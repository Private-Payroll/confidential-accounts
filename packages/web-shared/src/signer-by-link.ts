/**
 * **A SIGNER WHO JOINED BY A LINK OR A CODE, SEATED FROM A SIGNER'S DEVICE.**
 * The invitation the person accepted is signed again by this seat, naming the
 * leaf their device made and the address their own wallet signed that they
 * take it from, and raised as one
 * proposal like any other change; every other seat approves that proposal as
 * it was filed (`approveSeatByLeafOnDevice`); the person takes the seat from
 * their own wallet, and is admitted here once the chain holds it.
 */
import { answerOpenedWith } from '../../../src/core/answer-opened.js';
import { canonical, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import {
  invitationProposalSalt, seatByAddressChangeOf, signSeatInvitation, type Inviter, type ProposalIdentityOf, type SeatInvitationTerms,
  type SignedSeatInvitation,
} from '../../../src/core/invitation.js';
import { addSignerByLeafIn, type AddSignerByLeaf } from '../../../src/core/add-signer-filing.js';
import { seatAddressSignedFor, type InviteAddressOf, type SeatAddress } from '../../../src/core/seat-address.js';
import type { PendingSignerPayload, SealedProposal } from '../../../src/core/types.js';
import {
  InvitationNotBound, NotOpenedOnThisDevice, proposalIdentityOn, raiseTheSeatHere, type GovernanceDoors, type GovernedOutcome,
} from './governed-call-on-device.js';
import { linkInvitationRefusal } from './invitation-signed-by-a-seat.js';
import { addressReadsOf, addressSeatedOrInvitedRefusal } from './address-seated-or-invited.js';
import { admitSignerHere, rosterHere, seatingOf, waitingHere, type RosterDoors } from './roster-here.js';
import { seatRequestFingerprint } from './seat-request-fingerprint.js';

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
 * them, their leaf proved for their wallet. The invitation (the address their
 * own wallet signed in their request, and the rights `invite` gives the seat)
 * is then raised
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
    companyKeys: KeysHeld; signerId: string; readOut: string;
    /**
     * This seat as an inviter record - its wallet key, the directory entry its wallet signed and its own seat's
     * opening - carried in the proposal for the person's wallet, which keeps the company's account only on a seat
     * of it (`whyTheInvitationDoesNotNameIt`). A person added from a code holds no other.
     */
    inviter?: Inviter;
    /**
     * The rights the seat will carry, hex. The address it is taken from, and its salt, are never this seat's to
     * choose: they are the ones the person's own wallet signed in their request (`seatAddressSignedFor`).
     */
    invite: { scope: string };
    /** The account's own function making an address from a coin key and a salt: the signed address is worked out again with it. */
    inviteAddressOf: InviteAddressOf;
  },
): Promise<GovernedOutcome> {
  if ((input.invite as { threshold?: unknown }).threshold !== undefined) throw new InvitationNotBound(SEAT_BY_LEAF_SETS_NO_THRESHOLD);
  const payload = await waitingFor(doors, input.signerId, input.readOut);
  const leaf = payload.leafCommitment.toLowerCase();
  if (payload.invited === undefined) {
    throw new InvitationNotBound('This seat request carries no invitation a seat signed, so nothing was raised. Withdraw it, and '
      + 'invite the person again from the device of a seated signer who may invite.');
  }
  /* The chain seats whoever holds the address the proposal names, so it is the one the person's own wallet signed. */
  const signed = seatAddressSignedFor(payload.seatAddress, payload.opening?.walletKey, doors.accountId, leaf, input.inviteAddressOf);
  if (typeof signed === 'string') throw new InvitationNotBound(NO_SIGNED_ADDRESS_TO_RAISE);
  /*
   * The invitation the proposal carries names the leaf, the address and the proposal, signed by this seat: what every
   * approving device makes the payload from. It is raised by the one raise step, which holds it to the same rules as
   * an invitation by address before anything is raised, this seat's own vaults included.
   */
  const invite = { address: signed.address, salt: signed.salt, scope: input.invite.scope };
  const { invited, salt } = await invitationForTheLeaf(payload.invited, leaf, invite, doors.material.signingSecret as Hex, proposalIdentityOn(doors.builder));
  /* A seat the chain already holds, taken by the invitee before this device admitted them, is only admitted. */
  const held = doors.records === undefined ? false : (await doors.records.directory()).holders.seats.includes(leaf);
  /*
   * Every approval opens the proposal again: it holds the invitation to the payload the record carries, and the
   * person waiting to the opening of their leaf, with this device's own vault worker.
   */
  const outcome: GovernedOutcome = held ? { state: 'done', round: null } : await raiseTheSeatHere(doors, {
    viewingKey: input.companyKeys, invited, salt, name: payload.name, byItsProposal: false,
    ...(input.inviter === undefined ? {} : { inviter: input.inviter }),
    body: { signerId: input.signerId, coinPublicKey: signed.coinPublicKey },
    before: async () => {
      await waitingFor(doors, input.signerId, input.readOut);
      await refuseAnAddressSeatedOrInvited(doors, input.companyKeys, input.inviteAddressOf, signed, leaf, 'raised');
    },
  });
  if (outcome.state !== 'done') return outcome;
  await admitSignerHere(doors.roster, { signerId: input.signerId, readOut: input.readOut });
  return outcome;
}

/** The person waiting under `signerId`, read from the company's inbox and held by `waitingHere` to the fingerprint `readOut`. */
const waitingFor = async (doors: { readonly roster: RosterDoors }, signerId: string, readOut: string): Promise<PendingSignerPayload> => {
  const read = await rosterHere(doors.roster);
  return (await waitingHere(read.sealed, read.account, doors.roster.viewingKey, signerId, readOut, seatingOf(read, doors.roster.reads))).payload;
};

/** Why a seat is not raised for a request that carries no address the person's own wallet signed, and what clears it. */
const NO_SIGNED_ADDRESS_TO_RAISE = 'This person\'s seat request does not carry an address their own wallet signed for the seat, made '
  + 'from that wallet\'s coin key, so nothing was raised and nothing was sent. No wallet signs that address yet; that comes with '
  + 'joining by a link or a code in the wallet. Invite the person by their private address instead.';

/**
 * Refuses a seat at an address whose wallet already holds a seat here or is invited to one by another proposal
 * (`addressSeatedOrInvitedRefusal`, by the coin key the person's wallet signed), so one wallet is never seated twice
 * on any path. Every proposal for this same leaf is the one being raised or approved, and does not count.
 */
const refuseAnAddressSeatedOrInvited = async (
  doors: GovernanceDoors & { readonly roster: RosterDoors }, viewingKey: KeysHeld, inviteAddressOf: InviteAddressOf,
  signed: SeatAddress, leaf: string, done: 'raised' | 'approved',
): Promise<void> => {
  const proposals = doors.records?.proposals === undefined ? [] : await doors.records.proposals();
  const sameLeaf = proposals.flatMap((p) => {
    const body = addSignerByLeafIn(p, doors.accountId, viewingKey);
    return body !== null && String(body.invited.terms.leaf).toLowerCase() === leaf.toLowerCase() ? [body.chainId] : [];
  });
  const why = await addressSeatedOrInvitedRefusal(addressReadsOf(doors, undefined), doors.accountId, viewingKey, inviteAddressOf,
    signed.coinPublicKey, sameLeaf);
  if (why !== null) throw new InvitationNotBound(`Nothing was ${done} and nothing was sent: ${why}.`);
};

/** Why a proposal named is not one to seat a leaf this device opens, and what clears it. */
const NO_SEAT_BY_LEAF = 'The company holds no proposal to seat a person who joined by a link or a code under that name that '
  + 'this device can open, so nothing was approved. Nothing was sent. Reload the page.';

/** The proposal `proposal` names, read as one to seat a leaf (`addSignerByLeafIn`), or refused before anything else is read. */
const filedByLeaf = async (doors: GovernanceDoors, viewingKey: KeysHeld, proposal: string): Promise<AddSignerByLeaf> => {
  if (!doors.service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s proposals, so it cannot approve this one. Reload the page '
      + 'to get the current version. Nothing was sent.');
  }
  const rec = (await doors.service.sealedProposals(doors.accountId) as readonly SealedProposal[]).find((p) => p.id === proposal);
  const body = rec === undefined ? null : addSignerByLeafIn(rec, doors.accountId, viewingKey);
  if (body === null) throw new InvitationNotBound(NO_SEAT_BY_LEAF);
  return body;
};

/** An invitation's terms as the person waiting accepted them: less the leaf, the address and the proposal a raising seat signs in. */
const acceptedTermsOf = (t: SeatInvitationTerms): string => {
  const { leaf: _leaf, invite: _invite, proposal: _proposal, ...accepted } = t;
  return canonical(accepted);
};

/** Why a proposal to seat a leaf is refused when its terms are not the ones the person waiting accepted, and what clears it. */
const NOT_THE_WAITING_PERSONS = 'The proposal the company holds under that name is not the invitation the person waiting accepted '
  + '(its company or invitation differs), so nothing was approved. Nothing was sent. Do not approve it: ask the seat '
  + 'that raised it to withdraw it, and raise the person\'s seat again from the device of a seated signer who may invite.';

/**
 * Refuses a proposal to seat a leaf that is not for the person waiting, and gives the address their own wallet signed:
 * its invitation must give their seat, role, vaults, person, name and leaf, no new threshold, and the address their
 * own wallet signed, worked out again from the coin key signed with it (`linkInvitationRefusal`, the check every
 * approving reading makes), and its other terms must be the ones they accepted, less what the raising seat signs in.
 */
const refuseALeafNotTheWaitingPersons = (
  accountId: string, body: AddSignerByLeaf, payload: PendingSignerPayload, inviteAddressOf: InviteAddressOf,
): SeatAddress => {
  const why = linkInvitationRefusal(accountId, body.invited, payload, inviteAddressOf);
  if (why !== null) throw new InvitationNotBound(why);
  if (payload.invited === undefined || acceptedTermsOf(payload.invited.terms) !== acceptedTermsOf(body.invited.terms)) {
    throw new InvitationNotBound(NOT_THE_WAITING_PERSONS);
  }
  const signed = seatAddressSignedFor(payload.seatAddress, payload.opening?.walletKey, accountId, payload.leafCommitment, inviteAddressOf);
  /* `linkInvitationRefusal` has just held the same address; this only hands it on. */
  if (typeof signed === 'string') throw new InvitationNotBound(NOT_THE_WAITING_PERSONS);
  return signed;
};

/**
 * **WHAT A SEAT APPROVING A PROPOSAL TO SEAT A LEAF CONFIRMS FIRST**: the proposal, as `approveSeatByLeafOnDevice`
 * opens it, and the fingerprint of the keys in the request of the person waiting in the company's inbox, worked out
 * here, for the person approving to compare by eye with the one the person waiting reads out to them. The request is
 * held to every other check `waitingHere` makes and to the proposal's invitation, the address their wallet signed
 * among them (worked out again with `inviteAddressOf`), before the fingerprint is given. It reads and sends nothing else.
 */
export async function seatByLeafToConfirmHere(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: { readonly viewingKey: KeysHeld; readonly proposal: string; readonly inviteAddressOf: InviteAddressOf },
): Promise<{ readonly proposal: AddSignerByLeaf; readonly fingerprint: string }> {
  const body = await filedByLeaf(doors, input.viewingKey, input.proposal);
  const read = await rosterHere(doors.roster);
  const box = read.sealed.pendingSigners.find((p) => p.id === body.signerId);
  let fingerprint = '';
  try {
    if (box !== undefined) fingerprint = seatRequestFingerprint(answerOpenedWith<PendingSignerPayload>(doors.roster.viewingKey, box.sealed, read.sealed.id).value);
  } catch {
    /* A request that does not open has no fingerprint: `waitingHere` opens it again just below and refuses it by name. */
  }
  const { payload } = await waitingHere(read.sealed, read.account, doors.roster.viewingKey, body.signerId, fingerprint, seatingOf(read, doors.roster.reads));
  refuseALeafNotTheWaitingPersons(doors.accountId, body, payload, input.inviteAddressOf);
  return { proposal: body, fingerprint: seatRequestFingerprint(payload) };
}

/**
 * **A PROPOSAL TO SEAT A PERSON WHO JOINED BY A LINK OR A CODE, APPROVED FROM ANOTHER SEAT.** The proposal `proposal`
 * names is opened here as one to seat a leaf (`addSignerByLeafIn`); the person it names is read from the company's
 * inbox and held to every check `waitingHere` makes, the fingerprint this seat confirmed (`readOut`, which the
 * approver compared by eye with the one the person reads out) among them; the invitation the proposal carries must be
 * the one they accepted, for their leaf, with no new threshold, at the address their own wallet signed, worked out
 * again from the coin key signed with it, so no wallet but the one that signed can take the seat; and that wallet
 * must hold no seat here and be invited by no other proposal (`addressSeatedOrInvitedRefusal`). This seat's approval is then added
 * through the one raise step, with the invitation and salt as they were filed, never signed again (a seat signing it
 * again would make another salt and so another proposal), and only to the proposal the chain already holds
 * (`approveOnly`): nothing is raised. The person waiting is read again before anything is sent. The invitee takes the
 * seat from their own wallet; this device never carries it out.
 */
export async function approveSeatByLeafOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: { readonly viewingKey: KeysHeld; readonly proposal: string; readonly readOut: string; readonly inviteAddressOf: InviteAddressOf },
): Promise<GovernedOutcome> {
  const body = await filedByLeaf(doors, input.viewingKey, input.proposal);
  const held = async (): Promise<SeatAddress> =>
    refuseALeafNotTheWaitingPersons(doors.accountId, body, await waitingFor(doors, body.signerId, input.readOut), input.inviteAddressOf);
  await held();
  return raiseTheSeatHere(doors, {
    viewingKey: input.viewingKey, invited: body.invited, salt: body.proposalSalt, name: body.invited.terms.name, byItsProposal: false,
    approveOnly: body.chainId, ...(body.inviter === undefined ? {} : { inviter: body.inviter }),
    body: { signerId: body.signerId },
    before: async () => {
      await refuseAnAddressSeatedOrInvited(doors, input.viewingKey, input.inviteAddressOf, await held(), String(body.invited.terms.leaf), 'approved');
    },
  });
}
