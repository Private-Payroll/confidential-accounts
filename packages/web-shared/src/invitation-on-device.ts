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
import { canonical, randomBytes, toHex, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { openFromInbox, sealToInbox } from '../../../src/core/sealed-records.js';
import { sealPerson } from '../../../src/core/person-record.js';
import { newSeatInvitation, proveSeatKeys, type SeatInvitation } from '../../../src/core/seat-invite-proof.js';
import {
  acceptanceHashOf, acceptanceProofOf, invitationIdOf, invitationLink, InvitationNotOpened, newInvitationToken, openOffer,
  replacedBy, sealOffer, seatInvitationRefusal, signInvitationFiling, signOffer, signSeatInvitation, signWithdrawal, tokenOfLink,
  type EmployeeOffer, type InvitationFiling, type InvitationOffer, type Inviter, type SignedOffer, type SignedSeatInvitation,
} from '../../../src/core/invitation.js';
import type { PendingSignerPayload, Role, RosterEmployee, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import { seatInvitationIn, seatStillProposedFor } from '../../../src/core/proposal-filing.js';
import { mayInvite } from '../../../src/midnight/seat-directory.js';
import type { AssetId } from '../../../src/core/assets.js';
import { signCompanyFiling, toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { LeafScheme } from '../../../src/core/signer-leaf.js';
import type { SealedHandover } from '../../../src/core/invite-handover.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readJoinCode, writeJoinCode, JOIN_CODE_REFUSAL, type JoinCode, type PayeeParts, type SignerParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint, seatKeyFingerprint, tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { acceptSeatOnThisDevice, type AcceptedSeat, type SeatDoors } from './accept-seat.js';
import { walletKeyProvedBy, type SeatOpening, type WalletKey } from '../../../src/core/seat-opening.js';

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

/** This device's seat: the filing key it signs with, the directory entry its wallet signed for it, and its own seat's opening. */
export interface InvitingSeat extends Inviter {
  readonly signingSecret: Hex;
  /** The one filing call, bound to this company and this seat: a person record filed here is entered in the company's records. */
  readonly entered: RecordsEntered;
  /**
   * This seat as this device's own read of the company's directory holds it: its signer role, and whether a quorum
   * retired it. Only a seat not retired whose role may file a proposal invites a signer, re-issues an invitation or
   * withdraws somebody waiting (`mayInvite`), and a seat this device cannot say that of does none of them; every
   * member's device refuses what any other seat signs. A payee's invitation does not ask it.
   */
  readonly held?: { readonly role: Role | null; readonly retired: boolean };
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

/** Thrown, before anything is signed or sent, by a seat that may not invite, re-issue or withdraw. */
export class SeatMayNotInvite extends Error {
  constructor(why: string) {
    super(`${why} Nothing was signed or sent.`);
    this.name = 'SeatMayNotInvite';
  }
}

/** Refuses unless this device's seat is one not retired whose role may file a proposal: the one rule every member's device holds it to. */
const refuseASeatThatMayNotInvite = (seat: Pick<InvitingSeat, 'held'>): void => {
  if (seat.held === undefined) {
    throw new SeatMayNotInvite('This device has not read your seat\'s role from the company\'s directory, so it invites and withdraws nobody. Reload the page.');
  }
  if (seat.held.retired) throw new SeatMayNotInvite('Your seat has been retired from this company, so it invites and withdraws nobody.');
  if (!mayInvite({ role: seat.held.role })) {
    throw new SeatMayNotInvite('Your role on this company may not file a proposal, so it invites and withdraws nobody. Ask a signer whose role may.');
  }
};

const offered = (company: InvitingCompany, seat: InvitingSeat, forWhom: InvitationOffer['for']): InvitationOffer => ({
  company: company.id, companyName: company.name, label: company.label, account: company.account,
  inboxPublicKey: company.inboxPublicKey, for: forWhom,
  /* The inviter's own seat's opening, so the invitee's wallet can tell the seat was made for its key; nothing of any other seat. */
  inviter: { committeeKey: seat.committeeKey, statement: seat.statement, opening: seat.opening },
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
  const signed = signCompanyFiling(record, seat.signingSecret);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/people`, {
    method: 'POST', body: JSON.stringify({ person: toCompanyWire(signed), invitation }),
  }), 201);
  await seat.entered.enter([companyRecordEntry(signed)]);
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

/** Who a signer's invitation is for: the name and role they are offered, and the sign-in of the person invited. */
interface SignerSpec {
  readonly name: string;
  readonly role: Role;
  readonly person: string;
}

/**
 * A signer's invitation, made here and filed: the token and the seat's secret
 * stay on this device. Who the seat is for is signed here by this seat
 * (`signSeatInvitation`) and travels inside the sealed offer; for a seat added
 * from a code it also names the leaf the code carries (`leaf`).
 */
async function fileSignerInvitation(
  company: InvitingCompany, seat: InvitingSeat, signer: SignerSpec, send: InvitationSend, leaf?: Hex,
): Promise<{ token: Hex; id: Hex; proved: SeatInvitation; invited: SignedSeatInvitation }> {
  refuseASeatThatMayNotInvite(seat);
  const proved = newSeatInvitation(company.viewingKey, company.id, signer.name, signer.role);
  const token = newInvitationToken();
  const invited = signSeatInvitation({
    company: company.id, invitation: invitationIdOf(token), person: signer.person, name: signer.name, role: signer.role,
    ...(leaf === undefined ? {} : { leaf }),
  }, seat.signingSecret);
  const invitation = filed(company, seat, 'signer', token, signOffer(offered(company, seat, {
    kind: 'signer', name: signer.name, role: signer.role, seat: { nonce: proved.nonce, secret: proved.secret }, invited,
  }), seat.signingSecret));
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/invites/signer`, {
    method: 'POST', body: JSON.stringify({ invitation }),
  }), 201);
  return { token, id: invitation.id, proved, invited };
}

/**
 * **A SIGNER INVITED FROM THIS DEVICE**, for the person whose sign-in it names,
 * with the secret their new keys will be proved by inside the offer.
 */
export async function inviteSignerHere(
  company: InvitingCompany, seat: InvitingSeat, signer: SignerSpec, origin: string, send: InvitationSend,
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
 * Whether that seat is on that account, and its opening shows it was made for
 * the inviter's wallet key, is asked of the chain by the invitee's own wallet
 * before anything is signed for it.
 */
export async function openInvitationHere(link: string, send: InvitationSend): Promise<OpenedInvitation> {
  const token = tokenOfLink(link);
  if (token === null) throw new InvitationNotOpened('it is not a whole invitation link');
  const b = answered(await send(`/api/invites/${invitationIdOf(token)}/offer`, { method: 'GET' }), 200);
  const offer = b.offer as Sealed | undefined;
  if (offer === undefined || typeof b.expiresAt !== 'string') throw new InvitationNotOpened('the service sent no sealed offer');
  const signed = openOffer(offer, token);
  /* A re-issue is kept by the service as a signer's invitation: it opens nothing on its own and names a seat already held. */
  const kind = signed.offer.for.kind === 'reissue' ? 'signer' : signed.offer.for.kind;
  if (kind !== b.kind) throw new InvitationNotOpened('it is not the kind of invitation the service says it is');
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

/** The company a signer's invitation was filed to, as the service holds it; null when it holds none. */
type FiledTo = { readonly id: string; readonly label: string | null; readonly account: string | null } | null;

/**
 * **WHY THIS DEVICE MAKES NO SEAT FOR AN OFFER**: the offer names another
 * company id, label or account than the company its seat request would be
 * filed to, so the leaf would be made for one company and the request sent to
 * another. Null when they are the same.
 */
const offerNotForTheCompanyRefusal = (o: SignedOffer['offer'], filedTo: FiledTo): string | null =>
  filedTo !== null && filedTo.id === o.company && filedTo.label === o.label
    && typeof filedTo.account === 'string' && filedTo.account.toLowerCase() === String(o.account).toLowerCase()
    ? null
    : 'this invitation names another company account or label than the company its seat request would be filed to, so no seat was made '
      + 'and nothing was sent. Ask the person who invited you for a new invitation.';

/** The company the service says this invitation was filed to, asked with the proof only the link gives. */
const filedToOf = async (opened: OpenedInvitation, send: InvitationSend): Promise<FiledTo> => {
  const b = answered(await send(`/api/invites/${invitationIdOf(opened.token)}/filed-to`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token) }),
  }), 200);
  const c = b.company as Record<string, unknown> | null | undefined;
  return typeof c === 'object' && c !== null && typeof c.id === 'string'
    ? { id: c.id, label: typeof c.label === 'string' ? c.label : null, account: typeof c.account === 'string' ? c.account : null }
    : null;
};

/**
 * **A SIGNER ACCEPTS, THROUGH THE ONE SEAT PATH.** Their keys are made and kept
 * on this device (`doors.newKeys`, `doors.seal`), the leaf committing to the
 * wallet key their own wallet gives for the company the offer names
 * (`walletKey`, asked with the offer's label and account) - once the company
 * the seat request is filed to is the one the offer names
 * (`offerNotForTheCompanyRefusal`), and only for the person the invitation
 * names; the public halves, the leaf and its opening, the proof of their keys,
 * the name and role the offer gave them, and who the seat is for as the
 * inviting seat signed it are sealed here to the company's inbox key and filed
 * as the seat request.
 * Returns, with the seat, the fingerprint of the keys for the person to read
 * to whoever seats them.
 */
export async function acceptAsSignerHere(
  opened: OpenedInvitation, commitments: LeafScheme, doors: Omit<SeatDoors, 'publish'>, send: InvitationSend,
  /** The sign-in accepting it: sealed into the request, and held to the member the company would make of it when it is seated. */
  person: string,
  /** The person's own wallet key for the company, asked of their wallet with the offer's label and account. */
  walletKey: (company: { readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress }) => Promise<WalletKey>,
): Promise<AcceptedSeat & { readonly fingerprint: string }> {
  const o = opened.signed.offer;
  if (o.for.kind !== 'signer') throw new Error('that invitation offers pay, not a seat, so it is not accepted as a signer.');
  /* A seat goes to the person invited: a link opened under another sign-in makes no seat and sends nothing. */
  if (o.for.invited.terms.person !== person) {
    throw new Error('this invitation is for somebody else, so no seat was made and nothing was sent. Sign in as the person it '
      + 'was sent to, or ask whoever invited you for an invitation of your own.');
  }
  const notThisCompany = offerNotForTheCompanyRefusal(o, await filedToOf(opened, send));
  if (notThisCompany !== null) throw new Error(notThisCompany);
  const key = await walletKey({ accountId: o.company, label: o.label, account: o.account });
  const offer = o.for;
  let fingerprint = '';
  const seated = await acceptSeatOnThisDevice(o.company, commitments, {
    ...doors,
    /* The inviter's signed entry is kept with the material, for this person's first records-key ask. */
    /* And who the seat is for, kept until this person's own directory entry carries it. */
    seal: (seat) => doors.seal({ ...seat, invitedBy: o.inviter, invited: offer.invited }),
    publish: async (payload) => {
      /* Who the seat is for, as the seat that invited signed it, travels with the keys for every approving device to check. */
      const waiting: PendingSignerPayload = { name: offer.name, role: offer.role, ...payload, person, invited: offer.invited };
      fingerprint = seatRequestFingerprint(waiting);
      const b = answered(await send(`/api/invites/${invitationIdOf(opened.token)}/accept-signer`, {
        method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(opened.token), waiting: sealToInbox(waiting, o.inboxPublicKey) }),
      }), 201);
      if (typeof b.id !== 'string') throw new Error('the service did not say which seat request it filed, so this device cannot finish it.');
      return { id: b.id };
    },
  }, key, { accountId: o.company, nonce: offer.seat.nonce, secret: offer.seat.secret });
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
 * as a code their wallet signs (`sign`), with the leaf's opening beside it,
 * instead of as a seat request: the seat request is filed by whoever pastes
 * the code. Returns the code and the fingerprint the person reads to them.
 */
export async function makeSignerCodeHere(
  accountId: string, commitments: LeafScheme, doors: Omit<SeatDoors, 'publish' | 'promote'>,
  sign: (parts: SignerParts) => Promise<JoinCode>,
  /** The person's own wallet key for the company, as their wallet gave it: the key the seat's leaf commits to. */
  walletKey: WalletKey,
): Promise<{ readonly code: string; readonly fingerprint: string }> {
  let made: JoinCode | null = null;
  await acceptSeatOnThisDevice(accountId, commitments, {
    ...doors,
    publish: async (payload) => {
      const signed = await sign({ kind: 'signer', signingPublicKey: payload.signingPublicKey, wrappingPublicKey: payload.wrappingPublicKey, leafCommitment: payload.leafCommitment });
      /* The leaf's opening rides beside the signature: it proves itself against the leaf the wallet signed. */
      made = { ...signed, opening: payload.opening };
      return { id: null };
    },
    promote: async () => { throw new Error('a seat made for a code is bound to its seat once that seat is filed, not here.'); },
  }, walletKey);
  const code = made as JoinCode | null;
  if (code === null || code.parts.kind !== 'signer') throw new Error('the wallet made no code, so there is nothing to give.');
  return { code: writeJoinCode(code), fingerprint: seatKeyFingerprint(code.parts) };
}

/**
 * **A SIGNER ADDED FROM A CODE THEY GAVE.** This device checks the code's
 * signature and company, and that the opening beside it makes the code's leaf
 * for the wallet that signed the code (`walletKeyProvedBy`, with the leaf this
 * device's vault worker works out, `leaves`). It then makes a real invitation
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
  /* The invitation names the leaf the joiner's wallet signed, and the person it signed for. */
  const made = await fileSignerInvitation(company, seat, { ...signer, person: code.person }, send, parts.leafCommitment);
  /*
   * **THE PROOF HERE SAYS THIS DEVICE VOUCHED FOR EXACTLY THESE KEYS**, under
   * the invitation it has just made and holds the secret of: it does not say
   * the joiner made them. What ties the keys to the joiner is the code's
   * signature by their wallet, the opening that makes its leaf for that wallet,
   * and the fingerprint they read out, which the person adding them compares
   * with `fingerprint` below. The seat request is then the one a link's
   * acceptance files, and every seat has one invitation behind it.
   */
  const waiting: PendingSignerPayload = {
    name: signer.name, role: signer.role, ...keys, seatProof: proveSeatKeys(made.proved, keys), person: code.person,
    opening, invited: made.invited,
  };
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

/* ------------------------------------------------------------------ an inviter who left */

/**
 * **THE SEAT HANDED TO A PERSON'S WALLET AS THEIR INVITER**: of the one this
 * device kept from the invitation it accepted (or a re-issue of it) and the
 * one the proposal that seated them carries, the first whose seat the account
 * holds now, as the person's own wallet read it (`onTheChain`); the kept one
 * when neither is. The wallet keeps the company's account only on a seat of it
 * (`whyTheInvitationDoesNotNameIt`), so an inviter who has left is passed over
 * for one who has not, and a person added from a code, who kept none, is
 * handed the seat that raised their proposal.
 */
export const inviterForTheWallet = (
  kept: Inviter | undefined, carried: Inviter | null, onTheChain: readonly string[],
): Inviter | undefined => {
  const held = (x: Inviter | null | undefined): x is Inviter =>
    x != null && typeof x.statement?.seat === 'string' && onTheChain.some((s) => s.toLowerCase() === x.statement.seat.toLowerCase());
  if (held(kept)) return kept;
  if (held(carried)) return carried;
  return kept ?? carried ?? undefined;
};

/** Who an invitation is re-issued for: their seat on the chain, and the company's proposals, which carry the one it replaces. */
interface Reissued {
  /** The seat the chain holds that the invitation is re-issued for. */
  readonly leaf: Hex;
  /** The company's proposals: the one that seated the leaf carries the invitation it replaces, read by that leaf. */
  readonly proposals: readonly Pick<SealedProposal, 'accountId' | 'sealed'>[];
  /** Every seat the company's account holds now, as this person's own wallet read it. */
  readonly onTheChain: readonly string[];
}

/** The invitation the proposal seating `leaf` carried - one, read by the leaf - unless it is itself a re-issue. */
const replacedFor = (proposals: Reissued['proposals'], accountId: string, viewingKey: Hex, leaf: string): SignedSeatInvitation | null => {
  const original = seatInvitationIn(proposals, accountId, viewingKey, leaf);
  return original === null || original.terms.replaces !== undefined ? null : original;
};

/**
 * **AN INVITATION RE-ISSUED FROM THIS DEVICE FOR A PERSON WHOSE INVITER LEFT.**
 * For somebody the chain already seats: the invitation their seat was proposed
 * under - the one the proposal that seated their leaf carries, read by that
 * leaf - is signed again by this seat, for the same person, name and role and
 * the same leaf, naming the invitation it replaces, under a new link, with
 * this seat as their inviter. Their
 * device keeps both in place of what it kept (`takeTheReissueHere`), so their
 * wallet keeps the company's account on a seat it holds, and their own entry
 * carries an invitation from a seat not retired. Refused before anything is
 * signed when this seat may not invite, when the invitation names no leaf or
 * another company, or when the chain does not hold that leaf now.
 */
export async function reissueInvitationHere(
  company: InvitingCompany, seat: InvitingSeat, reissued: Reissued, origin: string, send: InvitationSend,
): Promise<MadeInvitation> {
  refuseASeatThatMayNotInvite(seat);
  const original = replacedFor(reissued.proposals, company.id, company.viewingKey, reissued.leaf);
  const t = original?.terms;
  if (original === null || t === undefined || seatInvitationRefusal(original) !== null || t.company !== company.id || t.leaf?.toLowerCase() !== reissued.leaf.toLowerCase()) {
    throw new SeatMayNotInvite('No one invitation a seat of this company signed for that seat is carried by the proposal that seated it, so nothing is re-issued.');
  }
  const leaf = t.leaf;
  if (!reissued.onTheChain.some((x) => x.toLowerCase() === leaf.toLowerCase())) {
    throw new SeatMayNotInvite('The seat that invitation names is not one the company\'s account holds now, so it is not re-issued: '
      + 'somebody waiting for a seat is withdrawn and invited again instead.');
  }
  const token = newInvitationToken();
  /* Exactly the person, name, role and seat the signers approved, and the invitation it replaces, for every member's device to hold it to. */
  const invited = signSeatInvitation({
    company: company.id, invitation: invitationIdOf(token), person: t.person, name: t.name, role: t.role, leaf,
    replaces: { invitation: t.invitation, signedBy: original.signedBy, signature: original.signature },
  }, seat.signingSecret);
  const invitation = filed(company, seat, 'signer', token, signOffer(offered(company, seat, { kind: 'reissue', name: t.name, role: t.role, invited }), seat.signingSecret));
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/invites/signer`, {
    method: 'POST', body: JSON.stringify({ invitation }),
  }), 201);
  return { link: invitationLink(origin, token), id: invitation.id };
}

/**
 * **A RE-ISSUED INVITATION, TAKEN ON THE PERSON'S OWN DEVICE.** Taken only for
 * the person signed in and for this device's own seat: the seat that signed it
 * and the invitation are kept together (`keep`), in place of the inviter and
 * invitation this device kept, for their wallet's next records-key ask and
 * their own directory entry. Nothing is sent.
 */
export async function takeTheReissueHere(
  opened: OpenedInvitation, mine: { readonly accountId: string; readonly person: string; readonly seat: string; readonly viewingKey: Hex },
  /** The company's proposals: the one that seated this device's seat carries the invitation the re-issue must replace. */
  proposals: Reissued['proposals'],
  keep: (reissued: { readonly inviter: Inviter; readonly invited: SignedSeatInvitation }) => Promise<void>,
): Promise<void> {
  const o = opened.signed.offer;
  if (o.for.kind !== 'reissue') throw new Error('that invitation does not re-issue an invitation for a seat, so nothing was kept.');
  const t = o.for.invited.terms;
  if (o.company !== mine.accountId || t.person !== mine.person) {
    throw new Error('that re-issued invitation is for somebody else, or another company, so nothing was kept. Sign in as the person it was sent to.');
  }
  if (t.leaf?.toLowerCase() !== mine.seat.toLowerCase()) {
    throw new Error('that re-issued invitation names another seat than the one this device holds for you, so nothing was kept.');
  }
  /* Only exactly the invitation your seat was proposed under, signed again: the same person, name, role and seat. */
  const original = replacedFor(proposals, mine.accountId, mine.viewingKey, mine.seat);
  const replaced = replacedBy(o.for.invited);
  if (original === null || replaced === null || canonical(replaced) !== canonical(original)) {
    throw new Error('that re-issued invitation is not the one your seat was proposed under, for the same name and role, so nothing was kept. '
      + 'Ask the signer who sent it to re-issue it again.');
  }
  await keep({ inviter: o.inviter, invited: o.for.invited });
}

/* ------------------------------------------------------------------ withdrawing somebody waiting */

/** What this device reads to withdraw a seat request: the company's inbox and proposals, and the chain's seats now. */
interface WaitingReads {
  readonly sealed: SealedAccount;
  readonly proposals: readonly SealedProposal[];
  /** Every seat the company's account holds now, as this person's own wallet read it. */
  readonly onTheChain: readonly string[];
  /** The ids of every proposal the company's account holds open now, approved or not, as this device's own read of the chain gives them. */
  readonly openOnTheChain: readonly string[];
}

/**
 * **SOMEBODY WAITING FOR A SEAT, WITHDRAWN FROM THIS DEVICE**, so the same
 * person can accept a new invitation. The request is opened here with the
 * company's key, and refused - before anything is signed - while the chain
 * holds its leaf, or holds a proposal to seat it open (as this device's own
 * read of the chain says, never the service), since either may still seat it:
 * that proposal is withdrawn first. The withdrawal names the request, the
 * invitation it answered and its leaf, signed by this seat's filing key; the
 * service lets the request go only while the chain holds this seat and not
 * that leaf.
 */
export async function withdrawWaitingSignerHere(
  company: Pick<InvitingCompany, 'id' | 'viewingKey'>, seat: Pick<InvitingSeat, 'signingSecret' | 'held' | 'statement'>, signerId: string,
  reads: WaitingReads, send: InvitationSend,
): Promise<void> {
  refuseASeatThatMayNotInvite(seat);
  if (!reads.onTheChain.some((x) => x.toLowerCase() === seat.statement.seat.toLowerCase())) {
    throw new SeatMayNotInvite('Your seat is not one the company\'s account holds now, so it withdraws nobody.');
  }
  const box = reads.sealed.pendingSigners.find((p) => p.id === signerId);
  if (box === undefined) throw new Error('That person is no longer waiting for a seat. Reload the page. Nothing was signed or sent.');
  const waiting = openFromInbox<PendingSignerPayload>(box.sealed, company.id, company.viewingKey);
  const invitation = waiting.invited?.terms.invitation;
  if (invitation === undefined) {
    throw new Error('This seat request names no invitation, so it cannot be withdrawn by its invitation. Nothing was signed or sent.');
  }
  if (reads.onTheChain.some((x) => x.toLowerCase() === waiting.leafCommitment.toLowerCase())) {
    throw new Error('The chain already holds this person\'s seat, so they are not withdrawn: they are admitted, or removed by '
      + 'a removal. Nothing was signed or sent.');
  }
  if (seatStillProposedFor(reads.proposals, company.id, company.viewingKey, signerId, reads.openOnTheChain)) {
    throw new Error('A proposal to seat this person is still open, and could still seat them. Withdraw that proposal first. '
      + 'Nothing was signed or sent.');
  }
  /* The leaf travels with it, so the service lets nothing go once its own read of the chain shows that leaf seated. */
  const withdrawal = signWithdrawal({ company: company.id, signerId, invitation, leaf: waiting.leafCommitment }, seat.signingSecret);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/signers/${encodeURIComponent(signerId)}/withdraw`, {
    method: 'POST', body: JSON.stringify({ withdrawal }),
  }), 200);
}
