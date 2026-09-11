// @vitest-environment jsdom
/**
 * **A WALLET ADDRESS THIS DEPLOYMENT HAS NEVER SEEN IS TOLD SO.**
 *
 * A person on this deployment is one wallet address: a sign-in resolves an
 * existing person by the address that answered, and an address it has not seen
 * becomes a new person with no companies. A wallet holds several addresses, so
 * signing in with a different one than last time lands on an empty list that
 * looks exactly like a list that lost its companies.
 *
 * The server reports whether the sign-in created the person. The picker says
 * so when it did and the list is empty - and says nothing when it did not, or
 * when a reload means nobody knows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { READY_PING } from 'midnight-identity/profile/channel';
import type { Openable } from './wallet-sign-in.js';
import * as keyring from './keyring.js';
import { AccountPicker } from './Auth.js';

const WALLET = 'https://wallet.example';

class WalletThatSignsIn implements Openable {
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: () => queueMicrotask(() => this.deliver({ schema: 'a-sign-in' })) };
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
}

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; keyring.forgetLocally(); });

function aServer(created: boolean) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = `${String(init?.method ?? 'GET')} ${url}`;
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;
    const user = { id: 'usr_1', email: null, name: '' };
    if (key === 'POST /api/auth/wallet/challenge') {
      return json({ nonce: 'n', handle: 'h', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (key === 'POST /api/auth/wallet') return json({ user, address: 'mn_shield-addr', created, session: {} });
    if (key === 'GET /api/me') return json({ user, accounts: [] });
    return { ok: false, status: 404, json: async () => ({ error: key }) } as Response;
  }) as typeof fetch;
}

const picker = (accounts: unknown[] = []) => render(
  <AccountPicker
    user={{ id: 'usr_1', email: null, name: '' }} accounts={accounts} busy={false}
    onOpen={() => {}} onUnlock={() => {}} onCreateWithWallet={() => {}}
    onFinishSetup={() => {}} awaitingSetup={null} onDemo={() => {}} onSignOut={() => {}} />);

const NEW_HERE = 'This wallet address has not signed in here before.';

describe('a wallet address new to this deployment', () => {
  it('IS TOLD SO, and told that another address from the same wallet is another person', async () => {
    aServer(true);
    await keyring.signInWithWallet(WALLET, undefined, new WalletThatSignsIn());
    const text = picker().container.textContent ?? '';
    expect(text).toContain(NEW_HERE);
    expect(text).toContain('Each address is a separate person here');
  });

  it('an address this deployment has seen before is NOT told it is new', async () => {
    aServer(false);
    await keyring.signInWithWallet(WALLET, undefined, new WalletThatSignsIn());
    const text = picker().container.textContent ?? '';
    expect(text).not.toContain(NEW_HERE);
    /* And the screen is the empty one, so the absence is not an empty render. */
    expect(text).toContain('You are not a signer on any company here yet');
  });

  it('and a tab that has forgotten its session claims nothing either', async () => {
    aServer(true);
    await keyring.signInWithWallet(WALLET, undefined, new WalletThatSignsIn());
    expect(keyring.signedInForTheFirstTimeHere()).toBe(true);
    keyring.forgetLocally();
    expect(keyring.signedInForTheFirstTimeHere()).toBe(false);
  });

  it('a session picked up after a reload claims nothing, because nothing says', async () => {
    aServer(true);
    await keyring.signInWithWallet(WALLET, undefined, new WalletThatSignsIn());
    await keyring.resumeSession();
    expect(picker().container.textContent ?? '').not.toContain(NEW_HERE);
  });

  it('and a new address that already has a company (an invitation brought it) is not told its list is empty', async () => {
    aServer(true);
    await keyring.signInWithWallet(WALLET, undefined, new WalletThatSignsIn());
    const text = picker([{ id: 'acc_1', name: 'x', signers: 1, threshold: 1 }]).container.textContent ?? '';
    expect(text).not.toContain(NEW_HERE);
    expect(text).toContain('A company you are a signer on');
  });
});
