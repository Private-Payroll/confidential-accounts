/**
 * **THE SERVICE'S READ ROUTES, IN MEMORY, FOR A TEST'S OWN SERVICE.** A device reads the company through its view, and
 * the view asks the routes that read many records at once, the company's directory and the newest version entered of
 * each record. A test's stand-in service that answers only the routes the test itself is about gets those here, in one
 * place: the joined reads are answered from the stand-in's own reads of one record, and the newest version entered of each
 * record is the newest the stand-in holds of it, so a record that moves after a read is seen to move. A route a test has not
 * said what to do with is refused, never answered as if nothing were there: the directory holds no filing only where the
 * test says so (`RoutesKept`).
 */
import type { InvitationSend } from 'vaults-web-shared/invitation-on-device.js';
import { serviceCallOf, type ServiceCall } from 'vaults-web-shared/records-source.js';
import { companyWirePaths, wirePaths, type CompanyRecordKind, type WireRecord } from '../midnight/sealed-record-wire.js';

/**
 * What a test's service does itself, so the routes here leave it alone: `joined` is a test that answers the reads of many
 * records itself; `directory` is `true` for a test that answers the company's directory, or `empty` for one whose company has
 * filed none, and left out the route is refused; `newest` is `by-the-test` for a test that answers the newest versions entered,
 * `none-entered` for one whose company has entered no record, or, left out, `as-held`: the service serves every version of each
 * record by its own route and has the newest version entered read off what it holds.
 */
export interface RoutesKept {
  readonly joined?: true;
  readonly directory?: true | 'empty';
  readonly newest?: 'by-the-test' | 'as-held' | 'none-entered';
}

const ACCOUNT_ROUTE = /^\/api\/accounts\/[^/?]+\/(records\/read|vault-records\/read|directory|manifest\/newest)$/u;

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

const companyOf = (path: string): string => decodeURIComponent(path.split('/')[3]!);

interface Asked { readonly kind?: string; readonly id?: string; readonly vault?: string; readonly record?: string; readonly every?: boolean }
interface Named { readonly store?: string; readonly kind?: string; readonly id?: string }

const listOf = <T>(init: RequestInit | undefined): readonly T[] => (bodyOf(init)['records'] ?? []) as T[];

/** The newest version a service holds of one record, read by its route for every version; 0 for a record it holds none of. */
const heldVersion = async (call: ServiceCall, path: string): Promise<number> => {
  try {
    const answer = await call(path) as { readonly versions?: readonly { readonly version: number }[] } | null;
    return Math.max(0, ...(answer?.versions ?? []).map((v) => v.version));
  } catch (e) {
    if ((e as { readonly status?: number }).status === 404) return 0;
    throw e;
  }
};

/** The newest version the service holds of each record named; 0 for one it holds none of or keeps in no store a test serves. */
const newestHeld = (call: ServiceCall, company: string, names: readonly Named[]): Promise<number[]> =>
  Promise.all(names.map(async (n) => {
    if (n.store === 'company') return heldVersion(call, companyWirePaths.versions(company, n.kind as CompanyRecordKind, n.id!));
    if (n.store === 'vault') return heldVersion(call, wirePaths.versions(n.id!, n.kind as WireRecord));
    return 0;
  }));

const joinedCompanyRecords = (call: ServiceCall, company: string, asked: readonly Asked[]) => Promise.all(asked.map((a) => call(a.every === true
  ? companyWirePaths.versions(company, a.kind as CompanyRecordKind, a.id!) : companyWirePaths.newest(company, a.kind as CompanyRecordKind, a.id!))));

const joinedVaultRecords = (call: ServiceCall, asked: readonly Asked[]) => Promise.all(asked.map((a) => call(a.every === true
  ? wirePaths.versions(a.vault!, a.record as WireRecord) : wirePaths.newest(a.vault!, a.record as WireRecord))));

/** What these routes answer to `path` asked as `init`, or `null` when it is not one they answer and the test's own service does. */
const answeredHere = async (call: ServiceCall, path: string, init: RequestInit | undefined, kept: RoutesKept): Promise<{ readonly body: unknown } | null> => {
  const route = ACCOUNT_ROUTE.exec(path)?.[1];
  if (route === undefined) return null;
  const company = companyOf(path);
  const method = init?.method ?? 'GET';
  if (route === 'records/read' && method === 'POST' && kept.joined !== true) return { body: { records: await joinedCompanyRecords(call, company, listOf<Asked>(init)) } };
  if (route === 'vault-records/read' && method === 'POST' && kept.joined !== true) return { body: { records: await joinedVaultRecords(call, listOf<Asked>(init)) } };
  if (route === 'directory' && method === 'GET' && kept.directory !== true) {
    if (kept.directory === 'empty') return { body: { filings: [] } };
    throw new Error(`this test's service answers no directory: say \`directory: true\` where it answers it, or \`directory: 'empty'\` where the company has filed none (${path})`);
  }
  if (route === 'manifest/newest' && method === 'POST' && kept.newest !== 'by-the-test') {
    const names = listOf<Named>(init);
    return { body: { versions: kept.newest === 'none-entered' ? names.map(() => 0) : await newestHeld(call, company, names) } };
  }
  return null;
};

/**
 * `call`, a test's own service, with the read routes a view asks: many company records, many vault records, the
 * directory and the newest versions. Each joined read is answered by `call`'s own read of each record, as the service
 * answers the read of one: the newest version, or with `every` all of them, in the order asked.
 */
export const readRoutesOver = (call: ServiceCall, kept: RoutesKept = {}): ServiceCall => async (path, init) => {
  const here = await answeredHere(call, path, init, kept);
  return here === null ? call(path, init) : here.body;
};

/** `send`, a test's own service answered by status and body, with the same read routes as `readRoutesOver`. */
export const readRoutesOverSend = (send: InvitationSend, kept: RoutesKept = {}): InvitationSend => {
  const call = serviceCallOf(send);
  return async (path, init) => {
    const here = await answeredHere(call, path, init, kept);
    return here === null ? send(path, init) : { status: 200, body: here.body };
  };
};
