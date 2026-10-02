/**
 * THE VAULT DIVIDES ONE OF ITS OWN NOTES AND KEEPS BOTH HALVES.
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
 * checks that what it wrote can be moved again. The rule is explicit about
 * the difference — *never ship a derivation of a value the money depends on
 * without a test that spends the result* — and it is there because a
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
import { AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, vaultRunOf } from './simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from './start-a-vault.js';
import { type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
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
const TOKEN_BYTES = bytes(0x9b);
const ALICE = bytes(0x0a);

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: { secret?: Uint8Array } }) => [ctx.privateState, ctx.privateState.secret ?? TEST_VAULT_SECRET],
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
 * produces exactly two. So the client that drives this circuit needs a
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

describe('a vault splits one of its own notes', () => {
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
    /* A vault takes no money until the account has adopted it and approved its first secret. */
    await startTheVault({
      sim, vault: vaultBytes(), approvers: [A, B], now: VAULT_NOW,
      call: async (circuit, ...a) => {
        const r: any = await (vault.impureCircuits as any)[circuit](ctx(circuit), ...a);
        vaultState = r.context.callContext.currentQueryContext.state;
        carryTheAccount(sim, r.context);
      },
    });

    /* One note of 1,000. The pool starts at one and the whole point is to make it two. */
    const coin = { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n };
    priv = { coin: { ...coin, mt_index: 0n } };
    const dep = await vault.impureCircuits.deposit(ctx('deposit'), coin);
    vaultState = dep.context.callContext.currentQueryContext.state;
  });

  /** A run of `leaves` at `amounts`, naming this vault, approved by both signers. */
  const approved = async (leaves: PayoutLeafInput[], amounts: bigint[], seed: number) => {
    const c: Change = change(0n, seed);
    const tree = payoutTreeOf(leaves, amounts, TOKEN_BYTES);
    const payload = pureCircuits.runPayload(
      fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, 0n);
    await sim.as(carrying(sim, A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees,
      from: WIN_FROM, until: WIN_UNTIL, vault: vaultBytes() });
    const id = sim.proposalId(payload, c.salt, vaultBytes());
    await sim.as(carrying(sim, A, c)).approve(id);
    await sim.as(carrying(sim, B, c)).approve(id);
    return (i: number) => vaultRunOf({
      proposal: id, vault: vaultBytes(), tree, i,
      opensAt: WIN_FROM, closesAt: WIN_UNTIL, salt: c.salt, nonce: fromHex(leaves[i]!.nonce),
    });
  };

  /**
   * Splits `amount` off the note the witness is currently offering, under a run
   * the signers approved for exactly that note and that piece.
   */
  const split = async (token: Uint8Array, amount: bigint, seed: number) => {
    const spent = vaultCircuits.noteNullifierOf(vaultBytes(), {
      nonce: priv.coin.nonce, color: priv.coin.color, value: priv.coin.value,
    });
    const runOf = await approved([{
      details: toHex(vaultCircuits.splitDetails(vaultBytes(), spent, token, amount)),
      nonce: toHex(bytes(seed)),
    }], [0n], seed);
    const r = await vault.impureCircuits.splitNote(ctx('splitNote'), runOf(0), token, amount);
    vaultState = r.context.callContext.currentQueryContext.state;
    carryTheAccount(sim, r.context);
    return { r, spent };
  };

  /*
   * A split needs an approved run, at the vault's own threshold, and records its
   * amount masked by the vault's secret; those refusals are pinned with the rest
   * of the vault's in `the-new-vault.test.ts`. This file pins that what a split
   * makes can be moved again.
   */

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
    const { r, spent } = await split(TOKEN_BYTES, 300n, 0xb1);
    const back = coinsBackTo(r.context.callContext.currentZswapLocalState, toHex(vaultBytes()));
    const piece = back.find((c) => c.value === 300n)!;
    expect(piece).toBeDefined();
    /* RED WHEN the piece's nonce is not the one worked out from the secret and the spent note. */
    expect(hex(piece.nonce)).toBe(hex(vaultCircuits.freshNonceOf(vaultCircuits.splitNonceTag(), TEST_VAULT_SECRET, spent)));

    /* The device now holds the 300 half and offers it to a payment. */
    priv = { coin: { ...piece, mt_index: 0n } };

    const runOf = await approved([{
      details: toHex(vaultCircuits.payoutDetails(ALICE, TOKEN_BYTES, 250n, bytes(0x40))),
      nonce: toHex(bytes(0xc1)),
    }], [250n], 71);

    /* RED WHEN the split's piece is committed so that the vault cannot spend it: refused as not in the pool. */
    const paid = await vault.impureCircuits.payout(ctx('payout'), runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote());
    vaultState = paid.context.callContext.currentQueryContext.state;
    carryTheAccount(sim, paid.context);

    const after = vaultLedger(vaultState as never);
    expect(after.payments).toBe(1n);
    /* RED WHEN the payment out of the piece is not recorded by the account. */
    expect(sim.ledger.movements.member(pureCircuits.paidOnceOf(bytes(0xc1)))).toBe(true);
    /* Two before, the 300 spent, its 50 of change back: two again. */
    expect(after.notes.size()).toBe(2n);
    /* RED WHEN the piece's change is not kept where the vault can find it: worked out from the secret and the piece's own nullifier. */
    const pieceSpent = vaultCircuits.noteNullifierOf(vaultBytes(), piece);
    const changeCoin = {
      nonce: vaultCircuits.freshNonceOf(vaultCircuits.changeNonceTag(), TEST_VAULT_SECRET, pieceSpent), color: TOKEN_BYTES, value: 50n,
    };
    expect(after.notes.member(heldBy(vaultBytes(), changeCoin))).toBe(true);
  });

  it('THE OTHER HALF SPENDS TOO: the rest a split leaves is paid out in full, leaving the piece', async () => {
    const { r, spent } = await split(TOKEN_BYTES, 300n, 0xb2);
    const back = coinsBackTo(r.context.callContext.currentZswapLocalState, toHex(vaultBytes()));
    const rest = back.find((c) => c.value === 700n)!;
    /* RED WHEN the rest's nonce is not the one worked out from the secret and the spent note. */
    expect(hex(rest.nonce)).toBe(hex(vaultCircuits.freshNonceOf(vaultCircuits.restNonceTag(), TEST_VAULT_SECRET, spent)));
    priv = { coin: { ...rest, mt_index: 0n } };

    const runOf = await approved([{
      details: toHex(vaultCircuits.payoutDetails(ALICE, TOKEN_BYTES, 700n, bytes(0x41))),
      nonce: toHex(bytes(0xc2)),
    }], [700n], 72);
    /* RED WHEN the rest is committed so that the vault cannot spend it. */
    const paid = await vault.impureCircuits.payout(ctx('payout'), runOf(0), ALICE, TOKEN_BYTES, 700n, bytes(0x41), noFurtherNote());
    vaultState = paid.context.callContext.currentQueryContext.state;

    /* Spent exactly, so no change: only the piece is left. */
    expect(vaultLedger(vaultState as never).payments).toBe(1n);
    expect([...pool()].map(hex)).toEqual([hex(heldBy(vaultBytes(), { nonce: back.find((c) => c.value === 300n)!.nonce, color: TOKEN_BYTES, value: 300n }))]);
  });
});
