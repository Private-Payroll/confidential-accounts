/**
 * THE VAULT, WITH ITS ACCOUNT, OFFLINE: EVERY WAY IT MOVES OR HOLDS MONEY, AND
 * EVERY REFUSAL.
 *
 * A vault and its company's account run here as two contracts in one
 * transaction: a `ContractStateProvider` hands the vault's call the account's
 * state, and the account's writes are carried forward from the call. The
 * runtime runs both contracts' asserts; it does not run the network's balancing
 * check, so a receipt is read from what the vault mints rather than refused for
 * being absent (`a-payment-needs-a-vaults-receipt.test.ts` builds that check's
 * transaction).
 *
 * Every assertion names the change that turns it red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as V,
} from '../managed-vault/contract/index.js';
import { pureCircuits as P } from '../managed/contract/index.js';
import {
  AccountSimulator, change, privateStateFor, type Change, payoutTreeOf, sumArgsOf,
} from './simulator.js';
import { type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { fromHex, toHex } from '../../src/core/crypto.js';
import { copiesTreeOf } from '../../src/midnight/sealed-copies-tree.js';
import { noFurtherNote } from '../../src/midnight/vault-step-notes.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ZERO = new Uint8Array(32);

const TOKEN_BYTES = bytes(0x9b);
const ALICE = bytes(0x0a);
/** A nonce secret: thirty-one bytes and a zero, the only shape the vault takes. */
const secretOf = (n: number) => { const b = bytes(n); b[31] = 0; return b; };
const SECRET = secretOf(0x51);
const NEXT_SECRET = secretOf(0x52);

interface Coin { nonce: Uint8Array; color: Uint8Array; value: bigint }
interface VaultPrivate { coin: Coin & { mt_index: bigint }; secret: Uint8Array }

const witnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.secret],
};

/** One signer's sealed copy, as the vault stores it: four parts, found by the reader's key. */
interface Copy { reader: Uint8Array; parts: Uint8Array[] }
const copyFor = (n: number): Copy => ({ reader: bytes(0x30 + n), parts: [1, 2, 3, 4].map((p) => bytes(n * 8 + p)) });

/** The approved tree of copies: its root, how many copies, each copy's path, and the edge past the last. */
const treeOf = (commitment: Uint8Array, copies: Copy[]) => copiesTreeOf(V as never, commitment, copies);

/** An edge for a call refused before its tree is read. */
const NO_EDGE = Array.from({ length: 10 }, () => ({ sibling: 0n, goesLeft: true }));

/**
 * The path to any place of the tree over `copies`, worked out here from the vault's own leaf and node, for an edge
 * at a place the product would not build one: past a count the run did not approve.
 */
const pathAt = (commitment: Uint8Array, copies: Copy[], place: number) => {
  const empty: bigint[] = [0n];
  for (let l = 0; l < 10; l++) empty.push(V.copyNodeOf(empty[l]!, empty[l]!));
  let level: bigint[] = copies.map((c) => V.copyLeafOf(commitment, c.reader, c.parts));
  const path: { sibling: bigint; goesLeft: boolean }[] = [];
  let at = place;
  for (let l = 0; l < 10; l++) {
    const beside = at ^ 1;
    path.push({ sibling: beside < level.length ? level[beside]! : empty[l]!, goesLeft: (at & 1) === 0 });
    const up: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) up.push(V.copyNodeOf(level[i]!, i + 1 < level.length ? level[i + 1]! : empty[l]!));
    level = up;
    at >>= 1;
  }
  return path;
};

/** The secret run's leaf for a tree of copies. */
const secretLeaf = (vault: Uint8Array, previous: Uint8Array, commitment: Uint8Array, tree: { root: Uint8Array; count: bigint }, nonce: number) =>
  [{ details: toHex(V.secretRunDetails(vault, previous, commitment, tree.root, tree.count)), nonce: toHex(bytes(nonce)) }];

class World {
  sim!: AccountSimulator;
  vault = new Vault<VaultPrivate>(witnesses as never);
  addr = '';
  state: any;
  priv: VaultPrivate = { coin: { nonce: ZERO, color: TOKEN_BYTES, value: 0n, mt_index: 0n }, secret: SECRET };
  lastFx: any;

  get self(): Uint8Array { return fromHex(this.addr); }
  get ledger() { return vaultLedger(this.state.data ?? this.state); }

  static async make(devices = [A, B], threshold = 2n, adopt = true): Promise<World> {
    const w = new World();
    w.sim = await AccountSimulator.liveAccount(devices, threshold);
    w.sim.at(NOW);
    w.addr = String(sampleContractAddress());
    const init = await w.vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: fromHex(String(w.sim.address)) } as never);
    w.state = init.currentContractState;
    if (adopt) await w.sim.adoptVault(w.self, devices);
    return w;
  }

  /** A second vault of the same company: the same account, its own address and state. */
  static async beside(other: World, adopt = true, approvers = [A, B]): Promise<World> {
    const w = new World();
    w.sim = other.sim;
    w.addr = String(sampleContractAddress());
    const init = await w.vault.initialState(
      createConstructorContext({} as VaultPrivate, BLOCK),
      { bytes: fromHex(String(w.sim.address)) } as never);
    w.state = init.currentContractState;
    if (adopt) await w.sim.adoptVault(w.self, approvers, 380 + Number(BigInt('0x' + w.addr.slice(0, 4)) % 100n));
    return w;
  }

  /** Calls one of the vault's circuits, carrying the vault's and the account's state forward. */
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

  /** A run of `leaves` at `amounts`, naming this vault, approved by `approvers`. */
  async approved(leaves: PayoutLeafInput[], amounts: bigint[], seed: number, approvers = [A, B], runVault?: Uint8Array) {
    const vault = runVault ?? this.self;
    const tree = payoutTreeOf(leaves, amounts, TOKEN_BYTES);
    const c: Change = change(0n, seed);
    await this.sim.as(this.sim.applying(approvers[0]!, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault,
    });
    const id = this.sim.proposalId(P.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n), c.salt, vault);
    for (const a of approvers) await this.sim.as(this.sim.applying(a, c)).approve(id);
    const runOf = (i: number) => ({
      proposal: id, runVault: vault, root: fromHex(tree.root), payees: tree.payees,
      opensAt: OPENS, closesAt: CLOSES, required: 0n, salt: c.salt,
      nonce: fromHex(leaves[i]!.nonce), asset: sumArgsOf(tree, i).asset, path: sumArgsOf(tree, i).path,
    });
    return { id, runOf };
  }

  /** The vault's first or next secret, through an approved secret run, and every copy written. */
  async setSecret(secret: Uint8Array, copies: Copy[] = [copyFor(1)], seed = 401, previous = this.ledger.nonceCommitment,
    earlier: Uint8Array = this.priv.secret) {
    const commitment = V.secretCommitmentOf(this.self, secret);
    const tree = treeOf(commitment, copies);
    const run = await this.approved(secretLeaf(this.self, previous, commitment, tree, seed % 256), [0n], seed);
    await this.call('setNonceSecret', run.runOf(0), previous, commitment, tree.root, tree.count, tree.edge, secret,
      previous.every((b) => b === 0) ? ZERO : earlier);
    for (let i = 0; i < copies.length; i++) {
      await this.call('writeSecretCopy', commitment, copies[i]!.reader, copies[i]!.parts, tree.paths[i]);
    }
    this.priv = { ...this.priv, secret };
    return { commitment, tree, run };
  }

  async deposit(coin: Coin) {
    await this.call('deposit', coin);
    this.priv = { ...this.priv, coin: { ...coin, mt_index: 0n } };
  }

  held(coin: Coin): Uint8Array { return V.heldCommitmentOf(coin, V.noteBlindingOf(this.self, coin)); }
  nullifierOf(coin: Coin): Uint8Array { return V.noteNullifierOf(this.self, coin); }
  notes(): string[] { return [...this.ledger.notes].map(hex).sort(); }
}

const paidRecord = (w: World) => [...w.sim.ledger.movements].map(hex).sort();

/** The tokens a call minted, as [tag hex, amount]. */
const mints = (w: World) => [...w.lastFx.unshieldedMints].map(([k, v]: [any, bigint]) => [typeof k === 'string' ? k : hex(k), v]);

/** The coin commitments a call claimed as made, as hex, however the runtime spells them. */
const claimed = (w: World): string[] => [...w.lastFx.claimedShieldedSpends].map((x: any) =>
  typeof x === 'string' ? x : x instanceof Uint8Array ? hex(x) : String(x.bytes ? hex(x.bytes) : x));

/* ------------------------------------------------------------------ */

describe('no money before the account adopts the vault and approves its first secret', () => {
  it('REFUSES a private and a public deposit while the vault has no secret', async () => {
    const w = await World.make();
    /* RED WHEN `deposit` stops asking whether the vault has started. */
    await expect(w.call('deposit', { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n }))
      .rejects.toThrow(/this vault takes no money yet/);
    /* RED WHEN `depositUnshielded` stops asking the same. */
    await expect(w.call('depositUnshielded', TOKEN_BYTES, 5n)).rejects.toThrow(/this vault takes no money yet/);
  });

  it('A VAULT THE ACCOUNT HAS NOT ADOPTED cannot be given its first secret, so it can never take money', async () => {
    const w = await World.make([A, B], 2n, false);
    /* RED WHEN the account's change step stops requiring an adopted vault. */
    await expect(w.setSecret(SECRET)).rejects.toThrow(/not a vault this company holds/);
    expect(w.ledger.nonceCommitment).toEqual(ZERO);
  });

  it('takes any token, once started, and refuses a deposit of nothing', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    await w.deposit({ nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n });
    await w.deposit({ nonce: bytes(0x78), color: bytes(0x42), value: 3n });
    expect(w.notes().length).toBe(2);
    /* RED WHEN a deposit of nothing is accepted into the pool. */
    await expect(w.call('deposit', { nonce: bytes(0x79), color: TOKEN_BYTES, value: 0n })).rejects.toThrow(/a deposit of nothing/);
  });
});

describe('the nonce secret: approved, chained, never zero or repeated, and recorded as no payment', () => {
  it('THE HEADLINE: a secret run sets the commitment and changes neither the account\'s record of payments nor the vault\'s payments counter', async () => {
    const w = await World.make();
    const before = paidRecord(w);
    const { commitment } = await w.setSecret(SECRET);
    /* RED WHEN `setNonceSecret` stops writing the commitment. */
    expect(w.ledger.nonceCommitment).toEqual(commitment);
    /* RED WHEN a secret run is recorded by the account as a payment (it would go through the payment step). */
    expect(paidRecord(w)).toEqual(before);
    /* RED WHEN a secret run adds one to the payments counter. */
    expect(w.ledger.payments).toBe(0n);
  });

  it('mints exactly one unit of the vault\'s CHANGE receipt to the account, and works out both receipts', async () => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const tree = treeOf(commitment, [copyFor(1)]);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, tree, 9), [0n], 409);
    await w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, SECRET, ZERO);
    const L: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    const changeColour = L.rawTokenType(V.changeReceiptTag(), w.addr);
    const payColour = L.rawTokenType(V.paymentReceiptTag(), w.addr);
    /* RED WHEN the run mints any other token or amount. */
    expect(mints(w)).toEqual([[hex(V.changeReceiptTag()), 1n]]);
    /* RED WHEN the colours kept for later receipts are not the ledger's own. */
    expect(hex(w.ledger.secretCopies.lookup(V.changeReceiptKey()))).toBe(changeColour);
    expect(hex(w.ledger.secretCopies.lookup(V.paymentReceiptKey()))).toBe(payColour);
  });

  it('REFUSES a commitment of zero, the commitment it already has, and a run that replaces another secret', async () => {
    const w = await World.make();
    const { commitment } = await w.setSecret(SECRET);
    /* RED WHEN a zero commitment is accepted, which would leave the vault with no secret. */
    const zeroLeaf = [{ details: toHex(V.secretRunDetails(w.self, commitment, ZERO, bytes(1), 1n)), nonce: toHex(bytes(3)) }];
    const zr = await w.approved(zeroLeaf, [0n], 403);
    await expect(w.call('setNonceSecret', zr.runOf(0), commitment, ZERO, bytes(1), 1n, NO_EDGE, SECRET, SECRET))
      .rejects.toThrow(/a secret's commitment of zero/);
    /* RED WHEN the commitment it already has is accepted again. */
    const sameLeaf = [{ details: toHex(V.secretRunDetails(w.self, commitment, commitment, bytes(1), 1n)), nonce: toHex(bytes(4)) }];
    const sr = await w.approved(sameLeaf, [0n], 404);
    await expect(w.call('setNonceSecret', sr.runOf(0), commitment, commitment, bytes(1), 1n, NO_EDGE, SECRET, SECRET))
      .rejects.toThrow(/that is the secret this vault already has/);
    /* RED WHEN a run naming a secret the vault no longer holds can roll it back. */
    const other = V.secretCommitmentOf(w.self, NEXT_SECRET);
    const staleLeaf = [{ details: toHex(V.secretRunDetails(w.self, other, bytes(7), bytes(1), 1n)), nonce: toHex(bytes(5)) }];
    const st = await w.approved(staleLeaf, [0n], 405);
    await expect(w.call('setNonceSecret', st.runOf(0), other, bytes(7), bytes(1), 1n, NO_EDGE, SECRET, SECRET))
      .rejects.toThrow(/replaces a secret this vault no longer holds/);
  });

  it('REFUSES the same approved run twice: the chain has moved on', async () => {
    const w = await World.make();
    const { commitment, tree, run } = await w.setSecret(SECRET);
    /* RED WHEN the commitment is not chained to the one it replaces. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, SECRET, ZERO))
      .rejects.toThrow(/replaces a secret this vault no longer holds/);
  });

  it('REFUSES a secret with no sealed copy, more copies than the tree holds, and one whose run did not approve this commitment', async () => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const { root, edge } = treeOf(commitment, [copyFor(1)]);
    const none = await w.approved(secretLeaf(w.self, ZERO, commitment, { root, count: 0n }, 6), [0n], 406);
    /* RED WHEN a secret nobody can open is accepted: a count of zero would open the vault with no copy written. */
    await expect(w.call('setNonceSecret', none.runOf(0), ZERO, commitment, root, 0n, NO_EDGE, SECRET, ZERO))
      .rejects.toThrow(/a secret with no sealed copy/);
    const many = await w.approved(secretLeaf(w.self, ZERO, commitment, { root, count: 1025n }, 7), [0n], 407);
    /* RED WHEN a count past the tree's 1024 places is accepted: the vault could never be opened to money. */
    await expect(w.call('setNonceSecret', many.runOf(0), ZERO, commitment, root, 1025n, NO_EDGE, SECRET, ZERO))
      .rejects.toThrow(/holds at most 1024/);
    const one = await w.approved(secretLeaf(w.self, ZERO, commitment, { root, count: 1n }, 8), [0n], 408);
    /* RED WHEN the run's leaf stops binding the commitment: another one, on the same approval. */
    await expect(w.call('setNonceSecret', one.runOf(0), ZERO, V.secretCommitmentOf(w.self, NEXT_SECRET), root, 1n, edge, NEXT_SECRET, ZERO))
      .rejects.toThrow(/that change is not in the approved run/);
  });

  it('THE RUN BINDS THE COMMITMENT, THE ROOT OF THE COPIES AND THEIR COUNT EACH ON ITS OWN: none can be swapped on the same approval', async () => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const tree = treeOf(commitment, [copyFor(1), copyFor(2)]);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, tree, 12), [0n], 412);
    const other = V.secretCommitmentOf(w.self, NEXT_SECRET);
    /* RED WHEN the leaf stops binding the commitment: anyone could set a secret only they know, on the signers' approval. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, other, tree.root, tree.count, tree.edge, NEXT_SECRET, ZERO))
      .rejects.toThrow(/that change is not in the approved run/);
    /* RED WHEN the leaf stops binding the root: anyone could swap in copies the signers never approved. */
    const swapped = treeOf(commitment, [copyFor(3), copyFor(4)]);
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, swapped.root, swapped.count, swapped.edge, SECRET, ZERO))
      .rejects.toThrow(/that change is not in the approved run/);
    /*
     * RED WHEN the leaf stops binding the count. A smaller count is refused before the leaf is read (the tree shows a
     * copy past it), so the swap here is a larger one: three for two, which shows nothing past place three.
     */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, 3n, pathAt(commitment, [copyFor(1), copyFor(2)], 3), SECRET, ZERO))
      .rejects.toThrow(/that change is not in the approved run/);
    /* The control: the approved commitment, root and count are accepted. */
    await w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, SECRET, ZERO);
    expect(w.ledger.nonceCommitment).toEqual(commitment);
  });

  it('REFUSES A SECRET THAT WAS THIS VAULT\'S BEFORE: A, then B, then A again', async () => {
    const w = await World.make();
    const first = await w.setSecret(SECRET);
    await w.setSecret(NEXT_SECRET, [copyFor(2)], 441);
    const again = treeOf(first.commitment, [copyFor(3)]);
    const run = await w.approved(secretLeaf(w.self, w.ledger.nonceCommitment, first.commitment, again, 13), [0n], 442);
    /* RED WHEN an earlier secret can be set again: the run that replaced it could then be replayed, and its copies rewritten. */
    await expect(w.call('setNonceSecret', run.runOf(0), w.ledger.nonceCommitment, first.commitment, again.root, again.count,
      again.edge, SECRET, NEXT_SECRET))
      .rejects.toThrow(/a secret is never set twice/);
  });

  it('A RUN BELOW THE VAULT\'S BAR cannot set its secret', async () => {
    const w = await World.make([A, B, C], 3n);
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const tree = treeOf(commitment, [copyFor(1)]);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, tree, 8), [0n], 408, [A, B]);
    /* The bar is the vault's: the account's own threshold is three here, and two approved. */
    /* RED WHEN the secret is set on fewer approvals than a payment from this vault needs. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, SECRET, ZERO))
      .rejects.toThrow(/not enough approvals yet/);
  });
});

describe('the sealed copies: one approved root, each copy written on its own, and no money until the count is in', () => {
  /** The vault with a secret run approved and set over `copies`, and no copy written yet. */
  const setButUnwritten = async (copies: Copy[], seed: number) => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const tree = treeOf(commitment, copies);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, tree, seed % 256), [0n], seed);
    await w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, SECRET, ZERO);
    return { w, commitment, tree };
  };
  const left = (w: World, commitment: Uint8Array) => w.ledger.secretCopies.lookup(V.copiesLeftKeyOf(commitment));

  it('writes every signer\'s copy where that signer finds it, for one, three and twelve signers', async () => {
    for (const n of [1, 3, 12]) {
      const w = await World.make();
      const copies = Array.from({ length: n }, (_, i) => copyFor(i + 1));
      const { commitment, tree } = await w.setSecret(SECRET, copies, 410 + n);
      /* RED WHEN the count approved is not the number of copies given. */
      expect(tree.count).toBe(BigInt(n));
      copies.forEach((copy, place) => {
        for (let p = 0; p < 4; p++) {
          /* RED WHEN a part is written under another key, or not written. */
          expect(w.ledger.secretCopies.lookup(V.copyKeyOf(commitment, copy.reader, BigInt(place), BigInt(p)))).toEqual(copy.parts[p]);
        }
      });
      /* RED WHEN the count is not run down to zero once every copy is written. */
      expect(left(w, commitment)).toEqual(ZERO);
      /* RED WHEN the last copy does not mark this secret's copies as all written. */
      expect(w.ledger.secretCopies.lookup(V.copiesWrittenKey())).toEqual(commitment);
    }
  });

  it('REFUSES a copy not under the approved root: forged parts, another reader, another secret, a path to another place', async () => {
    const copies = [copyFor(1), copyFor(2), copyFor(3)];
    const { w, commitment, tree } = await setButUnwritten(copies, 420);
    const before = left(w, commitment);
    const forged = { reader: copies[0]!.reader, parts: [bytes(1), bytes(2), bytes(3), bytes(4)] };
    /* RED WHEN a copy is written that the signers did not approve: anyone could hand a signer a copy that opens nothing. */
    await expect(w.call('writeSecretCopy', commitment, forged.reader, forged.parts, tree.paths[0]))
      .rejects.toThrow(/not one the signers approved/);
    /* RED WHEN the reader is not bound into the leaf. */
    await expect(w.call('writeSecretCopy', commitment, bytes(0x7f), copies[0]!.parts, tree.paths[0]))
      .rejects.toThrow(/not one the signers approved/);
    /* RED WHEN a copy's path is not checked against its leaf: copy 0 walked to copy 1's place. */
    await expect(w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, tree.paths[1]))
      .rejects.toThrow(/not one the signers approved/);
    /* RED WHEN a copy can be written for a secret no run approved. */
    await expect(w.call('writeSecretCopy', bytes(0x99), copies[0]!.reader, copies[0]!.parts, tree.paths[0]))
      .rejects.toThrow(/no approved list of sealed copies/);
    /* RED WHEN the commitment is not bound into the leaf: the same copy under another secret's root. */
    const other = V.secretCommitmentOf(w.self, NEXT_SECRET);
    await expect(w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, treeOf(other, copies).paths[0]))
      .rejects.toThrow(/not one the signers approved/);
    /*
     * A path with its direction flipped is refused: copy 2's own path with its first step turned the other way.
     * RED WHEN a step's direction is not bound into the root. A place past the count needs no case of its own: it
     * holds a zero leaf, which no copy's leaf can equal, so no copy reaches it under the approved root.
     */
    const past = tree.paths[2]!.map((s, l) => (l === 0 ? { sibling: s.sibling, goesLeft: false } : s));
    await expect(w.call('writeSecretCopy', commitment, copies[2]!.reader, copies[2]!.parts, past))
      .rejects.toThrow(/not one the signers approved/);
    /* RED WHEN a refused copy is counted. */
    expect(left(w, commitment)).toEqual(before);
    expect(before).not.toEqual(ZERO);
  });

  it('REFUSES THE SAME COPY TWICE, and a second write counts nothing', async () => {
    const copies = [copyFor(1), copyFor(2)];
    const { w, commitment, tree } = await setButUnwritten(copies, 421);
    await w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, tree.paths[0]);
    /* RED WHEN the same copy can be written twice: two writes of one copy would open the vault with another missing. */
    await expect(w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, tree.paths[0]))
      .rejects.toThrow(/that sealed copy is already written/);
    await expect(w.call('deposit', { nonce: bytes(0x61), color: TOKEN_BYTES, value: 10n }))
      .rejects.toThrow(/not every signer's sealed copy/);
    await w.call('writeSecretCopy', commitment, copies[1]!.reader, copies[1]!.parts, tree.paths[1]);
    /* RED WHEN a finished tree takes another copy: every place is written once, and none past the count holds one. */
    await expect(w.call('writeSecretCopy', commitment, copies[1]!.reader, copies[1]!.parts, tree.paths[1]))
      .rejects.toThrow(/that sealed copy is already written/);
    expect(left(w, commitment)).toEqual(ZERO);
  });

  it('A BAD ENTRY BLOCKS ONLY ITSELF: copies are written in any order, and one listed twice for a reader holds up nobody', async () => {
    /* The second and third entries are one reader twice, with different parts: a device's mistake the signers approved. */
    const copies = [copyFor(1), copyFor(2), { ...copyFor(2), parts: [bytes(5), bytes(6), bytes(7), bytes(8)] }, copyFor(4)];
    const { w, commitment, tree } = await setButUnwritten(copies, 422);
    /* RED WHEN copies must be written in the order approved, as a chain: the last first. */
    await w.call('writeSecretCopy', commitment, copies[3]!.reader, copies[3]!.parts, tree.paths[3]);
    /* A bad entry nobody can write - forged parts - is refused, and nothing else is touched. */
    await expect(w.call('writeSecretCopy', commitment, copies[0]!.reader, [bytes(9), bytes(9), bytes(9), bytes(9)], tree.paths[0]))
      .rejects.toThrow(/not one the signers approved/);
    await w.call('writeSecretCopy', commitment, copies[2]!.reader, copies[2]!.parts, tree.paths[2]);
    /* RED WHEN one reader listed twice jams the other entry: copies are keyed by reader alone. */
    await w.call('writeSecretCopy', commitment, copies[1]!.reader, copies[1]!.parts, tree.paths[1]);
    await w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, tree.paths[0]);
    /* RED WHEN the second entry for a reader overwrites the first. */
    expect(w.ledger.secretCopies.lookup(V.copyKeyOf(commitment, copies[1]!.reader, 1n, 0n))).toEqual(copies[1]!.parts[0]);
    expect(w.ledger.secretCopies.lookup(V.copyKeyOf(commitment, copies[2]!.reader, 2n, 0n))).toEqual(copies[2]!.parts[0]);
    await w.deposit({ nonce: bytes(0x61), color: TOKEN_BYTES, value: 10n });
    expect(w.notes()).toHaveLength(1);
  });

  it('NO MONEY MOVES UNTIL THE COUNT IS IN, and the last copy opens the vault', async () => {
    const copies = [copyFor(1), copyFor(2), copyFor(3)];
    const { w, commitment, tree } = await setButUnwritten(copies, 450);
    const coin: Coin = { nonce: bytes(0x61), color: TOKEN_BYTES, value: 10n };
    /* RED WHEN money is taken under a secret whose copies are not all written: a device lost now strands every coin made under it. */
    await expect(w.call('deposit', coin)).rejects.toThrow(/not every signer's sealed copy of its secret is on the chain/);
    await expect(w.call('depositUnshielded', TOKEN_BYTES, 10n)).rejects.toThrow(/not every signer's sealed copy/);
    await w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, tree.paths[0]);
    await w.call('writeSecretCopy', commitment, copies[2]!.reader, copies[2]!.parts, tree.paths[2]);
    /* RED WHEN the vault opens before the count is reached: two of three is not every copy. */
    await expect(w.call('deposit', coin)).rejects.toThrow(/not every signer's sealed copy/);
    await w.call('writeSecretCopy', commitment, copies[1]!.reader, copies[1]!.parts, tree.paths[1]);
    /* RED WHEN the last copy does not open the vault to money. */
    await w.deposit(coin);
    expect(w.notes()).toHaveLength(1);
  });

  it('AN EARLIER SECRET\'S COPIES FINISHED LATE DO NOT CLOSE THE VAULT AGAIN', async () => {
    const copies = [copyFor(1), copyFor(2)];
    const { w, commitment, tree } = await setButUnwritten(copies, 451);
    await w.call('writeSecretCopy', commitment, copies[0]!.reader, copies[0]!.parts, tree.paths[0]);
    /* The company moves on to a new secret, and writes all of its copies. */
    await w.setSecret(NEXT_SECRET, [copyFor(3)], 452, commitment);
    await w.deposit({ nonce: bytes(0x62), color: TOKEN_BYTES, value: 10n });
    /* Anyone may still finish the earlier tree. */
    await w.call('writeSecretCopy', commitment, copies[1]!.reader, copies[1]!.parts, tree.paths[1]);
    /* RED WHEN finishing an earlier secret's copies marks the vault as waiting on it: anyone could stop its money. */
    await w.deposit({ nonce: bytes(0x63), color: TOKEN_BYTES, value: 10n });
    expect(w.notes()).toHaveLength(2);
  });

  it('the product\'s tree refuses no copies, more than the tree holds, and a malformed copy, before anything is approved', () => {
    const commitment = V.secretCommitmentOf(bytes(1), SECRET);
    expect(() => treeOf(commitment, [])).toThrow(/no sealed copy/);
    expect(() => treeOf(commitment, Array.from({ length: 1025 }, () => copyFor(1)))).toThrow(/at most 1024/);
    expect(() => treeOf(commitment, [{ reader: bytes(1), parts: [bytes(1)] }])).toThrow(/four 32-byte parts/);
  });
});

describe('paying: through the account\'s receipt step, with every new coin\'s nonce worked out on chain', () => {
  let w: World;
  const NOTE: Coin = { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n };
  const payee = (amount: bigint, seed: number) => ({
    details: toHex(V.payoutDetails(ALICE, TOKEN_BYTES, amount, bytes(0x40))), nonce: toHex(bytes(seed)),
  });

  beforeEach(async () => {
    w = await World.make();
    await w.setSecret(SECRET);
    await w.deposit(NOTE);
  });

  it('THE HEADLINE: pays the payee, keeps the change, records the payment once and counts it once', async () => {
    const run = await w.approved([payee(250n, 0xc1)], [250n], 501);
    await w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote());
    /* RED WHEN the payment is not recorded by the account. */
    expect(w.sim.ledger.movements.member(P.paidOnceOf(bytes(0xc1)))).toBe(true);
    /* RED WHEN a payment stops adding one to the counter. */
    expect(w.ledger.payments).toBe(1n);
    /* RED WHEN the change's nonce is taken from anywhere but the secret and the spent note's nullifier, or its value is not what is left. */
    const spent = w.nullifierOf(NOTE);
    const changeCoin = { nonce: V.freshNonceOf(V.changeNonceTag(), SECRET, spent), color: TOKEN_BYTES, value: 750n };
    expect(w.notes()).toEqual([hex(w.held(changeCoin))]);
    /* RED WHEN the payment's receipt is not minted, or is the change receipt. */
    expect(mints(w)).toEqual([[hex(V.paymentReceiptTag()), 1n]]);
  });

  it('THE PAYEE\'S COIN carries the nonce worked out from the spent note, and no argument can choose it', async () => {
    const run = await w.approved([payee(250n, 0xc2)], [250n], 502);
    await w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote());
    const spent = w.nullifierOf(NOTE);
    const expected = V.coinCommitmentOf(
      { nonce: V.freshNonceOf(V.payeeNonceTag(), SECRET, spent), color: TOKEN_BYTES, value: 250n }, ALICE, true);
    /* RED WHEN the payee's nonce is derived any other way. */
    expect(claimed(w)).toContain(hex(expected));
    /* RED WHEN the circuit grows an argument a caller could put a nonce in: the run's nonce is the payee's leaf's,
       and the one argument past the payee's carries held notes, which the vault checks against its pool. */
    const info = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'managed-vault', 'compiler', 'contract-info.json'), 'utf8'));
    expect(info.circuits.find((c: any) => c.name === 'payout').arguments.map((a: any) => a.name))
      .toEqual(['run', 'recipient', 'token', 'amount', 'blinding', 'more']);
  });

  it('A CHANGE COIN\'S VALUE IS NOT FOUND FROM WHAT THE CHAIN SHOWS, and is found with the secret', async () => {
    const before = new Set(w.notes());
    const run = await w.approved([payee(250n, 0xc3)], [250n], 503);
    await w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote());
    /* What anybody reads: the nullifier the call spends, the note it adds, the vault's address and the token. */
    const nfs: Uint8Array[] = [...w.lastFx.claimedNullifiers].map((x: any) => (typeof x === 'string' ? fromHex(x) : x));
    const added = w.notes().filter((n) => !before.has(n));
    expect(nfs).toHaveLength(1);
    expect(added).toHaveLength(1);
    const valueOf = (secret: Uint8Array | null): bigint | null => {
      for (let v = 1n; v <= 1_000n; v++) {
        const nonce = secret === null
          ? V.freshNonceOf(V.changeNonceTag(), nfs[0]!, nfs[0]!)
          : V.freshNonceOf(V.changeNonceTag(), secret, nfs[0]!);
        if (hex(w.held({ nonce, color: TOKEN_BYTES, value: v })) === added[0]) return v;
      }
      return null;
    };
    /* The control: with the secret, trying amounts finds the change, so the search below is a real one. */
    expect(valueOf(SECRET)).toBe(750n);
    /*
     * RED WHEN a new coin's nonce is made without the secret: the nullifier is
     * public, so trying amounts against the note the vault adds finds the value,
     * as a salary was found from a deposit's nonce before. Every way of putting
     * the nullifier in where the secret goes is tried, and none finds it.
     */
    expect(valueOf(null)).toBeNull();
    for (let v = 1n; v <= 1_000n; v++) {
      for (const nonce of [
        V.freshNonceOf(V.changeNonceTag(), ZERO, nfs[0]!),
        V.freshNonceOf(V.changeNonceTag(), V.changeNonceTag(), nfs[0]!),
      ]) {
        expect(hex(w.held({ nonce, color: TOKEN_BYTES, value: v }))).not.toBe(added[0]);
      }
    }
  });

  it('REFUSES A DEVICE HOLDING ANOTHER SECRET: no payment makes coins under a secret the company cannot name them by', async () => {
    const run = await w.approved([payee(250n, 0xc4)], [250n], 504);
    w.priv = { ...w.priv, secret: NEXT_SECRET };
    /* RED WHEN payout makes its coins under whatever secret the device offers. */
    await expect(w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote()))
      .rejects.toThrow(/that is not this vault's current nonce secret/);
    expect(w.ledger.payments).toBe(0n);
  });

  it('REFUSES a payment of nothing, a note of another token, a note too small, and a note it does not hold', async () => {
    const zero = await w.approved([payee(0n, 0xc3)], [0n], 503);
    /* RED WHEN a payment of nothing records a person paid. */
    await expect(w.call('payout', zero.runOf(0), ALICE, TOKEN_BYTES, 0n, bytes(0x40), noFurtherNote())).rejects.toThrow(/a payment of nothing/);
    const big = await w.approved([payee(5_000n, 0xc4)], [5_000n], 504);
    /* RED WHEN a note smaller than the payment is spent. */
    await expect(w.call('payout', big.runOf(0), ALICE, TOKEN_BYTES, 5_000n, bytes(0x40), noFurtherNote())).rejects.toThrow(/do not hold enough/);
    const other = bytes(0x42);
    const run = await w.approved([{ details: toHex(V.payoutDetails(ALICE, other, 10n, bytes(0x40))), nonce: toHex(bytes(0xc5)) }], [10n], 505);
    /* RED WHEN a note of another token pays. */
    await expect(w.call('payout', run.runOf(0), ALICE, other, 10n, bytes(0x40), noFurtherNote())).rejects.toThrow(/not a note of the token being paid/);
    const ok = await w.approved([payee(250n, 0xc6)], [250n], 506);
    w.priv = { ...w.priv, coin: { nonce: bytes(0x01), color: TOKEN_BYTES, value: 1_000n, mt_index: 0n } };
    /* RED WHEN a note outside the pool pays. */
    await expect(w.call('payout', ok.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote())).rejects.toThrow(/not in this vault's pool/);
  });

  it('THE AMOUNT AND TOKEN THE ACCOUNT CHECKS are the ones the vault sends: a payee approved at 250 cannot be paid 300', async () => {
    const run = await w.approved([payee(250n, 0xc7)], [250n], 507);
    /* RED WHEN the vault hands the account an amount other than the one it sends. */
    await expect(w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 300n, bytes(0x40), noFurtherNote())).rejects.toThrow(/that payee is not in the approved run/);
    expect(w.ledger.payments).toBe(0n);
  });

  it('A CHANGE\'S LEAF NEVER SETTLES AS A PAYMENT: a split approved for this note cannot be paid out', async () => {
    const spent = w.nullifierOf(NOTE);
    const split = [{ details: toHex(V.splitDetails(w.self, spent, TOKEN_BYTES, 250n)), nonce: toHex(bytes(0xc8)) }];
    const run = await w.approved(split, [250n], 508);
    /* RED WHEN a change's details can be read as a payment's. */
    await expect(w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote())).rejects.toThrow(/that payee is not in the approved run/);
  });

  it('the same payee is paid once, whatever note is offered', async () => {
    const run = await w.approved([payee(250n, 0xc9)], [250n], 509);
    await w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote());
    const spent = w.nullifierOf(NOTE);
    w.priv = { ...w.priv, coin: { nonce: V.freshNonceOf(V.changeNonceTag(), SECRET, spent), color: TOKEN_BYTES, value: 750n, mt_index: 0n } };
    /* RED WHEN the account stops refusing a payee already paid. */
    await expect(w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40), noFurtherNote())).rejects.toThrow(/already been made/);
    expect(w.ledger.payments).toBe(1n);
  });
});

describe('splitting a note: approved like any other change, its amount kept on chain under the secret', () => {
  let w: World;
  const NOTE: Coin = { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n };
  const splitRun = async (amount: bigint, seed: number, note = NOTE) => {
    const leaves = [{ details: toHex(V.splitDetails(w.self, w.nullifierOf(note), TOKEN_BYTES, amount)), nonce: toHex(bytes(seed)) }];
    return (await w.approved(leaves, [0n], 600 + seed)).runOf(0);
  };

  beforeEach(async () => {
    w = await World.make();
    await w.setSecret(SECRET);
    await w.deposit(NOTE);
  });

  it('THE HEADLINE: two pieces that sum to the note, the amount recoverable with the secret, and no payment recorded or counted', async () => {
    const before = paidRecord(w);
    await w.call('splitNote', await splitRun(300n, 1), TOKEN_BYTES, 300n);
    const spent = w.nullifierOf(NOTE);
    const piece = { nonce: V.freshNonceOf(V.splitNonceTag(), SECRET, spent), color: TOKEN_BYTES, value: 300n };
    const rest = { nonce: V.freshNonceOf(V.restNonceTag(), SECRET, spent), color: TOKEN_BYTES, value: 700n };
    /* RED WHEN a piece's nonce or value is not the one worked out here, or the note is not taken out. */
    expect(w.notes()).toEqual([hex(w.held(piece)), hex(w.held(rest))].sort());
    /* RED WHEN the journal entry is not keyed by the spent note, or not masked by the secret. */
    expect(w.ledger.splitJournal.lookup(spent)).toEqual(V.maskedAmountOf(300n, V.splitMaskOf(SECRET, spent)));
    expect(w.ledger.splitJournal.lookup(spent)).not.toEqual(V.maskedAmountOf(300n, V.splitMaskOf(NEXT_SECRET, spent)));
    /* RED WHEN a split is recorded by the account as a payment, or counted as one. */
    expect(paidRecord(w)).toEqual(before);
    expect(w.ledger.payments).toBe(0n);
  });

  it('the device recovers the piece\'s amount from the journal with the secret, and from nothing else', async () => {
    await w.call('splitNote', await splitRun(321n, 2), TOKEN_BYTES, 321n);
    const spent = w.nullifierOf(NOTE);
    const stored = w.ledger.splitJournal.lookup(spent);
    const recover = (secret: Uint8Array) => V.unmaskedAmountOf(stored, V.splitMaskOf(secret, spent));
    /* RED WHEN the mask is not lifted by subtraction with the secret, as a device does. */
    expect(recover(SECRET)).toBe(321n);
    expect(recover(NEXT_SECRET)).not.toBe(321n);
  });

  it('REFUSES a split with no approval, or with the approval for another note or another amount', async () => {
    /* RED WHEN a split stops asking the account: one signer's approval is not the bar. */
    const leaves = [{ details: toHex(V.splitDetails(w.self, w.nullifierOf(NOTE), TOKEN_BYTES, 300n)), nonce: toHex(bytes(3)) }];
    const alone = (await w.approved(leaves, [0n], 603, [A])).runOf(0);
    await expect(w.call('splitNote', alone, TOKEN_BYTES, 300n)).rejects.toThrow(/not enough approvals yet/);
    /* RED WHEN the approval stops binding the amount. */
    await expect(w.call('splitNote', await splitRun(300n, 4), TOKEN_BYTES, 299n)).rejects.toThrow(/that change is not in the approved run/);
    const other: Coin = { nonce: bytes(0x78), color: TOKEN_BYTES, value: 1_000n };
    await w.deposit(other);
    /* RED WHEN the approval stops binding the note, by its nullifier. */
    await expect(w.call('splitNote', await splitRun(300n, 5, NOTE), TOKEN_BYTES, 300n)).rejects.toThrow(/that change is not in the approved run/);
  });

  it('REFUSES the same approved split twice: its run is closed, and the note is gone before any journal is read', async () => {
    const run = await splitRun(300n, 6);
    await w.call('splitNote', run, TOKEN_BYTES, 300n);
    const spent = w.nullifierOf(NOTE);
    const journal = w.ledger.splitJournal.lookup(spent);
    /* RED WHEN a run of one change stays open once its change is used. */
    await expect(w.call('splitNote', run, TOKEN_BYTES, 300n)).rejects.toThrow(/there is no open proposal with that id/);
    /*
     * A second run approving the same split. RED WHEN a spent note's split can be made again: the note is out of the
     * pool, so the split is refused before it reaches the journal, and the first piece's amount is kept. The ledger
     * makes no coin twice and takes no nullifier twice, so this is the only way back to a split of one note.
     */
    await expect(w.call('splitNote', await splitRun(300n, 7), TOKEN_BYTES, 300n)).rejects.toThrow(/not in this vault's pool/);
    expect(w.ledger.splitJournal.lookup(spent)).toEqual(journal);
  });

  it('REFUSES a note of another token, and a note the device invents, however well-formed', async () => {
    /* RED WHEN a split takes a note of a token other than the one named. */
    await expect(w.call('splitNote', await splitRun(300n, 10), bytes(0x42), 300n)).rejects.toThrow(/not a note of the token being split/);
    const invented: Coin = { nonce: bytes(0x01), color: TOKEN_BYTES, value: 1_000n };
    const leaves = [{ details: toHex(V.splitDetails(w.self, w.nullifierOf(invented), TOKEN_BYTES, 300n)), nonce: toHex(bytes(11)) }];
    const run = (await w.approved(leaves, [0n], 611)).runOf(0);
    w.priv = { ...w.priv, coin: { ...invented, mt_index: 0n } };
    /* RED WHEN a split spends a note the pool does not hold. */
    await expect(w.call('splitNote', run, TOKEN_BYTES, 300n)).rejects.toThrow(/not in this vault's pool/);
  });

  it('splits a piece again, so a pool can be cut down one note at a time', async () => {
    await w.call('splitNote', await splitRun(600n, 12), TOKEN_BYTES, 600n);
    const spent = w.nullifierOf(NOTE);
    const piece: Coin = { nonce: V.freshNonceOf(V.splitNonceTag(), SECRET, spent), color: TOKEN_BYTES, value: 600n };
    w.priv = { ...w.priv, coin: { ...piece, mt_index: 0n } };
    await w.call('splitNote', await splitRun(100n, 13, piece), TOKEN_BYTES, 100n);
    /* RED WHEN a piece a split made cannot itself be split: it would not be a note this vault holds. */
    expect(w.notes().length).toBe(3);
  });

  it('REFUSES a split of nothing, a split of the whole note, and a device holding another secret', async () => {
    /* RED WHEN a zero piece is cut. */
    await expect(w.call('splitNote', await splitRun(0n, 7), TOKEN_BYTES, 0n)).rejects.toThrow(/a split has to cut a piece/);
    /* RED WHEN a split may take the whole note. */
    await expect(w.call('splitNote', await splitRun(1_000n, 8), TOKEN_BYTES, 1_000n)).rejects.toThrow(/a split has to leave something behind/);
    w.priv = { ...w.priv, secret: NEXT_SECRET };
    /* RED WHEN the journal can be masked under a secret that is not the vault's. */
    await expect(w.call('splitNote', await splitRun(300n, 9), TOKEN_BYTES, 300n)).rejects.toThrow(/that is not this vault's current nonce secret/);
  });
});

describe('paying in public money: through the same receipt step', () => {
  /*
   * WHAT THIS SIMULATOR CANNOT SHOW: a public payment that lands. It keeps no public
   * balance for a contract, so the vault's balance check refuses every public payment
   * here, after the account has approved it. The approval half is pinned below.
   */
  it('REFUSES a public payment it cannot cover, after the account has approved the payee', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    const details = V.unshieldedPayoutDetails(ALICE, TOKEN_BYTES, 250n, bytes(0x40));
    const run = await w.approved([{ details: toHex(details), nonce: toHex(bytes(0xd1)) }], [250n], 701);
    /* RED WHEN the vault stops asking the chain for its balance before it sends. */
    await expect(w.call('payoutUnshielded', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40)))
      .rejects.toThrow(/does not hold enough of that token/);
    expect(w.ledger.payments).toBe(0n);
  });

  it('A PRIVATE LEAF NEVER SETTLES IN PUBLIC MONEY: refused by the account before any balance is read', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    const details = V.payoutDetails(ALICE, TOKEN_BYTES, 250n, bytes(0x40));
    const run = await w.approved([{ details: toHex(details), nonce: toHex(bytes(0xd2)) }], [250n], 702);
    /* RED WHEN public money takes a private payment's details. */
    await expect(w.call('payoutUnshielded', run.runOf(0), ALICE, TOKEN_BYTES, 250n, bytes(0x40)))
      .rejects.toThrow(/that payee is not in the approved run/);
  });
});

/* ------------------------------------------------------------------ */

/** What the vault keeps for the secret a later one replaced. */
const keptEarlier = (w: World, commitment: Uint8Array): Uint8Array => w.ledger.secretCopies.lookup(V.earlierSecretKeyOf(commitment));

describe('every earlier secret travels with the newest, so a signer seated later names every note', () => {
  const THIRD_SECRET = secretOf(0x53);
  const NOTE: Coin = { nonce: bytes(0x71), color: TOKEN_BYTES, value: 1_000n };

  it('THE HEADLINE: a signer given only the newest secret opens the one before it and names a note made under it', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    await w.deposit(NOTE);
    /* A note the vault makes under the first secret: a split's two pieces. */
    const spent = w.nullifierOf(NOTE);
    const run = await w.approved([{ details: toHex(V.splitDetails(w.self, spent, TOKEN_BYTES, 300n)), nonce: toHex(bytes(0x72)) }], [0n], 820);
    await w.call('splitNote', run.runOf(0), TOKEN_BYTES, 300n);
    /* The company changes its secret; the new copy goes to a signer seated since, who never held the first. */
    const next = await w.setSecret(NEXT_SECRET, [copyFor(9)], 821);
    /* That signer has the newest secret and the chain, and nothing else. */
    const earlier = V.earlierSecretOf(keptEarlier(w, next.commitment), NEXT_SECRET);
    /* RED WHEN the secret replaced is not kept, or not under the new secret's mask, or under another key. */
    expect(hex(earlier)).toBe(hex(SECRET));
    /* RED WHEN what is opened is not the secret the vault's notes were made under: the piece is named from it and found in the pool. */
    const piece: Coin = { nonce: V.freshNonceOf(V.splitNonceTag(), earlier, spent), color: TOKEN_BYTES, value: 300n };
    expect(w.notes()).toContain(hex(w.held(piece)));
  });

  it('walks back through every secret: from the third to the second to the first', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    const second = await w.setSecret(NEXT_SECRET, [copyFor(2)], 822);
    const third = await w.setSecret(THIRD_SECRET, [copyFor(3)], 823);
    const back1 = V.earlierSecretOf(keptEarlier(w, third.commitment), THIRD_SECRET);
    /* RED WHEN each secret does not carry the one it replaced. */
    expect(hex(back1)).toBe(hex(NEXT_SECRET));
    expect(V.secretCommitmentOf(w.self, back1)).toEqual(second.commitment);
    expect(hex(V.earlierSecretOf(keptEarlier(w, second.commitment), back1))).toBe(hex(SECRET));
  });

  it('a first secret carries nothing, and a signer who left, holding only earlier secrets, opens nothing newer', async () => {
    const w = await World.make();
    const first = await w.setSecret(SECRET);
    /* RED WHEN a first secret writes a link to a secret that never was. */
    expect(w.ledger.secretCopies.member(V.earlierSecretKeyOf(first.commitment))).toBe(false);
    const next = await w.setSecret(NEXT_SECRET, [copyFor(9)], 824);
    /* RED WHEN the mask is the earlier secret's, which a signer who left still holds. */
    expect(hex(V.earlierSecretOf(keptEarlier(w, next.commitment), SECRET))).not.toBe(hex(NEXT_SECRET));
    expect(hex(V.earlierSecretOf(keptEarlier(w, next.commitment), SECRET))).not.toBe(hex(SECRET));
  });

  it('REFUSES a caller who does not hold the secret the run sets, or the one it replaces: no later signer is left a key that opens nothing', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    const previous = w.ledger.nonceCommitment;
    const commitment = V.secretCommitmentOf(w.self, NEXT_SECRET);
    const tree = treeOf(commitment, [copyFor(2)]);
    const run = await w.approved(secretLeaf(w.self, previous, commitment, tree, 0x25), [0n], 825);
    /* RED WHEN the secret set is not checked against the commitment the run approved: a removed signer holding the run could set it. */
    await expect(w.call('setNonceSecret', run.runOf(0), previous, commitment, tree.root, tree.count, tree.edge, THIRD_SECRET, SECRET))
      .rejects.toThrow(/does not hold the secret that run sets/);
    /* RED WHEN the earlier secret carried is not checked against the one replaced: the link would open nothing. */
    await expect(w.call('setNonceSecret', run.runOf(0), previous, commitment, tree.root, tree.count, tree.edge, NEXT_SECRET, THIRD_SECRET))
      .rejects.toThrow(/does not carry the last secret this vault took money under/);
    expect(w.ledger.nonceCommitment).toEqual(previous);
    /* The control. */
    await w.call('setNonceSecret', run.runOf(0), previous, commitment, tree.root, tree.count, tree.edge, NEXT_SECRET, SECRET);
    expect(w.ledger.nonceCommitment).toEqual(commitment);
  });

  it('A SECRET WHOSE COPIES NEVER ALL REACHED THE CHAIN IS REPLACED WITHOUT BEING HELD, and the next carries the last secret that took money', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    await w.deposit(NOTE);
    const opened = w.ledger.nonceCommitment;
    /* A rotation is approved and set, and every device that held the new secret is lost before its copies are all in. */
    const lost = V.secretCommitmentOf(w.self, NEXT_SECRET);
    const lostTree = treeOf(lost, [copyFor(2), copyFor(3)]);
    const run = await w.approved(secretLeaf(w.self, opened, lost, lostTree, 0x27), [0n], 827);
    await w.call('setNonceSecret', run.runOf(0), opened, lost, lostTree.root, lostTree.count, lostTree.edge, NEXT_SECRET, SECRET);
    await w.call('writeSecretCopy', lost, copyFor(2).reader, copyFor(2).parts, lostTree.paths[0]);
    await expect(w.call('deposit', { nonce: bytes(0x7b), color: TOKEN_BYTES, value: 1n })).rejects.toThrow(/not every signer's sealed copy/);
    /* The signers who stay hold the first secret, not the lost one. */
    const commitment = V.secretCommitmentOf(w.self, THIRD_SECRET);
    const tree = treeOf(commitment, [copyFor(4)]);
    const again = await w.approved(secretLeaf(w.self, lost, commitment, tree, 0x28), [0n], 828);
    /* RED WHEN the carried secret is not the last one that took money: a lost secret would freeze every note made before it. */
    await expect(w.call('setNonceSecret', again.runOf(0), lost, commitment, tree.root, tree.count, tree.edge, THIRD_SECRET, NEXT_SECRET))
      .rejects.toThrow(/does not carry the last secret this vault took money under/);
    await w.call('setNonceSecret', again.runOf(0), lost, commitment, tree.root, tree.count, tree.edge, THIRD_SECRET, SECRET);
    await w.call('writeSecretCopy', commitment, copyFor(4).reader, copyFor(4).parts, tree.paths[0]);
    w.priv = { ...w.priv, secret: THIRD_SECRET };
    /* RED WHEN the link skips to the lost secret: the newest opens the one the notes were made under. */
    expect(hex(V.earlierSecretOf(keptEarlier(w, commitment), THIRD_SECRET))).toBe(hex(SECRET));
    expect(w.notes()).toContain(hex(w.held(NOTE)));
    /* And the vault takes money again under the new secret. */
    await w.deposit({ nonce: bytes(0x7c), color: TOKEN_BYTES, value: 1n });
  });

  it('A COUNT LARGER THAN THE COPIES never opens the vault, and the next secret run replaces it', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    const opened = w.ledger.nonceCommitment;
    const over = V.secretCommitmentOf(w.self, NEXT_SECRET);
    const copies = [copyFor(2), copyFor(3)];
    const tree = treeOf(over, copies);
    /* Approved at three for a tree of two: nothing past place three, so the edge holds, and place two can never be written. */
    const run = await w.approved(secretLeaf(w.self, opened, over, { root: tree.root, count: 3n }, 0x29), [0n], 829);
    await w.call('setNonceSecret', run.runOf(0), opened, over, tree.root, 3n, pathAt(over, copies, 3), NEXT_SECRET, SECRET);
    for (let i = 0; i < 2; i++) await w.call('writeSecretCopy', over, copies[i]!.reader, copies[i]!.parts, tree.paths[i]);
    /* RED WHEN a count above the copies opens the vault: it stays shut, failing closed. */
    await expect(w.call('deposit', { nonce: bytes(0x7d), color: TOKEN_BYTES, value: 1n })).rejects.toThrow(/not every signer's sealed copy/);
    await w.setSecret(THIRD_SECRET, [copyFor(4)], 830, over, SECRET);
    await w.deposit({ nonce: bytes(0x7e), color: TOKEN_BYTES, value: 1n });
    expect(hex(V.earlierSecretOf(keptEarlier(w, w.ledger.nonceCommitment), THIRD_SECRET))).toBe(hex(SECRET));
  });

  it('REFUSES a secret whose last byte is not zero: it could not be carried by the next', async () => {
    const w = await World.make();
    const whole = bytes(0x54);
    const commitment = V.secretCommitmentOf(w.self, whole);
    const tree = treeOf(commitment, [copyFor(1)]);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, tree, 0x26), [0n], 826);
    /* RED WHEN a secret of thirty-two bytes is taken: a later secret would carry it with its last byte lost. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, whole, ZERO))
      .rejects.toThrow(/ends in a zero byte/);
    expect(V.isNonceSecretShape(SECRET)).toBe(true);
    expect(V.isNonceSecretShape(whole)).toBe(false);
  });
});

describe('the count of copies: under a lasting key, tied to the tree, and kept after every copy is written', () => {
  /** A tree over `leaves` placed as given, zero where nothing is: its root, and the path to any place. */
  const sparse = (leaves: bigint[]) => {
    const empty: bigint[] = [0n];
    for (let l = 0; l < 10; l++) empty.push(V.copyNodeOf(empty[l]!, empty[l]!));
    const levels: bigint[][] = [leaves];
    for (let l = 0; l < 10; l++) {
      const below = levels[l]!;
      const up: bigint[] = [];
      for (let i = 0; i < below.length; i += 2) up.push(V.copyNodeOf(below[i]!, i + 1 < below.length ? below[i + 1]! : empty[l]!));
      levels.push(up);
    }
    const path = (place: number) => Array.from({ length: 10 }, (_, l) => {
      const at = place >> l;
      const beside = at ^ 1;
      return { sibling: beside < levels[l]!.length ? levels[l]![beside]! : empty[l]!, goesLeft: (at & 1) === 0 };
    });
    return { root: V.copiesRootOf(leaves[0]!, path(0)), path };
  };

  it('THE COUNT\'S KEY IS A LASTING HASH: the tagged persistent hash of the commitment', async () => {
    const R: any = await import('@midnight-ntwrk/compact-runtime');
    const commitment = V.secretCommitmentOf(bytes(1), SECRET);
    const tag = new Uint8Array(32);
    tag.set(new TextEncoder().encode('midnight-vault:copies-left:'));
    const lasting = R.persistentHash(new R.CompactTypeVector(2, new R.CompactTypeBytes(32)), [tag, commitment]);
    /* RED WHEN the key goes back to a light hash, which a fork may change between a secret run and its last copy. */
    expect(hex(V.copiesLeftKeyOf(commitment))).toBe(hex(lasting));
  });

  it('REFUSES A COUNT SMALLER THAN THE COPIES THE TREE HOLDS: no vault opens with a copy missing', async () => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const copies = [copyFor(1), copyFor(2), copyFor(3)];
    const tree = treeOf(commitment, copies);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, { root: tree.root, count: 2n }, 0x30), [0n], 830);
    /* RED WHEN the edge's own place is not checked empty: the third copy sits at place two. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, 2n, pathAt(commitment, copies, 2), SECRET, ZERO))
      .rejects.toThrow(/holds a copy past its count/);
    /* RED WHEN the edge is not tied to the count: the path to place three shows nothing about place two. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, 2n, pathAt(commitment, copies, 3), SECRET, ZERO))
      .rejects.toThrow(/holds a copy past its count/);
    expect(w.ledger.nonceCommitment).toEqual(ZERO);
  });

  it('REFUSES A COPY HIDDEN FURTHER RIGHT: every subtree to the right of the edge must be empty', async () => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const leaf = (n: number) => V.copyLeafOf(commitment, copyFor(n).reader, copyFor(n).parts);
    /* Copies at places zero and one, and a third at place five, which a count of two would leave unwritten. */
    const tree = sparse([leaf(1), leaf(2), 0n, 0n, 0n, leaf(3)]);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, { root: tree.root, count: 2n }, 0x31), [0n], 831);
    /* RED WHEN a sibling to the right of the edge is not checked empty. */
    await expect(w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, 2n, tree.path(2), SECRET, ZERO))
      .rejects.toThrow(/holds a copy past its count/);
    /* The control: the same shape with nothing at place five is taken. */
    const clean = sparse([leaf(1), leaf(2)]);
    const ok = await w.approved(secretLeaf(w.self, ZERO, commitment, { root: clean.root, count: 2n }, 0x32), [0n], 832);
    await w.call('setNonceSecret', ok.runOf(0), ZERO, commitment, clean.root, 2n, clean.path(2), SECRET, ZERO);
    expect(w.ledger.nonceCommitment).toEqual(commitment);
  });

  it('A FULL TREE NEEDS NO EDGE: 1024 copies are set with no place past them', async () => {
    const w = await World.make();
    const commitment = V.secretCommitmentOf(w.self, SECRET);
    const copies = Array.from({ length: 1024 }, (_, i) => ({ reader: bytes(i % 256), parts: [bytes(1), bytes(2), bytes(3), bytes(i >> 8)] }));
    const tree = treeOf(commitment, copies);
    const run = await w.approved(secretLeaf(w.self, ZERO, commitment, tree, 0x33), [0n], 833);
    /* RED WHEN a full tree is asked for an edge it cannot have. */
    await w.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, 1024n, tree.edge, SECRET, ZERO);
    expect(w.ledger.nonceCommitment).toEqual(commitment);
  });

  it('THE ORIGINAL COUNT STAYS READABLE once every copy is written, while the count left runs to zero', async () => {
    const w = await World.make();
    const { commitment } = await w.setSecret(SECRET, [copyFor(1), copyFor(2), copyFor(3)], 834);
    /* RED WHEN the count approved is not kept, or is run down with the copies. */
    expect(w.ledger.secretCopies.lookup(V.copiesCountKeyOf(commitment))[0]).toBe(3);
    expect(w.ledger.secretCopies.lookup(V.copiesLeftKeyOf(commitment))).toEqual(ZERO);
  });
});

describe('a finished secret run is closed, and the company-wide secret change is safe for every vault', () => {
  it('A FINISHED SECRET RUN IS CLOSED, not left open to the end of its window', async () => {
    const w = await World.make();
    const { run } = await w.setSecret(SECRET);
    /* RED WHEN the run stays open once its one change is used. */
    expect(w.sim.ledger.openProposals.member(run.id)).toBe(false);
    expect(w.sim.ledger.runWindow.member(run.id)).toBe(false);
  });

  /** One company-wide secret run over `vaults`, one leaf each bound to its vault, approved by `approvers`. */
  const companyWide = async (vaults: World[], secrets: Uint8Array[], seed: number, approvers = [A, B]) => {
    const sets = vaults.map((v, i) => {
      const commitment = V.secretCommitmentOf(v.self, secrets[i]!);
      const tree = treeOf(commitment, [copyFor(i + 1)]);
      return { commitment, tree, previous: v.ledger.nonceCommitment };
    });
    const leaves = vaults.map((v, i) => ({
      details: toHex(P.companyWideDetailsOf(V.secretRunDetails(v.self, sets[i]!.previous, sets[i]!.commitment, sets[i]!.tree.root, sets[i]!.tree.count), v.self)),
      nonce: toHex(bytes((seed + i) % 256)),
    }));
    const run = await vaults[0]!.approved(leaves, vaults.map(() => 0n), seed, approvers, P.companyWide());
    return { run, sets };
  };
  const setOn = (v: World, run: Awaited<ReturnType<typeof companyWide>>, i: number, secret: Uint8Array, earlier = ZERO) => {
    const s = run.sets[i]!;
    return v.call('setNonceSecret', run.run.runOf(i), s.previous, s.commitment, s.tree.root, s.tree.count, s.tree.edge, secret, earlier);
  };

  it('ONE APPROVAL SETS EVERY VAULT\'S SECRET: one leaf per vault, each computed by that vault, and the run closes after the last', async () => {
    const w1 = await World.make();
    const w2 = await World.beside(w1);
    const run = await companyWide([w1, w2], [SECRET, NEXT_SECRET], 840);
    await setOn(w1, run, 0, SECRET);
    /* RED WHEN a company-wide run closes at its first vault: the second could never be set. */
    expect(w1.sim.ledger.openProposals.member(run.run.id)).toBe(true);
    /*
     * The account counts changes, not which leaf: a leaf used again would close the run early. RED WHEN the vault
     * stops refusing its own leaf a second time - its chain to the secret it replaces and its never-twice check both
     * gone - and the replay counts, shutting the second vault out.
     */
    await expect(setOn(w1, run, 0, SECRET)).rejects.toThrow(/replaces a secret this vault no longer holds/);
    expect(w1.sim.ledger.openProposals.member(run.run.id)).toBe(true);
    await setOn(w2, run, 1, NEXT_SECRET);
    expect(w1.ledger.nonceCommitment).toEqual(run.sets[0]!.commitment);
    expect(w2.ledger.nonceCommitment).toEqual(run.sets[1]!.commitment);
    /* RED WHEN the run is left open once every vault's change is used. */
    expect(w1.sim.ledger.openProposals.member(run.run.id)).toBe(false);
  });

  it('A VAULT CANNOT USE ANOTHER VAULT\'S LEAF, even on a first secret where both replace nothing', async () => {
    const w1 = await World.make();
    const w2 = await World.beside(w1);
    const commitment = V.secretCommitmentOf(w2.self, NEXT_SECRET);
    const tree = treeOf(commitment, [copyFor(2)]);
    const set = (run: { runOf: (i: number) => unknown }) =>
      w2.call('setNonceSecret', run.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, NEXT_SECRET, ZERO);
    /* The second vault's own change, bound by the account to the first vault. */
    const boundToTheOther = await w1.approved([{
      details: toHex(P.companyWideDetailsOf(V.secretRunDetails(w2.self, ZERO, commitment, tree.root, tree.count), w1.self)),
      nonce: toHex(bytes(0x41)),
    }], [0n], 841, [A, B], P.companyWide());
    /* RED WHEN the account stops binding a company-wide leaf to the vault asking for it. */
    await expect(set(boundToTheOther)).rejects.toThrow(/that change is not in the approved run/);
    /* The first vault's change, bound by the account to the second: the vault puts itself in what it asks for. */
    const madeForTheOther = await w1.approved([{
      details: toHex(P.companyWideDetailsOf(V.secretRunDetails(w1.self, ZERO, commitment, tree.root, tree.count), w2.self)),
      nonce: toHex(bytes(0x42)),
    }], [0n], 842, [A, B], P.companyWide());
    /* RED WHEN the secret run's details stop binding the vault they are for. */
    await expect(set(madeForTheOther)).rejects.toThrow(/that change is not in the approved run/);
    expect(w2.ledger.nonceCommitment).toEqual(ZERO);
  });

  it('A VAULT STRICTER THAN THE COMPANY REFUSES THE COMPANY-WIDE CHANGE, and takes one of its own at its own bar', async () => {
    const w1 = await World.make([A, B, C], 2n);
    const w2 = await World.beside(w1);
    /* The second vault's own bar is three of three, above the company's two. */
    const tc = change(0n, 842);
    const bar = P.setVaultThresholdPayload(w2.self, 3n);
    await w1.sim.as(w1.sim.applying(A, tc)).propose(bar);
    const bid = w1.sim.proposalId(bar, tc.salt);
    await w1.sim.as(A).approve(bid);
    await w1.sim.as(B).approve(bid);
    await w1.sim.as(w1.sim.applying(A, tc)).setVaultThreshold(w2.self, 3n, bid);
    const run = await companyWide([w1, w2], [SECRET, NEXT_SECRET], 843);
    await setOn(w1, run, 0, SECRET);
    /* RED WHEN the account stops comparing the vault's own bar with the company's on a company-wide change. */
    await expect(setOn(w2, run, 1, NEXT_SECRET)).rejects.toThrow(/change it through a run of its own/);
    expect(w2.ledger.nonceCommitment).toEqual(ZERO);
    /* Its own run, at its own bar, sets it. */
    const commitment = V.secretCommitmentOf(w2.self, NEXT_SECRET);
    const tree = treeOf(commitment, [copyFor(2)]);
    const own = await w2.approved(secretLeaf(w2.self, ZERO, commitment, tree, 0x2c), [0n], 844, [A, B, C]);
    await w2.call('setNonceSecret', own.runOf(0), ZERO, commitment, tree.root, tree.count, tree.edge, NEXT_SECRET, ZERO);
    expect(w2.ledger.nonceCommitment).toEqual(commitment);
  });

  it('A CONTRACT THE COMPANY NEVER ADOPTED gets no secret from a company-wide run, even on a leaf bound to it', async () => {
    const w1 = await World.make();
    const stranger = await World.beside(w1, false);
    const run = await companyWide([w1, stranger], [SECRET, NEXT_SECRET], 845);
    /* RED WHEN the account takes a change receipt from a contract it does not hold. */
    await expect(setOn(stranger, run, 1, NEXT_SECRET)).rejects.toThrow(/not a vault this company holds/);
    expect(stranger.ledger.nonceCommitment).toEqual(ZERO);
  });

  it('A SECRET RUN\'S LEAF IS NEVER SPENT THROUGH A PAYMENT STEP, and its material without the secret sets nothing', async () => {
    const w = await World.make();
    await w.setSecret(SECRET);
    await w.deposit({ nonce: bytes(0x7a), color: TOKEN_BYTES, value: 1_000n });
    const previous = w.ledger.nonceCommitment;
    const commitment = V.secretCommitmentOf(w.self, NEXT_SECRET);
    const tree = treeOf(commitment, [copyFor(2)]);
    const run = await w.approved(secretLeaf(w.self, previous, commitment, tree, 0x2e), [0n], 846);
    /* RED WHEN the payment step takes a leaf whose details are not a payment's: the run's material alone would mark it paid. */
    await expect(w.call('payoutUnshielded', run.runOf(0), ALICE, TOKEN_BYTES, 1n, bytes(0x40)))
      .rejects.toThrow(/that payee is not in the approved run/);
    await expect(w.call('payout', run.runOf(0), ALICE, TOKEN_BYTES, 1n, bytes(0x40), noFurtherNote()))
      .rejects.toThrow(/that payee is not in the approved run/);
    expect(paidRecord(w).length).toBe(0);
    /* RED WHEN a holder of the run who does not hold the new secret can set it: a removed signer keeps the material, not the secret. */
    await expect(w.call('setNonceSecret', run.runOf(0), previous, commitment, tree.root, tree.count, tree.edge, secretOf(0x66), SECRET))
      .rejects.toThrow(/does not hold the secret that run sets/);
    /* The run is still open for the signers who stay. */
    await w.call('setNonceSecret', run.runOf(0), previous, commitment, tree.root, tree.count, tree.edge, NEXT_SECRET, SECRET);
    expect(w.ledger.nonceCommitment).toEqual(commitment);
  });
});
