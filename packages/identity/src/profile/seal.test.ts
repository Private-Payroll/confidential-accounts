import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromSecret, identityFromWords, newSecret } from '../keys/derivation.js';
import { emptyProfile, selfAssert } from './model.js';
import { GIVEN_NAME, REGISTRY } from './attributes.js';
import { open, profileKey, seal } from './seal.js';
import {
  StoreError, browserPort, forgetProfile, load, loadOrEmpty, putSealed, save, sealedIn,
} from './store.js';
import type { Port } from './store.js';

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const other = identityFromSecret(newSecret());

const someone = selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Sarah', 'legal', NOW);

const memory = (): Port => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
};

let port: Port;
beforeEach(() => { port = memory(); });

describe('nothing is stored as readable JSON — §4, §6', () => {
  it('the person\'s name is not in the stored bytes', async () => {
    await save(port, identity, someone);
    const raw = JSON.stringify(sealedIn(port));
    expect(raw).not.toContain('Sarah');
    expect(raw).not.toContain('given-name');
    expect(raw).not.toContain('legal');
  });

  it('what is stored opens again to exactly what went in', async () => {
    await save(port, identity, someone);
    const state = await load(port, identity);
    expect(state.of).toBe('profile');
    expect(state.of === 'profile' && state.profile).toEqual(someone);
  });

  it('a second seal of the same profile is different bytes — the IV is fresh', async () => {
    const key = await profileKey(identity);
    const a = await seal(key, someone);
    const b = await seal(key, someone);
    expect(a.sealed).not.toBe(b.sealed);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe('the key is the discriminator, and there are THREE read states', () => {
  it('nothing stored reads as `none`, never as an empty profile', async () => {
    expect(await load(port, identity)).toEqual({ of: 'none' });
  });

  it('ANOTHER ACCOUNT\'S BLOB reads as `unopenable`, never as `none`', async () => {
    await save(port, identity, someone);
    const state = await load(port, other);
    expect(state.of).toBe('unopenable');
  });

  it('an altered blob reads as `unopenable` — AES-GCM authenticates it', async () => {
    await save(port, identity, someone);
    const blob = sealedIn(port)!;
    putSealed(port, { ...blob, sealed: `${blob.sealed.slice(0, -4)}AAAA` });
    expect((await load(port, identity)).of).toBe('unopenable');
  });

  it('a blob whose envelope version is not ours is `unopenable`, not silently opened', async () => {
    await save(port, identity, someone);
    putSealed(port, { ...sealedIn(port)!, v: 2 });
    expect((await load(port, identity)).of).toBe('unopenable');
  });

  it('the additional data is bound in — a blob resealed under another envelope will not open',
    async () => {
      const key = await profileKey(identity);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new TextEncoder().encode(JSON.stringify(someone));
      const wrong = new Uint8Array(await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: new TextEncoder().encode('something-else') as BufferSource,
        },
        key, body as BufferSource));
      const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
      expect((await open(key, { v: 1, iv: toB64(iv), sealed: toB64(wrong) })).of)
        .toBe('unopenable');
    });
});

describe('a read that could not open must not let the next write destroy', () => {
  it('saving over an unopenable record is REFUSED, and nothing is written', async () => {
    await save(port, identity, someone);
    const before = JSON.stringify(sealedIn(port));
    await expect(save(port, other, emptyProfile(NOW))).rejects.toThrow(StoreError);
    expect(JSON.stringify(sealedIn(port))).toBe(before);
  });

  it('and it can be replaced when it is asked for by name', async () => {
    await save(port, identity, someone);
    await save(port, other, emptyProfile(NOW), { replacingUnopenable: true });
    expect((await load(port, other)).of).toBe('profile');
  });

  it('`loadOrEmpty` reports the STATE beside the profile, so a screen can tell', async () => {
    await save(port, identity, someone);
    const outcome = await loadOrEmpty(port, other, NOW);
    expect(outcome.state.of).toBe('unopenable');
    expect(outcome.profile.held).toHaveLength(0);
  });

  it('forgetting clears it', async () => {
    await save(port, identity, someone);
    forgetProfile(port);
    expect(await load(port, identity)).toEqual({ of: 'none' });
  });
});

describe('the profile key', () => {
  it('is not exportable', async () => {
    const key = await profileKey(identity);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('is the same key every time, from the secret alone — nothing is stored', async () => {
    const a = await seal(await profileKey(identity), someone);
    const again = identityFromWords(TEST_MNEMONIC);
    expect((await open(await profileKey(again), a)).of).toBe('profile');
  });

  it('a browser port is a Storage and needs no adapter', () => {
    expect(typeof browserPort).toBe('function');
  });
});

describe('an unopenable read NAMES WHICH WAY IT FAILED', () => {
  /*
   * A wallet that keeps several accounts in one browser can explain a key
   * failure that this module cannot. So the key failure is its own cause, and
   * every other failure is told apart from it: a screen that softened a
   * damaged envelope into *probably another wallet's* would be softening the
   * one case with no innocent explanation.
   */
  it('another account\'s blob is `another-key`', async () => {
    await save(port, identity, someone);
    const state = await load(port, other);
    expect(state.of === 'unopenable' && state.cause).toBe('another-key');
  });

  it('an altered body is `another-key` too - AES-GCM cannot tell the two apart, and says so by name', async () => {
    await save(port, identity, someone);
    const blob = sealedIn(port)!;
    putSealed(port, { ...blob, sealed: `${blob.sealed.slice(0, -4)}AAAA` });
    const state = await load(port, identity);
    expect(state.of === 'unopenable' && state.cause).toBe('another-key');
  });

  it('an envelope this wallet did not write is NOT `another-key`', async () => {
    await save(port, identity, someone);
    putSealed(port, { ...sealedIn(port)!, v: 2 });
    const state = await load(port, identity);
    expect(state.of === 'unopenable' && state.cause).toBe('not-sealed-by-this-wallet');
  });

  it('bytes that open and are not JSON are `unreadable`; JSON that is not a profile is `not-a-profile`', async () => {
    const key = await profileKey(identity);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealWith = async (text: string) => {
      const body = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('midnight-identity/profile-seal/v1') as BufferSource },
        key, new TextEncoder().encode(text) as BufferSource));
      return { v: 1, iv: Buffer.from(iv).toString('base64url'), sealed: Buffer.from(body).toString('base64url') };
    };
    const unreadable = await open(key, await sealWith('{not json'));
    expect(unreadable.of === 'unopenable' && unreadable.cause).toBe('unreadable');
    const stranger = await open(key, await sealWith('{"schema":"something-else"}'));
    expect(stranger.of === 'unopenable' && stranger.cause).toBe('not-a-profile');
  });
});
