// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { identityFromSecret, newSecret } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { coinPublicKeyOf } from '../chain/balance.js';
import type { BalanceEngine } from '../chain/balance.js';
import { BalanceEnginesContext } from '../chain/balance-context.js';
import { saveWalletCheckpoint } from '../accounts/storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet } from '../accounts/wallets-held.js';
import { WALLET_ACCOUNTS } from '../accounts/subwallets.js';
import { Home } from '../screens/home.js';
import {
  SWEEP_SLOT_GIVE_UP_MS, earnsAPreviewPlace, holdsMoney, useWalletBalances,
} from './wallet-balances.js';
import type { WalletBalanceRows } from './wallet-balances.js';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const inert: BalanceEngine = () => () => {};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
});

/**
 * An engine shaped like the real one: it replays the figure it saved last time,
 * with that figure's old moment, the instant it starts, and reads the chain a
 * moment later. It records every stop it is given, per slot.
 */
function replayingEngine(): {
  engine: BalanceEngine;
  stopped: Record<number, number>;
  stoppedBeforeLive: number[];
} {
  const stopped: Record<number, number> = {};
  const stoppedBeforeLive: number[] = [];
  const engine: BalanceEngine = (_identity, account, tell) => {
    let live = false;
    let stop = false;
    tell({ name: 'synced', night: 1n, asOf: 1_000 });
    setTimeout(() => {
      if (stop) return;
      live = true;
      tell({ name: 'synced', night: BigInt(account) * 1_000_000n, asOf: Date.now() });
    }, 5);
    return () => {
      stop = true;
      stopped[account] = (stopped[account] ?? 0) + 1;
      if (!live) stoppedBeforeLive.push(account);
    };
  };
  return { engine, stopped, stoppedBeforeLive };
}

function SweepProbe({ identity, onRows }: {
  identity: Identity; onRows: (rows: WalletBalanceRows, sweeping: boolean, sweep: () => void) => void;
}) {
  const { rows, sweeping, sweep } = useWalletBalances(identity);
  useEffect(() => { onRows(rows, sweeping, sweep); });
  return null;
}

describe('the check-all sweep, against an engine that replays before it reads', () => {
  it('every slot is read live, and each engine is stopped once, after its own answer', async () => {
    const { engine, stopped, stoppedBeforeLive } = replayingEngine();
    let rows: WalletBalanceRows = {};
    let sweeping = false;
    let sweep: () => void = () => {};
    const started = Date.now();
    render(
      <BalanceEnginesContext.Provider value={{ shielded: engine, unshielded: inert, dust: inert }}>
        <SweepProbe identity={identityFromSecret(newSecret())}
          onRows={(r, s, go) => { rows = r; sweeping = s; sweep = go; }} />
      </BalanceEnginesContext.Provider>,
    );
    act(() => { sweep(); });
    await waitFor(() => expect(sweeping).toBe(false), { timeout: 5_000 });
    for (const account of WALLET_ACCOUNTS) {
      const row = rows[account];
      /* RED WHEN the sweep takes the replayed figure as the answer: every row
       * carries the replay's one STAR and its moment of 1970. */
      expect(row?.kind, String(account)).toBe('known');
      if (row?.kind !== 'known') continue;
      expect(row.night, String(account)).toBe(BigInt(account) * 1_000_000n);
      expect(row.asOf, String(account)).toBeGreaterThanOrEqual(started);
      /* RED WHEN a slot's finish stops whatever engine is current by then:
       * the next slot's is stopped before it answers, and its own is never
       * stopped. */
      expect(stopped[account], String(account)).toBe(1);
    }
    expect(stoppedBeforeLive).toEqual([]);
  });

  it('a slot that never reads live keeps its replayed figure, with its old moment, at the deadline', async () => {
    /* Only the replay, then silence. The sweep must still finish. */
    const silent: BalanceEngine = (_identity, _account, tell) => {
      tell({ name: 'synced', night: 7n, asOf: 1_000 });
      return () => {};
    };
    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let rows: WalletBalanceRows = {};
      let sweeping = false;
      let sweep: () => void = () => {};
      render(
        <BalanceEnginesContext.Provider value={{ shielded: silent, unshielded: inert, dust: inert }}>
          <SweepProbe identity={identityFromSecret(newSecret())}
            onRows={(r, s, go) => { rows = r; sweeping = s; sweep = go; }} />
        </BalanceEnginesContext.Provider>,
      );
      act(() => { sweep(); });
      for (let i = 0; i < WALLET_ACCOUNTS.length; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(SWEEP_SLOT_GIVE_UP_MS); });
      }
      /* RED WHEN the sweep has no deadline of its own: it waits on slot 0 for
       * ever, because an engine stops reporting failure once a figure is shown. */
      expect(sweeping).toBe(false);
      for (const account of WALLET_ACCOUNTS) {
        expect(rows[account]).toEqual({ kind: 'known', night: 7n, asOf: 1_000 });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the sweep, at its two other edges', () => {
  const sweepWith = async (engine: BalanceEngine): Promise<WalletBalanceRows> => {
    let rows: WalletBalanceRows = {};
    let sweeping = false;
    let sweep: () => void = () => {};
    render(
      <BalanceEnginesContext.Provider value={{ shielded: engine, unshielded: inert, dust: inert }}>
        <SweepProbe identity={identityFromSecret(newSecret())}
          onRows={(r, s, go) => { rows = r; sweeping = s; sweep = go; }} />
      </BalanceEnginesContext.Provider>,
    );
    act(() => { sweep(); });
    await waitFor(() => expect(sweeping).toBe(false), { timeout: 5_000 });
    return rows;
  };

  it('a check that fails after a replay keeps the replayed figure with its old moment', async () => {
    const engine: BalanceEngine = (_identity, _account, tell) => {
      tell({ name: 'synced', night: 3n, asOf: 1_000 });
      setTimeout(() => tell({ name: 'failed', message: 'gone' }), 1);
      return () => {};
    };
    const rows = await sweepWith(engine);
    /* RED WHEN a failure discards the figure the slot already had. */
    for (const account of WALLET_ACCOUNTS) {
      expect(rows[account]).toEqual({ kind: 'known', night: 3n, asOf: 1_000 });
    }
  });

  it('an engine that answers before its handle is returned is still stopped, once', async () => {
    const stopped: Record<number, number> = {};
    const engine: BalanceEngine = (_identity, account, tell) => {
      tell({ name: 'synced', night: 1n, asOf: Date.now() });
      return () => { stopped[account] = (stopped[account] ?? 0) + 1; };
    };
    await sweepWith(engine);
    /* RED WHEN the handle of an engine that answered at once is never used. */
    for (const account of WALLET_ACCOUNTS) expect(stopped[account], String(account)).toBe(1);
  });
});

describe('a figure that did not record other tokens is not ranked empty', () => {
  it('as a rule', () => {
    expect(earnsAPreviewPlace({ kind: 'known', night: 0n, asOf: 1 })).toBe(true);
    expect(earnsAPreviewPlace({ kind: 'known', night: 0n, asOf: 1, others: {} })).toBe(false);
    expect(earnsAPreviewPlace({ kind: 'unknown' })).toBe(false);
    /* And the money question itself is unchanged. */
    expect(holdsMoney({ kind: 'known', night: 0n, asOf: 1 })).toBe(false);
  });

  it('on Home: an old figure with zero NIGHT takes a preview place ahead of a checked-empty slot', async () => {
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    /* Account 9 was saved by an older wallet that recorded NIGHT only. Account
     * 11 was checked by this one and holds nothing. */
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 9), 9, {
      serialized: 'x', night: 0n, asOf: Date.now(),
    }, ORIGINAL_SLOT);
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 11), 11, {
      serialized: 'x', night: 0n, others: {}, asOf: Date.now(),
    }, ORIGINAL_SLOT);
    render(
      <BalanceEnginesContext.Provider value={{ shielded: inert, unshielded: inert, dust: inert }}>
        <Home identity={identity} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    const previewed = (): string[] =>
      [...document.querySelectorAll('[data-wallet-preview-row]')]
        .map((row) => row.getAttribute('data-account') ?? '');
    /* RED WHEN the preview ranks by `holdsMoney` alone: 9 reads as empty and
     * the preview is 0, 2, 3. */
    await waitFor(() => expect(previewed()).toContain('9'));
    expect(previewed()).not.toContain('11');
  });
});
