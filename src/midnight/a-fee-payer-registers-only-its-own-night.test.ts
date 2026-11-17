/**
 * Registering a wallet's NIGHT for DUST. The wallet here is a recording stand-in for the SDK's facade: each case is
 * about what is asked of the wallet, in what order and with what, which is all this function decides.
 */
import { describe, it, expect } from 'vitest';
import { registerNightForDust, type DustRegistrationWallet, type NightOwner } from './dust-registration.js';
import { NIGHT } from '../core/assets.js';

const OTHER_TOKEN = 'ab'.repeat(32);
const coin = (type: string, value: bigint, registered: boolean, n: number) => ({
  utxo: { type, value, owner: 'owner', intentHash: `intent-${n}`, outputNo: n },
  meta: { ctime: new Date(0), registeredForDustGeneration: registered },
});
const FEE_PAYER_DUST_ADDRESS = 'the fee payer\'s own DUST address';
const OWNER: NightOwner = { verifyingKey: { tag: 'schnorr', value: 'vk' } as never, sign: async () => ({}) as never };

/** A wallet that records every call, holding the coins given. */
const aWallet = (coins: ReturnType<typeof coin>[], over: Partial<Record<keyof DustRegistrationWallet, unknown>> = {}) => {
  const calls: string[] = [];
  const registered: { coins: unknown[]; key: unknown; receiver: unknown }[] = [];
  const waits: { fee: bigint; opts: unknown }[] = [];
  const wallet = {
    waitForSyncedState: async () => {
      calls.push('sync');
      return { unshielded: { availableCoins: coins }, dust: { address: FEE_PAYER_DUST_ADDRESS } };
    },
    estimateRegistration: async (c: unknown[]) => { calls.push(`estimate ${c.length}`); return { fee: 700n, dustGenerationEstimations: [] }; },
    waitForGeneratedDust: async (_c: unknown[], fee: bigint, opts?: unknown) => { calls.push(`wait ${fee}`); waits.push({ fee, opts }); },
    registerNightUtxosForDustGeneration: async (c: unknown[], key: unknown, _sign: unknown, receiver: unknown) => {
      calls.push('register'); registered.push({ coins: c, key, receiver }); return { type: 'UNPROVEN_TRANSACTION' };
    },
    ...over,
  };
  const send = async () => { calls.push('send'); return 'tx_registration'; };
  return { wallet: wallet as never as DustRegistrationWallet, calls, registered, waits, send };
};

describe('registering the fee payer\'s NIGHT for DUST', () => {
  it('registers only NIGHT not yet registered, read after the wallet has synced, to the wallet\'s own DUST address', async () => {
    const night = coin(NIGHT, 5n, false, 1);
    const w = aWallet([night, coin(NIGHT, 7n, true, 2), coin(OTHER_TOKEN, 9n, false, 3)]);
    const result = await registerNightForDust(w.wallet, OWNER, { send: w.send });
    /* RED WHEN: a coin of another token, or NIGHT already registered, is put in a registration. */
    expect(w.registered[0]!.coins).toEqual([night]);
    /* RED WHEN: the generated DUST is sent anywhere but the fee payer's own DUST address. */
    expect(w.registered[0]!.receiver).toBe(FEE_PAYER_DUST_ADDRESS);
    /* RED WHEN: the registration is signed for by another key than the one that owns the NIGHT. */
    expect(w.registered[0]!.key).toBe(OWNER.verifyingKey);
    expect(result).toEqual({ registered: 1, fee: 700n, transaction: 'tx_registration' });
  });

  it('builds the registration only once the generated DUST covers its fee', async () => {
    const w = aWallet([coin(NIGHT, 5n, false, 1)]);
    await registerNightForDust(w.wallet, OWNER, { send: w.send });
    /* RED WHEN: the coins are read before the wallet has synced, or the registration is built before its fee is covered. */
    expect(w.calls).toEqual(['sync', 'estimate 1', 'wait 700', 'register', 'send']);
  });

  it('builds nothing when the generated DUST does not cover the fee in time', async () => {
    const w = aWallet([coin(NIGHT, 5n, false, 1)], {
      waitForGeneratedDust: async () => { throw new Error('the DUST did not reach 700 in time'); },
    });
    /* RED WHEN: a registration is built and sent after the wait failed, and fails at the node for its fee. */
    await expect(registerNightForDust(w.wallet, OWNER, { send: w.send })).rejects.toThrow(/did not reach 700/);
    expect(w.registered).toEqual([]);
  });

  it('asks nothing when every NIGHT coin is already registered', async () => {
    const w = aWallet([coin(NIGHT, 7n, true, 2), coin(OTHER_TOKEN, 9n, false, 3)]);
    /* RED WHEN: a registration with no NIGHT in it is estimated or built. */
    expect(await registerNightForDust(w.wallet, OWNER, { send: w.send })).toEqual({ registered: 0 });
    expect(w.calls).toEqual(['sync']);
  });

  it('waits as long as it is told, and otherwise as long as the wallet does', async () => {
    const told = aWallet([coin(NIGHT, 5n, false, 1)]);
    await registerNightForDust(told.wallet, OWNER, { waitMs: 600_000, send: told.send });
    const untold = aWallet([coin(NIGHT, 5n, false, 1)]);
    await registerNightForDust(untold.wallet, OWNER, { send: untold.send });
    /* RED WHEN: the wait is cut short of what the caller set, or a limit the wallet does not use is invented here. */
    expect([told.waits[0]!.opts, untold.waits[0]!.opts]).toEqual([{ timeoutMs: 600_000 }, undefined]);
  });

  it('sends the signed registration only the way its caller says', async () => {
    const sent: unknown[] = [];
    const w = aWallet([coin(NIGHT, 5n, false, 1)]);
    const result = await registerNightForDust(w.wallet, OWNER, { send: async (r) => { sent.push(r); return 'tx_own_chain'; } });
    /* RED WHEN: the registration is sent some other way than the caller's, which decides what a failed send gives back. */
    expect([sent, result]).toEqual([
      [{ type: 'UNPROVEN_TRANSACTION' }], { registered: 1, fee: 700n, transaction: 'tx_own_chain' },
    ]);
  });

  /*
   * RED WHEN: a registration waits for the whole wallet to sync, shielded side included, when the caller has said how
   * to wait for the two sides it reads; a shielded wallet replaying from the first event holds it for hours.
   */
  it('waits only for the sides its caller names, when the caller names them', async () => {
    const night = coin(NIGHT, 5n, false, 1);
    const w = aWallet([night], { waitForSyncedState: async () => { throw new Error('the whole wallet was waited for'); } });
    const result = await registerNightForDust(w.wallet, OWNER, {
      send: w.send,
      synced: async () => ({ unshielded: { availableCoins: [night] }, dust: { address: FEE_PAYER_DUST_ADDRESS } }) as never,
    });
    expect(result).toEqual({ registered: 1, fee: 700n, transaction: 'tx_registration' });
    expect(w.registered[0]!.receiver).toBe(FEE_PAYER_DUST_ADDRESS);
  });
});
