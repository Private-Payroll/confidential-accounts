/**
 * THE RECOVERY IN `docs/scope-the-vault-system.md` §3.8, RUN.
 *
 * A vault whose approval threshold nobody can meet is unspendable. The contract
 * describes the way out and, until this file, NO TEST HAD EVER EXECUTED IT — so
 * by `CLAUDE.md`'s own standing rule the repository documented a recovery that
 * did not exist.
 *
 * Four steps, in order, each asserted:
 *
 *   1. raise a vault's threshold ABOVE the seats the account holds
 *   2. prove a payment out of that vault is refused, AND assert the reason
 *   3. lower it by a governed round at the ACCOUNT's threshold
 *   4. pay — the same payment, the same run, the same call
 *
 * WHY IT IS REACHABLE AT ALL, which is the whole mechanism in one line:
 * `setVaultThreshold` (`ConfidentialAccount.compact:2699`) is judged by
 * `requireApproved` (`:1407`), which reads the ACCOUNT's `threshold` directly
 * and can never pick up a vault's own number — governance proposals name
 * `noVault()`, and no vault address can equal it. So the vault's bar governs
 * spending out of the vault and nothing else; it has no say in the round that
 * moves it.
 *
 * OFFLINE, AGAINST THE REAL COMPILED CONTRACTS, exactly as
 * `vault-payout.test.ts` is: `createCircuitContext` takes a
 * `ContractStateProvider`, so the vault's cross-contract call into the account
 * executes in this process. No node, no proof server, no wallet, no deploy.
 *
 * WHAT THIS DOES NOT SHOW, stated in the same terms the round asked for: it
 * does not show that a proof is produced for any of these circuits, that a node
 * accepts the resulting transaction, or that a person can drive the recovery
 * from a screen. It shows that the compiled circuits, executed in order, refuse
 * and then permit the payment for the stated reasons.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract as Vault, ledger as vaultLedger } from '../managed-vault/contract/index.js';
import { pureCircuits as vaultCircuits } from '../managed-vault/contract/index.js';
import { pureCircuits, ledger as accountLedger } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

/* The clock and the run's window. V-67, and pinned for the reason the
 * simulator's own comment gives: nothing here measures real time. */
const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);

const A = privateStateFor(1);
const B = privateStateFor(2);
const GBP = bytes(0x9b);
const ALICE = bytes(0x0a);

const NO_VAULT = pureCircuits.noVault();

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

/** The owner's device: which note to spend. One note here, so selection is trivial. */
const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
};

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('S6b: a vault whose threshold nobody can meet is recovered, and pays', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: string;
  let vaultState: any;
  let priv: VaultPrivate;

  const provider = () => ({
    getContractState: async (_block: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });

  const vaultAddrBytes = () => Uint8Array.from(Buffer.from(vaultAddr, 'hex'));

  const payoutContext = () => createCircuitContext<VaultPrivate>(
    'payout', vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);

  beforeEach(async () => {
    /* Two signers, and a threshold of two. Two seats is the number every
     * "above the seats" below is measured against. */
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    expect(sim.ledger.threshold).toBe(2n);

    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as string;

    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;

    const coin = { nonce: bytes(0x77), color: GBP, value: 1_000n };
    priv = { coin: { ...coin, mt_index: 0n } };
    const dep = await vault.impureCircuits.deposit(
      createCircuitContext<VaultPrivate>('deposit', vaultAddr as never, BLOCK, vaultState, priv),
      coin);
    vaultState = dep.context.callContext.currentQueryContext.state;
  });

  /**
   * A GOVERNED ROUND, DRIVEN THE WHOLE WAY.
   *
   * Propose, then approve as each named signer, and answer the id the chain
   * filed it under. Nothing here reaches into the ledger and writes a value:
   * step 3 of the recovery is only meaningful if the round is real, and a
   * helper that shortcut it would be testing a path no signer has.
   */
  const governedRound = async (payloadHash: Uint8Array, c: Change) => {
    await sim.as(carrying(sim, A, c)).propose(payloadHash, NO_VAULT);
    const id = sim.proposalId(payloadHash, c.salt, NO_VAULT);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return id;
  };

  /** Sets this vault's own threshold through a governed round, and asserts it landed. */
  const setVaultThresholdTo = async (n: bigint, c: Change) => {
    const payloadHash = pureCircuits.setVaultThresholdPayload(vaultAddrBytes(), n);
    const id = await governedRound(payloadHash, c);
    /* Exactly the ACCOUNT's threshold, and no more — this is the number that
     * makes the recovery reachable, so it is asserted rather than assumed. */
    expect(sim.approvalsFor(id)).toBe(sim.ledger.threshold);
    await sim.as(carrying(sim, A, c)).setVaultThreshold(vaultAddrBytes(), n, id);
    expect(sim.ledger.thresholds.lookup(vaultAddrBytes())).toBe(n);
    return id;
  };

  /** Raises and approves a one-payee run for this vault, and returns what a payer needs. */
  const approvedRun = async (to: Uint8Array, amount: bigint, nonce: number, c: Change) => {
    const leaves: PayoutLeafInput[] = [{
      details: toHex(vaultCircuits.payoutDetails(to, GBP, amount, bytes(0x40))),
      nonce: toHex(bytes(nonce)),
    }];
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultAddrBytes() });
    const id = sim.proposalId(payload, c.salt, vaultAddrBytes());
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return { tree, id };
  };

  it('THE FOUR STEPS: raised above the seats, refused with its reason, lowered by a governed round, paid',
    async () => {
    /* --- 1. RAISE IT ABOVE THE SEATS ---------------------------------------
     *
     * Three, on an account holding two seats. The contract accepts it and says
     * why it does not bound this the way `setThreshold` bounds the account's
     * own number (`:2166-2171`): a vault has no bootstrap window to reopen, and
     * an unmeetable vault threshold is recoverable rather than dangerous.
     *
     * This line IS that claim being taken at its word, so the rest of the test
     * is what turns "recoverable" into something that has been seen to happen.
     */
    const raising = govChange(71);
    await setVaultThresholdTo(3n, raising);
    expect(sim.ledger.thresholds.lookup(vaultAddrBytes()))
      .toBeGreaterThan(sim.ledger.signerLeaves.size());

    /* --- 2. THE PAYMENT IS REFUSED, AND THIS IS THE REASON ------------------
     *
     * A run for this vault, approved by everybody the account has. Two
     * approvals against a vault bar of three: unreachable, because a third
     * approval does not exist to be given — which is asserted below rather than
     * described, since "nobody can meet it" is the premise of the whole round.
     */
    const c = govChange(72);
    const run = await approvedRun(ALICE, 250n, 0xc1, c);
    expect(sim.approvalsFor(run.id)).toBe(2n);
    await expect(sim.as(carrying(sim, A, c)).approve(run.id))
      .rejects.toThrow(/already approved this proposal/i);
    await expect(sim.as(carrying(sim, B, c)).approve(run.id))
      .rejects.toThrow(/already approved this proposal/i);

    const leaf = fromHex(run.tree.leaves[0]);
    const pay = () => vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 250n, bytes(0x40), bytes(0xc1), run.tree.pathFor(0) as never);

    /*
     * THE REASON, NOT MERELY A THROW. A test that passed because something else
     * broke — a wrong salt, a stale path, a closed window — would report this
     * recovery as proven while proving nothing about thresholds. The message is
     * `requireApprovedForVault`'s (`:1192`), and it is the only assert in that
     * call path that can fire here.
     */
    await expect(pay()).rejects.toThrow(/not enough approvals yet/i);

    /* And nothing half-happened: no payment, no movement, the run still open. */
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
    expect(vaultLedger(vaultState as never).notes.size()).toBe(1n);
    expect(sim.ledger.movements.member(pureCircuits.paidMovementOf(leaf))).toBe(false);
    expect(sim.isOpen(run.id)).toBe(true);

    /* --- 3. LOWER IT BY A GOVERNED ROUND, AT THE ACCOUNT'S THRESHOLD --------
     *
     * The round that undoes it needs TWO approvals — the account's number —
     * while the vault it concerns demands three. That asymmetry is the
     * recovery. `setVaultThresholdTo` asserts the count it settled at, and the
     * proposal names `noVault()`, which is what keeps the vault's own bar out
     * of the decision.
     */
    const lowering = govChange(73);
    await setVaultThresholdTo(2n, lowering);
    expect(sim.ledger.thresholds.lookup(vaultAddrBytes())).toBe(2n);

    /* --- 4. PAY ------------------------------------------------------------
     *
     * The same run, the same proposal id, the same two approvals given before
     * the threshold moved, the same call. Nothing was re-approved and nothing
     * was re-proposed: the money was stuck and is now spendable.
     */
    const r = await pay();
    vaultState = r.context.callContext.currentQueryContext.state;

    expect(vaultLedger(vaultState as never).payments).toBe(1n);
    const acct = accountLedger(r.context.queryContexts[sim.address as never].state as never);
    expect(acct.movements.member(pureCircuits.paidMovementOf(leaf))).toBe(true);
  });

  it('THE CHAIN DOES NOT BOUND A VAULT THRESHOLD BY THE SEAT COUNT — the refusal that does is OURS',
    async () => {
    /*
     * WHICH OF THE TWO REFUSALS IS WHICH, pinned so a later round cannot delete
     * one believing the other covers it.
     *
     *   THE CHAIN     accepts any non-zero vault threshold, seats or no seats.
     *                 `setVaultThreshold` (`:2172-2188`) asserts only that the
     *                 number is not zero. This test is that half.
     *
     *   OURS          `src/core/account.ts:1291` refuses a vault threshold
     *                 above the seat count before a proposal is even raised,
     *                 and its message says whose rule it is. That half is
     *                 pinned by `src/core/a-vault-s-own-threshold.test.ts`,
     *                 "refuses a threshold above the seats the LEDGER holds,
     *                 and says the refusal is ours".
     *
     * Neither is redundant. Ours stops a company reaching the unspendable state
     * by accident; it is NOT what makes the recovery possible, and removing it
     * would not make anything below fail. The recovery is possible because of
     * `requireApproved` in the circuit above, which is a different line in a
     * different repository layer.
     */
    const nine = govChange(74);
    await setVaultThresholdTo(9n, nine);
    expect(sim.ledger.thresholds.lookup(vaultAddrBytes())).toBe(9n);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });
});

/*
 * THE PROPERTY THAT MAKES THE RECOVERY SAFE, AND WHICH `docs/vaults.md` DID NOT
 * STATE: the account's own threshold is always reachable, by construction.
 *
 * A vault's bar can be set past the point of no return; the ACCOUNT's cannot.
 * Both halves of that are single asserts, and both are what stop the recovery
 * from being a door that can itself be locked:
 *
 *   - `setThreshold` refuses `newThreshold > signerLeaves.size()`
 *   - `removeSigner` refuses to leave fewer signers than the threshold
 *     (`:1471-1472`)
 *
 * Together: there is no sequence of governed acts that strands the ACCOUNT, so
 * there is none that strands a VAULT permanently.
 *
 * BOTH LINES ARE ALREADY GUARDED ELSEWHERE and deliberately so, for different
 * reasons — `signer-governance.test.ts` asserts the first as M-37 (raising the
 * bar past the seats reopens the bootstrap window) and the second as the
 * account being stranded with its balance inside it. Neither of those tests is
 * about vaults, and neither would survive a rewrite that kept the M-37 argument
 * and dropped the reachability one. This describes the same two asserts as the
 * foundation of §3.8's recovery, which is a claim nothing else in the suite
 * makes.
 */
describe('S6b: the account\'s own threshold is always reachable, so no vault is stranded forever', () => {
  const liveAccount = async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);
    return sim;
  };

  const governedRound = async (sim: AccountSimulator, payloadHash: Uint8Array, c: Change) => {
    await sim.as(carrying(sim, A, c)).propose(payloadHash, NO_VAULT);
    const id = sim.proposalId(payloadHash, c.salt, NO_VAULT);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return id;
  };

  it('the account cannot raise its own threshold above the seats it holds', async () => {
    const sim = await liveAccount();
    const c = govChange(75);
    const id = await governedRound(sim, pureCircuits.setThresholdPayload(3n), c);

    await expect(sim.as(carrying(sim, A, c)).setThreshold(3n, id))
      .rejects.toThrow(/cannot exceed the number of signers/i);

    // The number that governs every vault recovery did not move.
    expect(sim.ledger.threshold).toBe(2n);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('the account cannot remove a signer below its own threshold', async () => {
    const sim = await liveAccount();
    const leafB = sim.leafOf(B);
    const c = govChange(76);
    const id = await governedRound(sim, pureCircuits.removeSignerPayload(leafB), c);

    await expect(sim.as(carrying(sim, A, c)).removeSigner(leafB, id))
      .rejects.toThrow(/fewer signers than the threshold/i);

    // Still two signers against a threshold of two: the account can still act,
    // and therefore can still lower any vault's bar.
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    expect(sim.ledger.threshold).toBe(2n);
  });

  it('BUT A VAULT HAS NO SUCH FLOOR: the seats can fall below a bar that was legal when it was set',
    async () => {
    /*
     * THE ASYMMETRY, RUN RATHER THAN REASONED, because reasoning about it got
     * the example wrong the first time.
     *
     * `removeSigner`'s floor protects the ACCOUNT's threshold and knows nothing
     * about the `thresholds` map — there is no vault equivalent of it, and
     * there is no client refusal on this route either: `src/core/account.ts:1291`
     * guards a threshold being RAISED above the seats, not the seats falling
     * below a threshold. So a vault can be made unspendable without anybody
     * setting an unmeetable number, by a sequence of acts each of which is
     * legal and each of which the product would allow.
     *
     * Four signers at 2 of 4, a vault at 4 — meetable the day it is set. Two
     * removals later, each leaving the account able to approve, the bar is
     * above the seats and no rule was broken.
     *
     * IT IS NOT NEW MONEY RISK, and the last two lines are why: the same
     * governed round the recovery uses gets straight back out of it. That is
     * the point of asserting it here rather than only naming it.
     */
    const C = privateStateFor(3);
    const D = privateStateFor(4);
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    /* B was seated by a round too, since `S35d` shut the bootstrap window; C
     * and D are seated here because this walk needs their seeds and its own
     * `governedRound`, which is the same three steps `liveAccount` runs. */
    sim.at(VAULT_NOW);
    for (const [who, seed] of [[C, 77], [D, 78]] as const) {
      const c = govChange(seed);
      const id = await governedRound(sim, pureCircuits.signerAddPayload(sim.leafOf(who)), c);
      await sim.as(carrying(sim, A, c)).addSigner(sim.leafOf(who), id);
    }
    expect(sim.ledger.signerLeaves.size()).toBe(4n);

    const VAULT = new Uint8Array(32).fill(0xa1);
    const raising = govChange(79);
    const rid = await governedRound(sim, pureCircuits.setVaultThresholdPayload(VAULT, 4n), raising);
    await sim.as(carrying(sim, A, raising)).setVaultThreshold(VAULT, 4n, rid);
    // Legal, and meetable: four seats, a bar of four.
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(sim.ledger.signerLeaves.size());

    /* Two removals, each of which the account's own floor permits. */
    for (const [who, seed] of [[C, 80], [D, 81]] as const) {
      const c = govChange(seed);
      const leaf = sim.leafOf(who);
      const id = await governedRound(sim, pureCircuits.removeSignerPayload(leaf), c);
      await sim.as(carrying(sim, A, c)).removeSigner(leaf, id);
    }

    // The account is fine. The vault is unspendable, and nothing refused anything.
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(4n);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBeGreaterThan(sim.ledger.signerLeaves.size());

    /* And the recovery gets out of it, at the account's threshold, as always. */
    const lowering = govChange(82);
    const lid = await governedRound(sim, pureCircuits.setVaultThresholdPayload(VAULT, 2n), lowering);
    expect(sim.approvalsFor(lid)).toBe(sim.ledger.threshold);
    await sim.as(carrying(sim, A, lowering)).setVaultThreshold(VAULT, 2n, lid);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(2n);
  });
});
