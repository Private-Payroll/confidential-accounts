import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Ask, UnlockRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { releaseFor, unlockKeyFor } from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from './crypto.js';
import { MemoryStore } from './store.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import { AccountService, openAccount, sealAccount } from './account.js';
import { NoCompanyAddress, companyForSession } from './company-address.js';
import { UNLOCK_PURPOSE, unlockAsk } from './wallet-unlock.js';
import { askWalletToUnlock, UnlockRefused } from '../web/wallet-unlock.js';
import type { Openable } from '../web/wallet-sign-in.js';

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
      wrappingSecret: 'bb'.repeat(32), blinding: 'cc'.repeat(32),
    },
  },
});

/* ======================================================================== */

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
   * **EVERY COMPANY IN THIS BLOCK IS A SIMULATED ONE, AND FROM `PI2b` THAT
   * HAS TO BE SAID OUT LOUD.**
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
     * side would produce, and `C136` is the row about why that is not the same
     * thing at all.
     */
    /* `PI2b`: the ledger answers with the address AND where it came from, so
     * the value to compare against is `.value`. The claim is unchanged — this
     * address is the ledger's own and was not minted on this side. */
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
    /* A company created before `PI2a`, or on a ledger with no contract for it. */
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
     * from, so dropping it is `C127` with a smaller radius.
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
   * **THE GREP THE ROUND ASKED FOR, RUN OVER THE SOURCE THAT HANDLES THE KEY.**
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
    /* The one request this round adds. Its path carries an account id and its
     * body is not sent at all. */
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
   * journey did not send it, which is the claim the round actually makes.
   */
  it('THE SERVER IS NEVER HANDED THE RELEASED KEY, in any spelling', async () => {
    const ask = parseAsk(unlockAsk({
      name: NAME, rdns: RDNS, purpose: UNLOCK_PURPOSE,
      nonce: 'n', expiresAt: AT + 60_000, company: ACME,
    }), US, AT);
    const releasedHex = toHex(unlockKeyFor(identity, asUnlock(ask)));

    const view = new WalletAtTheOtherEnd(
      a => (a.kind === 'unlock' ? releaseFor(identity, asUnlock(a), AT) : { schema: 'a-sign-in' }));

    const seen: Array<{ url: string; method: string; body: string }> = [];
    const answers: Record<string, unknown> = {
      'POST /api/auth/wallet/challenge': {
        nonce: 'sign-in-nonce', handle: 'h', expiresAt: new Date(AT + 60_000).toISOString(),
      },
      'POST /api/auth/wallet': {
        session: { token: 'tok' }, address: 'mn_shield-addr', created: true,
        user: { id: 'usr_1', email: null, name: '' },
      },
      'POST /api/accounts/acc_1/unlock': { company: ACME },
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
      await keyring.signInWithWallet(WALLET);
      expect(keyring.canOpenCompanies()).toBe(false);

      await keyring.unlockWithWallet('acc_1', WALLET, view, US);

      /* It opened, so the key really is the key. A test that proved only
       * absence would pass just as well if nothing had happened at all. */
      expect(keyring.canOpenCompanies()).toBe(true);
      expect(keyring.keysFor('acc_1')?.signingSecret).toBe('aa'.repeat(32));

      const everything = JSON.stringify(seen);
      expect(everything).not.toContain(releasedHex);
      expect(everything).not.toContain(releasedHex.toUpperCase());
      expect(everything).not.toContain(Buffer.from(releasedHex, 'hex').toString('base64'));
      /* And no request carried a body at all on the way to the company. */
      expect(seen.find(r => r.url.endsWith('/unlock'))!.body).toBe('');
    } finally {
      globalThis.fetch = realFetch;
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
    }
  });
});
