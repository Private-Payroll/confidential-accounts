// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { shieldedToken } from '@midnightntwrk/ledger-v9';
import { identityFromSecret, newSecret } from 'midnight-identity';
import type { BalanceState } from './balance.js';

/*
 * THE ENGINE ITSELF, WITH THE SDK'S WALLET REPLACED AND NOTHING ELSE.
 *
 * The screen tests drive a fake engine, so they cannot see what the real one
 * does with the SDK's state: which keys it reads out of the balance map, what
 * it tells the screen, and what it seals into the checkpoint. Here the SDK's
 * shielded wallet is the only thing replaced, by a stand-in that reports one
 * completed sync with a chosen balance map, and everything between that map
 * and the saved checkpoint is the code the app runs. Nothing touches the
 * network.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const TOKEN = '7e'.repeat(32);
const NIGHT_RAW = shieldedToken().raw;

/** The balance map the stand-in wallet reports when its sync completes. */
let reported: Record<string, bigint> = {};
/** Which door the engine took: the cold one or the restore one. */
const doors: string[] = [];

vi.mock('@midnightntwrk/wallet-sdk/shielded', () => {
  const standIn = () => ({
    state: {
      subscribe: (observer: { next: (state: unknown) => void }) => {
        queueMicrotask(() => observer.next({
          progress: { isConnected: true, isStrictlyComplete: () => true },
          balances: reported,
          serialize: () => 'SNAPSHOT',
        }));
        return { unsubscribe: () => {} };
      },
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  });
  return {
    ShieldedWallet: () => ({
      startWithSecretKeys: () => { doors.push('cold'); return standIn(); },
      restore: () => { doors.push('restore'); return standIn(); },
    }),
  };
});

const { startBalance, coinPublicKeyOf } = await import('./balance.js');
const { loadWalletCheckpoint, saveWalletCheckpoint } = await import('../accounts/storage.js');
const { ORIGINAL_SLOT, forgetOpenWallet } = await import('../accounts/wallets-held.js');

beforeEach(() => {
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  doors.length = 0;
});

/** Runs the engine until it has said `count` synced states, then stops it. */
const syncedStates = async (
  identity: ReturnType<typeof identityFromSecret>, count: number,
): Promise<Extract<BalanceState, { name: 'synced' }>[]> => {
  const seen: Extract<BalanceState, { name: 'synced' }>[] = [];
  const stop = startBalance(identity, 0, (state) => {
    if (state.name === 'synced') seen.push(state);
  });
  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(count));
  stop();
  return seen;
};

describe('the engine reads the whole balance map and seals all of it', () => {
  it('tells the screen NIGHT and every other held token, and saves both', async () => {
    const identity = identityFromSecret(newSecret());
    reported = { [NIGHT_RAW]: 1_234_567n, [TOKEN]: 5_000n };
    const [synced] = await syncedStates(identity, 1);
    /* RED WHEN the engine reads NIGHT alone out of the map. */
    expect(synced?.night).toBe(1_234_567n);
    expect(synced?.others).toEqual({ [TOKEN]: 5_000n });
    expect(doors).toEqual(['cold']);
    /* RED WHEN the checkpoint the engine writes drops the other tokens. */
    await vi.waitFor(async () => {
      const saved = await loadWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, ORIGINAL_SLOT);
      expect(saved).toMatchObject({
        serialized: 'SNAPSHOT', night: 1_234_567n, others: { [TOKEN]: 5_000n },
      });
    });
  });

  it('opens from a checkpoint that recorded other tokens WITH them, before the live answer', async () => {
    const identity = identityFromSecret(newSecret());
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, {
      serialized: 'NEW', night: 9n, others: { [TOKEN]: 7n }, asOf: 1_000,
    }, ORIGINAL_SLOT);
    reported = { [TOKEN]: 5_000n };
    const [fromDisk] = await syncedStates(identity, 2);
    expect(doors).toEqual(['restore']);
    /* RED WHEN a checkpoint that did record other tokens reopens as "not
     * recorded", or with its NIGHT moved. */
    expect(fromDisk).toEqual({ name: 'synced', night: 9n, asOf: 1_000, others: { [TOKEN]: 7n } });
  });

  it('opens from an old checkpoint as NIGHT only, then the live sync brings the whole map', async () => {
    const identity = identityFromSecret(newSecret());
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, {
      serialized: 'OLD', night: 9n, asOf: 1_000,
    }, ORIGINAL_SLOT);
    reported = { [TOKEN]: 5_000n };
    const [fromDisk, live] = await syncedStates(identity, 2);
    expect(doors).toEqual(['restore']);
    /* RED WHEN an old checkpoint is shown as holding no other token. */
    expect(fromDisk).toEqual({ name: 'synced', night: 9n, asOf: 1_000 });
    expect(fromDisk && 'others' in fromDisk).toBe(false);
    /* RED WHEN the live answer after it still reads only NIGHT. */
    expect(live?.night).toBe(0n);
    expect(live?.others).toEqual({ [TOKEN]: 5_000n });
  });
});
