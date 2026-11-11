/**
 * Whether a seat invitation made by address was signed by a seat this device believes may invite, and whether the
 * address and rights a proposal invites are the ones that seat signed. The seats come from the company's directory as
 * this device reads it; an invitation signed by any other key, or naming another company, address or rights, is refused.
 */
import { canonical } from '../../../src/core/crypto.js';
import { seatInvitationRefusal, type NotApproved, type SignedSeatInvitation } from '../../../src/core/invitation.js';
import { NO_VAULT_COUNTED, vaultsOfferedRefusal } from '../../../src/core/seat-rights.js';
import type { PendingSignerPayload } from '../../../src/core/types.js';
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
  inviterRefusalOf(invited, seats, leafOnTheChain) === null;

/**
 * **WHY THE SEAT THAT SIGNED `invited` INVITES NOBODY**, or null when it may:
 * the one role check every device asks of an inviter (`mayInvite`), on a seat
 * this device believes and has not seen retired, or, once the chain holds the
 * leaf the request is for (`leafOnTheChain`), on any seat it believes.
 */
export const inviterRefusalOf = (
  invited: SignedSeatInvitation, seats: readonly DirectoryWitness[], leafOnTheChain = false,
): 'not-seated' | 'may-not-invite' | null => {
  const inviter = seats.find((x) => x.signingKey.toLowerCase() === invited.signedBy.toLowerCase() && (leafOnTheChain || !x.retired));
  if (inviter === undefined) return 'not-seated';
  return mayInvite(inviter) ? null : 'may-not-invite';
};

/** The way out every refusal of an invitation by address names. */
const RAISE_IT_AGAIN = 'Withdraw this proposal, and raise the invitation again from the device of a seated signer who may invite.';

/**
 * **WHAT A SIGNER APPROVES WHEN THEY APPROVE AN INVITATION IS WHAT THE SEAT
 * THAT INVITED SIGNED.** Why the address and the rights a proposal invites
 * (`invite`, as the raiser sealed them beside it) are not bound to the
 * invitation it carries (`invited`), in the sentence a device shows, or null:
 * the invitation must be a seat invitation (`seatInvitationRefusal`) for this
 * company that names an address, signed by the filing key of a seat this
 * device believes, has not seen retired and whose role may invite
 * (`inviterRefusalOf`), offering only vaults within that seat's own rights as
 * the directory holds them (`vaultsOfferedRefusal`); and the
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
  const notInviting = inviterRefusalOf(signed, seats);
  if (notInviting !== null) {
    return notInviting === 'may-not-invite'
      ? `The seat that signed this invitation has a role that may not file a proposal, so it invites nobody. ${RAISE_IT_AGAIN}`
      : `The seat that signed this invitation is not one this device believes is seated, so this device does not act on it. ${RAISE_IT_AGAIN}`;
  }
  const inviter = seats.find((x) => !x.retired && x.signingKey.toLowerCase() === signed.signedBy.toLowerCase());
  const wider = vaultsOfferedRefusal(inviter?.rights ?? NO_VAULT_COUNTED, t.vaults);
  if (wider !== null) return `This device does not act on this invitation: ${wider}. ${RAISE_IT_AGAIN}`;
  if (String(invite.address).toLowerCase() !== t.invite.address.toLowerCase() || String(invite.scope).toLowerCase() !== t.invite.scope.toLowerCase()) {
    return 'The address or the rights this proposal invites are not the ones the seat that invited signed, so this device does not '
      + `approve it. Do not approve it. ${RAISE_IT_AGAIN}`;
  }
  return null;
};

/** What a device says for each way an invitation is not the one its approvers agreed to (`approvedInvitationRefusal`). */
export const NOT_APPROVED_SAID: Readonly<Record<NotApproved, string>> = Object.freeze({
  'not-raised': 'The invitation this proposal carries names no proposal raised for the address it seats, so the approvers would not be agreeing to its role',
  'not-its-salt': 'The salt this proposal is raised under is not the one its invitation makes, so the proposal would not commit to the person, name and role invited',
  'not-its-proposal': 'The proposal this invitation names is not the one its address, rights, threshold and salt make',
  'another-leaf': 'The seat this invitation names is not the one the network shows its proposal took',
});

/**
 * **WHY THE INVITATION A LINK OR CODE PROPOSAL CARRIES IS NOT FOR THE PERSON
 * WAITING**, or null: the seat it names is the leaf the waiting request
 * carries, its role, vaults, person and name are the ones the invitation the
 * person accepted gives, and the rights its address carries are the ones the
 * person's own leaf was made with. Run on every approving device after it has
 * checked the waiting request itself (`refuseASeatNotForTheInvited`), so the
 * approvers agree only to the seat the person accepted.
 */
export const linkInvitationRefusal = (invited: SignedSeatInvitation, waiting: Pick<PendingSignerPayload, 'leafCommitment' | 'invited' | 'opening'>): string | null => {
  const t = invited.terms;
  const w = waiting.invited?.terms;
  const vaultsOf = (x: { readonly vaults?: readonly string[] }) => canonical((x.vaults ?? []).map((v) => v.toLowerCase()));
  if (w === undefined || t.leaf?.toLowerCase() !== waiting.leafCommitment.toLowerCase() || t.role !== w.role || vaultsOf(t) !== vaultsOf(w)
    || t.person !== w.person || t.name !== w.name || String(waiting.opening?.scope).toLowerCase() !== t.invite?.scope.toLowerCase()) {
    return 'The invitation this proposal carries does not give the seat, role, vaults, person or name of the person waiting for it, so this '
      + 'device does not approve it. Do not approve it. Withdraw it, and invite the person again.';
  }
  return null;
};
