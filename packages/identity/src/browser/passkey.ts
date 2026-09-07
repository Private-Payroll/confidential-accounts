import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';
import { PasskeyError } from '../passkey/verify.js';
import type { AssertionInput, RegistrationInput } from '../passkey/verify.js';

/**
 * THE CEREMONY, AND AS LITTLE ELSE AS POSSIBLE.
 *
 * This is the only file in the library that calls `navigator`, and it is
 * deliberately thin: it turns a challenge into a browser prompt and turns the
 * browser's answer into plain bytes. **Every decision about whether that answer
 * is acceptable is made in `passkey/verify.ts`**, which has no browser in it
 * and is tested against recorded output from a real one.
 *
 * The reason for the split is that this file cannot be tested here — there is
 * no authenticator in a test runner — so the amount of judgement in it is kept
 * near zero. If something here has a branch, it is because the browser forced
 * one.
 *
 * NO PRF, ANYWHERE. §3. The passkey authenticates and never carries
 * key material, so nothing below asks for an extension, checks whether one is
 * supported, or behaves differently if it is not.
 */

export interface CreateOptions {
  /** The domain the credential belongs to. Not the origin — no scheme, no port. */
  readonly rpId: string;
  /** What the person sees in the prompt. */
  readonly rpName: string;
  /** Base64url, from the host's `ChallengeStore`. */
  readonly challenge: string;
  readonly person: {
    /**
     * A stable, opaque handle for this person. **Not an email and not a name**
     * — it is stored unencrypted on the authenticator and syncs to whatever
     * account backs it up.
     */
    readonly id: string;
    /** Shown in the account picker. An email is normal here. */
    readonly name: string;
    readonly displayName: string;
  };
  /**
   * EVERY CREDENTIAL THIS PERSON ALREADY HAS. Required, not optional.
   *
   * A discoverable credential is keyed by (rpId, user.id), so an authenticator
   * asked for a second one under the same handle **destroys the first**.
   * `excludeCredentials` is what turns that into a refusal instead. It is not
   * about what the browser offers.
   *
   * The failure it prevents is the bad kind: the ceremony succeeds, the old
   * credential is already gone from the authenticator, and any failure between
   * there and saving the new one — an expired challenge while somebody hunts
   * for their fingerprint, a dropped connection — leaves them with no passkey
   * at all, on an account that §7.7 allows to hold money.
   *
   * Pass an empty array only when the person genuinely has none. Get the list
   * from `PasskeyStore.forPerson` rather than remembering it.
   */
  readonly existing: readonly string[];
  /** Milliseconds before the browser gives up. Default 120000. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GetOptions {
  readonly rpId: string;
  readonly challenge: string;
  /** Leave empty to let the browser show every passkey it has for this site. */
  readonly allow?: readonly string[];
  /** Milliseconds before the browser gives up. Default 120000. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Whether this browser can do passkeys at all. */
export function passkeysAvailable(): boolean {
  return typeof globalThis.PublicKeyCredential === 'function'
    && typeof navigator !== 'undefined'
    && typeof navigator.credentials?.create === 'function';
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The browser throws `DOMException`s whose names mean several things at once.
 * Translating them here is the one piece of judgement this file is allowed,
 * because a person reading "InvalidStateError" learns nothing and the thing it
 * actually means — *you already have a passkey on this device* — is something
 * they can act on.
 */
function translate(e: unknown, what: 'create' | 'get'): PasskeyError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'InvalidStateError') {
    return new PasskeyError(
      'already-registered',
      'there is already a passkey for this account on this device.');
  }
  if (name === 'NotAllowedError') {
    return new PasskeyError(
      'cancelled',
      what === 'create'
        ? 'the passkey was not created — it was cancelled, or it timed out.'
        : 'the sign-in was not completed — it was cancelled, timed out, or no '
          + 'matching passkey was offered.');
  }
  if (name === 'NotSupportedError' || name === 'SecurityError' || name === 'AbortError') {
    return new PasskeyError('malformed', `${name}: ${(e as Error).message}`);
  }
  return new PasskeyError('malformed', `${name || 'the browser'}: ${(e as Error)?.message ?? e}`);
}

const descriptors = (
  ids: readonly string[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined => (ids?.length
  ? ids.map((id) => ({ type: 'public-key' as const, id: fromBase64Url(id) as BufferSource }))
  : undefined);

/**
 * Make a passkey.
 *
 * `attestation` is deliberately `'none'`: we never ask an authenticator to
 * prove its make and model, because no decision here depends on the answer and
 * asking means parsing CBOR from an untrusted source to learn something we
 * would not act on.
 */
export async function createPasskey(options: CreateOptions): Promise<RegistrationInput> {
  const personHandle = new TextEncoder().encode(options.person.id);
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64Url(options.challenge) as BufferSource,
      rp: { id: options.rpId, name: options.rpName },
      user: {
        id: personHandle as BufferSource,
        name: options.person.name,
        displayName: options.person.displayName,
      },
      /* ES256 first because every platform authenticator does it; the other two
       * are here so a hardware key that cannot do P-256 still works. */
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'required',
        requireResidentKey: true,
      },
      excludeCredentials: descriptors(options.existing),
      attestation: 'none',
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    ...(options.signal ? { signal: options.signal } : {}),
    }) as PublicKeyCredential | null;
  } catch (e) {
    throw translate(e, 'create');
  }

  if (!credential) {
    throw new PasskeyError('malformed', 'the browser returned no credential.');
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();

  return {
    credentialId: credential.id,
    personHandle: toBase64Url(personHandle),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    authenticatorData: new Uint8Array(response.getAuthenticatorData()),
    publicKeySpki: spki ? new Uint8Array(spki) : null,
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
    transports: response.getTransports?.() ?? [],
  };
}

/** Use a passkey. */
export async function usePasskey(options: GetOptions): Promise<AssertionInput> {
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64Url(options.challenge) as BufferSource,
        rpId: options.rpId,
        allowCredentials: descriptors(options.allow),
        userVerification: 'required',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    }) as PublicKeyCredential | null;
  } catch (e) {
    throw translate(e, 'get');
  }

  if (!credential) {
    throw new PasskeyError('malformed', 'the browser returned no assertion.');
  }
  const response = credential.response as AuthenticatorAssertionResponse;

  return {
    credentialId: credential.id,
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    authenticatorData: new Uint8Array(response.authenticatorData),
    signature: new Uint8Array(response.signature),
    /* WHOSE IT IS. Dropped by the first version of this file. */
    userHandle: response.userHandle ? toBase64Url(new Uint8Array(response.userHandle)) : null,
  };
}

export { fromBase64Url, toBase64Url };
