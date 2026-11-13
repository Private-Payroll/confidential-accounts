/**
 * Locking a company's records so we cannot read them.
 *
 * The shielded balance has always been sealed. Everything around it — the staff
 * list with names, emails and salaries, the signer roster, the spending rules —
 * has been sitting on the server as readable text. In a product called
 * confidential payroll.
 *
 * Nothing here is new cryptography. `seal`, `unseal`, `wrapKey` and `unwrapKey`
 * already exist and are already proven; this composes them and adds one thing:
 * a separate key per purpose.
 *
 * WHY SEPARATE KEYS, DECIDED NOW.
 *
 * One key for everything means anyone allowed to see anything can see
 * everything, permanently. A bookkeeper who needs the spending rules would get
 * every salary with them. Splitting later is not a code change, it is
 * re-encrypting every record every customer has and re-issuing every key.
 *
 * Today it costs one extra hash per read. That asymmetry is the whole argument.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not stop us WITHHOLDING a record — we host the ciphertext, so we can
 * refuse to serve it (decision 0002). It does not stop us serving an OLD one;
 * that needs a commitment on chain. And it does not hide access patterns:
 * sizes, counts and timing are still ours to see. Each of those is a separate
 * piece of work, and none of them is fixed by encryption.
 *
 * What it does do is make it impossible for us — or anyone who reaches our
 * database — to read what is inside.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  seal, unseal, toHex, fromHex, utf8, canonical, parseCanonical, wrapKey, unwrapKey,
  type Sealed, type Hex,
} from './crypto.js';

/**
 * **WHAT A KEY IS FOR: THE ONE LIST.** Every other place that names a purpose
 * takes it from here (the wire's map of kinds to purposes included).
 *
 * Deliberately a closed list rather than a free string. A typo in a purpose
 * would silently derive a different key and produce a record nobody can open,
 * a failure that looks like corruption and is impossible to diagnose from the
 * data. The compiler is a better place to catch that than a support ticket.
 *
 * `people` holds the company's person records and `payroll` its runs, so a
 * reader can be given the one without the other.
 */
export const PURPOSES = Object.freeze([
  'roster', 'policy', 'payroll', 'people', 'inbox', 'proposals', 'vaults', 'one-offs', 'vendors', 'company-service',
] as const);
export type Purpose = (typeof PURPOSES)[number];
/** Whether `x` names one of the company's purposes. */
export const isPurpose = (x: string): x is Purpose => (PURPOSES as readonly string[]).includes(x);

/**
 * One key per purpose, derived from the account's viewing key.
 *
 * The account id is the salt, so two accounts never derive the same key even if
 * a viewing key were somehow reused. The purpose is the info parameter, which is
 * exactly what HKDF's info field is for: separating uses of one secret.
 *
 * HKDF rather than hashing them together by hand, because a hand-rolled
 * construction is the kind of thing that looks fine and is subtly wrong, and
 * `@noble/hashes` already ships the real one.
 */
export const purposeKey = (viewingKey: Hex, accountId: string, purpose: Purpose): Hex =>
  toHex(hkdf(sha256, fromHex(viewingKey), utf8(accountId), utf8(purpose), 32));

/**
 * **A HOLDER'S KEYS, BY PURPOSE: THE SEAM EVERY RECORD IS OPENED AND SEALED
 * THROUGH.** `keyFor` gives the key this holder holds for one purpose of one
 * company, or null when it holds none. A holder of the company key derives
 * every purpose (`purposeKeysOfTheCompanyKey`); a holder given only some
 * purposes answers null for the rest, and a record of those is refused here
 * rather than read.
 *
 * `formerKeyFor` is the key of the purpose a purpose's records were sealed
 * under before it had its own (a person's record under `payroll`, before
 * `people`). It opens such a record and never seals one. Only a holder of the
 * company key answers it, because only the company key derives that older
 * key: a holder given purposes by a grant has no such key, so a `payroll`
 * grant never opens a person.
 */
export interface PurposeKeys {
  readonly keyFor: (purpose: Purpose, accountId: string) => Hex | null;
  readonly formerKeyFor?: (purpose: Purpose, accountId: string) => Hex | null;
  /** Why no key is held for a purpose, where the holder knows more than that none was given; null otherwise. */
  readonly whyNone?: (purpose: Purpose, accountId: string) => string | null;
}

/** The purpose each purpose's records were sealed under before it had its own: read with, never sealed with. */
const SEALED_BEFORE_UNDER: Readonly<Partial<Record<Purpose, Purpose>>> = Object.freeze({ people: 'payroll' });

/** A company key, or a holder's keys by purpose: what every function here takes to seal or open a record. */
export type RecordsKey = Hex | PurposeKeys;

/** The keys by purpose of a holder of the company key (of one epoch): each derived from it by `purposeKey`. */
export const purposeKeysOfTheCompanyKey = (companyKey: Hex): PurposeKeys => ({
  keyFor: (purpose, accountId) => purposeKey(companyKey, accountId, purpose),
  formerKeyFor: (purpose, accountId) => {
    const before = SEALED_BEFORE_UNDER[purpose];
    return before === undefined ? null : purposeKey(companyKey, accountId, before);
  },
});

const heldAsPurposeKeys = (keys: RecordsKey): PurposeKeys => (typeof keys === 'string' ? purposeKeysOfTheCompanyKey(keys) : keys);

/**
 * The key `keys` holds for `purpose` of `accountId`, or a refusal naming what
 * would open it: a seat holding the company key, or a grant naming the purpose;
 * or, where the holder knows why it has none (`whyNone`), that reason.
 */
export const keyForThePurpose = (keys: RecordsKey, accountId: string, purpose: Purpose): Hex => {
  const held = heldAsPurposeKeys(keys);
  const key = held.keyFor(purpose, accountId);
  if (key === null) {
    throw new Error(held.whyNone?.(purpose, accountId) ?? (
      `this device holds no key for the "${purpose}" records of account ${accountId}, so none of them is read here. ` +
        'A seat holding the company key opens them, and so does a read grant that names this purpose.'));
  }
  return key;
};

/*
 * `canonical` comes from crypto.ts and is not written out again here; a second
 * copy would mis-serialise an absent optional field, and stable serialisation
 * is load-bearing for anything signed or committed.
 */

export const sealRecord = <T>(
  purpose: Purpose,
  accountId: string,
  value: T,
  keys: RecordsKey,
): Sealed => seal(canonical(value), keyForThePurpose(keys, accountId, purpose));

/**
 * Opens a record, or fails loudly. A holder with no key for the purpose is
 * refused before anything is tried (`keyForThePurpose`). A record that does not
 * open under the purpose's key is tried once more under the key of the purpose
 * it was sealed under before, when the holder answers one (`formerKeyFor`).
 *
 * A wrong key produces an authentication failure from AES-GCM rather than
 * plausible rubbish, which is the property worth having: **a record opened with
 * the wrong key must not silently look like data.** The message names the
 * likely causes, because the two that matter — wrong purpose, and a key that has
 * since been rotated — are indistinguishable from the ciphertext alone.
 */
export const openRecord = <T>(
  purpose: Purpose,
  accountId: string,
  sealed: Sealed,
  keys: RecordsKey,
): T => {
  const key = keyForThePurpose(keys, accountId, purpose);
  const former = heldAsPurposeKeys(keys).formerKeyFor?.(purpose, accountId) ?? null;
  for (const k of former === null ? [key] : [key, former]) {
    try {
      /*
       * `parseCanonical`, not `JSON.parse`.
       *
       * `sealRecord` writes with `canonical`, which encodes a bigint as
       * `{"$n":"…"}` because `JSON.stringify` cannot serialise one at all. A plain
       * parse would hand back that object where an amount belongs — and an object
       * in arithmetic is `NaN` or a concatenation, not an error. The two functions
       * are a pair and neither is correct alone.
       */
      return parseCanonical<T>(unseal(sealed, k));
    } catch {
      /* Not under this key: the next one is tried, and the refusal below is thrown when none opens it. */
    }
  }
  throw new Error(
    `this "${purpose}" record for account ${accountId} will not open with the key this device holds for it: it was ` +
      'sealed under another purpose, another account or the company key of another epoch, or it is damaged. ' +
      'A device that holds the key it was sealed under reads it; this one cannot.',
  );
};

/* ---------------- the account inbox ---------------- */

/*
 * A one-way drop box for people who hold no viewing key.
 *
 * THE PROBLEM IT SOLVES. Sealing a record needs the key. Some records are
 * written by people who must not have it — an invitee accepting a signer seat
 * sends their public halves before any existing signer has granted them
 * anything. So there are exactly two options: leave what they write in the
 * clear, or give them a way to write something only a key holder can read.
 *
 * An x25519 keypair whose SECRET is derived from the viewing key gives the
 * second. The public half is published on the account and is safe to publish —
 * it is a public key. Anyone at all may seal to it. Only somebody who can derive
 * the viewing key can open what they sealed.
 *
 * Nothing new: this is `wrapKey`/`unwrapKey`, which the viewing key already
 * travels through, pointed at a keypair the account derives instead of one a
 * device generated. The only new line is that any 32 bytes is a valid x25519
 * secret, so the purpose subkey can be used as one directly.
 */

/** The account's inbox secret: the key its holder holds for the `inbox` purpose. */
const inboxSecret = (keys: RecordsKey, accountId: string): Hex =>
  keyForThePurpose(keys, accountId, 'inbox');

/** The account's inbox public key. Safe to store and serve in the clear. */
export const inboxPublicKey = (keys: RecordsKey, accountId: string): Hex =>
  toHex(x25519.getPublicKey(fromHex(inboxSecret(keys, accountId))));

/** Seals a value into an account's inbox. Needs no viewing key — that is the point. */
export const sealToInbox = <T>(value: T, inboxPublicKey: Hex): { ephemeral: Hex } & Sealed =>
  wrapKey(canonical(value), inboxPublicKey);

/** Opens something posted into the inbox, with the key its holder holds for the `inbox` purpose. */
export const openFromInbox = <T>(
  sealed: { ephemeral: Hex } & Sealed,
  accountId: string,
  keys: RecordsKey,
): T => {
  const secret = inboxSecret(keys, accountId);
  try {
    // `sealToInbox` writes with `canonical`. See `openRecord` for why the parse
    // has to match the writer rather than being a plain `JSON.parse`.
    return parseCanonical<T>(unwrapKey(sealed, secret));
  } catch {
    throw new Error(
      `an inbox record for account ${accountId} will not open. It was sealed to a different ` +
        "account's inbox, or under a viewing key that has since been rotated.",
    );
  }
};

/**
 * A stored record, and the shape the database should hold.
 *
 * THE POINT OF THIS TYPE IS WHAT IT LEAVES OUT. There is no field for a name, a
 * salary or a policy, so writing one in the clear is not an oversight that
 * review has to catch — it does not compile. That is what makes the fix stay
 * fixed rather than get fixed once and drift back.
 *
 * The three fields that remain readable are Tier 4: an id to route on, an epoch
 * to know which key applies, and the wrapped keys, which are themselves useless
 * without a signer's own secret.
 */
export interface SealedRecord {
  id: string;
  /** Which viewing key this was sealed under. See `rotate`. */
  keyEpoch: number;
  sealed: Sealed;
}

/**
 * Re-seals every record under a new viewing key.
 *
 * Removing a signer does not un-teach them a key they already hold, so removal
 * means changing the locks. This is the pure half of that: the ordering — write
 * the new set, flip the epoch, then drop the old — belongs to the store, and is
 * the part that must never leave an account half-rotated.
 *
 * Returns records at `epoch + 1`. It does not delete anything, on purpose:
 * a caller that cannot write the new set must still have the old one.
 */
export const reseal = <T>(
  purpose: Purpose,
  accountId: string,
  records: SealedRecord[],
  from: RecordsKey,
  to: RecordsKey,
): SealedRecord[] =>
  records.map((r) => ({
    id: r.id,
    keyEpoch: r.keyEpoch + 1,
    sealed: sealRecord(purpose, accountId, openRecord<T>(purpose, accountId, r.sealed, from), to),
  }));

/**
 * Identifies which key a cache was built with, without revealing the key.
 *
 * The client cache is keyed by this, so a rotation orphans the old cache
 * instead of silently serving records that no longer match the account. Safe to
 * store in plaintext and safe to log: it is a hash of a hash.
 */
export const keyFingerprint = (viewingKey: Hex): string =>
  toHex(sha256(utf8('midnight-accounts:fingerprint:' + viewingKey))).slice(0, 16);
