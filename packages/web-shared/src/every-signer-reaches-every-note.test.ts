/**
 * **EVERY SIGNER'S DEVICE REACHES EVERY NOTE ITS VAULT HOLDS** (`vaultNotesHere`).
 *
 * Two signers, each on their own device, share the company's records (one
 * in-memory store standing in for the service, each record sealed to both).
 * The vault worker is the product's own handler behind the page's own client,
 * over this build's compiled vault, so every commitment is the vault's own. The
 * chain is a stand-in read: the notes the vault holds, every output made for it,
 * the secret's commitment and its split journal, as the wallet's indexer would
 * give them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { newWrappingKeypair, toHex, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { purposeKey } from '../../../src/core/sealed-records.js';
import { MemorySealedPoolStore, SealedNotePool, sealPool, type PoolSigner, type SealedPoolStore } from '../../../src/midnight/vault-pool.js';
import { commitmentForNote, changeAfterSpending } from '../../../src/midnight/vault-recovery.js';
import { compiledOutputCommitment } from '../../../src/midnight/rebuild-from-records.js';
import { nonceCircuitsFrom } from '../../../src/midnight/vault-coin-nonces.js';
import { currentDepositNonceKey, openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { depositNonceAt } from '../../../src/midnight/deposit-nonce.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { recordsReaderOf } from './deposit-on-device.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer, type VaultBuilderClient, type VaultOnChainOnTheWire } from './vault-worker-client.js';
import { coinsHandedOverHere, coinsToHandOverHere, vaultNotesHere, type NotesHere, type RebuildDoors } from './vault-operation.js';
import { coinsFileText, coinsKeptOnThisDevice } from './vault-coins-kept-here.js';
import { inFlightInMemory, openInFlight } from './in-flight-on-this-device.js';

const VAULT = 'ab'.repeat(32) as Hex;
const ACCOUNT = 'c0'.repeat(32);
const TOKEN = '9b'.repeat(32) as Hex;
const TX = 'd7'.repeat(32);
const COMPANY_KEY = new Uint8Array(32).fill(3);
const INDEXER = { indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' };
const R = runtime as unknown as {
  ContractState: { deserialize(b: Uint8Array): any }; StateValue: any; ChargedState: new (v: unknown) => unknown;
  CompactTypeBytes: new (n: number) => any; upgradeFromTransient(x: bigint): Uint8Array;
};
const V = vaultModule as unknown as {
  Contract: new (w: unknown) => { initialState(a: unknown, b: unknown): Promise<{ currentContractState: { serialize(): Uint8Array } }> };
  pureCircuits: any;
};
const bytes = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));
const d = { vault: vaultModule as never, runtimeState: R.ContractState };

const ada = newWrappingKeypair();
const bo = newWrappingKeypair();
const ADA = { signerId: 'ada', wrappingSecret: ada.secret, companyKey: COMPANY_KEY };
const BO = { signerId: 'bo', wrappingSecret: bo.secret, companyKey: COMPANY_KEY };
const BOTH: PoolSigner[] = [{ id: 'ada', wrappingPublicKey: ada.publicKey }, { id: 'bo', wrappingPublicKey: bo.publicKey }];

const listeners: Array<(e: { data: unknown }) => void> = [];
/** The page's own client over the worker's own handler, over this build's compiled vault. */
const worker = vaultBuilderOver({
  postMessage: (m) => {
    void answerVaultAsk(async () => d as never, m as never).then(
      (a: VaultAnswer) => listeners.forEach((l) => l({ data: structuredClone(a) })),
      (e: Error) => listeners.forEach((l) => l({ data: { id: (m as { id: number }).id, ok: false, error: e.message } })));
  },
  addEventListener: (_t, l) => { listeners.push(l); },
}, 'undeployed');

const heldOf = (c: { nonce: string; token: string; value: bigint }) => commitmentForNote(V.pureCircuits, VAULT, c as never).toLowerCase();
let outputOf: (c: { nonce: string; token: string; value: bigint }) => string;

/** One company: the service's records, the chain as the wallet's indexer would read it, and each signer's doors. */
const aCompany = async (o: { signers?: PoolSigner[]; secretFiled?: boolean } = {}) => {
  if (outputOf === undefined) {
    const output = await compiledOutputCommitment();
    outputOf = (coin) => output(coin as never, VAULT).toLowerCase();
  }
  const service = new Map<WireRecord, MemorySealedPoolStore>();
  const stores = (r: WireRecord) => service.get(r) ?? service.set(r, new MemorySealedPoolStore()).get(r)!;
  const filed = startNonceSecret(VAULT, [recordsReaderOf(COMPANY_KEY)]);
  if (o.secretFiled !== false) await stores('nonce-secret').put(VAULT, filed);
  const secret = openNonceSecrets(filed, VAULT, recordsKeypairFrom(COMPANY_KEY)).secrets[0]! as Hex;
  const key = currentDepositNonceKey(openNonceSecrets(filed, VAULT, recordsKeypairFrom(COMPANY_KEY)));
  const chain = {
    notes: [] as string[], everCreated: [] as string[], state: undefined as string | undefined, reads: 0, nextRead: null as string[] | null | 'throws',
    splitJournal: [] as Array<[string, string]>,
    commitment: toHex(V.pureCircuits.secretCommitmentOf(bytes(VAULT), bytes(secret))),
  };
  const read = async (): Promise<VaultOnChainOnTheWire> => {
    chain.reads += 1;
    if (chain.reads > 1 && chain.nextRead === 'throws') throw new Error('the indexer did not answer');
    const notes = chain.reads > 1 && chain.nextRead !== null ? chain.nextRead as string[] : chain.notes;
    return {
      onChain: true, state: chain.state ?? 'AA==', notes, notesFromThisBuild: true, everCreated: chain.everCreated,
      account: ACCOUNT, started: true, nonceCommitment: chain.commitment, splitJournal: chain.splitJournal,
    };
  };
  const builder: RebuildDoors['builder'] = {
    ...worker, vaultOnChain: read,
    createdBy: async () => ({ transactionHash: TX, events: [{ transactionHash: TX } as never] }),
    creatingTransaction: async () => ({ state: 'found', createdIn: TX }),
    eventsOf: async () => [],
  } as VaultBuilderClient;
  const signers = async () => o.signers ?? BOTH;
  const doors = (me: typeof ADA, over: Partial<RebuildDoors> = {}): RebuildDoors => ({
    account: ACCOUNT as never, onChain: async () => ({ holders: { adoptedVaults: [VAULT] } as never }),
    indexer: async () => INDEXER, builder, me, records: stores, signers, seatHere: async () => ({ role: 'admin', retired: null }), ...over,
  });
  const poolOf = (me: typeof ADA) => new SealedNotePool(stores('pool'), { signerId: me.signerId, wrappingSecret: me.wrappingSecret }, signers);
  /* A deposit Ada made: its coin derived from the vault's secret, journalled, and on the chain. */
  const deposited = async (value: bigint, slot = 1, journalled = true) => {
    const coin = { nonce: depositNonceAt(key, { token: TOKEN, value }, slot) as Hex, token: TOKEN, value };
    if (journalled) {
      const j = stores('deposit-journal');
      const now = await j.get(VAULT);
      const lines = now === null ? [] : ((await import('../../../src/midnight/vault-pool.js')).openPool(now, 'ada', ada.secret, { record: 'deposit-journal' }) as { notes: unknown[] }).notes;
      await j.put(VAULT, sealPool(VAULT, { notes: [...lines, coin] } as never, BOTH, (now?.version ?? 0) + 1, 'deposit-journal'));
    }
    chain.notes.push(heldOf(coin));
    chain.everCreated.push(outputOf(coin));
    return coin;
  };
  return { service, stores, chain, doors, poolOf, deposited, secret };
};

beforeEach(() => { /* each test makes its own company */ });

describe('EVERY SIGNER\'S DEVICE REACHES EVERY NOTE ITS VAULT HOLDS', () => {
  it('A DEPOSIT ANOTHER SIGNER\'S DEVICE JOURNALLED AND NEVER ADDED TO THE POOL IS FOUND ON THIS DEVICE, FILED AS THE NEXT POOL VERSION WITH ITS CREATING TRANSACTION', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    const coin = await c.deposited(1_000n);
    const here = await vaultNotesHere(c.doors(BO), VAULT);
    /* RED WHEN: the journal's coin is not handed to the rebuild, or the rebuild is not filed. */
    expect(here.of).toBe('filed');
    const now = await c.poolOf(BO).load(VAULT);
    /* RED WHEN: the note is filed without its creating transaction, so no payment could spend it. */
    expect(now.notes).toEqual([{ ...coin, createdIn: TX }]);
    expect(now.readAt.version).toBe(2);
    /* Opened again, nothing changes and nothing more is filed. */
    expect((await vaultNotesHere(c.doors(ADA), VAULT)).of).toBe('as-filed');
    expect((await c.stores('pool').versions(VAULT)).length).toBe(2);
  });

  it('A NOTE NO RECORD NAMES SENDS ONE OPEN DOWN THE SLOW PATH, AND NOT THE NEXT OPEN ON THIS PAGE; IT IS SAID AND NEVER FILED', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    c.chain.notes.push('5a'.repeat(32));
    const walks: number[] = [];
    const spy = c.doors(ADA);
    const counted = { ...spy, builder: { ...spy.builder, vaultRebuilt: async (a: Parameters<NonNullable<VaultBuilderClient['vaultRebuilt']>>[0]) => { walks.push(a.walk === undefined ? 0 : 1); return worker.vaultRebuilt!(a); } } };
    const first: NotesHere = await vaultNotesHere(counted, VAULT);
    expect(first.of !== 'not-read' && first.unexplained).toBe(1);
    expect(first.said.join(' ')).toMatch(/no record this device can read names/);
    await vaultNotesHere(counted, VAULT);
    /* RED WHEN: every open reads every version and walks again for a note nobody's records name (a stranger's deposit). */
    expect(walks).toEqual([0, 1, 0]);
    expect((await c.stores('pool').versions(VAULT)).length).toBe(1);
  });

  it('A READ WITH NOTES BUT NO SPLIT JOURNAL OR COMMITMENT IS NOT READ, NEVER AN EMPTY JOURNAL', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    await c.deposited(800n);
    const read = await c.doors(ADA).builder.vaultOnChain({ vault: VAULT, indexer: INDEXER }) as VaultOnChainOnTheWire & { onChain: true };
    const { splitJournal: _s, ...withoutJournal } = read;
    const here = await vaultNotesHere(c.doors(ADA), VAULT, { ...withoutJournal, vault: VAULT, notes: read.notes as Hex[] });
    /* RED WHEN: a view without its split journal is rebuilt as though the vault never split. */
    expect(here.of).toBe('not-read');
    expect(here.said.join(' ')).toMatch(/did not give the vault's secret commitment and split journal/);
    await expect(worker.vaultRebuilt!({ vault: VAULT, chain: { notes: [], everCreated: [], nonceCommitment: c.chain.commitment }, secrets: [c.secret], versions: [], attempted: { deposits: [], payments: [] } }))
      .rejects.toThrow(/a journal not read is not an empty one/);
  });

  it('A SLOW PASS THAT NAMES SOME NOTES AND FILES NOTHING IS REMEMBERED BY WHAT THE FAST PASS LEFT UNNAMED', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    await c.deposited(400n, 1);
    await c.deposited(400n, 2, false);
    c.chain.notes.push('5c'.repeat(32));
    const walks: number[] = [];
    const viewer = c.doors(BO, { seatHere: async () => ({ role: 'viewer', retired: null }) });
    const counted = { ...viewer, builder: { ...viewer.builder, vaultRebuilt: async (a: Parameters<NonNullable<VaultBuilderClient['vaultRebuilt']>>[0]) => { walks.push(a.walk === undefined ? 0 : 1); return worker.vaultRebuilt!(a); } } };
    const first = await vaultNotesHere(counted, VAULT);
    /* A viewer's open finds both deposits, holds them in memory and files nothing. */
    expect(first.of).toBe('not-filed');
    expect(first.of !== 'not-read' && first.notes.length).toBe(2);
    await vaultNotesHere(counted, VAULT);
    /* RED WHEN: the memory is stored under the slow pass's unnamed notes, which the next fast pass never matches. */
    expect(walks).toEqual([0, 1, 0]);
    expect((await c.stores('pool').versions(VAULT)).length).toBe(1);
  });

  it('A REBUILD BELIEVES NO RECORD THE ANCHOR DOES NOT HOLD: A WITHHELD JOURNAL IS SAID, A VERSION A DEVICE PASSES OVER IS NEVER OPENED, AND NOTHING IS FILED ON A POOL IT DID NOT READ', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    await c.deposited(1_000n);
    const withheld = (r: WireRecord): SealedPoolStore => {
      const inner = c.stores(r);
      if (r !== 'deposit-journal') return inner;
      return {
        get: async () => { throw new Error('this deposit-journal was not given, and it is not read as absent'); },
        put: (v, x) => inner.put(v, x),
        /* Every version is one a device passes over; the bytes stay with the service, which a rebuild never reads. */
        versions: async (v) => (await inner.versions(v)).map((x) => ({ version: x.version, neverEntered: true as const })),
        versionsAsFiled: (v: string) => inner.versions(v),
      } as SealedPoolStore;
    };
    const here = await vaultNotesHere(c.doors(BO, { records: withheld }), VAULT);
    /* RED WHEN: a withheld journal is read as empty without being said. */
    expect(here.said.join(' ')).toMatch(/deposit journal was not read: this deposit-journal was not given/);
    /* RED WHEN: a passed-over version's bytes are read (`versionsAsFiled`), so the coin is named from a record no device believes. */
    expect(here.of === 'not-read' ? -1 : here.unexplained).toBe(1);
    expect((await c.stores('pool').versions(VAULT)).length).toBe(1);
    const noPool = (r: WireRecord): SealedPoolStore => (r === 'pool'
      ? { ...c.stores(r), get: async () => { throw new Error('version 1 of this pool is not believed'); }, versions: (v: string) => c.stores(r).versions(v), put: (v: string, x: never) => c.stores(r).put(v, x) } as SealedPoolStore
      : c.stores(r));
    const unread = await vaultNotesHere(c.doors(BO, { records: noPool }), VAULT);
    /* RED WHEN: a rebuild files over a pool it did not believe. */
    expect(unread.of).toBe('not-filed');
    expect((await c.stores('pool').versions(VAULT)).length).toBe(1);
  });

  it('A NOTE THE INDEXER HAS NOT SHOWN YET STAYS IN THE POOL; ONE THE CHAIN MADE AND A SECOND READ STILL SHOWS GONE IS DROPPED', async () => {
    const c = await aCompany();
    const notYet = { nonce: '11'.repeat(32) as Hex, token: TOKEN, value: 40n, createdIn: TX as Hex };
    const spent = { nonce: '12'.repeat(32) as Hex, token: TOKEN, value: 50n, createdIn: TX as Hex };
    await c.poolOf(ADA).create(VAULT, { notes: [notYet, spent] });
    c.chain.everCreated.push(outputOf(spent));
    const first = await vaultNotesHere(c.doors(ADA), VAULT);
    /* RED WHEN: a note the history has not shown made is dropped (the indexer is behind, the note is the vault's). */
    expect(first.of !== 'not-read' && first.notes.map((n) => n.nonce)).toEqual([notYet.nonce]);
    const c2 = await aCompany();
    await c2.poolOf(ADA).create(VAULT, { notes: [spent] });
    c2.chain.everCreated.push(outputOf(spent));
    c2.chain.nextRead = [heldOf(spent)];
    const raced = await vaultNotesHere(c2.doors(ADA), VAULT);
    /* RED WHEN: a note dropped on one read whose second read shows it held (made after the first) is dropped anyway. */
    expect(raced.of !== 'not-read' && raced.notes.map((n) => n.nonce)).toEqual([spent.nonce]);
    const c3 = await aCompany();
    const second = { nonce: '13'.repeat(32) as Hex, token: TOKEN, value: 60n, createdIn: TX as Hex };
    await c3.poolOf(ADA).create(VAULT, { notes: [spent, second] });
    c3.chain.everCreated.push(outputOf(spent), outputOf(second));
    c3.chain.nextRead = 'throws';
    const unconfirmed = await vaultNotesHere(c3.doors(ADA), VAULT);
    /* RED WHEN: a second read that fails confirms the drop of any note: both notes made after the first read are kept. */
    expect(unconfirmed.of !== 'not-read' && unconfirmed.notes.map((n) => n.nonce)).toEqual([spent.nonce, second.nonce]);
  });

  it('TWO DEVICES REBUILDING AT ONCE FILE ONE VERSION; THE SECOND FILES NOTHING NEW', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    await c.deposited(700n);
    const [a, b] = await Promise.all([vaultNotesHere(c.doors(ADA), VAULT), vaultNotesHere(c.doors(BO), VAULT)]);
    /* RED WHEN: the device that loses the race gives up, or files the same notes again as a third version. */
    expect([a.of, b.of].sort()).toEqual(['as-filed', 'filed']);
    expect((await c.stores('pool').versions(VAULT)).length).toBe(2);
  });

  it('A SIGNER SEATED AFTER THE LAST WRITE OPENS THE POOL AND THE JOURNALS ONCE ANOTHER SIGNER\'S DEVICE HAS OPENED THE VAULT', async () => {
    const c = await aCompany();
    const onlyAda = [BOTH[0]!];
    await new SealedNotePool(c.stores('pool'), { signerId: 'ada', wrappingSecret: ada.secret }, async () => onlyAda).create(VAULT, { notes: [] });
    await c.stores('payment-journal').put(VAULT, sealPool(VAULT, { attempts: [] } as never, onlyAda, 1, 'payment-journal'));
    await expect(c.poolOf(BO).load(VAULT)).rejects.toThrow(/no copy of the key is wrapped for signer bo/);
    const here = await vaultNotesHere(c.doors(ADA), VAULT);
    expect(here.of).toBe('as-filed');
    /* RED WHEN: nothing seals the newest pool and journals to a signer the directory seats who cannot open them. */
    expect((await c.poolOf(BO).load(VAULT)).notes).toEqual([]);
    const journal = (await c.stores('payment-journal').get(VAULT))!;
    expect(journal.wrapped.map((w) => w.signerId).sort()).toEqual(['ada', 'bo']);
  });

  it('A DEPOSIT WHOSE JOURNAL AND POOL VERSION THE SERVICE WITHHOLDS IS FOUND FROM THE COINS THIS DEVICE KEPT', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    const coin = await c.deposited(400n, 1, false);
    const kept = coinsKeptOnThisDevice(inFlightInMemory(), { signerId: 'ada', wrappingSecret: ada.secret });
    await kept.keep(VAULT, [coin]);
    const without = await vaultNotesHere(c.doors(ADA), VAULT);
    expect(without.of !== 'not-read' && without.unexplained).toBe(1);
    const here = await vaultNotesHere(c.doors(ADA, { kept }), VAULT);
    /* RED WHEN: the coins this device kept are not handed to the rebuild. */
    expect(here.of).toBe('filed');
    expect((await c.poolOf(ADA).load(VAULT)).notes.map((n) => n.nonce)).toEqual([coin.nonce]);
  });

  it('A COIN HANDED OVER BY ANOTHER SIGNER IS KEPT ONLY WHERE THE CHAIN MADE IT; A FORGED ONE NAMES NOTHING', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    const coin = await c.deposited(250n, 2, false);
    const bosKept = coinsKeptOnThisDevice(inFlightInMemory(), { signerId: 'bo', wrappingSecret: bo.secret });
    await bosKept.keep(VAULT, [coin, { nonce: '66'.repeat(32), token: TOKEN, value: 9_999n }]);
    const ACME = { id: 'acc_acme', keys: '5e'.repeat(32) };
    const file = await coinsToHandOverHere({ kept: bosKept }, VAULT, ACME);
    /* RED WHEN: the file names a coin's nonce or amount, or the vault, in clear. */
    /* RED WHEN: the file carries anything outside its seal but its format and epoch: a coin, the vault, or their fields in clear. */
    const outer = JSON.parse(file) as Record<string, unknown>;
    expect(Object.keys(outer).sort()).toEqual(['epoch', 'format', 'sealed']);
    expect(Object.keys(outer.sealed as object).sort()).toEqual(['body', 'iv', 'tag']);
    for (const part of Object.values(outer.sealed as Record<string, unknown>)) expect(part).toMatch(/^[0-9a-f]*$/u);
    expect((outer.sealed as Sealed).body.length).toBeGreaterThan(0);
    /* The seal opens with the company's `vaults` key and holds the coins; with another company's key it does not open. */
    const opened = JSON.parse(unseal(outer.sealed as Sealed, purposeKey(ACME.keys as Hex, ACME.id, 'vaults'))) as { vault: string; coins: Array<{ nonce: string }> };
    expect([opened.vault, opened.coins.map((x) => x.nonce)]).toEqual([VAULT, [coin.nonce, '66'.repeat(32)]]);
    expect(() => unseal(outer.sealed as Sealed, purposeKey(ACME.keys as Hex, 'acc_other', 'vaults'))).toThrow();
    const adasKept = coinsKeptOnThisDevice(inFlightInMemory(), { signerId: 'ada', wrappingSecret: ada.secret });
    /* RED WHEN: a file sealed for another company, or under another company's key, opens. */
    await expect(coinsHandedOverHere(c.doors(ADA, { kept: adasKept }), VAULT, file, { id: 'acc_other', keys: '5e'.repeat(32) })).rejects.toThrow(/does not open with this company/);
    await expect(coinsHandedOverHere(c.doors(ADA, { kept: adasKept }), VAULT, file, { id: 'acc_acme', keys: '6f'.repeat(32) })).rejects.toThrow(/does not open with this company/);
    const taken = await coinsHandedOverHere(c.doors(ADA, { kept: adasKept }), VAULT, file, ACME);
    /* RED WHEN: a coin the chain never made is kept from a file. */
    expect(taken).toEqual({ kept: 1, refused: 1 });
    expect((await adasKept.coins(VAULT)).map((x) => x.nonce)).toEqual([coin.nonce]);
    expect((await vaultNotesHere(c.doors(ADA, { kept: adasKept }), VAULT)).of).toBe('filed');
    /* A file for another vault is refused whole. */
    await expect(coinsHandedOverHere(c.doors(ADA, { kept: adasKept }), VAULT, coinsFileText('cd'.repeat(32) as Hex, [], ACME), ACME)).rejects.toThrow(/for another vault/);
  });

  it('KEPT COINS ARE SEALED UNDER THIS DEVICE\'S OWN KEY AND NEVER SENT TO THE SERVICE', async () => {
    const c = await aCompany();
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    const coin = await c.deposited(300n, 3);
    /* A line the journal holds for a coin the chain never made. */
    const never = { nonce: '77'.repeat(32) as Hex, token: TOKEN, value: 5n };
    const j = c.stores('deposit-journal');
    const lines = ((await import('../../../src/midnight/vault-pool.js')).openPool((await j.get(VAULT))!, 'ada', ada.secret, { record: 'deposit-journal' }) as { notes: unknown[] }).notes;
    await j.put(VAULT, sealPool(VAULT, { notes: [...lines, never] } as never, BOTH, 2, 'deposit-journal'));
    const store = inFlightInMemory();
    const kept = coinsKeptOnThisDevice(store, { signerId: 'ada', wrappingSecret: ada.secret });
    const filed = async () => (await Promise.all([...c.service.values()].map(async (x) => (await x.versions(VAULT)).length))).reduce((a, n) => a + n, 0);
    const before = await filed();
    await vaultNotesHere(c.doors(ADA, { kept }), VAULT);
    /* RED WHEN: a journal line is kept on this device though the chain never made its coin; the coin the chain made is kept. */
    expect((await kept.coins(VAULT)).map((x) => x.nonce)).toEqual([coin.nonce]);
    const sealed = [...store.kept.values()][0]!;
    /* RED WHEN: what is kept can be read without this signer's own key, or names the coin outside its seal. */
    expect(JSON.stringify(sealed)).not.toContain(coin.nonce);
    expect(openInFlight({ signerId: 'ada', wrappingSecret: bo.secret }, 'coins', VAULT, sealed)).toBeNull();
    /* RED WHEN: anything kept is filed with the service: only the pool gains its one version. */
    expect(await filed()).toBe(before + 1);
  });

  it('WITH THE NONCE SECRET\'S RECORD WITHHELD, THE SECRET IS READ FROM THIS SIGNER\'S OWN SEALED COPY ON THE CHAIN, AND A PAYMENT\'S CHANGE IS NAMED', async () => {
    const c = await aCompany();
    const paidFrom = { nonce: '21'.repeat(32) as Hex, token: TOKEN, value: 1_000n, createdIn: TX as Hex };
    await c.poolOf(ADA).create(VAULT, { notes: [paidFrom] });
    await c.stores('payment-journal').put(VAULT, sealPool(VAULT, {
      attempts: [{ spent: { nonce: paidFrom.nonce, token: TOKEN, value: 1_000n }, amount: 300n, step: 'payment', attemptedAt: 't' }],
    } as never, BOTH, 1, 'payment-journal'));
    const under = { circuits: nonceCircuitsFrom(V.pureCircuits), vault: VAULT, secret: c.secret };
    const change = changeAfterSpending(paidFrom, 1_000n, 300n, under)!;
    c.chain.notes = [heldOf(change)];
    c.chain.everCreated = [outputOf(paidFrom), outputOf(change)];
    /* The vault's state, holding this signer's sealed copy of its secret under the secret's commitment. */
    const made = await new V.Contract(new Proxy({}, { get: () => () => { throw new Error('no circuit runs here'); } })).initialState(
      { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } }, { bytes: bytes(ACCOUNT) });
    const state = R.ContractState.deserialize(made.currentContractState.serialize());
    const fields: any[] = state.data.state.asArray();
    const b32 = new R.CompactTypeBytes(32);
    const aligned = (b: Uint8Array) => ({ value: b32.toValue(b), alignment: b32.alignment() });
    const commitment = bytes(c.chain.commitment);
    const reader = bytes(recordsKeypairFrom(COMPANY_KEY).publicKey);
    let copies = fields[7].asMap();
    sealSecretCopy({ vault: VAULT, secret: c.secret, reader: toHex(reader) as Hex }).forEach((part, i) => {
      copies = copies.insert(aligned(V.pureCircuits.copyKeyOf(commitment, reader, 0n, BigInt(i))), R.StateValue.newCell(aligned(part)));
    });
    copies = copies.insert(aligned(V.pureCircuits.copiesCountKeyOf(commitment)), R.StateValue.newCell(aligned(R.upgradeFromTransient(1n))));
    let array = R.StateValue.newArray();
    for (const [i, f] of fields.entries()) array = array.arrayPush(i === 7 ? R.StateValue.newMap(copies) : f);
    state.data = new R.ChargedState(array);
    c.chain.state = Buffer.from(state.serialize()).toString('base64');
    const secretWithheld = (r: WireRecord): SealedPoolStore => (r === 'nonce-secret'
      ? { get: async () => { throw new Error('this nonce-secret was not given'); }, put: async () => {}, versions: async () => [] }
      : c.stores(r));
    const here = await vaultNotesHere(c.doors(ADA, { records: secretWithheld }), VAULT);
    /* RED WHEN: with the secret's record withheld, nothing reads this signer's sealed copy on the chain, so the change stays unnamed. */
    expect(here.of !== 'not-read' && here.notes.map((n) => [n.nonce, n.value])).toEqual([[change.nonce, 700n]]);
    expect(here.of).toBe('filed');
  });
});

describe('A READ OF A VAULT\'S NOTES FILES NOTHING', () => {
  it('A READ GIVEN NO SEAT FINDS THE SAME NOTES A FILING DEVICE WOULD, FILES NO VERSION OF ANY RECORD, AND SAYS THE FILING IS OWED', async () => {
    const c = await aCompany({ signers: [{ id: 'ada', wrappingPublicKey: ada.publicKey }] });
    await c.poolOf(ADA).create(VAULT, { notes: [] });
    const coin = await c.deposited(1_000n);
    const { seatHere: _seat, ...reading } = c.doors(ADA);
    const before = (await c.stores('pool').versions(VAULT)).length;
    const read = await vaultNotesHere({ ...reading, signers: async () => BOTH }, VAULT);
    /* RED WHEN: a read with no seat files the rebuilt pool, or the pool again for a signer who cannot open it yet (the re-file a newly seated signer waits on). */
    expect((await c.stores('pool').versions(VAULT)).length).toBe(before);
    expect((await c.stores('deposit-journal').versions(VAULT)).length).toBe(1);
    /* RED WHEN: a read that files nothing also finds nothing: the note it would have filed is still shown. */
    expect(read.of).toBe('not-filed');
    expect(read.of !== 'not-read' && read.notes).toEqual([{ ...coin, createdIn: TX }]);
    /* RED WHEN: the read says the seat may not file, as though the person's role were the reason, not that a read files nothing. */
    expect(read.said.join(' ')).toMatch(/a read files nothing/);
    expect(read.said.join(' ')).not.toMatch(/its role files none/);
  });
});
