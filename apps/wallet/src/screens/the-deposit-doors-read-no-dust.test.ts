// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { identityFromSecret, newSecret } from 'midnight-identity';

/*
 * THE DOORS THE DEPOSIT SCREEN PAYS THROUGH (`liveBalanceDoors`), WITH ONLY THE
 * SDK'S FACADE REPLACED. The helpers they are made of are pinned on their own;
 * here it is the doors themselves: the facade they assemble is restored from
 * this wallet's own checkpoint, and the parts they start are the private part,
 * the public part and the pending transactions - never DUST.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

/** Every facade the doors asked for, with what it was asked to restore from, and every part that was started. */
const asked: { account: number; restoreShieldedFrom?: string }[] = [];
const started: string[] = [];

vi.mock('../chain/facade.js', async (original) => {
  const real = await original<typeof import('../chain/facade.js')>();
  return {
    ...real,
    facadeFor: async (_identity: unknown, account: number, _proving: unknown, _overrides: unknown, from: { restoreShieldedFrom?: string } = {}) => {
      asked.push({ account, restoreShieldedFrom: from.restoreShieldedFrom });
      const part = (name: string) => ({ start: async () => { started.push(name); } });
      return {
        shielded: part('shielded'), unshielded: part('unshielded'), dust: part('dust'),
        pendingTransactionsService: part('pending'),
        start: async () => { started.push('all three, DUST with them'); },
        stop: async () => { started.push('stopped'); },
      };
    },
  };
});

const { liveBalanceDoors } = await import('./approve-balance.js');
const { saveWalletCheckpoint } = await import('../accounts/storage.js');
const { coinPublicKeyOf } = await import('../chain/balance.js');
const { ORIGINAL_SLOT, forgetOpenWallet } = await import('../accounts/wallets-held.js');
const { snapshotForTest } = await import('../testing/snapshot.js');

beforeEach(() => {
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  asked.length = 0;
  started.length = 0;
});

describe('THE DEPOSIT SCREEN\'S DOORS', () => {
  it('RESTORE THE PRIVATE PART FROM THIS WALLET\'S OWN CHECKPOINT, AND START NO DUST', async () => {
    const identity = identityFromSecret(newSecret());
    const snapshot = snapshotForTest({ coinPublicKey: coinPublicKeyOf(identity, 0) });
    expect(await saveWalletCheckpoint(coinPublicKeyOf(identity, 0), 0, { serialized: snapshot, night: 5n, asOf: 1 }, ORIGINAL_SLOT)).toBe(true);
    const doors = liveBalanceDoors(identity, 0);
    await doors.facade();
    /* RED WHEN: the doors read the private chain from the beginning although this wallet has its own checkpoint. */
    expect(asked).toEqual([{ account: 0, restoreShieldedFrom: snapshot }]);
    /* RED WHEN: the doors start DUST beside the private read, which a page's deposit never pays from and which doubled the wait. */
    expect(started.sort()).toEqual(['pending', 'shielded', 'unshielded']);
    await doors.stop();
    expect(started).toContain('stopped');
  });

  it('with no checkpoint, start the private part from the beginning, and still no DUST', async () => {
    const identity = identityFromSecret(newSecret());
    const doors = liveBalanceDoors(identity, 0);
    await doors.facade();
    /* RED WHEN: another wallet's checkpoint, or anything but none, is handed in. */
    expect(asked).toEqual([{ account: 0, restoreShieldedFrom: undefined }]);
    expect(started.sort()).toEqual(['pending', 'shielded', 'unshielded']);
  });
});
