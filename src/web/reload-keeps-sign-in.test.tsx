// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as keyring from './keyring.js';

/**
 * **A RELOAD DOES NOT SIGN ANYBODY OUT.** The session is a cookie this page
 * cannot read, so a fresh page asks the server who it is. Nothing here holds a
 * token: the requests below carry no `authorization` header at all, which is
 * what a page with nothing in memory sends.
 */

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); });

const aServer = (signedIn: boolean) => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get('authorization') });
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
    if (String(url) === '/api/me') {
      return signedIn ? json(200, { user: { id: 'usr_1', email: null, name: '' }, accounts: [] }) : json(401, { error: 'not signed in' });
    }
    if (String(url) === '/api/accounts') return json(200, []);
    return json(404, { error: 'no' });
  }) as typeof fetch;
  return seen;
};

describe('the session a reload leaves behind', () => {
  it('resumeSession PICKS UP a live session, and the tab is signed in with no token in it', async () => {
    const seen = aServer(true);
    expect(keyring.isSignedIn()).toBe(false);
    expect(await keyring.resumeSession()).toEqual({ id: 'usr_1', email: null, name: '' });
    expect(keyring.isSignedIn()).toBe(true);
    expect(seen.every((r) => r.auth === null)).toBe(true);
  });

  it('every request after that NAMES the person this tab was prepared for', async () => {
    const seen: Array<string | null> = [];
    aServer(true);
    await keyring.resumeSession();
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-signed-in-as'));
      return real(url, init);
    }) as typeof fetch;
    await keyring.api('/api/accounts');
    expect(seen).toEqual(['usr_1']);
  });

  it('and a session that has become SOMEBODY ELSE forgets this tab, rather than writing under them', async () => {
    aServer(true);
    await keyring.resumeSession();
    globalThis.fetch = (async () => ({
      ok: false, status: 409, json: async () => ({ error: 'another person', code: 'another-person' }),
    }) as Response) as typeof fetch;
    await expect(keyring.api('/api/me/keys', { method: 'PUT', body: '{}' })).rejects.toThrow('another person');
    expect(keyring.isSignedIn()).toBe(false);
  });

  it('resumeSession answers NOBODY on a 401, and the tab is not signed in', async () => {
    aServer(false);
    expect(await keyring.resumeSession()).toBeNull();
    expect(keyring.isSignedIn()).toBe(false);
  });

  it('THE PAGE, reloaded with a live session, lands on the company picker and not on the sign-in button', async () => {
    aServer(true);
    const { default: App } = await import('./App.js');
    const { SimulatedCommitments } = await import('../core/ledger.js');
    render(<App commitments={SimulatedCommitments} />);
    await waitFor(() => expect(screen.getByText('Signed in with your wallet')).toBeTruthy());
    expect(screen.queryByText('Sign in with your wallet')).toBeNull();
  });

  it('and with no session, the page lands on the sign-in button', async () => {
    aServer(false);
    const { default: App } = await import('./App.js');
    const { SimulatedCommitments } = await import('../core/ledger.js');
    render(<App commitments={SimulatedCommitments} />);
    await waitFor(() => expect(screen.getByText('Sign in with your wallet')).toBeTruthy());
  });
});
