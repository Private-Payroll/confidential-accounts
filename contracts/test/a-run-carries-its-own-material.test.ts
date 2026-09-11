/**
 * **WHAT A RUN HAS TO REMEMBER ABOUT ITSELF, AND WHAT GOES WRONG WHEN IT DOES
 * NOT.**
 *
 * A payroll run reaches the chain as a merkle root over blinded payee leaves.
 * The leaves are not on chain and the secrets behind them are not written down
 * anywhere: they are DERIVED, from the account's payout seed and the run's own
 * identity, so that any signer can rebuild the run and pay it. Every assertion
 * in this file is about a way that derivation can come out different from the
 * one the signers approved — and every one of those ends in the same place, an
 * approved run that nobody, including the company, can pay.
 *
 * **IT IS IN `contracts/test/` RATHER THAN BESIDE THE SOURCE FOR ONE REASON:**
 * the leaves are the VAULT's own commitments and the root is the on-chain
 * runtime's own merkle tree, so a test that stubbed either would be asserting
 * about arithmetic this product does not perform.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService } from '../../src/core/account.js';
import { PayrollService } from '../../src/core/payroll.js';
import { SimulatedLedger, SimulatedProofSystem } from '../../src/core/ledger.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { buildRun, rootOfLeaves } from '../../src/midnight/payout-tree.js';
import { runMaterialFor } from '../../src/midnight/run-material.js';
import { currentPayoutSeed } from '../../src/midnight/run-keys.js';
import { runPayments } from '../../src/midnight/run-status.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../../src/testing/assets.js';
import { FileStore } from '../../src/core/store-file.js';
import { toHex, type Hex } from '../../src/core/crypto.js';

const PAYROLL_VAULT = toHex(new Uint8Array(32).fill(0xa1));

/*
 * A window that is open NOW. The propose door refuses a window that has already
 * closed — a run whose window has closed can never be paid, and one whose
 * window has opened can no longer be withdrawn, so raising it would leave a
 * round that is neither.
 */
const OPENS = BigInt(Math.floor(Date.now() / 1000) - 3_600);
const CLOSES = BigInt(Math.floor(Date.now() / 1000) + 86_400);

const services = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-run-material-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  return { store, accounts, payroll };
};

/** A company, its payroll, and nothing raised yet. */
async function aPayroll(people: Array<{ asset: string; amount: bigint }>) {
  const { accounts, payroll } = services();
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  people.forEach((p, i) => {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: p.asset, baseAmount: p.amount,
    }, created.viewingKey);
  });
  const { run } = await payroll.createRunFromRoster(
    created.account.id, '2026-08', created.viewingKey);
  return { accounts, payroll, created, run };
}

/** Raises one leg of a run through the product's own door. */
async function raise(
  payroll: PayrollService, runId: string, viewingKey: Hex, signerId: string,
  opts: { asset?: string; vault?: Hex; opensAt?: bigint; closesAt?: bigint } = {},
) {
  const inputs = await payroll.runMaterialInputs(runId, viewingKey, opts.asset);
  const material = await runMaterialFor({
    accountId: inputs.accountId,
    runId: inputs.runId,
    seeds: inputs.seeds,
    facts: inputs.facts,
    opensAt: opts.opensAt ?? OPENS,
    closesAt: opts.closesAt ?? CLOSES,
    vault: opts.vault ?? PAYROLL_VAULT,
  });
  const proposal = await payroll.proposeRun(runId, viewingKey, signerId, material, opts.asset);
  return { material, proposal };
}

describe('a run carries what it takes to rebuild it', () => {
  /**
   * **THE ONE THAT COSTS A WHOLE PAYROLL: THE SEED GENERATION.**
   *
   * Payout seeds are APPENDED when a signer is removed, never replaced, so that
   * a run already approved stays payable across the removal. That only works
   * while the rebuild asks for the generation the run was RAISED under. Ask for
   * the current one instead and every leaf is different, the root is different,
   * and every payment of the approved run is refused as *"that payee is not in
   * the approved run"* — after the signatures are in and the fee is spent, with
   * nothing naming the cause.
   *
   * **THE CHANGE THAT TURNS THIS RED:** drop `epoch` from what the run stores,
   * or have the rebuild take `currentPayoutSeed(seeds).epoch` instead of the
   * stored number. The second half of this test IS that change, run
   * side by side with the first, so the two cannot both be green.
   */
  it('rebuilds the same root after a rotation, and a different one from the current seed',
    async () => {
      const { accounts, payroll, created, run } = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
      const { material } = await raise(
        payroll, run.id, created.viewingKey, created.secrets[0]!.signerId);

      /* A signer leaves. The account is resealed under a new key and a NEW
       * payout seed is appended at a new epoch. */
      const rotated = await accounts.rotate(created.account.id, created.viewingKey);
      const rebuild = (await payroll.payoutRebuildOf(run.id, rotated.viewingKey))!;
      expect(rebuild).not.toBeNull();
      expect(rebuild.seeds.length).toBe(2);
      const stored = rebuild.identity;

      /* THE RIGHT WAY: the generation the run recorded. */
      const rebuilt = buildRun(rebuild.seeds, stored, rebuild.facts, vaultDetails);
      expect(rebuilt.tree.root).toBe(material.run.root);
      expect(rebuilt.tree.leaves).toEqual(material.leaves);

      /* THE WRONG WAY, RUN BESIDE IT: the generation in force today. This is the
       * only difference between the two calls. */
      const fromCurrent = buildRun(
        rebuild.seeds,
        { ...stored, epoch: currentPayoutSeed(rebuild.seeds).epoch },
        rebuild.facts,
        vaultDetails,
      );
      expect(currentPayoutSeed(rebuild.seeds).epoch).not.toBe(stored.epoch);
      expect(fromCurrent.tree.root).not.toBe(material.run.root);
    });

  /**
   * **A PAYROLL THAT SETTLES IN TWO CURRENCIES IS TWO RUNS, AND THEY MUST NOT
   * SHARE THEIR PAYEES' SECRETS.**
   *
   * Each leg is its own approval over its own tree. If the two derived their
   * per-payee secrets from one identifier, position 0 of each would get the same
   * nonce and the same blinding — and a nonce is PUBLISHED by the payment that
   * spends it, so paying the first leg would hand a watcher the second leg's
   * secret for a payee who has not been paid yet.
   *
   * **THE CHANGE THAT TURNS THIS RED:** make the leg identifier the run's own id
   * rather than the run's id and the asset.
   */
  it('gives each settlement leg its own identity and its own leaves', async () => {
    const { payroll, created, run } = await aPayroll([
      { asset: 'GBP', amount: 100_00n },
      { asset: 'USDC', amount: 250_000000n },
    ]);
    const vk = created.viewingKey;
    const signer = created.secrets[0]!.signerId;

    const gbp = await raise(payroll, run.id, vk, signer, { asset: 'GBP' });
    const usdc = await raise(payroll, run.id, vk, signer, { asset: 'USDC' });

    const gbpRebuild = (await payroll.payoutRebuildOf(run.id, vk, 'GBP'))!;
    const usdcRebuild = (await payroll.payoutRebuildOf(run.id, vk, 'USDC'))!;
    expect(gbpRebuild.identity.runId).not.toBe(usdcRebuild.identity.runId);

    /*
     * **AND THE SECRETS THEMSELVES DIFFER, WHICH IS THE PROPERTY AND NOT A
     * PROXY FOR IT.** The two roots and the two leaf lists differ whatever the
     * identifier is — the legs hold different people, different tokens and
     * different amounts, so the leaves would differ even with the secrets
     * shared. Only the nonce and the blinding say whether they are shared, and a
     * nonce is PUBLISHED by the payment that spends it.
     */
    const gbpSecrets = buildRun(
      gbpRebuild.seeds, gbpRebuild.identity, gbpRebuild.facts, vaultDetails).payeeArgs(0);
    const usdcSecrets = buildRun(
      usdcRebuild.seeds, usdcRebuild.identity, usdcRebuild.facts, vaultDetails).payeeArgs(0);
    expect(gbpSecrets.nonce).not.toBe(usdcSecrets.nonce);
    expect(gbpSecrets.blinding).not.toBe(usdcSecrets.blinding);

    /* Two trees, and neither leg's material has overwritten the other's. */
    expect(gbp.material.run.root).not.toBe(usdc.material.run.root);
    expect(gbp.material.leaves).toHaveLength(1);
    expect(usdc.material.leaves).toHaveLength(1);
    expect(gbp.material.leaves[0]).not.toBe(usdc.material.leaves[0]);
    expect(payroll.payoutMaterialOf(run.id, vk, { asset: 'GBP' })!.leaves)
      .toEqual(gbp.material.leaves);
    expect(payroll.payoutMaterialOf(run.id, vk, { asset: 'USDC' })!.leaves)
      .toEqual(usdc.material.leaves);
  });

  /**
   * **AND IT REFUSES TO GUESS WHICH LEG IS BEING ASKED ABOUT.**
   *
   * Answering about one leg of a two-leg run without being asked is how a screen
   * comes to report a payroll complete while everybody in the other currency is
   * still owed.
   *
   * **THE CHANGE THAT TURNS THIS RED:** have the leg resolver fall back to the
   * first leg when a run settles in more than one asset.
   */
  it('refuses to report on a two-leg run without being told which leg', async () => {
    const { payroll, created, run } = await aPayroll([
      { asset: 'GBP', amount: 100_00n },
      { asset: 'USDC', amount: 250_000000n },
    ]);
    const vk = created.viewingKey;
    const signer = created.secrets[0]!.signerId;

    /* Nothing raised: there is nothing to report on, and that is `null` rather
     * than a refusal for want of an argument that would not have helped. */
    expect(payroll.payoutMaterialOf(run.id, vk)).toBeNull();

    await raise(payroll, run.id, vk, signer, { asset: 'GBP' });
    /* One leg raised: no ambiguity, so no argument needed. */
    expect(payroll.payoutMaterialOf(run.id, vk)!.leaves).toHaveLength(1);

    await raise(payroll, run.id, vk, signer, { asset: 'USDC' });
    expect(() => payroll.payoutMaterialOf(run.id, vk))
      .toThrow(/payout material for 2 assets \(GBP, USDC\)/);
    await expect(payroll.payoutRebuildOf(run.id, vk))
      .rejects.toThrow(/payout material for 2 assets \(GBP, USDC\)/);
  });

  /**
   * **A VAULT OF THE WRONG WIDTH IS REFUSED WHERE THE ROOT'S WIDTH IS REFUSED.**
   *
   * The vault is folded into the proposal's identity, so a vault that is 63
   * characters builds an id no vault can ever recompute — the same failure as a
   * short payout root, at the argument beside it. **Neither ledger catches it:**
   * both refuse only the no-vault sentinel, and the simulated scheme
   * interpolates the value into a string and accepts any width at all. So a run
   * raised with one is approved, paid for, and presentable by nobody.
   *
   * **THE CHANGE THAT TURNS THIS RED:** remove the width refusal from the
   * propose door. Putting it back at the two routes instead would leave it green
   * here and give the rule two homes.
   */
  it('refuses a vault that is not 32 bytes, at the door rather than at a route', async () => {
    const { payroll, created, run } = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
    await expect(raise(payroll, run.id, created.viewingKey, created.secrets[0]!.signerId, {
      vault: 'a1'.repeat(31) + 'a' as Hex,
    })).rejects.toThrow(/a vault address is 32 bytes as 64 lower-case hex characters/);
  });

  /**
   * **A WINDOW THAT HAS ALREADY CLOSED IS REFUSED BEFORE ANYBODY SIGNS.**
   *
   * Such a run can never be paid — no payment falls inside a closed window — and
   * can no longer be withdrawn, because the contract refuses to cancel a run
   * whose window has opened. It would collect approvals, cost a fee, and end as
   * an expired row somebody has to notice.
   *
   * **THE CHANGE THAT TURNS THIS RED:** remove the closed-window refusal at the
   * propose door. Neither ledger catches it — they check that the window is not
   * inside out and not written in milliseconds, and both of those are shapes
   * rather than moments.
   */
  it('refuses a run whose window has already closed', async () => {
    const { payroll, created, run } = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    await expect(raise(payroll, run.id, created.viewingKey, created.secrets[0]!.signerId, {
      opensAt: past - 3_600n, closesAt: past,
    })).rejects.toThrow(/window closed at .* and it is now /);
  });

  /**
   * **THE PAYMENT VIEW IS PROVED TO BE ABOUT THIS RUN'S PAYEES, AND THE PROOF IS
   * REACHED FROM THE PRODUCT'S OWN DOOR.**
   *
   * The strongest refusal in the payment module rebuilds the run's id from the
   * leaves in hand and says *these are not that run's payees*. Until a caller
   * supplied the material it was unreachable, and every answer a screen could
   * render carried a disclaimer that was permanently on — and a warning that is
   * always on stops being read.
   *
   * **THE CHANGE THAT TURNS EACH HALF RED:** for the first, stop populating
   * `proposal` in `payoutMaterialOf`, and `verified` goes false. For the second,
   * the wrong leaf list IS the change — it is a real leaf list from a different
   * payroll, not a fabricated one.
   */
  it('proves a payment view is about this run, and refuses one that is not', async () => {
    const a = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
    await raise(a.payroll, a.run.id, a.created.viewingKey, a.created.secrets[0]!.signerId);
    const mine = a.payroll.payoutMaterialOf(
      a.run.id, a.created.viewingKey, { rootOf: rootOfLeaves })!;

    /* Answered, and PROVED against the payroll run it is filed under. */
    const answer = runPayments(mine, { known: true, paid: [] });
    expect(answer.answered).toBe(true);
    if (answer.answered) expect(answer.status.verified).toBe(true);

    /* A second company's run, with the same number of people in it. */
    const b = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
    await raise(b.payroll, b.run.id, b.created.viewingKey, b.created.secrets[0]!.signerId);
    const theirs = b.payroll.payoutMaterialOf(
      b.run.id, b.created.viewingKey, { rootOf: rootOfLeaves })!;

    expect(theirs.leaves).not.toEqual(mine.leaves);
    /* **AT `runPayments`, THE DOOR THE PRODUCT ACTUALLY CALLS**, and not only at
     * the layer below it. */
    expect(() => runPayments(
      { ...mine, leaves: theirs.leaves }, { known: true, paid: [] }))
      .toThrow(/these are not that run's payees/);
  });

  /**
   * **AN APPROVED LEG STILL REBUILDS AFTER SOMEBODY ON IT IS MARKED A LEAVER.**
   *
   * *Mark leaver* is one click and it is the ordinary thing to do to somebody
   * who has left. The roster is live; an approved run is not. If the rebuild
   * read the roster again, that one click would refuse the whole leg — everybody
   * on it, not just the leaver — because a payee who is not active cannot be
   * turned into payment facts. Nobody on that payroll could then be paid, and
   * the refusal would name the wrong cause.
   *
   * **THE CHANGE THAT TURNS THIS RED:** have the rebuild take its facts from
   * `runMaterialInputs` (the roster) instead of from the run's own record.
   */
  it('rebuilds an approved leg after a payee on it is marked a leaver', async () => {
    const { payroll, created, run } = await aPayroll([
      { asset: 'GBP', amount: 100_00n },
      { asset: 'GBP', amount: 200_00n },
    ]);
    const vk = created.viewingKey;
    const { material } = await raise(payroll, run.id, vk, created.secrets[0]!.signerId);

    payroll.setStatus(run.employees[0]!.id, 'leaver', vk);
    /* The roster now refuses to produce facts for this run at all... */
    await expect(payroll.runMaterialInputs(run.id, vk)).rejects.toThrow(/is leaver, not active/);

    /* ...and the approved leg rebuilds to the same root regardless. */
    const rebuild = (await payroll.payoutRebuildOf(run.id, vk))!;
    const rebuilt = buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails);
    expect(rebuilt.tree.root).toBe(material.run.root);
    expect(rebuilt.tree.leaves).toEqual(material.leaves);
  });

  /**
   * **TWO LEGS RAISED AT ONCE BOTH KEEP THEIR PROPOSAL ID.**
   *
   * Each leg is its own approval round and each ends in a write of the whole run
   * record. A write that puts back the record as it was read BEFORE the chain
   * call drops whatever the other leg recorded in the meantime — and the guard
   * that refuses a leg already proposed then reads the field that was just
   * cleared, so the same people are raised on chain a second time under a fresh
   * salt. Approvals split across two rounds, neither reaching threshold, and
   * neither withdrawable once its window has opened.
   *
   * **THE CHANGE THAT TURNS THIS RED:** write back the record read at the top of
   * `proposeRun` instead of re-reading it after the chain call.
   */
  it('keeps both legs\' proposal ids when they are raised at the same time', async () => {
    const { payroll, created, run } = await aPayroll([
      { asset: 'GBP', amount: 100_00n },
      { asset: 'USDC', amount: 250_000000n },
    ]);
    const vk = created.viewingKey;
    const signer = created.secrets[0]!.signerId;

    const [gbp, usdc] = await Promise.all([
      raise(payroll, run.id, vk, signer, { asset: 'GBP' }),
      raise(payroll, run.id, vk, signer, { asset: 'USDC' }),
    ]);

    const after = payroll.requireRun(run.id, vk);
    expect(after.proposalIds.GBP).toBe(gbp.proposal.id);
    expect(after.proposalIds.USDC).toBe(usdc.proposal.id);
    expect(Object.keys(after.payout ?? {}).sort()).toEqual(['GBP', 'USDC']);

    /* And neither leg can now be raised a second time. */
    await expect(raise(payroll, run.id, vk, signer, { asset: 'GBP' }))
      .rejects.toThrow(/the GBP leg of this run is already proposed/);
  });

  /**
   * **THE DOOR'S OWN GUARDS, REACHED THE ONLY WAY THEY CAN BE.**
   *
   * **A CAST IS NOT NEEDED TO REACH THEM AND THE TEST SAYS SO BY USING ONE
   * ANYWAY.** The brand refuses a hand-written object; it does not refuse a
   * SPREAD of a real one, because a spread carries the brand across while
   * replacing a field. So each of these is reachable by an ordinary caller who
   * holds one material and edits a copy of it — which is precisely why the door
   * checks rather than trusting where the value came from.
   *
   * **THE CHANGE THAT TURNS EACH ONE RED:** delete the matching refusal in the
   * propose door. There are three and each has its own case below.
   */
  it('refuses material whose leaves do not account for its own payees', async () => {
    const { payroll, created, run } = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
    const inputs = await payroll.runMaterialInputs(run.id, created.viewingKey);
    const honest = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds,
      facts: inputs.facts, opensAt: OPENS, closesAt: CLOSES, vault: PAYROLL_VAULT,
    });

    const withNoLeaves = { ...honest, leaves: [] } as unknown as typeof honest;
    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, withNoLeaves))
      .rejects.toThrow(/names 1 payees and carries 0 payout leaves/);

    /*
     * **THE SPREAD THAT SWAPS THE ROOT, WHICH NEEDS NO CAST AT ALL.** The brand
     * refuses a hand-written object and carries across a spread, so this is what
     * an ordinary caller can produce — and it is the one disagreement that costs
     * a whole payroll, because the run the signers approve is then not the run
     * these payees are in.
     */
    const wrongRoot: typeof honest = { ...honest, run: { ...honest.run, root: 'de'.repeat(32) } };
    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, wrongRoot))
      .rejects.toThrow(/payout root is not the root over its own leaves/);

    const fromAnotherRun = {
      ...honest, identity: { ...honest.identity, runId: 'run_somebody_else:GBP' },
    } as unknown as typeof honest;
    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, fromAnotherRun))
      .rejects.toThrow(/was built for run run_somebody_else:GBP and is being raised for/);

    const fromAnotherAccount = {
      ...honest, identity: { ...honest.identity, accountId: 'acct_someone_else' },
    } as unknown as typeof honest;
    await expect(payroll.proposeRun(
      run.id, created.viewingKey, created.secrets[0]!.signerId, fromAnotherAccount))
      .rejects.toThrow(/was built for account acct_someone_else/);
  });

  /**
   * **A RUN WITH NO MATERIAL ANSWERS NOTHING, AND `null` IS WHAT SAYS SO.**
   *
   * A run in draft has no leaves and no window, and a reader that assembled an
   * empty leaf list for itself would get a view in which no payee is outstanding
   * and the run is therefore complete — *"all 0 paid"* over a payroll nobody has
   * been paid from.
   *
   * **THE CHANGE THAT TURNS THIS RED:** return an empty `RunInputs` instead of
   * `null` for a leg that has not been raised.
   */
  it('answers null for a leg with no material, rather than an empty run', async () => {
    const { payroll, created, run } = await aPayroll([{ asset: 'GBP', amount: 100_00n }]);
    expect(payroll.payoutMaterialOf(run.id, created.viewingKey)).toBeNull();
    expect(await payroll.payoutRebuildOf(run.id, created.viewingKey)).toBeNull();
    const answer = runPayments(
      payroll.payoutMaterialOf(run.id, created.viewingKey), { known: true, paid: [] });
    expect(answer.answered).toBe(false);
  });
});
