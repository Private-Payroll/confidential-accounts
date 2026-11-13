/**
 * **WHEN A CHANGE OF THE COMPANY'S KEY IS OWED, AND WHAT IT WAITS FOR.** A retirement no change of key has followed
 * yet (`owedIn`), or a read grant taken away while the newest key was in force, and everything a change after a removal waits for before this device makes it (`removalWaitsHere`):
 * each read from the directory this device believes and the chain's holders. The change itself is made in
 * `company-key-here.ts`.
 */
import type { DirectoryRotation, DirectorySeat } from '../../../src/midnight/seat-directory.js';
import type { RotationDoors } from './company-key-here.js';
import type { DirectoryHere } from './vault-page-doors.js';

/** The version of the newest retirement no rotation has followed yet (`after`), and the version of the newest rotation (`since`); null when every retirement is followed. */
export const owedIn = (here: DirectoryHere): { readonly after: number; readonly since: number } | null => {
  const retiredAt = here.dir.seats.flatMap((x) => (x.retired !== null && x.retiredAt !== undefined ? [x.retiredAt] : []));
  if (retiredAt.length === 0) return null;
  const after = Math.max(...retiredAt);
  const rotations = here.dir.rotations ?? [];
  const since = rotations.length === 0 ? 0 : rotations[rotations.length - 1]!.version;
  return after > since ? { after, since } : null;
};

/** Whether a change of the key was filed by a seat the directory has retired since and the chain no longer holds. */
export const filedByARemovedSeat = (here: DirectoryHere, r: DirectoryRotation): boolean => {
  const filer = here.dir.seats.find((x) => x.seat === r.by);
  return filer !== undefined && filer.retired !== null && filer.retiredAt !== undefined && filer.retiredAt > r.version
    && !here.holders.seats.includes(filer.seat);
};

/**
 * Whether the seats that stay, among those the chain holds, are enough to meet the higher of the account's threshold and
 * its seat bar on their own. A retired seat the chain still holds gets no copy of a new key, so it can never open, and so
 * never approve, a proposal sealed under it; the key changes past such a seat only while no proposal needs it.
 */
const stayersApproveAlone = (here: DirectoryHere): boolean => {
  const staying = here.holders.seats.filter((s) => here.dir.seats.some((x) => x.seat === s && x.retired === null)).length;
  return staying >= Math.max(Number(here.holders.approvals ?? 0), Number(here.holders.seatBar ?? 0));
};

/** Where a seat's device stands after a removal, before it changes the company's key or a vault's secret. */
type RemovalWaited =
  | { readonly state: 'waits' | 'not-this-seat'; readonly why: string }
  | { readonly state: 'not-needed' }
  | { readonly state: 'ready'; readonly seat: DirectorySeat; readonly owed: KeyChangeOwed };

/**
 * What a change of the company's key is owed for: a retirement no change has followed (`after`, and the newest change,
 * `since`), or a read grant taken away while the newest key was in force, which a repair of that key (`repairs`)
 * answers, following the retirement the newest change followed (`after`, 0 when none).
 */
type KeyChangeOwed =
  | { readonly after: number; readonly since: number }
  | { readonly after: number; readonly repairs: number };

/**
 * Whether a seat the chain holds and the directory has no entry for was admitted by the company's roster: such a seat
 * files its own entry first (its wallet's `ownEntryFiled`), so a change made now would leave it out. Waits too when the
 * roster cannot be read to tell. Null when no such seat is held.
 */
const admittedWaits = async (here: DirectoryHere, doors: Pick<RotationDoors, 'admitted'>): Promise<RemovalWaited | null> => {
  const unentered = here.holders.seats.filter((s) => !here.dir.seats.some((x) => x.seat === s));
  if (unentered.length === 0) return null;
  let admitted: ReadonlySet<string> | null = null;
  try {
    admitted = doors.admitted === undefined ? new Set(unentered.map((s) => s.toLowerCase())) : await doors.admitted();
  } catch {
    /* A roster that cannot be read cannot say the seat was not admitted: the change waits, as below. */
    admitted = null;
  }
  if (admitted === null) {
    return { state: 'waits', why: 'the chain holds a seat the company\'s directory has no entry for, and the company\'s roster could not be read to tell whether it was admitted' };
  }
  const roster = admitted;
  return unentered.some((s) => roster.has(s.toLowerCase()))
    ? { state: 'waits', why: 'the chain holds a seat the company\'s directory has no entry for yet; that seat files its entry first' } : null;
};

/**
 * **WHAT EVERY CHANGE AFTER A REMOVAL WAITS FOR, IN ONE PLACE.** `seat` is this device's own entry (`ownSeatIn`).
 * Nothing is made by a seat that is not in the directory, is retired, is the one leaving (`leaf`: the leaver's own
 * wallet makes nothing for the seats that stay), is no longer held by the chain or under an approved removal, or whose
 * role `mayAct` refuses (it returns why, in the caller's words); and nothing while who is under an approved removal
 * cannot be read, a change of the company's key is filed and not anchored, the retirement is not anchored, the chain
 * still holds a retired seat while the seats that stay could not meet the chain's approvals without it
 * (`stayersApproveAlone`), the chain holds a seat the directory has no entry for that the company's roster admitted,
 * or the directory holds a seat that stays and the chain no longer holds. `not-needed` is a company whose key is not
 * owed a change; `ready` names the seat that acts and what is owed (`owedIn`), or, when no retirement is owed and a read
 * grant was taken away while the newest key was in force (`revoked`, read only then: a retirement's change clears a
 * taking-away anyway), or when `repair` asks for one, a repair of the newest key. A repair asked for while a removal's
 * change is owed waits: that change is made first. A read of the grants that fails waits, to be read again first.
 * With `admittedFirst` (a change made whether or not the key is owed one, as a vault's secret is), a seat the roster
 * admitted that has filed no entry yet is waited for before `not-needed` too, so it is not left out of that change.
 */
export async function removalWaitsHere(
  here: DirectoryHere, seat: DirectorySeat | undefined,
  o: { readonly leaf?: string; readonly revoked?: () => Promise<number | null>; readonly admittedFirst?: boolean; readonly repair?: boolean },
  mayAct: (seat: DirectorySeat) => string | null, doors: Pick<RotationDoors, 'leaving' | 'admitted'>,
): Promise<RemovalWaited> {
  if (seat === undefined) return { state: 'not-this-seat', why: 'this device\'s seat has no entry in the company\'s directory' };
  if (seat.retired !== null) return { state: 'not-this-seat', why: 'this seat is retired from the company' };
  if (typeof o.leaf === 'string' && o.leaf.toLowerCase() === seat.seat) return { state: 'not-this-seat', why: 'this seat is the one leaving' };
  if (!here.holders.seats.includes(seat.seat)) return { state: 'not-this-seat', why: 'the chain no longer holds this seat' };
  const roleMayNot = mayAct(seat);
  if (roleMayNot !== null) return { state: 'not-this-seat', why: roleMayNot };
  let leaving: ReadonlySet<string>;
  try {
    leaving = await doors.leaving();
  } catch (e) {
    return { state: 'waits', why: `${(e as Error)?.message ?? String(e)}; the company's key is changed once it can be read` };
  }
  if (leaving.has(seat.signingKey.toLowerCase())) return { state: 'not-this-seat', why: 'a removal of this seat is approved' };
  const rotations = here.dir.rotations ?? [];
  if (rotations.some((r) => !here.records.directory.has(r.version))) {
    return { state: 'waits', why: 'a change of the company\'s key is filed and not yet anchored' };
  }
  const owed = owedIn(here);
  const last = rotations[rotations.length - 1];
  let revokedAt: number | null = null;
  if (owed === null && o.revoked !== undefined) {
    try {
      revokedAt = await o.revoked();
    } catch (e) {
      return { state: 'waits', why: `${(e as Error)?.message ?? String(e)}; the company's read grants are read again first` };
    }
  }
  const repairs = o.repair === true || (revokedAt !== null && revokedAt >= (last?.epoch ?? 0)) ? last?.epoch ?? 0 : null;
  if (owed === null && repairs === null) return (o.admittedFirst === true ? await admittedWaits(here, doors) : null) ?? { state: 'not-needed' };
  if (o.repair === true && owed !== null) {
    return { state: 'waits', why: 'a signer\'s removal owes the company a change of its key, with a new payout seed, which is made before any repair: the next action of a signer who stays makes it at its start' };
  }
  if (owed !== null && !here.records.directory.has(owed.after)) return { state: 'waits', why: 'the retirement of the leaving seat is filed and not yet anchored' };
  const stillHeld = owed === null ? [] : here.dir.seats.filter((x) => x.retired !== null && (x.retiredAt ?? 0) > owed.since && here.holders.seats.includes(x.seat));
  if (stillHeld.some((x) => !here.records.directory.has(x.retiredAt ?? 0)) || (stillHeld.length > 0 && !stayersApproveAlone(here))) {
    return { state: 'waits', why: 'the chain still holds a retired seat, so the removal is not carried out on the chain yet' };
  }
  const admittedWait = await admittedWaits(here, doors);
  if (admittedWait !== null) return admittedWait;
  if (here.dir.seats.some((x) => x.retired === null && !here.holders.seats.includes(x.seat))) {
    return { state: 'waits', why: 'the chain no longer holds a seat the directory has not retired; its retirement is filed and anchored first' };
  }
  return { state: 'ready', seat, owed: owed ?? { after: last?.after ?? 0, repairs: repairs ?? last?.epoch ?? 0 } };
}
