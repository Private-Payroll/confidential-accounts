/**
 * **A PERSON ADDED FROM A CODE THEY GAVE, ON A SEAT'S OWN DEVICE.** A signer's
 * code is made on the person's own device and signed by their wallet
 * (`makeSignerCodeHere`); whoever pastes it files a real invitation and the
 * seat request it stands for. A
 * payee's code is handed over the same way an accepted link hands it over.
 * Every code is read for this company and refused when its parts were changed.
 */
import { inboxPublicKey as inboxOf, sealToInbox } from '../../../src/core/sealed-records.js';
import { proveSeatKeys } from '../../../src/core/seat-invite-proof.js';
import { acceptanceProofOf } from '../../../src/core/invitation.js';
import type { PendingSignerPayload, Role } from '../../../src/core/types.js';
import { readJoinCode, JOIN_CODE_REFUSAL, type JoinCode, type PayeeParts, type SignerParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, seatKeyFingerprint } from 'midnight-identity/profile/fingerprint';
import { walletKeyProvedBy, type SeatOpening } from '../../../src/core/seat-opening.js';
import { seatAddressSignedFor, type InviteAddressOf } from '../../../src/core/seat-address.js';
import {
  answered, filePayeeInvitation, fileSignerInvitation, payeeHandoverOf, refuseASeatThatMayNotInvite, refuseVaultsBeyondTheSeat,
  type EmployeeSpec, type InvitationSend, type InvitingCompany, type InvitingSeat,
} from './invitation-on-device.js';

/** Thrown for a pasted code this device will not add anybody from; nothing was filed. */
export class CodeNotTaken extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'CodeNotTaken';
  }
}

const codeFor = (text: string, company: InvitingCompany, kind: 'signer' | 'payee'): JoinCode => {
  const code = readJoinCode(text, company.label);
  if (typeof code === 'string') throw new CodeNotTaken(JOIN_CODE_REFUSAL[code]);
  if (code.parts.kind !== kind) {
    throw new CodeNotTaken(kind === 'signer' ? 'This is a code for being paid, not for a seat.' : 'This is a code for a seat, not for being paid.');
  }
  return code;
};

/**
 * **A SIGNER ADDED FROM A CODE THEY GAVE.** This device checks the code's
 * signature and company, and that the opening beside it makes the code's leaf
 * for the wallet that signed the code (`walletKeyProvedBy`, with the leaf this
 * device's vault worker works out, `leaves`), and that the same wallet signed
 * the address the code carries for this company and that leaf, made from the
 * coin key signed with it (`seatAddressSignedFor`, worked out again with
 * `inviteAddressOf`). It then makes a real invitation
 * for them through the same filing as a link (kept, listed with the company's
 * invitations, and spent by this seat request), signed for the sign-in the
 * code names and for the leaf it carries, and files the seat request a link's
 * acceptance files. Returns the seat request and the fingerprint to compare
 * with the one the person reads out.
 */
export async function addSignerFromCodeHere(
  company: InvitingCompany, seat: InvitingSeat, text: string, signer: { readonly name: string; readonly role: Role }, send: InvitationSend,
  /** The leaf each opening makes, worked out in this device's vault worker. */
  leaves: (openings: readonly SeatOpening[]) => Promise<readonly (string | null)[]>,
  /** The account's own function making an address from a coin key and a salt: the code's address is worked out again with it. */
  inviteAddressOf: InviteAddressOf,
): Promise<{ readonly id: string; readonly fingerprint: string }> {
  refuseASeatThatMayNotInvite(seat);
  const code = codeFor(text, company, 'signer');
  const parts = code.parts as SignerParts;
  const keys = { signingPublicKey: parts.signingPublicKey, wrappingPublicKey: parts.wrappingPublicKey, leafCommitment: parts.leafCommitment };
  const opening = code.opening;
  const [leaf] = opening === undefined ? [null] : await leaves([opening]);
  const proved = walletKeyProvedBy(opening, parts.leafCommitment, () => leaf ?? null);
  if (opening === undefined || proved === null || proved.value.toLowerCase() !== code.committeeKey.value.toLowerCase()) {
    throw new CodeNotTaken('This code does not show that its seat is made for the wallet that signed it, so nobody can be added '
      + 'from it. Ask the person to make a new code.');
  }
  /* The chain seats whoever holds the address a proposal names, so the code must carry the joiner's own, signed by their wallet. */
  const seatAddress = seatAddressSignedFor(code.seatAddress, opening.walletKey, company.id, parts.leafCommitment, inviteAddressOf);
  if (typeof seatAddress === 'string') {
    throw new CodeNotTaken('This code does not carry an address its wallet signed for the seat, made from that wallet\'s coin key, so '
      + 'nobody can be added from it. No wallet adds that address to a code yet; that comes with joining by a code in the wallet. '
      + 'Invite this person by their private address instead.');
  }
  /*
   * A code's seat is made before anybody chose its role, for every right on every vault (`makeSignerCodeHere`): it is
   * added only as an admin, whose rights those are. Any other role is given by address, where the seat is made for it.
   */
  if (signer.role !== 'admin') {
    throw new CodeNotTaken(`A seat joined by a code is made for every right on every vault, so it can be added only as an admin, `
      + `not as an ${signer.role}. Invite this person by their address to give them that role.`);
  }
  refuseVaultsBeyondTheSeat(seat, undefined, '; invite this person by their address instead, naming vaults within your own');
  /* The invitation names the leaf the joiner's wallet signed, and the person it signed for. */
  const made = await fileSignerInvitation(company, seat, { ...signer, person: code.person }, send, parts.leafCommitment);
  /*
   * **THE PROOF HERE SAYS THIS DEVICE VOUCHED FOR EXACTLY THESE KEYS**, for
   * the sign-in the code names, under the invitation it has just made and holds
   * the secret of: it does not say the joiner made them. What ties the keys to the joiner is the code's
   * signature by their wallet, the opening that makes its leaf for that wallet,
   * and the fingerprint they read out, which the person adding them compares
   * with `fingerprint` below. The seat request is then the one a link's
   * acceptance files, and every seat has one invitation behind it.
   */
  const waiting: PendingSignerPayload = {
    name: signer.name, role: signer.role, ...keys, seatProof: proveSeatKeys(made.proved, keys, { person: code.person, invitationId: made.invited.terms.invitation }), person: code.person,
    opening, invited: made.invited, seatAddress,
  };
  const b = answered(await send(`/api/invites/${made.id}/accept-signer`, {
    method: 'POST',
    body: JSON.stringify({ acceptance: acceptanceProofOf(made.token), waiting: sealToInbox(waiting, inboxOf(made.sealing.key, company.id)), for: code.person }),
  }), 201);
  if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed.');
  return { id: b.id, fingerprint: seatKeyFingerprint(keys) };
}

/**
 * **AN EMPLOYEE ADDED FROM A CODE THEY GAVE.** Their first person record and a real
 * invitation are made and filed as for a link, and the invitation is accepted
 * here with their code as what they hand over. Admitting them is a separate
 * act. Returns the person and the fingerprint of the address they are paid at.
 */
export async function addPayeeFromCodeHere(
  company: InvitingCompany, seat: InvitingSeat, text: string, spec: EmployeeSpec, send: InvitationSend,
): Promise<{ readonly person: string; readonly fingerprint: string }> {
  const code = codeFor(text, company, 'payee');
  const made = await filePayeeInvitation(company, seat, spec, send);
  answered(await send(`/api/invites/${made.id}/accept-payee`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(made.token), handover: payeeHandoverOf(code, inboxOf(made.sealing.key, company.id)), kind: 'employee' }),
  }), 201);
  return { person: made.person, fingerprint: payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }) };
}
