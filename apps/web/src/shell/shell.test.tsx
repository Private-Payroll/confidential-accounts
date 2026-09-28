// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { PageView } from '../app.js';
import type { Company } from '../adapters/session.js';
import { EVERY_PAGE, isBuilt, mayOpen, PAGES, VIEWS, type PageId, type Viewer } from '../pages.js';
import { LANGUAGES } from '../languages.js';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { EVERY_SHORTCUT } from '../shortcuts.js';
import { menuFor } from './menu.js';
import { usePanel } from './right-panel.js';
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
  { id: 'c-2', createdAt: '2026-09-01T10:00:00.000Z', signers: 3, approvalsNeeded: 2 },
  { id: 'c-3', createdAt: '2026-09-20T10:00:00.000Z', signers: 1, approvalsNeeded: 1 },
  { id: 'c-1', createdAt: '2026-08-01T10:00:00.000Z', signers: 5, approvalsNeeded: 3 },
];

const signer: Viewer = { signedIn: true, view: VIEWS.company, signs: true };
const employee: Viewer = { signedIn: true, view: VIEWS.employee, signs: false };

function sessionFor(viewer: Viewer, over: Partial<Session> = {}): Session {
  return {
    person: { id: 'u1', name: 'Priya' }, companies: viewer.signs ? COMPANIES : [], company: viewer.signs ? 'c-2' : null,
    chooseCompany: vi.fn(), viewer, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES, choose: vi.fn(), signOut: vi.fn(), mac: true, ...over,
  };
}

function draw(session: Session, current: PageId, language = 'en') {
  window.history.replaceState(null, '', PAGES[current].path);
  return render(
    <KitProvider languages={TEST_LANGUAGES} pick={language}>
      <SessionProvider session={session}>
        <Shell current={current}><PageView id={current} /></Shell>
      </SessionProvider>
    </KitProvider>,
  );
}

/** A key pressed on the page, as the browser sends it. */
const press = (init: KeyboardEventInit) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the left menu', () => {
  /*
   * RED WHEN: the menu shows a page the list does not give this viewer, leaves
   * one out, links a page to an address that is not its own, or shows a page
   * not built yet without the Coming soon pill (or a built one with it).
   */
  it.each([['a signer', signer], ['an employee', employee]] as const)('shows %s exactly the list\'s pages, linked to their addresses', (_who, viewer) => {
    const { container } = draw(sessionFor(viewer), viewer.signs ? 'settingsAppearance' : 'payAppearance');
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
  it('marks the page open, and Settings while one of its sections is open', () => {
    const { container } = draw(sessionFor(signer), 'settingsLanguage');
    expect([...container.querySelectorAll('[data-menu-page] a[aria-current=page]')].map((a) => a.closest('[data-menu-page]')?.getAttribute('data-menu-page'))).toEqual(['settings']);
  });
});

describe('the command bar', () => {
  const open = async () => { await press({ key: 'k', code: 'KeyK', metaKey: true }); return document.querySelector('[data-command-bar]') as HTMLElement; };
  const search = (bar: HTMLElement, text: string) => act(() => { fireEvent.change(within(bar).getByRole('combobox'), { target: { value: text } }); });
  const linesOf = (bar: HTMLElement) => [...bar.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'));

  /* RED WHEN: the line saying how to open the bar is built from pieces, or loses the keys from where its phrase puts them. */
  it('says how to open it in one phrase, with the keys in the phrase\'s gap', async () => {
    draw(sessionFor(signer), 'settingsAppearance');
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
    draw(sessionFor(signer), 'settingsAppearance', 'de');
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
    expect(listed).toEqual(EVERY_PAGE.filter((p) => mayOpen(p, signer)).map((p) => p.id));
    expect(listed).not.toContain('payslips');
  });

  /* RED WHEN: choosing a page does not go to its address, or the bar stays open over the page it went to. */
  it('goes to the page chosen', async () => {
    draw(sessionFor(signer), 'settingsAppearance');
    const bar = await open();
    await search(bar, 'language');
    expect(linesOf(bar)).toEqual(['settingsLanguage']);
    await act(() => { fireEvent.keyDown(within(bar).getByRole('combobox'), { key: 'Enter' }); });
    expect(window.location.pathname).toBe(PAGES.settingsLanguage.path);
    expect(document.querySelector('[data-command-bar]')).toBeNull();
  });

  /* RED WHEN: the bar can be opened only by its shortcut: the button at the top of every page is gone, or does not open it. */
  it('opens from the button at the top of the page, for a browser that keeps the shortcut', async () => {
    const { container } = draw(sessionFor(signer), 'settingsAppearance');
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
    draw(sessionFor(signer), 'settingsAppearance', language);
    await press({ key: 'л', code: 'KeyK', metaKey: true });
    expect(document.querySelector('[data-command-bar]')).not.toBeNull();
  });

  /* RED WHEN: on a Mac, Ctrl is taken for the command key, or off a Mac the command key is taken for Ctrl. */
  it('hold the command key on a Mac and Ctrl elsewhere', async () => {
    draw(sessionFor(signer, { mac: true }), 'settingsAppearance');
    await press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(document.querySelector('[data-command-bar]')).toBeNull();
    cleanup();
    draw(sessionFor(signer, { mac: false }), 'settingsAppearance');
    await press({ key: 'k', code: 'KeyK', metaKey: true });
    expect(document.querySelector('[data-command-bar]')).toBeNull();
    await press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(document.querySelector('[data-command-bar]')).not.toBeNull();
  });

  /* RED WHEN: the list of shortcuts leaves one of the table's out, or shows one whose page is not built without Coming soon. */
  it('lists every shortcut in the table, with Coming soon for one not built', async () => {
    draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '?', code: 'Slash', shiftKey: true });
    const help = document.querySelector('[data-shortcuts-help]') as HTMLElement;
    expect([...help.querySelectorAll('[data-shortcut-line]')].map((l) => l.getAttribute('data-shortcut-line'))).toEqual(EVERY_SHORTCUT.map((s) => s.id));
    for (const s of EVERY_SHORTCUT) {
      expect(help.querySelector(`[data-shortcut-line=${s.id}] [data-slot=coming-soon]`) !== null, s.id).toBe(s.soon !== undefined);
    }
  });

  /* RED WHEN: a shortcut whose page is not built does something, or a letter typed into a field runs a shortcut. */
  it('runs nothing for a shortcut not built, nor for a letter typed into a field', async () => {
    draw(sessionFor(signer), 'settingsAppearance');
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
    draw(sessionFor(signer, { choose, preferences: { ...DEFAULT_PREFERENCES, mode: 'light' } }), 'settingsAppearance');
    await press({ key: 'l', code: 'KeyL', metaKey: true, shiftKey: true });
    expect(choose).toHaveBeenCalledWith({ mode: 'dark' });
  });

  /* RED WHEN: Cmd+. does not open the company switcher. */
  it('open the company switcher', async () => {
    draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    expect(document.querySelector('[data-company-switcher]')).not.toBeNull();
  });
});

describe('the company switcher', () => {
  /*
   * RED WHEN: the companies are put in any order but the service's, such as
   * by what they hold, or a company is shown with an amount; a company's name,
   * creating one or joining one is shown as if it worked when it is Coming
   * soon; or the list does not say which of what it shows anyone can look up.
   */
  it('lists the companies in the order the service gave, with no amounts, and their names Coming soon', async () => {
    draw(sessionFor(signer), 'settingsAppearance');
    await press({ key: '.', code: 'Period', metaKey: true });
    const menu = document.querySelector('[data-company-switcher]') as HTMLElement;
    expect([...menu.querySelectorAll('[data-company]')].map((c) => c.getAttribute('data-company'))).toEqual(['c-2', 'c-3', 'c-1']);
    expect(menu.querySelector('[data-slot=amount]')).toBeNull();
    expect(menu.querySelector('[data-company-names] [data-slot=coming-soon]')).not.toBeNull();
    expect(menu.querySelector('[data-action=join-with-a-code] [data-slot=coming-soon]')).not.toBeNull();
    expect(menu.querySelector('[data-action=create-company] [data-slot=coming-soon]')).not.toBeNull();
    expect(menu.querySelector('[data-public-facts]')?.textContent).toBe(EN['switcher.publicFacts']);
  });

  /* RED WHEN: choosing a company does not make it the one shown. */
  it('makes the company chosen the one shown', async () => {
    const chooseCompany = vi.fn();
    draw(sessionFor(signer, { chooseCompany }), 'settingsAppearance');
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
   * RED WHEN: the account's addresses or balances are shown as if they were
   * read, when no request for them exists; or the menu loses light and dark,
   * the language, switching view or signing out.
   */
  it('shows the account\'s addresses and balances Coming soon, and has light and dark, language, switching view and signing out', async () => {
    const { container } = draw(sessionFor(signer), 'settingsAppearance');
    const menu = await openMenu(container);
    expect(menu).not.toBeNull();
    const details = menu.querySelector('[data-account-details]') as HTMLElement;
    expect(details.querySelectorAll('[data-slot=coming-soon]').length).toBe(3);
    expect(details.querySelector('[data-slot=amount]')).toBeNull();
    expect([...menu.querySelectorAll('[data-mode]')].map((m) => m.getAttribute('data-mode'))).toEqual(['light', 'dark', 'system']);
    for (const a of ['language', 'switch-view', 'sign-out']) expect(menu.querySelector(`[data-action=${a}]`), a).not.toBeNull();
  });

  /* RED WHEN: switching view is offered to a person who signs for no company, where there is no company view to switch to. */
  it('offers switching view only to a person who signs for a company', async () => {
    const { container } = draw(sessionFor(employee), 'payAppearance');
    const menu = await openMenu(container);
    expect(menu.querySelector('[data-action=switch-view]')).toBeNull();
  });

  /* RED WHEN: choosing dark, or signing out, does not reach the one function that makes the change. */
  it('makes each change through the session', async () => {
    const choose = vi.fn(); const signOut = vi.fn();
    const { container } = draw(sessionFor(signer, { choose, signOut }), 'settingsAppearance');
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

describe('the pages', () => {
  /* RED WHEN: a page not built yet shows anything but its name, the Coming soon pill and what it will be. */
  it('shows a page not built yet as Coming soon, with what it will be', () => {
    const { container } = draw(sessionFor(signer), 'payroll');
    const page = container.querySelector('[data-screen=coming-soon]') as HTMLElement;
    expect(page.getAttribute('data-page')).toBe('payroll');
    expect(page.querySelector('h1')?.textContent).toBe(EN['page.payroll.name']);
    expect(page.querySelector('[data-slot=coming-soon]')).not.toBeNull();
    expect(page.textContent).toContain(EN['page.payroll.soon']);
    expect(page.querySelectorAll('button:not([data-slot=coming-soon]), input, a').length).toBe(0);
  });

  /* RED WHEN: a section of Settings is shown outside Settings, or Settings lists sections the list does not put in it. */
  it('shows Appearance inside Settings, beside the sections the list puts there', () => {
    const { container } = draw(sessionFor(signer), 'settingsAppearance');
    const settings = container.querySelector('[data-screen=settings]') as HTMLElement;
    expect(settings.querySelector('[data-screen=appearance]')).not.toBeNull();
    expect([...settings.querySelectorAll('[data-settings-section]')].map((s) => s.getAttribute('data-settings-section')))
      .toEqual(EVERY_PAGE.filter((p) => p.inside === 'settings').map((p) => p.id));
  });

  /* RED WHEN: the colours offered are not the kit's list, the language list is not the application's language files, or a choice does not reach the session. */
  it('offers the kit\'s colours and the language files, and makes each choice through the session', async () => {
    const choose = vi.fn();
    const { container } = draw(sessionFor(signer, { choose }), 'settingsAppearance');
    const { BASE_COLORS } = await import('vaults-ui');
    expect([...container.querySelectorAll('[data-colour]')].map((c) => c.getAttribute('data-colour'))).toEqual([...BASE_COLORS]);
    await act(() => { fireEvent.click(container.querySelector('[data-colour=olive] button')!); });
    expect(choose).toHaveBeenCalledWith({ base: 'olive' });
    cleanup();
    const again = draw(sessionFor(signer, { choose }), 'settingsLanguage');
    expect([...again.container.querySelectorAll('[data-language]')].map((c) => c.getAttribute('data-language'))).toEqual(['', ...LANGUAGES.map((l) => l.tag)]);
    expect(again.container.querySelector('[data-number-format] [data-slot=coming-soon]')).not.toBeNull();
  });

  /* RED WHEN: a signer looking at their own pay is not told so, or has no way back. */
  it('tells a signer looking at their own pay, with the way back', async () => {
    const chooseView = vi.fn();
    const { container } = draw(sessionFor({ ...signer, view: VIEWS.employee }, { chooseView }), 'payAppearance');
    const banner = container.querySelector('[data-view-banner]') as HTMLElement;
    await act(() => { fireEvent.click(within(banner).getByRole('button')); });
    expect(chooseView).toHaveBeenCalledWith(VIEWS.company);
    cleanup();
    expect(draw(sessionFor(employee), 'payAppearance').container.querySelector('[data-view-banner]')).toBeNull();
  });
});
