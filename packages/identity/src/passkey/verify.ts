import { fromBase64Url, sameBytes, toBase64Url } from './bytes.js';

/**
 * WHAT A PASSKEY IS FOR HERE, AND WHAT IT IS NOT. §3.
 *
 * It **authenticates**. It never holds, wraps or produces key material, so
 * there is no PRF call anywhere in this file, no check for whether a credential
 * supports one, and no branch that behaves differently if it does not. That
 * decision is the reason this file is short: the whole class of "the mechanism
 * quietly did not work and nobody found out" is absent, because there is no
 * mechanism to quietly fail.
 *
 * WHY THIS IS PURE AND HAS NO BROWSER IN IT. `ARCHITECTURE.md`: the core does
 * no I/O. The ceremony — `navigator.credentials.create` and `.get` — lives in
 * `browser/passkey.ts` and hands plain bytes here. A server verifying an
 * assertion runs exactly this code, and so does a standalone wallet with no
 * server at all.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE MATTERS:
 *
 *   the wrong ceremony     an assertion replayed as a registration, or the
 *                          reverse. `type` is inside the signed data.
 *   the wrong challenge    a replay. The challenge is one-use and short-lived,
 *                          and enforcing that is the host's `ChallengeStore`.
 *   the wrong origin       a phishing page. This is the check that makes a
 *                          passkey unphishable, and it is ours to perform —
 *                          the authenticator does not do it for us.
 *   the wrong rpId         a credential from another site's ceremony.
 *   user not present       a signature nobody touched anything for.
 *   user not verified      no face, no fingerprint, no PIN. Refused by default.
 *   a sign count going backwards   the one hint a credential has been cloned.
 *
 * THE ORIGIN CHECK IS THE ONE THAT IS EASY TO GET SUBTLY WRONG. `clientDataJSON`
 * is JSON and MUST be parsed rather than matched against a template — Chrome
 * inserts an extra field into it on purpose, containing the sentence "do not
 * compare clientDataJSON against a template", precisely to break code that
 * does. The fixtures this file is tested against are real browser output and
 * contain that field.
 */

export type PasskeyFailure =
  | 'malformed'
  | 'wrong-person'
  | 'wrong-ceremony'
  | 'challenge-mismatch'
  | 'origin-mismatch'
  | 'rp-mismatch'
  | 'user-not-present'
  | 'user-not-verified'
  | 'unsupported-algorithm'
  | 'no-public-key'
  | 'wrong-credential'
  | 'no-user-handle'
  /** The browser refused: a credential for this person is already here. */
  | 'already-registered'
  /** The person cancelled, or the ceremony timed out. */
  | 'cancelled'
  | 'bad-signature'
  | 'sign-count-went-backwards';

export class PasskeyError extends Error {
  readonly code: PasskeyFailure;
  constructor(code: PasskeyFailure, message: string) {
    super(message);
    this.name = 'PasskeyError';
    this.code = code;
  }
}

/** The COSE algorithm numbers we accept. Anything else is refused by name. */
export const Algorithms = {
  /** ECDSA P-256 with SHA-256. What every platform authenticator produces. */
  ES256: -7,
  /** Ed25519. Some hardware keys. */
  EdDSA: -8,
  /** RSA PKCS#1 v1.5 with SHA-256. Windows Hello, historically. */
  RS256: -257,
} as const;

/**
 * A registered passkey, as the host should store it.
 *
 * `syncsToACloud` and `backedUpNow` are the WebAuthn backup flags in plain
 * English, and they are kept because §7.5 needs them: they are how
 * we know a passkey lives in iCloud or a Google account, which is what makes
 * "this recovery piece sits behind the account you sign in with" a thing we can
 * say rather than guess.
 */
export interface Passkey {
  readonly credentialId: string;
  /**
   * WHOSE THIS IS — base64url of the `user.id` the ceremony was run with, and
   * the value the authenticator hands back at every sign-in.
   *
   * It exists because `verifyAssertion` would otherwise verify a credential and
   * say nothing about a person, leaving the host to supply that from the
   * request — which is a sign-in as anybody, with a perfectly good signature.
   * **This is a positive check, not the absence of one.**
   */
  readonly personHandle: string;
  readonly publicKeySpki: Uint8Array;
  readonly algorithm: number;
  /** What the authenticator last reported. Zero means it does not count. */
  readonly signCount: number;
  /**
   * FALSE UNTIL THIS CREDENTIAL HAS ACTUALLY SIGNED SOMETHING.
   *
   * A registration carries no signature — `attestation: 'none'` — so nothing in
   * it proves anybody holds the private half. A credential recorded with the
   * wrong public key registers happily and can never sign in again. **A host
   * must not count an unproven credential toward any rule about what an account
   * may do**; one completed sign-in is what turns this true.
   */
  readonly provenBySignIn: boolean;
  readonly rpId: string;
  /** BE — this credential is the kind that can be copied to a cloud account. */
  readonly syncsToACloud: boolean;
  /** BS — right now, a copy of it exists in that account. */
  readonly backedUpNow: boolean;
  readonly transports: readonly string[];
}

export interface Expectations {
  readonly rpId: string;
  /** One origin, or several. An exact string match; no wildcards, ever. */
  readonly origin: string | readonly string[];
  /** The challenge that was issued, base64url. One use, and the host enforces that. */
  readonly challenge: string;
  /** Default true. Setting it false accepts a touch with no face or PIN. */
  readonly requireUserVerification?: boolean;
  /**
   * Top-level origins this ceremony may be FRAMED by. Empty by default, which
   * means a framed ceremony is refused.
   *
   * The origin check proves the ceremony happened ON our origin. It does not
   * prove our origin was the page the person was looking at — a cross-origin
   * iframe of our page carries our origin in `clientData` and passes. What
   * reveals it is `crossOrigin`, which is why it is read. **Framing protection
   * itself is the host's response headers; this is the second half of it.**
   */
  readonly allowFramedBy?: readonly string[];
}

export interface RegistrationInput {
  readonly credentialId: string;
  /** Base64url of the `user.id` this ceremony was run with. */
  readonly personHandle: string;
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  /**
   * `AuthenticatorAttestationResponse.getPublicKey()`, which is SPKI DER.
   *
   * It is allowed to be null because the specification allows it, and when it
   * is null **we refuse rather than falling back to parsing the attestation
   * object ourselves.** Decoding CBOR and COSE by hand to recover a key is
   * exactly the kind of code that is wrong in a way nothing notices, and every
   * authenticator we intend to support returns a key here.
   */
  readonly publicKeySpki: Uint8Array | null;
  readonly publicKeyAlgorithm: number;
  readonly transports?: readonly string[];
}

export interface AssertionInput {
  readonly credentialId: string;
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
  /**
   * `AuthenticatorAssertionResponse.userHandle`, base64url — who the
   * authenticator says this is. Null when it did not say, which for a
   * discoverable credential should not happen and is refused.
   */
  readonly userHandle: string | null;
}

export interface AssertionResult {
  /** Who signed in. Checked, not reported — see `Passkey.personHandle`. */
  readonly personHandle: string;
  readonly signCount: number;
  readonly userVerified: boolean;
  readonly backedUpNow: boolean;
  /**
   * THE RECORD TO SAVE, ALREADY UPDATED. Hand this straight to
   * `PasskeyStore.save`.
   *
   * It exists so a host cannot assemble it by hand and forget a field: the
   * counter moves at every sign-in, `provenBySignIn` becomes true at the first,
   * and `backedUpNow` changes the day somebody switches iCloud Keychain on.
   * Every one of those is something §7.5 or the clone detector reads later.
   */
  readonly passkey: Passkey;
}

/*
 * WebCrypto wants an `ArrayBuffer`, and a `Uint8Array` is a view that may sit
 * on a shared or larger one. Copying into a fresh buffer is a few bytes and
 * removes a cast; every value passed through here is under a kilobyte.
 */
function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/* ---- authenticator data, which is a fixed binary layout and not CBOR ---- */

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;

interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly syncsToACloud: boolean;
  readonly backedUpNow: boolean;
  readonly signCount: number;
}

function readAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) {
    throw new PasskeyError(
      'malformed',
      `authenticator data is at least 37 bytes; got ${bytes.length}`);
  }
  const flags = bytes[32] as number;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    rpIdHash: bytes.slice(0, 32),
    userPresent: (flags & FLAG_USER_PRESENT) !== 0,
    userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
    syncsToACloud: (flags & FLAG_BACKUP_ELIGIBLE) !== 0,
    backedUpNow: (flags & FLAG_BACKED_UP) !== 0,
    signCount: view.getUint32(33, false),
  };
}

/* ---- client data, which is JSON and must be parsed ---- */

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  /** True when the ceremony ran inside a frame whose top document is elsewhere. */
  readonly crossOrigin: boolean;
  readonly topOrigin: string | null;
}

function readClientData(bytes: Uint8Array): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PasskeyError('malformed', 'clientDataJSON is not JSON');
  }
  const data = parsed as Partial<ClientData>;
  if (typeof data?.type !== 'string' || typeof data?.challenge !== 'string'
    || typeof data?.origin !== 'string') {
    throw new PasskeyError('malformed', 'clientDataJSON is missing type, challenge or origin');
  }
  return {
    type: data.type,
    challenge: data.challenge,
    origin: data.origin,
    crossOrigin: data.crossOrigin === true,
    topOrigin: typeof data.topOrigin === 'string' ? data.topOrigin : null,
  };
}

async function checkCommon(
  clientDataJSON: Uint8Array,
  authenticatorData: Uint8Array,
  expected: Expectations,
  ceremony: 'webauthn.create' | 'webauthn.get',
): Promise<AuthenticatorData> {
  const client = readClientData(clientDataJSON);

  if (client.type !== ceremony) {
    throw new PasskeyError(
      'wrong-ceremony',
      `this is a "${client.type}" and a "${ceremony}" was asked for. `
      + 'The ceremony is inside the signed data, so this is a replay of the wrong kind.');
  }

  if (client.challenge !== expected.challenge) {
    throw new PasskeyError(
      'challenge-mismatch',
      'this answers a different challenge from the one that was issued.');
  }

  const origins = typeof expected.origin === 'string' ? [expected.origin] : expected.origin;
  if (!origins.includes(client.origin)) {
    throw new PasskeyError(
      'origin-mismatch',
      `this ceremony happened on ${client.origin}, which is not ${origins.join(' or ')}. `
      + 'This is the check that makes a passkey unphishable and nothing else performs it.');
  }

  if (client.crossOrigin) {
    const allowed = expected.allowFramedBy ?? [];
    if (!client.topOrigin || !allowed.includes(client.topOrigin)) {
      throw new PasskeyError(
        'origin-mismatch',
        `this ceremony ran inside a frame on ${client.topOrigin ?? 'an undisclosed page'}. `
        + 'The origin matched because the frame was ours; the page around it was not.');
    }
  }

  const auth = readAuthenticatorData(authenticatorData);

  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', asBuffer(new TextEncoder().encode(expected.rpId))));
  if (!sameBytes(auth.rpIdHash, expectedRpIdHash)) {
    throw new PasskeyError(
      'rp-mismatch', `this credential does not belong to ${expected.rpId}.`);
  }

  if (!auth.userPresent) {
    throw new PasskeyError('user-not-present', 'nobody touched the authenticator.');
  }
  if ((expected.requireUserVerification ?? true) && !auth.userVerified) {
    throw new PasskeyError(
      'user-not-verified',
      'the authenticator did not check who was holding it — no face, fingerprint or PIN.');
  }

  return auth;
}

/**
 * A registration, checked. What comes back is what the host stores.
 *
 * Nothing about attestation is examined. We do not ask an authenticator to
 * prove what make and model it is, because we are not making a decision that
 * depends on the answer — and asking for it means parsing CBOR from an
 * untrusted source to learn something we would not act on.
 */
export async function verifyRegistration(
  input: RegistrationInput, expected: Expectations,
): Promise<Passkey> {
  const auth = await checkCommon(
    input.clientDataJSON, input.authenticatorData, expected, 'webauthn.create');

  if (!input.publicKeySpki || input.publicKeySpki.length === 0) {
    throw new PasskeyError(
      'no-public-key',
      'the browser did not hand back a public key for this credential. '
      + 'Rather than decoding the attestation object by hand, this is refused: '
      + 'the person should try a different device or authenticator.');
  }
  /* Refused HERE, at registration, rather than at the first sign-in — a key we
   * cannot verify with is a credential that would work exactly once. */
  await importVerificationKey(input.publicKeySpki, input.publicKeyAlgorithm);

  if (!input.personHandle) {
    throw new PasskeyError(
      'malformed',
      'a registration must say whose it is. Pass the same value that was used as '
      + 'user.id in the ceremony.');
  }

  return Object.freeze({
    credentialId: input.credentialId,
    personHandle: input.personHandle,
    publicKeySpki: input.publicKeySpki,
    algorithm: input.publicKeyAlgorithm,
    signCount: auth.signCount,
    /* Nothing here has proved anybody holds the private half. */
    provenBySignIn: false,
    rpId: expected.rpId,
    syncsToACloud: auth.syncsToACloud,
    backedUpNow: auth.backedUpNow,
    transports: Object.freeze([...(input.transports ?? [])]),
  });
}

/**
 * A sign-in, checked against a stored passkey.
 *
 * THE SIGN COUNT IS A CLONE DETECTOR AND IT IS OFF FOR MOST PEOPLE, which is
 * worth stating rather than discovering. A synced passkey — iCloud Keychain,
 * Google Password Manager — reports zero every time, because it genuinely
 * exists on several devices and a counter would be meaningless. So the rule is:
 * zero on both sides means the credential does not count and nothing is
 * checked; anything else must increase. **A passkey that has never counted
 * cannot be caught this way and we do not pretend otherwise.**
 */
export async function verifyAssertion(
  input: AssertionInput, passkey: Passkey, expected: Expectations,
): Promise<AssertionResult> {
  if (input.credentialId !== passkey.credentialId) {
    throw new PasskeyError(
      'wrong-credential',
      'this assertion is from a different credential than the one it was checked against.');
  }

  const auth = await checkCommon(
    input.clientDataJSON, input.authenticatorData, expected, 'webauthn.get');

  const key = await importVerificationKey(passkey.publicKeySpki, passkey.algorithm);
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', asBuffer(input.clientDataJSON)));
  const signed = new Uint8Array(input.authenticatorData.length + clientDataHash.length);
  signed.set(input.authenticatorData, 0);
  signed.set(clientDataHash, input.authenticatorData.length);

  const ok = await crypto.subtle.verify(
    verifyParams(passkey.algorithm), key,
    signatureFor(passkey.algorithm, input.signature), asBuffer(signed));
  if (!ok) {
    throw new PasskeyError('bad-signature', 'the signature does not match this credential.');
  }

  /*
   * WHOSE SIGN-IN IS THIS.
   *
   * THE ORDER OF THE THREE CHECKS BELOW IS DELIBERATE AND IS PINNED BY TESTS,
   * because each pair of them can be told apart by what comes back:
   *
   *   1. the SIGNATURE, first, so a wrong-person answer cannot be used to
   *      discover which handles exist without holding a key;
   *   2. WHO IT IS, second, because identity is a stronger objection than
   *      staleness — telling somebody their sign-in is out of date, when the
   *      real problem is that it is not their account, sends them to fix the
   *      wrong thing;
   *   3. the COUNTER, last.
   */
  if (!input.userHandle) {
    throw new PasskeyError(
      'no-user-handle',
      'this authenticator did not say whose credential it is. A discoverable '
      + 'credential always does, and without it a sign-in names no person.');
  }
  if (input.userHandle !== passkey.personHandle) {
    throw new PasskeyError(
      'wrong-person',
      'this credential belongs to somebody else.');
  }

  if (signCountLooksCloned(passkey.signCount, auth.signCount)) {
    throw new PasskeyError(
      'sign-count-went-backwards',
      `this authenticator reported ${auth.signCount} after ${passkey.signCount}. `
      + 'A counter that does not move forward is the one hint that a credential has been copied.');
  }

  const updated: Passkey = Object.freeze({
    ...passkey,
    signCount: auth.signCount,
    provenBySignIn: true,
    backedUpNow: auth.backedUpNow,
  });

  return Object.freeze({
    personHandle: passkey.personHandle,
    signCount: auth.signCount,
    userVerified: auth.userVerified,
    backedUpNow: auth.backedUpNow,
    passkey: updated,
  });
}

/**
 * The sign-counter rule, on its own, because it is the one piece of judgement
 * in this file that cannot be exercised with a recorded fixture.
 *
 * No authenticator we can drive reports a zero counter — Chromium's virtual one
 * increments regardless of what it is asked for — so the zero-on-both-sides
 * case has no real bytes behind it. Rather than let a test re-state the rule
 * beside the code and call that a check, the rule is a function and the test
 * calls **this**.
 *
 * `true` means refuse.
 */
export function signCountLooksCloned(stored: number, reported: number): boolean {
  /*
   * A REPORTED ZERO MEANS THE COUNTER IS SWITCHED OFF, NOT THAT IT WENT
   * BACKWARDS.
   *
   * The first version refused any counter that did not advance, which was right
   * about a replay and wrong about a credential that legitimately stops
   * counting — the ordinary cause being a device-bound passkey migrating into
   * iCloud Keychain or Google Password Manager, where a counter is meaningless
   * and the platform reports zero from then on. Stored N, reported 0 was then
   * refused for ever, and getting back in required re-registering, which
   * required being signed in, which required the credential being refused.
   * §1 is "passkey and nothing else", so that was a locked door with
   * the keys behind it.
   *
   * So zero is accepted and recorded, which puts the credential in exactly the
   * state a synced passkey is already in and already accepted. What is refused
   * is a counter that is running and repeats or goes back.
   */
  if (reported === 0) return false;
  return reported <= stored;
}

/* ---- signatures ---- */

function importParams(algorithm: number): EcKeyImportParams | RsaHashedImportParams | Algorithm {
  switch (algorithm) {
    case Algorithms.ES256: return { name: 'ECDSA', namedCurve: 'P-256' };
    case Algorithms.RS256: return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    case Algorithms.EdDSA: return { name: 'Ed25519' };
    default:
      throw new PasskeyError(
        'unsupported-algorithm',
        `this credential signs with COSE algorithm ${algorithm}, which is not one of `
        + `${Object.values(Algorithms).join(', ')}.`);
  }
}

function verifyParams(algorithm: number): AlgorithmIdentifier | EcdsaParams {
  switch (algorithm) {
    case Algorithms.ES256: return { name: 'ECDSA', hash: 'SHA-256' };
    case Algorithms.RS256: return { name: 'RSASSA-PKCS1-v1_5' };
    default: return { name: 'Ed25519' };
  }
}

async function importVerificationKey(spki: Uint8Array, algorithm: number): Promise<CryptoKey> {
  const params = importParams(algorithm);
  try {
    return await crypto.subtle.importKey('spki', asBuffer(spki), params, false, ['verify']);
  } catch (e) {
    throw new PasskeyError(
      'no-public-key',
      `this credential's public key could not be read: ${(e as Error).message}`);
  }
}

/**
 * WebAuthn's ECDSA signatures are DER and WebCrypto wants raw `r || s`. Nothing
 * else needs converting.
 *
 * This is the one piece of parsing in the file and it is deliberately strict:
 * a DER integer may carry a leading zero byte to keep it positive, and it may
 * not be longer than 33 bytes for P-256. Anything that does not fit that shape
 * is refused rather than trimmed into something that verifies.
 */
export function derToRawEcdsa(der: Uint8Array): Uint8Array {
  const fail = (why: string): never => {
    throw new PasskeyError('malformed', `this ECDSA signature is not valid DER: ${why}`);
  };
  if (der.length < 8 || der[0] !== 0x30) fail('it does not begin with a SEQUENCE');
  if (der[1] !== der.length - 2) fail('the declared length does not match the bytes');

  const readInt = (at: number): { value: Uint8Array; next: number } => {
    if (der[at] !== 0x02) fail('an INTEGER was expected');
    const length = der[at + 1] as number;
    if (length === 0 || length > 33) fail(`an INTEGER of ${length} bytes cannot be a P-256 scalar`);
    let value = der.slice(at + 2, at + 2 + length);
    if (value.length !== length) fail('it ends in the middle of an INTEGER');
    if (value[0] === 0x00) value = value.slice(1);
    if (value.length > 32) fail('an INTEGER is too long for P-256');
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return { value: padded, next: at + 2 + length };
  };

  const r = readInt(2);
  const s = readInt(r.next);
  if (s.next !== der.length) fail('there are bytes after the second INTEGER');

  const raw = new Uint8Array(64);
  raw.set(r.value, 0);
  raw.set(s.value, 32);
  return raw;
}

function signatureFor(algorithm: number, signature: Uint8Array): ArrayBuffer {
  return asBuffer(algorithm === Algorithms.ES256 ? derToRawEcdsa(signature) : signature);
}

/* Re-exported so a host can move these between the wire and this module. */
export { fromBase64Url, toBase64Url };
