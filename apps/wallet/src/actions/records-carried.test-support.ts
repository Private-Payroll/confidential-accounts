/*
 * The records a service answer carried, each named, and the rule each answer is held to: a list carries every record of
 * its kind the service holds, each once; a read carries only the records it asked, each once, and a read of every version
 * of a company record carries exactly the versions the service has filed of it. Names are `record <kind> <id> v<version>`
 * where the answer gives them, so what is carried is compared by record and not only by how many. What each read asked is
 * counted here too, by kind, for the wallet's counts and the page's alike.
 */
import { createHash } from 'node:crypto';
import { CO, store } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { peopleRecords } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import { READ_AT_ONCE } from '../../../../packages/web-shared/src/records-source.js';

type Row = Readonly<Record<string, unknown>>;
const isRow = (x: unknown): x is Row => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string => String(x);
const versioned = (base: string, version: unknown): string => (typeof version === 'number' ? `${base} v${version}` : base);

/* What a read asks, by its body: the records named one by one. */
const askedOf = (body: string | undefined): readonly Row[] => {
  const asked = body === undefined ? undefined : (JSON.parse(body) as { records?: unknown }).records;
  return Array.isArray(asked) ? asked.filter(isRow) : [];
};
/** The name of a record a read asks for: a vault's record by vault and name, a company record by kind and id, the directory by its name. */
export const askedName = (a: Row): string => {
  if (a['vault'] !== undefined) return `vault ${str(a['vault'])} ${str(a['record'])}`;
  if (a['store'] === 'directory') return 'directory';
  return `record ${str(a['kind'])} ${str(a['id'])}`;
};

/* The name of one row of a list: a filed record by kind, id and version, an invitation by whom it is for or when it was made, a header by its place, a proposal or run by its id. */
const rowName = (e: unknown): string => {
  if (!isRow(e)) return `item ${createHash('sha256').update(JSON.stringify(e) ?? '').digest('hex').slice(0, 12)}`;
  if (isRow(e['filed'])) return rowName(e['filed']);
  if (e['kind'] !== undefined && e['id'] !== undefined) return versioned(`record ${str(e['kind'])} ${str(e['id'])}`, e['version']);
  if (e['expiresAt'] !== undefined) return `invite ${str(e['kind'])} ${str(e['subjectId'] ?? e['createdAt'])}`;
  if (e['seq'] !== undefined) return `header ${str(e['seq'])}`;
  if (e['id'] !== undefined) return `row ${str(e['id'])}`;
  if (e['company'] !== undefined && typeof e['version'] === 'number') return `directory v${e['version']}`;
  return rowName(JSON.stringify(e));
};

const READ = /\/(records\/read|vault-records\/read|manifest\/newest|manifest\/tree\/proofs)$/u;

/*
 * The records a read's answer carried, paired with what it asked in order: every version of a record read whole, the
 * version of each record answered, or nothing for a record the service does not hold.
 */
const readCarried = (body: string | undefined, answer: unknown): string[] => {
  const asked = askedOf(body);
  const rows = isRow(answer) ? (Array.isArray(answer['records']) ? answer['records'] : Array.isArray(answer['versions']) ? answer['versions'] : []) : [];
  return asked.flatMap((a, i) => {
    const got: unknown = rows[i];
    if (got === null || got === undefined || got === 0) return [];
    if (typeof got === 'number') return [`${askedName(a)} v${got}`];
    if (!isRow(got)) return [askedName(a)];
    if (Array.isArray(got['versions'])) return got['versions'].map((v, n) => versioned(askedName(a), isRow(v) && typeof v['version'] === 'number' ? v['version'] : n + 1));
    const filed = isRow(got['filed']) ? got['filed'] : got;
    return [versioned(askedName(a), filed['version'])];
  });
};

/** The records an answer carried, each named: what a read asked and was answered, or each row of every list the answer holds at its top. */
export const recordsCarried = (method: string, path: string, body: string | undefined, answer: unknown): string[] => {
  if (method === 'POST' && READ.test(path.split('?')[0]!)) return readCarried(body, answer);
  if (Array.isArray(answer)) return answer.map(rowName);
  if (!isRow(answer)) return [];
  const lists = Object.values(answer).filter((v): v is unknown[] => Array.isArray(v));
  if (lists.length > 0) return lists.flatMap((l) => l.map(rowName));
  return Object.keys(answer).length > 0 ? [rowName(answer)] : [];
};

/*
 * The kind of a record a read asks: a company record by its kind, a vault's record by its name, whichever vault it is
 * of, the directory as itself.
 */
const kindAsked = (name: string): string => {
  const [of, a, b] = name.split(' ');
  return of === 'record' ? `record ${a}` : of === 'vault' ? `vault record ${b}` : name;
};

/** A call as a count's log has it: its route, method, path and body, and the step it was made in when the log is of an action's steps. */
export interface CallLogged { readonly step?: number; readonly route: string; readonly method: string; readonly path: string; readonly body: string | undefined }

/**
 * How many records of each kind each read that names its records asked, by step (where the log has steps), route, the
 * call's place among that step's calls of the route, and kind, each kind named by `kindOf` (by default a vault's record
 * as `vault record <name>`). A read of more records than one call asks (`READ_AT_ONCE`) is sent as a call of that many
 * and the calls after it; those calls are counted as the one call they continue.
 */
export const askedByKind = (c: { readonly log: readonly CallLogged[] }, kindOf: (name: string) => string = kindAsked): Map<string, number> => {
  const by = new Map<string, number>();
  const calls = new Map<string, number>();
  const continued = new Set<string>();
  for (const l of c.log) {
    if (l.method !== 'POST' || !READ.test(l.path.split('?')[0]!)) continue;
    const call = l.step === undefined ? l.route : `step ${l.step}: ${l.route}`;
    if (!continued.has(call)) calls.set(call, (calls.get(call) ?? 0) + 1);
    if (askedOf(l.body).length === READ_AT_ONCE) continued.add(call); else continued.delete(call);
    for (const n of askedOf(l.body).map(askedName)) {
      const at = `${call} call ${calls.get(call)!} asks ${kindOf(n)}`;
      by.set(at, (by.get(at) ?? 0) + 1);
    }
  }
  return by;
};

/** A record's name without its version. */
export const unversioned = (name: string): string => name.replace(/ v\d+$/u, '');

/* The records each list route lists, as the service holds them now. */
const HELD_LISTS: readonly (readonly [RegExp, () => Promise<readonly string[]>])[] = [
  [/^\/api\/accounts\/[^/]+\/proposals$/u, async () => store.listProposals(CO).map((p) => rowName(p))],
  [/^\/api\/accounts\/[^/]+\/invites$/u, async () => store.listInvites(CO).map((i) => rowName(i))],
  [/^\/api\/accounts\/[^/]+\/runs$/u, async () => store.listRuns(CO).map((r) => rowName(r))],
  [/^\/api\/accounts\/[^/]+\/people$/u, async () => (await peopleRecords.peopleOf(CO)).map((p) => rowName(p))],
];
/** Whether a call lists every record of its kind the service holds. */
export const listsItsKind = (method: string, path: string): boolean => method === 'GET' && HELD_LISTS.some(([at]) => at.test(path.split('?')[0]!));
const twice = (l: readonly string[]): string[] => l.filter((x, i) => l.indexOf(x) !== i);

/* How many versions of a company record the service has filed: the roster's in the account's store, any other in the company's records. */
const versionsFiled = async (a: Row): Promise<number> => (a['kind'] === 'roster'
  ? store.rosterVersions(CO).length
  : (await peopleRecords.versions(CO, a['kind'] as never, str(a['id']))).length);

/**
 * How a list's or a read's answer breaks the rule it is held to, or null: a record carried twice; a list that does not
 * carry exactly the records of its kind the service holds; a read that carries a record it did not ask, or carries of a
 * record read whole other than every version the service has filed of it. Other answers are held to their pinned count only.
 */
export const carriedNotAsHeld = async (method: string, path: string, body: string | undefined, carried: readonly string[]): Promise<string | null> => {
  const bare = path.split('?')[0]!;
  const held = method === 'GET' ? HELD_LISTS.find(([at]) => at.test(bare)) : undefined;
  const reads = method === 'POST' && READ.test(bare);
  if (held === undefined && !reads) return null;
  if (twice(carried).length > 0) return `carries ${twice(carried).join(', ')} more than once`;
  if (held !== undefined) {
    const [listed, holds] = [carried.map(unversioned), (await held[1]()).map(unversioned)];
    const [left, more] = [holds.filter((h) => !listed.includes(h)), listed.filter((l) => !holds.includes(l))];
    return left.length + more.length === 0 ? null : `lists ${more.join(', ') || 'nothing'} that the service does not hold, and leaves out ${left.join(', ') || 'nothing'} that it does`;
  }
  const asked = askedOf(body);
  const names = new Set(asked.map(askedName));
  const stray = carried.filter((c) => !names.has(unversioned(c)));
  if (stray.length > 0) return `carries ${stray.join(', ')}, which it did not ask`;
  if (!bare.endsWith('/records/read') || bare.endsWith('/vault-records/read')) return null;
  for (const a of asked.filter((x) => x['every'] === true)) {
    const filed = await versionsFiled(a);
    const got = carried.filter((c) => unversioned(c) === askedName(a)).length;
    if (got !== filed) return `carries ${got} versions of ${askedName(a)} where ${filed} are filed`;
  }
  return null;
};
