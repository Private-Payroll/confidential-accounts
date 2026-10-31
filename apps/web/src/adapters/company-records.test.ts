// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bigintJsonReplacer, newSigningKeypair, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { inboxPublicKey, sealRecord, sealToInbox } from '../../../../src/core/sealed-records.js';
import { sealPerson } from '../../../../src/core/person-record.js';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { signCompanyFiling, toCompanyWire } from '../../../../src/midnight/sealed-record-wire.js';
import { sealVendor, type VendorRecord } from '../../../../src/core/vendor-record.js';
import { SEED_ASSETS, StaticAssetRegistry } from '../../../../src/core/assets.js';
import { publicAmount } from 'vaults-ui';

/*
 * A COMPANY'S RECORDS, OPENED AND READ THROUGH THE ADAPTER. The keyring and
 * the service are stood in for; the runs and proposals are sealed with the
 * record code the service uses and opened with `openRecord`, the code a page
 * opens them with, so what is opened here is what a real record opens to. The people
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
  answers: {} as Record<string, unknown>, asked: [] as string[], keys: true, canOpen: true, user: 'u1', opened: 0,
  /* The company each opening of the saved keys named, as the company opened with them. */
  openedWith: [] as Array<string | undefined>,
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
  anchoring: [] as Array<{ company: string }>,
  /* The seats the account holds on the chain, its stored bar and its vaults' own thresholds, as the wallet reads them. */
  seats: [] as string[], policyBar: null as number | null, vaultThresholds: [] as Array<{ vault: string; threshold: number }>,
  /* The record ids this device's directory names, by kind, and the ones whose filer its judge refuses. */
  named: {} as Record<string, string[]>, unbelieved: [] as string[],
  /* What the vault builder was asked to check of an address claim, what it answers, and whether it can check one at all. */
  claims: [] as Array<{ claim: unknown; f: unknown }>, claimAnswer: null as string | null, claimCheck: true,
  /* The seats whose directory entry this device's directory read holds; null when that read gives no directory. */
  entries: null as string[] | null,
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    vaultOnChain: async (i: { vault: string; indexer: { indexerUri: string } }) => {
      kr.readHere.push(`${i.vault} at ${i.indexer.indexerUri}`);
      const v = kr.vaults[i.vault];
      if (v === undefined) throw new Error('the indexer holds nothing for that vault');
      return v;
    },
    ...(kr.claimCheck ? { addressClaimRefusal: async (claim: unknown, f: unknown) => { kr.claims.push({ claim, f }); return kr.claimAnswer; } } : {}),
  }),
}));
/* Any anchor started on this page, recorded: entering a company starts none. */
vi.mock('vaults-web-shared/records-anchored-here.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/records-anchored-here.js')>()),
  anchoredOnTheWayIn: (doors: { accountId: string }) => { kr.anchoring.push({ company: doors.accountId }); return new Promise(() => undefined); },
  anchorTheRecordsHere: (doors: { accountId: string }) => { kr.anchoring.push({ company: doors.accountId }); return new Promise(() => undefined); },
}));
/* The seat the chain says each proposal took, as the person's own indexer gives it, and the proposals it was asked about. */
const chainSeats = vi.hoisted(() => ({ took: {} as Record<string, string | null>, asked: [] as string[][], fails: false }));
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  rosterReadsFor: () => ({
    invitedSeats: async (proposals: string[]) => { chainSeats.asked.push(proposals); if (chainSeats.fails) throw new Error('the indexer did not answer'); return chainSeats.took; },
  }),
  /* The company's keys as its directory gives them (`companyKeysFor`), stood in for by the one key of a company never changed. */
  filingJudgeFor: () => async () => null,
  /* The directory this device believes, stood in for: the judge below reads `kr.named` and `kr.unbelieved` off it. */
  directoryHereFor: () => async () => (kr.entries === null ? {} : { dir: { seats: kr.entries.map((seat) => ({ seat })) } }),
  companyKeysFor: async () => ({ epoch: 0, newest: 0, key: VK, keyAt: () => VK, sealing: () => ({ key: VK, epoch: 0 }) }),
}));
/* What this device reads of the people: the real read, unless a test hands it an answer the real read never gives (a refused record named nowhere else). */
const peopleAre = vi.hoisted(() => ({ answer: null as null | (() => unknown) }));
vi.mock('vaults-web-shared/people-read-here.js', async (real) => {
  const actual = await real<typeof import('vaults-web-shared/people-read-here.js')>();
  return { ...actual, readPeopleHere: (...a: Parameters<typeof actual.readPeopleHere>) => (peopleAre.answer === null ? actual.readPeopleHere(...a) : Promise.resolve(peopleAre.answer())) };
});
/* The proposals that invite a signer by address, opened: what the core opens them to is the server's test, here only what the page asks and does with it. */
const bya = vi.hoisted(() => ({ bodies: {} as Record<string, unknown>, asked: [] as Array<{ id: string; account: string; keys: unknown }>, throws: false }));
vi.mock('../../../../src/core/proposal-filing.js', async (real) => ({
  ...(await real<typeof import('../../../../src/core/proposal-filing.js')>()),
  addSignerByAddressIn: (rec: { id: string }, account: string, keys: unknown) => {
    bya.asked.push({ id: rec.id, account, keys });
    if (bya.throws) throw new Error('the core could not open it');
    return bya.bodies[rec.id] ?? null;
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
vi.mock('vaults-web-shared/vault-page-doors.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/vault-page-doors.js')>()),
  judgeIn: () => Object.assign((_filer: unknown, _kind: unknown, key: string) => (kr.unbelieved.some((id) => key.includes(id)) ? 'a seat this device does not believe filed it' : null), {}),
  namedHere: (_here: unknown, _store: string, kind: string) => kr.named[kind] ?? [],
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: kr.user }),
  companyNameKeptHere: (id: string) => kr.kept[id] ?? null,
  companiesBeingCreated: () => Object.keys(kr.kept),
  forgetLocally: () => {},
  resumeSession: async () => null,
  /* This seat as the wallet read it for the tab: its public halves only. */
  seatHeldHere: () => (kr.keys ? { signerId: 's1', signingPublicKey: 'a1'.repeat(32), wrappingPublicKey: 'a2'.repeat(32), scope: 'a3'.repeat(32) } : null),
  canOpenCompanies: () => kr.canOpen,
  openAccount: () => {
    if (kr.account instanceof Error) throw kr.account;
    return kr.account;
  },
  viewingKeyFor: () => VK,
  openKeysWithWallet: async (...a: unknown[]) => { kr.opened += 1; kr.openedWith.push(a[4] as string | undefined); },
  /* Who holds the company, as the person's own wallet reads it with no press: the vaults its account has adopted, and its indexer. */
  /* `threshold` on this answer is the account's maintenance committee's, never the approvals the account asks for. */
  holdersFromTheWallet: async () => ({ holders: { adoptedVaults: kr.adopted, threshold: 1, seats: kr.seats, policyBar: kr.policyBar, vaultThresholds: kr.vaultThresholds, ...(kr.approvals === undefined ? {} : { approvals: kr.approvals, seatBar: Math.max(kr.approvals, kr.policyBar ?? 0) }) }, indexer: kr.indexer }),
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
const REAL_ADDRESSES: Record<string, { readonly kind: string; readonly bech32: string; readonly [key: string]: string }> = {
  '1 shielded': {
    kind: 'shielded', network: 'stagenet', coinPublicKey: '01'.repeat(32), encryptionPublicKey: '5b'.repeat(32),
    bech32: 'mn_shield-addr_stagenet1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kkcvfvr0u',
  },
  '2 unshielded': { kind: 'unshielded', network: 'stagenet', userAddress: '02'.repeat(32), bech32: 'mn_addr_stagenet1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq8fl0tq' },
};
const payable = (n: number, kind: 'shielded' | 'unshielded', label = LABEL) => {
  const keys = n.toString(16).padStart(2, '0').repeat(32);
  /* Real addresses written out, since the address encoder in this page's window reads another window's bytes; any other n is not an address. */
  const address = REAL_ADDRESSES[`${n} ${kind}`] ?? { kind, bech32: `mn_${kind === 'shielded' ? 'shield-addr' : 'addr'}_test1${'q'.repeat(59)}${n}` };
  const payslipKey = keys;
  const payeeCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), label as never, `usr_${n}`, { kind: 'payee', address: address.bech32, payslipKey });
  return { address, wrappingPublicKey: payslipKey, handedOverBy: payeeCode.committeeKey.value, payeeCode };
};
/** A person as the people read answers: their newest record on the wire, and whether a hand-over waits. */
const SEAT = newSigningKeypair().secret;
const MADE = { madeBy: signingPublicKeyOf(SEAT), madeAt: '2026-09-01T00:00:00Z' };
const filedPerson = (p: Record<string, unknown>, handedOver?: boolean, key = VK, company = 'c1') => ({
  filed: toCompanyWire(signCompanyFiling(sealPerson({ accountId: company, email: null, wrappingPublicKey: null, handedOverBy: null, ...MADE, ...p } as never, 1, 1, key), SEAT)),
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
    filedPerson({ id: 'emp_e2', name: 'Bo', title: 'Designer', asset: NIGHT.code, baseAmount: 2_000_000n, startDate: '2026-02-01', status: 'active', ...payable(2, 'unshielded') }, false),
    filedPerson({ id: 'emp_e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 5_000_000n, startDate: '2026-01-01', status: 'active', ...payable(1, 'shielded') }, false),
    filedPerson({ id: 'emp_e5', name: 'Eve', title: 'Writer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-03-01', status: 'pending', address: null }, true),
    filedPerson({ id: 'emp_e6', name: 'Fay', title: 'Writer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-03-01', status: 'pending', address: null }, false),
    filedPerson({ id: 'emp_e7', name: 'Gus', title: 'Writer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-03-01', status: 'leaver', address: { kind: 'shielded' } }),
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
    { kind: 'vendor', name: 'Vik', createdAt: '2026-09-12T00:00:00.000Z' },
    { kind: 'vendor', name: 'Spent', createdAt: '2026-09-12T00:00:00.000Z', acceptedAt: '2026-09-13T00:00:00.000Z' },
    { kind: 'super-admin', name: 'Root', createdAt: '2026-09-12T00:00:00.000Z' },
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

beforeEach(() => { info.answer = { state: 'none' }; info.asked = []; info.fails = false; kr.anchoring = []; kr.seats = []; kr.policyBar = null; kr.vaultThresholds = []; kr.named = {}; kr.unbelieved = []; kr.claims = []; kr.claimAnswer = null; kr.claimCheck = true; kr.entries = null; kr.answers = {}; kr.asked = []; kr.keys = true; kr.canOpen = true; kr.user = 'u1'; kr.opened = 0; everything(); });
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

  it('ENTERING THE COMPANY STARTS NO ANCHOR: ITS RECORDS ARE ANCHORED AT THE END OF A SEAT ACTION IN A SIGNER\'S WALLET', async () => {
    const { readCompany, readVaultName } = await load();
    expect((await readCompany('u1', 'c1')).of).toBe('open');
    await readVaultName('u1', 'c1', 'd1'.repeat(32));
    /* RED WHEN: opening a company starts an anchor on the page, a transaction signed with no press and listed in no window. */
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

  it('writes which check of the company\'s signers refused, and what stopped it, to the console report, and nothing the service served', async () => {
    const { readCompany } = await load();
    const { RosterNotBelieved, ROSTER_CHECK } = await import('vaults-web-shared/roster-here.js');
    const was = kr.account;
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warned.push(String(line)); });
    vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
    const served = `it has no entry for the seat ${'5e'.repeat(32)}`;
    kr.account = new RosterNotBelieved(`This device does not believe the company's roster it was given (${served}).`, null, null, {
      check: ROSTER_CHECK.seatUnnamed, stoppedBy: ['SeatNotReadOnTheChain'],
    });
    try {
      expect(await readCompany('u1', 'c1')).toEqual({ of: 'refused', why: 'roster-not-believed' });
      /* RED WHEN: the page refuses a company's signers and its console report does not say which check refused, the error's class and what stopped it. */
      expect(warned).toContain('read checking the company\'s signers: refused at seat-unnamed (RosterNotBelieved); stopped by SeatNotReadOnTheChain');
      /* RED WHEN: the console report carries the refusal's message, which can name a seat or anything else the service served. */
      expect(warned.join('\n')).not.toContain('5e'.repeat(32));
    } finally {
      kr.account = was;
      warn.mockRestore();
    }
  });

  it('says once that a company with no account on the network yet has no signers to check, and never as a refusal', async () => {
    const { readCompany } = await load();
    const { RosterNotBelieved, ROSTER_CHECK } = await import('vaults-web-shared/roster-here.js');
    const was = kr.account;
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warned.push(String(line)); });
    vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
    kr.account = new RosterNotBelieved('no account', null, null, { check: ROSTER_CHECK.noAccount });
    try {
      await readCompany('u1', 'c1');
      await readCompany('u1', 'c1');
      const said = warned.filter((l) => l.includes('checking the company\'s signers'));
      /* RED WHEN: a company with no account yet is logged as a refusal of its signers, or logged again at every read. */
      expect(said).toEqual(['read checking the company\'s signers: not checked, because the company has no account on the network yet']);
    } finally {
      kr.account = was;
      warn.mockRestore();
    }
  });

  it('names why the filer of the company\'s roster is not believed, by its code alone', async () => {
    const { readCompany } = await load();
    const { RosterNotBelieved, ROSTER_CHECK } = await import('vaults-web-shared/roster-here.js');
    const was = kr.account;
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warned.push(String(line)); });
    vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
    kr.account = new RosterNotBelieved(`not believed (${'5e'.repeat(32)})`, null, null, { check: ROSTER_CHECK.filerNotBelieved, because: 'no-entry' });
    try {
      await readCompany('u1', 'c1');
      /* RED WHEN: a roster refused for its filer is logged without the reason's code, or with the refusal's own words. */
      expect(warned).toContain('read checking the company\'s signers: refused at filer-not-believed (RosterNotBelieved); because no-entry');
      expect(warned.join('\n')).not.toContain('5e'.repeat(32));
    } finally {
      kr.account = was;
      warn.mockRestore();
    }
  });

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

  it('opens the saved keys with the company whose pages are open, and with none once they are left', async () => {
    const { companyPagesOpen, openWithYourAccount, readCompany } = await load();
    kr.openedWith = [];
    await openWithYourAccount('u1');
    const leave = companyPagesOpen('c1');
    await openWithYourAccount('u1');
    /* RED WHEN: the open press on a company's pages does not name that company, so its vault balances need another window. */
    expect(kr.openedWith).toEqual([undefined, 'c1']);
    leave();
    await readCompany('u1', 'c1');
    await openWithYourAccount('u1');
    /* RED WHEN: the open press away from a company's pages names the company last read, so its key is held while it is not open. */
    expect(kr.openedWith).toEqual([undefined, 'c1', undefined]);
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

  /* RED WHEN: an active person is shown as paid at an address, or with a payslip key, their own wallet did not sign, or with no code at all: they must be named not payable with why, and kept off the people shown. */
  it('names an active person not payable, with why, when they are not payable at what their own wallet signed', async () => {
    const { readCompany } = await load();
    const ana = { id: 'emp_e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'active' };
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
      if (c.of !== 'open' || c.peopleBelief?.of !== 'read') throw new Error(`not read: ${what}`);
      expect(c.people.of, what).toBe('unreadable');
      expect(c.peopleBelief.value.notPayable.map((x) => [x.person.id, x.why !== '']), what).toEqual([['emp_e1', true]]);
    }
    kr.answers[ROUTE('/people')] = { people: [filedPerson({ ...ana, ...good }, false)] };
    const c = await readCompany('u1', 'c1');
    expect(c.of === 'open' && c.people.of === 'read' && c.people.value.map((x) => x.id)).toEqual(['emp_e1']);
    expect(c.of === 'open' && c.peopleBelief?.of === 'read' && c.peopleBelief.value.notPayable).toEqual([]);
  });

  /* RED WHEN: a person added by an unshielded address with no claim of it their own wallet signed (or a forged one) is shown as payable. */
  it('does not show a person added by an unshielded address as payable without their wallet\'s signed claim of it', async () => {
    const { readCompany } = await load();
    const typed = REAL_ADDRESSES['2 unshielded']!.bech32;
    kr.answers[ROUTE('/people')] = { people: [filedPerson({
      id: 'emp_e2', name: 'Bo', title: 'Designer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-02-01', status: 'active', invitedAddress: typed,
      ...payable(2, 'unshielded'), addressClaim: { kind: 'unshielded', address: typed, signature: 'ff'.repeat(64) },
    }, false)] };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.peopleBelief?.of !== 'read') throw new Error('not read');
    expect(c.people.of).toBe('unreadable');
    expect(c.peopleBelief.value.notPayable.map((x) => [x.person.id, /claim/u.test(x.why)])).toEqual([['emp_e2', true]]);
  });

  /* RED WHEN: a person added by an unshielded address is read as payable on the page without their wallet's signed claim checked by the vault builder, or is read at all when the builder cannot check it. */
  it('checks the signed claim of a person added by an unshielded address in the vault builder, and reads no people when it cannot', async () => {
    const { readCompany } = await load();
    const typed = REAL_ADDRESSES['2 unshielded']!.bech32;
    const claim = { kind: 'unshielded', address: typed, verifyingKey: 'aa'.repeat(32), signature: 'ff'.repeat(64) };
    kr.answers[ROUTE('/people')] = { people: [filedPerson({
      id: 'emp_e2', name: 'Bo', title: 'Designer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-02-01', status: 'active', invitedAddress: typed,
      ...payable(2, 'unshielded'), addressClaim: claim,
    }, false)] };
    const held = await readCompany('u1', 'c1');
    expect(held.of === 'open' && held.people.of === 'read' && held.people.value.map((p) => p.id)).toEqual(['emp_e2']);
    expect(kr.claims).toEqual([{ claim, f: expect.objectContaining({ company: LABEL, person: 'emp_e2', payslipKey: '02'.repeat(32), address: typed }) }]);
    kr.claimAnswer = 'the claim\'s signature is not the address\'s';
    const refused = await readCompany('u1', 'c1');
    if (refused.of !== 'open' || refused.peopleBelief?.of !== 'read') throw new Error('not read');
    expect(refused.people.of).toBe('unreadable');
    expect(refused.peopleBelief.value.notPayable.map((x) => [x.person.id, x.why.includes(kr.claimAnswer!)])).toEqual([['emp_e2', true]]);
    kr.claimCheck = false;
    const unchecked = await readCompany('u1', 'c1');
    expect(unchecked.of === 'open' && [unchecked.people.of, unchecked.peopleBelief?.of]).toEqual(['unreadable', 'unreadable']);
  });

  /* RED WHEN: the company's read does not tell an accepted signer from a seated one by the roster and the chain, or counts a change of signers at the threshold where a stored bar is higher. */
  it('reads each signer as accepted or seated, and the approvals a change of signers needs with the vaults at that number', async () => {
    const { readCompany } = await load();
    const leaf = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
    const was = kr.account;
    kr.account = { id: 'c1', name: 'Northwind', signers: [
      { id: 's1', name: 'Priya', status: 'active', leafCommitment: leaf(1) }, { id: 's2', name: 'Sam', status: 'pending', leafCommitment: leaf(2) },
    ] };
    kr.seats = [leaf(1), leaf(2)];
    kr.approvals = 2;
    kr.policyBar = 3;
    kr.vaultThresholds = [{ vault: 'ab'.repeat(32), threshold: 3 }];
    const c = await readCompany('u1', 'c1');
    kr.account = was;
    if (c.of !== 'open') throw new Error('not open');
    expect(c.signerStandings).toEqual({ of: 'read', value: [
      { id: 's1', name: 'Priya', accepted: false, seatOnChain: true, you: false, entryFiled: null },
      { id: 's2', name: 'Sam', accepted: true, seatOnChain: true, you: false, entryFiled: null },
    ] });
    expect(c.approvalsForSigners).toEqual({ of: 'read', value: { count: 3, raisedAboveTheAccount: true, vaultsAtThatNumber: ['ab'.repeat(32)] } });
    expect(c.approvalsNeeded).toEqual({ of: 'read', value: 2 });
  });

  it('marks as you the one signer whose signing key is the seat this device holds, whatever the names say, and whose entry the directory holds', async () => {
    const { readCompany } = await load();
    const leaf = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
    const was = kr.account;
    /* The founding seat saved under the name the create step gives a person with no name, and the signer signed in here named apart. */
    kr.account = { id: 'c1', name: 'Northwind', signers: [
      { id: 'sF', name: 'You', status: 'active', leafCommitment: leaf(1), signingPublicKey: 'b1'.repeat(32) },
      { id: 's1', name: 'KC-Wallet 2', status: 'active', leafCommitment: leaf(2), signingPublicKey: 'A1'.repeat(32) },
    ] };
    kr.seats = [leaf(1), leaf(2)];
    kr.entries = [leaf(1)];
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.signerStandings?.of !== 'read') throw new Error('not open');
      /* RED WHEN: the signer marked as you is chosen by name, by order or by anything but the signing key of the seat this device holds. */
      expect(c.signerStandings.value.map((s) => [s.name, s.you])).toEqual([['You', false], ['KC-Wallet 2', true]]);
      /* RED WHEN: a seated signer whose entry the company's directory does not hold is not told apart from one whose entry it holds. */
      expect(c.signerStandings.value.map((s) => s.entryFiled)).toEqual([true, false]);
      kr.entries = null;
      const unread = await readCompany('u1', 'c1');
      if (unread.of !== 'open' || unread.signerStandings?.of !== 'read') throw new Error('not open');
      /* RED WHEN: a directory this device could not read is told as an entry not filed. */
      expect(unread.signerStandings.value.map((s) => s.entryFiled)).toEqual([null, null]);
    } finally {
      kr.account = was;
    }
  });

  it('marks as you only the row with both the seat id and the signing key this device holds, never a second row carrying its key', async () => {
    const { readCompany } = await load();
    const leaf = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
    const was = kr.account;
    /* A second row a believed filer put under this device's signing key, beside this device's own seat. */
    kr.account = { id: 'c1', name: 'Northwind', signers: [
      { id: 'sX', name: 'Copy', status: 'pending', leafCommitment: leaf(3), signingPublicKey: 'a1'.repeat(32) },
      { id: 's1', name: 'KC-Wallet 2', status: 'active', leafCommitment: leaf(2), signingPublicKey: 'a1'.repeat(32) },
    ] };
    kr.seats = [leaf(2), leaf(3)];
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.signerStandings?.of !== 'read') throw new Error('not open');
      /* RED WHEN: a row carrying this device's signing key under another id than this device's own seat is marked as you. */
      expect(c.signerStandings.value.map((s) => [s.id, s.you])).toEqual([['sX', false], ['s1', true]]);
    } finally {
      kr.account = was;
    }
  });

  /* RED WHEN: a record this device does not believe, or one the directory names and the service did not give, is shown as a person or left unsaid. */
  it('names the records it does not believe, and those named and not given', async () => {
    const { readCompany } = await load();
    kr.named = { person: ['emp_ghost'] };
    kr.unbelieved = ['emp_e1'];
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.peopleBelief?.of !== 'read') throw new Error('not read');
    expect([...c.peopleBelief.value.notBelieved].sort()).toEqual(['emp_e1', 'emp_ghost']);
    /* RED WHEN: people not believed are dropped from the people read and the screens lose them without a word. */
    expect(c.people.of).toBe('unreadable');
  });

  /* RED WHEN: a record filed for another company reads as a person, or hides the people that are fine; one sealed under another key reads as read. */
  it('names a record that is not a person of this company as refused, and hands on one it cannot open as unreadable', async () => {
    const { readCompany } = await load();
    const ana = { id: 'emp_e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'pending', address: null };
    kr.answers[ROUTE('/people')] = { people: [filedPerson(ana, false, VK, 'c2'), filedPerson({ ...ana, id: 'emp_e3', name: 'Cat' }, false)] };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.peopleBelief?.of !== 'read') throw new Error('not read');
    expect(c.peopleBelief.value.refused.map((x) => x.id)).toEqual(['emp_e1']);
    /* RED WHEN: a refused id is listed again among those not believed. */
    expect(c.peopleBelief.value.notBelieved).toEqual([]);
    expect(c.people.of).toBe('unreadable');
    kr.answers[ROUTE('/people')] = { people: [filedPerson(ana, false, OTHER_VK)] };
    const d = await readCompany('u1', 'c1');
    if (d.of !== 'open') throw new Error('not open');
    expect([d.people.of, d.peopleBelief?.of, d.runs.of]).toEqual(['unreadable', 'unreadable', 'read']);
  });

  /* RED WHEN: a person whose record was refused is left out of the people while the people read still says it is complete. */
  it('does not call the people complete when a record was refused, even one this device lists as believed nowhere else', async () => {
    const { readCompany } = await load();
    peopleAre.answer = () => ({ people: [], notBelieved: [], notPayable: [], refused: [{ id: 'emp_e1', why: 'it is filed for another company' }] });
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.peopleBelief?.of !== 'read') throw new Error('not read');
      expect(c.people.of).toBe('unreadable');
      /* RED WHEN: the page that names the refused record is not told which it is. */
      expect(c.peopleBelief.value.refused.map((x) => x.id)).toEqual(['emp_e1']);
      expect(c.peopleBelief.value.notBelieved).toEqual([]);
    } finally {
      peopleAre.answer = null;
    }
    /* With nothing refused, left out or not payable, the same read is complete. */
    peopleAre.answer = () => ({ people: [], notBelieved: [], notPayable: [], refused: [] });
    try {
      const c = await readCompany('u1', 'c1');
      expect(c.of === 'open' && c.people).toEqual({ of: 'read', value: [] });
    } finally {
      peopleAre.answer = null;
    }
  });

  /* RED WHEN: the vendors are not read with the belief check, or a pending vendor whose hand-over waits is shown as not yet invited-and-waiting, or a vendor the directory names and the service did not give is dropped. */
  it('reads the vendors, each with where it stands and whether a hand-over waits, and names the ones it does not believe', async () => {
    const { readCompany } = await load();
    const vendor = (id: string, name: string) => ({ versions: [toCompanyWire(signCompanyFiling(sealVendor({
      id, accountId: 'c1', name, email: null, network: 'stagenet', startDate: '2026-10-01', terms: { kind: 'one-off' }, status: 'pending', address: null,
      wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null, ...MADE,
    } as VendorRecord, 1, 1, VK), SEAT))] });
    kr.named = { vendor: ['ven_aa11aa11aa11aa11aa11', 'ven_bb22bb22bb22bb22bb22', 'ven_ghost'] };
    kr.answers[ROUTE('/records/vendor/ven_aa11aa11aa11aa11aa11/versions')] = vendor('ven_aa11aa11aa11aa11aa11', 'Vee');
    kr.answers[ROUTE('/records/vendor/ven_bb22bb22bb22bb22bb22/versions')] = vendor('ven_bb22bb22bb22bb22bb22', 'Wes');
    kr.answers[ROUTE('/vendors/ven_aa11aa11aa11aa11aa11/handover')] = { inbox: { sealed: 'x' } };
    kr.answers[ROUTE('/vendors/ven_bb22bb22bb22bb22bb22/handover')] = { inbox: null };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.vendorsBelief?.of !== 'read') throw new Error('not read');
    /* RED WHEN: a vendor this device does not believe is dropped from the vendors read without a word. */
    expect(c.vendors?.of).toBe('unreadable');
    expect(c.vendorsBelief.value.vendors.map((v) => [v.id, v.standing, v.handedOver, v.termsKind, v.paid])).toEqual([
      ['ven_aa11aa11aa11aa11aa11', 'waiting-for-check', true, 'one-off', 'not-set-up'], ['ven_bb22bb22bb22bb22bb22', 'invited', false, 'one-off', 'not-set-up'],
    ]);
    expect(c.vendorsBelief.value.notBelieved).toEqual(['ven_ghost']);
    expect(c.vendorsBelief.value.notPayable).toEqual([]);
    kr.named = { vendor: ['ven_aa11aa11aa11aa11aa11', 'ven_bb22bb22bb22bb22bb22'] };
    const d = await readCompany('u1', 'c1');
    expect(d.of === 'open' && d.vendors?.of === 'read' && d.vendors.value.vendors.length).toBe(2);
  });

  /* RED WHEN: a vendor's panel cannot show what they are paid, their dates, how they are admitted or whether they will be paid; a vendor the check will not pay is left out of `rows` or not marked with why; or a vendor who is paid is marked. */
  it('reads each vendor with their terms, dates and how to admit them, and keeps one who will not be paid in the rows, marked with why', async () => {
    const { readCompany } = await load();
    const vendor = (id: string, name: string, over: Record<string, unknown>) => ({ versions: [toCompanyWire(signCompanyFiling(sealVendor({
      id, accountId: 'c1', name, email: null, network: 'stagenet', startDate: '2026-10-01', terms: { kind: 'one-off' }, status: 'pending', address: null,
      wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null, ...MADE, ...over,
    } as VendorRecord, 1, 1, VK), SEAT))] });
    kr.named = { vendor: ['ven_aa11aa11aa11aa11aa11', 'ven_cc33cc33cc33cc33cc33'] };
    kr.answers[ROUTE('/records/vendor/ven_aa11aa11aa11aa11aa11/versions')] = vendor('ven_aa11aa11aa11aa11aa11', 'Vee', {
      terms: { kind: 'monthly', asset: NIGHT.code, amount: 2_500_000n }, endDate: '2026-12-31', invitedAddress: payable(2, 'unshielded').address.bech32,
    });
    kr.answers[ROUTE('/records/vendor/ven_cc33cc33cc33cc33cc33/versions')] = vendor('ven_cc33cc33cc33cc33cc33', 'Cy', { status: 'active', admittedAt: '2026-10-02T00:00:00.000Z' });
    kr.answers[ROUTE('/vendors/ven_aa11aa11aa11aa11aa11/handover')] = { inbox: { sealed: 'x' } };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.vendorsBelief?.of !== 'read') throw new Error('not read');
    const { rows, vendors, notPayable } = c.vendorsBelief.value;
    expect(rows.map((v) => [v.id, v.name, v.standing, v.notPayable !== null && v.notPayable !== ''])).toEqual([
      ['ven_cc33cc33cc33cc33cc33', 'Cy', 'active', true], ['ven_aa11aa11aa11aa11aa11', 'Vee', 'waiting-for-check', false],
    ]);
    expect(notPayable.map((n) => [n.vendor.id, n.why !== ''])).toEqual([['ven_cc33cc33cc33cc33cc33', true]]);
    expect(rows.find((v) => v.id === 'ven_cc33cc33cc33cc33cc33')!.notPayable).toBe(notPayable[0]!.why);
    expect(vendors.map((v) => v.id)).toEqual(['ven_aa11aa11aa11aa11aa11']);
    const vee = rows.find((v) => v.name === 'Vee')!;
    expect([vee.termsKind, vee.asset, vee.endDate, vee.admitBy, vee.admittedAt]).toEqual(['monthly', NIGHT.code, '2026-12-31', 'claim', null]);
    expect(vee.monthly).toEqual(publicAmount(2_500_000n, NIGHT.decimals, NIGHT.symbol));
    const cy = rows.find((v) => v.name === 'Cy')!;
    expect([cy.termsKind, cy.asset, cy.monthly, cy.endDate, cy.admitBy, cy.admittedAt]).toEqual(['one-off', null, null, null, 'fingerprint', '2026-10-02T00:00:00.000Z']);
  });

  /* RED WHEN: a vendor who has not been admitted yet, or who has left, and whose record names an address that does not hold, is marked as one this device will not pay (only an active vendor can be, as only an active person can), so a vendor waiting for the check loses the admit control; or an active one is not marked; or the guard on `vendors` is lifted by one who is not an active vendor. */
  it('marks as not payable only an active vendor, as for a person, and never one who is not admitted yet or has left', async () => {
    const { readCompany } = await load();
    const ids = { cy: 'ven_cc33cc33cc33cc33cc33', lee: 'ven_ee55ee55ee55ee55ee55', wes: 'ven_dd44dd44dd44dd44dd44', di: 'ven_ff66ff66ff66ff66ff66' };
    const vendor = (id: string, name: string, over: Record<string, unknown>) => ({ versions: [toCompanyWire(signCompanyFiling(sealVendor({
      id, accountId: 'c1', name, email: null, network: 'stagenet', startDate: '2026-10-01', terms: { kind: 'one-off' }, status: 'pending', address: null,
      wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null, ...MADE, ...over,
    } as VendorRecord, 1, 1, VK), SEAT))] });
    const set = (named: string[]) => {
      kr.named = { vendor: named };
      kr.answers[ROUTE(`/records/vendor/${ids.cy}/versions`)] = vendor(ids.cy, 'Cy', { status: 'active', admittedAt: '2026-10-02T00:00:00.000Z' });
      kr.answers[ROUTE(`/records/vendor/${ids.lee}/versions`)] = vendor(ids.lee, 'Lee', { status: 'leaver', admittedAt: '2026-10-02T00:00:00.000Z', address: payable(1, 'shielded').address });
      kr.answers[ROUTE(`/records/vendor/${ids.wes}/versions`)] = vendor(ids.wes, 'Wes', { address: payable(2, 'shielded').address });
      kr.answers[ROUTE(`/records/vendor/${ids.di}/versions`)] = vendor(ids.di, 'Di', {});
      kr.answers[ROUTE(`/vendors/${ids.wes}/handover`)] = { inbox: { sealed: 'x' } };
      for (const id of [ids.cy, ids.lee, ids.di]) kr.answers[ROUTE(`/vendors/${id}/handover`)] = { inbox: null };
    };
    set([ids.cy, ids.lee, ids.wes, ids.di]);
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.vendorsBelief?.of !== 'read') throw new Error('not read');
    expect(c.vendorsBelief.value.rows.map((v) => [v.name, v.standing, v.notPayable !== null])).toEqual([
      ['Cy', 'active', true], ['Di', 'invited', false], ['Lee', 'leaver', false], ['Wes', 'waiting-for-check', false],
    ]);
    expect(c.vendorsBelief.value.notPayable.map((n) => n.vendor.name)).toEqual(['Cy']);
    expect(c.vendors?.of).toBe('unreadable');
    set([ids.lee, ids.wes, ids.di]);
    const d = await readCompany('u1', 'c1');
    if (d.of !== 'open' || d.vendorsBelief?.of !== 'read') throw new Error('not read');
    expect([d.vendors?.of, d.vendorsBelief.value.notPayable, d.vendorsBelief.value.rows.map((v) => v.notPayable)]).toEqual(['read', [], [null, null, null]]);
  });

  /* RED WHEN: a vendor with no payment address yet is taken to be paid publicly or privately (a screen would then draw the Public pill, or promise privacy, before an address decides it), or one with an address is not. */
  it('knows how a vendor is paid only when the record holds the address that decides it', async () => {
    const { readCompany, visibilityKnown } = await load();
    const vendor = (id: string, name: string, over: Record<string, unknown>) => ({ versions: [toCompanyWire(signCompanyFiling(sealVendor({
      id, accountId: 'c1', name, email: null, network: 'stagenet', startDate: '2026-10-01', terms: { kind: 'monthly', asset: NIGHT.code, amount: 2_500_000n }, status: 'active', address: null,
      wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: '2026-10-02T00:00:00.000Z', ...MADE, ...over,
    } as VendorRecord, 1, 1, VK), SEAT))] });
    kr.named = { vendor: ['ven_aa11aa11aa11aa11aa11', 'ven_bb22bb22bb22bb22bb22', 'ven_cc33cc33cc33cc33cc33'] };
    kr.answers[ROUTE('/records/vendor/ven_aa11aa11aa11aa11aa11/versions')] = vendor('ven_aa11aa11aa11aa11aa11', 'Ada', { ...payable(1, 'shielded') });
    kr.answers[ROUTE('/records/vendor/ven_bb22bb22bb22bb22bb22/versions')] = vendor('ven_bb22bb22bb22bb22bb22', 'Bea', { ...payable(2, 'unshielded') });
    kr.answers[ROUTE('/records/vendor/ven_cc33cc33cc33cc33cc33/versions')] = vendor('ven_cc33cc33cc33cc33cc33', 'Cal', {});
    for (const id of ['ven_aa11aa11aa11aa11aa11', 'ven_bb22bb22bb22bb22bb22', 'ven_cc33cc33cc33cc33cc33']) kr.answers[ROUTE(`/vendors/${id}/handover`)] = { inbox: null };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.vendorsBelief?.of !== 'read') throw new Error('not read');
    expect(c.vendorsBelief.value.rows.map((v) => [v.name, v.paid, visibilityKnown(v.paid)])).toEqual([
      ['Ada', 'privately', true], ['Bea', 'publicly', true], ['Cal', 'not-set-up', false],
    ]);
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
      'active', 'add-signer', 'draft', 'employee', 'executed', 'held-by-committee', 'invited', 'leaver', 'not-known', 'not-set-up', 'open', 'payroll', 'privately', 'publicly', 'read', 'settled', 'signer', 'unknown', 'vendor', 'waiting-for-check',
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

  /* RED WHEN: a person's row loses what the People page's panel shows: the currency they are paid in, the classification and the end and leaving dates in force, the whole salary and classification history with when each line was made, or when they were admitted. */
  it('gives a person\'s row everything the People panel shows, with the history lines in order', async () => {
    const { personRow } = await load();
    const person = {
      id: 'e', name: 'A', title: 'T', asset: NIGHT.code, baseAmount: 5_000_000n, startDate: '2026-01-01', status: 'active', address: { kind: 'shielded' },
      endDate: '2027-06-30', leavingDate: '2027-05-31', admittedAt: '2026-01-02T09:00:00.000Z',
      pay: [{ amount: 5_000_000n, from: '2026-01-01', madeBy: null, madeAt: '2026-01-01T08:00:00.000Z' }, { amount: 6_000_000n, from: '2027-01-01', madeBy: null, madeAt: '2026-12-01T10:30:00.000Z' }],
      classifications: [{ classification: 'full-time', from: '2026-01-01', madeBy: null, madeAt: '2026-01-01T08:00:00.000Z' }, { classification: 'part-time', from: '2027-01-01', madeBy: null, madeAt: null }],
    };
    const row = personRow(person as never, undefined, '2026-12-31');
    expect([row.asset, row.classification, row.endDate, row.leavingDate, row.admittedAt]).toEqual([NIGHT.code, 'full-time', '2027-06-30', '2027-05-31', '2026-01-02T09:00:00.000Z']);
    expect(row.pays.map((l) => [l.amount === null ? null : formatTokenAmount(l.amount, 'en'), l.amount === null ? null : visibilityOf(l.amount), l.from, l.madeAt])).toEqual([
      ['5', 'private', '2026-01-01', '2026-01-01T08:00:00.000Z'], ['6', 'private', '2027-01-01', '2026-12-01T10:30:00.000Z'],
    ]);
    expect(row.classifications).toEqual([
      { classification: 'full-time', from: '2026-01-01', madeAt: '2026-01-01T08:00:00.000Z' }, { classification: 'part-time', from: '2027-01-01', madeAt: null },
    ]);
    expect(personRow(person as never, undefined, '2027-02-01').classification).toBe('part-time');
    /* A record filed before the history was kept has one line, from the start date; a person with no dates or lines has none to show. */
    const plain = personRow({ id: 'p', name: 'P', title: 'T', asset: NIGHT.code, baseAmount: 7_000_000n, startDate: '2026-03-01', status: 'pending', address: null } as never, undefined, '2026-12-31');
    expect([plain.pays.map((l) => [l.from, l.madeAt]), plain.classifications, plain.classification, plain.endDate, plain.leavingDate, plain.admittedAt]).toEqual([[['2026-03-01', null]], [], null, null, null, null]);
  });

  /* RED WHEN: a person with no payment address yet is taken to be paid publicly or privately (a screen would then draw the Public pill, or promise privacy, before an address decides it), or one with an address is not. */
  it('knows how a person is paid only when the record holds the address that decides it', async () => {
    const { personRow, visibilityKnown } = await load();
    const at = (address: { kind: string } | null) => personRow({ id: 'e', name: 'A', title: 'T', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'active', address } as never);
    expect([at(null), at({ kind: 'shielded' }), at({ kind: 'unshielded' })].map((r) => [r.paid, visibilityKnown(r.paid)])).toEqual([['not-set-up', false], ['privately', true], ['publicly', true]]);
  });

  /* RED WHEN: a person added by an unshielded address is asked for a fingerprint they cannot give (their wallet's signed claim admits them), or one added by link or at a private address is admitted without the fingerprint they read out. */
  it('says whether a person is admitted on a fingerprint or on their wallet\'s signed claim, by the address they were added at', async () => {
    const { personRow } = await load();
    const at = (invitedAddress?: string | null) => personRow({ id: 'e', name: 'A', title: 'T', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'pending', address: null, ...(invitedAddress === undefined ? {} : { invitedAddress }) } as never).admitBy;
    expect([at(), at(null), at(PRIVATE_ADDRESS), at(PUBLIC_ADDRESS), at(`  ${PRIVATE_ADDRESS} `)]).toEqual(['fingerprint', 'fingerprint', 'fingerprint', 'claim', 'fingerprint']);
  });

  /* RED WHEN: one record this device does not believe, or one that is refused or active and not payable, takes the believed people off the page with it (the guard on `people` is lifted for the page by `rows`), or `rows` carries someone who is not believed or is active and not payable. */
  it('keeps the believed people in rows while the people read stays unreadable, and leaves the others out of them', async () => {
    const { readCompany } = await load();
    kr.unbelieved = ['emp_e1'];
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.peopleBelief?.of !== 'read') throw new Error('not read');
    expect(c.people.of).toBe('unreadable');
    expect(c.peopleBelief.value.notBelieved).toEqual(['emp_e1']);
    expect(c.peopleBelief.value.rows.map((p) => [p.id, p.name, p.standing, p.asset])).toEqual([
      ['emp_e2', 'Bo', 'active', NIGHT.code], ['emp_e5', 'Eve', 'waiting-for-check', NIGHT.code], ['emp_e6', 'Fay', 'invited', NIGHT.code], ['emp_e7', 'Gus', 'leaver', NIGHT.code],
    ]);
    kr.unbelieved = [];
    const ana = { id: 'emp_e1', name: 'Ana', title: 'Engineer', asset: NIGHT.code, baseAmount: 1n, startDate: '2026-01-01', status: 'active' };
    kr.answers[ROUTE('/people')] = { people: [filedPerson({ ...ana, ...payable(1, 'shielded'), payeeCode: null }, false), filedPerson({ ...ana, id: 'emp_e3', name: 'Cat', status: 'pending', address: null }, true)] };
    const d = await readCompany('u1', 'c1');
    if (d.of !== 'open' || d.peopleBelief?.of !== 'read') throw new Error('not read');
    expect([d.people.of, d.peopleBelief.value.notPayable.map((x) => x.person.id), d.peopleBelief.value.rows.map((p) => p.id)]).toEqual(['unreadable', ['emp_e1'], ['emp_e1', 'emp_e3']]);
    /* The active person the check will not pay is a row marked with why, and the pending person is a row unmarked. */
    expect(d.peopleBelief.value.rows.map((p) => [p.id, p.notPayable !== null && p.notPayable !== ''])).toEqual([['emp_e1', true], ['emp_e3', false]]);
    expect(d.peopleBelief.value.rows[0]!.notPayable).toBe(d.peopleBelief.value.notPayable[0]!.why);
    kr.answers[ROUTE('/people')] = { people: [filedPerson({ ...ana, ...payable(1, 'shielded') }, false)] };
    const e = await readCompany('u1', 'c1');
    expect(e.of === 'open' && e.people.of === 'read' && e.peopleBelief?.of === 'read' && e.people.value).toEqual(e.of === 'open' && e.peopleBelief?.of === 'read' ? e.peopleBelief.value.rows : null);
  });

  /* RED WHEN: decimals are written in the adapter instead of read from the registry it is given. */
  it('reads decimals from the registry', async () => {
    const { runRow } = await load();
    const registry = new StaticAssetRegistry([...SEED_ASSETS.filter((a) => a.symbol !== 'NIGHT'), { ...NIGHT, decimals: 2 }]);
    const row = runRow({ id: 'r', period: '2026-10', status: 'draft', employees: [{ id: 'e', name: 'A', asset: NIGHT.code, amount: 150n, paidTo: PRIVATE_ADDRESS }] } as never, registry);
    expect(formatTokenAmount(row.currencies[0]!.privately!, 'en')).toBe('1.5');
  });

  /* RED WHEN: a person's pay is shown as the amount they were hired at after their salary changed. */
  it('shows a person\'s pay as the salary line in force, and before they start, the first', async () => {
    const { personRow } = await load();
    const person = {
      id: 'e', name: 'A', title: 'T', asset: NIGHT.code, baseAmount: 100000000n, startDate: '2026-10-01', status: 'active', address: null,
      pay: [{ amount: 100000000n, from: '2026-10-01', madeBy: null, madeAt: null }, { amount: 250000000n, from: '2027-01-01', madeBy: null, madeAt: null }],
    };
    expect(formatTokenAmount(personRow(person, undefined, '2026-12-31').pay!, 'en')).toBe(formatTokenAmount(personRow({ ...person, pay: undefined }, undefined, '2026-12-31').pay!, 'en'));
    expect(formatTokenAmount(personRow(person, undefined, '2027-01-01').pay!, 'en')).not.toBe(formatTokenAmount(personRow(person, undefined, '2026-12-31').pay!, 'en'));
    expect(formatTokenAmount(personRow(person, undefined, '2026-09-01').pay!, 'en')).toBe(formatTokenAmount(personRow(person, undefined, '2026-12-31').pay!, 'en'));
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

  /* RED WHEN: a link used, withdrawn or expired is listed as waiting to be used, one that names nobody is given a name, a link for a vendor is left out, or one for a kind the page cannot send is listed. */
  it('lists only the links still waiting to be used, a vendor\'s among them', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.invitations.of !== 'read') throw new Error('not read');
    expect(c.invitations.value.map((i) => [i.kind, i.name])).toEqual([['signer', 'Tom'], ['employee', null], ['vendor', 'Vik']]);
  });

  /* RED WHEN: a vendor's link is dropped or listed as an employee's, a vendor's link used, withdrawn or expired is listed, or a link of a kind the page cannot send is listed. */
  it('keeps a waiting vendor link as a vendor\'s, and drops a used, withdrawn or expired one and every other kind', async () => {
    const { invitationRows } = await load();
    const at = '2026-09-12T00:00:00.000Z';
    expect(invitationRows([
      { kind: 'vendor', name: 'Vik', createdAt: at },
      { kind: 'vendor', createdAt: at, expiresAt: '2999-01-01T00:00:00.000Z' },
      { kind: 'vendor', name: 'Spent', createdAt: at, acceptedAt: at },
      { kind: 'vendor', name: 'Gone', createdAt: at, revokedAt: at },
      { kind: 'vendor', name: 'Old', createdAt: at, expiresAt: '2020-10-11T00:00:00.000Z' },
      { kind: 'super-admin', name: 'Root', createdAt: at },
    ], Date.parse('2026-10-29T00:00:00.000Z'))).toEqual([
      { kind: 'vendor', name: 'Vik', sentAt: at, expiresAt: null },
      { kind: 'vendor', name: null, sentAt: at, expiresAt: '2999-01-01T00:00:00.000Z' },
    ]);
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

describe('the signers invited by address', () => {
  const body = (name: string) => ({ chainId: 'cc', summary: '', proposalSalt: 'aa', coinPublicKey: '0c'.repeat(32), invited: { terms: { name, role: 'approver', invite: { address: 'ab'.repeat(32), salt: 'cd'.repeat(32), scope: 'ef'.repeat(32) } } } });
  const open = async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open') throw new Error('not open');
    return c;
  };
  beforeEach(() => { bya.bodies = {}; bya.asked = []; bya.throws = false; });

  /* RED WHEN: a proposal that invites a signer by address is not handed on with its record id, and its role, or is opened for another company or under a key other than the company's. */
  it('opens each proposal from the one list of proposals, under the company\'s own keys, and hands on those that invite by address', async () => {
    bya.bodies['p1'] = body('Sam');
    const c = await open();
    expect(c.signersInvited).toEqual({ of: 'read', value: [{
      proposal: 'p1', name: 'Sam', role: 'approver', address: 'ab'.repeat(32), scope: 'ef'.repeat(32), coinKey: '0c'.repeat(32), status: 'open', approvals: null,
      seat: null,
    }] });
    expect(bya.asked.map((a) => [a.id, a.account])).toEqual([['p1', 'c1'], ['p2', 'c1']]);
    expect((bya.asked[0]!.keys as { key: string }).key).toBe(VK);
    expect(kr.asked.filter((p) => p.endsWith('/proposals'))).toHaveLength(1);
  });

  /* RED WHEN: proposals that cannot be read are told as no signer invited, or a core that cannot open one takes the proposals' own list down with it. */
  /* RED WHEN: a seat request the chain does not show the proposal took, filed by the service or another invitee, hides Approve; or the seat the chain says it took does not reach the signers page, so Approve stays on an invitation carried out. */
  it('reads the seat each invitation took from the chain alone, with the entry waiting at that seat, and never from a request naming it', async () => {
    const SEAT = '5e'.repeat(32);
    bya.bodies['p1'] = body('Sam');
    const forged = { name: 'Sam', role: 'approver', signingPublicKey: 'b1'.repeat(32), wrappingPublicKey: 'b2'.repeat(32), leafCommitment: SEAT, invited: { terms: { proposal: 'CC' } } };
    kr.answers[ROUTE()] = { ...(kr.answers[ROUTE()] as object), pendingSigners: [{ id: 'sX', userId: 'u8', createdAt: 'x', sealed: sealToInbox(forged, inboxPublicKey(VK, 'c1')) }] };
    const was = kr.account;
    kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active' }, { id: 'sB', name: 'Sam', status: 'pending', leafCommitment: SEAT }] };
    chainSeats.took = {}; chainSeats.asked = []; chainSeats.fails = false;
    try {
      const asked = await open();
      expect(asked.signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: null }] });
      expect(chainSeats.asked).toEqual([['cc']]);
      chainSeats.took = { cc: SEAT.toUpperCase() };
      expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: 'sB' } }] });
      chainSeats.took = { cc: '6f'.repeat(32) };
      expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: null } }] });
      chainSeats.fails = true;
      expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: null }] });
      chainSeats.fails = false;
      chainSeats.took = { cc: SEAT };
      kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active' }, { id: 'sB', name: 'Sam', status: 'active', leafCommitment: SEAT.toUpperCase() }] };
      /* RED WHEN: an invitation stays waiting after the chain shows its seat taken and the believed roster holds an active signer at that seat. */
      expect((await open()).signersInvited).toEqual({ of: 'read', value: [] });
      kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active', leafCommitment: SEAT }] };
      chainSeats.took = { cc: '6f'.repeat(32) };
      /* RED WHEN: an active signer at another seat than the one the chain says the proposal took ends the invitation's wait. */
      expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: null } }] });
    } finally {
      kr.account = was;
      chainSeats.took = {}; chainSeats.fails = false;
    }
  });

  it('says unreadable, apart from the proposals, when they cannot be read or one cannot be opened', async () => {
    kr.answers[ROUTE('/proposals')] = new Error('the service could not be reached');
    const down = await open();
    expect([down.proposals.of, down.signersInvited?.of]).toEqual(['unreadable', 'unreadable']);
    everything();
    bya.throws = true;
    const broke = await open();
    expect([broke.proposals.of, broke.signersInvited?.of]).toEqual(['read', 'unreadable']);
  });
});
