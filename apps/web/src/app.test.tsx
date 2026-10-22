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
/* A sign-in refusal the test hands the landing page, in place of the real sign-in. */
const signing = vi.hoisted(() => ({ refuse: null as string | null }));
/* The names this device holds for the companies listed (opened, or kept with a creation not finished), by company; a company not in it has none. */
const names = vi.hoisted(() => new Map<string, string>());
/* Why each company's name did not open on this device, by company, as the names read keeps it. */
const whyNot = vi.hoisted(() => new Map<string, string>());
vi.mock('./adapters/session.js', async (real) => {
  const actual = await real<typeof import('./adapters/session.js')>();
  return ({
  ...actual,
  /* The waits between asks after a service could not check the sign-in are not waited for here; their lengths are pinned in adapters/session.test.ts. */
  whoIsSignedIn: () => actual.whoIsSignedIn(async () => {}),
  signIn: async (asking: { name: string; purpose: string }) => (signing.refuse === null
    ? actual.signIn(asking)
    : { of: 'refused', why: signing.refuse, retryAfterSeconds: null }),
  /* What the person's own wallet reads off the chain for the companies listed below. */
  approvalsNeededFor: async () => new Map([['c-2', 2], ['c-3', 1], ['c-1', 3]]),
  companyNamesFor: async () => Object.assign(new Map(names), { whyNot: new Map(whyNot) }),
  });
});
/* The mark the creation adapter gives each company; a company not in it is given none. */
const creations = vi.hoisted(() => ({ mark: new Map<string, 'not-finished'>() }));
vi.mock('./adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('./adapters/creation-standing.js')>()),
  creationOf: async (id: string | null) => ({ company: id, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: id === null ? null : creations.mark.get(id) ?? null }),
}));
/* The creation adapter loads when a list first needs it; loaded here, once, so no test waits on that load. */
await import('./adapters/creation-standing.js');
const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'locales/en.json'), 'utf8')) as Record<string, string>;
/* How a company with no name on the device is listed: by the day its account was made, written the way the app writes a day. */
const STARTED = (iso: string): string => EN['company.startedOn']!.replace('{date}', new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(iso)));

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
  creations.mark.clear(); names.clear(); whyNot.clear();
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
    /* The account's window is drawn in the page's body, outside the root, so an open panel does not hide it from assistive tools. */
    expect(document.querySelector('[data-account-frame]')).not.toBeNull();
    expect(container.querySelector('[data-account-frame]')).toBeNull();
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

describe('a sign-in the account did not finish', () => {
  afterEach(() => { signing.refuse = null; });

  /* RED WHEN: an ask that ran out while the account was open, an answer that came too late, or a request the account would not take is said in the words of an ask that expired before it arrived, or of signing in not finishing, or in another's words, or in none. */
  it('says each in its own words, and what resolves it', async () => {
    const seen: string[] = [];
    for (const [why, key, says] of [
      ['ran-out', 'signIn.refused.ranOut', /ran out of time while your account was open.*nothing was signed.*Press the button again/u],
      ['answered-too-late', 'signIn.refused.answeredTooLate', /account did answer.*too late.*not signed in.*Press the button again/u],
      ['unreadable', 'signIn.refused.unreadable', /would not take this request.*nothing was signed.*Reload this page and press the button again/u],
      ['expired', 'signIn.refused.expired', /had expired by the time it reached your account.*nothing was signed/u],
    ] as const) {
      signing.refuse = why;
      me = json(401, {});
      const { container } = await open(PAGES.landing.path);
      await act(async () => { fireEvent.click(container.querySelector('[data-action=log-in]')!); await settle(); });
      const alert = container.querySelector('[data-refusal]') as HTMLElement;
      expect(alert.getAttribute('data-refusal')).toBe(why);
      expect(alert.textContent).toContain(EN[key]);
      expect(EN[key]).toMatch(says);
      seen.push(EN[key]!);
      cleanup();
    }
    expect(new Set(seen).size).toBe(seen.length);
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

  /* RED WHEN: the landing page lists a company with an empty name, or a company the device holds no name for as anything but "A company you started on <day>", or a company the device does name as anything but that name. */
  it('lists a named company by its name and every other by the day it was started, never empty', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    names.set('c-3', 'Northwind');
    names.set('c-1', '  ');
    const { container } = await open(PAGES.landing.path);
    const listed = [...container.querySelectorAll('[data-choose-a-company] [data-company]')].map((e) => e.querySelector('span > span')?.textContent ?? '');
    expect(listed).toEqual([STARTED('2026-09-01T12:00:00.000Z'), 'Northwind', STARTED('2026-08-01T12:00:00.000Z')]);
    expect(listed.every((l) => l.trim() !== '')).toBe(true);
  });

  /* RED WHEN: pressing a company does not open that company in the company view, or the switcher then lists other companies than the landing page did. */
  it('opens the company pressed, and the switcher lists the same companies', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    const { container } = await open(PAGES.landing.path);
    /* A company this device holds no name for is shown as a company the person started on the day it was made, with its approvals as M/N Approval. */
    expect([...container.querySelectorAll('[data-choose-a-company] [data-company]')].map((e) => e.textContent))
      .toEqual([`${STARTED('2026-09-01T12:00:00.000Z')}2/3 Approval`, `${STARTED('2026-09-20T12:00:00.000Z')}1/1 Approval`, `${STARTED('2026-08-01T12:00:00.000Z')}3/5 Approval`]);
    await act(async () => { fireEvent.click(container.querySelector('[data-choose-a-company] [data-company=c-3]')!); await settle(); });
    expect(window.location.pathname).toBe(PAGES.home.path);
    await untilPageShown(container);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: '.', code: 'Period', ctrlKey: true })); await settle(); });
    const switcher = document.querySelector('[data-company-switcher]')!;
    expect([...switcher.querySelectorAll('[data-company]')].map((e) => e.getAttribute('data-company'))).toEqual(['c-2', 'c-3', 'c-1']);
    /* The company shown is the one pressed, not the first on the list: its approvals, which no other company shares, are on the switcher, and it alone is ticked. */
    expect(document.querySelector('[data-action=company-switcher]')!.textContent).toBe(`${STARTED('2026-09-20T12:00:00.000Z')}1/1 Approval`);
    expect([...switcher.querySelectorAll('[data-company]')].map((e) => e.querySelectorAll('svg').length)).toEqual([1, 2, 1]);
  });

  /*
   * RED WHEN: the landing page lists a company that is not finished without saying so, or says so of another company; or
   * pressing it opens the company's home instead of the wizard at "Finish creating the company".
   */
  /* RED WHEN: a company whose name did not open on this device is listed with no word of why, or another company is given the reason. */
  it('says why a company\'s name did not open on this device', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    whyNot.set('c-1', 'roster-not-believed');
    const { container } = await open(PAGES.landing.path);
    const unnamed = await untilShown(() => container.querySelector<HTMLElement>('[data-choose-a-company] [data-company=c-1] [data-company-unnamed][data-why]'), 'why the name did not open');
    expect(unnamed.dataset.why).toBe('roster-not-believed');
    /* RED WHEN: why the name did not open is only a tooltip, which a touch screen and a keyboard never show. */
    expect(container.querySelector('[data-choose-a-company] [data-company=c-1] [data-unnamed-why]')?.textContent).toBe(EN['act.refused.rosterNotBelieved']);
    /*
     * RED WHEN: the reason does not wrap inside the company's button, which never wraps, so a long reason runs off a narrow
     * screen. A browser lays the row out; this checks the reason and its column are given the classes that let it wrap.
     */
    const why = container.querySelector<HTMLElement>('[data-choose-a-company] [data-company=c-1] [data-unnamed-why]')!;
    expect(why.className).toMatch(/\bwhitespace-normal\b/u);
    expect(why.parentElement!.className).toMatch(/\bmin-w-0\b/u);
    expect(container.querySelectorAll('[data-choose-a-company] [data-why]').length).toBe(1);
  });

  it('marks a company that is not finished, and opens it at step 2 of the wizard', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    creations.mark.set('c-3', 'not-finished');
    names.set('c-3', 'Test-001');
    const { container } = await open(PAGES.landing.path);
    await untilShown(() => container.querySelector('[data-choose-a-company] [data-company=c-3] [data-not-finished]'), 'the mark on the company not finished');
    expect([...container.querySelectorAll('[data-choose-a-company] [data-company]')].map((e) => e.querySelector('[data-not-finished]')?.textContent ?? null))
      .toEqual([null, EN['company.notFinished'], null]);
    /* RED WHEN: a company not finished is listed on the landing page with no name, though this device holds the name the person gave it; or another company is given it. */
    await untilShown(() => container.querySelector('[data-choose-a-company] [data-company=c-3] [data-company-name]'), 'the name of the company not finished');
    expect([...container.querySelectorAll('[data-choose-a-company] [data-company]')].map((e) => e.querySelector('[data-company-name]')?.textContent ?? null)).toEqual([null, 'Test-001', null]);
    await act(async () => { fireEvent.click(container.querySelector('[data-choose-a-company] [data-company=c-3]')!); await settle(); });
    expect(window.location.pathname).toBe(PAGES.setup.path);
    await untilShown(() => container.querySelector('[data-screen=setup]'), 'the setup wizard');
    await untilPageShown(container);
    expect(container.querySelector('[data-screen=setup] [data-current-step]')!.getAttribute('data-current-step')).toBe('finishCompany');
  });

  /*
   * RED WHEN: Create a company does not start the setup wizard at its first
   * step, or the wizard sets up a company the person already signs for: shows
   * it created, counts it, or offers to hand it over; or a step after
   * finishing the company is offered before there is a company to finish.
   */
  it('starts the wizard from Create a company, for a new company', async () => {
    me = json(200, { user: PERSON, accounts: THREE });
    const { container } = await open(PAGES.landing.path);
    await act(async () => { fireEvent.click(container.querySelector('[data-choose-a-company] [data-action=create-company]')!); await settle(); });
    expect(window.location.pathname).toBe(PAGES.setup.path);
    await untilShown(() => container.querySelector('[data-screen=setup]'), 'the setup wizard');
    await untilPageShown(container);
    expect(container.querySelector('[data-screen=setup] [data-current-step]')!.getAttribute('data-current-step')).toBe('createCompany');
    expect(container.querySelector('[data-setup-steps] [data-step=createCompany]')!.getAttribute('data-standing')).toBe('open');
    expect(container.querySelector('[data-mark=createCompany]')!.getAttribute('data-filled')).toBe('false');
    /* One focused page: no menu, and the way out across the top. */
    expect(container.querySelector('[data-slot=focused-layout] [data-screen=setup]')).not.toBeNull();
    expect(container.querySelector('[data-menu]')).toBeNull();
    expect(container.querySelector('[data-slot=focused-layout] [data-action=exit-focused]')!.textContent).toBe(EN['page.setup.exit']);
    expect(container.querySelector('[data-progress]')!.getAttribute('aria-valuenow')).toBe('0');
    await act(async () => { fireEvent.mouseDown(container.querySelector('[data-setup-steps] [data-step=vault]')!, { button: 0 }); await settle(); });
    expect(container.querySelector('[data-step-blocked]')!.getAttribute('data-step-blocked')).toBe('finishCompany');
    expect(container.querySelector('[data-action=create-vault]')).toBeNull();
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
