/**
 * Whether a seat invitation made by address was signed by a seat this device believes may invite, and whether the
 * address and rights a proposal invites are the ones that seat signed. The seats come from the company's directory as
 * this device reads it; an invitation signed by any other key, or naming another company, address or rights, is refused.
 */
import { seatInvitationRefusal, type SignedSeatInvitation } from '../../../src/core/invitation.js';
import type { DirectoryWitness } from '../../../src/core/roster-record.js';
import { mayInvite } from '../../../src/midnight/seat-directory.js';
/**
 * Whether `invited` is signed by the filing key of a seat this device believes,
 * whose role may invite (`mayInvite`), and which it has not seen retired - or,
 * once the chain holds the leaf the request is for (`leafOnTheChain`), which it
 * believes at all: the signers approved that leaf on the chain with its
 * inviter checked, so an inviter who has left since strands nobody waiting to
 * be admitted.
 */
export const signedByASeatHeld = (invited: SignedSeatInvitation, seats: readonly DirectoryWitness[], leafOnTheChain = false): boolean =>
  seats.some((x) => (leafOnTheChain || !x.retired) && mayInvite(x) && x.signingKey.toLowerCase() === invited.signedBy.toLowerCase());

/** The way out every refusal of an invitation by address names. */
const RAISE_IT_AGAIN = 'Withdraw this proposal, and raise the invitation again from the device of a seated signer who may invite.';

/**
 * **WHAT A SIGNER APPROVES WHEN THEY APPROVE AN INVITATION IS WHAT THE SEAT
 * THAT INVITED SIGNED.** Why the address and the rights a proposal invites
 * (`invite`, as the raiser sealed them beside it) are not bound to the
 * invitation it carries (`invited`), in the sentence a device shows, or null:
 * the invitation must be a seat invitation (`seatInvitationRefusal`) for this
 * company that names an address, signed by the filing key of a seat this
 * device believes, has not seen retired and whose role may invite; and the
 * address and the rights the proposal invites must be the ones it signed. The
 * payload a device then approves is made from the signed invitation alone, so
 * a raiser who names another address or wider rights is refused here and, if
 * the record says otherwise, by the payload made again before any call is
 * built. Run on the raising device before it raises, and on every approving
 * device before it approves.
 */
export const invitationByAddressRefusal = (
  company: string, invited: unknown, invite: { readonly address?: unknown; readonly scope?: unknown }, seats: readonly DirectoryWitness[],
): string | null => {
  if (seatInvitationRefusal(invited) !== null) {
    return `This proposal does not carry an invitation signed by the seat that invited, so this device does not act on it. ${RAISE_IT_AGAIN}`;
  }
  const signed = invited as SignedSeatInvitation;
  const t = signed.terms;
  if (t.invite === undefined) {
    return `The invitation this proposal carries does not name the address it invites, so this device does not act on it. ${RAISE_IT_AGAIN}`;
  }
  if (t.company !== company) {
    return `The invitation this proposal carries is for another company, so this device does not act on it. ${RAISE_IT_AGAIN}`;
  }
  if (!signedByASeatHeld(signed, seats)) {
    const inviter = seats.find((x) => x.signingKey.toLowerCase() === signed.signedBy.toLowerCase());
    return inviter !== undefined && !inviter.retired && !mayInvite(inviter)
      ? `The seat that signed this invitation has a role that may not file a proposal, so it invites nobody. ${RAISE_IT_AGAIN}`
      : `The seat that signed this invitation is not one this device believes is seated, so this device does not act on it. ${RAISE_IT_AGAIN}`;
  }
  if (String(invite.address).toLowerCase() !== t.invite.address.toLowerCase() || String(invite.scope).toLowerCase() !== t.invite.scope.toLowerCase()) {
    return 'The address or the rights this proposal invites are not the ones the seat that invited signed, so this device does not '
      + `approve it. Do not approve it. ${RAISE_IT_AGAIN}`;
  }
  return null;
};
