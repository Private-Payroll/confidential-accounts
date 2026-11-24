/**
 * **SPENDING POLICIES SEALED AGAIN, FILED AS ONE BATCH THROUGH A STEP'S VIEW OF THE COMPANY.** The view checks once,
 * sends each version in order and stops at the first refused. What landed before it is entered with one entry write;
 * the refused one and every one after it are answered as not filed, and the next seat action files them. A version
 * another seat filed first is answered as that seat's, and is not entered. A change found before the first write sends
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../src/core/crypto.js';
import { signedWithItsEntry } from '../../../src/midnight/record-manifest.js';
import { toCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { sealSpendingPolicy } from '../../../src/midnight/spending-policy-record.js';
import { VaultPoolVersionAlreadyFiled } from '../../../src/midnight/vault-pool.js';
import { TEST_TOKEN } from '../../../src/testing/assets.js';
import { companyViewFor, viewHeldOver } from './company-view.js';
import { CompanyChangedMeanwhile } from './company-view-probe.js';
import { manifestFollowing, recordsEnteredFor } from './record-entered-here.js';
import { serviceSource, takenOrThrown, type ServiceCall } from './records-source.js';
import { filedTogetherThrough } from './spending-policies-reach.js';

const COMPANY = 'acc_batch';
const POLICIES = ['a1', 'b2', 'c3'].map((p) => p.repeat(32));
const SIGNING = newSigningKeypair();
const ANOTHER_SEAT = newSigningKeypair();
const READERS = [{ id: 'aa'.repeat(32), wrappingPublicKey: newWrappingKeypair().publicKey }];
const believeAll = async () => Object.assign(() => null, {}) as never;
const TERMS = { bands: ['10', '20', '30', '40'].map((ceiling) => ({ ceiling, approvals: '1' })), periodLimit: '100', periodStart: '0', periodLength: '60' };
const versionOf = (id: string): SealedCompanyRecord => sealSpendingPolicy({
  company: COMPANY, id: id as Hex, version: 1, keyEpoch: 0,
  secrets: { vault: 'fa'.repeat(32), asset: TEST_TOKEN as never, opening: { terms: TERMS, blinding: '0b'.repeat(32) } as never }, signers: READERS as never,
});

/*
 * The company's service: each version filed, except a policy in `refusing`, refused, and one in `takenBy`, told taken and
 * holding another seat's filing; each request kept in `asked`.
 */
const service = (refusing: Set<string>, asked: string[], takenBy = new Map<string, SealedCompanyRecord>()): ServiceCall => async (path, init) => {
  const method = init?.method ?? 'GET';
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { records?: { id?: string }[]; digest?: string };
  asked.push(`${method} ${path.split('?')[0]}`);
  if (method === 'PUT') {
    const id = /\/records\/spending-policy\/([^/]+)\//u.exec(path)![1]!;
    if (refusing.has(id)) return takenOrThrown({ status: 409, body: { refused: 'not-filed', version: 1, why: 'refused here', error: 'refused' } });
    if (takenBy.has(id)) return takenOrThrown({ status: 409, body: { refused: 'version-already-filed', version: 1, error: 'taken' } });
    return { filed: true, version: 1, digest: body!.digest };
  }
  if (path.endsWith('/directory')) return { filings: [] };
  if (path.endsWith('/manifest/newest')) return { versions: (body?.records ?? []).map(() => 0) };
  if (path.endsWith('/records/read')) {
    return { records: (body?.records ?? []).map((r) => {
      const theirs = takenBy.get(String(r.id));
      return { versions: theirs === undefined ? [] : [toCompanyWire(signedWithItsEntry(theirs, ANOTHER_SEAT.secret))] };
    }) };
  }
  return {};
};

/** A step's view over `call`, opened again after a write it refused, whose holders are read through `holders`. */
const stepOver = (call: ServiceCall, holders: () => Promise<unknown>) => viewHeldOver((from) => companyViewFor(serviceSource(call, COMPANY), {
  holders: holders as never, onChain: async () => ({ landed: [], now: { approvals: 1 } }) as never, builder: { anchorHeads: async () => ({}) as never },
}, async () => ({}) as never, from));

const HOLDERS = { seats: ['a'], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null };

/** One version of each policy named, filed as one batch through `step`: each one's outcome. */
const batchOf = (step: ReturnType<typeof stepOver>, ids: readonly string[]) =>
  filedTogetherThrough(COMPANY, step, SIGNING.secret, believeAll, recordsEnteredFor(manifestFollowing(step), COMPANY, SIGNING.secret))(ids.map(versionOf));

describe('spending policies sealed again, filed as one batch', () => {
  /* RED WHEN: each version of the batch is checked and sent on its own, or the ones filed are entered one write each. */
  it('checks once, files each in order and enters them with one entry write, reading for the check what a batch of one reads', async () => {
    const asked: string[] = [];
    let holdersRead = 0;
    const sent = await batchOf(stepOver(service(new Set(), asked), async () => { holdersRead++; return HOLDERS; }), POLICIES);
    expect(sent.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(asked.filter((a) => a.startsWith('PUT'))).toEqual(POLICIES.map((id) => `PUT /api/accounts/${COMPANY}/records/spending-policy/${id}/1`));
    expect(asked.filter((a) => a.endsWith('/manifest/entries')).length).toBe(1);
    const one: string[] = [];
    let oneRead = 0;
    await batchOf(stepOver(service(new Set(), one), async () => { oneRead++; return HOLDERS; }), POLICIES.slice(0, 1));
    expect(holdersRead).toBe(oneRead);
    expect(asked.filter((a) => !a.startsWith('PUT')).length).toBe(one.filter((a) => !a.startsWith('PUT')).length);
  });

  /* RED WHEN: a batch stopped part way loses what landed before the stop, sends the versions after it, or says them filed. */
  it('files what landed before a refused version, answers it and those after it as not filed, and the next batch files them', async () => {
    const asked: string[] = [];
    const refusing = new Set([POLICIES[1]!]);
    const step = stepOver(service(refusing, asked), async () => HOLDERS);
    const sent = await batchOf(step, POLICIES);
    expect(sent.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(String((sent[1] as PromiseRejectedResult).reason.message)).toMatch(/was refused and not filed/u);
    expect(String((sent[2] as PromiseRejectedResult).reason.message)).toMatch(/was not sent, so it is not filed/u);
    expect(asked.filter((a) => a.startsWith('PUT')).length).toBe(2);
    expect(asked.filter((a) => a.endsWith('/manifest/entries')).length).toBe(1);

    refusing.clear();
    asked.length = 0;
    const again = await batchOf(step, POLICIES.slice(1));
    expect(again.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(asked.filter((a) => a.startsWith('PUT')).length).toBe(2);
  });

  /* RED WHEN: a version another seat filed first is taken for this seat's own, or entered as filed by it. */
  it('answers a version another seat filed first as theirs, enters only what this seat filed, and sends nothing after it', async () => {
    const asked: string[] = [];
    const step = stepOver(service(new Set(), asked, new Map([[POLICIES[1]!, versionOf(POLICIES[1]!)]])), async () => HOLDERS);
    const sent = await batchOf(step, POLICIES);
    expect(sent.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect((sent[1] as PromiseRejectedResult).reason).toBeInstanceOf(VaultPoolVersionAlreadyFiled);
    expect(asked.filter((a) => a.startsWith('PUT')).length).toBe(2);
    expect(asked.filter((a) => a.endsWith('/manifest/entries')).length).toBe(1);
  });

  /* RED WHEN: another seat's change found by the check before the batch still lets a version of it out. */
  it('sends nothing when the check before the batch finds another seat\'s change', async () => {
    const asked: string[] = [];
    let holders = HOLDERS;
    const step = stepOver(service(new Set(), asked), async () => holders);
    await step.current().records([{ kind: 'spending-policy', id: POLICIES[0]! }]);
    holders = { ...HOLDERS, seats: ['a', 'b'] };
    const sent = await batchOf(step, POLICIES);
    expect(sent.map((s) => s.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const s of sent) expect((s as PromiseRejectedResult).reason).toBeInstanceOf(CompanyChangedMeanwhile);
    expect(asked.filter((a) => a.startsWith('PUT') || a.endsWith('/manifest/entries'))).toEqual([]);
  });
});
