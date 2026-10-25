import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { seal, unseal } from '../../../src/core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../../../src/core/wallet-unlock.js';
import { sealKeyring, withNewSeat } from './keyring-blob.js';
import * as keyring from './keyring.js';
import { foundedAsTheWalletAnswers, keyringAsTheWalletAnswers, savedKeysSealKey } from '../../../src/testing/a-wallet-founds-a-company.js';
import type { Openable } from './wallet-sign-in.js';

/*
 * **EVERY WRITE OF A PERSON'S SAVED KEYS FROM THIS PAGE COUNTS ITSELF INSIDE THE SEAL**, so the person's wallet,
 * which remembers the highest count it has seen, does not later refuse what this page wrote as an older copy. And
 * the page hands the wallet the saved keys as the service holds them, and keeps what the wallet sealed again only
 * over the version it was handed.
 */

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS_A = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);

/** The wallet's own code answering the keyring ask over the real conversation. */
class WalletAtTheOtherEnd implements Openable {
  constructor(private readonly who = identity) {}
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
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
      answer = ask.kind === 'keyring'
        ? (ask as KeyringRequest).drawLabel ? foundedAsTheWalletAnswers(this.who, ask as KeyringRequest, (address) => address === ADDRESS_A)
          : keyringAsTheWalletAnswers(this.who, ask as KeyringRequest, (address) => address === ADDRESS_A)
        : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

const KEY = (savedKeysSealKey(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person: A.id, signedInAs: null, company: null, account: null,
}), US, Date.now()) as KeyringRequest));

const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const answerFor = { user: A, address: ADDRESS_A, created: true, session: {} };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

/** A service holding one person's saved keys, refusing a write over any version but the one it holds. */
function aService() {
  let saved: { bundle: unknown; version: number } = { bundle: null, version: 0 };
  const puts: unknown[] = [];
  const companies: unknown[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me': return json(200, { user: A, accounts: [] });
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys':
        puts.push(body);
        if (body.ifVersion !== undefined && body.ifVersion !== saved.version) {
          return json(409, { error: 'your saved keys changed', currentVersion: saved.version });
        }
        saved = { bundle: body.keyBundle, version: saved.version + 1 };
        return json(200, { ok: true, version: saved.version });
      case 'POST /api/accounts': companies.push(body.founding.account); return json(201, { account: { id: body.founding.account.id }, state: 'made' });
      case 'GET /api/accounts': return json(200, companies);
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return {
    puts,
    saved: () => saved,
    opened: () => JSON.parse(unseal(saved.bundle as never, KEY)),
    replace: (bundle: unknown) => { saved = { bundle, version: saved.version + 1 }; },
  };
}

const started = async () => {
  keyring.signedInByAnotherScreen(answerFor);
  return keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new WalletAtTheOtherEnd(), US);
};

describe('every write of saved keys this page keeps counts itself inside the seal', () => {
  it('a person\'s first write is count 1, and each write after is one more', async () => {
    const service = aService();
    await started();
    await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Second Ltd' }, WALLET, new WalletAtTheOtherEnd(), US);
    const counts = service.puts.map((put) => JSON.parse(unseal((put as { keyBundle: never }).keyBundle, KEY)).counter);
    /* RED WHEN: saved keys are kept with no count, so the wallet cannot tell a write from an older copy;
     * or a later write does not count on from the keys it was made from, so the wallet refuses it as older. */
    expect(counts.length).toBe(2);
    expect(counts).toEqual(counts.map((_c, i) => i + 1));
  });

  it('counts on from saved keys written before writes were counted, and from whatever count they carry', async () => {
    const service = aService();
    service.replace(seal(JSON.stringify({ accounts: {} }), KEY));
    await started();
    /* RED WHEN: saved keys with no count are not read as count 0. */
    expect(service.opened().counter).toBe(service.puts.length);
    keyring.forgetLocally();
    service.replace(seal(JSON.stringify({ ...service.opened(), counter: 70 }), KEY));
    const before = service.puts.length;
    keyring.signedInByAnotherScreen(answerFor);
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(), US);
    await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Second Ltd' }, WALLET, new WalletAtTheOtherEnd(), US);
    expect(service.opened().counter).toBe(70 + service.puts.length - before);
  });
});

describe('the page hands the wallet the saved keys and keeps what it sealed again', () => {
  it('hands over the saved keys as the service holds them, with its version', async () => {
    const service = aService();
    await started();
    /* RED WHEN: the wallet is handed this tab's copy, or a version other than the service's. */
    expect(await keyring.savedKeysForTheWallet()).toEqual({ sealed: service.saved().bundle, version: service.saved().version });
  });

  it('keeps saved keys the wallet sealed again over the version handed out, and reads them again', async () => {
    const service = aService();
    const first = await started();
    const handed = await keyring.savedKeysForTheWallet();
    const sealedAgain = sealKeyring(withNewSeat(service.opened(), 'acc_FROMTHEWALLET', {
      signerId: 'sig_9', signingSecret: '11'.repeat(32), wrappingSecret: '22'.repeat(32), blinding: '33'.repeat(32), scope: '44'.repeat(32),
    }), KEY).sealed;
    /* RED WHEN: what the wallet sealed is written over a version other than the one it was handed, or not written. */
    expect(await keyring.keepWhatTheWalletSealed(sealedAgain, handed.version)).toBe(handed.version + 1);
    expect(service.saved().bundle).toEqual(sealedAgain);
    /* RED WHEN: this tab opens what the wallet sealed: the seat it holds is known here only once the wallet reads it. */
    expect(keyring.seatHeldHere('acc_FROMTHEWALLET')).toBeNull();
    await keyring.startCompanyHeldFromTheStart({ ...A_COMPANY, name: 'Second Ltd' }, WALLET, new WalletAtTheOtherEnd(), US);
    expect(Object.keys(service.opened().accounts)).toEqual(expect.arrayContaining([first.accountId, 'acc_FROMTHEWALLET']));
  });

  it('refuses to keep saved keys the wallet sealed when the service holds a newer version, and erases nothing', async () => {
    const service = aService();
    await started();
    const handed = await keyring.savedKeysForTheWallet();
    service.replace(service.saved().bundle);
    const meanwhile = service.saved();
    /* RED WHEN: a write from another tab or device made meanwhile is erased by the wallet's copy. */
    expect(await keyring.keepWhatTheWalletSealed(sealKeyring(service.opened(), KEY).sealed, handed.version)).toBeNull();
    expect(service.saved()).toEqual(meanwhile);
  });
});

describe('the page holds what the wallet read from the saved keys, and no secret', () => {
  it('knows each seat by its public halves and each company by the viewing key the wallet opened, and holds no secret', async () => {
    const service = aService();
    const { accountId } = await started();
    keyring.forgetLocally();
    keyring.signedInByAnotherScreen(answerFor);
    await keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(), US);
    const seat = keyring.seatHeldHere(accountId)!;
    const held = service.opened().accounts[accountId];
    expect(seat.signerId).toBe(held.signerId);
    /* RED WHEN: a seat's secret, or the key the saved keys open with, is held anywhere this page can read it. */
    for (const secret of [held.signingSecret, held.wrappingSecret, held.blinding, KEY]) expect(JSON.stringify(seat)).not.toContain(secret);
    /* RED WHEN: the page cannot read a company it holds a seat on, because the wallet did not open its viewing key for it. */
    expect(keyring.viewingKeyFor({ id: accountId, wrappedKeys: [] })).toMatch(/^[0-9a-f]{64}$/u);
    /* RED WHEN: a door that hands out a seat's secret, signs with it or opens the saved keys is still on the page. */
    for (const door of ['keysFor', 'signerMaterialFor', 'signApproval', 'reopenSavedKeys']) expect(door in keyring, door).toBe(false);
  });

  it('refuses a second answer from another wallet, and keeps what the first one read', async () => {
    aService();
    const { accountId } = await started();
    const before = keyring.seatHeldHere(accountId);
    /* RED WHEN: another wallet's answer is taken in place of the one this tab's saved keys were read by: that wallet
     * cannot open them and gives nothing, and this tab keeps what it holds. */
    await expect(keyring.openKeysWithWallet(WALLET, new WalletAtTheOtherEnd(identityFromWords(generateMnemonic(wordlist, 256))), US)).rejects.toThrow();
    expect(keyring.seatHeldHere(accountId)).toEqual(before);
  });
});
