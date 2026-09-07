import type { ChallengeStore } from '../ports.js';
import { toBase64Url } from './bytes.js';

/**
 * A CHALLENGE STORE THAT ACTUALLY REFUSES A REPLAY — because the first version
 * of this library declared the interface and shipped nothing behind it.
 *
 * That mattered more than it sounds. `verify.ts` names two defences against a
 * replayed sign-in: the challenge, and the sign counter. **The counter is off
 * for almost everybody** — a synced passkey reports zero for ever, and
 * §1 depends on passkeys syncing. So the challenge is the whole
 * defence, and *"the host enforces one-use"* was a claim about code that did
 * not exist. A host whose `take` returned true would have passed every test in
 * the library while one captured request signed in for ever.
 *
 * This one is in memory, which is right for a single process and **wrong for
 * more than one** — two servers behind a load balancer do not share a `Map`, so
 * a challenge issued by one is unknown to the other and every other sign-in
 * fails. That failure is loud, which is the only reason it is acceptable to
 * ship this: a host that needs more than one process replaces this with
 * something shared, and finds out immediately rather than quietly.
 *
 * `everyChallengeStoreMustPass`, at the top of `challenges.test.ts`, is the
 * conformance suite. A host
 * writing its own runs it and inherits every property this one has.
 */

export interface MemoryChallengeStoreOptions {
  /** How long a challenge is good for. Default two minutes. */
  readonly ttlMs?: number;
  /**
   * The most challenges held at once. Default ten thousand.
   *
   * A store that grows without bound is a way to exhaust a server's memory by
   * asking it for challenges, so the oldest are dropped once this is reached.
   * **Dropping one refuses a ceremony somebody was in the middle of**, which is
   * a real cost and the reason the number is not small.
   */
  readonly capacity?: number;
  /**
   * The clock. Supplied rather than read, because `ports.ts` is a place with no
   * I/O in it and because expiry is much easier to test with a clock you hold.
   */
  readonly now?: () => number;
  /** Randomness. Supplied for the same reason. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

const CHALLENGE_BYTES = 32;

export class MemoryChallengeStore implements ChallengeStore {
  private readonly live = new Map<string, { purpose: string; expiresAt: number }>();

  private readonly ttlMs: number;

  private readonly capacity: number;

  private readonly now: () => number;

  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(options: MemoryChallengeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.capacity = options.capacity ?? 10_000;
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes
      ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  async issue(purpose: 'register' | 'sign-in'): Promise<string> {
    /*
     * Expired entries first. **This is not load-bearing and it is worth saying
     * so**: the TTL is the same for every challenge, so insertion order is
     * expiry order, and evicting the oldest already evicts the deadest. Removing
     * this line changes no observable behaviour, and a test claiming otherwise
     * would be a test that cannot fail.
     *
     * It stays because it keeps `size` honest at the moment of issue, and
     * because the day a per-challenge TTL exists it becomes load-bearing
     * immediately.
     */
    this.forget();
    /*
     * Eviction happens BEFORE the insert, so a full store never grows past its
     * capacity — and the oldest goes, not this one, because refusing to issue
     * would turn memory pressure into "nobody can sign in".
     */
    while (this.live.size >= this.capacity) {
      const oldest = this.live.keys().next();
      if (oldest.done) break;
      this.live.delete(oldest.value);
    }
    const challenge = toBase64Url(this.randomBytes(CHALLENGE_BYTES));
    this.live.set(challenge, { purpose, expiresAt: this.now() + this.ttlMs });
    return challenge;
  }

  /**
   * ONE USE, AND THE DELETE HAPPENS ON EVERY PATH.
   *
   * A challenge presented for the wrong purpose is spent, not returned — an
   * attacker who could keep retrying a captured value against both purposes
   * would have two attempts instead of none, and there is no legitimate caller
   * that presents one twice.
   */
  async take(challenge: string, purpose: 'register' | 'sign-in'): Promise<boolean> {
    const found = this.live.get(challenge);
    if (!found) return false;
    this.live.delete(challenge);
    if (found.expiresAt <= this.now()) return false;
    return found.purpose === purpose;
  }

  /** How many are outstanding. For a health check, and for the tests. */
  get size(): number {
    this.forget();
    return this.live.size;
  }

  private forget(): void {
    const now = this.now();
    for (const [challenge, found] of this.live) {
      if (found.expiresAt <= now) this.live.delete(challenge);
    }
  }
}
