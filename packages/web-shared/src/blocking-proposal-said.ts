/**
 * A proposal of the company that this device must read and cannot open: whether it is passed over, and the words for
 * one that is not. A removal, and every change that asks who is leaving, is refused while such a proposal stands,
 * because what it says cannot be read. The words name the proposal and the seat that raised it, from the company's own
 * records and directory, since only that signer can withdraw it and a proposal of the company never expires.
 */
import { recordKeyOf } from '../../../src/midnight/record-manifest.js';
import { NotOpenedOnThisDevice } from './round-opened-here.js';
import type { DirectoryHere } from './vault-page-doors.js';

/**
 * Whether a proposal that did not open, read only to learn whether it is of `kind`, is rightly passed over: its record
 * names another kind, or its filer has left and filed it past what the retirement kept, so no device acts on it.
 */
export const passedOverAs = (e: unknown, kind: string): boolean =>
  e instanceof NotOpenedOnThisDevice && (e.passedOver === true || (e.kind !== undefined && e.kind !== kind));

/** The seat whose signing key filed proposal `id` in the company's records, or null where the directory names none. */
const raiserSeatOf = (here: Pick<DirectoryHere, 'records' | 'dir'>, id: string): DirectoryHere['dir']['seats'][number] | null => {
  const key = recordKeyOf({ store: 'proposal', kind: 'proposal', id });
  const filer = (here.records.history.get(key) ?? [])[0]?.filedBy
    ?? here.records.notYetAnchored.find((e) => recordKeyOf(e) === key)?.filedBy.publicKey ?? null;
  if (filer === null) return null;
  return here.dir.seats.find((x) => x.signingKey.toLowerCase() === filer.toLowerCase()) ?? null;
};

/**
 * Why proposal `id` holds this change up, `e` being what stopped it opening, and who can clear it, as far as the chain
 * allows: a proposal whose kind was read is withdrawn only by the signer who raised it, while that signer is seated,
 * and never expires; where that signer is no longer seated, no signer can withdraw it and the company's super admins
 * clear it on the chain. A proposal whose kind was not read may be a payroll run, which any signer can withdraw before
 * its window opens and which closes once its window has passed, so the words say both.
 */
export const blockingProposalSaid = (here: Pick<DirectoryHere, 'records' | 'dir' | 'holders'>, id: string, e: unknown): string => {
  const why = (e as Error)?.message ?? String(e);
  const seat = raiserSeatOf(here, id);
  const seated = seat !== null && seat.retired === null && here.holders.seats.some((x) => x.toLowerCase() === seat.seat.toLowerCase());
  const raiser = seat === null ? 'the signer who raised it' : `the signer who raised it, seat ${seat.seat},`;
  const opened = `proposal ${id} did not open on this device (${why}).`;
  if (!(e instanceof NotOpenedOnThisDevice) || e.kind === undefined) {
    return `${opened} Its kind could not be read. If it is a payroll run, any signer can withdraw it before its window opens, `
      + `and it closes once its window has passed; any other proposal only ${raiser} can withdraw, and it stays open until then`;
  }
  if (seat !== null && !seated) {
    return `${opened} ${raiser.charAt(0).toUpperCase()}${raiser.slice(1)} is no longer seated, so no signer can withdraw it, and it `
      + 'never expires: the company\'s super admins clear it on the network';
  }
  return `${opened} Only ${raiser} can withdraw it, and until then it stays open, since a proposal of the company never expires`;
};
