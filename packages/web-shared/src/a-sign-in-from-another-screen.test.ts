import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { toHex, unseal } from '../../../src/core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../../../src/core/wallet-unlock.js';
import * as keyring from './keyring.js';
import type { Openable } from './wallet-sign-in.js';

/**
 * **A PERSON SIGNED IN BY ANOTHER SCREEN CAN SAVE THEIR FIRST KEYS, AND ONLY
 * UNDER THE WALLET THAT HOLDS THE ADDRESS THEY SIGNED IN AS.**
 *
 * A screen that signs in with its own code hands the keyring the service's
 * answer to that sign-in. From then on the keyring is where it would be after
 * signing in itself: the wallet is asked for the key naming the address the
 * answer carried, and a person's first keys are saved under that key. A
 * wallet that does not hold the address gives no key, and nothing is created
 * or saved.
 *
 * The wallet at the other end is the wallet's own code answering over the real
 * conversation, as in the legacy application's test of the same rule.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const ANOTHER = 'mn_addr_test1zzzzzzzzzzzzzzzzzzzz';
const PERSON = 'usr_1';
const identity = identityFromWords(TEST_MNEMONIC);

/** A wallet that gives the keyring key only for an address it holds, and records the address each ask named. */
class WalletAtTheOtherEnd implements Openable {
  readonly askedFor: (string | null)[] = [];
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  constructor(
    private readonly holds: (address: string) => boolean = (address) => address === SIGNED_IN,
    private readonly who: Identity = identity,
  ) {}
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void {
    this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent);
  }
  private onAsk(message: unknown): void {
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      if (ask.kind === 'keyring') this.askedFor.push((ask as KeyringRequest).signedInAs ?? null);
      answer = ask.kind === 'keyring' ? keyringReleaseFor(this.who, ask as KeyringRequest, Date.now(), this.holds) : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** The keyring key the wallet above gives this person. */
const keyringHex = () => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person: PERSON, signedInAs: null, company: null, account: null,
}), US, Date.now()) as KeyringRequest));

const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const USER = { id: PERSON, email: null, name: 'Priya' };
/** The service's answer to a sign-in, as the other screen received it. */
const answerFor = (address: string) => ({ user: USER, address, created: true, session: {} });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

/** A service with nothing saved for this person, answering the routes a first company uses. */
function nothingSavedYet() {
  const posted: { route: string; body: any }[] = [];
  let saved: unknown = null;
  let version = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ route, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me': return json(200, { user: USER, accounts: [] });
      case 'GET /api/me/keys': return json(200, { keyBundle: saved, version });
      case 'PUT /api/me/keys': saved = body.keyBundle; version += 1; return json(200, { version });
      case 'POST /api/accounts': return json(200, {
        account: { id: 'acc_new' },
        secrets: [{ signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32), scope: 'ab'.repeat(32) }],
      });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return { sent: (route: string) => posted.filter((p) => p.route === route) };
}

describe('a sign-in handed over by another screen', () => {
  /* RED WHEN: the keyring does not take the address from the answer handed over (it is left unset, or taken from anywhere but that answer), so a person's first company is refused in the screen that signed them in. */
  it('lets a person with nothing saved create their first company, and saves its keys under the wallet that holds their address', async () => {
    const { sent } = nothingSavedYet();
    expect(keyring.signedInByAnotherScreen(answerFor(SIGNED_IN))).toEqual(USER);
    expect(keyring.signedInWallet()).toBe(SIGNED_IN);
    const wallet = new WalletAtTheOtherEnd();
    expect(await keyring.createCompanyWithWallet(A_COMPANY, WALLET, wallet, US)).toEqual({ accountId: 'acc_new' });
    expect(wallet.askedFor).toEqual([SIGNED_IN]);
    expect(sent('POST /api/accounts')).toHaveLength(1);
    const writes = sent('PUT /api/me/keys');
    expect(writes).toHaveLength(1);
    /* Sealed under the key of the wallet that holds the address signed in as, and nothing else opens it. */
    expect(Object.keys(JSON.parse(unseal(writes[0]!.body.keyBundle, keyringHex())).accounts)).toEqual(['acc_new']);
    expect(keyring.keysFor('acc_new')).not.toBeNull();
  });

  /* RED WHEN: a wallet that does not hold the address signed in as is still asked without it, or its key is taken, so a person's first keys are saved under a wallet they did not sign in with. */
  it('creates and saves nothing when the wallet answering does not hold the address signed in as', async () => {
    const { sent } = nothingSavedYet();
    keyring.signedInByAnotherScreen(answerFor(SIGNED_IN));
    const elsewhere = new WalletAtTheOtherEnd((address) => address === ANOTHER);
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, elsewhere, US)).rejects.toThrow();
    expect(elsewhere.askedFor).toEqual([SIGNED_IN]);
    expect(sent('POST /api/accounts')).toEqual([]);
    expect(sent('PUT /api/me/keys')).toEqual([]);
    expect(keyring.canOpenCompanies()).toBe(false);
  });

  /* RED WHEN: a second sign-in handed over keeps the first one's address, or the first one's keys, so the wallet is asked about an address nobody is signed in as now. */
  it('replaces what an earlier sign-in left, and asks about the address signed in as now', async () => {
    nothingSavedYet();
    keyring.signedInByAnotherScreen(answerFor(ANOTHER));
    keyring.signedInByAnotherScreen(answerFor(SIGNED_IN));
    const wallet = new WalletAtTheOtherEnd();
    await keyring.createCompanyWithWallet(A_COMPANY, WALLET, wallet, US);
    expect(wallet.askedFor).toEqual([SIGNED_IN]);
  });

  /* RED WHEN: an answer with no person or no address is taken, leaving the tab signed in as nobody in particular or with no address to ask about. */
  it('refuses an answer that names no person or no address, and leaves the tab as it was', () => {
    for (const bad of [{}, { user: USER }, { user: USER, address: '' }, { address: SIGNED_IN }, { user: { id: PERSON }, address: SIGNED_IN }, null]) {
      expect(() => keyring.signedInByAnotherScreen(bad)).toThrow();
      expect(keyring.currentUser()).toBeNull();
      expect(keyring.signedInWallet()).toBeNull();
    }
    /* And a tab already signed in keeps who it was signed in as. */
    keyring.signedInByAnotherScreen(answerFor(SIGNED_IN));
    for (const bad of [{ user: { id: 'usr_2', name: 'x' } }, { user: { id: 'usr_2', name: 'x' }, address: '' }]) {
      expect(() => keyring.signedInByAnotherScreen(bad)).toThrow();
      expect([keyring.currentUser()?.id, keyring.signedInWallet()]).toEqual([PERSON, SIGNED_IN]);
    }
  });

  /* RED WHEN: a tab that picked the sign-in up without an answer (a reload) is let save a person's first keys, or the refusal stops being its own kind a screen can tell apart. */
  it('still refuses a person\'s first keys in a tab that was handed no sign-in, by a refusal a screen can name', async () => {
    const { sent } = nothingSavedYet();
    expect(await keyring.resumeSession()).toEqual(USER);
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US)).rejects.toBeInstanceOf(keyring.FirstKeysNeedTheSignIn);
    expect(sent('POST /api/accounts')).toEqual([]);
  });
});
