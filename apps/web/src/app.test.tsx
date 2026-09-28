// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { untilPageShown, untilShown } from './page-shown.test-support.js';
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
  /* Until the service has said who is signed in, the page is only a placeholder; the keyring it asks through, and the page, load on demand. */
  await untilPageShown(view.container);
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

  /* RED WHEN: a person who signs for a company is not shown the company view at its home, or is shown the landing page there. */
  it('shows a signer the company view, from its home', async () => {
    me = json(200, { user: PERSON, accounts: [COMPANY] });
    const { container } = await open(PAGES.home.path);
    expect(window.location.pathname).toBe(PAGES.home.path);
    expect(container.querySelector('[data-screen=landing]')).toBeNull();
    expect(container.querySelector('[data-menu-page=payroll]')).not.toBeNull();
    expect(container.querySelector('[data-menu-page=payslips]')).toBeNull();
    /* Home is built, loaded when first opened, and never Coming soon. */
    expect(container.querySelector('[data-screen=coming-soon]')).toBeNull();
    expect(container.querySelector('[data-screen=home]')).not.toBeNull();
  });

  /* RED WHEN: a person who signs for no company is shown the company view, or any company page. */
  it('shows a person who signs for no company their own pay, and no company page', async () => {
    me = json(200, { user: PERSON, accounts: [] });
    const { container } = await open(PAGES.payHome.path);
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

describe('the landing page, once signed in', () => {
  /* In an order no natural key gives, so a list sorted any way shows it. */
  const THREE = [
    /* At midday, so the day shown is the same in every time zone a test machine is in. */
    { id: 'c-2', createdAt: '2026-09-01T12:00:00.000Z', signerCount: 3, threshold: 2 },
    { id: 'c-3', createdAt: '2026-09-20T12:00:00.000Z', signerCount: 1, threshold: 1 },
    { id: 'c-1', createdAt: '2026-08-01T12:00:00.000Z', signerCount: 5, threshold: 3 },
  ];

  /*
   * RED WHEN: a signed-in person at the landing page is taken elsewhere, is
   * shown the sign-in, the menu, or a page other than the landing page; or the
   * page leaves out, adds, filters or reorders the companies the service gave.
   */
  it('changes in place to every company the person signs for, and Create a company', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    const { container } = await open(PAGES.landing.path);
    expect(window.location.pathname).toBe(PAGES.landing.path);
    expect(container.querySelector('[data-screen=landing][data-signed-in=true]')).not.toBeNull();
    expect(container.querySelector('[data-action=log-in]')).toBeNull();
    expect(container.querySelector('[data-action=get-started]')).toBeNull();
    expect(container.querySelector('[data-menu]')).toBeNull();
    expect([...container.querySelectorAll('[data-choose-a-company] [data-company]')].map((e) => e.getAttribute('data-company'))).toEqual(['c-2', 'c-3', 'c-1']);
    expect(container.querySelector('[data-choose-a-company] [data-action=create-company]')!.textContent).toBe(EN['switcher.create']);
  });

  /* RED WHEN: with no company, the page shows anything to choose, or not Create a company. */
  it('shows only Create a company to a person who signs for none', async () => {
    me = json(200, { user: PERSON, accounts: [] });
    const { container } = await open(PAGES.landing.path);
    const chooser = container.querySelector('[data-choose-a-company]')!;
    expect(chooser.querySelectorAll('[data-company]')).toHaveLength(0);
    expect(chooser.querySelectorAll('button')).toHaveLength(1);
    expect(chooser.querySelector('[data-action=create-company]')).not.toBeNull();
  });

  /* RED WHEN: pressing a company does not open that company in the company view, or the switcher then lists other companies than the landing page did. */
  it('opens the company pressed, and the switcher lists the same companies', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    const { container } = await open(PAGES.landing.path);
    await act(async () => { fireEvent.click(container.querySelector('[data-choose-a-company] [data-company=c-3]')!); await settle(); });
    expect(window.location.pathname).toBe(PAGES.home.path);
    await untilPageShown(container);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: '.', code: 'Period', ctrlKey: true })); await settle(); });
    const switcher = document.querySelector('[data-company-switcher]')!;
    expect([...switcher.querySelectorAll('[data-company]')].map((e) => e.getAttribute('data-company'))).toEqual(['c-2', 'c-3', 'c-1']);
    /* The company shown is the one pressed, not the first on the list: its date is on the switcher, and it alone is ticked. */
    expect(document.querySelector('[data-action=company-switcher]')!.textContent).toContain('Sep 20, 2026');
    expect([...switcher.querySelectorAll('[data-company]')].map((e) => e.querySelectorAll('svg').length)).toEqual([1, 2, 1]);
  });

  /*
   * RED WHEN: Create a company does not start the setup wizard at its first
   * step, or the wizard sets up a company the person already signs for: shows
   * it created, counts it, or offers to hand it over.
   */
  it('starts the wizard from Create a company, for a new company', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    const { container } = await open(PAGES.landing.path);
    await act(async () => { fireEvent.click(container.querySelector('[data-choose-a-company] [data-action=create-company]')!); await settle(); });
    expect(window.location.pathname).toBe(PAGES.setup.path);
    await untilShown(() => container.querySelector('[data-screen=setup]'), 'the setup wizard');
    await untilPageShown(container);
    expect(container.querySelector('[data-screen=setup] [data-current-step]')!.getAttribute('data-current-step')).toBe('createCompany');
    expect(container.querySelector('[data-mark=createCompany]')!.getAttribute('data-standing')).toBe('open');
    expect(container.querySelector('[data-progress]')!.getAttribute('aria-valuenow')).toBe('0');
    await act(async () => { fireEvent.mouseDown(container.querySelector('[data-setup-steps] [data-step=handOver]')!, { button: 0 }); await settle(); });
    expect(container.querySelector('[data-action=hand-over] [data-why]')!.getAttribute('data-why')).toBe('no-company');
  });

  /*
   * RED WHEN: a second list of companies is made: the service's list asked
   * for, or its rows read, anywhere but the adapter that asks who is signed
   * in; or the landing page or the switcher asking the service for anything
   * themselves rather than reading the application's one list.
   */
  it('reads one list of companies, through one adapter', () => {
    const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [`${dir}/${e.name}`] : []);
    const all = files(SRC).map((f) => ({ f: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));
    expect(all.filter((x) => /companiesFrom\(|\.accounts\b|\{[^}]*\baccounts\b[^}]*\}\s*=|\[['"]accounts['"]\]|['"]\/api\/me['"]|\/api\/accounts['"`]/.test(x.text)).map((x) => x.f)).toEqual(['adapters/session.ts']);
    expect(all.filter((x) => /\bwhoIsSignedIn\b/.test(x.text)).map((x) => x.f).sort()).toEqual(['adapters/session.ts', 'app.tsx']);
    for (const f of ['screens/landing.tsx', 'shell/company-switcher.tsx']) {
      const text = all.find((x) => x.f === f)!.text;
      expect(text, f).toMatch(/\.companies\b|\{ companies\b/);
      expect(text, f).not.toMatch(/\bfetch\b|\/api\//);
    }
  });
});
