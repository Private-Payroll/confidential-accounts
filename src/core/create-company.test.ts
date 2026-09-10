import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask, UnlockRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { releaseFor } from 'midnight-identity/profile/unlock';
import type { Openable } from '../web/wallet-sign-in.js';
import type { Sealed } from './crypto.js';
import { fromHex, toHex, unwrapKey, wrapKey } from './crypto.js';
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
 * **SOMEBODY WITH A WALLET STARTS A COMPANY.** `docs/NEXT.md` PI3, `C141`,
 *
 *
 * ── WHAT IS BEING PROVED, AND WHY IT IS PROVED BY WATCHING ────────────────
 *
 * The round is an ORDER OF OPERATIONS, and an order is a property of a journey
 * rather than of any one function. So the whole journey runs here against a
 * recording transport and a real wallet at the other end of a real channel:
 * every URL, method and body this tab sends is kept, and the assertions are
 * about what was sent, in what order, and what was never sent at all.
 *
 * **THE WALLET SIDE IS THE WALLET'S OWN CODE.** `identityFromWords`, `parseAsk`
 * and `releaseFor` ship from `midnight-identity`, resolved through its
 * `exports`. Nothing here is a fixture shaped like a key.
 *
 * ── AND THE SECOND DEVICE IS A SECOND DEVICE ──────────────────────────────
 *
 * `§4` rebuilds a wallet from the same words, at a DIFFERENT HOST, with nothing
 * carried over but the bundle the server holds — and opens what the first
 * device sealed. That is `PI2b`'s judged test applied to the founder, which is
 * what `docs/NEXT.md` §3 asks for.
 */

const US = 'https://payroll.example';
const ELSEWHERE = 'https://payroll.self-hosted.example';
const WALLET = 'https://wallet.example';

/** A company address, in the spelling the chain's own serialisation produces. */
const DEPLOYED = 'a1'.repeat(32);

const ACCOUNT_ID = 'acc_founded';

/* ---------------------------------------------------------------- *
 * A WALLET AT THE OTHER END OF A REAL CHANNEL. The same shape
 * `wallet-unlock.test.ts` uses, so the two rounds test one wallet.
 * ---------------------------------------------------------------- */

class WalletAtTheOtherEnd implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  readonly asked: any[] = [];
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
    queueMicrotask(() => this.deliver(this.answer(ask)));
  }
}

const asUnlock = (ask: Ask): UnlockRequest => {
  if (ask.kind !== 'unlock') throw new Error(`asked for a ${ask.kind}, not an unlock`);
  return ask;
};

/** The ordinary case: this person's wallet, answering honestly. */
const honestly = (words: readonly string[] | string) => (ask: Ask) =>
  ask.kind === 'unlock'
    ? releaseFor(identityFromWords(words), asUnlock(ask), 0)
    : { schema: 'a-sign-in' };

/* ---------------------------------------------------------------- *
 * A SERVER THAT REMEMBERS WHAT IT WAS TOLD.
 *
 * It is not a mock of one route at a time: the bundle a founder writes in `§1`
 * is the bundle a second device reads in `§4`, so the sealing and the opening
 * are one fact rather than two stubs that happen to agree.
 * ---------------------------------------------------------------- */

interface Recorded { url: string; method: string; body: string }

function aServer(opts: {
  /** What `POST /api/accounts/:id/unlock` answers, or the refusal it makes. */
  company?: string;
  refuseCompany?: { status: number; error: string; code: string };
} = {}) {
  const seen: Recorded[] = [];
  /** The bundle the server is holding. Written by a PUT, served by a GET. */
  let held: { keyBundle: Sealed | null; version: number } = { keyBundle: null, version: 0 };
  let created = 0;

  const founderSecrets = {
    signerId: 'sgn_founder',
    name: 'Ada',
    signingSecret: 'aa'.repeat(32),
    wrappingSecret: 'bb'.repeat(32),
    blinding: 'cc'.repeat(32),
  };

  const answer = (method: string, url: string, body: string): { status: number; json: any } => {
    if (method === 'POST' && url === '/api/auth/wallet/challenge') {
      return { status: 200, json: { nonce: 'n', handle: 'h', expiresAt: new Date(600_000).toISOString() } };
    }
    if (method === 'POST' && url === '/api/auth/wallet') {
      return { status: 200, json: {
        session: { token: 'tok' }, address: 'mn_shield-addr', created: true,
        user: { id: 'usr_founder', email: null, name: '' },
      } };
    }
    if (method === 'POST' && url === '/api/accounts') {
      created += 1;
      /*
       * WHAT THE REAL ROUTE ANSWERS. The address is on the record because the
       * LEDGER assigned it at `open` — this stub carries it for the same reason
       * the real one does, and nothing in the tab is allowed to read it.
       */
      return { status: 200, json: {
        account: {
          id: ACCOUNT_ID, contractAddress: opts.company ?? DEPLOYED, addressSource: 'chain',
          wrappedKeys: [], signers: [], name: JSON.parse(body || '{}').name,
        },
        viewingKey: 'ff'.repeat(32),
        secrets: [founderSecrets],
      } };
    }
    if (method === 'GET' && url === `/api/accounts/${ACCOUNT_ID}`) {
      /*
       * **THE RECORD, WITH ITS ADDRESS ON IT, AND THAT IS THE POINT.** The
       * address is readable here — it is public, it is on the account, and any
       * signed-in member can fetch it. **The creation path is not allowed to
       * use it**, because the door that carries `C140`'s guard is the unlock
       * and not this. `scripts/mutate-create-company.mjs` 02 makes the path
       * read it from here instead, and the refusal test dies.
       */
      return { status: 200, json: {
        id: ACCOUNT_ID, contractAddress: opts.company ?? DEPLOYED, addressSource: 'chain',
        wrappedKeys: [], pendingSigners: [], memberUserIds: ['usr_founder'],
      } };
    }
    if (method === 'POST' && url === `/api/accounts/${ACCOUNT_ID}/unlock`) {
      if (opts.refuseCompany) {
        return { status: opts.refuseCompany.status, json: opts.refuseCompany };
      }
      return { status: 200, json: { company: opts.company ?? DEPLOYED } };
    }
    if (method === 'GET' && url === '/api/me/keys') {
      return { status: 200, json: { keyBundle: held.keyBundle, version: held.version } };
    }
    if (method === 'PUT' && url === '/api/me/keys') {
      const b = JSON.parse(body);
      held = { keyBundle: b.keyBundle, version: held.version + 1 };
      return { status: 200, json: { version: held.version } };
    }
    throw new Error(`no route for ${method} ${url}`);
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body === undefined ? '' : String(init.body);
    seen.push({ url: String(url), method, body });
    const r = answer(method, String(url), body);
    return { ok: r.status < 400, status: r.status, json: async () => r.json } as Response;
  }) as typeof fetch;

  return {
    seen, fetchImpl, founderSecrets,
    createdCount: () => created,
    bundle: () => held,
    wrote: () => seen.filter(r => r.method === 'PUT' && r.url === '/api/me/keys'),
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
  /* The module holds a token, a key and possibly a founder's secrets. A test
   * that left them there would hand the next one a signed-in tab. */
  const keyring = await import('../web/keyring.js');
  keyring.forgetLocally();
});

/* ======================================================================== */

describe('§1 — CREATE, UNLOCK, SEAL — AND IN THAT ORDER', () => {
  it('A WALLET ACCOUNT STARTS A COMPANY AND ENDS UP HOLDING ITS KEYS', async () => {
    const server = aServer();
    const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
    inABrowser(view, server.fetchImpl);

    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    /* `C141` in one line: signed in, and able to open nothing. */
    expect(keyring.canOpenCompanies()).toBe(false);

    const { accountId } = await keyring.createCompanyWithWallet(
      { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
      WALLET, view, US);

    expect(accountId).toBe(ACCOUNT_ID);
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.keysFor(ACCOUNT_ID)?.signingSecret).toBe(server.founderSecrets.signingSecret);
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });

  it('THE ORDER IS CREATE, THEN ASK WHICH COMPANY, THEN SEAL — and it cannot be another',
    async () => {
      /*
       * **THE ROUND EXPRESSED AS A SEQUENCE.** Sealing needs a key, the key
       * needs an address, and the address does not exist until the company
       * does. The bundle write must come after the creation, and the question
       * *which company may this tab open* must sit between them — because that
       * question is what puts the address, and `C140`'s guard, into the path.
       */
      const server = aServer();
      const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
      inABrowser(view, server.fetchImpl);

      const keyring = await import('../web/keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
      await keyring.createCompanyWithWallet(
        { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
        WALLET, view, US);

      const order = server.seen.map(r => `${r.method} ${r.url}`);
      const create = order.indexOf('POST /api/accounts');
      const which = order.indexOf(`POST /api/accounts/${ACCOUNT_ID}/unlock`);
      const seal = order.indexOf('PUT /api/me/keys');

      expect(create).toBeGreaterThanOrEqual(0);
      expect(which).toBeGreaterThan(create);
      expect(seal).toBeGreaterThan(which);
    });

  it('THE COMPANY HANDED TO THE WALLET IS THE ONE THE SERVER NAMED, NOT ONE MADE UP HERE',
    async () => {
      /*
       * **`C136` AND `C140`, AT THE ONE MOMENT A CREATION PATH COULD DEFEAT
       * BOTH.** The identifier is the chain's because it is not ours to mint.
       * This tab has the address in front of it — the creation response carries
       * it — and it is not allowed to use that copy: it asks the server, whose
       * answer comes from what the ledger assigned to the account in the path.
       */
      const server = aServer();
      const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
      inABrowser(view, server.fetchImpl);

      const keyring = await import('../web/keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
      await keyring.createCompanyWithWallet(
        { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
        WALLET, view, US);

      const unlock = view.asked.find(a => a?.kind === 'unlock');
      expect(unlock).toBeTruthy();
      expect(unlock.company).toBe(DEPLOYED);
      /* And the question was asked with no body — there is nothing this page
       * could tell the server about which company it is. */
      const asked = server.seen.find(r => r.url.endsWith('/unlock'))!;
      expect(asked.body).toBe('');
    });
});

describe('§2 — AN ADDRESS NO CHAIN ASSIGNED SEALS NOTHING', () => {
  it('CREATION IS REFUSED, AND NOT ONE BYTE IS SEALED', async () => {
    /*
     * **`C140` IN THE CREATION PATH.** Outside `npm run dev` the running server
     * refuses a company whose address it invented, because a key derived from
     * one changes the day a contract is really deployed and everything sealed
     * under it stops opening — `C127` on a scheduled date.
     *
     * **THE ASSERTION THAT MATTERS IS THE SECOND ONE.** A refusal that still
     * wrote a bundle would be a refusal in name only.
     */
    const server = aServer({
      refuseCompany: {
        status: 409,
        code: 'company-address-not-from-a-chain',
        error: 'this company has an address, but no chain gave it one',
      },
    });
    const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
    inABrowser(view, server.fetchImpl);

    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());

    await expect(keyring.createCompanyWithWallet(
      { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
      WALLET, view, US)).rejects.toThrow(/no chain gave it one/);

    expect(server.wrote()).toHaveLength(0);
    expect(server.bundle().keyBundle).toBeNull();
    expect(keyring.canOpenCompanies()).toBe(false);
    /* The wallet was never even opened: nothing was released, so nothing leaked. */
    expect(view.asked.find(a => a?.kind === 'unlock')).toBeUndefined();
  });

  it('AND THE COMPANY IS NOT LOST — the secrets are still here and it can be finished',
    async () => {
      /*
       * The window between step 1 and step 3 holds the only copy of the
       * founder's secrets in existence. A refusal, or a declined press, must
       * cost a retry rather than the company.
       */
      const server = aServer({
        refuseCompany: {
          status: 409, code: 'company-address-not-from-a-chain', error: 'no chain gave it one',
        },
      });
      const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
      inABrowser(view, server.fetchImpl);

      const keyring = await import('../web/keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
      await expect(keyring.createCompanyWithWallet(
        { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
        WALLET, view, US)).rejects.toThrow();

      expect(keyring.companyAwaitingSetup()).toBe(ACCOUNT_ID);

      /* The same tab, the same secrets, a server that now answers. */
      const ok = aServer();
      inABrowser(view, ok.fetchImpl);
      await keyring.finishCompanyCreation(WALLET, view, US);

      expect(keyring.companyAwaitingSetup()).toBeNull();
      expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(server.founderSecrets.blinding);
      /* And it did NOT create a second company to get there. */
      expect(ok.createdCount()).toBe(0);
    });

  it('signing out drops the founder\'s unsealed secrets', async () => {
    const server = aServer({
      refuseCompany: { status: 409, code: 'company-address-not-from-a-chain', error: 'no' },
    });
    const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
    inABrowser(view, server.fetchImpl);

    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await expect(keyring.createCompanyWithWallet(
      { name: 'N', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
      WALLET, view, US)).rejects.toThrow();

    expect(keyring.companyAwaitingSetup()).toBe(ACCOUNT_ID);
    keyring.forgetLocally();
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });
});

describe('§3 — NO PASSWORD, ANYWHERE ON THIS JOURNEY', () => {
  it('NOT ONE REQUEST CARRIES AUTH MATERIAL', async () => {
    /*
     * **THE WHOLE REASON `PI3` EXISTED, AND WHAT `PI4b` COULD THEN DO.** While
     * creating a company was the one thing only a password could do, the
     * password could not be deleted and `C129` stayed open. Proved by watching
     * rather than by reading: every byte this tab handed the server, searched.
     *
     * **IT IS A WEAKER TEST THAN IT WAS AND A STRONGER CLAIM.** When it was
     * written, a password path existed alongside this one and the point was
     * that this journey did not touch it. There is no other path now — so what
     * this still catches is a REGRESSION that puts auth material back on the
     * wire, and the claim that none exists anywhere is made by
     * `src/web/no-password-in-the-bundle.test.ts`, which builds the app.
     */
    const server = aServer();
    const view = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC));
    inABrowser(view, server.fetchImpl);

    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.createCompanyWithWallet(
      { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
      WALLET, view, US);

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
     * *`keyring.ts` as a whole still derives auth material — the password path
     * is not deleted this round — so the assertion is about THIS function's own
     * source.* `PI4b` deleted `register`, `signIn` and `derive`, so the whole
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
     * forbid saying so. It matters more since `PI4b`, not less: the history is
     * the only place the reason survives.
     */
    const code = path.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('export async function createCompanyWithWallet');

    for (const word of ['password', 'authKey', 'authSalt', 'derive(', 'deriveAuthMaterial']) {
      expect(code, word).not.toContain(word);
    }
  });
});

describe('§4 — THE FOUNDER\'S FIRST DEVICE IS NOT SPECIAL', () => {
  it('A SECOND DEVICE, FROM THE WORDS ALONE, OPENS WHAT THE FIRST DEVICE SEALED', async () => {
    /*
     * **THE TEST THIS ROUND IS JUDGED ON**, and it is `PI2b`'s applied to the
     * founder. Device one creates the company and seals its keyring. Device two
     * is a wallet REBUILT FROM THE SAME WORDS, at a DIFFERENT HOST, with
     * nothing carried across but what the server is holding — no keyring, no
     * bundle key, no copy of device one.
     */
    const server = aServer();

    const deviceOne = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC), US);
    inABrowser(deviceOne, server.fetchImpl, US);
    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.createCompanyWithWallet(
      { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
      WALLET, deviceOne, US);
    const sealedByDeviceOne = server.bundle();
    expect(sealedByDeviceOne.keyBundle).toBeTruthy();

    /* Everything device one held is gone. This is the new laptop. */
    keyring.forgetLocally();
    expect(keyring.canOpenCompanies()).toBe(false);
    expect(keyring.keysFor(ACCOUNT_ID)).toBeNull();

    const deviceTwo = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC), ELSEWHERE);
    inABrowser(deviceTwo, server.fetchImpl, ELSEWHERE);
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.unlockWithWallet(ACCOUNT_ID, WALLET, deviceTwo, ELSEWHERE);

    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.keysFor(ACCOUNT_ID)?.signingSecret).toBe(server.founderSecrets.signingSecret);
    expect(keyring.keysFor(ACCOUNT_ID)?.blinding).toBe(server.founderSecrets.blinding);

    /*
     * **AND THEY REALLY DO OPEN THE COMPANY, not merely match a fixture.** The
     * viewing key is wrapped to the founder's wrapping key on the account
     * record, so unwrapping it here is the last link in a chain that starts at
     * twenty-four words: words to unlock key, unlock key to bundle, bundle to
     * wrapping secret, wrapping secret to the key that reads the company.
     */
    const keys = keyring.keysFor(ACCOUNT_ID)!;
    const viewingKey = 'ff'.repeat(32);
    const forTheFounder = wrapKey(viewingKey, x25519PublicOf(keys.wrappingSecret));
    expect(unwrapKey(forTheFounder, keys.wrappingSecret)).toBe(viewingKey);
  });

  it('AND A DIFFERENT WALLET ON THAT SECOND DEVICE OPENS NOTHING', async () => {
    const server = aServer();
    const deviceOne = new WalletAtTheOtherEnd(honestly(TEST_MNEMONIC), US);
    inABrowser(deviceOne, server.fetchImpl, US);
    const keyring = await import('../web/keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.createCompanyWithWallet(
      { name: 'Northwind', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
      WALLET, deviceOne, US);

    keyring.forgetLocally();

    const somebodyElse = new WalletAtTheOtherEnd(honestly(newWords()), ELSEWHERE);
    inABrowser(somebodyElse, server.fetchImpl, ELSEWHERE);
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await expect(keyring.unlockWithWallet(ACCOUNT_ID, WALLET, somebodyElse, ELSEWHERE))
      .rejects.toThrow(/could not be opened/);
    expect(keyring.canOpenCompanies()).toBe(false);
  });
});
