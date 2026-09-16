/**
 * **A VAULT'S NONCE SECRET: THE COMPANY'S, OPENED BY ANY SIGNER WITH THEIR OWN
 * RECOVERY WORDS, ROTATED WHEN A SIGNER LEAVES, AND NEVER FORGETTING AN EPOCH.**
 *
 * A private deposit's nonce is derived from a secret (`deposit-nonce.ts`), and
 * whoever holds the secret and the company's own amounts can name every coin
 * the vault ever made (`rebuild-from-records.ts`). So the secret decides who can
 * rebuild a vault, and it has to meet one test:
 *
 *   **any one signer, holding only their own recovery words, can name every
 *   coin the vault holds.**
 *
 * ------------------------------------------------------------------------
 * **ONE SECRET PER EPOCH, WRAPPED TO EVERY SIGNER.**
 *
 * The secret is thirty-two random bytes made once, when the vault's record of
 * it is started, and it belongs to nobody in particular. It is wrapped to each
 * signer separately, the way a vault's note pool is, so any one of them opens
 * it and nobody's departure takes it away.
 *
 * **WRAPPED TO A KEY EACH SIGNER DERIVES, NOT TO THE KEY THE POOL USES.** A
 * signer's pool key is random and kept in their saved keys, which live on this
 * product's server; a copy wrapped to it opens only while that server does. So
 * each copy here is wrapped to a key the signer works out from the key their
 * wallet releases for this company (`recordsKeypairFrom`), which is a pure
 * function of their recovery words and the company's address: no device, no
 * saved keys and no server is needed to work it out again. Copies are found by
 * that public key, never by an identifier this product mints.
 *
 * **A NEW EPOCH FOR A SIGNER LEAVING, AND EVERY EARLIER EPOCH KEPT.** A signer who
 * leaves remembers every secret they could open, and could go on confirming a
 * guessed amount against deposits made under them; that is accepted. What they
 * must not have is the secret deposits are made under from then on. So
 * `rotateNonceSecret` starts a new epoch with a new secret, wrapped to the
 * signers who remain, and
 * the record carries every earlier secret sealed under the new one: old
 * deposits keep their names, and anybody who can open the newest epoch can
 * name every coin the vault ever made. A new signer is given the current
 * epoch, and with it every earlier one (`admitToNonceSecret`). These are the
 * operations a signer's device runs when somebody leaves or joins; the screens
 * that run them are not built yet.
 *
 * **WHAT THE RECORD SAYS ABOUT ITSELF IS SEALED INSIDE IT.** The vault, the
 * version and the epoch are part of the sealed body and are checked when it is
 * opened, so a record moved to another vault or presented as another version
 * does not open as one. Each copy is checked against the body it opens, and the
 * newest secret must be the one the copy carried.
 *
 * ------------------------------------------------------------------------
 * **WHERE THE WRAPPED COPIES LIVE DECIDES WHETHER THE TEST IS MET.** A signer
 * who has only their words and the public chain can learn the secret only if
 * something public and lasting holds a copy of it sealed to a key their words
 * derive: the secret is random and shared, so it is not a function of any one
 * person's words. This record is written in the shape a sealed record already
 * travels in, and it is kept wherever it is filed. Filed only with this
 * product, it opens only while this product keeps it.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  seal, unseal, wrapKey, unwrapKey, canonical, fromHex, toHex, utf8, randomBytes,
  type Hex, type WrappingKeypair,
} from '../core/crypto.js';
import { paddedToABucket, type SealedPool } from './vault-pool.js';
import { depositNonceKeyFor, type DepositNonceKey } from './deposit-nonce.js';

const KEY_BYTES = 32;
const HEX32 = /^[0-9a-f]{64}$/u;

/*
 * The domains. The day either changes, every copy wrapped or sealed under the
 * old one stops opening, so a change is a migration and never a patch.
 */
const RECORDS_WRAPPING_SALT = utf8('confidential-accounts/company-records-wrapping/v1');
const SEAL_SALT = utf8('confidential-accounts/nonce-secret-seal/v1');

/** The record kind, as the store and the wire name it. */
export const NONCE_SECRET_RECORD = 'nonce-secret' as const;

/**
 * **A SIGNER'S KEY FOR THE COMPANY'S RECORDS, FROM THE KEY THEIR WALLET RELEASES
 * FOR THIS COMPANY AND FROM NOTHING ELSE.**
 *
 * The released key is thirty-two bytes, a pure function of the person's
 * recovery words and the company's address. This expands it under a domain of
 * its own, so it is neither the released key nor the payslip key derived from
 * the same bytes: holding one is not holding another.
 */
export function recordsKeypairFrom(releasedCompanyKey: Uint8Array): WrappingKeypair {
  if (!(releasedCompanyKey instanceof Uint8Array) || releasedCompanyKey.length !== KEY_BYTES) {
    throw new Error(
      `a signer's records key is derived from the ${KEY_BYTES}-byte key their wallet releases for the `
      + 'company, and this is not one. Nothing is derived. Unlock the company with the wallet again.');
  }
  if (releasedCompanyKey.every((b) => b === 0)) {
    throw new Error('the key a records key would be derived from is all zeros, which is no secret. Nothing is derived.');
  }
  const secret = hkdf(sha256, releasedCompanyKey, RECORDS_WRAPPING_SALT, new Uint8Array(0), KEY_BYTES);
  return { secret: toHex(secret), publicKey: toHex(x25519.getPublicKey(secret)) };
}

/** A signer as this record needs them: the public half of their records key. */
export interface NonceSecretReader {
  readonly publicKey: Hex;
}

/** What a signer opens a record with: their records keypair. */
export type NonceSecretOpener = WrappingKeypair;

/** What a record opens to. */
export interface OpenedNonceSecrets {
  readonly vault: string;
  readonly version: number;
  /** The newest epoch this reader was given. */
  readonly epoch: number;
  /** One secret per epoch, oldest first; the last is the epoch deposits are made under now. */
  readonly secrets: readonly Hex[];
  /** Who the opened version is wrapped to, by records public key. */
  readonly readers: readonly Hex[];
}

interface Body {
  readonly record: typeof NONCE_SECRET_RECORD;
  readonly vault: string;
  readonly version: number;
  readonly epoch: number;
  readonly secrets: readonly Hex[];
}

/** Thrown for a record that does not open as what it says it is. Nothing is derived from it. */
export class NonceSecretUnreadable extends Error {
  constructor(why: string) {
    super(
      `this vault's nonce secret could not be opened: ${why}. No deposit is made and nothing is `
      + 'named from it. This is not a vault with no secret: a record that does not open is refused, '
      + 'never replaced.');
    this.name = 'NonceSecretUnreadable';
  }
}

const vaultOf = (vault: string): string => {
  if (typeof vault !== 'string' || !HEX32.test(vault)) {
    throw new Error('a nonce secret belongs to a vault named as 64 lower-case hex characters, and this is not one.');
  }
  return vault;
};

const publicKeyOf = (r: NonceSecretReader): Hex => {
  if (typeof r?.publicKey !== 'string' || !HEX32.test(r.publicKey)) {
    throw new Error('a signer is given a copy of the nonce secret by the public half of their records key, and this is not one.');
  }
  return r.publicKey;
};

const sealKeyOf = (secret: Hex): Hex => toHex(hkdf(sha256, fromHex(secret), SEAL_SALT, new Uint8Array(0), KEY_BYTES));

const newSecret = (): Hex => {
  for (;;) {
    const s = randomBytes(KEY_BYTES);
    if (!s.every((b) => b === 0)) return toHex(s);
  }
};

const build = (body: Body, readers: readonly Hex[]): SealedPool => {
  if (readers.length === 0) {
    throw new Error(
      'a nonce secret wrapped to nobody is a secret no device anywhere can open, and every deposit '
      + 'made under it would be nameable by no one. Nothing is written.');
  }
  const current = body.secrets[body.secrets.length - 1]!;
  const distinct = [...new Set(readers)];
  return {
    vault: body.vault,
    version: body.version,
    /* Padded, so its length does not say how many epochs there have been. */
    sealed: seal(paddedToABucket(canonical(body)), sealKeyOf(current)),
    wrapped: distinct.map((pk) => ({ signerId: pk, wrapped: wrapKey(current, pk) })),
  };
};

/**
 * **THE FIRST RECORD OF A VAULT'S NONCE SECRET**: epoch 1, version 1, wrapped
 * to every signer given.
 */
export const startNonceSecret = (vault: string, readers: readonly NonceSecretReader[]): SealedPool =>
  build({ record: NONCE_SECRET_RECORD, vault: vaultOf(vault), version: 1, epoch: 1, secrets: [newSecret()] },
    readers.map(publicKeyOf));

/**
 * **OPENS A RECORD WITH ONE SIGNER'S RECORDS KEY**, and checks that it is what
 * it says it is: the vault asked for, the version it is filed as, one secret per
 * epoch, and the newest secret the one the copy carried.
 */
export const openNonceSecrets = (rec: SealedPool, vault: string, me: NonceSecretOpener): OpenedNonceSecrets => {
  const expected = vaultOf(vault);
  if (rec?.vault !== expected) throw new NonceSecretUnreadable('it is filed for a different vault than the one asked for');
  if (typeof me?.secret !== 'string' || !HEX32.test(me.secret)) {
    throw new NonceSecretUnreadable('the key it was opened with is not a records key');
  }
  const mine = toHex(x25519.getPublicKey(fromHex(me.secret)));
  if (me.publicKey !== mine) throw new NonceSecretUnreadable('the records key given does not match its own public half');
  const copy = rec.wrapped.find((w) => w.signerId === mine);
  if (!copy) {
    throw new NonceSecretUnreadable(
      'no copy is wrapped to this signer\x27s records key. They were added after this version was '
      + 'written, or they left before it; any signer who can open it can give them a copy');
  }
  let current: string;
  let body: Body;
  try {
    current = unwrapKey(copy.wrapped, me.secret);
  } catch {
    throw new NonceSecretUnreadable('this signer\x27s copy would not unwrap with their records key');
  }
  if (!HEX32.test(current)) throw new NonceSecretUnreadable('the copy did not hold a secret');
  try {
    body = JSON.parse(unseal(rec.sealed, sealKeyOf(current))) as Body;
  } catch {
    throw new NonceSecretUnreadable('the copy opened but the record it belongs to did not');
  }
  if (body?.record !== NONCE_SECRET_RECORD) throw new NonceSecretUnreadable('what is sealed inside is not a nonce secret');
  if (body.vault !== expected) throw new NonceSecretUnreadable('what is sealed inside names a different vault');
  if (body.version !== rec.version) {
    throw new NonceSecretUnreadable(`it is filed as version ${rec.version} and what is sealed inside says ${JSON.stringify(body.version)}`);
  }
  if (!Array.isArray(body.secrets) || !Number.isInteger(body.epoch) || body.epoch < 1
    || body.secrets.length !== body.epoch || !body.secrets.every((s) => typeof s === 'string' && HEX32.test(s))) {
    throw new NonceSecretUnreadable('what is sealed inside is not one secret per epoch');
  }
  if (body.secrets[body.secrets.length - 1] !== current) {
    throw new NonceSecretUnreadable('the copy carried a secret that is not the one this record is sealed under');
  }
  return {
    vault: body.vault, version: body.version, epoch: body.epoch,
    secrets: [...body.secrets], readers: rec.wrapped.map((w) => w.signerId),
  };
};

/**
 * **GIVES SIGNERS A COPY OF THE CURRENT EPOCH**, as the next version. Nothing
 * about the secret changes, and nobody who could open it loses their copy.
 */
export const admitToNonceSecret = (
  rec: SealedPool, vault: string, by: NonceSecretOpener, added: readonly NonceSecretReader[],
): SealedPool => {
  const opened = openNonceSecrets(rec, vault, by);
  return build(
    { record: NONCE_SECRET_RECORD, vault: opened.vault, version: opened.version + 1, epoch: opened.epoch, secrets: opened.secrets },
    [...opened.readers, ...added.map(publicKeyOf)]);
};

/**
 * **STARTS A NEW EPOCH BECAUSE SIGNERS ARE LEAVING**, as the next version,
 * wrapped to the signers who remain and carrying every earlier secret.
 *
 * Every signer the current version is wrapped to must be named, either as
 * remaining or as leaving, so a rotation never drops somebody it was not told
 * about. Somebody who is leaving keeps what they already had and gets nothing
 * made from here on.
 */
export const rotateNonceSecret = (
  rec: SealedPool, vault: string, by: NonceSecretOpener,
  who: { readonly remaining: readonly NonceSecretReader[]; readonly leaving: readonly NonceSecretReader[] },
): SealedPool => {
  const opened = openNonceSecrets(rec, vault, by);
  const remaining = new Set(who.remaining.map(publicKeyOf));
  const leaving = new Set(who.leaving.map(publicKeyOf));
  for (const pk of leaving) {
    if (remaining.has(pk)) throw new Error('a signer cannot be both leaving and remaining. Nothing is written.');
  }
  if (leaving.size === 0) {
    throw new Error('a new epoch is started because somebody is leaving, and nobody is named as leaving. Nothing is written.');
  }
  const unnamed = opened.readers.filter((pk) => !remaining.has(pk) && !leaving.has(pk));
  if (unnamed.length > 0) {
    throw new Error(
      `${unnamed.length} signer(s) can open the current epoch and are named neither as remaining nor as `
      + 'leaving. A new epoch wrapped without them would take their access away without anybody '
      + 'deciding it. Nothing is written. Name every signer.');
  }
  return build(
    {
      record: NONCE_SECRET_RECORD, vault: opened.vault, version: opened.version + 1,
      epoch: opened.epoch + 1, secrets: [...opened.secrets, newSecret()],
    },
    [...remaining]);
};

/**
 * **THE KEYS A VAULT'S DEPOSITS ARE NAMED WITH**: one per epoch, oldest first.
 * The last is the one a deposit is made under now.
 */
export const depositNonceKeysOf = (opened: OpenedNonceSecrets): readonly DepositNonceKey[] =>
  opened.secrets.map((s) => depositNonceKeyFor(fromHex(s), opened.vault));

/** The key a deposit is made under now. */
export const currentDepositNonceKey = (opened: OpenedNonceSecrets): DepositNonceKey =>
  depositNonceKeyFor(fromHex(opened.secrets[opened.secrets.length - 1]!), opened.vault);

/**
 * **THE NEWEST VERSION THIS SIGNER CAN OPEN, FROM EVERY VERSION FILED.**
 *
 * A signer who left can open only the versions before they left, and that is
 * the whole of what they keep. Everybody else opens the newest. A version this
 * signer has no copy in is skipped; a version they do have a copy in that does
 * not open is refused, because it is not theirs to guess past.
 */
export const openNewestNonceSecrets = (
  versions: readonly { readonly version: number; readonly sealed: SealedPool }[],
  vault: string, me: NonceSecretOpener,
): OpenedNonceSecrets => {
  const mine = toHex(x25519.getPublicKey(fromHex(me.secret)));
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const v = versions[i]!;
    if (!v.sealed.wrapped.some((w) => w.signerId === mine)) continue;
    return openNonceSecrets(v.sealed, vault, me);
  }
  throw new NonceSecretUnreadable('no version filed for this vault has a copy for this signer');
};
