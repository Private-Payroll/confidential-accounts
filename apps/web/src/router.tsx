import { createContext, useContext, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { EVERY_PAGE, HOME, mayOpen, PAGES, type Page, type PageId, type Viewer } from './pages.js';

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

/** The page's address. */
export const addressOf = (id: PageId): string => PAGES[id].path;

/** Go to a page. `replace` leaves no step in the tab's history, for a page the person did not ask for by name. */
export function go(id: PageId, replace = false): void {
  const to = addressOf(id);
  if (normalised(window.location.pathname) === to) return;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  changed();
}

/** What an address opens for a viewer: a page, a page they may not open, or nothing. */
export const RESOLVED = { page: 'page', notYours: 'not-yours', nothing: 'nothing' } as const;

export type Resolved =
  | { of: typeof RESOLVED.page; id: PageId; page: Page }
  | { of: typeof RESOLVED.notYours; id: PageId; page: Page }
  | { of: typeof RESOLVED.nothing };

/**
 * WHAT `address` OPENS FOR `viewer`. The address is matched against the list
 * alone; a page the viewer may not open is never opened, whoever typed its
 * address.
 */
export function resolve(address: string, viewer: Viewer): Resolved {
  const at = normalised(address);
  const found = EVERY_PAGE.find((p) => p.path === at);
  if (found === undefined) return { of: RESOLVED.nothing };
  return mayOpen(found, viewer) ? { of: RESOLVED.page, id: found.id, page: found } : { of: RESOLVED.notYours, id: found.id, page: found };
}

/** The page to go to instead, when the address opens nothing the viewer may see: where their view begins. */
export const homeOf = (viewer: Viewer): PageId => (viewer.signedIn ? HOME[viewer.view] : HOME.visitor);

const CurrentPage = createContext<{ id: PageId; page: Page } | null>(null);

/** The page being shown, for a screen that is shown at more than one address. */
export function useCurrentPage(): { id: PageId; page: Page } {
  const current = useContext(CurrentPage);
  /* Only the router shows a screen, and it always says which page; a screen shown any other way is a mistake in the code. */
  if (current === null) throw new RangeError();
  return current;
}

export function CurrentPageProvider({ id, children }: { id: PageId; children?: ReactNode }) {
  return <CurrentPage.Provider value={{ id, page: PAGES[id] }}>{children}</CurrentPage.Provider>;
}

/**
 * A LINK TO A PAGE, BY ITS ID. It is a real link, so it can be opened in a new
 * tab, and a plain press goes to the page without reloading.
 */
export function PageLink({ to, children, onClick, ...rest }: { to: PageId; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const follow = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
  return <a href={addressOf(to)} onClick={follow} {...rest}>{children}</a>;
}
