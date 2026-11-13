/**
 * What an invited signer's device sends beside its keys, for the tests that accept a seat through the service: the
 * proof its link let it make, for their sign-in and the invitation behind it, and that invitation as the inviting
 * seat signed it. Every seating device holds the request to both, so a test that leaves either out is refused there.
 */
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation } from '../core/invitation.js';
import type { Role } from '../core/roles.js';
import { newSeatInvitation, proveSeatKeys } from '../core/seat-invite-proof.js';

/** The seat that signs each invitation these tests make. */
const INVITING_SEAT = newSigningKeypair().secret as Hex;

/** Each invitee's sign-in, from the name they were invited under. */
export const personOf = (invite: { name?: string }): string => `usr_${String(invite.name).toLowerCase()}`;

/** The proof and the signed invitation, in the order the service's acceptance takes them. */
export const provenBy = (
  viewingKey: string, invite: { accountId: string; name?: string; role?: string },
  signingPublicKey: string, wrappingPublicKey: string, leafCommitment: string, person: string = personOf(invite),
) => {
  const invitationId = invitationIdOf(newInvitationToken());
  const proof = proveSeatKeys(newSeatInvitation(viewingKey, invite.accountId, invite.name!, invite.role!, invitationId),
    { signingPublicKey, wrappingPublicKey, leafCommitment }, { person, invitationId });
  const invited = signSeatInvitation({
    company: invite.accountId, invitation: invitationId, person, name: invite.name!, role: invite.role as Role,
  }, INVITING_SEAT);
  return [proof, invited] as const;
};
