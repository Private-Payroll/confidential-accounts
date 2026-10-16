/**
 * **A COMPANY'S SEAT DIRECTORY: WHO FILES ITS RECORDS UNDER WHICH KEY, AND
 * WHAT A DEVICE BELIEVES OF IT.**
 *
 * The company's server keeps the directory as it is handed in: for each seat
 * on the company's account, the person who holds it, the key their filings
 * are signed with, the key copies are sealed to, and a role. **The server is
 * assumed to lie**, so nothing in the directory is believed because the server
 * says so:
 *
 *   · **an entry** names its seat, its filing key and its records key in the
 *     open, signed by that filing key. Sealed inside it under the company's
 *     roster key are the seat's wallet key, that wallet's signature over the
 *     entry, and the seat's opening of its own leaf (`SeatProof`). A member's
 *     device opens them and believes an entry only when the wallet's signature
 *     verifies and the opening proves that wallet key for that seat
 *     (`walletKeyProvedBy`): its blinding is the hash of the key under its
 *     salt, and the account's own `signerLeaf` over it is the seat's leaf - the
 *     leaf the signers approved when they seated it. So the account's committee
 *     is never asked who a seat is. Anyone may claim any seat; a device
 *     believes, per seat, the first claim whose proof proves, one claim per
 *     leaf and per filing key ever, and one per person and per records or
 *     wallet key among the seats not retired: a retired seat gives up its
 *     person, wallet and records key, so the same person can be seated again
 *     under a new leaf, while its leaf and filing key stay its own, since its
 *     versions inside its boundary are judged by them.
 *   · **a change to an entry** - a role, or a seat retired with the last
 *     version of each record it filed and the records-key statement its own
 *     wallet signed - is believed on a device when as many
 *     seats as a change of who is seated needs on the account (`seatBarOf`:
 *     the higher of its threshold and the approvals a policy change needs),
 *     read from the chain, signed it. The seat a demotion or a retirement is
 *     about counts like any other, seated still or already removed, and
 *     neither may leave fewer seated signers than that bar, as the chain's
 *     removal by `amendSigner` never does.
 *   · **the super admins are not here.** They are the keys on the account's
 *     committee as the chain holds it, and only the chain says who they are;
 *     nothing in the directory names, gives or takes that role, and no change
 *     here reads the committee. A seat whose wallet key is on the committee is,
 *     to the signers, a signer like any other.
 *   · **a filing** is believed only when it is signed by a seat the directory
 *     believes, whose role may file that kind of record (`filingRefusalOf`). A
 *     version signed by a key whose seat is not seated now is refused, unless a
 *     retirement record signed by a quorum names it within that seat's last
 *     versions.
 *
 * **THE SERVER IS A STORE, AND JUDGES NO SEAT'S IDENTITY, ROLE OR QUORUM.** It
 * holds no roster key, so it never opens an entry's proof: it keeps every
 * entry from a signed-in member for a seat the chain holds now, signed by the
 * filing key it names, as the next version and in its shape, and picks
 * between none (`EntryJudge`). It keeps a role or retirement change in its
 * shape, every signature verifying, signed against at least the approvals a
 * change of who is seated needs on the chain now (`seatBarOf`), as the next
 * version - and counts no quorum and keeps no retirement. So no
 * member's claim and no server can keep a true seat out: each member's device
 * believes the first claim whose proof proves and counts every quorum itself.
 *
 * **THE DIRECTORY IS NEVER A SECOND SOURCE FOR WHO MAY READ A SECRET.** Who a
 * vault's secret is sealed to is decided by the records-key statement each
 * signer's wallet signs and the reader check over it, and by nothing here.
 * The wrapping key an entry names is the same records key, signed by the same
 * wallet in the same press; a device refuses an entry whose wrapping key is
 * not the records key that seat's statement names.
 *
 * Pure, and loads no WebAssembly: the server and the page both import it.
 */
import {
  directoryEntrySignedBy, recordsKeySignedBy, type AccountSeats, type DirectoryEntryStatement, type RecordsKeyStatement,
} from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { canonical, sign, verify, type Hex, type Sealed } from '../core/crypto.js';
import { openSeatProof, sealSeatProof, walletKeyProvedBy, type LeafOf, type SeatOpening, type SeatProof } from '../core/seat-opening.js';
import type { Role } from '../core/types.js';
import { replacedBy, seatInvitationRefusal, type SignedSeatInvitation } from '../core/invitation.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS, type CompanyRecordKind, type WireRecord } from './sealed-record-wire.js';

/* ------------------------------------------------------------------ kinds */

export type { CompanyRecordKind };

/** Every kind of record a seat files: a company's own, and a vault's. */
export type FiledKind = CompanyRecordKind | WireRecord;

/**
 * **WHICH KINDS EACH SIGNER ROLE MAY FILE**, as a member's device judges every
 * filing it reads; the server judges no role. A seat with no role set yet is a
 * seated signer whose role the quorum has not named: it files what a full
 * signer files. A limited seat files nothing.
 */
export const MAY_FILE: Readonly<Record<Role | 'unset', readonly FiledKind[]>> = Object.freeze({
  admin: Object.freeze([...COMPANY_RECORD_KINDS, ...WIRE_RECORDS]),
  approver: Object.freeze(['proposal', ...WIRE_RECORDS] as FiledKind[]),
  initiator: Object.freeze(['run', 'proposal', ...WIRE_RECORDS] as FiledKind[]),
  viewer: Object.freeze([] as FiledKind[]),
  unset: Object.freeze([...COMPANY_RECORD_KINDS, ...WIRE_RECORDS]),
});

/**
 * **WHAT ONE SEAT MAY FILE**: what its signer role gives, and nothing else. The
 * one reading of `MAY_FILE` for a seat. Its wallet key being on the committee
 * gives it nothing here: a super admin's power is the committee, and filing
 * runs or anchoring the company's records comes from a signer role alone.
 */
export const mayFile = (seat: { readonly role: Role | null }): readonly FiledKind[] => MAY_FILE[seat.role ?? 'unset'];

/**
 * **WHETHER A SEAT MAY INVITE, RE-ISSUE AN INVITATION OR WITHDRAW SOMEBODY
 * WAITING FOR A SEAT**: only a seat whose signer role may file a proposal. The
 * one rule the signing device, the directory judge and every approving device
 * hold an invitation's signer to; a viewer seats and turns away nobody.
 */
export const mayInvite = (seat: { readonly role: Role | null }): boolean => mayFile(seat).includes('proposal');

/** The key one record's versions are counted under, in a retirement record's boundary. */
export const vaultRecordKey = (vault: string, record: WireRecord): string => `vault:${vault}:${record}`;
export const companyRecordKey = (kind: CompanyRecordKind, id: string): string => `${kind}:${id}`;

/* ------------------------------------------------------------------ the filings */

/** A committee key, as the chain lists it. */
export interface CommitteeKey { readonly tag: string; readonly value: string }

/** What anyone may read of an entry: the account, the seat, its filing key and its records key. */
export type EntryStatement = Omit<DirectoryEntryStatement, 'signature'>;

/**
 * One seat's entry, as its own device files it: what anyone may read of it,
 * the seat's proof sealed under the company's roster key (`SeatProof`: the
 * wallet key, the wallet's signature over the statement, and the seat's
 * opening of its own leaf), and the filing key's signature over all of it.
 */
export interface DirectoryEntry {
  /** The signed-in person who filed it. The server's attribution, checked against who is signed in; a device does not rest on it. */
  readonly person: string;
  readonly statement: EntryStatement;
  /** The seat's proof, sealed under the company's roster key: only a member's device opens it. */
  readonly proof: Sealed;
  /** The ed25519 signature by the filing key the statement names over the entry (`entryFilingMessage`), 128 lower-case hex characters. */
  readonly signature: Hex;
}

const ENTRY_DOMAIN = 'confidential-accounts/seat-directory-entry/v1';

/** The exact text an entry's filing key signs: the company, the person, the statement and the sealed proof. */
export const entryFilingMessage = (company: string, entry: Pick<DirectoryEntry, 'person' | 'statement' | 'proof'>): string =>
  canonical({ domain: ENTRY_DOMAIN, company, person: entry.person, statement: entry.statement, proof: entry.proof });

/**
 * **THIS SEAT'S OWN ENTRY, MADE ON ITS OWN DEVICE**: the statement its wallet
 * signed with that signature and the wallet key taken out of it, the proof
 * sealed under the company's roster key, and the whole signed by the seat's
 * filing key.
 */
export const directoryEntryMade = (input: {
  readonly company: string;
  readonly person: string;
  readonly committeeKey: CommitteeKey;
  /** The statement the seat's wallet signed. */
  readonly signed: DirectoryEntryStatement;
  readonly opening: SeatOpening;
  /** Who the seat is for, as the seat that invited signed it; absent only for the founding seat. */
  readonly invited?: SignedSeatInvitation;
  readonly signingSecret: Hex;
  readonly viewingKey: Hex;
}): DirectoryEntry => {
  const { signature, ...statement } = input.signed;
  const lower = {
    account: statement.account.toLowerCase(), signingKey: statement.signingKey.toLowerCase(),
    wrappingKey: statement.wrappingKey.toLowerCase(), seat: statement.seat.toLowerCase(),
  };
  const proof = sealSeatProof(input.company, {
    committeeKey: input.committeeKey, signature, opening: input.opening, ...(input.invited === undefined ? {} : { invited: input.invited }),
  }, input.viewingKey);
  const unsigned = { person: input.person, statement: lower, proof };
  return { ...unsigned, signature: sign(entryFilingMessage(input.company, unsigned), input.signingSecret) };
};

/** The keys an entry may have, and a statement's: the service keeps nothing else, so nothing else can be carried in the open. */
const ENTRY_FIELDS = ['person', 'proof', 'signature', 'statement'];
const STATEMENT_FIELDS = ['account', 'seat', 'signingKey', 'wrappingKey'];
const PROOF_FIELDS = ['body', 'iv', 'tag'];
const exactly = (o: object, fields: readonly string[]): boolean => {
  const keys = Object.keys(o).sort();
  return keys.length === fields.length && keys.every((k, i) => k === fields[i]);
};

/**
 * **AN ENTRY IN ITS SHAPE, FOR THIS ACCOUNT, SIGNED BY THE FILING KEY IT
 * NAMES**, or why not: the one rule the server and a member's device both
 * apply to an entry before anything else. Nothing here opens the proof.
 */
export const entryFilingRefusal = (company: string, account: AccountAddress, entry: DirectoryEntry): DirectoryRefusalCode | null => {
  const s = entry?.statement as Partial<EntryStatement> | undefined;
  const p = entry?.proof as Partial<Sealed> | undefined;
  if (typeof entry !== 'object' || entry === null || !exactly(entry, ENTRY_FIELDS) || typeof entry.person !== 'string' || entry.person.length === 0
    || typeof s !== 'object' || s === null || !exactly(s, STATEMENT_FIELDS)
    || ![s.account, s.signingKey, s.wrappingKey, s.seat].every((k) => typeof k === 'string' && HEX64.test(k)) || s.signingKey === s.wrappingKey
    || typeof p !== 'object' || p === null || !exactly(p, PROOF_FIELDS) || ![p.iv, p.tag, p.body].every((x) => typeof x === 'string' && HEX_OR_EMPTY.test(x))
    || typeof entry.signature !== 'string' || !HEX128.test(entry.signature)) return 'not-a-change';
  /* Entered for this company's account and no other: an entry for another account decides nothing here. */
  if (s.account !== String(account).toLowerCase()) return 'entry-not-for-this-account';
  if (!verify(entryFilingMessage(company, entry), entry.signature, s.signingKey as Hex)) return 'entry-not-filed-by-its-key';
  return null;
};

/** One seat's signature over a change, with the filing key it is checked against. */
export interface SeatSignature { readonly publicKey: Hex; readonly signature: Hex }

export type DirectoryChange =
  /** A seat's own entry. Signed by its filing key, its proof by its wallet; no quorum. */
  | { readonly kind: 'claim'; readonly entry: DirectoryEntry }
  /** A seat's role, named by a quorum. */
  | { readonly kind: 'role'; readonly seat: string; readonly role: Role; readonly threshold: number; readonly signatures: readonly SeatSignature[] }
  /**
   * A seat retired by a quorum, with the last version of each record it filed:
   * a version it filed up to that boundary is still believed, anything after
   * is refused. `statement` is the leaving seat's records-key statement exactly
   * as its own wallet signed it, taken from its roster entry when the
   * retirement is raised: once the roster drops the seat, this is where a
   * device reads which records key its versions inside the boundary were
   * sealed with, so they stay readable. A seat no roster entry holds a
   * statement for is retired without one, and then no version it filed is
   * believed, as none was while it was seated: a missing statement never
   * keeps a signer from being removed.
   */
  | {
    readonly kind: 'retire'; readonly seat: string; readonly filedUpTo: Readonly<Record<string, number>>;
    readonly statement?: RecordsKeyStatement;
    readonly threshold: number; readonly signatures: readonly SeatSignature[];
  };
/** A change a quorum of seats signs with their filing keys: a role, or a retirement. */
export type QuorumChange = Extract<DirectoryChange, { kind: 'role' | 'retire' }>;
/** A change signed for one version of the directory: a quorum's role or retirement. */
export type SignedChange = QuorumChange;

/** The seat a quorum's change is about, as a list: empty when the change names none in its shape. */
export const seatsChangedBy = (change: SignedChange): readonly string[] =>
  (typeof change.seat === 'string' ? [change.seat] : []);

/** One version of a company's directory, as it is filed and served. */
export interface DirectoryFiling {
  readonly company: string;
  readonly version: number;
  readonly change: DirectoryChange;
  /**
   * **A QUORUM'S CHANGE FILED AGAIN**: the earlier version its signatures were
   * made over, when the company's records passed that version over - or it
   * rested on a seat one passed over - so its change was never applied. Its
   * signatures still bind that version, so the change is filed again as a new
   * version carrying them unchanged, and is believed only as
   * `refiledRefusalOf` allows. Absent on every other filing.
   */
  readonly signedAt?: number;
}

const QUORUM_DOMAIN = 'confidential-accounts/seat-directory-change/v1';

/** The exact text each seat of a quorum signs for a change: everything but the signatures. */
export const directoryChangeMessage = (company: string, version: number, change: DirectoryChange): string => {
  if (change.kind === 'claim') throw new Error('an entry is signed by its own wallet, not by a quorum.');
  const { signatures: _signed, ...unsigned } = change;
  return canonical({ domain: QUORUM_DOMAIN, company, version, change: unsigned });
};

/* ------------------------------------------------------------------ what is believed */

/** A seat as the directory holds it once its filings are read. */
export interface DirectorySeat {
  readonly seat: string;
  readonly person: string;
  readonly signingKey: Hex;
  readonly wrappingKey: Hex;
  /**
   * The seat's wallet key, as its opening proves it for the seat's leaf, and
   * that opening, from the seat's own entry: set where a member's device opened
   * the entry and believed it. The server never holds either.
   */
  readonly committeeKey?: CommitteeKey;
  readonly opening?: SeatOpening;
  readonly role: Role | null;
  /** Null while the seat is not retired; its last versions once a quorum has retired it. */
  readonly retired: Readonly<Record<string, number>> | null;
  /** Once retired: the records-key statement its own wallet signed, as its retirement carries it. */
  readonly retiredStatement?: RecordsKeyStatement;
}

export interface Directory {
  readonly company: string;
  readonly version: number;
  readonly seats: readonly DirectorySeat[];
}

export const emptyDirectory = (company: string): Directory => ({ company, version: 0, seats: [] });

/** Why a filing or a read of the directory is refused. Each is a sentence a person can act on. */
export const DIRECTORY_REFUSAL = {
  'not-this-company': 'that filing is for another company, so it is not filed here.',
  'not-the-next-version': 'that is not the next version of this company\'s directory. Read the directory again and file the change on what it holds now.',
  'not-your-entry': 'that entry names another person. A seat\'s entry is filed by the person who holds the seat, from their own device.',
  'not-a-member': 'that person is not a member of this company, so they hold no seat to enter.',
  'no-account': 'this company has no account on the chain, so no seat can be entered. Create a new company.',
  'key-not-in-its-leaf': 'that entry is not believed: its seat\'s opening does not show that the seat was made for the wallet key that signed it. Take the seat again on the device that holds it.',
  'entry-not-signed': 'that entry is not signed by the wallet of the seat it names, for this company. Ask your wallet to sign your entry again.',
  'entry-not-for-this-account': 'that entry names another account than this company\'s, so it is not entered here.',
  'entry-not-filed-by-its-key': 'that entry is not signed by the filing key it names, so it is not entered. Enter the seat again from the device that took it.',
  'entry-not-opened': 'that entry\'s wallet key and opening are not sealed under this company\'s key as this device holds it, so it is not believed. Enter the seat again from the device that took it.',
  'seat-not-seated': 'the seat that entry names is not one the company\'s account holds now, so it has no entry.',
  'seat-taken': 'this device already believes an earlier entry for that seat, and believes one entry per seat.',
  'key-taken': 'that filing, records or committee key is already an entry\'s this device believes, and a key belongs to one entry.',
  'person-has-a-seat': 'this device already believes an entry by that person in this company\'s directory.',
  'not-invited': 'that entry carries no invitation a seat of this company signed for it, so it is not believed. A seated signer invites the person again, and their device files its entry again.',
  'invited-someone-else': 'the invitation that entry carries is for another person than the one the entry names, so it is not believed.',
  'inviter-not-seated': 'the invitation that entry carries was not signed by a seat this directory holds and has not retired, so it is not believed. A seated signer invites the person again.',
  'not-the-invitation-it-replaces': 'that entry carries a re-issued invitation that is not the one a seat of this company signed when that seat was proposed, for the same person, name, role and seat, so it is not believed. A seated signer re-issues it again from the proposal that seated it.',
  'inviter-may-not-invite': 'the invitation that entry carries was signed by a seat whose role may not file a proposal, and only such a seat invites anybody, so it is not believed. A seated signer whose role may file one invites the person again.',
  'invited-another-leaf': 'the invitation that entry carries names no seat, or another seat than the one the entry names, so it is not believed. Open the company again on the device that holds the seat: it files the entry with the invitation the proposal that seated it carries.',
  'no-such-seat': 'that change names a seat the directory has no entry for.',
  'seat-retired': 'that seat has been retired, so it cannot be changed or sign a change.',
  'statement-not-the-leavers': 'that retirement does not carry the records-key statement the leaving seat\'s own wallet signed for that seat, so the records it filed could not be read once it leaves. Raise the retirement again with the statement its roster entry holds.',
  'threshold-not-the-chains': 'that change was signed against fewer approvals than a change of who is seated needs on the company\'s account: the higher of its threshold and the approvals a policy change needs. Have it signed again against the chain\'s.',
  'not-signed': 'one of the signatures on that change does not verify. Have the change signed again.',
  'twice-by-one-seat': 'one seat signed that change twice, and a seat counts once.',
  'below-quorum': 'not enough of the company\'s seats signed that change: it needs as many as a change of who is seated needs on the company\'s account, the higher of its threshold and the approvals a policy change needs.',
  'not-a-change': 'that is not a change to a company\'s directory.',
  'leaves-too-few-signers': 'that change would leave fewer seated signers than a change of who is seated needs on the company\'s account - the higher of its threshold and the approvals a policy change needs - and the chain refuses the same. Seat another signer, or lower the threshold or the approvals a policy change needs, first, then sign it again.',
  'signed-at-applied': 'that change is filed again under signatures made for a version of the directory that was applied, or was already filed again, so there is nothing to file again. Read the directory again.',
  'signed-at-not-passed-over': 'that change is filed again under signatures made for a version of the directory the company\'s records did not pass over, and that rests on no seat a passed-over version claimed or changed, so it is not filed again. If the change is still wanted, the seats sign it again as the directory stands now.',
  'reverses-a-later-change': 'that change, filed again, would undo a change to the same seat applied after the version it was signed for, so it is not applied. If it is still wanted, the seats sign it again as the directory stands now.',
  'not-as-the-chain-holds': 'that change, filed again, does not agree with who holds the company\'s account on the chain now: a seat it gives a role is not seated there. It is not applied; if it is still wanted, the seats sign it again as the account stands now.',
} as const;
export type DirectoryRefusalCode = keyof typeof DIRECTORY_REFUSAL;

export class DirectoryRefused extends Error {
  constructor(readonly code: DirectoryRefusalCode) {
    super(DIRECTORY_REFUSAL[code]);
    this.name = 'DirectoryRefused';
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const HEX_OR_EMPTY = /^(?:[0-9a-f]{2})*$/u;

/** What the chain says about the company's account, as the checker read it. */
export interface ChainHolders {
  /** The committee the account lists, and every seat it holds now. */
  readonly seats: AccountSeats;
  /** The approvals the account requires. */
  readonly approvals: number;
  /** The approvals a change of who is seated needs on the account (`seatBarOf`). */
  readonly seatBar: number;
}

/**
 * **WHO IS JUDGING AN ENTRY, AND SO HOW.**
 *   · `AT_THE_SERVER`: the company's server, which holds no roster key. It
 *     keeps every entry on `entryFilingRefusal` and the seat checks alone,
 *     never opens its proof, so it learns no seat's wallet key, and picks
 *     between no two entries for one seat; it counts no quorum.
 *   · a member's device: opens each entry's proof with the company's viewing
 *     key (`proofOf`) and believes the entry only when the wallet's signature
 *     verifies and the opening proves that key for the seat, against `leafOf`
 *     - what this device's vault worker made of each opening with the
 *     account's own `signerLeaf`.
 */
export type EntryJudge =
  | { readonly by: 'the-server' }
  | {
    readonly by: 'a-member'; readonly proofOf: (entry: DirectoryEntry) => SeatProof | null; readonly leafOf: LeafOf;
    /** The seat the account's deploy seated, as the person's own wallet read it: the one entry believed without an invitation. */
    readonly founding: string | null;
  };

export const AT_THE_SERVER: EntryJudge = Object.freeze({ by: 'the-server' });

/**
 * **EVERY ENTRY'S PROOF, OPENED WITH THE COMPANY'S VIEWING KEY**, each once:
 * null for one that does not open under it or is not one in its shape.
 */
export const proofsOpenedWith = (company: string, viewingKey: Hex): ((entry: DirectoryEntry) => SeatProof | null) => {
  const opened = new WeakMap<object, SeatProof | null>();
  return (entry) => {
    const sealed = entry?.proof;
    if (typeof sealed !== 'object' || sealed === null) return null;
    if (!opened.has(sealed)) opened.set(sealed, openSeatProof(company, sealed, viewingKey));
    return opened.get(sealed) ?? null;
  };
};

/**
 * A member's device's judge: each entry's proof as `proofOf` opens it, checked
 * against `leafOf`, and every entry but the founding seat's (`founding`, the
 * seat the account's deploy seated as the person's own wallet read it) held to
 * the invitation it carries.
 */
export const asAMember = (proofOf: (entry: DirectoryEntry) => SeatProof | null, leafOf: LeafOf, founding: string | null): EntryJudge =>
  ({ by: 'a-member', proofOf, leafOf, founding: typeof founding === 'string' ? founding.toLowerCase() : null });

/**
 * **WHY A MEMBER'S DEVICE DOES NOT BELIEVE THE INVITATION AN ENTRY CARRIES**,
 * or null when it does: signed by the filing key of a seat `dir` holds and has
 * not retired and whose role may invite (`mayInvite`), for this company,
 * naming the entry's person and the entry's seat; a re-issue only as exactly
 * the invitation it replaces, signed by a seat it holds (`replacedBy`). Every invitation an entry carries names its leaf, so one person's
 * invitation seats one leaf and no other seat can be entered under it. The
 * founding seat needs none.
 */
const invitationRefusalOf = (
  dir: Directory, entry: DirectoryEntry, proof: SeatProof, founding: string | null,
): DirectoryRefusalCode | null => {
  if (founding !== null && entry.statement.seat.toLowerCase() === founding) return null;
  const invited = proof.invited;
  if (invited === undefined || seatInvitationRefusal(invited) !== null || invited.terms.company !== dir.company) return 'not-invited';
  if (invited.terms.person !== entry.person) return 'invited-someone-else';
  if (invited.terms.leaf === undefined || invited.terms.leaf.toLowerCase() !== entry.statement.seat.toLowerCase()) return 'invited-another-leaf';
  const inviter = dir.seats.find((x) => x.signingKey.toLowerCase() === invited.signedBy.toLowerCase());
  if (inviter === undefined || inviter.retired !== null) return 'inviter-not-seated';
  if (!mayInvite(inviter)) return 'inviter-may-not-invite';
  /*
   * A re-issue gives the seat nothing the invitation it replaces did not: that one must verify over the same person,
   * name, role and seat, signed by a seat this directory holds - retired or not, since its leaving is why it was
   * re-issued - whose role may invite.
   */
  const original = replacedBy(invited);
  if (original === null) return null;
  const first = seatInvitationRefusal(original) === null
    ? dir.seats.find((x) => x.signingKey.toLowerCase() === original.signedBy.toLowerCase()) : undefined;
  return first !== undefined && mayInvite(first) ? null : 'not-the-invitation-it-replaces';
};

const sameKey = (a: CommitteeKey, b: CommitteeKey): boolean =>
  a.tag === b.tag && a.value.toLowerCase() === b.value.toLowerCase();

/**
 * **A MEMBER'S DEVICE: THE WALLET KEY AN ENTRY'S PROOF PROVES FOR ITS SEAT**,
 * or why it does not: the proof opens under the company's key, the wallet's
 * signature over the statement verifies under the wallet key it names, and
 * the opening proves that key for the seat against `leafOf`. Never throws.
 */
export const proofRefusalOf = (
  label: CompanyLabel, account: AccountAddress, entry: DirectoryEntry, judge: Extract<EntryJudge, { by: 'a-member' }>,
): { readonly proof: SeatProof } | DirectoryRefusalCode => {
  const proof = judge.proofOf(entry);
  if (proof === null) return 'entry-not-opened';
  if (!directoryEntrySignedBy(label, account, proof.committeeKey, { ...entry.statement, signature: proof.signature })) return 'entry-not-signed';
  const proved = walletKeyProvedBy(proof.opening, entry.statement.seat, judge.leafOf);
  if (proved === null || !sameKey(proved, proof.committeeKey)) return 'key-not-in-its-leaf';
  return { proof };
};

/**
 * Whether every signature on a quorum's change is in its shape, verifies under
 * the key it names over the version it was signed for, and names a key once:
 * what anyone can check of a change, the server included. Who the keys are is
 * not asked here.
 */
const signaturesRefusal = (company: string, change: QuorumChange, version: number): DirectoryRefusalCode | null => {
  if (!Array.isArray(change.signatures)) return 'not-a-change';
  const message = directoryChangeMessage(company, version, change);
  const seen = new Set<string>();
  for (const sig of change.signatures) {
    if (typeof sig?.publicKey !== 'string' || !HEX64.test(sig.publicKey) || typeof sig.signature !== 'string' || !HEX128.test(sig.signature)) return 'not-a-change';
    if (!verify(message, sig.signature, sig.publicKey)) return 'not-signed';
    if (seen.has(sig.publicKey)) return 'twice-by-one-seat';
    seen.add(sig.publicKey);
  }
  return null;
};

/** A member's device: how many distinct seats it believes, not retired, signed a change whose signatures all verify. */
const quorumOf = (dir: Directory, change: QuorumChange, version: number, counts: (seat: DirectorySeat) => boolean): number | DirectoryRefusalCode => {
  const bad = signaturesRefusal(dir.company, change, version);
  if (bad !== null) return bad;
  /* One wallet is one vote: two entries under one committee key count once. */
  const wallets = new Set<string>();
  let n = 0;
  for (const sig of change.signatures) {
    const seat = dir.seats.find((x) => x.signingKey === sig.publicKey);
    const wallet = seat === undefined ? '' : seat.committeeKey === undefined ? `filing:${seat.signingKey}`
      : `${seat.committeeKey.tag}:${seat.committeeKey.value.toLowerCase()}`;
    if (seat !== undefined && seat.retired === null && counts(seat) && !wallets.has(wallet)) { wallets.add(wallet); n += 1; }
  }
  return n;
};

const ROLES: readonly Role[] = ['admin', 'approver', 'initiator', 'viewer'];

/** Whether a read of who holds the account carries a seat bar the chain could hold: a whole number, at least one. */
const barReadable = (held: { readonly seatBar?: number }): boolean => Number.isSafeInteger(held.seatBar) && (held.seatBar as number) >= 1;

const STATEMENT_KEYS = ['recordsKey', 'seat', 'signature'];
/** Whether a retirement's statement is a records-key statement in its shape, for the seat it retires. Signatures are not checked here. */
const statementShapedFor = (statement: unknown, seat: string): boolean => {
  const st = statement as Partial<RecordsKeyStatement> | null | undefined;
  return typeof st === 'object' && st !== null && exactly(st, STATEMENT_KEYS)
    && typeof st.recordsKey === 'string' && HEX64.test(st.recordsKey) && st.seat === seat
    && typeof st.signature === 'string' && HEX128.test(st.signature);
};

/**
 * **ONE FILING, APPLIED TO THE DIRECTORY AS IT STANDS, OR REFUSED.**
 *
 * Filed (`chain` given): the server's check before it files, against its own
 * read of the chain now. An entry must be in its shape, for this account,
 * signed by the filing key it names, and its seat seated; it is kept beside
 * every other entry for that seat. A quorum's change must be in its shape,
 * every signature verifying, signed against at least the approvals a change of
 * who is seated needs on the chain now: the server counts no quorum and keeps
 * no role or retirement, which each member's device judges as it replays. `who` is the signed-in person filing
 * and the company's members: an entry names its filer, who must be a member.
 *
 * Replayed (`chain` null): reading back every filing. An entry is judged as
 * `judge` says (`EntryJudge`): on a member's device, its proof is opened and
 * must prove its wallet key for its seat and, for every seat but the founding
 * one, carry the invitation a seat it holds signed for its person and its seat
 * (`invitationRefusalOf`), which gives it its role, and it is believed only as the first such entry for
 * its seat and for its keys. With `now`, a change must
 * name at least the approvals a change of who is seated needs now, and its
 * quorum is counted against that bar, over seats not retired that are seated
 * now, one per wallet, and it may leave no fewer seated and not retired than
 * that bar; a retirement's records-key statement, where it carries one, must be
 * the leaving seat's, signed by the wallet its entry proved; without
 * it, against the threshold the change names. Whether a seat is held NOW is
 * asked of each filing when it is read (`filingRefusalOf`), because a seat retired
 * later was seated when it filed.
 */
export const applyFiling = (
  dir: Directory, filing: DirectoryFiling,
  ctx: {
    readonly label: CompanyLabel;
    /** The company's account, as the one applying the filing holds it: an entry signed for any other is refused. */
    readonly account: AccountAddress;
    readonly chain: ChainHolders | null;
    readonly who?: { readonly person: string; readonly members: readonly string[] };
    /**
     * Replayed only: the chain as this device's own wallet read it for this read. A change is then believed only
     * when it names at least the approvals a change of who is seated needs now, counting only seats seated now whose
     * entry was believed, so a change the server stored under a lower threshold, signed by seats that have left, or
     * signed by an entry the server made up, is not believed.
     */
    readonly now?: AccountHeld;
    /**
     * Replayed only, for a version the company's records anchor: who held the account as the anchor call that first
     * anchored it ran - the approvals it required and the seats its signer tree held, both checked by that call, and
     * the approvals a change of who is seated needed in the state the block that call landed in left. A change is then
     * believed only when it names at least that bar, counting only seats that tree held. Nothing of the account now
     * enters into it.
     */
    readonly anchored?: AccountHeld;
    /** Who is judging each entry: the server, which never opens its proof, or a member's device, which must. */
    readonly judge: EntryJudge;
  },
): Directory => {
  if (typeof filing !== 'object' || filing === null || typeof filing.change !== 'object' || filing.change === null) {
    throw new DirectoryRefused('not-a-change');
  }
  if (filing.company !== dir.company) throw new DirectoryRefused('not-this-company');
  if (filing.version !== dir.version + 1) throw new DirectoryRefused('not-the-next-version');
  const change = filing.change;
  /* A change filed again names an earlier version, and only a quorum's change carries one: an entry names no version. */
  if (filing.signedAt !== undefined && (change.kind === 'claim' || !Number.isSafeInteger(filing.signedAt)
    || filing.signedAt < 1 || filing.signedAt >= filing.version)) throw new DirectoryRefused('not-a-change');
  if (change.kind === 'claim') {
    const entry = change.entry;
    const filed = entryFilingRefusal(dir.company, ctx.account, entry);
    if (filed !== null) throw new DirectoryRefused(filed);
    if (ctx.who !== undefined) {
      if (entry.person !== ctx.who.person) throw new DirectoryRefused('not-your-entry');
      if (!ctx.who.members.includes(entry.person)) throw new DirectoryRefused('not-a-member');
    }
    const s = entry.statement;
    if (ctx.chain !== null && !ctx.chain.seats.seats.includes(s.seat)) throw new DirectoryRefused('seat-not-seated');
    /*
     * Only a member's device opens the proof and picks between entries: the first whose proof proves holds the seat.
     * The server keeps every entry on what it can read, so no entry filed first can keep the seat's own out.
     */
    let proof: SeatProof | undefined;
    if (ctx.judge.by === 'a-member') {
      const proved = proofRefusalOf(ctx.label, ctx.account, entry, ctx.judge);
      if (typeof proved === 'string') throw new DirectoryRefused(proved);
      proof = proved.proof;
      /* A seat goes to the person a seat of this company invited: every entry but the founding seat's carries that invitation. */
      const uninvited = invitationRefusalOf(dir, entry, proof, ctx.judge.founding);
      if (uninvited !== null) throw new DirectoryRefused(uninvited);
      /*
       * A retired seat holds no person, wallet or records key any more: who left can be seated again under a new leaf.
       * Its leaf and its filing key stay its own for good, since its versions inside its boundary are judged by them,
       * and a leaf the chain has not removed yet must never be entered again as a seat not retired.
       */
      const holding = dir.seats.filter((x) => x.retired === null);
      if (dir.seats.some((x) => x.seat === s.seat)) throw new DirectoryRefused('seat-taken');
      const p = proof;
      if (dir.seats.some((x) => x.signingKey === s.signingKey || x.signingKey === s.wrappingKey)
        || holding.some((x) => x.wrappingKey === s.signingKey || x.wrappingKey === s.wrappingKey)
        /* One wallet holds one seat: a second entry whose proof names a wallet key another entry's proves is refused. */
        || holding.some((x) => x.committeeKey !== undefined && sameKey(x.committeeKey, p.committeeKey))) {
        throw new DirectoryRefused('key-taken');
      }
      if (holding.some((x) => x.person === entry.person)) throw new DirectoryRefused('person-has-a-seat');
    }
    return {
      ...dir, version: filing.version,
      seats: [...dir.seats, {
        /* Entered at the role its invitation gives, which a quorum's role change may change later; the founding seat's is unset. */
        seat: s.seat, person: entry.person, signingKey: s.signingKey as Hex, wrappingKey: s.wrappingKey as Hex, role: proof?.invited?.terms.role ?? null, retired: null,
        ...(proof === undefined ? {} : {
          committeeKey: { tag: proof.committeeKey.tag, value: proof.committeeKey.value.toLowerCase() },
          opening: Object.freeze({ ...proof.opening, walletKey: Object.freeze({ ...proof.opening.walletKey }) }),
        }),
      }],
    };
  }
  if (change.kind !== 'role' && change.kind !== 'retire') throw new DirectoryRefused('not-a-change');
  /*
   * The server keeps no role and no retirement, and counts no quorum: it checks what anyone can of the change - its
   * shape, every signature, and the chain's seat bar now - so neither it nor a member can stop a true change.
   */
  const atTheServer = ctx.judge.by === 'the-server';
  const target = dir.seats.find((x) => x.seat === change.seat);
  if (!atTheServer && target === undefined) throw new DirectoryRefused('no-such-seat');
  if (!atTheServer && target!.retired !== null) throw new DirectoryRefused('seat-retired');
  if (typeof change.seat !== 'string' || !HEX64.test(change.seat)) throw new DirectoryRefused('not-a-change');
  if (!Number.isSafeInteger(change.threshold) || change.threshold < 1) throw new DirectoryRefused('not-a-change');
  const now = ctx.now;
  const anchored = ctx.anchored;
  const against = anchored ?? now;
  /*
   * The approvals a change of who is seated needs, from the chain's read, the account as the change was anchored, or the
   * account now, in that order: the same bar the chain holds a removal by `amendSigner` to. A read without it is
   * refused, never taken as no bar, since a change judged against none would pass below the chain's.
   */
  const heldBy = ctx.chain ?? against;
  if (heldBy !== undefined && !barReadable(heldBy)) {
    throw new Error('who holds the company\'s account was read without the approvals a change of who is seated needs, so no '
      + 'change to its directory is judged. Reload the page.');
  }
  const bar = heldBy?.seatBar;
  if (bar !== undefined && change.threshold < bar && (ctx.chain !== null || !atTheServer)) throw new DirectoryRefused('threshold-not-the-chains');
  if (change.kind === 'role' && !ROLES.includes(change.role)) throw new DirectoryRefused('not-a-change');
  if (change.kind === 'retire' && (typeof change.filedUpTo !== 'object' || change.filedUpTo === null
    || !Object.values(change.filedUpTo).every((v) => Number.isSafeInteger(v) && v >= 0))) throw new DirectoryRefused('not-a-change');
  if (change.kind === 'retire' && change.statement !== undefined && !statementShapedFor(change.statement, change.seat)) {
    throw new DirectoryRefused('statement-not-the-leavers');
  }
  if (atTheServer) {
    const bad = signaturesRefusal(dir.company, change, filing.signedAt ?? filing.version);
    if (bad !== null) throw new DirectoryRefused(bad);
    return { ...dir, version: filing.version };
  }
  /*
   * The statement a retirement carries is believed only as the leaving seat's own wallet signed it, under the wallet
   * key its entry's opening proved, naming the records key its entry wraps to: no quorum can put another records key
   * in its place, and a stale statement the same wallet once signed would leave the leaver's versions unread for good.
   * A retirement carrying none retires the seat with no statement, so nothing it filed is read as sealed by it.
   */
  if (change.kind === 'retire' && change.statement !== undefined && (target!.committeeKey === undefined || change.statement.recordsKey !== target!.wrappingKey
    || !recordsKeySignedBy(ctx.label, ctx.account, target!.committeeKey, change.statement))) {
    throw new DirectoryRefused('statement-not-the-leavers');
  }
  const chain = ctx.chain;
  /*
   * The seat a demotion or retirement is about counts like any other, whether it is still seated or the chain has
   * already removed it, as the chain counted its approval of its own removal; no other seat off the account counts.
   */
  const held = (x: DirectorySeat): boolean => x.seat === change.seat || (chain !== null ? chain.seats.seats.includes(x.seat)
    : anchored !== undefined ? anchored.seats.includes(x.seat)
      : now === undefined || now.seats.includes(x.seat));
  /*
   * The chain's removal by `amendSigner` never leaves fewer seated than the
   * approvals a change of who is seated needs, since the account could then
   * never approve again; a directory that retired the seat anyway would hold a
   * company the chain does not. The bar, not the threshold the change was
   * signed at, is what the chain checks.
   */
  const seated = chain !== null ? chain.seats.seats : anchored !== undefined ? anchored.seats : now !== undefined ? now.seats
    : dir.seats.filter((x) => x.retired === null).map((x) => x.seat);
  /*
   * Staying means seated and not retired: a seat this directory has retired, whose removal the chain has not carried
   * out yet, is leaving all the same, so it does not hold a second retirement up.
   */
  const retiredHere = (seat: string): boolean => dir.seats.some((x) => x.seat === seat && x.retired !== null);
  const staying = seated.filter((x) => !retiredHere(x) && (change.kind !== 'retire' || x !== change.seat));
  if (staying.length < (bar ?? change.threshold)) throw new DirectoryRefused('leaves-too-few-signers');
  const n = quorumOf(dir, change, filing.signedAt ?? filing.version, held);
  if (typeof n === 'string') throw new DirectoryRefused(n);
  if (n < Math.max(change.threshold, bar ?? 0)) throw new DirectoryRefused('below-quorum');
  return {
    ...dir, version: filing.version,
    seats: dir.seats.map((x) => (x !== target ? x : change.kind === 'role'
      ? { ...x, role: change.role }
      : { ...x, retired: Object.freeze({ ...change.filedUpTo }),
        ...(change.statement === undefined ? {} : { retiredStatement: Object.freeze({ ...change.statement }) }) })),
  };
};

/**
 * Who held the company's account, as the signers' rules count it: the
 * approvals it required and its seats. Read now from the person's own wallet;
 * for a version the company's records anchor, the approvals and seats the
 * anchor call that first anchored it checked. The account's committee is the
 * super admins' and is not part of it.
 */
export interface AccountHeld {
  readonly approvals: number;
  readonly seats: readonly string[];
  /**
   * The approvals a change of who is seated needed on the account then: the
   * higher of its threshold and the approvals a policy change needs
   * (`seatBarOf`). A demotion or retirement is held to it, as the chain holds a
   * removal by `amendSigner` to it.
   */
  readonly seatBar: number;
}

/**
 * **THE DIRECTORY A DEVICE BELIEVES**, replayed from every filing the server
 * served. Versions must run 1, 2, 3 without a gap. **An entry whose signature
 * does not verify is left out, not fatal**: it is a seat this device does not
 * believe, and a filing signed by its key is refused when it is read. On a
 * member's device, an entry whose proof does not open, or whose opening does
 * not prove its wallet key for its seat, is left out the same way, and so is a
 * change a quorum did not sign. Whether a seat is seated now is asked of every
 * filing as it is read, against this device's own wallet's read of the chain
 * (`filingRefusalOf`).
 *
 * **A VERSION THE COMPANY'S RECORDS ANCHOR IS COUNTED AGAINST WHO HELD THE
 * ACCOUNT WHEN IT WAS ANCHORED**, never against who holds it now: `asAnchored`
 * gives, for such a version, the approvals and seats the anchor call that
 * first anchored it checked as it ran, and the seat bar of the state its block
 * left. A role or retirement change needs that bar of those seats, whatever
 * their wallet keys. So a signer of the change who leaves later, or a
 * threshold that rises later, changes nothing about it. Null there means the
 * version may be anchored and who held the account then is not known, and the
 * filing is not believed. A version not yet anchored is counted against `now`:
 * the approvals a change of who is seated needs now, signed by that many seats
 * seated now.
 */
export const believedDirectory = (
  company: string, filings: readonly DirectoryFiling[], label: CompanyLabel, account: AccountAddress,
  judge: EntryJudge,
  now?: AccountHeld,
  asAnchored?: (version: number) => AccountHeld | null | undefined,
): Directory => directoryReplayed(company, filings, label, account, judge, now, asAnchored).dir;

/**
 * What a replay of the directory keeps, to judge a quorum's change filed again
 * (`refiledRefusalOf`): which versions were applied, which the company's
 * records passed over, and the latest version each seat was changed at.
 */
export interface DirectoryReplay {
  readonly filings: readonly DirectoryFiling[];
  /** Every version whose change was applied: by its own version, and a change filed again by the version it was signed for too. */
  readonly applied: ReadonlySet<number>;
  /** Every version the company's records passed over (never entered while a later one was anchored), or past a header not checked. */
  readonly passed: ReadonlySet<number>;
  /** Per seat, the latest version a role or retirement applied to it was signed for. */
  readonly changed: ReadonlyMap<string, number>;
}

/** The directory as replayed, every version not applied with why, and what the replay kept. */
export interface DirectoryReplayed {
  readonly dir: Directory;
  readonly refused: ReadonlyMap<number, DirectoryRefusalCode>;
  readonly replay: DirectoryReplay;
}

/** The seats a filing claims or changes. */
const seatsOf = (f: DirectoryFiling | undefined): readonly string[] => {
  const c = f?.change;
  if (c === undefined || c === null || typeof c !== 'object') return [];
  if (c.kind === 'claim') return typeof c.entry?.statement?.seat === 'string' ? [c.entry.statement.seat] : [];
  return seatsChangedBy(c);
};

/**
 * **WHETHER A QUORUM'S CHANGE FILED AGAIN IS BELIEVED, AFTER `replay`**, or why
 * not. Its signatures bind the version it was signed for (`signedAt`), checked
 * as any change's by `applyFiling`; on top of that, it is believed only when:
 *   · that version's change was not applied, nor filed again and applied before;
 *   · that version was passed over by the company's records, or rests on one
 *     that was - it changes a seat, or is signed by a seat's key, that a
 *     passed-over version below it claimed or changed;
 *   · no role or retirement of the same seat was applied for a later version -
 *     so one seat's changes are filed again in the order they were first
 *     filed, and a change to another seat never holds it back;
 *   · with `now`, who holds the account on chain now - given while the change
 *     filed again is not yet anchored, never after, since an anchored version is
 *     counted against who held the account as it was anchored: it is signed
 *     against at least the approvals a change of who is seated needs now (as the
 *     service files it), and a seat it gives a role is seated there. A
 *     retirement is believed whether its seat is still seated or already off
 *     the chain: the chain may remove the seat before or after its retirement
 *     is filed, and the retirement is the same either way.
 */
export const refiledRefusalOf = (
  replay: DirectoryReplay, filing: DirectoryFiling, now?: AccountHeld,
): DirectoryRefusalCode | null => {
  const v = filing.signedAt;
  const change = filing.change;
  if (v === undefined) return null;
  if ((change?.kind !== 'role' && change?.kind !== 'retire') || !Number.isSafeInteger(v) || v < 1 || v >= filing.version) return 'not-a-change';
  if (replay.applied.has(v)) return 'signed-at-applied';
  const named = seatsChangedBy(change);
  if (!replay.passed.has(v)) {
    const signers = new Set((!Array.isArray(change.signatures) ? [] : change.signatures)
      .map((x) => String(x?.publicKey).toLowerCase()));
    const restsOnOne = [...replay.passed].some((p) => p < v && (seatsOf(replay.filings[p - 1]).some((x) => named.includes(x))
      || (replay.filings[p - 1]?.change.kind === 'claim'
        && signers.has(String((replay.filings[p - 1]!.change as { entry: DirectoryEntry }).entry.statement.signingKey).toLowerCase()))));
    if (!restsOnOne) return 'signed-at-not-passed-over';
  }
  if ((replay.changed.get(change.seat) ?? 0) > v) return 'reverses-a-later-change';
  if (now !== undefined && !barReadable(now)) {
    throw new Error('who holds the company\'s account was read without the approvals a change of who is seated needs, so no '
      + 'change filed again is judged. Reload the page.');
  }
  if (now !== undefined && change.threshold < now.seatBar) return 'threshold-not-the-chains';
  if (now !== undefined && change.kind === 'role' && !now.seats.includes(change.seat)) return 'not-as-the-chain-holds';
  return null;
};

/**
 * **THE DIRECTORY REPLAYED**, as `believedDirectory` describes it, with every
 * version not applied and why, and what the replay kept. A quorum's change
 * filed again (`signedAt`) is believed only as `refiledRefusalOf` allows, the
 * chain now being `now`'s seats where it is given. Each entry is judged as
 * `judge` says: on a member's device its proof is opened and checked, and the
 * server keeps it on what it can read (`EntryJudge`). The one replay a device
 * and this product's server both make.
 */
export const directoryReplayed = (
  company: string, filings: readonly DirectoryFiling[], label: CompanyLabel, account: AccountAddress,
  judge: EntryJudge,
  now?: AccountHeld,
  asAnchored?: (version: number) => AccountHeld | null | undefined,
): DirectoryReplayed => {
  let dir = emptyDirectory(company);
  const refused = new Map<number, DirectoryRefusalCode>();
  const applied = new Set<number>();
  const passed = new Set<number>();
  const changed = new Map<string, number>();
  filings.forEach((f, i) => {
    if (f?.version !== i + 1) throw new DirectoryRefused('not-the-next-version');
    try {
      const held = asAnchored?.(f.version);
      if (held === null) {
        passed.add(f.version);
        throw new DirectoryRefused('below-quorum');
      }
      /* Who holds the account now judges a change filed again only until it is anchored. */
      const again = refiledRefusalOf({ filings, applied, passed, changed }, f, held === undefined ? now : undefined);
      if (again !== null) throw new DirectoryRefused(again);
      dir = applyFiling(dir, f, {
        label, account, chain: null, judge,
        ...(held !== undefined ? { anchored: held } : now === undefined ? {} : { now }),
      });
      applied.add(f.version);
      const at = f.signedAt ?? f.version;
      if (f.signedAt !== undefined) applied.add(f.signedAt);
      if (f.change.kind === 'role' || f.change.kind === 'retire') changed.set(f.change.seat, Math.max(changed.get(f.change.seat) ?? 0, at));
    } catch (e) {
      if (!(e instanceof DirectoryRefused)) throw e;
      refused.set(f.version, e.code);
      dir = { ...dir, version: f.version };
    }
  });
  return { dir, refused, replay: { filings, applied, passed, changed } };
};

/** Why a device does not believe a filing signed by `publicKey`, or null when it does. */
export type FilingRefusal = 'no-entry' | 'no-account' | 'seat-not-seated' | 'role-may-not-file' | 'past-its-boundary';

export const FILING_REFUSAL: Readonly<Record<FilingRefusal, string>> = Object.freeze({
  'no-entry': 'it is signed by a key that has no entry in the company\'s directory that this device believes',
  'no-account': 'it is signed by a seat of a company whose account on the chain could not be read, so whether the account holds that seat is not known',
  'seat-not-seated': 'it is signed by a seat the company\'s account no longer holds, and no retirement names it',
  'role-may-not-file': 'it is signed by a seat whose role may not file this kind of record',
  'past-its-boundary': 'it is signed by a retired seat, and is later than the last version that seat filed before it left',
});

/** A retired seat's version is believed only up to the last it filed of that record before it left. */
const withinItsBoundary = (seat: DirectorySeat, recordKey: string, version: number): boolean => {
  const last = seat.retired?.[recordKey];
  return last !== undefined && version <= last;
};

/**
 * **WHETHER A MEMBER'S DEVICE BELIEVES A FILING**: a version signed by
 * `publicKey` of the record counted under `recordKey`, of kind `kind`, at
 * `version`. The seat's role must file that kind (`mayFile`). `chain` is what
 * this device's own wallet read off the chain for this read: a seat not
 * retired is believed only while its seat is seated - its wallet key was
 * proved for that seat by its entry's opening when the entry was believed; a
 * retired seat only within its boundary.
 */
export const filingRefusalOf = (
  dir: Directory, chain: AccountSeats, publicKey: Hex, kind: FiledKind, recordKey: string, version: number,
): FilingRefusal | null => {
  const seat = dir.seats.find((x) => x.signingKey === publicKey.toLowerCase());
  if (seat === undefined) return 'no-entry';
  if (!mayFile(seat).includes(kind)) return 'role-may-not-file';
  if (seat.retired !== null) return withinItsBoundary(seat, recordKey, version) ? null : 'past-its-boundary';
  return notOnTheChainNow(seat, chain);
};

/**
 * Whether the chain, read now, holds `seat`: one rule for a device and the
 * server. Who the seat is - its wallet key - was proved on a member's device by
 * its entry's opening against its leaf when the entry was believed, so the
 * account's committee, which holds only the super admins' keys, is not asked.
 */
export const notOnTheChainNow = (seat: DirectorySeat, chain: AccountSeats): 'seat-not-seated' | null =>
  (chain.seats.includes(seat.seat) ? null : 'seat-not-seated');

/*
 * **THE SERVER'S HALF: A STORE, JUDGING NO ROLE AND NO RETIREMENT.** What the
 * server asks before it keeps a filing: an entry kept for the key that signed
 * it, for a seat the chain holds now. The server keeps every entry for a seat
 * and no retirement, so it asks the chain alone whether a seat is held. Which
 * kinds a role may file, and a retired seat's boundary, are each member's
 * device's to judge as it reads (`filingRefusalOf`); the server keeps what a
 * seat signs.
 */

/** Why the server does not keep a filing: never the role or a retirement, which it does not judge. */
export type ServerSeatRefusal = Exclude<FilingRefusal, 'role-may-not-file' | 'past-its-boundary'>;

/** Of `entries`, one for a seat the chain holds now, or why none: the server's one reading of a seat. */
const heldNow = (entries: readonly DirectorySeat[], chain: AccountSeats | null): DirectorySeat | ServerSeatRefusal => {
  if (entries.length === 0) return 'no-entry';
  if (chain === null) return 'no-account';
  return entries.find((x) => notOnTheChainNow(x, chain) === null) ?? 'seat-not-seated';
};

/**
 * **THE SEAT THE SIGNED-IN PERSON FILES UNDER, ON THE SERVER**: an entry that
 * person filed under the key `publicKey`, for a seat the chain holds now, or
 * why not. `dir` is the directory as the server keeps it, every entry for a
 * seat beside the others, and `chain` the server's read of the chain now, null
 * when the company has no account on a chain the server can read. Asked by
 * person and key together, so a person who entered a seat again under a new
 * key files under either, and never under another's.
 */
export const filerSeatOf = (
  dir: Directory, chain: AccountSeats | null, person: string, publicKey: Hex,
): DirectorySeat | ServerSeatRefusal =>
  heldNow(dir.seats.filter((x) => x.person === person && x.signingKey === publicKey.toLowerCase()), chain);

/**
 * **THE SEAT THAT SIGNED SOMETHING, ON THE SERVER, WHOEVER HANDS IT IN**: an
 * entry kept for the key that signed it, for a seat the chain holds now - and
 * never who is signed in to hand it in. A device that kept another seat's
 * signed entry files it again this way.
 */
export const signerSeatOf = (dir: Directory, chain: AccountSeats | null, publicKey: Hex): DirectorySeat | ServerSeatRefusal =>
  heldNow(dir.seats.filter((x) => x.signingKey === publicKey.toLowerCase()), chain);

/**
 * **THE SEAT THAT SIGNED A VERSION OF A RECORD, IN ONE DIRECTORY**: an entry
 * kept for the key that signed it. What the chain says of the seat is not
 * asked here: `signerSeatOf` asks it of the chain now, and a version judged as
 * the directory stood when it was anchored is judged against the holders that
 * batch names, and within a retired seat's boundary, by each device.
 */
export const filerSeatIn = (dir: Directory, publicKey: Hex): DirectorySeat | ServerSeatRefusal =>
  dir.seats.find((x) => x.signingKey === publicKey.toLowerCase()) ?? 'no-entry';

/**
 * **THE SEATS WHOSE WRAPPING KEY IS NOT THE RECORDS KEY THEIR OWN WALLET
 * ATTESTED.** Every seat in the directory is checked, not only those a
 * statement is held for. `attested` is every records-key statement this device
 * holds from the roster; a retired seat is judged by the statement its
 * retirement carries instead, and by no roster statement, so its versions
 * inside its boundary stay believed once the roster drops it. A statement
 * counts for a seat only when it verifies under the wallet key the seat's
 * entry proved, so a statement under any other key decides nothing, and none
 * counts for a seat whose entry this device did not open. A seat is refused,
 * and its filings are not believed, when no statement counts for it or one
 * that counts names a different key than its entry's wrapping key. This adds
 * no reader to any secret, and takes the statement as the one word on whose a
 * records key is.
 */
export const seatsWithAnotherRecordsKey = (
  dir: Directory, label: CompanyLabel, account: AccountAddress,
  attested: readonly { readonly committeeKey: CommitteeKey; readonly statement: RecordsKeyStatement }[],
): ReadonlySet<string> => {
  const refused = new Set<string>();
  for (const seat of dir.seats) {
    const counted = statementsCountedFor(seat, label, account, attested);
    if (counted.length === 0 || counted.some((a) => String(a.recordsKey).toLowerCase() !== seat.wrappingKey)) {
      refused.add(seat.seat);
    }
  }
  return refused;
};

/**
 * **THE RECORDS-KEY STATEMENTS THAT COUNT FOR ONE SEAT**: of `attested` (the
 * roster's) for a seat not retired, or only the one its retirement carries for
 * a retired seat; each for that seat, verifying under the wallet key its
 * entry proved. None for a seat whose entry this device did not open.
 */
export const statementsCountedFor = (
  seat: DirectorySeat, label: CompanyLabel, account: AccountAddress,
  attested: readonly { readonly committeeKey: CommitteeKey; readonly statement: RecordsKeyStatement }[],
): readonly RecordsKeyStatement[] => {
  const key = seat.committeeKey;
  if (key === undefined) return [];
  const held = seat.retired === null ? attested.map((a) => a.statement)
    : seat.retiredStatement === undefined ? [] : [seat.retiredStatement];
  return held.filter((st) => String(st.seat).toLowerCase() === seat.seat && recordsKeySignedBy(label, account, key, st));
};

/** Why a signed-in person may not act on the company's proposals now. */
export type ActingRefusal = 'no-entry' | 'no-account' | 'seat-not-seated';

export const ACTING_REFUSAL: Readonly<Record<ActingRefusal, string>> = Object.freeze({
  'no-entry': 'you hold no seat on this company that its directory believes, so nothing is relayed for you',
  'no-account': 'the company\'s account on the chain could not be read, so whether it holds your seat is not known and nothing is relayed for you',
  'seat-not-seated': 'the company\'s account does not hold your seat now, so nothing is relayed for you',
});

/**
 * **THE SEAT A RELAY IS PAID FOR, ON THE SERVER**: the entry the signed-in
 * person filed under the filing key `filer` their device sent, for a seat the
 * chain holds now, or why they may not act. Asked by person and key together
 * among every entry kept, never by person alone: a person may have filed
 * several. A proposal is raised, approved, withdrawn
 * and carried out only for a seat the account holds now: the chain's read, not
 * a retirement, which the server does not keep. The server judges no role:
 * each member's device judges the role of every proposal's seat as it reads
 * it, and the chain makes its own signer check on every call relayed; this one
 * decides whether this service pays the fee.
 */
export const actingSeatOf = (dir: Directory, chain: AccountSeats | null, person: string, filer: Hex): DirectorySeat | ActingRefusal =>
  heldNow(dir.seats.filter((x) => x.person === person && x.signingKey === String(filer).toLowerCase()), chain);
