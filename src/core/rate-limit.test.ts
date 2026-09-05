/**
 * S-2, tested against a REAL Postgres rather than a mock.
 *
 * A mock would prove the SQL string is what this file expects it to be, which
 * is not the claim. The claim is that a hundred simultaneous login attempts
 * count as a hundred — and that is a property of the database, not of our
 * code. It cannot be asserted anywhere but against a database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MemoryRateLimiter, PostgresRateLimiter, windowStart, DEFAULT_POLICY, FALLBACK_POLICY,
  type RateLimiter,
} from './rate-limit.js';

/*
 * The Postgres half needs a real database and is SKIPPED without one, loudly,
 * rather than quietly passing. A skipped test that reads as green is the
 * failure mode this project has a list of — so the count in the run output is
 * the thing to read, and `DB-TEST.command` is what makes it non-zero.
 *
 *   TEST_DATABASE_URL=postgres://… npx vitest run src/core/rate-limit
 *
 * The memory implementation is exercised either way, because it is what the
 * standalone build actually uses.
 */
const DB = process.env.TEST_DATABASE_URL;
const withDb = DB ? describe : describe.skip;

let sql: any;
let closeSql: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!DB) return;
  const { default: postgres } = await import('postgres');
  sql = postgres(DB, { prepare: false, onnotice: () => {} });
  closeSql = () => sql.end();
  await sql.unsafe(readFileSync('db/migrations/0001_sessions_and_rate_limits.sql', 'utf8'));
});
afterAll(async () => { if (closeSql) await closeSql(); });
beforeEach(async () => { if (DB) await sql`TRUNCATE login_attempts`; });

/*
 * Both implementations are held to the same tests, because the memory one is
 * what the standalone build and most of the suite will use — and a limiter
 * that behaves differently in tests from production is worse than none, since
 * the tests then describe something nobody runs.
 *
 * The concurrency test is the exception, and is marked as such.
 */
const implementations: [string, () => RateLimiter, boolean][] = [
  ['memory', () => new MemoryRateLimiter(), true],
  ['postgres', () => new PostgresRateLimiter(sql), Boolean(DB)],
];

for (const [name, make, run] of implementations) {
  (run ? describe : describe.skip)(`${name} rate limiter`, () => {
    /*
     * **THE SCOPE THESE RUN ON CHANGED AND THE MECHANISM DID NOT.** `PI4b`.
     *
     * They were written against `email`, which was the scope `login` counted
     * on, and this round deleted both. **They were never tests about a
     * password** — every one of them is about the bucket: what it counts, what
     * it keeps apart, and when it forgets. So they are pointed at a scope that
     * has a caller, and the numbers come from the policy rather than being
     * written out, exactly as before.
     */
    const SCOPE = 'invite-offer';
    const POLICY = DEFAULT_POLICY[SCOPE];

    it('allows attempts up to the limit and refuses the one after', async () => {
      const rl = make();
      for (let i = 1; i <= POLICY.max; i++) {
        const d = await rl.record(SCOPE, 'a@example.com');
        expect(d.allowed, `attempt ${i} of ${POLICY.max} should be allowed`).toBe(true);
        expect(d.attempts).toBe(i);
      }
      const over = await rl.record(SCOPE, 'a@example.com');
      expect(over.allowed).toBe(false);
      expect(over.attempts).toBe(POLICY.max + 1);
      expect(over.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('counts the attempt before deciding, so a correct guess late in a run is still refused', async () => {
      /*
       * A limiter that only counted FAILURES would let an attacker whose 500th
       * guess is right straight through — the server cannot know a guess was
       * wrong until it has done the work the limiter exists to prevent.
       */
      const rl = make();
      for (let i = 0; i < POLICY.max; i++) await rl.record(SCOPE, 'b@example.com');
      expect((await rl.record(SCOPE, 'b@example.com')).allowed).toBe(false);
    });

    it('keeps the two scopes apart', async () => {
      // One door being hammered must not close another. They must not share a
      // bucket, and each door's ceiling is its own.
      const rl = make();
      for (let i = 0; i < POLICY.max + 1; i++) await rl.record(SCOPE, 'c@example.com');
      expect((await rl.record(SCOPE, 'c@example.com')).allowed).toBe(false);
      expect((await rl.record('ip', '198.51.100.7')).allowed).toBe(true);
    });

    it('AND AN UNKNOWN SCOPE IS METERED RATHER THAN WAVED THROUGH — PI4b', async () => {
      /*
       * The fallback used to be `DEFAULT_POLICY.email`, and this round deleted
       * that bucket. **A scope with a typo in it must not become an unlimited
       * door**, which is what `?? undefined` or a fallback to the most generous
       * policy would have made it — so the fallback is named, and this is what
       * notices if it stops existing.
       */
      const rl = make();
      for (let i = 0; i < FALLBACK_POLICY.max; i++) await rl.record('no-such-door', 'z');
      expect((await rl.record('no-such-door', 'z')).allowed).toBe(false);
    });

    it('keeps different keys in the same scope apart', async () => {
      const rl = make();
      for (let i = 0; i < POLICY.max + 1; i++) await rl.record(SCOPE, 'd@example.com');
      expect((await rl.record(SCOPE, 'd@example.com')).allowed).toBe(false);
      expect((await rl.record(SCOPE, 'e@example.com')).allowed).toBe(true);
    });

    it('forgets once the window has passed', async () => {
      const rl = make();
      const t0 = new Date('2026-08-14T10:00:00Z');
      for (let i = 0; i < POLICY.max + 1; i++) await rl.record(SCOPE, 'f@example.com', t0);
      expect((await rl.record(SCOPE, 'f@example.com', t0)).allowed).toBe(false);

      const later = new Date(t0.getTime() + (POLICY.windowSeconds + 1) * 1000);
      const fresh = await rl.record(SCOPE, 'f@example.com', later);
      expect(fresh.allowed).toBe(true);
      expect(fresh.attempts).toBe(1);
    });

    /*
     * **`clears on a successful login` IS DELETED.** `PI4b`.
     *
     * `clear` is gone from the interface and from both implementations, because
     * `login` was its only caller. **The two doors that count now have never
     * cleared and must not start**: forgiving an address on success hands the
     * limit back to anybody holding one valid credential of their own — spray
     * to the ceiling, succeed once, repeat — which is the attack the per-IP
     * scope exists for. A test for a method nobody calls is a green tick that
     * means nothing.
     */

    it('says how long to wait, and it is within the window', async () => {
      const rl = make();
      const now = new Date('2026-08-14T10:00:30Z');
      for (let i = 0; i < POLICY.max; i++) await rl.record(SCOPE, 'h@example.com', now);
      const d = await rl.record(SCOPE, 'h@example.com', now);
      expect(d.retryAfterSeconds).toBeGreaterThan(0);
      expect(d.retryAfterSeconds).toBeLessThanOrEqual(POLICY.windowSeconds);
    });
  });
}

withDb('THE ONE THAT MATTERS: concurrent attempts each get their own number', () => {
  /*
   * The failure this is written against, stated as the attack:
   *
   * A limiter that reads the count, adds one and writes it back can be beaten
   * by not waiting. Fire a hundred requests at once and every one of them
   * reads 4, every one writes 5, and a hundred guesses cost you one attempt.
   * An attacker does not politely serialise.
   *
   * So the assertion is not "the limiter trips" — it is that a hundred
   * concurrent calls produce the numbers 1 to 100 with nothing lost and
   * nothing repeated. Only the Postgres implementation can pass this, and the
   * memory one is deliberately not asked to: it exists for a single-process
   * build, and pretending otherwise is how a fake guarantee gets shipped.
   */
  it('a hundred at once are counted as a hundred, not as one', async () => {
    const rl = new PostgresRateLimiter(sql);
    const now = new Date('2026-08-14T11:00:00Z');

    /* `PI4b`: this ran on `email`, which was a scope until this round deleted
     * it. The claim is about the INCREMENT, not about which door — so it runs
     * on one that has a caller. */
    const results = await Promise.all(
      Array.from({ length: 100 }, () => rl.record('invite-offer', 'flood@example.com', now)),
    );

    const seen = results.map(r => r.attempts).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

    const [row] = await sql`
      SELECT attempts FROM login_attempts
      WHERE scope = 'invite-offer' AND key = 'flood@example.com'
        AND window_start = ${windowStart(now, DEFAULT_POLICY['invite-offer'].windowSeconds)}
    `;
    expect(Number(row.attempts)).toBe(100);

    // And the ones past the limit were refused, which is the point of counting.
    expect(results.filter(r => r.allowed)).toHaveLength(DEFAULT_POLICY['invite-offer'].max);
  });

  it('one bucket per window, not one row per attempt', async () => {
    // A row per attempt would make the table grow with the attack it is
    // supposed to make expensive, which is the wrong way round.
    const rl = new PostgresRateLimiter(sql);
    const now = new Date('2026-08-14T12:00:00Z');
    await Promise.all(Array.from({ length: 50 }, () => rl.record('ip', '203.0.113.9', now)));
    const rows = await sql`SELECT count(*)::int AS n FROM login_attempts WHERE scope = 'ip'`;
    expect(rows[0].n).toBe(1);
  });

  it('sweeping old windows leaves the current one alone', async () => {
    const rl = new PostgresRateLimiter(sql);
    const old = new Date('2026-08-01T00:00:00Z');
    const now = new Date('2026-08-14T13:00:00Z');
    await rl.record('invite-offer', 'stale@example.com', old);
    await rl.record('invite-offer', 'fresh@example.com', now);

    const removed = await rl.sweep(new Date('2026-08-10T00:00:00Z'));
    expect(removed).toBe(1);
    const rows = await sql`SELECT key FROM login_attempts`;
    expect(rows.map((r: any) => r.key)).toEqual(['fresh@example.com']);
  });
});

/**
 * **THE CENSUS BEHIND THE SENTENCE, SO THE SENTENCE STOPS BEING PROSE.**
 * `T-235`, `S58`, rule 27.
 *
 * `rate-limit.ts` said `GET /api/invites/:token/offer` *is the one door in this
 * product that answers a stranger*. That is false at source and had been for
 * some time: **twelve routes in `src/server/index.ts` carry no `authed`**. What
 * is unique about the offer endpoint is the METER, and the sentence has been
 * narrowed to say so.
 *
 * **A CORRECTED SENTENCE WITH NOTHING BEHIND IT GOES STALE THE SAME WAY THE
 * FIRST ONE DID**, which is the whole of `T-235`'s complaint, so the numbers
 * are asserted here rather than asserted in a comment. This test reads the
 * route table as TEXT — it is a census, not behaviour — and it goes red when a
 * thirteenth unauthenticated route is added or when the metering moves, which
 * is exactly when somebody should re-read that paragraph.
 */
describe('T-235: the unauthenticated surface, counted rather than described', () => {
  const server = readFileSync('src/server/index.ts', 'utf8');
  const routes = server.split('\n')
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(r => /^\s*app\.(get|post|put|patch|delete)\(/.test(r.line));

  it('there are twelve routes with no `authed`, and the offer endpoint is one of them', () => {
    const open = routes.filter(r => !r.line.includes('authed'));
    expect(
      open.map(r => `${r.at}: ${r.line.trim().slice(0, 70)}`).join('\n'),
    ).toBeTruthy();
    expect(open).toHaveLength(12);
    expect(open.some(r => r.line.includes("'/api/invites/:token/offer'"))).toBe(true);
  });

  it('and exactly ONE route handler meters, which is the word the sentence turns on', () => {
    /*
     * `limiter.record` inside a route handler. `WalletIdentityService` meters
     * `/auth/wallet/challenge` and `/auth/wallet` from inside the service by
     * `ip`, which is why those two are not counted here — the distinction the
     * corrected sentence draws is about the ROUTE, and conflating the two is
     * how the original sentence came to be written.
     */
    const metering = server.split('\n').filter(l => /limiter\.record\(/.test(l));
    expect(metering).toHaveLength(1);
    expect(metering[0]).toContain("'invite-offer'");
  });

  it('and the sentence in `rate-limit.ts` says METERED, not merely unauthenticated', () => {
    /*
     * The half a census cannot check is whether the prose still matches it.
     * This is the cheapest thing that fails when somebody restores the old
     * wording — and the old wording is what `T-235` was opened about.
     */
    const doc = readFileSync('src/core/rate-limit.ts', 'utf8');
    expect(doc).toContain('the one METERED door');
    expect(doc).not.toMatch(/is the one door in this product that\n \* answers a stranger, and/);
  });
});
