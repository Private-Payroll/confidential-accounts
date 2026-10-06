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
 * account, the inviter's committee key and the entry its wallet signed. So the
 * invitee's device can tell which company's account the invitation is for from
 * the invitation itself, and check the inviter's committee key against that
 * account on the chain, without taking the service's word for either.
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
}

/** The seat that invited: its committee key, and the directory entry its wallet signed. */
export interface Inviter {
  readonly committeeKey: { readonly tag: string; readonly value: string };
  readonly statement: DirectoryEntryStatement;
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
  readonly for: EmployeeOffer | SignerOffer;
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
 * inviter's committee key for this company's label and account. Whether that
 * committee key is on the account's committee is the chain's to say, and the
 * invitee's wallet asks it.
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
  if (!verify(offerMessage(o), signed.signature, s.signingKey)) return 'the seat that invited did not sign this offer';
  const f = o.for;
  if (f?.kind === 'signer') {
    if (!HEX64.test(String(f.seat?.nonce)) || !HEX64.test(String(f.seat?.secret))) return 'it offers a seat without the secret to prove one with';
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
