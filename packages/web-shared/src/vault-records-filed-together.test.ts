/**
 * **VAULT RECORDS FILED AS ONE BATCH THROUGH A STEP'S VIEW OF THE COMPANY.** Each store's filing waits until the batch is
 * sent; then the view checks once, sends each write in order and stops at the first refused. What landed before it is
 * filed and entered with one entry write, the refused one and every one after it are answered as not filed, and the
 * next batch files them. A change found before the first write sends nothing.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newWrappingKeypair } from '../../../src/core/crypto.js';
import { sealPool, VaultRecordRefused } from '../../../src/midnight/vault-pool.js';
import { HttpSealedPoolStore, readsJoinedIn } from './http-sealed-pool-store.js';
import { companyViewFor, viewHeldOver } from './company-view.js';
import { CompanyChangedMeanwhile } from './company-view-probe.js';
import { serviceSource, takenOrThrown, type ServiceCall } from './records-source.js';
import { VaultRecordsHeld } from './vault-records-filed-together.js';

const VAULTS = ['a1', 'b2', 'c3'].map((p) => p.repeat(32));
const SIGNING = newSigningKeypair();
const READERS = [{ id: 'aa'.repeat(32), wrappingPublicKey: newWrappingKeypair().publicKey }];
const believeAll = async () => Object.assign(() => null, {}) as never;
const poolOf = (vault: string) => sealPool(vault, { notes: [] } as never, READERS, 1, 'pool');

/** The company's service: each filing taken, except the vaults in `refusing`, each request kept in `asked`. */
const service = (refusing: Set<string>, asked: string[]): ServiceCall => async (path, init) => {
  const method = init?.method ?? 'GET';
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { records?: unknown[]; digest?: string };
  asked.push(`${method} ${path.split('?')[0]}`);
  if (method === 'PUT') {
    const vault = /\/api\/vaults\/([^/]+)\//u.exec(path)![1]!;
    if (refusing.has(vault)) return takenOrThrown({ status: 409, body: { refused: 'not-filed', version: 1, why: 'refused here', error: 'refused' } });
    return { filed: true, record: 'pool', version: 1, digest: body!.digest };
  }
  if (path.endsWith('/directory')) return { filings: [] };
  if (path.endsWith('/manifest/newest')) return { versions: (body?.records ?? []).map(() => 0) };
  if (path.endsWith('/vault-records/read')) return { records: (body?.records ?? []).map(() => ({ record: 'pool', filed: null })) };
  return {};
};

/** A step's view over `call`, opened again after a write it refused, whose holders are read through `holders`. */
const stepOver = (call: ServiceCall, holders: () => Promise<unknown>) => viewHeldOver((from) => companyViewFor(serviceSource(call, 'acc_batch'), {
  holders: holders as never, onChain: async () => ({ landed: [], now: { approvals: 1 } }) as never, builder: { anchorHeads: async () => ({}) as never },
}, async () => ({}) as never, from));

const HOLDERS = { seats: ['a'], approvals: 1, adoptedVaults: VAULTS, threshold: 1, committee: [], vaultThresholds: [], policyBar: null };

/** One pool version for each vault named, filed through a batch held over `step`, then sent: each vault's outcome. */
const batchOf = async (step: ReturnType<typeof stepOver>, vaults: readonly string[]) => {
  const held = new VaultRecordsHeld((writes) => step.current().write(writes));
  const store = new HttpSealedPoolStore('pool', { ...readsJoinedIn(step), held }, SIGNING.secret, believeAll);
  for (const v of vaults) await store.put(v, poolOf(v));
  return held.sent();
};

describe('vault records filed as one batch', () => {
  /* RED WHEN: each filing of the batch is checked and sent on its own, so the check is read once for every vault. */
  it('checks once, sends nothing until the batch is sent, then files each in order and enters them with one entry write', async () => {
    const asked: string[] = [];
    let holdersRead = 0;
    const step = stepOver(service(new Set(), asked), async () => { holdersRead++; return HOLDERS; });
    const held = new VaultRecordsHeld((writes) => step.current().write(writes));
    const store = new HttpSealedPoolStore('pool', { ...readsJoinedIn(step), held }, SIGNING.secret, believeAll);
    for (const v of VAULTS) await store.put(v, poolOf(v));
    expect(asked.filter((a) => a.startsWith('PUT'))).toEqual([]);
    /* RED WHEN: a read of a vault's record a step holds a version of is answered by the service, so its next version is built on an older one. */
    expect((await store.get(VAULTS[1]!))?.version).toBe(1);
    const before = holdersRead;
    const readBefore = asked.length;
    const sent = await held.sent();
    expect(sent.map((s) => s.outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(asked.filter((a) => a.startsWith('PUT')).length).toBe(3);
    expect(asked.filter((a) => a.endsWith('/manifest/entries')).length).toBe(1);
    /* The checks a batch of one vault reads, on a step of its own: a batch of three reads the same. */
    const one: string[] = [];
    let oneRead = 0;
    await batchOf(stepOver(service(new Set(), one), async () => { oneRead++; return HOLDERS; }), VAULTS.slice(0, 1));
    expect(holdersRead - before).toBe(oneRead);
    expect(asked.slice(readBefore).filter((a) => !a.startsWith('PUT')).length).toBe(one.filter((a) => !a.startsWith('PUT')).length);
  });

  /* RED WHEN: a batch stopped part way loses what landed before the stop, sends the writes after it, or says them filed. */
  it('files what landed before a refused write, answers it and those after it as not filed, and the next batch files them', async () => {
    const asked: string[] = [];
    const refusing = new Set([VAULTS[1]!]);
    const step = stepOver(service(refusing, asked), async () => HOLDERS);
    const sent = await batchOf(step, VAULTS);
    expect(sent.map((s) => s.outcome.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    for (const s of sent.slice(1)) expect((s.outcome as PromiseRejectedResult).reason).toBeInstanceOf(VaultRecordRefused);
    expect((sent[2]!.outcome as PromiseRejectedResult).reason.message).toMatch(/was not sent, so it is not filed/u);
    expect(asked.filter((a) => a.startsWith('PUT'))).toEqual([`PUT /api/vaults/${VAULTS[0]}/records/pool/1`, `PUT /api/vaults/${VAULTS[1]}/records/pool/1`]);
    expect(asked.filter((a) => a.endsWith('/manifest/entries')).length).toBe(1);

    refusing.clear();
    asked.length = 0;
    const again = await batchOf(step, VAULTS.slice(1));
    expect(again.map((s) => s.outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(asked.filter((a) => a.startsWith('PUT'))).toEqual([`PUT /api/vaults/${VAULTS[1]}/records/pool/1`, `PUT /api/vaults/${VAULTS[2]}/records/pool/1`]);
  });

  /* RED WHEN: another seat's change found by the check before the batch still lets a write of it out. */
  it('sends nothing when the check before the batch finds another seat\'s change', async () => {
    const asked: string[] = [];
    let holders = HOLDERS;
    const step = stepOver(service(new Set(), asked), async () => holders);
    await step.current().vaultRecords([{ vault: VAULTS[0]!, record: 'pool' }]);
    holders = { ...HOLDERS, seats: ['a', 'b'] };
    const sent = await batchOf(step, VAULTS);
    expect(sent.map((s) => s.outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const s of sent) expect((s.outcome as PromiseRejectedResult).reason).toBeInstanceOf(CompanyChangedMeanwhile);
    expect(asked.filter((a) => a.startsWith('PUT') || a.endsWith('/manifest/entries'))).toEqual([]);
  });
});
