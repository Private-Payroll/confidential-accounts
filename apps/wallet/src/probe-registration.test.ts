// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import { NIGHT } from '../../../src/core/assets.js';
import { NETWORK_NAME, result } from './probe-record.js';
import { registerOwnNight } from './probe-registration.js';

/*
 * THE PROBE REGISTERS ITS NIGHT THROUGH THE ONE REGISTRATION EVERY WALLET RUNS.
 * The probe's wallet is the maintainer's own; the facade here is a recording stand-in, and each case
 * is about what the probe asks of it and what the probe reports along the way.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const OTHER_TOKEN = 'ab'.repeat(32);
const DUST_ADDRESS = 'the wallet\'s own DUST address';
const coin = (type: string, registered: boolean, n: number) => ({
  utxo: { type, value: 5n, owner: 'owner', intentHash: `intent-${n}`, outputNo: n },
  meta: { ctime: new Date(0), registeredForDustGeneration: registered },
});

const aFacade = (coins: ReturnType<typeof coin>[]) => {
  const registered: { coins: unknown[]; receiver: unknown }[] = [];
  const submitted: unknown[] = [];
  const facade = {
    waitForSyncedState: async () => ({ unshielded: { availableCoins: coins }, dust: { address: DUST_ADDRESS } }),
    estimateRegistration: async () => ({ fee: 700n, dustGenerationEstimations: [] }),
    waitForGeneratedDust: async () => undefined,
    registerNightUtxosForDustGeneration: async (c: unknown[], _key: unknown, _sign: unknown, receiver: unknown) => {
      registered.push({ coins: c, receiver });
      return 'recipe';
    },
    finalizeRecipe: async (recipe: unknown) => `finalized ${String(recipe)}`,
    submitTransaction: async (finalized: unknown) => { submitted.push(finalized); return 'tx-registration'; },
  };
  return { facade: facade as never as WalletFacade, registered, submitted };
};

const identity = identityFromWords(TEST_MNEMONIC);

beforeEach(() => {
  result.steps.length = 0;
  delete result.registrationTxId;
});

describe('the probe registering its NIGHT for DUST', () => {
  it('registers only NIGHT that is not yet registered, for the wallet\'s own DUST address', async () => {
    /* RED WHEN: the probe registers every unregistered coin of the wallet, whatever token it is, or
     * leaves the generated DUST's receiver to the SDK's default, as its own inline code once did. */
    const night = coin(NIGHT, false, 1);
    const w = aFacade([night, coin(NIGHT, true, 2), coin(OTHER_TOKEN, false, 3)]);
    await registerOwnNight(w.facade, identity, 0n, () => undefined);
    expect(w.registered).toHaveLength(1);
    expect(w.registered[0]!.coins).toEqual([night]);
    expect(w.registered[0]!.receiver).toBe(DUST_ADDRESS);
  });

  it('reports each stage as a step and as the stage it is in, and records the transaction', async () => {
    /* RED WHEN: a stage the probe has always reported goes unreported once the registration is shared. */
    const stages: string[] = [];
    const w = aFacade([coin(NIGHT, false, 1)]);
    await registerOwnNight(w.facade, identity, 0n, (stage) => stages.push(stage));
    expect(result.steps.map((s) => s.name)).toEqual([
      'registration-fee-estimated', 'registration-fee-covered', 'registration-built',
      'registration-proved', 'registration-submitted',
    ]);
    expect(stages).toEqual([
      'estimating the registration fee',
      'waiting until projected generation covers the fee',
      'building and signing the registration',
      'proving the registration in the browser',
      `submitting the registration to the ${NETWORK_NAME} node`,
    ]);
    expect(w.submitted).toEqual(['finalized recipe']);
    expect(result.registrationTxId).toBe('tx-registration');
  });

  it('submits nothing when there is no NIGHT left to register', async () => {
    /* RED WHEN: the probe builds and sends a registration for a wallet whose NIGHT is all registered. */
    const w = aFacade([coin(NIGHT, true, 1), coin(OTHER_TOKEN, false, 2)]);
    await registerOwnNight(w.facade, identity, 0n, () => undefined);
    expect(w.registered).toEqual([]);
    expect(w.submitted).toEqual([]);
    expect(result.steps).toEqual([]);
  });
});
