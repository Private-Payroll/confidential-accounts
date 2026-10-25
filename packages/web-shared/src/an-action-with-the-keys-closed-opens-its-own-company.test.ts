import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromWords } from 'midnight-identity';
import { ACT_ENDED_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import { drawCompanyLabel, type AccountAddress } from 'midnight-identity/profile/company-label';
import { parseAsk, type ActRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringHolderFor } from 'midnight-identity/profile/unlock';
import { fromHex, randomBytes, toHex, wrapKey } from '../../../src/core/crypto.js';
import { inboxPublicKey } from '../../../src/core/sealed-records.js';
import { keyringAsTheWalletAnswers, savedKeysSealKey } from '../../../src/testing/a-wallet-founds-a-company.js';
import * as keyring from './keyring.js';
import { metadataOf, openKeyring, sealKeyring, seatsOf, servedKeysOpenedFrom } from './keyring-blob.js';
import type { Openable } from './wallet-sign-in.js';

/*
 * **A CREATE VAULT OR A FINISH PRESSED WITH THE KEYS CLOSED LEAVES THE PAGE ITS OWN COMPANY OPEN.** The tab hands the
 * wallet the action's own company's served keys with the ask; the wallet's end answer gives that company's viewing key
 * (opened and believed as a keyring answer's is) with its seat's public halves; the tab takes them as a read of that
 * company alone. So opening the company and reading its new vault ask the wallet for nothing more, and every other
 * company still waits for the wallet to read the saved keys.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);
const OWN = 'acc_OwnCompany01';
const OTHER = 'acc_OtherCompany';
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const seat = (n: string) => ({
  signerId: `sig_${n}`, signingSecret: toHex(randomBytes(32)), wrappingSecret: toHex(randomBytes(32)), blinding: toHex(randomBytes(32)), scope: '44'.repeat(32),
});
const SEATS: Record<string, ReturnType<typeof seat>> = { [OWN]: seat('own'), [OTHER]: seat('other') };
const VIEWING: Record<string, string> = { [OWN]: toHex(randomBytes(32)), [OTHER]: toHex(randomBytes(32)) };
const KEY = savedKeysSealKey(identity, { requester: { origin: US, name: 'x', rdns: 'x' }, person: A.id } as never);
const BUNDLE = sealKeyring({ accounts: SEATS }, KEY as never).sealed;
const listed = (inboxOf: (id: string) => string) => [OWN, OTHER].map((id) => ({
  id, inboxPublicKey: inboxOf(id),
  wrappedKeys: [{ signerId: SEATS[id]!.signerId, ...wrapKey(VIEWING[id]!, toHex(x25519.getPublicKey(fromHex(SEATS[id]!.wrappingSecret)))) }],
}));

/** A wallet that answers an action as this wallet's code does: what the saved keys hold that is not secret, and the served keys it believes. */
class Wallet implements Openable {
  readonly asks: Array<{ kind: string; body: unknown }> = [];
  /** When set, the end answer gives this company's key in place of the one the action is about, and this value for it. */
  givesTheKeyOf: string | null = null;
  givesTheValue: string | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => { void this.onAsk(m); } };
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void { this.handler = h; queueMicrotask(() => this.deliver({ schema: READY_PING })); }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void { this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private async onAsk(message: unknown): Promise<void> {
    let answer: unknown = { schema: 'nothing-given' };
    try {
      const ask = parseAsk(message, US, Date.now());
      this.asks.push({ kind: ask.kind, body: ask });
      if (ask.kind === 'keyring') {
        answer = keyringAsTheWalletAnswers(identity, ask as KeyringRequest, (a) => a === ADDRESS);
      } else if (ask.kind === 'act') {
        const a = ask as ActRequest;
        const k = openKeyring(a.keyring!.sealed as never, KEY as never);
        answer = {
          schema: ACT_ENDED_SCHEMA, nonce: a.nonce, intent: a.intent.name, ended: 'done', step: 1, steps: 1, relayed: 0, unconfirmed: 0,
          keys: {
            seats: seatsOf(k),
            viewing: this.givesTheKeyOf === null ? servedKeysOpenedFrom(k, a.served ?? [])
              : { [this.givesTheKeyOf]: this.givesTheValue ?? VIEWING[this.givesTheKeyOf] },
            metadata: metadataOf(k),
            holder: keyringHolderFor(identity, a as never), resealed: null,
          },
        };
      }
    } catch { /* answered as nothing given */ }
    queueMicrotask(() => this.deliver(answer));
  }
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });
const aService = (inboxOf: (id: string) => string = (id) => inboxPublicKey(VIEWING[id]!, id)) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (route === 'GET /api/me/keys') return json(200, { keyBundle: BUNDLE, version: 1 });
    if (route === 'GET /api/accounts') return json(200, listed(inboxOf));
    if (route === `POST /api/accounts/${OWN}/unlock`) return json(200, { company: LABEL, account: ACCOUNT });
    return json(404, { error: `no route for ${route}` });
  }) as typeof fetch;
};
const signIn = () => keyring.signedInByAnotherScreen({ user: A, address: ADDRESS, created: true, session: {} });
const createVault = (wallet: Wallet) => keyring.actOnACompanyInTheWallet(
  { name: 'create-vault', record: OWN, company: LABEL, account: ACCOUNT }, WALLET, {}, wallet);
const finish = (wallet: Wallet) => keyring.finishCompanyInTheWallet(OWN, WALLET, {}, wallet, US);

/** What opening the company and reading its vault turn on in this tab: its seat, its viewing key, and that it may open it. */
const ownCompanyOpens = (): void => {
  expect(keyring.canOpenCompanies(OWN)).toBe(true);
  expect(keyring.seatHeldHere(OWN)?.signerId).toBe(SEATS[OWN]!.signerId);
  expect(keyring.viewingKeyFor({ id: OWN, wrappedKeys: [] })).toBe(VIEWING[OWN]);
};

describe('AN ACTION WITH THE KEYS CLOSED OPENS ITS OWN COMPANY, AND ONLY THAT', () => {
  for (const [name, run] of [['Create vault', createVault], ['Finish', finish]] as const) {
    it(`after a cold ${name}, the company opens and its vault reads with no keys window`, async () => {
      aService();
      signIn();
      const wallet = new Wallet();
      expect(keyring.canOpenCompanies(OWN)).toBe(false);
      await run(wallet);
      /* RED WHEN: the ask hands the wallet no served keys, or more than the action's own company's. */
      const ask = wallet.asks[0]!.body as ActRequest;
      expect(ask.served?.map((s) => s.accountId)).toEqual([OWN]);
      /* RED WHEN: the end answer's key is left out, or not taken, so the company asks the wallet again. */
      ownCompanyOpens();
      expect(wallet.asks.map((a) => a.kind)).toEqual(['act']);
      /* RED WHEN: a read of one company is taken as the saved keys read for every company. */
      expect(keyring.canOpenCompanies(OTHER)).toBe(false);
      expect(keyring.canOpenCompanies()).toBe(false);
      expect(keyring.seatHeldHere(OTHER)).toBeNull();
    });
  }

  it('a viewing key whose inbox public key does not match is left out, and the company stays closed', async () => {
    aService((id) => inboxPublicKey(VIEWING[OTHER]!, id));
    signIn();
    const wallet = new Wallet();
    await createVault(wallet);
    /* RED WHEN: a key is believed without making the company's inbox public key. */
    expect(keyring.canOpenCompanies(OWN)).toBe(false);
    expect(keyring.seatHeldHere(OWN)).toBeNull();
  });

  it('an end answer giving another company\'s key is not taken as a read at all', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    wallet.givesTheKeyOf = OTHER;
    await createVault(wallet);
    /* RED WHEN: the tab takes a key for a company the action was not about. */
    expect(keyring.canOpenCompanies(OTHER)).toBe(false);
    expect(keyring.canOpenCompanies(OWN)).toBe(false);
    expect(keyring.seatHeldHere(OTHER)).toBeNull();
  });

  it('in a tab whose saved keys were read, an end answer giving another company\'s key changes nothing held for it', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    await keyring.openKeysWithWallet(WALLET, wallet, US);
    expect(keyring.viewingKeyFor({ id: OTHER, wrappedKeys: [] })).toBe(VIEWING[OTHER]);
    wallet.givesTheKeyOf = OTHER;
    wallet.givesTheValue = toHex(randomBytes(32));
    await createVault(wallet);
    /* RED WHEN: an end answer for one company's action replaces the key this tab holds for another. */
    expect(keyring.viewingKeyFor({ id: OTHER, wrappedKeys: [] })).toBe(VIEWING[OTHER]);
  });
});

describe('A PRIVATE DEPOSIT IS ASKED OF THE WALLET AS ONE ACTION', () => {
  /* RED WHEN: the amount reaches the wallet as anything but the whole number of the token's smallest units, or the ask names more than the company, the vault, the token and the amount. */
  it('names the company, the vault, the token and the amount in the token\'s smallest units, written in decimal', async () => {
    aService();
    signIn();
    const wallet = new Wallet();
    const vault = 'd1'.repeat(32), token = '02'.repeat(32);
    await keyring.privateDepositInTheWallet({ record: OWN, company: LABEL, account: ACCOUNT as AccountAddress, vault, token, units: 12_345_678_901_234_567_890n }, WALLET, {}, wallet);
    const ask = wallet.asks[0]!.body as ActRequest;
    expect(ask.intent).toEqual({ name: 'private-deposit', fields: { record: OWN, company: LABEL, account: ACCOUNT, vault, token, amount: '12345678901234567890' } });
  });
});

describe('A COMPANY KEY RELEASED TO THIS TAB IS TOLD TO WHAT WAITS FOR IT', () => {
  /* RED WHEN: a vault page left unable to read what the vault holds privately is never told that its company's key has since been released, so it stays unread until the page is reloaded. */
  it('tells each watcher the company whose key the wallet released, and no longer once it stops watching', async () => {
    aService();
    signIn();
    const told: string[] = [];
    const stop = keyring.watchCompanyKeyReleased((id) => { told.push(id); });
    await keyring.companyKeysForVaults(OWN, WALLET, new Wallet(), US);
    expect(keyring.companyKeyReleasedFor(OWN)).not.toBeNull();
    expect(told).toEqual([OWN]);
    stop();
    keyring.forgetLocally();
    signIn();
    await keyring.companyKeysForVaults(OWN, WALLET, new Wallet(), US);
    expect(told).toEqual([OWN]);
  });
});
