// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import type { Company } from './adapters/company-records.js';
import { untilPageShown } from './page-shown.test-support.js';

/*
 * ONE MENU. No page adds a second menu beside the main left menu: whatever a
 * page holds (its sections, lists or steps) is reached by tabs across the
 * top, and those tabs are the kit's one tabs component. Every page is drawn,
 * in the frame when its viewer is signed in, with the company's records
 * locked and again opened; and every file of the application is read, so a
 * later change cannot bring a second menu back on any page.
 *
 * And a test that opens a page waits for it through the one shared helper,
 * never for a fixed number of turns.
 */
const records = vi.hoisted(() => ({ company: { of: 'locked' } as unknown }));
vi.mock('./adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('./adapters/company-records.js')>()),
  readCompany: async () => records.company,
}));
vi.mock('./adapters/handover-state.js', async (real) => ({
  ...(await real<typeof import('./adapters/handover-state.js')>()),
  readHandover: async () => ({ of: 'vault-keys-missing', signers: 1 }),
}));
vi.mock('./adapters/session.js', async (real) => ({
  ...(await real<typeof import('./adapters/session.js')>()),
  companyNamesFor: async () => new Map<string, string>(),
}));

const { InFrame, PageView } = await import('./app.js');
const { SessionProvider } = await import('./session.js');
const { DEFAULT_PREFERENCES } = await import('./preferences.js');
const { addressOf, resolve: resolveAddress, RESOLVED } = await import('./router.js');
const { EVERY_PAGE, mayOpen, VIEWS } = await import('./pages.js');
type PageId = import('./pages.js').PageId;
type Viewer = import('./pages.js').Viewer;

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SRC, '../../..');
const EN = JSON.parse(readFileSync(`${SRC}/locales/en.json`, 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });

const SIGNER: Viewer = { signedIn: true, view: VIEWS.company, signs: true };
const EMPLOYEE: Viewer = { signedIn: true, view: VIEWS.employee, signs: false };
const VISITOR: Viewer = { signedIn: false, view: VIEWS.employee, signs: false };

/** A company whose records opened, with one of each record, so what a page draws from them is drawn too. */
const OPEN: Company = {
  of: 'open', id: 'c-1', name: 'Northwind', signers: [{ id: 's1', name: 'Priya' }], approvalsNeeded: 1,
  proposals: { of: 'read', value: [{ id: 'p1', kind: 'payroll', status: 'open', raisedBy: 'Sam', approvals: 0, needed: 1, raisedAt: '2026-09-21T00:00:00.000Z', pays: { run: 'x1', period: '2026-10', currency: 'NIGHT' } }] },
  runs: { of: 'read', value: [{
    id: 'x1', period: '2026-10', status: 'proposed', settledAt: null,
    payees: [{ id: 'e1', name: 'Ana', amount: privateAmount(5n, 6, 'NIGHT'), paid: 'privately' }, { id: 'e2', name: 'Bo', amount: publicAmount(2n, 6, 'NIGHT'), paid: 'publicly' }],
    currencies: [{ code: 'NIGHT', privately: privateAmount(5n, 6, 'NIGHT'), publicly: publicAmount(2n, 6, 'NIGHT') }],
    legs: [{ code: 'NIGHT', vault: 'x1', payees: 2 }], unrecognised: 0,
  }] },
  people: { of: 'read', value: [{ id: 'e1', name: 'Ana', title: 'Engineer', standing: 'active', pay: privateAmount(5n, 6, 'NIGHT'), paid: 'privately', startedAt: '2026-01-01' }] },
  vaults: { of: 'read', value: [{ vault: 'x1', createdAt: '2026-09-01T00:00:00.000Z', standing: 'held-by-committee' }] },
  invitations: { of: 'read', value: [{ kind: 'signer', name: 'Tom', sentAt: '2026-09-10T00:00:00.000Z', expiresAt: null }] },
};

/** Every file under `dir`, relative to the repository, read. */
const walk = (dir: string): { path: string; text: string }[] => readdirSync(`${ROOT}/${dir}`, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [{ path: `${dir}/${e.name}`, text: readFileSync(`${ROOT}/${dir}/${e.name}`, 'utf8') }] : []);
const APP = walk('apps/web/src');
const APP_CODE = APP.filter((f) => !/\.test(-support)?\.tsx?$/.test(f.path));
const KIT_CODE = walk('packages/ui/src').filter((f) => !/\.test(-support)?\.tsx?$/.test(f.path));

/** Draw a page in the frame its entry names, for a viewer who may open it, with every value its address stands for filled, and read nothing yet. */
function drawNow(id: PageId) {
  const page = EVERY_PAGE.find((p) => p.id === id)!;
  const viewer = [SIGNER, EMPLOYEE, VISITOR].find((v) => mayOpen(page, v))!;
  const params = Object.fromEntries([...page.path.matchAll(/:(\w+)/g)].map((m) => [m[1]!, 'x1']));
  window.history.replaceState(null, '', addressOf(id, params));
  const session = {
    person: { id: 'u1', name: 'Priya' }, companies: viewer.signs ? [{ id: 'c-1', createdAt: '2026-09-01T00:00:00.000Z', signers: 1, approvalsNeeded: 1 }] : [],
    company: viewer.signs ? 'c-1' : null, chooseCompany: vi.fn(), viewer, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
    choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
  };
  const view = render(
    <KitProvider languages={LANGUAGES} pick="en">
      <SessionProvider session={session}>
        {viewer.signedIn ? <InFrame current={id}><PageView id={id} params={params} /></InFrame> : <PageView id={id} params={params} />}
      </SessionProvider>
    </KitProvider>,
  );
  return view.container;
}

/** Draw a page, and wait until it is on screen. */
async function draw(id: PageId) {
  const container = drawNow(id);
  await untilPageShown(container);
  return container;
}

/** The main left menu, which is the one menu, and the kit's tab lists: the places navigation may be. */
const ALLOWED = '[data-menu], [data-slot=tabs-list]';

/**
 * The second menus drawn on a page: a nav or navigation landmark outside the
 * main menu; a tab list or tab that is not the kit's; a kit tab list set
 * down the side; or a list of three or more links to other pages, each entry
 * one link, outside the main menu and the kit's tabs.
 */
function secondMenusIn(container: HTMLElement): string[] {
  const found: string[] = [];
  const outside = (e: Element) => e.closest(ALLOWED) === null;
  for (const e of container.querySelectorAll('nav, [role=navigation]')) if (outside(e)) found.push(`a ${e.tagName.toLowerCase()} beside the menu`);
  for (const e of container.querySelectorAll('[role=tablist]')) if (e.getAttribute('data-slot') !== 'tabs-list') found.push('a tab list not the kit\'s');
  for (const e of container.querySelectorAll('[role=tab]')) if (e.getAttribute('data-slot') !== 'tabs-trigger') found.push('a tab not the kit\'s');
  for (const e of container.querySelectorAll('[data-slot=tabs-list]')) if (e.getAttribute('aria-orientation') !== 'horizontal') found.push('the kit\'s tabs set down the side');
  for (const e of container.querySelectorAll('[role=menu], [role=menubar]')) if (outside(e)) found.push('a menu beside the menu');
  /* A page link is a link whose address opens a page with no value in it: a row that opens one record is not a menu. */
  const pageOf = (a: Element): string | null => {
    const r = resolveAddress(a.getAttribute('href') ?? '', SIGNER);
    const at = r.of === RESOLVED.page ? r : resolveAddress(a.getAttribute('href') ?? '', EMPLOYEE);
    return at.of === RESOLVED.page && !at.page.path.includes(':') ? at.id : null;
  };
  for (const list of container.querySelectorAll('*')) {
    if (!outside(list)) continue;
    const entries = [...list.children].map((c) => [...(c.matches('a[href]') ? [c] : c.querySelectorAll('a[href]'))]).filter((links) => links.length === 1).map((links) => pageOf(links[0]!)).filter((p) => p !== null);
    if (new Set(entries).size >= 3) found.push(`a list of links to ${[...new Set(entries)].join(', ')}`);
  }
  return found;
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); window.sessionStorage.clear(); records.company = { of: 'locked' }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('one menu', () => {
  /*
   * RED WHEN: any page draws a second menu beside the main one: a nav, a
   * menu, tabs that are not the kit's or that run down the side, or a list
   * of links to other pages.
   */
  it.each(EVERY_PAGE.map((p) => p.id))('%s has no second menu, with the records locked and opened', async (id) => {
    records.company = { of: 'locked' };
    expect(secondMenusIn(await draw(id)), 'locked').toEqual([]);
    cleanup();
    records.company = OPEN;
    expect(secondMenusIn(await draw(id)), 'opened').toEqual([]);
  });

  /* RED WHEN: the wizard's steps or Settings' sections are not the kit's tabs across the top, one to a step or section. */
  it('puts the wizard\'s steps and Settings\' sections in the kit\'s tabs, across the top', async () => {
    const wizard = await draw('setup');
    const steps = wizard.querySelector('[data-setup-steps]')!;
    expect(steps.getAttribute('data-slot')).toBe('tabs-list');
    expect(steps.getAttribute('aria-orientation')).toBe('horizontal');
    expect(steps.querySelectorAll('[data-slot=tabs-trigger]').length).toBe(5);
    cleanup();
    const settings = await draw('settingsAppearance');
    const sections = settings.querySelector('[data-settings-sections]')!;
    expect(sections.getAttribute('data-slot')).toBe('tabs-list');
    expect(sections.getAttribute('aria-orientation')).toBe('horizontal');
    expect([...sections.querySelectorAll('[data-slot=tabs-trigger]')].map((e) => e.getAttribute('href'))).toContain('/settings/appearance');
    expect(sections.querySelector('[data-slot=tabs-trigger][aria-selected=true]')!.getAttribute('href')).toBe('/settings/appearance');
  });

  /* RED WHEN: the page rule stops seeing what it is for: each kind of second menu, drawn, is found. */
  it('finds each kind of second menu when one is drawn', () => {
    const drawn = (html: string) => { const c = document.createElement('div'); c.innerHTML = html; return secondMenusIn(c); };
    expect(drawn('<nav></nav>')).toEqual(['a nav beside the menu']);
    expect(drawn('<div role="navigation"></div>')).toEqual(['a div beside the menu']);
    expect(drawn('<div role="tablist"><button role="tab"></button></div>')).toEqual(['a tab list not the kit\'s', 'a tab not the kit\'s']);
    expect(drawn('<div role="tablist" data-slot="tabs-list" aria-orientation="vertical"></div>')).toEqual(['the kit\'s tabs set down the side']);
    expect(drawn('<ul role="menu"></ul>')).toEqual(['a menu beside the menu']);
    expect(drawn('<ul><li><a href="/settings/appearance">a</a></li><li><a href="/settings/language">b</a></li><li><a href="/settings/account">c</a></li></ul>')).toEqual(['a list of links to settingsAppearance, settingsLanguage, settingsAccount']);
    expect(drawn('<div><a href="/payroll/r1">a</a><a href="/payroll/r2">b</a><a href="/payroll/r3">c</a></div>')).toEqual([]);
    expect(drawn('<div data-menu><nav><a href="/home">a</a><a href="/payroll">b</a><a href="/people">c</a></nav></div>')).toEqual([]);
  });
});

describe('one menu, in every file', () => {
  const NAV = /<nav\b|\brole=\{?\s*["'`](?:tablist|tab|menu|menubar|menuitem|navigation)["'`]/;
  const TABS_BY_HAND = /from\s+['"](?:radix-ui|@radix-ui\/[\w-]+)['"]/;
  const TABS_IMPORTED = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  const SIDEBAR = /\bSidebar\w*\b/;
  /* The kit's tabs laid out by a page (a class or an orientation on the tabs or their list) could be set down the side as a menu. */
  const TABS_LAID_OUT = /<(?:Tabs|TabsList)\b[^>]*?\b(?:className|orientation)=/;
  /* Going to a page from code, rather than by a link: a row of buttons that do it is a menu. */
  const GOES = /\bgo\(/;
  /* The main menu is the kit's sidebar, and the frame that holds it is the one place the sidebar's parts are used. */
  const FRAME = ['apps/web/src/shell/shell.tsx', 'apps/web/src/shell/menu.tsx', 'apps/web/src/shell/account-menu.tsx', 'apps/web/src/shell/company-switcher.tsx'];

  /*
   * RED WHEN: a file of the application writes a menu of its own (a nav, a
   * tab list, a menu), imports the primitives directly (from which tabs or a
   * menu could be built by hand) rather than using the kit's components,
   * takes the kit's tabs from anywhere but the kit, lays the kit's tabs out
   * itself, or uses the sidebar outside the frame's main menu.
   */
  it('has no nav, no tabs by hand and no second sidebar in the application', () => {
    expect(APP_CODE.length).toBeGreaterThan(40);
    expect(APP_CODE.filter((f) => NAV.test(f.text)).map((f) => f.path)).toEqual([]);
    expect(APP_CODE.filter((f) => TABS_BY_HAND.test(f.text)).map((f) => f.path)).toEqual([]);
    const tabsFrom = APP_CODE.flatMap((f) => [...f.text.matchAll(TABS_IMPORTED)].filter((m) => /\bTabs\w*\b/.test(m[1]!)).map((m) => `${f.path} ${m[2]}`));
    expect(tabsFrom.filter((x) => !x.endsWith(' vaults-ui'))).toEqual([]);
    expect(tabsFrom.map((x) => x.split(' ')[0]).sort()).toEqual(['apps/web/src/screens/invitations.tsx', 'apps/web/src/screens/proposals.tsx', 'apps/web/src/screens/settings.tsx', 'apps/web/src/screens/setup.tsx']);
    expect(APP_CODE.filter((f) => !FRAME.includes(f.path) && SIDEBAR.test(f.text)).map((f) => f.path)).toEqual([]);
    expect(APP_CODE.filter((f) => TABS_LAID_OUT.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  /*
   * RED WHEN: a file not named here goes to a page from code, so a column of
   * buttons could be a menu the link rules above do not see. Each file named
   * goes to one page for one reason: the router and the frame, the landing
   * page's Create a company, Home's setup card, Settings' tabs, the way out
   * of a focused page, and the Vaults page's way to the setup step that makes
   * creating a vault possible.
   */
  it('goes to a page from code only where it is named', () => {
    expect(APP_CODE.filter((f) => GOES.test(f.text) && f.path !== 'apps/web/src/router.tsx').map((f) => f.path).sort()).toEqual([
      'apps/web/src/app.tsx', 'apps/web/src/screens/home.tsx', 'apps/web/src/screens/landing.tsx', 'apps/web/src/screens/settings.tsx',
      'apps/web/src/screens/vaults.tsx', 'apps/web/src/shell/account-menu.tsx', 'apps/web/src/shell/command-bar.tsx', 'apps/web/src/shell/company-switcher.tsx', 'apps/web/src/shell/focused-frame.tsx',
      'apps/web/src/shell/shell.tsx',
    ]);
  });

  /*
   * RED WHEN: the kit builds tabs, or a tab, anywhere but its one tabs
   * component. A kit component that uses the tabs imports them from that
   * component and takes no tabs primitive of its own; the table's filters are
   * the one such component.
   */
  it('has one tabs component in the kit', () => {
    const TABS = /\bTabs\w*\b|\brole=\{?\s*["'`](?:tablist|tab)["'`]/;
    const USES_THE_KIT_TABS = (text: string): boolean => /from\s+['"]vaults-ui\/components\/tabs['"]/.test(text) && !/\brole=\{?\s*["'`](?:tablist|tab)["'`]/.test(text)
      && ![...text.matchAll(TABS_IMPORTED)].some((m) => /\bTabs\w*\b/.test(m[1]!) && m[2] !== 'vaults-ui/components/tabs');
    expect(KIT_CODE.filter((f) => TABS.test(f.text) && !USES_THE_KIT_TABS(f.text)).map((f) => f.path).sort()).toEqual(['packages/ui/src/components/tabs.tsx', 'packages/ui/src/index.ts']);
    expect(KIT_CODE.filter((f) => TABS.test(f.text) && USES_THE_KIT_TABS(f.text)).map((f) => f.path)).toEqual(['packages/ui/src/components/data-table.tsx']);
  });

  /* RED WHEN: a rule above stops matching what it is written to refuse. */
  it('reads each way a second menu is written', () => {
    for (const probe of ['<nav />', '<nav className="x">', '<div role="tablist" />', '<div role={"tab"} />', "<ul role={'menu'} />", '<div role=`navigation` />', '<li role="menuitem" />']) expect(NAV.test(probe), probe).toBe(true);
    for (const probe of ["import { Tabs } from 'radix-ui';", 'import * as T from "@radix-ui/react-tabs";']) expect(TABS_BY_HAND.test(probe), probe).toBe(true);
    for (const probe of ['<TabsList className="flex-col">', '<Tabs value={v} className="flex-row">', '<Tabs orientation="vertical" value={v}>', '<TabsList\n  className="w-48"\n>']) expect(TABS_LAID_OUT.test(probe), probe).toBe(true);
    expect(TABS_LAID_OUT.test('<TabsTrigger value="a" className="x">') || TABS_LAID_OUT.test('<Tabs value={v} data-tabs>')).toBe(false);
    expect(GOES.test('onClick={() => go(PAGE.home)}') && !GOES.test('const going = 1;')).toBe(true);
    expect(NAV.test('<navigation-bar />') || NAV.test('const role = "tab";')).toBe(false);
  });
});
