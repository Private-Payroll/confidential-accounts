/*
 * A screen of the page opened against the company the wallet's harness makes, with each read it makes counted. The
 * service is the company's own routes in memory, reached through the page's own transport; the builder is the
 * company's builder double; the person's wallet answers who holds the account from the company's chain double. One
 * opening of one screen is counted: every call to the service by route, every ask of the wallet by what it asks, and
 * every chain, builder and indexer read by the door it came through.
 * An opening is whole or it fails: it waits for every read it has started to answer, fails if its reads do not go quiet, and
 * fails the next opening (or the end of the test) if a read of it started after it was counted.
 *
 * The page's device is the person's own, kept between openings: what it has checked of the company stays checked, so
 * a first opening on a new device and an opening after it are counted apart.
 */
import { createElement, type ReactElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { routeOf, type IntentShape } from 'midnight-identity/profile/request';
import { metadataOf, seatsOf, type Keyring } from 'vaults-web-shared/keyring-blob.js';
import { signedInByAnotherScreen, takeTheRead } from 'vaults-web-shared/keyring.js';
import type { HoldersRead } from 'vaults-web-shared/wallet-records-key.js';
import { ACT_INTENTS } from '../../../../packages/identity/src/profile/act-intents.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';

/** The door a chain, builder or indexer read came through, as the wallet's harness names it. */
export type Door = 'holders' | 'onChain' | 'builder' | 'indexer';

/** How many of each kind of record the company holds, as the wallet's harness takes it. */
export interface CompanySize {
  readonly people: number;
  readonly vendors?: number;
  readonly vaults?: number;
  readonly proposals?: number;
  readonly seats?: number;
  readonly anchoredBatches?: number;
}
/** The company a screen is opened on, as the wallet's harness makes it: what the counting here reads of it. */
export interface CompanyOpened {
  readonly wallet: (person: string) => { readonly kept: Keyring };
  readonly seats: () => readonly { readonly person: string }[];
  readonly vaults: () => readonly string[];
  readonly fields: { readonly record: string };
  readonly companyKey: string;
  readonly call: (person: string) => (method: string, path: string, body?: string) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly served: () => number;
  readonly openProposals: () => number;
  readonly growTo: (size: CompanySize) => Promise<void>;
}
/* The chain as the person's wallet reads it to answer the page. */
interface WalletReads {
  readonly holders: () => Promise<unknown>;
  readonly roles: (account: unknown, label: unknown, keys: readonly string[]) => Promise<unknown>;
  readonly indexer: HoldersRead['indexer'];
}
interface WalletHarness {
  readonly aCompanyOf: (size: CompanySize, served: { readonly vaultRows: boolean }) => CompanyOpened;
  readonly doorsCountedWhile: <T>(company: CompanyOpened, by: string, open: () => Promise<T>) => Promise<{
    readonly value: T; readonly doors: readonly { readonly door: Door; readonly ask: string }[];
  }>;
  readonly doorsAsked: () => number;
  readonly doorsInFlight: () => number;
  readonly refuseLateDoorAsks: () => void;
  readonly companyDoors: () => { readonly builder: unknown; readonly walletReads: WalletReads };
}

/* The page's builder is the company's, and the person's wallet answers from the company's chain; every other ask of the wallet is counted and refused. */
const page = vi.hoisted(() => ({ asked: null as string[] | null, late: [] as string[], inFlight: 0, harness: null as WalletHarness | null }));
/* An ask of the wallet lands in the opening being counted, or, with none open, in the reads to be refused. */
const walletAsked = (what: string): void => { if (page.asked !== null) page.asked.push(what); else page.late.push(`wallet ${what}`); };
const harness = (): WalletHarness => page.harness!;
vi.mock('../adapters/vault-builder.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-builder.js')>()),
  theVaultBuilder: async () => harness().companyDoors().builder,
}));
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async (_origin: string, ask: { readonly roles?: readonly string[] }): Promise<HoldersRead> => {
    walletAsked('holders');
    page.inFlight += 1;
    try {
      const chain = harness().companyDoors().walletReads;
      const holders = await chain.holders() as HoldersRead['holders'];
      const roles = ask.roles === undefined ? {} : { roles: await chain.roles(null, null, ask.roles) as HoldersRead['roles'] };
      return { holders, indexer: chain.indexer, ...roles };
    } finally {
      page.inFlight -= 1;
    }
  },
}));
vi.mock('vaults-web-shared/wallet-sign-in.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-sign-in.js')>()),
  askWallet: async (_view: unknown, _origin: string, message: { readonly kind?: string }) => {
    walletAsked(String(message.kind));
    throw new Error(`the page asked the wallet for ${String(message.kind)}, which a screen's opening here is not answered`);
  },
}));

/* The wallet's harness, named by a path the page's typecheck does not follow: the wallet's code is typed under its own config. */
const WALLET_HARNESS = '../../../wallet/src/actions/company-harness.test-support.js';
page.harness = await import(/* @vite-ignore */ WALLET_HARNESS) as WalletHarness;

/**
 * Makes the company of the wallet's harness and seeds it to `size` before the file's tests run. Call it where the
 * file's tests are declared, once.
 */
export const aCompanyOf = (size: CompanySize): CompanyOpened => {
  const company = harness().aCompanyOf(size, { vaultRows: true });
  /* A read that started after the last opening of a test was counted fails that test, not only the next opening. */
  afterEach(() => refuseLateReads());
  return company;
};

const { PageView } = await import('../app.js');
const { Shell } = await import('../shell/shell.js');
const { SessionProvider } = await import('../session.js');
const { DEFAULT_PREFERENCES } = await import('../preferences.js');
const { addressOf } = await import('../router.js');
const { VIEWS } = await import('../pages.js');
type PageId = Parameters<typeof addressOf>[0];

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
const LANGUAGES = languagesFrom({ './locales/en.json': ENGLISH });
/** How long one opening may take before it fails: every record is opened with the real keys, so it is seconds, not milliseconds. */
const OPENING_MS = 60_000;

/** What one opening of a screen read: its service calls by route, its wallet asks, and its door reads by door and by ask. */
export interface ScreenCount {
  readonly screen: string;
  /** The words the screen showed once it was drawn, so a count is known to be of a screen that read its records. */
  readonly text: string;
  readonly routes: Readonly<Record<string, number>>;
  readonly wallet: Readonly<Record<string, number>>;
  readonly doors: Readonly<Record<Door, number>>;
  readonly asks: Readonly<Record<string, number>>;
}

/* Every route any action declares, so a page's call is named by the same method and pattern an action's is. */
const EVERY_ROUTE: IntentShape = {
  fields: {},
  calls: Object.values(ACT_INTENTS as Readonly<Record<string, IntentShape>>).flatMap((shape) => shape.calls ?? []),
};
/* A path segment that names one record: anything with a digit in it, or the company's own id. */
const namesARecord = (segment: string, company: string): boolean => segment === company || /\d/u.test(segment);

/**
 * The route a page's call matches, as its method and pattern; a call no action declares is named by its path with
 * each segment that names a record written `:id`, so the same read of two records is one route.
 */
export const pageRouteOf = (method: string, path: string, company: string): string => {
  const route = routeOf(EVERY_ROUTE, method, path);
  if (route !== null) return `${route.method} ${route.path}`;
  const bare = path.split('?')[0]!.split('/').map((s) => (namesARecord(s, company) ? ':id' : s)).join('/');
  return `${method} ${bare} (no action declares it)`;
};

const tallied = (names: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const n of names) out[n] = (out[n] ?? 0) + 1;
  return out;
};
const byDoor = (doors: readonly { readonly door: Door }[]): Record<Door, number> => {
  const out: Record<Door, number> = { holders: 0, onChain: 0, builder: 0, indexer: 0 };
  for (const d of doors) out[d.door] += 1;
  return out;
};

/*
 * The page's own fetch: a call to the service goes to the company's routes as the person, counted by route. A call to any other
 * address is counted by its address and refused, never made, but for the machine's own: the harness's own hops between the
 * service and the vault service go to it, and are the harness's, not the page's. A call is in flight until it has answered, and one made while no
 * opening is being counted is kept, to be refused.
 */
const realFetch = globalThis.fetch.bind(globalThis);
const onThisMachine = (url: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/u.test(url);
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const NO_BODY = new Set([204, 205, 304]);
const fetchAs = (company: CompanyOpened, person: string, into: string[] | null): typeof fetch => async (input, init) => {
  const url = urlOf(input);
  if (onThisMachine(url)) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  const named = url.startsWith('/') ? pageRouteOf(method, url, company.fields.record) : `${method} ${url} (not the service)`;
  if (into === null) page.late.push(`route ${named}`); else into.push(named);
  if (!url.startsWith('/')) throw new TypeError(`the page fetched ${url}, which is not the company's service`);
  page.inFlight += 1;
  try {
    const r = await company.call(person)(method, url, init?.body === undefined || init.body === null ? undefined : String(init.body));
    return new Response(NO_BODY.has(r.status) ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  } finally {
    page.inFlight -= 1;
  }
};
/** Refuses, naming each, any read of the page that started after its opening was counted, since the last call. */
const refuseLateReads = (): void => {
  harness().refuseLateDoorAsks();
  const late = page.late.splice(0);
  if (late.length > 0) throw new Error(`a read started after its opening was counted, so it is in no count: ${late.join(', ')}`);
};

/* Each person's page keeps what it has checked in its own browser storage, kept between openings. */
const pageStorage = new Map<string, IDBFactory>();
const onItsOwnDevice = (person: string): void => {
  if (!pageStorage.has(person)) pageStorage.set(person, new IDBFactory());
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = pageStorage.get(person);
};

/* The page signed in as `person`, holding what their wallet read from the keys it keeps for the company. */
const signedInAs = (company: CompanyOpened, person: string): void => {
  const { kept } = company.wallet(person);
  signedInByAnotherScreen({ user: { id: person, name: person, email: null }, address: `addr_${person}` });
  takeTheRead({
    seats: seatsOf(kept), viewing: { [company.fields.record]: company.companyKey }, metadata: metadataOf(kept) as never, holder: person, resealed: null,
  }, true, 1);
};

const sessionOf = (company: CompanyOpened, person: string) => ({
  person: { id: person, name: person }, companies: [{ id: company.fields.record, createdAt: '2026-10-01T00:00:00.000Z', signers: company.seats().length }],
  company: company.fields.record, chooseCompany: () => {}, viewer: { signedIn: true, view: VIEWS.company, signs: true }, chooseView: () => {},
  preferences: DEFAULT_PREFERENCES, choose: () => {}, signOut: () => {}, mac: true, companiesChanged: async () => {},
});

/* Draws the page at its own address in the frame, and waits until its screen is drawn with nothing still being read. */
const frameAround = (company: CompanyOpened, person: string, id: PageId, body: ReactElement): ReactElement =>
  createElement(KitProvider, { languages: LANGUAGES, pick: 'en' },
    createElement(SessionProvider, { session: sessionOf(company, person) as never }, createElement(Shell, { current: id }, body)));
const drawn = async (company: CompanyOpened, person: string, id: PageId, params: Record<string, string>, limitMs: number): Promise<HTMLElement> => {
  window.history.replaceState(null, '', addressOf(id, params));
  const view = render(frameAround(company, person, id, createElement(PageView, { id, params })));
  return untilPageShown(view.container, limitMs);
};

/*
 * An opening is counted until its reads go quiet, not only until a screen is drawn: a page inside the settings draws
 * the settings' own screen first and its page, with its reads, after it. Quiet is no read of the service, the wallet or any
 * door in flight, and none started for QUIET_MS; an opening that is not quiet by OPENING_MS fails, never counted as it stands.
 */
const QUIET_MS = 800;
const readsStarted = (routes: readonly string[], asked: readonly string[]): number => routes.length + asked.length + harness().doorsAsked();
const readsInFlight = (): number => page.inFlight + harness().doorsInFlight();
const quietened = async (routes: readonly string[], asked: readonly string[], limitMs: number): Promise<void> => {
  const end = Date.now() + limitMs;
  let seen = readsStarted(routes, asked);
  let since = Date.now();
  while (readsInFlight() > 0 || Date.now() - since < QUIET_MS) {
    if (Date.now() >= end) throw new Error(`the opening's reads were not quiet after ${limitMs} ms (${readsInFlight()} in flight), so its count is not whole`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    if (readsStarted(routes, asked) !== seen) { seen = readsStarted(routes, asked); since = Date.now(); }
  }
};

/* After an opening the page is taken down, but its fetch stays one that keeps what it is asked, so a late read is found. */
const afterAnOpening = (company: CompanyOpened, person: string): typeof fetch => fetchAs(company, person, null);

/**
 * Opens the screen at page `id` as `by`'s page, signed in and holding their seat's keys, and counts what that one
 * opening read, until the screen is drawn with nothing still being read. The screen is taken down after. An opening that is not
 * drawn and quiet within `limitMs` fails.
 */
export async function openScreen(company: CompanyOpened, by: string, id: PageId, params: Record<string, string> = {}, limitMs = OPENING_MS): Promise<ScreenCount> {
  const routes: string[] = [];
  const asked: string[] = [];
  refuseLateReads();
  onItsOwnDevice(by);
  signedInAs(company, by);
  globalThis.fetch = fetchAs(company, by, routes);
  page.asked = asked;
  try {
    const { value: screen, doors } = await harness().doorsCountedWhile(company, by, async () => {
      await drawn(company, by, id, params, limitMs);
      await quietened(routes, asked, limitMs);
      return untilPageShown(document.body, limitMs);
    });
    return {
      screen: screen.getAttribute('data-screen') ?? '', text: screen.textContent ?? '', routes: tallied(routes), wallet: tallied(asked),
      doors: byDoor(doors), asks: tallied(doors.map((d) => `${d.door} ${d.ask}`)),
    };
  } finally {
    page.asked = null;
    globalThis.fetch = afterAnOpening(company, by);
    cleanup();
  }
}

/**
 * Opens an action panel as `by`'s page, drawn in the shell's frame on the People page's address, and counts what that one
 * opening read, until nothing is still being read. The panel is taken down after. Its `text` is what the panel showed.
 */
export async function openPanel(company: CompanyOpened, by: string, panel: ReactElement, limitMs = OPENING_MS): Promise<ScreenCount> {
  const routes: string[] = [];
  const asked: string[] = [];
  refuseLateReads();
  onItsOwnDevice(by);
  signedInAs(company, by);
  globalThis.fetch = fetchAs(company, by, routes);
  page.asked = asked;
  try {
    const { value: text, doors } = await harness().doorsCountedWhile(company, by, async () => {
      window.history.replaceState(null, '', addressOf('people', {}));
      render(frameAround(company, by, 'people', panel));
      await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
      await quietened(routes, asked, limitMs);
      return document.body.textContent ?? '';
    });
    return { screen: 'panel', text, routes: tallied(routes), wallet: tallied(asked), doors: byDoor(doors), asks: tallied(doors.map((d) => `${d.door} ${d.ask}`)) };
  } finally {
    page.asked = null;
    globalThis.fetch = afterAnOpening(company, by);
    cleanup();
  }
}
