/*
 * What a roster read and a roster filing ask of the company's service, in one place: the account, its proposals, the
 * open vault-key offers, every version of the roster, the manifest, and the writes (the roster, an admission, a vault-key
 * offer). Every one of them goes through the step's or screen's view, so the view's check runs before each write and
 * its baseline moves by what the write's own entries enter.
 */
import { ROSTER_ID } from '../../../src/core/roster-record.js';
import { fromCompanyWire, type CompanyRecordKind, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { CompanyView } from './company-view.js';
import { manifestFollowing, type ManifestService } from './record-entered-here.js';
import type { RecordWrite } from './records-source.js';

/** The parts of a view of the company a roster is read and filed through. */
export type RosterView = Pick<CompanyView<unknown>, 'account' | 'list' | 'records' | 'manifest' | 'write'>;

/** The view a roster follows: the step's or screen's current one, opened again after the step's own send. */
export interface RosterViewHeld { current(): RosterView }

/** What a roster read and filing reads and writes. */
interface RosterService {
  account(): Promise<unknown>;
  proposals(): Promise<unknown>;
  offers(): Promise<unknown>;
  /** Every version of the roster the service holds, as the wire carries them. */
  rosterVersions(): Promise<unknown>;
  /** The first version of one of the company's records, or null when none was filed. */
  first(kind: CompanyRecordKind, id: string): Promise<SealedCompanyRecord | null>;
  readonly manifest: ManifestService;
  file(w: RecordWrite): Promise<unknown>;
}

/** The versions of every version's answer, its first one picked out, or null when the record was never filed. */
export const firstOf = (answer: unknown, company: string, kind: CompanyRecordKind, id: string): SealedCompanyRecord | null => {
  const versions = (answer as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) throw new Error(`the service did not answer with the versions of the company's ${kind} record`);
  for (const wire of versions) {
    const rec = fromCompanyWire(wire, { company, kind, id }).sealed;
    if (rec.version === 1) return rec;
  }
  return null;
};

/** The first version of one of the company's records read through `held`'s view, or null when none was filed. */
export const firstFiledThrough = async (
  held: { current(): Pick<RosterView, 'records'> }, company: string, kind: CompanyRecordKind, id: string,
): Promise<SealedCompanyRecord | null> => firstOf((await held.current().records([{ kind, id, every: true }]))[0], company, kind, id);

const throughTheView = (held: RosterViewHeld, company: string): RosterService => ({
  account: () => held.current().account(),
  proposals: () => held.current().list('proposals'),
  offers: () => held.current().list('vault-key-offers'),
  rosterVersions: async () => (await held.current().records([{ kind: 'roster', id: ROSTER_ID, every: true }]))[0],
  first: (kind, id) => firstFiledThrough(held, company, kind, id),
  manifest: manifestFollowing(held),
  file: async (w) => (await held.current().write([w]))[0],
});

/** The roster's reads and writes, through `view`. */
export const rosterServiceOf = (d: { readonly accountId: string; readonly view: RosterViewHeld }): RosterService =>
  throughTheView(d.view, d.accountId);
