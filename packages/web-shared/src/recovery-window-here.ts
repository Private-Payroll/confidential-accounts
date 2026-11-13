/**
 * **THE RECOVERY WINDOW AS THIS DEVICE READS IT**, from the company's records through its service, every version judged
 * against the company's directory and the chain, folded at the seat bar (`recoveryWindowInForceOf`). Read whole or not
 * at all: a version the records name that the service did not give, a version that does not open here, or a chain read
 * with no seat bar is said as unread, never as no window.
 *
 * The wallet reads it in its upkeep and keeps it beside the last records it checked (`KeptRecoveryWindow`), so a
 * recovery, which asks the service nothing, holds the window as of the batch it resumes from. The page reads it to show
 * the window and to offer only waits within it.
 */
import type { ServiceOpener } from '../../../src/midnight/company-service-record.js';
import type { Hex } from '../../../src/core/crypto.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import {
  openRecoveryWindow, RECOVERY_WINDOW_RECORD, recoveryWindowInForceOf, windowMessage, windowOpenedWithTheCompanyKey,
  type WindowChange, type WindowVersion,
} from '../../../src/midnight/recovery-window-record.js';
import { companyWirePaths, fromCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey, type DirectorySeat } from '../../../src/midnight/seat-directory.js';
import { barReadable, quorumOf } from '../../../src/midnight/seat-quorum.js';
import type { CompanyKeyHere } from './company-key-here.js';
import type { ServiceReach } from './company-service-here.js';
import { countAsAnchoredFor, versionsWithheldIn } from './signed-record-here.js';
import type { KeptRecoveryWindow, RecoveryWindowsKeptStore } from './tree-kept-here.js';
import { judgeIn, type DirectoryHere } from './vault-page-doors.js';
import { saidWithoutStop } from './vault-info-here.js';

/** A change of the window: its length, its number and the version it is filed at. */
interface WindowSeen {
  readonly seconds: number;
  readonly version: number;
  readonly sequence: number;
}

/** A change still gathering signatures: how many seats the chain holds have signed it, of the seat bar it needs. */
interface WindowWaiting extends WindowSeen {
  readonly signed: number;
  readonly needed: number;
  readonly change: WindowChange;
}

/** The last records this read checked, and the batches that anchored each version of the window they name. */
interface WindowNamed {
  readonly at: { readonly head: Hex; readonly seq: number };
  readonly named: readonly number[];
}

/**
 * The window as read here: the change in force (null for none), the change still gathering signatures, the highest
 * version filed, and, from the same directory read, the records it was read at (`at`, `named`).
 */
export interface WindowRead extends WindowNamed {
  readonly inForce: WindowSeen | null;
  readonly waiting: WindowWaiting | null;
  readonly highest: number;
  readonly here: DirectoryHere;
}

/**
 * Why the window was not read here. `noKey`: the records name a version this device holds no key to open, the one
 * case a device keeps the window as unread. Any other failure (the service, the directory, a count) leaves it as kept.
 * `at` and `named` are given whenever the directory was read.
 */
interface WindowUnread extends Partial<WindowNamed> {
  readonly unread: string;
  readonly noKey?: true;
}

/** The doors: the service reach the wallet and the page already build, whose opener's seat copy opens a version. */
export type WindowReach = Pick<ServiceReach, 'accountId' | 'api' | 'judges' | 'label' | 'account' | 'roster' | 'opener'>
  & { readonly companyKeys: CompanyKeyHere };

const MISSING = (version: number): string => `the company's records name version ${version} of the recovery window and the service did not give it. `
  + 'Reload, and if it happens again the service is withholding it';
const AS_ANCHORED_UNREAD = 'who held the company\'s account when the records anchored a version of the recovery window could not be read, so no signature on it is counted';
const NO_KEY = (version: number, epoch: number): string =>
  `version ${version} of the recovery window was sealed under the company's key at epoch ${epoch}, which this device does not hold`;

const windowOpenerOf = (accountId: string, opener: ServiceOpener, companyKeys: Pick<CompanyKeyHere, 'keyAt'>): ServiceOpener => ({
  signerId: opener.signerId, keyOf: opener.keyOf, companyCopy: windowOpenedWithTheCompanyKey(accountId, (epoch) => companyKeys.keyAt(epoch)),
});

/** Where the records this directory read checked stand, and the batches that anchored each version of the window they name. */
const namedIn = (here: DirectoryHere): WindowNamed => ({
  at: { head: here.records.reached.head, seq: here.records.reached.seq },
  named: (here.records.history.get(recordKeyOf({ store: 'company', ...RECOVERY_WINDOW_RECORD })) ?? []).map((v) => v.batch),
});

/**
 * **THE WINDOW READ.** Every version the service gives, judged and folded; unread rather than guessed. `anchoredOnly`
 * folds only the versions the records anchor up to the head read, as the window a recovery from that head holds.
 */
export async function recoveryWindowHere(r: WindowReach, o: { readonly anchoredOnly?: boolean } = {}): Promise<WindowRead | WindowUnread> {
  const { kind, id } = RECOVERY_WINDOW_RECORD;
  let here: DirectoryHere;
  try {
    here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)({ records: [{ store: 'company', kind, id }] }) as DirectoryHere;
  } catch (e) {
    return { unread: saidWithoutStop(e) };
  }
  const named = namedIn(here);
  try {
    const b = await r.api(companyWirePaths.versions(r.accountId, kind, id)).catch((e: unknown) => {
      if ((e as { status?: unknown } | null)?.status === 404) return null;
      throw e;
    }) as { versions?: unknown } | null;
    const given = b?.versions;
    const served: SealedCompanyRecord[] = Array.isArray(given) ? given.map((m) => fromCompanyWire(m, { company: r.accountId, kind, id }).sealed) : [];
    const read = windowFromVersions(r.accountId, served, here, windowOpenerOf(r.accountId, r.opener, r.companyKeys), r.companyKeys, o.anchoredOnly === true);
    return { ...named, ...read };
  } catch (e) {
    return { ...named, unread: saidWithoutStop(e) };
  }
}

/** The window from the versions served and the directory read, as `recoveryWindowHere` judges them. */
function windowFromVersions(
  accountId: string, served: readonly SealedCompanyRecord[], here: DirectoryHere, opener: ServiceOpener,
  keys: Pick<CompanyKeyHere, 'keyAt'>, anchoredOnly: boolean,
): Omit<WindowRead, keyof WindowNamed> | Omit<WindowUnread, keyof WindowNamed> {
  const { kind, id } = RECOVERY_WINDOW_RECORD;
  const anchored = new Set((here.records.history.get(recordKeyOf({ store: 'company', kind, id })) ?? []).map((v) => v.version));
  const ours = served.filter((rec) => rec.company === accountId && rec.kind === kind && rec.id === id && (!anchoredOnly || anchored.has(rec.version)));
  const judge = judgeIn(here);
  const withheld = versionsWithheldIn(here, ours, RECOVERY_WINDOW_RECORD, MISSING, judge.withheld);
  if (withheld !== null) return { unread: withheld };
  if (!barReadable(here.holders)) return { unread: 'who holds the company\'s account was read without the approvals a change of who is seated needs' };
  const filed = ours.filter((rec) => judge(verifiedCompanyFiler(rec), kind, companyRecordKey(kind, id), companyRecordEntry(rec)) === null);
  const versions: WindowVersion[] = [];
  for (const rec of filed) {
    const change = openRecoveryWindow(rec, opener);
    if (change === null && !holdsTheKeyAt(keys, rec.keyEpoch)) return { unread: NO_KEY(rec.version, rec.keyEpoch), noKey: true };
    versions.push({ version: rec.version, filer: verifiedCompanyFiler(rec), change });
  }
  const now = { seats: here.dir.seats, held: (seat: DirectorySeat) => here.holders.seats.includes(seat.seat), bar: Number(here.holders.seatBar) };
  const asAnchored = countAsAnchoredFor(here, filed, RECOVERY_WINDOW_RECORD, () => new Error(AS_ANCHORED_UNREAD));
  let folded: ReturnType<typeof recoveryWindowInForceOf>;
  try {
    folded = recoveryWindowInForceOf(accountId, versions, { ...now, asAnchored });
  } catch (e) {
    return { unread: saidWithoutStop(e) };
  }
  const seen = (v: WindowVersion & { readonly change: WindowChange }): WindowSeen => ({ seconds: v.change.seconds, version: v.version, sequence: v.change.sequence });
  const waiting = folded.waiting;
  const signed = waiting === null ? 0 : quorumOf(now.seats, windowMessage(accountId, waiting.change), waiting.change.signatures, now.held);
  return {
    inForce: folded.inForce === null ? null : seen(folded.inForce),
    waiting: waiting === null ? null : { ...seen(waiting), signed: typeof signed === 'number' ? signed : 0, needed: now.bar, change: waiting.change },
    highest: ours.reduce((n, rec) => Math.max(n, rec.version), 0),
    here,
  };
}

/**
 * Whether this device holds the company's key at `epoch`. A version that does not open although it does was sealed
 * wrong for every device, and is folded as not opened; one sealed under a key this device lacks is unread here.
 */
const holdsTheKeyAt = (keys: Pick<CompanyKeyHere, 'keyAt'>, epoch: number): boolean => {
  try {
    keys.keyAt(epoch);
    return true;
  } catch {
    return false; /* keyAt throws only when this device holds no key at that epoch, which is the answer asked */
  }
};

/**
 * **THE WINDOW KEPT BESIDE THE LAST RECORDS THIS WALLET CHECKED**, under the head the same directory read stood on.
 * A window read is kept as read: the length in force, or null for none. Unread is kept only when the records name a
 * version this device holds no key to open. Any other failure keeps what was kept, unless the directory was read and
 * names no version of the window at all (kept as none in force), or names none anchored after the head kept before
 * (that window carried forward to the new head).
 */
export async function keepRecoveryWindowHere(
  accountId: string, read: () => Promise<WindowRead | WindowUnread>, kept: { readonly windows: RecoveryWindowsKeptStore },
): Promise<KeptRecoveryWindow | null> {
  const got = await read();
  const before = await kept.windows.read(accountId);
  const keep = async (window: KeptRecoveryWindow): Promise<KeptRecoveryWindow> => { await kept.windows.write(accountId, window); return window; };
  if (got.at === undefined || got.at.seq < 0) return before;
  if (!('unread' in got)) return keep({ ...got.at, seconds: got.inForce?.seconds ?? null });
  if (got.noKey === true) return keep({ ...got.at, seconds: null, unread: got.unread });
  const named = got.named ?? [];
  if (named.length === 0) return keep({ ...got.at, seconds: null });
  if (before !== null && before.unread === undefined && before.seq <= got.at.seq && named.every((batch) => batch <= before.seq)) {
    return keep({ ...got.at, seconds: before.seconds });
  }
  return before;
}
