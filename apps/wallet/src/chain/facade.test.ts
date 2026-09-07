// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import { NoOpTransactionHistoryStorage, WalletFacade } from '@midnightntwrk/wallet-sdk';
import { addressFor, identityFromWords } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { EMPTY } from 'rxjs';
import { NETWORK } from '../config.js';
import { walletFor } from './balance.js';
import { FACADE_CONFIG, NODE_RPC_URL, facadeFor, facadeKeysFor, failingProving } from './facade.js';
import type { FacadeServiceOverrides } from './facade.js';
import { unshieldedAddressFor, unshieldedWalletFor } from './unshielded.js';
import { dustAddressFor, dustWalletFor } from './dust.js';

/*
 * THE FACADE IS THE SAME THREE WALLETS, and the property the send
 * path will inherit rather than re-prove: the facade that will pay is
 * assembled from the exact `walletFor` / `unshieldedWalletFor` /
 * `dustWalletFor` the balance screens run, so the §1.1 address-agreement
 * pins carry over. Asserted here by asking each of the facade's three
 * wallets for ITS OWN address and comparing with the app's derivations.
 *
 * Constructing the facade dials nothing by itself is NOT claimed — the
 * SDK's submission client may open its socket eagerly — but nothing here
 * proves, signs or submits, and the prover in these tests is one that
 * REFUSES: if any construction path reaches proving, this suite goes red
 * instead of quietly proving nothing.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const ours: Identity = identityFromWords(TEST_MNEMONIC);

/* The SDK's DEFAULT submission and pending services dial the node and the
 * indexer DURING init — measured: `WalletFacade.init` never resolves in
 * this offline sandbox without these. So the offline tests inject inert
 * ones through the SDK's own `InitParams` seams. Nothing submitted through
 * the inert service could ever look successful: it refuses loudly. */
const offlineServices: FacadeServiceOverrides = {
  submissionService: () => ({
    submitTransaction: (() => Promise.reject(
      new Error('offline test: nothing may submit'))) as never,
    close: () => Promise.resolve(),
  }),
  pendingTransactionsService: () => ({
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    state: () => EMPTY,
    addPendingTransaction: () => Promise.reject(new Error('offline test')),
    clear: () => Promise.resolve(),
  }),
};

describe('the facade composes the SAME wallets the screens show', () => {
  it('all three of the facade\'s wallets report the app\'s own addresses', async () => {
    const facade = await facadeFor(ours, 2, failingProving, offlineServices);
    try {
      const shielded = MidnightBech32m.encode(NETWORK, await facade.shielded.getAddress()).asString();
      const unshielded = MidnightBech32m.encode(NETWORK, await facade.unshielded.getAddress()).asString();
      const dust = MidnightBech32m.encode(NETWORK, await facade.dust.getAddress()).asString();
      expect(shielded).toBe(addressFor(ours.moneyAt(2).zswap, NETWORK).bech32);
      expect(unshielded).toBe(unshieldedAddressFor(ours, 2));
      expect(dust).toBe(dustAddressFor(ours, 2));
    } finally {
      await facade.stop().catch(() => {});
    }
  }, 60_000);

  it('refuses the reserved account — the guard holds through the facade too', async () => {
    await expect(facadeFor(ours, 1, failingProving, offlineServices))
      .rejects.toThrow(/authority/);
  });

  it('the no-prover prover refuses instead of proving nothing', async () => {
    await expect(failingProving.prove(
      undefined as never)).rejects.toThrow(/without a prover on purpose/);
  });

  it('the endpoints are stagenet\'s, stated once', () => {
    expect(NODE_RPC_URL).toBe('wss://rpc.stagenet.shielded.tools');
    expect(FACADE_CONFIG.networkId).toBe('stagenet');
    expect(FACADE_CONFIG.relayURL.protocol).toBe('wss:');
    expect(new URL(FACADE_CONFIG.indexerClientConnection.indexerHttpUrl).host)
      .toBe('indexer.stagenet.shielded.tools');
    /* The guide's own fee margin, and a whole number of blocks. */
    expect(FACADE_CONFIG.costParameters.feeBlocksMargin).toBe(5);
  });

  /* ---- Held by tests rather than a sentence (SCOPE §7.18): this
   * wallet proves ON THE USER'S MACHINE, and no preimage ever leaves it.
   * The SDK's DEFAULT proving service is a remote proof server that POSTs
   * the serialized preimage — which the Foundation's own spec says carries
   * the exact private data the proof hides — to somebody else's host
   * (provingService.js:57, HttpProverClient.js:19,70). These two pins make
   * the trade impossible to make QUIETLY. ---- */

  it('the config can never quietly grow the SDK\'s server prover', async () => {
    /* The SDK refuses to build its default (server) proving service without
     * a provingServerUrl (facade/index.js:178-185). So: our config must not
     * carry one — adding it is the one-line escape the rule forbids — and a
     * facade built WITHOUT an injected proving service must refuse loudly
     * rather than fall back to anything. */
    expect('provingServerUrl' in FACADE_CONFIG).toBe(false);
    await expect(WalletFacade.init({
      configuration: { ...FACADE_CONFIG, txHistoryStorage: new NoOpTransactionHistoryStorage() },
      shielded: () => walletFor(ours, 2),
      unshielded: () => unshieldedWalletFor(ours, 2),
      dust: () => dustWalletFor(ours, 2),
      /* no provingService — the exact omission this test exists to catch */
      ...offlineServices,
    } as never)).rejects.toThrow(/provingServerUrl|provingService/);
  }, 60_000);

  it('the facade carries EXACTLY the proving service it was handed', async () => {
    const facade = await facadeFor(ours, 2, failingProving, offlineServices);
    try {
      /* The facade keeps the injected service as its own (facade/index.js:282)
       * — same object, not a wrapper, not a default. If this ever fails, some
       * layer between the seam and the facade has started substituting
       * provers, and the rule says that layer must be read before it ships. */
      expect((facade as unknown as { provingService: unknown }).provingService)
        .toBe(failingProving);
    } finally {
      await facade.stop().catch(() => {});
    }
  }, 60_000);

  it('facadeKeysFor derives the keys the wallets themselves were built from', () => {
    const keys = facadeKeysFor(ours, 2);
    /* The coin public key is the shielded wallet's identity; the dust public
     * key is the dust wallet's — both must be the account-2 derivations. */
    expect(keys.shielded.coinPublicKey).toBeTruthy();
    expect(dustAddressFor(ours, 2)).toContain('mn_dust_stagenet1');
    expect(() => facadeKeysFor(ours, 1)).toThrow(/authority/);
  });
});
