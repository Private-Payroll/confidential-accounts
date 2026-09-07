import { describe, expect, it } from 'vitest';
import {
  Algorithms, PasskeyError, derToRawEcdsa, fromBase64Url, signCountLooksCloned, toBase64Url,
  verifyAssertion, verifyRegistration,
} from './verify.js';
import { sameBytes } from './bytes.js';
import type { AssertionInput, Expectations, Passkey, RegistrationInput } from './verify.js';
import { deviceBound, eligibleOnly, synced, twoSignIns } from './verify.fixtures.js';

/**
 * EVERY INPUT HERE IS REAL BROWSER OUTPUT — see `verify.fixtures.ts`. Nothing
 * in this file constructs a registration or an assertion from scratch, because
 * a builder written from the same understanding as the verifier proves only
 * that the two agree with each other.
 *
 * The failure cases are therefore made by CORRUPTING valid data, or by lying
 * about what is stored — which is the shape of the real attack in every case
 * where a host is the one lying.
 */

const b = fromBase64Url;

interface RegFixture {
  readonly challenge: string;
  readonly credentialId: string;
  readonly personHandle: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly publicKeySpki: string;
  readonly publicKeyAlgorithm: number;
  readonly transports: readonly string[];
}
interface SignInFixture {
  readonly challenge: string;
  readonly credentialId: string;
  readonly userHandle: string | null;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
}
interface Site {
  readonly rpId: string;
  readonly origin: string;
}

const registrationOf = (f: RegFixture): RegistrationInput => ({
  credentialId: f.credentialId,
  personHandle: f.personHandle,
  clientDataJSON: b(f.clientDataJSON),
  authenticatorData: b(f.authenticatorData),
  publicKeySpki: b(f.publicKeySpki),
  publicKeyAlgorithm: f.publicKeyAlgorithm,
  transports: f.transports,
});

const signInOf = (f: SignInFixture): AssertionInput => ({
  credentialId: f.credentialId,
  userHandle: f.userHandle,
  clientDataJSON: b(f.clientDataJSON),
  authenticatorData: b(f.authenticatorData),
  signature: b(f.signature),
});

const at = (site: Site, challenge: string): Expectations => ({
  rpId: site.rpId, origin: site.origin, challenge,
});

const enrol = (site: Site & { registration: RegFixture }): Promise<Passkey> =>
  verifyRegistration(registrationOf(site.registration), at(site, site.registration.challenge));

const regExpect = at(deviceBound, deviceBound.registration.challenge);
const getExpect = at(deviceBound, deviceBound.signIn.challenge);

describe('a registration a browser actually produced', () => {
  it('is accepted, and comes back as the record the host stores', async () => {
    const passkey = await enrol(deviceBound);
    expect(passkey.credentialId).toBe(deviceBound.registration.credentialId);
    expect(passkey.personHandle).toBe(deviceBound.registration.personHandle);
    expect(passkey.algorithm).toBe(Algorithms.ES256);
    expect(passkey.rpId).toBe('localhost');
    expect(passkey.signCount).toBe(1);
    expect(passkey.transports).toEqual(['internal']);
  });

  it('records the credential as UNPROVEN, because nothing signed anything', async () => {
    /*
     * `attestation: 'none'` means a registration carries no signature at all,
     * so nothing in it demonstrates that anybody holds the private half. A
     * record built with the wrong public key registers perfectly and can never
     * sign in again. A host must not count this toward any rule until it has.
     */
    expect((await enrol(deviceBound)).provenBySignIn).toBe(false);
  });

  it('accepts a registration carrying somebody ELSE\'s public key — which is why this check exists',
    async () => {
      const swapped = await verifyRegistration({
        ...registrationOf(deviceBound.registration),
        publicKeySpki: b(deviceBound.otherRegistration.publicKeySpki),
      }, regExpect);
      expect(swapped.provenBySignIn).toBe(false);

      /* And the person's own real sign-in is then refused, for ever. */
      await expect(verifyAssertion(signInOf(deviceBound.signIn), swapped, getExpect))
        .rejects.toMatchObject({ code: 'bad-signature' });
    });

  it('refuses a registration that does not say whose it is', async () => {
    await expect(verifyRegistration(
      { ...registrationOf(deviceBound.registration), personHandle: '' }, regExpect,
    )).rejects.toMatchObject({ code: 'malformed' });
  });

  it('reads the two backup flags separately, including when they disagree', async () => {
    /*
     * §7.5 needs this and nothing else supplies it. Until the third
     * fixture existed, reading either flag where the other was meant passed the
     * whole suite — every other fixture has them agreeing, and TWO FLAGS THAT
     * ALWAYS AGREE IN THE DATA ARE ONE FLAG.
     *
     * The third case is real: a passkey made on an iPhone with iCloud Keychain
     * switched off. It is exactly where "your passkey is safely synced" would
     * be a lie.
     */
    const bound = await enrol(deviceBound);
    expect([bound.syncsToACloud, bound.backedUpNow]).toEqual([false, false]);

    const cloud = await enrol(synced);
    expect([cloud.syncsToACloud, cloud.backedUpNow]).toEqual([true, true]);

    const eligible = await enrol(eligibleOnly);
    expect([eligible.syncsToACloud, eligible.backedUpNow]).toEqual([true, false]);
  });

  it('refuses an assertion presented as a registration', async () => {
    await expect(verifyRegistration({
      ...registrationOf(deviceBound.registration),
      clientDataJSON: b(deviceBound.signIn.clientDataJSON),
    }, getExpect)).rejects.toMatchObject({ code: 'wrong-ceremony' });
  });

  it('refuses a different challenge', async () => {
    await expect(verifyRegistration(
      registrationOf(deviceBound.registration),
      { ...regExpect, challenge: deviceBound.signIn.challenge },
    )).rejects.toMatchObject({ code: 'challenge-mismatch' });
  });

  it('refuses a ceremony that happened on another origin — the phishing check', async () => {
    await expect(verifyRegistration(
      registrationOf(deviceBound.registration),
      { ...regExpect, origin: 'https://midnight-identity.example' },
    )).rejects.toMatchObject({ code: 'origin-mismatch' });
  });

  it('accepts an origin from a list, and still refuses one that is absent', async () => {
    await expect(verifyRegistration(
      registrationOf(deviceBound.registration),
      { ...regExpect, origin: ['https://a.example', deviceBound.origin] },
    )).resolves.toBeTruthy();
    await expect(verifyRegistration(
      registrationOf(deviceBound.registration),
      { ...regExpect, origin: ['https://a.example', 'https://b.example'] },
    )).rejects.toMatchObject({ code: 'origin-mismatch' });
  });

  it('refuses a ceremony framed by a page that is not ours, and can be told to allow one',
    async () => {
      /*
       * The origin check proves the ceremony ran ON our origin. It does not
       * prove our origin was the page the person was looking at: a cross-origin
       * iframe of our page carries our origin here and passes everything else.
       * `crossOrigin` is what reveals it.
       *
       * This is built by editing a registration's clientDataJSON, which is
       * honest because a registration carries no signature over it — see above
       * above. An assertion could not be tested this way and does not need to
       * be: the same code runs for both.
       */
      const framed = new TextEncoder().encode(JSON.stringify({
        type: 'webauthn.create',
        challenge: deviceBound.registration.challenge,
        origin: deviceBound.origin,
        crossOrigin: true,
        topOrigin: 'https://attacker.example',
      }));
      const input = { ...registrationOf(deviceBound.registration), clientDataJSON: framed };

      await expect(verifyRegistration(input, regExpect))
        .rejects.toMatchObject({ code: 'origin-mismatch' });
      await expect(verifyRegistration(
        input, { ...regExpect, allowFramedBy: ['https://somebody-else.example'] },
      )).rejects.toMatchObject({ code: 'origin-mismatch' });
      await expect(verifyRegistration(
        input, { ...regExpect, allowFramedBy: ['https://attacker.example'] },
      )).resolves.toBeTruthy();

      /*
       * MORE THAN ONE ALLOWED FRAME, matching the SECOND. Without this, an
       * implementation that only ever compared the first entry passed
       * everything — every other case here has a list of one, and a list of one
       * cannot tell "any of these" from "the first of these".
       */
      await expect(verifyRegistration(
        input,
        { ...regExpect, allowFramedBy: ['https://first.example', 'https://attacker.example'] },
      )).resolves.toBeTruthy();
      await expect(verifyRegistration(
        input,
        { ...regExpect, allowFramedBy: ['https://first.example', 'https://second.example'] },
      )).rejects.toMatchObject({ code: 'origin-mismatch' });
    });

  it('refuses a credential registered for a different site', async () => {
    await expect(verifyRegistration(
      registrationOf(deviceBound.registration), { ...regExpect, rpId: 'example.com' },
    )).rejects.toMatchObject({ code: 'rp-mismatch' });
  });

  it('refuses when the browser handed back no public key, rather than guessing', async () => {
    for (const spki of [null, new Uint8Array(0)]) {
      await expect(verifyRegistration(
        { ...registrationOf(deviceBound.registration), publicKeySpki: spki }, regExpect,
      )).rejects.toMatchObject({ code: 'no-public-key' });
    }
  });

  it('refuses an algorithm it cannot verify — at REGISTRATION, not at first sign-in', async () => {
    await expect(verifyRegistration(
      { ...registrationOf(deviceBound.registration), publicKeyAlgorithm: -65535 }, regExpect,
    )).rejects.toMatchObject({ code: 'unsupported-algorithm' });
  });

  it('refuses a key that is not the algorithm it claims to be', async () => {
    await expect(verifyRegistration(
      { ...registrationOf(deviceBound.registration), publicKeyAlgorithm: Algorithms.RS256 },
      regExpect,
    )).rejects.toMatchObject({ code: 'no-public-key' });
  });

  it('refuses authenticator data too short to hold what it must hold', async () => {
    await expect(verifyRegistration({
      ...registrationOf(deviceBound.registration),
      authenticatorData: b(deviceBound.registration.authenticatorData).slice(0, 36),
    }, regExpect)).rejects.toMatchObject({ code: 'malformed' });
  });

  it('refuses a ceremony nobody touched the authenticator for', async () => {
    const data = b(deviceBound.registration.authenticatorData);
    data[32] = (data[32] as number) & ~0x01;
    await expect(verifyRegistration(
      { ...registrationOf(deviceBound.registration), authenticatorData: data }, regExpect,
    )).rejects.toMatchObject({ code: 'user-not-present' });
  });

  it('refuses a touch with no face, fingerprint or PIN — and can be told not to', async () => {
    const data = b(deviceBound.registration.authenticatorData);
    data[32] = (data[32] as number) & ~0x04;
    const input = { ...registrationOf(deviceBound.registration), authenticatorData: data };
    await expect(verifyRegistration(input, regExpect))
      .rejects.toMatchObject({ code: 'user-not-verified' });
    await expect(verifyRegistration(input, { ...regExpect, requireUserVerification: false }))
      .resolves.toBeTruthy();
  });
});

describe('a sign-in a browser actually produced', () => {
  it('verifies, and hands back the record to save', async () => {
    const passkey = await enrol(deviceBound);
    const result = await verifyAssertion(signInOf(deviceBound.signIn), passkey, getExpect);
    expect(result.userVerified).toBe(true);
    expect(result.signCount).toBe(2);
    expect(result.personHandle).toBe(deviceBound.registration.personHandle);
    /* The updated record, assembled here so a host cannot forget a field. */
    expect(result.passkey.signCount).toBe(2);
    expect(result.passkey.provenBySignIn).toBe(true);
    expect(result.passkey.credentialId).toBe(passkey.credentialId);
  });

  it('parses clientDataJSON rather than matching it, because Chrome adds a field', async () => {
    /*
     * The sign-in clientDataJSON contains a field whose value is the sentence
     * "do not compare clientDataJSON against a template". Chrome puts it there
     * deliberately to break code that string-matches. This passing is the proof
     * that we parse.
     */
    const decoded = new TextDecoder().decode(b(deviceBound.signIn.clientDataJSON));
    expect(decoded).toContain('other_keys_can_be_added_here');
    await expect(verifyAssertion(signInOf(deviceBound.signIn), await enrol(deviceBound), getExpect))
      .resolves.toBeTruthy();
  });

  it('REFUSES A SIGN-IN CLAIMED FOR THE WRONG PERSON', async () => {
    /*
     * The attack this closes: an attacker registers their own passkey honestly,
     * signs in honestly, and tells the server it is somebody else's account.
     * Every other check passes, because every other check is about the
     * credential. The authenticator says whose it is; now so do we.
     */
    const passkey = await enrol(deviceBound);
    const claimedAsSomebodyElse: Passkey = {
      ...passkey, personHandle: synced.registration.personHandle,
    };
    await expect(verifyAssertion(signInOf(deviceBound.signIn), claimedAsSomebodyElse, getExpect))
      .rejects.toMatchObject({ code: 'wrong-person' });
  });

  it('refuses a sign-in that names nobody at all — null OR empty', async () => {
    const passkey = await enrol(deviceBound);
    /* Both, because the type allows a string and an empty one names nobody
     * exactly as much as null does. */
    for (const userHandle of [null, '']) {
      await expect(verifyAssertion(
        { ...signInOf(deviceBound.signIn), userHandle }, passkey, getExpect,
      )).rejects.toMatchObject({ code: 'no-user-handle' });
    }
  });

  it('says WHO before it says STALE, when a sign-in is both', async () => {
    /*
     * Order matters here for a plain reason: telling somebody their sign-in is
     * out of date, when the real problem is that it is not their account, sends
     * them to fix the wrong thing. Identity is the stronger objection, so it
     * comes first — and it is pinned, because nothing else would notice a
     * refactor flipping the two.
     */
    const passkey = await enrol(deviceBound);
    const bothWrong: Passkey = {
      ...passkey, personHandle: synced.registration.personHandle, signCount: 99,
    };
    await expect(verifyAssertion(signInOf(deviceBound.signIn), bothWrong, getExpect))
      .rejects.toMatchObject({ code: 'wrong-person' });
  });

  it('checks who it is only AFTER the signature, so it cannot be used to fish for handles',
    async () => {
      /*
       * A wrong-person answer given before the signature is checked would let
       * anybody test which handles exist by sending noise. The order matters
       * and it is asserted rather than assumed.
       */
      const passkey = await enrol(deviceBound);
      const wrongEverything: Passkey = {
        ...passkey, personHandle: synced.registration.personHandle,
        publicKeySpki: b(deviceBound.otherRegistration.publicKeySpki),
      };
      await expect(verifyAssertion(signInOf(deviceBound.signIn), wrongEverything, getExpect))
        .rejects.toMatchObject({ code: 'bad-signature' });
    });

  it('refuses a signature that belongs to another credential', async () => {
    const passkey = await enrol(deviceBound);
    await expect(verifyAssertion({
      ...signInOf(deviceBound.signIn), signature: b(synced.signIn.signature),
    }, passkey, getExpect)).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('refuses a sign-in checked against the wrong stored passkey', async () => {
    const other = await verifyRegistration(
      registrationOf(deviceBound.otherRegistration),
      at(deviceBound, deviceBound.otherRegistration.challenge));
    await expect(verifyAssertion(signInOf(deviceBound.signIn), other, getExpect))
      .rejects.toMatchObject({ code: 'wrong-credential' });
  });

  it('refuses a signature over data that was altered afterwards', async () => {
    const passkey = await enrol(deviceBound);
    const data = b(deviceBound.signIn.authenticatorData);
    data[36] = (data[36] as number) + 1;
    await expect(verifyAssertion(
      { ...signInOf(deviceBound.signIn), authenticatorData: data }, passkey, getExpect,
    )).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('refuses a registration presented as a sign-in', async () => {
    const passkey = await enrol(deviceBound);
    await expect(verifyAssertion({
      ...signInOf(deviceBound.signIn),
      clientDataJSON: b(deviceBound.registration.clientDataJSON),
    }, passkey, regExpect)).rejects.toMatchObject({ code: 'wrong-ceremony' });
  });

  it('refuses a challenge that was already answered', async () => {
    const passkey = await enrol(deviceBound);
    await expect(verifyAssertion(
      signInOf(deviceBound.signIn), passkey,
      { ...getExpect, challenge: deviceBound.registration.challenge },
    )).rejects.toMatchObject({ code: 'challenge-mismatch' });
  });
});

describe('the sign counter, which is a clone detector that is off for most people', () => {
  const registered = (): Promise<Passkey> => enrol(twoSignIns);

  it('accepts two real sign-ins in the order they happened', async () => {
    const passkey = await registered();
    const first = await verifyAssertion(
      signInOf(twoSignIns.firstSignIn), passkey, at(twoSignIns, twoSignIns.firstSignIn.challenge));
    expect(first.signCount).toBe(2);

    const second = await verifyAssertion(
      signInOf(twoSignIns.secondSignIn), first.passkey,
      at(twoSignIns, twoSignIns.secondSignIn.challenge));
    expect(second.signCount).toBe(3);
  });

  it('refuses the FIRST sign-in replayed after the second — real, valid, correctly signed',
    async () => {
      /*
       * Every other refusal in this file is triggered by data somebody
       * corrupted. This one is genuine browser output whose signature verifies,
       * refused purely because the counter says it has already been used. That
       * is the whole clone detector.
       */
      const passkey = await registered();
      await expect(verifyAssertion(
        signInOf(twoSignIns.firstSignIn), { ...passkey, signCount: 3 },
        at(twoSignIns, twoSignIns.firstSignIn.challenge),
      )).rejects.toMatchObject({ code: 'sign-count-went-backwards' });
    });

  it('refuses a counter that stood still', async () => {
    const passkey = await registered();
    await expect(verifyAssertion(
      signInOf(twoSignIns.firstSignIn), { ...passkey, signCount: 2 },
      at(twoSignIns, twoSignIns.firstSignIn.challenge),
    )).rejects.toMatchObject({ code: 'sign-count-went-backwards' });
  });

  it('treats a reported zero as the counter being switched OFF, not as a clone', () => {
    /*
     * No authenticator we can drive reports zero — Chromium's virtual one
     * increments whatever it is asked for — so this case has no fixture and
     * cannot have one. The rule is therefore a function and this calls it.
     *
     * Why it must not refuse: a device-bound passkey migrated into iCloud
     * Keychain legitimately stops counting and reports zero from then on.
     * Refusing that locked the person out permanently — getting back in needed
     * a re-registration, which needed a sign-in, which needed the credential
     * being refused, and §1 is "passkey and nothing else".
     *
     * **A credential that has never counted cannot be caught by this check, and
     * we do not pretend otherwise.**
     */
    expect(signCountLooksCloned(0, 0)).toBe(false);
    expect(signCountLooksCloned(0, 1)).toBe(false);
    expect(signCountLooksCloned(2, 3)).toBe(false);
    expect(signCountLooksCloned(7, 0)).toBe(false);
    expect(signCountLooksCloned(1, 1)).toBe(true);
    expect(signCountLooksCloned(5, 2)).toBe(true);
  });
});

describe('the byte comparison the rpId check is built on', () => {
  /*
   * It had no test of its own, and the one thing exercising it — the rpId hash
   * comparison — passed with a version that looked at only the LAST byte,
   * purely because SHA-256('localhost') and SHA-256('example.com') happen to
   * differ there. A check that holds by coincidence of the fixtures is not a
   * check.
   */
  it('is false when any byte differs, not only the last one', () => {
    const a = new Uint8Array(32).fill(7);
    for (let i = 0; i < 32; i += 1) {
      const b = new Uint8Array(32).fill(7);
      b[i] = 8;
      expect(sameBytes(a, b)).toBe(false);
    }
    expect(sameBytes(a, new Uint8Array(32).fill(7))).toBe(true);
  });

  it('is false for different lengths, and true for two empties', () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('base64url, and the DER unpacking', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(new Uint8Array(0))).toBe('');
  });

  it('refuses ordinary base64, because a lenient decoder makes values compare equal', () => {
    expect(() => fromBase64Url('ab+/cd')).toThrow();
    expect(() => fromBase64Url('abcd=')).toThrow();
  });

  it('unpacks real DER signatures to sixty-four bytes', () => {
    for (const der of [deviceBound.signIn.signature, synced.signIn.signature,
      twoSignIns.firstSignIn.signature, twoSignIns.secondSignIn.signature]) {
      expect(derToRawEcdsa(b(der))).toHaveLength(64);
    }
  });

  it('refuses DER that is malformed rather than trimming it into something valid', () => {
    const good = b(deviceBound.signIn.signature);
    const cases: Uint8Array[] = [
      Uint8Array.from([0x31, ...good.slice(1)]),
      Uint8Array.from([good[0] as number, 99, ...good.slice(2)]),
      Uint8Array.from([...good, 0x00]),
      good.slice(0, 6),
      /* Outer length CORRECT, with a third INTEGER inside it. The length check
       * cannot see this one; only the "nothing after s" check can. */
      Uint8Array.from(
        [good[0] as number, (good[1] as number) + 3, ...good.slice(2), 0x02, 0x01, 0x00]),
    ];
    for (const bytes of cases) expect(() => derToRawEcdsa(bytes)).toThrow(PasskeyError);
  });
});
