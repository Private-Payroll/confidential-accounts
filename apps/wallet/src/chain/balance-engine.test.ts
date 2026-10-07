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
/** What the stand-in wallet holds in flight when it is serialised: a coin set aside, a coin expected, or nothing. */
let inFlight: 'spend' | 'output' | null = null;
/** Every save the engine asked of the store, and what the store answered: kept, or refused. */
const saves: Promise<boolean>[] = [];
/** The configuration the app hands the SDK's shielded wallet. */
const configured: unknown[] = [];

vi.mock('@midnightntwrk/wallet-sdk/shielded', () => {
  const standIn = () => ({
    state: {
      subscribe: (observer: { next: (state: unknown) => void }) => {
        queueMicrotask(() => observer.next({
          progress: { isConnected: true, isStrictlyComplete: () => true },
          balances: reported,
          serialize: () => snapshotForTest({ inFlight }),
        }));
        return { unsubscribe: () => {} };
      },
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  });
  return {
    ShieldedWallet: (config: unknown) => {
      configured.push(config);
      return {
        startWithSecretKeys: () => { doors.push('cold'); return standIn(); },
        restore: () => { doors.push('restore'); return standIn(); },
      };
    },
  };
});

/* The store the app runs, with each save the engine asks for kept, so a test waits for the store's answer rather than a clock. */
vi.mock('../accounts/storage.js', async (original) => {
  const real = await original<typeof import('../accounts/storage.js')>();
  return {
    ...real,
    saveWalletCheckpoint: (...args: Parameters<typeof real.saveWalletCheckpoint>) => {
      const answered = real.saveWalletCheckpoint(...args);
      saves.push(answered);
      return answered;
    },
  };
});

const { snapshotForTest } = await import('../testing/snapshot.js');
const { READ_BATCH_SIZE, startBalance, coinPublicKeyOf } = await import('./balance.js');
const { loadWalletCheckpoint, saveWalletCheckpoint } = await import('../accounts/storage.js');
const { ORIGINAL_SLOT, checkpointKeyFor, forgetOpenWallet, sealKeyFor } = await import('../accounts/wallets-held.js');
const { toBase64Url } = await import('midnight-identity/passkey/bytes');

/** Account 0's entry in the open compartment's checkpoint record, as the store holds it. */
const keptFor0 = async (): Promise<unknown> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('midnight-identity', 1);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const record = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction('keys', 'readonly').objectStore('keys').get(checkpointKeyFor(ORIGINAL_SLOT));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return (record as { perAccount?: Record<string, unknown> } | undefined)?.perAccount?.['0'];
};

/**
 * Seals a checkpoint for account 0 into the store the way a wallet did before
 * the store refused snapshots holding anything in flight: written field by
 * field, so it does not pass through today's guard.
 */
const sealAsBefore = async (coinPublicKey: string, serialized: string): Promise<void> => {
  /* Any kept save makes the compartment's sealing key; then the entry is replaced. */
  await saveWalletCheckpoint(coinPublicKey, 0, { serialized: snapshotForTest(), night: 1n, asOf: 1 }, ORIGINAL_SLOT);
  saves.length = 0;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('midnight-identity', 1);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const get = (key: string): Promise<unknown> => new Promise((resolve, reject) => {
    const request = db.transaction('keys', 'readonly').objectStore('keys').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const key = (await get(sealKeyFor(ORIGINAL_SLOT))) as CryptoKey;
  const record = (await get(checkpointKeyFor(ORIGINAL_SLOT))) as {
    perAccount: Record<string, { coinPublicKey: string; iv: string; sealed: string }>;
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ coinPublicKey, serialized, night: '5', asOf: 1 }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource));
  record.perAccount['0'] = { coinPublicKey, iv: toBase64Url(iv), sealed: toBase64Url(sealed) };
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction('keys', 'readwrite').objectStore('keys').put(record, checkpointKeyFor(ORIGINAL_SLOT));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  db.close();
};

beforeEach(() => {
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  doors.length = 0;
  saves.length = 0;
  inFlight = null;
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
        serialized: snapshotForTest(), night: 1_234_567n, others: { [TOKEN]: 5_000n },
      });
    });
  });

  it('opens from a checkpoint that recorded other tokens WITH them, before the live answer', async () => {
    const identity = identityFromSecret(newSecret());
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, {
      serialized: snapshotForTest(), night: 9n, others: { [TOKEN]: 7n }, asOf: 1_000,
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
      serialized: snapshotForTest(), night: 9n, asOf: 1_000,
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

describe('A CHECKPOINT IS NEVER WRITTEN WITH ANYTHING IN FLIGHT', () => {
  it('a state holding coins set aside, or coins expected, is shown and never written down', async () => {
    for (const which of ['spend', 'output'] as const) {
      localStorage.clear();
      (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
      saves.length = 0;
      const identity = identityFromSecret(newSecret());
      inFlight = which;
      reported = { [NIGHT_RAW]: 5n };
      const [synced] = await syncedStates(identity, 1);
      expect(synced?.night, which).toBe(5n);
      /* The store's own answer to the engine's save, awaited rather than guessed at with a clock. */
      await vi.waitFor(() => expect(saves.length, which).toBeGreaterThan(0));
      /* RED WHEN: a snapshot with coins set aside is sealed, and every wallet restored from it keeps them set aside for good. */
      expect(await Promise.all(saves), which).toEqual(saves.map(() => false));
      expect(await loadWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, ORIGINAL_SLOT), which).toBeNull();
    }
  });

  it('a snapshot kept before the store refused one is not restored: it is taken out, and the next read writes a clean one', async () => {
    const identity = identityFromSecret(newSecret());
    /* A snapshot holding a coin set aside, sealed into the store as an older wallet could have done. */
    await sealAsBefore(coinPublicKeyOf(identity, 0), snapshotForTest({ inFlight: 'spend' }));
    /* RED WHEN: the refused snapshot is left in the store, to be refused again on every open until a read completes. */
    expect(await loadWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, ORIGINAL_SLOT)).toBeNull();
    expect(await keptFor0()).toBeUndefined();
    reported = { [NIGHT_RAW]: 5n };
    await syncedStates(identity, 1);
    /* RED WHEN: the engine restores a snapshot that still holds coins set aside. */
    expect(doors).toEqual(['cold']);
    await vi.waitFor(() => expect(saves.length).toBeGreaterThan(0));
    await Promise.all(saves);
    /* RED WHEN: the refused snapshot stays, and is never replaced by the clean read that followed. */
    expect((await loadWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, ORIGINAL_SLOT))?.serialized).toBe(snapshotForTest());
  });
});

describe('THE WALLET READS THE NETWORK A HUNDRED EVENTS AT A TIME', () => {
  it('hands the SDK a batch of a hundred and nothing else about the read', async () => {
    configured.length = 0;
    const identity = identityFromSecret(newSecret());
    reported = {};
    await syncedStates(identity, 1);
    /* RED WHEN: the batch goes back to the SDK's ten, and a cold private read takes about three fifths longer. */
    expect((configured[0] as { batchUpdates?: unknown }).batchUpdates).toEqual({ size: READ_BATCH_SIZE });
    expect(READ_BATCH_SIZE).toBe(100);
  });
});
