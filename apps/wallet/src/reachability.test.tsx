// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from './testing/render.js';

/* Walks the mounted app from its front door, following only links a person can reach, and fails on any route no
 * walk reaches: one walk for an unlocked wallet and one for a browser with nothing in it. */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => undefined,
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn()
}));

vi.mock('midnight-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof Identity>();
  return { ...actual, verifyAssertion: vi.fn() };
});

import { Buffer as PolyfillBuffer } from 'buffer/';
import { verifyAssertion } from 'midnight-identity';
import { usePasskey } from 'midnight-identity/browser';
import { newSecret } from 'midnight-identity/keys/derivation';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import type * as Identity from 'midnight-identity';
import type { AssertionInput, AssertionResult, Passkey } from 'midnight-identity/passkey/verify';

import { savePasskey, saveSecret } from './accounts/storage.js';
import { ORIGINAL_SLOT } from './accounts/wallets-held.js';
import { App } from './app.js';
import type { RouteName } from './routes.js';
import { hrefOf, KNOWN, parseRoute } from './routes.js';
import { SessionProvider } from './session.js';

/* `kit`, the component gallery, is reached only by typing its address; its specimen links are not counted as doors,
 * so a specimen can never stand in for a real link. */
const UNLINKED_BY_DECISION: readonly RouteName[] = ['kit'];

/* `recover` replaces the wallet on this machine, so an unlocked wallet has no door to it; its doors are on the screens
 * of a browser with nothing open. */
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
  transports: []
});

const assertionFixture = (credentialId: string): AssertionInput => ({
  credentialId,
  clientDataJSON: new Uint8Array(),
  authenticatorData: new Uint8Array(),
  signature: new Uint8Array(),
  userHandle: 'person-1'
});

const signedInFixture = (credentialId: string): AssertionResult => ({
  personHandle: 'person-1',
  signCount: 1,
  userVerified: true,
  backedUpNow: false,
  passkey: passkeyFixture(credentialId)
});

const isRoute = (name: string): name is RouteName => (KNOWN as readonly string[]).includes(name);

/** Every route a person can reach from what is currently on the screen. */
function harvest(into: Set<string>): void {
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith('#')) continue;
    /* Present in the DOM is not the same as reachable. */
    if (anchor.closest('[aria-hidden="true"]') !== null) continue;
    if (anchor.closest('[hidden]') !== null) continue;
    const named =
      (anchor.textContent ?? '').trim() !== '' ||
      (anchor.getAttribute('aria-label') ?? '').trim() !== '' ||
      (anchor.getAttribute('title') ?? '').trim() !== '';
    if (!named) continue;
    into.add(parseRoute(href).name);
  }
}

/** Every room reachable from `start` over a door map; a room in `notASource` is reached, its doors not followed. */
export function reachableFrom(
  start: RouteName,
  doorsOf: (room: RouteName) => Iterable<string>,
  notASource: readonly RouteName[] = []
): Set<RouteName> {
  const reached = new Set<RouteName>();
  const queue: RouteName[] = [start];
  for (let room = queue.shift(); room !== undefined; room = queue.shift()) {
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

/* jsdom does not fire `hashchange` when `location.hash` is assigned, so it is dispatched here; without it the walk
 * never leaves Home and harvests the same screen every time. */
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
  /* The hash moves inside the same mounted app: remounting per route would drop an unlocked wallet back to locked. */
  const doorsOfTheMountedApp = (room: RouteName): Set<string> => {
    enter(room);
    const doors = new Set<string>();
    harvest(doors);
    return doors;
  };

  /** What a browser with NOTHING in it can reach, starting where it lands. */
  function fromAnEmptyBrowser(): Set<RouteName> {
    window.location.hash = '#/';
    render(
      <SessionProvider>
        <App />
      </SessionProvider>
    );
    const found = reachableFrom('home', doorsOfTheMountedApp, UNLINKED_BY_DECISION);
    cleanup();
    return found;
  }

  /** An unlocked wallet standing on Home, through the real unlock rather than a faked phase. */
  async function openAnUnlockedWallet(): Promise<void> {
    savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
    await saveSecret(newSecret());
    vi.mocked(usePasskey).mockResolvedValue(assertionFixture('cred-1'));
    vi.mocked(verifyAssertion).mockResolvedValue(signedInFixture('cred-1'));
    window.location.hash = '#/';
    render(
      <SessionProvider>
        <App />
      </SessionProvider>
    );
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
    `nothing an ${room} can WALK to links to: ${orphans.join(', ')}. ` +
    'A route nothing points at is a feature nobody can reach. The walk ' +
    'starts at the front door and follows only the doors it finds, so a route ' +
    'reachable only by typing its address is an orphan. Add a door on a screen ' +
    'that walk already reaches, or add the route to UNLINKED_BY_DECISION or ' +
    'DOOR_IS_ELSEWHERE with the sentence that justifies it.';

  it('an unlocked wallet has a door to every place and every action', async () => {
    const found = await fromAnUnlockedWallet();
    console.log(`WITNESS unlocked · walked to: ${[...found].sort().join(', ')}`);
    const orphans = KNOWN.filter((route) => !UNLINKED_BY_DECISION.includes(route))
      .filter((route) => !DOOR_IS_ELSEWHERE.includes(route))
      .filter((route) => !found.has(route));
    expect(orphans, complain(orphans, 'unlocked wallet')).toEqual([]);
  });

  it('and a browser with nothing in it has a door to the ones that belong there', () => {
    const found = fromAnEmptyBrowser();
    const orphans = DOOR_IS_ELSEWHERE.filter((route) => !found.has(route));
    expect(orphans, complain(orphans, 'empty browser')).toEqual([]);
  });

  // RED WHEN: a route is added to an exempt list without this test changing with it.
  it('the exempt lists are exactly what was decided, and no longer', () => {
    expect(UNLINKED_BY_DECISION).toEqual(['kit']);
    expect(DOOR_IS_ELSEWHERE).toEqual(['recover']);
  });

  // RED WHEN: the harvester stops seeing links and the walk passes on an empty set.
  it('the harvester actually finds links — the pin is not green on an empty set', async () => {
    const found = await fromAnUnlockedWallet();
    expect(found.size).toBeGreaterThan(3);
    /* `kit` has real anchors; a walk that harvested the gallery's specimens would reach it here. */
    expect(found.has('kit')).toBe(false);
  });

  // RED WHEN: going through a door leaves the walk standing on Home.
  it('the walk actually MOVES — a room away from Home is a different screen', async () => {
    await openAnUnlockedWallet();
    expect(screen.queryByText('Every wallet')).not.toBeNull();
    enter('activity');
    expect(screen.queryByText('Every wallet')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
  });
});

/* The walk itself, over invented door maps that use real route names as symbols. */
describe('the walk is a WALK', () => {
  /** home ⇄ activity, and an island of two rooms pointing only at each other. */
  const ISLAND: Readonly<Record<string, readonly string[]>> = {
    home: ['activity'],
    activity: ['home'],
    secure: ['add-device'],
    'add-device': ['secure']
  };
  const doorsOf = (room: RouteName): readonly string[] => ISLAND[room] ?? [];

  it('refuses an island — two rooms that point only at each other', () => {
    const found = reachableFrom('home', doorsOf);
    expect([...found].sort()).toEqual(['activity', 'home']);
    /* Each island room links to the other, so a walk over every address would call both reachable. */
    expect(found.has('secure')).toBe(false);
    expect(found.has('add-device')).toBe(false);
  });

  it('follows a chain of rooms, however long', () => {
    const chain: Readonly<Record<string, readonly string[]>> = {
      home: ['settings'],
      settings: ['address-book'],
      'address-book': ['advanced'],
      advanced: []
    };
    const found = reachableFrom('home', (room) => chain[room] ?? []);
    expect([...found].sort()).toEqual(['address-book', 'advanced', 'home', 'settings']);
  });

  it('enters an exempt room and does not take its word for anything further on', () => {
    const gallery: Readonly<Record<string, readonly string[]>> = {
      home: ['kit'],
      /* The gallery's specimens. Every one of these is an anchor in the DOM. */
      kit: ['settings', 'send', 'activity', 'explore']
    };
    const found = reachableFrom('home', (room) => gallery[room] ?? [], ['kit']);
    expect([...found].sort()).toEqual(['home', 'kit']);
  });

  it('is not fooled by a link to a path the route table has no name for', () => {
    const found = reachableFrom('home', () => ['nowhere', 'not-found', 'activity']);
    expect([...found].sort()).toEqual(['activity', 'home']);
  });
});
