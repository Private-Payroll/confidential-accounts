import { describe, expect, it } from 'vitest';
import { MemorySessionStore, DEFAULT_TTL_HOURS, MAX_LIFETIME_HOURS } from './sessions.js';

/**
 * **A SESSION ENDS AT A FIXED TIME AFTER SIGN-IN, WHATEVER THE PERSON IS DOING, UNLESS IT IS RENEWED.**
 *
 * Found in the founder's console log of 20 Oct: /api/me answered 401 at 17:47:57Z, twelve hours (the
 * session's whole lifetime) after the page was first loaded and signed in at 05:47Z, in the middle of
 * creating a company. A session that is used while it runs low is given a fresh lifetime, up to a maximum
 * counted from the sign-in.
 *
 * RED WHEN: a session used at hour 7 is no longer live at hour 13; a session with plenty left is
 * extended; a revoked or expired one is brought back; one lives longer than the maximum.
 */
const T0 = new Date('2026-10-20T05:47:00Z');
const hours = (n: number) => new Date(T0.getTime() + n * 3600_000);

describe('renewing a session', () => {
  it('a session used at hour 7 of 12 is still live at hour 13', async () => {
    const s = new MemorySessionStore();
    const { token } = await s.issue('usr_1', { now: T0 });
    expect(await s.resolve(token, hours(13))).toBeNull();
    expect(await s.renew(token, hours(7))).toBe(hours(7 + DEFAULT_TTL_HOURS).toISOString());
    expect(await s.resolve(token, hours(13))).toBe('usr_1');
  });

  it('a session with more than half its lifetime left is not touched', async () => {
    const s = new MemorySessionStore();
    const { token, expiresAt } = await s.issue('usr_1', { now: T0 });
    expect(await s.renew(token, hours(2))).toBeNull();
    expect(await s.resolve(token, hours(DEFAULT_TTL_HOURS - 0.5))).toBe('usr_1');
    expect(await s.resolve(token, new Date(expiresAt))).toBeNull();
  });

  it('an expired or revoked session is not brought back', async () => {
    const s = new MemorySessionStore();
    const a = await s.issue('usr_1', { now: T0 });
    expect(await s.renew(a.token, hours(13))).toBeNull();
    expect(await s.resolve(a.token, hours(13))).toBeNull();
    const b = await s.issue('usr_1', { now: T0 });
    await s.revoke(b.token, hours(1));
    expect(await s.renew(b.token, hours(8))).toBeNull();
    expect(await s.resolve(b.token, hours(9))).toBeNull();
  });

  it('a session never lives past the maximum from its sign-in', async () => {
    const s = new MemorySessionStore();
    const { token } = await s.issue('usr_1', { now: T0 });
    let at = 7;
    while (await s.renew(token, hours(at)) !== null) at += 11;
    expect(await s.resolve(token, hours(MAX_LIFETIME_HOURS - 0.01))).toBe('usr_1');
    expect(await s.resolve(token, hours(MAX_LIFETIME_HOURS))).toBeNull();
  });
});
