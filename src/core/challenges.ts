import { randomBytes, toHex, type Hex } from './crypto.js';

/**
 * ONE-USE CHALLENGES, SO A SIGNATURE CANNOT BE REPLAYED.
 *
 * Signing in with a recovery phrase means proving you hold the identity key the
 * seed produces. A proof has to be over something the server chose and has
 * never issued before, or **the same signature works for ever**: anybody who
 * captures one — a proxy log, a shared machine, a browser extension — becomes
 * that person permanently, which is a worse failure than the password this is
 * replacing.
 *
 * So: the server issues a random value, remembers it briefly, and **consumes it
 * on first use.** A second attempt with the same one is refused whether or not
 * the signature is good.
 *
 * ## The limitation, stated rather than discovered
 *
 * The memory implementation below is per process. Two API processes behind a
 * load balancer will issue a challenge on one and fail to find it on the other,
 * and a restart forgets every outstanding one — both of which look to a person
 * like their recovery phrase was rejected. Sessions had exactly this problem and
 * grew a Postgres implementation behind the same interface; **this needs the
 * same before it runs on more than one process**, and it is an interface for
 * that reason rather than a class. `A-19`.
 */
export interface ChallengeStore {
  /** A fresh value bound to whoever asked for it. */
  issue(subject: string, now?: Date): Promise<{ challenge: Hex; expiresAt: string }>;
  /**
   * Takes the challenge if it is live and belongs to this subject, and removes
   * it. Returns false for unknown, expired, wrong-subject and already-used
   * alike — **one answer for every way of failing**, because distinguishing
   * them tells somebody holding a stolen value which kind of stolen it is.
   */
  consume(subject: string, challenge: Hex, now?: Date): Promise<boolean>;
}

/** Two minutes: long enough to read a phrase off paper, short enough to matter. */
export const CHALLENGE_TTL_SECONDS = 120;

export class MemoryChallengeStore implements ChallengeStore {
  private live = new Map<Hex, { subject: string; expiresAt: number }>();

  async issue(subject: string, now = new Date()) {
    this.sweep(now);
    const challenge = toHex(randomBytes(32));
    const expires = now.getTime() + CHALLENGE_TTL_SECONDS * 1000;
    this.live.set(challenge, { subject, expiresAt: expires });
    return { challenge, expiresAt: new Date(expires).toISOString() };
  }

  async consume(subject: string, challenge: Hex, now = new Date()) {
    const row = this.live.get(challenge);
    /*
     * DELETED WHETHER OR NOT IT MATCHES. A challenge presented once is spent —
     * otherwise a wrong subject could be tried against the same value until it
     * expired, which turns a one-use proof into a two-minute window.
     */
    if (row) this.live.delete(challenge);
    if (!row) return false;
    if (row.expiresAt <= now.getTime()) return false;
    return row.subject === subject;
  }

  private sweep(now: Date) {
    for (const [k, v] of this.live) if (v.expiresAt <= now.getTime()) this.live.delete(k);
  }
}
