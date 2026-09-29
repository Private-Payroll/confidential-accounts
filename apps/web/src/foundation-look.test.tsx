// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { classWordsOf, KIT_ENTRIES, utilityOf } from 'vaults-ui/rules/source-rules.test-support';
import { untilPageShown } from './page-shown.test-support.js';

/*
 * THE FOUNDATION'S LOOK, HELD ON EVERY PAGE. Every page a signed-in person
 * opens is drawn in the kit's page layout, or, for a page its entry marks
 * focused, in the kit's focused layout with no menu. And every file a page is
 * drawn from is read, so that no page paints its own background, chooses its
 * own width, or builds its own section, list, table or empty state: those
 * are the kit's, so every page looks like every other.
 *
 * THE PAGES NOT MOVED TO THE KIT YET are each named below with what moves
 * them, and each is held to still breaking the rule it is named for, so the
 * list can only shrink: a page that is fixed and left on it goes red.
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
const { addressOf } = await import('./router.js');
const { EVERY_PAGE, mayOpen, PAGES, VIEWS } = await import('./pages.js');
type PageId = import('./pages.js').PageId;
type Viewer = import('./pages.js').Viewer;
type Page = import('./pages.js').Page;

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

/** Draw a page in the frame its entry names, for `viewer`, with every value its address stands for filled, and wait until it is on screen. */
async function draw(id: PageId, viewer: Viewer) {
  const page = EVERY_PAGE.find((p) => p.id === id)!;
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
  await untilPageShown(view.container);
  return view.container;
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); window.sessionStorage.clear(); records.company = { of: 'locked' }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/**
 * THE PAGES DRAWN BEFORE ANYONE IS SIGNED IN, outside any frame: the landing
 * page is a layout of its own, where a visitor signs in, until it is redrawn
 * on the kit's layouts; and joining, not built yet, which a visitor opens
 * before signing in.
 */
const OUTSIDE_A_FRAME: readonly PageId[] = ['landing', 'join'];

describe('every page in the kit\'s layout', () => {
  /*
   * RED WHEN: a page a signed-in person opens is drawn outside the kit's page
   * layout; the frame stops putting pages in it; a page marked focused is
   * drawn in the frame with the menu; or the layout loses its maximum width.
   */
  it.each(EVERY_PAGE.filter((p) => !OUTSIDE_A_FRAME.includes(p.id)).map((p) => p.id))('%s', async (id) => {
    const viewer = [SIGNER, EMPLOYEE].find((v) => mayOpen(PAGES[id], v))!;
    const c = await draw(id, viewer);
    const screen = c.querySelector('[data-screen]')!;
    if ((PAGES[id] as Page).focused !== undefined) {
      expect(screen.closest('[data-slot=focused-layout]'), id).not.toBeNull();
      expect(c.querySelector('[data-menu]'), id).toBeNull();
    } else {
      const layout = screen.closest('[data-slot=page-layout]');
      expect(layout, id).not.toBeNull();
      expect(layout!.className.split(/\s+/), id).toContain('max-w-7xl');
      expect(c.querySelector('[data-menu]'), id).not.toBeNull();
    }
  });

  /* RED WHEN: a page a visitor cannot open is exempted from the frame. */
  it('lets only pages a visitor opens be drawn outside a frame', () => {
    for (const id of OUTSIDE_A_FRAME) expect(mayOpen(PAGES[id], VISITOR), id).toBe(true);
  });
});

describe('the setup wizard, one focused page', () => {
  /*
   * RED WHEN: the wizard shows the menu, with or without a company, the first
   * time or any time after; loses its way out; or the way out does not go to
   * where the person's view begins.
   */
  it.each([['with a company', SIGNER, '/home'], ['before a company exists', EMPLOYEE, '/pay']] as const)('%s, on every visit, with Exit setup', async (_, viewer, home) => {
    for (const visit of [1, 2]) {
      const c = await draw('setup', viewer);
      expect(c.querySelector('[data-slot=focused-layout] [data-screen=setup]'), `visit ${visit}`).not.toBeNull();
      expect(c.querySelector('[data-menu]'), `visit ${visit}`).toBeNull();
      expect(c.querySelector('[data-slot=focused-title]')!.textContent).toBe(EN['page.setup.name']);
      const exit = c.querySelector('[data-action=exit-focused]') as HTMLElement;
      expect(exit.textContent).toBe(EN['page.setup.exit']);
      await act(async () => { fireEvent.click(exit); });
      expect(window.location.pathname).toBe(home);
      cleanup();
    }
  });
});

/* ------------------------------------------------ what a page may not draw itself */

interface Source { path: string; text: string }
const walk = (dir: string): Source[] => readdirSync(`${ROOT}/${dir}`, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) && !/\.test(-support)?\.tsx?$/.test(e.name) ? [{ path: `${dir}/${e.name}`, text: readFileSync(`${ROOT}/${dir}/${e.name}`, 'utf8') }] : []);

/** The files a page is drawn from: the screens, the parts they share, the setup steps' actions and forms, and the frame's own page bodies. */
const PAGE_CODE: Source[] = [
  ...walk('apps/web/src/screens'), ...walk('apps/web/src/records'), ...walk('apps/web/src/actions'), ...walk('apps/web/src/setup'),
  ...['apps/web/src/shell/coming-soon-page.tsx', 'apps/web/src/shell/no-page.tsx'].map((p) => ({ path: p, text: readFileSync(`${ROOT}/${p}`, 'utf8') })),
];

/** A class that paints a background, in any state. */
const paintsBackground = (s: Source): string[] => classWordsOf(s).map((w) => w.word).filter((w) => /^bg-/.test(utilityOf(w)));
/**
 * A class that sets how wide or tall the page is, or centres it: the page
 * layout's to set. A part of a page may hold its own text or form to a
 * reading width (`max-w-prose`, and `xs` to `xl`, at most 36rem); anything
 * wider, and any width written as a value, is the page choosing its own.
 */
const setsPageWidth = (s: Source): string[] => classWordsOf(s).map((w) => w.word)
  .filter((w) => /^(?:mx-auto|container|w-screen|h-screen|min-h-(?:svh|dvh|lvh|screen)|max-w-(?:screen\S*|[2-7]xl|full|none)|(?:min-w|max-w|w)-[[(].*)$/.test(utilityOf(w)));
/** An element that builds a section, a list or a table, by its tag or its role: the kit's section, rows and table draw these. */
const buildsSectionsOrLists = (s: Source): string[] => [
  ...[...s.text.matchAll(/<(section|ul|ol|li|dl|table|thead|tbody|tr|td|th)\b/g)].map((m) => m[1]!),
  ...[...s.text.matchAll(/\brole=\{?\s*["'`](list|listitem|table|row|cell|rowgroup|grid|region)["'`]/g)].map((m) => `role ${m[1]!}`),
];
/**
 * A phrase saying there is nothing there (a key ending `.none` or `.empty`)
 * asked for anywhere but inside the kit's empty state: an empty state built
 * by hand.
 */
function emptyStatesByHand(s: Source): string[] {
  const out: string[] = [];
  for (const m of s.text.matchAll(/\bt\(\s*['"]([\w.]+\.(?:none|empty))['"]/g)) {
    const before = s.text.slice(0, m.index);
    if (before.lastIndexOf('<EmptyState') <= before.lastIndexOf('</EmptyState>')) out.push(m[1]!);
  }
  return out;
}

/**
 * THE FILES NOT MOVED TO THE KIT YET, BY RULE, each with what moves it. A
 * file here must still break its rule: once it is fixed it comes off.
 */
const NOT_MOVED_YET: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  background: {
    'apps/web/src/screens/landing.tsx': 'the landing page, drawn before anyone is signed in, redrawn on the kit\'s layouts with the app\'s polish',
    'apps/web/src/screens/people.tsx': 'the people list, moved to the kit\'s table with inviting and joining',
    'apps/web/src/screens/proposals.tsx': 'the proposals list, moved to the kit\'s table with raising and approving proposals',
  },
  width: {
    'apps/web/src/screens/landing.tsx': 'the landing page, drawn before anyone is signed in, redrawn on the kit\'s layouts with the app\'s polish',
    'apps/web/src/screens/appearance.tsx': 'Settings\' sections, held to a width of their own until they move to the kit\'s sections with the rest of Settings',
    'apps/web/src/screens/language.tsx': 'Settings\' sections, held to a width of their own until they move to the kit\'s sections with the rest of Settings',
  },
  lists: {
    'apps/web/src/screens/landing.tsx': 'the landing page, redrawn on the kit\'s layouts with the app\'s polish',
    'apps/web/src/screens/proposals.tsx': 'moved to the kit\'s table with raising and approving proposals',
    'apps/web/src/screens/payroll.tsx': 'moved to the kit\'s table with raising payroll runs for approval',
    'apps/web/src/screens/run.tsx': 'moved to the kit\'s table with raising payroll runs for approval',
    'apps/web/src/screens/people.tsx': 'moved to the kit\'s table with inviting and joining',
    'apps/web/src/screens/invitations.tsx': 'moved to the kit\'s table with inviting and joining',
    'apps/web/src/screens/vault.tsx': 'moved to the kit\'s sections with putting money into vaults',
    'apps/web/src/screens/appearance.tsx': 'moved to the kit\'s sections with the rest of Settings',
    'apps/web/src/screens/language.tsx': 'moved to the kit\'s sections with the rest of Settings',
    'apps/web/src/actions/create-company.tsx': 'the setup steps\' own forms, moved to the kit\'s sections with the setup wizard',
    'apps/web/src/actions/hand-over.tsx': 'the setup steps\' own forms, moved to the kit\'s sections with the setup wizard',
  },
  empty: {
    'apps/web/src/screens/landing.tsx': 'the landing page, redrawn on the kit\'s layouts with the app\'s polish',
    'apps/web/src/screens/proposals.tsx': 'moved to the kit\'s table with raising and approving proposals',
    'apps/web/src/screens/payroll.tsx': 'moved to the kit\'s table with raising payroll runs for approval',
    'apps/web/src/screens/people.tsx': 'moved to the kit\'s table with inviting and joining',
    'apps/web/src/screens/invitations.tsx': 'moved to the kit\'s table with inviting and joining',
    'apps/web/src/screens/vaults.tsx': 'moved to the kit\'s sections with putting money into vaults',
    'apps/web/src/screens/vault.tsx': 'moved to the kit\'s sections with putting money into vaults',
  },
};
const RULES = { background: paintsBackground, width: setsPageWidth, lists: buildsSectionsOrLists, empty: emptyStatesByHand } as const;

describe('no page draws what the kit draws', () => {
  /* RED WHEN: the files a page is drawn from are not read, so every rule below passes over nothing. */
  it('reads every file a page is drawn from', () => {
    const paths = PAGE_CODE.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['apps/web/src/screens/home.tsx', 'apps/web/src/screens/setup.tsx', 'apps/web/src/records/parts.tsx', 'apps/web/src/actions/hand-over.tsx', 'apps/web/src/shell/no-page.tsx']));
    expect(paths.length).toBeGreaterThan(20);
  });

  /*
   * RED WHEN: a page paints its own background, sets its own width, builds its
   * own section, list or table, or its own empty state, outside the files
   * named as not moved yet.
   */
  it.each(Object.keys(RULES) as (keyof typeof RULES)[])('%s', (rule) => {
    const found = PAGE_CODE.filter((f) => !(f.path in NOT_MOVED_YET[rule]!)).map((f) => ({ path: f.path, found: RULES[rule](f) })).filter((x) => x.found.length > 0);
    expect(found).toEqual([]);
  });

  /* RED WHEN: a file named as not moved yet no longer breaks its rule and is left on the list, or the list names a file that is not there, or gives no reason. */
  it('names as not moved yet only files that still are', () => {
    for (const [rule, files] of Object.entries(NOT_MOVED_YET)) {
      for (const [path, why] of Object.entries(files)) {
        const f = PAGE_CODE.find((x) => x.path === path);
        expect(f, `${rule} ${path}`).toBeDefined();
        expect(RULES[rule as keyof typeof RULES](f!).length, `${rule} ${path}`).toBeGreaterThan(0);
        expect(why.length, path).toBeGreaterThan(20);
      }
    }
  });

  /*
   * RED WHEN: a kit entry kept out of the first download is imported by a
   * file that is not a screen loaded when its page is opened, so the first
   * download would carry it after all.
   */
  it('imports the kit\'s own entries only from screens loaded when opened', () => {
    const PAGES_TS = readFileSync(`${ROOT}/apps/web/src/pages.ts`, 'utf8');
    const onDemand = new Set([...PAGES_TS.matchAll(/onDemand\(\(\) => import\('\.\/(screens\/[\w-]+)\.js'\)/g)].map((m) => `apps/web/src/${m[1]!}.tsx`));
    const everyFile = walk('apps/web/src');
    const importers = everyFile.filter((f) => Object.keys(KIT_ENTRIES).some((e) => f.text.includes(`from '${e}'`))).map((f) => f.path);
    expect(importers).toEqual(['apps/web/src/screens/home.tsx']);
    for (const p of importers) {
      expect(onDemand.has(p), p).toBe(true);
      const name = p.replace(/^apps\/web\/src\//, '').replace(/\.tsx$/, '');
      expect(everyFile.filter((f) => f.path !== p && new RegExp(`from '[./]*${name}\\.js'`).test(f.text)).map((f) => f.path), p).toEqual([]);
    }
  });

  /*
   * RED WHEN: a page, the frame's page body or the application draws its own
   * loading lines (the bare skeleton, a pulse, or a busy mark of its own)
   * instead of a loading state of the kit's, shaped like what loads; or a
   * comment naming the kit's loading state stands in for drawing it.
   */
  it('draws what is loading only with the kit\'s loading states', () => {
    /* Read without comments, so a comment naming a loading state is not taken for one drawn. */
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const files = [...PAGE_CODE, { path: 'apps/web/src/app.tsx', text: readFileSync(`${ROOT}/apps/web/src/app.tsx`, 'utf8') }].map((f) => ({ path: f.path, text: code(f.text) }));
    expect(files.filter((f) => /\bSkeleton\b|\banimate-pulse\b/.test(f.text)).map((f) => f.path)).toEqual([]);
    /* A busy mark of its own is a loading state drawn by hand. The one allowed: the blank page before the service says who is signed in, when there is no frame yet to draw a page loading in. */
    const busy = files.flatMap((f) => [...f.text.matchAll(/aria-busy/g)].map(() => f.path));
    expect(busy).toEqual(['apps/web/src/app.tsx']);
    expect(files.find((f) => f.path === 'apps/web/src/app.tsx')!.text).toMatch(/if \(who\.of === LOADING\.of\) return <div className="min-h-svh bg-background" aria-busy=\{true\} \/>;/);
    expect(files.filter((f) => /<(?:PageLoading|SectionLoading)\b/.test(f.text)).map((f) => f.path).sort()).toEqual(['apps/web/src/app.tsx', 'apps/web/src/records/parts.tsx', 'apps/web/src/screens/setup.tsx']);
  });

  /* RED WHEN: Home, the setup wizard or the parts every page shares are named as not moved yet. */
  it('holds Home, the wizard and the shared parts to every rule', () => {
    for (const files of Object.values(NOT_MOVED_YET)) {
      expect(Object.keys(files).filter((p) => /\/(home|setup)\.tsx$|\/records\//.test(p))).toEqual([]);
    }
  });

  /* RED WHEN: a rule stops finding what it is written to refuse, or refuses what the kit draws. */
  it('finds each thing a page may not draw itself', () => {
    const f = (text: string): Source => ({ path: 'x.tsx', text });
    expect(paintsBackground(f('<div className="bg-muted p-4" />'))).toEqual(['bg-muted']);
    expect(paintsBackground(f('<a className="hover:bg-accent" />'))).toEqual(['hover:bg-accent']);
    expect(paintsBackground(f('<div className="text-muted-foreground" />'))).toEqual([]);
    expect(setsPageWidth(f('<main className="mx-auto max-w-5xl min-h-svh" />'))).toEqual(['mx-auto', 'max-w-5xl', 'min-h-svh']);
    expect(setsPageWidth(f('<p className="max-w-prose max-w-md max-w-xl" />'))).toEqual([]);
    expect(setsPageWidth(f('<div className="max-w-3xl max-w-[64rem] w-[1100px] min-w-(--x)" />'))).toEqual(['max-w-3xl', 'max-w-[64rem]', 'w-[1100px]', 'min-w-(--x)']);
    expect(buildsSectionsOrLists(f('<section><ul><li /></ul><table><tr><td /></tr></table></section>'))).toEqual(['section', 'ul', 'li', 'table', 'tr', 'td']);
    expect(buildsSectionsOrLists(f('<div role="list"><div role={"listitem"} /></div>'))).toEqual(['role list', 'role listitem']);
    expect(buildsSectionsOrLists(f('<Section title="x"><SectionRow /></Section><Table />'))).toEqual([]);
    expect(emptyStatesByHand(f("<p>{t('people.none')}</p>"))).toEqual(['people.none']);
    expect(emptyStatesByHand(f("<EmptyState icon={X}>{t('people.none')}</EmptyState>"))).toEqual([]);
    expect(emptyStatesByHand(f("<EmptyState icon={X}>{t('a.b')}</EmptyState><p>{t('people.none')}</p>"))).toEqual(['people.none']);
  });
});
