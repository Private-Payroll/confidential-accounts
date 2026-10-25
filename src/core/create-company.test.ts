import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask, KeyringRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { Openable } from 'vaults-web-shared/wallet-sign-in.js';
import type { CompanyToFound } from 'vaults-web-shared/keyring.js';
import { foundedAsTheWalletAnswers, keyringAsTheWalletAnswers, savedKeysSealKey } from '../testing/a-wallet-founds-a-company.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Sealed } from './crypto.js';
import { fromHex, seal, signingPublicKeyOf, toHex, unseal, unwrapKey, wrapKey } from './crypto.js';

/** A seat's signing public key, as the wallet reads it from the saved keys for a page. */
const publicOf = (secret: string | undefined): string | null => (secret === undefined ? null : signingPublicKeyOf(secret).toLowerCase());
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
 * **SOMEBODY WITH A WALLET STARTS A COMPANY, AND WHAT IS SAVED FOR THEM OPENS ON ANOTHER DEVICE.**
 *
 * ── WHAT IS BEING PROVED, AND WHY IT IS PROVED BY WATCHING ────────────────
 *
 * Starting a company is an ORDER OF OPERATIONS, and an order is a property of a
 * journey rather than of any one function. So the whole first press runs here
 * against a recording transport and a real wallet at the other end of a real
 * channel: every URL, method and body this tab sends is kept, every question the
 * wallet is asked is kept, and the assertions are about what happened, in what
 * order, and what never happened at all.
 *
 * The order is: **open the keys saved for this person** (one question to the
 * wallet, for the key it derives for this person on this site, which also draws
 * the new company's label), **save the founding seat's keys beside everything
 * already saved**, under that same key, and only then **send the company**. A
 * person's saved keys belong to the person and not to any one company, so
 * nothing about saving them waits on a company's address.
 *
 * **THE WALLET SIDE IS THE WALLET'S OWN CODE.** `identityFromWords`, `parseAsk`,
 * `keyringReleaseFor` and `keyringKeyFor` ship from `midnight-identity`, resolved
 * through its `exports`. Nothing here is a fixture shaped like a key, and the key
 * a bundle is checked against is derived here independently of the tab. The
 * builder stands in for the worker, which
 * `contracts/test/a-company-born-held-from-the-browser.test.ts` drives for real.
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

/** The company's account on the chain, as the deploy this device builds names it. */
const DEPLOYED = 'a1'.repeat(32);
/** Every label a wallet on this journey made up, in order, so a test can say which one the page used. */
const drawn: CompanyLabel[] = [];
const draw = (): CompanyLabel => {
  const label = ('co_' + (drawn.length + 1).toString(16).padStart(64, '0')) as CompanyLabel;
  drawn.push(label);
  return label;
};

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

const NORTHWIND: CompanyToFound = { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 };
const SOUTHWIND: CompanyToFound = { name: 'Southwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 };


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
  if (ask.kind === 'keyring' && ask.drawLabel) return foundedAsTheWalletAnswers(identityOf(words), ask, (held) => held === address, 0, draw);
  if (ask.kind === 'keyring') return keyringAsTheWalletAnswers(identityOf(words), ask, held => held === address, 0);
  return { schema: 'not-something-this-journey-asks-a-wallet-for' };
};

/** The key a person's saved keys are sealed under, derived here, away from the tab. */
const theKeyringKey = (words: readonly string[] | string, ask: KeyringRequest): string =>
  savedKeysSealKey(identityOf(words), { requester: ask.requester, person: PERSON });

/** The ordinary key of one company, as an unlock of that company would release it. */
const theCompanyKey = (words: readonly string[] | string, ask: KeyringRequest, company: CompanyLabel): string =>
  toHex(unlockKeyFor(identityOf(words), {
    schema: ask.schema, kind: 'unlock', requester: ask.requester, purpose: ask.purpose,
    nonce: ask.nonce, expiresAt: ask.expiresAt, company, account: DEPLOYED as never,
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
  /** Keys already saved for this person before the journey starts. */
  saved?: Sealed;
} = {}) {
  const seen: Recorded[] = [];
  /** The bundle the server is holding. Written by a PUT, served by a GET. */
  let held: { keyBundle: Sealed | null; version: number } =
    opts.saved ? { keyBundle: opts.saved, version: 1 } : { keyBundle: null, version: 0 };
  let created = 0;
  let lastMade = '';

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
      lastMade = String(JSON.parse(body).founding.account.id);
      return { status: 201, json: { account: { id: lastMade }, state: 'made' } };
    }
    if (method === 'GET' && url === '/api/me/keys') {
      return { status: 200, json: { keyBundle: held.keyBundle, version: held.version } };
    }
    if (method === 'PUT' && url === '/api/me/keys') {
      const b = JSON.parse(body);
      /* As the real service: a save that names no version is an overwrite, and one that names a stale version is refused. */
      if (b.ifVersion !== undefined && b.ifVersion !== held.version) {
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
    /** The id of the company the last request to create one made. */
    madeId: () => lastMade,
    bundle: () => held,
    /** Another device saving keys for this person, under whatever key it holds. */
    savedElsewhere: (keyBundle: Sealed) => { held = { keyBundle, version: held.version + 1 }; },
    /** The server answering from an earlier moment: what it held then, at that version. */
    goesBackTo: (earlier: { keyBundle: Sealed | null; version: number }) => { held = earlier; },
    /** Every bundle write this tab attempted, taken or refused. */
    wrote: () => seen.filter(r => r.method === 'PUT' && r.url === '/api/me/keys'),
    reads: () => seen.filter(r => r.method === 'GET' && r.url === '/api/me/keys').length,
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
  const keyring = await import('vaults-web-shared/keyring.js');
  keyring.forgetLocally();
});

/** The founding signer's own wallet, signed in, in a tab at `origin`. */
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
  const keyring = await import('vaults-web-shared/keyring.js');
  await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
  return { view, keyring };
}

/** A transport on which the first save of this tab's keys is refused because the sign-in has ended. */
/** A transport on which another device saves keys for this person just before this tab's first save arrives. */
const anotherDeviceSavesBeforeTheFirstSave = (server: ReturnType<typeof aServer>, view: () => WalletAtTheOtherEnd) => {
  let done = false;
  return (async (url: string, init?: RequestInit) => {
    if (String(init?.method ?? 'GET') === 'PUT' && url === '/api/me/keys' && !done) {
      done = true;
      server.savedElsewhere(seal(JSON.stringify({ accounts: { acc_elsewhere: { signerId: 'sgn_elsewhere' } } }), theKeyringKey(FOUNDER_WORDS, view().keyringAsks[0]!)));
    }
    return server.fetchImpl(url, init);
  }) as typeof fetch;
};

const theSignInEndsOnTheFirstSave = (server: ReturnType<typeof aServer>) => {
  let sent = false;
  return (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    if (method === 'PUT' && url === '/api/me/keys' && !sent) {
      sent = true;
      server.seen.push({ url, method, body: String(init?.body ?? '') });
      journey.push(`${method} ${url}`);
      return { ok: false, status: 401, json: async () => ({ error: 'not signed in' }) } as Response;
    }
    return server.fetchImpl(url, init);
  }) as typeof fetch;
};

/* ======================================================================== */

/** The first press for `NORTHWIND`, and the id of the company it made. */
const startedBy = async (view: WalletAtTheOtherEnd, keyring: typeof import('vaults-web-shared/keyring.js'), company = NORTHWIND) => {
  const started = await keyring.startCompanyHeldFromTheStart(company, WALLET, view, US);
  return started.accountId;
};

describe('§1 - OPEN YOUR KEYS, SAVE THE SEAT, THEN SEND THE COMPANY - IN THAT ORDER', () => {
  /* RED WHEN: a person signed in with their wallet and nothing saved cannot start a company, or starts one and is left without its keys, so the company's records cannot be opened. */
  it('A SIGNED-IN WALLET PERSON WITH NOTHING SAVED STARTS A COMPANY AND ENDS UP HOLDING ITS KEYS', async () => {
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    /* Signed in, and able to open nothing: a signature is not a key. */
    expect(keyring.canOpenCompanies()).toBe(false);

    const accountId = await startedBy(view, keyring);

    expect(accountId).toBe(server.madeId());
    expect(keyring.canOpenCompanies()).toBe(true);
    const held = keyring.seatHeldHere(accountId);
    expect(held?.signingPublicKey).toMatch(/^[0-9a-f]{64}$/u);
    const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));
    /* RED WHEN: the tab holds the seat by anything but its public half: its secret stays in the saved keys only the wallet opens. */
    expect(publicOf(inside?.accounts[accountId]?.signingSecret)).toBe(held?.signingPublicKey);
    expect(JSON.stringify(held)).not.toContain(inside!.accounts[accountId]!.signingSecret);
  });

  it('THE WALLET IS ASKED ONCE, FOR THIS PERSON AND THE ADDRESS THEY SIGNED IN AS, AND THE KEYS ARE SAVED BEFORE THE COMPANY IS SENT',
    async () => {
      /*
       * **THE JOURNEY EXPRESSED AS A SEQUENCE.** The key the founding signer's secrets
       * are saved under is open before the company exists, so a wallet that
       * refuses, or saved keys that do not open, cost nothing: no company has
       * been made whose keys would have nowhere to go.
       */
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      await startedBy(view, keyring);

      expect(journey.filter(step => step.startsWith('wallet ')), 'a sign-in, then one keyring question')
        .toEqual(['wallet sign-in', 'wallet keyring']);
      const [ask] = view.keyringAsks;
      expect(ask?.person).toBe(PERSON);
      expect(ask?.signedInAs).toBe(FOUNDER_ADDRESS);
      expect(ask?.company, 'no company is named when opening keys').toBeNull();
      /*
       * RED WHEN the page names the label itself, or posts one the wallet did
       * not make up: the label is the wallet's to draw, asked for and taken as given.
       */
      expect(ask?.drawLabel).toBe(true);
      const posted = server.seen.find(r => r.method === 'POST' && r.url === '/api/accounts')!;
      expect(JSON.parse(posted.body).companyLabel).toBe(drawn[drawn.length - 1]);

      const opens = journey.indexOf('wallet keyring');
      const save = journey.indexOf('PUT /api/me/keys');
      const create = journey.indexOf('POST /api/accounts');
      expect(opens).toBeGreaterThanOrEqual(0);
      expect(save).toBeGreaterThan(opens);
      expect(create).toBeGreaterThan(save);
    });

  /* RED WHEN: what is saved opens only with one company's key, so a second company's keys would have nowhere to go, or the saved keys are not the ones the company was made with. */
  it('WHAT IS SAVED OPENS WITH THE KEY THE WALLET DERIVES FOR THIS PERSON, AND NOT WITH THE COMPANY\'S KEY',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      const accountId = await startedBy(view, keyring);

      expect(server.wrote().length).toBeGreaterThan(0);
      const bundle = server.bundle().keyBundle;
      const ask = view.keyringAsks[0]!;
      /* A bundle sealed under one company's key could never take a second company's keys. */
      expect(opened(bundle, theCompanyKey(FOUNDER_WORDS, ask, drawn[drawn.length - 1]!)), 'not under the company\'s key')
        .toBeNull();
      const inside = opened(bundle, theKeyringKey(FOUNDER_WORDS, ask));
      expect(inside, 'it opens with this person\'s keyring key').not.toBeNull();
      expect(publicOf(inside?.accounts[accountId]?.signingSecret)).toBe(keyring.seatHeldHere(accountId)?.signingPublicKey);
      expect(JSON.stringify(keyring.seatHeldHere(accountId))).not.toContain(inside!.accounts[accountId]!.blinding);
    });
});

describe('§2 - A FRESH TAB OPENS WHAT WAS SAVED', () => {
  /* RED WHEN: a person who opens a new tab and signs in with the same wallet cannot open the company's keys. */
  it('A FRESH TAB, SIGNED IN WITH THE SAME WALLET, OPENS THE COMPANY\'S KEYS', async () => {
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    const accountId = await startedBy(view, keyring);
    const secret = keyring.seatHeldHere(accountId)!.signingPublicKey;

    keyring.forgetLocally();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.seatHeldHere(accountId)).toBeNull();

    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.openKeysWithWallet(WALLET, view, US);

    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.seatHeldHere(accountId)?.signingPublicKey).toBe(secret);
  });
});

describe('§3 - NO PASSWORD, ANYWHERE ON THIS JOURNEY', () => {
  /* RED WHEN: anything the person could sign in with by password, or a derived password key, is sent to the service while a company is made. */
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
     * wire. The claim that none exists anywhere was made by a build of the
     * earlier application, which went with it.
     */
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await startedBy(view, keyring);

    const everything = server.everything();
    for (const word of ['authKey', 'authSalt', 'password', 'argon']) {
      expect(everything, word).not.toContain(word);
    }
    /* It really did run: an absence test passes just as well when nothing
     * happened at all. */
    expect(server.wrote().length).toBeGreaterThan(0);
    expect(server.createdCount()).toBe(1);
  });

  /* RED WHEN: someone adds a password or password-derived sign-in to the code that creates a company. */
  it('AND THE CREATION PATH HAS NOWHERE TO PUT ONE', () => {
    /*
     * The rule expressed where it cannot be forgotten.
     *
     * **THE SLICE IS NO LONGER NECESSARY AND IS KEPT ON PURPOSE.** It read:
     * *`keyring.ts` as a whole still derived auth material when this was
     * written, so the assertion is about THIS section's own source.*
     * `register`, `signIn` and `derive` have since been deleted, so the whole
     * file would now pass this. **Widening it to the file would be a different
     * test with the same name**: this one says the CREATION PATH has nowhere to
     * put a password, which stays worth saying the day somebody adds a fallback
     * to one here. The whole-file claim against built output belongs to a
     * build check, and no build of `apps/web` makes it yet.
     */
    const src = readFileSync(new URL('../../packages/web-shared/src/keyring.ts', import.meta.url), 'utf8');
    const opens = src.indexOf('/* ---------------- bringing a company into being');
    const closes = src.indexOf(' * Opens an account the server just served us.');
    /* The markers are asserted before the slice is used. A slice taken between
     * two indexes that have moved is a test that passes over the wrong text —
     * which is the shape of every vacuous grep this project has written. */
    expect(opens, 'the creation section is still where this expects').toBeGreaterThan(-1);
    expect(closes).toBeGreaterThan(opens);
    const path = src.slice(opens, closes);

    /* It really is the creation path and not an empty slice. */
    expect(path).toContain('export async function startCompanyHeldFromTheStart');
    expect(path).toContain('export async function finishCompanyInTheWallet');

    /*
     * **COMMENTS MAY SAY THE WORDS; CODE MAY NOT.** `wallet-unlock.test.ts`'s
     * rule, and it is not a loophole — a header may explain what a password
     * used to be able to do here and why this path never had a fallback to
     * one, and a test that forbade the WORD would forbid saying so. It matters
     * more now that the password path is gone, not less: the history is the
     * only place the reason survives.
     */
    const code = path.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('export async function startCompanyHeldFromTheStart');

    for (const word of ['password', 'authKey', 'authSalt', 'derive(', 'deriveAuthMaterial']) {
      expect(code, word).not.toContain(word);
    }
  });
});

describe('§4 - THE FOUNDING SIGNER\'S FIRST DEVICE IS NOT SPECIAL', () => {
  /* RED WHEN: a person on a new laptop, with only their wallet's words and a different address, cannot open the company's keys, or opening them changes what is saved. */
  it('A SECOND DEVICE, FROM THE WORDS ALONE, AT ANOTHER ADDRESS, OPENS THE COMPANY\'S KEYS', async () => {
    /*
     * Device one creates a company and saves its keys. Device two is a
     * wallet REBUILT FROM THE SAME WORDS, at a DIFFERENT HOST, with nothing
     * carried across but what the server is holding - no keyring, no key, no
     * copy of device one. The key is the person's on this site, worked out from
     * the words and the person, and the host the page is served from is not part
     * of it.
     */
    const server = aServer();
    const { view: deviceOne, keyring } = await signedInWith(server);
    const accountId = await startedBy(deviceOne, keyring);
    const first = keyring.seatHeldHere(accountId)!;
    expect(server.bundle().keyBundle).toBeTruthy();

    /* Everything device one held is gone. This is the new laptop. */
    keyring.forgetLocally();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.seatHeldHere(accountId)).toBeNull();

    const { view: deviceTwo } = await signedInWith(server, FOUNDER_WORDS, FOUNDER_ADDRESS, ELSEWHERE);
    const writes = server.wrote().length;
    await keyring.openKeysWithWallet(WALLET, deviceTwo, ELSEWHERE);

    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.seatHeldHere(accountId)).toEqual(first);
    /* Opening wrote nothing. */
    expect(server.wrote()).toHaveLength(writes);

    /*
     * **AND THEY REALLY DO OPEN THE COMPANY, not merely match a fixture.** The
     * viewing key is wrapped to the founding signer's wrapping key on the account
     * record, so unwrapping it here is the last link in a chain that starts at
     * twenty-four words: words to the person's key, that key to the saved keys,
     * saved keys to the wrapping secret, wrapping secret to the key that reads
     * the company. Here the wallet's own read of the saved keys stands for it:
     * this tab never holds the wrapping secret.
     */
    const keys = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, deviceTwo.keyringAsks[0]!))!.accounts[accountId] as unknown as { wrappingSecret: string };
    const viewingKey = 'ff'.repeat(32);
    const forTheFounder = wrapKey(viewingKey, x25519PublicOf(keys.wrappingSecret));
    expect(unwrapKey(forTheFounder, keys.wrappingSecret)).toBe(viewingKey);
  });

  /* RED WHEN: another wallet in the same browser is handed the person's keys, or the page reads or writes anything because of it. */
  it('A DIFFERENT WALLET, ASKED FOR THE ADDRESS THIS TAB SIGNED IN AS, GIVES NOTHING', async () => {
    /*
     * A browser can hold more than one wallet. The founding signer signs in with theirs,
     * and a different wallet answers the question about their keys. That wallet
     * holds no account with the address this tab signed in as, so it builds no
     * answer at all - and nothing is read or written here.
     */
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    await startedBy(view, keyring);
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
    /* The tab read the sealed saved keys and the companies' served keys to hand them in, and wrote nothing. */
    expect(server.seen.slice(requestsBefore).map((r) => `${r.method} ${r.url}`), 'nothing was written').toEqual(['GET /api/me/keys', 'GET /api/accounts']);
  });

  /* RED WHEN: another wallet's key opens the person's keys, or starting a company from that tab saves over what the person had saved. */
  it('AND IN A TAB THAT DID NOT SIGN IN, A DIFFERENT WALLET\'S KEY OPENS NOTHING AND SAVES NOTHING', async () => {
    /*
     * After a reload the tab does not know which address it signed in as, so it
     * asks without one and a different wallet does give a key - its own. What is
     * saved is its own check: that key does not open it, so nothing is opened,
     * and nothing is ever saved over it from here.
     */
    const server = aServer();
    const { view, keyring } = await signedInWith(server);
    const accountId = await startedBy(view, keyring);
    keyring.forgetLocally();
    const savedBefore = JSON.stringify(server.bundle());
    const writesBefore = server.wrote().length;

    const somebodyElse = new WalletAtTheOtherEnd(honestly(SOMEBODY_ELSE_WORDS, SOMEBODY_ELSE_ADDRESS));
    inABrowser(somebodyElse, server.fetchImpl);
    expect(await keyring.resumeSession()).toMatchObject({ id: PERSON });

    const failure = await keyring.openKeysWithWallet(WALLET, somebodyElse, US).catch((e: unknown) => e);
    /* RED WHEN: a wallet whose key does not open the saved keys answers anything: it opens them itself and refuses. */
    expect(failure).toBeInstanceOf(Error);
    expect(somebodyElse.keyringAsks[0]?.signedInAs, 'the tab did not know the address').toBeNull();
    expect(somebodyElse.refused).toEqual(['keys-did-not-open']);
    expect(somebodyElse.released, 'that wallet gave nothing').toHaveLength(0);
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.seatHeldHere(accountId)).toBeNull();

    /* And starting a company here does not save over what could not be opened: that wallet refuses to found over them. */
    await expect(keyring.startCompanyHeldFromTheStart(SOUTHWIND, WALLET, somebodyElse, US)).rejects.toThrow();
    expect(somebodyElse.refused).toEqual(['keys-did-not-open', 'keys-did-not-open']);
    expect(server.wrote()).toHaveLength(writesBefore);
    expect(server.createdCount()).toBe(1);
    expect(JSON.stringify(server.bundle())).toBe(savedBefore);
  });
});

describe('§5 - WHAT IS REFUSED, AND BEFORE WHAT', () => {
  /* RED WHEN: a person whose saved keys do not open with their wallet's key is let create a company anyway, or their saved keys are written over. */
  it('SAVED KEYS THAT DO NOT OPEN ARE REFUSED BEFORE ANY COMPANY IS CREATED', async () => {
    const theirs = seal(JSON.stringify({ accounts: {} }), 'ab'.repeat(32));
    const server = aServer({ saved: theirs });
    const { view, keyring } = await signedInWith(server);

    /* The wallet is handed them, does not open them, and founds nothing: it refuses on its own screen. */
    const failure = await keyring.startCompanyHeldFromTheStart(NORTHWIND, WALLET, view, US).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(view.refused).toEqual(['keys-did-not-open']);

    expect(journey, 'no company was created').not.toContain('POST /api/accounts');
    expect(server.createdCount()).toBe(0);
    expect(server.wrote(), 'nothing was saved over them').toHaveLength(0);
    expect(server.bundle().keyBundle).toEqual(theirs);
    expect(keyring.companiesBeingCreated()).toEqual([]);
    expect(keyring.canOpenCompanies()).toBe(false);
  });

  /* RED WHEN: a tab that never saw the sign-in saves a person's first keys under a key it could not check, or creates a company before saying so. */
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
      const keyring = await import('vaults-web-shared/keyring.js');
      expect(await keyring.resumeSession()).toMatchObject({ id: PERSON });
      expect(keyring.signedInWallet()).toBeNull();

      await expect(keyring.startCompanyHeldFromTheStart(NORTHWIND, WALLET, view, US))
        .rejects.toThrow(/nothing is saved for you here yet, and this tab did not sign you in/);

      expect(view.keyringAsks[0]?.signedInAs).toBeNull();
      expect(journey, 'no company was created').not.toContain('POST /api/accounts');
      expect(server.createdCount()).toBe(0);
      expect(server.wrote()).toHaveLength(0);
      expect(keyring.companiesBeingCreated()).toEqual([]);
    });

  /* RED WHEN: a save refused because the person was signed out is tried again, or the company is sent without its keys saved. */
  it('A SAVE REFUSED BECAUSE THE SIGN-IN ENDED IS NOT TRIED AGAIN, AND NOTHING IS SENT',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server, FOUNDER_WORDS, FOUNDER_ADDRESS, US,
        () => theSignInEndsOnTheFirstSave(server));

      const failure = await keyring.startCompanyHeldFromTheStart(NORTHWIND, WALLET, view, US).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(keyring.AuthError);
      expect(server.wrote(), 'exactly one save').toHaveLength(1);
      expect(server.reads(), 'nothing was read again').toBe(1);
      expect(server.createdCount(), 'and the company was never sent').toBe(0);
      expect(keyring.isSignedIn()).toBe(false);
    });

  it('A SAVE THAT DID NOT SEE WHAT ANOTHER DEVICE SAVED SINCE IS REFUSED, AND NOTHING IS SENT OR OVERWRITTEN',
    async () => {
      const server = aServer();
      let theView: WalletAtTheOtherEnd | null = null;
      const { view, keyring } = await signedInWith(server, FOUNDER_WORDS, FOUNDER_ADDRESS, US, (v) => {
        theView = v;
        return anotherDeviceSavesBeforeTheFirstSave(server, () => theView!);
      });

      /* RED WHEN: the save of the keys does not carry the version it read, so it overwrites what another device saved in between. */
      await expect(keyring.startCompanyHeldFromTheStart(NORTHWIND, WALLET, view, US))
        .rejects.toThrow(/changed on another device/);

      expect(server.createdCount(), 'the company was never sent').toBe(0);
      const inside = opened(server.bundle().keyBundle, theKeyringKey(FOUNDER_WORDS, view.keyringAsks[0]!));
      expect(Object.keys(inside?.accounts ?? {}), 'what the other device saved is kept').toEqual(['acc_elsewhere']);
    });

  /* RED WHEN: a tab that already holds the person's keys loses them, or writes over what is saved, when the saved keys are replaced by ones it cannot open. */
  it('A TAB ALREADY HOLDING THE KEY, WHOSE SAVED KEYS WERE REPLACED BY ONES IT CANNOT OPEN, REFUSES THEM AND KEEPS WHAT IT HOLDS',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      const accountId = await startedBy(view, keyring);
      const held = keyring.seatHeldHere(accountId);
      server.savedElsewhere(seal(JSON.stringify({ accounts: {} }), 'ab'.repeat(32)));
      const writes = server.wrote().length;

      /* The wallet opens the saved keys and refuses ones that do not open with its key. */
      const failure = await keyring.openKeysWithWallet(WALLET, view, US).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(view.refused).toContain('keys-did-not-open');
      expect(server.wrote(), 'nothing was saved over them').toHaveLength(writes);
      expect(keyring.seatHeldHere(accountId), 'what this tab holds is kept').toEqual(held);
    });

  /* RED WHEN: a tab accepts saved keys older than what it already read, and so loses the keys of a company it holds. */
  it('THE SAME TAB, WHEN WHAT IS SAVED IS OLDER THAN WHAT IT ALREADY READ, REFUSES IT AND KEEPS THE KEYS IT HOLDS',
    async () => {
      const server = aServer();
      const { view, keyring } = await signedInWith(server);
      const nothingYet = { ...server.bundle() };
      const accountId = await startedBy(view, keyring);
      const held = keyring.seatHeldHere(accountId);
      /* The server now answers from before the company's keys were saved. */
      server.goesBackTo(nothingYet);

      const asked = view.keyringAsks.length;
      const failure = await keyring.openKeysWithWallet(WALLET, view, US).catch((e: unknown) => e);
      /* RED WHEN: an older copy is handed on to the wallet as the saved keys, or taken in place of what this tab holds. */
      expect(failure).toBeInstanceOf(keyring.SavedKeysWentBack);
      expect((failure as Error).message).toMatch(/older than what this tab already read/);
      expect(view.keyringAsks).toHaveLength(asked);
      expect(keyring.seatHeldHere(accountId), 'what this tab holds is kept').toEqual(held);
    });
});
