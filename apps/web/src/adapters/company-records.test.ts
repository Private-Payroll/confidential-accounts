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
  /* The indexer the person's own wallet names, and each vault the page's vault worker read there. */
  indexer: null as { indexerUri: string; indexerWsUri: string } | null,
  vaults: {} as Record<string, unknown>,
  readHere: [] as string[],
  /* The vaults the company's account has adopted, as the wallet reads the chain. */
  adopted: [] as string[],
  /* The approvals the company's account asks for, as the wallet reads the chain; undefined when the wallet cannot say. */
  approvals: 2 as number | undefined,
  /* The name the person gave each company this device holds a creation of (kept or set aside), by company. */
  kept: {} as Record<string, string>,
  /* Each company this page entered and started the one-a-day anchor for, with the keys it was handed. */
  anchoring: [] as Array<{ company: string; signerId: string }>,
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    vaultOnChain: async (i: { vault: string; indexer: { indexerUri: string } }) => {
      kr.readHere.push(`${i.vault} at ${i.indexer.indexerUri}`);
      const v = kr.vaults[i.vault];
      if (v === undefined) throw new Error('the indexer holds nothing for that vault');
      return v;
    },
  }),
}));
/* The one-a-day anchor as entering a company starts it: recorded, and never finished, so a read that waited on it would never answer. */
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  /* The company's keys as its directory gives them (`companyKeysFor`), stood in for by the one key of a company never changed. */
  filingJudgeFor: () => async () => null,
  companyKeysFor: async () => ({ epoch: 0, newest: 0, key: VK, keyAt: () => VK, sealing: () => ({ key: VK, epoch: 0 }) }),
  anchoredOnTheWayInFor: (sealed: { id: string }, keys: { signerId: string }) => {
    kr.anchoring.push({ company: sealed.id, signerId: keys.signerId });
    return new Promise(() => undefined);
  },
}));
/* The name a vault was filed under, as this device reads it: what the read answers, and what it was asked with. */
const info = vi.hoisted(() => ({ answer: { state: 'none' } as unknown, asked: [] as Array<{ vault: string; keys: unknown; account: string }>, fails: false }));
vi.mock('vaults-web-shared/vault-info-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-info-here.js')>()),
  vaultInfoRecordsFor: (account: string) => ({ account }),
  vaultInfoHere: async (doors: { companyKeys: unknown; records: { account: string } }, vault: string) => {
    info.asked.push({ vault, keys: doors.companyKeys, account: doors.records.account });
    if (info.fails) throw new Error('the records could not be read');
    return info.answer;
  },
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: kr.user }),
  companyNameKeptHere: (id: string) => kr.kept[id] ?? null,
  companiesBeingCreated: () => Object.keys(kr.kept),
  forgetLocally: () => {},
  resumeSession: async () => null,
  keysFor: () => (kr.keys ? { signerId: 's1' } : null),
  canOpenCompanies: () => kr.canOpen,
  reopenSavedKeys: async () => {},
  /* A seat this device left unfinished: finishing it is what gives this device the company's keys. */
  pendingSeatsFor: () => (kr.seat ? [{ accountId: 'c1' }] : []),
  finishPendingSeat: async () => { if (!kr.seat) return false; kr.seat = false; kr.keys = true; return true; },
  openAccount: () => {
    if (kr.account instanceof Error) throw kr.account;
    return kr.account;
  },
  viewingKeyFor: () => VK,
  openKeysWithWallet: async () => { kr.opened += 1; },
  /* Who holds the company, as the person's own wallet reads it with no press: the vaults its account has adopted, and its indexer. */
  /* `threshold` on this answer is the account's maintenance committee's, never the approvals the account asks for. */
  holdersFromTheWallet: async () => ({ holders: { adoptedVaults: kr.adopted, threshold: 1, ...(kr.approvals === undefined ? {} : { approvals: kr.approvals }) }, indexer: kr.indexer }),
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
  kr.answers[ROUTE()] = { id: 'c1', threshold: 2, signerCount: 2, wrappedKeys: [], companyLabel: LABEL, contractAddress: 'c0'.repeat(32) };
  kr.adopted = ['ab'.repeat(32), 'cd'.repeat(32)];
  kr.approvals = 2;
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

beforeEach(() => { info.answer = { state: 'none' }; info.asked = []; info.fails = false; kr.anchoring = []; kr.answers = {}; kr.asked = []; kr.keys = true; kr.canOpen = true; kr.user = 'u1'; kr.opened = 0; everything(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('opening a company', () => {
  /* RED WHEN: the name or signers are not the opened record's, or how many must approve is not what the wallet read off the chain. */
  it('opens the company with the keys saved for the person', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    expect(c.of).toBe('open');
    if (c.of !== 'open') return;
    expect([c.name, c.signers.map((s) => s.name), c.approvalsNeeded]).toEqual(['Northwind', ['Priya', 'Sam'], { of: 'read', value: 2 }]);
  });

  /* RED WHEN: how many must approve is read off the service's record (which says 2 here), or off the wallet's committee threshold (1), or something is shown when the wallet could not say. */
  it('says how many must approve as the wallet read it off the chain, and nothing when the wallet cannot say', async () => {
    const { readCompany } = await load();
    kr.approvals = 3;
    const read = await readCompany('u1', 'c1');
    expect(read.of === 'open' && read.approvalsNeeded).toEqual({ of: 'read', value: 3 });
    kr.approvals = undefined;
    const unsaid = await readCompany('u1', 'c1');
    expect(unsaid.of === 'open' && unsaid.approvalsNeeded).toEqual({ of: 'unreadable' });
  });

  it('ENTERING THE COMPANY STARTS THE ONE-A-DAY ANCHOR WITH THIS SEAT\'S OWN KEYS, AND THE READ DOES NOT WAIT ON IT', async () => {
    const { readCompany } = await load();
    /* RED WHEN: the read waits on the anchor's proof, or entering the company starts no anchor, so between raises nothing is ever anchored. */
    expect((await readCompany('u1', 'c1')).of).toBe('open');
    expect(kr.anchoring).toEqual([{ company: 'c1', signerId: 's1' }]);
    kr.anchoring = []; kr.keys = false; kr.canOpen = false;
    /* RED WHEN: a device with no keys for the company starts an anchor it cannot sign. */
    expect(await readCompany('u1', 'c1')).toEqual({ of: 'locked' });
    expect(kr.anchoring).toEqual([]);
  });

  /*
   * RED WHEN: a tab whose saved keys are not open is said to have no keys for
   * the company, or one whose keys are open and hold none for it is said to
   * be locked, so the person is sent to their account for nothing, or told the
   * company is elsewhere when one approval would open it; or a refusal is
   * handed on in the service's words.
   */
  /* RED WHEN: a company whose roster this device does not believe is told "it did not finish", so nobody learns why it will not open. */
  it('says a roster this device does not believe as that', async () => {
    const { readCompany } = await load();
    const { RosterNotBelieved } = await import('vaults-web-shared/roster-here.js');
    const was = kr.account;
    kr.account = new RosterNotBelieved('This device does not believe the company\'s roster it was given (x).');
    try {
      expect(await readCompany('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-not-believed' });
    } finally {
      kr.account = was;
    }
  });

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

  /*
   * RED WHEN: a proposal raised by a signer whose roster entry this device does not believe is said to be raised by a
   * signer no longer listed, so the screen hides why; or a raiser the roster truly does not name is given a reason.
   */
  it('names a raiser whose entry this device does not believe, and why, apart from one the roster does not name', async () => {
    const { readCompany } = await load();
    const was = kr.account;
    kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], refused: [{ signerId: 's2', name: 'Sam', why: 'seat-not-on-the-chain' }] };
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      expect(c.proposals.value.map((p) => [p.id, p.raisedBy, p.raiserNotBelieved])).toEqual([['p1', 'Sam', 'seat-not-on-the-chain'], ['p2', null, null]]);
      kr.account = { ...(kr.account as object), refused: [{ signerId: 's2', name: 'Sam', why: 'no-entry-of-their-own' }] };
      const opened = await readCompany('u1', 'c1');
      if (opened.of !== 'open' || opened.proposals.of !== 'read') throw new Error('not read');
      expect(opened.proposals.value[0]!.raiserNotBelieved).toBe('no-entry-of-their-own');
      kr.account = { ...(kr.account as object), refused: [{ signerId: 's2', name: 'Sam', why: 'not-their-signing-key' }] };
      const signed = await readCompany('u1', 'c1');
      if (signed.of !== 'open' || signed.proposals.of !== 'read') throw new Error('not read');
      expect(signed.proposals.value[0]!.raiserNotBelieved).toBe('not-their-signing-key');
      /* RED WHEN: the name in a roster entry this device refused as not what its wallet signed is shown as who raised it. */
      expect(signed.proposals.value[0]!.raisedBy).toBeNull();
    } finally {
      kr.account = was;
    }
  });

  /* RED WHEN: a vault's name that could not be read is told apart from none filed only when asked, or not at all. */
  it('tells a vault name that could not be read apart from none filed, when asked to', async () => {
    const m = await load();
    const readVaultName = m.readVaultName;
    info.answer = { state: 'none' };
    expect(await readVaultName('u1', 'c1', 'v', m.NAME_NOT_READ)).toBeNull();
    info.answer = { state: 'unread', why: 'the record could not be opened', version: 1 };
    expect(await readVaultName('u1', 'c1', 'v', m.NAME_NOT_READ)).toBe(m.NAME_NOT_READ);
    expect(await readVaultName('u1', 'c1', 'v')).toBeNull();
    info.fails = true;
    expect(await readVaultName('u1', 'c1', 'v', m.NAME_NOT_READ)).toBe(m.NAME_NOT_READ);
    info.fails = false;
    info.answer = { state: 'named', name: 'Payroll', description: '', version: 1 };
    expect(await readVaultName('u1', 'c1', 'v', m.NAME_NOT_READ)).toBe('Payroll');
    info.answer = { state: 'none' };
  });

  /* RED WHEN: a vault standing the service names that is not in the set is handed on as it came, or the service's words about it are. */
  it('reads each vault, a standing not in the set as unknown', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.vaults.of !== 'read') throw new Error('not read');
    expect(c.vaults.value).toEqual([
      { vault: 'ab'.repeat(32), createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee', adopted: true },
      { vault: 'cd'.repeat(32), createdAt: '2026-09-02T00:00:00.000Z', standing: 'unknown', adopted: true },
    ]);
  });

  /*
   * RED WHEN: the vault list is the service's rather than the vaults the account adopted as the person's own wallet reads
   * the chain: a vault the service leaves out goes unnoticed, or a vault it lists that the account never adopted is shown
   * as the company's; or a vault the service names with a standing no service gives any more is listed as the company's.
   */
  it('lists the vaults the account adopted on the chain, notices one the service leaves out, and shows no vault the account never adopted', async () => {
    const { readCompany } = await load();
    const rows = (kr.answers[ROUTE('/vaults')] as { rows: unknown[] }).rows;
    kr.answers[ROUTE('/vaults')] = { rows: [...rows,
      { vault: 'ee'.repeat(32), deployedAt: '2026-09-03T00:00:00.000Z', state: 'held-by-committee' },
      { vault: 'ef'.repeat(32), deployedAt: '2026-09-04T00:00:00.000Z', state: 'start-owed' },
      { vault: 'e1'.repeat(32), deployedAt: '2026-09-05T00:00:00.000Z', state: 'handover-owed' },
    ] };
    const listed = await readCompany('u1', 'c1');
    if (listed.of !== 'open' || listed.vaults.of !== 'read') throw new Error('not read');
    /* A vault the service calls the company's that the account never adopted is not listed; one whose set-up is not finished is, as not finished. */
    expect(listed.vaults.value.map((v) => [v.vault.slice(0, 2), v.standing])).toEqual([['ab', 'held-by-committee'], ['cd', 'unknown'], ['ef', 'start-owed']]);
    /* Only a vault the account adopted is marked so: the one waiting to be set up is listed, not marked. */
    expect(listed.vaults.value.map((v) => v.adopted === true)).toEqual([true, true, false]);
    /* The service leaves out a vault the account holds: the list is unreadable, never shown one short. */
    kr.adopted = ['ab'.repeat(32), 'cd'.repeat(32), 'aa'.repeat(32)];
    const short = await readCompany('u1', 'c1');
    expect(short.of === 'open' && short.vaults.of).toBe('unreadable');
  });

  /*
   * RED WHEN: a vault's name is read from anywhere but the company's own filed record of it, opened on this device; a
   * vault with no name, an unreadable one or a blank one is handed on as a name; a read that fails is thrown at the
   * page; or a name is read for a person who is not signed in.
   */
  it('reads a vault\'s name from its filed record on this device, and gives none when there is none to give', async () => {
    const { readVaultName } = await load();
    const vault = 'ab'.repeat(32);
    info.answer = { state: 'named', name: 'Treasury', description: 'The reserve', version: 2 };
    expect(await readVaultName('u1', 'c1', vault)).toBe('Treasury');
    expect(info.asked).toEqual([{ vault, keys: expect.objectContaining({ key: VK }), account: 'c1' }]);
    for (const answer of [{ state: 'none' }, { state: 'unread', why: 'not believed', version: 3 }, { state: 'named', name: '  ', description: '', version: 1 }]) {
      info.answer = answer;
      expect(await readVaultName('u1', 'c1', vault), JSON.stringify(answer)).toBeNull();
    }
    info.fails = true;
    expect(await readVaultName('u1', 'c1', vault)).toBeNull();
    info.fails = false;
    info.answer = { state: 'named', name: 'Treasury', description: '', version: 1 };
    info.asked = [];
    expect(await readVaultName('u2', 'c1', vault)).toBeNull();
    expect(info.asked).toEqual([]);
  });

  /* RED WHEN: a link used, withdrawn or expired is listed as waiting to be used, or one that names nobody is given a name. */
  it('lists only the links still waiting to be used', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.invitations.of !== 'read') throw new Error('not read');
    expect(c.invitations.value.map((i) => [i.kind, i.name])).toEqual([['signer', 'Tom'], ['employee', null]]);
  });

  /*
   * RED WHEN: a vault's public money is read from anywhere but this device's own read of that vault, at the indexer the
   * person's own wallet names; or a failure, or a wallet naming no indexer, is handed on as nothing held.
   */
  it('reads a vault\'s public money on this device, at the wallet\'s indexer, when asked', async () => {
    const { readVaultPublicMoney } = await load();
    const token = NIGHT.ledger.unshielded!;
    kr.answers[ROUTE()] = { ...(kr.answers[ROUTE()] as object), contractAddress: 'c0'.repeat(32) };
    kr.indexer = { indexerUri: 'https://indexer.wallet.example/api/v3/graphql', indexerWsUri: 'wss://indexer.wallet.example/api/v3/graphql/ws' };
    kr.vaults['ab'.repeat(32)] = { onChain: true, publicBalances: [{ token, amount: '4000000' }] };
    const held = await readVaultPublicMoney('u1', 'c1', 'ab'.repeat(32));
    expect([held?.amounts.map((a) => formatTokenAmount(a, 'en')), held?.unrecognised]).toEqual([['4'], 0]);
    expect(kr.readHere).toEqual([`${'ab'.repeat(32)} at https://indexer.wallet.example/api/v3/graphql`]);
    expect(kr.asked.filter((p) => p.endsWith('/chain'))).toEqual([]);
    expect(await readVaultPublicMoney('u1', 'c1', 'cd'.repeat(32))).toBeNull();
    kr.indexer = null;
    kr.readHere = [];
    expect(await readVaultPublicMoney('u1', 'c1', 'ab'.repeat(32))).toBeNull();
    expect(kr.readHere).toEqual([]);
  });
});

describe('how many must approve, in the one list of companies', () => {
  /* RED WHEN: a company's approvals are the service's row (which says 1 here) rather than what the person's wallet read off the chain, or are named for a company the wallet could not read, or are asked for somebody else's list. */
  it('gives each company\'s approvals as the wallet read them, leaves out one it could not, and ignores the row\'s own number', async () => {
    vi.resetModules();
    const row = (id: string, over: object = {}) => ({ id, createdAt: 'x', signerCount: 1, threshold: 1, companyLabel: LABEL, contractAddress: 'c0'.repeat(32), ...over });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      user: { id: 'u1', name: 'Priya' }, accounts: [row('c1'), row('c2', { contractAddress: null })],
    }), { status: 200 })));
    const session = await import('./session.js');
    expect((await session.approvalsNeededFor('u1')).size).toBe(0);
    const listed = await session.whoIsSignedIn();
    expect(JSON.stringify(listed)).not.toContain('approvalsNeeded');
    expect([...(await session.approvalsNeededFor('u1')).entries()]).toEqual([['c1', 2]]);
    kr.approvals = undefined;
    expect([...(await session.approvalsNeededFor('somebody else')).entries()]).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe('the names in the one list of companies', () => {
  /*
   * RED WHEN: a company not finished, which has no sealed record to open, is listed with no name though this device kept its
   * creation; or it is given the name in the service's plain field; or a company this device can neither open nor has a
   * creation of is given any name; or a name the device opened is replaced by the kept creation's.
   */
  it('names a company that is not finished by the creation this device kept, never by the service\'s own field', async () => {
    vi.resetModules();
    const accounts = [
      { id: 'c2', createdAt: 'x', signerCount: 1, name: 'Service name 2' },
      { id: 'c3', createdAt: 'x', signerCount: 1, name: 'Service name 3' },
      { id: 'c1', createdAt: 'x', signerCount: 1, name: 'Service name 1' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1', name: 'Priya' }, accounts }), { status: 200 })));
    const was = kr.account;
    kr.account = null;
    kr.kept = { c2: 'Test-001', c1: 'Kept name 1' };
    try {
      const session = await import('./session.js');
      await session.whoIsSignedIn();
      expect([...(await session.companyNamesFor('u1')).entries()].sort()).toEqual([['c1', 'Kept name 1'], ['c2', 'Test-001']]);
      kr.account = was;
      expect((await session.companyNamesFor('u1')).get('c1')).toBe('Northwind');
    } finally {
      kr.account = was; kr.kept = {};
      vi.unstubAllGlobals();
    }
  });

  /*
   * RED WHEN: a creation this device keeps and the service does not list (its first post never arrived) is left out of the
   * list of companies and of the names, so after a reload it is reachable from nowhere; or it is listed twice when the
   * service lists it too; or another person's creation is listed.
   */
  it('lists a creation kept here that the service does not list, once, by its name', async () => {
    vi.resetModules();
    const accounts = [{ id: 'c1', createdAt: 'x', signerCount: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1', name: 'Priya' }, accounts }), { status: 200 })));
    kr.kept = { c1: 'Kept name 1', acc_unposted: 'Unposted Ltd' };
    try {
      const session = await import('./session.js');
      const who = await session.whoIsSignedIn();
      expect(who.of).toBe('signed-in');
      const ids = (who as unknown as { companies: { id: string }[] }).companies.map((c) => c.id);
      expect(ids).toEqual(['c1', 'acc_unposted']);
      expect((await session.companyNamesFor('u1')).get('acc_unposted')).toBe('Unposted Ltd');
      kr.user = 'someone-else';
      expect(((await session.whoIsSignedIn()) as unknown as { companies: { id: string }[] }).companies.map((c) => c.id)).toEqual(['c1']);
    } finally {
      kr.kept = {}; kr.user = 'u1';
      vi.unstubAllGlobals();
    }
  });

  /* RED WHEN: why a company's name did not open on this device is thrown away, or a reason is kept beside a name that opened. */
  it('keeps why a company\'s name did not open on this device, and no reason beside a name', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: 'u1', name: 'Priya' }, accounts: [{ id: 'c1', createdAt: 'x', signerCount: 1 }] }), { status: 200 })));
    const was = kr.account;
    try {
      const session = await import('./session.js');
      const { RosterNotBelieved } = await import('vaults-web-shared/roster-here.js');
      await session.whoIsSignedIn();
      kr.account = new RosterNotBelieved('This device does not believe the company\'s roster it was given (x).');
      const refused = await session.companyNamesFor('u1');
      expect(refused.get('c1')).toBeUndefined();
      expect(refused.whyNot.get('c1')).toBe('roster-not-believed');
      kr.account = null;
      expect((await session.companyNamesFor('u1')).whyNot.get('c1')).toBe('no-keys-here');
      kr.account = was;
      const named = await session.companyNamesFor('u1');
      expect(named.get('c1')).toBe('Northwind');
      expect(named.whyNot.size).toBe(0);
    } finally {
      kr.account = was;
      vi.unstubAllGlobals();
    }
  /* Every module the names read loads is loaded afresh here, which takes some seconds the first time. */
  }, 30_000);

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
