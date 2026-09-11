import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { Purposes, identityFromSecret, identityFromWords, newSecret } from '../keys/derivation.js';
import { emptyProfile, selfAssert } from './model.js';
import { GIVEN_NAME, REGISTRY } from './attributes.js';
import { open, profileKey, seal } from './seal.js';
import type { SealedProfile } from './seal.js';
import {
  StoreError, browserPort, forgetProfile, load, loadOrEmpty, putSealed, recordNameFor, save,
  sealedFor, sealedIn,
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

/** Replaces the record `who` reads with `change(it)`, at the name it reads it from. */
const tamperWithOwn = async (who: typeof identity, change: (blob: SealedProfile) => SealedProfile) => {
  const blob = await sealedFor(port, who);
  if (blob === null) throw new Error('nothing to tamper with');
  port.setItem(await recordNameFor(who), JSON.stringify(change(blob)));
};

describe('nothing is stored as readable JSON — §4, §6', () => {
  it('the person\'s name is not in the stored bytes', async () => {
    await save(port, identity, someone);
    const blob = await sealedFor(port, identity);
    expect(blob, 'something was stored, so the absence below is about its bytes').not.toBeNull();
    const raw = JSON.stringify(blob);
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

  it('ANOTHER WALLET\'S RECORD IS NOT THIS WALLET\'S STATE: it reads `none` here, and is untouched', async () => {
    await save(port, identity, someone);
    const theirs = JSON.stringify(await sealedFor(port, identity));
    expect(await load(port, other)).toEqual({ of: 'none' });
    await save(port, other, emptyProfile(NOW));
    expect(JSON.stringify(await sealedFor(port, identity))).toBe(theirs);
    expect((await load(port, identity)).of).toBe('profile');
    expect((await load(port, other)).of).toBe('profile');
  });

  it('an altered record of this wallet\'s own reads as `unopenable` — AES-GCM authenticates it', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, sealed: `${blob.sealed.slice(0, -4)}AAAA` }));
    expect((await load(port, identity)).of).toBe('unopenable');
  });

  it('a blob whose envelope version is not ours is `unopenable`, not silently opened', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, v: 2 }));
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
  it('saving over this wallet\'s own unopenable record is REFUSED, and nothing is written', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, v: 2 }));
    const before = JSON.stringify(await sealedFor(port, identity));
    await expect(save(port, identity, emptyProfile(NOW))).rejects.toThrow(StoreError);
    expect(JSON.stringify(await sealedFor(port, identity))).toBe(before);
  });

  it('and it can be replaced when it is asked for by name', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, v: 2 }));
    await save(port, identity, emptyProfile(NOW), { replacingUnopenable: true });
    expect((await load(port, identity)).of).toBe('profile');
  });

  it('`loadOrEmpty` reports the STATE beside the profile, so a screen can tell', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, v: 2 }));
    const outcome = await loadOrEmpty(port, identity, NOW);
    expect(outcome.state.of).toBe('unopenable');
    expect(outcome.profile.held).toHaveLength(0);
  });

  it('forgetting clears this wallet\'s record', async () => {
    await save(port, identity, someone);
    await forgetProfile(port, identity);
    expect(await load(port, identity)).toEqual({ of: 'none' });
  });

  it('and does not clear another wallet\'s', async () => {
    await save(port, identity, someone);
    await save(port, other, emptyProfile(NOW));
    await forgetProfile(port, other);
    expect((await load(port, identity)).of).toBe('profile');
    expect(await load(port, other)).toEqual({ of: 'none' });
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
    const state = await open(await profileKey(other), (await sealedFor(port, identity))!);
    expect(state.of === 'unopenable' && state.cause).toBe('another-key');
  });

  it('an altered body is `another-key` too - AES-GCM cannot tell the two apart, and says so by name', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, sealed: `${blob.sealed.slice(0, -4)}AAAA` }));
    const state = await load(port, identity);
    expect(state.of === 'unopenable' && state.cause).toBe('another-key');
  });

  it('an envelope this wallet did not write is NOT `another-key`', async () => {
    await save(port, identity, someone);
    await tamperWithOwn(identity, (blob) => ({ ...blob, v: 2 }));
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

describe('ONE BROWSER, SEVERAL WALLETS - each keeps its own record, and the record that came before is not moved', () => {
  /*
   * A browser used to keep ONE record, at one name, sealed by whichever wallet
   * saved first; every other wallet read a record it could not open and was
   * refused every save. `putSealed` puts such a record in place, sealed the way
   * `save` sealed it then, so these start from the browser as it was.
   */
  const third = identityFromSecret(newSecret());
  const sealedBy = async (who: typeof identity, profile = someone) => seal(await profileKey(who), profile);

  it('A SECOND WALLET CAN SAVE, AND THE FIRST ONE\'S RECORD IS LEFT BYTE FOR BYTE', async () => {
    putSealed(port, await sealedBy(identity));
    const before = JSON.stringify(sealedIn(port));

    const loaded = await load(port, other);
    expect(loaded.of).toBe('none');
    expect(loaded.othersHere, 'the record it cannot open is reported, not hidden').toBe(true);

    await save(port, other, emptyProfile(NOW));
    expect(JSON.stringify(sealedIn(port))).toBe(before);
    expect((await load(port, other)).of).toBe('profile');

    const first = await load(port, identity);
    expect(first.of === 'profile' && first.profile).toEqual(someone);
  });

  it('the wallet that sealed the record at the old name keeps reading AND WRITING it there', async () => {
    putSealed(port, await sealedBy(identity));
    const next = selfAssert(someone, REGISTRY, 'email', 'sarah@work.example', 'work', NOW);
    await save(port, identity, next);
    expect(port.getItem(await recordNameFor(identity)), 'nothing was moved to a name of its own').toBeNull();
    const reopened = await open(await profileKey(identity), sealedIn(port)!);
    expect(reopened.of === 'profile' && reopened.profile).toEqual(next);
    expect((await load(port, identity)).othersHere).toBeUndefined();
  });

  it('WITH THE WALLET THAT SEALED IT GONE, every wallet here can still save and read its own', async () => {
    const gone = identityFromSecret(newSecret());
    putSealed(port, await sealedBy(gone));
    const wallets = [[identity, 'First'], [other, 'Second'], [third, 'Third']] as const;
    for (const [who, name] of wallets) {
      await save(port, who, selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, name, 'legal', NOW));
    }
    for (const [who, name] of wallets) {
      const state = await load(port, who);
      expect(state.of === 'profile' && state.profile.held[0]?.says).toEqual({ of: 'value', value: name });
    }
  });

  it('a record at the old name that is PROVABLY a wallet\'s own and damaged is that wallet\'s to see, and nobody else\'s', async () => {
    const key = await profileKey(identity);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('midnight-identity/profile-seal/v1') as BufferSource },
      key, new TextEncoder().encode('{not json') as BufferSource));
    putSealed(port, { v: 1, iv: Buffer.from(iv).toString('base64url'), sealed: Buffer.from(body).toString('base64url') });
    const before = JSON.stringify(sealedIn(port));

    expect((await load(port, identity)).of).toBe('unopenable');
    await expect(save(port, identity, emptyProfile(NOW))).rejects.toThrow(StoreError);
    expect(JSON.stringify(sealedIn(port))).toBe(before);

    expect((await load(port, other)).of).toBe('none');
    await save(port, other, emptyProfile(NOW));
    expect(JSON.stringify(sealedIn(port))).toBe(before);
  });

  it('replacing by name reaches only this wallet\'s own record, never the one at the old name', async () => {
    putSealed(port, await sealedBy(identity));
    const before = JSON.stringify(sealedIn(port));
    await save(port, other, emptyProfile(NOW), { replacingUnopenable: true });
    expect(JSON.stringify(sealedIn(port))).toBe(before);
    await forgetProfile(port, other);
    expect(JSON.stringify(sealedIn(port))).toBe(before);
  });

  it('a wallet\'s own name is the same from the same secret, differs between wallets, and names nobody', async () => {
    const again = identityFromWords(TEST_MNEMONIC);
    expect(await recordNameFor(again)).toBe(await recordNameFor(identity));
    expect(await recordNameFor(other)).not.toBe(await recordNameFor(identity));
    const name = await recordNameFor(identity);
    expect(name.startsWith('midnight-identity:profile:')).toBe(true);
    expect(name).not.toBe('midnight-identity:profile');
    const raw = Buffer.from(identity.authority(Purposes.Profile, 0)).toString('base64url');
    expect(name).not.toContain(raw.slice(0, 12));
  });
});
