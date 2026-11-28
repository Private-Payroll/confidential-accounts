/**
 * **A VERSION WHOSE ENTRY NEVER REACHED THE COMPANY'S RECORDS IS ENTERED FROM
 * ANY SEAT'S DEVICE.** Every company record carries its filer's own signed entry
 * (`signedWithItsEntry`). A device that reads a version the company's records do
 * not name posts that entry through the records' door, so one lost entry no
 * longer leaves every other device refusing the record until its filer acts.
 *
 * It trusts nothing the service says of the entry: it posts one only when the
 * entry is the record's own filer's signature over exactly that version
 * (`carriedEntryRefusal`), and the caller reads the record again afterwards,
 * believing it only as the company's records then hold it. It never enters the
 * first version of a record the company was founded with, never one the
 * records already name or pass, and nothing at all
 * before the company's first anchor, which holds the records it was founded
 * with and is made by its founding seat alone.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { carriedEntryRefusal } from '../../../src/midnight/carried-entry.js';
import {
  companyRecordEntry,
  ENTRIES_AT_ONCE,
  entryIdOf,
  type ManifestEntry
} from '../../../src/midnight/record-manifest.js';
import {
  FOUNDING_RECORDS,
  heldStandingOf,
  type RecordsAsked,
  type RecordsHeld
} from '../../../src/midnight/records-held.js';
import {
  fromCompanyWire,
  verifiedCompanyFiler,
  type CompanyRecordKind,
  type SealedCompanyRecord
} from '../../../src/midnight/sealed-record-wire.js';
import type { ManifestService } from './record-entered-here.js';
import type { CompanyView } from './company-view.js';

/** How many carried entries were entered, and why the rest were not when the service refused them; null when none was refused. */
interface CarriedEntered {
  readonly entered: number;
  readonly refused: string | null;
}

/**
 * Whether a served version's carried entry is owed: its own filer's, not a record the company was founded with as it
 * was founded (its founding seat enters those, first), and named nowhere in the company's records.
 */
const owedEntryOf = (company: string, held: RecordsHeld, rec: SealedCompanyRecord): ManifestEntry | null => {
  if (
    rec.company !== company ||
    (rec.version === 1 && FOUNDING_RECORDS.some((r) => r.kind === rec.kind && r.id === rec.id)) ||
    carriedEntryRefusal(rec) !== null
  )
    return null;
  const s = heldStandingOf(held, companyRecordEntry(rec), verifiedCompanyFiler(rec)!);
  return s.standing === 'not-entered' && s.newest < rec.version ? rec.entry! : null;
};

/**
 * **THE SWEEP**: enters, in version order, each carried entry the versions
 * `served` owe the company's records as `held` reads them. Enters nothing while
 * nothing is anchored, nor past a stop the read came to (no version past one
 * reads as not entered). A refusal by the service is
 * returned, never thrown: the version then stays unentered, and the read that
 * follows refuses it as it did before.
 */
export async function carriedEntriesEntered(
  doors: { readonly accountId: string; readonly manifest: Pick<ManifestService, 'enter'> },
  held: RecordsHeld,
  served: readonly SealedCompanyRecord[]
): Promise<CarriedEntered> {
  if (held.reached.seq < 0) return { entered: 0, refused: null };
  const owed = new Map<Hex, ManifestEntry>();
  for (const rec of [...served].sort((a, b) => a.version - b.version)) {
    const e = owedEntryOf(doors.accountId, held, rec);
    if (e !== null) owed.set(entryIdOf(e), e);
  }
  const entries = [...owed.values()];
  let entered = 0;
  for (let i = 0; i < entries.length; i += ENTRIES_AT_ONCE) {
    const some = entries.slice(i, i + ENTRIES_AT_ONCE);
    try {
      await doors.manifest.enter(doors.accountId, some);
    } catch (e) {
      return { entered, refused: (e as Error)?.message ?? String(e) };
    }
    entered += some.length;
  }
  return { entered, refused: null };
}

/** The company's records as one record's sweep reads them through the step's view: versions, directory, held and entries. */
interface EnteredThroughTheView {
  readonly accountId: string;
  readonly view: Pick<CompanyView<unknown>, 'company' | 'records' | 'manifest' | 'declare' | 'directory'> & {
    /** The records held as the anchor holds them, for the records asked: all the sweep reads of a held read. */
    held(more: RecordsAsked): Promise<{ readonly records: RecordsHeld }>;
  };
}

/** Every served version of the record, and the records as the company holds them for it, read through the view. */
async function sweptThroughTheView(doors: EnteredThroughTheView, kind: CompanyRecordKind, id: string) {
  const { view } = doors;
  if (view.company !== doors.accountId) {
    throw new Error(
      `the read of company ${view.company} was handed in for company ${doors.accountId}, so nothing of either is entered through it.`
    );
  }
  const name = { store: 'company' as const, kind, id };
  view.declare({ records: [name] });
  const [versions] = await view.records([{ kind, id, every: true }]);
  await view.directory();
  return { versions, held: (await view.held({ records: [name] })).records, manifest: view.manifest };
}

/**
 * The sweep over every served version of one company record: read as the
 * company's records hold it now, and each owed carried entry entered. The
 * caller reads the record again when anything was entered. Every read and
 * entry goes through the step's view.
 */
export async function recordEnteredHere(
  doors: EnteredThroughTheView,
  kind: CompanyRecordKind,
  id: string
): Promise<CarriedEntered> {
  const read = await sweptThroughTheView(doors, kind, id);
  const b = read.versions as { versions?: unknown } | null | undefined;
  if (!Array.isArray(b?.versions))
    return { entered: 0, refused: "the service did not answer with the record's versions" };
  const served = b.versions.map((w: unknown) => fromCompanyWire(w, { company: doors.accountId, kind, id }).sealed);
  return carriedEntriesEntered({ accountId: doors.accountId, manifest: read.manifest }, read.held, served);
}

/**
 * A read, made again once after the sweep when it refused for a reason the
 * sweep can lift (`unentered`) and the sweep entered something; otherwise its
 * refusal stands as it was thrown.
 */
export async function readAfterEntering<T>(
  read: () => Promise<T>,
  unentered: (e: unknown) => boolean,
  sweep: () => Promise<CarriedEntered>
): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!unentered(e) || (await sweep()).entered === 0) throw e;
    return read();
  }
}
