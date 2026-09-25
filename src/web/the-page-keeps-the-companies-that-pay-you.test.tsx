// @vitest-environment jsdom
/**
 * **THE PAGE ITSELF KEEPS THE LIST OF COMPANIES THAT PAY YOU WHERE IT IS FOUND
 * AGAIN, FEEDS IT TO THE COMPANY LIST, AND OPENS ONE WITHOUT ANYTHING A SIGNER
 * SEES.**
 *
 * Driven through the whole page, from its own buttons, with a server and a
 * wallet that answer the way the real ones do. The wallet is the wallet's own
 * code answering over the real conversation, so the key the page holds is one
 * the wallet really gave, and it gives the key for the address the page signed
 * in as only when it holds that address.
 *
 * What these pin:
 *
 *   1. the list saved with a person reaches the company list, and opening a
 *      company from it shows that person's payslips view and no signer screen;
 *   2. a company held in this browser before the saved keys were open is moved
 *      into them when the person unlocks in the tab that signed them in;
 *   3. in a tab that did not sign them in, a person with nothing saved yet is
 *      told why it cannot be saved there, and the company waits for them in
 *      this browser until they sign in again, when it is saved.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { READY_PING } from 'midnight-identity/profile/channel';
import { keyringKeyFor, keyringReleaseFor } from 'midnight-identity/profile/unlock';
import { seal, toHex, unseal } from '../core/crypto.js';
import { keyringAsk, KEYRING_PURPOSE } from '../core/wallet-unlock.js';
import type { Openable } from './wallet-sign-in.js';

const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const PERSON = 'usr_1';
const ACME = 'ab'.repeat(32);
const identity = identityFromWords(TEST_MNEMONIC);

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

/* The page opens the wallet in its own window; here the wallet above answers instead. */
vi.mock('./keyring.js', async (original) => {
  const real = await original<typeof import('./keyring.js')>();
  return {
    ...real,
    openKeysWithWallet: (origin: string) => real.openKeysWithWallet(origin, new WalletAtTheOtherEnd(), US),
    signInWithWallet: (origin: string, token?: string) => real.signInWithWallet(origin, token, new WalletAtTheOtherEnd()),
  };
});
/* The page is built knowing where the wallet is served from, before any of it is loaded. */
vi.hoisted(() => { vi.stubEnv('VITE_WALLET_ORIGIN', 'https://wallet.example'); });

const keyring = await import('./keyring.js');

/** The keyring key the wallet above gives this person. */
const keyringHex = () => toHex(keyringKeyFor(identity, parseAsk(keyringAsk({
  name: 'n', rdns: 'r', purpose: KEYRING_PURPOSE, nonce: 'n', expiresAt: Date.now() + 60_000,
  person: PERSON, signedInAs: null, company: null,
}), US, Date.now()) as KeyringRequest));

/** A company this person signs for, sealed; its name cannot be read until the keys open. */
const SIGNED_FOR = { id: 'acc_1', signerCount: 1, threshold: 1, wrappedKeys: [], wiring: 'chain' };

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); localStorage.clear();
});

/** A server that answers these routes the way the real one does, and records every write of the saved keys. */
function aServer(saved: { paidBy?: string[] } | null, signsFor: unknown[] = []) {
  let bundle: unknown = saved === null ? null : seal(JSON.stringify({ accounts: {}, ...saved }), keyringHex());
  let version = saved === null ? 0 : 1;
  const writes: Array<{ keyBundle: unknown }> = [];
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET');
    asked.push(`${method} ${url}`);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    const user = { id: PERSON, email: null, name: '' };
    switch (`${method} ${url}`) {
      case 'POST /api/auth/wallet/challenge':
        return json(200, { nonce: 'nonce', handle: 'h', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      case 'POST /api/auth/wallet': return json(200, { user, address: SIGNED_IN, created: false, session: {} });
      case 'POST /api/auth/logout': return json(200, { ok: true });
      case 'GET /api/me': return json(200, { user, accounts: signsFor });
      case 'GET /api/accounts': return json(200, signsFor);
      case 'GET /api/me/keys': return json(200, { keyBundle: bundle, version });
      case 'PUT /api/me/keys':
        writes.push(body);
        bundle = body.keyBundle;
        version += 1;
        return json(200, { version });
      default: return json(404, { error: `no route for ${method} ${url}` });
    }
  }) as typeof fetch;
  const savedList = (i: number) => JSON.parse(unseal(writes[i]!.keyBundle as never, keyringHex())).paidBy;
  return { writes, savedList, asked };
}

async function thePage() {
  const { default: App } = await import('./App.js');
  const { SimulatedCommitments } = await import('../core/ledger.js');
  return render(<App commitments={SimulatedCommitments} />);
}

const unlock = async (container: HTMLElement) => {
  const button = await waitFor(() => {
    const b = container.querySelector('[data-unlock-employers]') as HTMLButtonElement | null;
    expect(b).not.toBeNull();
    return b!;
  });
  fireEvent.click(button);
};

describe('the page keeps the companies that pay you where they are found again', () => {
  it('THE SAVED LIST REACHES THE COMPANY LIST, AND OPENING ONE SHOWS NOTHING A SIGNER SEES', async () => {
    aServer({ paidBy: [ACME] }, [SIGNED_FOR]);
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    const { container } = await thePage();
    await waitFor(() => expect(container.textContent).toContain('A company you are a signer on'));
    /* Before the saved keys are open, the list inside them cannot be shown. */
    expect(container.querySelector(`[data-employer="${ACME}"]`)).toBeNull();
    await unlock(container);
    /* RED WHEN the page does not feed the list saved with the person to the company list. */
    const row = await waitFor(() => {
      const r = container.querySelector(`[data-employer="${ACME}"]`) as HTMLButtonElement | null;
      expect(r).not.toBeNull();
      return r!;
    });
    fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('[data-employer-view]')).not.toBeNull());
    /* RED WHEN the company list, or anything a signer sees, is drawn beside or under the payslips view. */
    const text = container.textContent ?? '';
    for (const signerOnly of ['A company you are a signer on', 'Your accounts', 'Approvals', 'Run payroll']) {
      expect(text).not.toContain(signerOnly);
    }
    expect(container.querySelector('[data-employers]')).toBeNull();
    expect(container.querySelector('[data-company]')?.textContent).toBe(ACME);
  });

  it('A NEW EMPLOYEE WHO ACCEPTS AND UNLOCKS IN THE TAB THAT SIGNED THEM IN HAS THE COMPANY IN THEIR SAVED KEYS', async () => {
    const { writes, savedList } = aServer(null);
    /* Accepting an invitation signs the person in and keeps the company for them before any keys are open. */
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await keyring.rememberCompanyThatPaysYou(ACME);
    expect(writes).toHaveLength(0);
    /* The accepted screen's link is followed in the same tab: the page is drawn again, not loaded again. */
    const { container } = await thePage();
    await unlock(container);
    /* RED WHEN the company stays in this browser: nothing is saved, and it does not follow them. */
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(savedList(0)).toEqual([ACME]);
    expect(localStorage.getItem(`payslip-companies-of:${PERSON}`)).toBeNull();
    await waitFor(() => expect(container.querySelector(`[data-employer="${ACME}"]`)).not.toBeNull());
    expect(container.querySelector('.err')).toBeNull();
  });

  it('IN A RELOADED TAB WITH NOTHING SAVED, IT IS SAID WHY, AND A FRESH SIGN-IN SAVES IT', async () => {
    const { writes, savedList } = aServer(null);
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await keyring.rememberCompanyThatPaysYou(ACME);
    /* The tab is loaded again: it forgets who it signed in, and the page picks the sign-in up from the server. */
    keyring.forgetLocally();
    const { container } = await thePage();
    await unlock(container);
    /* RED WHEN the refusal is swallowed and the company stays in this browser with nothing on screen. */
    await waitFor(() => expect(container.textContent).toContain(
      'Sign in again in this tab, with the same wallet address, and try again.'));
    expect(writes).toHaveLength(0);
    /* It is not lost: this browser still holds it for this person, and the list still shows it. */
    expect(JSON.parse(localStorage.getItem(`payslip-companies-of:${PERSON}`) ?? '[]')).toEqual([ACME]);
    expect(container.querySelector(`[data-employer="${ACME}"]`)).not.toBeNull();
    /* Signing out and in again in this tab, from the page's own buttons, lets the next unlock save it with them. */
    fireEvent.click([...container.querySelectorAll('a')].find(a => a.textContent === 'Sign out')!);
    const signIn = await waitFor(() => {
      const b = container.querySelector('button.primary') as HTMLButtonElement | null;
      expect(b?.textContent).toMatch(/wallet/i);
      return b!;
    });
    fireEvent.click(signIn);
    await unlock(container);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(savedList(0)).toEqual([ACME]);
    expect(localStorage.getItem(`payslip-companies-of:${PERSON}`)).toBeNull();
  });

  it('UNLOCKING A COMPANY YOU SIGN FOR, IN A RELOADED TAB WITH NOTHING SAVED, SAYS WHY THE LIST WAS NOT SAVED AND DOES NOT OPEN THE COMPANY OVER IT', async () => {
    const { writes, asked } = aServer(null, [SIGNED_FOR]);
    await keyring.signInWithWallet(WALLET, undefined, new WalletAtTheOtherEnd());
    await keyring.rememberCompanyThatPaysYou(ACME);
    keyring.forgetLocally();
    const { container } = await thePage();
    const row = await waitFor(() => {
      const r = [...container.querySelectorAll('button.acctrow')]
        .find(b => b.textContent?.includes('A company you are a signer on')) as HTMLButtonElement | undefined;
      expect(r).toBeTruthy();
      return r!;
    });
    fireEvent.click(row);
    /* RED WHEN the refusal is swallowed, or the company is opened and the sentence is lost under it. */
    await waitFor(() => expect(container.textContent).toContain(
      'Sign in again in this tab, with the same wallet address, and try again.'));
    expect(asked).not.toContain('GET /api/accounts/acc_1');
    expect(writes).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(`payslip-companies-of:${PERSON}`) ?? '[]')).toEqual([ACME]);
  });

  it('THE ACCEPTED SCREEN\'S LINK TO YOUR PAYSLIPS IS FOLLOWED IN THIS TAB, AND A NEW-TAB CLICK IS LEFT TO THE BROWSER', async () => {
    const { Accepted } = await import('./Join.js');
    const follow = vi.fn();
    const { container } = render(<Accepted company="Acme Ltd" companyAddress={ACME} onOpenPayslips={follow} />);
    const link = container.querySelector('[data-open-payslips]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/payslips');
    /* RED WHEN the link loads the page again: the tab forgets who it signed in and cannot save first keys. */
    expect(fireEvent.click(link)).toBe(false);
    expect(follow).toHaveBeenCalledTimes(1);
    /* A click asking for another tab is the browser's to follow. */
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(follow).toHaveBeenCalledTimes(1);
  });
});
