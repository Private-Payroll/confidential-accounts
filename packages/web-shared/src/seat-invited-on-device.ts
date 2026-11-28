/**
 * **A SIGNER INVITED BY ADDRESS, RAISED AND APPROVED FROM THIS DEVICE.**
 *
 * The proposal must carry the invitation it was raised for, the address must be
 * the one the invited person's own coin key commits to, and the person, rights,
 * role and approvals shown on the page must be the ones the proposal holds. An
 * address already seated or invited, or a second invitation filed under the
 * same proposal, is refused before anything is approved.
 */
import type { SignerByAddressDoors } from './invitation-on-device.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { OpenedRound } from './governed-call-builder.js';
import type { Hex } from '../../../src/core/crypto.js';
import { invitedSeatRightsOf } from '../../../src/core/seat-rights.js';
import type { Role, SealedProposal } from '../../../src/core/types.js';
import { standingOnChainHere } from './run-rebuilt-here.js';
import { NotOpenedOnThisDevice } from './round-opened-here.js';
import { addSignerByAddressIn, addSignerInvitationRefusalIn } from '../../../src/core/proposal-filing.js';
import { believedSeatingsUnder, rosterHere, sameInvitation, seatingOf, type RosterDoors } from './roster-here.js';
import { invitationByAddressRefusal, NOT_APPROVED_SAID } from './invitation-signed-by-a-seat.js';
import {
  approvedInvitationRefusal,
  seatByAddressChangeOf,
  type Inviter,
  type SignedSeatInvitation
} from '../../../src/core/invitation.js';
import { addressReadsOf, addressSeatedOrInvitedRefusal, type InviteAddressOf } from './address-seated-or-invited.js';
import { kindAsked } from './vault-page-doors.js';
import {
  type GovernanceDoors,
  type GovernedOutcome,
  governOnDevice,
  InvitationNotBound,
  proposalIdentityOn
} from './company-change-on-device.js';
import { ApprovalNotOwed } from './proposal-approved-on-device.js';

/** An inviter record as a proposal carries it: the wallet key, the signed entry and the opening, and nothing else. */
const inviterRecordOf = (x: Inviter): Inviter => ({
  committeeKey: { tag: x.committeeKey.tag, value: x.committeeKey.value },
  statement: x.statement,
  opening: x.opening
});

/**
 * An invitation by address as its raise needs it: the signed invitation, the salt its proposal is raised under, and
 * the coin key of the address typed. A device that raises the proposal must give the coin key, which the proposal
 * carries sealed; a device that approves a proposal already raised gives the one the proposal carries, checked again
 * against the commitment, or none.
 */
export interface SeatInvitationToRaise {
  readonly invited: SignedSeatInvitation;
  /** The salt the proposal's identity was made with: the one the invitation makes (`invitationProposalSalt`), and the invitee's wallet carries. */
  readonly proposalSalt: string;
  readonly name: string;
  readonly inviter?: Inviter;
  readonly coinPublicKey?: Hex;
}

/**
 * **A SEAT OFFERED BY ADDRESS, RAISED BEFORE ANYBODY HAS ACCEPTED IT, AND APPROVED.** The invitation names the
 * commitment to the address that was typed, the rights the seat carries, the threshold it sets once taken (where it
 * names one) and the proposal raised for it; this device checks it was signed by a seated signer who may invite, that
 * the salt is the one the invitation itself makes, and that the proposal it raises or approves is exactly the one its
 * change and that salt make (the one raise step, `raiseTheSeatHere`), so it commits to the whole invitation. A threshold it sets is checked before
 * every send as the chain will check it, and against every vault (`refuseASeatThresholdHere`), with the seat counted on
 * the vaults its role's rights reach (`invitedSeatRightsOf`). Nothing waits for an acceptance and no fingerprint is read: the invitee's own wallet takes the
 * seat (`seatInvited`), proving it holds the address, once the approvals reach the seat bar, and this device never
 * carries it out. Called again from another seat's device, it approves the same proposal; asked only to approve
 * (`approveOnly`, the proposal's identity on the chain), it raises nothing.
 */
export async function raiseSeatInvitationOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: { readonly viewingKey: KeysHeld } & SeatInvitationToRaise,
  inviteAddressOf?: InviteAddressOf,
  o: { readonly approveOnly?: string } = {}
): Promise<GovernedOutcome> {
  const t = input.invited.terms;
  if (t.invite === undefined || t.proposal === undefined || t.leaf !== undefined) {
    throw new InvitationNotBound(
      'This invitation is not one made by address, naming the proposal raised for it, so nothing was raised.'
    );
  }
  const invite = t.invite;
  const coin = input.coinPublicKey?.toLowerCase() as Hex | undefined;
  if (coin !== undefined) {
    if (inviteAddressOf === undefined) {
      throw new InvitationNotBound(
        'This device cannot check the address this invitation commits to, so nothing was raised. Reload the page.'
      );
    }
    if (
      String(inviteAddressOf(coin, invite.salt.toLowerCase() as Hex)).toLowerCase() !== invite.address.toLowerCase()
    ) {
      throw new InvitationNotBound(
        "The coin key given is not the one the invitation's address commits to, so nothing was raised. " +
          'Invite the person again.'
      );
    }
  }
  return raiseTheSeatHere(doors, {
    viewingKey: input.viewingKey,
    invited: input.invited,
    salt: input.proposalSalt,
    name: input.name,
    byItsProposal: true,
    ...(input.inviter === undefined ? {} : { inviter: input.inviter }),
    ...(o.approveOnly === undefined ? {} : { approveOnly: o.approveOnly }),
    body: coin === undefined ? {} : { coinPublicKey: coin },
    /* Only a raise reaches this with no round opened: a proposal raised without the coin key hides a wallet invited twice. */
    before: async (opened) => {
      if (opened === undefined && coin === undefined) {
        throw new InvitationNotBound(
          'This invitation is raised without the coin key of the address it invites, so nothing was raised. ' +
            'Invite the person again from the device that typed the address.'
        );
      }
    }
  });
}

/**
 * **THE ONE RAISE STEP FOR A SIGNER INVITATION**, by address or by a link or a
 * code. The invitation must be signed by a seat this device believes may
 * invite, offering only vaults within its own, and name the address the
 * proposal invites (`invitationByAddressRefusal`); the proposal is the one its
 * change (`seatByAddressChangeOf`) and the salt its own signed terms make
 * (`approvedInvitationRefusal`), filed under that salt so the approvers'
 * signatures commit to the whole invitation, and the new seat is counted on
 * the vaults its role's rights reach (`invitedSeatRightsOf`). `byItsProposal`
 * finds an open round by the proposal the invitation names; otherwise by its
 * change, as a second device's own signature makes another proposal. `body`
 * adds what the way in carries beside the invitation.
 */
export async function raiseTheSeatHere(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: {
    readonly viewingKey: KeysHeld;
    readonly invited: SignedSeatInvitation;
    readonly salt: string;
    readonly name: string;
    readonly inviter?: Inviter;
    readonly byItsProposal: boolean;
    readonly approveOnly?: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly before: (opened?: OpenedRound) => Promise<void>;
  }
): Promise<GovernedOutcome> {
  const t = input.invited.terms;
  if (t.invite === undefined)
    throw new InvitationNotBound(`${NOT_APPROVED_SAID['not-raised']}, so nothing was raised. Invite the person again.`);
  const seats = seatingOf(await rosterHere(doors.roster), doors.roster.reads).seats;
  const refused = invitationByAddressRefusal(doors.roster.accountId, input.invited, t.invite, seats);
  if (refused !== null) throw new InvitationNotBound(refused);
  const change = seatByAddressChangeOf(t.invite);
  const identity = await proposalIdentityOn(doors.builder)(change, input.salt);
  const unbound = approvedInvitationRefusal(input.invited, { salt: input.salt, chainId: identity.chainId });
  if (unbound !== null)
    throw new InvitationNotBound(`${NOT_APPROVED_SAID[unbound]}, so nothing was raised. Invite the person again.`);
  return governOnDevice(
    { ...doors, filing: { ...doors.filing, salt: () => input.salt }, leaves: doors.roster.reads.leaves },
    {
      viewingKey: input.viewingKey,
      change,
      ...(input.byItsProposal ? { proposal: t.proposal! } : {}),
      summary:
        change.threshold === undefined
          ? `Add ${input.name} as a signer`
          : `Add ${input.name} as a signer, then need ${change.threshold} approvals`,
      body: {
        ...input.body,
        invite: { address: change.address, scope: change.scope },
        invited: input.invited,
        ...(input.inviter === undefined ? {} : { inviter: inviterRecordOf(input.inviter) })
      },
      before: input.before,
      ...(input.approveOnly === undefined ? {} : { approveOnly: input.approveOnly }),
      seatRights: invitedSeatRightsOf(t, change.scope)
    }
  );
}

/** What the person approving a seat by address was shown before they approved: the proposal, and what it invites. */
export interface SeatInvitationShown {
  /** The proposal's name in the company's records. */
  readonly proposal: string;
  readonly name: string;
  /** The role the seat is invited with, as the proposal's signed invitation names it: what the new seat may do. */
  readonly role: Role;
  /** The commitment to the address invited, as the proposal's invitation names it. */
  readonly address: string;
  readonly scope: string;
  readonly coinPublicKey: string;
  /** The approvals the account needs once the seat is taken, as digits; none or "0" keeps the threshold in force. */
  readonly threshold?: string;
}

/**
 * **A SEAT OFFERED BY ADDRESS, APPROVED FROM ANOTHER SEAT'S DEVICE, EXACTLY AS IT WAS SHOWN.** The proposal is opened
 * here from the company's records (`addSignerByAddressIn`) and approved only when it invites the very name, role,
 * commitment, rights, threshold once seated and coin key shown, the coin key makes that commitment under the invitation's salt, and the wallet behind it
 * holds no seat here and no other open invitation, on the chain or written down with a raise that may still land by the
 * chain's time (`addressSeatedOrInvitedRefusal`, with the coin keys the roster this device believes records), and no other proposal this device believes under the same id on the network carries
 * another invitation (`believedSeatingsUnder`, which believes only a record whose invitation makes that id, so a second
 * invitation filed under it is passed over), which the admission would refuse after the seat is taken. It is then approved as every seat offered by address is
 * (`raiseSeatInvitationOnDevice`), which raises nothing: unless the chain already holds that proposal raised, nothing
 * is sent. A proposal the chain has already carried out is refused as owed nothing (`ApprovalNotOwed`), and so is
 * an approval the chain already counts for this seat. Every refusal comes before anything is built or sent.
 */
export async function approveSeatInvitationOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: {
    readonly viewingKey: KeysHeld;
    readonly shown: SeatInvitationShown;
    readonly chainTime?: () => Promise<number>;
  },
  inviteAddressOf: InviteAddressOf
): Promise<GovernedOutcome> {
  const low = (x: unknown): string => String(x).toLowerCase();
  const { shown } = input;
  if (!doors.service.sealedProposals) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's proposals, so it cannot approve this one. Reload the page " +
        'to get the current version. Nothing was sent.'
    );
  }
  const rec = ((await doors.service.sealedProposals(doors.accountId)) as readonly SealedProposal[]).find(
    (p) => p.id === shown.proposal
  );
  const body = rec === undefined ? null : addSignerByAddressIn(rec, doors.accountId, input.viewingKey);
  if (body === null) {
    throw new InvitationNotBound(
      (rec === undefined ? null : addSignerInvitationRefusalIn(rec, doors.accountId, input.viewingKey)) ??
        'The company holds no proposal to add a seat by address under that name that this device can open, ' +
          'so nothing was approved. Nothing was sent. Reload the page.'
    );
  }
  const invite = body.invited.terms.invite!;
  if (
    body.invited.terms.name !== shown.name ||
    low(invite.address) !== low(shown.address) ||
    low(invite.scope) !== low(shown.scope) ||
    body.coinPublicKey === null ||
    body.coinPublicKey !== low(shown.coinPublicKey)
  ) {
    throw new InvitationNotBound(
      'The proposal the company holds under that name invites another person, address or rights than the ' +
        'ones shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.'
    );
  }
  /* The threshold the seat sets once taken is the signed invitation's, and must be the one shown: none and "0" both keep the one in force. */
  if ((invite.threshold ?? '0') !== (shown.threshold === undefined || shown.threshold === '' ? '0' : shown.threshold)) {
    throw new InvitationNotBound(
      `The proposal the company holds under that name sets the approvals needed to ${invite.threshold ?? 'what they are now'} ` +
        `once the seat is taken, not to ${shown.threshold === undefined || shown.threshold === '' || shown.threshold === '0' ? 'what they are now' : shown.threshold} ` +
        'as shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.'
    );
  }
  if (body.invited.terms.role !== shown.role) {
    throw new InvitationNotBound(
      `The proposal the company holds under that name invites this person as ${body.invited.terms.role}, ` +
        `not as ${String(shown.role)} as shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.`
    );
  }
  if (low(inviteAddressOf(body.coinPublicKey, low(invite.salt) as Hex)) !== low(invite.address)) {
    throw new InvitationNotBound(
      "The coin key this proposal carries is not the one its invitation's address commits to, so nothing " +
        'was approved. Nothing was sent. Do not approve it.'
    );
  }
  /* Where the proposal stands is read from the chain, never the service's status: closed by being carried out, it owes no approval. */
  if (doors.records?.roundsOnChain !== undefined) {
    const [standing] = await standingOnChainHere(doors.records, [
      { id: rec!.id, chainId: body.chainId, status: rec!.status }
    ]);
    if (standing?.status === 'executed') throw new ApprovalNotOwed('carried-out');
  }
  const held = await addressSeatedOrInvitedRefusal(
    addressReadsOf(doors, input.chainTime),
    doors.accountId,
    input.viewingKey,
    inviteAddressOf,
    body.coinPublicKey,
    body.chainId
  );
  if (held !== null) throw new InvitationNotBound(`This proposal was not approved, and nothing was sent: ${held}.`);
  const seats = seatingOf(await rosterHere(doors.roster), doors.roster.reads).seats;
  const beside = await believedSeatingsUnder(
    await doors.records!.directory(kindAsked('proposal')),
    await doors.records!.proposals!(),
    doors.accountId,
    input.viewingKey,
    body.chainId,
    seats,
    proposalIdentityOn(doors.builder)
  );
  if (beside.some((x) => !sameInvitation(x.invited, body.invited))) {
    throw new InvitationNotBound(
      'Another proposal the company holds under the same id on the network carries another invitation, ' +
        'filed and signed by a seat that may invite, so the person could take the seat and never be admitted. Nothing was approved. ' +
        'Nothing was sent. Do not approve it: ask the seats that raised them to withdraw both, and invite the person again.'
    );
  }
  return raiseSeatInvitationOnDevice(
    doors,
    {
      viewingKey: input.viewingKey,
      invited: body.invited,
      proposalSalt: body.proposalSalt,
      name: body.invited.terms.name,
      coinPublicKey: body.coinPublicKey,
      ...(body.inviter === undefined ? {} : { inviter: body.inviter })
    },
    inviteAddressOf,
    { approveOnly: body.chainId }
  );
}

/**
 * The doors `inviteHere` raises a seat offered by address through, from this seat's governance doors: where this
 * device keeps the invitation before it is raised (`keep`), whether the address's wallet is already seated or invited
 * here (`addressSeatedOrInvitedRefusal`, from the company's proposals and this device's own read of the chain and its
 * time, `chainTime`), the
 * proposal's identity as this device's builder makes it, and the raise itself (`raiseSeatInvitationOnDevice`), which
 * checks the coin key against the commitment before the proposal carries it.
 */
export const signerByAddressDoorsOf = (
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  viewingKey: KeysHeld,
  network: SignerByAddressDoors['network'],
  commitments: SignerByAddressDoors['commitments'],
  keep: SignerByAddressDoors['keep'],
  chainTime?: () => Promise<number>
): SignerByAddressDoors => ({
  keep,
  network,
  commitments,
  held: (coinPublicKey, except) =>
    addressSeatedOrInvitedRefusal(
      addressReadsOf(doors, chainTime),
      doors.accountId,
      viewingKey,
      (c, salt) => commitments.inviteAddressOf(c, salt),
      coinPublicKey,
      except
    ),
  identity: async (change, salt) => proposalIdentityOn(doors.builder)(change, salt),
  raise: (input) =>
    raiseSeatInvitationOnDevice(doors, { viewingKey, ...input }, (c, salt) => commitments.inviteAddressOf(c, salt))
});
