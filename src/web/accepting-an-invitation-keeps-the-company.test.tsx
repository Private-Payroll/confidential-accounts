// @vitest-environment jsdom
/**
 * **ACCEPTING AN INVITATION KEEPS THE COMPANY FOR THE PERSON WHO ACCEPTED, AND
 * FOLLOWING THE ACCEPTED SCREEN'S LINK THEN UNLOCKING SAVES IT WITH THEM.**
 *
 * Driven through the whole page from the invitation's own address: the offer is
 * read, the wallet approves, the code is pasted, the acceptance is sent, the
 * accepted screen's link is followed, and the person unlocks. The two wallet
 * asks the invitation makes answer as a wallet does; the keyring's own ask is
 * answered by the wallet's own code, which gives the key for the address the
 * page signed in as only when it holds that address.
 *
 * What this pins is the whole of one journey that used to end with the company
 * in one browser: the save made when an invitation is accepted, the link that
 * keeps the tab that signed the person in, and the unlock that then saves the
 * company with them.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { bech32m } from '@scure/base';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { newWrappingKeypair, toHex, unseal } from '../core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../core/wallet-unlock.js';
import { RECEIVING_ADDRESS } from '../core/wallet-payee-ask.js';
import type { Openable } from './wallet-sign-in.js';

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const PERSON = 'usr_1';
const ACME = 'ab'.repeat(32);
const TOKEN = 'the-invitation';
const identity = identityFromWords(TEST_MNEMONIC);
/** Where this person is paid: a well-formed stagenet shielded address, both keys 32 bytes. */
const PAID_TO = bech32m.encode('mn_shield-addr_stagenet', bech32m.toWords(new Uint8Array(64).fill(0x0d)), false);

/** A wallet that gives the keyring key from its own words, and only for an address it holds. */
class WalletAtTheOtherEnd implements Openable {
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
        ? keyringReleaseFor(identity, ask as KeyringRequest, Date.now(), (a) => a === SIGNED_IN)
        : { schema: 'a-sign-in' };
    } catch {
      answer = { schema: 'nothing-given' };
    }
    queueMicrotask(() => this.deliver(answer));
  }
}

/* The page is built knowing where the wallet is served from, before any of it is loaded. */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'https://wallet.example'); });
/* The keyring's asks are answered by the wallet above rather than a window. */
vi.mock('./keyring.js', async (original) => {
  const real = await original<typeof import('./keyring.js')>();
  return {
    ...real,
    openKeysWithWallet: (origin: string) => real.openKeysWithWallet(origin, new WalletAtTheOtherEnd(), US),
    signInWithWallet: (origin: string, token?: string) => real.signInWithWallet(origin, token, new WalletAtTheOtherEnd()),
  };
});
/* The invitation's two asks: the company's key, then where to pay, chosen on the wallet's own screen. */
vi.mock('./wallet-unlock.js', async (original) => ({
  ...(await original<typeof import('./wallet-unlock.js')>()),
  askWalletToUnlock: async () => new Uint8Array(32).fill(5),
}));
vi.mock('./wallet-payee.js', async (original) => ({
  ...(await original<typeof import('./wallet-payee.js')>()),
  askWalletForPayeeAddress: async () => ({
    payload: { disclosed: [{ about: RECEIVING_ADDRESS, says: { of: 'value', value: PAID_TO }, asserted: { by: 'wallet' } }] },
  }),
}));

const keyring = await import('./keyring.js');

/** The keyring key the wallet above gives this person. */
const keyringHex = () => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person: PERSON, signedInAs: null, company: null,
}), US, Date.now()) as KeyringRequest));

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); localStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** The offer, and a server that answers these routes the way the real one does. */
function aServer() {
  let bundle: unknown = null;
  let version = 0;
  const writes: Array<{ keyBundle: unknown }> = [];
  const accepted: unknown[] = [];
  const offer = {
    company: 'Acme Ltd', companyAddress: ACME, inboxPublicKey: newWrappingKeypair().publicKey,
    name: 'Dana', title: 'Engineer', email: null, asset: 'TESTUSD', baseAmount: { $n: '5000000000' },
    startDate: '2026-10-01T00:00:00.000Z', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const user = { id: PERSON, email: null, name: '' };
    switch (`${method} ${url}`) {
      case `GET /api/invites/${TOKEN}/offer`: return json(200, offer);
      case `POST /api/invites/${TOKEN}/accept-employee`: accepted.push(body); return json(200, { ok: true });
      case 'POST /api/auth/wallet/challenge':
        return json(200, { nonce: 'nonce', handle: 'h', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      case 'POST /api/auth/wallet': return json(200, { user, address: SIGNED_IN, created: true, session: {} });
      case 'GET /api/me': return json(200, { user, accounts: [] });
      case 'GET /api/accounts': return json(200, []);
      case 'GET /api/me/keys': return json(200, { keyBundle: bundle, version });
      case 'PUT /api/me/keys':
        writes.push(body);
        bundle = body.keyBundle;
        version += 1;
        return json(200, { version });
      default: return json(404, { error: `no route for ${method} ${url}` });
    }
  }) as typeof fetch;
  return { writes, accepted, savedList: (i: number) => JSON.parse(unseal(writes[i]!.keyBundle as never, keyringHex())).paidBy };
}

const button = (container: HTMLElement, text: RegExp) => waitFor(() => {
  const b = [...container.querySelectorAll('button')].find(x => text.test(x.textContent ?? ''));
  expect(b, String(text)).toBeTruthy();
  return b as HTMLButtonElement;
});

describe('accepting an invitation keeps the company where the person finds it again', () => {
  it('ACCEPT, FOLLOW THE LINK, UNLOCK: THE COMPANY IS IN THE SAVED KEYS', async () => {
    const { writes, accepted, savedList } = aServer();
    window.history.replaceState(null, '', `/join#${TOKEN}`);
    /* Signed in on the invitation, in this tab. */
    await keyring.signInWithWallet(WALLET);
    const { default: App } = await import('./App.js');
    const { SimulatedCommitments } = await import('../core/ledger.js');
    const { container } = render(<App commitments={SimulatedCommitments} />);
    fireEvent.click(await button(container, /Open my wallet and approve/));
    const code = await waitFor(() => {
      const input = container.querySelector('[data-confirmation-code]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      return input!;
    });
    fireEvent.change(code, { target: { value: 'ABCDE-FGHJK-MNPQR-STVWX' } });
    fireEvent.click(await button(container, /Send this to Acme Ltd/));
    const link = await waitFor(() => {
      const a = container.querySelector('[data-open-payslips]') as HTMLAnchorElement | null;
      expect(a).not.toBeNull();
      return a!;
    });
    expect(accepted).toHaveLength(1);
    /* RED WHEN accepting keeps nothing: the company is then nowhere the person can find it again. */
    expect(JSON.parse(localStorage.getItem(`payslip-companies-of:${PERSON}`) ?? '[]')).toEqual([ACME]);
    expect(writes).toHaveLength(0);
    fireEvent.click(link);
    /* RED WHEN the page does not leave the invitation, or loads the page again and forgets who signed in. */
    await waitFor(() => expect(container.querySelector('[data-unlock-employers]')).not.toBeNull());
    expect(window.location.pathname).toBe('/payslips');
    expect(keyring.signedInWallet()).toBe(SIGNED_IN);
    fireEvent.click(container.querySelector('[data-unlock-employers]') as HTMLButtonElement);
    /* RED WHEN the unlock leaves the company in this browser: the saved keys are written with it. */
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(savedList(0)).toEqual([ACME]);
    expect(localStorage.getItem(`payslip-companies-of:${PERSON}`)).toBeNull();
    await waitFor(() => expect(container.querySelector(`[data-employer="${ACME}"]`)).not.toBeNull());
  });
});
