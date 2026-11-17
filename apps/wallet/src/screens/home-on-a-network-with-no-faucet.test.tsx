// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '../testing/render.js';
import { IDBFactory } from 'fake-indexeddb';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { identityFromSecret, newSecret } from 'midnight-identity';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { BalanceEnginesContext } from '../chain/balance-context.js';
import type { BalanceEngine } from '../chain/balance.js';

/*
 * ON A NETWORK THAT GIVES NO TEST MONEY AWAY, THE HOME SCREEN SAYS NOTHING OF A
 * FAUCET. The screen reads whether there is one from the network's own record
 * (`network-words.ts`), so this file stands a record with none in its place and
 * renders the two places the screen would otherwise mention it.
 */

vi.mock('./network-words.js', () => ({ NETWORK_LABEL: 'Midnight Preprod', FAUCET_NAME: null }));

import { Home } from './home.js';

/* jsdom is its own realm; see `home.test.tsx` for why the polyfill. */
(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
});

describe('the home screen on a network with no faucet', () => {
  it('the Receive popup tells where ordinary transfers pay, and names no faucet', () => {
    const secret = newSecret();
    render(<Home identity={identityFromSecret(secret)} secret={secret} />);
    fireEvent.click(screen.getByText('Receive'));
    const popup = document.querySelector('[role="dialog"]')!;
    /* RED WHEN the faucet sentence is shown whatever the record says. */
    expect(popup.textContent).toMatch(/Ordinary NIGHT transfers pay here\./);
    expect(popup.textContent).not.toMatch(/faucet/i);
  });

  it('the unshielded line is titled without the faucet', () => {
    const secret = newSecret();
    const syncs: BalanceEngine = (_identity, _account, tell) => {
      tell({ name: 'synced', night: 1_000_000n, asOf: Date.now() });
      return () => {};
    };
    const inert: BalanceEngine = () => () => {};
    render(
      <BalanceEnginesContext.Provider value={{ shielded: inert, unshielded: syncs, dust: inert }}>
        <Home identity={identityFromSecret(secret)} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    fireEvent.click(screen.getByText('Check the balance'));
    /* RED WHEN the title names the faucet whatever the record says. */
    expect(screen.getByText('Unshielded NIGHT — ordinary transfers')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/faucet/i);
  });
});
