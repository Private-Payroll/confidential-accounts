/**
 * S6a: THE VAULT DIVIDES ONE OF ITS OWN NOTES AND KEEPS BOTH HALVES.
 *
 * The pool's size is a privacy property — the count is public, so a constant is
 * uninformative where a moving number is a signal — and before this circuit
 * existed nothing could restore it. `deposit` adds a note from outside;
 * `payout` removes one and puts the change back. A pool that had fallen from
 * sixteen to twelve stayed there, and the product had no business claiming a
 * fixed size.
 *
 * **The one to read first is "a half of a split really SPENDS".** Everything
 * else here checks that the contract wrote what it meant to write; that one
 * checks that what it wrote can be moved again. The register's rule is explicit
 * about the difference — *never ship a derivation of a value the money depends
 * on without a test that spends the result* — and V-47 is in it because a
 * derivation that compiled and read plausibly was wrong.
 *
 * Every note here is committed under a blinding the CONTRACT derives
 * (`noteBlindingOf`), which is the same change: a value the money depends on,
 * newly derived, so it is spent rather than merely compared.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as vaultCircuits,
} from '../managed-vault/contract/index.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change } from './simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';

const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const A = privateStateFor(1);
const B = privateStateFor(2);
const GBP = bytes(0x9b);
const USD = bytes(0x7d);
const ALICE = bytes(0x0a);

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
};

const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) =>
  sim.applying(d, c);

/**
 * EVERY coin this call sent back to the vault, in the order the outputs carry.
 *
 * Written here rather than taken from `src/midnight/vault-coins.ts`, and that
 * is a FINDING rather than a convenience: `changeCoinOf` throws when it finds
 * more than one output addressed to the vault — deliberately, because one
 * payment produces at most one change coin and guessing between two would hand
 * a caller something that is not the whole of what the vault holds. A split
 * produces exactly two. So the client that drives this circuit (S6h) needs a
 * plural reader, and does not have one yet.
 */
const coinsBackTo = (zswap: unknown, vaultAddress: string) => {
  const outputs = (zswap as { outputs?: unknown[] } | undefined)?.outputs ?? [];
  return outputs
    .filter((o) => {
      const r = (o as { recipient?: { is_left?: boolean; right?: { bytes?: Uint8Array } } })
        .recipient;
      return r?.is_left === false && r.right?.bytes !== undefined
        && toHex(r.right.bytes) === vaultAddress;
    })
    .map((o) => {
      const c = (o as { coinInfo: { nonce: Uint8Array; color: Uint8Array; value: bigint } })
        .coinInfo;
      return { nonce: c.nonce, color: c.color, value: c.value };
    });
};

/** The pool's record for a coin, from the contract's own two circuits. */
const heldBy = (
  addr: Uint8Array,
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
) => vaultCircuits.heldCommitmentOf(coin, vaultCircuits.noteBlindingOf(addr, coin));

describe('S6a: a vault splits one of its own notes', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: string;
  let vaultState: any;
  let priv: VaultPrivate;

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });
  const vaultBytes = () => Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
  const ctx = (circuit: string) => createCircuitContext<VaultPrivate>(
    circuit, vaultAddr as never, BLOCK, vaultState, priv,
    provider() as never, undefined, undefined, VAULT_NOW, BLOCK);

  const pool = (state: any = vaultState) => vaultLedger(state as never).notes;

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(VAULT_NOW);

    vault = new Vault<VaultPrivate>(vaultWitnesses as never);
    vaultAddr = sampleContractAddress() as never as string;
    const init = await vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex')) } as never);
    vaultState = init.currentContractState;

    /* One note of 1,000. The pool starts at one and the whole point is to make it two. */
    const coin = { nonce: bytes(0x77), color: GBP, value: 1_000n };
    priv = { coin: { ...coin, mt_index: 0n } };
    const dep = await vault.impureCircuits.deposit(ctx('deposit'), coin);
    vaultState = dep.context.callContext.currentQueryContext.state;
  });

  /** Splits `amount` off the note the witness is currently offering. */
  const split = async (token: Uint8Array, amount: bigint) => {
    const r = await vault.impureCircuits.splitNote(ctx('splitNote'), token, amount);
    vaultState = r.context.callContext.currentQueryContext.state;
    return r;
  };

  it('turns ONE note into TWO, and both are notes the chain says this vault holds', async () => {
    expect(pool().size()).toBe(1n);

    const r = await split(GBP, 300n);

    /*
     * The count is the property §3.5 is about: one in, two out, so any deficit
     * can be closed exactly by repeating this. A four-way split would move the
     * count in threes and could never land on sixteen from twelve.
     */
    expect(pool().size()).toBe(2n);

    const back = coinsBackTo(r.context.callContext.currentZswapLocalState, toHex(vaultBytes()));
    expect(back).toHaveLength(2);
    expect(back.map((c) => c.value).sort((x, y) => Number(x - y))).toEqual([300n, 700n]);

    /* Both halves are in the pool, under the contract's own derived blindings. */
    for (const c of back) expect(pool().member(heldBy(vaultBytes(), c))).toBe(true);

    /* And the note that went in is gone, so it cannot be offered twice. */
    expect(pool().member(heldBy(
      vaultBytes(), { nonce: bytes(0x77), color: GBP, value: 1_000n }))).toBe(false);
  });

  it('THE ONE THAT MATTERS: a half of a split really SPENDS', async () => {
    /*
     * A commitment the vault cannot reproduce is money that is visibly on chain
     * and permanently stuck, and nothing about a split LOOKS wrong when that
     * has happened — the pool has the right number of entries and the values
     * add up. So the split's output is carried forward exactly as a device
     * would and then paid to somebody.
     *
     * If `noteBlindingOf` and the commitment written by `splitNote` disagreed
     * by one byte, this fails at "that note is not in this vault's pool".
     */
    const r = await split(GBP, 300n);
    const back = coinsBackTo(r.context.callContext.currentZswapLocalState, toHex(vaultBytes()));
    const piece = back.find((c) => c.value === 300n)!;
    expect(piece).toBeDefined();

    /* The device now holds the 300 half and offers it to a payment. */
    priv = { coin: { ...piece, mt_index: 0n } };

    const c = change(0n, 71);
    const leaves: PayoutLeafInput[] = [{
      details: toHex(vaultCircuits.payoutDetails(ALICE, GBP, 250n, bytes(0x40))),
      nonce: toHex(bytes(0xc1)),
    }];
    const tree = buildPayoutTree(leaves);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes() });
    const id = sim.proposalId(payload, c.salt, vaultBytes());
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);

    const paid = await vault.impureCircuits.payout(
      ctx('payout'),
      id, fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, c.salt,
      ALICE, GBP, 250n, bytes(0x40), bytes(0xc1), tree.pathFor(0) as never);

    const after = vaultLedger(
      paid.context.callContext.currentQueryContext.state as never);
    expect(after.payments).toBe(1n);
    /* Two before, the 300 spent, its 50 of change back: two again. */
    expect(after.notes.size()).toBe(2n);
  });

  it('REFUSES TO SPLIT A NOTE INTO THE WHOLE OF ITSELF', async () => {
    /*
     * A split of everything produces no remainder, so the vault would come out
     * of it holding the same one note it went in with, having paid a fee — and
     * the "no remainder" branch is the one that would silently drop the larger
     * half if it were written as an `if` rather than an assert.
     */
    await expect(split(GBP, 1_000n)).rejects.toThrow(/leave something behind/i);
    await expect(split(GBP, 1_001n)).rejects.toThrow(/leave something behind/i);
    expect(pool().size()).toBe(1n);
  });

  it('refuses to split a note of a DIFFERENT TOKEN from the one asked for', async () => {
    /* The membership check would refuse it too; this pins which refusal fires,
     * for the reason `payout`'s twin test gives. */
    priv = { coin: { ...priv.coin, color: USD } };
    await expect(split(GBP, 100n)).rejects.toThrow(/not a note of the token being split/i);
  });

  it('refuses a note the witness invented for a split, however well-formed', async () => {
    /*
     * A witness is untrusted input by the language's own warning. Without the
     * membership check the device could offer any coin at all and the vault
     * would spend a note it does not hold — or, worse, one it holds under a
     * different value.
     */
    priv = { coin: { nonce: bytes(0x5f), color: GBP, value: 4_000n, mt_index: 0n } };
    await expect(split(GBP, 100n)).rejects.toThrow(/not one this vault holds/i);
  });

  it('IS NOT A PAYMENT, and does not touch the counter an auditor reads', async () => {
    /*
     * `payments` is the one number anybody can check with no key at all.
     * Housekeeping inflating it would quietly change what it means.
     */
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
    await split(GBP, 300n);
    expect(vaultLedger(vaultState as never).payments).toBe(0n);
  });

  it('splits again, so a pool can be restored one note at a time', async () => {
    /* Twelve to sixteen is four of these. The point of a +1 shape is that any
     * deficit can be closed exactly. */
    const r = await split(GBP, 300n);
    const back = coinsBackTo(r.context.callContext.currentZswapLocalState, toHex(vaultBytes()));
    priv = { coin: { ...back.find((c) => c.value === 700n)!, mt_index: 0n } };

    await split(GBP, 200n);
    expect(pool().size()).toBe(3n);
  });

  it('the blinding is a function of the coin AND of the vault, not of either alone', () => {
    /*
     * Two vaults that ever held the same coin must not publish the same bytes —
     * M-36's argument for putting the account's address inside
     * `approvalNullifier`, one contract along. And two different coins in one
     * vault must not either.
     */
    const coin = { nonce: bytes(0x77), color: GBP, value: 1_000n };
    const other = Uint8Array.from(
      Buffer.from(sampleContractAddress() as never as string, 'hex'));

    expect(hex(vaultCircuits.noteBlindingOf(vaultBytes(), coin)))
      .not.toBe(hex(vaultCircuits.noteBlindingOf(other, coin)));
    expect(hex(vaultCircuits.noteBlindingOf(vaultBytes(), coin)))
      .not.toBe(hex(vaultCircuits.noteBlindingOf(
        vaultBytes(), { ...coin, value: 999n })));
    expect(hex(vaultCircuits.noteBlindingOf(vaultBytes(), coin)))
      .not.toBe(hex(vaultCircuits.noteBlindingOf(
        vaultBytes(), { ...coin, nonce: bytes(0x78) })));
    expect(hex(vaultCircuits.noteBlindingOf(vaultBytes(), coin)))
      .not.toBe(hex(vaultCircuits.noteBlindingOf(
        vaultBytes(), { ...coin, color: USD })));

    /* And it is deterministic, which is the whole of why nothing is stored. */
    expect(hex(vaultCircuits.noteBlindingOf(vaultBytes(), coin)))
      .toBe(hex(vaultCircuits.noteBlindingOf(vaultBytes(), { ...coin })));
  });
});
