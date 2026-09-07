import { describe, expect, it } from 'vitest';
import { MemoryChallengeStore } from './challenges.js';
import type { ChallengeStore } from '../ports.js';

/**
 * WHAT ANY CHALLENGE STORE MUST DO, written once so a host that replaces this
 * one can be held to the same thing.
 *
 * Export it, run it against your own implementation, and the properties come
 * with it. The clock is a parameter for the same reason it is a parameter on
 * the store: expiry tested with a real clock is a test that sleeps.
 */
export function everyChallengeStoreMustPass(
  name: string,
  make: (clock: { now: number }) => ChallengeStore,
): void {
  describe(name, () => {
    it('issues something long enough to be unguessable, and never the same twice', async () => {
      const clock = { now: 1_000 };
      const store = make(clock);
      const seen = new Set<string>();
      for (let i = 0; i < 200; i += 1) seen.add(await store.issue('sign-in'));
      expect(seen.size).toBe(200);
      for (const challenge of seen) expect(challenge.length).toBeGreaterThanOrEqual(40);
    });

    it('takes a challenge exactly once', async () => {
      const clock = { now: 1_000 };
      const store = make(clock);
      const challenge = await store.issue('sign-in');
      expect(await store.take(challenge, 'sign-in')).toBe(true);
      expect(await store.take(challenge, 'sign-in')).toBe(false);
      expect(await store.take(challenge, 'sign-in')).toBe(false);
    });

    it('refuses one it never issued', async () => {
      const store = make({ now: 1_000 });
      expect(await store.take('bm90IGEgcmVhbCBjaGFsbGVuZ2UgYXQgYWxs', 'sign-in')).toBe(false);
      expect(await store.take('', 'sign-in')).toBe(false);
    });

    it('refuses one issued for the other purpose, and SPENDS it doing so', async () => {
      const store = make({ now: 1_000 });
      const challenge = await store.issue('register');
      expect(await store.take(challenge, 'sign-in')).toBe(false);
      /* Not returned to the pool: two chances is worse than none. */
      expect(await store.take(challenge, 'register')).toBe(false);
    });

    it('refuses one that has expired', async () => {
      const clock = { now: 1_000 };
      const store = make(clock);
      const challenge = await store.issue('sign-in');
      clock.now += 119_000;
      const stillGood = await store.issue('sign-in');
      clock.now += 2_000;
      expect(await store.take(challenge, 'sign-in')).toBe(false);
      expect(await store.take(stillGood, 'sign-in')).toBe(true);
    });

  });
}

everyChallengeStoreMustPass(
  'MemoryChallengeStore',
  (clock) => new MemoryChallengeStore({ now: () => clock.now }));

describe('MemoryChallengeStore, and what it costs', () => {
  it('does not grow without bound, and drops the OLDEST rather than refusing to issue', async () => {
    /*
     * A store that grows for ever is a way to exhaust a server by asking it for
     * challenges. Refusing to issue would be worse than forgetting: it turns
     * memory pressure into nobody being able to sign in.
     *
     * The cost is real and is stated rather than hidden: **an evicted challenge
     * refuses a ceremony somebody was in the middle of**, which is why the
     * default capacity is ten thousand and not ten.
     */
    const clock = { now: 1_000 };
    const store = new MemoryChallengeStore({ capacity: 3, now: () => clock.now });
    const first = await store.issue('sign-in');
    const second = await store.issue('sign-in');
    await store.issue('sign-in');
    expect(store.size).toBe(3);

    const fourth = await store.issue('sign-in');
    expect(store.size).toBe(3);
    expect(await store.take(first, 'sign-in')).toBe(false);
    expect(await store.take(second, 'sign-in')).toBe(true);
    expect(await store.take(fourth, 'sign-in')).toBe(true);
  });

  it('forgets expired challenges without being asked', async () => {
    const clock = { now: 1_000 };
    const store = new MemoryChallengeStore({ ttlMs: 1_000, now: () => clock.now });
    for (let i = 0; i < 50; i += 1) await store.issue('sign-in');
    expect(store.size).toBe(50);
    clock.now += 1_001;
    expect(store.size).toBe(0);
  });

  it('expires ON the deadline rather than one tick after it', async () => {
    /*
     * The boundary, because nothing else lands on it — every other expiry test
     * overshoots by a comfortable margin, so `<=` and `<` were
     * indistinguishable. A challenge whose time is up is up.
     *
     * It lives here rather than in the conformance suite because it depends on
     * knowing the TTL, and a host's store is entitled to a different one.
     */
    const clock = { now: 1_000 };
    const store = new MemoryChallengeStore({ ttlMs: 1_000, now: () => clock.now });
    const justInTime = await store.issue('sign-in');
    const onTheDot = await store.issue('sign-in');

    clock.now = 1_999;
    expect(await store.take(justInTime, 'sign-in')).toBe(true);
    clock.now = 2_000;
    expect(await store.take(onTheDot, 'sign-in')).toBe(false);
  });

  it('does not evict a live ceremony to make room when the store is full of dead ones', async () => {
    /*
     * What this proves and what it does NOT. It proves the outcome: after the
     * store fills with challenges that then expire, two fresh ones both work.
     *
     * It does not prove that `issue()` calls `forget()`, and no test can,
     * because with one TTL for everything insertion order IS expiry order —
     * evicting the oldest already evicts the deadest, so removing that call
     * changes nothing observable. That is written in `challenges.ts` beside the
     * line rather than asserted here, because **a test that cannot fail is
     * worse than no test**: it reads as cover.
     */
    const clock = { now: 1_000 };
    const store = new MemoryChallengeStore({ capacity: 2, ttlMs: 1_000, now: () => clock.now });
    await store.issue('sign-in');
    await store.issue('sign-in');

    clock.now += 1_001;
    const afterTheDead = await store.issue('sign-in');
    const alsoLive = await store.issue('sign-in');

    expect(await store.take(afterTheDead, 'sign-in')).toBe(true);
    expect(await store.take(alsoLive, 'sign-in')).toBe(true);
    expect(store.size).toBe(0);
  });

  it('issues 32 bytes of real randomness by default', async () => {
    const store = new MemoryChallengeStore();
    const challenge = await store.issue('register');
    /* 32 bytes is 43 base64url characters with the padding stripped. */
    expect(challenge).toHaveLength(43);
  });
});
