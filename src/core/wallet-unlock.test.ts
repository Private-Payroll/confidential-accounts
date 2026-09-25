import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask, KeyringRequest, UnlockRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import {
  keyringKeyFor, keyringReleaseFor, releaseFor, unlockKeyFor,
} from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from './crypto.js';
import { MemoryStore } from './store.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import { AccountService, openAccount, sealAccount } from './account.js';
import { NoCompanyAddress, companyForSession } from './company-address.js';
import { KEYRING_PURPOSE, UNLOCK_PURPOSE, keyringAsk, unlockAsk } from './wallet-unlock.js';
import {
  askWalletForKeys, askWalletToUnlock, askWalletToUnlockAndWhereItReads, UnlockRefused,
} from '../web/wallet-unlock.js';
import type { Openable } from '../web/wallet-sign-in.js';

/**
 * **THE WINDOW `inABrowser` INSTALLED, HANDED IN BY NAME.** The product now shows
 * the wallet inside the page by default, and a journey with no frame on the page
 * refuses to open one. These cases model a wallet at the other end of a window
 * and install it as `window`, so they pass that window explicitly rather than
 * relying on a default that no longer reaches it.
 */
const thisBrowsersWindow = () => (globalThis as { window?: unknown }).window as never;


/**
 * **THE WALLET OPENS THE BOX THE PASSWORD USED TO.** `docs/NEXT.md` PI2a,
 * `docs/scope-payroll-identity.md` §9 and §9b.
 *
 * ── EVERY KEY IN THIS FILE IS A REAL RELEASED KEY ─────────────────────────
 *
 * `identityFromWords`, `parseAsk` and `releaseFor` are imported from the
 * wallet's own package, resolved through its `exports`. So the wallet side of
 * every conversation below is the wallet's code: its parser sees the ask this
 * product actually builds, its derivation produces the bytes, and this side
 * checks them with `readRelease` — which also ships from there. **Nothing here
 * is a fixture shaped like a key.** That is the point of depending on the
 * package rather than describing it: if the two sides ever disagreed about a
 * byte, this file is what would notice.
 *
 * ── AND THE HOSTS ARE REAL HOSTS ──────────────────────────────────────────
 *
 * `US` and `ELSEWHERE` are two complete origins. The second-device test is not
 * a second call on one host — it is the SAME company reached from a DIFFERENT
 * host by a wallet rebuilt from the same words, which is the property a derived
 * key buys and a stored one never did.
 */

const US = 'https://payroll.example';
const ELSEWHERE = 'https://payroll.self-hosted.example';
const WALLET = 'https://wallet.example';
const THEM = 'https://other-payroll.example';

/** Two companies, in the spelling the chain's own serialisation produces. */
const ACME = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

const NAME = 'Confidential Accounts';
/** The address a sign-in answer names, in the shape the wallet's parser accepts. */
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const RDNS = 'social.lemonade.confidential-accounts';
const AT = 1_756_000_000_000;

/* ---------------------------------------------------------------- *
 * A WALLET AT THE OTHER END OF A REAL CHANNEL.
 *
 * It answers with `releaseFor`, over the same `postMessage` conversation the
 * browser half drives: the ready ping first, then one ask, then one answer. The
 * origin the wallet OBSERVES is supplied to `parseAsk` the way `channel.ts`
 * supplies it — from the event, never from the message.
 * ---------------------------------------------------------------- */

class WalletAtTheOtherEnd implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  /** Everything this page posted to the wallet, for the asks to be read back. */
  readonly asked: unknown[] = [];
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };

  constructor(
    private readonly answer: (ask: Ask) => unknown,
    private readonly observing: string = US,
    private readonly walletOrigin: string = WALLET,
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
    this.handler?.({
      origin: this.walletOrigin, source: this.tab, data,
    } as unknown as MessageEvent);
  }

  private onAsk(message: unknown): void {
    this.asked.push(message);
    const ask = parseAsk(message, this.observing, AT);
    queueMicrotask(() => this.deliver(this.answer(ask)));
  }
}

const identity = identityFromWords(TEST_MNEMONIC);

/**
 * **THE WALLET ANSWERS AN UNLOCK OR IT ANSWERS NOTHING.** The parser returns
 * the union of all three kinds, and a wallet that released a key for whatever
 * it happened to be handed is the mistake `parseAsk` exists to make impossible.
 */
const asUnlock = (ask: Ask): UnlockRequest => {
  if (ask.kind !== 'unlock') throw new Error(`asked for a ${ask.kind}, not an unlock`);
  return ask;
};

/** The ordinary case: this wallet, this person, answering honestly. */
const honestly = (who = identity) => (ask: Ask) => releaseFor(who, asUnlock(ask), AT);

const unlock = (
  view: Openable, opts: { company?: string; atOrigin?: string } = {},
): Promise<Uint8Array> => askWalletToUnlock(view, WALLET, {
  company: opts.company ?? ACME,
  atOrigin: opts.atOrigin ?? US,
  name: NAME,
  rdns: RDNS,
  now: () => AT,
  nonce: 'nonce-one',
});

const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(UnlockRefused);
    return (e as UnlockRefused).code;
  }
  throw new Error('should have refused');
};

/** What a keyring actually holds. Sealed the way `keyring.ts` seals it. */
const A_KEYRING = JSON.stringify({
  accounts: {
    acc_1: {
      signerId: 'sgn_1', signingSecret: 'aa'.repeat(32),
      wrappingSecret: 'bb'.repeat(32), blinding: 'cc'.repeat(32), scope: 'ab'.repeat(32),
    },
  },
});

/* ======================================================================== */

describe('THE WALLET SAYS WHERE IT READS THE CHAIN, BESIDE THE KEY', () => {
  it('THE PAGE GETS BACK THE SAME KEY AND THE INDEXER THE WALLET NAMED, OR NONE', async () => {
    const indexer = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
    const ask = {
      company: ACME, atOrigin: US, name: NAME, rdns: RDNS, now: () => AT, nonce: 'nonce-one',
    };
    const naming = new WalletAtTheOtherEnd((a: Ask) => releaseFor(identity, asUnlock(a), AT, indexer));
    const both = await askWalletToUnlockAndWhereItReads(naming, WALLET, ask);
    /* RED WHEN the page drops what the wallet named, or the key changes because it was named. */
    expect(both.indexer).toEqual(indexer);
    expect(toHex(both.key)).toBe(toHex(await unlock(new WalletAtTheOtherEnd(honestly()))));
    const silent = await askWalletToUnlockAndWhereItReads(new WalletAtTheOtherEnd(honestly()), WALLET, ask);
    expect(silent.indexer).toBeNull();
  });
});

describe('§1 — THE BUNDLE OPENS WITH A KEY THE WALLET RELEASED', () => {
  it('THE KEY OPENS THE BUNDLE, AND NO PASSWORD IS ANYWHERE IN IT', async () => {
    const key = await unlock(new WalletAtTheOtherEnd(honestly()));

    expect(key).toHaveLength(32);
    /* Sealed under the released key, opened under the released key — the same
     * two functions `signIn` uses, which is what makes everything downstream
     * unable to tell the difference. */
    const bundle = seal(A_KEYRING, toHex(key));
    expect(JSON.parse(unseal(bundle, toHex(key))).accounts.acc_1.signingSecret)
      .toBe('aa'.repeat(32));
  });

  it('THE ASK NAMES NO ORIGIN AND ASKS FOR NOTHING — there is nowhere to put either', async () => {
    const view = new WalletAtTheOtherEnd(honestly());
    await unlock(view);

    const sent = view.asked[0] as Record<string, unknown>;
    expect(sent['kind']).toBe('unlock');
    expect(sent['company']).toBe(ACME);
    expect(sent['purpose']).toBe(UNLOCK_PURPOSE);
    /* The wallet refuses either by name. The builder has no parameter for one,
     * which is the same rule expressed where it cannot be forgotten. */
    expect(sent).not.toHaveProperty('wants');
    expect(sent['requester']).not.toHaveProperty('origin');
    expect(JSON.stringify(sent)).not.toContain(US);
  });

  it('A SECOND DEVICE OPENS THE SAME BUNDLE — derived, not stored, and not this host', async () => {
    /* Device one: this laptop, at our own host. */
    const first = await unlock(new WalletAtTheOtherEnd(honestly()));
    const bundle = seal(A_KEYRING, toHex(first));

    /*
     * Device two: a wallet REBUILT FROM THE SAME WORDS — no shared object, no
     * storage between them — answering an ask from a DIFFERENT HOST, with a
     * different nonce. Nothing about device one is available to it.
     */
    const rebuilt = identityFromWords(TEST_MNEMONIC);
    const second = await askWalletToUnlock(
      new WalletAtTheOtherEnd(honestly(rebuilt), ELSEWHERE),
      WALLET,
      {
        company: ACME, atOrigin: ELSEWHERE, name: NAME, rdns: RDNS,
        now: () => AT + 86_400_000, nonce: 'a-different-nonce',
      });

    expect(toHex(second)).toBe(toHex(first));
    expect(JSON.parse(unseal(bundle, toHex(second))).accounts.acc_1.blinding)
      .toBe('cc'.repeat(32));
  });

  it('AND A DIFFERENT COMPANY OPENS NOTHING — one leak does not reach another', async () => {
    const acme = await unlock(new WalletAtTheOtherEnd(honestly()));
    const other = await unlock(
      new WalletAtTheOtherEnd(honestly()), { company: OTHER });

    expect(toHex(other)).not.toBe(toHex(acme));
    expect(() => unseal(seal(A_KEYRING, toHex(acme)), toHex(other))).toThrow();
  });

  it('the released bytes are the wallet\'s own derivation and not something this side made',
    async () => {
      const key = await unlock(new WalletAtTheOtherEnd(honestly()));
      const ask = parseAsk(unlockAsk({
        name: NAME, rdns: RDNS, purpose: UNLOCK_PURPOSE,
        nonce: 'nonce-one', expiresAt: AT + 60_000, company: ACME,
      }), US, AT);
      expect(toHex(key)).toBe(toHex(unlockKeyFor(identity, asUnlock(ask))));
    });
});

describe('§2 — A RELEASE IS CHECKED HERE, BECAUSE NO SERVER EVER SEES IT', () => {
  it('A RELEASE FOR A DIFFERENT COMPANY IS REFUSED RATHER THAN USED', async () => {
    /*
     * The one only this side can catch. The wallet answered honestly about a
     * company; this page asked about another. Using it would seal records under
     * a key nobody will look for again.
     */
    const wrong = new WalletAtTheOtherEnd(
      ask => ({ ...(releaseFor(identity, asUnlock(ask), AT) as object), company: OTHER }));
    expect(await refusalOf(() => unlock(wrong))).toBe('company-mismatch');
  });

  it('A RELEASE ANSWERING AN EARLIER QUESTION IS REFUSED', async () => {
    const stale = new WalletAtTheOtherEnd(
      ask => ({ ...(releaseFor(identity, asUnlock(ask), AT) as object), nonce: 'an-older-nonce' }));
    expect(await refusalOf(() => unlock(stale))).toBe('nonce-mismatch');
  });

  it('A RELEASE MINTED FOR ANOTHER PAYROLL IS REFUSED HERE', async () => {
    /* The wallet observed `THEM`, so it released to `THEM`; this page is `US`. */
    const theirs = new WalletAtTheOtherEnd(honestly(), THEM);
    expect(await refusalOf(() => unlock(theirs, { atOrigin: US })))
      .toBe('origin-mismatch');
  });

  it('and something that is not a release at all is refused by name', async () => {
    const junk = new WalletAtTheOtherEnd(() => ({ schema: 'something-else' }));
    expect(await refusalOf(() => unlock(junk))).toBe('not-a-release');
  });
});

describe('§2 — THE COMPANY COMES FROM THE SESSION, NEVER FROM THE REQUEST', () => {
  /*
   * **EVERY COMPANY IN THIS BLOCK IS A SIMULATED ONE, AND SINCE AN ADDRESS NO
   * CHAIN ASSIGNED IS REFUSED, THAT HAS TO BE SAID OUT LOUD.**
   *
   * `SimulatedLedger` mints an address shaped exactly like a chain's, so
   * `companyForSession` now refuses it unless the process was started to
   * allow it. These assertions are unchanged and are about a different rule —
   * whose company is served, and what happens when there is none. What changed
   * is that the world they run in must declare itself, which is what
   * `company-address-source.test.ts` exists to hold this side of.
   */
  beforeEach(() => { vi.stubEnv('ALLOW_SIMULATED_COMPANY_ADDRESS', '1'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  const world = () => {
    const store = new MemoryStore();
    const ledger = new SimulatedLedger(SimulatedCommitments);
    return {
      store, ledger, accounts: new AccountService(store, ledger, SimulatedCommitments) };
  };

  it('THE ADDRESS IS THE LEDGER\'S OWN, NOT ONE MINTED ON THIS SIDE', async () => {
    const { store, ledger, accounts } = world();
    const made = await accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_1' }], 1);

    /*
     * Asserted against the ledger rather than against a shape. A value that
     * merely LOOKS like a contract address is exactly what minting one on this
     * side would produce, which is not the same thing at all.
     */
    /* The ledger answers with the address AND where it came from, so the value
     * to compare against is `.value`. The claim is unchanged — this address is
     * the ledger's own and was not minted on this side. */
    expect(made.account.contractAddress).toBe((await ledger.address(made.account.id))?.value);
    expect(made.account.contractAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(companyForSession(store, 'usr_1', made.account.id))
      .toBe(made.account.contractAddress);
  });

  it('SOMEBODY ELSE\'S COMPANY IS NOT FOUND, AND SO IS A COMPANY THAT DOES NOT EXIST',
    async () => {
      const { store, accounts } = world();
      const made = await accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_1' }], 1);

      const refused = (run: () => unknown): string => {
        try { run(); } catch (e) {
          expect(e).toBeInstanceOf(NoCompanyAddress);
          return (e as NoCompanyAddress).code;
        }
        throw new Error('should have refused');
      };
      /* The same answer for both, or this route enumerates account ids. */
      expect(refused(() => companyForSession(store, 'usr_2', made.account.id)))
        .toBe('company-not-yours');
      expect(refused(() => companyForSession(store, 'usr_1', 'acc_nope')))
        .toBe('company-not-yours');
      expect(String(refused(() => companyForSession(store, 'usr_2', made.account.id))))
        .not.toContain(made.account.contractAddress);
    });

  it('A COMPANY WITH NO ADDRESS REFUSES BY NAME RATHER THAN SUBSTITUTING ONE', async () => {
    const { store, accounts } = world();
    const made = await accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_1' }], 1);
    /* A company created before this field existed, or on a ledger with no
     * contract for it. */
    store.putAccount({ ...store.getAccount(made.account.id)!, contractAddress: null });

    try {
      companyForSession(store, 'usr_1', made.account.id);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(NoCompanyAddress);
      expect((e as NoCompanyAddress).code).toBe('company-not-on-a-chain');
    }
  });

  it('THE ADDRESS SURVIVES A RE-SEAL — losing it would be losing the data', async () => {
    /*
     * `save()` rebuilds the stored record from an opened account on every
     * write. A readable field that does not round-trip is written once and
     * dropped by the next roster edit — and this one is what the key is derived
     * from, so dropping it loses every payslip that was sealed under it.
     */
    const { store, accounts } = world();
    const made = await accounts.create('Acme', [{ name: 'Ada', role: 'admin', userId: 'usr_1' }], 1);

    /*
     * The address is put there INDEPENDENTLY of the write path being tested.
     * Comparing the re-sealed record against the stored one would compare two
     * values the same line produced, and would agree just as happily when that
     * line writes nothing at all — which is the mutation this is for.
     */
    const known = 'de'.repeat(32);
    store.putAccount({ ...store.getAccount(made.account.id)!, contractAddress: known });
    const rec = store.getAccount(made.account.id)!;

    const round = sealAccount(
      openAccount(rec, made.viewingKey), made.viewingKey, rec.pendingSigners, rec.keyEpoch);
    expect(round.contractAddress).toBe(known);
  });
});

describe('§3 — THE KEY IS IN NO LOG, NO URL AND NO STORED FIELD', () => {
  /**
   * **A GREP RUN OVER THE SOURCE THAT HANDLES THE KEY.**
   *
   * A runtime capture (in `keyring.test`-shaped form below) proves what one
   * journey did; this proves the shape of every journey. Both are here because
   * neither alone is the claim: *the server never holds the released key.*
   */
  const sourceOf = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  /** Comments are allowed to say the words. Code is what is being asserted about. */
  const codeOf = (p: string) =>
    sourceOf(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('nothing on the unlock path writes to a log or to browser storage', () => {
    for (const file of ['../web/wallet-unlock.ts', '../web/keyring.ts', './wallet-unlock.ts']) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(code, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it('THE SERVER SIDE NEVER NAMES A RELEASED KEY AT ALL', () => {
    /*
     * The route hands back a public chain address and nothing else. If a key
     * ever became something this server received, `readRelease`, `unlockKeyFor`
     * or the release schema would have to appear here first.
     */
    expect(codeOf('../server/index.ts')).not.toMatch(/readRelease|unlockKeyFor|unlock-release/);
    expect(codeOf('./company-address.ts')).not.toMatch(/readRelease|unlockKeyFor|unlock-release/);
  });

  it('and the key is not put in the URL, because the URL is built from an account id', () => {
    const keyring = sourceOf('../web/keyring.ts');
    /* The one request the unlock path adds. Its path carries an account id and
     * its body is not sent at all. */
    expect(keyring).toContain('await api(`/api/accounts/${accountId}/unlock`');
    expect(keyring).not.toMatch(/api\(`[^`]*\$\{ek\}/);
  });
});

describe('§3 — AND THE SAME THING PROVED BY WATCHING, NOT BY READING', () => {
  /**
   * **EVERY BYTE THIS TAB EVER HANDED THE SERVER, RECORDED AND SEARCHED.**
   *
   * The whole journey a person makes: sign in with the wallet, ask which
   * company may be opened, ask the wallet to release its key, open the bundle.
   * The transport underneath is a recorder — every URL, every method, every
   * body — and the assertion is that **the released key appears in none of
   * them**, in neither its raw nor its hex spelling.
   *
   * A source grep says the code has no line that would send it. This says the
   * journey did not send it, which is the claim actually being made.
   */
  it('THE SERVER IS NEVER HANDED THE RELEASED KEY, in any spelling', async () => {
    const ask = parseAsk(keyringAsk({
      name: NAME, rdns: RDNS, purpose: KEYRING_PURPOSE,
      nonce: 'n', expiresAt: AT + 60_000, person: 'usr_1', signedInAs: SIGNED_IN, company: null,
    }), US, AT) as KeyringRequest;
    const releasedHex = toHex(keyringKeyFor(identity, ask));

    const view = new WalletAtTheOtherEnd(
      a => (a.kind === 'keyring'
        ? keyringReleaseFor(identity, a, AT, held => held === SIGNED_IN)
        : { schema: 'a-sign-in' }));

    const seen: Array<{ url: string; method: string; body: string }> = [];
    const answers: Record<string, unknown> = {
      'POST /api/auth/wallet/challenge': {
        nonce: 'sign-in-nonce', handle: 'h', expiresAt: new Date(AT + 60_000).toISOString(),
      },
      'POST /api/auth/wallet': {
        session: { token: 'tok' }, address: SIGNED_IN, created: true,
        user: { id: 'usr_1', email: null, name: '' },
      },
      'GET /api/me/keys': { keyBundle: seal(A_KEYRING, releasedHex), version: 7 },
    };

    const realFetch = globalThis.fetch;
    const realWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = Object.assign(view, {
      location: { origin: US },
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET');
      const body = init?.body === undefined ? '' : String(init.body);
      seen.push({ url: String(url), method, body });
      const answer = answers[`${method} ${url}`];
      if (answer === undefined) throw new Error(`no stub for ${method} ${url}`);
      return { ok: true, status: 200, json: async () => answer } as Response;
    }) as typeof fetch;

    try {
      const keyring = await import('../web/keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
      expect(keyring.canOpenCompanies()).toBe(false);

      await keyring.openKeysWithWallet(WALLET, view, US);

      /* It opened, so the key really is the key. A test that proved only
       * absence would pass just as well if nothing had happened at all. */
      expect(keyring.canOpenCompanies()).toBe(true);
      expect(keyring.keysFor('acc_1')?.signingSecret).toBe('aa'.repeat(32));

      const everything = JSON.stringify(seen);
      expect(everything).not.toContain(releasedHex);
      expect(everything).not.toContain(releasedHex.toUpperCase());
      expect(everything).not.toContain(Buffer.from(releasedHex, 'hex').toString('base64'));
      /* Opening the keys names no company to the server at all. */
      expect(seen.some(r => r.url.endsWith('/unlock'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
    }
  });
});

describe('§4 - THE KEYS SAVED FOR A PERSON OPEN WITH THE KEY THEIR WALLET GIVES FOR THEM', () => {
  const keysFor = (who = identity, holds: (a: string) => boolean = a => a === SIGNED_IN) =>
    (ask: Ask) => (ask.kind === 'keyring' ? keyringReleaseFor(who, ask, AT, holds) : { schema: 'x' });
  const askForKeys = (
    view: Openable,
    opts: { person?: string; signedInAs?: string | null; company?: string | null; atOrigin?: string } = {},
  ) => askWalletForKeys(view, WALLET, {
    person: opts.person ?? 'usr_1',
    signedInAs: opts.signedInAs === undefined ? SIGNED_IN : opts.signedInAs,
    company: opts.company ?? null,
    atOrigin: opts.atOrigin ?? US,
    name: NAME, rdns: RDNS, now: () => AT, nonce: 'nonce-keys',
  });

  it('ONE KEY OPENS THE KEYS SAVED FOR EVERY COMPANY, AND IT IS NO COMPANY\'S KEY', async () => {
    const { key, companyKey } = await askForKeys(new WalletAtTheOtherEnd(keysFor()));
    expect(companyKey).toBeNull();
    const both = JSON.stringify({ accounts: {
      acc_1: JSON.parse(A_KEYRING).accounts.acc_1,
      acc_2: { signerId: 'sgn_2', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32), scope: 'ab'.repeat(32) },
    } });
    const bundle = seal(both, toHex(key));
    const opened = JSON.parse(unseal(bundle, toHex(key)));
    expect(Object.keys(opened.accounts).sort()).toEqual(['acc_1', 'acc_2']);
    const acme = await unlock(new WalletAtTheOtherEnd(honestly()));
    expect(toHex(acme)).not.toBe(toHex(key));
    expect(() => unseal(bundle, toHex(acme))).toThrow();
  });

  it('THE ASK NAMES THE PERSON AND THE SIGNED-IN ADDRESS, AND NO ORIGIN', async () => {
    const view = new WalletAtTheOtherEnd(keysFor());
    await askForKeys(view);
    const sent = view.asked[0] as Record<string, unknown>;
    expect(sent['kind']).toBe('keyring');
    expect(sent['person']).toBe('usr_1');
    expect(sent['signedInAs']).toBe(SIGNED_IN);
    expect(sent['purpose']).toBe(KEYRING_PURPOSE);
    expect(sent).not.toHaveProperty('company');
    expect(sent).not.toHaveProperty('wants');
    expect(sent['requester']).not.toHaveProperty('origin');
    /* A tab that does not know its address says nothing rather than something empty. */
    const unknown = new WalletAtTheOtherEnd(keysFor());
    await askForKeys(unknown, { signedInAs: null });
    expect(unknown.asked[0]).not.toHaveProperty('signedInAs');
  });

  it('A SECOND DEVICE AND ANOTHER HOST GET THE SAME KEY; ANOTHER PERSON DOES NOT', async () => {
    const first = await askForKeys(new WalletAtTheOtherEnd(keysFor()));
    const second = await askWalletForKeys(
      new WalletAtTheOtherEnd(keysFor(identityFromWords(TEST_MNEMONIC)), ELSEWHERE), WALLET, {
        person: 'usr_1', signedInAs: SIGNED_IN, company: null, atOrigin: ELSEWHERE,
        name: NAME, rdns: RDNS, now: () => AT + 86_400_000, nonce: 'another',
      });
    expect(toHex(second.key)).toBe(toHex(first.key));
    const other = await askForKeys(new WalletAtTheOtherEnd(keysFor()), { person: 'usr_2' });
    expect(toHex(other.key)).not.toBe(toHex(first.key));
  });

  it('A WALLET THAT DOES NOT HOLD THE SIGNED-IN ADDRESS GIVES NOTHING', () => {
    const ask = parseAsk(keyringAsk({
      name: NAME, rdns: RDNS, purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: AT + 60_000,
      person: 'usr_1', signedInAs: SIGNED_IN, company: null,
    }), US, AT) as KeyringRequest;
    expect(() => keyringReleaseFor(identity, ask, AT, () => false)).toThrow(/none of this wallet's accounts/u);
  });

  it('WITH A COMPANY, THE SAME ANSWER CARRIES THAT COMPANY\'S ORDINARY KEY', async () => {
    const { key, companyKey } = await askForKeys(new WalletAtTheOtherEnd(keysFor()), { company: ACME });
    const acme = await unlock(new WalletAtTheOtherEnd(honestly()));
    expect(toHex(companyKey!)).toBe(toHex(acme));
    expect(toHex(key)).not.toBe(toHex(acme));
  });

  it('AN ANSWER FOR ANOTHER PERSON, ADDRESS, COMPANY OR PAGE IS REFUSED RATHER THAN USED', async () => {
    const tampered = (over: Record<string, unknown>) => new WalletAtTheOtherEnd(
      ask => ({ ...(keysFor()(ask) as object), ...over }));
    expect(await refusalOf(() => askForKeys(tampered({ person: 'usr_2' })))).toBe('person-mismatch');
    expect(await refusalOf(() => askForKeys(tampered({ signedInAs: null })))).toBe('person-mismatch');
    expect(await refusalOf(() => askForKeys(tampered({ nonce: 'old' })))).toBe('nonce-mismatch');
    expect(await refusalOf(() => askForKeys(new WalletAtTheOtherEnd(keysFor(), THEM)))).toBe('origin-mismatch');
    expect(await refusalOf(() => askForKeys(
      new WalletAtTheOtherEnd(ask => ({ ...(keysFor()(ask) as object), company: OTHER })), { company: ACME })))
      .toBe('company-mismatch');
  });
});

describe('§5 - A PAYSLIP KEY IS WORKED OUT ONLY FROM THIS COMPANY\'S KEY, FROM THE WALLET WHOSE KEYS ARE OPEN', () => {
  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;
  const other = identityFromWords(
    'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote');

  const journey = async (keysAnsweredBy: typeof identity) => {
    const personKey = toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
      name: NAME, rdns: RDNS, purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: AT + 60_000,
      person: 'usr_1', signedInAs: SIGNED_IN, company: null,
    }), US, AT) as KeyringRequest));
    let keyringAsks = 0;
    const view = new WalletAtTheOtherEnd((a) => {
      if (a.kind === 'sign-in') return { schema: 'a-sign-in' };
      if (a.kind === 'keyring') {
        keyringAsks += 1;
        /* The first answer opens the keys; the one asked with a company is the one under test. */
        const who = a.company === null ? identity : keysAnsweredBy;
        return keyringReleaseFor(who, a, AT, held => held === SIGNED_IN);
      }
      return { schema: 'a-payee-answer' };
    });
    const answers: Record<string, unknown> = {
      'POST /api/auth/wallet/challenge': { nonce: 's', handle: 'h', expiresAt: new Date(AT + 60_000).toISOString() },
      'POST /api/auth/wallet': { address: SIGNED_IN, created: true, user: { id: 'usr_1', email: null, name: '' } },
      'GET /api/me/keys': { keyBundle: seal(A_KEYRING, personKey), version: 3 },
      'POST /api/accounts/acc_1/unlock': { company: ACME },
      'POST /api/accounts/acc_1/payee-challenge': { nonce: 'p', handle: 'ph', expiresAt: new Date(AT + 60_000).toISOString() },
      'PUT /api/me/keys': { version: 4 },
    };
    (globalThis as { window?: unknown }).window = Object.assign(view, { location: { origin: US } });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const answer = answers[`${String(init?.method ?? 'GET')} ${url}`];
      if (answer === undefined) throw new Error(`no stub for ${String(init?.method ?? 'GET')} ${url}`);
      return { ok: true, status: 200, json: async () => answer } as Response;
    }) as typeof fetch;
    const keyring = await import('../web/keyring.js');
    keyring.forgetLocally();
    await keyring.signInWithWallet(WALLET, undefined, thisBrowsersWindow());
    await keyring.openKeysWithWallet(WALLET, view, US);
    return { keyring, view, personKey, asks: () => keyringAsks };
  };

  afterEach(async () => {
    const keyring = await import('../web/keyring.js');
    keyring.forgetLocally();
    globalThis.fetch = realFetch;
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  });

  it('THE KEY HANDED BACK IS THE COMPANY\'S OWN KEY FROM THIS WALLET, NOT THE KEY THE SAVED KEYS OPEN WITH', async () => {
    const { keyring, view, personKey, asks } = await journey(identity);
    const { companyKey, companyAddress, disclosure } = await keyring.payslipKeyAndPayeeAddress('acc_1', WALLET, view, US);
    expect(companyAddress).toBe(ACME);
    const expected = toHex(unlockKeyFor(identity, asUnlock(parseAsk(unlockAsk({
      name: NAME, rdns: RDNS, purpose: UNLOCK_PURPOSE, nonce: 'n', expiresAt: AT + 60_000, company: ACME,
    }), US, AT))));
    expect(companyKey).toBe(expected);
    expect(companyKey).not.toBe(personKey);
    expect(keyring.companyKeyReleasedFor('acc_1')).toBe(expected);
    expect(disclosure.handle).toBe('ph');
    /* And a second time asks the wallet for no key, only for where to pay. */
    const again = await keyring.payslipKeyAndPayeeAddress('acc_1', WALLET, view, US);
    expect(asks()).toBe(2);
    /* RED WHEN the company address the key came from is not handed back, first time or after. */
    expect(again.companyAddress).toBe(ACME);
  });

  it('A SIGNER WHO MAKES THEMSELVES PAYABLE HAS THEIR COMPANY ON THEIR OWN LIST, ONCE THE SERVICE TOOK IT', async () => {
    const { keyring, view, personKey } = await journey(identity);
    expect(keyring.companiesThatPayYou()).toEqual([]);
    /* A service that refuses: nothing goes on the list. */
    await expect(keyring.payYourselfHere('acc_1', WALLET, async () => { throw new Error('refused'); }, view, US))
      .rejects.toThrow('refused');
    expect(keyring.companiesThatPayYou()).toEqual([]);
    const sent: string[] = [];
    const answering = globalThis.fetch;
    const saved: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (`${String(init?.method ?? 'GET')} ${url}` === 'PUT /api/me/keys') saved.push(JSON.parse(String(init!.body)).keyBundle);
      return answering(url, init);
    }) as typeof fetch;
    await keyring.payYourselfHere('acc_1', WALLET, async (_key, d) => { sent.push(d.handle); }, view, US);
    expect(sent).toEqual(['ph']);
    /* RED WHEN a signer paid through self-payee is left off their own list of companies that pay them. */
    expect(keyring.companiesThatPayYou()).toEqual([ACME]);
    expect(saved).toHaveLength(1);
    expect(JSON.parse(unseal(saved[0] as never, personKey)).paidBy).toEqual([ACME]);
  });

  it('A LIST THAT CANNOT BE SAVED AFTER A SIGNER MADE THEMSELVES PAYABLE IS SAID, NOT SWALLOWED', async () => {
    const { keyring, view } = await journey(identity);
    const answering = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (`${String(init?.method ?? 'GET')} ${url}` === 'PUT /api/me/keys') {
        return { ok: false, status: 409, json: async () => ({ error: 'the keys changed on another device' }) } as Response;
      }
      return answering(url, init);
    }) as typeof fetch;
    /* RED WHEN the refused save is caught and dropped: the signer is paid and the company never reaches their list. */
    await expect(keyring.payYourselfHere('acc_1', WALLET, async () => {}, view, US))
      .rejects.toThrow(/changed on another device/);
    expect(keyring.companiesThatPayYou()).toEqual([]);
  });

  it('A DIFFERENT WALLET ANSWERING THE COMPANY\'S ASK IS REFUSED, AND NO COMPANY KEY IS KEPT', async () => {
    const { keyring, view } = await journey(other);
    await expect(keyring.payslipKeyAndPayeeAddress('acc_1', WALLET, view, US))
      .rejects.toThrow('gave a different key from the one this tab opened your saved keys with');
    expect(keyring.companyKeyReleasedFor('acc_1')).toBeNull();
    expect(keyring.canOpenCompanies()).toBe(true);
  });
});
