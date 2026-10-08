/**
 * THE VAULT PAYS FROM SEVERAL NOTES, PAYS BATCHES OF UP TO FOUR, AND MERGES ITS
 * NOTES: EVERY WAY EACH MOVES OR KEEPS MONEY, AND EVERY REFUSAL.
 *
 * The vault and its company's account run here as two contracts in one
 * transaction, as in `the-new-vault.test.ts`: the account's state is handed to
 * the vault's call and the account's writes are carried forward from it.
 *
 * Every assertion names the change that turns it red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract as Vault, ledger as vaultLedger, pureCircuits as V } from '../managed-vault/contract/index.js';
import { pureCircuits as P } from '../managed/contract/index.js';
import { AccountSimulator, change, privateStateFor, type Change } from './simulator.js';
import { sumTreeOfLeaves } from '../../src/midnight/payout-tree.js';
import { copiesTreeOf } from '../../src/midnight/sealed-copies-tree.js';
import { fromHex, toHex, type Hex } from '../../src/core/crypto.js';
import { noFurtherNote, notePlaces, unusedNotePlace } from '../../src/midnight/vault-step-notes.js';
import { replayVault, keptByAStep, whyNoStepCouldBe, type VaultEvent } from '../../src/midnight/vault-recovery.js';
import { STEP_LIMITS } from '../../src/midnight/payment-plan.js';

const A = privateStateFor(1);
const B = privateStateFor(2);

const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ZERO = new Uint8Array(32);
const TOKEN = bytes(0x9b);
const OTHER_TOKEN = bytes(0x42);
const secretOf = (n: number) => { const b = bytes(n); b[31] = 0; return b; };
const SECRET = secretOf(0x51);
const WRONG_SECRET = secretOf(0x53);

interface Coin { nonce: Uint8Array; color: Uint8Array; value: bigint }
type Held = Coin & { mt_index: bigint };
interface VaultPrivate { coin: Held; secret: Uint8Array }

const witnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.secret],
};

const coin = (n: number, value: bigint, color = TOKEN): Held => ({ nonce: bytes(n), color, value, mt_index: 0n });

/** One place of a batch as a vault pays it. */
interface Pay { live: boolean; recipient: Uint8Array; amount: bigint; blinding: Uint8Array; nonce: Uint8Array }
const pay = (to: number, amount: bigint, nonce: number): Pay =>
  ({ live: true, recipient: bytes(to), amount, blinding: bytes(0x40 + to), nonce: bytes(nonce) });
const UNUSED: Pay = { live: false, recipient: ZERO, amount: 0n, blinding: ZERO, nonce: ZERO };
const fill4 = (ps: Pay[]): Pay[] => [...ps, ...Array.from({ length: 4 - ps.length }, () => UNUSED)];

class World {
  sim!: AccountSimulator;
  vault = new Vault<VaultPrivate>(witnesses as never);
  addr = '';
  state: any;
  priv: VaultPrivate = { coin: coin(0, 0n), secret: SECRET };
  lastFx: any;

  get self(): Uint8Array { return fromHex(this.addr); }
  get ledger() { return vaultLedger(this.state.data ?? this.state); }

  /** A vault adopted by a two-of-two account, its first secret set and its copy written. */
  static async started(): Promise<World> {
    const w = new World();
    w.sim = await AccountSimulator.liveAccount([A, B], 2n);
    w.sim.at(NOW);
    w.addr = String(sampleContractAddress());
    const init = await w.vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK), { bytes: fromHex(String(w.sim.address)) } as never);
    w.state = init.currentContractState;
    await w.sim.adoptVault(w.self, [A, B]);
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const copy = { reader: bytes(0x31), parts: [1, 2, 3, 4].map((p) => bytes(8 + p)) };
    const tree = copiesTreeOf(V as never, commitment, [copy]);
    const details = V.secretRunDetails(w.self, ZERO, commitment, tree.root, tree.count);
    const run = await w.run([{ leaf: P.payoutLeaf(details, bytes(9)), amount: 0n }], 401);
    await w.call('setNonceSecret', { ...run.base, nonce: bytes(9), asset: TOKEN, path: run.pathFor(0) },
      ZERO, commitment, tree.root, tree.count, tree.edge, SECRET, ZERO);
    await w.call('writeSecretCopy', commitment, copy.reader, copy.parts, tree.paths[0]);
    return w;
  }

  async call(circuit: string, ...args: unknown[]): Promise<unknown> {
    const provider = {
      getContractState: async (_b: string, address: unknown) =>
        String(address) === String(this.sim.address) ? (this.sim.contractStateForCall as never) : undefined,
    };
    const ctx = createCircuitContext<VaultPrivate>(
      circuit as never, this.addr as never, BLOCK, this.state, this.priv,
      provider as never, undefined, undefined, NOW, BLOCK);
    const out: any = await (this.vault.impureCircuits as any)[circuit](ctx, ...args);
    this.state = out.context.callContext.currentQueryContext.state;
    this.lastFx = out.context.callContext.currentQueryContext.effects;
    try { this.sim.adoptFromCall(out.context); } catch { /* this call did not reach the account */ }
    return out.result;
  }

  async deposit(...coins: Held[]) {
    for (const c of coins) await this.call('deposit', { nonce: c.nonce, color: c.color, value: c.value });
  }

  /**
   * A run over these leaves at these amounts, naming `runVault` (this vault unless named), approved
   * by both signers: what a batch step hands the account, and each leaf's path.
   */
  async run(leaves: Array<{ leaf: Uint8Array; amount: bigint }>, seed: number, runVault = this.self) {
    const tree = sumTreeOfLeaves(leaves.map((l) => toHex(l.leaf) as Hex), leaves.map((l) => l.amount), toHex(TOKEN) as Hex);
    const c: Change = change(0n, seed);
    const payees = BigInt(leaves.length);
    await this.sim.as(this.sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees, from: OPENS, until: CLOSES, vault: runVault });
    const id = this.sim.proposalId(P.runPayload(fromHex(tree.root), payees, OPENS, CLOSES, 0n), c.salt, runVault);
    for (const s of [A, B]) await this.sim.as(this.sim.applying(s, c)).approve(id);
    const base = { proposal: id, runVault, root: fromHex(tree.root), payees, opensAt: OPENS, closesAt: CLOSES, required: 0n, salt: c.salt };
    return { id, base, pathFor: tree.pathFor };
  }

  held(c: Coin): string { return hex(V.heldCommitmentOf(c, V.noteBlindingOf(this.self, c))); }
  nullifierOf(c: Coin): Uint8Array { return V.noteNullifierOf(this.self, { nonce: c.nonce, color: c.color, value: c.value }); }
  notes(): string[] { return [...this.ledger.notes].map(hex).sort(); }
}

/** A payee's leaf, as the run builder makes it, for a run of this vault or a company-wide one. */
const payeeLeaf = (w: World, p: Pay, companyWide = false): Uint8Array => {
  const details = V.payoutDetails(p.recipient, TOKEN, p.amount, p.blinding);
  return P.payoutLeaf(companyWide ? P.companyWideDetailsOf(details, w.self) : details, p.nonce);
};
/** A batch's leaf over four places, as the run builder makes it: a payee's leaf per live place, zero and nothing for an unused one. */
const batchLeaf = (w: World, ps: Pay[], companyWide = false): { leaf: Uint8Array; amount: bigint } => {
  const places = fill4(ps);
  const leaves = places.map((p) => (p.live ? payeeLeaf(w, p, companyWide) : ZERO));
  const amounts = places.map((p) => (p.live ? p.amount : 0n));
  return { leaf: P.batchLeafOf(leaves, amounts), amount: amounts.reduce((t, a) => t + a, 0n) };
};
const batchRun = (r: { base: object; pathFor: (i: number) => unknown }, i: number) => ({ ...r.base, path: r.pathFor(i) });
const singleRun = (r: { base: object; pathFor: (i: number) => unknown }, i: number, nonce: Uint8Array) =>
  ({ ...r.base, nonce, asset: TOKEN, path: r.pathFor(i) });

/** The coin commitments a call claimed as made. */
const claimed = (w: World): string[] => [...w.lastFx.claimedShieldedSpends].map((x: any) =>
  typeof x === 'string' ? x : x instanceof Uint8Array ? hex(x) : String(x.bytes ? hex(x.bytes) : x));
const payeeCoin = (tag: Uint8Array, spent: Uint8Array, p: Pay) =>
  hex(V.coinCommitmentOf({ nonce: V.freshNonceOf(tag, SECRET, spent), color: TOKEN, value: p.amount }, p.recipient, true));
const paidMarks = (w: World, leaf: Uint8Array, nonce: Uint8Array) =>
  [w.sim.ledger.movements.member(P.paidMovementOf(leaf)), w.sim.ledger.movements.member(P.paidOnceOf(nonce))];
const receiptsMinted = (w: World) => [...w.lastFx.unshieldedMints].length;

describe('a payment that draws on several notes', () => {
  it('PAYS A PAYEE NO SINGLE NOTE COVERS FROM TWO NOTES, AND KEEPS THE EXACT CHANGE', async () => {
    const w = await World.started();
    const first = coin(0x71, 60n);
    const second = coin(0x72, 50n);
    await w.deposit(first, second);
    const p = pay(0x0a, 100n, 0xc1);
    const r = await w.run([{ leaf: payeeLeaf(w, p), amount: 100n }], 501);
    w.priv = { ...w.priv, coin: first };
    await w.call('payout', singleRun(r, 0, p.nonce), p.recipient, TOKEN, 100n, p.blinding, [second]);

    const spent = w.nullifierOf(first);
    const kept = { nonce: V.freshNonceOf(V.changeNonceTag(), SECRET, spent), color: TOKEN, value: 10n };
    /* RED WHEN either note stays in the pool, or the change is sized from one note alone. */
    expect(w.notes()).toEqual([w.held(kept)]);
    /* RED WHEN the payee is sent anything but the approved amount, or under another nonce. */
    expect(claimed(w)).toContain(payeeCoin(V.payeeNonceTag(), spent, p));
    /* RED WHEN the account does not record the payment it approved. */
    expect(paidMarks(w, payeeLeaf(w, p), p.nonce)).toEqual([true, true]);
    expect(w.ledger.payments).toBe(1n);
  });

  it('REFUSES NOTES THAT TOGETHER HOLD TOO LITTLE, A FURTHER NOTE OF ANOTHER TOKEN OR NOT HELD, AND ONE NOTE OFFERED TWICE', async () => {
    const w = await World.started();
    const first = coin(0x71, 60n);
    const second = coin(0x72, 30n);
    const other = coin(0x73, 90n, OTHER_TOKEN);
    await w.deposit(first, second, other);
    const p = pay(0x0a, 100n, 0xc2);
    const r = await w.run([{ leaf: payeeLeaf(w, p), amount: 100n }], 502);
    w.priv = { ...w.priv, coin: first };
    const payWith = (more: Held[]) => w.call('payout', singleRun(r, 0, p.nonce), p.recipient, TOKEN, 100n, p.blinding, more);
    /* RED WHEN what the notes hold together is not compared with the amount. */
    await expect(payWith([second])).rejects.toThrow(/the notes offered do not hold enough/);
    /* RED WHEN a further note's token is not checked. */
    await expect(payWith([other])).rejects.toThrow(/every note a step spends is of the token it pays/);
    /* RED WHEN a further note is spent without being found in the pool. */
    await expect(payWith([coin(0x74, 50n)])).rejects.toThrow(/not in this vault's pool/);
    /* RED WHEN one note may stand in two places: the first spend takes it out of the pool. */
    await expect(payWith([first])).rejects.toThrow(/not in this vault's pool/);
    expect(w.notes()).toHaveLength(3);
  });
});

describe('a batch of up to four payees, approved together', () => {
  it('PAYS FOUR PAYEES FROM THREE NOTES WITH ONE RECEIPT, MARKS EACH PAID, KEEPS THE CHANGE AND MARKS THE RUN PAID FROM', async () => {
    const w = await World.started();
    const notes = [coin(0x71, 100n), coin(0x72, 100n), coin(0x73, 100n)];
    await w.deposit(...notes);
    const ps = [pay(0x0a, 50n, 0xd1), pay(0x0b, 60n, 0xd2), pay(0x0c, 70n, 0xd3), pay(0x0d, 80n, 0xd4)];
    const r = await w.run([batchLeaf(w, ps)], 511);
    await w.call('batchPayout', batchRun(r, 0), TOKEN, ps, notes);

    const spent = w.nullifierOf(notes[0]!);
    const kept = { nonce: V.freshNonceOf(V.changeNonceTag(), SECRET, spent), color: TOKEN, value: 40n };
    /* RED WHEN a note stays in the pool, or the change is not what the three held less what the four were paid. */
    expect(w.notes()).toEqual([w.held(kept)]);
    /* RED WHEN a place is paid under another place's tag, another amount or another payee. */
    for (const [i, p] of ps.entries()) expect(claimed(w)).toContain(payeeCoin(V.batchPayeeNonceTag(BigInt(i)), spent, p));
    /* RED WHEN a batch mints more than one receipt, or none. */
    expect(receiptsMinted(w)).toBe(1);
    /* RED WHEN any payee of the batch is not marked by both marks a single payment writes. */
    for (const p of ps) expect(paidMarks(w, payeeLeaf(w, p), p.nonce)).toEqual([true, true]);
    /* RED WHEN a batch does not mark its run paid from, so the run could still be held after money left. */
    expect(hex(w.sim.ledger.proposalHolds.lookup(r.id).runHold.placedBy)).toBe(hex(P.paidFromMark()));
    expect(w.ledger.payments).toBe(1n);
  });

  it('PAYS A BATCH OF ONE AND MAKES NO COIN FOR AN UNUSED PLACE', async () => {
    const w = await World.started();
    const note = coin(0x71, 25n);
    await w.deposit(note);
    const p = pay(0x0a, 25n, 0xd5);
    const r = await w.run([batchLeaf(w, [p])], 512);
    await w.call('batchPayout', batchRun(r, 0), TOKEN, fill4([p]), notePlaces([note], 3));
    /* RED WHEN an unused place makes a coin, or an exact spend writes a change note. */
    expect(claimed(w)).toEqual([payeeCoin(V.batchPayeeNonceTag(0n), w.nullifierOf(note), p)]);
    expect(w.notes()).toEqual([]);
  });

  it('REFUSES A BATCH CHANGED FROM THE ONE APPROVED: AN AMOUNT, A PAYEE, A PLACE TURNED OFF, OR THE PLACES REORDERED', async () => {
    const w = await World.started();
    const note = coin(0x71, 1_000n);
    await w.deposit(note);
    const ps = [pay(0x0a, 50n, 0xe1), pay(0x0b, 60n, 0xe2)];
    const r = await w.run([batchLeaf(w, ps)], 513);
    const send = (places: Pay[]) => w.call('batchPayout', batchRun(r, 0), TOKEN, fill4(places), notePlaces([note], 3));
    const refused = /that batch is not in the approved run/;
    /* RED WHEN the amounts are not bound into the batch's leaf. */
    await expect(send([{ ...ps[0]!, amount: 51n }, ps[1]!])).rejects.toThrow(refused);
    /* RED WHEN the payees are not bound into it. */
    await expect(send([{ ...ps[0]!, recipient: bytes(0x0f) }, ps[1]!])).rejects.toThrow(refused);
    /* RED WHEN which places pay is not bound into it. */
    await expect(send([ps[0]!])).rejects.toThrow(refused);
    /* RED WHEN the places' order is not bound into it. */
    await expect(send([ps[1]!, ps[0]!])).rejects.toThrow(refused);
    await send(ps);
  });

  it('REFUSES A LIVE PLACE AT NOTHING AND A BATCH THAT PAYS NOBODY', async () => {
    const w = await World.started();
    const note = coin(0x71, 100n);
    await w.deposit(note);
    const zero = { ...pay(0x0a, 0n, 0xe3) };
    const r = await w.run([batchLeaf(w, [pay(0x0b, 10n, 0xe4)])], 514);
    /* RED WHEN a live place may pay nothing, which would mark a person paid with nobody paid. */
    await expect(w.call('batchPayout', batchRun(r, 0), TOKEN, fill4([zero]), notePlaces([note], 3)))
      .rejects.toThrow(/a payment of nothing records a person as paid/);
    /* RED WHEN the vault sends a batch of four unused places on to the account (the account's own refusal reads differently). */
    await expect(w.call('batchPayout', batchRun(r, 0), TOKEN, fill4([]), notePlaces([note], 3)))
      .rejects.toThrow(/a batch pays at least one person/);
  });

  it("REFUSES A BATCH MADE WITHOUT THE VAULT'S CURRENT SECRET", async () => {
    const w = await World.started();
    const note = coin(0x71, 100n);
    await w.deposit(note);
    const ps = [pay(0x0a, 10n, 0xe6)];
    const r = await w.run([batchLeaf(w, ps)], 521);
    w.priv = { ...w.priv, secret: WRONG_SECRET };
    /* RED WHEN a batch makes its coins under whatever secret the device offers: its change could never be named again. */
    await expect(w.call('batchPayout', batchRun(r, 0), TOKEN, fill4(ps), notePlaces([note], 3)))
      .rejects.toThrow(/that is not this vault's current nonce secret/);
    expect(w.notes()).toEqual([w.held(note)]);
  });

  it('THE ACCOUNT ITSELF REFUSES A BATCH WITH NO PLACE THAT PAYS, AND AN UNUSED PLACE CARRYING AN AMOUNT', async () => {
    const w = await World.started();
    const p = pay(0x0a, 10n, 0xe7);
    const live = { live: true, details: V.payoutDetails(p.recipient, TOKEN, p.amount, p.blinding), nonce: p.nonce, amount: p.amount };
    const dead = (amount: bigint) => ({ live: false, details: ZERO, nonce: ZERO, amount });
    type Slot = typeof live;
    /* Each run approves exactly the batch leaf the shape below makes, so only the check under test can refuse it. */
    const approvedAs = async (slots: Slot[], seed: number) => {
      const leaves = slots.map((x) => (x.live ? payeeLeaf(w, p) : ZERO));
      const amounts = slots.map((x) => x.amount);
      return w.run([{ leaf: P.batchLeafOf(leaves, amounts), amount: amounts.reduce((t, a) => t + a, 0n) }], seed);
    };
    /* The account's step, called on its own: the vault's checks are not in front of it. */
    const record = (r: Awaited<ReturnType<typeof approvedAs>>, slots: Slot[]) =>
      (w.sim as any).run('recordBatchFromVault', (c: any) => w.sim.contract.impureCircuits.recordBatchFromVault(c,
        r.id, w.self, w.self, r.base.root, r.base.payees, OPENS, CLOSES, 0n, r.base.salt, slots, TOKEN, r.pathFor(0)));
    const nobody = [dead(0n), dead(0n), dead(0n), dead(0n)];
    const carrying = [live, dead(5n), dead(0n), dead(0n)];
    /* RED WHEN the account accepts a batch none of whose places pays, even one a run approved. */
    await expect(record(await approvedAs(nobody, 522), nobody)).rejects.toThrow(/a batch with no place that pays records no payment/);
    /* RED WHEN an unused place may carry an amount into the batch's total, even one a run approved. */
    await expect(record(await approvedAs(carrying, 523), carrying)).rejects.toThrow(/either pays someone something or is unused/);
    const fine = [live, dead(0n), dead(0n), dead(0n)];
    await record(await approvedAs(fine, 524), fine);
    expect(paidMarks(w, payeeLeaf(w, p), p.nonce)).toEqual([true, true]);
  });

  it("THE VAULT SENDS AN UNUSED PLACE ON AS NOTHING, WHATEVER AMOUNT IT WAS HANDED", async () => {
    const w = await World.started();
    const note = coin(0x71, 100n);
    await w.deposit(note);
    const ps = [pay(0x0a, 10n, 0xe8)];
    const r = await w.run([batchLeaf(w, ps)], 525);
    /* RED WHEN an unused place's amount reaches the account, which then refuses a batch the run approved. */
    await w.call('batchPayout', batchRun(r, 0), TOKEN, [ps[0]!, { ...UNUSED, amount: 7n }, UNUSED, UNUSED], notePlaces([note], 3));
    expect(paidMarks(w, payeeLeaf(w, ps[0]!), ps[0]!.nonce)).toEqual([true, true]);
  });

  it('REFUSES NOTES THAT HOLD LESS THAN THE BATCH, A NOTE OF ANOTHER TOKEN, AND A NOTE IT DOES NOT HOLD', async () => {
    const w = await World.started();
    const small = coin(0x71, 40n);
    const other = coin(0x72, 500n, OTHER_TOKEN);
    await w.deposit(small, other);
    const ps = [pay(0x0a, 50n, 0xe5)];
    const r = await w.run([batchLeaf(w, ps)], 515);
    const send = (notes: Held[]) => w.call('batchPayout', batchRun(r, 0), TOKEN, fill4(ps), notePlaces(notes, 3));
    /* RED WHEN what the notes hold is not compared with the batch's total. */
    await expect(send([small])).rejects.toThrow(/the notes offered do not hold enough/);
    /* RED WHEN the first note's token is not checked. */
    await expect(send([other])).rejects.toThrow(/that is not a note of the token being paid/);
    /* RED WHEN a note is spent without being found in the pool. */
    await expect(send([coin(0x73, 500n)])).rejects.toThrow(/not in this vault's pool/);
  });

  it('NOBODY IS PAID TWICE: A BATCH REPLAYED, A PAYEE PAID ALONE THEN IN A BATCH, OR TWICE IN ONE BATCH', async () => {
    const w = await World.started();
    const big = coin(0x71, 10_000n);
    await w.deposit(big);
    let held: Held = big;
    const afterPaying = (paid: bigint) => {
      held = { nonce: V.freshNonceOf(V.changeNonceTag(), SECRET, w.nullifierOf(held)), color: TOKEN, value: held.value - paid, mt_index: 0n };
    };
    const alone = pay(0x0a, 50n, 0xf1);
    const ps = [alone, pay(0x0b, 60n, 0xf2)];
    const twice = [pay(0x0c, 70n, 0xf3), pay(0x0c, 70n, 0xf3)];
    const r = await w.run([{ leaf: payeeLeaf(w, alone), amount: 50n }, batchLeaf(w, ps), batchLeaf(w, twice)], 516);

    w.priv = { ...w.priv, coin: held };
    await w.call('payout', singleRun(r, 0, alone.nonce), alone.recipient, TOKEN, 50n, alone.blinding, noFurtherNote());
    afterPaying(50n);
    /* RED WHEN a batch does not check each of its payees against the marks a single payment wrote. */
    await expect(w.call('batchPayout', batchRun(r, 1), TOKEN, fill4(ps), notePlaces([held], 3)))
      .rejects.toThrow(/that payment has already been made/);
    /* RED WHEN one payee standing in two places of one batch is paid twice. */
    await expect(w.call('batchPayout', batchRun(r, 2), TOKEN, fill4(twice), notePlaces([held], 3)))
      .rejects.toThrow(/that payment has already been made/);
  });

  it('A BATCH IS PAID ONCE, AND TWO LEAVES CARRYING ONE PAYEE NONCE ARE PAID ONCE BETWEEN THEM', async () => {
    const w = await World.started();
    const big = coin(0x71, 10_000n);
    await w.deposit(big);
    const ps = [pay(0x0a, 50n, 0xf4)];
    const sameNonce = [pay(0x0b, 60n, 0xf4)];
    const r = await w.run([batchLeaf(w, ps), batchLeaf(w, sameNonce)], 517);
    await w.call('batchPayout', batchRun(r, 0), TOKEN, fill4(ps), notePlaces([big], 3));
    const change: Held = { nonce: V.freshNonceOf(V.changeNonceTag(), SECRET, w.nullifierOf(big)), color: TOKEN, value: 9_950n, mt_index: 0n };
    /* RED WHEN a batch's payees are not marked: the same batch, from new notes, would pay again. */
    await expect(w.call('batchPayout', batchRun(r, 0), TOKEN, fill4(ps), notePlaces([change], 3)))
      .rejects.toThrow(/that payment has already been made/);
    /* RED WHEN a batch's places do not write the person-and-month mark a payee nonce stands for. */
    await expect(w.call('batchPayout', batchRun(r, 1), TOKEN, fill4(sameNonce), notePlaces([change], 3)))
      .rejects.toThrow(/a payment is already recorded for this person/);
  });

  it("A BATCH LEAF IS NOT A PAYEE'S LEAF: NEITHER CAN BE PAID AS THE OTHER", async () => {
    const w = await World.started();
    const big = coin(0x71, 10_000n);
    await w.deposit(big);
    const p = pay(0x0a, 50n, 0xf5);
    const q = pay(0x0b, 70n, 0xf6);
    const r = await w.run([batchLeaf(w, [p]), { leaf: payeeLeaf(w, q), amount: 70n }], 518);
    w.priv = { ...w.priv, coin: big };
    /* RED WHEN a payee whose only leaf is inside a batch can be paid alone. */
    await expect(w.call('payout', singleRun(r, 0, p.nonce), p.recipient, TOKEN, 50n, p.blinding, noFurtherNote()))
      .rejects.toThrow(/that payee is not in the approved run/);
    /* RED WHEN a single payee's leaf can be paid as a batch of one. */
    await expect(w.call('batchPayout', batchRun(r, 1), TOKEN, fill4([q]), notePlaces([big], 3)))
      .rejects.toThrow(/that batch is not in the approved run/);
  });

  it('A COMPANY-WIDE BATCH IS PAID ONLY BY THE VAULT ITS PLACES NAME', async () => {
    const w = await World.started();
    const big = coin(0x71, 1_000n);
    await w.deposit(big);
    const ps = [pay(0x0a, 50n, 0xf7)];
    const forOther = await w.run([batchLeaf(w, ps)], 519, P.companyWide());
    /* RED WHEN a company-wide batch's places are not bound to the paying vault: leaves built for no vault pay here. */
    await expect(w.call('batchPayout', batchRun(forOther, 0), TOKEN, fill4(ps), notePlaces([big], 3)))
      .rejects.toThrow(/that batch is not in the approved run/);
    const forThis = await w.run([batchLeaf(w, ps, true)], 520, P.companyWide());
    await w.call('batchPayout', batchRun(forThis, 0), TOKEN, fill4(ps), notePlaces([big], 3));
    expect(paidMarks(w, payeeLeaf(w, ps[0]!, true), ps[0]!.nonce)).toEqual([true, true]);
  });

  it('THE BATCH LEAF IS ITS OWN KIND, UNDER TAG 19, AND ITS VALUE IS PINNED', () => {
    const leaves = [bytes(1), bytes(2), ZERO, ZERO];
    const amounts = [5n, 7n, 0n, 0n];
    /* RED WHEN the batch leaf's tag, its order of fields, or its hash changes: every run raised over batches would stop paying. */
    expect(hex(P.batchLeafOf(leaves, amounts))).toBe(BATCH_LEAF_PIN);
    /* RED WHEN a batch of one is the same value as that payee's own leaf, so one could be paid as the other. */
    const own = P.payoutLeaf(bytes(3), bytes(4));
    expect(hex(P.batchLeafOf([own, ZERO, ZERO, ZERO], [5n, 0n, 0n, 0n]))).not.toBe(hex(own));
  });
});

/** `batchLeafOf([1…, 2…, 0, 0], [5, 7, 0, 0])`, worked out once by the contract. */
const BATCH_LEAF_PIN = '597ad2ccaa579ca30a6fd26aff90679b351fd823efe925ee1d66069e1dbd766b';

describe('a merge, which needs no approval', () => {
  it('MERGES TWO, THREE OR FOUR NOTES INTO ONE THE VAULT KEEPS, WORTH EXACTLY WHAT THEY HELD', async () => {
    for (const count of [2, 3, 4]) {
      const w = await World.started();
      const notes = Array.from({ length: count }, (_, i) => coin(0x71 + i, BigInt(10 * (i + 1))));
      await w.deposit(...notes);
      const movementsBefore = [...w.sim.ledger.movements].length;
      await w.call('mergeNotes', TOKEN, notePlaces(notes, 4));
      const value = notes.reduce((t, n) => t + n.value, 0n);
      const kept = { nonce: V.freshNonceOf(V.mergeNonceTag(), SECRET, w.nullifierOf(notes[0]!)), color: TOKEN, value };
      /* RED WHEN a merged note stays, the kept coin is worth anything but their sum, or it is made under another nonce. */
      expect(w.notes()).toEqual([w.held(kept)]);
      /* RED WHEN a merge mints a receipt, asks the account, or counts as a payment. */
      expect(receiptsMinted(w)).toBe(0);
      expect([...w.sim.ledger.movements].length).toBe(movementsBefore);
      expect(w.ledger.payments).toBe(0n);
    }
  });

  it("REFUSES A MERGE OF ONE NOTE, A NOTE OF ANOTHER TOKEN OR NOT HELD, ONE NOTE TWICE, AND A CALLER WITHOUT THE VAULT'S SECRET", async () => {
    const w = await World.started();
    const a = coin(0x71, 10n);
    const b = coin(0x72, 20n);
    const other = coin(0x73, 30n, OTHER_TOKEN);
    await w.deposit(a, b, other);
    const merge = (notes: Held[]) => w.call('mergeNotes', TOKEN, notePlaces(notes, 4));
    /* RED WHEN a merge of one note is accepted: it would only spend a fee and change a nonce. */
    await expect(merge([a])).rejects.toThrow(/a merge takes at least two notes/);
    /* RED WHEN a merge's notes are not all of its token. */
    await expect(merge([a, other])).rejects.toThrow(/every note a step spends is of the token it pays/);
    await expect(merge([other, a])).rejects.toThrow(/every note a step spends is of the token it pays/);
    /* RED WHEN a merge spends a note the pool does not hold, or one note twice. */
    await expect(merge([a, coin(0x74, 5n)])).rejects.toThrow(/not in this vault's pool/);
    await expect(merge([a, a])).rejects.toThrow(/not in this vault's pool/);
    /* RED WHEN a merge is made without the vault's current secret, so its coin could be one nobody can name. */
    w.priv = { ...w.priv, secret: WRONG_SECRET };
    await expect(merge([a, b])).rejects.toThrow(/that is not this vault's current nonce secret/);
    expect(w.notes()).toHaveLength(3);
  });

  it('REFUSES A MERGE BEFORE THE VAULT HAS ITS FIRST SECRET', async () => {
    const w = new World();
    w.sim = await AccountSimulator.liveAccount([A, B], 2n);
    w.sim.at(NOW);
    w.addr = String(sampleContractAddress());
    w.state = (await w.vault.initialState(createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: fromHex(String(w.sim.address)) } as never)).currentContractState;
    /* RED WHEN a merge does not ask whether the vault has started. */
    await expect(w.call('mergeNotes', TOKEN, notePlaces([coin(1, 1n), coin(2, 1n)], 4)))
      .rejects.toThrow(/this vault takes no money yet/);
  });
});

describe('the places a step is handed', () => {
  it('THE PLANNER\'S STEP SIZES ARE THE COMPILED VAULT\'S', () => {
    const info = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'managed-vault', 'compiler', 'contract-info.json'), 'utf8'));
    const length = (circuit: string, arg: string) =>
      info.circuits.find((c: any) => c.name === circuit).arguments.find((a: any) => a.name === arg).type.length;
    /* RED WHEN the planner's limits and the vault's fixed lengths part: a plan would hand a step more notes than it takes. */
    expect(length('payout', 'more') + 1).toBe(STEP_LIMITS.paymentNotes);
    expect(length('batchPayout', 'notes')).toBe(STEP_LIMITS.batchNotes);
    expect(length('batchPayout', 'pays')).toBe(STEP_LIMITS.batchPlaces);
    expect(length('mergeNotes', 'notes')).toBe(STEP_LIMITS.mergeNotes);
  });

  it('fills a step\'s places with unused ones, and refuses more notes than places or a note worth nothing', () => {
    expect(notePlaces([coin(1, 5n)], 3).map((n) => n.value)).toEqual([5n, 0n, 0n]);
    expect(noFurtherNote()).toEqual([unusedNotePlace()]);
    /* RED WHEN a step is handed more notes than it has places, which the circuit's fixed length would cut. */
    expect(() => notePlaces([coin(1, 5n), coin(2, 5n)], 1)).toThrow(/at most 1 note/);
    /* RED WHEN a note worth nothing is handed as one to spend: the vault would read it as unused. */
    expect(() => notePlaces([coin(1, 0n)], 3)).toThrow(/worth nothing/);
  });
});

describe('recovery names every coin these steps made', () => {
  it('REBUILDS THE POOL AFTER A TWO-NOTE PAYMENT, A BATCH AND A MERGE, AND THE MERGED NOTE IT NAMES IS SPENT', async () => {
    const w = await World.started();
    const notes = [coin(0x71, 60n), coin(0x72, 50n), coin(0x73, 300n), coin(0x74, 40n), coin(0x75, 45n)];
    await w.deposit(...notes);
    const single = pay(0x0a, 100n, 0xa1);
    const ps = [pay(0x0b, 70n, 0xa2), pay(0x0c, 80n, 0xa3)];
    const after = pay(0x0d, 80n, 0xa4);
    const r = await w.run([{ leaf: payeeLeaf(w, single), amount: 100n }, batchLeaf(w, ps), { leaf: payeeLeaf(w, after), amount: 80n }], 530);

    w.priv = { ...w.priv, coin: notes[0]! };
    await w.call('payout', singleRun(r, 0, single.nonce), single.recipient, TOKEN, 100n, single.blinding, [notes[1]!]);
    await w.call('batchPayout', batchRun(r, 1), TOKEN, fill4(ps), notePlaces([notes[2]!], 3));
    await w.call('mergeNotes', TOKEN, notePlaces([notes[3]!, notes[4]!], 4));

    const hexed = (c: Held) => ({ nonce: toHex(c.nonce) as Hex, token: toHex(c.color) as Hex, value: c.value });
    const history: VaultEvent[] = [
      ...notes.map((c) => ({ kind: 'deposit' as const, coin: hexed(c) })),
      { kind: 'payout', spent: toHex(notes[0]!.nonce) as Hex, amount: 100n, further: [toHex(notes[1]!.nonce) as Hex] },
      { kind: 'batch', spent: [toHex(notes[2]!.nonce) as Hex], amounts: [70n, 80n, 0n, 0n] },
      { kind: 'merge', spent: [toHex(notes[3]!.nonce) as Hex, toHex(notes[4]!.nonce) as Hex] },
    ];
    const rebuilt = replayVault({
      vault: w.addr as Hex, chain: w.notes() as Hex[], pool: [], history, circuits: V as never,
      nonceSecrets: { secrets: [toHex(SECRET) as Hex], commitment: toHex(w.ledger.nonceCommitment) as Hex },
    });
    /* RED WHEN any coin these steps kept is named with another nonce or value: it would come back unexplained. */
    expect(rebuilt.unexplained).toEqual([]);
    expect(rebuilt.held.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([10n, 85n, 150n]);
    /* RED WHEN a batch place's coin is named under another place's tag, or the payment's under the batch's. */
    const paidNonces = rebuilt.paid.map((c) => c.nonce);
    expect(paidNonces).toContain(toHex(V.freshNonceOf(V.payeeNonceTag(), SECRET, w.nullifierOf(notes[0]!))));
    expect(paidNonces).toContain(toHex(V.freshNonceOf(V.batchPayeeNonceTag(1n), SECRET, w.nullifierOf(notes[2]!))));

    /* And the merged note it named is real: the vault spends it. */
    const merged = rebuilt.held.find((n) => n.value === 85n)!;
    w.priv = { ...w.priv, coin: { nonce: fromHex(merged.nonce), color: TOKEN, value: 85n, mt_index: 0n } };
    await w.call('payout', singleRun(r, 2, after.nonce), after.recipient, TOKEN, 80n, after.blinding, noFurtherNote());
    expect(paidMarks(w, payeeLeaf(w, after), after.nonce)).toEqual([true, true]);
  });
});

describe('the journal alone names what every note of a step left, when the pool write was lost', () => {
  it('A TWO-NOTE PAYMENT, A BATCH OF TWO NOTES AND A MERGE, EACH JOURNALLED BEFORE ITS CALL, ARE REBUILT FROM THEIR LINES, AND WHAT THEY NAME SPENDS', async () => {
    const w = await World.started();
    const notes = [coin(0x81, 60n), coin(0x82, 50n), coin(0x83, 100n), coin(0x84, 90n), coin(0x85, 40n), coin(0x86, 45n)];
    await w.deposit(...notes);
    const single = pay(0x0a, 100n, 0xb1);
    const ps = [pay(0x0b, 70n, 0xb2), pay(0x0c, 80n, 0xb3)];
    const after = pay(0x0d, 80n, 0xb4);
    const r = await w.run([{ leaf: payeeLeaf(w, single), amount: 100n }, batchLeaf(w, ps), { leaf: payeeLeaf(w, after), amount: 80n }], 531);

    w.priv = { ...w.priv, coin: notes[0]! };
    await w.call('payout', singleRun(r, 0, single.nonce), single.recipient, TOKEN, 100n, single.blinding, [notes[1]!]);
    await w.call('batchPayout', batchRun(r, 1), TOKEN, fill4(ps), notePlaces([notes[2]!, notes[3]!], 3));
    await w.call('mergeNotes', TOKEN, notePlaces([notes[4]!, notes[5]!], 4));

    /*
     * No pool was written after any of the three: only the deposits are known as notes, and each step's journal line,
     * written before its call, names every note it spent. RED WHEN an attempt is derived from its first note alone - the
     * coin it kept would be named at the first note's value less what left, which the chain never made.
     */
    const hexed = (c: Held) => ({ nonce: toHex(c.nonce) as Hex, token: toHex(c.color) as Hex, value: c.value });
    const rebuilt = replayVault({
      vault: w.addr as Hex, chain: w.notes() as Hex[], pool: notes.map(hexed),
      history: [
        ...notes.map((c) => ({ kind: 'deposit' as const, coin: hexed(c) })),
        { kind: 'payout-attempt', spent: hexed(notes[0]!), further: [hexed(notes[1]!)], amount: 100n },
        { kind: 'payout-attempt', spent: hexed(notes[2]!), further: [hexed(notes[3]!)], amount: 150n },
        { kind: 'payout-attempt', spent: hexed(notes[4]!), further: [hexed(notes[5]!)], merge: true, amount: 0n },
      ],
      circuits: V as never,
      nonceSecrets: { secrets: [toHex(SECRET) as Hex], commitment: toHex(w.ledger.nonceCommitment) as Hex },
    });
    expect(rebuilt.unexplained, 'RED WHEN: a coin a several-note step kept comes back unexplained').toEqual([]);
    expect(rebuilt.held.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([10n, 40n, 85n]);
    /* Every note the steps spent is stale: the pool that still held them is told so, and none is offered again. */
    expect(rebuilt.stale.map((n) => n.nonce).sort()).toEqual(notes.map((c) => toHex(c.nonce)).sort());

    const merged = rebuilt.held.find((n) => n.value === 85n)!;
    w.priv = { ...w.priv, coin: { nonce: fromHex(merged.nonce), color: TOKEN, value: 85n, mt_index: 0n } };
    await w.call('payout', singleRun(r, 2, after.nonce), after.recipient, TOKEN, 80n, after.blinding, noFurtherNote());
    expect(paidMarks(w, payeeLeaf(w, after), after.nonce), 'RED WHEN: the merged note the journal named is not the vault\'s').toEqual([true, true]);
  });

  it('refuses an attempt line no step could have made', () => {
    const N = (n: number, value: bigint) => ({ nonce: toHex(bytes(n)) as Hex, token: toHex(TOKEN) as Hex, value });
    const replay = (e: VaultEvent) => () => replayVault({ vault: toHex(bytes(0xee)) as Hex, chain: [], pool: [], history: [e], circuits: V as never });
    /* RED WHEN a payment line paying more than all its notes held is derived from. */
    expect(replay({ kind: 'payout-attempt', spent: N(1, 10n), further: [N(2, 20n)], amount: 31n })).toThrow(/which together the line says hold 30/);
    /* RED WHEN a merge line of one note, or one sending money out, is derived from. */
    expect(replay({ kind: 'payout-attempt', spent: N(1, 10n), merge: true, amount: 0n })).toThrow(/A merge takes at least two notes and sends nothing/);
    expect(replay({ kind: 'payout-attempt', spent: N(1, 10n), further: [N(2, 20n)], merge: true, amount: 5n })).toThrow(/sends nothing/);
    /* RED WHEN one note named twice in a line is read as two notes. */
    expect(replay({ kind: 'payout-attempt', spent: N(1, 10n), further: [N(1, 10n)], amount: 15n })).toThrow(/names one note twice/);
    /* RED WHEN a line of two tokens is derived from: the coin it names is no coin the vault made. */
    expect(replay({ kind: 'payout-attempt', spent: N(1, 10n), further: [{ ...N(2, 20n), token: toHex(OTHER_TOKEN) as Hex }], amount: 15n })).toThrow(/notes of two tokens/);
    /* The same statement refuses the line on the device, where a step's coin is named to ask the chain about it. */
    expect(whyNoStepCouldBe({ spent: N(1, 10n), merge: true, amount: 0n })).toMatch(/A merge takes at least two notes/);
    expect(() => keptByAStep({ spent: N(1, 10n), merge: true, amount: 0n }, { circuits: V as never, vault: toHex(bytes(0xee)) as Hex, secret: toHex(SECRET) as Hex }))
      .toThrow(/A merge takes at least two notes/);
  });
});

describe('recovery refuses a history no vault could have', () => {
  const N = (n: number, value: bigint) => ({ nonce: toHex(bytes(n)) as Hex, token: toHex(TOKEN) as Hex, value });
  const run = (history: VaultEvent[]) => () => replayVault({
    vault: toHex(bytes(0xee)) as Hex, chain: [], pool: [], history, circuits: V as never,
  });
  const two: VaultEvent[] = [{ kind: 'deposit', coin: N(1, 10n) }, { kind: 'deposit', coin: N(2, 20n) }];
  it('a merge of one note, a step naming one note twice, and steps paying more than their notes held', () => {
    /* RED WHEN a merge of one note is replayed as keeping a note. */
    expect(run([...two, { kind: 'merge', spent: [N(1, 0n).nonce] }])).toThrow(/a merge takes at least two/);
    /* RED WHEN one note in two places of a step is replayed as two notes. */
    expect(run([...two, { kind: 'merge', spent: [N(1, 0n).nonce, N(1, 0n).nonce] }])).toThrow(/one note twice/);
    /* RED WHEN a payment from two notes may pay more than both held. */
    expect(run([...two, { kind: 'payout', spent: N(1, 0n).nonce, amount: 31n, further: [N(2, 0n).nonce] }])).toThrow(/from notes holding 30/);
    /* RED WHEN a batch may pay more than its notes held, or pay nobody. */
    expect(run([...two, { kind: 'batch', spent: [N(1, 0n).nonce], amounts: [11n, 0n, 0n, 0n] }])).toThrow(/from notes holding 10/);
    expect(run([...two, { kind: 'batch', spent: [N(1, 0n).nonce], amounts: [0n, 0n, 0n, 0n] }])).toThrow(/pays nobody/);
    /* Without the secret a merge's note is listed as not named, never guessed. */
    expect(run([...two, { kind: 'merge', spent: [N(1, 0n).nonce, N(2, 0n).nonce] }])().unnamedWithoutTheSecret).toEqual([2]);
  });
});
