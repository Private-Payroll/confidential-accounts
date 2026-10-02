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
 *   1. leave a vault's threshold ABOVE the seats the account holds. It cannot
 *      be SET there: the contract refuses a vault threshold above the signers
 *      seated, and one above the approvals a policy change needs raises that
 *      number, which every removal then keeps the seats at or above. The one
 *      way there is the signers at that number choosing to lower it, then a
 *      removal.
 *   2. prove a payment out of that vault is refused, AND assert the reason
 *   3. lower it by a governed round at the higher of the ACCOUNT's threshold
 *      and the approvals a policy change needs
 *   4. the run raised under the higher bar is STILL refused, because a run
 *      needs the higher of its bar when raised and the bar now; the same
 *      payment raised again after the lowering pays
 *
 * WHY IT IS REACHABLE AT ALL, which is the whole mechanism in one line:
 * lowering a vault's threshold needs the higher of the account's `threshold`
 * and the approvals a policy change needs, and neither can exceed the seats -
 * every circuit that sets either refuses more than the signers seated, and
 * every removal refuses to leave fewer. A vault's own number never enters the
 * round that moves it: governance proposals name `noVault()`, and no vault
 * address can equal it. Seats are not live keys: a seat whose key is lost
 * still counts, and that is not this file's subject.
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
import { AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, vaultRunOf } from './simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from './start-a-vault.js';
import { type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

/* The clock and the run's window, pinned for the reason the simulator's own
 * comment gives: nothing here measures real time. */
const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);

const A = privateStateFor(1);
const B = privateStateFor(2);
const TOKEN_BYTES = bytes(0x9b);
const ALICE = bytes(0x0a);

const NO_VAULT = pureCircuits.noVault();

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

/** The owner's device: which note to spend. One note here, so selection is trivial. */
const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: { secret?: Uint8Array } }) => [ctx.privateState, ctx.privateState.secret ?? TEST_VAULT_SECRET],
};

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('a vault whose threshold nobody can meet is recovered, and pays', () => {
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
    /* A vault takes no money until the account has adopted it and approved its first secret. */
    await startTheVault({
      sim, vault: Uint8Array.from(Buffer.from(String(vaultAddr), 'hex')), approvers: [A, B], now: VAULT_NOW,
      call: async (circuit, ...a) => {
        const r: any = await (vault.impureCircuits as any)[circuit](createCircuitContext(
          circuit as never, vaultAddr as never, BLOCK, vaultState, {} as never,
          provider() as never, undefined, undefined, VAULT_NOW, BLOCK), ...a);
        vaultState = r.context.callContext.currentQueryContext.state;
        carryTheAccount(sim, r.context);
      },
    });

    const coin = { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n };
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
  const governedRound = async (
    payloadHash: Uint8Array, c: Change, by: ReturnType<typeof privateStateFor>[] = [A, B],
  ) => {
    await sim.as(carrying(sim, A, c)).propose(payloadHash, NO_VAULT);
    const id = sim.proposalId(payloadHash, c.salt, NO_VAULT);
    for (const who of by) await sim.as(carrying(sim, who, c)).approve(id);
    return id;
  };

  /**
   * Sets this vault's own threshold through a governed round of two, and asserts what the
   * contract then holds: the vault's threshold, and, separately, the approvals a policy change
   * needs, which a vault threshold above it raises and nothing here lowers.
   */
  const setVaultThresholdTo = async (n: bigint, c: Change, barAfter: bigint) => {
    const payloadHash = pureCircuits.setVaultThresholdPayload(vaultAddrBytes(), n);
    const id = await governedRound(payloadHash, c);
    await sim.as(carrying(sim, A, c)).setVaultThreshold(vaultAddrBytes(), n, id);
    /* RED WHEN the circuit stops writing the vault's threshold, or writes another number. */
    expect(sim.ledger.thresholds.lookup(vaultAddrBytes())).toBe(n);
    /* RED WHEN the circuit stops writing the bar a vault threshold raises, or lowers it. */
    expect(sim.ledger.thresholds.lookup(pureCircuits.policyBarKey())).toBe(barAfter);
    return id;
  };

  /** Raises and approves a one-payee run for this vault, and returns what a payer needs. */
  const approvedRun = async (to: Uint8Array, amount: bigint, nonce: number, c: Change) => {
    const leaves: PayoutLeafInput[] = [{
      details: toHex(vaultCircuits.payoutDetails(to, TOKEN_BYTES, amount, bytes(0x40))),
      nonce: toHex(bytes(nonce)),
    }];
    const tree = payoutTreeOf(leaves, [amount], TOKEN_BYTES);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, 0n);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultAddrBytes() });
    const id = sim.proposalId(payload, c.salt, vaultAddrBytes());
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return { tree, id };
  };

  it('THE FOUR STEPS: raised above the seats, refused with its reason, lowered by a governed round, raised again and paid',
    async () => {
    /* --- 1. LEAVE IT ABOVE THE SEATS ---------------------------------------
     *
     * Three, on an account holding two seats, by the only road there is: a
     * third seat, the vault set to three by all three (which raises the
     * approvals a policy change needs to three), that number lowered to two by
     * all three, and the third seat removed by two.
     */
    const C = privateStateFor(3);
    const seat = govChange(70);
    const sid = await governedRound(pureCircuits.signerAddPayload(sim.leafOf(C)), seat);
    await sim.as(carrying(sim, A, seat)).addSigner(sim.leafOf(C), sid);
    const raising = govChange(71);
    const rid = await governedRound(
      pureCircuits.setVaultThresholdPayload(vaultAddrBytes(), 3n), raising, [A, B, C]);
    await sim.as(carrying(sim, A, raising)).setVaultThreshold(vaultAddrBytes(), 3n, rid);
    expect(sim.ledger.thresholds.lookup(pureCircuits.policyBarKey())).toBe(3n);
    const lowerBar = govChange(75);
    const bid = await governedRound(pureCircuits.setPolicyBarPayload(2n), lowerBar, [A, B, C]);
    await sim.as(carrying(sim, A, lowerBar)).setPolicyBar(2n, bid);
    const out = govChange(76);
    const oid = await governedRound(pureCircuits.removeSignerPayload(sim.leafOf(C)), out);
    await sim.as(carrying(sim, A, out)).removeSigner(sim.leafOf(C), oid);
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
      vaultRunOf({
        proposal: run.id, vault: vaultAddrBytes(), tree: run.tree, i: 0,
        opensAt: WIN_FROM, closesAt: WIN_UNTIL, salt: c.salt, nonce: bytes(0xc1),
      }),
      ALICE, TOKEN_BYTES, 250n, bytes(0x40));

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

    /* --- 3. LOWER IT BY A GOVERNED ROUND, AT THE SEAT BAR -------------------
     *
     * The round that undoes it needs TWO approvals — the higher of the
     * account's number and the approvals a policy change needs, both two —
     * while the vault it concerns demands three. That asymmetry is the
     * recovery. `setVaultThresholdTo` asserts the count it settled at, and the
     * proposal names `noVault()`, which is what keeps the vault's own bar out
     * of the decision.
     */
    const lowering = govChange(73);
    await setVaultThresholdTo(2n, lowering, 2n);
    expect(sim.ledger.thresholds.lookup(vaultAddrBytes())).toBe(2n);

    /* --- 4. RAISE IT AGAIN, AND PAY ----------------------------------------
     *
     * A fall never releases approvals already given: the run raised when the
     * vault needed three still needs three.
     *
     * RED WHEN: the bar a run was raised with is dropped from the check, and
     * only the vault's threshold now is compared (`higher(hold.needed, ...)`
     * replaced by the threshold alone).
     */
    await expect(pay()).rejects.toThrow(/not enough approvals yet/i);

    /* The same payee raised again, under a fresh salt, at the bar now: it pays. */
    const again = govChange(74);
    const rerun = await approvedRun(ALICE, 250n, 0xc1, again);
    expect(rerun.tree.leaves[0]).toBe(run.tree.leaves[0]);
    const r = await vault.impureCircuits.payout(
      payoutContext(),
      vaultRunOf({
        proposal: rerun.id, vault: vaultAddrBytes(), tree: rerun.tree, i: 0,
        opensAt: WIN_FROM, closesAt: WIN_UNTIL, salt: again.salt, nonce: bytes(0xc1),
      }),
      ALICE, TOKEN_BYTES, 250n, bytes(0x40));
    vaultState = r.context.callContext.currentQueryContext.state;

    expect(vaultLedger(vaultState as never).payments).toBe(1n);
    const acct = accountLedger(r.context.queryContexts[sim.address as never].state as never);
    expect(acct.movements.member(pureCircuits.paidMovementOf(leaf))).toBe(true);
  });

  it('THE CHAIN REFUSES A VAULT THRESHOLD ABOVE THE SIGNERS SEATED, as ours does',
    async () => {
    /*
     * BOTH REFUSALS NOW, pinned so a later round cannot delete one believing
     * the other covers it.
     *
     *   THE CHAIN     `setVaultThreshold` refuses a number above the signers
     *                 seated, as `setPolicy` refuses such a band: a vault
     *                 threshold above the approvals a policy change needs
     *                 raises that number, and it must stay reachable.
     *
     *   OURS          `src/core/account.ts` refuses a vault threshold above
     *                 the seat count before a proposal is even raised. That
     *                 half is pinned by `src/core/a-vault-s-own-threshold.test.ts`.
     */
    const nine = govChange(74);
    const id = await governedRound(pureCircuits.setVaultThresholdPayload(vaultAddrBytes(), 9n), nine);
    /* RED WHEN the circuit stops refusing a vault threshold above the signers seated. */
    await expect(sim.as(carrying(sim, A, nine)).setVaultThreshold(vaultAddrBytes(), 9n, id))
      .rejects.toThrow(/a vault cannot need more approvals than the company has signers/);
    expect(sim.ledger.thresholds.member(vaultAddrBytes())).toBe(false);
    /* At exactly the signers seated it is accepted, and the bar is written at it. */
    const two = govChange(77);
    await setVaultThresholdTo(2n, two, 2n);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
    /* Lowered below the bar, the vault's number falls and the bar does not, so the helper's two
     * checks tell them apart. */
    await setVaultThresholdTo(1n, govChange(78), 2n);
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
 * reasons — `signer-governance.test.ts` asserts the first (raising the bar
 * past the seats reopens the bootstrap window) and the second as the account
 * being stranded with its balance inside it. Neither of those tests is about
 * vaults, and neither would survive a rewrite that kept the seating argument
 * and dropped the reachability one. This describes the same two asserts as the
 * foundation of §3.8's recovery, which is a claim nothing else in the suite
 * makes.
 */
describe('the account\'s own threshold is always reachable, so no vault is stranded forever', () => {
  const liveAccount = async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);
    return sim;
  };

  const governedRound = async (
    sim: AccountSimulator, payloadHash: Uint8Array, c: Change,
    by: ReturnType<typeof privateStateFor>[] = [A, B],
  ) => {
    await sim.as(carrying(sim, A, c)).propose(payloadHash, NO_VAULT);
    const id = sim.proposalId(payloadHash, c.salt, NO_VAULT);
    for (const who of by) await sim.as(carrying(sim, who, c)).approve(id);
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

  it('AND A VAULT HAS THE SAME FLOOR: no removal leaves fewer seats than a vault threshold it raised the bar to',
    async () => {
    /*
     * Four signers at 2 of 4, a vault at 4. Setting it raised the approvals a
     * policy change needs to four, so every change of who is seated needs four
     * and no removal may leave fewer than four seats. Until a vault threshold
     * raised that number, two removals at two approvals each left the vault
     * above the seats with nothing refusing anything.
     */
    const C = privateStateFor(3);
    const D = privateStateFor(4);
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);
    for (const [who, seed] of [[C, 77], [D, 78]] as const) {
      const c = govChange(seed);
      const id = await governedRound(sim, pureCircuits.signerAddPayload(sim.leafOf(who)), c);
      await sim.as(carrying(sim, A, c)).addSigner(sim.leafOf(who), id);
    }
    expect(sim.ledger.signerLeaves.size()).toBe(4n);

    const VAULT = new Uint8Array(32).fill(0xa1);
    await sim.adoptVault(VAULT, [A, B]);
    const raising = govChange(79);
    const rid = await governedRound(sim, pureCircuits.setVaultThresholdPayload(VAULT, 4n), raising, [A, B, C, D]);
    await sim.as(carrying(sim, A, raising)).setVaultThreshold(VAULT, 4n, rid);

    /* With every signer approving, neither removal may leave three seats against a vault of four. */
    const leaf = sim.leafOf(C);
    const one = govChange(80);
    const id1 = await governedRound(sim, pureCircuits.removeSignerPayload(leaf), one, [A, B, C, D]);
    /* RED WHEN a vault threshold no longer raises the bar: the removal then passes at the account's own floor. */
    await expect(sim.as(carrying(sim, A, one)).removeSigner(leaf, id1))
      .rejects.toThrow(/that would leave fewer signers than a policy change needs/);
    const both = govChange(81);
    const id2 = await governedRound(
      sim, pureCircuits.removeAndSetThresholdPayload(leaf, 2n), both, [A, B, C, D]);
    /* RED WHEN the combined removal stops checking the bar after the seat leaves. */
    await expect(sim.as(carrying(sim, A, both)).removeSignerAndSetThreshold(leaf, 2n, id2))
      .rejects.toThrow(/that would leave fewer signers than a policy change needs/);
    expect(sim.ledger.signerLeaves.size()).toBe(4n);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(4n);
  });
});

/*
 * A VAULT'S OWN THRESHOLD GUARDS WHO IS SEATED, BY THE SAME STEP A POLICY'S
 * HIGHEST BAND DOES. Setting one above the approvals a policy change needs
 * raises that number to it; a lower later one never lowers it; raising one
 * past it, or lowering a vault's threshold, needs that many approvals. So
 * signers short of a vault's threshold can neither seat their way to it nor
 * loosen it.
 */
describe("a vault's own threshold guards who is seated", () => {
  const C = privateStateFor(3);
  const D = privateStateFor(4);
  const VAULT = new Uint8Array(32).fill(0xa1);
  const OTHER = new Uint8Array(32).fill(0xa2);
  type Who = ReturnType<typeof privateStateFor>;

  const live = async (threshold: bigint) => {
    const sim = await AccountSimulator.liveAccount([A, B, C], threshold);
    sim.at(VAULT_NOW);
    await sim.adoptVault(VAULT, [A, B, C].slice(0, Number(threshold)));
    await sim.adoptVault(OTHER, [A, B, C].slice(0, Number(threshold)), 392);
    return sim;
  };
  const round = async (sim: AccountSimulator, payloadHash: Uint8Array, c: Change, by: Who[]) => {
    await sim.as(carrying(sim, A, c)).propose(payloadHash, NO_VAULT);
    const id = sim.proposalId(payloadHash, c.salt, NO_VAULT);
    for (const who of by) await sim.as(carrying(sim, who, c)).approve(id);
    return id;
  };
  const setVault = async (sim: AccountSimulator, vault: Uint8Array, n: bigint, seed: number, by: Who[]) => {
    const c = govChange(seed);
    const id = await round(sim, pureCircuits.setVaultThresholdPayload(vault, n), c, by);
    return sim.as(carrying(sim, A, c)).setVaultThreshold(vault, n, id);
  };
  const bar = (sim: AccountSimulator) => sim.ledger.thresholds.member(pureCircuits.policyBarKey())
    ? sim.ledger.thresholds.lookup(pureCircuits.policyBarKey()) : undefined;

  it('SIGNERS AT THE SEAT BAR CANNOT SEAT, RE-SEAT OR REMOVE THEIR WAY TO A STRICTER VAULT', async () => {
    const sim = await live(2n);
    await setVault(sim, VAULT, 3n, 101, [A, B, C]);
    const seat = govChange(102);
    const sid = await round(sim, pureCircuits.signerAddPayload(sim.leafOf(D)), seat, [A, B]);
    /* RED WHEN a vault threshold above the bar does not raise it: two of three seat a fourth leaf they hold. */
    await expect(sim.as(carrying(sim, A, seat)).addSigner(sim.leafOf(D), sid))
      .rejects.toThrow(/seating, removing or re-seating a signer needs as many approvals as a policy change needs/);
    const swap = govChange(103);
    const wid = await round(sim, pureCircuits.reseatPayload(sim.leafOf(C), sim.leafOf(D)), swap, [A, B]);
    await expect(sim.as(carrying(sim, A, swap)).reseatSigner(sim.leafOf(C), sim.leafOf(D), wid))
      .rejects.toThrow(/seating, removing or re-seating a signer needs as many approvals as a policy change needs/);
    const out = govChange(104);
    const oid = await round(sim, pureCircuits.removeSignerPayload(sim.leafOf(C)), out, [A, B]);
    /* RED WHEN the removal's seat bar is the account's threshold alone: two of three remove the third. */
    await expect(sim.as(carrying(sim, A, out)).removeSigner(sim.leafOf(C), oid))
      .rejects.toThrow(/seating, removing or re-seating a signer needs as many approvals as a policy change needs/);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
  });

  it('a vault threshold above the bar raises it, and a lower later one never lowers it', async () => {
    const sim = await live(2n);
    expect(bar(sim)).toBeUndefined();
    await setVault(sim, VAULT, 3n, 111, [A, B, C]);
    /* RED WHEN setVaultThreshold does not write the bar. */
    expect(bar(sim)).toBe(3n);
    await setVault(sim, OTHER, 2n, 112, [A, B]);
    /* RED WHEN the bar is written even below it: a lower vault threshold would lower it. */
    expect(bar(sim)).toBe(3n);
    expect(sim.ledger.thresholds.lookup(OTHER)).toBe(2n);
  });

  it('RAISING A VAULT PAST THE BAR, OR LOWERING ONE, NEEDS THE BAR', async () => {
    const sim = await AccountSimulator.liveAccount([A, B, C, D], 2n);
    sim.at(VAULT_NOW);
    await sim.adoptVault(VAULT, [A, B]);
    await sim.adoptVault(OTHER, [A, B], 392);
    /* At a seat bar of two, two of four raise a vault to three, and so the bar to three. */
    await setVault(sim, VAULT, 3n, 121, [A, B]);
    expect(bar(sim)).toBe(3n);
    /* RED WHEN raising past the bar needs only the account's threshold: two would make it four. */
    await expect(setVault(sim, OTHER, 4n, 122, [A, B]))
      .rejects.toThrow(/raising a vault's threshold past the approvals a policy change needs, or lowering a vault's threshold, needs that many approvals/);
    expect(bar(sim)).toBe(3n);
    /* RED WHEN lowering a vault's threshold needs only the account's threshold. */
    await expect(setVault(sim, VAULT, 2n, 123, [A, B]))
      .rejects.toThrow(/raising a vault's threshold past the approvals a policy change needs, or lowering a vault's threshold, needs that many approvals/);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(3n);
    /* A vault with none of its own reads the account's threshold, so setting it below that lowers it too.
     * RED WHEN an unset vault is read as needing nothing: two would set it to one under a bar of three. */
    await expect(setVault(sim, OTHER, 1n, 124, [A, B]))
      .rejects.toThrow(/raising a vault's threshold past the approvals a policy change needs, or lowering a vault's threshold, needs that many approvals/);
    expect(sim.ledger.thresholds.member(OTHER)).toBe(false);
    /* Up to the bar, the account's threshold is enough, as before. */
    await setVault(sim, OTHER, 3n, 125, [A, B]);
    expect(sim.ledger.thresholds.lookup(OTHER)).toBe(3n);
    /* Lowered at the bar, the vault's number falls and the bar stays. */
    await setVault(sim, VAULT, 2n, 126, [A, B, C]);
    expect(sim.ledger.thresholds.lookup(VAULT)).toBe(2n);
    expect(bar(sim)).toBe(3n);
  });

  it('BYTES THE COMPANY DOES NOT HOLD AS A VAULT NEVER RAISE THE BAR, but may carry a threshold at or below it', async () => {
    const sim = await live(2n);
    const STRANGER = new Uint8Array(32).fill(0xa3);
    /* RED WHEN setVaultThreshold lets bytes no vault holds raise the bar: three of three would raise it to three. */
    await expect(setVault(sim, STRANGER, 3n, 141, [A, B, C]))
      .rejects.toThrow(/that is not a vault this company holds, so its threshold cannot exceed the approvals a policy change needs/);
    expect(bar(sim)).toBeUndefined();
    expect(sim.ledger.thresholds.member(STRANGER)).toBe(false);
    /* At the bar a threshold is still set before adoption. RED WHEN the refusal also catches a
     * threshold at or below the bar, which a vault set up before it is adopted needs. */
    await setVault(sim, STRANGER, 2n, 142, [A, B]);
    expect(sim.ledger.thresholds.lookup(STRANGER)).toBe(2n);
    /* Once adopted, the same raise passes and raises the bar. */
    await sim.adoptVault(STRANGER, [A, B], 393);
    await setVault(sim, STRANGER, 3n, 143, [A, B]);
    expect(bar(sim)).toBe(3n);
  });

  it('A VAULT AT THE THRESHOLD WRITES THE BAR, SO LOWERING THE THRESHOLD LATER LEAVES IT GUARDED', async () => {
    const sim = await live(3n);
    await setVault(sim, VAULT, 3n, 131, [A, B, C]);
    /* RED WHEN the bar is written only above the threshold standing in for it. */
    expect(bar(sim)).toBe(3n);
    const lower = govChange(132);
    const lid = await round(sim, pureCircuits.setThresholdPayload(2n), lower, [A, B, C]);
    await sim.as(carrying(sim, A, lower)).setThreshold(2n, lid);
    const seat = govChange(133);
    const sid = await round(sim, pureCircuits.signerAddPayload(sim.leafOf(D)), seat, [A, B]);
    await expect(sim.as(carrying(sim, A, seat)).addSigner(sim.leafOf(D), sid))
      .rejects.toThrow(/seating, removing or re-seating a signer needs as many approvals as a policy change needs/);
  });
});
