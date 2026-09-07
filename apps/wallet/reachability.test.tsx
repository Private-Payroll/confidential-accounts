// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/*
 * ============================================================================
 * THE REACHABILITY PIN — THE CLASS, NOT ITS INSTANCE.
 * ============================================================================
 *
 * WHAT HAPPENED. Home was the only place linking to *Add another device*. A change
 * rebuilt Home out of the kit. The rebuild did not mention the link. **The
 * link left with the card it lived in and every one of 710 tests stayed
 * green.** The screenshot walker found it; the suite could not.
 *
 * WHY THE SUITE COULD NOT. Every screen test in this repository renders its
 * screen DIRECTLY and asserts about what is inside it, and `routes.test.ts`
 * only asks whether a path PARSES. **So nothing anywhere asserted that a route
 * was REACHABLE** — the exact words for it: *no test can tell a door
 * from no door.* Settings, the send screen and the money card
 * can each orphan a feature exactly the same way, which is why this was
 * built before any of them.
 *
 * ============================================================================
 * IT IS A WALK FROM THE FRONT DOOR NOW, AND THAT IS THE WHOLE ROUND'S §0.
 * ============================================================================
 *
 * **AN EARLIER VERSION REACHED EACH SCREEN BY ADDRESS.** It set the hash to every
 * route in `KNOWN`, harvested each one, and unioned the results. Its closing note
 * named the residual: *"it does not yet prove you can
 * WALK there from the front door — two screens pointing only at each other
 * would satisfy it. Impossible today because every place is in the permanent
 * navigation; possible the first time a place is reachable only from another
 * place."*
 *
 * **Settings is that place.** Settings is the first screen holding doors to places
 * that are NOT in the navigation — the address book, advanced — so from this
 * change on the union is a claim about addresses and not about doors.
 *
 * **So the walk starts at the front door and follows only what it found.**
 * Mount the real app at `#/`, harvest, follow each door, harvest again, and
 * repeat until nothing new appears. *Reachable* now means **you could get
 * there by pressing things**, which is the sentence the pin is about; it no
 * longer means *the address renders a screen with links on it*.
 *
 * **AND IT WAS WATCHED FAILING BEFORE IT WAS BELIEVED.** The design
 * ordered an island — two routes linking only to each other and to nothing
 * else. The old walk goes green on it; this one goes red naming both. The run
 * was watched. *A pin nobody has watched fail is a claim.*
 *
 * **THE ISLAND IS ALSO PINNED PERMANENTLY, AND NOT BY SHIPPING ONE.** The two
 * island routes existed for one run and were removed; what stays is
 * `reachableFrom` below — the walk as a pure function over a door map — and a
 * test that hands it an island built from real route names as symbols. A
 * property demonstrated once in a report rots; a property a fixture asserts
 * does not.
 *
 * ============================================================================
 * WHAT IT ACTUALLY DOES, AND WHY IT IS NOT A GREP.
 * ============================================================================
 *
 * THE RULE: *"'a link exists' means a link a person can reach, not a
 * string in the file. If the only way to satisfy the pin honestly is to render
 * the screen and look at what it produced, do that."*
 *
 * So it renders. It mounts the real `App` inside the real `SessionProvider`,
 * moves the hash the way a person pressing a link moves it, and harvests the
 * anchors the browser actually got. Three consequences worth stating:
 *
 *   **A route added to the table joins the walk by itself.** The list checked
 *   for orphans is `KNOWN`, read off `routes.ts`, never a copy of it — so a
 *   round that adds a place and forgets to link it is red the moment the route
 *   exists, which is the whole point.
 *
 *   **A link inside a closed dialog does not count**, because Radix does not
 *   mount closed dialog content and there is therefore nothing to harvest.
 *   That is correct: a door behind a popup nobody opens is a door this pin
 *   should not accept on the strength of the source containing an `href`.
 *
 *   **AN ANCHOR IS NOT AUTOMATICALLY A LINK.** One inside an `aria-hidden`
 *   subtree, or one with no words and no accessible name, is not something a
 *   person can reach — so `harvest` refuses both. A pin that accepted them
 *   would go green on a link that had been hidden rather than removed.
 *
 * ============================================================================
 * ONE UNION IS NOT ENOUGH, AND FINDING THAT OUT IS HALF THE VALUE HERE.
 * ============================================================================
 *
 * **The first version of this pin collected every door in the whole app into
 * one set — and the old pin walked straight past it, green.** Deleting *Add another
 * device* from Home, which is the original failure reproduced exactly, changed
 * nothing: `screens/welcome.tsx` also links to `#/add-device`, so the route
 * was still "reachable" — **by a browser with no account in it, which is not
 * the person who lost the door.**
 *
 * That is the same disease one layer up: a test that passes
 * without discriminating. So the pin asks the question a person would ask.
 * **A door has to be in the room you are standing in.** An unlocked wallet is
 * checked against what an unlocked wallet can reach, and a browser with
 * nothing in it against what IT can reach, and a link in the wrong room does
 * not answer for the other. **Each room now has its own front door too** —
 * `#/` unlocked is Home, `#/` empty is Welcome — so the two walks start where
 * their own person starts.
 *
 * ============================================================================
 * THE EXEMPT LISTS ARE DECISIONS AND THEY ARE SHORT ON PURPOSE.
 * ============================================================================
 *
 * THE RULE: *"a route silently added to that list later is the same defect
 * wearing a disguise, so the list is short and it is commented."* Every entry
 * carries the sentence that justifies it, and adding one is a change an audit
 * reads rather than a line it skims.
 *
 * A NOTE ON THE DESIGN, because it does not match the code and the difference
 * matters. The design names six exemptions — `broken`, `notfound`,
 * `unsupported`, `notbuilt`, `passkey-no-account`, `account-no-passkey`. Those
 * are SCREENS, and in this repository **not one of them is a route**: they are
 * rendered by `app.tsx` out of the phase, or out of a parse failure, and
 * `routes.ts` has no name for any of them. So they cannot appear in this walk
 * and cannot be exempted from it — they are already outside it. The exemption
 * the ROUTE table actually needs is the one below, and it is a single entry.
 */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity')>();
  return { ...actual, verifyAssertion: vi.fn() };
});

import { Buffer as PolyfillBuffer } from 'buffer/';
import { usePasskey } from 'midnight-identity/browser';
import { verifyAssertion } from 'midnight-identity';
import { newSecret } from 'midnight-identity/keys/derivation';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import type { Passkey } from 'midnight-identity/passkey/verify';
import { App } from './app.js';
import { SessionProvider } from './session.js';
import { KNOWN, hrefOf, parseRoute } from './routes.js';
import type { RouteName } from './routes.js';
import { savePasskey, saveSecret } from './storage.js';
import { ORIGINAL_SLOT } from './wallets-held.js';

/**
 * THE ONE ROUTE THAT MAY HAVE NO DOOR, AND THE SENTENCE THAT BUYS IT.
 *
 * `kit` — the component gallery. The design adds it *"additive and
 * UNLINKED — it is in no navigation and nothing in the app points at it; you
 * reach it by typing `#/kit`."* It is a workshop surface, and a link to it
 * appearing in a person's wallet is the failure rather than the fix.
 * **It is not unpinned, it is pinned the other way round:** `kit.test.tsx`
 * asserts that every link on that page points at the gallery itself, so a
 * stray door OUT of it is red, and this list is what says a door INTO it is
 * not wanted either.
 *
 * AND THE WALK DOES NOT HARVEST FROM AN EXEMPT SURFACE, which is the half of
 * this that was nearly a hole. The gallery is FULL of anchors — every
 * `ListRow` and `ActionTile` specimen has one — and they are specimens rather
 * than navigation. Counting them would mean a specimen written as
 * `href="#/settings"` could satisfy this pin for the real Settings route while
 * the wallet itself had no door to it: the defect alive, with the pin holding the
 * torch. So a route exempt from NEEDING a door is also not a SOURCE of one.
 *
 * **THIS MAKES THAT REFUSAL CHEAPER TO STATE AND HARDER TO LOSE.** In a walk it
 * is not a filter applied to a list of addresses, it is a room the walk enters
 * and does not look around in — `reachableFrom` takes the list and stops
 * there. A route reached through a real door still COUNTS as reached; it just
 * cannot vouch for anything further on.
 */
const UNLINKED_BY_DECISION: readonly RouteName[] = ['kit'];

/**
 * THE ROUTES WHOSE DOOR IS DELIBERATELY *NOT* IN AN UNLOCKED WALLET.
 *
 * `recover` — gathering pieces ends in a landing that REPLACES the wallet on
 * this machine, so the landing model refuses to reach it idly from `unlocked`: *"a stale
 * link or the Back button must not put a primary button in front of that."*
 * `app.tsx` enforces it by rendering Home when an unlocked browser asks for
 * `#/recover`. Its doors are on the screens of a browser that has nothing —
 * welcome, unlock, broken, and the two half-state phases — which is exactly
 * where somebody rebuilding an account is standing. **Absent from an unlocked
 * wallet is the FEATURE here**, so it is checked against the other room
 * instead of being excused from both.
 */
const DOOR_IS_ELSEWHERE: readonly RouteName[] = ['recover'];

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId,
  personHandle: 'person-1',
  publicKeySpki: new Uint8Array([1, 2, 3]),
  algorithm: -7,
  signCount: 0,
  provenBySignIn: false,
  rpId: 'localhost',
  syncsToACloud: false,
  backedUpNow: false,
  transports: [],
});

const isRoute = (name: string): name is RouteName =>
  (KNOWN as readonly string[]).includes(name);

/** Every route a person can reach from what is currently on the screen. */
function harvest(into: Set<string>): void {
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith('#')) continue;
    /* Present in the DOM is not the same as reachable. */
    if (anchor.closest('[aria-hidden="true"]') !== null) continue;
    if (anchor.closest('[hidden]') !== null) continue;
    const named = (anchor.textContent ?? '').trim() !== ''
      || (anchor.getAttribute('aria-label') ?? '').trim() !== ''
      || (anchor.getAttribute('title') ?? '').trim() !== '';
    if (!named) continue;
    into.add(parseRoute(href).name);
  }
}

/**
 * THE WALK ITSELF, AS A PURE FUNCTION OVER A DOOR MAP.
 *
 * **The reason it is separated from the DOM is that the property it holds is
 * about GRAPH SHAPE, not about React**, and a property demonstrated once in a
 * report rots. The island the design ordered lived for one run
 * and was removed; the fixture below keeps its
 * question askable for ever, at no cost to the route table.
 *
 * BREADTH-FIRST FROM ONE ROOM. Harvest where you are standing, follow only
 * what you found, and stop when nothing new appears. **The start is reachable
 * by definition** — it is the front door, the screen a person lands on with
 * no address at all — and everything else has to be arrived at.
 *
 * `notASource` IS ENTERED AND NOT LOOKED AROUND IN, for the gallery's reason
 * above: reaching it is a fact, and what it links to is not evidence about
 * anything else.
 */
export function reachableFrom(
  start: RouteName,
  doorsOf: (room: RouteName) => Iterable<string>,
  notASource: readonly RouteName[] = [],
): Set<RouteName> {
  const reached = new Set<RouteName>();
  const queue: RouteName[] = [start];
  while (queue.length > 0) {
    const room = queue.shift() as RouteName;
    if (reached.has(room)) continue;
    reached.add(room);
    if (notASource.includes(room)) continue;
    for (const door of doorsOf(room)) {
      /* `not-found` is what `parseRoute` says about a link this table has no
       * name for. It is not a room, so it is not a door. */
      if (!isRoute(door)) continue;
      if (!reached.has(door)) queue.push(door);
    }
  }
  return reached;
}

/**
 * GOING THROUGH A DOOR — AND THE MEASUREMENT THAT MADE THIS FIVE LINES RATHER
 * THAN ONE.
 *
 * **jsdom DOES NOT FIRE `hashchange` WHEN `location.hash` IS ASSIGNED.**
 * Measured here, three ways, against `router.tsx`'s real `useRoute` in a real
 * render — `act(() => { window.location.hash = '#/settings'; })` leaves the
 * component reading `home`; wrapping the same assignment in an ASYNC `act` and
 * letting the task queue drain leaves it reading `home`; dispatching
 * `new HashChangeEvent('hashchange')` after the assignment is the only one of
 * the three that reaches `settings`.
 *
 * **THE OLD WALK DID THE FIRST OF THOSE, SO IT NEVER LEFT HOME.** It set the hash
 * eleven times inside one mounted app and harvested eleven times, and every
 * one of those harvests was of the SAME SCREEN. It was green because Home
 * links to every route in the table, which is true today and is exactly the
 * property this ends — and it would have gone on being green while a screen was
 * orphaned, which is the defect with the pin holding the torch, for the second
 * time. The failing run has the measurement and both walks over
 * the island; the row is the one this change opened.
 *
 * **DISPATCHING THE EVENT IS NOT SIMULATING WHAT IS UNDER TEST.** What is
 * under test is the app's LINK GRAPH — which screen offers a door to which
 * other screen. The browser's own fragment navigation is not this repository's
 * code and is not what the pin is about; jsdom simply does not implement that
 * half, so the harness supplies it. **And the harness is itself pinned**, four
 * tests down, because a navigator that silently does not navigate is what this
 * whole comment is about.
 */
const enter = (room: RouteName): void => {
  act(() => {
    window.location.hash = hrefOf(room);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  window.location.hash = '#/';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

describe('every place and every action has a door', () => {
  /**
   * WHAT ONE ROOM OF THE MOUNTED APP OFFERS. The hash moves inside the SAME
   * mounted app, the way it moves when a person presses a link — remounting
   * per route would drop an unlocked wallet back to `locked` and quietly
   * measure the wrong room.
   */
  const doorsOfTheMountedApp = (room: RouteName): Set<string> => {
    enter(room);
    const doors = new Set<string>();
    harvest(doors);
    return doors;
  };

  /** What a browser with NOTHING in it can reach, starting where it lands. */
  function fromAnEmptyBrowser(): Set<RouteName> {
    window.location.hash = '#/';
    render(<SessionProvider><App /></SessionProvider>);
    const found = reachableFrom('home', doorsOfTheMountedApp, UNLINKED_BY_DECISION);
    cleanup();
    return found;
  }

  /**
   * An unlocked wallet standing on Home, through the REAL unlock. No phase is
   * faked, because a faked phase is a screen nobody has to have rendered
   * correctly to get.
   */
  async function openAnUnlockedWallet(): Promise<void> {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    vi.mocked(usePasskey).mockResolvedValue({ credentialId: 'cred-1' } as never);
    vi.mocked(verifyAssertion).mockResolvedValue({ passkey: passkeyFixture('cred-1') } as never);
    window.location.hash = '#/';
    render(<SessionProvider><App /></SessionProvider>);
    fireEvent.click(screen.getByText('Unlock with your passkey'));
    await screen.findByText('Every wallet');
  }

  /** What an UNLOCKED WALLET can reach, starting on Home. */
  async function fromAnUnlockedWallet(): Promise<Set<RouteName>> {
    await openAnUnlockedWallet();
    const found = reachableFrom('home', doorsOfTheMountedApp, UNLINKED_BY_DECISION);
    cleanup();
    return found;
  }

  const complain = (orphans: readonly string[], room: string): string =>
    `nothing an ${room} can WALK to links to: ${orphans.join(', ')}. `
    + 'A route nothing points at is a feature nobody can reach. The walk '
    + 'starts at the front door and follows only the doors it finds, so a route '
    + 'reachable only by typing its address is an orphan. Add a door on a screen '
    + 'that walk already reaches, or add the route to UNLINKED_BY_DECISION or '
    + 'DOOR_IS_ELSEWHERE with the sentence that justifies it.';

  it('an unlocked wallet has a door to every place and every action', async () => {
    const found = await fromAnUnlockedWallet();
    /*
     * AND IT SAYS WHERE IT WENT. ADDED; no assertion below changed.
     *
     * STANDING RULE: *reading a test's code tells you what it would
     * assert if it ran as intended; it does not tell you what it ran on. A test
     * that walks, renders or navigates must be made to say WHERE IT WENT before
     * any conclusion is drawn from its colour.* That rule cost this project two
     * changes (and the CORRECTION above it), and until this line
     * the walk was still a colour rather than an itinerary in every report that
     * quoted it. It prints; nothing reads the print, so it cannot be a second
     * source of truth — it is the walk saying out loud what it saw.
     */
    // eslint-disable-next-line no-console
    console.log(`WITNESS unlocked · walked to: ${[...found].sort().join(', ')}`);
    const orphans = KNOWN
      .filter((route) => !UNLINKED_BY_DECISION.includes(route))
      .filter((route) => !DOOR_IS_ELSEWHERE.includes(route))
      .filter((route) => !found.has(route));
    expect(orphans, complain(orphans, 'unlocked wallet')).toEqual([]);
  });

  it('and a browser with nothing in it has a door to the ones that belong there', () => {
    const found = fromAnEmptyBrowser();
    const orphans = DOOR_IS_ELSEWHERE.filter((route) => !found.has(route));
    expect(orphans, complain(orphans, 'empty browser')).toEqual([]);
  });

  /**
   * THE EXEMPT LIST IS PINNED TOO, or it is a hole rather than a decision. A
   * later change that finds this test in its way can still add a name to
   * `UNLINKED_BY_DECISION` — but it cannot do it and leave the count where it
   * was, so the diff says out loud that an exemption was bought.
   */
  it('the exempt lists are exactly what was decided, and no longer', () => {
    expect(UNLINKED_BY_DECISION).toEqual(['kit']);
    expect(DOOR_IS_ELSEWHERE).toEqual(['recover']);
  });

  /**
   * AND THE HARVESTER ITSELF IS PINNED, because a pin whose collector is
   * broken is green for the wrong reason. If `harvest` ever stopped seeing
   * anchors — a selector typo, a change in how links are drawn — the test
   * above would go green with an EMPTY set and nothing would say so.
   */
  it('the harvester actually finds links — the pin is not green on an empty set', async () => {
    const found = await fromAnUnlockedWallet();
    expect(found.size).toBeGreaterThan(3);
    /* And it discriminates: `kit` is a real route with real anchors on it, and
     * the walk neither reaches it nor accepts a door to it. A harvester that
     * scraped the SOURCE, or a walk that visited every address and harvested
     * the gallery's specimens, would find it here. */
    expect(found.has('kit')).toBe(false);
  });

  /**
   * AND THE NAVIGATOR IS PINNED, WHICH IS THE LESSON OF THIS CHANGE'S §0.
   *
   * The old walk moved the hash and nothing happened, and nothing said so: the
   * harvest that followed re-read Home, and the union came out green because
   * Home links to everything. **A walk that cannot leave the first room is not
   * a walk, and it fails in the direction of passing.** So the going-through-a-
   * door part is asserted on its own, against two screens that cannot be
   * mistaken for each other.
   */
  it('the walk actually MOVES — a room away from Home is a different screen', async () => {
    await openAnUnlockedWallet();
    expect(screen.queryByText('Every wallet')).not.toBeNull();
    enter('activity');
    /* Home is gone... */
    expect(screen.queryByText('Every wallet')).toBeNull();
    /* ...and the room asked for is the one that arrived. */
    expect(screen.getByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
  });
});

/**
 * ============================================================================
 * THE ISLAND — §0, KEPT AS A FIXTURE RATHER THAN AS TWO REAL ROUTES.
 * ============================================================================
 *
 * THE ORDER WAS: *"Build the island the current pin cannot see: two routes
 * linking only to each other and to nothing else. The old walk goes green, the
 * new one goes red."* That was done with real routes, once, and the failure
 * text was watched.
 *
 * **What is below is the same question asked of a fixture**, so it survives
 * the island being removed. Real route names are used as SYMBOLS — the map is
 * invented, and the point is the shape of the graph, not this app's doors.
 */
describe('the walk is a WALK', () => {
  /** home ⇄ activity, and an island of two rooms pointing only at each other. */
  const ISLAND: Readonly<Record<string, readonly string[]>> = {
    home: ['activity'],
    activity: ['home'],
    secure: ['add-device'],
    'add-device': ['secure'],
  };
  const doorsOf = (room: RouteName): readonly string[] => ISLAND[room] ?? [];

  it('refuses an island — two rooms that point only at each other', () => {
    const found = reachableFrom('home', doorsOf);
    expect([...found].sort()).toEqual(['activity', 'home']);
    /* THE SENTENCE THIS FILE IS ABOUT. The old walk asked every address in
     * turn, so both island rooms rendered links and both looked reachable. */
    expect(found.has('secure')).toBe(false);
    expect(found.has('add-device')).toBe(false);
  });

  it('follows a chain of rooms, however long', () => {
    const chain: Readonly<Record<string, readonly string[]>> = {
      home: ['settings'],
      settings: ['address-book'],
      'address-book': ['advanced'],
      advanced: [],
    };
    const found = reachableFrom('home', (room) => chain[room] ?? []);
    expect([...found].sort()).toEqual(['address-book', 'advanced', 'home', 'settings']);
  });

  it('enters an exempt room and does not take its word for anything further on', () => {
    const gallery: Readonly<Record<string, readonly string[]>> = {
      home: ['kit'],
      /* The gallery's specimens. Every one of these is an anchor in the DOM. */
      kit: ['settings', 'send', 'activity', 'explore'],
    };
    const found = reachableFrom('home', (room) => gallery[room] ?? [], ['kit']);
    expect([...found].sort()).toEqual(['home', 'kit']);
  });

  it('is not fooled by a link to a path the route table has no name for', () => {
    const found = reachableFrom('home', () => ['nowhere', 'not-found', 'activity']);
    expect([...found].sort()).toEqual(['activity', 'home']);
  });
});
