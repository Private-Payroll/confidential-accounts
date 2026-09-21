import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask, KeyringRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { keyringKeyFor, keyringReleaseFor, unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { Openable } from '../web/wallet-sign-in.js';
import type { Sealed } from './crypto.js';
import { fromHex, seal, toHex, unseal, unwrapKey, wrapKey } from './crypto.js';
import { x25519 } from '@noble/curves/ed25519.js';

/**
 * **THE WINDOW `inABrowser` INSTALLED, HANDED IN BY NAME.** The product now shows
 * the wallet inside the page by default, and a journey with no frame on the page
 * refuses to open one. These cases model a wallet at the other end of a window
 * and install it as `window`, so they pass that window explicitly rather than
 * relying on a default that no longer reaches it.
 */
const thisBrowsersWindow = () => (globalThis as { window?: unknown }).window as never;


/** The public half of a wrapping secret, as `newWrappingKeypair` computes it. */
const x25519PublicOf = (secret: string) => toHex(x25519.getPublicKey(fromHex(secret)));

/**
 * **SOMEBODY WITH A WALLET STARTS A COMPANY - AND THEN ANOTHER.**
 *
 * ── WHAT IS BEING PROVED, AND WHY IT IS PROVED BY WATCHING ────────────────
 *
 * Starting a company is an ORDER OF OPERATIONS, and an order is a property of a
 * journey rather than of any one function. So the whole journey runs here
 * against a recording transport and a real wallet at the other end of a real
 * channel: every URL, method and body this tab sends is kept, every question the
 * wallet is asked is kept, and the assertions are about what happened, in what
 * order, and what never happened at all.
 *
 * The order is: **open the keys saved for this person** (one question to the
 * wallet, for the key it derives for this person on this site), **create the
 * company**, **save its keys beside everything already saved**, under that same
 * key. A person's saved keys belong to the person and not to any one company, so
 * a second company's keys are saved beside the first's - and nothing about
 * saving them waits on a company's address.
 *
 * **THE WALLET SIDE IS THE WALLET'S OWN CODE.** `identityFromWords`, `parseAsk`,
 * `keyringReleaseFor` and `keyringKeyFor` ship from `midnight-identity`, resolved
 * through its `exports`. Nothing here is a fixture shaped like a key, and the key
 * a bundle is checked against is derived here independently of the tab.
 *
 * ── AND THE SECOND DEVICE IS A SECOND DEVICE ──────────────────────────────
 *
 * `§4` rebuilds a wallet from the same words, at a DIFFERENT HOST, with nothing
 * carried over but the bundle the server holds - and opens what the first
 * device saved.
 */

const US = 'https://payroll.example';
const ELSEWHERE = 'https://payroll.self-hosted.example';
const WALLET = 'https://wallet.example';

/** A company address, in the spelling the chain's own serialisation produces. */
const DEPLOYED = 'a1'.repeat(32);

/** The site's identifier for the person who signs in, whichever device they use. */
const PERSON = 'usr_founder';

/**
 * **EACH SET OF WORDS HAS ITS OWN ADDRESS.** A wallet holds an address only when
 * it is the one that wallet signed in with, and the stub server's sign-in answer
 * names the address the answering wallet gave - in the shape the wallet's own
 * parser accepts.
 */
const FOUNDER_WORDS = TEST_MNEMONIC;
const FOUNDER_ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const SOMEBODY_ELSE_WORDS = newWords();
const SOMEBODY_ELSE_ADDRESS = 'mn_addr_test1pppppppppppppppppppp';

const ACCOUNT_ID = 'acc_founded';
const SECOND_ID = 'acc_second';
/** A company whose keys another device saved while this tab was busy. */
const OTHER_DEVICE_ID = 'acc_saved_elsewhere';

const FIRST_SECRETS = {
  signerId: 'sgn_founder',
  name: 'Ada',
  signingSecret: 'aa'.repeat(32),
  wrappingSecret: 'bb'.repeat(32),
  blinding: 'cc'.repeat(32),
  /* As the service answers: every seat's secrets carry the scope it was seated under. */
  scope: 'dd'.repeat(32),
};
const SECOND_SECRETS = {
  signerId: 'sgn_second',
  name: 'Ada',
  signingSecret: 'a2'.repeat(32),
  wrappingSecret: 'b2'.repeat(32),
  blinding: 'c2'.repeat(32),
  scope: 'd2'.repeat(32),
};
const OTHER_DEVICE_KEYS = {
  signerId: 'sgn_elsewhere',
  signingSecret: 'a3'.repeat(32),
  wrappingSecret: 'b3'.repeat(32),
  blinding: 'c3'.repeat(32),
  scope: 'd3'.repeat(32),
};

const NORTHWIND = { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' as const }], threshold: 1 };
const SOUTHWIND = { name: 'Southwind', signers: [{ name: 'Ada', role: 'admin' as const }], threshold: 1 };
const WESTWIND = { name: 'Westwind', signers: [{ name: 'Ada', role: 'admin' as const }], threshold: 1 };

/**
 * **ONE TIMELINE FOR BOTH ENDS.** The server and the wallet write into the same
 * list, so *the wallet was asked before the company was created* is read off one
 * sequence rather than inferred from two.
 */
const journey: string[] = [];

/* ---------------------------------------------------------------- *
 * A WALLET AT THE OTHER END OF A REAL CHANNEL.
 * ---------------------------------------------------------------- */

/** What a person's decline on the wallet's screen sends back. */
const DECLINED = { schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined' } as const;

const identities = new Map<string, ReturnType<typeof identityFromWords>>();
const identityOf = (words: readonly string[] | string) => {
  const name = typeof words === 'string' ? words : words.join(' ');
  let identity = identities.get(name);
  if (!identity) { identity = identityFromWords(words); identities.set(name, identity); }
  return identity;
};

class WalletAtTheOtherEnd implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  readonly asked: unknown[] = [];
  /** Every keyring question, as the wallet's own parser read it. */
  readonly keyringAsks: KeyringRequest[] = [];
  /** Why the wallet refused to build an answer, when it did. */
  readonly refused: string[] = [];
  /** Every keyring answer the wallet actually sent. */
  readonly released: unknown[] = [];
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };

  constructor(
    private readonly answer: (ask: Ask) => unknown,
    private readonly observing: string = US,
  ) {}

  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  /* No real timers: nothing here waits, and a dangling one outlives the test. */
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }

  private deliver(data: unknown): void {
    this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent);
  }

  private onAsk(message: unknown): void {
    this.asked.push(message);
    const ask = parseAsk(message, this.observing, 0);
    journey.push(`wallet ${ask.kind}`);
    if (ask.kind === 'keyring') this.keyringAsks.push(ask);
    let reply: unknown;
    try {
      reply = this.answer(ask);
      if (ask.kind === 'keyring') this.released.push(reply);
    } catch (e) {
      /*
       * **THE WALLET BUILDS NOTHING AND SENDS NOTHING WHEN IT REFUSES.** Its
       * screen shows why, and the one thing that can come back from it is the
       * person declining - which is what arrives here, so the page's wait ends
       * the way it would for a person.
       */
      const code = (e as { code?: unknown }).code;
      if (typeof code !== 'string') throw e;
      this.refused.push(code);
      reply = DECLINED;
    }
    queueMicrotask(() => this.deliver(reply));
  }
}

/**
 * The ordinary case: a wallet answering honestly. It holds exactly one address,
 * the one it signs in with, and gives the keyring key only for a question that
 * names that address or names none.
 */
const honestly = (words: readonly string[] | string, address: string) => (ask: Ask): unknown => {
  if (ask.kind === 'sign-in') return { schema: 'a-sign-in', address };
  if (ask.kind === 'keyring') {
    return keyringReleaseFor(identityOf(words), ask, 0, held => held === address);
  }
  return { schema: 'not-something-this-journey-asks-a-wallet-for' };
};

/** The key a person's saved keys are sealed under, derived here, away from the tab. */
const theKeyringKey = (words: readonly string[] | string, ask: KeyringRequest): string =>
  toHex(keyringKeyFor(identityOf(words), { ...ask, person: PERSON, signedInAs: null, company: null }));

/** The ordinary key of one company, as an unlock of that company would release it. */
const theCompanyKey = (words: readonly string[] | string, ask: KeyringRequest, company: string): string =>
  toHex(unlockKeyFor(identityOf(words), {
    schema: ask.schema, kind: 'unlock', requester: ask.requester, purpose: ask.purpose,
    nonce: ask.nonce, expiresAt: ask.expiresAt, company,
  }));

type Opened = { accounts: Record<string, { signingSecret: string; blinding: string }> };
/** What a saved bundle holds when opened with `key`, or null when it does not open. */
const opened = (bundle: Sealed | null, key: string): Opened | null => {
  if (bundle === null) return null;
  try { return JSON.parse(unseal(bundle, key)) as Opened; } catch { return null; }
};

/* ---------------------------------------------------------------- *
 * A SERVER THAT REMEMBERS WHAT IT WAS TOLD.
 *
 * It is not a mock of one route at a time: the bundle a founder writes in `§1`
 * is the bundle a second device reads in `§4`, so the saving and the opening
 * are one fact rather than two stubs that happen to agree. And it refuses a
 * write that did not see the last one, the way the real one does.
 * ---------------------------------------------------------------- */

interface Recorded { url: string; method: string; body: string }

function aServer(opts: {
  /** The address the server has on the record for a new company. */
  companyAddress?: string;
  /** The refusal `POST /api/accounts/:id/unlock` makes, if any. */
  refuseCompany?: { status: number; error: string; code: string };
  /** Keys already saved for this person before the journey starts. */
  saved?: Sealed;
} = {}) {
  const seen: Recorded[] = [];
  /** The bundle the server is holding. Written by a PUT, served by a GET. */
  let held: { keyBundle: Sealed | null; version: number } =
    opts.saved ? { keyBundle: opts.saved, version: 1 } : { keyBundle: null, version: 0 };
  let created = 0;

  const answer = (method: string, url: string, body: string): { status: number; json: any } => {
    if (method === 'POST' && url === '/api/auth/wallet/challenge') {
      return { status: 200, json: { nonce: 'n', handle: 'h', expiresAt: new Date(600_000).toISOString() } };
    }
    if (method === 'POST' && url === '/api/auth/wallet') {
      /* The address the answering wallet signed in as. */
      const response = JSON.parse(body || '{}').response as { address?: string } | undefined;
      return { status: 200, json: {
        session: { token: 'tok' }, address: response?.address ?? null, created: true,
        user: { id: PERSON, email: null, name: '' },
      } };
    }
    if (method === 'GET' && url === '/api/me') {
      return { status: 200, json: { user: { id: PERSON, email: null, name: '' } } };
    }
    if (method === 'POST' && url === '/api/accounts') {
      created += 1;
      const [id, secrets] = created === 1 ? [ACCOUNT_ID, FIRST_SECRETS] : [SECOND_ID, SECOND_SECRETS];
      return { status: 200, json: {
        account: {
          id, contractAddress: opts.companyAddress ?? DEPLOYED,
          addressSource: opts.companyAddress ? 'invented' : 'chain',
          wrappedKeys: [], signers: [], name: JSON.parse(body || '{}').name,
        },
        viewingKey: 'ff'.repeat(32),
        secrets: [secrets],
      } };
    }
    if (method === 'POST' && url.startsWith('/api/accounts/') && url.endsWith('/unlock')) {
      if (opts.refuseCompany) {
        return { status: opts.refuseCompany.status, json: opts.refuseCompany };
      }
      return { status: 200, json: { company: opts.companyAddress ?? DEPLOYED } };
    }
    if (method === 'GET' && url === '/api/me/keys') {
      return { status: 200, json: { keyBundle: held.keyBundle, version: held.version } };
    }
    if (method === 'PUT' && url === '/api/me/keys') {
      const b = JSON.parse(body);
      if (b.ifVersion !== held.version) {
        return { status: 409, json: { error: 'the keys changed on another device since this tab read them' } };
      }
      held = { keyBundle: b.keyBundle, version: held.version + 1 };
      return { status: 200, json: { version: held.version } };
    }
    throw new Error(`no route for ${method} ${url}`);
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body === undefined ? '' : String(init.body);
    seen.push({ url: String(url), method, body });
    journey.push(`${method} ${url}`);
    const r = answer(method, String(url), body);
    return { ok: r.status < 400, status: r.status, json: async () => r.json } as Response;
  }) as typeof fetch;

  return {
    seen, fetchImpl,
    createdCount: () => created,
    bundle: () => held,
    /** Another device saving keys for this person, under whatever key it holds. */
    savedElsewhere: (keyBundle: Sealed) => { held = { keyBundle, version: held.version + 1 }; },
    /** The server answering from an earlier moment: what it held then, at that version. */
    goesBackTo: (earlier: { keyBundle: Sealed | null; version: number }) => { held = earlier; },
    /** Every bundle write this tab attempted, taken or refused. */
    wrote: () => seen.filter(r => r.method === 'PUT' && r.url === '/api/me/keys'),
    reads: () => seen.filter(r => r.method === 'GET' && r.url === '/api/me/keys').length,
    askedWhichCompany: () => seen.filter(r => r.url.endsWith('/unlock')),
    everything: () => JSON.stringify(seen),
  };
}

/** Installs the fake window and transport for one journey, and takes them away. */
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

function inABrowser(view: Openable, fetchImpl: typeof fetch, origin = US) {
  (globalThis as { window?: unknown }).window =
    Object.assign(view, { location: { origin } });
  globalThis.fetch = fetchImpl;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
  journey.length = 0;
  /* The module holds a key and possibly a founder's secrets. A test that left
   * them there would hand the next one a signed-in tab. */
  const keyring = await import('../web/keyring.js');
  keyring.forgetLocally();
});

/** The founder's own wallet, signed in, in a tab at `origin`. */
async function signedInWith(
  server: ReturnType<typeof aServer>,
  words: readonly string[] | string = FOUNDER_WORDS,
  address = FOUNDER_ADDRESS,
  origin = US,
  /* The transport this tab talks through, when it is not the server as it stands. */
  through: (view: WalletAtTheOtherEnd) => typeof fetch = () => server.fetchImpl,
) {
  const view = new WalletAtTheOtherEnd(honestly(words, address), origin);
  inABrowser(view, through(view), origin);
  const keyring = await import('../web/keyring.js');
  await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
  return { view, keyring };
}

/**
 * **WHAT HAPPENS TO EACH SAVE THIS TAB SENDS, IN ORDER.** The server falls over;
 * the sign-in has ended; or another device saves keys for this person just
 * before the save arrives, which the server then refuses because the save did
 * not see it. A save past the last step is left to the server.
 */
type SaveStep =
  | { readonly fallsOver: true }
  | { readonly signedOut: true }
  | { readonly anotherDeviceSaves: () => Sealed };
const FALLS_OVER: SaveStep = { fallsOver: true };
const SIGNED_OUT: SaveStep = { signedOut: true };

const savesGo = (server: ReturnType<typeof aServer>, ...steps: SaveStep[]) => {
  let n = 0;
  return (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    if (method === 'PUT' && url === '/api/me/keys' && n < steps.length) {
      const step = steps[n++]!;
      if ('anotherDeviceSaves' in step) {
        server.savedElsewhere(step.anotherDeviceSaves());
      } else {
        server.seen.push({ url, method, body: String(init?.body ?? '') });
        journey.push(`${method} ${url}`);
        return ('signedOut' in step
          ? { ok: false, status: 401, json: async () => ({ error: 'not signed in' }) }
          : { ok: false, status: 500, json: async () => ({ error: 'the server fell over' }) }) as Response;
      }
    }
    return server.fetchImpl(url, init);
  }) as typeof fetch;
};

/** Keys another device saved for this person, under the same person's key. */
const aCompanySavedElsewhere = (view: WalletAtTheOtherEnd) => () => seal(
  JSON.stringify({ accounts: { [OTHER_DEVICE_ID]: OTHER_DEVICE_KEYS } }),
  theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));

/* ======================================================================== */

describe('§1 - OPEN YOUR KEYS, CREATE, SAVE - IN THAT ORDER', () => {
  it('A SIGNED-IN WALLET PERSON WITH NOTHING SAVED STARTS A COMPANY AND ENDS UP HOLDING ITS KEYS', async () => {
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    /* Signed in, and able to open nothing: a signature is not a key. */
    expect(keyring.canOpenCompanies()).toBe(false);

    const { accountId } = await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);

    expect(accountId).toBe(ACCOUNT_ID);
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.keysFor(ACCOUNT_ID)?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });

  it('THE WALLET IS ASKED ONCE, FOR THIS PERSON AND THE ADDRESS THEY SIGNED IN AS, BEFORE THE COMPANY IS CREATED',
    async () => {
      /*
       * **THE JOURNEY EXPRESSED AS A SEQUENCE.** The key the founder's secrets
       * are saved under is open before the company exists, so a wallet that
       * refuses, or saved keys that do not open, cost nothing: no company has
       * been made whose keys would have nowhere to go.
       */
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);

      expect(journey.filter(step => step.startsWith('wallet ')), 'a sign-in, then one keyring question')
        .toEqual(['wallet sign-in', 'wallet keyring']);
      const [ask] = view.keyringAsks;
      expect(ask?.person).toBe(PERSON);
      expect(ask?.signedInAs).toBe(FOUNDER_ADDRESS);
      expect(ask?.company, 'no company is named when opening keys').toBeNull();

      const opens = journey.indexOf('wallet keyring');
      const create = journey.indexOf('POST /api/accounts');
      const save = journey.indexOf('PUT /api/me/keys');
      expect(opens).toBeGreaterThanOrEqual(0);
      expect(create).toBeGreaterThan(opens);
      expect(save).toBeGreaterThan(create);

      /* And nothing asks the server which company it is: saving keys does not need to know. */
      expect(server.askedWhichCompany()).toHaveLength(0);
    });

  it('WHAT IS SAVED OPENS WITH THE KEY THE WALLET DERIVES FOR THIS PERSON, AND NOT WITH THE COMPANY\'S KEY',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);

      expect(server.wrote()).toHaveLength(1);
      const bundle = server.bundle().keyBundle;
      const ask = view.keyringAsks[0]!;
      /* A bundle sealed under one company's key could never take a second company's keys. */
      expect(opened(bundle, theCompanyKey(FOUNDER_WORDS, ask, DEPLOYED)), 'not under the company\'s key')
        .toBeNull();
      const inside = opened(bundle, theKeyringKey(FOUNDER_WORDS, ask));
      expect(inside, 'it opens with this person\'s keyring key').not.toBeNull();
      expect(inside?.accounts[ACCOUNT_ID]?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
      expect(inside?.accounts[ACCOUNT_ID]?.blinding).toBe(FIRST_SECRETS.blinding);
    });
});

describe('§2 - A SECOND COMPANY, SAVED BESIDE THE FIRST', () => {
  it('THE SAME TAB STARTS A SECOND COMPANY WITHOUT ASKING THE WALLET, AND BOTH COMPANIES\' KEYS ARE SAVED TOGETHER',
    async () => {
      /*
       * **WHAT A PERSON WHO BELONGS TO TWO COMPANIES NEEDS.** The keys saved for
       * them are theirs and not any one company's, so the second company's keys
       * go into the same bundle, under the same key, beside the first's.
       */
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
      const asksAfterTheFirst = view.asked.length;

      const { accountId } = await keyring.createCompanyWithWallet(SOUTHWIND, WALLET, view, US);

      expect(accountId).toBe(SECOND_ID);
      expect(view.asked.length, 'the tab already holds the key, so the wallet is not asked')
        .toBe(asksAfterTheFirst);
      expect(server.createdCount()).toBe(2);
      expect(server.wrote()).toHaveLength(2);

      const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));
      expect(inside?.accounts[ACCOUNT_ID]?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
      expect(inside?.accounts[SECOND_ID]?.signingSecret).toBe(SECOND_SECRETS.signingSecret);
      expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(FIRST_SECRETS.blinding);
      expect(keyring.keysFor(SECOND_ID)?.blinding).toBe(SECOND_SECRETS.blinding);
      expect(keyring.companyAwaitingSetup()).toBeNull();
    });

  it('A FRESH TAB, SIGNED IN WITH THE SAME WALLET, OPENS BOTH', async () => {
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
    await keyring.createCompanyWithWallet(SOUTHWIND, WALLET, view, US);

    keyring.forgetLocally();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.keysFor(ACCOUNT_ID)).toBeNull();

    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.openKeysWithWallet(WALLET, view, US);

    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.keysFor(ACCOUNT_ID)?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
    expect(keyring.keysFor(SECOND_ID)?.signingSecret).toBe(SECOND_SECRETS.signingSecret);
  });

  it('A COMPANY WHOSE ADDRESS NO CHAIN ASSIGNED STILL HAS ITS KEYS SAVED', async () => {
    /*
     * **THIS USED TO BE REFUSED, AND NOT ONE BYTE SAVED.** Keys were then sealed
     * under a key worked out from the company's address, so an address no chain
     * assigned would have produced a key that changes the day the company is
     * really deployed. Keys are no longer sealed under anything a company's
     * address reaches: they are sealed under the person's own key, so there is
     * nothing to refuse here. The payslip key, which IS worked out from the
     * company's address, is a separate journey and keeps that refusal.
     */
    const server = aServer({
      companyAddress: 'dd'.repeat(32),
      refuseCompany: {
        status: 409,
        code: 'company-address-not-from-a-chain',
        error: 'this company has an address, but no chain gave it one',
      },
    });
    const { view, keyring } = await signedInWith(server);

    await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US))
      .resolves.toEqual({ accountId: ACCOUNT_ID });

    expect(server.askedWhichCompany(), 'the address was never asked about').toHaveLength(0);
    expect(keyring.companyAwaitingSetup()).toBeNull();
    const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));
    expect(inside?.accounts[ACCOUNT_ID]?.blinding).toBe(FIRST_SECRETS.blinding);
  });
});

describe('§3 - NO PASSWORD, ANYWHERE ON THIS JOURNEY', () => {
  it('NOT ONE REQUEST CARRIES AUTH MATERIAL', async () => {
    /*
     * **WHY THE PASSWORD COULD NOT BE DELETED UNTIL THIS PASSED.** While
     * creating a company was the one thing only a password could do, the
     * password had to stay. Proved by watching rather than by reading: every
     * byte this tab handed the server, searched.
     *
     * **IT IS A WEAKER TEST THAN IT WAS AND A STRONGER CLAIM.** When it was
     * written, a password path existed alongside this one and the point was
     * that this journey did not touch it. There is no other path now — so what
     * this still catches is a REGRESSION that puts auth material back on the
     * wire, and the claim that none exists anywhere is made by
     * `src/web/no-password-in-the-bundle.test.ts`, which builds the app.
     */
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);

    const everything = server.everything();
    for (const word of ['authKey', 'authSalt', 'password', 'argon']) {
      expect(everything, word).not.toContain(word);
    }
    /* It really did run: an absence test passes just as well when nothing
     * happened at all. */
    expect(server.wrote()).toHaveLength(1);
  });

  it('AND THE CREATION PATH HAS NOWHERE TO PUT ONE', () => {
    /*
     * The rule expressed where it cannot be forgotten.
     *
     * **THE SLICE IS NO LONGER NECESSARY AND IS KEPT ON PURPOSE.** It read:
     * *`keyring.ts` as a whole still derived auth material when this was
     * written, so the assertion is about THIS function's own source.*
     * `register`, `signIn` and `derive` have since been deleted, so the whole
     * file would now pass this. **Widening it to the file would be a different
     * test with the same name**: this one says the CREATION PATH has nowhere to
     * put a password, which stays worth saying the day somebody adds a fallback
     * to one here — and `no-password-in-the-bundle.test.ts` makes the
     * whole-file claim against the built output, where it belongs.
     */
    const src = readFileSync(new URL('../web/keyring.ts', import.meta.url), 'utf8');
    const opens = src.indexOf('/* ---------------- bringing a company into being');
    const closes = src.indexOf(' * Derives the viewing key from the account');
    /* The markers are asserted before the slice is used. A slice taken between
     * two indexes that have moved is a test that passes over the wrong text —
     * which is the shape of every vacuous grep this project has written. */
    expect(opens, 'the creation section is still where this expects').toBeGreaterThan(-1);
    expect(closes).toBeGreaterThan(opens);
    const path = src.slice(opens, closes);

    /* It really is the creation path and not an empty slice. */
    expect(path).toContain('export async function createCompanyWithWallet');
    expect(path).toContain('export async function finishCompanyCreation');

    /*
     * **COMMENTS MAY SAY THE WORDS; CODE MAY NOT.** `wallet-unlock.test.ts`'s
     * rule, and it is not a loophole — the header above this function explains
     * at length what a password used to be able to do here and why this path
     * never had a fallback to one, and a test that forbade the WORD would
     * forbid saying so. It matters more now that the password path is gone, not
     * less: the history is the only place the reason survives.
     */
    const code = path.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('export async function createCompanyWithWallet');

    for (const word of ['password', 'authKey', 'authSalt', 'derive(', 'deriveAuthMaterial']) {
      expect(code, word).not.toContain(word);
    }
  });
});

describe('§4 - THE FOUNDER\'S FIRST DEVICE IS NOT SPECIAL', () => {
  it('A SECOND DEVICE, FROM THE WORDS ALONE, AT ANOTHER ADDRESS, OPENS BOTH COMPANIES\' KEYS', async () => {
    /*
     * Device one creates two companies and saves their keys. Device two is a
     * wallet REBUILT FROM THE SAME WORDS, at a DIFFERENT HOST, with nothing
     * carried across but what the server is holding - no keyring, no key, no
     * copy of device one. The key is the person's on this site, worked out from
     * the words and the person, and the host the page is served from is not part
     * of it.
     */
    const server = aServer();
    const { view: deviceOne, keyring } = await signedInWith(server);
    await keyring.createCompanyWithWallet(NORTHWIND, WALLET, deviceOne, US);
    await keyring.createCompanyWithWallet(SOUTHWIND, WALLET, deviceOne, US);
    expect(server.bundle().keyBundle).toBeTruthy();

    /* Everything device one held is gone. This is the new laptop. */
    keyring.forgetLocally();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.keysFor(ACCOUNT_ID)).toBeNull();

    const { view: deviceTwo } = await signedInWith(server, FOUNDER_WORDS, FOUNDER_ADDRESS, ELSEWHERE);
    await keyring.openKeysWithWallet(WALLET, deviceTwo, ELSEWHERE);

    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.keysFor(ACCOUNT_ID)?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
    expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(FIRST_SECRETS.blinding);
    expect(keyring.keysFor(SECOND_ID)?.signingSecret).toBe(SECOND_SECRETS.signingSecret);
    expect(keyring.keysFor(SECOND_ID)?.blinding).toBe(SECOND_SECRETS.blinding);
    /* Opening wrote nothing. */
    expect(server.wrote()).toHaveLength(2);

    /*
     * **AND THEY REALLY DO OPEN THE COMPANY, not merely match a fixture.** The
     * viewing key is wrapped to the founder's wrapping key on the account
     * record, so unwrapping it here is the last link in a chain that starts at
     * twenty-four words: words to the person's key, that key to the saved keys,
     * saved keys to the wrapping secret, wrapping secret to the key that reads
     * the company.
     */
    const keys = keyring.keysFor(ACCOUNT_ID)!;
    const viewingKey = 'ff'.repeat(32);
    const forTheFounder = wrapKey(viewingKey, x25519PublicOf(keys.wrappingSecret));
    expect(unwrapKey(forTheFounder, keys.wrappingSecret)).toBe(viewingKey);
  });

  it('A DIFFERENT WALLET, ASKED FOR THE ADDRESS THIS TAB SIGNED IN AS, GIVES NOTHING', async () => {
    /*
     * A browser can hold more than one wallet. The founder signs in with theirs,
     * and a different wallet answers the question about their keys. That wallet
     * holds no account with the address this tab signed in as, so it builds no
     * answer at all - and nothing is read or written here.
     */
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
    keyring.forgetLocally();
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());

    const somebodyElse = new WalletAtTheOtherEnd(honestly(SOMEBODY_ELSE_WORDS, SOMEBODY_ELSE_ADDRESS));
    const requestsBefore = server.seen.length;
    await expect(keyring.openKeysWithWallet(WALLET, somebodyElse, US))
      .rejects.toThrow(/did not approve it in your wallet/);

    expect(somebodyElse.keyringAsks[0]?.signedInAs).toBe(FOUNDER_ADDRESS);
    expect(somebodyElse.refused).toEqual(['address-not-held']);
    expect(somebodyElse.released, 'no key was sent').toHaveLength(0);
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(server.seen.slice(requestsBefore), 'nothing was read or written').toEqual([]);
  });

  it('AND IN A TAB THAT DID NOT SIGN IN, A DIFFERENT WALLET\'S KEY OPENS NOTHING AND SAVES NOTHING', async () => {
    /*
     * After a reload the tab does not know which address it signed in as, so it
     * asks without one and a different wallet does give a key - its own. What is
     * saved is its own check: that key does not open it, so nothing is opened,
     * and nothing is ever saved over it from here.
     */
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
    keyring.forgetLocally();
    const savedBefore = JSON.stringify(server.bundle());
    const writesBefore = server.wrote().length;

    const somebodyElse = new WalletAtTheOtherEnd(honestly(SOMEBODY_ELSE_WORDS, SOMEBODY_ELSE_ADDRESS));
    inABrowser(somebodyElse, server.fetchImpl);
    expect(await keyring.resumeSession()).toMatchObject({ id: PERSON });

    const failure = await keyring.openKeysWithWallet(WALLET, somebodyElse, US).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect((failure as Error).message).toMatch(/did not open with the key your wallet gave/);
    expect(somebodyElse.keyringAsks[0]?.signedInAs, 'the tab did not know the address').toBeNull();
    expect(somebodyElse.refused).toEqual([]);
    expect(somebodyElse.released, 'the wallet did give its own key').toHaveLength(1);
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.keysFor(ACCOUNT_ID)).toBeNull();

    /* And starting a company here does not save over what could not be opened. */
    await expect(keyring.createCompanyWithWallet(SOUTHWIND, WALLET, somebodyElse, US))
      .rejects.toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect(server.wrote()).toHaveLength(writesBefore);
    expect(server.createdCount()).toBe(1);
    expect(JSON.stringify(server.bundle())).toBe(savedBefore);
  });
});

describe('§5 - WHAT IS REFUSED, AND BEFORE WHAT', () => {
  it('SAVED KEYS THAT DO NOT OPEN ARE REFUSED BEFORE ANY COMPANY IS CREATED', async () => {
    const theirs = seal(JSON.stringify({ accounts: {} }), 'ab'.repeat(32));
    const server = aServer({ saved: theirs });
    const { view, keyring } = await signedInWith(server);

    const failure = await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(keyring.SavedKeysDidNotOpen);

    expect(journey, 'no company was created').not.toContain('POST /api/accounts');
    expect(server.createdCount()).toBe(0);
    expect(server.wrote(), 'nothing was saved over them').toHaveLength(0);
    expect(server.bundle().keyBundle).toEqual(theirs);
    expect(keyring.companyAwaitingSetup()).toBeNull();
    expect(keyring.canOpenCompanies()).toBe(false);
  });

  it('A TAB THAT DID NOT SIGN IN MAY NOT SAVE A PERSON\'S FIRST KEYS, AND SAYS SO BEFORE ANY COMPANY IS CREATED',
    async () => {
      /*
       * With nothing saved there is nothing a key can be checked against, so the
       * first keys are saved only under a key asked for with the address this
       * tab signed in as. A tab that picked up an existing sign-in never saw it.
       */
      const server = aServer();
      const view = new WalletAtTheOtherEnd(honestly(FOUNDER_WORDS, FOUNDER_ADDRESS));
      inABrowser(view, server.fetchImpl);
      const keyring = await import('../web/keyring.js');
      expect(await keyring.resumeSession()).toMatchObject({ id: PERSON });
      expect(keyring.signedInWallet()).toBeNull();

      await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US))
        .rejects.toThrow(/nothing is saved for you here yet, and this tab did not sign you in/);

      expect(view.keyringAsks[0]?.signedInAs).toBeNull();
      expect(journey, 'no company was created').not.toContain('POST /api/accounts');
      expect(server.createdCount()).toBe(0);
      expect(server.wrote()).toHaveLength(0);
      expect(keyring.companyAwaitingSetup()).toBeNull();
    });

  it('THE SAME KIND OF TAB, FOR A PERSON WHOSE SAVED KEYS OPEN, MAY START A COMPANY', async () => {
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
    keyring.forgetLocally();
    expect(await keyring.resumeSession()).toMatchObject({ id: PERSON });

    await expect(keyring.createCompanyWithWallet(SOUTHWIND, WALLET, view, US))
      .resolves.toEqual({ accountId: SECOND_ID });

    const ask = view.keyringAsks.at(-1)!;
    expect(ask.signedInAs).toBeNull();
    const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, ask));
    expect(inside?.accounts[ACCOUNT_ID]?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
    expect(inside?.accounts[SECOND_ID]?.signingSecret).toBe(SECOND_SECRETS.signingSecret);
  });

  it('A TAB WAITING TO FINISH A COMPANY DOES NOT START ANOTHER', async () => {
    const server = aServer();
    const view = new WalletAtTheOtherEnd(honestly(FOUNDER_WORDS, FOUNDER_ADDRESS));
    inABrowser(view, savesGo(server, FALLS_OVER, FALLS_OVER));
    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US)).rejects.toThrow(/fell over/);
    expect(server.wrote(), 'the save was tried once more before the company was left waiting').toHaveLength(2);
    expect(keyring.companyAwaitingSetup()).toBe(ACCOUNT_ID);
    const asks = view.asked.length;

    /* Starting another would replace the only copy of the first one's keys. */
    await expect(keyring.createCompanyWithWallet(SOUTHWIND, WALLET, view, US))
      .rejects.toThrow(/is not finished yet/);
    expect(server.createdCount()).toBe(1);
    expect(view.asked.length).toBe(asks);
    expect(keyring.companyAwaitingSetup()).toBe(ACCOUNT_ID);
  });

  it('ONE PRESS: WHEN ANOTHER DEVICE SAVES A COMPANY\'S KEYS BETWEEN THIS TAB\'S READ AND ITS SAVE, BOTH ARE SAVED AND NOTHING IS LEFT WAITING',
    async () => {
      /*
       * The ordinary race. What the other device saved opens with this person's
       * key, so the refused save is read again and tried once more at once,
       * rather than leaving the founder's keys in a tab that may close first.
       */
      const server = aServer();
      const { view, keyring } = await signedInWith(server, FOUNDER_WORDS, FOUNDER_ADDRESS, US,
        v => savesGo(server, { anotherDeviceSaves: aCompanySavedElsewhere(v) }));

      await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US))
        .resolves.toEqual({ accountId: ACCOUNT_ID });

      expect(journey.filter(step => step.startsWith('wallet ')), 'the wallet was asked once')
        .toEqual(['wallet sign-in', 'wallet keyring']);
      expect(journey.filter(step => step.endsWith(' /api/me/keys')), 'read, refused, read again, saved')
        .toEqual(['GET /api/me/keys', 'PUT /api/me/keys', 'GET /api/me/keys', 'PUT /api/me/keys']);
      expect(server.createdCount()).toBe(1);
      const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));
      expect(inside?.accounts[OTHER_DEVICE_ID]?.signingSecret).toBe(OTHER_DEVICE_KEYS.signingSecret);
      expect(inside?.accounts[ACCOUNT_ID]?.blinding).toBe(FIRST_SECRETS.blinding);
      expect(keyring.companyAwaitingSetup()).toBeNull();
      expect(keyring.keysFor(OTHER_DEVICE_ID)?.signingSecret).toBe(OTHER_DEVICE_KEYS.signingSecret);
      expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(FIRST_SECRETS.blinding);
    });

  it('A SAVE REFUSED BECAUSE THE SIGN-IN ENDED IS NOT TRIED AGAIN, AND THE UNSAVED COMPANY GOES WITH THE SIGN-IN',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server, FOUNDER_WORDS, FOUNDER_ADDRESS, US,
        () => savesGo(server, SIGNED_OUT));

      const failure = await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(keyring.AuthError);
      expect(server.wrote(), 'exactly one save').toHaveLength(1);
      expect(server.reads(), 'nothing was read again').toBe(1);
      expect(keyring.companyAwaitingSetup()).toBeNull();
      expect(keyring.isSignedIn()).toBe(false);
    });

  it('A TAB ALREADY HOLDING THE KEY, WHOSE SAVED KEYS WERE REPLACED BY ONES IT CANNOT OPEN, IS REFUSED BEFORE ANY COMPANY IS CREATED',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
      server.savedElsewhere(seal(JSON.stringify({ accounts: {} }), 'ab'.repeat(32)));
      const asks = view.asked.length;
      const writes = server.wrote().length;

      const failure = await keyring.createCompanyWithWallet(SOUTHWIND, WALLET, view, US).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(keyring.SavedKeysDidNotOpen);
      expect(view.asked.length, 'the wallet was not asked').toBe(asks);
      expect(server.createdCount(), 'no second company was created').toBe(1);
      expect(server.wrote(), 'nothing was saved over them').toHaveLength(writes);
      expect(keyring.companyAwaitingSetup()).toBeNull();
    });

  it('THE SAME TAB, WHEN WHAT IS SAVED IS OLDER THAN WHAT IT ALREADY READ, IS REFUSED BEFORE ANY COMPANY IS CREATED AND KEEPS THE KEYS IT HOLDS',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      await keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US);
      const earlier = { ...server.bundle() };
      await keyring.createCompanyWithWallet(SOUTHWIND, WALLET, view, US);
      /* The server now answers from before the second company's keys were saved. */
      server.goesBackTo(earlier);

      const failure = await keyring.createCompanyWithWallet(WESTWIND, WALLET, view, US).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(keyring.SavedKeysWentBack);
      expect((failure as Error).message).toMatch(/older than what this tab already read/);
      expect(server.createdCount(), 'no third company was created').toBe(2);
      expect(server.wrote()).toHaveLength(2);
      expect(keyring.keysFor(SECOND_ID)?.signingSecret, 'the keys this tab holds are kept')
        .toBe(SECOND_SECRETS.signingSecret);
      expect(keyring.keysFor(ACCOUNT_ID)?.signingSecret).toBe(FIRST_SECRETS.signingSecret);
      expect(keyring.companyAwaitingSetup()).toBeNull();
    });

  it('A SAVE REFUSED TWICE BECAUSE ANOTHER DEVICE KEPT SAVING KEEPS THE COMPANY, AND FINISH SAVES IT BESIDE WHAT WAS SAVED, WITHOUT THE WALLET',
    async () => {
      const server = aServer();
      const view = new WalletAtTheOtherEnd(honestly(FOUNDER_WORDS, FOUNDER_ADDRESS));
      /* The other device holds the same person's key, so what it saved opens here. */
      const theirs = aCompanySavedElsewhere(view);
      inABrowser(view, savesGo(server, { anotherDeviceSaves: theirs }, { anotherDeviceSaves: theirs }));
      const keyring = await import('../web/keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());

      await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US))
        .rejects.toThrow(/changed on another device/);
      expect(server.wrote(), 'saved, read again, and tried once more').toHaveLength(2);
      expect(keyring.companyAwaitingSetup(), 'the founder\'s keys are still held').toBe(ACCOUNT_ID);
      expect(keyring.companyAwaitingSetupProblem(), 'it can still be finished').toBeNull();
      /* The refused write left no keys behind in a tab that would believe them saved. */
      expect(keyring.keysFor(ACCOUNT_ID)).toBeNull();

      const asks = view.asked.length;
      const readsBefore = server.reads();
      await expect(keyring.finishCompanyCreation()).resolves.toEqual({ accountId: ACCOUNT_ID });

      expect(view.asked.length, 'Finish asked the wallet nothing').toBe(asks);
      expect(server.reads(), 'Finish read what is saved again').toBe(readsBefore + 1);
      expect(server.createdCount(), 'and made no second company').toBe(1);
      const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));
      expect(inside?.accounts[OTHER_DEVICE_ID]?.signingSecret, 'what the other device saved is kept')
        .toBe(OTHER_DEVICE_KEYS.signingSecret);
      expect(inside?.accounts[ACCOUNT_ID]?.blinding).toBe(FIRST_SECRETS.blinding);
      expect(keyring.companyAwaitingSetup()).toBeNull();
      expect(keyring.keysFor(OTHER_DEVICE_ID)?.signingSecret).toBe(OTHER_DEVICE_KEYS.signingSecret);
      expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(FIRST_SECRETS.blinding);
    });

  it('WHEN WHAT WAS SAVED MEANWHILE DOES NOT OPEN WITH THIS TAB\'S KEY, FINISH SAYS IT CANNOT BE SAVED AND WRITES NOTHING',
    async () => {
      const server = aServer();
      const view = new WalletAtTheOtherEnd(honestly(FOUNDER_WORDS, FOUNDER_ADDRESS));
      /* The first save falls over; before the second, a bundle under another key is saved. */
      inABrowser(view, savesGo(server, FALLS_OVER, {
        anotherDeviceSaves: () =>
          seal(JSON.stringify({ accounts: { [OTHER_DEVICE_ID]: OTHER_DEVICE_KEYS } }), 'ab'.repeat(32)),
      }));
      const keyring = await import('../web/keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());

      await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US))
        .rejects.toThrow(/changed on another device/);
      expect(keyring.companyAwaitingSetup()).toBe(ACCOUNT_ID);
      expect(keyring.companyAwaitingSetupProblem()).toBeNull();

      const asks = view.asked.length;
      const writes = server.wrote().length;
      const theirs = JSON.stringify(server.bundle());

      const failure = await keyring.finishCompanyCreation().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(keyring.SavedKeysDidNotOpen);
      expect((failure as Error).message).toMatch(/this company's keys cannot be saved/);
      const problem = keyring.companyAwaitingSetupProblem();
      expect(problem?.canFinish).toBe(false);
      expect(problem?.why).toMatch(/closing this tab or signing out loses this company for good/);
      expect(server.wrote(), 'nothing was saved over keys this tab cannot open').toHaveLength(writes);
      expect(JSON.stringify(server.bundle())).toBe(theirs);
      expect(keyring.companyAwaitingSetup(), 'the keys are still held in this tab').toBe(ACCOUNT_ID);

      /* And a second Finish stops at once: nothing is read, and the wallet is not asked. */
      const reads = server.reads();
      await expect(keyring.finishCompanyCreation()).rejects.toThrow(/this company's keys cannot be saved/);
      expect(server.reads()).toBe(reads);
      expect(server.wrote()).toHaveLength(writes);
      expect(view.asked.length).toBe(asks);
    });

  it('a save refused for any other reason is still offered as finishable', async () => {
    const server = aServer();
    const view = new WalletAtTheOtherEnd(honestly(FOUNDER_WORDS, FOUNDER_ADDRESS));
    inABrowser(view, savesGo(server, FALLS_OVER, FALLS_OVER));
    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US)).rejects.toThrow(/fell over/);
    expect(keyring.companyAwaitingSetupProblem()).toBeNull();
    await keyring.finishCompanyCreation();
    expect(keyring.companyAwaitingSetup()).toBeNull();
    expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(FIRST_SECRETS.blinding);
  });

  it('signing out drops the founder\'s unsaved secrets', async () => {
    const server = aServer();
    const view = new WalletAtTheOtherEnd(honestly(FOUNDER_WORDS, FOUNDER_ADDRESS));
    inABrowser(view, savesGo(server, FALLS_OVER, FALLS_OVER));
    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await expect(keyring.createCompanyWithWallet(NORTHWIND, WALLET, view, US)).rejects.toThrow(/fell over/);

    expect(keyring.companyAwaitingSetup()).toBe(ACCOUNT_ID);
    keyring.forgetLocally();
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });
});
