import { createContext, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { EVERY_PAGE, HOME, mayOpen, PAGES, type Page, type PageId, type Params, type Viewer } from './pages.js';
import { Fault, FAULT } from './faults.js';

/**
 * THE ROUTER. It knows the pages only from the one list: an address is a page
 * when the list names it, and is opened only when the list says the viewer may
 * open it. Going to a page is naming its id, never writing its address, so an
 * address that is not in the list cannot be linked to.
 */

/** The browser's events this file listens for. */
const BROWSER_EVENTS = { back: 'popstate' } as const;

const listeners = new Set<() => void>();
const changed = (): void => { for (const l of listeners) l(); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener(BROWSER_EVENTS.back, changed);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener(BROWSER_EVENTS.back, changed);
  };
}

/** The address the tab is at, without a trailing slash, followed as it changes. */
export function useAddress(): string {
  return useSyncExternalStore(subscribe, () => normalised(window.location.pathname));
}

/** An address as the list writes it: no trailing slash, except for the root. */
export const normalised = (path: string): string => path.replace(/\/+$/, '') || path.slice(0, 1);

/** What a value in a page's address may be written with: letters, digits, `_` and `-`, so it can never end the part it fills or be read as anything but itself. */
const SAFE_VALUE = /^[A-Za-z0-9_-]+$/;
/** A part of a page's address that stands for a value, such as `:run`. */
const VALUE_PART = /^:[a-z]+$/;
const VALUE_PARTS = /:([a-z]+)/g;

/**
 * THE PAGE'S ADDRESS, with each value it stands for filled in from `params`.
 * A page that stands for a value, opened without it or with one that is not
 * written in the letters a value may be, is a mistake in the code.
 */
export function addressOf(id: PageId, params: Params = {}): string {
  return PAGES[id].path.replace(VALUE_PARTS, (_part, name: string) => {
    const value = params[name];
    if (value === undefined || !SAFE_VALUE.test(value)) throw new Fault(FAULT.noValueForAddress);
    return value;
  });
}

/**
 * The values `address` gives the parts of `path` that stand for one, or null
 * when `address` is not that page's: every other part the same, and every
 * value there and written in the letters a value may be.
 */
export function matchAddress(path: string, address: string): Params | null {
  const want = path.split(/\//);
  const got = address.split(/\//);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const value = got[i]!;
    if (!VALUE_PART.test(part)) { if (part !== value) return null; continue; }
    if (!SAFE_VALUE.test(value)) return null;
    params[part.slice(1)] = value;
  }
  return params;
}

/** Go to a page. `replace` leaves no step in the tab's history, for a page the person did not ask for by name. `params` fills the values the page's address stands for. */
export function go(id: PageId, replace = false, params: Params = {}): void {
  const to = addressOf(id, params);
  if (normalised(window.location.pathname) === to) return;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  changed();
}

/** What an address opens for a viewer: a page, a page they may not open, or nothing. */
export const RESOLVED = { page: 'page', notYours: 'not-yours', nothing: 'nothing' } as const;

export type Resolved =
  | { of: typeof RESOLVED.page; id: PageId; page: Page; params: Params }
  | { of: typeof RESOLVED.notYours; id: PageId; page: Page }
  | { of: typeof RESOLVED.nothing };

/**
 * WHAT `address` OPENS FOR `viewer`. The address is matched against the list
 * alone, a page whose address stands for a value taking that value from it;
 * a page the viewer may not open is never opened, whoever typed its address.
 * An address a page names outright is that page's before any page that
 * stands for a value there.
 */
export function resolve(address: string, viewer: Viewer): Resolved {
  const found = pageAt(EVERY_PAGE, normalised(address));
  if (found === null) return { of: RESOLVED.nothing };
  const { page, params } = found;
  return mayOpen(page, viewer) ? { of: RESOLVED.page, id: page.id, page, params } : { of: RESOLVED.notYours, id: page.id, page };
}

/**
 * The page of `pages` at the address `at`, and the values it takes from it.
 * A page that names the address outright wins over every page whose address
 * stands for a value there, wherever each sits in the list; among those, the
 * first in the list wins. Null when no page is at the address.
 */
export function pageAt<P extends Page & { id: PageId }>(pages: readonly P[], at: string): { page: P; params: Params } | null {
  const outright = pages.find((p) => p.path === at);
  if (outright !== undefined) return { page: outright, params: {} };
  for (const page of pages) {
    const params = matchAddress(page.path, at);
    if (params !== null) return { page, params };
  }
  return null;
}

/** The page to go to instead, when the address opens nothing the viewer may see: where their view begins. */
export const homeOf = (viewer: Viewer): PageId => (viewer.signedIn ? HOME[viewer.view] : HOME.visitor);

const CurrentPage = createContext<{ id: PageId; page: Page; params: Params } | null>(null);

/** The page being shown, and the values its address gave, for a screen that is shown at more than one address. */
export function useCurrentPage(): { id: PageId; page: Page; params: Params } {
  const current = useContext(CurrentPage);
  /* Only the router shows a screen, and it always says which page; a screen shown any other way is a mistake in the code. */
  if (current === null) throw new Fault(FAULT.noCurrentPage);
  return current;
}

export function CurrentPageProvider({ id, params = {}, children }: { id: PageId; params?: Params; children?: ReactNode }) {
  return <CurrentPage.Provider value={{ id, page: PAGES[id], params }}>{children}</CurrentPage.Provider>;
}

/**
 * A LINK TO A PAGE, BY ITS ID. It is a real link, so it can be opened in a new
 * tab, and a plain press goes to the page without reloading.
 */
export function PageLink({ to, params, children, onClick, ...rest }: { to: PageId; params?: Params; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const follow = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to, false, params);
  };
  return <a href={addressOf(to, params)} onClick={follow} {...rest}>{children}</a>;
}
