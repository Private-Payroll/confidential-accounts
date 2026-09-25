// @vitest-environment jsdom
/**
 * **AN INVITATION IN MONEY WITH NO PRIVATE FORM ASKS THE INVITED PERSON'S
 * WALLET FOR A PUBLIC ADDRESS, AND NEVER ACCEPTS A PRIVATE ONE.**
 *
 * Driven through the whole page from the invitation's own address, as
 * `accepting-an-invitation-keeps-the-company.test.tsx` drives it. The address
 * ask goes through the page's real `askWalletForPayeeAddress` and the real ask
 * builder; the window at the far end is stood in for, and it records exactly
 * what the page asked for and answers as it is told to. The company-key ask
 * before it is stood in for too, answering a fixed key, as in that file; the
 * count of asks below is of address asks only.
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
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { newWrappingKeypair } from '../core/crypto.js';
import { PUBLIC_RECEIVING_ADDRESS, RECEIVING_ADDRESS } from '../core/wallet-payee-ask.js';
import { PUBLIC_PAYMENT } from './public-payment.js';
import type { Openable } from './wallet-sign-in.js';

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const PERSON = 'usr_1';
const ACME = 'ab'.repeat(32);
const TOKEN = 'the-invitation';
const identity = identityFromWords(TEST_MNEMONIC);
/** Well-formed stagenet addresses: a shielded one, two keys of 32 bytes, and a public one, one key. */
const PRIVATE_ADDRESS = bech32m.encode('mn_shield-addr_stagenet', bech32m.toWords(new Uint8Array(64).fill(0x0d)), false);
const PUBLIC_ADDRESS = bech32m.encode('mn_addr_stagenet', bech32m.toWords(new Uint8Array(32).fill(0x0e)), false);

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

/** What the far end of the address ask records and how it answers. */
const addressAsks: Array<{ kind?: string; wants?: Array<{ attribute: string; required: boolean }> }> = [];
let answerWith: (asked: string) => unknown = () => null;
const disclosed = (about: string, value: string) =>
  ({ payload: { disclosed: [{ about, says: { of: 'value', value }, asserted: { by: 'wallet' } }] } });

vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'https://wallet.example'); });
vi.mock('./keyring.js', async (original) => {
  const real = await original<typeof import('./keyring.js')>();
  return {
    ...real,
    openKeysWithWallet: (origin: string) => real.openKeysWithWallet(origin, new WalletAtTheOtherEnd(), US),
    signInWithWallet: (origin: string, token?: string) => real.signInWithWallet(origin, token, new WalletAtTheOtherEnd()),
  };
});
vi.mock('./wallet-unlock.js', async (original) => ({
  ...(await original<typeof import('./wallet-unlock.js')>()),
  askWalletToUnlock: async () => new Uint8Array(32).fill(5),
}));
/* The page's own address ask, built by the page's own code, reaches this stand-in for the window. */
vi.mock('./wallet-sign-in.js', async (original) => {
  const real = await original<typeof import('./wallet-sign-in.js')>();
  return {
    ...real,
    askWallet: async (view: Openable, origin: string, message: unknown, dialog?: never) => {
      const m = message as { kind?: string; wants?: Array<{ attribute: string; required: boolean }> };
      if (m.kind !== 'disclosure') return real.askWallet(view, origin, message, dialog);
      addressAsks.push(m);
      return answerWith(m.wants?.[0]?.attribute ?? '');
    },
  };
});

const keyring = await import('./keyring.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); localStorage.clear();
  window.history.replaceState(null, '', '/');
  addressAsks.length = 0;
});

function aServer(asset: string) {
  const accepted: unknown[] = [];
  const offer = {
    company: 'Acme Ltd', companyAddress: ACME, inboxPublicKey: newWrappingKeypair().publicKey,
    name: 'Dana', title: 'Engineer', email: null, asset, baseAmount: { $n: '5000000000' },
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
      case 'GET /api/me/keys': return json(200, { keyBundle: null, version: 0 });
      default: return json(404, { error: `no route for ${method} ${url}` });
    }
  }) as typeof fetch;
  return { accepted };
}

const button = (container: HTMLElement, text: RegExp) => waitFor(() => {
  const b = [...container.querySelectorAll('button')].find(x => text.test(x.textContent ?? ''));
  expect(b, String(text)).toBeTruthy();
  return b as HTMLButtonElement;
});

/** Opens the invitation and presses approve; resolves with the page once the address ask has been answered. */
async function approveAnInvitationIn(asset: string, beforeApprove: (container: HTMLElement) => void = () => undefined) {
  const server = aServer(asset);
  window.history.replaceState(null, '', `/join#${TOKEN}`);
  await keyring.signInWithWallet(WALLET);
  const { default: App } = await import('./App.js');
  const { SimulatedCommitments } = await import('../core/ledger.js');
  const { container } = render(<App commitments={SimulatedCommitments} />);
  const approve = await button(container, /Open my wallet and approve/);
  beforeApprove(container);
  fireEvent.click(approve);
  await waitFor(() => expect(addressAsks).toHaveLength(1));
  return { container, ...server };
}

const settledOn = (container: HTMLElement) => waitFor(() => {
  const code = container.querySelector('[data-confirmation-code]');
  const err = container.querySelector('.err, [role="alert"], .error');
  expect(code !== null || err !== null).toBe(true);
  return { code, err: err?.textContent ?? null };
});

describe('an invitation in money with no private form asks for a public address', () => {
  it('NIGHT: THE WALLET IS ASKED FOR THE PUBLIC ADDRESS, ONCE, AND A PUBLIC ONE IS TAKEN', async () => {
    answerWith = (asked) => disclosed(asked, PUBLIC_ADDRESS);
    const { container, accepted } = await approveAnInvitationIn('NIGHT', (offerScreen) => {
      /* The person is told, before they approve, what a public payment puts on the record. */
      expect(offerScreen.querySelector('[data-public-payment]')?.textContent).toBe(PUBLIC_PAYMENT);
      /* RED WHEN the screen still says the service never sees an address every payment will make public. */
      expect(offerScreen.querySelector('[data-sealed-never-seen]')).toBeNull();
    });
    /* RED WHEN the invitation asks for the shielded address: NIGHT can never be paid to it. */
    expect(addressAsks[0]!.wants).toEqual([expect.objectContaining({ attribute: PUBLIC_RECEIVING_ADDRESS, required: true })]);
    const settled = await settledOn(container);
    /* RED WHEN the page's check refuses a public address for NIGHT. */
    expect(settled.err).toBeNull();
    expect(settled.code).not.toBeNull();
    fireEvent.change(settled.code!, { target: { value: 'ABCDE-FGHJK-MNPQR-STVWX' } });
    fireEvent.click(await button(container, /Send this to Acme Ltd/));
    await waitFor(() => expect(accepted).toHaveLength(1));
    /* No second address ask. */
    expect(addressAsks).toHaveLength(1);
  });

  it('NIGHT: A PRIVATE ADDRESS IS REFUSED ON THE PAGE, AND NOTHING IS SENT', async () => {
    answerWith = (asked) => disclosed(asked, PRIVATE_ADDRESS);
    const { container, accepted } = await approveAnInvitationIn('NIGHT');
    const settled = await settledOn(container);
    /* RED WHEN the page checks a NIGHT invitation's address as a shielded one: it would take this. */
    expect(settled.code).toBeNull();
    expect(settled.err).toMatch(/not a public address/u);
    expect(accepted).toHaveLength(0);
  });

  it('NIGHT: A PRIVATE ADDRESS SENT UNDER THE PRIVATE NAME IS REFUSED TOO', async () => {
    answerWith = () => disclosed(RECEIVING_ADDRESS, PRIVATE_ADDRESS);
    const { container, accepted } = await approveAnInvitationIn('NIGHT');
    const settled = await settledOn(container);
    /* RED WHEN the page reads the address from the attribute it did not ask for. */
    expect(settled.code).toBeNull();
    expect(settled.err).toMatch(/other/u);
    expect(accepted).toHaveLength(0);
  });

  it('MONEY WITH A PRIVATE FORM WORKS AS BEFORE: THE SHIELDED ADDRESS IS ASKED FOR AND A PUBLIC ONE REFUSED', async () => {
    answerWith = (asked) => disclosed(asked, PUBLIC_ADDRESS);
    const { container, accepted } = await approveAnInvitationIn('TESTUSD', (offerScreen) => {
      expect(offerScreen.querySelector('[data-public-payment]')).toBeNull();
      expect(offerScreen.querySelector('[data-sealed-never-seen]')).not.toBeNull();
    });
    expect(addressAsks[0]!.wants).toEqual([expect.objectContaining({ attribute: RECEIVING_ADDRESS, required: true })]);
    const settled = await settledOn(container);
    expect(settled.code).toBeNull();
    expect(settled.err).toMatch(/not a payee address/u);
    expect(accepted).toHaveLength(0);
  });
});
