/**
 * THE WHOLE PRODUCT, END TO END, OFFLINE.
 *
 * A vault pays one payee of an approved run by calling its account, and the
 * account authorises that one payee. Two contracts, one transaction, no node
 * and no proof server.
 *
 * WHY THIS CAN RUN AT ALL, since it was filed for weeks as needing a chain:
 * `createCircuitContext` takes a `ContractStateProvider`, which is the only
 * thing a cross-contract call needs that a simulator has not got. Supply one
 * that answers with the account's state and the call executes in this
 * process.
 *
 * WHAT IT STILL CANNOT ANSWER, and the distinction matters: whether a FAILURE
 * in the vault reverts the account's record of the payment. Here both live in
 * one circuit context that is discarded together; on chain that is a question
 * about guaranteed and fallible transaction segments, and that stays open.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract as Vault, ledger as vaultLedger } from '../managed-vault/contract/index.js';
import { pureCircuits as vaultCircuits } from '../managed-vault/contract/index.js';
import { pureCircuits, ledger as accountLedger } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import {
  buildPayoutTree, buildRun, buildRetryRun, type PayoutLeafInput, type PaymentFacts,
} from '../../src/midnight/payout-tree.js';
import { payeeFor } from '../../src/testing/payees.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { recipientOf } from '../../src/midnight/payee-address.js';
import type { PayoutSeed, RunIdentity } from '../../src/midnight/run-keys.js';
import { changeCoinOf } from '../../src/midnight/vault-coins.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

/*
 * THE CLOCK AND THE RUN'S WINDOW.
 *
 * Payments assert they fall inside the window the signers approved, so both the
 * account simulator and the vault's own circuit context have to agree about the
 * time. Seconds since the Unix epoch — the unit `secondsSinceEpoch` uses.
 */
const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);

const BLOCK = '0'.repeat(64);


const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const A = privateStateFor(1);
const B = privateStateFor(2);
const GBP = bytes(0x9b);                      // a token type; the vault never interprets one
const ALICE = bytes(0x0a);                    // a payee's shielded public key
const BOB = bytes(0x0b);

/**
 * The vault's private state: which coin it can spend, and nothing else.
 *
 * IT USED TO CARRY TWO BLINDINGS and no longer carries any. A note's blinding
 * is derived in-circuit from the coin and the vault's address, so there is no
 * blinding for a device to hold, to choose, or to get wrong. A test that still
 * supplied one would be testing a contract this is not.
 */
interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

/**
 * What the chain holds for a coin this vault owns, from the CONTRACT'S OWN two
 * circuits rather than recomputed here.
 *
 * A test that derived the commitment a second way would pass by agreeing with
 * itself. Both halves come out of the compiled contract, so this asserts the
 * chain's record against the chain's own definition of it.
 */
const heldBy = (
  addr: Uint8Array,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
) => vaultCircuits.heldCommitmentOf(coin, vaultCircuits.noteBlindingOf(addr, coin));

/**
 * The owner's device: which note to spend, and the blindings over the pool.
 *
 * `noteToSpend` is coin selection, and it lives here rather than in the
 * contract because which notes exist is exactly what the contract must not see.
 * These tests hold one note at a time, so selection is trivial; a real device
 * picks among the pool.
 */
const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
};

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('a vault pays one payee of an approved run', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: string;
  let vaultState: any;
  let priv: VaultPrivate;

  /** The account's state, as the provider hands it to a cross-contract call. */
  const provider = () => ({
    getContractState: async (_block: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });

  const vaultAddrBytes = () => Uint8Array.from(Buffer.from(vaultAddr, 'hex'));

  const payoutContext = () => createCircuitContext<VaultPrivate>(
    'payout', vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);

    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as string;

    /* The vault is married to THIS account when it is created. */
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;

    /* A coin arrives. 1,000 of GBP, which the vault records as a commitment. */
    const coin = { nonce: bytes(0x77), color: GBP, value: 1_000n };
    priv = { coin: { ...coin, mt_index: 0n } };
    const dep = await vault.impureCircuits.deposit(
      createCircuitContext<VaultPrivate>('deposit', vaultAddr as never, BLOCK, vaultState, priv),
      coin);
    vaultState = dep.context.callContext.currentQueryContext.state;
  });

  /** Raises and approves a run, and returns what a payer needs. */
  const approvedRun = async (payments: Array<{ to: Uint8Array; amount: bigint; nonce: number }>, c: Change) => {
    const leaves: PayoutLeafInput[] = payments.map((p, i) => ({
      details: toHex(vaultCircuits.payoutDetails(p.to, GBP, p.amount, bytes(0x40 + i))),
      nonce: toHex(bytes(p.nonce)),
    }));
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    const vaultBytes = Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return { tree, id, leaves };
  };

  it('THE WHOLE THING: approved, claimed and paid in one call', async () => {
    const c = govChange(31);
    const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xc1 }], c);

    const r = await vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 250n, bytes(0x40), bytes(0xc1), run.tree.pathFor(0) as never);

    // The vault paid once…
    const after = vaultLedger(r.context.callContext.currentQueryContext.state as never);
    expect(after.payments).toBe(1n);

    /*
     * …and the ACCOUNT wrote its own state during the call, which is the claim
     * that was filed for weeks as needing a chain.
     *
     * What it wrote is the PAYMENT, not a completion: the proposal stays open
     * until its window shuts, because a run ends by time and completion is
     * derived from the payments rather than asserted by the contract. So the
     * evidence a payment happened is the movement, and that is exactly what the
     * product reads.
     */
    const acct = accountLedger(r.context.queryContexts[sim.address as never].state as never);
    expect(acct.movements.member(
      pureCircuits.paidMovementOf(fromHex(run.tree.leaves[0])))).toBe(true);
    expect(acct.openProposals.member(run.id)).toBe(true);
  });

  it('refuses to pay somebody the signers did not approve', async () => {
    const c = govChange(32);
    const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xc2 }], c);

    /* Same run, same amount, different payee. The leaf no longer matches. */
    await expect(vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      BOB, GBP, 250n, bytes(0x40), bytes(0xc2), run.tree.pathFor(0) as never))
      .rejects.toThrow(/not for this payee|not in the approved run/i);
  });

  it('refuses to pay a different AMOUNT than the one approved', async () => {
    const c = govChange(33);
    const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xc3 }], c);

    await expect(vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 900n, bytes(0x40), bytes(0xc3), run.tree.pathFor(0) as never))
      .rejects.toThrow(/not for this payee|not in the approved run/i);
  });

  it('refuses to pay more than it holds', async () => {
    const c = govChange(34);
    const run = await approvedRun([{ to: ALICE, amount: 5_000n, nonce: 0xc4 }], c);

    await expect(vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 5_000n, bytes(0x40), bytes(0xc4), run.tree.pathFor(0) as never))
      .rejects.toThrow(/does not hold enough/i);
  });

  it('refuses a note the witness invented, however well-formed', async () => {
    /*
     * A witness is UNTRUSTED INPUT by the language's own warning. The vault's
     * only tie between the private coin and the public record is the
     * commitment, so this hands it a different coin of the same token.
     */
    const c = govChange(35);
    const run = await approvedRun([{ to: ALICE, amount: 100n, nonce: 0xc5 }], c);
    priv = { ...priv, coin: { ...priv.coin, nonce: bytes(0x78), value: 9_999n } };

    await expect(vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 100n, bytes(0x40), bytes(0xc5), run.tree.pathFor(0) as never))
      .rejects.toThrow(/not in this vault.s pool/i);
  });

  it('KEEPS THE CHANGE, and commits to it — the silent way to lose money', async () => {
    /*
     * `sendShielded` hands the change back and the contract must manage it. A
     * vault that dropped it would lose the difference between what it held and
     * what it paid, on every payment, without an error anywhere.
     *
     * So: hold 1,000, pay 250, and the chain's record must now be a commitment
     * to a coin of 750 under the NEXT blinding — checked against the vault's
     * own circuit rather than against a number this test made up.
     */
    const c = govChange(36);
    const run = await approvedRun([{ to: ALICE, amount: 250n, nonce: 0xc6 }], c);

    const r = await vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 250n, bytes(0x40), bytes(0xc6), run.tree.pathFor(0) as never);

    const pool = vaultLedger(r.context.callContext.currentQueryContext.state as never).notes;

    /*
     * THE CHANGE COIN HAS A NEW NONCE, and reading it correctly is what keeps
     * the money spendable.
     *
     * It is READ from the call's Zswap outputs, not derived: `sendShielded`
     * hashes a new nonce under a domain the standard library's `evolveNonce`
     * does not use, so a derivation that looks right produces a coin the
     * commitment rejects. What the client reads here must reproduce exactly
     * what the chain committed to.
     */
    const back = changeCoinOf(r.context.callContext.currentZswapLocalState, toHex(vaultAddrBytes()));
    expect(back).toBeDefined();
    expect(back!.value).toBe(750n);
    expect(back!.token).toBe(toHex(GBP));

    expect(pool.member(heldBy(
      vaultAddrBytes(),
      { nonce: fromHex(back!.nonce), color: GBP, value: back!.value }))).toBe(true);
  });

  it('a SECOND payment spends the change, which is the proof the derivation is right', async () => {
    /*
     * The test above says the client can reconstruct the change coin. This one
     * says the reconstruction actually spends: pay twice from one deposit,
     * carrying the coin forward exactly as an owner's device would.
     *
     * If the nonce derivation were wrong, this fails with "does not match the
     * coin offered" — the vault holding money it can never move.
     */
    const c = govChange(39);
    const run = await approvedRun([
      { to: ALICE, amount: 100n, nonce: 0xd1 },
      { to: BOB, amount: 200n, nonce: 0xd2 },
    ], c);

    const first = await vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 100n, bytes(0x40), bytes(0xd1), run.tree.pathFor(0) as never);
    vaultState = first.context.callContext.currentQueryContext.state;

    /*
     * What the owner's device does between payments: read the coin the payment
     * handed back, and carry it forward as what the vault now holds.
     */
    const back = changeCoinOf(first.context.callContext.currentZswapLocalState, toHex(vaultAddrBytes()));
    expect(back).toEqual({ nonce: back!.nonce, token: toHex(GBP), value: 900n });
    priv = {
      coin: { nonce: fromHex(back!.nonce), color: fromHex(back!.token), value: back!.value, mt_index: 0n },
    };

    const second = await vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      BOB, GBP, 200n, bytes(0x41), bytes(0xd2), run.tree.pathFor(1) as never);

    expect(vaultLedger(second.context.callContext.currentQueryContext.state as never).payments)
      .toBe(2n);
  });

  it('REFUSES TO SPEND THE SAME NOTE TWICE, which is the pool\'s whole safety property', async () => {
    /*
     * The pool had no test for this for a long time — found by a mutation that
     * deleted `notes.remove(spent)` and was not caught by the test named for
     * it.
     *
     * The vault takes the note it spends from a WITNESS, which is untrusted
     * input by the language's own warning. Nothing stops an operator's device
     * offering the same note to a second payment: the coin is well-formed, the
     * amount fits, and the commitment recomputes correctly. **The only thing
     * between that and paying the same money twice is the note being removed
     * from the pool when it is spent.**
     *
     * So this pays once, then offers the SAME note again — exactly what a
     * device would do if its record of what it holds had not moved on — and
     * requires the chain to refuse it.
     */
    const c = govChange(41);
    const run = await approvedRun([
      { to: ALICE, amount: 100n, nonce: 0xe1 },
      { to: BOB, amount: 200n, nonce: 0xe2 },
    ], c);

    const first = await vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 100n, bytes(0x40), bytes(0xe1), run.tree.pathFor(0) as never);
    vaultState = first.context.callContext.currentQueryContext.state;

    /*
     * `priv` is deliberately NOT advanced. The witness still offers the
     * original 1,000 note, which the vault spent a moment ago.
     */
    await expect(vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      BOB, GBP, 200n, bytes(0x41), bytes(0xe2), run.tree.pathFor(1) as never))
      .rejects.toThrow(/not in this vault/i);

    // And the payment count did not move, so nothing half-happened.
    expect(vaultLedger(vaultState as never).payments).toBe(1n);
  });

  it('END TO END: a run built from the ACCOUNT\'S SEED pays, and a second admin finishes it',
    async () => {
    /*
     * The proof that the derivation is not merely self-consistent: the leaves
     * it produces are the ones the CHAIN accepts.
     *
     * The scenario, played out. A raises a three-person run from the account's
     * payout seed and pays one person. A's laptop dies. B — who has never seen
     * A's machine and holds nothing of A's — rebuilds the run from the account's
     * sealed seeds and the run's identity, and pays the other two.
     */
    const seeds: PayoutSeed[] = [{ epoch: 0, seed: toHex(bytes(0x5e)) }];
    const identity: RunIdentity = { accountId: 'acct-e2e', runId: 'payroll-2026-09', epoch: 0 };
    const payroll: PaymentFacts[] = [
      { payee: payeeFor(ALICE, 'undeployed'), token: toHex(GBP), amount: 100n },
      { payee: payeeFor(BOB, 'undeployed'), token: toHex(GBP), amount: 200n },
      { payee: payeeFor(bytes(0x0c), 'undeployed'), token: toHex(GBP), amount: 300n },
    ];

    /* --- A's machine --- */
    const byA = buildRun(seeds, identity, payroll, vaultDetails);
    const c = govChange(63);
    const vaultBytes = vaultAddrBytes();
    const payload = pureCircuits.runPayload(
      fromHex(byA.tree.root), byA.tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(byA.tree.root), payees: byA.tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);

    const pay = async (run: typeof byA, i: number) => {
      const a = run.payeeArgs(i);
      const r = await vault.impureCircuits.payout(
        payoutContext(),
        id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
        fromHex(recipientOf(a.payee)), fromHex(a.token), a.amount,
        fromHex(a.blinding), fromHex(a.nonce), a.path as never);
      vaultState = r.context.callContext.currentQueryContext.state;
      /* And the account's own write, which a chain would commit with it. */
      sim.adoptFromCall(r.context);
      /* Carry the change forward, as an owner's device does between payments. */
      const back = changeCoinOf(r.context.callContext.currentZswapLocalState, toHex(vaultBytes));
      void i;
      priv = {
        coin: {
          nonce: fromHex(back!.nonce), color: fromHex(back!.token), value: back!.value,
          mt_index: 0n,
        },
      };
      return r;
    };

    await pay(byA, 0);

    /* --- A's laptop dies here. Nothing of A's crosses to B. --- */

    /* --- B's machine: the same account seeds, the same run identity --- */
    const byB = buildRun(seeds, identity, payroll, vaultDetails);
    expect(byB.tree.root).toBe(byA.tree.root);

    await pay(byB, 1);
    await pay(byB, 2);

    const acct = accountLedger(vaultState as never);
    void acct;
    expect(vaultLedger(vaultState as never).payments).toBe(3n);
  });

  it('a rebuilt RETRY run cannot pay somebody the original already paid', async () => {
    /*
     * The two fixes meeting. B rebuilds the run, retries the stragglers — and
     * the person A already paid is refused, because a retry reuses the original
     * leaf and a leaf can be paid once in any run.
     */
    const seeds: PayoutSeed[] = [{ epoch: 0, seed: toHex(bytes(0x5f)) }];
    const identity: RunIdentity = { accountId: 'acct-retry', runId: 'payroll-2026-10', epoch: 0 };
    const payroll: PaymentFacts[] = [
      { payee: payeeFor(ALICE, 'undeployed'), token: toHex(GBP), amount: 100n },
      { payee: payeeFor(BOB, 'undeployed'), token: toHex(GBP), amount: 200n },
    ];

    const byA = buildRun(seeds, identity, payroll, vaultDetails);
    const c = govChange(64);
    const vaultBytes = vaultAddrBytes();
    const payload = pureCircuits.runPayload(
      fromHex(byA.tree.root), byA.tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(byA.tree.root), payees: byA.tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);

    const a0 = byA.payeeArgs(0);
    const first = await vault.impureCircuits.payout(
      payoutContext(),
      id, fromHex(byA.tree.root), byA.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      fromHex(recipientOf(a0.payee)), fromHex(a0.token), a0.amount,
      fromHex(a0.blinding), fromHex(a0.nonce), a0.path as never);
    vaultState = first.context.callContext.currentQueryContext.state;
    sim.adoptFromCall(first.context);

    /* B rebuilds and, not knowing what landed, retries BOTH people. */
    const retry = buildRetryRun(
      buildRun(seeds, identity, payroll, vaultDetails), [0, 1]);
    const r0 = retry.payeeArgs(0);
    const retryPayload = pureCircuits.runPayload(
      fromHex(retry.tree.root), retry.tree.payees, WIN_FROM, WIN_UNTIL);
    const c2 = govChange(65);
    await sim.as(carrying(sim, A, c2)).proposeRun({
      root: fromHex(retry.tree.root), payees: retry.tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const retryId = sim.proposalId(retryPayload, c2.salt, vaultBytes);
    await sim.as(carrying(sim, A, c2)).approve(retryId);
    await sim.as(carrying(sim, B, c2)).approve(retryId);

    await expect(vault.impureCircuits.payout(
      payoutContext(),
      retryId, fromHex(retry.tree.root), retry.tree.payees, WIN_FROM, WIN_UNTIL, c2.salt,
      fromHex(recipientOf(r0.payee)), fromHex(r0.token), r0.amount,
      fromHex(r0.blinding), fromHex(r0.nonce), r0.path as never))
      .rejects.toThrow(/already been made/i);
  });

  it('counts its payments, which is the one number an auditor can check with no key', async () => {
    const c = govChange(37);
    const run = await approvedRun([
      { to: ALICE, amount: 100n, nonce: 0xc7 },
      { to: BOB, amount: 200n, nonce: 0xc8 },
    ], c);

    const first = await vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 100n, bytes(0x40), bytes(0xc7), run.tree.pathFor(0) as never);
    vaultState = first.context.callContext.currentQueryContext.state;
    expect(vaultLedger(vaultState as never).payments).toBe(1n);
  });

  it('refuses a note of the WRONG TOKEN with a message that says so', async () => {
    /*
     * The commitment check would refuse this too — a commitment covers the
     * coin's colour — so this pins WHICH refusal fires. An error saying "the
     * vault's record does not match" when the real problem is "that is a coin
     * of a different token" is the kind of message that sends somebody looking
     * in the wrong place at the worst moment.
     */
    const c = govChange(38);
    const run = await approvedRun([{ to: ALICE, amount: 100n, nonce: 0xc9 }], c);
    priv = { ...priv, coin: { ...priv.coin, color: bytes(0x5e) } };

    await expect(vault.impureCircuits.payout(
      payoutContext(),
      run.id, fromHex(run.tree.root), run.tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 100n, bytes(0x40), bytes(0xc9), run.tree.pathFor(0) as never))
      .rejects.toThrow(/not a note of the token being paid/i);
  });

  it('two vaults holding the SAME coin publish different bytes', async () => {
    /*
     * The blinding inside the held commitment is what makes the record opaque
     * rather than merely hashed. Without it, a coin's commitment is a hash of
     * three values an observer can guess at — a token type there are few of, a
     * round amount, and a nonce that becomes public the moment the coin is
     * spent — so two vaults holding the same amount would publish identical
     * bytes and a watcher could read balances off the chain by comparison.
     */
    const coin = { nonce: bytes(0x77), color: GBP, value: 1_000n };
    const one = Uint8Array.from(Buffer.from(sampleContractAddress() as never as string, 'hex'));
    const other = Uint8Array.from(Buffer.from(sampleContractAddress() as never as string, 'hex'));
    expect(hex(one)).not.toBe(hex(other));

    /*
     * THIS TEST NOW PLAYS WHAT ITS NAME SAYS, which it could not before.
     *
     * The blinding used to be a number a caller chose, so the strongest thing
     * available was that two DIFFERENT blindings give different bytes — true of
     * any commitment, and silent about vaults. It is derived now, and derived
     * from the coin AND the vault's own address, so two vaults holding the same
     * coin can actually be compared. Take the address out of `noteBlindingOf`
     * and these two are equal.
     */
    expect(hex(vaultCircuits.noteBlindingOf(one, coin)))
      .not.toBe(hex(vaultCircuits.noteBlindingOf(other, coin)));
    expect(hex(heldBy(one, coin))).not.toBe(hex(heldBy(other, coin)));
  });

  it('a deposit adds ONE opaque note to the pool, not a balance', () => {
    /*
     * The product's central claim, checked against the chain's own view: what a
     * vault holds is a set of 32-byte commitments. An observer learns how many
     * notes there are — which is why the pool is kept at a fixed size — and
     * nothing about what any of them is worth, or in what token.
     */
    const pool = vaultLedger(vaultState as never).notes;
    expect(pool.size()).toBe(1n);
    expect(pool.member(heldBy(
      vaultAddrBytes(), { nonce: bytes(0x77), color: GBP, value: 1_000n }))).toBe(true);
  });

  it('two notes of the same token sit in the pool side by side', async () => {
    /* The case one-note-per-token could not express, and the whole point of a
     * pool: a second deposit is another note, not a merge and not a conflict. */
    const second = { nonce: bytes(0x88), color: GBP, value: 500n };
    const dep = await vault.impureCircuits.deposit(
      createCircuitContext<VaultPrivate>('deposit', vaultAddr as never, BLOCK, vaultState, priv),
      second);
    const pool = vaultLedger(dep.context.callContext.currentQueryContext.state as never).notes;
    expect(pool.size()).toBe(2n);
  });
});
