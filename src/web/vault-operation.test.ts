import { describe, it, expect } from 'vitest';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool, DepositNotYetSeen, VaultHandoverOwed,
  type TemporaryKeys, type VaultChainView, type VaultService,
} from './vault-operation.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { MemorySealedPoolStore } from '../midnight/vault-pool.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { newWrappingKeypair } from '../core/crypto.js';

/*
 * The order a signer's device runs, with the service and the builder stood in.
 * The same order against the ledger's own state machine is
 * `contracts/test/a-company-vault-from-the-page.test.ts`.
 */
const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const committee = { committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1 };
const pacing = { sleep: async () => {}, waitMs: 3, everyMs: 1 };
const view = (over: Partial<VaultChainView>): VaultChainView => ({ vault: VAULT, onChain: true, committee, ...over });

const builder = (log: string[]): VaultBuilderClient => ({
  deploy: async () => { log.push('build deploy'); return { vault: VAULT, temporaryKey: { tag: 'schnorr', value: '77'.repeat(32) }, tx: 'D' }; },
  handover: async (i) => { log.push(`build handover at ${i.counter}`); return { tx: 'H' }; },
  deposit: async () => { log.push('build deposit'); return { tx: 'P' }; },
  commitments: async () => ({ output: 'aa'.repeat(32), held: 'bb'.repeat(32) }),
});
const memoryKeys = (log: string[]) => {
  const held = new Map<string, { tag: string; value: string }>();
  const keys: TemporaryKeys = {
    put: async (v, k) => { log.push('key kept'); held.set(v, k); },
    get: async (v) => held.get(v) ?? null,
    forget: async (v) => { log.push('key forgotten'); held.delete(v); },
  };
  return { keys, held };
};
const serviceFrom = (views: VaultChainView[], log: string[], over: Partial<VaultService> = {}): VaultService => {
  let i = 0;
  return {
    keys: async () => ({ committee, why: null, readers: [] }),
    deploy: async () => { log.push('sent deploy'); return { vault: VAULT, txRef: 'd' }; },
    handover: async () => { log.push('sent handover'); return { txRef: 'h' }; },
    chain: async () => views[Math.min(i++, views.length - 1)]!,
    deposit: async () => { log.push('sent deposit'); return { txRef: 'p', transactionHash: 'ee'.repeat(32) }; },
    ...over,
  };
};
const oneKey = view({ authority: { committee: [{ tag: 'schnorr', value: '99'.repeat(32) }], threshold: 1, counter: '0', shape: 'one-key' }, heldByCommittee: false });
const held = view({ heldByCommittee: true, why: null });

describe('CREATING A VAULT', () => {
  it('keeps the temporary key BEFORE the deploy is sent, and forgets it only once the chain says the committee holds the vault', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const done = await createCompanyVault({ ...pacing, account: ACCOUNT, service: serviceFrom([oneKey, held], log), builder: builder(log), keys });
    expect(done).toEqual({ vault: VAULT, state: 'held-by-committee' });
    expect(log).toEqual(['build deploy', 'key kept', 'sent deploy', 'build handover at 0', 'sent handover', 'key forgotten']);
    expect(kept.size).toBe(0);
  });

  it('NO COMMITTEE, NOTHING BUILT', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, { keys: async () => ({ committee: null, why: 'not everybody has given a key.', readers: [] }) });
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service, builder: builder(log), keys: memoryKeys(log).keys }))
      .rejects.toThrow('not everybody has given a key.');
    expect(log).toEqual([]);
  });

  it('A DEPLOY THAT MAY HAVE LANDED IS A FAILURE NAMING THE VAULT, AND THE KEY IS KEPT', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const service = serviceFrom([], log, { deploy: async () => { throw new Error('the node did not answer'); } });
    const e = await createCompanyVault({ ...pacing, account: ACCOUNT, service, builder: builder(log), keys }).catch((x) => x);
    expect(e).toBeInstanceOf(VaultHandoverOwed);
    expect(e.vault).toBe(VAULT);
    expect(kept.has(VAULT)).toBe(true);
  });

  it('A DEPLOY REFUSED BEFORE IT WAS SENT forgets the key and says why', async () => {
    const log: string[] = [];
    const { keys, held: kept } = memoryKeys(log);
    const service = serviceFrom([], log, {
      deploy: async () => { throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); },
    });
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service, builder: builder(log), keys })).rejects.toThrow('refused. Nothing was sent.');
    expect(kept.size).toBe(0);
  });

  it('A HANDOVER THAT DOES NOT SHOW, OR A VAULT THAT NEVER APPEARS, IS NEVER REPORTED CREATED', async () => {
    const log: string[] = [];
    const neverHeld = await createCompanyVault({
      ...pacing, account: ACCOUNT, service: serviceFrom([oneKey], log), builder: builder(log), keys: memoryKeys(log).keys,
    }).catch((x) => x);
    expect(neverHeld).toBeInstanceOf(VaultHandoverOwed);
    expect(log.filter((l) => l === 'sent handover')).toHaveLength(3);
    const absent = await createCompanyVault({
      ...pacing, account: ACCOUNT, service: serviceFrom([view({ onChain: false })], []), builder: builder([]), keys: memoryKeys([]).keys,
    }).catch((x) => x);
    expect(absent).toBeInstanceOf(VaultHandoverOwed);
    expect(absent.message).toMatch(/has not shown the vault yet/);
  });

  it('A RESUME WITHOUT THE TEMPORARY KEY ON THIS DEVICE STOPS, AND SAYS ONLY THE DEPLOYING DEVICE CAN FINISH', async () => {
    const log: string[] = [];
    const e = await createCompanyVault({
      ...pacing, account: ACCOUNT, service: serviceFrom([oneKey], log), builder: builder(log), keys: memoryKeys(log).keys,
    }, VAULT).catch((x) => x);
    expect(e).toBeInstanceOf(VaultHandoverOwed);
    expect(e.message).toMatch(/only the device that deployed it/);
    expect(log).toEqual([]);
  });

  it('a resume for a vault the committee already holds finishes without building anything', async () => {
    const log: string[] = [];
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service: serviceFrom([held], log), builder: builder(log), keys: memoryKeys(log).keys }, VAULT))
      .resolves.toEqual({ vault: VAULT, state: 'held-by-committee' });
    expect(log).toEqual(['key forgotten']);
  });

  it('a vault held by some other committee is not handed over', async () => {
    const log: string[] = [];
    const other = view({ authority: { committee: [], threshold: 2, counter: '3', shape: 'committee' }, heldByCommittee: false, why: 'held by others.' });
    await expect(createCompanyVault({ ...pacing, account: ACCOUNT, service: serviceFrom([other], log), builder: builder(log), keys: memoryKeys(log).keys }, VAULT))
      .rejects.toThrow(/held by others/);
    expect(log).toEqual([]);
  });
});

describe('THE POOL AND A DEPOSIT', () => {
  const wrapping = newWrappingKeypair();
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const stores = () => {
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const poolDoors = (service: VaultService, records = stores()) => ({
    ...pacing, service, me, myRecordsKey: 'ff'.repeat(32), records,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
  });

  it('A POOL IS NOT OPENED FOR A VAULT THE COMMITTEE DOES NOT HOLD, NOR AN EMPTY ONE FOR A VAULT WITH MONEY', async () => {
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([oneKey], [])), VAULT)).rejects.toThrow();
    const records = stores();
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([view({ heldByCommittee: true, everCreated: ['01'] })], []), records), VAULT))
      .rejects.toThrow(/already put money in this vault and it has no pool/);
    expect(await records('pool').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT INTO A VAULT THE COMMITTEE DOES NOT HOLD IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const log: string[] = [];
    const records = stores();
    /* The chain has the vault and its state, so the only thing refusing is who holds it. */
    const stillOurs = view({ ...oneKey, state: 'AAAA', notes: [], everCreated: [] });
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([stillOurs], log), records), company: ACCOUNT, builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 1n })).rejects.toThrow(/not held by the company's committee/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A VAULT THE COMMITTEE HOLDS TAKES NO MONEY WHILE THE COMPANY ACCOUNT IS NOT HELD BY IT, AND THE WALLET IS NEVER ASKED', async () => {
    /* RED WHEN: the `fundable` check in `depositIntoCompanyVault` is removed or moved after the coin is chosen -
     * the log then carries 'build deposit' and 'paid', and the journal holds a coin for a deposit the service refuses. */
    const log: string[] = [];
    const records = stores();
    const vaultOnly = view({
      heldByCommittee: true, fundable: false, state: 'AAAA', notes: [], everCreated: [],
      why: 'this company\'s account is still held by the temporary key it was created with.',
    });
    await openCompanyVaultPool(poolDoors(serviceFrom([vaultOnly], log), records), VAULT);
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([vaultOnly], log), records), company: ACCOUNT, builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n })).rejects.toThrow(/account is still held by the temporary key/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A DEPOSIT THE CHAIN HAS NOT SHOWN IS NOT RECORDED IN THE POOL, AND SAYS IT MAY STILL LAND', async () => {
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, fundable: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), company: ACCOUNT, builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect(log).toEqual(['build deposit', 'paid', 'sent deposit']);
    expect((await records('pool').versions(VAULT)).length).toBe(1);
    expect(await records('deposit-journal').get(VAULT)).not.toBeNull();
  });
});
