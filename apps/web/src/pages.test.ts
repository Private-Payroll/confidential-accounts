import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVERY_PAGE, HOME, isBuilt, mayOpen, MENU_GROUPS, outerOf, pagesByShortcut, PAGES, reachedByName, SETTINGS_OF, valuesOf, VIEWS, viewFor, type Page, type PageId, type Text, type Viewer } from './pages.js';
import { MODE_NAMES, MODES } from './preferences.js';
import { addressOf, resolve, RESOLVED } from './router.js';
import { EVERY_SHORTCUT, SHORTCUTS, type Chord } from './shortcuts.js';
import { menuFor } from './shell/menu.js';

/*
 * THE ONE LIST OF PAGES, HELD TO WHAT IT PROMISES: every page is in it, every
 * entry is a page, no two share an address or a shortcut, and no page opens
 * for a person who may not see it, by the router, the menu or anything else.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const read = (p: string): string => readFileSync(SRC + p, 'utf8');

/** Every kind of person who looks at the application. */
const VIEWERS: Record<string, Viewer> = {
  visitor: { signedIn: false, view: VIEWS.company, signs: false },
  signerInTheCompanyView: { signedIn: true, view: VIEWS.company, signs: true },
  signerSeeingTheirPay: { signedIn: true, view: VIEWS.employee, signs: true },
  employee: { signedIn: true, view: viewFor(false, VIEWS.company), signs: false },
  /* Not a state the application makes (a person who signs for nothing is always shown their pay), but the rules must hold for it too. */
  nonSignerInTheCompanyView: { signedIn: true, view: VIEWS.company, signs: false },
};

/** Who may see each audience, written out by hand rather than worked out, so the rule is compared with the promise. */
const WHO_SEES: Record<Page['audience'], string[]> = {
  everyone: ['visitor', 'signerInTheCompanyView', 'signerSeeingTheirPay', 'employee', 'nonSignerInTheCompanyView'],
  visitor: ['visitor'],
  'signed-in': ['signerInTheCompanyView', 'signerSeeingTheirPay', 'employee', 'nonSignerInTheCompanyView'],
  company: ['signerInTheCompanyView'],
  employee: ['signerSeeingTheirPay', 'employee', 'nonSignerInTheCompanyView'],
};

describe('every page the design names is in the list', () => {
  /*
   * RED WHEN: a page the design names is dropped from the list, renamed, moved
   * to another view or another menu group, or the menu's order within a group
   * changes. The design's page map and left menus, section 2, written out.
   */
  it('has the design\'s pages, views and menu groups', () => {
    const shape = EVERY_PAGE.map((p) => [p.id, p.audience, p.group ?? outerOf(p) ?? '-']);
    expect(shape).toEqual([
      ['landing', 'everyone', '-'], ['join', 'visitor', '-'], ['setup', 'signed-in', '-'],
      ['home', 'company', 'top'], ['proposals', 'company', 'top'],
      ['payroll', 'company', 'money'], ['run', 'company', 'payroll'], ['vaults', 'company', 'money'], ['vault', 'company', 'vaults'],
      ['transactions', 'company', 'money'], ['reports', 'company', 'money'],
      ['people', 'company', 'people'], ['invitations', 'company', 'people'],
      ['disclosures', 'company', 'compliance'], ['policies', 'company', 'compliance'], ['activity', 'company', 'compliance'],
      ['apps', 'company', 'bottom'], ['settings', 'company', 'bottom'],
      ['settingsCompany', 'company', 'settings'], ['settingsSigners', 'company', 'settings'], ['settingsRoles', 'company', 'settings'],
      ['settingsAppearance', 'company', 'settings'], ['settingsLanguage', 'company', 'settings'], ['settingsAccount', 'company', 'settings'],
      ['settingsNotifications', 'company', 'settings'], ['settingsBilling', 'company', 'settings'],
      ['payHome', 'employee', 'top'], ['payslips', 'employee', 'top'], ['paymentsReceived', 'employee', 'top'], ['myDetails', 'employee', 'top'],
      ['documents', 'employee', 'top'], ['paySettings', 'employee', 'bottom'],
      ['payAppearance', 'employee', 'paySettings'], ['payLanguage', 'employee', 'paySettings'], ['payAccount', 'employee', 'paySettings'],
      ['payNotifications', 'employee', 'paySettings'],
    ]);
  });

  /* RED WHEN: a page that is built is shown as Coming soon, or a page not built yet is shown as working. */
  it('builds the frame\'s pages and the company pages that read, and shows every other page Coming soon', () => {
    expect(EVERY_PAGE.filter(isBuilt).map((p) => p.id)).toEqual([
      'landing', 'setup', 'home', 'proposals', 'payroll', 'run', 'vaults', 'vault', 'people', 'invitations',
      'settings', 'settingsAppearance', 'settingsLanguage', 'paySettings', 'payAppearance', 'payLanguage',
    ]);
  });

  /*
   * RED WHEN: a page the first download does not need is loaded with it
   * instead of when it is opened, so the download grows with every page; or
   * the list names a screen its module does not export.
   */
  it('loads every company page and the setup wizard when it is first opened', async () => {
    const onDemand = EVERY_PAGE.filter((p) => isBuilt(p) && typeof (p.shows.screen as { load?: unknown }).load === 'function').map((p) => p.id);
    expect(onDemand).toEqual(['setup', 'home', 'proposals', 'payroll', 'run', 'vaults', 'vault', 'people', 'invitations']);
    for (const id of onDemand) {
      const screen = PAGES[id].shows as { screen: { load: () => Promise<unknown>; screenName: string } };
      expect(typeof await screen.screen.load(), id).toBe('function');
    }
    const eager = read('pages.ts').match(/^import .* from '\.\/screens\/[^']+';$/gm) ?? [];
    expect(eager.map((l) => l.replace(/.*\/screens\/|';$/g, '')).sort()).toEqual(['appearance.js', 'landing.js', 'language.js', 'settings.js']);
  });

  /* RED WHEN: a menu group is added that no page is in, or a page names a group the menu does not have. */
  it('puts every menu page in a group the menu has, and every group has a page', () => {
    const groups = Object.keys(MENU_GROUPS);
    expect(EVERY_PAGE.filter((p) => p.group !== null && !groups.includes(p.group)).map((p) => p.id)).toEqual([]);
    for (const g of groups) expect(EVERY_PAGE.some((p) => p.group === g), g).toBe(true);
  });
});

describe('every entry is a page, and every page is an entry', () => {
  /*
   * RED WHEN: a screen is written with no entry that shows it (a file in
   * screens/ the list does not use), or an entry names a screen that is not a
   * page's screen. Every exported component of every file in screens/ must be
   * shown by an entry.
   */
  it('shows every screen in screens/ and its folders from an entry', async () => {
    /* A screen loaded on demand is compared by what it loads, not by the placeholder that loads it. */
    const screenOf = async (p: Page): Promise<unknown> => {
      const screen = (p.shows as { screen?: { load?: () => Promise<unknown> } }).screen;
      return typeof screen?.load === 'function' ? screen.load() : screen;
    };
    const screens = await Promise.all(EVERY_PAGE.filter(isBuilt).map(async (p) => ({ id: p.id, screen: await screenOf(p) })));
    const shown = new Set(screens.map((x) => x.screen));
    const walk = (dir: string): string[] => readdirSync(SRC + dir, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`.slice('screens/'.length)]));
    const files = walk('screens').filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n));
    expect(files.length).toBeGreaterThan(0);
    const unlisted: string[] = [];
    for (const f of files) {
      const mod = (await import(`./screens/${f}`)) as Record<string, unknown>;
      const components = Object.entries(mod).filter(([name, v]) => typeof v === 'function' && /^\p{Lu}/u.test(name));
      expect(components.length, f).toBeGreaterThan(0);
      for (const [name, v] of components) if (!shown.has(v)) unlisted.push(`${f}#${name}`);
    }
    expect(unlisted).toEqual([]);
    /* And every screen an entry shows is one of those files'. */
    const fromScreens = new Set<unknown>();
    for (const f of files) for (const v of Object.values((await import(`./screens/${f}`)) as Record<string, unknown>)) fromScreens.add(v);
    expect(screens.filter((x) => !fromScreens.has(x.screen)).map((x) => x.id)).toEqual([]);
  });

  /*
   * RED WHEN: a page's name, other words or Coming soon line, a menu group's
   * heading, a shortcut's description or an appearance mode's name is written
   * in the code instead of asked for by its key, or asks for a key the English
   * file lacks. Each is called with a stand-in that returns the key it was
   * asked for, marked, so anything else it returns was written in the code.
   */
  it('asks for every name and line by its key, and writes none itself', () => {
    const en = JSON.parse(read('locales/en.json')) as Record<string, string>;
    const asked: string[] = [];
    const stub = ((k: string) => { asked.push(k); return `\u0000${k}`; }) as Text;
    const marked = (v: string) => v.startsWith('\u0000') && v.slice(1) in en;
    for (const p of EVERY_PAGE) {
      expect(marked(p.name(stub)), `${p.id} name`).toBe(true);
      if (p.words !== undefined) expect(marked(p.words(stub)), `${p.id} words`).toBe(true);
      const soon = (p.shows as { comingSoon?: (t: Text) => string }).comingSoon;
      if (soon !== undefined) expect(marked(soon(stub)), `${p.id} soon`).toBe(true);
    }
    for (const heading of Object.values(MENU_GROUPS)) if (heading !== null) expect(marked(heading(stub))).toBe(true);
    for (const s of EVERY_SHORTCUT) {
      expect(marked(s.does(stub)), `${s.id} does`).toBe(true);
      if (s.soon !== undefined) expect(marked(s.soon(stub)), `${s.id} soon`).toBe(true);
    }
    for (const m of MODES) expect(marked(MODE_NAMES[m](stub)), m).toBe(true);
    expect(asked.length).toBeGreaterThan(EVERY_PAGE.length * 2);
  });

  /* RED WHEN: an entry is neither built nor Coming soon with what it will be, or a Coming soon page says nothing about what it will be. */
  it('gives every entry a screen, or a line on what it will be', () => {
    for (const p of EVERY_PAGE) {
      const soon = (p.shows as { comingSoon?: unknown }).comingSoon;
      expect(isBuilt(p) !== (typeof soon === 'function'), p.id).toBe(true);
    }
  });

  /* RED WHEN: a page is shown inside a page that is not in the list, inside one that is not built, inside one of another audience, or inside itself. */
  it('shows a page only inside a built page of its own audience', () => {
    for (const p of EVERY_PAGE) {
      const outer = outerOf(p);
      if (outer === undefined) continue;
      expect(Object.keys(PAGES), p.id).toContain(outer);
      const o = PAGES[outer] as Page;
      expect(isBuilt(o), p.id).toBe(true);
      expect(o.audience, p.id).toBe(p.audience);
      expect(outer, p.id).not.toBe(p.id);
      expect(p.path.startsWith(o.path + '/'), p.id).toBe(true);
    }
  });

  /* RED WHEN: a view begins, or keeps its settings, at a page that is not in the list or not open to that view. */
  it('begins each view at a page of that view', () => {
    expect(mayOpen(PAGES[HOME.company], VIEWERS.signerInTheCompanyView!)).toBe(true);
    expect(mayOpen(PAGES[HOME.employee], VIEWERS.employee!)).toBe(true);
    expect(mayOpen(PAGES[HOME.visitor], VIEWERS.visitor!)).toBe(true);
    expect(mayOpen(PAGES[HOME.setup], VIEWERS.employee!)).toBe(true);
    /* The landing page is where a signed-in person chooses a company, so it opens for every kind of person. */
    for (const [who, v] of Object.entries(VIEWERS)) expect(mayOpen(PAGES[HOME.visitor], v), who).toBe(true);
    expect(mayOpen(PAGES[SETTINGS_OF.company], VIEWERS.signerInTheCompanyView!)).toBe(true);
    expect(mayOpen(PAGES[SETTINGS_OF.employee], VIEWERS.employee!)).toBe(true);
  });
});

describe('no two pages share an address or a shortcut', () => {
  /*
   * RED WHEN: two entries have one address, or two whose values stand in the
   * same places; an address is not written the way the router matches it; a
   * page is reached at another page's address; or a page that stands for a
   * value does not hand the value it was opened with to its screen.
   */
  it('gives every page its own address, and the router opens it there', () => {
    const paths = EVERY_PAGE.map((p) => p.path);
    const shapes = paths.map((p) => p.replace(/:[a-z]+/g, ':'));
    expect(shapes.filter((p, i) => shapes.indexOf(p) !== i)).toEqual([]);
    for (const p of paths) expect(p, p).toMatch(/^\/(?:(?:[a-z0-9-]+|:[a-z]+)(?:\/(?:[a-z0-9-]+|:[a-z]+))*)?$/);
    for (const p of EVERY_PAGE) {
      const viewer = Object.values(VIEWERS).find((v) => mayOpen(p, v))!;
      const params = Object.fromEntries(valuesOf(p).map((n) => [n, `${n}-1_A`]));
      const at = addressOf(p.id, params);
      const r = resolve(at, viewer);
      expect(r.of === RESOLVED.page ? r.id : null, p.id).toBe(p.id);
      expect(r.of === RESOLVED.page ? r.params : null, p.id).toEqual(params);
      expect(resolve(at + '/', viewer).of === RESOLVED.page ? (resolve(at + '/', viewer) as { id: PageId }).id : null, p.id).toBe(p.id);
    }
  });

  /*
   * RED WHEN: a page that stands for a value opens with it empty or missing,
   * or is offered by name in the command bar or by a shortcut, where it has
   * no value to open with.
   */
  it('opens a page that stands for a value only with one, and never by name', () => {
    const viewer = VIEWERS.signerInTheCompanyView!;
    expect(EVERY_PAGE.filter((p) => !reachedByName(p)).map((p) => [p.id, valuesOf(p)])).toEqual([['run', ['run']], ['vault', ['vault']]]);
    expect(resolve('/payroll/', viewer).of === RESOLVED.page ? (resolve('/payroll/', viewer) as { id: PageId }).id : null).toBe('payroll');
    expect(resolve('/payroll/r-1/more', viewer).of).toBe(RESOLVED.nothing);
    expect(() => addressOf('run')).toThrow();
    expect(() => addressOf('run', { run: '' })).toThrow();
    /* A value that could end its part, or be read as another address, is refused both ways. */
    expect(() => addressOf('run', { run: 'r/../../settings' })).toThrow();
    expect(resolve('/payroll/r%2F1', viewer).of).toBe(RESOLVED.nothing);
    const withShortcut = [{ ...EVERY_PAGE.find((p) => p.id === 'run')!, shortcut: 'create' }];
    expect(pagesByShortcut(withShortcut, viewer)).toEqual({});
  });

  /*
   * RED WHEN: two shortcuts are the same keys, by the character typed or by the
   * key's place (which is what a keyboard with other letters matches on); a
   * letter's place is not where that letter sits on an English keyboard; a
   * page names a shortcut that is not in the table; or a page takes a shortcut
   * another page or a command already has.
   */
  it('gives every shortcut its own keys, and every page shortcut is in the table and its own', () => {
    const byKey = (c: Chord) => [c.key, c.command === true, c.shift === true].map(String).join(' ');
    const byPlace = (c: Chord) => [c.code, c.command === true, c.shift === true].map(String).join(' ');
    for (const way of [byKey, byPlace]) {
      const all = EVERY_SHORTCUT.flatMap((s) => s.chords.map(way));
      expect(all.filter((c, i) => all.indexOf(c) !== i)).toEqual([]);
    }
    for (const c of EVERY_SHORTCUT.flatMap((s) => s.chords)) if (/^[a-z]$/.test(c.key)) expect(c.code, c.key).toBe(`Key${c.key.toUpperCase()}`);
    const byPages = EVERY_PAGE.flatMap((p) => (p.shortcut === undefined ? [] : [p.shortcut]));
    expect(byPages.filter((s) => !(s in SHORTCUTS))).toEqual([]);
    expect(byPages.filter((s, i) => byPages.indexOf(s) !== i)).toEqual([]);
    const commands = ['commandBar', 'everyShortcut', 'searchThisPage', 'create', 'nextRow', 'previousRow', 'openRow', 'close', 'toggleMenu', 'switchCompany', 'lightOrDark'];
    expect(Object.keys(SHORTCUTS)).toEqual(commands);
    expect(byPages.filter((s) => commands.includes(s))).toEqual([]);
  });
});

describe('no page opens for a person who may not see it', () => {
  /*
   * RED WHEN: a company page opens for an employee, or for a person who signs
   * for a company while they look at their own pay; an employee page opens in
   * the company view; a visitor's page (joining) opens for a signed-in person;
   * the landing page does not open for somebody; or any page but a visitor's
   * or everyone's opens for a visitor. Read for every page and every
   * kind of person, through the rule and through the router.
   */
  it.each(Object.keys(VIEWERS))('%s', (who) => {
    const viewer = VIEWERS[who]!;
    for (const p of EVERY_PAGE) {
      const may = WHO_SEES[p.audience].includes(who);
      expect(mayOpen(p, viewer), `${p.id} for ${who}`).toBe(may);
      const r = resolve(p.path, viewer);
      expect(r.of, `${p.id} by address for ${who}`).toBe(may ? RESOLVED.page : RESOLVED.notYours);
    }
  });

  /* RED WHEN: the menu lists a page its viewer may not open, leaves out one they may, or lists a page that has no group. */
  it('lists in the menu exactly the pages with a group that the viewer may open', () => {
    for (const [who, viewer] of Object.entries(VIEWERS)) {
      const listed = menuFor(viewer).flatMap((g) => g.pages.map((p) => p.id));
      expect(listed, who).toEqual(EVERY_PAGE.filter((p) => p.group !== null && mayOpen(p, viewer)).map((p) => p.id));
    }
    expect(menuFor(VIEWERS.employee!).flatMap((g) => g.pages.map((p) => p.id))).toEqual(['payHome', 'payslips', 'paymentsReceived', 'myDetails', 'documents', 'paySettings']);
  });

  /* RED WHEN: a page's own shortcut goes to it for a viewer who may not open it, or does not go to it for one who may. */
  it('gives a page\'s shortcut only to a viewer who may open it', () => {
    const pages = [{ ...EVERY_PAGE.find((p) => p.id === 'payroll')!, shortcut: 'create' }, { ...EVERY_PAGE.find((p) => p.id === 'payslips')!, shortcut: 'nextRow' }];
    expect(pagesByShortcut(pages, VIEWERS.signerInTheCompanyView!)).toEqual({ create: 'payroll' });
    expect(pagesByShortcut(pages, VIEWERS.employee!)).toEqual({ nextRow: 'payslips' });
    expect(pagesByShortcut(pages, VIEWERS.visitor!)).toEqual({});
    expect(pagesByShortcut(EVERY_PAGE, VIEWERS.signerInTheCompanyView!)).toEqual({});
  });

  /* RED WHEN: an address in no entry opens a page. */
  it('opens nothing at an address the list does not name', () => {
    for (const viewer of Object.values(VIEWERS)) {
      for (const at of ['/nowhere', '/settings/appearance/more', '/HOME', '/pay/settings/company', '/api/me']) {
        expect(resolve(at, viewer).of, at).toBe(RESOLVED.nothing);
      }
    }
  });
});

describe('the menu, the command bar, the shortcuts and the router read the list and nothing else', () => {
  const files = (dir: string): string[] => readdirSync(SRC + dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(`${dir}${d.name}/`) : [`${dir}${d.name}`]))
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\./.test(p));
  const own = files('');

  /*
   * RED WHEN: a file other than the list writes an address of the
   * application (`'/settings'`, `"/pay"`, a template starting with `/`), so a
   * page or a link exists that the list does not name. The adapters write the
   * service's addresses, which are not pages.
   */
  it('writes an address of the application only in the list', () => {
    const outside = own.filter((p) => p !== 'pages.ts' && !p.startsWith('adapters/'));
    expect(outside.length).toBeGreaterThan(10);
    /* The one exception: the shortcut table names the / key, which is a key and not an address. */
    const key = (p: string, m: string): boolean => p === 'shortcuts.ts' && m === "'/'";
    /* A part that stands for a value (`/payroll/:run`) is an address too. */
    const address = /(['"`])\/(?:[a-z][\w-]*)?(?:\/:?[\w-]+)*(?:\1|\/?\$\{|[?#])/g;
    const breaches = outside.flatMap((p) => [...read(p).matchAll(address)].filter((m) => !key(p, m[0])).map((m) => `${p}: ${m[0]}`));
    expect(breaches).toEqual([]);
    /* The rule reads what it is for: the list itself is full of addresses. */
    expect([...read('pages.ts').matchAll(/(['"`])\/(?:[a-z][\w-]*)?(?:\/:?[\w-]+)*\1/g)].length).toBe(EVERY_PAGE.length);
  });

  /*
   * RED WHEN: a file other than the shortcut table listens for keys, or reads
   * which modifier is held, so a shortcut exists that the table does not name.
   * The command bar reads the arrow keys and Enter of its own list, and a link
   * reads whether a modifier asks for a new tab; neither is a shortcut.
   */
  it('reads the keyboard only in the shortcut table, the command bar\'s list and a link', () => {
    const allowed: Record<string, RegExp> = {
      'shortcuts.ts': /./,
      'shell/command-bar.tsx': /onKeyDown/,
      'router.tsx': /metaKey|ctrlKey|shiftKey|altKey/,
    };
    const reads = /keydown|keyup|keypress|onKey(?:Down|Up|Press)|metaKey|ctrlKey|altKey|shiftKey/g;
    const breaches = own.flatMap((p) => [...read(p).matchAll(reads)].filter((m) => !(allowed[p]?.test(m[0]) ?? false)).map((m) => `${p}: ${m[0]}`));
    expect(breaches).toEqual([]);
    expect(read('shortcuts.ts').match(reads)?.length ?? 0).toBeGreaterThan(5);
  });
});
