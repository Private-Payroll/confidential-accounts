/*
 * An invitation as the inviting device files it with the service: what the service keeps, signed by the inviting
 * seat, and why a filing is not one. Nothing in it opens the offer or names the person.
 */
import { canonical, sign, signingPublicKeyOf, verify, type Hex, type Sealed } from './crypto.js';
import { EMPLOYEE_ID, INVITATION_KINDS, PAYEE_KINDS, VENDOR_ID, type InvitationKind } from './invitation.js';

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * **AN INVITATION AS THE INVITING DEVICE FILES IT**: everything the service
 * keeps, and the seat's signature over it. Nothing in it opens the offer or
 * accepts the invitation, and nothing in it names, dates, addresses or
 * classifies the person: that is all in the sealed offer. A re-issued seat
 * invitation is filed as a signer's.
 */
export interface InvitationFiling {
  readonly company: string;
  readonly kind: InvitationKind;
  readonly id: Hex;
  readonly acceptanceHash: Hex;
  readonly offer: Sealed;
  /** An employee's or a vendor's invitation: the id of the record it is for, and no other kind's carries one. */
  readonly person?: string;
  /**
   * The epoch of the company key the offer's inbox and seat secret were made under. The service keeps it and judges
   * nothing by it; each member's device refuses an answer sealed to an older inbox than the key in force, unless the
   * change of the key named it as waiting.
   */
  readonly keyEpoch: number;
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
  const allowed = ['company', 'kind', 'id', 'acceptanceHash', 'offer', 'person', 'keyEpoch', 'filedBy'];
  if (Object.keys(f).some((k) => !allowed.includes(k))) return 'it carries something an invitation does not, and nothing unread is kept';
  if (f.company !== company) return 'it is for another company';
  if (!INVITATION_KINDS.includes(f.kind as InvitationKind)) {
    return 'it is none of the four kinds of invitation (an employee, a vendor, a signer or a super admin): make it again as one of them';
  }
  if (!HEX64.test(String(f.id)) || !HEX64.test(String(f.acceptanceHash))) return 'it is not named by a lookup id and an acceptance hash';
  if (!Number.isSafeInteger(f.keyEpoch) || (f.keyEpoch as number) < 0) return 'it does not name the epoch of the company key it was made under';
  const o = f.offer as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || ['iv', 'tag', 'body'].some((k) => typeof o[k] !== 'string')) return 'it carries no sealed offer';
  if (PAYEE_KINDS.includes(f.kind as InvitationKind) ? typeof f.person !== 'string' || f.person === '' : f.person !== undefined) {
    return 'an employee\'s or a vendor\'s invitation names the record it is for, and no other kind\'s does';
  }
  if (f.kind === 'vendor' && !VENDOR_ID.test(String(f.person))) return 'a vendor\'s invitation names a vendor entry\'s id, and this one does not';
  if (f.kind === 'employee' && !EMPLOYEE_ID.test(String(f.person))) return 'an employee\'s invitation names an employee\'s id, and this one does not';
  return null;
};
