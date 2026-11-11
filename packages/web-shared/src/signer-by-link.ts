/**
 * **A SIGNER WHO JOINED BY A LINK OR A CODE, SEATED FROM A SIGNER'S DEVICE.**
 * The invitation the person accepted is signed again by this seat, naming the
 * leaf their device made and the address they take it from, and raised as one
 * proposal like any other change; the person takes the seat from their own
 * wallet, and is admitted here once the chain holds it.
 */
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import {
  invitationProposalSalt, seatByAddressChangeOf, signSeatInvitation, type Inviter, type ProposalIdentityOf, type SignedSeatInvitation,
} from '../../../src/core/invitation.js';
import { InvitationNotBound, proposalIdentityOn, raiseTheSeatHere, type GovernanceDoors, type GovernedOutcome } from './governed-call-on-device.js';
import { admitSignerHere, rosterHere, seatingOf, waitingHere, type RosterDoors } from './roster-here.js';

/**
 * **THE INVITATION A SEAT IS ENTERED UNDER, NAMING ITS LEAF, THE ADDRESS IT
 * IS TAKEN FROM AND THE PROPOSAL RAISED FOR IT.** It is signed again here with
 * the same terms, the leaf, and the address's commitment, salt and rights, by
 * this seat's filing key, which every member's device holds to a seat it
 * believes, has not seen retired and whose role may invite, as it holds any
 * inviter. The proposal is raised under the salt those terms make
 * (`invitationProposalSalt`), as an invitation by address is, so the proposal
 * the approvers sign commits to the role, the vaults and the leaf; the
 * invitation names that proposal, worked out with `identity`.
 */
const invitationForTheLeaf = async (
  invited: SignedSeatInvitation, leaf: string, invite: { address: string; salt: string; scope: string }, signingSecret: Hex,
  identity: ProposalIdentityOf,
): Promise<{ readonly invited: SignedSeatInvitation; readonly salt: string }> => {
  /* This path raises a seat that keeps the threshold in force: an invitation that names one is never signed again without it. */
  if (invited.terms.invite?.threshold !== undefined) throw new InvitationNotBound(SEAT_BY_LEAF_SETS_NO_THRESHOLD);
  const { proposal: _named, ...accepted } = invited.terms;
  const terms = {
    ...accepted, leaf: leaf as Hex,
    invite: { address: invite.address.toLowerCase() as Hex, salt: invite.salt.toLowerCase() as Hex, scope: invite.scope.toLowerCase() as Hex },
  };
  const salt = invitationProposalSalt({ terms, signedBy: signingPublicKeyOf(signingSecret) });
  const { chainId } = await identity(seatByAddressChangeOf(terms.invite), salt);
  return { invited: signSeatInvitation({ ...terms, proposal: String(chainId).toLowerCase() as Hex }, signingSecret), salt };
};

/** Why a seat entered under the leaf its person sealed is refused when its invitation sets a threshold. */
const SEAT_BY_LEAF_SETS_NO_THRESHOLD = 'This invitation sets the approvals the company needs once the seat is taken, and a seat '
  + 'entered under the leaf its person sent keeps the threshold in force, so nothing was raised. Invite the person by their '
  + 'private address instead, which carries the new threshold to the seat.';

/**
 * **ONE PERSON WAITING FOR A SEAT, INVITED AND ADMITTED AS FAR AS THIS DEVICE
 * CAN.** Who waits is read from the company's inbox and checked here before
 * anything is raised, approved or filed (`waitingHere`): their keys against the
 * proof their invitation gave them, against every other signer's, against the
 * fingerprint they read out (`readOut`), against the sign-in their request was
 * sealed for, and against the invitation a seat this device believes signed for
 * them, their leaf proved for their wallet. The invitation (`invite`: the
 * commitment to their address and the rights the seat carries) is then raised
 * under the salt its signed terms make, so the approvers agree to its role, its
 * vaults and its leaf, and approved like any other change, the new seat counted
 * on the vaults its role's rights reach; the invitee takes the seat from their
 * own wallet; this device never carries it out. Once the chain holds their
 * leaf, they are admitted to the roster from this device and the company's key
 * is wrapped to them.
 */
export async function seatSignerOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: {
    viewingKey: KeysHeld; signerId: string; readOut: string;
    /**
     * This seat as an inviter record - its wallet key, the directory entry its wallet signed and its own seat's
     * opening - carried in the proposal for the person's wallet, which keeps the company's account only on a seat
     * of it (`whyTheInvitationDoesNotNameIt`). A person added from a code holds no other.
     */
    inviter?: Inviter;
    /**
     * The hiding commitment to the invitee's address, the salt it was made under and the rights their seat will
     * carry, all hex. This seat signs them into the invitation the proposal carries.
     */
    invite: { address: string; salt: string; scope: string };
  },
): Promise<GovernedOutcome> {
  if ((input.invite as { threshold?: unknown }).threshold !== undefined) throw new InvitationNotBound(SEAT_BY_LEAF_SETS_NO_THRESHOLD);
  const look = async () => {
    const read = await rosterHere(doors.roster);
    const seating = seatingOf(read, doors.roster.reads);
    return { ...await waitingHere(read.sealed, read.account, doors.roster.viewingKey, input.signerId, input.readOut, seating), seats: seating.seats };
  };
  const { payload } = await look();
  const leaf = payload.leafCommitment.toLowerCase();
  if (payload.invited === undefined) {
    throw new InvitationNotBound('This seat request carries no invitation a seat signed, so nothing was raised. Withdraw it, and '
      + 'invite the person again from the device of a seated signer who may invite.');
  }
  /*
   * The invitation the proposal carries names the leaf, the address and the proposal, signed by this seat: what every
   * approving device makes the payload from. It is raised by the one raise step, which holds it to the same rules as
   * an invitation by address before anything is raised, this seat's own vaults included.
   */
  const { invited, salt } = await invitationForTheLeaf(payload.invited, leaf, input.invite, doors.material.signingSecret as Hex, proposalIdentityOn(doors.builder));
  /* A seat the chain already holds, taken by the invitee before this device admitted them, is only admitted. */
  const held = doors.records === undefined ? false : (await doors.records.directory()).holders.seats.includes(leaf);
  /*
   * Every approval opens the proposal again: it holds the invitation to the payload the record carries, and the
   * person waiting to the opening of their leaf, with this device's own vault worker.
   */
  const outcome: GovernedOutcome = held ? { state: 'done', round: null } : await raiseTheSeatHere(doors, {
    viewingKey: input.viewingKey, invited, salt, name: payload.name, byItsProposal: false,
    ...(input.inviter === undefined ? {} : { inviter: input.inviter }),
    body: { signerId: input.signerId },
    before: async () => { await look(); },
  });
  if (outcome.state !== 'done') return outcome;
  await admitSignerHere(doors.roster, { signerId: input.signerId, readOut: input.readOut });
  return outcome;
}
