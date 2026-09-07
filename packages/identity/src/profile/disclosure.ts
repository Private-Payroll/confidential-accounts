/* `:101` mints a signing key and `:192` encodes an unshielded
 * address, and both used the BARE GLOBAL `Buffer`. Node has one; a browser
 * does not, so both entry points that reach this file — `midnight-identity`
 * and `midnight-identity/profile/disclosure` — threw `ReferenceError` in a
 * browser unless the consumer had already loaded `midnight-identity/browser`,
 * which nothing in this file's import graph does.
 *
 * THE SPECIFIER IS BARE `'buffer'` ON PURPOSE, and it is the same one
 * `browser/buffer.ts:1` uses. In Node it resolves to the builtin; under a
 * bundler it resolves to the `buffer` package, which is already a declared
 * runtime DEPENDENCY (`package.json`). So the right object arrives in each
 * runtime without this file knowing which one it is in.
 *
 * THIS DOES NOT REPLACE `ensureBuffer()` AND MUST NOT BE READ AS DOING SO.
 * That function exists because the SDK's address-format package
 * reaches for the GLOBAL, which no import here can supply; `app/main.tsx` and
 * `app/probe.ts` still CALL it, and a called function cannot be tree-shaken.
 * This import fixes only the two sites below. */
import { Buffer } from 'buffer';
import {
  addressFromKey, signData, signatureVerifyingKey, verifySignature,
} from '@midnightntwrk/ledger-v9';
import type { Signature, SignatureVerifyingKey, SigningKey } from '@midnightntwrk/ledger-v9';
import { UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';
import type { Identity } from '../keys/derivation.js';
import { RESPONSE_SCHEMA, preimage, readPreimage } from './payload.js';
import type { DisclosurePayload } from './payload.js';
import type { AttributeName } from './definition.js';
import type { Disclosure, Sent } from './model.js';

/**
 * THE SIGNATURE, AND WHICH KEY MAKES IT.
 *
 * §9 leaves this open, with the reasoning owed. Here it is.
 *
 * ── THE DECISION ──────────────────────────────────────────────────────────
 * **A disclosure is signed by the SUBWALLET'S OWN UNSHIELDED (NIGHT) KEY**,
 * through the SDK's own `createKeystore({ kind: 'schnorr' })` path — the same
 * key, the same kind and the same code that already produce the address that
 * subwallet is paid at (`apps/wallet/src/chain/unshielded.ts:51-59`).
 *
 * ── WHY NOT `Purposes.Seat`, WHICH IS THE OTHER CANDIDATE ─────────────────
 * 1. **A Seat key cannot make the statement the recipient needs.** What payroll
 *    needs to believe is *the person who owns the address I am about to pay
 *    told me these facts* (§7 step 6). A Seat key signing a payload that NAMES
 *    an address proves only that whoever holds that Seat key claims the
 *    address. Anybody can claim an address. Only a key that controls the
 *    address can tie the details to the payee, and that is the entire point of
 *    the flow.
 * 2. **Seat's unlinkability is already bought, and by the subwallet.** §7
 *    step 2 has the person choose a slot per employer, and each slot has its
 *    own address. The recipient already holds that address. A separate
 *    unlinkable signing key adds no unlinkability the address has not already
 *    spent.
 * 3. **The verifier does not have to trust the payload's address.** It
 *    recomputes it from the verifying key — `addressOfVerifyingKey` below — so
 *    `payload.address` is a convenience and never an authority.
 *
 * ── WHAT IT COSTS, SAID RATHER THAN LEFT TO BE FOUND ──────────────────────
 * - **Eleven slots is the ceiling on distinct signing keys.** `subwallets.ts`
 *   offers accounts 0 and 2–11. `Purposes.Seat` has no ceiling. Two recipients
 *   paid by the SAME subwallet see the same key — which they would anyway,
 *   having the same address, but it is a real limit and it is the reason to
 *   revisit this if a person ever needs more relationships than slots.
 * - **`Purposes.Seat` is therefore still unused by any shipped code**, and this
 *   change did not remove it. It is the right key for a credential that proves
 *   membership without naming a payee, which is a different job.
 * - **This signs with a SPENDING key, and the SDK warns against exactly that.**
 *   `ledger-v9.d.ts:447`: *"WARNING: Do not expose access to this function for
 *   valuable keys for data that is not strictly controlled!"* Strict control
 *   here is structural, not a comment:
 *     · `mint` takes a payload STRUCT. **There is no exported function anywhere
 *       in this module that signs caller-supplied bytes**, so there is no path
 *       from a requester's message to `signData`.
 *     · the preimage begins with a domain tag no ledger signing envelope begins
 *       with — MEASURED against the SDK at run time in `disclosure.test.ts`,
 *       not asserted (`payload.ts`'s header has the measurements).
 *     · every disclosure is approved by a person, every time, per value (§6).
 *   **What it does NOT do is prove that no ledger-signable byte string could
 *   ever begin with our tag.** It proves that none of the three the shipped SDK
 *   produces does. That gap is named in the entry rather than papered over.
 */

/** The scheme the SDK's own NIGHT path uses. `unshielded.ts:53-54`. */
const KIND = 'schnorr' as const;

export const DISCLOSURE_SCHEMES = ['schnorr'] as const;

/**
 * WHAT CROSSES BACK. §5.2.
 *
 * **`scheme` IS REQUIRED HERE AND THE CONNECTOR'S IS NOT**, which is worth a
 * line because it is the same field. `dapp-connector-api/dist/api.d.ts:305`
 * declares `scheme?: 'ecdsa_secp256k1_sha256' | 'schnorr_bip340'` and says in
 * its own comment that an omitted value *"must be interpreted as being produced
 * with the `schnorr_bip340` scheme, which is the default"*. **Reading a default
 * as a mechanism is a trap.** An absent field and a stated one are different
 * facts, and a verifier that assumes one when it sees the other is a verifier
 * that can be told what to assume. Ours is always stated.
 */
export interface DisclosureResponse {
  readonly payload: DisclosurePayload;
  readonly scheme: (typeof DISCLOSURE_SCHEMES)[number];
  /** Hex, as the ledger spells it. */
  readonly signature: string;
  readonly verifyingKey: string;
  /**
   * The requester's own words about itself, returned unchanged and **outside
   * the signature on purpose** — `payload.ts` says why: the wallet verified
   * neither and must not appear to attest to them.
   */
  readonly requesterSaidItWas: { readonly name: string; readonly rdns: string };
}

/* -------------------------------- minting -------------------------------- */

const signingKeyFor = (identity: Identity, subwallet: number): SigningKey => ({
  tag: KIND,
  value: Buffer.from(identity.moneyAt(subwallet).night).toString('hex'),
});

/**
 * WHAT `mint` HANDS BACK — two things, and they go to two different places.
 *
 * **`response` CROSSES TO THE REQUESTER. `signedBytes` NEVER DOES.**
 * THE DESIGN asks the history entry to keep the exact bytes
 * that were signed, and the obvious shortcut — putting them on the wire beside
 * the payload — is the one thing that must not happen: **a recipient handed
 * both would be free to verify the signature against the BYTES rather than
 * against the payload, and a payload that agrees with itself is exactly what a
 * forged one looks like.** `verify` below always recomputes the preimage from
 * `payload`; the bytes are for the wallet's own record and for nothing else.
 *
 * They are base64url rather than a `Uint8Array` because the only thing that
 * ever holds them is a `Disclosure`, and a `Disclosure` is JSON inside the
 * sealed blob. A hash of them is `sha256(fromBase64Url(bytes))`.
 */
export interface Minted {
  readonly response: DisclosureResponse;
  readonly signedBytes: string;
}

/**
 * MINT A DISCLOSURE. The only thing in this repository that signs one.
 *
 * `at` is passed in rather than read off the clock so the caller — the approval
 * screen — owns the moment, and so a test can hold it still. The wallet's own
 * clock is what fills it; nothing from the request reaches this field.
 *
 * It returns the bytes it signed as well as the message it built. **The
 * bytes are the ones that went into `signData`, not a second call to
 * `preimage`** — the whole value of §5.5's field is that nothing rebuilds it.
 */
export function mint(
  identity: Identity, subwallet: number,
  parts: {
    readonly origin: string;
    readonly nonce: string;
    readonly address: string;
    readonly at: number;
    readonly disclosed: readonly Sent[];
    readonly declined: readonly AttributeName[];
    readonly requesterSaidItWas: { readonly name: string; readonly rdns: string };
  },
): Minted {
  const payload: DisclosurePayload = Object.freeze({
    schema: RESPONSE_SCHEMA,
    origin: parts.origin,
    nonce: parts.nonce,
    address: parts.address,
    at: parts.at,
    disclosed: Object.freeze([...parts.disclosed]),
    declined: Object.freeze([...parts.declined]),
  });
  const key = signingKeyFor(identity, subwallet);
  /* ONE CALL, ONE BUFFER. What is signed and what is kept are the same bytes,
   * by being the same variable — §5.5's field is worth nothing if the record
   * holds a second serialisation that merely ought to match. */
  const bytes = preimage(payload);
  const signature: Signature = signData(key, bytes as Uint8Array<ArrayBuffer>);
  const verifying: SignatureVerifyingKey = signatureVerifyingKey(key);
  return Object.freeze({
    response: Object.freeze({
      payload,
      scheme: KIND,
      signature: signature.value,
      verifyingKey: verifying.value,
      requesterSaidItWas: Object.freeze({ ...parts.requesterSaidItWas }),
    }),
    signedBytes: toBase64Url(bytes),
  });
}

/* ------------------------------- verifying ------------------------------- */

/**
 * THE ADDRESS A VERIFYING KEY BELONGS TO — recomputed, never read.
 *
 * The path is the SDK's own, taken apart from `createKeystore`
 * (`wallet-sdk-unshielded-wallet/dist/KeyStore.js:31-37`): the address is
 * `addressFromKey(getPublicKey())`, and the bech32 is that address's bytes
 * through `UnshieldedAddress.codec.encode(networkId, …)`. This function walks
 * the same two steps from a bare verifying key, which is all a recipient has.
 */
export function addressOfVerifyingKey(
  verifyingKey: string, networkId: Parameters<typeof UnshieldedAddress.codec.encode>[0],
): string {
  const hex = addressFromKey({ tag: KIND, value: verifyingKey });
  return UnshieldedAddress.codec
    .encode(networkId, new UnshieldedAddress(Buffer.from(hex, 'hex')))
    .asString();
}

export type VerdictFailure =
  | 'wrong-schema'
  | 'origin-mismatch'
  | 'nonce-mismatch'
  | 'address-mismatch'
  | 'signature-invalid'
  | 'expired-claim';

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: VerdictFailure; readonly says: string };

/**
 * **THE CHECK THAT MAKES A REPLAY IMPOSSIBLE, AND IT BELONGS TO THE RECIPIENT.**
 *
 * It ships here so that the thing the payroll product will run is the thing this
 * change tested, rather than a description of it — and so that
 * `disclosure.test.ts` can show a disclosure minted for origin A being REFUSED
 * at origin B, which is what this change ends with.
 *
 * `atOrigin` is the recipient's OWN origin, and `expectingNonce` the nonce the
 * recipient itself issued. Neither is read out of the payload. **A verifier that
 * took either from the payload would verify that the payload agrees with
 * itself**, which is what a replay looks like.
 */
export function verify(
  response: DisclosureResponse,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    /** The address the recipient is about to pay. Bech32, as a wallet shows it. */
    readonly payingAddress: string;
    readonly networkId: Parameters<typeof UnshieldedAddress.codec.encode>[0];
    /** Now, so an issued claim's expiry can be judged. */
    readonly now: number;
  },
): Verdict {
  const { payload } = response;
  if (payload?.schema !== RESPONSE_SCHEMA) {
    return { ok: false, code: 'wrong-schema', says: 'that is not a disclosure response.' };
  }
  if (payload.origin !== expecting.atOrigin) {
    return {
      ok: false,
      code: 'origin-mismatch',
      says: `this disclosure was made for ${payload.origin} and was received at `
        + `${expecting.atOrigin}. It belongs to somebody else and is refused.`,
    };
  }
  if (payload.nonce !== expecting.expectingNonce) {
    return {
      ok: false,
      code: 'nonce-mismatch',
      says: 'this disclosure answers a different request from the one that is open.',
    };
  }
  let derived: string;
  try {
    derived = addressOfVerifyingKey(response.verifyingKey, expecting.networkId);
  } catch {
    return {
      ok: false, code: 'signature-invalid', says: 'the verifying key is not a usable one.',
    };
  }
  if (derived !== expecting.payingAddress) {
    return {
      ok: false,
      code: 'address-mismatch',
      says: `this disclosure was signed by the owner of ${derived}, and the address about `
        + `to be paid is ${expecting.payingAddress}. They are not the same person.`,
    };
  }
  let good = false;
  try {
    good = verifySignature(
      { tag: KIND, value: response.verifyingKey },
      preimage(payload) as Uint8Array<ArrayBuffer>,
      { tag: KIND, value: response.signature });
  } catch {
    good = false;
  }
  if (!good) {
    return {
      ok: false,
      code: 'signature-invalid',
      says: 'the signature does not match what was sent. Something changed on the way.',
    };
  }
  for (const sent of payload.disclosed) {
    if (sent.asserted.by === 'issuer' && sent.asserted.expiresAt !== null
      && expecting.now >= sent.asserted.expiresAt) {
      return {
        ok: false,
        code: 'expired-claim',
        says: `the proof about ${sent.about} expired on `
          + `${new Date(sent.asserted.expiresAt).toISOString().slice(0, 10)}. It is not `
          + 'evidence today.',
      };
    }
  }
  return { ok: true };
}

/* ---------------------- reading a recorded one back ---------------------- */

export type RecheckFailure =
  | 'no-bytes-recorded'
  | 'bytes-unreadable'
  | 'signature-invalid'
  | 'fields-disagree';

export type Recheck =
  | { readonly ok: true; readonly payload: DisclosurePayload }
  | { readonly ok: false; readonly code: RecheckFailure; readonly says: string };

/**
 * **THE CHECK THAT MAKES §5.5's STORED BYTES WORTH STORING.**
 *
 * The condition: *a stored blob nobody checks is decoration*, and *if the
 * stored bytes and the stored fields can disagree, the entry is worse than not
 * having them.* This is what stops them disagreeing, and it is three steps
 * rather than one:
 *
 *   1. the bytes DECODE — they are a payload, whole, with nothing trailing;
 *   2. the SIGNATURE verifies over them, under the key recorded beside them;
 *   3. what comes OUT of them equals the fields stored next to them.
 *
 * Step 2 is what a flipped byte dies on. **Step 3 is what a re-serialisation
 * dies on** — bytes that are a valid, correctly-signed payload of something
 * else entirely would pass 1 and 2 and fail here.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: the origin and the address. Those are in
 * the decoded payload and a caller can read them, but this function is about
 * whether the ENTRY is internally honest, not about whether some other party
 * should accept it. `verify` is the other question and takes the recipient's
 * own expectations.
 */
export function recheck(entry: Disclosure): Recheck {
  const signed = entry.signed;
  if (signed === null) {
    return {
      ok: false,
      code: 'no-bytes-recorded',
      says: 'this disclosure was recorded by a version of this wallet that did not keep '
        + 'the bytes it signed. It really happened and it really was signed; there is '
        + 'simply nothing here to re-check.',
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(signed.bytes);
  } catch {
    return { ok: false, code: 'bytes-unreadable', says: 'the recorded bytes are not bytes.' };
  }
  const payload = readPreimage(bytes);
  if (payload === null) {
    return {
      ok: false,
      code: 'bytes-unreadable',
      says: 'the recorded bytes are not a disclosure this wallet could have signed.',
    };
  }
  let good = false;
  try {
    good = verifySignature(
      { tag: signed.scheme, value: signed.verifyingKey },
      bytes as Uint8Array<ArrayBuffer>,
      { tag: signed.scheme, value: signed.signature });
  } catch {
    good = false;
  }
  if (!good) {
    return {
      ok: false,
      code: 'signature-invalid',
      says: 'the recorded signature does not match the recorded bytes.',
    };
  }
  const disagreement = (() => {
    if (payload.at !== entry.at) return `the time (${payload.at} against ${entry.at})`;
    if (payload.nonce !== entry.nonce) return 'the nonce';
    if (payload.disclosed.length !== entry.sent.length) return 'how many values were sent';
    for (const [i, sent] of entry.sent.entries()) {
      const inBytes = payload.disclosed[i];
      if (inBytes === undefined) return `value ${i}`;
      if (JSON.stringify(inBytes) !== JSON.stringify(sent)) {
        return `what was sent for '${sent.about}'`;
      }
    }
    if (JSON.stringify([...payload.declined]) !== JSON.stringify([...entry.declined])) {
      return 'what was declined';
    }
    return null;
  })();
  if (disagreement !== null) {
    return {
      ok: false,
      code: 'fields-disagree',
      says: `the bytes that were signed and the record beside them disagree about `
        + `${disagreement}. The record is not a true account of what was sent.`,
    };
  }
  return { ok: true, payload };
}
