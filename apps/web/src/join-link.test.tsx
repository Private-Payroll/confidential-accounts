// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterSignIn } from './app.js';
import { HOME, PAGES, VIEWS, type Viewer } from './pages.js';
import { forgetLink, holdLink, resolve, useHeldLink } from './router.js';
import { Root } from './root.js';
import { untilPageShown } from './page-shown.test-support.js';

/*
 * A LINK TO JOIN A COMPANY, `/join/<id>#<token>`: the token in its fragment is
 * kept in this tab's memory, never sent to the service and never left in the
 * address, and the page it opens is open to a visitor and to a signed-in person.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
vi.mock('./adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('./adapters/creation-standing.js')>()),
  creationOf: async (id: string | null) => ({ company: id, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null }),
}));
await import('./adapters/creation-standing.js');
vi.mock('./adapters/session.js', async (real) => ({
  ...(await real<typeof import('./adapters/session.js')>()),
  approvalsNeededFor: async () => new Map<string, number>(),
  companyNamesFor: async () => Object.assign(new Map<string, string>(), { whyNot: new Map() }),
}));
vi.mock('./adapters/proving-warmed.js', () => ({ warmTheProving: () => {} }));

const ID = 'a'.repeat(64);
const TOKEN = 'b'.repeat(64);
const OTHER_ID = 'c'.repeat(64);
const join = (id: string): string => PAGES.join.path.replace(':id', id);
const VISITOR_AFTER: Viewer = { signedIn: true, view: VIEWS.company, signs: false };

function Probe({ id }: { id: string }) {
  return <p data-held={useHeldLink(id) ?? 'nothing'} />;
}
const heldFor = (id: string): string => {
  const { container } = render(<Probe id={id} />);
  return container.querySelector('[data-held]')!.getAttribute('data-held')!;
};

beforeEach(() => { forgetLink(); window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the link\'s token is held in memory and taken out of the address', () => {
  /* RED WHEN: the token stays in the address bar after the page is opened, is not held for the invitation it came with, or is handed to the page of another invitation. */
  it('holds the token for its own invitation only, and leaves only the path in the address', () => {
    window.history.replaceState(null, '', `${join(ID)}#${TOKEN}`);
    holdLink(window.location.pathname, window.location.hash);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(join(ID));
    expect(heldFor(ID)).toBe(TOKEN);
    expect(heldFor(OTHER_ID)).toBe('nothing');
  });

  /* RED WHEN: a fragment that is not a token, or a fragment on any page but the joining page, is held as if it were an invitation's token. */
  it('holds nothing for a fragment that is not a token, or on another page', () => {
    window.history.replaceState(null, '', `${join(ID)}#not-a-token`);
    holdLink(window.location.pathname, window.location.hash);
    expect(heldFor(ID)).toBe('nothing');
    window.history.replaceState(null, '', `${PAGES.settings.path}#${TOKEN}`);
    holdLink(window.location.pathname, window.location.hash);
    expect(heldFor(ID)).toBe('nothing');
    expect(window.location.hash).toBe(`#${TOKEN}`);
  });

  /* RED WHEN: opening the page again without the fragment, as a reload or a move inside the app does, forgets a token still wanted. */
  it('keeps the token when the same page is opened again without it', () => {
    window.history.replaceState(null, '', `${join(ID)}#${TOKEN}`);
    holdLink(window.location.pathname, window.location.hash);
    holdLink(window.location.pathname, window.location.hash);
    expect(heldFor(ID)).toBe(TOKEN);
  });

  /* RED WHEN: the page keeps showing a token after it was told to forget it, or is not told that it was forgotten. */
  it('tells the page it showed the token when the token is forgotten', async () => {
    window.history.replaceState(null, '', `${join(ID)}#${TOKEN}`);
    holdLink(window.location.pathname, window.location.hash);
    const { container } = render(<Probe id={ID} />);
    expect(container.querySelector('[data-held]')!.getAttribute('data-held')).toBe(TOKEN);
    await act(async () => { forgetLink(); });
    expect(container.querySelector('[data-held]')!.getAttribute('data-held')).toBe('nothing');
  });
});

describe('after signing in, the person stays on a page that opens for them', () => {
  /* RED WHEN: signing in from the joining page takes the person off it, to the landing page. */
  it('stays on the joining page', () => {
    expect(afterSignIn(resolve(join(ID), VISITOR_AFTER), null, VISITOR_AFTER)).toBeNull();
  });

  /* RED WHEN: a page a visitor was sent away from is not gone on to once they may open it, or one they may not open is. */
  it('goes on to the page asked for before when it opens, and stays on the landing page when it does not', () => {
    const signer: Viewer = { signedIn: true, view: VIEWS.company, signs: true };
    expect(afterSignIn(resolve('/', signer), 'home', signer)).toBe('home');
    expect(afterSignIn(resolve('/', VISITOR_AFTER), 'home', VISITOR_AFTER)).toBeNull();
  });

  /* RED WHEN: a person at an address no page opens for them is left there after signing in. */
  it('takes the person to the landing page from an address that opens nothing', () => {
    expect(afterSignIn(resolve('/nowhere', VISITOR_AFTER), null, VISITOR_AFTER)).toBe(HOME.visitor);
  });
});

describe('the application opens an invitation link', () => {
  const calls: unknown[][] = [];
  const asked = (who: 'visitor' | 'signer') => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      if (args[0] !== '/api/me') throw new TypeError('network');
      return who === 'visitor'
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ user: { id: 'u1', email: null, name: 'Priya' }, accounts: [{ id: 'c1', createdAt: '2026-09-01T00:00:00.000Z', signerCount: 2, threshold: 2 }] }), { status: 200 });
    }));
  };
  const open = async (): Promise<HTMLElement> => {
    window.history.replaceState(null, '', `${join(ID)}#${TOKEN}`);
    const view = render(<Root />);
    await untilPageShown(view.container);
    return view.container;
  };

  /* RED WHEN: a visitor with an invitation link is sent to the landing page, is shown a menu, still has the token in the address, or the token is sent anywhere. */
  it('shows a visitor the joining page, with the token held and sent nowhere', async () => {
    asked('visitor');
    const container = await open();
    expect(window.location.pathname).toBe(join(ID));
    expect(window.location.hash).toBe('');
    expect(container.querySelector('[data-screen=join]')).not.toBeNull();
    expect(container.querySelector('[data-menu]')).toBeNull();
    expect(heldFor(ID)).toBe(TOKEN);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  /* RED WHEN: a signed-in person with an invitation link is refused the page, or shown it with no menu, or the token is sent anywhere. */
  it('shows a signed-in person the joining page in the frame, with the token held and sent nowhere', async () => {
    asked('signer');
    const container = await open();
    expect(window.location.pathname).toBe(join(ID));
    expect(window.location.hash).toBe('');
    expect(container.querySelector('[data-screen=join]')).not.toBeNull();
    expect(container.querySelector('[data-menu]')).not.toBeNull();
    expect(heldFor(ID)).toBe(TOKEN);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });
});
