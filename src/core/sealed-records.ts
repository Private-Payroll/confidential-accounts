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
 * refuse to serve it (decision 0002, S-7). It does not stop us serving an OLD
 * one; that needs a commitment on chain. And it does not hide access
 * patterns: sizes, counts and timing are still ours to see. Each of those is a
 * separate piece of work, and none of them is fixed by encryption.
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
 * What a key is for.
 *
 * Deliberately a closed list rather than a free string. A typo in a purpose
 * would silently derive a different key and produce a record nobody can open —
 * a failure that looks like corruption and is impossible to diagnose from the
 * data. The compiler is a better place to catch that than a support ticket.
 */
export type Purpose = 'roster' | 'policy' | 'payroll' | 'audit' | 'inbox' | 'proposals';

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

/*
 * `canonical` comes from crypto.ts. It used to be written out a second time
 * here, which is the ninth-and-tenth instance of this project's recurring
 * failure — one rule in two places, and this pair had genuinely drifted: the
 * crypto.ts copy mis-serialises an absent optional field. Stable serialisation
 * is load-bearing for anything signed or committed, so a private near-copy was
 * the worst possible thing to duplicate.
 */

export const sealRecord = <T>(
  purpose: Purpose,
  accountId: string,
  value: T,
  viewingKey: Hex,
): Sealed => seal(canonical(value), purposeKey(viewingKey, accountId, purpose));

/**
 * Opens a record, or fails loudly.
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
  viewingKey: Hex,
): T => {
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
    return parseCanonical<T>(unseal(sealed, purposeKey(viewingKey, accountId, purpose)));
  } catch {
    throw new Error(
      `this "${purpose}" record for account ${accountId} will not open. ` +
        'Either it belongs to a different purpose, or it was sealed under a viewing key ' +
        'that has since been rotated — check the key epoch before assuming corruption.',
    );
  }
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

/** The account's inbox secret. Derivable only from the viewing key. */
const inboxSecret = (viewingKey: Hex, accountId: string): Hex =>
  purposeKey(viewingKey, accountId, 'inbox');

/** The account's inbox public key. Safe to store and serve in the clear. */
export const inboxPublicKey = (viewingKey: Hex, accountId: string): Hex =>
  toHex(x25519.getPublicKey(fromHex(inboxSecret(viewingKey, accountId))));

/** Seals a value into an account's inbox. Needs no viewing key — that is the point. */
export const sealToInbox = <T>(value: T, inboxPublicKey: Hex): { ephemeral: Hex } & Sealed =>
  wrapKey(canonical(value), inboxPublicKey);

/** Opens something posted into the inbox. Needs the viewing key, and nothing else does. */
export const openFromInbox = <T>(
  sealed: { ephemeral: Hex } & Sealed,
  accountId: string,
  viewingKey: Hex,
): T => {
  try {
    // `sealToInbox` writes with `canonical`. See `openRecord` for why the parse
    // has to match the writer rather than being a plain `JSON.parse`.
    return parseCanonical<T>(unwrapKey(sealed, inboxSecret(viewingKey, accountId)));
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
 * review has to catch — it does not compile. That is what makes S-8 and S-9 stay
 * fixed rather than get fixed once and drift back.
 *
 * The three fields that remain readable are Tier 4: an id to route on, an epoch
 * to know which key applies, and the wrapped keys, which are themselves useless
 * without a signer's own secret.
 */
export interface SealedRecord {
  id: string;
  /** Which viewing key this was sealed under. See `rotate` in K-4. */
  keyEpoch: number;
  sealed: Sealed;
}

/**
 * Re-seals every record under a new viewing key. K-4.
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
  from: Hex,
  to: Hex,
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
