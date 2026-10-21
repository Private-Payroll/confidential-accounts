import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as keyring from './keyring.js';

/**
 * **A 401 SIGNS THE PERSON OUT; A 503 `could-not-check` AND A NETWORK FAILURE NEVER DO.**
 *
 * The service answers 401 only when it looked and found no live session. When it could not look it
 * answers 503 `could-not-check`: the person stays signed in here, the page asks again after a short
 * wait, and only the answer to a fresh ask decides.
 *
 * RED WHEN: a 503 or a failed fetch makes the keyring forget the person; resumeSession does not ask
 * again after 0.6, 1.5 and 4 seconds, or asks without end; a good answer after a 503 is not taken; or a 401
 * stops forgetting.
 */
let answers: Array<() => Response | Promise<Response>> = [];
let asked = 0;
const reply = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const couldNotCheck = reply(503, { error: 'the service could not check your sign-in', code: 'could-not-check' });
const ME = reply(200, { user: { id: 'u1', email: null, name: 'Priya' } });

beforeEach(() => {
  asked = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    const next = answers[Math.min(asked, answers.length - 1)]!;
    asked += 1;
    return next();
  }));
});
afterEach(() => { vi.unstubAllGlobals(); keyring.forgetLocally(); });

const signedIn = async () => {
  answers = [ME];
  await keyring.resumeSession(null, async () => {});
  expect(keyring.currentUser()?.id).toBe('u1');
  asked = 0;
};

describe('api', () => {
  it('a 503 could-not-check throws CouldNotCheckError, which is not an AuthError, and forgets nothing', async () => {
    await signedIn();
    answers = [couldNotCheck];
    const caught = await keyring.api('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(keyring.CouldNotCheckError);
    expect(caught).not.toBeInstanceOf(keyring.AuthError);
    expect(keyring.currentUser()?.id).toBe('u1');
  });

  it('a 401 still signs the person out', async () => {
    await signedIn();
    answers = [reply(401, { error: 'not signed in' })];
    await expect(keyring.api('/api/accounts')).rejects.toBeInstanceOf(keyring.AuthError);
    expect(keyring.currentUser()).toBeNull();
  });
});

describe('resuming a session', () => {
  it('asks again after 0.6, 1.5 and 4 seconds, takes the good answer, and is signed in', async () => {
    answers = [couldNotCheck, couldNotCheck, ME];
    const waited: number[] = [];
    const me = await keyring.resumeSession(null, async (ms) => { waited.push(ms); });
    expect(me?.id).toBe('u1');
    expect(waited).toEqual([600, 1500]);
  });

  it('gives up after the last wait with the failure to check, and a person already signed in stays signed in', async () => {
    await signedIn();
    answers = [couldNotCheck];
    const waited: number[] = [];
    await expect(keyring.resumeSession(null, async (ms) => { waited.push(ms); })).rejects.toBeInstanceOf(keyring.CouldNotCheckError);
    expect(waited).toEqual([...keyring.RESUME_BACKOFF_MS]);
    expect(asked).toBe(4);
    expect(keyring.currentUser()?.id).toBe('u1');
  });

  it('a network failure is asked again the same way and signs nobody out', async () => {
    await signedIn();
    answers = [() => { throw new TypeError('Failed to fetch'); }];
    await expect(keyring.resumeSession(null, async () => {})).rejects.toBeInstanceOf(TypeError);
    expect(asked).toBe(4);
    expect(keyring.currentUser()?.id).toBe('u1');
  });

  it('a 401 is nobody, at once, with no second ask', async () => {
    answers = [reply(401, { error: 'not signed in' })];
    expect(await keyring.resumeSession(null, async () => { throw new Error('must not wait'); })).toBeNull();
    expect(asked).toBe(1);
  });
});
