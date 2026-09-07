import { describe, expect, it } from 'vitest';
import {
  acceptKeys, answerCommitment, askToPair, beginOffer, revealAndShow, sealKeys,
} from '../devices/pairing.js';
import { identityFromSecret, newSecret } from '../keys/derivation.js';
import { GIVEN_NAME, REGISTRY } from './attributes.js';
import { emptyProfile, selfAssert } from './model.js';
import { TravelError, pack, unpack } from './travel.js';
import { load, save, sealedIn } from './store.js';
import type { Port } from './store.js';

/**
 * **THE PROFILE TRAVELS WITH PAIRING — PROVED END TO END RATHER THAN
 * DESCRIBED.** This file drives the REAL pairing
 * protocol from `packages/identity/src/devices/pairing.ts`, which this change did not touch.
 */

const NOW = 1_755_000_000_000;

const memory = (): Port => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
};

/** The four real steps, in order, on the real module. */
const pairAndCarry = (secret: Uint8Array, oldDevice: Port) => {
  const asking = askToPair(NOW);                                  /* 1. NEW  */
  const offer = beginOffer(asking.code, NOW);                     /* 2. OLD  */
  const answered = answerCommitment(asking, offer.message, NOW);  /* 3. NEW  */
  const reveal = revealAndShow(offer.pending, answered.nonce, NOW); /* 4. OLD */
  const keys = sealKeys(offer.pending, secret, NOW);              /* 6. OLD  */
  return {
    /* What the OLD device puts on the screen: the sealed wallet AND the
     * sealed profile, in one payload. */
    payload: pack(keys, sealedIn(oldDevice)),
    reveal,
    request: answered.request,
  };
};

describe('a paired device opens the profile that crossed with the wallet', () => {
  it('END TO END, THROUGH THE REAL PAIRING PROTOCOL: the new device holds the same facts',
    async () => {
      const secret = newSecret();
      const identity = identityFromSecret(secret);

      /* The old device: a person with two facts, sealed at rest. */
      const oldDevice = memory();
      let profile = emptyProfile(NOW);
      profile = selfAssert(profile, REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW);
      profile = selfAssert(profile, REGISTRY, 'email', 'sarah@work.example', 'work', NOW);
      await save(oldDevice, identity, profile);

      const { payload, reveal, request } = pairAndCarry(secret, oldDevice);

      /* The new device reads ONE payload and separates the two halves. */
      const carried = unpack(payload);
      expect(carried.of).toBe('keys-and-profile');
      if (carried.of !== 'keys-and-profile') throw new Error('unreachable');

      /* The wallet half goes through `pairing.ts` untouched — including the
       * two digits a person compares, which is the defence this change did not
       * weaken and did not reimplement. */
      const accepted = acceptKeys(request, reveal.ephemeralPublic, carried.keys,
        reveal.digits, NOW);
      expect(Buffer.from(accepted.secret).toString('hex'))
        .toBe(Buffer.from(secret).toString('hex'));

      /* The profile half needs no key of its own: the identity built from the
       * secret that just arrived derives the same profile key. */
      const newDevice = memory();
      newDevice.setItem('midnight-identity:profile', JSON.stringify(carried.profile));
      const state = await load(newDevice, identityFromSecret(accepted.secret));
      expect(state.of).toBe('profile');
      expect(state.of === 'profile' && state.profile).toEqual(profile);
      expect(state.of === 'profile' && state.profile.held.map((h) => h.says))
        .toEqual([
          { of: 'value', value: 'Sarah' },
          { of: 'value', value: 'sarah@work.example' },
        ]);
    });

  it('THE WRONG DIGITS STOP THE WHOLE THING, profile included', () => {
    const secret = newSecret();
    const oldDevice = memory();
    const { payload, reveal, request } = pairAndCarry(secret, oldDevice);
    const carried = unpack(payload);
    const wrong = reveal.digits === '00' ? '01' : '00';
    expect(() => acceptKeys(request, reveal.ephemeralPublic, carried.keys, wrong, NOW))
      .toThrow(/Stop unless the other one shows the same/u);
  });
});

describe('the pairing payload is self-describing', () => {
  it('a bare sealed wallet — what pairing.ts itself produces — is still read', () => {
    expect(unpack('abcDEF123_-')).toEqual({ of: 'keys-only', keys: { sealed: 'abcDEF123_-' } });
  });

  it('"the sender had no profile" and "an older build" are different spellings', () => {
    expect(unpack(pack({ sealed: 'abc' }, null)).of).toBe('keys-and-no-profile');
    expect(unpack('abc').of).toBe('keys-only');
  });

  it('a profile half that will not read REFUSES rather than opening the wallet half', () => {
    /* If the details are unreadable the person is told, and nothing is opened
     * half-way. A pairing that quietly dropped the profile would look like a
     * device with no details rather than a device that lost them. */
    expect(() => unpack('mi1.abc.!!!!')).toThrow(TravelError);
    expect(() => unpack('mi1.abc.bm90LWpzb24')).toThrow(TravelError);
  });

  it('refuses something that is not a pairing payload at all', () => {
    for (const bad of ['', '   ', 'mi1.', 'mi1..x', 'has spaces']) {
      expect(() => unpack(bad)).toThrow(TravelError);
    }
  });

  it('what it packs is exactly what it unpacks', async () => {
    const identity = identityFromSecret(newSecret());
    const port = memory();
    await save(port, identity, selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', '', NOW));
    const blob = sealedIn(port)!;
    const carried = unpack(pack({ sealed: 'wallet-bytes' }, blob));
    expect(carried.of).toBe('keys-and-profile');
    expect(carried.of === 'keys-and-profile' && carried.profile).toEqual(blob);
    expect(carried.keys.sealed).toBe('wallet-bytes');
  });
});

describe('the ciphertext needs no second envelope — that is §4\'s whole argument', () => {
  it('the new device derives the key from the secret that just crossed, and it opens',
    async () => {
      const secret = newSecret();
      const oldDevice = memory();
      const oldIdentity = identityFromSecret(secret);
      const profile = selfAssert(
        emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW);
      await save(oldDevice, oldIdentity, profile);

      /* The blob crosses in the clear, beside the sealed wallet. */
      const carried = unpack(pack({ sealed: 'x' }, sealedIn(oldDevice)));
      expect(carried.of).toBe('keys-and-profile');

      /* On the new device: the secret arrives, an identity is built from it,
       * and the SAME key falls out. Nothing was transported and nothing was
       * re-encrypted. */
      const newDevice = memory();
      if (carried.of === 'keys-and-profile') {
        newDevice.setItem('midnight-identity:profile', JSON.stringify(carried.profile));
      }
      const newIdentity = identityFromSecret(secret);
      const state = await load(newDevice, newIdentity);
      expect(state.of).toBe('profile');
      expect(state.of === 'profile' && state.profile).toEqual(profile);
    });

  it('AND A DEVICE PAIRED FROM A DIFFERENT ACCOUNT CANNOT OPEN IT', async () => {
    const oldDevice = memory();
    const identity = identityFromSecret(newSecret());
    await save(oldDevice, identity,
      selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', '', NOW));
    const carried = unpack(pack({ sealed: 'x' }, sealedIn(oldDevice)));
    const newDevice = memory();
    if (carried.of === 'keys-and-profile') {
      newDevice.setItem('midnight-identity:profile', JSON.stringify(carried.profile));
    }
    expect((await load(newDevice, identityFromSecret(newSecret()))).of).toBe('unopenable');
  });
});
