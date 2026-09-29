import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { toHex, unseal } from '../../../src/core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../../../src/core/wallet-unlock.js';
import * as keyring from './keyring.js';
import type { Openable } from './wallet-sign-in.js';

/**
 * **A COMPANY STARTED IN A TAB IS SAVED ONLY INTO THE KEYS OF WHOEVER STARTED
 * IT, AND A SIGN-IN PICKED UP AFTER A RELOAD CAN CARRY ITS ADDRESS BACK.**
 *
 * The first half: a company whose keys could not be saved waits in the tab. If
 * somebody else signs in in that tab before it is finished, finishing it is
 * refused for them, nothing of it is written into their saved keys, and it is
 * still there for the person who started it.
 *
 * The second half: a reloaded tab knows who is signed in but not the address
 * the sign-in was for. A screen that kept it hands it back, and the keyring
 * takes it only for the person the service says is signed in, so that person's
 * first keys are saved under the account holding that address with no second
 * sign-in. Handed nothing, the keyring is as it always was.
 *
 * The wallet at the other end is the wallet's own code answering over the real
 * conversation.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS_A = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const ADDRESS_B = 'mn_addr_test1zzzzzzzzzzzzzzzzzzzz';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const B = { id: 'usr_b', email: null, name: 'Sam' };
const identity = identityFromWords(TEST_MNEMONIC);

/** A wallet that gives the keyring key only for the address it holds, and records the address each ask named. */
class WalletAtTheOtherEnd implements Openable {
  readonly askedFor: (string | null)[] = [];
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  constructor(private readonly holds: string) {}
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
      answer = ask.kind === 'keyring'
        ? keyringReleaseFor(identity, ask as KeyringRequest, Date.now(), (address) => address === this.holds)
        : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** The keyring key the wallet above gives `person`. */
const keyringHexFor = (person: string) => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person, signedInAs: null, company: null,
}), US, Date.now()) as KeyringRequest));

const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const answerFor = (user: typeof A, address: string) => ({ user, address, created: true, session: {} });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

/**
 * A service keeping each person's saved keys apart, by who the request says it
 * is for. `refuseSavesFor` names a person every save of theirs is refused for,
 * as if another device saved first each time.
 */
function aService(opts: { signedIn: () => typeof A; refuseSavesFor?: string | null }) {
  const posted: { route: string; as: string | null; body: any }[] = [];
  const saved = new Map<string, { bundle: unknown; version: number }>();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const as = (init?.headers as Record<string, string> | undefined)?.['x-signed-in-as'] ?? null;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ route, as, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const who = opts.signedIn().id;
    const mine = saved.get(who) ?? { bundle: null, version: 0 };
    switch (route) {
      case 'GET /api/me': return json(200, { user: opts.signedIn(), accounts: [] });
      case 'GET /api/me/keys': return json(200, { keyBundle: mine.bundle, version: mine.version });
      case 'PUT /api/me/keys':
        if (who === opts.refuseSavesFor) return json(409, { error: 'saved from somewhere else since' });
        saved.set(who, { bundle: body.keyBundle, version: mine.version + 1 });
        return json(200, { version: mine.version + 1 });
      case 'POST /api/accounts': return json(200, {
        account: { id: 'acc_new' },
        secrets: [{ signerId: 'sgn_new', signingSecret: 'dd'.repeat(32), wrappingSecret: 'ee'.repeat(32), blinding: 'ff'.repeat(32), scope: 'ab'.repeat(32) }],
      });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return {
    all: () => posted,
    sent: (route: string) => posted.filter((p) => p.route === route),
    savedFor: (person: string) => saved.get(person)?.bundle ?? null,
    replaceSaved: (person: string, bundle: unknown) => { saved.set(person, { bundle, version: (saved.get(person)?.version ?? 0) + 1 }); },
  };
}

/** The companies whose keys are in `bundle`, opened with `person`'s key. */
const companiesIn = (bundle: unknown, person: string): string[] =>
  Object.keys(JSON.parse(unseal(bundle as never, keyringHexFor(person))).accounts);

describe('a company waiting to be finished in a tab', () => {
  /*
   * RED WHEN: the company waiting is not bound to whoever started it, so
   * finishing it after somebody else signed in in the tab saves its keys into
   * theirs; or it is offered to them as theirs to finish; or it is dropped
   * rather than left for the person who started it.
   */
  it('is finished only for whoever started it, and saved into nobody else\'s keys', async () => {
    let now = A;
    const service = aService({ signedIn: () => now, refuseSavesFor: A.id });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US)).rejects.toThrow();
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');

    /* Somebody else signs in in the same tab, and opens their own saved keys. */
    now = B;
    keyring.signedInByAnotherScreen(answerFor(B, ADDRESS_B));
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_B), US);
    expect(keyring.canOpenCompanies()).toBe(true);
    expect(keyring.companyAwaitingSetup()).toBeNull();
    expect(keyring.companyAwaitingSetupProblem()).toBeNull();
    const asked = service.all().length;
    await expect(keyring.finishCompanyCreation()).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    /* Refused before anything is read or written: nothing of theirs is even read for it. */
    expect(service.all().length).toBe(asked);
    expect(service.savedFor(B.id)).toBeNull();
    expect(keyring.keysFor('acc_new')).toBeNull();

    /* Starting a company of their own is refused as someone else's unfinished company, never as theirs to finish. */
    const posts = service.sent('POST /api/accounts').length;
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_B), US)).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(service.sent('POST /api/accounts')).toHaveLength(posts);

    /* The person who started it signs in again in the tab: it is theirs to finish, and it is saved into their keys. */
    now = A;
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    expect(keyring.companyAwaitingSetup()).toBe('acc_new');
  });

  /* RED WHEN: a new company's first save is made after somebody else signed in while the company was being made, so its keys are written under them. */
  it('saves nothing when somebody else signs in while the company is being made', async () => {
    let now = A;
    const service = aService({ signedIn: () => now });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US);
    const made = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const answer = await made(url, init);
      if (`${String(init?.method ?? 'GET')} ${url}` === 'POST /api/accounts') {
        /* The answer arrives after somebody else has signed in here and opened their keys. */
        now = B;
        keyring.signedInByAnotherScreen(answerFor(B, ADDRESS_B));
        await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_B), US);
      }
      return answer;
    }) as typeof fetch;
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US))
      .rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(service.sent('PUT /api/me/keys').filter((w) => w.as === B.id)).toEqual([]);
    expect(service.savedFor(B.id)).toBeNull();
  });

  /* RED WHEN: a sign-in as somebody else that arrives while finishing reads the saved keys lets the company's keys be written under them. */
  it('saves nothing when somebody else signs in while it is being finished', async () => {
    let now = A;
    let refuse: string | null = A.id;
    const service = aService({ signedIn: () => now, get refuseSavesFor() { return refuse; } });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US)).rejects.toThrow();
    refuse = null;
    const made = globalThis.fetch;
    let switched = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const answer = await made(url, init);
      if (!switched && `${String(init?.method ?? 'GET')} ${url}` === 'GET /api/me/keys') {
        switched = true;
        now = B;
        keyring.signedInByAnotherScreen(answerFor(B, ADDRESS_B));
        await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(ADDRESS_B), US);
      }
      return answer;
    }) as typeof fetch;
    await expect(keyring.finishCompanyCreation()).rejects.toBeInstanceOf(keyring.CompanyStartedBySomebodyElse);
    expect(switched).toBe(true);
    expect(service.sent('PUT /api/me/keys').filter((w) => w.as === B.id)).toEqual([]);
    expect(service.savedFor(B.id)).toBeNull();
  });

  /* RED WHEN: why a company cannot be finished is said to somebody who did not start it. */
  it('says nothing of a company that can never be finished to anybody but whoever started it', async () => {
    let now = A;
    const service = aService({ signedIn: () => now, refuseSavesFor: A.id });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US)).rejects.toThrow();
    /* What is saved now does not open with the key this tab holds, so it can never be finished. */
    service.replaceSaved(A.id, { v: 1, box: 'not sealed under this key' });
    await expect(keyring.finishCompanyCreation()).rejects.toBeInstanceOf(keyring.SavedKeysDidNotOpen);
    expect(keyring.companyAwaitingSetupProblem()?.canFinish).toBe(false);
    now = B;
    keyring.signedInByAnotherScreen(answerFor(B, ADDRESS_B));
    expect(keyring.companyAwaitingSetupProblem()).toBeNull();
  });

  /* RED WHEN: binding the company to its creator stops the ordinary finish, so the person who started it cannot save it. */
  it('is still finished, into their own keys, by whoever started it', async () => {
    let refuse: string | null = A.id;
    const service = aService({ signedIn: () => A, get refuseSavesFor() { return refuse; } });
    keyring.signedInByAnotherScreen(answerFor(A, ADDRESS_A));
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_A), US)).rejects.toThrow();
    refuse = null;
    expect(await keyring.finishCompanyCreation()).toEqual({ accountId: 'acc_new' });
    expect(companiesIn(service.savedFor(A.id), A.id)).toEqual(['acc_new']);
    expect(keyring.companyAwaitingSetup()).toBeNull();
  });
});

describe('a sign-in picked up after a reload', () => {
  /* RED WHEN: the address handed back is not taken, so a person with nothing saved must sign in again to create their first company; or it is taken from anywhere but what was handed back. */
  it('carries the address handed back, so a first company needs no second sign-in', async () => {
    const service = aService({ signedIn: () => A });
    expect(await keyring.resumeSession({ personId: A.id, address: ADDRESS_A })).toEqual(A);
    expect(keyring.signedInWallet()).toBe(ADDRESS_A);
    const wallet = new WalletAtTheOtherEnd(ADDRESS_A);
    expect(await keyring.createCompanyWithWallet(A_COMPANY, WALLET, wallet, US)).toEqual({ accountId: 'acc_new' });
    expect(wallet.askedFor).toEqual([ADDRESS_A]);
    expect(companiesIn(service.savedFor(A.id), A.id)).toEqual(['acc_new']);
  });

  /* RED WHEN: an address kept for somebody else is taken for the person signed in now, so their first keys could be saved under an account they did not sign in with. */
  it('takes no address kept for somebody else, and saves nothing', async () => {
    const service = aService({ signedIn: () => A });
    expect(await keyring.resumeSession({ personId: B.id, address: ADDRESS_B })).toEqual(A);
    expect(keyring.signedInWallet()).toBeNull();
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, new WalletAtTheOtherEnd(ADDRESS_B), US))
      .rejects.toBeInstanceOf(keyring.FirstKeysNeedTheSignIn);
    expect(service.sent('POST /api/accounts')).toEqual([]);
  });

  /* RED WHEN: a wallet that does not hold the address handed back gives the key a person's first keys are saved under. */
  it('saves nothing when the wallet answering does not hold the address handed back', async () => {
    const service = aService({ signedIn: () => A });
    await keyring.resumeSession({ personId: A.id, address: ADDRESS_A });
    const elsewhere = new WalletAtTheOtherEnd(ADDRESS_B);
    await expect(keyring.createCompanyWithWallet(A_COMPANY, WALLET, elsewhere, US)).rejects.toThrow();
    expect(elsewhere.askedFor).toEqual([ADDRESS_A]);
    expect(service.sent('POST /api/accounts')).toEqual([]);
    expect(service.sent('PUT /api/me/keys')).toEqual([]);
  });

  /* RED WHEN: picking a sign-in up with nothing handed back, as the legacy page does, starts taking an address from anywhere. */
  it('takes no address when nothing is handed back', async () => {
    aService({ signedIn: () => A });
    expect(await keyring.resumeSession()).toEqual(A);
    expect(keyring.signedInWallet()).toBeNull();
    for (const bad of [{ personId: A.id, address: '' }, { personId: '', address: ADDRESS_A }]) {
      keyring.forgetLocally();
      await keyring.resumeSession(bad);
      expect(keyring.signedInWallet()).toBeNull();
    }
  });
});
