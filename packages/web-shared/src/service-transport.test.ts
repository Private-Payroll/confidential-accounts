/**
 * **THE PAGE'S ONE FETCH OF THE SERVICE, AND ITS TWO FORMS.** `api` turns an answer into a value or a refusal a screen
 * can tell apart, and tells the sign-in when the service ended it; `serviceAnswered`, the quiet form, gives every status
 * back with its body and tells the sign-in nothing. Both are one fetch (`pageFetch`): to this product's own server only,
 * saying who the tab was prepared for, and a request that got no answer is `ServiceNotReached`. The browser's fetch is
 * stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceNotReached } from './hand-over.js';
import { api, AuthError, serviceAnswered, theSignInIsHeldBy } from './service-transport.js';
import { personAnsweredOnPage } from './person-on-page.js';
import { invitationOnPage, walletCallsOnPage } from './asks-on-page.js';

const t = { sent: [] as { path: string; init: RequestInit }[], answer: (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 })), lost: [] as string[] };

beforeEach(() => {
  t.sent = []; t.lost = [];
  t.answer = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { t.sent.push({ path, init }); return t.answer(); });
  theSignInIsHeldBy({ person: () => ({ id: 'held-person' }), isLive: () => true, lost: (why) => { t.lost.push(why); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

const header = (i: number, name: string): string | undefined => (t.sent[i]!.init.headers as Record<string, string>)[name];

describe('the quiet form', () => {
  it('names the person its caller names, with the sign-in cookie, and gives the status and body back', async () => {
    const r = await serviceAnswered(() => 'u-caller')('/api/me', { method: 'GET' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    /* RED WHEN: the quiet form names the person the tab's sign-in holds, not the one its caller was prepared for. */
    expect([header(0, 'x-signed-in-as'), t.sent[0]!.init.credentials]).toEqual(['u-caller', 'same-origin']);
  });

  it('answers a 401 as a status and signs nothing out', async () => {
    t.answer = () => Promise.resolve(new Response(JSON.stringify({ error: 'no session' }), { status: 401 }));
    /* RED WHEN: the quiet form tells the sign-in it was lost, so a caller reading the status signs the page out. */
    expect(await serviceAnswered(() => 'u1')('/api/me', { method: 'GET' })).toEqual({ status: 401, body: { error: 'no session' } });
    expect(t.lost).toEqual([]);
  });

  it('is ServiceNotReached when no answer came, asked once, and never tried again', async () => {
    t.answer = () => Promise.reject(new TypeError('Failed to fetch'));
    /* RED WHEN: a request that got no answer is said as an answer, or as anything but not reached, or is sent again. */
    await expect(serviceAnswered(() => 'u1')('/api/me', { method: 'GET' })).rejects.toBeInstanceOf(ServiceNotReached);
    expect(t.sent).toHaveLength(1);
  });

  it('sends only to this product\'s own server: any other path is refused with nothing sent', async () => {
    /* RED WHEN: a request can be sent anywhere but under /api/ of this page's own origin. */
    await expect(serviceAnswered(() => 'u1')('https://elsewhere.example/api/me', { method: 'GET' })).rejects.toThrow(/nowhere else/u);
    await expect(api('/elsewhere')).rejects.toThrow(/nowhere else/u);
    expect(t.sent).toEqual([]);
  });
});

describe('the page\'s api, on the same fetch', () => {
  it('names the person the tab was prepared for, and tells the sign-in a 401 ended it', async () => {
    await api('/api/me');
    expect(header(0, 'x-signed-in-as')).toBe('held-person');
    t.answer = () => Promise.resolve(new Response(JSON.stringify({ error: 'no session' }), { status: 401 }));
    await expect(api('/api/me')).rejects.toBeInstanceOf(AuthError);
    expect(t.lost).toEqual(['no-session']);
  });

  it('refuses a read that got no answer as ServiceNotReached, once, as it refused the browser\'s own failure before', async () => {
    t.answer = () => Promise.reject(new TypeError('Failed to fetch'));
    /* RED WHEN: a read with no answer is refused as anything but not reached, or the bounded read sends it again. */
    await expect(api('/api/me')).rejects.toBeInstanceOf(ServiceNotReached);
    await expect(api('/api/accounts/c1/proposals', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ServiceNotReached);
    expect(t.sent.map((s) => s.path)).toEqual(['/api/me', '/api/accounts/c1/proposals']);
  });
});

describe('the asks that read their own answers', () => {
  it('the sign-in ask, an invitation\'s asks and the wallet\'s relayed calls each name their caller\'s person, and a 401 signs nothing out', async () => {
    t.answer = () => Promise.resolve(new Response(JSON.stringify({ error: 'no session' }), { status: 401 }));
    const answers = [
      await personAnsweredOnPage(() => 'u-sign-in').me(),
      await invitationOnPage(() => 'u-invited').offer('inv1'),
      await walletCallsOnPage(() => 'u-wallet')({ method: 'POST', path: '/api/accounts/c1/proven', body: '{}' }),
    ];
    /* RED WHEN: one of them sends as the tab's own sign-in, or is answered through the transport that signs the page out. */
    expect(t.sent.map((_, i) => header(i, 'x-signed-in-as'))).toEqual(['u-sign-in', 'u-invited', 'u-wallet']);
    expect([answers.map((a) => (a as { status: number }).status), t.lost]).toEqual([[401, 401, 401], []]);
  });
});
