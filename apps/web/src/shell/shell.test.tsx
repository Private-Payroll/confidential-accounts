// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { untilPageShown, untilShown } from '../page-shown.test-support.js';
const names = vi.hoisted(() => ({ opened: new Map<string, string>(), approvals: new Map<string, number>() }));
/* The account's window, shown and put away by the test as the shared code would. */
const wallet = vi.hoisted(() => ({
  shown: false, watchers: new Set<(shown: boolean) => void>(),
  set(shown: boolean) { this.shown = shown; for (const w of [...this.watchers]) w(shown); },
}));
vi.mock('../adapters/session.js', async (real) => {
  const r = await real<typeof import('../adapters/session.js')>();
  return {
    ...r,
    companyNamesFor: async () => names.opened,
    approvalsNeededFor: async () => names.approvals,
    accountFrame: {
      ...r.accountFrame,
      mount: () => {},
      shown: () => wallet.shown,
      onShown: (watch: (shown: boolean) => void) => { wallet.watchers.add(watch); return () => { wallet.watchers.delete(watch); }; },
    },
  };
});
/* What the creation adapter says of each company: the mark it gives (null for a company it knows nothing of or could not read), and every read asked of it. */
const creations = vi.hoisted(() => ({ mark: new Map<string, 'not-finished'>(), reads: [] as (string | null)[], throwing: new Set<string>() }));
vi.mock('../adapters/creation-standing.js', async (real) => ({
  ...(await real<typeof import('../adapters/creation-standing.js')>()),
  creationOf: async (id: string | null) => {
    creations.reads.push(id);
    if (id !== null && creations.throwing.has(id)) throw new Error('read failed');
    return { company: id, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: id === null ? null : creations.mark.get(id) ?? null };
  },
}));
/* The ask of the wallet for the account's tokens: every ask that reaches it is kept, and it answers with nothing a page could show. */
const walletAsks = vi.hoisted(() => ({ asked: [] as unknown[][] }));
vi.mock('../adapters/account-balances.js', async (real) => ({
  ...(await real<typeof import('../adapters/account-balances.js')>()),
  askForAccountBalances: async (...args: unknown[]) => { walletAsks.asked.push(args); return { of: 'refused', why: 'declined' }; },
}));
vi.mock('../adapters/company-records.js', async (real) => ({
  ...(await real<typeof import('../adapters/company-records.js')>()),
  readCompany: async () => ({ of: 'locked' }),
}));
const { PageView } = await import('../app.js');
const { takeAsked } = await import('../setup/asked.js');
/* The creation adapter loads when a list first needs it; loaded here, once, so no test waits on that load. */
await import('../adapters/creation-standing.js');
/* The records are read lazily by the page; loaded here, once, so no test ends with that read still arriving (it did, 29 Sep, as 25 errors after the run). */
await import('../adapters/company-records.js');
import type { Company } from '../adapters/session.js';
import { EVERY_PAGE, isBuilt, mayOpen, PAGES, reachedByName, VIEWS, type PageId, type Viewer } from '../pages.js';
import { LANGUAGES } from '../languages.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { EVERY_SHORTCUT } from '../shortcuts.js';
import { menuFor } from './menu.js';
import { AccountFrame } from './account-frame.js';
import { PanelProvider, RightPanel, usePanel } from './right-panel.js';
import { Shell } from './shell.js';

/*
 * THE FRAME, DRAWN: the menu, the command bar, the shortcuts, the account
 * menu, the company switcher and the right-hand panel, each read from the one
 * list and the one table, in English and in a second language made up for the
 * test, whose words are not English.
 */
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
/* Every phrase in a language that is not English: the same key, the English words backwards. A page found by one of these is found by its own language's name. */
const XX = Object.fromEntries(Object.entries(EN).map(([k, v]) => [k, [...v].reverse().join('')]));
const TEST_LANGUAGES = languagesFrom({ './locales/en.json': EN, './locales/de.json': XX });

/* In an order no natural key gives: neither by date, id or how many sign, either way. */
const COMPANIES: Company[] = [
  { id: 'c-2', createdAt: '2026-09-01T10:00:00.000Z', signers: 3 },
  { id: 'c-3', createdAt: '2026-09-20T10:00:00.000Z', signers: 1 },
  { id: 'c-1', createdAt: '2026-08-01T10:00:00.000Z', signers: 5 },
];

/* How an unnamed company is listed: by the day its account was made, written the way the app writes a day. */
const STARTED = (iso: string): string => EN['company.startedOn']!.replace('{date}', new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(iso)));

const signer: Viewer = { signedIn: true, view: VIEWS.company, signs: true };
const employee: Viewer = { signedIn: true, view: VIEWS.employee, signs: false };

function sessionFor(viewer: Viewer, over: Partial<Session> = {}): Session {
  return {
    person: { id: 'u1', name: 'Priya' }, companies: viewer.signs ? COMPANIES : [], company: viewer.signs ? 'c-2' : null,
    chooseCompany: vi.fn(), viewer, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true,
    companiesChanged: vi.fn(async () => {}), ...over,
  };
}

async function draw(session: Session, current: PageId, language = 'en') {
  window.history.replaceState(null, '', PAGES[current].path);
  const view = render(
    <KitProvider languages={TEST_LANGUAGES} pick={language}>
      <SessionProvider session={session}>
        <Shell current={current}><PageView id={current} /></Shell>
      </SessionProvider>
    </KitProvider>,
  );
  await untilPageShown(view.container);
  return view;
}

/** A key pressed on the page, as the browser sends it. */
const press = (init: KeyboardEventInit) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  creations.mark.clear(); creations.reads.length = 0; creations.throwing.clear(); takeAsked(); walletAsks.asked = [];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the left menu', () => {
  /*
   * RED WHEN: the menu shows a page the list does not give this viewer, leaves
   * one out, links a page to an address that is not its own, or shows a page
   * not built yet without the Coming soon pill (or a built one with it).
   */
  it.each([['a signer', signer], ['an employee', employee]] as const)('shows %s exactly the list\'s pages, linked to their addresses', async (_who, viewer) => {
    const { container } = await draw(sessionFor(viewer), viewer.signs ? 'settingsAppearance' : 'payAppearance');
    const items = [...container.querySelectorAll('[data-menu-page]')];
    const expected = menuFor(viewer).flatMap((g) => g.pages);
    expect(items.map((i) => i.getAttribute('data-menu-page'))).toEqual(expected.map((p) => p.id));
    for (const [i, p] of expected.entries()) {
      expect(items[i]!.querySelector('a')?.getAttribute('href'), p.id).toBe(p.path);
      expect(items[i]!.querySelector('[data-slot=coming-soon]') !== null, p.id).toBe(!isBuilt(p));
    }
    expect(expected.every((p) => mayOpen(p, viewer))).toBe(true);
  });

  /* RED WHEN: the page shown, or the section a page sits in, is not marked as the one open. */
  it('marks the page open, and Settings while one of its sections is open', async () => {
    const { container } = await draw(sessionFor(signer), 'settingsLanguage');
    expect([...container.querySelectorAll('[data-menu-page] a[aria-current=page]')].map((a) => a.closest('[data-menu-page]')?.getAttribute('data-menu-page'))).toEqual(['settings']);
  });
});

describe('the command bar', () => {
  const open = async () => { await press({ key: 'k', code: 'KeyK', metaKey: true }); return document.querySelector('[data-command-bar]') as HTMLElement; };
  const search = (bar: HTMLElement, text: string) => act(() => { fireEvent.change(within(bar).getByRole('combobox'), { target: { value: text } }); });
  const linesOf = (bar: HTMLElement) => [...bar.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'));

  /* RED WHEN: the line saying how to open the bar is built from pieces, or loses the keys from where its phrase puts them. */
  it('says how to open it in one phrase, with the keys in the phrase\'s gap', async () => {
    await draw(sessionFor(signer), 'settingsAppearance');
    const bar = await open();
    const line = bar.querySelector('[data-command-bar-way-in]') as HTMLElement;
    const [before, after] = EN['commandBar.wayIn']!.split('{keys}');
    expect(line.firstChild?.textContent).toBe(before);
    expect(line.lastChild?.textContent).toBe(after);
    expect(line.querySelector('[data-shortcut=commandBar]')).not.toBeNull();
  });

  /*
   * RED WHEN: a page is found only by its English name, or only by its name in
   * the language shown, or not by the other words it is known by ("theme" for
   * Appearance); or the bar lists a page its viewer may not open.
   */
  it('finds a page by its name in the language shown and by its English name', async () => {
    await draw(sessionFor(signer), 'settingsAppearance', 'de');
    const bar = await open();
    expect(bar).not.toBeNull();
    /* The made-up language's word for Appearance is also in its words for the appearance commands, as it is in English. */
    await search(bar, XX['page.settingsAppearance.name']!);
    expect(linesOf(bar)).toEqual(['settingsAppearance', 'light', 'dark', 'system']);
    await search(bar, 'appearance');
    expect(linesOf(bar)).toEqual(['settingsAppearance', 'light', 'dark', 'system']);
    await search(bar, 'theme');
    expect(linesOf(bar)).toEqual(['settingsAppearance', 'light', 'dark', 'system']);
    await search(bar, 'nothing is called this');
    expect(linesOf(bar)).toEqual([]);
    await search(bar, '');
    const listed = linesOf(bar).filter((l) => l !== null && l in PAGES);
    /* A page that stands for a value, such as one run's page, is opened from its row, never by name. */
    expect(listed).toEqual(EVERY_PAGE.filter((p) => mayOpen(p, signer) && reachedByName(p)).map((p) => p.id));
    expect(listed).not.toContain('payslips');
  });

  /* RED WHEN: choosing a page does not go to its address, or the bar stays open over the page it went to. */
  it('goes to the page chosen', async () => {
    await draw(sessionFor(signer), 'settingsAppearance');
    const bar = await open();
    await search(bar, 'language');
    expect(linesOf(bar)).toEqual(['settingsLanguage']);
    await act(() => { fireEvent.keyDown(within(bar).getByRole('combobox'), { key: 'Enter' }); });
    expect(window.location.pathname).toBe(PAGES.settingsLanguage.path);
    expect(document.querySelector('[data-command-bar]')).toBeNull();
  });

  /* RED WHEN: the bar can be opened only by its shortcut: the button at the top of every page is gone, or does not open it. */
  it('opens from the button at the top of the page, for a browser that keeps the shortcut', async () => {
    const { container } = await draw(sessionFor(signer), 'settingsAppearance');
    await act(() => { fireEvent.click(container.querySelector('[data-action=open-command-bar]')!); });
    expect(document.querySelector('[data-command-bar]')).not.toBeNull();
    expect(document.querySelector('[data-command-bar-way-in] [data-shortcut=commandBar]')).not.toBeNull();
  });
});

describe('the shortcuts', () => {
  /*
   * RED WHEN: a shortcut is keyed to the language shown, so the same keys do
   * something else in another language; or a key on a keyboard whose letters
   * are not Latin, in the place of K, does not open the command bar.
   */
  it.each(['en', 'de'])('are the same keys in %s, and on a keyboard with other letters', async (language) => {
    await draw(sessionFor(signer), 'settingsAppearance', language);
    await press({ key: 'л', code: 'KeyK', metaKey: true });
    expect(document.querySelector('[data-command-bar]')).not.toBeNull();
  });

  /* RED WHEN: on a Mac, Ctrl is taken for the command key, or off a Mac the command key is taken for Ctrl. */
  it('hold the command key on a Mac and Ctrl elsewhere', async () => {
    await draw(sessionFor(signer, { mac: true }), 'settingsAppearance');
    await press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(document.querySelector('[data-command-bar]')).toBeNull();
    cleanup();
    await draw(sessionFor(signer, { mac: false }), 'settingsAppearance');
    await press({ key: 'k', code: 'KeyK', metaKey: true });
    expect(document.querySelector('[data-command-bar]')).toBeNull();
    await press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(document.querySelector('[data-command-bar]')).not.toBeNull();
  });

  /* RED WHEN: the list of shortcuts leaves one of the table's out, or shows one whose page is not built without Coming soon. */
  it('lists every shortcut in the table, with Coming soon for one not built', async () => {
    await draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '?', code: 'Slash', shiftKey: true });
    const help = document.querySelector('[data-shortcuts-help]') as HTMLElement;
    expect([...help.querySelectorAll('[data-shortcut-line]')].map((l) => l.getAttribute('data-shortcut-line'))).toEqual(EVERY_SHORTCUT.map((s) => s.id));
    for (const s of EVERY_SHORTCUT) {
      expect(help.querySelector(`[data-shortcut-line=${s.id}] [data-slot=coming-soon]`) !== null, s.id).toBe(s.soon !== undefined);
    }
  });

  /* RED WHEN: a shortcut whose page is not built does something, or a letter typed into a field runs a shortcut. */
  it('runs nothing for a shortcut not built, nor for a letter typed into a field', async () => {
    await draw(sessionFor(signer), 'settingsAppearance');
    const before = document.body.innerHTML;
    await press({ key: 'c', code: 'KeyC' });
    await press({ key: '/', code: 'Slash' });
    expect(document.body.innerHTML).toBe(before);
    const bar = document.querySelector('[data-action=open-command-bar]') as HTMLElement;
    await act(() => { fireEvent.click(bar); });
    const box = within(document.querySelector('[data-command-bar]') as HTMLElement).getByRole('combobox');
    await act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-shortcuts-help]')).toBeNull();
  });

  /* RED WHEN: Cmd+Shift+L does not switch between light and dark, or switches to the one already shown. */
  it('switch between light and dark', async () => {
    const choose = vi.fn();
    await draw(sessionFor(signer, { choose, preferences: { ...DEFAULT_PREFERENCES, mode: 'light' } }), 'settingsAppearance');
    await press({ key: 'l', code: 'KeyL', metaKey: true, shiftKey: true });
    expect(choose).toHaveBeenCalledWith({ mode: 'dark' });
  });

  /* RED WHEN: Cmd+. does not open the company switcher. */
  it('open the company switcher', async () => {
    await draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    expect(document.querySelector('[data-company-switcher]')).not.toBeNull();
  });
});

describe('the company switcher', () => {
  /*
   * RED WHEN: the companies are put in any order but the service's, such as
   * by what they hold, or a company is shown with an amount; a company's name,
   * creating one or joining one is shown as if it worked when it is Coming
   * soon; a company is shown by the day it was created, or by anything but its
   * name or the word for a company and its approvals as M/N Approval; or the
   * line on what anyone can look up is still in the menu; or a company's approvals are shown that the person's own
   * wallet has not read off the chain (the second test below), or are the list's own number.
   */
  it('lists the companies in the order the service gave, with no amounts, and says where their names open', async () => {
    names.opened = new Map();
    names.approvals = new Map([['c-2', 2], ['c-3', 1], ['c-1', 3]]);
    await draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    const menu = document.querySelector('[data-company-switcher]') as HTMLElement;
    expect([...menu.querySelectorAll('[data-company]')].map((c) => c.getAttribute('data-company'))).toEqual(['c-2', 'c-3', 'c-1']);
    expect(menu.querySelector('[data-slot=amount]')).toBeNull();
    /* Names are built: none says Coming soon, and while none is open the list says where they open. */
    expect(menu.querySelector('[data-company-names] [data-slot=coming-soon]')).toBeNull();
    expect(menu.querySelector('[data-company-names=locked]')?.textContent).toBe(EN['switcher.namesLocked']);
    expect(menu.querySelector('[data-action=join-with-a-code]')).toBeNull();
    expect(menu.textContent).not.toContain('Join with a code');
    /* Create a company is built: it starts the setup wizard, and is not Coming soon. */
    expect(menu.querySelector('[data-action=create-company]')).not.toBeNull();
    expect(menu.querySelector('[data-action=create-company] [data-slot=coming-soon]')).toBeNull();
    expect(menu.querySelector('[data-public-facts]')).toBeNull();
    expect([...menu.querySelectorAll('[data-company]')].map((c) => c.textContent)).toEqual([
      `${STARTED(COMPANIES[0]!.createdAt)}2/3 Approval`, `${STARTED(COMPANIES[1]!.createdAt)}1/1 Approval`, `${STARTED(COMPANIES[2]!.createdAt)}3/5 Approval`]);
    expect(document.querySelector('[data-action=company-switcher]')!.textContent).toBe(`${STARTED(COMPANIES[0]!.createdAt)}2/3 Approval`);
  });

  it('shows no approvals for a company until the chain has said, and never the list\'s own number', async () => {
    names.opened = new Map();
    names.approvals = new Map([['c-3', 1]]);
    await draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    const menu = document.querySelector('[data-company-switcher]') as HTMLElement;
    expect([...menu.querySelectorAll('[data-company]')].map((c) => c.textContent)).toEqual([
      STARTED(COMPANIES[0]!.createdAt), `${STARTED(COMPANIES[1]!.createdAt)}1/1 Approval`, STARTED(COMPANIES[2]!.createdAt)]);
  });

  /*
   * RED WHEN: a company the device holds no name for is listed or shown at the top of the switcher as anything but "A company you
   * started on <day>" (or "A company you started" when no day is known), or any company in the list or at the top is shown empty,
   * whether its name is missing, blank, or only spaces.
   */
  it('never lists a company with an empty name: a missing, blank or spaces-only name reads as the day it was started', async () => {
    names.opened = new Map([['c-2', ''], ['c-3', '   '], ['c-1', 'Acme']]);
    names.approvals = new Map();
    const noDay = { id: 'c-4', createdAt: 'not a day', signers: 1 } as Company;
    await draw(sessionFor(signer, { companies: [...COMPANIES, noDay] }), 'settingsAppearance');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.querySelector('[data-action=company-switcher]')!.textContent).toBe(STARTED(COMPANIES[0]!.createdAt));
    await press({ key: '.', code: 'Period', metaKey: true });
    const menu = document.querySelector('[data-company-switcher]') as HTMLElement;
    const listed = [...menu.querySelectorAll('[data-company]')].map((c) => c.textContent);
    expect(listed).toEqual([STARTED(COMPANIES[0]!.createdAt), STARTED(COMPANIES[1]!.createdAt), 'Acme', EN['company.started']]);
    expect(listed.every((l) => l !== null && l.trim() !== '')).toBe(true);
  });

  /*
   * RED WHEN: a company's name, once the person's keys have opened it, is not
   * shown in the switcher and at its top, is shown beside another company, or
   * the line saying where names open stays when every name is open.
   */
  it('shows each company by its name once the keys saved for the person have opened it', async () => {
    names.opened = new Map([['c-2', 'Northwind'], ['c-1', 'Acme']]);
    const { container } = await draw(sessionFor(signer), 'settingsAppearance');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector('[data-shown-name]')?.textContent).toBe('Northwind');
    await press({ key: '.', code: 'Period', metaKey: true });
    const menu = document.querySelector('[data-company-switcher]') as HTMLElement;
    expect([...menu.querySelectorAll('[data-company]')].map((c) => c.querySelector('[data-company-name]')?.textContent ?? null)).toEqual(['Northwind', null, 'Acme']);
    expect(menu.querySelector('[data-company-names=locked]')).not.toBeNull();
    names.opened = new Map([['c-2', 'Northwind'], ['c-3', 'Globex'], ['c-1', 'Acme']]);
    cleanup();
    await draw(sessionFor(signer), 'settingsAppearance');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await press({ key: '.', code: 'Period', metaKey: true });
    expect(document.querySelector('[data-company-switcher] [data-company-names]')).toBeNull();
  });

  /*
   * RED WHEN: a company the creation adapter marks not finished is listed in the switcher without the kit's badge saying so, or
   * another company carries it; or a company whose read is unknown or failed shows any mark; or a company is read more than once.
   */
  it('marks the company that is not finished, once, and no company whose read is unknown or failed', async () => {
    names.opened = new Map([['c-3', 'Test-001']]);
    names.approvals = new Map([['c-2', 2], ['c-3', 1], ['c-1', 3]]);
    creations.mark.set('c-3', 'not-finished');
    creations.throwing.add('c-1');
    await draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    await untilShown(() => document.querySelector('[data-company-switcher] [data-company=c-3] [data-not-finished]'), 'the mark on the company not finished');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const menu = document.querySelector('[data-company-switcher]') as HTMLElement;
    const marks = [...menu.querySelectorAll('[data-company]')].map((c) => c.querySelector('[data-not-finished]')?.textContent ?? null);
    expect(marks).toEqual([null, EN['company.notFinished'], null]);
    expect(menu.querySelector('[data-company=c-3] [data-not-finished]')!.getAttribute('data-slot')).toBe('badge');
    /* RED WHEN: a company not finished is listed in the switcher with no name, or without its name beside the mark. */
    expect(menu.querySelector('[data-company=c-3]')!.textContent).toBe(`Test-0011/1 Approval${EN['company.notFinished']}`);
    expect(creations.reads.filter((id) => id === 'c-3')).toHaveLength(1);
  });

  /*
   * RED WHEN: opening a company that carries the mark does not choose it and then open the wizard at "Finish creating the
   * company" (step 2, for the company already there); or opening one that does not takes the person to the wizard.
   */
  it('opens a company that is not finished at step 2 of the wizard, and any other as before', async () => {
    creations.mark.set('c-3', 'not-finished');
    const chooseCompany = vi.fn();
    await draw(sessionFor(signer, { chooseCompany }), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    await act(async () => { fireEvent.click(document.querySelector('[data-company=c-1]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(chooseCompany).toHaveBeenLastCalledWith('c-1');
    expect(takeAsked()).toBeNull();
    expect(window.location.pathname).not.toBe(PAGES.setup.path);
    await press({ key: '.', code: 'Period', metaKey: true });
    await act(async () => { fireEvent.click(document.querySelector('[data-company=c-3]')!); await new Promise((r) => setTimeout(r, 20)); });
    expect(chooseCompany).toHaveBeenLastCalledWith('c-3');
    expect(takeAsked()).toEqual({ step: 'finishCompany', newCompany: false });
    expect(window.location.pathname).toBe(PAGES.setup.path);
  });

  /* RED WHEN: choosing a company does not make it the one shown. */
  it('makes the company chosen the one shown', async () => {
    const chooseCompany = vi.fn();
    await draw(sessionFor(signer, { chooseCompany }), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    await act(() => { fireEvent.click(document.querySelector('[data-company=c-1]')!); });
    expect(chooseCompany).toHaveBeenCalledWith('c-1');
  });
});

describe('the account menu', () => {
  const openMenu = async (container: HTMLElement) => {
    const trigger = container.querySelector('[data-action=account-menu]') as HTMLElement;
    await act(() => { fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' }); });
    return document.querySelector('[data-account-menu]') as HTMLElement;
  };

  /*
   * RED WHEN: the account's addresses are shown as if they were read, when no
   * request for them exists; Balances is still said to be coming; or the menu
   * loses light and dark, the language, switching view or signing out.
   */
  it('shows the account\'s addresses Coming soon, offers Balances, and has light and dark, language, switching view and signing out', async () => {
    const { container } = await draw(sessionFor(signer), 'settingsAppearance');
    const menu = await openMenu(container);
    expect(menu).not.toBeNull();
    const details = menu.querySelector('[data-account-details]') as HTMLElement;
    expect(details.querySelectorAll('[data-slot=coming-soon]').length).toBe(2);
    expect(details.textContent).toContain(EN['account.privateAddress']);
    expect(details.textContent).toContain(EN['account.publicAddress']);
    expect(details.querySelector('[data-action=account-balances]')?.textContent).toBe(EN['account.balances']);
    expect(details.querySelector('[data-slot=amount]')).toBeNull();
    expect(EN['account.detailsSoon']).not.toMatch(/balance/i);
    expect([...menu.querySelectorAll('[data-mode]')].map((m) => m.getAttribute('data-mode'))).toEqual(['light', 'dark', 'system']);
    for (const a of ['language', 'switch-view', 'sign-out']) expect(menu.querySelector(`[data-action=${a}]`), a).not.toBeNull();
  });

  /*
   * RED WHEN: pressing Balances opens nothing, opens the account's tokens without the person's press asking the wallet for them,
   * or asks the wallet before the person presses the button in the panel.
   */
  it('opens the account\'s tokens in the right-hand panel on Balances, and asks the wallet only on the panel\'s own button', async () => {
    const { container } = await draw(sessionFor(signer), 'settingsAppearance');
    const menu = await openMenu(container);
    expect(document.querySelector('[data-panel]')).toBeNull();
    await act(() => { fireEvent.click(menu.querySelector('[data-action=account-balances]')!); });
    await waitFor(() => expect(document.querySelector('[data-panel] [data-account-tokens=not-asked]')).not.toBeNull());
    const panel = document.querySelector('[data-panel]') as HTMLElement;
    expect(panel.textContent).toContain(EN['account.balances']);
    expect(panel.textContent).toContain(EN['accountTokens.opens']);
    expect(walletAsks.asked).toHaveLength(0);
    await act(async () => { fireEvent.click(panel.querySelector('[data-action=show-account-tokens]')!); await Promise.resolve(); });
    expect(walletAsks.asked).toHaveLength(1);
  });

  /* RED WHEN: on a phone, the menu sheet stays open under the Balances panel, or stays open after the panel closes; or Balances has no icon like its neighbours. */
  it('closes the phone\'s menu sheet when Balances opens the panel, and shows Balances with an icon', async () => {
    const was = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      const { container } = await draw(sessionFor(signer), 'settingsAppearance');
      await act(() => { fireEvent.click(document.querySelector('[data-sidebar=trigger]')!); });
      expect(document.querySelector('[data-mobile=true]')).not.toBeNull();
      const menu = await openMenu(document.body);
      const item = menu.querySelector('[data-action=account-balances]')!;
      expect(item.querySelector('svg')).not.toBeNull();
      await act(() => { fireEvent.click(item); });
      await waitFor(() => expect(document.querySelector('[data-panel] [data-account-tokens]')).not.toBeNull());
      expect(document.querySelector('[data-mobile=true]')).toBeNull();
      expect(container).not.toBeNull();
    } finally { window.matchMedia = was; }
  });

  /* RED WHEN: switching view is offered to a person who signs for no company, where there is no company view to switch to. */
  it('offers switching view only to a person who signs for a company', async () => {
    const { container } = await draw(sessionFor(employee), 'payAppearance');
    const menu = await openMenu(container);
    expect(menu.querySelector('[data-action=switch-view]')).toBeNull();
  });

  /* RED WHEN: choosing dark, or signing out, does not reach the one function that makes the change. */
  it('makes each change through the session', async () => {
    const choose = vi.fn(); const signOut = vi.fn();
    const { container } = await draw(sessionFor(signer, { choose, signOut }), 'settingsAppearance');
    let menu = await openMenu(container);
    await act(() => { fireEvent.click(menu.querySelector('[data-mode=dark]')!); });
    expect(choose).toHaveBeenCalledWith({ mode: 'dark' });
    menu = await openMenu(container);
    await act(() => { fireEvent.click(menu.querySelector('[data-action=sign-out]')!); });
    expect(signOut).toHaveBeenCalled();
  });
});

describe('the right-hand panel', () => {
  function Opener() {
    const { open } = usePanel();
    return <button type="button" data-open-panel onClick={() => open({ title: 'x', body: <p data-panel-body /> })} />;
  }

  /* RED WHEN: the frame has no place for the panel, the panel does not open over the page with what a page gives it, or Esc does not close it. */
  it('opens with what a page gives it, over the page, and closes on Esc', async () => {
    window.history.replaceState(null, '', PAGES.settingsAppearance.path);
    render(
      <KitProvider languages={TEST_LANGUAGES} pick="en">
        <SessionProvider session={sessionFor(signer)}><Shell current="settingsAppearance"><Opener /></Shell></SessionProvider>
      </KitProvider>,
    );
    expect(document.querySelector('[data-panel]')).toBeNull();
    await act(() => { fireEvent.click(document.querySelector('[data-open-panel]')!); });
    expect(document.querySelector('[data-panel] [data-panel-body]')).not.toBeNull();
    expect(document.querySelector('[data-page-body] [data-open-panel]')).not.toBeNull();
    await act(() => { fireEvent.keyDown(document.querySelector('[data-panel]')!, { key: 'Escape' }); });
    expect(document.querySelector('[data-panel]')).toBeNull();
  });
});

describe('the account\'s window over the right-hand panel', () => {
  function Opener() {
    const { open } = usePanel();
    return <button type="button" data-open-panel onClick={() => open({ title: 'x', body: <p data-panel-body /> })} />;
  }
  const layerOf = (el: Element | null): number => Number(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/u.exec(el?.getAttribute('class') ?? '')?.slice(1).find((n) => n !== undefined) ?? NaN);
  async function drawOpen() {
    render(
      <KitProvider languages={TEST_LANGUAGES} pick="en">
        <PanelProvider><Opener /><RightPanel /><AccountFrame /></PanelProvider>
      </KitProvider>,
    );
    await act(() => { fireEvent.click(document.querySelector('[data-open-panel]')!); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }

  /* RED WHEN: the account's window, which a panel's button opens, is drawn at or below the panel or its dimmed backdrop, or does not take presses while the panel switches presses outside itself off. */
  it('stacks above the panel and its backdrop, and takes the press', async () => {
    await drawOpen();
    const frame = document.querySelector('[data-account-frame]')!;
    const panel = document.querySelector('[data-panel]')!;
    const backdrop = document.querySelector('[data-slot=sheet-overlay]')!;
    expect(layerOf(panel)).toBeGreaterThan(0);
    expect(layerOf(frame)).toBeGreaterThan(layerOf(panel));
    expect(layerOf(frame)).toBeGreaterThan(layerOf(backdrop));
    expect(frame.className).toContain('pointer-events-auto');
  });

  /* RED WHEN: a press in the account's window closes the panel it was opened from, so the deposit it was opened for is lost; or a press elsewhere outside the panel no longer closes it. */
  it('leaves the panel open for a press in the account\'s window, and still closes it for a press elsewhere', async () => {
    await drawOpen();
    const frame = document.querySelector('[data-account-frame]')!;
    await act(async () => { fireEvent.pointerDown(frame); fireEvent.mouseDown(frame); fireEvent.click(frame); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel] [data-panel-body]')).not.toBeNull();
    await act(async () => { fireEvent.pointerDown(document.body); fireEvent.click(document.body); await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-panel]')).toBeNull();
  });
});

describe('the account\'s window over the right-hand panel, by keyboard and to assistive tools', () => {
  function Opener() {
    const { open } = usePanel();
    return <button type="button" data-open-panel onClick={() => open({ title: 'x', body: <button type="button" data-panel-button>Inside</button> })} />;
  }
  const ancestorsHidden = (el: Element): boolean => { for (let e: Element | null = el; e !== null; e = e.parentElement) if (e.getAttribute('aria-hidden') === 'true') return true; return false; };
  const settleFocus = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  async function drawPanel() {
    wallet.shown = false;
    const view = render(
      <KitProvider languages={TEST_LANGUAGES} pick="en">
        <PanelProvider><Opener /><RightPanel /><AccountFrame /></PanelProvider>
      </KitProvider>,
    );
    const frame = () => document.querySelector<HTMLElement>('[data-account-frame]')!;
    const openPanel = async () => { await act(() => { fireEvent.click(document.querySelector('[data-open-panel]')!); }); await settleFocus(); };
    const show = async (shown: boolean) => { await act(async () => { wallet.set(shown); }); await settleFocus(); };
    return { view, frame, openPanel, show };
  }
  afterEach(() => { wallet.set(false); wallet.watchers.clear(); });

  /* RED WHEN: the account's window is drawn inside the application's root (so the panel's hiding of the rest of the page hides it from assistive tools too), or is still hidden from them once shown, whether the panel was opened before it or after. */
  it('is drawn outside the root and is not hidden from assistive tools while shown, whichever opened first', async () => {
    const { view, frame, openPanel, show } = await drawPanel();
    expect(view.container.contains(frame())).toBe(false);
    expect(frame().parentElement).toBe(document.body);
    await openPanel();
    expect(view.container.getAttribute('aria-hidden')).toBe('true');
    await show(true);
    expect(ancestorsHidden(frame())).toBe(false);
    expect(frame().querySelector('[role=dialog]')!.getAttribute('aria-modal')).toBe('true');
    expect(frame().querySelector('[role=dialog]')!.getAttribute('aria-labelledby')).toBe(frame().querySelector('strong')!.id);
    await show(false);
    await act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
    await settleFocus();
    expect(document.querySelector('[data-panel]')).toBeNull();
    await show(true);
    await openPanel();
    expect(ancestorsHidden(frame())).toBe(false);
  });

  /* RED WHEN: focus does not go into the account's window when it opens over a panel, or the panel's focus trap sends it straight back, or it does not go back to where it was when the window is put away. */
  it('takes focus into the account when it opens over the panel, keeps it there, and gives it back when put away', async () => {
    const { frame, openPanel, show } = await drawPanel();
    await openPanel();
    const inside = document.querySelector<HTMLElement>('[data-panel-button]')!;
    await act(() => { inside.focus(); });
    expect(document.activeElement).toBe(inside);
    await show(true);
    expect(document.activeElement).toBe(frame().querySelector('iframe'));
    await act(() => { frame().querySelector<HTMLElement>('[data-action=stop-waiting]')!.focus(); });
    await settleFocus();
    expect(document.activeElement).toBe(frame().querySelector('[data-action=stop-waiting]'));
    await show(false);
    expect(document.activeElement).toBe(inside);
    expect(document.querySelector('[data-panel]')).not.toBeNull();
  });

  /* RED WHEN: Tab can leave the account's window for the page behind it: past the account's last control, or back past the stop button, instead of going round inside the window. */
  it('sends focus round inside the window at both ends, never on to the page behind it', async () => {
    const { frame, openPanel, show } = await drawPanel();
    await openPanel();
    await show(true);
    const guard = (end: string) => frame().querySelector<HTMLElement>(`[data-focus-guard=${end}]`)!;
    await act(() => { guard('end').focus(); });
    expect(document.activeElement).toBe(frame().querySelector('[data-action=stop-waiting]'));
    await act(() => { guard('start').focus(); });
    expect(document.activeElement).toBe(frame().querySelector('iframe'));
    expect(guard('start').compareDocumentPosition(frame().querySelector('[data-action=stop-waiting]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(guard('end').compareDocumentPosition(frame().querySelector('iframe')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  /* RED WHEN: Esc pressed in the account's window closes the panel it was opened over, or the panel stops closing for Esc pressed in itself, or its focus trap stops sending focus that goes elsewhere (outside both) back into it. */
  it('keeps the panel open for Esc in the account\'s window, and the panel still closes for Esc in itself and holds focus in', async () => {
    const { frame, openPanel, show } = await drawPanel();
    await openPanel();
    await show(true);
    await act(() => { fireEvent.keyDown(frame().querySelector('[data-action=stop-waiting]')!, { key: 'Escape' }); });
    await settleFocus();
    expect(document.querySelector('[data-panel]')).not.toBeNull();
    await show(false);
    const outside = document.querySelector<HTMLElement>('[data-open-panel]')!;
    await act(() => { outside.focus(); });
    await settleFocus();
    expect(document.querySelector('[data-panel]')!.contains(document.activeElement)).toBe(true);
    await act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
    await settleFocus();
    expect(document.querySelector('[data-panel]')).toBeNull();
  });
});

describe('the pages', () => {
  /* RED WHEN: a page not built yet shows anything but its name, the Coming soon pill and what it will be. */
  it('shows a page not built yet as Coming soon, with what it will be', async () => {
    const { container } = await draw(sessionFor(signer), 'transactions');
    const page = container.querySelector('[data-screen=coming-soon]') as HTMLElement;
    expect(page.getAttribute('data-page')).toBe('transactions');
    expect(page.querySelector('h1')?.textContent).toBe(EN['page.transactions.name']);
    expect(page.querySelector('[data-slot=coming-soon]')).not.toBeNull();
    expect(page.textContent).toContain(EN['page.transactions.soon']);
    expect(page.querySelectorAll('button:not([data-slot=coming-soon]), input, a').length).toBe(0);
  });

  /* RED WHEN: the Apps entry of the menu carries a Coming soon pill, or Apps is not its own built page. */
  it('shows Apps in the menu with no Coming soon pill', async () => {
    const { container } = await draw(sessionFor(signer), 'apps');
    expect(container.querySelector('[data-menu-page=apps]')).not.toBeNull();
    expect(container.querySelector('[data-menu-page=apps] [data-slot=coming-soon]')).toBeNull();
    expect(container.querySelector('[data-screen=apps]')).not.toBeNull();
  });

  /* RED WHEN: a section of Settings is shown outside Settings, or Settings lists sections the list does not put in it. */
  it('shows Appearance inside Settings, below the sections the list puts there', async () => {
    const { container } = await draw(sessionFor(signer), 'settingsAppearance');
    const settings = container.querySelector('[data-screen=settings]') as HTMLElement;
    expect(settings.querySelector('[data-screen=appearance]')).not.toBeNull();
    expect([...settings.querySelectorAll('[data-settings-section]')].map((s) => s.getAttribute('data-settings-section')))
      .toEqual(EVERY_PAGE.filter((p) => p.inside === 'settings').map((p) => p.id));
  });

  /* RED WHEN: the colours offered are not the kit's list, the language list is not the application's language files, or a choice does not reach the session. */
  it('offers the kit\'s colours and the language files, and makes each choice through the session', async () => {
    const choose = vi.fn();
    const { container } = await draw(sessionFor(signer, { choose }), 'settingsAppearance');
    const { BASE_COLORS } = await import('vaults-ui');
    expect([...container.querySelectorAll('[data-colour]')].map((c) => c.getAttribute('data-colour'))).toEqual([...BASE_COLORS]);
    await act(() => { fireEvent.click(container.querySelector('[data-colour=olive] button')!); });
    expect(choose).toHaveBeenCalledWith({ base: 'olive' });
    cleanup();
    const again = await draw(sessionFor(signer, { choose }), 'settingsLanguage');
    expect([...again.container.querySelectorAll('[data-language]')].map((c) => c.getAttribute('data-language'))).toEqual(['', ...LANGUAGES.map((l) => l.tag)]);
    /* Date and number format is not built, so it is not shown at all. */
    expect(again.container.querySelector('[data-screen=language] [data-slot=coming-soon]')).toBeNull();
    expect(again.container.querySelector('[data-screen=language]')!.textContent).not.toMatch(/format/i);
  });

  /*
   * RED WHEN: a tab of Settings carries a Coming soon pill; the Company tab
   * does not show the day the company shown was created, or stops saying the
   * rest is Coming soon; or the line on what anyone can look up is not on the
   * Signers tab, or that tab stops saying the rest is Coming soon.
   */
  it('shows no pill on Settings\' tabs, the day created on Company and the public line on Signers', async () => {
    const company = await draw(sessionFor(signer, { company: 'c-3' }), 'settingsCompany');
    expect(company.container.querySelector('[data-settings-sections] [data-slot=coming-soon]')).toBeNull();
    expect(company.container.querySelector('[data-company-created]')!.textContent).toBe('Created Sep 20, 2026');
    expect(company.container.querySelector('[data-screen=coming-soon] [data-slot=page-header] [data-slot=coming-soon]')).not.toBeNull();
    expect(company.container.textContent).toContain(EN['page.settingsCompany.soon']);
    cleanup();
    const signers = await draw(sessionFor(signer), 'settingsSigners');
    expect(signers.container.querySelector('[data-public-facts]')!.textContent).toBe(EN['settingsSigners.publicFacts']);
    expect(EN['settingsSigners.publicFacts']).toMatch(/^Anyone can look up how many sign/);
    expect(signers.container.querySelector('[data-company-created]')).toBeNull();
    expect(signers.container.querySelector('[data-screen=coming-soon] [data-slot=page-header] [data-slot=coming-soon]')).not.toBeNull();
  });

  /* RED WHEN: a signer looking at their own pay is not told so, or has no way back. */
  it('tells a signer looking at their own pay, with the way back', async () => {
    const chooseView = vi.fn();
    const { container } = await draw(sessionFor({ ...signer, view: VIEWS.employee }, { chooseView }), 'payAppearance');
    const banner = container.querySelector('[data-view-banner]') as HTMLElement;
    await act(() => { fireEvent.click(within(banner).getByRole('button')); });
    expect(chooseView).toHaveBeenCalledWith(VIEWS.company);
    cleanup();
    expect((await draw(sessionFor(employee), 'payAppearance')).container.querySelector('[data-view-banner]')).toBeNull();
  });
});
