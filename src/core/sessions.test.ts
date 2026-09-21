/**
 * These tests are written as the failures rather than as the feature.
 *
 * The old sessions were signed blobs with no server-side record, so the two
 * tests that matter are the two things that design could not do: end a session
 * on demand, and survive a restart. Both are stated here as the damage.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  MemorySessionStore, PostgresSessionStore, tokenHash, newToken, type SessionStore,
} from './sessions.js';

const DB = process.env.TEST_DATABASE_URL;
let sql: any;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!DB) return;
  const { default: postgres } = await import('postgres');
  sql = postgres(DB, { prepare: false, onnotice: () => {} });
  close = () => sql.end();
  await sql.unsafe(readFileSync('db/migrations/0001_sessions_and_rate_limits.sql', 'utf8'));
});
afterAll(async () => { if (close) await close(); });
beforeEach(async () => { if (DB) await sql`TRUNCATE sessions`; });

const implementations: [string, () => SessionStore, boolean][] = [
  ['memory', () => new MemorySessionStore(), true],
  ['postgres', () => new PostgresSessionStore(sql), Boolean(DB)],
];

for (const [name, make, run] of implementations) {
  (run ? describe : describe.skip)(`${name} sessions`, () => {
    it('issues a token that resolves to the user', async () => {
      const s = make();
      const { token } = await s.issue('usr_1');
      expect(await s.resolve(token)).toBe('usr_1');
    });

    it('signing out actually ends the session', async () => {
      /*
       * Under the old design this was impossible. The token was self-contained
       * and valid until it expired, so "sign out" dropped it client-side and
       * hoped. A stolen token could not be stopped, and neither could a
       * session on a lost laptop.
       */
      const s = make();
      const { token } = await s.issue('usr_1');
      expect(await s.resolve(token)).toBe('usr_1');

      await s.revoke(token);
      expect(await s.resolve(token)).toBeNull();
    });

    it('revoking twice is not an error', async () => {
      // Sign-out is a button a person can press twice, and a network can retry.
      const s = make();
      const { token } = await s.issue('usr_1');
      await s.revoke(token);
      await expect(s.revoke(token)).resolves.not.toThrow();
      expect(await s.resolve(token)).toBeNull();
    });

    it('signs out everywhere, and can keep the session doing the asking', async () => {
      // "Sign out my other devices". It used to be described as the useful
      // half of a password change; the other half was deleted and this is a
      // door of its own.
      const s = make();
      const a = await s.issue('usr_1');
      const b = await s.issue('usr_1');
      const c = await s.issue('usr_1');

      const ended = await s.revokeAll('usr_1', { except: b.token });
      expect(ended).toBe(2);
      expect(await s.resolve(a.token)).toBeNull();
      expect(await s.resolve(c.token)).toBeNull();
      expect(await s.resolve(b.token)).toBe('usr_1');
    });

    it('does not touch another user\'s sessions', async () => {
      const s = make();
      const mine = await s.issue('usr_1');
      const theirs = await s.issue('usr_2');
      await s.revokeAll('usr_1');
      expect(await s.resolve(mine.token)).toBeNull();
      expect(await s.resolve(theirs.token)).toBe('usr_2');
    });

    it('refuses an expired session', async () => {
      const s = make();
      const t0 = new Date('2026-08-14T10:00:00Z');
      const { token } = await s.issue('usr_1', { ttlHours: 1, now: t0 });
      expect(await s.resolve(token, new Date('2026-08-14T10:30:00Z'))).toBe('usr_1');
      expect(await s.resolve(token, new Date('2026-08-14T11:00:01Z'))).toBeNull();
    });

    it('refuses a token that was never issued, and one that is nonsense', async () => {
      const s = make();
      expect(await s.resolve(newToken())).toBeNull();
      expect(await s.resolve('')).toBeNull();
      expect(await s.resolve('not-a-token')).toBeNull();
    });

    it('gives the same answer — null — for unknown, expired and revoked', async () => {
      /*
       * Three facts an attacker would like told apart, and the caller does the
       * same thing in all three cases. The reason belongs in a log, not a
       * response.
       */
      const s = make();
      const t0 = new Date('2026-08-14T10:00:00Z');
      const expired = await s.issue('usr_1', { ttlHours: 1, now: t0 });
      const revoked = await s.issue('usr_1');
      await s.revoke(revoked.token);
      const later = new Date('2026-08-14T12:00:00Z');

      expect(await s.resolve(newToken(), later)).toBeNull();
      expect(await s.resolve(expired.token, later)).toBeNull();
      expect(await s.resolve(revoked.token, later)).toBeNull();
    });

    it('lists live sessions, marks the current one, and never returns a token', async () => {
      const s = make();
      const a = await s.issue('usr_1', { userAgent: 'Firefox on a Mac' });
      const b = await s.issue('usr_1', { userAgent: 'a phone' });
      await s.revoke(a.token);

      const live = await s.list('usr_1', { current: b.token });
      expect(live).toHaveLength(1);
      expect(live[0].current).toBe(true);
      expect(live[0].userAgent).toBe('a phone');
      expect(JSON.stringify(live)).not.toContain(b.token);
    });

    it('a session in the list can actually be signed out, by its id', async () => {
      /*
       * The list existed before this did, which made it a screen full of rows
       * with nothing behind them: `revoke` took a token, and the browser
       * reading the list does not hold the phone's token.
       */
      const s = make();
      const here = await s.issue('usr_1', { userAgent: 'this browser' });
      await s.issue('usr_1', { userAgent: 'a phone' });

      const phone = (await s.list('usr_1')).find(x => x.userAgent === 'a phone')!;
      expect(await s.revokeSession('usr_1', phone.id)).toBe(true);

      const after = await s.list('usr_1');
      expect(after.map(x => x.userAgent)).toEqual(['this browser']);
      expect(await s.resolve(here.token)).toBe('usr_1'); // and only the phone
    });

    it('a session id is not a licence to end a stranger\'s session', async () => {
      /*
       * A token is 32 random bytes and is its own authority. An id is twelve
       * characters of a hash, shown on a screen and copied into a URL — so if
       * `revokeSession` matched on the id alone, anybody who saw one could sign
       * somebody else out. The `user_id` clause is the whole security property,
       * and it is one word long, which is exactly why it needs a test.
       */
      const s = make();
      const victim = await s.issue('usr_victim', { userAgent: 'the target' });
      const theirs = (await s.list('usr_victim'))[0];

      expect(await s.revokeSession('usr_attacker', theirs.id)).toBe(false);
      expect(await s.resolve(victim.token)).toBe('usr_victim');
    });

    it('revoking an unknown id, or the same one twice, is a false rather than a throw', async () => {
      const s = make();
      const { token } = await s.issue('usr_1');
      const only = (await s.list('usr_1'))[0];
      expect(await s.revokeSession('usr_1', 'ffffffffffff')).toBe(false);
      expect(await s.revokeSession('usr_1', only.id)).toBe(true);
      expect(await s.revokeSession('usr_1', only.id)).toBe(false);
      expect(await s.resolve(token)).toBeNull();
    });

    it('sweeping removes expired rows and leaves live ones', async () => {
      const s = make();
      const t0 = new Date('2026-08-14T10:00:00Z');
      await s.issue('usr_1', { ttlHours: 1, now: t0 });
      const live = await s.issue('usr_1', { ttlHours: 48, now: t0 });
      expect(await s.sweep(new Date('2026-08-14T12:00:00Z'))).toBe(1);
      expect(await s.resolve(live.token, new Date('2026-08-14T12:00:00Z'))).toBe('usr_1');
    });
  });
}

describe('what is stored is not what is handed out', () => {
  it('the token never appears in the store; only its sha256 does', async () => {
    /*
     * A database backup must not be a stack of working sessions — the same
     * reason a password was never stored here, back when there was one.
     *
     * THE EXPECTED VALUE IS COMPUTED HERE, WITH NODE'S OWN SHA-256, NOT WITH
     * THE MODULE'S `tokenHash`. The first version of this test used `tokenHash`
     * on both sides, so it asserted only that the store had called the same
     * function the test called — replacing that function with one that stored
     * the token itself left the test green. An oracle that moves with the code
     * under test is not an oracle.
     */
    const s = new MemorySessionStore();
    const { token } = await s.issue('usr_1');
    const dump = JSON.stringify([...(s as any).rows.entries()]);

    const independent = createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex');
    expect(dump).toContain(independent);
    expect(dump).not.toContain(token);
    // And nothing else in there is the token in some other dress.
    expect(Buffer.from(dump).toString('hex')).not.toContain(
      Buffer.from(token, 'utf8').toString('hex'),
    );
  });

  it('tokenHash agrees with a sha256 written somewhere else', () => {
    const t = 'a-fixed-token-so-this-does-not-depend-on-randomness';
    expect(Buffer.from(tokenHash(t)).toString('hex')).toBe(
      createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex'),
    );
  });
});

describe('a session token has to be unguessable', () => {
  /*
   * Stated as the attack: the rate limiter guards the door somebody signs
   * in at, because checking what arrives there is expensive — it guarded
   * `POST /login` and now guards the wallet sign-in. It does NOT guard
   * presenting a session token, because checking one is a single indexed
   * lookup and throttling that would throttle every logged-in request. So a
   * predictable token is an unthrottled way past the sign-in the limiter was
   * built to protect.
   *
   * The suite noticed all-zero tokens before this test existed — several tests
   * went red for unrelated reasons — but nothing NAMED the property, so the
   * failure would have read as a bug in revocation rather than as "the tokens
   * are all the same".
   */
  it('a thousand tokens are a thousand different tokens', () => {
    const tokens = Array.from({ length: 1000 }, () => newToken());
    expect(new Set(tokens).size).toBe(1000);
  });

  it('THE ONE THAT CATCHES A COUNTER: every byte of the token is random, not just some', () => {
    /*
     * Distinctness is not the property. A counter produces a thousand distinct
     * tokens and is completely predictable — both mutations that beat the test
     * above, a counter and a 4-random-bytes-then-padding source, are DISTINCT
     * and USELESS. What separates them from a real token is that they hold
     * most byte positions constant.
     *
     * So: 256 samples, and every one of the 32 byte positions must vary. For a
     * genuinely random byte the expected number of distinct values in 256 draws
     * is ~162 with a standard deviation near 6, so a floor of 80 is over a
     * dozen deviations away — this does not flake. A counter leaves the top
     * bytes at zero (1 distinct value) and a truncated source leaves 28 of the
     * 32 positions constant, and both die here.
     */
    const SAMPLES = 256, BYTES = 32, FLOOR = 80;
    const samples = Array.from({ length: SAMPLES }, () => Buffer.from(newToken(), 'hex'));
    for (const s of samples) expect(s.length).toBe(BYTES);

    const distinctPerPosition = Array.from({ length: BYTES }, (_, i) =>
      new Set(samples.map(s => s[i])).size);

    const weakest = Math.min(...distinctPerPosition);
    expect(
      weakest,
      `byte position ${distinctPerPosition.indexOf(weakest)} took only ${weakest} ` +
      `distinct values across ${SAMPLES} tokens — that byte is not random`,
    ).toBeGreaterThan(FLOOR);
  });

  it('each one is a full-length hex token', () => {
    for (const t of Array.from({ length: 32 }, () => newToken())) {
      expect(t).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

(DB ? describe : describe.skip)('sessions outlive a restart', () => {
  it('a session issued by one instance resolves on another', async () => {
    /*
     * The old design could not do this and nobody noticed, because it failed
     * silently: `SESSION_SECRET` defaulted to a fresh random value on boot, so
     * every restart invalidated every token — and a signed-out user looks
     * exactly like an expired one.
     *
     * The second store gets its OWN CONNECTION POOL, not a second wrapper
     * around the first one's. Sharing `sql` would leave a whole class of
     * connection-local state — a temp table, an open transaction, a session
     * GUC — able to carry the answer between the two halves, and then the test
     * would pass for a reason that has nothing to do with a restart.
     */
    const { default: postgres } = await import('postgres');
    const secondProcess = postgres(DB!, { prepare: false, onnotice: () => {} });
    try {
      const issuing = new PostgresSessionStore(sql);
      const { token } = await issuing.issue('usr_restart');

      const other = new PostgresSessionStore(secondProcess as any);
      expect(await other.resolve(token)).toBe('usr_restart');

      await other.revoke(token);
      expect(await issuing.resolve(token)).toBeNull();
    } finally {
      await secondProcess.end();
    }
  });
});
