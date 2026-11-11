/**
 * A signer invitation as the seat that raises its proposal signs it: carrying the address it invites and the proposal
 * its address, rights, threshold and every other signed term make (`invitationProposalSalt`), with the account's own
 * compiled functions working out that proposal, as a device's vault worker does. A directory believes a seat only on an
 * invitation that makes its proposal, so every test seat is invited this way.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, utf8, type Hex } from '../core/crypto.js';
import {
  invitationProposalSalt, seatByAddressChangeOf, signSeatInvitation, type ProposalIdentityOf, type SeatInvitationTerms, type SignedSeatInvitation,
} from '../core/invitation.js';
import { signingPublicKeyOf } from '../core/crypto.js';
import { isSignerRole } from '../core/roles.js';
import { ALL_VAULTS, scopeOfRole } from '../core/seat-rights.js';

const { identityOfAChange } = await import('vaults-web-shared/governed-call-builder.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

/** A governance proposal's identity, its digest and the value it names for a vault, as a device's vault worker makes them. */
export const governanceIdentityOfTheContract = async (change: Parameters<typeof identityOfAChange>[1], salt: string) =>
  identityOfAChange({ accountPure: pureCircuits as never }, change, salt);

/** A seat invitation's proposal's identity, as a device's vault worker makes it with the account's own functions. */
export const proposalIdentityOfTheContract: ProposalIdentityOf = governanceIdentityOfTheContract;

/** The same identity, worked out at once: for a judge a test builds by hand. */
const chainIdOf = (invited: SignedSeatInvitation): string | null => {
  const t = invited.terms;
  if (t.invite === undefined) return null;
  return identityOfAChange({ accountPure: pureCircuits as never }, seatByAddressChangeOf(t.invite), invitationProposalSalt(invited)).chainId.toLowerCase();
};

/** The proposal `invited`'s own salt makes, as a member's device works it out for every seat invitation (`proposalMadeBy`). */
export const proposalMadeByHere = (invited: SignedSeatInvitation): string | null => chainIdOf(invited);

/**
 * The seat each raised test invitation's proposal took, as the chain's record of `seatInvited` would show it once
 * the invitee took the seat it names: written by `invitedAsRaised` for every invitation that names a leaf.
 */
const TAKEN = new Map<string, string>();
/** The seat the test chain shows `proposal` took, or null (`invitedLeafOf`). */
export const invitedLeafOfTheTestChain = (proposal: string): string | null => TAKEN.get(proposal.toLowerCase()) ?? null;
/** The same, as a device's vault worker answers a read of many proposals at once (`invitedSeats`). */
export const invitedSeatsOfTheTestChain = async (proposals: readonly string[]): Promise<Readonly<Record<string, string | null>>> =>
  Object.fromEntries(proposals.map((p) => [p.toLowerCase(), invitedLeafOfTheTestChain(p)]));

/**
 * `terms` signed by `signingSecret` as the raising seat signs them: with an address made up for the test unless `terms`
 * names one, at `scope` (the rights the terms' role is given unless named), and the proposal that makes. Terms that name a proposal are signed as given.
 */
export const invitedAsRaised = (terms: SeatInvitationTerms, signingSecret: Hex, scope?: Hex): SignedSeatInvitation => {
  if (terms.proposal !== undefined) return signSeatInvitation(terms, signingSecret);
  /* The test chain records the seat each such proposal took (`TAKEN`): the leaf the invitation names. */
  const at = (what: string): Hex => toHex(sha256(utf8(`a test invitation's ${what}:${terms.company}:${terms.invitation}`))) as Hex;
  const invite = terms.invite ?? { address: at('address'), salt: at('salt'), scope: scope ?? (isSignerRole(terms.role) ? scopeOfRole(terms.role, terms.vaults) : ALL_VAULTS) };
  const unnamed = { ...terms, invite };
  const salt = invitationProposalSalt({ terms: unnamed, signedBy: signingPublicKeyOf(signingSecret) });
  const proposal = identityOfAChange({ accountPure: pureCircuits as never }, seatByAddressChangeOf(invite), salt).chainId.toLowerCase() as Hex;
  if (terms.leaf !== undefined) TAKEN.set(proposal, terms.leaf.toLowerCase());
  return signSeatInvitation({ ...unnamed, proposal }, signingSecret);
};
