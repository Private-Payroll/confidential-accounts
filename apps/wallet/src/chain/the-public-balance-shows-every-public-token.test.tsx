// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { nativeToken } from '@midnightntwrk/ledger-v9';
import { identityFromSecret, newSecret } from 'midnight-identity';
import type { BalanceEngine, BalanceState } from './balance.js';
import { BalanceEnginesContext } from './balance-context.js';
import { smallestUnits, shortColour } from './shielded-tokens.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { Home } from '../screens/home.js';

/*
 * THE PUBLIC CARD SHOWS EVERY PUBLIC TOKEN THE ACCOUNT HOLDS, NOT ONLY NIGHT.
 *
 * A payroll run pays a public payee publicly, in whatever token they are paid
 * in. The unshielded wallet reports one balance map for every public token,
 * keyed by colour; reading only NIGHT's key out of it showed such a payment as
 * nothing at all. These pin the whole map from the SDK's state to the card.
 *
 * The SDK's unshielded wallet is replaced by one that reports a fixed state, so
 * the engine the app runs is driven without a network. Everything else in the
 * SDK is the real one: the keystore and the public key the engine builds first.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NIGHT = nativeToken().raw;
const TOKEN = '5a'.repeat(32);
const NOTHING_HELD = '6b'.repeat(32);

let reported: Record<string, bigint> = {};

vi.mock('@midnightntwrk/wallet-sdk', async (original) => {
  const real = await original<typeof import('@midnightntwrk/wallet-sdk')>();
  return {
    ...real,
    UnshieldedWallet: () => ({
      startWithPublicKey: () => ({
        state: {
          subscribe: ({ next }: { next: (state: unknown) => void }) => {
            next({
              progress: { isConnected: true, isStrictlyComplete: () => true },
              balances: reported,
            });
            return { unsubscribe: () => undefined };
          },
        },
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
    }),
  };
});

const { startUnshieldedBalance, syncedFromUnshielded } = await import('./unshielded.js');

const inert: BalanceEngine = () => () => {};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
});

describe('every public token an account holds, from the SDK to the card', () => {
  it('the state a completed public sync makes carries the whole map, NIGHT as itself', () => {
    const synced = syncedFromUnshielded({ [NIGHT]: 5_000_000n, [TOKEN]: 700n, [NOTHING_HELD]: 0n }, 42);
    /* RED WHEN NIGHT is read from any key but public NIGHT's own. */
    expect(synced.night).toBe(5_000_000n);
    /* RED WHEN the map is dropped, a zero is kept, or NIGHT is listed again. */
    expect(synced.others).toEqual({ [TOKEN]: 700n });
    expect(synced.asOf).toBe(42);
    /* A map holding no NIGHT key read whole: no NIGHT, never a missing number. */
    expect(syncedFromUnshielded({ [TOKEN]: 1n }, 1)).toMatchObject({ night: 0n, others: { [TOKEN]: 1n } });
  });

  it('the engine the app runs reports every public token, not only NIGHT', () => {
    reported = { [NIGHT]: 5_000_000n, [TOKEN]: 700n };
    const seen: BalanceState[] = [];
    const stop = startUnshieldedBalance(identityFromSecret(newSecret()), 0, (s) => seen.push(s));
    stop();
    const synced = seen.find((s) => s.name === 'synced');
    /* RED WHEN the engine reads NIGHT's key alone: the state then carries no
     * other token and a public payment in TOKEN reads as nothing. */
    expect(synced).toMatchObject({ name: 'synced', night: 5_000_000n, others: { [TOKEN]: 700n } });
  });

  it('the public card shows a non-NIGHT public token on its own line, NIGHT unchanged', () => {
    /* Each engine has its own stand-in, and both answer, so a card fed by the wrong one shows it. */
    const tells: Record<'shielded' | 'unshielded', Array<(s: BalanceState) => void>> = { shielded: [], unshielded: [] };
    const standIn = (kind: 'shielded' | 'unshielded'): BalanceEngine => (_identity, _account, onState) => {
      tells[kind].push(onState);
      return () => undefined;
    };
    const secret = newSecret();
    const { container } = render(
      <BalanceEnginesContext.Provider value={{ shielded: standIn('shielded'), unshielded: standIn('unshielded'), dust: inert }}>
        <Home identity={identityFromSecret(secret)} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    fireEvent.click(screen.getByText('Check the balance'));
    act(() => {
      for (const tell of tells.shielded) tell({ name: 'synced', night: 1_000_000n, asOf: Date.now(), others: {} });
      for (const tell of tells.unshielded) tell({ name: 'synced', night: 5_000_000n, asOf: Date.now(), others: { [TOKEN]: 700n } });
    });
    const line = container.querySelector(`[data-kind="unshielded"] [data-token="${TOKEN}"]`);
    /* RED WHEN the card lists other tokens on the private line only. */
    expect(line?.textContent).toContain(`${smallestUnits(700n)} of token`);
    expect(line?.textContent).toContain(shortColour(TOKEN));
    expect(line?.textContent).toContain(TOKEN);
    /* NIGHT's figure is still NIGHT's. */
    expect(container.querySelector('[data-kind="unshielded"] .balance-big')?.textContent)
      .toMatch(/^5 tNIGHT$/u);
    /* RED WHEN the private card is fed by the public engine: it then lists the public token. */
    expect(container.querySelector(`[data-kind="shielded"] [data-token="${TOKEN}"]`)).toBeNull();
  });
});
