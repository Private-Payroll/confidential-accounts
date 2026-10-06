// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bigintJsonReplacer, type Hex } from '../../../../src/core/crypto.js';
import { sealRecord } from '../../../../src/core/sealed-records.js';
import { sealPerson } from '../../../../src/core/person-record.js';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { toCompanyWire } from '../../../../src/midnight/sealed-record-wire.js';
import { SEED_ASSETS, StaticAssetRegistry } from '../../../../src/core/assets.js';

/*
 * A COMPANY'S RECORDS, OPENED AND READ THROUGH THE ADAPTER. The keyring and
 * the service are stood in for; the runs and proposals are sealed with the
 * record code the service uses and opened with the one the legacy application
 * uses, so what is opened here is what a real record opens to. The people
 * are person records sealed with the code a seat's device seals them with.
 */
const VK = '11'.repeat(32) as Hex;
const OTHER_VK = '22'.repeat(32) as Hex;
const NIGHT = SEED_ASSETS.find((a) => a.symbol === 'NIGHT')!;
/** The public leg of a run paying NIGHT, as the record keys it. */
const NIGHT_PUBLICLY = `${NIGHT.code}:unshielded`;
const PRIVATE_ADDRESS = 'mn_shield-addr_preview1qqqq';
const PUBLIC_ADDRESS = 'mn_addr_preview1qqqq';
const kr = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>, asked: [] as string[], keys: true, canOpen: true, user: 'u1', opened: 0, seat: false,
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
  /* A seat this device left unfinished: finishing it is what gives this device the company's keys. */
  pendingSeatsFor: () => (kr.seat ? [{ accountId: 'c1' }] : []),
  finishPendingSeat: async () => { if (!kr.seat) return false; kr.seat = false; kr.keys = true; return true; },
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
  sealed: sealRecord('payroll', 'c1', { employees, totals: {}, proposalIds: { [NIGHT_PUBLICLY]: 'p1' } }, key), ...extra,
});
/** The company's label, as its record names it: every payee's code is signed for it. */
const LABEL = `co_${'c1'.repeat(32)}`;
/** What makes a person payable: an address of `kind` their own wallet (numbered `n`) signed in a code, with their payslip key, kept in their record. */
const payable = (n: number, kind: 'shielded' | 'unshielded', label = LABEL) => {
  const bech32 = kind === 'shielded' ? `mn_shield-addr_test1${'q'.repeat(59)}${n}` : `mn_addr_test1${'q'.repeat(59)}${n}`;
  const payslipKey = n.toString(16).padStart(2, '0').repeat(32);
  const payeeCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), label as never, `usr_${n}`, { kind: 'payee', address: bech32, payslipKey });
  return { address: { kind, bech32 }, wrappingPublicKey: payslipKey, handedOverBy: payeeCode.committeeKey.value, payeeCode };
};
/** A person as the people read answers: their newest record on the wire, and whether a hand-over waits. */
const filedPerson = (p: Record<string, unknown>, handedOver?: boolean, key = VK, company = 'c1') => ({
  filed: toCompanyWire(sealPerson({ accountId: company, email: null, wrappingPublicKey: null, handedOverBy: null, ...p } as never, 1, 1, key)),
  ...(handedOver === undefined ? {} : { handedOver }),
});
const sealedProposal = (id: string, status: string, secrets: Record<string, unknown>) => ({
  id, accountId: 'c1', status, createdAt: '2026-09-20T10:00:00.000Z', digest: 'dd', chainId: 'cc', approvalCount: 99, keyEpoch: 1,
  sealed: sealRecord('proposals', 'c1', { kind: 'payroll', summary: 'Pay the October run, a sentence the service wrote', proposedBy: 's2', approvals: [{ signerId: 's1' }], vault: 'v', ...secrets }, VK),
});

function everything() {
  kr.answers[ROUTE()] = { id: 'c1', threshold: 2, signerCount: 2, wrappedKeys: [], companyLabel: LABEL };
  kr.answers[ROUTE('/runs')] = [
    sealedRun('r1', '2026-10', 'draft', [
      { id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5_000_000n, paidTo: PRIVATE_ADDRESS },
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 2_000_000n, paidTo: PUBLIC_ADDRESS },
      { id: 'e3', name: 'Cy', asset: NIGHT.code, amount: 1_000_000n },
      { id: 'e4', name: 'Di', asset: 'f0'.repeat(32), amount: 7n, paidTo: PRIVATE_ADDRESS },
      { id: 'e5', name: 'Ed', asset: NIGHT.code, amount: 500_000n, paidTo: 'not an address' },
    ], { payout: { [NIGHT_PUBLICLY]: { vault: 'ab'.repeat(32), payees: 3n, leaves: ['01', '02', '03'] } } }),
    sealedRun('r0', '2026-09', 'settled', [{ id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5n, paidTo: PRIVATE_ADDRESS }], { settledAt: '2026-09-30T12:00:00.000Z' }),
  ];
  kr.answers[ROUTE('/proposals')] = [
    sealedProposal('p1', 'open', { approvalRound: { state: 'short', approvals: 1, threshold: 2 } }),
    sealedProposal('p2', 'executed', { kind: 'add-signer', proposedBy: 'gone' }),
  ];
  kr.answers[ROUTE('/people')] = { people: [
    filedPerson({ id: 'e2', name: 'Bo', title: 'Designer', asset: NIGHT.code, baseAmount: 2_000_000n, startDate: '2026-02-01', status: 'active', ...payable(2, 'unshielded') }, false),
    filedPerson({ id: 'e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 5_000_000n, startDate: '2026-01-01', status: 'active', ...payable(1, 'shielded') }, false),
    filedPerson({ id: 'e5', name: 'Eve', title: 'Writer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-03-01', status: 'pending', address: null }, true),
    filedPerson({ id: 'e6', name: 'Fay', title: 'Writer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-03-01', status: 'pending', address: null }, false),
    filedPerson({ id: 'e7', name: 'Gus', title: 'Writer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-03-01', status: 'leaver', address: { kind: 'shielded' } }),
  ] };
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
    /* RED WHEN: a seat this device left unfinished is not finished on the way in, so the one device holding the company's keys is told they are elsewhere. */
    kr.canOpen = true; kr.seat = true;
    expect((await readCompany('u1', 'c1')).of).toBe('open');
    kr.keys = false; kr.canOpen = false;
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
    kr.answers[ROUTE('/people')] = new TypeError('fetch failed');
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

  /* RED WHEN: the viewing key is sent to the service on any read - the people's included, which used to carry it in its address. */
  it('sends the viewing key on no read', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open') throw new Error('not open');
    expect(c.people.of).toBe('read');
    expect(kr.asked.filter((p) => p.includes(VK))).toEqual([]);
    expect(kr.asked.some((p) => p.endsWith('/state') || p.includes('/state?'))).toBe(false);
  });

  /* RED WHEN: an active person is shown as paid at an address, or with a payslip key, their own wallet did not sign, or with no code at all. */
  it('hands on the people as unreadable when an active person is not payable at what their own wallet signed', async () => {
    const { readCompany } = await load();
    const ana = { id: 'e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'active' };
    const good = payable(1, 'shielded');
    for (const [what, p] of [
      ['another address', { ...ana, ...good, address: { kind: 'shielded', bech32: payable(3, 'shielded').address.bech32 } }],
      ['another payslip key', { ...ana, ...good, wrappingPublicKey: 'ee'.repeat(32) }],
      ['no code', { ...ana, ...good, payeeCode: null }],
      ['a code changed after it was signed', { ...ana, ...good, payeeCode: { ...good.payeeCode, person: 'usr_mallory' } }],
      ['a code for another company', { ...ana, ...payable(1, 'shielded', `co_${'c2'.repeat(32)}`) }],
    ] as const) {
      kr.answers[ROUTE('/people')] = { people: [filedPerson(p, false)] };
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open') throw new Error('not open');
      expect(c.people.of, what).toBe('unreadable');
    }
    kr.answers[ROUTE('/people')] = { people: [filedPerson({ ...ana, ...good }, false)] };
    const c = await readCompany('u1', 'c1');
    expect(c.of === 'open' && c.people.of).toBe('read');
  });

  /* RED WHEN: a person record sealed under another key, or filed for another company, is shown as a person rather than the people being handed on unreadable. */
  it('hands on the people as unreadable when a record is not this company\'s or will not open', async () => {
    const { readCompany } = await load();
    const ana = { id: 'e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'pending', address: null };
    for (const wrong of [filedPerson(ana, false, OTHER_VK), filedPerson(ana, false, VK, 'c2')]) {
      kr.answers[ROUTE('/people')] = { people: [wrong] };
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open') throw new Error('not open');
      expect([c.people.of, c.runs.of]).toEqual(['unreadable', 'read']);
    }
  });

  /*
   * RED WHEN: anything the service or a record wrote in words (a proposal's
   * summary, a vault's why) reaches a screen, or a code is handed on that is
   * not one of its set. Every string handed on is an id, a date, a name a
   * person gave, a token or its symbol, or a code from a fixed set.
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
   * record; or a token the registry does not name is shown as a figure
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
    const night = next!.currencies.find((x) => x.symbol === 'NIGHT')!;
    expect([visibilityOf(night.privately!), formatTokenAmount(night.privately!, 'en')]).toEqual(['private', '5']);
    expect([visibilityOf(night.publicly!), formatTokenAmount(night.publicly!, 'en')]).toEqual(['public', '3.5']);
    expect(next!.currencies.map((x) => [x.code, x.symbol])).toEqual([[NIGHT.code, 'NIGHT']]);
    expect(next!.unrecognised).toBe(1);
    /* RED WHEN a leg is named to a screen by its token rather than its symbol, or is not said to pay the form its key names. */
    /* RED WHEN a leg's token is not the token its key names, so a run's page would hang one token's approvals on another. */
    expect(next!.legs).toEqual([{ code: NIGHT_PUBLICLY, asset: NIGHT.code, symbol: 'NIGHT', paid: 'publicly', vault: 'ab'.repeat(32), payees: 3 }]);
    expect([paid!.status, paid!.settledAt]).toEqual(['settled', '2026-09-30T12:00:00.000Z']);
    expect(paid!.currencies[0]!.publicly).toBeNull();
  });

  /* RED WHEN: a person's pay is marked private without a private address, where each stands is not their record's (waiting on us, waiting on them, active, left), or they are not listed by name. */
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
    const registry = new StaticAssetRegistry([...SEED_ASSETS.filter((a) => a.symbol !== 'NIGHT'), { ...NIGHT, decimals: 2 }]);
    const row = runRow({ id: 'r', period: '2026-10', status: 'draft', employees: [{ id: 'e', name: 'A', asset: NIGHT.code, amount: 150n, paidTo: PRIVATE_ADDRESS }] } as never, registry);
    expect(formatTokenAmount(row.currencies[0]!.privately!, 'en')).toBe('1.5');
  });
});

describe('proposals, vaults and invitations', () => {
  /*
   * RED WHEN: how many must approve is guessed when the record does not say
   * (the company's count is not a vault's), the approvals are the service's
   * outer count instead of the opened record's, a payment of a run is not tied
   * to its run, token and form, or a proposal raised by a seat the record no
   * longer names is put on somebody else.
   */
  it('reads each proposal from its opened record', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
    expect(c.proposals.value.map((p) => [p.id, p.kind, p.status, p.raisedBy, p.approvals, p.needed, p.pays])).toEqual([
      /* RED WHEN a payroll round is not tied to the token and the form its leg pays, or names its token to a screen by anything but its symbol. */
      ['p1', 'payroll', 'open', 'Sam', 1, 2, { run: 'r1', period: '2026-10', asset: NIGHT.code, symbol: 'NIGHT', paid: 'publicly' }],
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
    expect([held?.amounts.map((a) => formatTokenAmount(a, 'en')), held?.unrecognised]).toEqual([['4'], 0]);
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
