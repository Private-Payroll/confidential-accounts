import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import type { RouteName } from '../routes.js';

/**
 * An honest door for a room that isn't built. Each screen says what will be
 * here and which milestone brings it, so a person understands what is
 * unfinished rather than meeting a dead link.
 */

interface Coming {
  readonly title: string;
  readonly milestone: string;
  readonly body: ReactNode;
}

const COMING: Partial<Record<RouteName, Coming>> = {
  /*
   * Three PLACES were added to the navigation and no screens behind them. Each
   * one says what will be there and that it is not there yet, which is the
   * whole job of this screen: an honest empty room, never a dead link and
   * never a mock-up that a tester mistakes for a thing that works.
   */
  activity: {
    title: 'Activity',
    milestone: 'a future release',
    body: (
      <p className="muted">
        Every payment this wallet has made and received. The wallet SDK already
        answers for it — this is a screen to build, not a capability to invent —
        and like the balances it reads from the indexer only when you ask.
        Payments still waiting for an answer will appear here as well as on your
        wallet.
      </p>
    ),
  },
  /*
   * `explore` IS A SCREEN NOW (`screens/explore.js`), AND THIS ENTRY IS
   * NO LONGER REACHED. It is kept because the change that built the screen said
   * to keep it, and it is commented because the entry two lines below records
   * the opposite decision for `settings`: an entry for a screen that EXISTS is
   * a sentence waiting to be shown to somebody, the day a guard changes and
   * the route falls through here again. Today no branch in `app.tsx` can
   * reach it — `case 'explore'` renders the screen — so the risk is dormant
   * rather than absent. One of the two decisions should win; that is a decision
   * to settle, not this file's.
   */
  explore: {
    title: 'Explore',
    milestone: 'a future release',
    body: (
      <p className="muted">
        Earning, prediction markets, prices — and whatever comes after them.
        Everything that grows arrives in this room rather than as another tab
        along the bottom. Nothing outside is asked anything until you open it,
        and whatever it asks will name the hosts it asks on this screen.
      </p>
    ),
  },
  /* `settings` WAS HERE AND IS GONE — IT IS BUILT. A `COMING` entry for a
   * screen that exists is a sentence waiting to be shown to somebody: this map
   * is read by route name, so the day a guard changes and `#/settings` falls
   * through to `NotBuilt` again, the honest outcome is nothing rather than
   * "not built yet" over a screen that is. */
  /*
   * Home's fourth quick action. The design settles what it
   * is before it is built: ONE store, shared across accounts by default, with a
   * per-contact scope field from day one, and three doors into it — Settings,
   * this shortcut, and inline in Send.
   */
  /* THE WORDS ARE *Contacts*; THE ROUTE NAME IS STILL `address-book`. This
   * map is keyed by ROUTE, and a route name is what the code, the walk and any
   * hash somebody has kept refer to — renaming it to follow the heading would
   * change a URL for a cosmetic reason. */
  'address-book': {
    title: 'Contacts',
    milestone: 'a future release',
    body: (
      <p className="muted">
        The people you pay, so an address is never typed twice. One book shared
        across your wallets — a person is the same person whichever wallet pays
        them — and it is managed in Settings, used inline when you send, and
        reached from your wallet here. A name in it will help you FIND an
        address; it will never stand in place of one on the screen that approves
        a payment.
      </p>
    ),
  },
  advanced: {
    title: 'Advanced',
    milestone: 'a later milestone',
    body: (
      <p className="muted">
        The twenty-four-word recovery phrase — shown only after a deliberate,
        warned act, because anyone who reads it owns the account — and the recovery
        key you can publish so someone can lock a piece to your wallet.
      </p>
    ),
  },
};

export function NotBuilt({ route }: { readonly route: RouteName }): ReactNode {
  const coming = COMING[route];
  if (!coming) return null;
  return (
    <>
      <h1>{coming.title}</h1>
      <p className="lede">
        Not built yet — this arrives in <strong>{coming.milestone}</strong>.
      </p>
      {coming.body}
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('home')}>← Back to your wallet</a>
      </p>
    </>
  );
}
