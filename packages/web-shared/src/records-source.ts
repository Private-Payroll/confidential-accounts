/**
 * **THE ONE PLACE A DEVICE KNOWS WHERE THE COMPANY'S RECORDS ARE KEPT.** A `RecordSource` answers named asks about one
 * company (its account, its directory, its records, its record tree and its lists) and takes its writes, and nothing
 * else on the device names a company's service path. `serviceSource` answers them from the company's service, through the one
 * transport the device has (`ServiceCall`). Another source, one that reads the chain and the device alone, answers the
 * same asks. The asks made before a device holds a view of a company (an invitation taken by someone not yet one of
 * its members, a company being created) are named here too (`invitationSource`, `creationSource`).
 *
 * A source reads at most `READ_AT_ONCE` records in one ask, the most the service proves or reads in one request; the
 * company's view (`company-view.ts`) splits a longer ask into parts, so the source never splits one itself.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import type { Hex } from '../../../src/core/crypto.js';
import { manifestPaths, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import { PROVEN_AT_ONCE, type HeadersPage, type ProofsAsk, type ProofsGiven, type RecordName, type TreeHeader } from '../../../src/midnight/record-tree.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import { companyWirePaths, wirePaths, type CompanyRecordKind, type WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { HoldersMove } from './company-view-probe.js';
import type { ManifestService, TreeService } from './record-entered-here.js';
import { posted, type PathAsk } from './person-asks.js';

/** The device's one way to the service: a path, and how to ask it. `read` marks a POST that reads and changes nothing. */
export type ServiceCall = (path: string, init?: RequestInit & { read?: boolean }) => Promise<unknown>;

/** The most records one ask names: the most the service proves, or reads by name, in one request. */
export const READ_AT_ONCE = PROVEN_AT_ONCE;

/** One of the company's records, asked by kind and id: its newest version, or with `every` all of them. */
export interface CompanyRecordAsked { readonly kind: CompanyRecordKind; readonly id: string; readonly every?: boolean }

/** One record of one of the company's vaults: its newest version, or with `every` all of them. */
export interface VaultRecordAsked { readonly vault: string; readonly record: WireRecord; readonly every?: boolean }

/** The company's lists, each read whole in one ask. */
const LIST_KINDS = ['proposals', 'people', 'runs', 'invites', 'vaults', 'vault-key-offers'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** The company record each row of a list names, by the list's kind; a list not named here names none. */
const LISTED_KIND: Partial<Record<ListKind, CompanyRecordKind>> = { people: 'person' };

/**
 * Every company record a list answered with, at the version it answered: each row's `filed` record of the people list.
 * A row that does not name a record and a version names nothing here; reading the list refuses it as its reader does.
 */
export const listedRecords = (kind: ListKind, answer: unknown): readonly { readonly name: RecordName; readonly version: number }[] => {
  const listed = LISTED_KIND[kind];
  const rows = (answer as { readonly people?: unknown } | null)?.people;
  if (listed === undefined || !Array.isArray(rows)) return [];
  return rows.flatMap((row: { readonly filed?: { readonly id?: unknown; readonly version?: unknown } } | null) => {
    const f = row?.filed;
    return typeof f?.id === 'string' && Number.isInteger(f.version)
      ? [{ name: { store: 'company' as const, kind: listed, id: f.id }, version: f.version as number }] : [];
  });
};

/**
 * **WHAT A WRITE RESTS ON, OF AN ANSWER THAT CARRIES NO VERSION.** The view keeps these facts of each such answer it
 * serves, and reads them again from the service before it writes: a step that built its write on them stops if
 * another seat changed them meanwhile. Each is only what a write is built from and the service does not itself refuse
 * on:
 * - `handover` and `vendor-handover`: the inbox a person or vendor handed over, which an admission is built from;
 * - `invites`: each invitation's kind, who it is for, its role, who made it and whether it was withdrawn, never when
 *   it was accepted or who asked for a late seat, which move with no seat's act;
 * - `account`: its roster (the newest filed, and the sealed one it carries), the signers waiting to be admitted, the
 *   keys wrapped to its members, its key epoch, its count of signers and its members, which a roster, a vault's keys,
 *   an admission and a deposit are built from and sealed to.
 * Not compared, each for its reason: the people list (its rows are records, compared by their versions); proposals
 * and runs (the contracts check every approval and payout on the chain); the vaults list (worked out from the chain on
 * every read, so it moves with nothing changed; which vaults the account adopts is read from the chain with who holds
 * it); the vault-key offers (each is signed by its seat and folded against the account's signers, which are compared).
 */
export type ServedFact = 'account' | 'invites' | 'handover' | 'vendor-handover';

/** The list kinds whose answers are compared by their facts, and the fact each is. */
export const LIST_FACT: Partial<Record<ListKind, ServedFact>> = { invites: 'invites' };

/** `x` written the same way whatever order its fields came in. */
const steady = (x: unknown): string => JSON.stringify(x, (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v)) ?? 'null';

type Row = { readonly [field: string]: unknown } | null;
const rowsOf = (answer: unknown): readonly Row[] => (Array.isArray(answer) ? answer as Row[] : []);

/** The facts of `answer`, as `fact` names them, written so two reads of the same facts are equal. */
export const servedFactsOf = (fact: ServedFact, answer: unknown): string => {
  const a = (answer ?? null) as Row;
  switch (fact) {
    case 'handover': case 'vendor-handover': return steady(a?.['inbox'] ?? null);
    case 'invites': return steady(rowsOf(answer).map((r) => [r?.['kind'], r?.['subjectId'] ?? null, r?.['name'] ?? null, r?.['email'] ?? null,
      r?.['role'] ?? null, r?.['createdBy'] ?? null, r?.['createdByKey'] ?? null, r?.['keyEpoch'] ?? null, r?.['revokedAt'] ?? null])
      .map((r) => steady(r)).sort());
    case 'account': return steady({
      roster: a?.['roster'] ?? null, sealedRoster: a?.['sealedRoster'] ?? null, keyEpoch: a?.['keyEpoch'] ?? null, signerCount: a?.['signerCount'] ?? null,
      pendingSigners: rowsOf(a?.['pendingSigners']).map((s) => steady(s)).sort(), wrappedKeys: rowsOf(a?.['wrappedKeys']).map((k) => steady(k)).sort(),
      memberUserIds: [...((a?.['memberUserIds'] as unknown[] | undefined) ?? [])].map((m) => String(m)).sort(),
    });
  }
};

/** What a step of a filed proposal does, as the proposal's own route names it. */
export type ProposalAct = 'send' | 'approve' | 'retirement' | 'cancel' | 'carry' | 'charge' | 'closed';

/** A call to one of the company's vaults this device proved, by the route that sends it: a new vault, or one already adopted. */
export type VaultSend =
  | { readonly act: 'deploy'; readonly vault?: undefined }
  | { readonly act: 'handover' | 'deposit' | 'public-deposit' | 'payout' | 'merge' | 'public-payout'; readonly vault: string };

/** A step of starting a vault, as its route names it. */
export type VaultStartStep = 'account' | 'secret' | 'copy';

/** The kinds the company records route files: a person and the roster are each filed by their own route, which this one refuses. */
export type RecordRouteKind = Exclude<CompanyRecordKind, 'person' | 'roster'>;

/**
 * A write to the company's records, named by what it writes. Each is sent exactly as the record's own route takes it,
 * and the service refuses it on its own facts when it lands (a version already taken, a filer it does not believe).
 */
export type RecordWrite =
  | { readonly to: 'entries'; readonly entries: readonly ManifestEntry[] }
  | { readonly to: 'header'; readonly header: TreeHeader; readonly entries?: readonly ManifestEntry[] }
  | { readonly to: 'directory'; readonly filing: DirectoryFiling }
  | { readonly to: 'record'; readonly kind: RecordRouteKind; readonly id: string; readonly version: number; readonly body: unknown }
  | { readonly to: 'vault-record'; readonly vault: string; readonly record: WireRecord; readonly version: number; readonly body: unknown }
  | { readonly to: 'roster'; readonly body: unknown }
  | { readonly to: 'vault-keys'; readonly body: unknown }
  /** A waiting signer seated in the roster filed with it, and given the company's key. */
  | { readonly to: 'admission'; readonly signer: string; readonly body: unknown }
  /** The readers of the read grants in force, as their signers signed them. */
  | { readonly to: 'readers'; readonly body: unknown }
  /** A proposal filed, with the call that raises it on the chain when it carries one. */
  | { readonly to: 'proposal-filed'; readonly body: unknown }
  /** A step of a proposal already filed: a call sent, approved, carried or charged, its retirement, cancel or close. */
  | { readonly to: 'proposal'; readonly id: string; readonly act: ProposalAct; readonly body: unknown }
  /** A proposal carried out on the chain without the service, told to it so it closes the proposal it keeps. */
  | { readonly to: 'carried'; readonly id: string; readonly body: unknown }
  /** A call this device proved, sent to the chain through the service. */
  | { readonly to: 'proven'; readonly tx: string }
  /** A transaction this device proved, of one or more calls to the company's vaults, sent through the vault's own route. */
  | { readonly to: 'vault-send'; readonly tx: string; readonly calls: readonly VaultSend[] }
  /** An invitation filed: the signed filing, and for a payee the first version of their entry with it. */
  | { readonly to: 'invitation'; readonly body: unknown }
  /** A waiting signer's request withdrawn, signed by the seat that withdraws it. */
  | { readonly to: 'signer-withdrawn'; readonly signer: string; readonly body: unknown }
  /** A person's next entry: their status or details changed, or their payee code admitted. */
  | { readonly to: 'person'; readonly id: string; readonly act: 'status' | 'details' | 'admit'; readonly body: unknown }
  /** A payroll run drawn on this device, sealed and signed by the seat that files it. */
  | { readonly to: 'run'; readonly body: unknown }
  /** A vendor's next entry with their payee code admitted. */
  | { readonly to: 'vendor-admitted'; readonly id: string; readonly body: unknown }
  /** A finished call handed to our service to pay its fee, and the booking of that fee told done once the call is sent. */
  | { readonly to: 'fee'; readonly body: unknown }
  | { readonly to: 'fee-done'; readonly body: unknown }
  /** The entry of a signer who pays themself. */
  | { readonly to: 'self-payee'; readonly body: unknown }
  /** A step of starting a vault this device proved, sent to the chain through the service: its account's call, its secret, or a copy of it. */
  | { readonly to: 'vault-start'; readonly vault: string; readonly step: VaultStartStep; readonly body: unknown }
  /**
   * The change that brings the company's contracts to the committee holding its account: this device's signatures kept
   * by the service until enough are given, or an update with enough signatures sent to the chain.
   */
  | { readonly to: 'committee-change'; readonly act: 'signatures' | 'send'; readonly body: unknown };

/** What one company's records answer, from wherever they are kept. */
export interface RecordSource {
  readonly company: string;
  /** The company's account as the service keeps it: its signers, its keys' wraps, its vaults. */
  account(): Promise<unknown>;
  /** Every filing of the company's directory, oldest first. */
  filings(): Promise<readonly DirectoryFiling[]>;
  /** The newest version entered of each record named, in the order named. */
  newest(names: readonly RecordName[]): Promise<readonly number[]>;
  /** The entries not yet anchored over `root`; null when the service keeps no tree at that root. */
  pending(root: Hex): Promise<readonly unknown[] | null>;
  /** The proofs of the records and kinds asked, at the root asked; null when the service keeps no tree at that root. */
  proofs(ask: ProofsAsk): Promise<ProofsGiven | null>;
  /** The record tree's headers after `after`, at most `limit` of them, with their entries and leaves. */
  headers(after: number, limit: number): Promise<HeadersPage>;
  /** Each company record asked, in the order asked, as its own read answers it; never filed, `filed: null`. */
  records(asked: readonly CompanyRecordAsked[]): Promise<readonly unknown[]>;
  /** Each vault record asked, in the order asked, as its own read answers it. */
  vaultRecords(asked: readonly VaultRecordAsked[]): Promise<readonly unknown[]>;
  /** What each person named handed over, sealed, in the order named. */
  handovers(people: readonly string[]): Promise<readonly unknown[]>;
  /** What each vendor named handed over, sealed, in the order named; `inbox: null` for a vendor the company has not invited. */
  vendorHandovers(vendors: readonly string[]): Promise<readonly unknown[]>;
  /** One of the company's lists, whole. */
  list(kind: ListKind): Promise<unknown>;
  /** Where a proposal stands on the chain, as the service reads it there. */
  standing(proposal: string): Promise<unknown>;
  /** The company's account's call chain as the service reads it on the chain. */
  callState(): Promise<unknown>;
  /** One vault as the service reads it on the chain, and the state of its payouts. */
  vaultChain(vault: string): Promise<unknown>;
  payoutState(vault: string): Promise<unknown>;
  /** Who holds the company's account on the chain, as the service reads it there, and whether a change of its contracts' committee is owed. */
  authority(): Promise<unknown>;
  /** The change of the contracts' committee owed: each contract's update and the signatures it has. */
  committeeChange(): Promise<unknown>;
  /** The readers the company's vaults are started for and the committee they are held by, as the service keeps them. */
  vaultKeys(): Promise<unknown>;
  /** One write; what the service answered for it. */
  write(w: RecordWrite): Promise<unknown>;
  /** How a write this source just sent moves who holds the company, where the one it is written for declared it. */
  movesOf?(w: RecordWrite): HoldersMove | undefined;
}

/** An ask naming more records than one request carries: the caller splits it (`inParts`, company-view-batch.ts). */
export class AskTooLong extends Error {
  constructor(what: string, count: number) {
    super(`${count} ${what} were asked in one request, and one request carries at most ${READ_AT_ONCE}. Ask in parts of ${READ_AT_ONCE}.`);
  }
}

const atMost = <T>(what: string, items: readonly T[]): readonly T[] => {
  if (items.length > READ_AT_ONCE) throw new AskTooLong(what, items.length);
  return items;
};

const listOf = (answer: unknown, field: string, what: string, count: number): readonly unknown[] => {
  const list = fieldsOf(answer)?.[field];
  if (!Array.isArray(list) || list.length !== count) throw new Error(`the service did not answer with ${what}, one for each asked`);
  return list;
};

const LIST_PATHS: Readonly<Record<ListKind, string>> = Object.freeze({
  proposals: '/proposals', people: '/people', runs: '/runs', invites: '/invites', vaults: '/vaults', 'vault-key-offers': '/vault-keys/offers',
});

const accountPath = (company: string, rest = ''): string => `/api/accounts/${encodeURIComponent(company)}${rest}`;

/** An answer read as an object of named fields, or null when it is not one. */
type Fields = { readonly [field: string]: unknown } | null;
const fieldsOf = (answer: unknown): Fields => (answer !== null && typeof answer === 'object' ? answer as Fields : null);

/** The directory's filings in the service's answer; throws when it holds none, so no filing is believed. */
const filingsIn = (answer: unknown): DirectoryFiling[] => {
  const filings = fieldsOf(answer)?.['filings'];
  if (!Array.isArray(filings)) throw new Error('the company\'s directory could not be read, so no filing is believed.');
  return filings as DirectoryFiling[];
};

const readPost = (body: unknown): RequestInit & { read: true } => ({ method: 'POST', body: JSON.stringify(body), read: true });

/**
 * The committee change's signatures given, or its update sent, at the change's own route: the one way both are sent,
 * through a view's write and as a super admin's ask, the latter with the headers its signed request carries.
 */
const committeeChangeSent = (
  call: ServiceCall, company: string, act: 'signatures' | 'send', body: unknown, headers?: Record<string, string>,
): Promise<unknown> => call(accountPath(company, `/committee-change/${act}`), { method: 'POST', body: JSON.stringify(body), ...(headers === undefined ? {} : { headers }) });

/** Sends one write to the route that takes it. */
const written = (call: ServiceCall, company: string, w: RecordWrite): Promise<unknown> => {
  const send = (path: string, method: string, body: unknown) => call(path, { method, body: JSON.stringify(body) });
  switch (w.to) {
    case 'entries': return send(manifestPaths.entries(company), 'POST', { entries: w.entries });
    case 'header': return send(manifestPaths.treeHeaders(company), 'POST', w.entries === undefined ? { header: w.header } : { header: w.header, entries: w.entries });
    case 'directory': return send(accountPath(company, `/directory/${w.filing.version}`), 'PUT', w.filing);
    case 'record': return send(companyWirePaths.one(company, w.kind, w.id, w.version), 'PUT', w.body);
    case 'vault-record': return send(wirePaths.file(w.vault, w.record, w.version), 'PUT', w.body);
    case 'roster': return send(accountPath(company, '/roster'), 'POST', w.body);
    case 'vault-keys': return send(accountPath(company, '/vault-keys'), 'PUT', w.body);
    case 'admission': return send(accountPath(company, `/signers/${encodeURIComponent(w.signer)}/admit`), 'POST', w.body);
    case 'readers': return send(accountPath(company, '/readers'), 'POST', w.body);
    case 'proposal-filed': return send(accountPath(company, '/proposals'), 'POST', w.body);
    case 'proposal': return send(`/api/proposals/${encodeURIComponent(w.id)}/${w.act}`, 'POST', w.body);
    case 'invitation': return send(accountPath(company, '/invites'), 'POST', w.body);
    case 'signer-withdrawn': return send(accountPath(company, `/signers/${encodeURIComponent(w.signer)}/withdraw`), 'POST', w.body);
    case 'person': return send(w.act === 'admit' ? `/api/employees/${encodeURIComponent(w.id)}/admit` : `/api/people/${encodeURIComponent(w.id)}/${w.act}`, 'POST', w.body);
    case 'vendor-admitted': return send(accountPath(company, `/vendors/${encodeURIComponent(w.id)}/admit`), 'POST', w.body);
    case 'fee': return send(accountPath(company, '/fee'), 'POST', w.body);
    case 'fee-done': return send(accountPath(company, '/fee/done'), 'POST', w.body);
    case 'self-payee': return send(accountPath(company, '/self-payee'), 'POST', w.body);
    case 'run': return send(accountPath(company, '/runs'), 'POST', w.body);
    case 'carried': return send(`/api/proposals/${encodeURIComponent(w.id)}/carried`, 'POST', w.body);
    case 'proven': return send(accountPath(company, '/proven'), 'POST', { tx: w.tx });
    case 'committee-change': return committeeChangeSent(call, company, w.act, w.body);
    case 'vault-start': return send(accountPath(company, `/vaults/${encodeURIComponent(w.vault)}/start/${w.step}`), 'POST', w.body);
    case 'vault-send': {
      const [c, ...more] = w.calls;
      if (c === undefined || more.length > 0) return Promise.reject(Object.assign(new Error(`the service's vault routes file one call a transaction, and this one carries ${w.calls.length}, so nothing was sent.`), { nothingWasSent: true, thisSendNotSent: true }));
      return send(c.act === 'deploy' ? accountPath(company, '/vaults') : accountPath(company, `/vaults/${encodeURIComponent(c.vault)}/${c.act}`), 'POST', { tx: w.tx });
    }
  }
};

/** The company's records as its service keeps them, asked through `call`. */
export const serviceSource = (call: ServiceCall, company: string): RecordSource => Object.freeze<RecordSource>({
  company,
  account: () => call(accountPath(company)),
  filings: async () => filingsIn(await call(accountPath(company, '/directory'))),
  newest: async (names) => {
    if (atMost('records', names).length === 0) return [];
    const m = await call(manifestPaths.newest(company), readPost({ records: names }));
    const versions = listOf(m, 'versions', 'the newest version entered of each record', names.length);
    if (versions.some((v) => !Number.isSafeInteger(v) || (v as number) < 0)) {
      throw new Error('the service did not answer with the newest version entered of each record asked');
    }
    return versions as number[];
  },
  pending: async (root) => {
    const p = fieldsOf(await call(`${manifestPaths.treePending(company)}?root=${root}`));
    if (p?.['refused'] === 'root-not-kept') return null;
    const entries = p?.['entries'];
    if (!Array.isArray(entries)) throw new Error('the service did not answer with the entries not yet anchored');
    return entries;
  },
  proofs: async (ask) => {
    atMost('records', ask.records);
    const p = fieldsOf(await call(manifestPaths.treeProofs(company), readPost(ask)));
    if (p?.['refused'] === 'root-not-kept') return null;
    const siblings = fieldsOf(p?.['proof'])?.['siblings'];
    if (p === null || !Array.isArray(p['records']) || !Array.isArray(p['kinds']) || !Array.isArray(p['older'])
      || !Array.isArray(siblings)) throw new Error('the service did not answer with the proofs asked for');
    return { records: p['records'], kinds: p['kinds'], older: p['older'], proof: { siblings } };
  },
  headers: async (after, limit) => {
    const p = fieldsOf(await call(`${manifestPaths.treeHeaders(company)}?after=${after}&limit=${limit}`));
    const [headers, entries, leaves] = [p?.['headers'], p?.['entries'], p?.['leaves']];
    if (!Array.isArray(headers) || !Array.isArray(entries) || !Array.isArray(leaves)) {
      throw new Error('the service did not answer with a page of the company\'s record headers');
    }
    return { headers, entries, leaves };
  },
  records: async (asked) => listOf(await call(accountPath(company, '/records/read'), readPost({ records: atMost('records', asked) })),
    'records', 'the records asked', asked.length),
  vaultRecords: async (asked) => listOf(await call(accountPath(company, '/vault-records/read'), readPost({ records: atMost('vault records', asked) })),
    'records', 'the vault records asked', asked.length),
  handovers: async (people) => listOf(await call(accountPath(company, '/handovers'), readPost({ people: atMost('people', people) })),
    'handovers', 'what each person handed over', people.length),
  vendorHandovers: async (vendors) => listOf(await call(accountPath(company, '/handovers'), readPost({ vendors: atMost('vendors', vendors) })),
    'handovers', 'what each vendor handed over', vendors.length),
  list: (kind) => call(accountPath(company, LIST_PATHS[kind])),
  standing: (proposal) => call(`/api/proposals/${encodeURIComponent(proposal)}/standing`, readPost({})),
  callState: () => call(accountPath(company, '/call-state')),
  vaultChain: (vault) => call(accountPath(company, `/vaults/${encodeURIComponent(vault)}/chain`)),
  payoutState: (vault) => call(accountPath(company, `/vaults/${encodeURIComponent(vault)}/payout-state`)),
  authority: () => call(accountPath(company, '/authority')),
  committeeChange: () => call(accountPath(company, '/committee-change')),
  vaultKeys: () => call(accountPath(company, '/vault-keys')),
  write: (w) => written(call, company, w),
});

/**
 * A change of the super admins, as a super admin's device asks the service for it, with the headers each ask carries
 * (a super admin by a link holds no view of the company): raised, joined, its kept signatures read, given more, and a
 * contract's update with enough signatures sent to the chain; and the indexer the super admin's own wallet reads the
 * company's chain through, the one read of the chain the change is raised and approved over.
 */
export interface SuperAdminAsks {
  raise(body: unknown, headers: Record<string, string>): Promise<unknown>;
  join(body: unknown, headers: Record<string, string>): Promise<unknown>;
  kept(headers: Record<string, string>): Promise<unknown>;
  keep(body: unknown, headers: Record<string, string>): Promise<unknown>;
  send(update: unknown, headers: Record<string, string>): Promise<unknown>;
  /** The indexer the person's own wallet names for the company at `where`, or null when it names none. */
  indexer(where: { readonly company: CompanyLabel; readonly account: AccountAddress }): Promise<WalletIndexer | null>;
}

/** The super admins' change of company `company`, asked through `call`, and the indexer asked of the person's wallet through `indexer`. */
export const superAdminAsks = (call: ServiceCall, company: string, indexer: SuperAdminAsks['indexer']): SuperAdminAsks => {
  const post = (rest: string, body: unknown, headers: Record<string, string>) => call(accountPath(company, rest), { method: 'POST', body: JSON.stringify(body), headers });
  return Object.freeze<SuperAdminAsks>({
    raise: (body, headers) => post('/committee-change/raise', body, headers),
    join: (body, headers) => post('/committee-change/join', body, headers),
    kept: (headers) => call(accountPath(company, '/committee-change/signatures'), { headers }),
    keep: (body, headers) => committeeChangeSent(call, company, 'signatures', body, headers),
    send: (update, headers) => committeeChangeSent(call, company, 'send', update, headers),
    indexer,
  });
};

/**
 * One company's writes, named by the company they are for: a device acting in one company writes through its view of
 * it, and refuses another.
 */
export type CompanyWrites = (company: string, w: RecordWrite) => Promise<unknown>;

/**
 * The body of an answer the service gave with a 2xx status; any other answer thrown as the service's refusal, with its
 * status, whether it says nothing was sent, its code, and what it said and why it refused (`error`, `refused`).
 */
export const takenOrThrown = (answered: { readonly status: number; readonly body: unknown }): unknown => {
  if (answered.status >= 200 && answered.status < 300) return answered.body;
  const told = fieldsOf(answered.body);
  const said = told?.['error'];
  const why = typeof said === 'string' ? said : `the company's service answered ${answered.status}`;
  const marked = told?.['nothingWasSent'];
  const code = told?.['code'];
  const refused = told?.['refused'];
  throw Object.assign(new Error(why), {
    status: answered.status,
    body: answered.body,
    nothingWasSent: typeof marked === 'boolean' ? marked : /Nothing was sent/u.test(why),
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof said === 'string' ? { error: said } : {}),
    ...(typeof refused === 'string' ? { refused } : {}),
  });
};

/** A call made as a fetch over a send that answers with status and body: the body of a 2xx answer, any other thrown (`takenOrThrown`). */
export const serviceCallOf = (send: (path: string, init: { readonly method: 'GET' | 'PUT' | 'POST'; readonly body?: string }) => Promise<{ readonly status: number; readonly body: unknown }>): ServiceCall =>
  async (path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase() as 'GET' | 'PUT' | 'POST';
    return takenOrThrown(await send(path, { method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) }));
  };

/** A call answered with the service's status and body, whatever the status. */
export type AnsweredCall = (method: 'GET' | 'PUT' | 'POST', path: string, body?: string) => Promise<{ readonly status: number; readonly body: unknown }>;

/** The status and body a call was answered with. */
export type Answered = Awaited<ReturnType<AnsweredCall>>;

/**
 * An invitation, asked by whoever holds its link before they are one of the company's members, so with no view of the
 * company and no check of it first: its offer, a payee's or a signer's acceptance, the seat taken with it, the seats
 * it names, the company it was filed to, and that company's directory. Each answers with the status and body the
 * service gave, for the step to read.
 */
export interface InvitationSource {
  offer(invitation: string): Promise<Answered>;
  acceptPayee(invitation: string, body: unknown): Promise<Answered>;
  acceptSigner(invitation: string, body: unknown): Promise<Answered>;
  seat(invitation: string, body: unknown): Promise<Answered>;
  seatsNamed(invitation: string, body: unknown): Promise<Answered>;
  filedTo(invitation: string, body: unknown): Promise<Answered>;
  /** Every filing of the directory of the company `company`, oldest first; throws when the service does not answer with them. */
  filings(company: string): Promise<readonly DirectoryFiling[]>;
  /** The call a seat is taken with, as the gate of the step that sends it names it. */
  seatCall(invitation: string): { readonly path: string };
}

const invitePath = (invitation: string, rest: string): string => `/api/invites/${encodeURIComponent(invitation)}/${rest}`;

/** The invitations asked through `call`. */
export const invitationSource = (call: AnsweredCall): InvitationSource => {
  const post = (invitation: string, rest: string, body: unknown) => call('POST', invitePath(invitation, rest), JSON.stringify(body));
  return Object.freeze<InvitationSource>({
    offer: (invitation) => call('GET', invitePath(invitation, 'offer')),
    acceptPayee: (invitation, body) => post(invitation, 'accept-payee', body),
    acceptSigner: (invitation, body) => post(invitation, 'accept-signer', body),
    seat: (invitation, body) => post(invitation, 'seat', body),
    seatsNamed: (invitation, body) => post(invitation, 'seats-named', body),
    filedTo: (invitation, body) => post(invitation, 'filed-to', body),
    filings: async (company) => {
      const answer = await call('GET', accountPath(company, '/directory'));
      if (answer.status < 200 || answer.status >= 300) throw new Error(`the company's directory could not be read (the service answered ${answer.status}), so no filing is believed.`);
      return filingsIn(answer.body);
    },
    seatCall: (invitation) => ({ path: invitePath(invitation, 'seat') }),
  });
};

/**
 * A company being created, as the page that starts it asks: whether the service holds its creation and how far it
 * stands, the creation handed to the service, the deploy and its insert handed on (again, when the first may be
 * replaced), the finish, and the pay key's calls. Each answers as `call` does.
 */
export interface CreationAsks<R> {
  standing(company: string): Promise<R>;
  created(request: unknown): Promise<R>;
  handedOn(company: string, body: unknown, again: boolean): Promise<R>;
  finished(company: string, body: unknown): Promise<R>;
  payKey(company: string, body: unknown): Promise<R>;
  /** Whether a call the wallet hands the page is one of this creation's own routes, the only ones finishing it may call. */
  isItsOwn(company: string, path: string): boolean;
}

const creationPath = (company: string): string => `/api/accounts/${company}/creation`;

/** A company's creation, asked through `call`. */
export const creationAsks = <R>(call: PathAsk<R>): CreationAsks<R> => Object.freeze<CreationAsks<R>>({
  standing: (company) => call(creationPath(company)),
  created: (request) => call('/api/accounts', posted(request)),
  handedOn: (company, body, again) => call(again ? `${creationPath(company)}/again` : creationPath(company), posted(body)),
  finished: (company, body) => call(`${creationPath(company)}/finish`, posted(body)),
  payKey: (company, body) => call(`${creationPath(company)}/pay-key`, posted(body)),
  isItsOwn: (company, path) => path.startsWith(`${creationPath(company)}/`),
});

/**
 * A call proved in the proving worker, handed to the company's service to send to the chain. The worker holds no
 * sign-in and no view of the company, so it asks by its own send; the answer is read by the worker's own rules.
 */
export const provenHandedOver = (call: AnsweredCall) => (company: string, tx: string): Promise<Answered> =>
  call('POST', accountPath(company, '/proven'), JSON.stringify({ tx }));

/**
 * A company being created, asked by its creator before its records are anyone's to read: the pay key's call sent to
 * the chain, and the proposal that raises it, filed. Each answers with the status and body the service gave.
 */
export interface CreationSource {
  payKey(company: string, body: unknown): Promise<Answered>;
  payKeyProposal(company: string, body: unknown): Promise<Answered>;
}

/** The creation of a company asked through `call`. */
export const creationSource = (call: AnsweredCall): CreationSource => Object.freeze<CreationSource>({
  payKey: (company, body) => call('POST', accountPath(company, '/creation/pay-key'), JSON.stringify(body)),
  payKeyProposal: (company, body) => call('POST', accountPath(company, '/creation/pay-key/proposal'), JSON.stringify(body)),
});

/** The fee our service pays for one call a device proved, and that call's booking told done, for the company named. */
export interface FeeSource {
  fee(company: string, body: unknown): Promise<Answered>;
  feeDone(company: string, body: unknown): Promise<Answered>;
}

/** The fee routes asked through `call`. */
export const feeSource = (call: AnsweredCall): FeeSource => Object.freeze<FeeSource>({
  fee: (company, body) => call('POST', accountPath(company, '/fee'), JSON.stringify(body)),
  feeDone: (company, body) => call('POST', accountPath(company, '/fee/done'), JSON.stringify(body)),
});

const sameCompany = (source: RecordSource, accountId: string): void => {
  if (accountId !== source.company) {
    throw new Error(`this company's records were asked about another company (${accountId}); nothing was read or written.`);
  }
};

/** The record tree's reads and the filing of a header, as the code that anchors and reads held asks them, from `source`. */
export const treeServiceOf = (source: RecordSource): TreeService => Object.freeze<TreeService>({
  headersAfter: async (accountId, seq, limit) => { sameCompany(source, accountId); return source.headers(seq, limit); },
  fileHeader: async (accountId, header, entries) => {
    sameCompany(source, accountId);
    await source.write(entries === undefined ? { to: 'header', header } : { to: 'header', header, entries });
  },
  proofs: async (accountId, ask) => { sameCompany(source, accountId); return source.proofs(ask); },
  pending: async (accountId, root) => { sameCompany(source, accountId); return source.pending(root); },
});

/** The manifest's newest versions and the entering of entries, as the code that files and anchors asks them, from `source`. */
export const manifestServiceOf = (source: RecordSource): ManifestService => Object.freeze<ManifestService>({
  newest: async (accountId, records) => { sameCompany(source, accountId); return source.newest(records); },
  enter: async (accountId, entries) => { sameCompany(source, accountId); await source.write({ to: 'entries', entries }); },
});
