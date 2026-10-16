/**
 * **AN INVITATION, MADE ON THE INVITING SIGNER'S DEVICE: ONE TOKEN SPLIT
 * THREE WAYS, AN OFFER ONLY THE TOKEN OPENS, AND A FILING THE SERVICE CAN
 * CHECK WITHOUT OPENING ANYTHING.**
 *
 * The inviting device draws a random token and never sends it. From it come
 * three values, each under its own domain so none says anything about another:
 *
 *   · **the lookup id**, which names the invitation in its link's path and in
 *     the service's table;
 *   · **the offer key**, which seals what the person is offered; it travels
 *     only in the link's fragment, which a browser never sends to a server;
 *   · **the acceptance proof**, which the invitee's device sends to accept; the
 *     service keeps only its hash, so the table opens nothing and accepts
 *     nothing on its own.
 *
 * **THE OFFER IS SIGNED BY THE SEAT THAT INVITED**, with the filing key its
 * directory entry names, and carries that entry: the company's label and
 * account, the inviter's wallet key, the entry its wallet signed and the
 * inviter's own seat's opening. So the invitee's device can tell which
 * company's account the invitation is for from the invitation itself, and its
 * wallet can check that the inviter's seat on that account was made for that
 * wallet key, without taking the service's word for either.
 *
 * Pure: the service and the page both import it.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { directoryEntrySignedBy, type DirectoryEntryStatement } from 'midnight-identity/profile/records-key';
import {
  readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel,
} from 'midnight-identity/profile/company-label';
import {
  canonical, parseCanonical, randomBytes, seal, sign, signingPublicKeyOf, toHex, unseal, utf8, verify,
  type Hex, type Sealed,
} from './crypto.js';
import type { AssetId } from './assets.js';
import type { Role } from './types.js';
import { seatOpeningRefusal, type SeatOpening } from './seat-opening.js';

/** How long an invitation can be accepted for, from when it is filed. */
export const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;

/* ------------------------------------------------------------------ the token */

/** A new invitation token: 32 random bytes, drawn and kept on the inviting device. */
export const newInvitationToken = (): Hex => toHex(randomBytes(32));

const derived = (what: string, token: string): Hex => {
  if (!HEX64.test(token)) throw new Error('that is not an invitation token, so nothing can be worked out from it.');
  return toHex(sha256(utf8(`confidential-accounts/invitation/${what}:${token}`)));
};

/** The invitation's name in its link's path and in the service's table. */
export const invitationIdOf = (token: Hex): Hex => derived('id', token);
/** The key the offer is sealed under. Never leaves the link's fragment. */
export const offerKeyOf = (token: Hex): Hex => derived('offer', token);
/** What the invitee's device sends to accept. */
export const acceptanceProofOf = (token: Hex): Hex => derived('accept', token);
/** What the service keeps of the acceptance proof: its hash, which accepts nothing. */
export const acceptanceHashOf = (proof: Hex): Hex => {
  if (!HEX64.test(proof)) throw new Error('that is not an acceptance proof.');
  return toHex(sha256(utf8(`confidential-accounts/invitation/accept-hash:${proof}`)));
};

/** The link the inviter sends: the lookup id in the path, the token in the fragment. */
export const invitationLink = (origin: string, token: Hex): string =>
  `${origin.replace(/\/+$/u, '')}/join/${invitationIdOf(token)}#${token}`;

/** The token a link carries, or null when it is not an invitation link or its path and fragment disagree. */
export const tokenOfLink = (link: string): Hex | null => {
  const m = /\/join\/([0-9a-f]{64})#([0-9a-f]{64})\s*$/u.exec(link.trim());
  if (m === null) return null;
  return invitationIdOf(m[2]!) === m[1] ? m[2]! : null;
};

/* ------------------------------------------------------------------ the offer */

/** What a payee is offered: the person record it names, and their pay. */
export interface EmployeeOffer {
  readonly kind: 'employee';
  /** The id of the person record the invitation is for. */
  readonly person: string;
  readonly name: string;
  readonly title: string;
  readonly email: string | null;
  readonly asset: AssetId;
  readonly baseAmount: bigint;
  readonly startDate: string;
}

/** What a signer is offered: a seat, with the secret their keys are proved by. */
export interface SignerOffer {
  readonly kind: 'signer';
  readonly name: string;
  readonly role: Role;
  /** The secret the invitee's device proves its new keys with (`seat-invite-proof.ts`). */
  readonly seat: { readonly nonce: Hex; readonly secret: Hex };
  /** Who the seat is for, as the seat that invited signed it; the joiner's device copies it into the seat request. */
  readonly invited: SignedSeatInvitation;
}

/**
 * **AN INVITATION RE-ISSUED FOR A SEAT THE CHAIN ALREADY HOLDS**: who the seat
 * is for, signed again by a seat that holds one now, naming the same person,
 * name and role and the seat's own leaf. For a person whose inviter left
 * before their own entry and their wallet's first records-key ask: their
 * device keeps it, with the seat that signed it (`InvitationOffer.inviter`), in
 * place of the invitation and inviter it kept. It offers no new seat, so it
 * carries no secret to prove new keys with.
 */
export interface ReissueOffer {
  readonly kind: 'reissue';
  readonly name: string;
  readonly role: Role;
  readonly invited: SignedSeatInvitation;
}

/**
 * **WHO A SEAT IS FOR, AS THE SEAT THAT INVITED SIGNED IT**: the company, the
 * invitation's id, the sign-in of the person invited, and the name and role
 * they are offered. Where the joiner's keys reached the inviter in a code their
 * wallet signed, it also names the leaf that code carries, so the seat is bound
 * to that leaf from the start. The service cannot write one, because only a
 * seat's filing key signs it, and every approving device holds a seat request
 * to it before it approves the leaf.
 */
export interface SeatInvitationTerms {
  /** The company's id on this service. */
  readonly company: string;
  /** The invitation's id: its name in its link's path and in the service's table. */
  readonly invitation: Hex;
  /** The sign-in of the person invited. */
  readonly person: string;
  readonly name: string;
  readonly role: Role;
  /** Only for a seat added from a code: the leaf the code carries. */
  readonly leaf?: Hex;
  /**
   * Only on an invitation re-issued for a seat the chain already holds: the invitation it replaces - the one the
   * proposal that seated that leaf carried - by its id and its signature. Its terms are this one's own, but for the
   * id, so it verifies only where the person, name, role and seat are exactly the ones that seat was proposed with
   * (`replacedBy`).
   */
  readonly replaces?: { readonly invitation: Hex; readonly signedBy: Hex; readonly signature: Hex };
}

/** A seat invitation, signed by the filing key of the seat that invited (`signedBy`). */
export interface SignedSeatInvitation {
  readonly terms: SeatInvitationTerms;
  readonly signedBy: Hex;
  readonly signature: Hex;
}

const SEAT_INVITATION_DOMAIN = 'confidential-accounts/seat-invitation/v1';
const PERSON = /^[A-Za-z0-9_-]{1,64}$/u;
const seatInvitationMessage = (terms: SeatInvitationTerms): string => canonical({ domain: SEAT_INVITATION_DOMAIN, terms });

/** A seat invitation, signed on the inviting device by the filing key its directory entry names. */
export const signSeatInvitation = (terms: SeatInvitationTerms, signingSecret: Hex): SignedSeatInvitation => {
  const t: SeatInvitationTerms = {
    company: terms.company, invitation: terms.invitation.toLowerCase() as Hex, person: terms.person, name: terms.name, role: terms.role,
    ...(terms.leaf === undefined ? {} : { leaf: terms.leaf.toLowerCase() as Hex }),
    ...(terms.replaces === undefined ? {} : { replaces: {
      invitation: terms.replaces.invitation.toLowerCase() as Hex, signedBy: terms.replaces.signedBy.toLowerCase() as Hex, signature: terms.replaces.signature.toLowerCase() as Hex,
    } }),
  };
  if (seatInvitationTermsRefusal(t) !== null) throw new Error('that is not a seat invitation this device can sign, so the invitation was not made.');
  return { terms: t, signedBy: signingPublicKeyOf(signingSecret), signature: sign(seatInvitationMessage(t), signingSecret) };
};

const seatInvitationTermsRefusal = (t: Partial<SeatInvitationTerms> | null | undefined): string | null => {
  if (typeof t !== 'object' || t === null) return 'it names nobody';
  const keys = Object.keys(t).sort().join(',');
  if (keys !== 'company,invitation,name,person,role' && keys !== 'company,invitation,leaf,name,person,role'
    && keys !== 'company,invitation,leaf,name,person,replaces,role') {
    return 'it carries something a seat invitation does not';
  }
  if (t.replaces !== undefined) {
    const r = t.replaces as Partial<NonNullable<SeatInvitationTerms['replaces']>> | null;
    if (typeof r !== 'object' || r === null || Object.keys(r).sort().join(',') !== 'invitation,signature,signedBy'
      || !HEX64.test(String(r.invitation)) || !HEX64.test(String(r.signedBy)) || !HEX128.test(String(r.signature))) {
      return 'the invitation it replaces is not named by its id and signature';
    }
  }
  if (typeof t.company !== 'string' || t.company === '' || typeof t.name !== 'string' || typeof t.role !== 'string' || String(t.role) === '') {
    return 'it does not name the company, the name and the role';
  }
  if (typeof t.person !== 'string' || !PERSON.test(t.person)) return 'it does not name the sign-in of the person invited';
  if (!HEX64.test(String(t.invitation))) return 'it does not name its invitation';
  if (t.leaf !== undefined && !HEX64.test(String(t.leaf))) return 'the leaf it names is not one';
  return null;
};

/**
 * **WHY THIS IS NOT A SEAT INVITATION SIGNED BY THE FILING KEY IT NAMES**, or
 * null when it is. Whether that key is a seat the reader believes is the
 * reader's to ask of its own read of the company's directory.
 */
export const seatInvitationRefusal = (x: unknown): string | null => {
  const s = x as Partial<SignedSeatInvitation> | null | undefined;
  if (typeof s !== 'object' || s === null || Object.keys(s).sort().join(',') !== 'signature,signedBy,terms') return 'it is not a signed seat invitation';
  const why = seatInvitationTermsRefusal(s.terms);
  if (why !== null) return why;
  if (!HEX64.test(String(s.signedBy)) || !HEX128.test(String(s.signature))) return 'it is not signed by a filing key';
  return verify(seatInvitationMessage(s.terms!), s.signature!, s.signedBy!) ? null : 'the key it names did not sign it';
};

/**
 * **THE INVITATION A RE-ISSUE REPLACES**, as its seat signed it: this one's own
 * terms with the replaced invitation's id, under the signature the re-issue
 * names. Null for an invitation that replaces none. Whether it verifies -
 * which it does only for exactly the person, name, role and seat the replaced
 * one named - and whether a seat of the company signed it, is the reader's to
 * ask (`seatInvitationRefusal`, and its own read of the directory).
 */
export const replacedBy = (reissue: SignedSeatInvitation): SignedSeatInvitation | null => {
  const r = reissue.terms.replaces;
  if (r === undefined) return null;
  const { replaces: _replaced, ...terms } = reissue.terms;
  return { terms: { ...terms, invitation: r.invitation }, signedBy: r.signedBy, signature: r.signature };
};

/**
 * The seat that invited: its wallet key, the directory entry its wallet
 * signed, and its own seat's opening, which shows the invitee's wallet that
 * the seat was made for that key. Nothing of any other seat.
 */
export interface Inviter {
  readonly committeeKey: { readonly tag: string; readonly value: string };
  readonly statement: DirectoryEntryStatement;
  readonly opening: SeatOpening;
}

/** An invitation's offer, as its invitee reads it. */
export interface InvitationOffer {
  /** The company's id on this service. */
  readonly company: string;
  readonly companyName: string;
  readonly label: CompanyLabel;
  /** The company's account on the chain, as the inviter's entry binds it. */
  readonly account: AccountAddress;
  /** The key the invitee seals what they hand over to. */
  readonly inboxPublicKey: Hex;
  readonly for: EmployeeOffer | SignerOffer | ReissueOffer;
  readonly inviter: Inviter;
}

export interface SignedOffer {
  readonly offer: InvitationOffer;
  /** By the inviter's filing key, over the offer. */
  readonly signature: Hex;
}

const OFFER_DOMAIN = 'confidential-accounts/invitation-offer/v1';
const offerMessage = (offer: InvitationOffer): string => canonical({ domain: OFFER_DOMAIN, offer });

/** The offer, signed on the inviting device by the filing key its directory entry names. */
export const signOffer = (offer: InvitationOffer, signingSecret: Hex): SignedOffer => {
  if (signingPublicKeyOf(signingSecret) !== offer.inviter.statement.signingKey) {
    throw new Error('this device\'s filing key is not the one its directory entry names, so the invitation was not made.');
  }
  return { offer, signature: sign(offerMessage(offer), signingSecret) };
};

/**
 * **WHY AN OFFER IS NOT ONE ITS INVITER SIGNED**, or null when it is: signed by
 * the filing key the inviter's entry names, and that entry signed by the
 * inviter's committee key for this company's label and account, with the
 * inviter's own seat's opening in its shape. Whether that seat is on the
 * account, and its opening proves that key for it, is the chain's leaf to say,
 * and the invitee's wallet asks it.
 */
export const whyThisOfferIsNotSigned = (signed: SignedOffer): string | null => {
  const o = signed?.offer;
  if (typeof o !== 'object' || o === null || typeof signed.signature !== 'string' || !HEX128.test(signed.signature)) {
    return 'it is not a signed invitation';
  }
  if (readCompanyLabel(o.label) === null || readAccountAddress(o.account) === null || !HEX64.test(String(o.inboxPublicKey))) {
    return 'it does not name a company\'s label, account and key';
  }
  const s = o.inviter?.statement;
  if (typeof s !== 'object' || s === null || s.account !== o.account) return 'the seat that invited is not on the account it names';
  if (!directoryEntrySignedBy(o.label, o.account, o.inviter.committeeKey, s)) return 'the seat that invited did not sign its entry for this company';
  if (seatOpeningRefusal(o.inviter.opening) !== null) return 'the seat that invited did not hand over its own seat\'s opening';
  if (!verify(offerMessage(o), signed.signature, s.signingKey)) return 'the seat that invited did not sign this offer';
  const f = o.for;
  if (f?.kind === 'signer' || f?.kind === 'reissue') {
    if (f.kind === 'signer' && (!HEX64.test(String(f.seat?.nonce)) || !HEX64.test(String(f.seat?.secret)))) {
      return 'it offers a seat without the secret to prove one with';
    }
    /* Who the seat is for, signed by the same seat that signed the offer, for the same company, name and role. */
    const invited = seatInvitationRefusal(f.invited);
    if (invited !== null) return `it does not say who the seat is for (${invited})`;
    const t = f.invited.terms;
    if (f.invited.signedBy !== s.signingKey || t.company !== o.company || t.name !== f.name || t.role !== f.role) {
      return 'who the seat is for was not signed by the seat that invited, for this offer';
    }
  } else if (f?.kind !== 'employee' || typeof f.person !== 'string' || typeof f.baseAmount !== 'bigint') {
    return 'it offers nothing this service knows';
  }
  return null;
};

/** Thrown for a link that opens no offer, or one its inviter did not sign. */
export class InvitationNotOpened extends Error {
  constructor(why: string) {
    super(`this invitation could not be opened: ${why}. Nothing was sent. Ask whoever invited you for a new link.`);
    this.name = 'InvitationNotOpened';
  }
}

/** The signed offer, sealed under the token's offer key. */
export const sealOffer = (signed: SignedOffer, token: Hex): Sealed => seal(canonical(signed), offerKeyOf(token));

/** The offer a link opens, checked as its inviter's, or `InvitationNotOpened`. */
export const openOffer = (sealed: Sealed, token: Hex): SignedOffer => {
  let signed: SignedOffer;
  try {
    signed = parseCanonical<SignedOffer>(unseal(sealed, offerKeyOf(token)));
  } catch {
    throw new InvitationNotOpened('the link does not open the offer it names');
  }
  const why = whyThisOfferIsNotSigned(signed);
  if (why !== null) throw new InvitationNotOpened(why);
  /* A link's seat is for the invitation the link names, and names no leaf: the joiner's device has not made one yet. */
  const f = signed.offer.for;
  if (f.kind === 'signer' && (f.invited.terms.invitation !== invitationIdOf(token) || f.invited.terms.leaf !== undefined)) {
    throw new InvitationNotOpened('who the seat is for was signed for another invitation than this link');
  }
  /* A re-issue is for a seat the chain already holds, so it names that seat's leaf, under the invitation the link names. */
  if (f.kind === 'reissue' && (f.invited.terms.invitation !== invitationIdOf(token) || f.invited.terms.leaf === undefined)) {
    throw new InvitationNotOpened('the invitation it re-issues was signed for another invitation than this link, or for no seat');
  }
  return signed;
};

/* ------------------------------------------------------------------ the filing */

/**
 * **AN INVITATION AS THE INVITING DEVICE FILES IT**: everything the service
 * keeps, and the seat's signature over it. Nothing in it opens the offer or
 * accepts the invitation.
 */
export interface InvitationFiling {
  readonly company: string;
  readonly kind: 'employee' | 'signer';
  readonly id: Hex;
  readonly acceptanceHash: Hex;
  readonly offer: Sealed;
  /** A payee's invitation: the person record it is for. */
  readonly person?: string;
  readonly filedBy?: { readonly publicKey: Hex; readonly signature: Hex };
}

const FILING_DOMAIN = 'confidential-accounts/invitation-filing/v1';
const filingMessage = (f: InvitationFiling): string => {
  const { filedBy: _signature, ...unsigned } = f;
  return canonical({ domain: FILING_DOMAIN, ...unsigned });
};

export const signInvitationFiling = (f: InvitationFiling, signingSecret: Hex): InvitationFiling => {
  const { filedBy: _replaced, ...unsigned } = f;
  return { ...unsigned, filedBy: { publicKey: signingPublicKeyOf(signingSecret), signature: sign(filingMessage(unsigned), signingSecret) } };
};

/** The filing key that signed this invitation, or null for none or one that does not cover exactly it. */
export const verifiedInvitationFiler = (f: InvitationFiling): Hex | null => {
  const by = f.filedBy;
  if (!by || typeof by.publicKey !== 'string' || typeof by.signature !== 'string') return null;
  return verify(filingMessage(f), by.signature, by.publicKey) ? by.publicKey : null;
};

/** Why `x` is not an invitation filing for `company`, or null when it is one. */
export const whyThisIsNotAnInvitation = (x: unknown, company: string): string | null => {
  if (x === null || typeof x !== 'object') return 'it is not an invitation';
  const f = x as Record<string, unknown>;
  const allowed = ['company', 'kind', 'id', 'acceptanceHash', 'offer', 'person', 'filedBy'];
  if (Object.keys(f).some((k) => !allowed.includes(k))) return 'it carries something an invitation does not, and nothing unread is kept';
  if (f.company !== company) return 'it is for another company';
  if (f.kind !== 'employee' && f.kind !== 'signer') return 'it is neither a payee\'s nor a signer\'s';
  if (!HEX64.test(String(f.id)) || !HEX64.test(String(f.acceptanceHash))) return 'it is not named by a lookup id and an acceptance hash';
  const o = f.offer as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || ['iv', 'tag', 'body'].some((k) => typeof o[k] !== 'string')) return 'it carries no sealed offer';
  if (f.kind === 'employee' ? typeof f.person !== 'string' || f.person === '' : f.person !== undefined) {
    return 'a payee\'s invitation names the person it is for, and only a payee\'s does';
  }
  return null;
};

/* ------------------------------------------------------------------ using it */

/** Why a stored invitation cannot be opened or accepted now, each a sentence its reader can act on. */
export const INVITATION_REFUSAL = {
  'not-found': 'there is no invitation at this link. Check you have the whole link, or ask whoever invited you for a new one.',
  'withdrawn': 'this invitation has been withdrawn by the company that sent it, so there is no offer here any more. Nothing you do with this link can change anything. If you were expecting to join, ask whoever sent it to you.',
  'expired': 'this invitation has expired, so the offer it carried can no longer be opened or accepted. Nothing has been sent and nothing has changed. Ask whoever invited you to send a new invitation - the same link cannot be re-opened, by them or by us.',
  'used': 'this invitation has already been accepted, so it cannot be accepted again. If that was not you, tell whoever invited you now.',
  'not-accepted': 'what was sent does not accept this invitation. Open the whole link again on the device you are joining from.',
} as const;
export type InvitationRefusal = keyof typeof INVITATION_REFUSAL;

/** Why `invite` (of `kind`) cannot be opened at `now`, or null when it can. */
export const whyThisInvitationIsClosed = (
  invite: { kind: string; revokedAt?: string; acceptedAt?: string; expiresAt?: string } | null, kind: 'employee' | 'signer', now: number,
): InvitationRefusal | null => {
  if (invite === null || invite.kind !== kind) return 'not-found';
  if (invite.revokedAt) return 'withdrawn';
  if (!invite.expiresAt || Date.parse(invite.expiresAt) <= now) return 'expired';
  if (invite.acceptedAt) return 'used';
  return null;
};

/** Whether `proof` accepts an invitation whose stored hash is `hash`. */
export const acceptsTheInvitation = (proof: unknown, hash: string | undefined): boolean =>
  typeof proof === 'string' && HEX64.test(proof) && typeof hash === 'string' && acceptanceHashOf(proof) === hash;

/* ------------------------------------------------------------------ one person, one seat request */

/**
 * **WHETHER `person` IS ALREADY ON THE COMPANY OR WAITING FOR A SEAT ON IT**:
 * a member, or named on a seat request still waiting. The one rule every
 * acceptance of a signer's invitation is refused by, so one person waits for
 * one seat. A convenience of the service's store: the directory's own
 * `person-has-a-seat` and every approving device's one-person check decide.
 */
export const alreadyOnTheCompany = (
  company: { readonly memberUserIds: readonly string[]; readonly pendingSigners: readonly { readonly userId: string | null }[] },
  person: string,
): boolean => company.memberUserIds.includes(person) || company.pendingSigners.some((p) => p.userId === person);

/* ------------------------------------------------------------------ withdrawing a waiting signer */

/**
 * **SOMEBODY WAITING FOR A SEAT, WITHDRAWN**: the company, the seat request
 * the service filed them under, and the invitation it answered, signed by the
 * filing key of a seat of the company (`signedBy`). The service keeps it only
 * while that key's seat is one the chain holds; whether the seat's role may
 * withdraw anybody is the signing device's to refuse (`mayInvite`).
 */
export interface WaitingSignerWithdrawal {
  readonly company: string;
  /** The seat request's id, as the service filed it. */
  readonly signerId: string;
  /** The invitation the request answered: its link reads as withdrawn from then on. */
  readonly invitation: Hex;
  /** The leaf the request is for: a request whose leaf the chain holds is never withdrawn. */
  readonly leaf: Hex;
  readonly signedBy: Hex;
  readonly signature: Hex;
}

const WITHDRAWAL_DOMAIN = 'confidential-accounts/waiting-signer-withdrawn/v1';
const SIGNER_ID = /^sgn_[A-Za-z0-9_-]{1,64}$/u;
const withdrawalMessage = (w: Pick<WaitingSignerWithdrawal, 'company' | 'signerId' | 'invitation' | 'leaf'>): string =>
  canonical({ domain: WITHDRAWAL_DOMAIN, company: w.company, signerId: w.signerId, invitation: w.invitation.toLowerCase(), leaf: w.leaf.toLowerCase() });

/** A withdrawal of the seat request `signerId`, signed on a seat's device by its filing key. */
export const signWithdrawal = (
  terms: Pick<WaitingSignerWithdrawal, 'company' | 'signerId' | 'invitation' | 'leaf'>, signingSecret: Hex,
): WaitingSignerWithdrawal => {
  const t = { company: terms.company, signerId: terms.signerId, invitation: terms.invitation.toLowerCase() as Hex, leaf: terms.leaf.toLowerCase() as Hex };
  return { ...t, signedBy: signingPublicKeyOf(signingSecret), signature: sign(withdrawalMessage(t), signingSecret) };
};

/**
 * **WHY THIS IS NOT A WITHDRAWAL OF A SEAT REQUEST OF `company`, SIGNED BY THE
 * FILING KEY IT NAMES**, or null when it is. Which seat that key is, and
 * whether the chain holds it, is the reader's to ask.
 */
export const withdrawalRefusal = (x: unknown, company: string): string | null => {
  const w = x as Partial<WaitingSignerWithdrawal> | null | undefined;
  if (typeof w !== 'object' || w === null || Object.keys(w).sort().join(',') !== 'company,invitation,leaf,signature,signedBy,signerId') {
    return 'it is not a signed withdrawal';
  }
  if (w.company !== company) return 'it is for another company';
  if (typeof w.signerId !== 'string' || !SIGNER_ID.test(w.signerId) || !HEX64.test(String(w.invitation)) || !HEX64.test(String(w.leaf))) {
    return 'it does not name a seat request, the invitation it answered and the leaf it is for';
  }
  if (!HEX64.test(String(w.signedBy)) || !HEX128.test(String(w.signature))) return 'it is not signed by a filing key';
  return verify(withdrawalMessage(w as WaitingSignerWithdrawal), w.signature!, w.signedBy!) ? null : 'the key it names did not sign it';
};
