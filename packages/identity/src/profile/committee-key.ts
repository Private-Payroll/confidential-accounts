import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type { SignatureVerifyingKey, SigningKey } from '@midnightntwrk/ledger-v9';
import { Purposes } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';

/**
 * THE KEY A PERSON SITS ON ONE COMPANY'S VAULT COMMITTEE WITH.
 *
 * A vault's maintenance authority is a list of signature keys and a threshold.
 * A maintenance update - replacing the committee, or the proofs the vault
 * accepts - is valid only when enough of those keys have signed it. Each
 * company signer contributes one key, and this file is where that key comes
 * from.
 *
 * **A PURE FUNCTION OF THE WORDS AND THE COMPANY'S ADDRESS.** A person who has
 * lost every device and kept their words derives the same key again. A person
 * who has lost their words cannot, and nothing can give it back: the remaining
 * signers replace them. In a company with one signer there are no remaining
 * signers, so a lost set of words is a vault whose rules can never change again.
 * Its money is not locked by that - paying out is the company's own threshold,
 * not the maintenance authority - but no new version of the vault's proofs can
 * ever be installed on it.
 *
 * **THE PARENT IS `Purposes.Maintenance` AND NOTHING ELSE.** Not the unlock
 * parent the company's page is given a key from, and not anything the records
 * key is expanded from, so a page holding every key it is ever released cannot
 * compute this one.
 *
 * **THE SECRET HALF NEVER LEAVES THE WALLET.** `committeeKeyFor` is the only
 * export that crosses a channel, and it is public.
 *
 * **AND THIS FILE LOADS NO WEBASSEMBLY.** A company's page reads a released
 * committee key through `unlock.ts`, and the page may not load the ledger. The
 * key is BIP-340 - the ledger's own `signingKeyFromBip340` and
 * `signatureVerifyingKey` give exactly these bytes, which the test beside this
 * file checks - so the arithmetic here is `@noble/curves`' and the ledger is
 * reached only for types.
 */

/* The domain of this expansion. The day it changes, every company's committee
 * changes with it, which is a replacement on every vault and never a patch. */
const COMMITTEE_SALT = new TextEncoder().encode('midnight-identity/vault-committee/v1');

/** One parent, one job. */
const COMMITTEE_PARENT_INDEX = 0;

const COMPANY_ADDRESS = /^[0-9a-f]{64}$/u;

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

/**
 * How many expansions are tried before giving up. A BIP-340 secret must be a
 * non-zero number below the curve order, and a uniformly random 32-byte value
 * misses that with a probability near 2^-128; the counter exists so the
 * function is total rather than because a second try is expected.
 */
const TRIES = 4;

export class CommitteeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeKeyError';
  }
}

const companyOf = (company: string): string => {
  const folded = typeof company === 'string' ? company.toLowerCase() : '';
  if (!COMPANY_ADDRESS.test(folded)) {
    throw new CommitteeKeyError(
      'a committee key belongs to one company, named by its own sixty-four character address '
      + 'on the chain, and what was given is not one. No key was derived.');
  }
  return folded;
};

/**
 * THE SECRET HALF. **Used inside the wallet only**, to sign a maintenance update
 * a person has approved on its own screen.
 */
export function committeeSigningKeyFor(identity: Identity, company: string): SigningKey {
  const address = companyOf(company);
  const parent = identity.authority(Purposes.Maintenance, COMMITTEE_PARENT_INDEX);
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const info = new TextEncoder().encode(attempt === 0 ? address : `${address}/${attempt}`);
    const bytes = hkdf(sha256, parent, COMMITTEE_SALT, info, 32);
    if (secp256k1.utils.isValidSecretKey(bytes)) {
      return { tag: 'schnorr', value: toHex(bytes) } as SigningKey;
    }
    /* outside the curve order; the next expansion is independent of this one */
  }
  throw new CommitteeKeyError(
    'this wallet could not derive a committee key for that company. Nothing was given.');
}

/** THE PUBLIC HALF, which is what a vault's committee lists. */
export function committeeKeyFor(identity: Identity, company: string): SignatureVerifyingKey {
  const secret = fromHex(committeeSigningKeyFor(identity, company).value);
  return Object.freeze({ tag: 'schnorr', value: toHex(schnorr.getPublicKey(secret)) }) as SignatureVerifyingKey;
}

/**
 * THE SHAPE OF A COMMITTEE KEY ON A WIRE, read by whoever receives one. A tag
 * the ledger names and thirty-two bytes of lower-case hex; anything else is
 * refused.
 */
export function readCommitteeKey(value: unknown): SignatureVerifyingKey | null {
  if (typeof value !== 'object' || value === null) return null;
  const { tag, value: key } = value as { tag?: unknown; value?: unknown };
  /* The only kind this wallet derives. A committee key of another kind did not
   * come from here. */
  if (tag !== 'schnorr') return null;
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/u.test(key)) return null;
  return Object.freeze({ tag, value: key }) as SignatureVerifyingKey;
}
