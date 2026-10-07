/**
 * **A COMPANY'S SEAT DIRECTORY: WHO FILES ITS RECORDS UNDER WHICH KEY, AND
 * WHAT A DEVICE BELIEVES OF IT.**
 *
 * The company's server keeps the directory in plain text: for each seat on the
 * company's account, the person who holds it, the key their filings are signed
 * with, the key copies are sealed to, and a role. **The server is assumed to
 * lie**, so nothing in the directory is believed because the server says so:
 *
 *   · **an entry** is signed by the seat's own wallet with the committee key
 *     the company's account lists on the chain, for the seat that account
 *     holds now (`directoryEntrySignedBy`). A device believes an entry only
 *     when that signature verifies against the committee its own wallet read
 *     off the chain, and the seat is seated now. One entry per seat, and one
 *     per key: a second is refused.
 *   · **a change to an entry** - a role, or a seat retired with the last
 *     version of each record it filed - is signed by as many seats as the
 *     account's approval threshold, read from the chain (check Q).
 *   · **a filing** is believed only when it is signed by a seat the directory
 *     believes, whose role may file that kind of record (check S). A version
 *     signed by a key whose seat is not seated now is refused, unless a
 *     retirement record signed by a quorum names it within that seat's last
 *     versions.
 *
 * The server makes the same checks when it is asked to file, so an honest
 * server refuses what every device would refuse; but what a device believes
 * rests on its own checks here, never on the server's.
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
import { canonical, verify, type Hex } from '../core/crypto.js';
import type { Role } from '../core/types.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS, type CompanyRecordKind, type WireRecord } from './sealed-record-wire.js';

/* ------------------------------------------------------------------ kinds */

export type { CompanyRecordKind };

/** Every kind of record a seat files: a company's own, and a vault's. */
export type FiledKind = CompanyRecordKind | WireRecord;

/**
 * **WHICH KINDS EACH ROLE MAY FILE.** A seat with no role set yet is a seated
 * signer whose role the quorum has not named: it files what a full signer
 * files. A limited seat files nothing.
 */
export const MAY_FILE: Readonly<Record<Role | 'unset', readonly FiledKind[]>> = Object.freeze({
  admin: Object.freeze([...COMPANY_RECORD_KINDS, ...WIRE_RECORDS]),
  approver: Object.freeze(['proposal', ...WIRE_RECORDS] as FiledKind[]),
  initiator: Object.freeze(['run', 'proposal', ...WIRE_RECORDS] as FiledKind[]),
  viewer: Object.freeze([] as FiledKind[]),
  unset: Object.freeze([...COMPANY_RECORD_KINDS, ...WIRE_RECORDS]),
});

/** The key one record's versions are counted under, in a retirement record's boundary. */
export const vaultRecordKey = (vault: string, record: WireRecord): string => `vault:${vault}:${record}`;
export const companyRecordKey = (kind: CompanyRecordKind, id: string): string => `${kind}:${id}`;

/* ------------------------------------------------------------------ the filings */

/** A committee key, as the chain lists it. */
export interface CommitteeKey { readonly tag: string; readonly value: string }

/** One seat's entry, as its own device files it: the statement its wallet signed, and the committee key that signed it. */
export interface DirectoryEntry {
  /** The signed-in person who filed it. The server's attribution, checked against who is signed in; a device does not rest on it. */
  readonly person: string;
  readonly committeeKey: CommitteeKey;
  readonly statement: DirectoryEntryStatement;
}

/** One seat's signature over a change, with the filing key it is checked against. */
export interface SeatSignature { readonly publicKey: Hex; readonly signature: Hex }

export type DirectoryChange =
  /** A seat's own entry. Signed by its wallet; no quorum. */
  | { readonly kind: 'claim'; readonly entry: DirectoryEntry }
  /** A seat's role, named by a quorum. */
  | { readonly kind: 'role'; readonly seat: string; readonly role: Role; readonly threshold: number; readonly signatures: readonly SeatSignature[] }
  /**
   * A seat retired by a quorum, with the last version of each record it filed:
   * a version it filed up to that boundary is still believed, anything after
   * is refused.
   */
  | {
    readonly kind: 'retire'; readonly seat: string; readonly filedUpTo: Readonly<Record<string, number>>;
    readonly threshold: number; readonly signatures: readonly SeatSignature[];
  };

/** One version of a company's directory, as it is filed and served. */
export interface DirectoryFiling {
  readonly company: string;
  readonly version: number;
  readonly change: DirectoryChange;
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
  readonly committeeKey: CommitteeKey;
  readonly role: Role | null;
  /** Null while the seat is not retired; its last versions once a quorum has retired it. */
  readonly retired: Readonly<Record<string, number>> | null;
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
  'not-on-the-committee': 'the key that signed that entry is not on the committee the company\'s account lists on the chain. A company whose account was never handed to its signers\' committee has none: create a new company. Otherwise finish handing the account to its committee, then enter the seat again.',
  'entry-not-signed': 'that entry is not signed by the wallet of the seat it names, for this company. Ask your wallet to sign your entry again.',
  'seat-not-seated': 'the seat that entry names is not one the company\'s account holds now, so it has no entry.',
  'seat-taken': 'that seat already has an entry, and a seat has one.',
  'key-taken': 'that filing, records or committee key is already another entry\'s, and a key belongs to one entry.',
  'person-has-a-seat': 'that person already holds an entry in this company\'s directory.',
  'no-such-seat': 'that change names a seat the directory has no entry for.',
  'seat-retired': 'that seat has been retired, so it cannot be changed or sign a change.',
  'threshold-not-the-chains': 'that change was signed against a number of approvals that is not the one the company\'s account requires on the chain now. Have it signed again against the chain\'s.',
  'not-signed': 'one of the signatures on that change does not verify. Have the change signed again.',
  'twice-by-one-seat': 'one seat signed that change twice, and a seat counts once.',
  'below-quorum': 'not enough of the company\'s seats signed that change: it needs as many as the company\'s account requires on the chain.',
  'not-a-change': 'that is not a change to a company\'s directory.',
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

/** What the chain says about the company's account, as the checker read it. */
export interface ChainHolders {
  /** The committee the account lists, and every seat it holds now. */
  readonly seats: AccountSeats;
  /** The approvals the account requires. */
  readonly approvals: number;
}

const sameKey = (a: CommitteeKey, b: CommitteeKey): boolean =>
  a.tag === b.tag && a.value.toLowerCase() === b.value.toLowerCase();

/**
 * Whether an entry's own signature checks out, and, given what the chain says
 * now, whether its committee key is on the account's committee and its seat is
 * seated. Never throws.
 */
export const entryRefusalOf = (
  label: CompanyLabel, account: AccountAddress, entry: DirectoryEntry, chain: ChainHolders | null,
): DirectoryRefusalCode | null => {
  const s = entry?.statement;
  if (typeof s !== 'object' || s === null || ![s.account, s.signingKey, s.wrappingKey, s.seat].every((k) => typeof k === 'string' && HEX64.test(k))
    || typeof entry.committeeKey !== 'object' || entry.committeeKey === null) return 'not-a-change';
  if (chain !== null && !chain.seats.committee.some((k) => sameKey(k, entry.committeeKey))) return 'not-on-the-committee';
  /* Signed for this company's account and no other: an entry for another account carrying the label decides nothing here. */
  if (!directoryEntrySignedBy(label, account, entry.committeeKey, s)) return 'entry-not-signed';
  if (chain !== null && !chain.seats.seats.includes(s.seat)) return 'seat-not-seated';
  return null;
};

/** How many distinct, valid signatures from seats the directory holds and has not retired; refused on a bad or doubled one. */
const quorumOf = (dir: Directory, change: Exclude<DirectoryChange, { kind: 'claim' }>, version: number, counts: (seat: DirectorySeat) => boolean): number | DirectoryRefusalCode => {
  if (!Array.isArray(change.signatures)) return 'not-a-change';
  const message = directoryChangeMessage(dir.company, version, change);
  const seen = new Set<string>();
  /* One wallet is one vote: two entries under one committee key count once. */
  const wallets = new Set<string>();
  let n = 0;
  for (const sig of change.signatures) {
    if (typeof sig?.publicKey !== 'string' || !HEX64.test(sig.publicKey) || typeof sig.signature !== 'string' || !HEX128.test(sig.signature)) return 'not-a-change';
    if (!verify(message, sig.signature, sig.publicKey)) return 'not-signed';
    if (seen.has(sig.publicKey)) return 'twice-by-one-seat';
    seen.add(sig.publicKey);
    const seat = dir.seats.find((x) => x.signingKey === sig.publicKey);
    const wallet = seat === undefined ? '' : `${seat.committeeKey.tag}:${seat.committeeKey.value.toLowerCase()}`;
    if (seat !== undefined && seat.retired === null && counts(seat) && !wallets.has(wallet)) { wallets.add(wallet); n += 1; }
  }
  return n;
};

const ROLES: readonly Role[] = ['admin', 'approver', 'initiator', 'viewer'];

/**
 * **ONE FILING, APPLIED TO THE DIRECTORY AS IT STANDS, OR REFUSED.**
 *
 * Filed (`chain` given): the server's check before it files, against its own
 * read of the chain now. An entry's committee key must be on the committee and
 * its seat seated; a quorum's change must be signed against the chain's
 * threshold by that many seats seated now. `who` is the signed-in person
 * filing and the company's members: an entry names its filer, who must be a
 * member.
 *
 * Replayed (`chain` null): a device reading back every filing. Each entry's
 * signature is checked. With `now`, a change's quorum is counted against the
 * account's approval threshold now, over seats not retired that are seated now
 * and whose committee key the committee lists now, one per wallet; without it,
 * against the threshold the change names. Whether a seat is held NOW is asked
 * of each filing when it is read (`filingRefusalOf`), because a seat retired
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
     * when it names at least the account's approval threshold now, counting only seats seated now whose committee
     * key the account's committee lists now, so a change the server stored under a lower threshold, signed by seats
     * that have left, or signed by an entry the server made up, is not believed.
     */
    readonly now?: { readonly approvals: number; readonly seats: readonly string[]; readonly committee: readonly CommitteeKey[] };
  },
): Directory => {
  if (typeof filing !== 'object' || filing === null || typeof filing.change !== 'object' || filing.change === null) {
    throw new DirectoryRefused('not-a-change');
  }
  if (filing.company !== dir.company) throw new DirectoryRefused('not-this-company');
  if (filing.version !== dir.version + 1) throw new DirectoryRefused('not-the-next-version');
  const change = filing.change;
  if (change.kind === 'claim') {
    const entry = change.entry;
    if (typeof entry !== 'object' || entry === null || typeof entry.person !== 'string' || entry.person.length === 0) {
      throw new DirectoryRefused('not-a-change');
    }
    if (ctx.who !== undefined) {
      if (entry.person !== ctx.who.person) throw new DirectoryRefused('not-your-entry');
      if (!ctx.who.members.includes(entry.person)) throw new DirectoryRefused('not-a-member');
    }
    const refused = entryRefusalOf(ctx.label, ctx.account, entry, ctx.chain);
    if (refused !== null) throw new DirectoryRefused(refused);
    const s = entry.statement;
    if (dir.seats.some((x) => x.seat === s.seat)) throw new DirectoryRefused('seat-taken');
    if (dir.seats.some((x) => [x.signingKey, x.wrappingKey].some((k) => k === s.signingKey || k === s.wrappingKey))
      || s.signingKey === s.wrappingKey
      /* One wallet holds one seat: a second entry signed with a committee key another entry carries is refused. */
      || dir.seats.some((x) => sameKey(x.committeeKey, entry.committeeKey))) throw new DirectoryRefused('key-taken');
    if (dir.seats.some((x) => x.person === entry.person)) throw new DirectoryRefused('person-has-a-seat');
    return {
      ...dir, version: filing.version,
      seats: [...dir.seats, {
        seat: s.seat, person: entry.person, signingKey: s.signingKey, wrappingKey: s.wrappingKey,
        committeeKey: { tag: entry.committeeKey.tag, value: entry.committeeKey.value.toLowerCase() }, role: null, retired: null,
      }],
    };
  }
  if (change.kind !== 'role' && change.kind !== 'retire') throw new DirectoryRefused('not-a-change');
  const target = dir.seats.find((x) => x.seat === change.seat);
  if (target === undefined) throw new DirectoryRefused('no-such-seat');
  if (target.retired !== null) throw new DirectoryRefused('seat-retired');
  if (!Number.isSafeInteger(change.threshold) || change.threshold < 1) throw new DirectoryRefused('not-a-change');
  if (ctx.chain !== null && change.threshold !== ctx.chain.approvals) throw new DirectoryRefused('threshold-not-the-chains');
  const now = ctx.now;
  if (ctx.chain === null && now !== undefined && change.threshold < now.approvals) throw new DirectoryRefused('threshold-not-the-chains');
  if (change.kind === 'role' && !ROLES.includes(change.role)) throw new DirectoryRefused('not-a-change');
  if (change.kind === 'retire' && (typeof change.filedUpTo !== 'object' || change.filedUpTo === null
    || !Object.values(change.filedUpTo).every((v) => Number.isSafeInteger(v) && v >= 0))) throw new DirectoryRefused('not-a-change');
  const chain = ctx.chain;
  const n = quorumOf(dir, change, filing.version, (x) => (chain !== null ? chain.seats.seats.includes(x.seat)
    : now === undefined || (now.seats.includes(x.seat) && now.committee.some((k) => sameKey(k, x.committeeKey)))));
  if (typeof n === 'string') throw new DirectoryRefused(n);
  if (n < change.threshold) throw new DirectoryRefused('below-quorum');
  return {
    ...dir, version: filing.version,
    seats: dir.seats.map((x) => (x.seat !== change.seat ? x : change.kind === 'role'
      ? { ...x, role: change.role }
      : { ...x, retired: Object.freeze({ ...change.filedUpTo }) })),
  };
};

/**
 * **THE DIRECTORY A DEVICE BELIEVES**, replayed from every filing the server
 * served. Versions must run 1, 2, 3 without a gap. **An entry whose signature
 * does not verify is left out, not fatal**: it is a seat this device does not
 * believe, and a filing signed by its key is refused when it is read. A change
 * a quorum did not sign is left out the same way. Whether a seat is on the
 * committee and seated now is asked of every filing as it is read, against
 * this device's own wallet's read of the chain (`filingRefusalOf`). With `now`,
 * a role or retirement change is believed only at the account's approval
 * threshold now, signed by that many seats seated now.
 */
export const believedDirectory = (
  company: string, filings: readonly DirectoryFiling[], label: CompanyLabel, account: AccountAddress,
  now?: { readonly approvals: number; readonly seats: readonly string[]; readonly committee: readonly CommitteeKey[] },
): Directory => {
  let dir = emptyDirectory(company);
  filings.forEach((f, i) => {
    if (f?.version !== i + 1) throw new DirectoryRefused('not-the-next-version');
    try {
      dir = applyFiling(dir, f, { label, account, chain: null, ...(now === undefined ? {} : { now }) });
    } catch (e) {
      if (!(e instanceof DirectoryRefused)) throw e;
      dir = { ...dir, version: f.version };
    }
  });
  return dir;
};

/** Why a device does not believe a filing signed by `publicKey`, or null when it does. */
export type FilingRefusal = 'no-entry' | 'not-on-the-committee' | 'seat-not-seated' | 'role-may-not-file' | 'past-its-boundary';

export const FILING_REFUSAL: Readonly<Record<FilingRefusal, string>> = Object.freeze({
  'no-entry': 'it is signed by a key that has no entry in the company\'s directory that this device believes',
  'not-on-the-committee': 'it is signed by a seat whose entry was signed by a key the company\'s account does not list on its committee now',
  'seat-not-seated': 'it is signed by a seat the company\'s account no longer holds, and no retirement names it',
  'role-may-not-file': 'it is signed by a seat whose role may not file this kind of record',
  'past-its-boundary': 'it is signed by a retired seat, and is later than the last version that seat filed before it left',
});

/**
 * **CHECK S, ON A DEVICE**: whether a version signed by `publicKey` of the
 * record counted under `recordKey`, of kind `kind`, at `version`, is believed.
 * `chain` is what this device's own wallet read off the chain for this read:
 * a seat not retired is believed only while its entry's committee key is on the
 * committee and its seat is seated; a retired seat only within its boundary.
 */
export const filingRefusalOf = (
  dir: Directory, chain: AccountSeats, publicKey: Hex, kind: FiledKind, recordKey: string, version: number,
): FilingRefusal | null => {
  const seat = dir.seats.find((x) => x.signingKey === publicKey.toLowerCase());
  if (seat === undefined) return 'no-entry';
  if (!MAY_FILE[seat.role ?? 'unset'].includes(kind)) return 'role-may-not-file';
  if (seat.retired !== null) {
    const last = seat.retired[recordKey];
    return last !== undefined && version <= last ? null : 'past-its-boundary';
  }
  return notOnTheChainNow(seat, chain);
};

/** Whether the chain, read now, lists the committee key that signed `seat`'s entry and holds the seat: one rule for a device and the server. */
export const notOnTheChainNow = (seat: DirectorySeat, chain: AccountSeats): 'not-on-the-committee' | 'seat-not-seated' | null => {
  if (!chain.committee.some((k) => sameKey(k, seat.committeeKey))) return 'not-on-the-committee';
  if (!chain.seats.includes(seat.seat)) return 'seat-not-seated';
  return null;
};

/**
 * **CHECK S, ON THE SERVER**: the seat the signed-in person holds, filing under
 * `publicKey` a record of kind `kind`, or the reason they may not. `dir` is the
 * directory replayed against the server's own read of the chain now, and
 * `chain` is that read, null when the company has no account on a chain the
 * server can read: a seat files only while the committee key that signed its
 * entry is on the committee and the account holds it, the rule a device
 * applies to every filing it reads (`filingRefusalOf`). A retired seat files
 * nothing new.
 */
export const filerSeatOf = (
  dir: Directory, chain: AccountSeats | null, person: string, publicKey: Hex, kind: FiledKind,
): DirectorySeat | FilingRefusal => {
  const seat = dir.seats.find((x) => x.person === person);
  if (seat === undefined || seat.signingKey !== publicKey.toLowerCase()) return 'no-entry';
  if (seat.retired !== null) return 'past-its-boundary';
  if (!MAY_FILE[seat.role ?? 'unset'].includes(kind)) return 'role-may-not-file';
  if (chain === null) return 'not-on-the-committee';
  return notOnTheChainNow(seat, chain) ?? seat;
};

/**
 * **THE SEATS WHOSE WRAPPING KEY IS NOT THE RECORDS KEY THEIR OWN WALLET
 * ATTESTED.** Every seat in the directory is checked, not only those a
 * statement is held for. `attested` is every records-key statement this device
 * holds; a statement counts for a seat only when it verifies under the
 * committee key that signed the seat's own entry, so a statement under any
 * other key decides nothing. A seat is refused, and its filings are not
 * believed, when no statement counts for it or one that counts names a
 * different key than its entry's wrapping key. This adds no reader to any
 * secret, and takes the statement as the one word on whose a records key is.
 */
export const seatsWithAnotherRecordsKey = (
  dir: Directory, label: CompanyLabel, account: AccountAddress,
  attested: readonly { readonly committeeKey: CommitteeKey; readonly statement: RecordsKeyStatement }[],
): ReadonlySet<string> => {
  const refused = new Set<string>();
  for (const seat of dir.seats) {
    const counted = attested.filter((a) => String(a.statement.seat).toLowerCase() === seat.seat
      && recordsKeySignedBy(label, account, seat.committeeKey, a.statement));
    if (counted.length === 0 || counted.some((a) => String(a.statement.recordsKey).toLowerCase() !== seat.wrappingKey)) {
      refused.add(seat.seat);
    }
  }
  return refused;
};

/** Why a signed-in person may not act on the company's proposals now. */
export type ActingRefusal = 'no-entry' | 'past-its-boundary' | 'not-on-the-committee' | 'seat-not-seated' | 'role-may-not-act';

export const ACTING_REFUSAL: Readonly<Record<ActingRefusal, string>> = Object.freeze({
  'no-entry': 'you hold no seat on this company that its directory believes, so nothing is relayed for you',
  'past-its-boundary': 'your seat on this company has been retired, so nothing is relayed for you',
  'not-on-the-committee': 'your seat\'s entry was signed by a key the company\'s account does not list on its committee now, so nothing is relayed for you',
  'seat-not-seated': 'the company\'s account does not hold your seat now, so nothing is relayed for you',
  'role-may-not-act': 'your seat on this company may read but not raise, approve, withdraw or carry out proposals',
});

/**
 * **CHECK S FOR A RELAY, ON THE SERVER**: the seat the signed-in person holds on
 * the company now, as the directory replayed against the chain believes it, or
 * why they may not act. A proposal is raised, approved, withdrawn and carried
 * out only for a seat the account holds now, whose entry its own wallet signed
 * with a key on the account's committee now, and whose role is not a limited
 * one. The chain makes its own signer check on every call relayed; this one
 * decides whether this service pays the fee for it.
 */
export const actingSeatOf = (dir: Directory, chain: AccountSeats | null, person: string): DirectorySeat | ActingRefusal => {
  const seat = dir.seats.find((x) => x.person === person);
  if (seat === undefined) return 'no-entry';
  if (seat.retired !== null) return 'past-its-boundary';
  if (seat.role === 'viewer') return 'role-may-not-act';
  if (chain === null) return 'not-on-the-committee';
  return notOnTheChainNow(seat, chain) ?? seat;
};
