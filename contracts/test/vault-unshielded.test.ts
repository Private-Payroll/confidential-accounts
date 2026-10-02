/**
 * ONE VAULT, BOTH KINDS OF MONEY, SIDE BY SIDE.
 *
 * NIGHT is an UNSHIELDED token by definition — `nativeToken()` returns
 * `UnshieldedTokenType` — and `Vault.compact` used to be `receiveShielded`,
 * `sendShielded` and a pool of Zswap commitments from end to end. So the vault could
 * not hold the asset the product launches with. These tests drive the three circuits
 * that close that, against the real compiled contract.
 *
 * ------------------------------------------------------------------------
 * HOW A CONTRACT'S PUBLIC BALANCE REACHES A CIRCUIT HERE, AND WHY IT IS SET BY HAND
 *
 * `unshieldedBalanceGte` and `unshieldedBalanceLte` read `CallContext.balance` —
 * *"the balances held by the called contract at the time it was called"* — and the
 * runtime fills it from `ContractState.balance`, but only when it is handed a real
 * `ContractState`: `compact-runtime/dist/circuit-context.js:113` reads
 *
 *     contractState instanceof ocrt.ContractState ? contractState.balance : new Map()
 *
 * A circuit's own result carries a `ChargedState`, not a `ContractState`, so a test
 * that threaded the state forward the way `vault-payout.test.ts` does would run every
 * balance question against an EMPTY MAP and every one of these asserts would pass or
 * fail for the wrong reason. `chainSays` rewraps it, which is the same move
 * `AccountSimulator.contractStateForCall` makes for a cross-contract callee.
 *
 * **WHAT THAT MEANS THIS FILE IS NOT TESTING, said plainly rather than implied.**
 * Nothing here applies a transaction, so nothing here moves a balance: `chainSays`
 * is the test author stating what the chain would say, and it is a SECOND MODEL of
 * the ledger's arithmetic in exactly the sense `CLAUDE.md` warns about. What is real
 * is everything on this side of that line — the effects the circuits DECLARE, which
 * is what the ledger actually applies (`midnight-ledger` `ledger-9.1.0.0-rc.3`, `ledger/src/semantics.rs:1462-1490`, where
 * `unshielded_outputs` are subtracted with `checked_sub` and an underflow is
 * `BalanceCheckOutOfBounds`). So the tests below assert on the DECLARED EFFECTS, and
 * use the hand-set balance only to reach the branches that read one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as ocrt from '@midnightntwrk/onchain-runtime-v4';
import { Contract as Vault, ledger as vaultLedger } from '../managed-vault/contract/index.js';
import { pureCircuits as vaultCircuits } from '../managed-vault/contract/index.js';
import { pureCircuits, ledger as accountLedger } from '../managed/contract/index.js';
import {
  AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, vaultRunOf, NOT_IN_THE_APPROVED_RUN,
} from './simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from './start-a-vault.js';
import { type PayoutLeafInput, type PayoutTree } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { noFurtherNote } from '../../src/midnight/vault-step-notes.js';

const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const A = privateStateFor(1);
const B = privateStateFor(2);

/** The token the product launches with. The vault never interprets one. */
const NIGHT = bytes(0x99);
/** A payee's UNSHIELDED user address. Thirty-two bytes, like a coin public key
 *  and belonging to an entirely different key space — which is the whole of the
 *  domain-separation test below. */
const ALICE = bytes(0x0a);
const BOB = bytes(0x0b);

interface VaultPrivate { coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint } }
const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: { secret?: Uint8Array } }) => [ctx.privateState, ctx.privateState.secret ?? TEST_VAULT_SECRET],
};

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

describe('a vault holds public money as well as private', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: string;
  let vaultState: unknown;
  const priv: VaultPrivate = { coin: { nonce: bytes(0x77), color: NIGHT, value: 1_000n, mt_index: 0n } };

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });

  /**
   * The vault's current state, plus what the chain says it holds in public money.
   *
   * Read the file header before using this: the balances are stated, not applied.
   */
  const chainSays = (balances: Array<[Uint8Array, bigint]> = []) => {
    const cs = new ocrt.ContractState();
    (cs as { data: unknown }).data = (vaultState as { data?: unknown }).data ?? vaultState;
    cs.balance = new Map(balances.map(([t, v]) => [{ tag: 'unshielded', raw: hex(t) } as never, v]));
    return cs;
  };

  const ctxFor = (circuitId: string, state: unknown) =>
    createCircuitContext<VaultPrivate>(
      circuitId, vaultAddr as never, BLOCK, state as never, priv,
      provider() as never, undefined, undefined, VAULT_NOW, BLOCK);

  const adopt = (r: { context: { callContext: { currentQueryContext: { state: unknown } } } }) => {
    vaultState = r.context.callContext.currentQueryContext.state;
  };

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);

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
          circuit as never, vaultAddr as never, BLOCK, vaultState as never, {} as never,
          provider() as never, undefined, undefined, VAULT_NOW, BLOCK), ...a);
        vaultState = r.context.callContext.currentQueryContext.state;
        carryTheAccount(sim, r.context);
      },
    });
  });

  /** Raises and approves a run whose leaves are built for the kind named. */
  const approvedRun = async (
    kind: 'unshielded' | 'shielded',
    payments: Array<{ to: Uint8Array; amount: bigint; nonce: number }>,
    c: Change,
  ) => {
    const detailsOf = kind === 'unshielded'
      ? vaultCircuits.unshieldedPayoutDetails : vaultCircuits.payoutDetails;
    const leaves: PayoutLeafInput[] = payments.map((p, i) => ({
      details: toHex(detailsOf(p.to, NIGHT, p.amount, bytes(0x40 + i))),
      nonce: toHex(bytes(p.nonce)),
    }));
    /* The run's root commits to the token it pays in, which the vault hands the account. */
    const tree = payoutTreeOf(leaves, payments.map((p) => p.amount), NIGHT);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, 0n);
    const vaultBytes = Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes });
    const id = sim.proposalId(payload, c.salt, vaultBytes);
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return { tree, id };
  };

  /** The run the first payee of an approved run hands the account, with that payee's nonce. */
  const runOf = (tree: PayoutTree, id: Uint8Array, salt: Uint8Array, nonce: number) => vaultRunOf({
    proposal: id, vault: Uint8Array.from(Buffer.from(vaultAddr, 'hex')), tree, i: 0,
    opensAt: WIN_FROM, closesAt: WIN_UNTIL, salt, nonce: bytes(nonce),
  });

  const pay = (
    state: unknown, run: { tree: PayoutTree },
    id: Uint8Array, salt: Uint8Array, to: Uint8Array, amount: bigint, blind: number, nonce: number,
  ) => vault.impureCircuits.payoutUnshielded(
    ctxFor('payoutUnshielded', state),
    runOf(run.tree, id, salt, nonce), to, NIGHT, amount, bytes(blind));

  /* ---------------------------------------------------------------- deposit */

  it('takes a deposit of public money and declares it to the ledger', async () => {
    const r = await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n);
    adopt(r as never);

    /* The DECLARED EFFECT is what the ledger credits — semantics.rs:1463-1476 at ledger-9.1.0.0-rc.3. */
    const inputs = [...(r as never as {
      context: { callContext: { currentQueryContext: { effects: { unshieldedInputs: Map<{ tag: string; raw: string }, bigint> } } } }
    }).context.callContext.currentQueryContext.effects.unshieldedInputs];
    expect(inputs).toHaveLength(1);
    expect(inputs[0][0].tag).toBe('unshielded');
    expect(inputs[0][0].raw).toBe(hex(NIGHT));
    expect(inputs[0][1]).toBe(500n);

    /* And no note was invented for it. The pool is the private side only. */
    const after = vaultLedger(vaultState as never);
    expect(after.notes.isEmpty()).toBe(true);
    expect(after.unshieldedTokens.member(NIGHT)).toBe(true);
  });

  it('refuses a deposit of nothing, which would seat a colour for free', async () => {
    await expect(vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 0n))
      .rejects.toThrow(/deposit of nothing/i);
  });

  /* ----------------------------------------------------------------- payout */

  it('THE WHOLE THING IN PUBLIC MONEY: approved, claimed and paid in one call', async () => {
    const c = govChange(71);
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);
    const run = await approvedRun('unshielded', [{ to: ALICE, amount: 250n, nonce: 0xc1 }], c);

    const r = await pay(chainSays([[NIGHT, 500n]]), run, run.id, c.salt, ALICE, 250n, 0x40, 0xc1);

    /* The money left as a declared unshielded OUTPUT — what the ledger subtracts. */
    const outs = [...(r as never as {
      context: { callContext: { currentQueryContext: { effects: { unshieldedOutputs: Map<{ tag: string; raw: string }, bigint> } } } }
    }).context.callContext.currentQueryContext.effects.unshieldedOutputs];
    expect(outs).toHaveLength(1);
    expect(outs[0][0].raw).toBe(hex(NIGHT));
    expect(outs[0][1]).toBe(250n);

    /*
     * AND IT WENT TO THE PERSON, WHICH IS A SEPARATE CLAIM FROM THE AMOUNT.
     *
     * `claimedUnshieldedSpends` is keyed by `[TokenType, PublicAddress]`, and the
     * address side carries its own tag. So this pins BOTH halves of the recipient:
     * that it is a `user` and not a `contract`, and which user. The unshielded
     * `Either` puts the contract on the LEFT and the user on the RIGHT — the
     * opposite way round from the shielded one — and a circuit that took the wrong
     * side would send the company's money to itself, or to some contract, with an
     * amount and a token that both still look right.
     */
    const spends = [...(r as never as {
      context: { callContext: { currentQueryContext: { effects: {
        claimedUnshieldedSpends: Map<[{ raw: string }, { tag: string; address: string }], bigint> } } } }
    }).context.callContext.currentQueryContext.effects.claimedUnshieldedSpends];
    /*
     * Two spends are claimed: the payment, and one unit of the vault's payment
     * receipt to the account, which is what lets the account record it at all.
     */
    const ofNight = spends.filter(([[token]]) => token.raw === hex(NIGHT));
    /* RED WHEN the payment is claimed twice, or not at all. */
    expect(ofNight).toHaveLength(1);
    /* RED WHEN the money goes to a contract rather than the person. */
    expect(ofNight[0]![0][1].tag).toBe('user');
    expect(ofNight[0]![0][1].address).toBe(hex(ALICE));
    expect(ofNight[0]![1]).toBe(250n);
    const others = spends.filter(([[token]]) => token.raw !== hex(NIGHT));
    /* RED WHEN anything but one receipt goes to the account beside the payment. */
    expect(others.map(([[, to], v]) => [to.tag, to.address, v])).toEqual([['contract', String(sim.address), 1n]]);

    /* The vault counted it… */
    expect(vaultLedger(r.context.callContext.currentQueryContext.state as never).payments).toBe(1n);
    /* …and the ACCOUNT recorded the leaf, paid-once working unchanged. */
    const acct = accountLedger(r.context.queryContexts[sim.address as never].state as never);
    expect(acct.movements.member(
      pureCircuits.paidMovementOf(fromHex(run.tree.leaves[0])))).toBe(true);
  });

  it('THE ONE THAT LOSES THE MONEY: an approval for a SHIELDED payment cannot be paid in public money', async () => {
    const c = govChange(72);
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);

    /*
     * The run is built with `payoutDetails` — the shielded derivation. Same payee,
     * same token, same amount, same blinding, same nonce. Only the KIND differs.
     *
     * Without the domain separator in `unshieldedPayoutDetails` this call succeeds:
     * the account sees a leaf it approved and says yes, and 250 of NIGHT leaves the
     * vault as a UTXO addressed to a UserAddress built out of somebody's ZSWAP COIN
     * PUBLIC KEY — an address in a different key space, which nobody holds and there
     * is no unshielded burn address to distinguish from an intention.
     */
    const run = await approvedRun('shielded', [{ to: ALICE, amount: 250n, nonce: 0xc2 }], c);

    /* RED WHEN a leaf approved for private money settles in public money, or this is refused for another reason. */
    await expect(pay(chainSays([[NIGHT, 500n]]), run, run.id, c.salt, ALICE, 250n, 0x40, 0xc2))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);
  });

  it('and the reverse: an approval for a PUBLIC payment is not a shielded one either', async () => {
    const c = govChange(73);
    const run = await approvedRun('unshielded', [{ to: ALICE, amount: 250n, nonce: 0xc3 }], c);

    /* A note the vault genuinely holds, so the refusal cannot come from the pool. */
    const coin = { nonce: bytes(0x77), color: NIGHT, value: 1_000n };
    adopt(await vault.impureCircuits.deposit(
      ctxFor('deposit', chainSays()), coin) as never);

    /* RED WHEN a leaf approved for public money settles in private money, or this is refused for another reason. */
    await expect(vault.impureCircuits.payout(
      ctxFor('payout', chainSays()),
      runOf(run.tree, run.id, c.salt, 0xc3), ALICE, NIGHT, 250n, bytes(0x40), noFurtherNote()))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);
  });

  it('refuses to pay a different AMOUNT of public money than the one approved', async () => {
    const c = govChange(77);
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);
    const run = await approvedRun('unshielded', [{ to: ALICE, amount: 250n, nonce: 0xc7 }], c);

    /* The signers approved 250. Same payee, same token, same everything else. */
    /* RED WHEN the account records an amount the run did not approve, or refuses this one for another reason. */
    await expect(pay(chainSays([[NIGHT, 500n]]), run, run.id, c.salt, ALICE, 400n, 0x40, 0xc7))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);
  });

  it('refuses to pay public money to somebody the signers did not approve', async () => {
    const c = govChange(74);
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);
    const run = await approvedRun('unshielded', [{ to: ALICE, amount: 250n, nonce: 0xc4 }], c);

    /* RED WHEN the account records a payee the run did not approve, or refuses this one for another reason. */
    await expect(pay(chainSays([[NIGHT, 500n]]), run, run.id, c.salt, BOB, 250n, 0x40, 0xc4))
      .rejects.toThrow(NOT_IN_THE_APPROVED_RUN);
  });

  it('refuses to pay more public money than the chain says it holds', async () => {
    const c = govChange(75);
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 100n) as never);
    const run = await approvedRun('unshielded', [{ to: ALICE, amount: 250n, nonce: 0xc5 }], c);

    await expect(pay(chainSays([[NIGHT, 100n]]), run, run.id, c.salt, ALICE, 250n, 0x40, 0xc5))
      .rejects.toThrow(/does not hold enough of that token/i);
  });

  it('pays a payee once, ever', async () => {
    const c = govChange(76);
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);
    const run = await approvedRun('unshielded', [{ to: ALICE, amount: 250n, nonce: 0xc6 }], c);

    const first = await pay(chainSays([[NIGHT, 500n]]), run, run.id, c.salt, ALICE, 250n, 0x40, 0xc6);
    adopt(first as never);
    /* Carry the account's write forward, or the second call is judged against an
     * account that never saw the first. */
    sim.adoptFromCall(first.context);

    await expect(pay(chainSays([[NIGHT, 250n]]), run, run.id, c.salt, ALICE, 250n, 0x40, 0xc6))
      .rejects.toThrow(/already been made/i);
  });

  it("A PUBLIC PAYMENT'S DETAILS COMMIT TO THE AMOUNT: the same payee at another amount is another leaf", () => {
    /*
     * The account binds the amount a second way, through the run's sum tree, so a
     * payment at another amount is refused even by details that left it out. This
     * pins the details on their own, so neither binding quietly stands in for the other.
     */
    /* RED WHEN a payment's details stop covering the amount. */
    expect(hex(vaultCircuits.unshieldedPayoutDetails(ALICE, NIGHT, 250n, bytes(0x40))))
      .not.toBe(hex(vaultCircuits.unshieldedPayoutDetails(ALICE, NIGHT, 900n, bytes(0x40))));
  });

  /* ------------------------------------------------------- retire and forget */

  it('REFUSES TO RETIRE A VAULT HOLDING PUBLIC MONEY, which an empty note pool does not say', async () => {
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);
    expect(vaultLedger(vaultState as never).notes.isEmpty()).toBe(true);

    await expect(vault.impureCircuits.retire(
      ctxFor('retire', chainSays([[NIGHT, 500n]])), bytes(0x51), bytes(0x52)))
      .rejects.toThrow(/still holds public money/i);
  });

  it('will not forget a colour the chain says it still holds', async () => {
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);

    await expect(vault.impureCircuits.forgetUnshielded(
      ctxFor('forgetUnshielded', chainSays([[NIGHT, 500n]])), NIGHT))
      .rejects.toThrow(/still holds some of that token/i);
  });

  it('forgets a colour once the chain says the balance is gone, and the vault can then retire', async () => {
    adopt(await vault.impureCircuits.depositUnshielded(
      ctxFor('depositUnshielded', chainSays()), NIGHT, 500n) as never);

    adopt(await vault.impureCircuits.forgetUnshielded(
      ctxFor('forgetUnshielded', chainSays([])), NIGHT) as never);
    expect(vaultLedger(vaultState as never).unshieldedTokens.isEmpty()).toBe(true);

    /* Retirement now gets as far as the account, which is as far as this vault's
     * own refusals go. The account has no such retire round open, so it refuses
     * there — and that is a DIFFERENT refusal from the two this circuit makes. */
    await expect(vault.impureCircuits.retire(
      ctxFor('retire', chainSays([])), bytes(0x51), bytes(0x52)))
      .rejects.toThrow(/^(?!.*still holds).*$/is);
  });
});
