// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bigintJsonReplacer, canonical, newSigningKeypair, seal, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { inboxPublicKey, sealRecord, sealToInbox } from '../../../../src/core/sealed-records.js';
import { sealPerson } from '../../../../src/core/person-record.js';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { signCompanyFiling, toCompanyWire } from '../../../../src/midnight/sealed-record-wire.js';
import { sealVendor, type VendorRecord } from '../../../../src/core/vendor-record.js';
import { SEED_ASSETS, StaticAssetRegistry } from '../../../../src/core/assets.js';
import { newProposalId, signProposalFiling } from '../../../../src/core/proposal-filing.js';
import { publicAmount } from 'vaults-ui';
import { newOneOffId } from '../../../../src/midnight/one-off-record.js';

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
  answers: {} as Record<string, unknown>, asked: [] as string[], keys: true, canOpen: true, user: 'u1', opened: 0, asking: 0, quiet: async () => ({ epoch: 0, newest: 0, key: VK, keyAt: () => VK, sealing: () => ({ key: VK, epoch: 0 }) }),
  /* The signing key of the seat this device holds, as the wallet read it for the tab. */
  ownKey: 'a1'.repeat(32),
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
  named: {} as Record<string, string[]>, unbelieved: [] as string[], leftOut: [] as string[],
  /* The records the list was checked against, by key, as the directory handed to that check named them. */
  listedFrom: [] as string[],
  /* What the vault builder was asked to check of an address claim, what it answers, and whether it can check one at all. */
  claims: [] as Array<{ claim: unknown; f: unknown }>, claimAnswer: null as string | null, claimCheck: true,
  /* The seats whose directory entry this device's directory read holds; null when that read gives no directory. */
  entries: null as string[] | null,
}));
/*
 * Where each proposal stands as the page's vault worker reads it off the chain (`roundsOnChain`), by its identity on the
 * chain, and each read it was asked for: the account, the indexer and the identities.
 */
const chain = vi.hoisted(() => ({
  rounds: {} as Record<string, unknown>, asked: [] as Array<{ account: string; indexer: unknown; chainIds: readonly string[]; seat?: unknown }>,
  /* Which payments the account records as paid, as the page's vault worker reads them off the chain (`paidLeaves`), by leaf; and each read it was asked for. */
  paid: {} as Record<string, boolean>, paidAsked: [] as Array<{ account: string; indexer: unknown; leaves: readonly string[] }>, paidFails: false,
  /* An answer the worker gives as it is, whatever leaves it was asked about; null to answer each leaf asked from `paid`. */
  paidAnswer: null as Record<string, boolean> | null,
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    roundsOnChain: async (i: { account: string; indexer: unknown; chainIds: readonly string[] }) => {
      chain.asked.push(i);
      return Object.fromEntries(i.chainIds.map((id) => [id, chain.rounds[id] ?? { held: 'never', approvals: 0 }]));
    },
    paidLeaves: async (i: { account: string; indexer: unknown; leaves: readonly string[] }) => {
      chain.paidAsked.push(i);
      if (chain.paidFails) throw new Error('the indexer did not answer');
      if (chain.paidAnswer !== null) return chain.paidAnswer;
      return Object.fromEntries(i.leaves.map((l) => [l, chain.paid[l] ?? false]));
    },
    vaultOnChain: async (i: { vault: string; indexer: { indexerUri: string } }) => {
      kr.readHere.push(`${i.vault} at ${i.indexer.indexerUri}`);
      const v = kr.vaults[i.vault];
      if (v === undefined) throw new Error('the indexer holds nothing for that vault');
      return v;
    },
    ...(kr.claimCheck ? { addressClaimRefusal: async (claim: unknown, f: unknown) => { kr.claims.push({ claim, f }); return kr.claimAnswer; } } : {}),
    /* A one-off's record, opened in the page's worker: it opens, under the company's key alone, to what `oneOffs.opened` holds for its id. */
    openOneOff: async (rec: { id: string }, key: string) => {
      if (key !== '11'.repeat(32) || !(rec.id in oneOffs.opened)) throw new Error('this record does not open with that key');
      return oneOffs.opened[rec.id];
    },
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
  filingJudgeFor: () => async () => Object.assign(() => null, {}),
  /* The directory this device believes, stood in for: the judge below reads `kr.named` and `kr.unbelieved` off it. */
  directoryHereFor: () => async () => ({
    records: { history: new Map(kr.named.proposal?.map((id) => [`proposal:proposal:${id}`, []]) ?? []), notYetAnchored: [] },
    ...(kr.entries === null ? {} : { dir: { seats: kr.entries.map((seat) => ({ seat })) } }),
  }),
  /* The asking judge counts its use (`kr.asking`): a page load uses only the quiet one. */
  companyKeysQuietlyFor: kr.quiet, companyKeysFor: async () => { kr.asking += 1; return kr.quiet(); },
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
/*
 * A one-off payment's record, as the page's worker opens it (`openOneOff` on the vault builder above): the record is
 * fetched, judged and matched as it is, and only its opening, which decodes the payee's address, is stood in for.
 */
const oneOffs = vi.hoisted(() => ({ opened: {} as Record<string, unknown> }));
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
  /* The list as this device believes it, stood in for: the records named in `kr.leftOut` are left out as sealed under an older key. */
  listedHere: <T extends { id: string }>(here: { records?: { history?: Map<string, unknown> } }, _store: string, listed: readonly T[]) => Object.assign((() => {
    kr.listedFrom = [...(here.records?.history?.keys() ?? [])];
    return listed.filter((x) => !kr.leftOut.includes(x.id));
  })(), {
    leftOut: new Map(kr.leftOut.map((id) => [id, 'sealed under an older key'])), setAside: listed.filter((x) => kr.leftOut.includes(x.id)),
  }),
}));
/*
 * The chain read and the filing check, as they are: taken through the module mocks so that, after each load's module
 * reset, they read the directory stand-in above, as every other import of it does.
 */
vi.mock('vaults-web-shared/run-rebuilt-here.js', async (real) => ({ ...(await real<typeof import('vaults-web-shared/run-rebuilt-here.js')>()) }));
vi.mock('vaults-web-shared/round-opened-here.js', async (real) => ({ ...(await real<typeof import('vaults-web-shared/round-opened-here.js')>()) }));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => ({ id: kr.user }),
  companyNameKeptHere: (id: string) => kr.kept[id] ?? null,
  companiesBeingCreated: () => Object.keys(kr.kept),
  forgetLocally: () => {},
  resumeSession: async () => null,
  /* This seat as the wallet read it for the tab: its public halves only. */
  seatHeldHere: () => (kr.keys ? { signerId: 's1', signingPublicKey: kr.ownKey, wrappingPublicKey: 'a2'.repeat(32), scope: 'a3'.repeat(32) } : null),
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
/* A run as a device seals it: its payout sealed with its people, and what else `extra` gives served beside the seal. */
const sealedRun = (id: string, period: string, status: string, employees: unknown[], extra: Record<string, unknown> = {}, key = VK) => {
  const { payout, ...served } = extra;
  return {
    id, accountId: 'c1', period, status, payslips: [], keyEpoch: 1, proposalIds: ['p1'],
    sealed: sealRecord('payroll', 'c1', { employees, totals: {}, proposalIds: { [NIGHT_PUBLICLY]: 'p1' }, ...(payout === undefined ? {} : { payout }) }, key), ...served,
  };
};
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
  kr.indexer = { indexerUri: 'https://indexer.wallet.example/api/v4/graphql', indexerWsUri: 'wss://indexer.wallet.example/api/v4/graphql/ws' };
  /* Both proposals carry the one identity on the chain; the chain holds it open at 1 of the 2 it was raised needing. */
  kr.named = { proposal: ['p1', 'p2'] };
  chain.rounds = { cc: { held: 'open', approvals: 1, needed: 2, raisedAt: Date.parse('2026-09-21T10:00:00.000Z') } };
  chain.asked = [];
  chain.paid = {}; chain.paidAsked = []; chain.paidFails = false; chain.paidAnswer = null;
  kr.adopted = ['ab'.repeat(32), 'cd'.repeat(32)];
  kr.approvals = 2;
  kr.answers[ROUTE('/runs')] = [
    sealedRun('r1', '2026-10', 'draft', [
      { id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5_000_000n, paidTo: PRIVATE_ADDRESS },
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 2_000_000n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
      { id: 'e3', name: 'Cy', asset: NIGHT.code, amount: 1_000_000n, form: 'unshielded' },
      { id: 'e4', name: 'Di', asset: 'f0'.repeat(32), amount: 7n, paidTo: PRIVATE_ADDRESS },
      { id: 'e5', name: 'Ed', asset: NIGHT.code, amount: 500_000n, form: 'unshielded', paidTo: 'not an address' },
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

beforeEach(() => { kr.asking = 0; info.answer = { state: 'none' }; info.asked = []; info.fails = false; kr.anchoring = []; kr.seats = []; kr.policyBar = null; kr.vaultThresholds = []; kr.named = {}; kr.unbelieved = []; kr.leftOut = []; kr.listedFrom = []; kr.claims = []; kr.claimAnswer = null; kr.claimCheck = true; kr.entries = null; kr.ownKey = 'a1'.repeat(32); kr.answers = {}; kr.asked = []; kr.keys = true; kr.canOpen = true; kr.user = 'u1'; kr.opened = 0; everything(); });
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
    ], waited: [leaf(2), leaf(3)] };
    kr.seats = [leaf(1), leaf(2), leaf(3)];
    kr.approvals = 2;
    kr.policyBar = 3;
    kr.vaultThresholds = [{ vault: 'ab'.repeat(32), threshold: 3 }];
    const c = await readCompany('u1', 'c1');
    kr.account = was;
    if (c.of !== 'open') throw new Error('not open');
    expect(c.signerStandings).toEqual({ of: 'read', value: [
      { id: 's1', name: 'Priya', accepted: false, seatOnChain: true, you: false, entryFiled: null, leaf: leaf(1) },
      { id: 's2', name: 'Sam', accepted: true, seatOnChain: true, you: false, entryFiled: null, leaf: leaf(2) },
      /* RED WHEN: the page builds where each signer stands without the seats the roster read waits for, so a seat the network holds is left off. */
      { id: leaf(3), name: '', accepted: false, seatOnChain: true, you: false, entryFiled: null, leaf: leaf(3), waiting: true },
    ] });
    expect(c.approvalsForSigners).toEqual({ of: 'read', value: { count: 3, raisedAboveTheAccount: true, vaultsAtThatNumber: ['ab'.repeat(32)], seated: 3 } });
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

  /* RED WHEN: a record filed for another company reads as a person, or hides the people that are fine; one sealed under another key reads as a person. */
  it('names a record that is not a person of this company, or one that does not open here, as refused, and hands on the people as unreadable', async () => {
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
    expect([d.people.of, d.peopleBelief?.of === 'read' && d.peopleBelief.value.refused.map((x) => x.id), d.runs.of]).toEqual(['unreadable', ['emp_e1'], 'read']);
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
    /* RED WHEN: a vendor's row loses the address their entry holds, or invents one for a vendor whose entry holds none, so the payee list would offer an address nobody gave. */
    expect(d.vendorsBelief.value.rows.map((v) => [v.name, v.address])).toEqual([['Di', null], ['Lee', payable(1, 'shielded').address.bech32], ['Wes', payable(2, 'shielded').address.bech32]]);
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
      'active', 'add-signer', 'employee', 'held-by-committee', 'invited', 'leaver', 'not-known', 'not-set-up', 'open', 'payroll', 'privately', 'publicly', 'read', 'signer', 'unknown', 'vendor', 'waiting-for-check',
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
    expect(next!.legs.map(({ pays: _pays, ...leg }) => leg)).toEqual([{
      code: NIGHT_PUBLICLY, asset: NIGHT.code, symbol: 'NIGHT', paid: 'publicly', vault: 'ab'.repeat(32), payees: 3,
      proposal: 'p1', form: 'unshielded', list: 'employees', people: 3, total: 3_500_000n, leaves: ['01', '02', '03'], paidOnChain: 0,
      amounts: [2_000_000n, 1_000_000n, 500_000n], unpaid: [0, 1, 2],
    }]);
    /* RED WHEN a leg's people are counted from its recorded leaves rather than the run's people on that leg as the wallet counts them, its total is not their sum, or its payments lose a person, their address or their amount. */
    expect(next!.legs[0]!.pays.map((x) => [x.name, x.address, x.amount === null ? null : visibilityOf(x.amount)])).toEqual([
      ['Bo', PUBLIC_ADDRESS, 'public'], ['Cy', null, 'public'], ['Ed', 'not an address', 'public'],
    ]);
    /* RED WHEN: a run carries what the service says of it, its status or its settled day, for a screen to read as paid. */
    expect(['status' in paid!, 'settledAt' in paid!, 'status' in next!, 'settledAt' in next!]).toEqual([false, false, false, false]);
    expect(paid!.currencies[0]!.publicly).toBeNull();
    /* The service says r0 settled, and its record names no payment the chain could be asked about, so what is paid of it is not read. */
    expect(paid!.paidOnChain).toBeUndefined();
  });

  /*
   * RED WHEN: a run, a leg or a retry reads as paid from the service's status or its settled day, or from anything but what this device's own
   * worker reads of the account's chain; a payment the chain does not show is read as paid, or one it cannot read as not paid; or all, some and
   * none of a leg's payments are not told apart.
   */
  it('reads what is paid of a run from the chain, and never from the service\'s word that it settled', async () => {
    const { readCompany } = await load();
    const run = (id: string, leaves: string[]) => sealedRun(id, '2026-11', 'settled', [
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 2n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
      { id: 'e3', name: 'Cy', asset: NIGHT.code, amount: 1n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
    ], { settledAt: '2026-11-30T12:00:00.000Z', payout: { [NIGHT_PUBLICLY]: { vault: 'ab'.repeat(32), payees: 2n, leaves } } });
    kr.answers[ROUTE('/runs')] = [run('r5', ['aa', 'bb'])];
    const stateOf = async () => {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.runs.of !== 'read') throw new Error('not read');
      const [r] = c.runs.value;
      return ['status' in r! || 'settledAt' in r!, r!.paidOnChain, r!.legs[0]!.paidOnChain];
    };
    /* Settled by the service's word, and none of its payments on the chain: not paid, and the service's word is not carried. */
    expect(await stateOf()).toEqual([false, 0, 0]);
    expect(chain.paidAsked).toEqual([{ account: 'c0'.repeat(32), indexer: kr.indexer, leaves: ['aa', 'bb'] }]);
    chain.paid = { aa: true };
    expect(await stateOf()).toEqual([false, 1, 1]);
    chain.paid = { aa: true, bb: true };
    expect(await stateOf()).toEqual([false, 2, 2]);
    /* A chain that cannot be read says nothing of it: neither paid nor unpaid. */
    chain.paidFails = true;
    expect(await stateOf()).toEqual([false, undefined, undefined]);
    chain.paidFails = false;
    kr.indexer = null;
    expect(await stateOf()).toEqual([false, undefined, undefined]);
  });

  /*
   * RED WHEN: the people a leg names are not the wallet's own for it (`legEmployees`: the run's people of that token and form, in the run's order, a person
   * with no form on the shielded leg), in the same order as the leaves the leg was raised over, so a place the page names for a retry is another person's
   * for the wallet; or the places the chain shows unpaid, the people's amounts or the leg's closing time are not read off the leg's own record.
   */
  it('names the people of a leg in the wallet\'s order, and the places the chain shows unpaid among them', async () => {
    const { readCompany } = await load();
    const { legEmployees } = await import('../../../../src/core/run-legs.js');
    const other = 'f0'.repeat(32);
    const employees = [
      { id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5n, paidTo: PRIVATE_ADDRESS },
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 2n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
      { id: 'e4', name: 'Di', asset: other, amount: 7n, paidTo: PRIVATE_ADDRESS },
      { id: 'e3', name: 'Cy', asset: NIGHT.code, amount: 1n, form: 'shielded', paidTo: PRIVATE_ADDRESS },
      { id: 'e5', name: 'Ed', asset: NIGHT.code, amount: 4n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
      { id: 'e6', name: 'Flo', asset: NIGHT.code, amount: 8n, paidTo: PRIVATE_ADDRESS },
    ];
    const SHIELDED = `${NIGHT.code}:shielded`;
    kr.answers[ROUTE('/runs')] = [sealedRun('r5', '2026-11', 'proposed', employees, { payout: {
      [SHIELDED]: { vault: 'ab'.repeat(32), payees: 3n, leaves: ['a1', 'a2', 'a3'], closesAt: 1_800_000_000n },
      [NIGHT_PUBLICLY]: { vault: 'ab'.repeat(32), payees: 2n, leaves: ['b1', 'b2'], closesAt: 1_800_000_000n },
    } })];
    chain.paid = { a1: true, a3: true, b1: true, b2: true };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.runs.of !== 'read') throw new Error('not read');
    const run = c.runs.value[0]!;
    const wallet = (leg: string) => legEmployees({ employees } as never, leg as never).map((e) => [e.name, e.amount]);
    const shielded = run.legs.find((l) => l.code === SHIELDED)!;
    const publicly = run.legs.find((l) => l.code === NIGHT_PUBLICLY)!;
    expect(wallet(SHIELDED)).toEqual([['Ana', 5n], ['Cy', 1n], ['Flo', 8n]]);
    expect(shielded.pays.map((x) => x.name)).toEqual(wallet(SHIELDED).map(([n]) => n));
    expect(shielded.amounts).toEqual(wallet(SHIELDED).map(([, a]) => a));
    expect(publicly.pays.map((x) => x.name)).toEqual(wallet(NIGHT_PUBLICLY).map(([n]) => n));
    expect(publicly.amounts).toEqual(wallet(NIGHT_PUBLICLY).map(([, a]) => a));
    /* The chain shows the first and third of the shielded leg paid: the second, Cy, is who a retry names. */
    expect([shielded.unpaid, shielded.paidOnChain, shielded.closesAt]).toEqual([[1], 1, 1_800_000_000n]);
    expect([publicly.unpaid, publicly.paidOnChain]).toEqual([[], 2]);
    /* A leg that lists other people than it was raised over names no amounts, so no place can be named for it. */
    kr.answers[ROUTE('/runs')] = [sealedRun('r5', '2026-11', 'proposed', employees, { payout: { [SHIELDED]: { vault: 'ab'.repeat(32), payees: 2n, leaves: ['a1', 'a2'], closesAt: 1n } } })];
    const d = await readCompany('u1', 'c1');
    if (d.of !== 'open' || d.runs.of !== 'read') throw new Error('not read');
    expect(d.runs.value[0]!.legs[0]!.amounts).toBeUndefined();
  });

  /* RED WHEN: a retry raised on a leg is not read with its proposal, its people and total, and only their payments, or its proposal is not said to pay its run. */
  it('reads a retry on a leg as a proposal of the run paying only the people it names, and what the chain shows of those', async () => {
    const { readCompany } = await load();
    kr.named = { proposal: ['p1', 'p2', 'p3'] };
    chain.rounds = { cc: { held: 'open', approvals: 2, needed: 2, raisedAt: Date.parse('2026-09-21T10:00:00.000Z') } };
    kr.answers[ROUTE('/proposals')] = [sealedProposal('p1', 'open', {}), sealedProposal('p3', 'open', {})];
    kr.answers[ROUTE('/runs')] = [sealedRun('r5', '2026-11', 'proposed', [
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 2_000_000n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
      { id: 'e3', name: 'Cy', asset: NIGHT.code, amount: 1_000_000n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
      { id: 'e5', name: 'Ed', asset: NIGHT.code, amount: 500_000n, form: 'unshielded', paidTo: PUBLIC_ADDRESS },
    ], {
      payout: { [NIGHT_PUBLICLY]: {
        vault: 'ab'.repeat(32), payees: 3n, leaves: ['aa', 'bb', 'cc'],
        retries: [{ originalIndices: [1, 2], root: 'dd', payees: 2n, opensAt: 5n, closesAt: 9n, vault: 'cd'.repeat(32), proposalId: 'p3', proposedBy: 's1', at: '2026-11-02T00:00:00.000Z' }],
      } },
    })];
    chain.paid = { aa: true, bb: true };
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.runs.of !== 'read' || c.proposals.of !== 'read') throw new Error('not read');
    const leg = c.runs.value[0]!.legs[0]!;
    expect(leg.paidOnChain).toBe(1);
    expect(leg.retries!.map(({ pays, ...r }) => [r, pays.map((x) => x.name)])).toEqual([[
      { proposal: 'p3', vault: 'cd'.repeat(32), people: 2, total: 1_500_000n, leaves: ['bb', 'cc'], paidOnChain: 1 }, ['Cy', 'Ed'],
    ]]);
    expect(c.proposals.value.find((p) => p.id === 'p3')!.pays).toMatchObject({ run: 'r5', period: '2026-11', asset: NIGHT.code, paid: 'publicly' });
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
   * RED WHEN: where a proposal stands, its count or its bar is the service's or the sealed record's rather than the
   * chain's, a payment of a run is not tied to its run, token and form, or a filing that carries no signature is put on
   * the signer its sealed body names.
   */
  it('reads each proposal from its opened record, where the chain holds it', async () => {
    const { readCompany } = await load();
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
    expect(c.proposals.value.map((p) => [p.id, p.kind, p.status, p.raisedBy, p.approvals, p.needed, p.pays])).toEqual([
      /* RED WHEN a payroll round is not tied to the token and the form its leg pays, or names its token to a screen by anything but its symbol. */
      ['p1', 'payroll', 'open', null, 1, 2, { run: 'r1', period: '2026-10', asset: NIGHT.code, symbol: 'NIGHT', paid: 'publicly' }],
      ['p2', 'add-signer', 'open', null, 1, 2, null],
    ]);
    /* RED WHEN: the chain is read at any account or indexer but the company's own and the one the person's wallet names, or with a seat's secret. */
    expect(chain.asked).toEqual([{ account: 'c0'.repeat(32), indexer: kr.indexer, chainIds: ['cc'] }]);
  });

  /*
   * The company of 21 Oct: its founding signer alone at one approval, and the three proposals that set it up, raised by
   * that signer's device and filed signed by that signer's seat - its pay-record key, a vault's adoption and that vault's
   * first secret. The sealed bodies name a signer id the roster does not hold, and the service says each was withdrawn.
   */
  it("READS THE 21 OCT COMPANY'S THREE PROPOSALS AS THE CHAIN HOLDS THEM, 1 OF 1, RAISED BY ITS FOUNDER, EACH SAID FOR WHAT IT DOES", async () => {
    const { readCompany } = await load();
    const founder = newSigningKeypair().secret;
    const was = kr.account;
    kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 'sgn_founder01', name: 'Priya', signingPublicKey: signingPublicKeyOf(founder).toUpperCase() }] };
    const filed = (n: number, kind: string) => ({
      ...signProposalFiling('c1', {
        id: newProposalId(), digest: `${n}d`.repeat(32) as Hex, chainId: `${n}c`.repeat(32) as Hex, keyEpoch: 1, createdAt: '2026-10-21T09:00:00.000Z',
        sealed: sealRecord('proposals', 'c1', { kind, summary: '', proposedBy: 'sgn_notonroster', approvals: [] }, VK),
      }, founder),
      accountId: 'c1', status: 'cancelled', approvalCount: 0,
    });
    const [payKey, adopt, secret] = [filed(1, 'pay-key'), filed(2, 'adopt-vault'), filed(3, 'vault-secret')];
    kr.answers[ROUTE('/proposals')] = [payKey, adopt, secret];
    kr.named = { proposal: [payKey.id, adopt.id, secret.id] };
    const at = Date.parse('2026-10-21T09:00:30.000Z');
    chain.rounds = {
      [payKey.chainId]: { held: 'closed', approvals: 1, needed: 1, raisedAt: at, closedBy: ['sealPayKey'] },
      [adopt.chainId]: { held: 'closed', approvals: 1, needed: 1, raisedAt: at, closedBy: ['adopt'] },
      [secret.chainId]: { held: 'open', approvals: 1, needed: 1, raisedAt: at },
    };
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      /* RED WHEN: a proposal's status is the service's, its count the sealed list's, its bar not the chain's, its raiser matched by the sealed signer id, or any of the three kinds said as a change to the company. */
      expect(c.proposals.value.map((p) => [p.kind, p.status, p.approvals, p.needed, p.raisedBy, p.raisedAt])).toEqual([
        ['pay-key', 'executed', 1, 1, 'Priya', new Date(at).toISOString()],
        ['adopt-vault', 'executed', 1, 1, 'Priya', new Date(at).toISOString()],
        ['vault-secret', 'approved', 1, 1, 'Priya', new Date(at).toISOString()],
      ]);
    } finally {
      kr.account = was;
    }
  });

  /* RED WHEN: a run the chain holds charged to its period, or a proposal at the bar it was raised needing, reads as waiting; or one short of it, or with no bar read, reads approved. */
  it('reads a proposal held cleared, or held at its bar, as approved, and one short of it, or with no bar read, as waiting', async () => {
    const { readCompany } = await load();
    const statusWhen = async (round: unknown) => {
      chain.rounds = { cc: round };
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      return c.proposals.value[0]!.status;
    };
    expect(await statusWhen({ held: 'cleared', approvals: 1, needed: 2 })).toBe('approved');
    expect(await statusWhen({ held: 'open', approvals: 2, needed: 2 })).toBe('approved');
    expect(await statusWhen({ held: 'open', approvals: 1, needed: 2 })).toBe('open');
    expect(await statusWhen({ held: 'open', approvals: 5 })).toBe('open');
    expect(await statusWhen({ held: 'closed', approvals: 2, needed: 2, closedBy: ['cancel'] })).toBe('cancelled');
    /* RED WHEN: a run the chain closed past its window, or closed by calls not read, is said as withdrawn when nobody withdrew it. */
    expect(await statusWhen({ held: 'closed', approvals: 2, needed: 2, closedBy: ['closeExpiredRun'] })).toBe('expired');
    expect(await statusWhen({ held: 'closed', approvals: 2, needed: 2, closedBy: [] })).toBe('closed');
    expect(await statusWhen({ held: 'closed', approvals: 2, needed: 2 })).toBe('closed');
    expect(await statusWhen({ held: 'closed', approvals: 2, needed: 2, closedBy: ['cancel', 'closeExpiredRun'] })).toBe('closed');
    expect(await statusWhen({ held: 'closed', approvals: 2, needed: 2, closedBy: ['execute'] })).toBe('executed');
  });

  /* RED WHEN: a status the service lists, and not the chain's, decides whether Pay or Retry is offered. */
  it('offers Pay only on the chain\'s approval, whatever the service lists, and Retry on a run closed past its window or closed unread', async () => {
    const m = await load();
    const listing = (status: string) => {
      kr.answers[ROUTE('/proposals')] = [sealedProposal('p1', status, { approvalRound: { state: 'short', approvals: 2, threshold: 2 } })];
      kr.named = { proposal: ['p1'] };
    };
    const read = async () => {
      const c = await m.readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      return c.proposals;
    };
    const leg = { proposal: 'p1', form: 'shielded', paidOnChain: 'none' } as const;
    listing('approved');
    chain.rounds = { cc: { held: 'open', approvals: 1, needed: 2 } };
    const short = await read();
    expect(short.of === 'read' && short.value[0]!.status).toBe('open');
    expect(m.canPay(leg as never, short)).toBe(false);
    chain.rounds = { cc: { held: 'open', approvals: 2, needed: 2 } };
    expect(m.canPay(leg as never, await read())).toBe(true);
    const unpaid = { ...leg, unpaid: [0], amounts: [1n], leaves: ['01'], closesAt: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    for (const closedBy of [['closeExpiredRun'], [], ['cancel']]) {
      listing('cancelled');
      chain.rounds = { cc: { held: 'closed', approvals: 2, needed: 2, closedBy } };
      /* RED WHEN: a leg whose run closed unpaid, however it closed, is not offered Retry before its window would have closed. */
      expect(m.canRetry(unpaid as never, await read(), Date.now()), JSON.stringify(closedBy)).toBe(true);
    }
  });

  /*
   * RED WHEN: a proposal the company's records do not name, one sealed under an older key, or one whose filing this
   * device does not believe is read as the service gave it, or takes every other proposal down with it; or one the
   * records name and the service did not give is not listed.
   */
  it('LISTS A PROPOSAL THE COMPANY\'S RECORDS NAME AND THE SERVICE WITHHELD, OR LEAVE OUT, OR WHOSE FILING IS NOT BELIEVED, AS UNREADABLE BY ITS ID, AND READS THE REST', async () => {
    const { readCompany } = await load();
    const founder = newSigningKeypair().secret;
    const was = kr.account;
    kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 'sgn_founder01', name: 'Priya', signingPublicKey: signingPublicKeyOf(founder) }] };
    const filed = (n: number) => ({
      ...signProposalFiling('c1', {
        id: newProposalId(), digest: `${n}d`.repeat(32) as Hex, chainId: `${n}c`.repeat(32) as Hex, keyEpoch: 1, createdAt: new Date(Date.UTC(2026, 9, 20 + n)).toISOString(),
        sealed: sealRecord('proposals', 'c1', { kind: 'set-threshold', summary: '', proposedBy: 'x', approvals: [] }, VK),
      }, founder),
      accountId: 'c1', status: 'open', approvalCount: 0,
    });
    const [kept, unnamed, older, unbelieved] = [filed(1), filed(2), filed(3), filed(4)];
    kr.answers[ROUTE('/proposals')] = [kept, unnamed, older, unbelieved];
    /* `prp_withheld01` the records name and the service does not give. */
    kr.named = { proposal: [kept.id, older.id, unbelieved.id, 'prp_withheld01'] };
    kr.leftOut = [older.id];
    kr.unbelieved = [unbelieved.id];
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      expect(c.proposals.value.map((p) => [p.id, p.kind, p.status, p.raisedBy])).toEqual([
        [kept.id, 'set-threshold', 'open', 'Priya'],
        ['prp_withheld01', 'unreadable', 'unreadable', null],
        [older.id, 'unreadable', 'unreadable', null], [unnamed.id, 'unreadable', 'unreadable', null], [unbelieved.id, 'unreadable', 'unreadable', null],
      ]);
      /* RED WHEN: a proposal the records name and the service withheld is left off the list, or takes the proposals it did give down with it. */
      expect(kr.listedFrom).not.toContain('proposal:proposal:prp_withheld01');
      expect(kr.listedFrom).toContain(`proposal:proposal:${kept.id}`);
    } finally {
      kr.account = was;
    }
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
      { vault: 'ab'.repeat(32), createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee', adopted: true, approvals: 2 },
      { vault: 'cd'.repeat(32), createdAt: '2026-09-02T00:00:00.000Z', standing: 'unknown', adopted: true, approvals: 2 },
    ]);
  });

  /* RED WHEN: a vault's row does not carry the approvals the chain holds for that vault (its own number where it has one, whatever the case of its address, else the company's), or carries a number the chain did not give (a vault number below one, or no company number to fall back on). */
  it('reads the approvals each vault asks for: its own number, else the company\'s, and none where the chain gave none', async () => {
    const { readCompany } = await load();
    const numbers = async () => {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.vaults.of !== 'read') throw new Error('not read');
      return c.vaults.value.map((v) => [v.vault.slice(0, 2), v.approvals]);
    };
    kr.approvals = 2;
    kr.vaultThresholds = [{ vault: 'AB'.repeat(32), threshold: 3 }];
    expect(await numbers()).toEqual([['ab', 3], ['cd', 2]]);
    kr.vaultThresholds = [{ vault: 'ab'.repeat(32), threshold: 0 }];
    expect(await numbers()).toEqual([['ab', undefined], ['cd', 2]]);
    kr.approvals = undefined;
    kr.vaultThresholds = [{ vault: 'ab'.repeat(32), threshold: 3 }];
    expect(await numbers()).toEqual([['ab', 3], ['cd', undefined]]);
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
    /* RED WHEN: the name is read through the judge that may open the wallet's window (`companyKeysFor`): the second count is its uses. */
    expect([info.asked, kr.asking]).toEqual([[{ vault, keys: expect.objectContaining({ key: VK }), account: 'c1' }], 0]);
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
    expect([...(await session.approvalsNeededFor('u1')).entries()]).toEqual([['c1', { needed: 2, because: 'account' }]]);
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

describe('what an open proposal carries for the wallet to approve it', () => {
  const V = 'ab'.repeat(32);
  const W = 'cd'.repeat(32);
  const LEAF = '4e'.repeat(32);
  /* A proposal raised on the chain as 'cc', its body sealed under the company's key as a device seals it. */
  const proposal = (id: string, kind: string, body: Record<string, unknown>) => sealedProposal(id, 'open', {
    kind, vault: V, sealedPayload: seal(canonical({ ...body, __change: { salt: '5a'.repeat(32) } }), VK),
  });
  const ONE = newOneOffId();
  /* Written out, as the payees above are: the address encoder in this page's window reads another window's bytes. */
  const PAYEE = REAL_ADDRESSES['2 unshielded']!.bech32;
  const oneOffAt = ROUTE(`/records/transfer/${ONE}/1`);
  const fileTheOneOff = (proposalId: string) => {
    oneOffs.opened = { [ONE]: {
      vault: V, asset: NIGHT.code, token: NIGHT.ledger.unshielded, amount: '250',
      payee: { ref: null, name: 'Northwind Paper', address: PAYEE }, reason: 'Invoice 118, office paper',
      proposal: { id: proposalId, chainId: 'cc' },
    } };
    const rec = { company: 'c1', kind: 'transfer' as const, id: ONE, version: 1, keyEpoch: 1, sealed: seal('{}', VK), wrapped: [] };
    kr.answers[oneOffAt] = { kind: 'transfer', id: ONE, version: 1, filed: toCompanyWire(signCompanyFiling(rec, SEAT)) };
  };
  /* An invitation by address, as its sealed body carries it: signed terms naming the address it seats. */
  const BY_ADDRESS = { invited: { terms: { invite: { address: 'a7'.repeat(32) } } } };
  const invited = (coinPublicKey: string | null) => ({
    chainId: 'cc', summary: '', proposalSalt: 'aa', coinPublicKey,
    invited: { terms: { name: 'Sam', role: 'approver', invite: { address: 'a7'.repeat(32), salt: 'cd'.repeat(32), scope: 'ef'.repeat(32), threshold: '2' } } },
  });
  /* The run the payroll proposal pays one leg of: two people paid publicly in NIGHT, and one privately the proposal does not pay. */
  const theRun = () => sealedRun('r9', '2026-11', 'proposed', [
    { id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5n, paidTo: PUBLIC_ADDRESS, form: 'unshielded' },
    { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 7n, paidTo: PUBLIC_ADDRESS, form: 'unshielded' },
    { id: 'e3', name: 'Cy', asset: NIGHT.code, amount: 11n, paidTo: PRIVATE_ADDRESS },
  ], { payout: { [NIGHT_PUBLICLY]: { vault: 'ee'.repeat(32), payees: 9n, leaves: [] } } });
  const rowsOf = async (proposals: Array<{ id: string }>) => {
    kr.answers[ROUTE('/proposals')] = proposals;
    kr.named = { proposal: proposals.map((p) => p.id) };
    const { readCompany } = await load();
    const { canApprove } = await import('./proposal-acts.js');
    const c = await readCompany('u1', 'c1');
    if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
    return Object.fromEntries(c.proposals.value.map((r) => [r.id, { kind: r.kind, asks: r.asks, approvable: canApprove(r), ...(r.asksUnread === undefined ? {} : { unread: r.asksUnread }) }]));
  };
  beforeEach(() => { bya.bodies = {}; bya.asked = []; bya.throws = false; oneOffs.opened = {}; });

  /*
   * RED WHEN: a kind's row does not carry every field its approval in the wallet checks, a field is read from anything
   * but the company's sealed records (the proposal's own body, its run, its one-off, its invitation), a policy proposal
   * reaches the screen under the kind it is sealed as rather than as a change of policy, or a kind whose fields are all
   * read is not offered Approve.
   */
  it('carries, for every kind, what the wallet checks before it approves, read from the company\'s sealed records', async () => {
    kr.answers[ROUTE('/runs')] = [theRun()];
    fileTheOneOff('q-one');
    bya.bodies['q-add'] = invited('0c'.repeat(32));
    const rows = await rowsOf([
      proposal('p1', 'payroll', { runId: 'r9' }),
      proposal('q-one', 'transfer', { oneOff: { id: ONE, version: 1 } }),
      proposal('q-add', 'add-signer', BY_ADDRESS),
      proposal('q-out', 'remove-signer', { leaf: LEAF, newThreshold: 1 }),
      proposal('q-out0', 'remove-signer', { leaf: LEAF }),
      proposal('q-bar', 'set-threshold', { newThreshold: 2 }),
      proposal('q-vbar', 'set-vault-threshold', { vault: W, newThreshold: 3 }),
      proposal('q-pbar', 'set-policy-bar', { newPolicyBar: 2 }),
      proposal('q-pol', 'set-spending-policy', { vault: W, assetKey: '11'.repeat(32), commitment: '22'.repeat(32) }),
      proposal('q-adopt', 'adopt-vault', { vault: W }),
      proposal('q-secret', 'vault-secret', { vault: W, root: '00'.repeat(32), payees: '0', opensAt: '1', closesAt: '2' }),
      proposal('q-key', 'pay-key', { commitment: '77'.repeat(32) }),
    ]);
    expect(rows).toEqual({
      /* The vault is the one the sealed proposal names, never the run's served payout. */
      p1: { kind: 'payroll', approvable: true, asks: { run: 'r9', period: '2026-11', list: 'employees', vault: V, token: NIGHT.code, form: 'public', payees: 2, total: 12n } },
      'q-one': { kind: 'transfer', approvable: true, asks: { vault: V, token: NIGHT.code, amount: '250', payee: PAYEE, reason: 'Invoice 118, office paper', payeeName: 'Northwind Paper' } },
      'q-add': { kind: 'add-signer', approvable: true, asks: { personName: 'Sam', role: 'approver', address: 'a7'.repeat(32), scope: 'ef'.repeat(32), coinKey: '0c'.repeat(32), threshold: '2' } },
      'q-out': { kind: 'remove-signer', approvable: true, asks: { leaf: LEAF, threshold: 1 } },
      'q-out0': { kind: 'remove-signer', approvable: true, asks: { leaf: LEAF } },
      'q-bar': { kind: 'set-threshold', approvable: true, asks: { threshold: 2 } },
      'q-vbar': { kind: 'set-vault-threshold', approvable: true, asks: { threshold: 3, vault: W } },
      'q-pbar': { kind: 'set-policy-bar', approvable: true, asks: { kind: 'policy-bar', bar: 2 } },
      /* RED WHEN: a spending policy is not offered Approve, or its row names anything of the policy but its vault: the terms open only in the signer's wallet. */
      'q-pol': { kind: 'set-spending-policy', approvable: true, asks: { kind: 'spending-policy', vault: W } },
      'q-adopt': { kind: 'adopt-vault', approvable: true, asks: { vault: W } },
      'q-secret': { kind: 'vault-secret', approvable: true, asks: { vault: W } },
      'q-key': { kind: 'pay-key', approvable: true, asks: {} },
    });
    /* RED WHEN: reading what a proposal asks sends the service anything but the one-off's own record name, or a person, amount, payee or name. */
    expect(kr.asked.filter((p) => p.includes('/records/'))).toEqual([oneOffAt]);
    /* Read by whole parts of each path, so a random one-off id that happens to hold the same letters is not taken for a leak. */
    const parts = (p: string): readonly string[] => decodeURIComponent(p).split(/[/?&=]/u);
    const told = ['250', 'e1', 'Sam', 'Ana', 'Northwind Paper', 'Invoice 118, office paper'];
    expect(kr.asked.filter((p) => parts(p).some((x) => told.includes(x) || /Northwind|Invoice|Sam|Ana/u.test(x)))).toEqual([]);
  });

  /*
   * RED WHEN: a row missing a field its approval checks is offered Approve: an invitation with no coin key, a one-off
   * whose record the service does not give or that another proposal raised, a payroll proposal no run names, a removal
   * naming no seat, a spending policy whose record names no vault, or a proposal no longer waiting.
   */
  it('offers no Approve on a row missing a field its approval needs, and reads nothing for one not waiting', async () => {
    bya.bodies['q-add'] = invited(null);
    chain.rounds = { ...chain.rounds, dd: { held: 'closed', approvals: 2, needed: 2, closedBy: ['changeThreshold'] } };
    const rows = await rowsOf([
      proposal('q-add', 'add-signer', BY_ADDRESS),
      proposal('q-one', 'transfer', { oneOff: { id: ONE, version: 1 } }),
      proposal('q-run', 'payroll', { runId: 'r-none' }),
      proposal('q-out', 'remove-signer', { newThreshold: 1 }),
      proposal('q-pol', 'set-spending-policy', { assetKey: '11'.repeat(32), commitment: '22'.repeat(32) }),
      /* Carried out: the chain holds its round closed. */
      { ...proposal('q-done', 'set-threshold', { newThreshold: 2 }), chainId: 'dd' },
    ]);
    expect(Object.values(rows).map((r) => r.approvable)).toEqual([false, false, false, false, false, false]);
    expect(rows['q-done']!.kind).toBe('set-threshold');
    expect(rows['q-pol']).toEqual({ kind: 'set-spending-policy', approvable: false, asks: undefined, unread: 'not-read' });
    expect([rows['q-add']!.asks, rows['q-one']!.asks, rows['q-run']!.asks, rows['q-out']!.asks, rows['q-done']!.asks]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    /*
     * RED WHEN: a waiting proposal of a kind this page approves whose record, run or one-off was not read or believed here
     * is not marked so (and would be told as a kind this page cannot approve), or a kind this page does not approve, or a
     * proposal no longer waiting, is marked as not read.
     */
    expect(Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.unread ?? null]))).toEqual({
      'q-add': 'not-read', 'q-one': 'not-read', 'q-run': 'not-read', 'q-out': 'not-read', 'q-pol': 'not-read', 'q-done': null,
    });
    /* RED WHEN: a one-off raised by another proposal is carried as this one's. */
    fileTheOneOff('q-other');
    expect((await rowsOf([proposal('q-one', 'transfer', { oneOff: { id: ONE, version: 1 } })]))['q-one']).toEqual({ kind: 'transfer', approvable: false, asks: undefined, unread: 'not-read' });
  });

  /*
   * A one-off payment the chain holds approved stays on the chain once it is paid, so whether to offer its press is read
   * off the chain by the payment leaf the worker built from its record (`leaf` on what the worker opened), through the
   * same paid-leaves read the runs use.
   */
  describe('a one-off payment the chain holds approved', () => {
    const PAID_LEAF = '6d'.repeat(32);
    const OTHER_LEAF = '7e'.repeat(32);
    const ASKS = { vault: V, token: NIGHT.code, amount: '250', payee: PAYEE, reason: 'Invoice 118, office paper', payeeName: 'Northwind Paper' };
    const approvedOneOff = async (leaf: string | null) => {
      fileTheOneOff('q-one');
      (oneOffs.opened[ONE] as Record<string, unknown>).leaf = leaf;
      chain.rounds = { cc: { held: 'open', approvals: 2, needed: 2 } };
      kr.answers[ROUTE('/proposals')] = [proposal('q-one', 'transfer', { oneOff: { id: ONE, version: 1 } })];
      kr.named = { proposal: ['q-one'] };
      const { readCompany, openOneOffsOf } = await load();
      const { canApprove } = await import('./proposal-acts.js');
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      const row = c.proposals.value.find((r) => r.id === 'q-one')!;
      return { status: row.status, paidOnChain: row.paidOnChain, asks: row.asks, press: canApprove(row), listed: openOneOffsOf(c.proposals.value, V).map((o) => o.id) };
    };

    /* RED WHEN: a one-off the chain holds approved and shows not paid is not offered its press on the vault's page, or is offered it without what the wallet checks. */
    it('offers its press while the chain shows its payment not made', async () => {
      chain.paid = {};
      expect(await approvedOneOff(PAID_LEAF)).toEqual({ status: 'approved', paidOnChain: false, asks: ASKS, press: true, listed: ['q-one'] });
      /* RED WHEN: the payment is asked about by anything but the leaf the worker built from the one-off's record. */
      expect(chain.paidAsked.map((a) => a.leaves)).toContainEqual([PAID_LEAF]);
    });

    /* RED WHEN: a one-off the chain shows paid is offered a press, which would send a signer to pay it again. */
    it('offers no press once the chain shows it paid', async () => {
      chain.paid = { [PAID_LEAF]: true };
      expect(await approvedOneOff(PAID_LEAF)).toEqual({ status: 'approved', paidOnChain: true, asks: ASKS, press: false, listed: [] });
    });

    /*
     * RED WHEN: a payment leaf the chain shows paid is taken as this one-off's when the worker built this one-off another
     * leaf, or an answer that does not name this one-off's leaf is read as paid or as unpaid.
     */
    it('does not take another payment the chain shows paid as this one\'s', async () => {
      chain.paidAnswer = { [OTHER_LEAF]: true, [PAID_LEAF]: false };
      expect(await approvedOneOff(PAID_LEAF)).toMatchObject({ paidOnChain: false, press: true });
      chain.paidAnswer = { [OTHER_LEAF]: true };
      expect(await approvedOneOff(PAID_LEAF)).toMatchObject({ paidOnChain: undefined, press: false });
    });

    /* RED WHEN: a one-off whose payment was not read, for the worker built no leaf or the chain could not be read, is offered a press or said to be paid or unpaid. */
    it('offers no press and says nothing of its payment when that was not read', async () => {
      expect(await approvedOneOff(null)).toEqual({ status: 'approved', paidOnChain: undefined, asks: ASKS, press: false, listed: [] });
      chain.paidFails = true;
      expect(await approvedOneOff(PAID_LEAF)).toEqual({ status: 'approved', paidOnChain: undefined, asks: ASKS, press: false, listed: [] });
    });

    /* RED WHEN: a one-off the chain no longer holds, withdrawn or closed, is offered a press or has its payment asked about. */
    it('offers no press on one the chain holds closed', async () => {
      fileTheOneOff('q-one');
      (oneOffs.opened[ONE] as Record<string, unknown>).leaf = PAID_LEAF;
      chain.rounds = { cc: { held: 'closed', approvals: 2, needed: 2, closedBy: ['cancel'] } };
      const rows = await rowsOf([proposal('q-one', 'transfer', { oneOff: { id: ONE, version: 1 } })]);
      expect(rows['q-one']).toEqual({ kind: 'transfer', approvable: false, asks: undefined });
      expect(chain.paidAsked.flatMap((a) => a.leaves)).not.toContain(PAID_LEAF);
    });
  });

  /*
   * RED WHEN: a retry of some of a leg's people carries no asks, or asks other than the people at the positions it names
   * on that leg, as the run's seal holds them; or a retry the seal does not hold, served beside it, is read as one.
   */
  it('carries a retry\'s people from the run\'s seal, at the positions the retry names on its leg, and no retry served beside the seal', async () => {
    const retry = { originalIndices: [1], root: '9a'.repeat(32), payees: 1n, opensAt: 1n, closesAt: 2n, vault: V, proposalId: 'q-retry' };
    const run = sealedRun('r9', '2026-11', 'proposed', [
      { id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5n, paidTo: PUBLIC_ADDRESS, form: 'unshielded' },
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 7n, paidTo: PUBLIC_ADDRESS, form: 'unshielded' },
    ], { payout: { [NIGHT_PUBLICLY]: { vault: V, payees: 2n, leaves: [], retries: [retry] } } });
    kr.answers[ROUTE('/runs')] = [run];
    expect((await rowsOf([proposal('q-retry', 'payroll', { runId: 'r9' })]))['q-retry']).toEqual({
      kind: 'payroll', approvable: true, asks: { run: 'r9', period: '2026-11', list: 'employees', vault: V, token: NIGHT.code, form: 'public', payees: 1, total: 7n },
    });
    /* The same retry served beside a seal that holds none. */
    const bare = sealedRun('r9', '2026-11', 'proposed', [
      { id: 'e1', name: 'Ana', asset: NIGHT.code, amount: 5n, paidTo: PUBLIC_ADDRESS, form: 'unshielded' },
      { id: 'e2', name: 'Bo', asset: NIGHT.code, amount: 7n, paidTo: PUBLIC_ADDRESS, form: 'unshielded' },
    ]);
    kr.answers[ROUTE('/runs')] = [{ ...bare, payout: { [NIGHT_PUBLICLY]: { vault: V, payees: 2n, leaves: [], retries: [retry] } } }];
    expect((await rowsOf([proposal('q-retry', 'payroll', { runId: 'r9' })]))['q-retry']).toEqual({ kind: 'payroll', approvable: false, asks: undefined, unread: 'not-read' });
  });

  /* RED WHEN: Approve is offered on a proposal the network has never held raised, or it is not marked as not raised. */
  it('offers no Approve on a proposal the network has never held, and says it is not raised yet', async () => {
    chain.rounds = { cc: { held: 'never', approvals: 0 } };
    expect((await rowsOf([proposal('q-bar', 'set-threshold', { newThreshold: 2 })]))['q-bar']).toEqual({ kind: 'set-threshold', approvable: false, asks: undefined, unread: 'not-raised' });
    /* RED WHEN: an invitation naming no address, which this page does not approve, is marked as one whose record was not read. */
    chain.rounds = { cc: { held: 'open', approvals: 1, needed: 2 } };
    expect((await rowsOf([proposal('q-seat', 'add-signer', {})]))['q-seat']).toEqual({ kind: 'add-signer', approvable: false, asks: undefined });
  });
});

describe('who may withdraw a proposal, and its count', () => {
  /*
   * RED WHEN: a proposal is marked as raised by this device's seat because its raiser bears the person's name, or one
   * filed with this seat's own key is not; or a row's count is the service's, not the chain's round.
   */
  it('marks a proposal as raised here only when its believed filing is signed with this seat\'s key, never by a name, and counts as the chain does', async () => {
    const { readCompany } = await load();
    const mine = newSigningKeypair().secret;
    const namesake = newSigningKeypair().secret;
    const was = kr.account;
    kr.ownKey = signingPublicKeyOf(mine);
    kr.account = { id: 'c1', name: 'Northwind', signers: [
      { id: 's1', name: 'Priya', signingPublicKey: signingPublicKeyOf(mine) }, { id: 's2', name: 'Priya', signingPublicKey: signingPublicKeyOf(namesake) },
    ] };
    const filed = (n: number, by: Uint8Array | string) => ({
      ...signProposalFiling('c1', {
        id: newProposalId(), digest: `${n}d`.repeat(32) as Hex, chainId: `${n}c`.repeat(32) as Hex, keyEpoch: 1, createdAt: '2026-10-21T09:00:00.000Z',
        sealed: sealRecord('proposals', 'c1', { kind: 'set-threshold', summary: '', proposedBy: 'x', approvals: [] }, VK),
      }, by as never),
      accountId: 'c1', status: 'executed', approvalCount: 9,
    });
    const [ours, theirs] = [filed(1, mine), filed(2, namesake)];
    kr.answers[ROUTE('/proposals')] = [ours, theirs];
    kr.named = { proposal: [ours.id, theirs.id] };
    chain.rounds = { [ours.chainId]: { held: 'open', approvals: 1, needed: 2, raisedAt: 1 }, [theirs.chainId]: { held: 'open', approvals: 1, needed: 2, raisedAt: 1 } };
    try {
      const c = await readCompany('u1', 'c1');
      if (c.of !== 'open' || c.proposals.of !== 'read') throw new Error('not read');
      expect(c.proposals.value.map((p) => [p.id, p.raisedBy, p.raisedByYou, p.status, p.approvals])).toEqual([
        [ours.id, 'Priya', true, 'open', 1], [theirs.id, 'Priya', false, 'open', 1],
      ]);
    } finally {
      kr.account = was;
    }
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
      proposal: 'p1', name: 'Sam', role: 'approver', address: 'ab'.repeat(32), scope: 'ef'.repeat(32), coinKey: '0c'.repeat(32), status: 'open', approvals: 1,
      seat: null, threshold: null,
    }] });
    /* Each proposal is opened once, whether for this list or for what its row asks the wallet to check. */
    expect(bya.asked.map((a) => [a.id, a.account]).sort()).toEqual([['p1', 'c1'], ['p2', 'c1']]);
    expect((bya.asked[0]!.keys as { key: string }).key).toBe(VK);
    expect(kr.asked.filter((p) => p.endsWith('/proposals'))).toHaveLength(1);
  });

  /* RED WHEN: proposals that cannot be read are told as no signer invited, or a core that cannot open one takes the proposals' own list down with it. */
  /* RED WHEN: a seat request the chain does not show the proposal took, filed by the service or another invitee, hides Approve; or the seat the chain says it took does not reach the signers page, so Approve stays on an invitation carried out. */
  it('reads the seat each invitation took from the chain alone, with the entry waiting at that seat, and never from a request naming it', async () => {
    const SEAT = '5e'.repeat(32);
    /* Both proposals carry one identity on the chain of thirty-two bytes, the only kind the chain is asked about. */
    const CC = 'cc'.repeat(32); chain.rounds = { [CC]: chain.rounds['cc'] }; bya.bodies['p1'] = { ...body('Sam'), chainId: CC };
    kr.answers[ROUTE('/proposals')] = (kr.answers[ROUTE('/proposals')] as Array<Record<string, unknown>>).map((p) => ({ ...p, chainId: CC }));
    const forged = { name: 'Sam', role: 'approver', signingPublicKey: 'b1'.repeat(32), wrappingPublicKey: 'b2'.repeat(32), leafCommitment: SEAT, invited: { terms: { proposal: CC.toUpperCase() } } };
    kr.answers[ROUTE()] = { ...(kr.answers[ROUTE()] as object), pendingSigners: [{ id: 'sX', userId: 'u8', createdAt: 'x', sealed: sealToInbox(forged, inboxPublicKey(VK, 'c1')) }] };
    const was = kr.account; kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active' }, { id: 'sB', name: 'Sam', status: 'pending', leafCommitment: SEAT }] };
    chainSeats.took = { [CC]: null }; chainSeats.asked = []; chainSeats.fails = false;
    try {
      const asked = await open();
      expect(asked.signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: null }] });
      /* The seats taken are read once for the page, for both the standings and the invitations. */
      expect(chainSeats.asked).toEqual([[CC]]);
      chainSeats.took = { [CC]: SEAT.toUpperCase() }; expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: 'sB' } }] });
      chainSeats.took = { [CC]: '6f'.repeat(32) }; expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: null } }] });
      chainSeats.fails = true; const failed = await open();
      /* RED WHEN: a read of the seats taken that failed is shown as no seat taken, so one seat is listed twice: as an invitation with no seat and as a seat someone invited took. */
      expect([failed.signersInvited, failed.signerStandings]).toEqual([{ of: 'unreadable' }, { of: 'unreadable' }]);
      /* RED WHEN: an answer that leaves out a proposal asked about is read as no seat taken by it. */
      chainSeats.fails = false; chainSeats.took = {}; expect((await open()).signersInvited).toEqual({ of: 'unreadable' });
      /* The seat the proposal took, which the roster read waits for and no roster entry names yet, is listed once, under its invitation. */
      chainSeats.took = { [CC]: SEAT }; kr.seats = [SEAT];
      kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active' }], waited: [SEAT] };
      const once = await open();
      expect(once.signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: null } }] });
      /* RED WHEN: the page does not hand the seats invitations by address took to where each signer stands, so that seat is also listed as someone invited. */
      expect(once.signerStandings?.of === 'read' && once.signerStandings.value.filter((x) => x.waiting === true)).toEqual([]);
      kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active' }, { id: 'sB', name: 'Sam', status: 'active', leafCommitment: SEAT.toUpperCase() }] };
      /* RED WHEN: an invitation stays waiting after the chain shows its seat taken and the believed roster holds an active signer at that seat. */
      expect((await open()).signersInvited).toEqual({ of: 'read', value: [] });
      kr.account = { id: 'c1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya', status: 'active', leafCommitment: SEAT }] };
      chainSeats.took = { [CC]: '6f'.repeat(32) };
      /* RED WHEN: an active signer at another seat than the one the chain says the proposal took ends the invitation's wait. */
      expect((await open()).signersInvited).toMatchObject({ of: 'read', value: [{ proposal: 'p1', seat: { signer: null } }] });
    } finally {
      kr.account = was; chainSeats.took = {}; chainSeats.fails = false;
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

describe('the vendors and the one-off payments a vault\'s page offers', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'ven_aa', name: 'Vee', address: PUBLIC_ADDRESS, standing: 'active', handedOver: false, termsKind: 'one-off', asset: null, monthly: null, paid: 'publicly',
    startedAt: '2026-02-01', endDate: null, admittedAt: null, admitBy: 'fingerprint', notPayable: null, ...over,
  }) as never;

  /* RED WHEN: the payee list offers a vendor with no address, one who has left or has not joined, or one this device will not pay, or leaves out one who can be paid. */
  it('offers as payees only the active vendors with an address that this device would pay', async () => {
    const { payableVendors } = await load();
    expect(payableVendors([
      row({}), row({ id: 'ven_bb', name: 'Bo', standing: 'leaver' }), row({ id: 'ven_cc', name: 'Cy', address: null }), row({ id: 'ven_dd', name: 'Di', notPayable: 'no keys' }),
      row({ id: 'ven_ee', name: 'Ed', standing: 'waiting-for-check' }), row({ id: 'ven_ff', name: 'Fay', address: PRIVATE_ADDRESS }),
    ])).toEqual([{ id: 'ven_aa', name: 'Vee', address: PUBLIC_ADDRESS }, { id: 'ven_ff', name: 'Fay', address: PRIVATE_ADDRESS }]);
  });

  const proposal = (over: Record<string, unknown> = {}, asks: Record<string, unknown> = {}) => ({
    id: 'prop_0001', kind: 'transfer', status: 'open', raisedBy: 'Sam', approvals: 1, needed: 2, raisedAt: '2026-10-21T00:00:00.000Z', pays: null,
    asks: { vault: V1, token: NIGHT.code, amount: '2500000', payee: PUBLIC_ADDRESS, reason: 'Invoice 118', ...asks }, ...over,
  }) as never;
  const V1 = 'ab'.repeat(32);

  /* RED WHEN: a vault's list shows a payment of another vault, one the chain no longer holds open, another kind of proposal, or one that carries nothing to approve, or loses the figure, the name or the approvals. */
  it('lists the open one-off payments of one vault, each with its amount made from the units it pays, its payee by name else address, and its approvals', async () => {
    const { openOneOffsOf } = await load();
    const rows = openOneOffsOf([
      proposal(), proposal({ id: 'prop_0002' }, { vault: 'cd'.repeat(32) }), proposal({ id: 'prop_0003', status: 'approved' }), proposal({ id: 'prop_0004', kind: 'payroll' }),
      proposal({ id: 'prop_0005', asks: undefined }), proposal({ id: 'prop_0006' }, { payeeName: 'Northwind Paper', amount: '1', token: 'ef'.repeat(32) }),
      proposal({ id: 'prop_0007' }, { amount: 'many', payee: PRIVATE_ADDRESS }),
    ], V1.toUpperCase());
    expect(rows.map((r) => [r.id, r.payee, r.leg?.pays[0]?.address ?? null, r.reason, r.approvals, r.needed])).toEqual([
      ['prop_0001', PUBLIC_ADDRESS, PUBLIC_ADDRESS, 'Invoice 118', 1, 2], ['prop_0006', 'Northwind Paper', PUBLIC_ADDRESS, 'Invoice 118', 1, 2],
      ['prop_0007', PRIVATE_ADDRESS, null, 'Invoice 118', 1, 2],
    ]);
    expect(rows.map((r) => r.amount)).toEqual([publicAmount(2_500_000n, NIGHT.decimals, NIGHT.symbol), null, null]);
    expect(rows[0]!.proposal.id).toBe('prop_0001');
    /* RED WHEN: the payment's facts are described for an address the page cannot place, or a public payment is described as private. */
    expect(rows.map((r) => r.leg?.form ?? null)).toEqual(['unshielded', 'unshielded', null]);
    expect(openOneOffsOf([proposal({}, { payee: PRIVATE_ADDRESS })], V1)[0]!.leg).toMatchObject({ form: 'shielded', paid: 'privately' });
    expect(rows[0]!.leg).toMatchObject({ people: 1, total: 2_500_000n, vault: V1, symbol: 'NIGHT', pays: [{ name: '', address: PUBLIC_ADDRESS, amount: publicAmount(2_500_000n, NIGHT.decimals, NIGHT.symbol) }] });
    expect(openOneOffsOf([proposal({}, { payee: 'not an address' })], V1)[0]!.leg).toBeNull();
  });
});
