import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type KeyringRequest } from 'midnight-identity/profile/request';
import { openKeyring } from './keyring-blob.js';
import { foundedAsTheWalletAnswers, keyringAsTheWalletAnswers, savedKeysSealKey } from '../../../src/testing/a-wallet-founds-a-company.js';
import { unwrapKey, unseal, parseCanonical, toHex } from '../../../src/core/crypto.js';
import { purposeKey, type Purpose } from '../../../src/core/sealed-records.js';
import * as keyring from './keyring.js';
import type { Openable } from './wallet-sign-in.js';

/**
 * **A COMPANY'S FOUNDING SENDS THE SERVICE NONE OF ITS KEYS, BY VALUE.**
 *
 * The founding signer's wallet makes the company's key, its purpose keys, the seat's secrets and the company's first
 * state, and the page keeps the saved keys the wallet sealed and sends the founding on. This file sends the founding through the page's own transport (`api` in the keyring) with the fetch
 * replaced by a recorder, and reads every address, header and body that left for the plaintext of each of those
 * secrets. The service refuses a founding that carries a secret under a secret's name; this reads the values, so a key
 * sent under any other name is found too.
 */

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A = { id: 'usr_a', email: null, name: 'Priya' };
const identity = identityFromWords(TEST_MNEMONIC);
const ACCOUNT = 'c0'.repeat(32);
const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const PURPOSES: readonly Purpose[] = ['roster', 'policy', 'payroll', 'inbox', 'proposals'];

/** The wallet, answering the keyring ask with its own code, and founding a company as it does. */
class Wallet implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void {}
  private deliver(data: unknown): void { this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private onAsk(message: unknown): void {
    let answer: unknown;
    try {
      const ask = parseAsk(message, US, Date.now());
      if (ask.kind === 'keyring' && (ask as KeyringRequest).drawLabel) answer = foundedAsTheWalletAnswers(identity, ask as KeyringRequest, (a) => a === ADDRESS);
      else if (ask.kind === 'keyring') answer = keyringAsTheWalletAnswers(identity, ask as KeyringRequest, (a) => a === ADDRESS);
      else answer = { schema: 'nothing-given' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/** Everything the page sent: the address, every header and the body of each request, in order. */
interface Sent { readonly route: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); });

const recordingService = (): Sent[] => {
  const sent: Sent[] = [];
  let saved: { bundle: unknown; version: number } = { bundle: null, version: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body === undefined ? '' : String(init.body);
    sent.push({ route: `${String(init?.method ?? 'GET')} ${url}`, url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const route = `${String(init?.method ?? 'GET')} ${url}`.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X');
    switch (route) {
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys': saved = { bundle: JSON.parse(body).keyBundle, version: saved.version + 1 }; return json(200, { version: saved.version });
      case 'POST /api/accounts': return json(201, { account: { id: JSON.parse(body).founding.account.id }, state: 'made' });
      case 'POST /api/accounts/acc_X/creation': return json(201, { account: ACCOUNT, state: 'deploy-sent', txRef: 'tx' });
      case 'GET /api/accounts/acc_X/call-state': return json(200, { account: ACCOUNT, blockHash: '00'.repeat(32), accountState: 'U1RBVEU=', parameters: 'UEFSQU1T' });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return sent;
};

/** Each secret, by what it is, in the forms it could travel in: lowercase hex, and base64 of its bytes. */
const formsOf = (hex: string): string[] => {
  const h = hex.toLowerCase().replace(/^0x/u, '');
  return [h, Buffer.from(h, 'hex').toString('base64')];
};

/** The names of the secrets found in `texts`. */
const foundIn = (texts: readonly string[], secrets: ReadonlyMap<string, string>): string[] =>
  [...secrets].filter(([, value]) => value.length >= 32 && formsOf(value).some((f) => texts.some((t) => t.toLowerCase().includes(f.toLowerCase())))).map(([name]) => name);

describe('A COMPANY\'S FOUNDING SENDS THE SERVICE NONE OF ITS KEYS', () => {
  it('NO ADDRESS, HEADER OR BODY OF THE FOUNDING CARRIES THE COMPANY\'S KEY, A KEY MADE FROM IT, THE SEAT\'S SECRETS OR THE FIRST STATE\'S SECRETS', async () => {
    const sent = recordingService();
    keyring.signedInByAnotherScreen({ user: A, address: ADDRESS, created: true, session: {} });
    await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, new Wallet(), US);
    const made = JSON.parse(sent.find((s) => s.route === 'POST /api/accounts')!.body) as { founding: any };
    const id = made.founding.account.id as string;
    /* The seat as the saved keys the wallet sealed hold it, opened here with the wallet's key: this page never holds it. */
    const put = JSON.parse(sent.find((s) => s.route === 'PUT /api/me/keys')!.body) as { keyBundle: never };
    const mine = openKeyring(put.keyBundle, (savedKeysSealKey(identity, { requester: { origin: US, name: 'x', rdns: 'x' }, person: A.id } as never)) as never).accounts[id]!;
    const viewingKey = unwrapKey(made.founding.account.wrappedKeys[0], mine.wrappingSecret);
    const state = parseCanonical<{ blinding: { assetBlinding: string; payRecordKey: string; payoutSeeds: Array<{ seed: string }> } }>(unseal(made.founding.state.sealed, viewingKey));

    const secrets = new Map<string, string>([
      ['the company key', viewingKey],
      ...PURPOSES.map((p) => [`the ${p} key`, purposeKey(viewingKey, id, p)] as [string, string]),
      ['the seat\'s signing secret', mine.signingSecret],
      ['the seat\'s wrapping secret', mine.wrappingSecret],
      ['the seat\'s blinding', mine.blinding],
      ['the seat\'s opening salt', mine.opening?.salt ?? ''],
      ['the asset blinding', state.blinding.assetBlinding],
      ['the pay record key', state.blinding.payRecordKey],
      ...state.blinding.payoutSeeds.map((s, i) => [`payout seed ${i}`, s.seed] as [string, string]),
    ]);
    for (const [name, value] of secrets) expect(value, name).toMatch(/^[0-9a-f]{32,}$/iu);

    expect(sent.length).toBeGreaterThan(2);
    const texts = sent.flatMap((s) => [s.url, s.body, JSON.stringify(s.headers)]);
    /* RED WHEN: any request of the founding carries the plaintext of the company's key, a key made from it, a secret of the founding seat or a secret of the first state, in its address, a header or its body. */
    expect(foundIn(texts, secrets)).toEqual([]);

    /* RED WHEN: the page's own transport adds a header beyond the content type and the signed-in person's id. */
    for (const s of sent) expect(Object.keys(s.headers).sort().filter((h) => h !== 'content-type' && h !== 'x-signed-in-as'), s.route).toEqual([]);
  });

  it('THE SCAN FINDS A KEY IN AN ADDRESS, A HEADER AND A BODY, IN HEX AND IN BASE64', () => {
    const key = toHex(new Uint8Array(32).fill(7));
    const secrets = new Map([['k', key]]);
    /* RED WHEN: the scan stops reading hex, base64, addresses, headers or bodies, so a founding that sent a key would pass. */
    expect(foundIn([`/api/x?k=${key}`], secrets)).toEqual(['k']);
    expect(foundIn([JSON.stringify({ 'x-k': key.toUpperCase() })], secrets)).toEqual(['k']);
    expect(foundIn([JSON.stringify({ a: { b: Buffer.from(key, 'hex').toString('base64') } })], secrets)).toEqual(['k']);
    expect(foundIn(['/api/x?k=nothing'], secrets)).toEqual([]);
  });
});
