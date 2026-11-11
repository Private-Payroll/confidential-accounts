/**
 * **THE COMPANY'S READ GRANTS: WHO READS WHAT, GIVEN AND TAKEN AWAY BY ITS SIGNERS AT THE SEAT BAR.**
 *
 * One company record, kind `grants`, holds every read grant: each entry names the recipient's wrapping key, a person
 * id or a server label, its reader role and the purposes that role read when the grant was made (`grantPurposes`). An
 * entry is read by the purposes it was filed with, which the signers signed, never by what its role reads today.
 * An entry is never a seat: it holds no leaf, files nothing, is counted by no threshold and is never wrapped the
 * company key or a vault secret.
 * What it holds is the purpose keys its entry names, wrapped to its key, for every key epoch from the first up to the
 * version's own (`wraps`), never past the newest the directory believes, and only from the version whose signatures
 * reach the bar: a version still gathering signatures wraps keys only to the entries already in force.
 *
 * A change of the entries (`sequence`) counts once enough signers at the seat bar signed it, each with its own seat's
 * filing key in its own wallet (`quorumOf`, one wallet one vote). The signatures are over the company, the change's
 * number, the person ids it names and a digest of its entries, never over the wraps, so a version that only wraps the
 * same entries again after the company's key changes carries the same signatures, and the service can count them over
 * the plain list of readers alone. Signatures gather on successive versions, each signer filing the change again with
 * its own signature added, until one reaches the bar.
 *
 * Each version is sealed under a key of its own wrapped to every seat the filing device believes and to every entry's
 * recipient it carries keys for, as a spending policy is: a reader learns the other readers' ids and purposes, and its purpose keys are
 * wrapped to its own key only.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  canonical, newSymmetricKey, parseCanonical, seal, toHex, unseal, unwrapKey, utf8, wrapKey, type Hex, type Sealed,
} from '../core/crypto.js';
import { grantPurposes, isReaderRole, READER_PURPOSES, type ReaderRole } from '../core/roles.js';
import type { Purpose } from '../core/sealed-records.js';
import { HEX64 } from './directory-change-shape.js';
import type { SealedCompanyRecord } from './sealed-record-wire.js';
import type { DirectorySeat, SeatSignature } from './seat-directory.js';
import { quorumOf } from './seat-quorum.js';
import { paddedToABucket, type PoolSigner } from './vault-pool.js';

/** The one grants record a company keeps: its kind and its id. */
export const GRANTS_RECORD = Object.freeze({ kind: 'grants' as const, id: 'read-grants' });

/** One read grant: to whom its keys are wrapped, who that is to the service, the reader role, and what it reads. */
export interface GrantEntry {
  readonly recipient: Hex;
  readonly person: string;
  readonly role: ReaderRole;
  readonly purposes: readonly Purpose[];
}

/** What a quorum signs: the change's number, one more than the change in force, and every entry after it, in order of recipient. */
export interface GrantsChange {
  readonly sequence: number;
  readonly entries: readonly GrantEntry[];
}

/** One purpose key of one epoch, wrapped to one entry's recipient. */
export interface PurposeWrap {
  readonly epoch: number;
  readonly purpose: Purpose;
  readonly wrap: { ephemeral: Hex } & Sealed;
}

/** One version of the grants record, opened: the change, the signatures gathered on it, and each entry's wraps, by reader id. */
export interface Grants extends GrantsChange {
  readonly signatures: readonly SeatSignature[];
  readonly wraps: Readonly<Record<string, readonly PurposeWrap[]>>;
}

/** A version as a device reads it: its number, the newest key epoch it wraps, and what it opened to. */
export interface GrantsVersion {
  readonly version: number;
  readonly keyEpoch: number;
  readonly grants: Grants;
}

const READER_ID = 'reader:';
/** The id an entry's recipient opens a version and its wraps under: never a seat's. */
export const readerIdOf = (recipient: string): string => `${READER_ID}${recipient.toLowerCase()}`;
/** Whether a wrap's id is a reader's rather than a seat's. */
export const isReaderId = (id: string): boolean => id.toLowerCase().startsWith(READER_ID);

/** The entry a grant to `recipient` at `role` makes: the purposes that role reads (`grantPurposes`). */
export const grantEntryOf = (g: { readonly recipient: string; readonly person: string; readonly role: ReaderRole }): GrantEntry =>
  Object.freeze({ recipient: g.recipient.toLowerCase() as Hex, person: g.person, role: g.role, purposes: grantPurposes(g.role) });

/** Entries in the one order a change holds them in: by recipient. */
export const entriesInOrder = (entries: readonly GrantEntry[]): readonly GrantEntry[] =>
  [...entries].sort((a, b) => (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0));

/** The digest of a change's entries the signatures commit to. */
export const entriesDigestOf = (entries: readonly GrantEntry[]): Hex => toHex(sha256(utf8(canonical(entries)))) as Hex;

/** The person ids or server labels a change names, in order, each once: the list the service keeps as its readers. */
export const readersNamedIn = (entries: readonly GrantEntry[]): readonly string[] => [...new Set(entries.map((e) => e.person))].sort();

const GRANTS_DOMAIN = 'confidential-accounts/read-grants/v1';

/** What a signer signs for a change: the company, its number, the readers it names and its entries' digest. The service computes the same from the plain list. */
export const readersMessage = (company: string, sequence: number, readers: readonly string[], entries: Hex): string =>
  canonical({ domain: GRANTS_DOMAIN, company, sequence, readers: [...readers], entries });

/** The message of one change. */
export const grantsMessage = (company: string, change: GrantsChange): string =>
  readersMessage(company, change.sequence, readersNamedIn(change.entries), entriesDigestOf(change.entries));

/** The plain list the service keeps as a company's readers, with what puts it in force: the signatures over it. */
export interface ReadersHandedIn {
  readonly sequence: number;
  readonly readers: readonly string[];
  readonly entries: Hex;
  readonly signatures: readonly SeatSignature[];
}

/** The list of readers a change names, as a signer's wallet hands it to the service. */
export const readersHandedInFor = (change: GrantsChange, signatures: readonly SeatSignature[]): ReadersHandedIn =>
  ({ sequence: change.sequence, readers: readersNamedIn(change.entries), entries: entriesDigestOf(change.entries), signatures: [...signatures] });

/** Why a version of the grants record is not believed, each in words that say what puts it right. */
export const GRANTS_REFUSAL = {
  'not-opened': 'this version of the read grants is not sealed to this device, or does not open, so it is not read here. A signer who stays files the grants again, sealed to every seat and reader.',
  'not-grants': 'this version of the read grants is not in the one shape a grant is held in, so it is not believed. A signer files the change again from their wallet.',
  'not-the-next-change': 'this version of the read grants is neither the change in force wrapped again nor the next change after it, so it is not believed. A signer asks for the change again from their wallet, on the grants as they stand.',
  'epoch-not-reached': 'this version of the read grants names a key epoch the company\'s key has not reached, so it is not believed. A signer who stays files the grants again from their wallet, at the key in force.',
  'wraps-not-the-entries': 'this version of the read grants does not wrap each entry\'s purposes for every key epoch up to its own, to exactly the entries the signers signed, so it is not believed. A signer who stays files the grants again from their wallet.',
  'not-signed': 'a signature on this version of the read grants does not verify, or one seat signed it twice, so it is not believed. Each signer signs the change again from their wallet.',
  'below-quorum': 'not enough of the company\'s signers have signed this change of the read grants yet: it needs as many as a change of who is seated needs on the company\'s account. It counts once the other signers sign it in their own wallets.',
} as const;
export type GrantsRefusal = keyof typeof GRANTS_REFUSAL;

const NAME = /^[A-Za-z0-9._:@-]{1,128}$/u;

/** Every purpose some reader role reads: the most any entry may carry, whatever its role. */
const READ_BY_A_READER: ReadonlySet<string> = new Set(Object.values(READER_PURPOSES).flat());

/**
 * Whether an entry's purposes are a list the signers could have signed: at least one, none twice, each one some reader
 * role reads. An entry is judged by the purposes it was filed with, never against what its role reads today, so a
 * change of what a role reads leaves every grant already filed in force until the signers file it again.
 */
const purposesFiledWell = (purposes: unknown): boolean => Array.isArray(purposes) && purposes.length > 0
  && new Set(purposes).size === purposes.length && purposes.every((p) => typeof p === 'string' && READ_BY_A_READER.has(p));

/** Why a change is not in its one shape: entries in order of recipient, one per recipient and per person, each with purposes filed well. */
export const grantsChangeRefusal = (change: GrantsChange): GrantsRefusal | null => {
  if (typeof change !== 'object' || change === null || !Number.isSafeInteger(change.sequence) || change.sequence < 1
    || !Array.isArray(change.entries)) return 'not-grants';
  const recipients = new Set<string>();
  const persons = new Set<string>();
  for (const e of change.entries) {
    if (typeof e?.recipient !== 'string' || !HEX64.test(e.recipient) || typeof e.person !== 'string' || !NAME.test(e.person)
      || !isReaderRole(e.role) || !purposesFiledWell(e.purposes)) return 'not-grants';
    recipients.add(e.recipient);
    persons.add(e.person);
  }
  if (recipients.size !== change.entries.length || persons.size !== change.entries.length) return 'not-grants';
  return canonical(change.entries) === canonical(entriesInOrder(change.entries)) ? null : 'not-grants';
};

/**
 * Whether a version wraps each of `wrapped`'s purposes, once each, for every key epoch from 0 up to `keyEpoch`, and
 * nothing to anyone else: every entry signed, for a version that counts; for one still below the bar, only the entries
 * already in force unchanged (`carriedFrom`), so a recipient the quorum has not agreed to yet holds no key.
 */
export const wrapsRefusal = (grants: Grants, keyEpoch: number, wrapped: readonly GrantEntry[] = grants.entries): GrantsRefusal | null => {
  if (typeof grants.wraps !== 'object' || grants.wraps === null) return 'wraps-not-the-entries';
  const ids = wrapped.map((e) => readerIdOf(e.recipient)).sort();
  if (canonical(Object.keys(grants.wraps).sort()) !== canonical(ids)) return 'wraps-not-the-entries';
  for (const e of wrapped) {
    const wraps = grants.wraps[readerIdOf(e.recipient)];
    if (!Array.isArray(wraps) || wraps.length !== (keyEpoch + 1) * e.purposes.length) return 'wraps-not-the-entries';
    const seen = new Set(wraps.map((w) => `${w?.epoch}:${w?.purpose}`));
    for (let epoch = 0; epoch <= keyEpoch; epoch += 1) {
      for (const p of e.purposes) if (!seen.has(`${epoch}:${p}`)) return 'wraps-not-the-entries';
    }
    if (wraps.some((w) => typeof w.wrap !== 'object' || w.wrap === null || typeof w.wrap.ephemeral !== 'string')) return 'wraps-not-the-entries';
  }
  return null;
};

/** The entries of `after` already in force in `before`, unchanged: all a version still below the bar may wrap keys to. */
export const carriedFrom = (before: readonly GrantEntry[], after: readonly GrantEntry[]): readonly GrantEntry[] =>
  after.filter((a) => before.some((b) => b.recipient === a.recipient && canonical(b.purposes) === canonical(a.purposes)));

/**
 * Whether `after` only narrows `before`: every entry it holds was already in force for the same recipient, person and
 * role, reading no purpose it did not read. Such a change can only take reading away, never give it.
 */
export const narrowsOnly = (before: readonly GrantEntry[], after: readonly GrantEntry[]): boolean =>
  after.every((a) => before.some((b) => b.recipient === a.recipient && b.person === a.person && b.role === a.role
    && a.purposes.every((p) => b.purposes.includes(p))));

/**
 * How many distinct wallets of the directory's seats signed `message`, a seat retired since, or no longer held by the
 * chain, counted as well: what a change that only narrows the grants is counted with. A signer of a taking-away who is
 * removed afterwards, before or with its anchoring, still counts, so the reader it took away never comes back; and a
 * change counted this way can only take reading away, so no reader is ever let in by a seat that has left.
 */
const signedByAnySeat = (seats: readonly DirectorySeat[], message: string, signatures: readonly SeatSignature[]): number => {
  const n = quorumOf(seats.map((x) => ({ ...x, retired: null })), message, signatures, () => true);
  return typeof n === 'string' ? 0 : n;
};

/** Whether `after` takes away anything `before` gave: an entry gone, or a purpose an entry no longer reads. */
export const takesAway = (before: readonly GrantEntry[], after: readonly GrantEntry[]): boolean =>
  before.some((b) => {
    const a = after.find((x) => x.recipient === b.recipient);
    return a === undefined || b.purposes.some((p) => !a.purposes.includes(p));
  });

/** The purpose key of each purpose an entry reads, for every epoch up to `newest`, wrapped to its recipient. */
export const purposeWrapsFor = (
  entries: readonly GrantEntry[], purposeKeyAt: (epoch: number, purpose: Purpose) => Hex, newest: number,
): Record<string, PurposeWrap[]> => Object.fromEntries(entries.map((e) => [readerIdOf(e.recipient), Array.from({ length: newest + 1 }, (_x, epoch) =>
  e.purposes.map((purpose) => ({ epoch, purpose, wrap: wrapKey(purposeKeyAt(epoch, purpose), e.recipient) }))).flat()]));

interface GrantsLabel { readonly record: 'grants'; readonly company: string; readonly version: number }

/** One version of the grants record, sealed under a key of its own wrapped to every seat in `seats` and every entry's recipient. */
export const sealGrants = (input: {
  readonly company: string; readonly version: number; readonly keyEpoch: number; readonly grants: Grants; readonly seats: readonly PoolSigner[];
}): SealedCompanyRecord => {
  const key = newSymmetricKey();
  const label: GrantsLabel = { record: 'grants', company: input.company, version: input.version };
  /* A recipient is sealed a version only where it carries that recipient's keys: never one still waiting for the bar. */
  const readers = input.grants.entries.filter((e) => input.grants.wraps[readerIdOf(e.recipient)] !== undefined)
    .map((e) => ({ id: readerIdOf(e.recipient), wrappingPublicKey: e.recipient }));
  return {
    company: input.company, kind: GRANTS_RECORD.kind, id: GRANTS_RECORD.id, version: input.version, keyEpoch: input.keyEpoch,
    sealed: seal(paddedToABucket(canonical({ ...input.grants, $label: label })), key),
    wrapped: [...input.seats, ...readers].map((s) => ({ signerId: s.id, wrapped: wrapKey(key, s.wrappingPublicKey) })),
  };
};

/** One version opened with `me`'s copy of its key, or null when it was not sealed to `me`, does not open, or says it is another record. */
export const openGrants = (rec: SealedCompanyRecord, me: { readonly signerId: string; readonly wrappingSecret: Hex }): Grants | null => {
  const mine = rec.wrapped.find((w) => w.signerId === me.signerId);
  if (rec.kind !== GRANTS_RECORD.kind || mine === undefined) return null;
  let body: Grants & { readonly $label?: Partial<GrantsLabel> };
  try {
    body = parseCanonical<Grants & { readonly $label?: Partial<GrantsLabel> }>(unseal(rec.sealed, unwrapKey(mine.wrapped, me.wrappingSecret)));
  } catch {
    /* A copy that does not open is a version this device cannot read: it is reported as not opened, never believed. */
    return null;
  }
  const label = body?.$label;
  if (label?.record !== 'grants' || label.company !== rec.company || label.version !== rec.version) return null;
  const { $label: _label, ...grants } = body;
  return grants;
};

/** The grants a device believes: the change in force, a change still gathering signatures after it, and the key epoch a believed taking-away was filed at. */
export interface GrantsInForce {
  readonly inForce: GrantsVersion | null;
  /** The newest version of the next change, signed below the bar: what a signer who agrees signs. */
  readonly waiting: GrantsVersion | null;
  /** The key epoch of the newest believed version that took something away, or null: the key is owed a change while it is the newest. */
  readonly revokedAt: number | null;
  readonly refused: ReadonlyMap<number, GrantsRefusal>;
}

/** Who counts toward the bar: the seats the directory believes, the test of a seat the chain holds, and the seat bar. */
export interface GrantsCount {
  readonly seats: readonly DirectorySeat[];
  readonly held: (seat: DirectorySeat) => boolean;
  readonly bar: number;
}

/**
 * Who counts toward the bar now, and the newest key epoch the directory believes, which no version may name a higher
 * one than. `asAnchored` gives, for a version the company's records anchor, who counted as they anchored it: such a
 * version is counted against that, never against today's seats, so a signer who leaves later, or a bar raised later,
 * never drops a change the bar once carried, and never brings back a reader it took away. Undefined for a version not
 * yet anchored, which is counted against now.
 */
export interface GrantsQuorum extends GrantsCount {
  readonly newest: number;
  readonly asAnchored?: (version: number) => GrantsCount | undefined;
}

/**
 * **THE GRANTS IN FORCE, JUDGED VERSION BY VERSION.** A version is believed when it is in its shape, names a key epoch
 * no higher than the newest the directory believes and no lower than the version in force, wraps exactly its entries,
 * is signed at the bar (as the records anchored it, for a version they anchor), and is the change in force wrapped again
 * or the next change. A change that only narrows the grants (`narrowsOnly`) counts its signers' seats that have left
 * since (`signedByAnySeat`), so removing a signer of a taking-away never brings back the reader it took away. One still below the bar wraps keys
 * only to entries already in force, unchanged.
 * The first version this device opens may be any change: a reader opens only the versions sealed to it. A version that
 * takes away an entry or a purpose names the key epoch it was filed at (`revokedAt`): until the company's key changes
 * past it, the revoked reader still holds the key in force.
 */
export const grantsInForceOf = (
  company: string, versions: readonly { readonly version: number; readonly keyEpoch: number; readonly grants: Grants | null }[], quorum: GrantsQuorum,
): GrantsInForce => {
  let inForce: GrantsVersion | null = null;
  let waiting: GrantsVersion | null = null;
  let revokedAt: number | null = null;
  const refused = new Map<number, GrantsRefusal>();
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    const g = v.grants;
    if (g === null) { refused.set(v.version, 'not-opened'); continue; }
    const shape = grantsChangeRefusal(g) ?? (!Number.isSafeInteger(v.keyEpoch) || v.keyEpoch < 0 ? 'not-grants'
      : v.keyEpoch > quorum.newest ? 'epoch-not-reached' : null);
    if (shape !== null) { refused.set(v.version, shape); continue; }
    const prior = inForce;
    const again = prior !== null && g.sequence === prior.grants.sequence;
    if (prior !== null && (again ? canonical(g.entries) !== canonical(prior.grants.entries) || v.keyEpoch < prior.keyEpoch
      : g.sequence !== prior.grants.sequence + 1 || v.keyEpoch < prior.keyEpoch)) {
      refused.set(v.version, 'not-the-next-change');
      continue;
    }
    const count = quorum.asAnchored?.(v.version) ?? quorum;
    const message = grantsMessage(company, g);
    const counted = quorumOf(count.seats, message, g.signatures, count.held);
    if (typeof counted === 'string') { refused.set(v.version, 'not-signed'); continue; }
    const n = prior !== null && !again && narrowsOnly(prior.grants.entries, g.entries)
      ? Math.max(counted, signedByAnySeat(count.seats, message, g.signatures)) : counted;
    const unwrapped = wrapsRefusal(g, v.keyEpoch, n >= count.bar ? g.entries : carriedFrom(prior?.grants.entries ?? [], g.entries));
    if (unwrapped !== null) { refused.set(v.version, unwrapped); continue; }
    if (n < count.bar) {
      refused.set(v.version, 'below-quorum');
      if (!again) waiting = { version: v.version, keyEpoch: v.keyEpoch, grants: g };
      continue;
    }
    if (prior !== null && !again && takesAway(prior.grants.entries, g.entries)) revokedAt = v.keyEpoch;
    inForce = { version: v.version, keyEpoch: v.keyEpoch, grants: g };
    if (waiting !== null && waiting.grants.sequence <= g.sequence) waiting = null;
  }
  return { inForce, waiting, revokedAt, refused };
};
