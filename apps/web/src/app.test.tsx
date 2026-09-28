// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGES } from './pages.js';
import { Root } from './root.js';

/*
 * THE APPLICATION FROM ITS ROOT, AGAINST A STAND-IN SERVICE: which frame and
 * which page each person is shown, and what an address none of it may open
 * shows them.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'locales/en.json'), 'utf8')) as Record<string, string>;

let me: () => Response;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const PERSON = { id: 'u1', email: null, name: 'Priya' };
const COMPANY = { id: 'c1', createdAt: '2026-09-01T00:00:00.000Z', signerCount: 2, threshold: 2 };
const settle = () => new Promise((r) => setTimeout(r, 0));

async function open(at: string) {
  window.history.replaceState(null, '', at);
  const view = render(<Root />);
  await act(settle);
  await act(settle);
  return view;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/me') return me();
    throw new TypeError('network');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('who is shown what', () => {
  /* RED WHEN: a visitor is shown the menu, or a page but the landing page, or is not taken to the landing page from a page that is not theirs. */
  it('shows a visitor the landing page and nothing else', async () => {
    me = json(401, {});
    const { container } = await open(PAGES.settingsAppearance.path);
    expect(window.location.pathname).toBe(PAGES.landing.path);
    expect(container.querySelector('[data-screen=landing]')).not.toBeNull();
    expect(container.querySelector('[data-menu]')).toBeNull();
    expect(container.querySelector('[data-account-frame]')).not.toBeNull();
  });

  /* RED WHEN: a person who signs for a company is not shown the company view, begins anywhere but its home, or is shown the landing page. */
  it('shows a signer the company view, from its home', async () => {
    me = json(200, { user: PERSON, accounts: [COMPANY] });
    const { container } = await open(PAGES.landing.path);
    expect(window.location.pathname).toBe(PAGES.home.path);
    expect(container.querySelector('[data-menu-page=payroll]')).not.toBeNull();
    expect(container.querySelector('[data-menu-page=payslips]')).toBeNull();
    expect(container.querySelector('[data-screen=coming-soon][data-page=home]')).not.toBeNull();
  });

  /* RED WHEN: a person who signs for no company is shown the company view, or any company page. */
  it('shows a person who signs for no company their own pay, and no company page', async () => {
    me = json(200, { user: PERSON, accounts: [] });
    const { container } = await open(PAGES.landing.path);
    expect(window.location.pathname).toBe(PAGES.payHome.path);
    expect(container.querySelector('[data-menu-page=payroll]')).toBeNull();
    expect(container.querySelector('[data-menu-page=payslips]')).not.toBeNull();
    cleanup();
    const again = await open(PAGES.payroll.path);
    expect(again.container.querySelector('[data-screen=no-page]')).not.toBeNull();
    expect(again.container.querySelector('[data-screen=coming-soon]')).toBeNull();
  });

  /* RED WHEN: an address no page is at opens something, or a page of the other view opens by its address. */
  it('opens nothing at an address no page is at, or of the other view', async () => {
    me = json(200, { user: PERSON, accounts: [COMPANY] });
    expect((await open('/nowhere')).container.querySelector('[data-screen=no-page]')).not.toBeNull();
    cleanup();
    expect((await open(PAGES.payslips.path)).container.querySelector('[data-screen=no-page]')).not.toBeNull();
  });

  /* RED WHEN: a service that cannot be reached is shown as nobody signed in, or companies kept apart are shown as none. */
  it('says when the service cannot be reached, and when companies cannot be shown together', async () => {
    me = () => { throw new TypeError('network'); };
    const a = await open(PAGES.home.path);
    expect(a.container.querySelector('[data-screen=service-unreachable]')).not.toBeNull();
    expect(a.container.querySelector('[data-screen=landing]')).toBeNull();
    cleanup();
    me = json(409, { code: 'records-from-more-than-one-ledger' });
    const b = await open(PAGES.home.path);
    expect(b.container.querySelector('[data-screen=records-apart]')).not.toBeNull();
    expect(b.container.querySelector('[data-menu]')).toBeNull();
  });
});

describe('signing in from the landing page', () => {
  /* RED WHEN: a sign-in that could not start says nothing, or says it in words that are not the language file's. */
  it('says why, in the language file\'s words, when it could not sign in', async () => {
    me = json(401, {});
    const { container } = await open(PAGES.landing.path);
    await act(async () => { fireEvent.click(container.querySelector('[data-action=log-in]')!); await settle(); });
    const alert = container.querySelector('[data-refusal]') as HTMLElement;
    expect(alert.getAttribute('data-refusal')).toBe('not-set-up');
    expect(alert.textContent).toContain(EN['signIn.refused.notSetUp']);
  });
});
