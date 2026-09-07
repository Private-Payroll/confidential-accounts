/**
 * The route table, as a pure function so it can be tested without a browser.
 *
 * Routing is hash-based on purpose: there is no server behind this app
 * (§7.8), so there is nothing to rewrite deep links back to
 * `index.html`. `#/secure` survives a reload; `/secure` would 404.
 */

export type RouteName =
  | 'home'
  /* The three places the navigation adds. Additive only — no existing
   * name, path or parse behaviour moves, and `routes.test.ts` passes
   * unchanged. Each renders the `notbuilt` screen until its own round. */
  | 'activity'
  | 'explore'
  | 'settings'
  | 'send'
  | 'secure'
  | 'recover'
  | 'add-device'
  | 'advanced'
  /* The address book. ADDITIVE — no existing name, path or parse behaviour
   * moves, and `routes.test.ts` passes unchanged. THE RULE:
   * *"the shortcut is real; the panel is deferred"* — Home links here and the
   * `notbuilt` screen says what will be here, because building it as an inline
   * drawer now and converting it to a route later is a rewrite. */
  | 'address-book'
  /* The component gallery. ADDITIVE and UNLINKED — it is in no navigation
   * and nothing in the app points at it; you reach it by typing `#/kit`. It is
   * a workshop surface for looking at every component in every state at once,
   * which is what stops the same argument about a button happening on Activity,
   * then on Settings, then on Send. */
  | 'kit'
  /* The person's own details, and the surface that approves letting some
   * of them out. ADDITIVE — no existing name, path or parse behaviour moves,
   * and `routes.test.ts` passes unchanged.
   *
   * NEITHER IS A PLACE. The design keeps the navigation at four
   * places on purpose, and growth goes into Explore or into Settings rather
   * than into the bar. `profile` is reached from Settings, the way the address
   * book is; `approve` is where an application that opened this wallet lands,
   * and is reachable by typing the hash so the screen can be seen and
   * photographed without a second origin. */
  | 'profile'
  | 'approve';

export interface Route {
  readonly name: RouteName | 'not-found';
  /** The path as typed, kept for the not-found screen to show. */
  readonly path: string;
}

/**
 * EXPORTED, and that is the only change to this file this change.
 * ADDITIVE: no name, no path and no parse behaviour moves, and
 * `routes.test.ts` passes unchanged.
 *
 * `reachability.test.tsx` walks this array. It has to be the array the parser
 * uses rather than a copy of it, or a route added here and forgotten there is
 * exactly the orphan the pin exists to catch, wearing the pin's own clothes.
 */
export const KNOWN: readonly RouteName[] = [
  'home', 'activity', 'explore', 'settings',
  'send', 'secure', 'recover', 'add-device', 'advanced', 'address-book', 'kit',
  'profile', 'approve',
];

/** `#/secure` → `{name: 'secure'}`. Empty, `#` and `#/` are home. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (path === '') return { name: 'home', path: '/' };
  const name = KNOWN.find((known) => known === path);
  return name ? { name, path: `/${path}` } : { name: 'not-found', path: `/${path}` };
}

export const hrefOf = (name: RouteName): string => (name === 'home' ? '#/' : `#/${name}`);
