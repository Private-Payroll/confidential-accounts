/*
 * A screen of the page opened against the company the wallet's harness makes, with each read it makes counted. The
 * service is the company's own routes in memory, reached through the page's own transport; the builder is the
 * company's builder double; the person's wallet answers who holds the account from the company's chain double. One
 * opening of one screen is counted: every call to the service by route, every ask of the wallet by what it asks, and
 * every chain, builder and indexer read by the door it came through. Every call the service answered is also logged with the
 * records its answer carried, and what the actions a press ran in the wallet called is logged with it.
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
import { routeOf, type IntentShape, PROGRESS_SCHEMA } from 'midnight-identity/profile/request';
import { ACT_ENDED_SCHEMA, readOutcome } from 'midnight-identity/profile/channel';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { metadataOf, seatsOf, type Keyring } from 'vaults-web-shared/keyring-blob.js';
import { signedInByAnotherScreen, takeTheRead } from 'vaults-web-shared/keyring.js';
import type { HoldersRead } from 'vaults-web-shared/wallet-records-key.js';
import { ACT_INTENTS } from '../../../../packages/identity/src/profile/act-intents.js';
import { ENGLISH } from '../english.test-support.js';
import { untilPageShown } from '../page-shown.test-support.js';
import { calledAs, type Called } from './screen-carried.test-support.js';

/** The door a chain, builder or indexer read came through, as the wallet's harness names it. */
export type Door = 'holders' | 'onChain' | 'builder' | 'indexer';

/**
 * How many of each kind of record the company holds, as the wallet's harness takes it and grows it: its runs, the runs
 * paid, its open one-off payments and its spending policies are passed through to the wallet's harness as they are.
 */
export interface CompanySize {
  readonly people: number;
  readonly vendors?: number;
  readonly vaults?: number;
  readonly proposals?: number;
  readonly runs?: number;
  readonly payments?: number;
  readonly oneOffs?: number;
  readonly policies?: number;
  readonly seats?: number;
  readonly anchoredBatches?: number;
}
/** What a company holds of each kind its pages read more of as it grows. */
export type CompanyHeld = Readonly<Record<'people' | 'vendors' | 'vaults' | 'proposals' | 'open proposals' | 'policies', number>>;
/** The company a screen is opened on, as the wallet's harness makes it: what the counting here reads of it. */
export interface CompanyOpened {
  readonly wallet: (person: string) => {
    readonly kept: Keyring; readonly identity: unknown; readonly secret: unknown;
    /** What the wallet holds of each company it knows, by company: where it came from and whether it created it. */
    readonly pins: Map<string, unknown>;
  };
  readonly seats: () => readonly { readonly person: string }[];
  readonly vaults: () => readonly string[];
  readonly fields: { readonly record: string; readonly company: string; readonly account: string };
  readonly companyKey: string;
  readonly call: (person: string) => (method: string, path: string, body?: string) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly served: () => number;
  readonly openProposals: () => number;
  readonly growTo: (size: CompanySize) => Promise<void>;
  /** What the company holds now of each kind its pages read more of as it grows, as the service and the chain hold it. */
  readonly held: () => CompanyHeld;
  /** Files one more payee, invited and accepted with their own wallet's code, waiting for a seat to admit them. */
  readonly payeeWaiting: () => Promise<{ readonly id: string; readonly name: string; readonly fingerprint: string }>;
}
/* The chain as the person's wallet reads it to answer the page. */
interface WalletReads {
  readonly holders: () => Promise<unknown>;
  readonly roles: (account: unknown, label: unknown, keys: readonly string[]) => Promise<unknown>;
  readonly indexer: HoldersRead['indexer'];
}
/** What an action run by the wallet's steps read, step by step, as the wallet's harness counts it, and every call it made. */
interface IntentRan {
  readonly steps: readonly {
    readonly routes: Readonly<Record<string, number>>; readonly doors: Readonly<Record<Door, number>>; readonly asks: Readonly<Record<string, number>>;
  }[];
  readonly log: readonly Called[];
  /** What the action told the page when it ended. */
  readonly told?: Readonly<Record<string, string | number>>;
}
/** The window being counted: its company and person, what the actions the page pressed ran, and the counting resumed after each, ended with the window. */
interface ActingNow {
  readonly company: CompanyOpened;
  readonly by: string;
  readonly ran: IntentRan[];
  /** The actions the wallet's steps could not run, with why. */
  readonly refused: string[];
  readonly resumed: Promise<{ readonly doors: readonly { readonly door: Door; readonly ask: string }[] }>[];
  readonly windowEnds: Promise<void>;
}
interface WalletHarness {
  readonly runIntent: (name: string, intent: unknown, company: CompanyOpened, by: string) => Promise<IntentRan>;
  readonly aCompanyOf: (size: CompanySize, served: { readonly vaultRows: boolean }) => CompanyOpened;
  readonly doorsCountedWhile: <T>(company: CompanyOpened, by: string, open: () => Promise<T>) => Promise<{
    readonly value: T; readonly doors: readonly { readonly door: Door; readonly ask: string }[];
  }>;
  readonly doorsAsked: () => number;
  readonly doorsInFlight: () => number;
  readonly refuseLateDoorAsks: () => void;
  readonly companyDoors: () => { readonly builder: unknown; readonly walletReads: WalletReads };
}

/* The page is built for an account service, as it is when it is served: a press that asks the wallet to act is not refused as not set up. */
/*
 * The page's wallet origin, and the byte types a jsdom test shares with the code under it. In a jsdom test the global `Uint8Array` and
 * `ArrayBuffer` are the ones jsdom makes, while the bytes the wallet's libraries build (from node's `Buffer` and from their own code)
 * are node's, so a library that asks `instanceof Uint8Array` of them refuses them with "Uint8Array expected" and no address is made.
 * Node's two byte types are put back as the global ones, together, since a library that checks a byte array's buffer against
 * `ArrayBuffer` refuses a pair from two realms as well. Before any import, so every module sees the same two.
 */
vi.hoisted(() => {
  vi.stubEnv('VITE_WALLET_ORIGIN', 'http://wallet.localhost:5180');
  globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
  globalThis.ArrayBuffer = Buffer.alloc(0).buffer.constructor as ArrayBufferConstructor;
});

const PAY_KEY_COMMITTED = 'a1'.repeat(32);
/** What the wallet double signs a change of the committee with: a signature in the shape the service keeps, not one the chain would take. */
const SIGNATURE = '5e'.repeat(64);
/** What the page asks the wallet to sign for a change of the committee. */
interface CommitteeSigned {
  readonly contracts: readonly { readonly address: string; readonly counter: string; readonly now: { readonly committee: readonly { readonly value: string }[] } }[];
}
/* The payment the wallet says the account holds and the open payment window it says it holds, where the pay key is committed. */
const PAYMENT_HELD = 'c3'.repeat(32);
const ROUND_OPEN = 'd4'.repeat(32);
/** Public money a vault holds where a stand-in says it holds some: one token, one amount. */
const PUBLIC_MONEY = [{ token: 'b2'.repeat(32), amount: '1000' }];

/**
 * What the stand-ins answer, which a test turns to have a page take another branch of what it reads. Each is put back to the usual
 * after every test of the file that made the company.
 */
export interface Served {
  /** Which of the company's vaults hold public money: none of them (the usual), or its second only. */
  readonly publicMoney: 'none' | 'second';
  /** Whether the company's pay key is committed on its account, with a payment held and a payment window open (the usual), or not committed, with none of either. */
  readonly payKey: 'committed' | 'not-committed';
  /** Whether the company's account is held by its committee (the usual), or the service says a change of the committee is owed. */
  readonly committee: 'held' | 'change-owed';
}
const USUAL: Served = { publicMoney: 'none', payKey: 'committed', committee: 'held' };
/** Every answer each stand-in can be turned to, the usual one first: a page is counted under each of the others. */
export const SERVED_CHOICES: { readonly [K in keyof Served]: readonly Served[K][] } = {
  publicMoney: ['none', 'second'], payKey: ['committed', 'not-committed'], committee: ['held', 'change-owed'],
};

/* The page's builder is the company's, and the person's wallet answers from the company's chain; every other ask of the wallet is counted and refused. */
const page = vi.hoisted(() => ({
  asked: null as string[] | null, late: [] as string[], inFlight: 0, harness: null as WalletHarness | null,
  /* The company the file made, and what the stand-ins answer of it now. */
  company: null as CompanyOpened | null, served: {} as { -readonly [K in keyof Served]: Served[K] },
  /* The company whose key the person's wallet has released to this tab, and that key. */
  keyed: null as { readonly record: string; readonly key: string; readonly committeeKey: { readonly tag: string; readonly value: string } } | null,
  /* The window being counted: what the page's presses in the wallet ran, and the counting that resumes after each. */
  acting: null as ActingNow | null,
  /* What happens before the page's next call to a route: once, for a test that has something happen between two reads of the page. */
  before: [] as { readonly method: string; readonly path: string; readonly run: () => Promise<void>; readonly bodyHas: string }[],
}));
Object.assign(page.served, USUAL);
/* An ask of the wallet lands in the opening being counted, or, with none open, in the reads to be refused. */
const walletAsked = (what: string): void => { if (page.asked !== null) page.asked.push(what); else page.late.push(`wallet ${what}`); };
const harness = (): WalletHarness => page.harness!;
/* Whether a vault holds public money, as `page.served` says: a vault the company does not hold holds none. */
const holdsPublicMoney = (vault: unknown): boolean => {
  const own = (page.company?.vaults() ?? []).map((v) => v.toLowerCase());
  const id = String(vault).toLowerCase();
  return page.served.publicMoney === 'second' && own[1] === id;
};
/* A vault as the chain answers is read for its public money too, as the stand-in says, whatever the chain double lists for it: so a page counts the branch it is asked for. */
const withPublicMoney = <T extends object>(vault: T, id: unknown): T => ({ ...vault, publicBalances: holdsPublicMoney(id) ? PUBLIC_MONEY : [] });
type Ask = (...a: unknown[]) => Promise<unknown>;
/* One answering builder for each builder, so what the page keeps against the builder it was handed is kept against the same one at each ask. */
const answering = new WeakMap<object, unknown>();
const publicMoneyAnswered = (builder: unknown): unknown => {
  const own = builder as { readonly vaultOnChain: Ask; readonly vaultsOnChain: Ask };
  if (!answering.has(own)) {
    answering.set(own, Object.create(own, {
      vaultOnChain: { value: async (...a: unknown[]) => withPublicMoney(await own.vaultOnChain(...a) as object, (a[0] as { vault?: unknown })?.vault) },
      vaultsOnChain: {
        value: async (...a: unknown[]) => {
          const ids = (a[0] as { vaults?: readonly unknown[] })?.vaults ?? [];
          return (await own.vaultsOnChain(...a) as object[]).map((v, i) => withPublicMoney(v, ids[i]));
        },
      },
    }));
  }
  return answering.get(own);
};
vi.mock('../adapters/vault-builder.js', async (real) => ({
  ...(await real<typeof import('../adapters/vault-builder.js')>()),
  theVaultBuilder: async () => publicMoneyAnswered(harness().companyDoors().builder),
}));
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  /* The person's wallet signs a change of the committee with the key it gives for the company, one signature for each contract it holds a seat on. */
  signCommitteeChangeFromTheWallet: async (_origin: string, ask: CommitteeSigned) => {
    walletAsked('sign-committee-change');
    const signer = page.keyed!.committeeKey;
    const seatOn = (c: CommitteeSigned['contracts'][number]): number => c.now.committee.findIndex((k) => k.value.toLowerCase() === signer.value.toLowerCase());
    return {
      signer,
      signatures: ask.contracts.filter((c) => seatOn(c) >= 0).map((c) => ({ address: c.address, counter: c.counter, seat: seatOn(c), signature: { tag: 'schnorr', value: SIGNATURE } })),
    };
  },
  holdersFromTheWallet: async (_origin: string, ask: { readonly roles?: readonly string[]; readonly movements?: readonly string[] }): Promise<HoldersRead> => {
    walletAsked('holders');
    page.inFlight += 1;
    try {
      const chain = harness().companyDoors().walletReads;
      const holders = await chain.holders() as HoldersRead['holders'];
      const roles = ask.roles === undefined ? {} : { roles: await chain.roles(null, null, ask.roles) as HoldersRead['roles'] };
      /* The chain double holds no record of payments, so a wallet asked about it says what `page.served` says of the pay key. */
      const committed = page.served.payKey === 'committed';
      const payments = ask.movements === undefined ? {} : {
        payments: committed
          ? { payKeyCommitment: PAY_KEY_COMMITTED, held: [PAYMENT_HELD], openRounds: [ROUND_OPEN], entries: 1 }
          : { payKeyCommitment: null, held: [], openRounds: [], entries: 0 },
      };
      return { holders, indexer: chain.indexer, ...roles, ...payments } as HoldersRead;
    } finally {
      page.inFlight -= 1;
    }
  },
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  companyKeyReleasedFor: (record: string) => (page.keyed?.record === record ? page.keyed.key : null),
  committeeKeyReleasedFor: (record: string) => (page.keyed?.record === record ? page.keyed.committeeKey : null),
  /* The keys the person's wallet released to this tab for the company: its key and the key the person sits on its committee with. */
  companyKeysForVaults: async (record: string) => {
    if (page.keyed?.record !== record || page.company === null) throw new Error('the wallet released no keys for this company');
    return { companyKey: page.keyed.key, committeeKey: page.keyed.committeeKey, company: page.company.fields.company, account: page.company.fields.account };
  },
}));
/*
 * A press that asks the wallet to act reaches the page's own wallet protocol (`actInTheWallet`, which builds the ask and reads the
 * wallet's answer), and the window the wallet answers in is stood in here: the wallet's own steps are run over the company as the person's
 * wallet runs them, each step is reported as the wallet reports its progress, and the wallet's ending is sent as the wallet sends it
 * (what the action told, passed through the wallet's own filter), for the page to read as it reads any. An action the wallet's steps
 * refuse stops the test.
 */
type ActAsk = { readonly nonce: string; readonly intent: { readonly name: string } & Readonly<Record<string, string>> };
const answerAct = async (message: ActAsk, hears: ((body: Readonly<Record<string, unknown>>) => void) | undefined): Promise<unknown> => {
  const { name, ...fields } = message.intent;
  const acting = page.acting;
  if (acting === null) {
    page.late.push(`wallet act ${name}`);
    throw new Error(`the page asked the wallet to act (${name}) with no opening being counted`);
  }
  walletAsked(`act ${name}`);
  page.inFlight += 1;
  try {
    const ran = await harness().runIntent(name, { name, fields }, acting.company, acting.by);
    acting.ran.push(ran);
    acting.resumed.push(harness().doorsCountedWhile(acting.company, acting.by, () => acting.windowEnds));
    const steps = ran.steps.length;
    for (let step = 1; step <= steps; step += 1) hears?.({ schema: PROGRESS_SCHEMA, stage: 'proving', step, steps });
    const told = ran.told ?? {};
    const outcome = Object.keys(told).length === 0 ? undefined : readOutcome({ ...told }, name);
    return {
      schema: ACT_ENDED_SCHEMA, nonce: message.nonce, intent: name, ended: 'done', step: steps, steps, relayed: 0, unconfirmed: 0,
      ...(outcome === undefined || outcome === null ? {} : { outcome }),
    };
  } catch (e) {
    acting.refused.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    page.inFlight -= 1;
  }
};
vi.mock('vaults-web-shared/wallet-sign-in.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-sign-in.js')>()),
  askWallet: async (_view: unknown, _origin: string, message: { readonly kind?: string }, _dialog: unknown, hears?: (body: Readonly<Record<string, unknown>>) => void) => {
    if (message.kind === 'act') return answerAct(message as unknown as ActAsk, hears);
    walletAsked(String(message.kind));
    throw new Error(`the page asked the wallet for ${String(message.kind)}, which a screen's opening here is not answered`);
  },
}));

/* The wallet's harness, named by a path the page's typecheck does not follow: the wallet's code is typed under its own config. */
const WALLET_HARNESS = '../../../wallet/src/actions/company-harness.test-support.js';
page.harness = await import(/* @vite-ignore */ WALLET_HARNESS) as WalletHarness;
const WALLET_REACH = '../../../wallet/src/actions/company-reach.js';
const { companyKeyOf } = await import(/* @vite-ignore */ WALLET_REACH) as {
  readonly companyKeyOf: (ctx: { readonly held: { readonly identity: unknown; readonly secret: unknown }; readonly asker: unknown }, label: string, account: string) => string;
};
/* The asker the key is released to: the key is the person's own for the company, whoever asks. */
const ASKER = { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' };

/**
 * Makes the company of the wallet's harness and seeds it to `size` before the file's tests run. Call it where the
 * file's tests are declared, once.
 */
export const aCompanyOf = (size: CompanySize): CompanyOpened => {
  const company = harness().aCompanyOf(size, { vaultRows: true });
  page.company = company;
  /* What a test turned the stand-ins to answer is put back, and a read that started after the last opening of a test was counted fails that test, not only the next opening. */
  afterEach(() => { Object.assign(page.served, USUAL); refuseLateReads(); });
  return company;
};

/** A payee invited, accepted with their own wallet's code and admitted by `by`'s wallet, as the people a run pays are before it is raised for them. */
export const payeeAdmittedBy = async (company: CompanyOpened, by: string): Promise<void> => {
  const payee = await company.payeeWaiting();
  const fields = { ...company.fields, kind: 'employee', person: payee.id, personName: payee.name, fingerprint: payee.fingerprint };
  await harness().runIntent('admit-person', { name: 'admit-person', fields }, company, by);
};

/** Has the stand-ins answer as `over` says until the end of the test, for a page to take the branch of what it reads that the answer opens. */
export const servedAs = (over: Partial<Served>): void => { Object.assign(page.served, over); };

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

/** What one opening of a screen read: its service calls by route, its wallet asks, and its door reads by door and by ask, and each service call as it was answered. */
export interface ScreenCount {
  readonly screen: string;
  /** The words the screen showed once it was drawn, so a count is known to be of a screen that read its records. */
  readonly text: string;
  readonly routes: Readonly<Record<string, number>>;
  readonly wallet: Readonly<Record<string, number>>;
  readonly doors: Readonly<Record<Door, number>>;
  readonly asks: Readonly<Record<string, number>>;
  /** Every call the opening made to the service, as it was answered, with the records each answer carried. */
  readonly calls: readonly Called[];
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
/*
 * What the company's in-memory service does not serve, answered as the service answers it for a company that is finished
 * being created and whose rules its super admins hold, or, with `page.served`, whose committee has a change owed: the person's saved
 * keys (the wallet's to open, so none are handed in: the wallet's steps are run over the company directly), the company's creation,
 * who holds its rules, the change of the committee owed, and what the service keeps of a signature on it.
 */
type Answered = { readonly status: number; readonly body: unknown } | null;
/*
 * A change of the committee owed, as the service serves it: one contract of the company's account, held by two keys of which the
 * person's is one and the other another's, none signed yet, to be held by the committee the chain shows holding the account.
 */
const changeOwedOf = async (company: CompanyOpened): Promise<unknown> => {
  const held = await harness().companyDoors().walletReads.holders() as { readonly committee: readonly { readonly tag: string; readonly value: string }[]; readonly threshold: number };
  const mine = page.keyed!.committeeKey;
  const other = { tag: mine.tag, value: 'ab'.repeat(32) };
  return {
    company: company.fields.account, label: company.fields.company, to: { committee: held.committee, threshold: held.threshold }, why: null,
    contracts: [{ contract: 'account', address: company.fields.account, counter: '1', now: { committee: [mine, other], threshold: 2 }, signedIndexes: [], required: 2 }],
    notChangeable: [],
  };
};
const answeredHere = async (company: CompanyOpened, method: string, url: string): Promise<Answered> => {
  const own = `/api/accounts/${company.fields.record}`;
  if (method === 'POST' && url === `${own}/committee-change/signatures`) {
    return { status: 200, body: { results: [{ address: company.fields.account, state: 'kept', have: 1, required: 2 }] } };
  }
  if (method !== 'GET') return null;
  if (url === '/api/me/keys') return { status: 200, body: { keyBundle: null, version: 0 } };
  if (url === `${own}/creation`) return { status: 200, body: { state: 'finished', account: company.fields.account } };
  if (url === `${own}/authority`) {
    return {
      status: 200,
      body: { company: { address: company.fields.account }, committee: {}, contracts: [{ read: 'read', heldByTheCompany: true }], change: { possible: page.served.committee === 'change-owed' } },
    };
  }
  if (url === `${own}/committee-change` && page.served.committee === 'change-owed') return { status: 200, body: await changeOwedOf(company) };
  return null;
};
const NO_BODY = new Set([204, 205, 304]);
const fetchAs = (company: CompanyOpened, person: string, into: string[] | null, calls: Called[] | null): typeof fetch => async (input, init) => {
  const url = urlOf(input);
  if (onThisMachine(url)) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  const named = url.startsWith('/') ? pageRouteOf(method, url, company.fields.record) : `${method} ${url} (not the service)`;
  if (into === null) page.late.push(`route ${named}`); else into.push(named);
  if (!url.startsWith('/')) throw new TypeError(`the page fetched ${url}, which is not the company's service`);
  page.inFlight += 1;
  try {
    const sent = init?.body === undefined || init.body === null ? '' : String(init.body);
    const hook = page.before.findIndex((b) => b.method === method && b.path === url.split('?')[0] && sent.includes(b.bodyHas));
    if (hook >= 0) await page.before.splice(hook, 1)[0]!.run();
    const body = sent === '' ? undefined : sent;
    const stoodIn = await answeredHere(company, method, url);
    const r = stoodIn ?? await company.call(person)(method, url, body);
    /* What the service itself answered is logged with the records it carried; an answer the harness stands in for is the harness's. */
    if (stoodIn === null && calls !== null) calls.push(await calledAs(named, method, url, body, r));
    return new Response(NO_BODY.has(r.status) ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  } finally {
    page.inFlight -= 1;
  }
};
/**
 * Has `run` happen once, just before the page's next call of `method` to `path` (its body holding `bodyHas`) is answered, for a test that has another seat
 * enter a record between two reads of one opening. A hook the opening never reached is dropped when the opening ends.
 */
export const beforeTheCall = (method: string, path: string, run: () => Promise<void>, bodyHas = ''): void => { page.before.push({ method, path, run, bodyHas }); };

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
  const { identity, secret } = company.wallet(person);
  page.keyed = {
    record: company.fields.record, key: companyKeyOf({ held: { identity, secret }, asker: ASKER }, company.fields.company, company.fields.account),
    committeeKey: committeeKeyFor(identity as never, company.fields.company as never) as { tag: string; value: string },
  };
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
const afterAnOpening = (company: CompanyOpened, person: string): typeof fetch => fetchAs(company, person, null, null);

/** What one window of counting read, before it is named: the page's own calls, asks and door reads, and each action the page's press ran in the wallet. */
interface Window<T> {
  readonly value: T;
  readonly routes: readonly string[];
  readonly asked: readonly string[];
  readonly calls: readonly Called[];
  readonly doors: readonly { readonly door: Door; readonly ask: string }[];
  readonly ran: readonly IntentRan[];
}

/*
 * Runs `work` as `by`'s page and counts everything it reads until its reads go quiet. An action the page presses in the wallet
 * is run by the wallet's own steps (`answerPress`) and its reads are counted beside the page's; the page's reads after the
 * wallet answered are counted in the same window.
 */
async function inAWindow<T>(company: CompanyOpened, by: string, limitMs: number, work: () => Promise<T>): Promise<Window<T>> {
  const routes: string[] = [];
  const asked: string[] = [];
  const calls: Called[] = [];
  let end = (): void => {};
  const acting: ActingNow = { company, by, ran: [], refused: [], resumed: [], windowEnds: new Promise<void>((resolve) => { end = resolve; }) };
  refuseLateReads();
  globalThis.fetch = fetchAs(company, by, routes, calls);
  page.asked = asked;
  page.acting = acting;
  try {
    const { value, doors } = await harness().doorsCountedWhile(company, by, async () => {
      const done = await work();
      await quietened(routes, asked, limitMs);
      end();
      return done;
    });
    const resumed = (await Promise.all(acting.resumed)).flatMap((r) => r.doors);
    if (acting.refused.length > 0) throw new Error(`the wallet's steps could not run what the page pressed, so it is in no count: ${acting.refused.join('; ')}`);
    return { value, routes, asked, calls, doors: [...doors, ...resumed], ran: acting.ran };
  } finally {
    page.asked = null;
    page.acting = null;
    globalThis.fetch = afterAnOpening(company, by);
  }
}

/* What an action the page pressed read in the wallet, added to what the page itself read in the same window. */
const countOf = (screen: string, text: string, w: Window<unknown>): ScreenCount => {
  const routes = tallied(w.routes);
  const asks = tallied(w.doors.map((d) => `${d.door} ${d.ask}`));
  const doors = byDoor(w.doors);
  for (const step of w.ran.flatMap((r) => r.steps)) {
    for (const [route, n] of Object.entries(step.routes)) routes[route] = (routes[route] ?? 0) + n;
    for (const [ask, n] of Object.entries(step.asks)) asks[ask] = (asks[ask] ?? 0) + n;
    for (const door of Object.keys(doors) as Door[]) doors[door] += step.doors[door];
  }
  return { screen, text, routes, wallet: tallied(w.asked), doors, asks, calls: [...w.calls, ...w.ran.flatMap((r) => r.log)] };
};

/** The page signed in as `by` on its own device, ready to be drawn. */
const signedInOnItsDevice = (company: CompanyOpened, by: string): void => {
  refuseLateReads();
  onItsOwnDevice(by);
  signedInAs(company, by);
};

/**
 * Opens the screen at page `id` as `by`'s page, signed in and holding their seat's keys, and counts what that one
 * opening read, until the screen is drawn with nothing still being read. The screen is taken down after. An opening that is not
 * drawn and quiet within `limitMs` fails.
 */
export async function openScreen(company: CompanyOpened, by: string, id: PageId, params: Record<string, string> = {}, limitMs = OPENING_MS): Promise<ScreenCount> {
  return (await openScreenAnd(company, by, id, params, [], limitMs))[0]!;
}

/** What a person does on a screen that is drawn: a press, or a number of them, waiting for what each shows; it may hand back how to read the words it waited for, which are the step's text once its reads are quiet. */
export type Step = (screen: HTMLElement) => Promise<(() => string) | void>;

/**
 * Opens the screen at page `id` as `by`'s page, then takes each of `steps` on it in turn, and counts each apart until its reads go
 * quiet: the opening first, then one count for each step. A press that asks the wallet to act is answered by the wallet's own
 * steps run over the company, and what they read is part of that step's count. The screen is taken down after.
 */
export async function openScreenAnd(
  company: CompanyOpened, by: string, id: PageId, params: Record<string, string>, steps: readonly Step[], limitMs = OPENING_MS,
): Promise<ScreenCount[]> {
  signedInOnItsDevice(company, by);
  try {
    const opening = await inAWindow(company, by, limitMs, async () => { await drawn(company, by, id, params, limitMs); });
    const shown = await untilPageShown(document.body, limitMs);
    const counts = [countOf(shown.getAttribute('data-screen') ?? '', shown.textContent ?? '', opening)];
    for (const step of steps) {
      const taken = await inAWindow(company, by, limitMs, async () => {
        return step(shown);
      });
      counts.push(countOf('step', taken.value?.() ?? document.body.textContent ?? '', taken));
    }
    return counts;
  } finally {
    page.before.length = 0;
    cleanup();
  }
}

/**
 * Opens an action panel as `by`'s page, drawn in the shell's frame on the People page's address, and counts what that one
 * opening read, until nothing is still being read. The panel is taken down after. Its `text` is what the panel showed.
 */
export async function openPanel(company: CompanyOpened, by: string, panel: ReactElement, limitMs = OPENING_MS): Promise<ScreenCount> {
  signedInOnItsDevice(company, by);
  try {
    const w = await inAWindow(company, by, limitMs, async () => {
      window.history.replaceState(null, '', addressOf('people', {}));
      render(frameAround(company, by, 'people', panel));
      await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    });
    return countOf('panel', document.body.textContent ?? '', w);
  } finally {
    page.before.length = 0;
    cleanup();
  }
}
