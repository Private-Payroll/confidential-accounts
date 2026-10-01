/**
 * **THE COINS A VAULT MAKES ARE NAMED AGAIN ONLY WITH THE SECRET THEY WERE MADE
 * UNDER**, against the real compiled vault run in process: a payment's change, a
 * split's two pieces with the piece's amount from the vault's own split journal,
 * and a vault whose secret was rotated between two payments. Each named note is
 * then spent, because a named note that cannot be spent is not recovered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract as Vault, ledger as vaultLedger, pureCircuits as V,
} from '../../contracts/managed-vault/contract/index.js';
import { pureCircuits as P } from '../../contracts/managed/contract/index.js';
import {
  AccountSimulator, privateStateFor, change, payoutTreeOf, vaultRunOf,
} from '../../contracts/test/simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from '../../contracts/test/start-a-vault.js';
import { copiesTreeOf } from './sealed-copies-tree.js';
import { changeCoinOf, paidCoinTo } from './vault-coins.js';
import { replayVault, reconcileVaultPool } from './vault-recovery.js';
import { NonceSecretNotTheVaults } from './vault-coin-nonces.js';
import { smallestNoteCovering, type Note } from './vault-notes.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';

const NOW = 1_800_000_000;
const FROM = BigInt(NOW - 3_600);
const UNTIL = BigInt(NOW + 3_600);
const BLOCK = '0'.repeat(64);
const bytes = (n: number) => new Uint8Array(32).fill(n);
const A = privateStateFor(1);
const B = privateStateFor(2);
const TOKEN = bytes(0x9b);
const ALICE = bytes(0x0a);
const BOB = bytes(0x0b);
const OLD = toHex(TEST_VAULT_SECRET);
const NEW = toHex(Uint8Array.from(bytes(0x62), (b, i) => (i === 31 ? 0 : b)));
const WRONG = toHex(bytes(0x73));

interface VaultPrivate { notes: Note[] }

describe('naming the coins a vault made, with the secret each was made under', () => {
  let sim: AccountSimulator;
  let vault: Vault<VaultPrivate>;
  let vaultAddr: Hex;
  let vaultState: any;
  let priv: VaultPrivate;
  /** The secret the device hands the vault's witness: the vault's current one. */
  let secretNow: Hex;

  const FIRST = { nonce: toHex(bytes(0x77)), token: toHex(TOKEN), value: 1_000n };
  const SECOND = { nonce: toHex(bytes(0x88)), token: toHex(TOKEN), value: 400n };
  const asNotes = (coins: readonly { nonce: Hex; token: Hex; value: bigint }[]): Note[] => coins.map((c) => ({ ...c, index: 0n }));

  const provider = () => ({
    getContractState: async (_b: string, address: unknown) =>
      String(address) === String(sim.address) ? (sim.contractStateForCall as never) : undefined,
  });
  const ctx = (circuit: string) => createCircuitContext<VaultPrivate>(
    circuit as never, vaultAddr as never, BLOCK, vaultState, priv, provider() as never, undefined, undefined, NOW, BLOCK);
  const call = async (circuit: string, ...a: unknown[]): Promise<any> => {
    const r: any = await (vault.impureCircuits as any)[circuit](ctx(circuit), ...a);
    vaultState = r.context.callContext.currentQueryContext.state;
    carryTheAccount(sim, r.context);
    return r;
  };
  const chainNotes = (): Hex[] => [...vaultLedger(vaultState as never).notes].map((c: Uint8Array) => toHex(c));
  const commitmentNow = (): Hex => toHex(vaultLedger(vaultState as never).nonceCommitment);
  const splitJournal = (): Map<Hex, Hex> =>
    new Map([...vaultLedger(vaultState as never).splitJournal].map(([k, v]: [Uint8Array, Uint8Array]) => [toHex(k), toHex(v)]));

  const approved = async (details: Uint8Array, amount: bigint, seed: number) => {
    const leaves = [{ details: toHex(details), nonce: toHex(bytes(seed)) }];
    const tree = payoutTreeOf(leaves, [amount], TOKEN);
    const c = change(0n, seed);
    const vaultBytes = fromHex(vaultAddr);
    await sim.as(sim.applying(A, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from: FROM, until: UNTIL, vault: vaultBytes });
    const id = sim.proposalId(P.runPayload(fromHex(tree.root), tree.payees, FROM, UNTIL, 0n), c.salt, vaultBytes);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);
    return vaultRunOf({ proposal: id, vault: vaultBytes, tree, i: 0, opensAt: FROM, closesAt: UNTIL, salt: c.salt, nonce: bytes(seed) });
  };
  const pay = async (to: Uint8Array, amount: bigint, seed: number) => {
    const run = await approved(V.payoutDetails(to, TOKEN, amount, bytes(0x40)), amount, seed);
    return call('payout', run, to, TOKEN, amount, bytes(0x40));
  };
  const split = async (amount: bigint, seed: number) => {
    const n = smallestNoteCovering(priv.notes, toHex(TOKEN), amount)!;
    const vaultBytes = fromHex(vaultAddr);
    const spent = V.noteNullifierOf(vaultBytes, { nonce: fromHex(n.nonce), color: fromHex(n.token), value: n.value });
    const run = await approved(V.splitDetails(vaultBytes, spent, TOKEN, amount), 0n, seed);
    return call('splitNote', run, TOKEN, amount);
  };
  /** A secret run, as the account approves one: the vault's secret replaced, and its one sealed copy written. */
  const rotateTo = async (next: Hex, seed: number) => {
    const vaultBytes = fromHex(vaultAddr);
    const previous = vaultLedger(vaultState as never).nonceCommitment;
    const commitment = V.secretCommitmentOf(vaultBytes, fromHex(next));
    const copy = { reader: bytes(0x32), parts: [5, 6, 7, 8].map((p) => bytes(p)) };
    const copies = copiesTreeOf(V as never, commitment, [copy]);
    const run = await approved(V.secretRunDetails(vaultBytes, previous, commitment, copies.root, copies.count), 0n, seed);
    await call('setNonceSecret', run, previous, commitment, copies.root, copies.count, copies.edge, fromHex(next), fromHex(secretNow));
    await call('writeSecretCopy', commitment, copy.reader, copy.parts, copies.paths[0]);
    secretNow = next;
  };

  beforeEach(async () => {
    sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(NOW);
    secretNow = OLD;
    vault = new Vault<VaultPrivate>({
      noteToSpend: (c: { privateState: VaultPrivate }, token: Uint8Array, amount: bigint) => {
        const n = smallestNoteCovering(c.privateState.notes, toHex(token), amount);
        if (n === undefined) throw new Error(`the test pool has no note covering ${amount}`);
        return [c.privateState, { nonce: fromHex(n.nonce), color: fromHex(n.token), value: n.value, mt_index: n.index }];
      },
      nonceSecret: (c: { privateState: VaultPrivate }) => [c.privateState, fromHex(secretNow)],
    } as never);
    vaultAddr = sampleContractAddress() as never as Hex;
    const init = await vault.initialState(createConstructorContext({} as VaultPrivate, BLOCK), { bytes: fromHex(String(sim.address)) } as never);
    vaultState = init.currentContractState;
    priv = { notes: [] };
    await startTheVault({ sim, vault: fromHex(vaultAddr), approvers: [A, B], now: NOW, call });
    for (const coin of [FIRST, SECOND]) await call('deposit', { nonce: fromHex(coin.nonce), color: fromHex(coin.token), value: coin.value });
    priv = { notes: asNotes([FIRST, SECOND]) };
  });

  it('A PAYMENT\'S CHANGE IS NAMED ONLY WITH THE SECRET IT WAS MADE UNDER, and then it spends', async () => {
    const paid = await pay(ALICE, 250n, 0xe1);               // SECOND (400) -> change 150; the pool write is lost
    const made = changeCoinOf(paid.context.callContext.currentZswapLocalState, vaultAddr)!;
    const versions = [{ version: 1, notes: asNotes([FIRST, SECOND]) }];
    const attempted = { deposits: [], payments: [{ spent: SECOND, amount: 250n }] };
    const rebuild = (nonceSecrets?: { secrets: Hex[]; commitment: Hex }) => reconcileVaultPool({
      vault: vaultAddr, chain: chainNotes(), versions, attempted, circuits: V, ...(nonceSecrets ? { nonceSecrets } : {}),
    });

    const named = rebuild({ secrets: [WRONG, OLD], commitment: commitmentNow() });
    expect(
      named.recovered.map((n) => [n.nonce, n.value]),
      /* RED WHEN the change's nonce is worked out with any tag, secret or spent-note input but the vault's own */
      'RED WHEN: the change the vault made is not named from the secret it was made under',
    ).toEqual([[made.nonce, 150n]]);
    expect(
      () => rebuild({ secrets: [WRONG], commitment: commitmentNow() }),
      /* RED WHEN the secrets are not checked against the vault's commitment before anything is named */
      'RED WHEN: secrets none of which is the vault\'s are used to name coins rather than refused by name',
    ).toThrow(NonceSecretNotTheVaults);
    const without = rebuild();
    /* RED WHEN a change is worked out without the vault's secret */
    expect(without.unexplained, 'RED WHEN: without the secret a change is still guessed at').toHaveLength(1);
    /* RED WHEN an event whose coins were not named is not reported */
    expect(without.unnamedWithoutTheSecret, 'RED WHEN: a rebuild without the secret does not say which events it could not name').toEqual([2]);

    priv = { notes: asNotes(named.held) };
    /* RED WHEN the rebuilt pool hands back a note other than the coin the chain holds */
    await expect(
      pay(BOB, 120n, 0xe2).then((r) => changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr)?.value),
      'RED WHEN: the change named again cannot be spent',
    ).resolves.toBe(30n);                                     // 150 is the smallest note covering 120
  });

  it('A SPLIT\'S TWO PIECES ARE NAMED WITH THEIR AMOUNTS FROM THE VAULT\'S SPLIT JOURNAL, and the piece spends', async () => {
    await split(300n, 0x5a);                                  // SECOND (400) -> 300 and 100; the pool write is lost
    const versions = [{ version: 1, notes: asNotes([FIRST, SECOND]) }];
    const r = reconcileVaultPool({
      vault: vaultAddr, chain: chainNotes(), versions, circuits: V,
      nonceSecrets: { secrets: [OLD], commitment: commitmentNow() }, splitJournal: splitJournal(),
    });
    expect(
      r.recovered.map((n) => n.value).sort((a, b) => Number(a - b)),
      /* RED WHEN the journal's amount is not unmasked with the secret, or a piece takes the other piece's tag */
      'RED WHEN: a split\'s pieces are not both named, with the amount the journal holds',
    ).toEqual([100n, 300n]);
    expect(
      /* RED WHEN a split journal is read without the secret and nothing is said */
      () => reconcileVaultPool({ vault: vaultAddr, chain: chainNotes(), versions, circuits: V, splitJournal: splitJournal() }),
      'RED WHEN: a split journal is read without the secret and its pieces left unnamed in silence',
    ).toThrow(/nonce secret/);

    priv = { notes: asNotes(r.held) };
    /* RED WHEN the rebuilt pool hands back a note other than the coin the chain holds */
    await expect(
      pay(ALICE, 250n, 0xc1).then((p) => changeCoinOf(p.context.callContext.currentZswapLocalState, vaultAddr)?.value),
      'RED WHEN: the piece named again cannot be spent',
    ).resolves.toBe(50n);                                     // 300 is the smallest note covering 250
  });

  it('A VAULT WHOSE SECRET WAS ROTATED NAMES WHAT IT MADE UNDER THE OLD SECRET AND THE NEW', async () => {
    const before = await pay(ALICE, 250n, 0xa1);              // SECOND under the old secret -> change 150
    priv = { notes: asNotes([FIRST]) };
    await rotateTo(NEW, 0x91);
    const after = await pay(BOB, 100n, 0xa2);                 // FIRST under the new secret -> change 900
    const versions = [{ version: 1, notes: asNotes([FIRST, SECOND]) }];
    const attempted = { deposits: [], payments: [{ spent: SECOND, amount: 250n }, { spent: FIRST, amount: 100n }] };
    const rebuild = (secrets: Hex[]) => reconcileVaultPool({
      vault: vaultAddr, chain: chainNotes(), versions, attempted, circuits: V,
      nonceSecrets: { secrets, commitment: commitmentNow() },
    });

    expect(
      rebuild([NEW]).held.map((n) => n.value),
      /* RED WHEN a coin is named without the secret it was made under */
      'RED WHEN: the change made under the old secret is named with only the new one',
    ).toEqual([900n]);
    const both = rebuild([OLD, NEW]);
    expect(
      both.held.map((n) => n.value).sort((a, b) => Number(a - b)),
      /* RED WHEN only the newest secret is tried */
      'RED WHEN: a coin made under a secret since rotated is not named',
    ).toEqual([150n, 900n]);
    expect(
      /* RED WHEN the secrets are not checked against the vault's commitment */
      () => rebuild([OLD]),
      'RED WHEN: a record older than the vault\'s current secret is used rather than refused by name',
    ).toThrow(NonceSecretNotTheVaults);

    /* The payee coins, each from the secret its change shows, for marking each payment as paid. */
    const { paid, paidUnsettled } = replayVault({
      vault: vaultAddr, chain: chainNotes(), pool: [], circuits: V,
      history: [
        { kind: 'deposit', coin: FIRST }, { kind: 'deposit', coin: SECOND },
        { kind: 'payout', spent: SECOND.nonce, amount: 250n }, { kind: 'payout', spent: FIRST.nonce, amount: 100n },
      ],
      nonceSecrets: { secrets: [OLD, NEW], commitment: commitmentNow() },
    });
    /* RED WHEN a payment whose change shows its secret is left unsettled */
    expect(paidUnsettled, 'RED WHEN: the chain\'s answer about which secret made a payment is not used').toEqual([]);
    expect(
      paid,
      /* RED WHEN the payee coin is taken from a secret other than the one its change shows */
      'RED WHEN: a payee coin is named under a secret that did not make it',
    ).toEqual([
      paidCoinTo(before.context.callContext.currentZswapLocalState, toHex(ALICE)),
      paidCoinTo(after.context.callContext.currentZswapLocalState, toHex(BOB)),
    ]);

    priv = { notes: asNotes(both.held) };
    /* RED WHEN the rebuilt pool hands back a note other than the coin the chain holds */
    await expect(
      pay(ALICE, 140n, 0xa3).then((r) => changeCoinOf(r.context.callContext.currentZswapLocalState, vaultAddr)?.value),
      'RED WHEN: the change made under the old secret cannot be spent',
    ).resolves.toBe(10n);                                     // the 150 made under the old secret
  });
});
