// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealRecord, type Purpose } from '../../../../src/core/sealed-records.js';

/*
 * A READER READS A COMPANY'S RUNS AND PROPOSALS with the purpose keys its wallet released and nothing else. The service and
 * the chain are stood in for; the runs are sealed with the record code the service uses and opened with the code a page opens
 * them with. What is asked here is which keys open what, what a link that is not the company's does, and what "not found" says.
 */
const t = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>, notFound: [] as string[], proposalArgs: [] as unknown[][],
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => {
  const actual = await real<typeof import('vaults-web-shared/keyring.js')>();
  return {
    ...actual,
    api: async (path: string) => {
      if (t.notFound.includes(path)) throw new actual.NotOnTheService('not found');
      if (!(path in t.answers)) throw new Error(`no answer for ${path}`);
      return t.answers[path];
    },
  };
});
vi.mock('./filing-judge.js', () => ({ readerDirectoryHereFor: () => (held: unknown) => async () => ({ held }) }));
vi.mock('./company-records.js', async (real) => ({
  ...(await real<typeof import('./company-records.js')>()),
  runsPaidFromTheChain: async (_sealed: unknown, runs: unknown) => runs,
  proposalsHere: async (...args: unknown[]) => {
    t.proposalArgs.push(args);
    const standing = { status: 'open', shown: 'open', approvals: 1, needed: 2, raisedAt: '2026-09-20T10:00:00.000Z', filer: '1a'.repeat(32), raised: true, outrun: false };
    return { believed: [{ opened: { id: 'p1', kind: 'payroll', proposedBy: 's1' }, standing }], unreadable: [{ id: 'p9', kind: 'unreadable' }] };
  },
}));

const { readReaderCompany, READER_OF, READER_REFUSED } = await import('./reader-records.js');
type ReaderLink = import('./reader-records.js').ReaderLink;
type ReaderCompany = import('./reader-records.js').ReaderCompany;
const { purposeKeysAt } = await import('vaults-web-shared/purpose-wraps.js');
type Held = import('vaults-web-shared/purpose-wraps.js').PurposeWrapsHeld;

const KEY = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const LABEL = `co_${'c1'.repeat(32)}` as never;
const ADDRESS = 'c0'.repeat(32) as never;
const held = (byEpoch: Record<number, Partial<Record<Purpose, string>>>): Held => Object.freeze({
  kind: 'purpose-wraps' as const, accountId: 'c1',
  byEpoch: new Map(Object.entries(byEpoch).map(([e, keys]) => [Number(e), new Map(Object.entries(keys) as [Purpose, string][])])),
  unopened: [],
}) as Held;
const ACCOUNTANT = held({ 1: { payroll: KEY(1), proposals: KEY(2), roster: KEY(3) } });
const LIMITED = held({ 1: { proposals: KEY(2), roster: KEY(3) } });
const LINK: ReaderLink = { id: 'c1', label: LABEL, account: ADDRESS };
const keys = (h: Held) => purposeKeysAt(h, 1);
const ROUTE = (r = '') => `/api/accounts/c1${r}`;
const sealedRun = (id: string, period: string, keyEpoch: number) => ({
  id, accountId: 'c1', period, status: 'draft', payslips: [], keyEpoch,
  sealed: sealRecord('payroll', 'c1', { employees: [{ id: 'e1', name: 'Ana', asset: 'f0'.repeat(32), amount: 5n }], totals: {}, proposalIds: {} }, keys(ACCOUNTANT)),
});
const SIGNING = '1a'.repeat(32);
const account = (over: Record<string, unknown> = {}) => ({
  id: 'c1', companyLabel: LABEL, contractAddress: ADDRESS,
  roster: {
    company: 'c1', kind: 'roster', id: 'roster', version: 2, keyEpoch: 1,
    sealed: sealRecord('roster', 'c1', { name: 'Acme', signers: [{ id: 's1', name: 'Priya', signingPublicKey: SIGNING }] }, keys(ACCOUNTANT)),
  },
  ...over,
});

beforeEach(() => {
  t.notFound = []; t.proposalArgs = [];
  t.answers = { [ROUTE()]: account(), [ROUTE('/runs')]: [sealedRun('r0', '2026-09', 1), sealedRun('r1', '2026-10', 1)], [ROUTE('/proposals')]: [] };
});

describe('A READER READS A COMPANY WITH ITS PURPOSE KEYS', () => {
  it('OPENS THE RUNS WITH THE PAYROLL KEY, NEWEST PERIOD FIRST, AND HANDS THE PROPOSALS THE KEYS AND NO COMPANY KEY', async () => {
    const read: ReaderCompany = await readReaderCompany(ACCOUNTANT, LINK);
    /* RED WHEN: a run a reader's payroll key opens is not read, or the runs are not newest first. */
    expect(read.of === READER_OF.open && read.runs.of === 'read' ? read.runs.value.rows.map((r) => r.period) : null).toEqual(['2026-10', '2026-09']);
    /* RED WHEN: the proposals are read with anything but the purpose keys the wallet released. */
    expect(t.proposalArgs[0]![4]).toBe(ACCOUNTANT);
    /* RED WHEN: a proposal the page cannot open is left out of the list instead of listed as unreadable. */
    expect(read.of === READER_OF.open && read.proposals.of === 'read' ? read.proposals.value.map((p) => p.id) : null).toEqual(['p1', 'p9']);
  });

  it('SHOWS THE RUNS THAT OPEN AND LISTS A RUN SEALED AT AN EPOCH THE GRANT NEVER WRAPPED AS ONE THAT DID NOT', async () => {
    t.answers[ROUTE('/runs')] = [sealedRun('r2', '2026-11', 2), sealedRun('r0', '2026-09', 1)];
    const read = await readReaderCompany(ACCOUNTANT, LINK);
    const runs = read.of === READER_OF.open && read.runs.of === 'read' ? read.runs.value : null;
    /* RED WHEN: one run sealed after the keys the grant wrapped makes the whole list unreadable, or the run that opens is left out. */
    expect(runs?.rows.map((r) => r.period)).toEqual(['2026-09']);
    /* RED WHEN: a run that does not open is dropped without a row, or shown as read. */
    expect(runs?.unreadable).toEqual([{ id: 'r2', period: '2026-11' }]);
  });

  it('SAYS A KIND THE SERVICE DOES NOT SERVE THIS READER IS NOT IN ITS ACCESS, AND NOT THAT THE GRANT WAS TAKEN AWAY', async () => {
    t.notFound = [ROUTE('/runs')];
    const read = await readReaderCompany(LIMITED, LINK);
    /* RED WHEN: a limited reader's runs "not found" reads as unreadable, or as a refusal of the whole company. */
    expect(read.of === READER_OF.open ? read.runs.of : null).toBe('not-in-access');
    expect(read.of === READER_OF.open ? read.proposals.of : null).toBe('read');
  });

  it('NAMES WHO RAISED A PROPOSAL FROM THE ROSTER OPENED WITH THE ROSTER KEY, AND NAMES NOBODY WHEN THE GRANT HOLDS NO ROSTER KEY', async () => {
    const raisedBy = async (h: Held) => { const r = await readReaderCompany(h, LINK); return r.of === READER_OF.open && r.proposals.of === 'read' ? r.proposals.value[0]!.raisedBy : 'unread'; };
    /* RED WHEN: the roster's signers are not handed to the proposals' rows. */
    expect(await raisedBy(ACCOUNTANT)).toBe('Priya');
    /* RED WHEN: a roster that does not open with this reader's keys is read as if it had. */
    expect(await raisedBy(held({ 1: { payroll: KEY(1), proposals: KEY(2) } }))).toBeNull();
  });

  it('REFUSES A LINK WHOSE LABEL OR ADDRESS IS NOT THE ONE THE SERVICE HOLDS FOR THE COMPANY, BEFORE OPENING ANYTHING', async () => {
    /* RED WHEN: a link naming another label or another contract opens the company's records. */
    for (const link of [{ ...LINK, label: `co_${'d2'.repeat(32)}` as never }, { ...LINK, account: 'd0'.repeat(32) as never }, { ...LINK, id: 'c2' }]) {
      t.answers['/api/accounts/c2'] = account({ id: 'c2' });
      expect(await readReaderCompany(ACCOUNTANT, link)).toEqual({ of: READER_OF.refused, why: READER_REFUSED.notTheCompanys });
    }
    expect(t.proposalArgs).toEqual([]);
    /* RED WHEN: a company the service cannot answer for is shown as opened or as not the company's. */
    t.notFound = [ROUTE()];
    expect(await readReaderCompany(ACCOUNTANT, LINK)).toEqual({ of: READER_OF.refused, why: READER_REFUSED.unreached });
  });
});
