/**
 * The company's list of signers as a removal reads it. Every other read of it stops while the network shows a seat taken
 * on an invitation this wallet cannot tie to that one invitation (`seatingRefusedRead`), and the one change that clears
 * that is removing such a seat. So the removal of one of those seats reads the signers this wallet believes from the
 * roster as filed, and its approvers are counted from them alone. The removal of any other seat still stops, with
 * words saying that seat is removed first. Any other stop is thrown as it came.
 */
import type { OpenedAccount } from '../../../../packages/web-shared/src/company-judges.js';
import { seatingRefusedRead } from '../../../../packages/web-shared/src/roster-seating-refused.js';
import type { CompanyReach } from './company-reach.js';
import { StepRefused } from './definition.js';

/** The name a removal seals for a seat the company's roster names no one for: the network shows the seat, and no name. */
export const UNREAD_SEAT_NAME = 'a seat the company\'s roster does not name';

/** The list of signers a removal reads, and whether the seat it takes is one the network shows and the roster names no one for. */
export type RemovalRoster = OpenedAccount & { readonly leavingUnread: boolean };

/**
 * The roster `r` reads, or, where that read stops on a seat it cannot tell as any seat and `leaf` is such a seat, the
 * signers believed when it stopped. Then no seat is listed as one the roster leaves out: every seat the believed
 * signers do not name, whether it cannot be told, waits for Finish adding or has an entry refused, is counted as no
 * vault's approver. That can only refuse a removal the chain would carry, never let one through it would refuse, and
 * it sends nobody to Finish adding, which stops on the same seat. Refuses the removal of any other seat while the
 * read stops that way.
 */
export const rosterForARemovalHere = async (r: Pick<CompanyReach, 'roster'>, leaf: string): Promise<RemovalRoster> => {
  try {
    return { ...await r.roster(), leavingUnread: false };
  } catch (e) {
    const held = seatingRefusedRead(e);
    if (held === null) throw e;
    const leaving = leaf.toLowerCase();
    if (!held.unread.includes(leaving)) {
      throw new StepRefused({ key: 'act.remove-signer.why.unread-seat-first', values: { seats: held.unread.join(', ') } });
    }
    return { ...held.account, notBelieved: [], leavingUnread: true };
  }
};

/** `r`, with its list of signers read as the removal of `leaf` reads it; everything else is `r`'s own. */
export const removalReachFor = (r: CompanyReach, leaf: string): CompanyReach => ({ ...r, roster: () => rosterForARemovalHere(r, leaf) });
