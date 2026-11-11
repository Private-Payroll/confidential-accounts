/**
 * What a roster read still knows when it stops on a seat the network shows taken on an invitation this device cannot
 * tie to that one invitation. Every reader stops there (`rosterBelievedHere`), since such a seat may be no one the
 * company meant. The one change that clears it is removing that seat, and a removal needs the signers this device
 * believes to count its approvals, so the stop keeps them beside it: the signers believed from the roster as filed,
 * the seats the chain holds that they leave out, and the seats it could not tell. Nothing else reads them.
 */
import type { Account } from '../../../src/core/types.js';
import { believedSigners, seatsNotBelieved, seatsStaying, type RefusedEntry, type RosterWitnesses } from '../../../src/core/roster-record.js';
import type { BelievedAccount } from './roster-here.js';

/** The signers believed when the read stopped, and the seats on the chain it could not tell as any seat. */
interface SeatingRefusedRead {
  readonly account: BelievedAccount & { readonly refused: readonly RefusedEntry[]; readonly waited: readonly string[] };
  readonly unread: readonly string[];
}

const READS = new WeakMap<object, SeatingRefusedRead>();

/**
 * `stop`, carrying the read it stopped: the roster as filed, judged entry by entry on its signers' witnesses as every
 * believed read is, and `unread`, the seats the chain holds that no seated entry names and no one invited waits for.
 */
export const seatingRefusedHolding = <E extends object>(
  stop: E, held: { readonly opened: Account; readonly witnesses: RosterWitnesses; readonly waited: ReadonlySet<string> }, unread: readonly string[],
): E => {
  const { believed, refused, attesting } = believedSigners(held.opened.signers, held.witnesses);
  READS.set(stop, {
    account: { ...held.opened, signers: believed, attesting, notBelieved: seatsNotBelieved(believed, seatsStaying(held.witnesses)), refused, waited: [...held.waited] },
    unread: unread.map((x) => x.toLowerCase()),
  });
  return stop;
};

/** The read a stop on such a seat carries, or null for any other error. */
export const seatingRefusedRead = (e: unknown): SeatingRefusedRead | null =>
  (typeof e === 'object' && e !== null ? READS.get(e) ?? null : null);
