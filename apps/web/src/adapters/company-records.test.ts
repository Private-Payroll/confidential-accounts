// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bigintJsonReplacer, type Hex } from '../../../../src/core/crypto.js';
import { sealRecord } from '../../../../src/core/sealed-records.js';
import { SEED_ASSETS, StaticAssetRegistry } from '../../../../src/core/assets.js';

/*
 * A COMPANY'S RECORDS, OPENED AND READ THROUGH THE ADAPTER. The keyring and
 * the service are stood in for; the runs and proposals are sealed with the
 * record code the service uses and opened with the one the legacy application
 * uses, so what is opened here is what a real record opens to.
 */
const VK = '11'.repeat(32) as Hex;
const OTHER_VK = '22'.repeat(32) as Hex;
const NIGHT = SEED_ASSETS.find((a) => a.code === 'NIGHT')!;
const PRIVATE_ADDRESS = 'mn_shield-addr_preview1qqqq';
const PUBLIC_ADDRESS = 'mn_addr_preview1qqqq';
const kr = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>, asked: [] as string[], keys: true, canOpen: true, user: 'u1', opened: 0,
  account: { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }, { id: 's2', name: 'Sam' }] } as unknown,
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: kr.user }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  keysFor: () => (kr.keys ? { signerId: 's1' } : null),
  canOpenCompanies: () => kr.canOpen,
  reopenSavedKeys: async () => {},
  openAccount: () => kr.account,
  viewingKeyFor: () => VK,
  openKeysWithWallet: async () => { kr.opened += 1; },
  api: async (path: string) => {
    kr.asked.push(path);
    const a = kr.answers[path];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`the service has nothing at ${path}`);
    return JSON.parse(JSON.stringify(a, bigintJsonReplacer));
  },
}));

const ROUTE = (r = '') => `/api/accounts/c1${r}`;
const sealedRun = (id: string, period: string, status: string, employees: unknown[], extra: Record<string, unknown> = {}, key = VK) => ({
  id, accountId: 'c1', period, status, payslips: [], keyEpoch: 1, proposalIds: ['p1'],
  sealed: sealRecord('payroll', 'c1', { employees, totals: {}, proposalIds: { NIGHT: 'p1' } }, key), ...extra,
});
const sealedProposal = (id: string, status: string, secrets: Record<string, unknown>) => ({
  id, accountId: 'c1', status, createdAt: '2026-09-20T10:00:00.000Z', digest: 'dd', chainId: 'cc', approvalCount: 99, keyEpoch: 1,
  sealed: sealRecord('proposals', 'c1', { kind: 'payroll', summary: 'Pay the October run, a sentence the service wrote', proposedBy: 's2', approvals: [{ signerId: 's1' }], vault: 'v', ...secrets }, VK),
});

function everything() {
  kr.answers[ROUTE()] = { id: 'c1', threshold: 2, signerCount: 2, wrappedKeys: [] };
  kr.answers[ROUTE('/runs')] = [
    sealedRun('r1', '2026-10', 'draft', [
      { id: 'e1', name: 'Ana', asset: 'NIGHT', amount: 5_000_000n, paidTo: PRIVATE_ADDRESS },
      { id: 'e2', name: 'Bo', asset: 'NIGHT', amount: 2_000_000n, paidTo: PUBLIC_ADDRESS },
      { id: 'e3', name: 'Cy', asset: 'NIGHT', amount: 1_000_000n },
      { id: 'e4', name: 'Di', asset: 'ZZZ', amount: 7n, paidTo: PRIVATE_ADDRESS },
      { id: 'e5', name: 'Ed', asset: 'NIGHT', amount: 500_000n, paidTo: 'not an address' },
    ], { payout: { NIGHT: { vault: 'ab'.repeat(32), payees: 3n, leaves: ['01', '02', '03'] } } }),
    sealedRun('r0', '2026-09', 'settled', [{ id: 'e1', name: 'Ana', asset: 'NIGHT', amount: 5n, paidTo: PRIVATE_ADDRESS }], { settledAt: '2026-09-30T12:00:00.000Z' }),
  ];
  kr.answers[ROUTE('/proposals')] = [
    sealedProposal('p1', 'open', { approvalRound: { state: 'short', approvals: 1, threshold: 2 } }),
    sealedProposal('p2', 'executed', { kind: 'add-signer', proposedBy: 'gone' }),
  ];
  kr.answers[ROUTE(`/people?viewingKey=${VK}`)] = [
    { id: 'e1', name: 'Ana', title: 'Engineer', asset: 'NIGHT', baseAmount: 5_000_000n, startDate: '2026-01-01', status: 'active', address: { kind: 'shielded' }, handedOver: false },
    { id: 'e2', name: 'Bo', title: 'Designer', asset: 'NIGHT', baseAmount: 2_000_000n, startDate: '2026-02-01', status: 'active', address: { kind: 'unshielded' }, handedOver: false },
    { id: 'e5', name: 'Eve', title: 'Writer', asset: 'NIGHT', baseAmount: 1n, startDate: '2026-03-01', status: 'pending', address: null, handedOver: true },
    { id: 'e6', name: 'Fay', title: 'Writer', asset: 'NIGHT', baseAmount: 1n, startDate: '2026-03-01', status: 'pending', address: null, handedOver: false },
    { id: 'e7', name: 'Gus', title: 'Writer', asset: 'NIGHT', baseAmount: 1n, startDate: '2026-03-01', status: 'leaver', address: { kind: 'shielded' } },
  ];
  kr.answers[ROUTE('/vaults')] = { rows: [
    { vault: 'ab'.repeat(32), deployedAt: '2026-09-01T00:00:00.000Z', state: 'held-by-committee', why: 'a sentence the service wrote' },
    { vault: 'cd'.repeat(32), deployedAt: '2026-09-02T00:00:00.000Z', state: 'something new', why: null },
  ] };
  kr.answers[ROUTE('/invites')] = [
    { kind: 'signer', name: 'Tom', createdAt: '2026-09-10T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z' },
    { kind: 'employee', createdAt: '2026-09-11T00:00:00.000Z' },
    { kind: 'employee', name: 'Used', createdAt: '2026-09-11T00:00:00.000Z', acceptedAt: '2026-09-12T00:00:00.000Z' },
    { kind: 'employee', name: 'Gone', createdAt: '2026-09-11T00:00:00.000Z', revokedAt: '2026-09-12T00:00:00.000Z' },
    { kind: 'employee', name: 'Old', createdAt: '2020-09-11T00:00:00.000Z', expiresAt: '2020-10-11T00:00:00.000Z' },
  ];
}

/* The amount helpers of the same load as the adapter, since an amount is known only to the module that made it. */
let visibilityOf: typeof import('vaults-ui/format/token-amount').visibilityOf;
let formatTokenAmount: typeof import('vaults-ui/format/token-amount').formatTokenAmount;
let isAmount: (v: unknown) => boolean;
async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  const amounts = await import('vaults-ui/format/token-amount');
  ({ visibilityOf, formatTokenAmount } = amounts);
  isAmount = (v) => v instanceof amounts.PublicAmount || v instanceof amounts.PrivateAmount;
  return import('./company-records.js');
}

/** Every string in an answer, with where it is. */
function strings(value: unknown, at = 'answer'): string[] {
  if (isAmount(value)) return [];
  if (typeof value === 'string') return [`${at}=${value}`];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${at}[${i}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  return [];
}

beforeEach(() => { kr.answers = {}; kr.asked = []; kr.keys = true; kr.canOpen = true; kr.user = 'u1'; kr.opened = 0; everything(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('opening a company', () => {
  /* RED WHEN: the name or signers are not the opened record's, or how many must approve is not the service's public count. */
  it('opens the company with the keys saved for the person', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    expect(c.of).toBe('open');
    if (c.of !== 'open') return;
    expect([c.name, c.signers.map((s) => s.name), c.approvalsNeeded]).toEqual(['Northwind', ['Priya', 'Sam'], 2]);
  });

  /*
   * RED WHEN: a tab whose saved keys are not open is said to have no keys for
   * the company, or one whose keys are open and hold none for it is said to
   * be locked, so the person is sent to their account for nothing, or told the
   * company is elsewhere when one approval would open it; or a refusal is
   * handed on in the service's words.
   */
  it('says whether the keys are locked, not here, or refused, each apart', async () => {
    const { readCompany } = await load();
    kr.keys = false; kr.canOpen = false;
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'locked' });
    kr.canOpen = true;
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'no-keys-here' });
    kr.keys = true; kr.account = null;
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'no-keys-here' });
    kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }, { id: 's2', name: 'Sam' }] };
    kr.answers[ROUTE()] = new TypeError('fetch failed');
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'refused', why: 'unreachable' });
    kr.answers[ROUTE()] = new Error('a sentence the service wrote');
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'refused', why: 'did-not-finish' });
    kr.user = 'somebody else';
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'refused', why: 'not-signed-in' });
  });

  /* RED WHEN: opening the saved keys asks the account when this build does not know where it is, or a refusal is not handed on as a code. */
  it('opens the saved keys with the person\'s account, and says why when it cannot', async () => {
    const { openWithYourAccount } = await load();
    expect(await openWithYourAccount('u1')).toEqual({ of: 'done' });
    expect(kr.opened).toBe(1);
    vi.resetModules();
    vi.stubEnv('VITE_WALLET_ORIGIN', '');
    const bare = await import('./company-records.js');
    expect(await bare.openWithYourAccount('u1')).toEqual({ of: 'refused', why: 'not-set-up' });
    expect(kr.opened).toBe(1);
  });
});

describe('each read, on its own', () => {
  /* RED WHEN: one read that fails hides the reads that worked, or is handed on as nothing (an empty list) instead of unreadable. */
  it('hands on every read that worked beside one that did not', async () => {
    const { readCompany } = await load();
    kr.answers[ROUTE('/vaults')] = new Error('the chain could not be read');
    kr.answers[ROUTE(`/people?viewingKey=${VK}`)] = new TypeError('fetch failed');
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open') throw new Error('not open');
    expect([c.proposals.of, c.runs.of, c.people.of, c.vaults.of, c.invitations.of]).toEqual(['read', 'read', 'unreadable', 'unreadable', 'read']);
  });

  /* RED WHEN: a run or proposal sealed under another key is shown as read, which would be plausible rubbish; or the runs failing hides the proposals. */
  it('hands on runs sealed under another key as unreadable, and still reads the proposals', async () => {
    const { readCompany } = await load();
    kr.answers[ROUTE('/runs')] = [sealedRun('r9', '2026-10', 'draft', [], {}, OTHER_VK)];
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open') throw new Error('not open');
    expect([c.runs.of, c.proposals.of]).toEqual(['unreadable', 'read']);
  });

  /* RED WHEN: the viewing key is sent to the service on any read but the people's, which the service opens to answer. */
  it('sends the viewing key only to read the people', async () => {
    const { readCompany } = await load();
    await readCompany('u1', 'c1');
    expect(kr.asked.filter((p) => p.includes(VK))).toEqual([ROUTE(`/people?viewingKey=${VK}`)]);
    expect(kr.asked.some((p) => p.endsWith('/state') || p.includes('/state?'))).toBe(false);
  });

  /*
   * RED WHEN: anything the service or a record wrote in words (a proposal's
   * summary, a vault's why) reaches a screen, or a code is handed on that is
   * not one of its set. Every string handed on is an id, a date, a name a
   * person gave, a currency's code, or a code from a fixed set.
   */
  it('hands on codes, ids, dates and names, never the service\'s words', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    const all = strings(c);
    expect(all.filter((s) => /sentence|wrote/.test(s))).toEqual([]);
    expect(all.filter((s) => /\.(standing|paid|kind|status|of)=/.test(s)).map((s) => s.replace(/^.*=/, '')).sort().filter((v, i, a) => a.indexOf(v) === i)).toEqual([
      'active', 'add-signer', 'draft', 'employee', 'executed', 'held-by-committee', 'invited', 'leaver', 'not-known', 'not-set-up', 'open', 'payroll', 'privately', 'publicly', 'read', 'settled', 'signer', 'unknown', 'waiting-for-check',
    ]);
  });
});

describe('amounts, marked by how they are paid', () => {
  /*
   * RED WHEN: a payee with a private address is not marked private, one with a
   * public address, with none, or with an address of neither kind, is marked
   * private (a screen would then promise more privacy than the payment
   * delivers), or one not known is said to be paid publicly; a run's private and
   * public money are added into one figure; decimals are not the token's
   * record; or a currency the registry does not name is shown as a figure
   * instead of counted.
   */
  it('marks each run amount by the address it is paid to, and never adds private and public together', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.runs.of !== 'read') throw new Error('not read');
    const [next, paid] = c.runs.value;
    expect([next!.id, paid!.id]).toEqual(['r1', 'r0']);
    expect(next!.payees.map((p) => [p.name, p.paid, p.amount === null ? null : visibilityOf(p.amount)])).toEqual([
      ['Ana', 'privately', 'private'], ['Bo', 'publicly', 'public'], ['Cy', 'not-known', 'public'], ['Di', 'privately', null], ['Ed', 'not-known', 'public'],
    ]);
    const night = next!.currencies.find((x) => x.code === 'NIGHT')!;
    expect([visibilityOf(night.privately!), formatTokenAmount(night.privately!, 'en')]).toEqual(['private', '5.000000']);
    expect([visibilityOf(night.publicly!), formatTokenAmount(night.publicly!, 'en')]).toEqual(['public', '3.500000']);
    expect(next!.currencies.map((x) => x.code)).toEqual(['NIGHT']);
    expect(next!.unrecognised).toBe(1);
    expect(next!.legs).toEqual([{ code: 'NIGHT', vault: 'ab'.repeat(32), payees: 3 }]);
    expect([paid!.status, paid!.settledAt]).toEqual(['settled', '2026-09-30T12:00:00.000Z']);
    expect(paid!.currencies[0]!.publicly).toBeNull();
  });

  /* RED WHEN: a person's pay is marked private without a private address, or where each stands is not the service's (waiting on us, waiting on them, active, left). */
  it('marks a person\'s pay by their address, and says where each stands', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.people.of !== 'read') throw new Error('not read');
    expect(c.people.value.map((p) => [p.name, p.standing, p.paid, p.pay === null ? null : visibilityOf(p.pay)])).toEqual([
      ['Ana', 'active', 'privately', 'private'], ['Bo', 'active', 'publicly', 'public'], ['Eve', 'waiting-for-check', 'not-set-up', 'public'],
      ['Fay', 'invited', 'not-set-up', 'public'], ['Gus', 'leaver', 'privately', 'private'],
    ]);
  });

  /* RED WHEN: decimals are written in the adapter instead of read from the registry it is given. */
  it('reads decimals from the registry', async () => {
    const { runRow } = await load();
    const registry = new StaticAssetRegistry([...SEED_ASSETS.filter((a) => a.code !== 'NIGHT'), { ...NIGHT, decimals: 2 }]);
    const row = runRow({ id: 'r', period: '2026-10', status: 'draft', employees: [{ id: 'e', name: 'A', asset: 'NIGHT', amount: 150n, paidTo: PRIVATE_ADDRESS }] } as never, registry);
    expect(formatTokenAmount(row.currencies[0]!.privately!, 'en')).toBe('1.50');
  });
});

describe('proposals, vaults and invitations', () => {
  /*
   * RED WHEN: how many must approve is guessed when the record does not say
   * (the company's count is not a vault's), the approvals are the service's
   * outer count instead of the opened record's, a payment of a run is not tied
   * to its run and currency, or a proposal raised by a seat the record no
   * longer names is put on somebody else.
   */
  it('reads each proposal from its opened record', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
    expect(c.proposals.value.map((p) => [p.id, p.kind, p.status, p.raisedBy, p.approvals, p.needed, p.pays])).toEqual([
      ['p1', 'payroll', 'open', 'Sam', 1, 2, { run: 'r1', period: '2026-10', currency: 'NIGHT' }],
      ['p2', 'add-signer', 'executed', null, 1, null, null],
    ]);
  });

  /* RED WHEN: a vault standing the service names that is not in the set is handed on as it came, or the service's words about it are. */
  it('reads each vault, a standing not in the set as unknown', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.vaults.of !== 'read') throw new Error('not read');
    expect(c.vaults.value).toEqual([
      { vault: 'ab'.repeat(32), createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' },
      { vault: 'cd'.repeat(32), createdAt: '2026-09-02T00:00:00.000Z', standing: 'unknown' },
    ]);
  });

  /* RED WHEN: a link used, withdrawn or expired is listed as waiting to be used, or one that names nobody is given a name. */
  it('lists only the links still waiting to be used', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.invitations.of !== 'read') throw new Error('not read');
    expect(c.invitations.value.map((i) => [i.kind, i.name])).toEqual([['signer', 'Tom'], ['employee', null]]);
  });

  /* RED WHEN: a vault's public money is read from anywhere but that vault's view, or a failure is handed on as nothing held. */
  it('reads a vault\'s public money from its view, when asked', async () => {
    const { readVaultPublicMoney } = await load();
    const token = NIGHT.ledger.unshielded!;
    kr.answers[ROUTE(`/vaults/${'ab'.repeat(32)}/chain`)] = { onChain: true, publicBalances: [{ token, amount: '4000000' }] };
    const held = await readVaultPublicMoney('u1', 'c1', 'ab'.repeat(32));
    expect([held?.amounts.map((a) => formatTokenAmount(a, 'en')), held?.unrecognised]).toEqual([['4.000000'], 0]);
    expect(await readVaultPublicMoney('u1', 'c1', 'cd'.repeat(32))).toBeNull();
  });
});

describe('the names in the one list of companies', () => {
  /* RED WHEN: names are read from a second list of companies asked of the service, or handed on for a list read for somebody else. */
  it('opens the names of the one list read when the person signed in, and asks the service nothing more', async () => {
    vi.resetModules();
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      fetched.push(path);
      return new Response(JSON.stringify({ user: { id: 'u1', name: 'Priya' }, accounts: [{ id: 'c1', createdAt: 'x', signerCount: 1, threshold: 1 }] }), { status: 200 });
    }));
    const session = await import('./session.js');
    expect((await session.companyNamesFor('u1')).size).toBe(0);
    await session.whoIsSignedIn();
    expect([...(await session.companyNamesFor('u1')).entries()]).toEqual([['c1', 'Northwind']]);
    expect([...(await session.companyNamesFor('somebody else')).entries()]).toEqual([]);
    /* No second list of companies is asked for: the names are the one list's. */
    expect(fetched.filter((p) => p.startsWith('/api/accounts'))).toEqual([]);
    vi.unstubAllGlobals();
  });
});
