// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealRecord, type Purpose } from '../../../../src/core/sealed-records.js';

/*
 * A READER'S PAGE READS THE COMPANY THROUGH ONE VIEW AN OPENING, with the page's own readers: the runs, the proposals
 * with the directory they are judged by, and the chain at the indexer the reader's wallet named. Only the service, the
 * reader's wallet and the vault worker are stood in for. The wallet is asked who holds the company once for the opening,
 * and every judge of the view reads its own company only.
 */
const t = vi.hoisted(() => ({ paths: [] as string[], walletAsked: 0, builderAsked: [] as string[] }));
vi.mock('vaults-web-shared/service-transport.js', async (real) => (await import('./service-in-memory.test-support.js')).withTheView({
  ...(await real<typeof import('vaults-web-shared/service-transport.js')>()),
  api: async (path: string) => {
    t.paths.push(path);
    const answer = ANSWERS()[path];
    if (answer === undefined) throw new Error(`no answer for ${path}`);
    return answer;
  },
}));
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async () => {
    t.walletAsked += 1;
    return { holders: { committee: [], threshold: 1, seats: [], approvals: 1, adoptedVaults: [], vaultThresholds: [], policyBar: null }, indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' } };
  },
}));
/* The vault worker answers nothing here: every read that needs it fails on its own, and is said as unreadable. */
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => new Proxy({}, { get: (_o, ask) => (ask === 'then' ? undefined : async () => { t.builderAsked.push(String(ask)); throw new Error('the vault worker is stood in for'); }) }),
}));

const { readReaderCompany, READER_OF } = await import('./reader-records.js');
const { readerJudgesOf } = await import('./reader-judge.js');
const { openViewOf } = await import('./filing-judge.js');
type Held = import('vaults-web-shared/purpose-wraps.js').PurposeWrapsHeld;
const { purposeKeysAt } = await import('vaults-web-shared/purpose-wraps.js');

const KEY = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const LABEL = `co_${'c1'.repeat(32)}` as never;
const ADDRESS = 'c0'.repeat(32) as never;
const HELD: Held = Object.freeze({
  kind: 'purpose-wraps' as const, accountId: 'c1', unopened: [],
  byEpoch: new Map([[1, new Map(Object.entries({ payroll: KEY(1), proposals: KEY(2), roster: KEY(3) }) as [Purpose, string][])]]),
}) as Held;
const LINK = { id: 'c1', label: LABEL, account: ADDRESS };
const ROUTE = (r = '') => `/api/accounts/c1${r}`;
function ANSWERS(): Record<string, unknown> {
  const keys = purposeKeysAt(HELD, 1);
  return {
    [ROUTE()]: { id: 'c1', companyLabel: LABEL, contractAddress: ADDRESS },
    [ROUTE('/directory')]: { filings: [] },
    [ROUTE('/runs')]: [{
      id: 'r1', accountId: 'c1', period: '2026-10', status: 'draft', payslips: [], keyEpoch: 1,
      sealed: sealRecord('payroll', 'c1', { employees: [], totals: {}, proposalIds: {} }, keys),
    }],
    [ROUTE('/proposals')]: [{ id: 'p1', accountId: 'c1', kind: 'payroll', keyEpoch: 1, sealed: sealRecord('proposals', 'c1', { id: 'p1' }, keys) }],
  };
}

beforeEach(() => { t.paths = []; t.walletAsked = 0; t.builderAsked = []; });

describe('a reader\'s page reads the company through one view an opening', () => {
  /* RED WHEN: the reader's page reads the company apart from one view of it, so its wallet is asked who holds the company again for the directory, the chain or the proposals. */
  it('asks the reader\'s wallet once, and reads the account and each list once, with the page\'s own readers', async () => {
    const read = await readReaderCompany(HELD, LINK);
    expect(read.of).toBe(READER_OF.open);
    expect(t.walletAsked).toBe(1);
    expect([ROUTE(), ROUTE('/runs'), ROUTE('/proposals')].map((p) => t.paths.filter((x) => x === p).length)).toEqual([1, 1, 1]);
    /* The proposals were judged: the directory they are judged by was read, through the same view. */
    expect(t.paths.filter((x) => x === ROUTE('/directory'))).toHaveLength(1);
    const again = await readReaderCompany(HELD, LINK);
    expect(again.of).toBe(READER_OF.open);
    /* RED WHEN: a second opening is answered from the first one's reads. */
    expect(t.walletAsked).toBe(2);
  });
});

describe('the reader\'s judges', () => {
  /* RED WHEN: a judge of the reader's view, asked about another company, reads that company through this view. */
  it('refuse a read of another company through the reader\'s view, before anything is read', async () => {
    const view = openViewOf('c1');
    await expect(readerJudgesOf(view).anchoredForAReader('acc_other', LABEL, ADDRESS)({} as never, {})).rejects.toThrow(/web-21-judge-asked-another-company/u);
    expect([t.paths, t.walletAsked]).toEqual([[], 0]);
    view.end('the test is done');
  });
});
