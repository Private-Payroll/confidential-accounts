// @vitest-environment jsdom
/**
 * **A SIGN-OUT THE SERVER DID NOT END IS NOT REPORTED AS A SIGN-OUT.**
 *
 * The session is an `HttpOnly` cookie. This page cannot read it and cannot
 * remove it; only the server's answer to a sign-out clears it. So when that
 * answer does not arrive, the browser is still signed in - a reload picks the
 * session up again - while the tab has already dropped everything it held and
 * shows the sign-in button. On a shared machine that is a person who believes
 * they have left and has not.
 *
 * The tab still forgets everything either way. What changes is that the screen
 * after it says what is true.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import * as keyring from './keyring.js';

type Logout = 'ok' | 'unreachable' | 'server-error' | 'no-session' | 'another-person';

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); });

function aServer(logout: Logout) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = `${String(init?.method ?? 'GET')} ${url}`;
    seen.push(key);
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (key === 'GET /api/me') return json(200, { user: { id: 'usr_1', email: null, name: '' }, accounts: [] });
    if (key === 'GET /api/accounts') return json(200, []);
    if (key === 'POST /api/auth/logout') {
      if (logout === 'ok') return json(200, { ok: true });
      if (logout === 'unreachable') throw new TypeError('Failed to fetch');
      if (logout === 'server-error') return json(500, { error: 'the store could not be written' });
      if (logout === 'no-session') return json(401, { error: 'not signed in' });
      return json(409, { error: 'another person', code: 'another-person' });
    }
    return json(404, { error: key });
  }) as typeof fetch;
  return seen;
}

describe('signing out, as the keyring reports it', () => {
  const cases: Array<[Logout, boolean, boolean]> = [
    ['ok', true, false],
    ['no-session', true, false],
    ['unreachable', false, false],
    ['server-error', false, false],
    ['another-person', false, true],
  ];
  for (const [logout, ended, anotherPerson] of cases) {
    it(`a logout that is ${logout} is ${ended ? '' : 'NOT '}reported as ended, and the tab forgets either way`, async () => {
      const seen = aServer(logout);
      await keyring.resumeSession();
      expect(keyring.isSignedIn()).toBe(true);
      expect(await keyring.signOut()).toEqual({ ended, anotherPerson });
      expect(seen).toContain('POST /api/auth/logout');
      expect(keyring.isSignedIn()).toBe(false);
    });
  }
});

describe('a tab that has already forgotten who it was', () => {
  /*
   * A request from such a tab carries no name, so the server would end
   * whichever session the cookie holds. After the server said there was no
   * session there is nothing to end; after it said the session is somebody
   * else's, ending it from here is not this person's to do.
   */
  it('after the server said NOBODY: reports ended, and sends nothing', async () => {
    aServer('ok');
    await keyring.resumeSession();
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({ error: 'not signed in' }) }) as Response) as typeof fetch;
    await expect(keyring.api('/api/accounts')).rejects.toThrow();
    const after = aServer('ok');
    expect(await keyring.signOut()).toEqual({ ended: true, anotherPerson: false });
    expect(after).not.toContain('POST /api/auth/logout');
  });

  it('after the server said SOMEBODY ELSE: reports not ended, names it, and sends nothing that would end their session', async () => {
    aServer('ok');
    await keyring.resumeSession();
    globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: 'another person', code: 'another-person' }) }) as Response) as typeof fetch;
    await expect(keyring.api('/api/accounts')).rejects.toThrow('another person');
    const after = aServer('ok');
    expect(await keyring.signOut()).toEqual({ ended: false, anotherPerson: true });
    expect(after).not.toContain('POST /api/auth/logout');
  });
});

describe('signing out, as the page shows it', () => {
  async function signOutOnThePage(logout: Logout) {
    aServer(logout);
    const { default: App, SIGN_OUT_DID_NOT_END, SIGN_OUT_ANOTHER_PERSON } = await import('./App.js');
    const { SimulatedCommitments } = await import('../core/ledger.js');
    const { container, getByText } = render(<App commitments={SimulatedCommitments} />);
    const link = await waitFor(() => getByText('Sign out'));
    fireEvent.click(link);
    await waitFor(() => expect(container.textContent).toContain('Sign in with your wallet'));
    return { text: container.textContent ?? '', SIGN_OUT_DID_NOT_END, SIGN_OUT_ANOTHER_PERSON };
  }

  it('A SIGN-OUT THAT DID NOT REACH THE SERVER SAYS THIS BROWSER MAY STILL BE SIGNED IN', async () => {
    const { text, SIGN_OUT_DID_NOT_END } = await signOutOnThePage('unreachable');
    expect(text).toContain(SIGN_OUT_DID_NOT_END);
    expect(SIGN_OUT_DID_NOT_END).toContain('this browser may still be signed in');
  });

  it('A SIGN-OUT REFUSED BECAUSE THE SESSION IS SOMEBODY ELSE\'S SAYS THAT, and where signing out works', async () => {
    const { text, SIGN_OUT_DID_NOT_END, SIGN_OUT_ANOTHER_PERSON } = await signOutOnThePage('another-person');
    expect(text).toContain(SIGN_OUT_ANOTHER_PERSON);
    expect(text).not.toContain(SIGN_OUT_DID_NOT_END);
    expect(SIGN_OUT_ANOTHER_PERSON).toContain('signed in as somebody else, from another tab');
  });

  it('and a sign-out the server confirmed says nothing more than the sign-in screen', async () => {
    const { text, SIGN_OUT_DID_NOT_END, SIGN_OUT_ANOTHER_PERSON } = await signOutOnThePage('ok');
    expect(text).not.toContain(SIGN_OUT_DID_NOT_END);
    expect(text).not.toContain(SIGN_OUT_ANOTHER_PERSON);
  });
});
