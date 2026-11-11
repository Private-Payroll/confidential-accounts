/**
 * **THE ROLES A SEAT OF A COMPANY CAN HOLD, AND WHAT EACH ROLE MAY FILE.**
 *
 * The one list of roles. A signer role (admin, approver, initiator) is held by
 * a seat with a leaf on the company's account. A reader role (limited,
 * accountant) holds no leaf: it signs nothing on the chain and files none of
 * the company's records. Every device judges a filing by what its filer's role
 * may file here; the service judges no role. A role this list does not name
 * files nothing, and no seat is given one (`isRole`).
 */
import { SIGNER_ROLES } from 'midnight-identity/profile/request';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS, type CompanyRecordKind, type WireRecord } from '../midnight/sealed-record-wire.js';
import type { Purpose } from './sealed-records.js';

/** The roles held by a seat with a leaf on the company's account, which signs on the chain: the names a founding is asked with. */
export { SIGNER_ROLES };
/** The roles held by a seat with no leaf, which signs nothing on the chain. */
export const READER_ROLES = Object.freeze(['limited', 'accountant'] as const);

export type SignerRole = (typeof SIGNER_ROLES)[number];
export type ReaderRole = (typeof READER_ROLES)[number];
export type Role = SignerRole | ReaderRole;

/** Every role, signer roles first. */
export const ROLES: readonly Role[] = Object.freeze([...SIGNER_ROLES, ...READER_ROLES]);

/** Whether a value is one of the roles above: anything else is refused wherever a seat would be given it. */
export const isRole = (x: unknown): x is Role => typeof x === 'string' && (ROLES as readonly string[]).includes(x);

/** Whether a value is a signer role: the only roles a seat with a leaf, which a signer invitation makes, is given. */
export const isSignerRole = (x: unknown): x is SignerRole => typeof x === 'string' && (SIGNER_ROLES as readonly string[]).includes(x);

/** Whether `x` names a reader role: one held by a seat with no leaf. */
export const isReaderRole = (x: unknown): x is ReaderRole => typeof x === 'string' && (READER_ROLES as readonly string[]).includes(x);

/** What a signer seat may do with the company's runs on the chain: raise them, approve them, and hold them. */
export interface RunRights {
  readonly mayRaise: boolean;
  readonly mayApprove: boolean;
  readonly mayHold: boolean;
}

/**
 * **WHAT EACH SIGNER ROLE MAY DO WITH RUNS ON THE CHAIN**, which the seat's leaf commits to and every run's proof
 * checks. An admin raises, approves and holds runs; an approver approves and holds runs and raises none; an
 * initiator raises runs and approves none, so its own raise is not an approval. Governance asks for none of these.
 */
export const RIGHTS_PRESET: Readonly<Record<SignerRole, RunRights>> = Object.freeze({
  admin: Object.freeze({ mayRaise: true, mayApprove: true, mayHold: true }),
  approver: Object.freeze({ mayRaise: false, mayApprove: true, mayHold: true }),
  initiator: Object.freeze({ mayRaise: true, mayApprove: false, mayHold: false }),
});

/** Every kind of record a seat files: a company's own, and a vault's. */
export type FiledKind = CompanyRecordKind | WireRecord;

const NOTHING: readonly FiledKind[] = Object.freeze([]);

/**
 * **WHICH KINDS EACH ROLE MAY FILE**, as a member's device judges every filing
 * it reads. A seat with no role set yet is a seated signer whose role the
 * quorum has not named, which is how the founding seat is held: it files what
 * an admin files. A reader role files nothing. A seat that raises runs also
 * files a one-off payment's record (`transfer`), which a one-off is raised
 * over. Every signer role files the read grants (`grants`), since each signer
 * at the seat bar signs a change of them by filing it again with its own
 * signature added. What each signer role may do on the chain is `RIGHTS_PRESET`,
 * above, and which records each reader role may open is `READER_PURPOSES`, below.
 */
export const MAY_FILE: Readonly<Record<Role | 'unset', readonly FiledKind[]>> = Object.freeze({
  admin: Object.freeze([...COMPANY_RECORD_KINDS, ...WIRE_RECORDS]),
  approver: Object.freeze(['proposal', 'grants', ...WIRE_RECORDS] as FiledKind[]),
  initiator: Object.freeze(['run', 'transfer', 'proposal', 'grants', ...WIRE_RECORDS] as FiledKind[]),
  limited: NOTHING,
  accountant: NOTHING,
  unset: Object.freeze([...COMPANY_RECORD_KINDS, ...WIRE_RECORDS]),
});

/**
 * **WHAT ONE SEAT MAY FILE**: what its role gives, and nothing else. A role
 * this list does not name gives nothing, so a seat read with one files nothing
 * rather than stopping the read. Its wallet key being on the committee gives
 * it nothing here: a super admin's power is the committee, and filing runs or
 * anchoring the company's records comes from a signer role alone.
 */
export const mayFile = (seat: { readonly role: Role | null }): readonly FiledKind[] =>
  seat.role === null ? MAY_FILE.unset : isRole(seat.role) ? MAY_FILE[seat.role] : NOTHING;

/**
 * **WHETHER A SEAT MAY INVITE, RE-ISSUE AN INVITATION OR WITHDRAW SOMEBODY
 * WAITING FOR A SEAT**: only a seat whose role may file a proposal. The one
 * rule the signing device, the directory judge and every approving device
 * hold an invitation's signer to; a reader seats and turns away nobody.
 */
export const mayInvite = (seat: { readonly role: Role | null }): boolean => mayFile(seat).includes('proposal');

/**
 * **WHAT EACH READER ROLE READS: THE PURPOSES A READ GRANT TO IT NAMES.** An
 * accountant reads the people, the payroll runs, the signers, the policies and
 * each proposal's kind, summary and standing; a limited seat reads the
 * signers, the policies and each proposal's kind, summary and standing. The
 * `proposals` purpose never opens what a proposal pays, and nothing here opens
 * the company's state: both stay under the company key, which no reader holds.
 */
export const READER_PURPOSES: Readonly<Record<ReaderRole, readonly Purpose[]>> = Object.freeze({
  limited: Object.freeze(['roster', 'policy', 'proposals'] as const),
  accountant: Object.freeze(['people', 'payroll', 'roster', 'policy', 'proposals'] as const),
});

/**
 * The purposes a read grant to a seat of `role` names, the one answer every
 * screen that grants reading asks for. A role that is not a reader role is
 * refused: a signer role holds the company key and is given no grant.
 */
export const grantPurposes = (role: ReaderRole): readonly Purpose[] => {
  if (!isReaderRole(role)) {
    throw new Error(`"${String(role)}" is not a reader role, so no read grant is made for it. A read grant is for one of: ${READER_ROLES.join(', ')}.`);
  }
  return READER_PURPOSES[role];
};
