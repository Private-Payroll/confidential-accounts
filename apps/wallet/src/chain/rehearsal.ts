import { Effect, Either, Exit, Scope } from 'effect';
import {
  Simulator, getCurrentTime, makeSimulatorBlockDataFetcher, makeSimulatorProvingService,
  makeSimulatorSubmissionService,
} from '@midnightntwrk/wallet-sdk/capabilities';
import type {
  SubmissionService, SubmissionServiceEffect,
} from '@midnightntwrk/wallet-sdk/capabilities';
import {
  InMemoryTransactionHistoryStorage, NoOpTransactionHistoryStorage, WalletFacade,
} from '@midnightntwrk/wallet-sdk';
import type { ProvingService, UnboundTransaction } from '@midnightntwrk/wallet-sdk/proving';
import { CustomShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import type { ShieldedWalletAPI } from '@midnightntwrk/wallet-sdk/shielded';
import * as ShieldedV1 from '@midnightntwrk/wallet-sdk/shielded/v1';
import { CustomUnshieldedWallet, PublicKey } from '@midnightntwrk/wallet-sdk/unshielded';
import type { UnshieldedWalletAPI } from '@midnightntwrk/wallet-sdk/unshielded';
import * as UnshieldedV1 from '@midnightntwrk/wallet-sdk/unshielded/v1';
import { CustomDustWallet } from '@midnightntwrk/wallet-sdk/dust';
import type { DustWalletAPI } from '@midnightntwrk/wallet-sdk/dust';
import * as DustV1 from '@midnightntwrk/wallet-sdk/dust/v1';
import {
  LedgerParameters, nativeToken, shieldedToken,
} from '@midnightntwrk/ledger-v9';
import type { FinalizedTransaction, ProofErasedTransaction } from '@midnightntwrk/ledger-v9';
import type { Identity } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { secretKeysFor } from './balance.js';
import { unshieldedKeystoreFor } from './unshielded.js';
import { throwawayPendingGuard } from './pending.js';
import { dustSecretKeyFor } from './dust.js';
import { facadeKeysFor } from './facade.js';
import type { SendDoors } from './send.js';

/**
 * A PRETEND CHAIN THAT RUNS THE REAL WALLET — the whole method.
 *
 * The sending rules (§2) say the flow is built against the SDK's simulator
 * prover FIRST, so it can be tested and photographed in milliseconds. This
 * file goes exactly as far as the SDK itself goes and no further: everything
 * here is the SDK's OWN simulation stack — its in-memory ledger
 * (`Simulator`), its simulator sync services for all three wallets, its
 * simulator transacting capabilities, its simulator submission service, its
 * simulator block-data fetcher and its simulator proving service — composed
 * through the same seams the live wallets use. Nothing of the facade is
 * re-implemented; the `WalletFacade` in a rehearsal is the real class, and
 * the wallets it composes are started from THIS identity's real keys, so the
 * address-agreement property (§1.1) carries into the rehearsal unchanged:
 * the wallet that pays on the pretend chain is derived exactly like the
 * wallet the screens display.
 *
 * WHAT A REHEARSAL IS FOR, and what it is not: it exercises every joint of a
 * send — build, balance, confirm, prove, validate, submit, land in a block
 * under the ledger's real rules (the simulator's default block producer
 * enforces balancing, signatures and limits) — while touching no network and
 * moving no real money. It is how the send screen exists and is honest
 * before the real prover is wired in at this same seam.
 *
 * THE SIMULATED LEDGER RUNS THE REAL RULES. `immediateBlockProducer` (the
 * default) applies post-genesis strictness — a rehearsal transaction that
 * does not pay its fee is rejected by the same well-formedness checks the
 * chain runs. That is why DUST exists here the honest way: the rehearsal
 * REGISTERS its NIGHT through `facade.registerNightUtxosForDustGeneration` —
 * the exact call that ran against stagenet — and generation accrues on the
 * simulator's own clock, fast-forwarded because a rehearsal should not take
 * hours to earn a fee.
 */

/* Anything in a rehearsal that tried to dial out would be a defect, so the
 * endpoints a configuration shape demands are hosts that cannot resolve —
 * `.invalid` is reserved (RFC 2606) — and a dial fails loudly by name. */
const NOWHERE_HTTP = 'https://rehearsal.invalid/graphql';
const NOWHERE_WS = 'wss://rehearsal.invalid/graphql/ws';

/* THE ONE PLACE THIS REPOSITORY KEEPS A FACT ABOUT A PAYMENT, and why it is
 * allowed to: the SDK's simulator history services WRITE each finalized
 * rehearsal transaction into the configured storage and READ it back while
 * syncing the block that carries it — measured, not assumed: with the app's
 * usual NoOp storage the very first sync fails with "No transaction found
 * in storage for hash: …" (wallet-sdk-shielded/dist/v1/TransactionHistory.js,
 * `getTransactionDetails`) and the facade never reports itself synced. So a
 * rehearsal uses the SDK's OWN in-memory storage, holding only PRETEND
 * transactions on a pretend chain, discarded with the rehearsal. Nothing
 * about a real payment can enter it: no real transaction ever reaches a
 * rehearsal facade. The live wallets keep their NoOp storage untouched. */

/*
 * THE SDK'S SIMULATOR SYNC CAPABILITIES APPLY EVERY BLOCK AND NEVER SAY SO —
 * measured here, worth telling the Foundation. Each one advances
 * `appliedIndex` (or `appliedId`) but leaves the progress's "highest" figure
 * at zero, and the shielded and dust ones never set `isConnected` at all, so
 * `isStrictlyComplete()` — which requires connected AND applied == highest
 * (SyncProgress.js in wallet-sdk-abstractions, and the unshielded package's
 * own copy) — is false for ever, and `waitForSyncedState()` on a
 * simulator-synced wallet NEVER RESOLVES. Read in the shipped source:
 * wallet-sdk-shielded/dist/v1/Sync.js and wallet-sdk-dust-wallet/dist/v1/
 * Sync.js update only `appliedIndex`; wallet-sdk-unshielded-wallet/dist/v1/
 * Sync.js sets `isConnected` and `appliedId` but not `highestTransactionId`.
 *
 * So the rehearsal finishes the bookkeeping the SDK's capabilities start:
 * each wrapper below delegates the whole apply to the SDK's own capability
 * and then records what is true of a simulator by construction — the wallet
 * IS connected (the ledger is in memory) and has applied everything there is
 * (the simulator's state is the whole chain). This is bookkeeping over the
 * SDK's result, not a re-implementation of syncing.
 */
const shieldedSimSyncCapability = (): ReturnType<typeof ShieldedV1.Sync.makeSimulatorSyncCapability> => {
  const inner = ShieldedV1.Sync.makeSimulatorSyncCapability();
  return {
    applyUpdate: (state, update) => {
      const [next, changes] = inner.applyUpdate(state, update);
      return [ShieldedV1.CoreWallet.updateProgress(next, {
        isConnected: true,
        highestRelevantWalletIndex: next.progress.appliedIndex,
      }), changes];
    },
  };
};

const dustSimSyncCapability = (): ReturnType<typeof DustV1.SyncService.makeSimulatorSyncCapability> => {
  const inner = DustV1.SyncService.makeSimulatorSyncCapability();
  return {
    applyUpdate: (state, update) => {
      const [next, changes] = inner.applyUpdate(state, update);
      return [DustV1.CoreWallet.updateProgress(next, {
        isConnected: true,
        highestRelevantWalletIndex: next.progress.appliedIndex,
      }), changes];
    },
  };
};

const unshieldedSimSyncCapability = (): ReturnType<typeof UnshieldedV1.Sync.makeSimulatorSyncCapability> => {
  const inner = UnshieldedV1.Sync.makeSimulatorSyncCapability();
  return {
    applyUpdate: (state, update) =>
      Either.map(inner.applyUpdate(state, update), (next) =>
        UnshieldedV1.CoreWallet.updateProgress(next, {
          highestTransactionId: next.progress.appliedId,
        })),
  };
};

/**
 * The simulator's own clock, exposed the way the facade wants a clock. The
 * dust wallet projects generation from `clock.now()`, so the facade and the
 * ledger must agree on what time it is — both read the simulator.
 */
const simulatorClock = (simulator: Simulator): { now: () => Date } => ({
  now: () => Effect.runSync(Effect.map(simulator.getLatestState(), getCurrentTime)),
});

/**
 * The SDK's simulator submission service speaks Effect; the facade's
 * injection seam wants promises. This adapter only translates the calling
 * convention — the service inside is the SDK's own, and the transaction
 * lands in the simulated mempool and then a block.
 */
const asPromiseSubmission = <T>(service: SubmissionServiceEffect<T>): SubmissionService<T> => ({
  submitTransaction: ((tx: T, waitForStatus?: 'Submitted' | 'InBlock' | 'Finalized') =>
    Effect.runPromise(service.submitTransaction(tx, waitForStatus))) as
      SubmissionService<T>['submitTransaction'],
  close: () => Effect.runPromise(service.close()),
});

export interface RehearsalOptions {
  /** STARs minted to the account's unshielded address at genesis. The
   * default mirrors the real test wallet: 5,000 tNIGHT. */
  readonly unshieldedStars?: bigint;
  /** STARs minted to the account's SHIELDED address at genesis, so a private
   * payment has coins to spend. */
  readonly shieldedStars?: bigint;
  /** The prover. Defaults to the SDK's simulator prover — no real proof,
   * milliseconds. The live path swaps this one value for the WASM prover; that swap
   * being a one-argument change is the §1 seam, kept. */
  readonly provingService?: ProvingService<UnboundTransaction>;
  /** The submission door. Defaults to the SDK's simulator submission
   * service over the simulated mempool. A rehearsal of the DANGEROUS MIDDLE
   * — the proof succeeds and the submission fails — injects a refusing one
   * here, through the facade's own seam. */
  readonly submissionService?: SubmissionService<FinalizedTransaction>;
  /** Skip the DUST registration step — for tests that exercise exactly the
   * cannot-pay-a-fee refusal. */
  readonly withoutDust?: boolean;
}

export interface Rehearsal {
  /** The real WalletFacade, over the pretend chain. Started and synced. */
  readonly facade: WalletFacade;
  /** The simulated ledger itself, for tests that check where money landed. */
  readonly simulator: Simulator;
  readonly keys: ReturnType<typeof facadeKeysFor>;
  /** Advance the pretend clock — DUST generation accrues with it. */
  readonly fastForward: (seconds: bigint) => Promise<void>;
  readonly now: () => Date;
  readonly stop: () => Promise<void>;
}

/**
 * A running rehearsal for ONE account: the simulated chain funded at
 * genesis, all three wallets synced from it, DUST registered and generating
 * so fees are payable — the state the real wallet was in when registration finished.
 */
export async function startRehearsal(
  identity: Identity,
  account: number,
  options: RehearsalOptions = {},
): Promise<Rehearsal> {
  const unshieldedStars = options.unshieldedStars ?? 5_000_000_000n;
  const shieldedStars = options.shieldedStars ?? 100_000_000n;
  const keystore = unshieldedKeystoreFor(identity, account);
  const shieldedKeys = secretKeysFor(identity, account);

  /* The simulator lives in an Effect scope; the scope is held open for the
   * rehearsal's life and closed by `stop`. */
  const scope = Effect.runSync(Scope.make());
  const simulator = await Effect.runPromise(Scope.extend(Simulator.init({
    networkId: NETWORK,
    genesisMints: [
      {
        type: 'unshielded',
        tokenType: nativeToken().raw,
        amount: unshieldedStars,
        recipient: keystore.getAddress(),
        /* NIGHT cannot be minted from nothing (supply invariant) — the
         * simulator claims it as a reward, which needs the verifying key. */
        verifyingKey: keystore.getPublicKey(),
      },
      {
        type: 'shielded',
        tokenType: shieldedToken().raw,
        amount: shieldedStars,
        recipient: shieldedKeys,
      },
    ],
  }), scope));

  const stopScope = (): Promise<void> =>
    Effect.runPromise(Scope.close(scope, Exit.void)).then(() => undefined);

  try {
    /* THE THREE WALLETS, rebuilt over the simulator's seams. Each builder
     * line swaps exactly one capability for the SDK's simulator flavour of
     * the same capability; everything else is the SDK's default. The keys
     * they start from are the app's own derivations — the same
     * `secretKeysFor` / `unshieldedKeystoreFor` / `dustSecretKeyFor` the
     * live doors use — so §1.1 holds on the pretend chain too. */
    const shielded = CustomShieldedWallet(
      {
        networkId: NETWORK,
        simulator,
        txHistoryStorage: new InMemoryTransactionHistoryStorage(
          ShieldedV1.TransactionHistory.ShieldedTransactionHistoryEntrySchema),
        indexerClientConnection: { indexerHttpUrl: NOWHERE_HTTP },
      },
      new ShieldedV1.V1Builder()
        .withTransactionType<ProofErasedTransaction>()
        .withSync(ShieldedV1.Sync.makeSimulatorSyncService, shieldedSimSyncCapability)
        .withSerializationDefaults()
        .withTransacting(ShieldedV1.Transacting.makeSimulatorTransactingCapability)
        .withCoinSelectionDefaults()
        .withCoinsAndBalancesDefaults()
        .withKeysDefaults()
        .withTransactionHistory(ShieldedV1.TransactionHistory.makeSimulatorTransactionHistoryService),
    ).startWithSecretKeys(shieldedKeys);

    const unshielded = CustomUnshieldedWallet(
      {
        networkId: NETWORK,
        simulator,
        txHistoryStorage: new InMemoryTransactionHistoryStorage(
          UnshieldedV1.TransactionHistory.UnshieldedTransactionHistoryEntrySchema),
      },
      new UnshieldedV1.V1Builder()
        .withSync(UnshieldedV1.Sync.makeSimulatorSyncService, unshieldedSimSyncCapability)
        .withSerializationDefaults()
        .withTransactingDefaults()
        .withSigningDefaults()
        .withCoinSelectionDefaults()
        .withCoinsAndBalancesDefaults()
        .withKeysDefaults()
        .withTransactionHistoryDefaults(),
    ).startWithPublicKey(PublicKey.fromKeyStore(keystore));

    const dust = CustomDustWallet(
      {
        networkId: NETWORK,
        simulator,
        costParameters: { feeBlocksMargin: 5 },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(
          DustV1.TransactionHistory.DustTransactionHistoryEntrySchema),
        indexerClientConnection: { indexerHttpUrl: NOWHERE_HTTP },
      },
      new DustV1.V1Builder()
        .withTransactionType<ProofErasedTransaction>()
        .withSync(DustV1.SyncService.makeSimulatorSyncService, dustSimSyncCapability)
        .withSerializationDefaults()
        .withTransacting(DustV1.Transacting.makeSimulatorTransactingCapability)
        .withCoinSelectionDefaults()
        .withCoinsAndBalancesDefaults()
        .withKeysDefaults()
        .withTransactionHistory(DustV1.TransactionHistory.makeSimulatorTransactionHistoryService),
    ).startWithSecretKey(
      dustSecretKeyFor(identity, account), LedgerParameters.initialParameters().dust);

    /* THE TYPE CASTS, SAID OUT LOUD RATHER THAN HIDDEN. The facade's public
     * type is written over live `FinalizedTransaction`s; the SDK's own
     * simulator capabilities substitute PROOF-ERASED transactions through
     * the whole stack (that is what "no real proof" means mechanically).
     * The transaction type is a phantom parameter on the wallet APIs — the
     * facade's code paths call only methods the two types share (`bind`,
     * `merge`, `identifiers`, `serialize` — read in ledger-v9.d.ts, where
     * both are the same `Transaction` class at different type states), and
     * the SDK's own facade documentation points simulator tests at these
     * seams. The casts below are the SDK's intended composition stated in
     * TypeScript, not a bypass of a runtime check. */
    const facade = await WalletFacade.init({
      configuration: {
        networkId: NETWORK,
        costParameters: { feeBlocksMargin: 5 },
        relayURL: new URL(NOWHERE_WS),
        indexerClientConnection: { indexerHttpUrl: NOWHERE_HTTP, indexerWsUrl: NOWHERE_WS },
        txHistoryStorage: new NoOpTransactionHistoryStorage(),
      },
      shielded: () => shielded as unknown as ShieldedWalletAPI,
      unshielded: () => unshielded as unknown as UnshieldedWalletAPI,
      dust: () => dust as unknown as DustWalletAPI,
      provingService: () => options.provingService
        ?? (makeSimulatorProvingService() as unknown as ProvingService<UnboundTransaction>),
      submissionService: () => options.submissionService
        ?? asPromiseSubmission(
          makeSimulatorSubmissionService<FinalizedTransaction>()(
            { simulator: simulator as never })),
      fetchBlockData: () => makeSimulatorBlockDataFetcher(simulator),
      clock: () => simulatorClock(simulator),
    });

    const keys = facadeKeysFor(identity, account);
    const fastForward = (seconds: bigint): Promise<void> =>
      Effect.runPromise(simulator.fastForward(seconds));

    await facade.start(keys.shielded, keys.dust);
    await facade.waitForSyncedState();

    if (!options.withoutDust) {
      /* DUST THE HONEST WAY — the registration flow, re-run against the pretend chain:
       * estimate, wait until projected generation covers the fee, register
       * with the unshielded key, prove (simulated), submit, and let
       * generation accrue. The only liberty a rehearsal takes is with the
       * clock, which is the simulator's to move. */
      const synced = await facade.waitForSyncedState();
      const unregistered = synced.unshielded.availableCoins
        .filter((coin) => !coin.meta.registeredForDustGeneration);
      if (unregistered.length > 0) {
        /* A day of pretend time before estimating, so the projection the
         * SDK computes from the coin's age already covers the fee. */
        await fastForward(86_400n);
        const { fee } = await facade.estimateRegistration(unregistered);
        await facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: 10_000 });
        const recipe = await facade.registerNightUtxosForDustGeneration(
          unregistered, keystore.getPublicKey(), keystore.signDataAsync);
        /* The SETUP registration is proved and submitted by the simulator
         * DIRECTLY, not through the facade's injected services — because a
         * rehearsal scenario may deliberately inject a prover or a
         * submission door that fails, and the failure being rehearsed is
         * the SEND's, not the scaffolding's. Building, estimating, waiting
         * and signing above still go through the exact facade calls it ran. */
        const proofErased = await makeSimulatorProvingService().prove(recipe.transaction);
        await Effect.runPromise(simulator.submitTransaction(proofErased));
        /* Another pretend day, so the registered NIGHT has generated DUST
         * worth spending — the state the real wallet reached. */
        await fastForward(86_400n);
        await facade.waitForSyncedState();
      }
    }

    return {
      facade,
      simulator,
      keys,
      fastForward,
      now: () => simulatorClock(simulator).now(),
      stop: async () => {
        await facade.stop().catch(() => { /* already stopping is fine */ });
        await stopScope().catch(() => { /* scope already closed is fine */ });
      },
    };
  } catch (e) {
    await stopScope().catch(() => { /* best effort on the failure path */ });
    throw e;
  }
}

/* --------------------------------------------------------------- the doors */

/**
 * What a rehearsal lets a person practise. Each scenario is honest about
 * what it changes and changes it ONLY through the facade's own seams:
 *
 *  - `ordinary`         the simulator prover and the simulated mempool;
 *  - `slow-proving`     the same, with the proof deliberately taking as
 *                       long as a real in-browser proof MAY take (unmeasured
 *                       until later) — so the waiting the send screen was built
 *                       for can be seen, rehearsed and photographed;
 *  - `submission-fails` the proof succeeds and the network never accepts —
 *                       the dangerous middle, rehearsed on purpose, because
 *                       the first time a person sees that screen must not be
 *                       the time it is true.
 */
export type RehearsalScenario = 'ordinary' | 'slow-proving' | 'submission-fails';

/** How long the slow-proving rehearsal proof takes. Two minutes: "minutes",
 * as the design says to design for, without being unbearable to rehearse. */
export const SLOW_PROVING_MS = 120_000;

/** A prover that takes the time a real one may take, then proves the
 * simulator way — an IMPLEMENTATION of the SDK's one-method proving
 * interface, injected at the same seam the WASM prover will be. */
const slowSimulatorProving = (delayMs: number): ProvingService<UnboundTransaction> => {
  const inner = makeSimulatorProvingService();
  return {
    prove: async (tx) => {
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      return inner.prove(tx) as unknown as ReturnType<ProvingService<UnboundTransaction>['prove']>;
    },
  };
};

/** A submission door where the network never answers well — after the
 * proof has already succeeded. What it says is what a dropped connection
 * looks like from a browser. */
const refusingSubmission: SubmissionService<FinalizedTransaction> = {
  submitTransaction: (() => Promise.reject(new Error(
    'the connection to the node closed before any answer arrived'))) as
      SubmissionService<FinalizedTransaction>['submitTransaction'],
  close: () => Promise.resolve(),
};

export interface RehearsalDoors extends SendDoors {
  /** Ends the rehearsal chain behind the doors. */
  readonly stop: () => Promise<void>;
}

/**
 * Send doors over a rehearsal chain for ONE account — what the send screen
 * plugs into `startSend`. The rehearsal starts on first use and is
 * shared by every send until `stop`. The live path replaces this function, at this
 * seam, with doors over the stagenet facade and the WASM prover.
 */
export function rehearsalDoors(
  identity: Identity,
  account: number,
  scenario: RehearsalScenario = 'ordinary',
  options: { readonly slowMs?: number } = {},
): RehearsalDoors {
  let running: Promise<Rehearsal> | null = null;
  const rehearsal = (): Promise<Rehearsal> => {
    running ??= startRehearsal(identity, account, {
      provingService: scenario === 'slow-proving'
        ? slowSimulatorProving(options.slowMs ?? SLOW_PROVING_MS)
        : undefined,
      submissionService: scenario === 'submission-fails' ? refusingSubmission : undefined,
    });
    return running;
  };
  return {
    facade: async () => (await rehearsal()).facade,
    keys: () => ({
      /* The facade's own parameter names — see the note on SendDoors.keys. */
      shieldedSecretKeys: secretKeysFor(identity, account),
      dustSecretKey: dustSecretKeyFor(identity, account),
    }),
    /* The unshielded signer, derived per call like the keys. The
     * keystore's own `signDataAsync` IS the SDK's `SignSegment` shape, and
     * the registration path in this wallet already hands over the very same
     * function (probe.ts, rehearsal.ts) — the transfer path simply never
     * did. */
    signSegment: () => unshieldedKeystoreFor(identity, account).signDataAsync,
    ownUnshieldedHex: unshieldedKeystoreFor(identity, account).getAddress(),
    /* THE PENDING RECORD IN REHEARSAL: the same written-down middle, on a THROWAWAY store
     * — a pretend payment must never reach the real home screen — and a
     * chain that never answers, so the worst case rehearses exactly what a
     * person would see: the watched middle, refusing a duplicate, ending
     * only when the (real) TTL would end it. */
    pending: throwawayPendingGuard(),
    transactionStatus: async () => ({ found: false } as const),
    stop: async () => {
      if (!running) return;
      const r = await running.catch(() => null);
      running = null;
      await r?.stop();
    },
  };
}
