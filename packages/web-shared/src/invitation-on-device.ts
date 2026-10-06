/**
 * **INVITING SOMEBODY, AND ACCEPTING AN INVITATION, ON THE PERSON'S OWN
 * DEVICE.** Each step is one function a screen can call.
 *
 *   · **inviting** (`invitePayeeHere`, `inviteSignerHere`): this device draws
 *     the token, seals the offer under the key only the link carries, signs it
 *     with this seat's filing key and the directory entry its wallet signed,
 *     and files what the service keeps: the lookup id, the hash of what
 *     accepts it, the sealed offer. A payee's first person record is sealed
 *     here and filed with it. The service is sent no token, no offer key and
 *     nothing it can open.
 *   · **opening** (`openInvitationHere`): the invitee's device asks for the
 *     invitation by its lookup id, opens the offer with the key in the link's
 *     fragment, and believes it only when the seat that invited signed it.
 *   · **accepting** (`acceptAsPayeeHere`, `acceptAsSignerHere`): what the
 *     invitee hands over is sealed here to the company's inbox key the offer
 *     names, and sent with the proof only the token gives. A signer accepts
 *     through the one seat path every way of joining uses
 *     (`acceptSeatOnThisDevice`), so the request that ends in a seat is the
 *     same whichever way they came.
 */
import { randomBytes, toHex, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { sealToInbox } from '../../../src/core/sealed-records.js';
import { sealPerson } from '../../../src/core/person-record.js';
import { newSeatInvitation, proveSeatKeys, type SeatInvitation } from '../../../src/core/seat-invite-proof.js';
import {
  acceptanceHashOf, acceptanceProofOf, invitationIdOf, invitationLink, InvitationNotOpened, newInvitationToken, openOffer,
  sealOffer, signInvitationFiling, signOffer, tokenOfLink,
  type EmployeeOffer, type InvitationFiling, type InvitationOffer, type Inviter, type SignedOffer,
} from '../../../src/core/invitation.js';
import type { PendingSignerPayload, Role, RosterEmployee } from '../../../src/core/types.js';
import type { AssetId } from '../../../src/core/assets.js';
import { signCompanyFiling, toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';
import type { LeafScheme } from '../../../src/core/signer-leaf.js';
import type { SealedHandover } from '../../../src/core/invite-handover.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readJoinCode, writeJoinCode, JOIN_CODE_REFUSAL, type JoinCode, type PayeeParts, type SignerParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, seatKeyFingerprint, tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { acceptSeatOnThisDevice, type AcceptedSeat, type SeatDoors } from './accept-seat.js';

/** How this device reaches the service: a path and a JSON body, an answer with its status. */
export type InvitationSend = (
  path: string, init: { readonly method: 'GET' | 'POST'; readonly body?: string },
) => Promise<{ readonly status: number; readonly body: unknown }>;

/** The company an invitation is made for, as this device opened it. */
export interface InvitingCompany {
  readonly id: string;
  readonly name: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  readonly inboxPublicKey: Hex;
  readonly keyEpoch: number;
  readonly viewingKey: Hex;
}

/** This device's seat: the filing key it signs with, and the directory entry its wallet signed for it. */
export interface InvitingSeat extends Inviter {
  readonly signingSecret: Hex;
}

/** An invitation made: the link to send the person, and the ids the service knows it by. */
interface MadeInvitation {
  readonly link: string;
  readonly id: Hex;
  /** A payee's: the person record filed for them. */
  readonly person?: string;
}

/** Thrown when the service refused to keep what this device made; its words are in the message. */
export class InvitationRefused extends Error {
  constructor(readonly status: number, readonly refused: string | null, said: string) {
    super(said);
    this.name = 'InvitationRefused';
  }
}

const answered = (r: { status: number; body: unknown }, ok: number): Record<string, unknown> => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (r.status !== ok) {
    throw new InvitationRefused(r.status, typeof b.refused === 'string' ? b.refused : null,
      typeof b.error === 'string' ? b.error : `the service answered ${r.status} and said nothing, so nothing is known to have been kept.`);
  }
  return b;
};

const offered = (company: InvitingCompany, seat: InvitingSeat, forWhom: InvitationOffer['for']): InvitationOffer => ({
  company: company.id, companyName: company.name, label: company.label, account: company.account,
  inboxPublicKey: company.inboxPublicKey, for: forWhom, inviter: { committeeKey: seat.committeeKey, statement: seat.statement },
});

const filed = (company: InvitingCompany, seat: InvitingSeat, kind: 'employee' | 'signer', token: Hex, signed: SignedOffer, person?: string): InvitationFiling =>
  signInvitationFiling({
    company: company.id, kind, id: invitationIdOf(token), acceptanceHash: acceptanceHashOf(acceptanceProofOf(token)),
    offer: sealOffer(signed, token), ...(person === undefined ? {} : { person }),
  }, seat.signingSecret);

/** Who a payee is and what they are paid, as the person inviting them enters it. */
interface PayeeSpec {
  readonly name: string;
  readonly email: string | null;
  readonly title: string;
  readonly asset: AssetId;
  readonly baseAmount: bigint;
  readonly startDate: string;
}

/** A payee's invitation and first record, made here and filed; the token stays on this device. */
async function filePayeeInvitation(
  company: InvitingCompany, seat: InvitingSeat, spec: PayeeSpec, send: InvitationSend,
): Promise<{ token: Hex; id: Hex; person: string }> {
  if (typeof spec.baseAmount !== 'bigint' || spec.baseAmount <= 0n) throw new Error('a payee is invited with a pay above nothing, in the token\'s smallest unit.');
  const person: RosterEmployee = {
    id: `emp_${toHex(randomBytes(10))}`, accountId: company.id, name: spec.name, email: spec.email, title: spec.title,
    asset: spec.asset, baseAmount: spec.baseAmount, startDate: spec.startDate, status: 'pending', wrappingPublicKey: null,
    handedOverBy: null, admittedBy: null, admittedAt: null, selfRaised: false, address: null,
  };
  const record = sealPerson(person, 1, company.keyEpoch, company.viewingKey);
  const offer: EmployeeOffer = {
    kind: 'employee', person: person.id, name: spec.name, title: spec.title, email: spec.email,
    asset: spec.asset, baseAmount: spec.baseAmount, startDate: spec.startDate,
  };
  const token = newInvitationToken();
  const invitation = filed(company, seat, 'employee', token, signOffer(offered(company, seat, offer), seat.signingSecret), person.id);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/people`, {
    method: 'POST', body: JSON.stringify({ person: toCompanyWire(signCompanyFiling(record, seat.signingSecret)), invitation }),
  }), 201);
  return { token, id: invitation.id, person: person.id };
}

/**
 * **A PAYEE INVITED FROM THIS DEVICE**: their first person record, sealed
 * here, and the invitation for it, filed together. Returns the link to send.
 */
export async function invitePayeeHere(
  company: InvitingCompany, seat: InvitingSeat, spec: PayeeSpec, origin: string, send: InvitationSend,
): Promise<MadeInvitation> {
  const made = await filePayeeInvitation(company, seat, spec, send);
  return { link: invitationLink(origin, made.token), id: made.id, person: made.person };
}

/** A signer's invitation, made here and filed: the token and the seat's secret stay on this device. */
async function fileSignerInvitation(
  company: InvitingCompany, seat: InvitingSeat, signer: { readonly name: string; readonly role: Role }, send: InvitationSend,
): Promise<{ token: Hex; id: Hex; proved: SeatInvitation }> {
  const proved = newSeatInvitation(company.viewingKey, company.id, signer.name, signer.role);
  const token = newInvitationToken();
  const invitation = filed(company, seat, 'signer', token, signOffer(offered(company, seat, {
    kind: 'signer', name: signer.name, role: signer.role, seat: { nonce: proved.nonce, secret: proved.secret },
  }), seat.signingSecret));
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/invites/signer`, {
    method: 'POST', body: JSON.stringify({ invitation }),
  }), 201);
  return { token, id: invitation.id, proved };
}

/** **A SIGNER INVITED FROM THIS DEVICE**, with the secret their new keys will be proved by inside the offer. */
export async function inviteSignerHere(
  company: InvitingCompany, seat: InvitingSeat, signer: { readonly name: string; readonly role: Role }, origin: string, send: InvitationSend,
): Promise<MadeInvitation> {
  const made = await fileSignerInvitation(company, seat, signer, send);
  return { link: invitationLink(origin, made.token), id: made.id };
}

/** An invitation this device opened: the token its link carried, and the offer its inviter signed. */
interface OpenedInvitation {
  readonly token: Hex;
  readonly signed: SignedOffer;
  readonly expiresAt: string;
}

/**
 * **AN INVITATION OPENED ON THE INVITEE'S DEVICE.** Believed only when the seat
 * that invited signed the offer, for the company's label and account it names.
 * Whether that seat's committee key is on that account's committee is asked of
 * the chain by the invitee's own wallet before anything is signed for it.
 */
export async function openInvitationHere(link: string, send: InvitationSend): Promise<OpenedInvitation> {
  const token = tokenOfLink(link);
  if (token === null) throw new InvitationNotOpened('it is not a whole invitation link');
  const b = answered(await send(`/api/invites/${invitationIdOf(token)}/offer`, { method: 'GET' }), 200);
  const offer = b.offer as Sealed | undefined;
  if (offer === undefined || typeof b.expiresAt !== 'string') throw new InvitationNotOpened('the service sent no sealed offer');
  const signed = openOffer(offer, token);
  if (signed.offer.for.kind !== b.kind) throw new InvitationNotOpened('it is not the kind of invitation the service says it is');
  return { token, signed, expiresAt: b.expiresAt };
}

/**
 * **A PAYEE ACCEPTS, HANDING OVER THEIR CODE.** `code` is the one their own
 * wallet signed for this company (`askWalletForAJoinCode`), the same package a
 * pasted code hands over; it is sealed here to the inbox key the signed offer
 * names and sent with the proof only the token gives. Returns the fingerprint
 * of the address they are paid at, for them to read to whoever admits them.
 */
export async function acceptAsPayeeHere(opened: OpenedInvitation, code: JoinCode, send: InvitationSend): Promise<{ readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind !== 'employee') throw new Error('that invitation offers a seat, not pay, so it is not accepted as a payee.');
  if (code.parts.kind !== 'payee' || code.company !== o.label) {
    throw new Error('that code is not a payee\'s code for the company this invitation is from, so nothing was sent.');
  }
  answered(await send(`/api/invites/${invitationIdOf(opened.token)}/accept-employee`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token), handover: payeeHandoverOf(code, o.inboxPublicKey) }),
  }), 201);
  return { fingerprint: payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }) };
}

/**
 * **A SIGNER ACCEPTS, THROUGH THE ONE SEAT PATH.** Their keys are made and kept
 * on this device (`doors.newKeys`, `doors.seal`); the public halves, the leaf,
 * the proof of their keys, and the name and role the offer gave them are
 * sealed here to the company's inbox key and filed as the seat request.
 * Returns, with the seat, the fingerprint of the keys for the person to read
 * to whoever seats them.
 */
export async function acceptAsSignerHere(
  opened: OpenedInvitation, commitments: LeafScheme, doors: Omit<SeatDoors, 'publish'>, send: InvitationSend,
): Promise<AcceptedSeat & { readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind !== 'signer') throw new Error('that invitation offers pay, not a seat, so it is not accepted as a signer.');
  const offer = o.for;
  let fingerprint = '';
  const seated = await acceptSeatOnThisDevice(o.company, commitments, {
    ...doors,
    publish: async (payload) => {
      const waiting: PendingSignerPayload = { name: offer.name, role: offer.role, ...payload };
      fingerprint = seatRequestFingerprint(waiting);
      const b = answered(await send(`/api/invites/${invitationIdOf(opened.token)}/accept-signer`, {
        method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token), waiting: sealToInbox(waiting, o.inboxPublicKey) }),
      }), 201);
      if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed, so this device cannot finish it.');
      return { id: b.id };
    },
  }, { accountId: o.company, nonce: offer.seat.nonce, secret: offer.seat.secret });
  return { ...seated, fingerprint };
}

/* ------------------------------------------------------------------ codes */

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
 * **WHAT A PAYEE HANDS OVER, WHICHEVER WAY THEY JOIN**: their code, sealed to
 * the company's inbox key. Accepting a link hands it over from the payee's own
 * device; adding them from a pasted code hands over the same code from the
 * device that pasted it. An admitting device opens one package either way.
 */
export const payeeHandoverOf = (code: JoinCode, inboxPublicKey: Hex): SealedHandover => sealToInbox(code, inboxPublicKey);

/**
 * **A SIGNER'S CODE, MADE ON THEIR OWN DEVICE THROUGH THE ONE SEAT PATH.** The
 * keys are made and kept here (`doors`); their public halves and leaf go out
 * as a code their wallet signs (`sign`), instead of as a seat request: the
 * seat request is filed by whoever pastes the code. Returns the code and the
 * fingerprint the person reads to them.
 */
export async function makeSignerCodeHere(
  accountId: string, commitments: LeafScheme, doors: Omit<SeatDoors, 'publish' | 'promote'>,
  sign: (parts: SignerParts) => Promise<JoinCode>,
): Promise<{ readonly code: string; readonly fingerprint: string }> {
  let made: JoinCode | null = null;
  await acceptSeatOnThisDevice(accountId, commitments, {
    ...doors,
    publish: async (payload) => {
      made = await sign({ kind: 'signer', signingPublicKey: payload.signingPublicKey, wrappingPublicKey: payload.wrappingPublicKey, leafCommitment: payload.leafCommitment });
      return { id: null };
    },
    promote: async () => { throw new Error('a seat made for a code is bound to its seat once that seat is filed, not here.'); },
  });
  const code = made as JoinCode | null;
  if (code === null || code.parts.kind !== 'signer') throw new Error('the wallet made no code, so there is nothing to give.');
  return { code: writeJoinCode(code), fingerprint: seatKeyFingerprint(code.parts) };
}

/**
 * **A SIGNER ADDED FROM A CODE THEY GAVE.** This device checks the code's
 * signature and company, makes a real invitation for them through the same
 * filing as a link (kept, listed with the company's invitations, and spent by
 * this seat request), and files the seat request a link's acceptance files,
 * under the sign-in the code names. Returns the seat request and the
 * fingerprint to compare with the one the person reads out.
 */
export async function addSignerFromCodeHere(
  company: InvitingCompany, seat: InvitingSeat, text: string, signer: { readonly name: string; readonly role: Role }, send: InvitationSend,
): Promise<{ readonly id: string; readonly fingerprint: string }> {
  const code = codeFor(text, company, 'signer');
  const parts = code.parts as SignerParts;
  const keys = { signingPublicKey: parts.signingPublicKey, wrappingPublicKey: parts.wrappingPublicKey, leafCommitment: parts.leafCommitment };
  const made = await fileSignerInvitation(company, seat, signer, send);
  /*
   * **THE PROOF HERE SAYS THIS DEVICE VOUCHED FOR EXACTLY THESE KEYS**, under
   * the invitation it has just made and holds the secret of: it does not say
   * the joiner made them. What ties the keys to the joiner is the code's
   * signature by their wallet and the fingerprint they read out, which the
   * person adding them compares with `fingerprint` below. The seat request is
   * then the one a link's acceptance files, and every seat has one invitation
   * behind it.
   */
  const waiting: PendingSignerPayload = { name: signer.name, role: signer.role, ...keys, seatProof: proveSeatKeys(made.proved, keys) };
  const b = answered(await send(`/api/invites/${made.id}/accept-signer`, {
    method: 'POST',
    body: JSON.stringify({ acceptance: acceptanceProofOf(made.token), waiting: sealToInbox(waiting, company.inboxPublicKey), for: code.person }),
  }), 201);
  if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed.');
  return { id: b.id, fingerprint: seatKeyFingerprint(keys) };
}

/**
 * **A PAYEE ADDED FROM A CODE THEY GAVE.** Their first person record and a real
 * invitation are made and filed as for a link, and the invitation is accepted
 * here with their code as what they hand over. Admitting them is a separate
 * act. Returns the person and the fingerprint of the address they are paid at.
 */
export async function addPayeeFromCodeHere(
  company: InvitingCompany, seat: InvitingSeat, text: string, spec: PayeeSpec, send: InvitationSend,
): Promise<{ readonly person: string; readonly fingerprint: string }> {
  const code = codeFor(text, company, 'payee');
  const made = await filePayeeInvitation(company, seat, spec, send);
  answered(await send(`/api/invites/${made.id}/accept-employee`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(made.token), handover: payeeHandoverOf(code, company.inboxPublicKey) }),
  }), 201);
  return { person: made.person, fingerprint: payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts }) };
}

/** Thrown when the fingerprint a joiner reads out is not the one of the keys about to be seated. */
export class FingerprintsDiffer extends Error {
  constructor() {
    super('The fingerprint the person read out is not the fingerprint of the keys about to be seated, so what reached this company is not what their device made. Do not seat them: ask them for a new code or a new link.');
    this.name = 'FingerprintsDiffer';
  }
}

/** The fingerprint of the keys a seat request would seat, as a device about to seat it works it out. */
export const seatRequestFingerprint = (waiting: Pick<PendingSignerPayload, 'signingPublicKey' | 'wrappingPublicKey' | 'leafCommitment'>): string =>
  seatKeyFingerprint(waiting);

/** Refuses unless the fingerprint the joiner read out, however typed, is the one of the keys about to be seated. */
export function refuseASeatWhoseFingerprintIsNotTheJoiners(
  waiting: Pick<PendingSignerPayload, 'signingPublicKey' | 'wrappingPublicKey' | 'leafCommitment'>, readOut: string,
): void {
  if (tidyFingerprint(readOut) !== seatRequestFingerprint(waiting)) throw new FingerprintsDiffer();
}
