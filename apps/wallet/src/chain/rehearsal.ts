import { Effect, Either, Exit, Scope } from 'effect';
import {
  V9, makeV9SimulatorBlockDataFetcher, makeV9SimulatorProvingService, makeV9SimulatorSubmissionService,
} from '@midnightntwrk/wallet-sdk/capabilities';
import type {
  AnyVersionUnboundTransaction, SubmissionService, SubmissionServiceEffect,
} from '@midnightntwrk/wallet-sdk/capabilities';
import {
  InMemoryTransactionHistoryStorage, NoOpTransactionHistoryStorage, ProtocolVersion, WalletFacade,
} from '@midnightntwrk/wallet-sdk';
import type { FinalizedTx, WalletSeeds } from '@midnightntwrk/wallet-sdk';
import { CustomShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import * as ShieldedV2 from '@midnightntwrk/wallet-sdk/shielded/v2';
import { CustomUnshieldedWallet, PublicKey } from '@midnightntwrk/wallet-sdk/unshielded';
import * as UnshieldedV2 from '@midnightntwrk/wallet-sdk/unshielded/v2';
import { CustomDustWallet } from '@midnightntwrk/wallet-sdk/dust';
import * as DustV2 from '@midnightntwrk/wallet-sdk/dust/v2';
import { Transaction, nativeToken, shieldedToken } from '@midnightntwrk/ledger-v9';
import type { ProofErasedTransaction } from '@midnightntwrk/ledger-v9';
import type { Identity } from 'midnight-identity';
import { NETWORK } from '../config.js';
import { secretKeysFor } from './balance.js';
import { carriedBy } from './carried.js';
import { registerNightForDust } from '../../../../src/midnight/dust-registration.js';
import { unshieldedKeystoreFor } from './unshielded.js';
import { throwawayPendingGuard } from './pending.js';
import { dustSecretKeyFor } from './dust.js';
import { seedsFor, type FacadeProving } from './facade.js';
import type { SendDoors } from './send.js';

/**
 * A PRETEND CHAIN THAT RUNS THE REAL WALLET — the whole method.
 *
 * The send flow is built against the SDK's simulator prover first, so it can
 * be tested and photographed in milliseconds. This file goes exactly as far as
 * the SDK itself goes and no further: everything here is the SDK's OWN
 * simulation stack — its in-memory ledger-v9 chain (`V9.Simulator`), its
 * simulator sync services for all three wallets, its simulator transacting
 * capabilities, its simulator submission service, its simulator block-data
 * fetcher and its simulator proving service — composed through the same seams
 * the live wallets use. Nothing of the facade is re-implemented; the
 * `WalletFacade` in a rehearsal is the real class, and the wallets it composes
 * are started from THIS identity's real keys, so the wallet that pays on the
 * pretend chain is derived exactly like the wallet the screens display.
 *
 * WHAT A REHEARSAL IS FOR, and what it is not: it exercises every joint of a
 * send — build, balance, confirm, prove, validate, submit, land in a block
 * under the ledger's real rules (the simulator's default block producer
 * enforces balancing, signatures and limits) — while touching no network and
 * moving no real money.
 *
 * THE SIMULATED LEDGER RUNS THE REAL RULES. `immediateBlockProducer` (the
 * default) applies post-genesis strictness — a rehearsal transaction that
 * does not pay its fee is rejected by the same well-formedness checks the
 * chain runs. That is why DUST exists here the honest way: the rehearsal
 * REGISTERS its NIGHT through `facade.registerNightUtxosForDustGeneration` —
 * the same call a live wallet makes — and generation accrues on the
 * simulator's own clock, fast-forwarded because a rehearsal should not take
 * hours to earn a fee.
 *
 * The simulated chain is on ledger-v9 from its first block, so the facade's
 * fork schedule puts ledger-v9 at the lowest protocol version: the version
 * the simulator and the single-ledger wallets below stamp what they build with.
 */

/* Anything in a rehearsal that tried to dial out would be a defect, so the
 * endpoints a configuration shape demands are hosts that cannot resolve —
 * `.invalid` is reserved (RFC 2606) — and a dial fails loudly by name. */
const NOWHERE_HTTP = 'https://rehearsal.invalid/graphql';
const NOWHERE_WS = 'wss://rehearsal.invalid/graphql/ws';

/** The facade's fork schedule over the simulated chain: ledger-v9 from the start. */
const REHEARSAL_FORKS = { v9: ProtocolVersion.MinSupportedVersion };

/* THE ONE PLACE THIS REPOSITORY KEEPS A FACT ABOUT A PAYMENT, and why it is
 * allowed to: the SDK's simulator history services WRITE each finalized
 * rehearsal transaction into the configured storage and READ it back while
 * syncing the block that carries it, so with the app's usual no-op storage
 * the first sync fails and the facade never reports itself synced. So a
 * rehearsal uses the SDK's OWN in-memory storage, holding only PRETEND
 * transactions on a pretend chain, discarded with the rehearsal. Nothing
 * about a real payment can enter it: no real transaction ever reaches a
 * rehearsal facade. The live wallets keep their no-op storage untouched. */

/*
 * THE SDK'S SIMULATOR SYNC FOR THE PUBLIC WALLET NEVER SAYS IT IS DONE. It
 * advances `appliedId` with every block but leaves `highestTransactionId` at
 * zero, so its `isStrictlyComplete()` (connected, and applied equal to
 * highest) stays false and `waitForSyncedState()` on it never resolves. The
 * private and DUST wallets' simulator sync records both figures itself.
 *
 * So the rehearsal finishes the bookkeeping for the public wallet: the wrapper
 * below delegates the whole apply to the SDK's own capability and then records
 * what is true of a simulator by construction — the wallet has applied
 * everything there is (the simulator's state is the whole chain). This is
 * bookkeeping over the SDK's result, not a re-implementation of syncing.
 */
const unshieldedSimSyncCapability = (): ReturnType<typeof UnshieldedV2.Sync.makeSimulatorSyncCapability> => {
  const inner = UnshieldedV2.Sync.makeSimulatorSyncCapability();
  return {
    applyUpdate: (state, update, activeRange) =>
      Either.map(inner.applyUpdate(state, update, activeRange), (next) =>
        UnshieldedV2.CoreWallet.updateProgress(next, {
          highestTransactionId: next.progress.appliedId,
        })),
  };
};

/**
 * The simulator's own clock, exposed the way the facade wants a clock. The
 * dust wallet projects generation from `clock.now()`, so the facade and the
 * ledger must agree on what time it is — both read the simulator.
 */
const simulatorClock = (simulator: V9.Simulator): { now: () => Date } => ({
  now: () => Effect.runSync(Effect.map(simulator.getLatestState(), V9.getCurrentTime)),
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

/**
 * THE ONE PLACE A REHEARSAL NAMES A TRANSACTION WHAT IT IS NOT. The simulator's
 * prover makes PROOF-ERASED transactions — that is what "no real proof" means
 * — and the facade's types are written over proven ones; the two are the same
 * ledger `Transaction` class at different type states, and the facade's code
 * paths call only what both have. So the simulator's prover is handed to the
 * facade as the prover it stands in for, and a finished transaction is handed
 * to the simulator as the proof-erased one it is. Anything that is not a
 * ledger-v9 transaction is refused before either is asked.
 */
const simulatorProving = (): FacadeProving => {
  const inner = makeV9SimulatorProvingService();
  return {
    prove: async (tx) => {
      if (!(tx instanceof Transaction)) throw new Error('the rehearsal proves only ledger-v9 transactions.');
      return (await inner.prove(tx)) as unknown as AnyVersionUnboundTransaction;
    },
  };
};

/** What a finished handle carries, as the simulator takes it. */
const proofErasedIn = (handle: unknown): ProofErasedTransaction => {
  const carried = carriedBy(handle);
  if (!(carried instanceof Transaction)) throw new Error('the rehearsal submits only ledger-v9 transactions.');
  return carried as ProofErasedTransaction;
};

/** The SDK's simulator submission service, taking the facade's finished handles. */
const simulatorSubmission = (simulator: V9.Simulator): SubmissionService<FinalizedTx> => asPromiseSubmission(
  makeV9SimulatorSubmissionService<FinalizedTx>()({
    simulator: {
      submitTransaction: (handle) => Effect.asVoid(simulator.submitTransaction(proofErasedIn(handle))),
      getLatestState: () => simulator.getLatestState(),
    },
  }));

export interface RehearsalOptions {
  /** STARs minted to the account's unshielded address at genesis. The
   * default mirrors the real test wallet: 5,000 tNIGHT. */
  readonly unshieldedStars?: bigint;
  /** STARs minted to the account's SHIELDED address at genesis, so a private
   * payment has coins to spend. */
  readonly shieldedStars?: bigint;
  /** The prover. Defaults to the SDK's simulator prover — no real proof,
   * milliseconds. The live path swaps this one value for the WASM prover. */
  readonly provingService?: FacadeProving;
  /** The submission door. Defaults to the SDK's simulator submission
   * service over the simulated mempool. A rehearsal of the DANGEROUS MIDDLE
   * — the proof succeeds and the submission fails — injects a refusing one
   * here, through the facade's own seam. */
  readonly submissionService?: SubmissionService<FinalizedTx>;
  /** Skip the DUST registration step — for tests that exercise exactly the
   * cannot-pay-a-fee refusal. */
  readonly withoutDust?: boolean;
}

export interface Rehearsal {
  /** The real WalletFacade, over the pretend chain. Started and synced. */
  readonly facade: WalletFacade;
  /** The simulated ledger itself, for tests that check where money landed. */
  readonly simulator: V9.Simulator;
  /** What the facade was started from: the account's own seeds. */
  readonly seeds: WalletSeeds;
  /** Advance the pretend clock — DUST generation accrues with it. */
  readonly fastForward: (seconds: bigint) => Promise<void>;
  readonly now: () => Date;
  readonly stop: () => Promise<void>;
}

/** The three wallets over the simulated chain, started from this account's own keys. */
function simulatedWallets(
  identity: Identity, account: number, simulator: V9.Simulator,
  keystore: ReturnType<typeof unshieldedKeystoreFor>, shieldedKeys: ReturnType<typeof secretKeysFor>,
) {
  /* THE THREE WALLETS, rebuilt over the simulator's seams. Each builder
   * line swaps exactly one capability for the SDK's simulator flavour of
   * the same capability; everything else is the SDK's default. The keys
   * they start from are the app's own derivations — the same
   * `secretKeysFor` / `unshieldedKeystoreFor` / `dustSecretKeyFor` the
   * live doors use. */
  const shielded = CustomShieldedWallet(
    {
      networkId: NETWORK,
      simulator,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        ShieldedV2.TransactionHistory.ShieldedTransactionHistoryEntrySchema),
      indexerClientConnection: { indexerHttpUrl: NOWHERE_HTTP },
    },
    new ShieldedV2.V2Builder()
      .withTransactionType<ProofErasedTransaction>()
      .withSync(ShieldedV2.Sync.makeSimulatorSyncService, ShieldedV2.Sync.makeSimulatorSyncCapability)
      .withSerializationDefaults()
      .withTransacting(ShieldedV2.Transacting.makeSimulatorTransactingCapability)
      .withCoinSelectionDefaults()
      .withCoinsAndBalancesDefaults()
      .withKeysDefaults()
      .withStartAuxDefaults()
      .withTransactionHistory(ShieldedV2.TransactionHistory.makeSimulatorTransactionHistoryService),
  ).startWithSecretKeys(shieldedKeys);

  const unshielded = CustomUnshieldedWallet(
    {
      networkId: NETWORK,
      simulator,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        UnshieldedV2.TransactionHistory.UnshieldedTransactionHistoryEntrySchema),
    },
    new UnshieldedV2.V2Builder()
      .withSync(UnshieldedV2.Sync.makeSimulatorSyncService, unshieldedSimSyncCapability)
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
        DustV2.TransactionHistory.DustTransactionHistoryEntrySchema),
      indexerClientConnection: { indexerHttpUrl: NOWHERE_HTTP },
    },
    new DustV2.V2Builder()
      .withTransactionType<ProofErasedTransaction>()
      .withSync(DustV2.SyncService.makeSimulatorSyncService, DustV2.SyncService.makeSimulatorSyncCapability)
      .withSerializationDefaults()
      .withTransacting(DustV2.Transacting.makeSimulatorTransactingCapability)
      .withCoinSelectionDefaults()
      .withCoinsAndBalancesDefaults()
      .withKeysDefaults()
      .withStartAuxDefaults()
      .withTransactionHistory(DustV2.TransactionHistory.makeSimulatorTransactionHistoryService),
  ).startWithSecretKey(dustSecretKeyFor(identity, account));
  return { shielded, unshielded, dust };
}

/** Registers the account's public NIGHT for DUST on the simulated chain and lets a day of DUST accrue. */
async function registeredForDust(
  facade: WalletFacade, simulator: V9.Simulator,
  keystore: ReturnType<typeof unshieldedKeystoreFor>, fastForward: (seconds: bigint) => Promise<void>,
): Promise<void> {
  /* DUST THE HONEST WAY — the registration every wallet runs
   * (`registerNightForDust`), re-run against the pretend chain: estimate, wait
   * until projected generation covers the fee, register with the unshielded
   * key, prove (simulated), submit, and let generation accrue. The only
   * liberty a rehearsal takes is with the clock, which is the simulator's to
   * move: a day of pretend time first, so the projection the SDK computes
   * from the coin's age already covers the fee. */
  await fastForward(86_400n);
  const done = await registerNightForDust(facade, { verifyingKey: keystore.getPublicKey(), sign: keystore.signDataAsync }, {
    waitMs: 10_000,
    /* The SETUP registration is proved and submitted by the simulator
     * DIRECTLY, not through the facade's injected services — because a
     * rehearsal scenario may deliberately inject a prover or a
     * submission door that fails, and the failure being rehearsed is
     * the SEND's, not the scaffolding's. */
    send: async (registration) => {
      const unproven = carriedBy(registration.transaction);
      if (!(unproven instanceof Transaction)) throw new Error('the rehearsal could not read its own DUST registration.');
      const proofErased = await makeV9SimulatorProvingService().prove(unproven);
      await Effect.runPromise(simulator.submitTransaction(proofErased));
      return proofErased.identifiers()[0] ?? '';
    },
  });
  if (done.registered === 0) return;
  /* Another pretend day, so the registered NIGHT has generated DUST
   * worth spending — the state the real wallet reached. */
  await fastForward(86_400n);
  await facade.waitForSyncedState();
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
  const simulator = await Effect.runPromise(Scope.extend(V9.Simulator.init({
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
    const { shielded, unshielded, dust } = simulatedWallets(identity, account, simulator, keystore, shieldedKeys);
    const facade = await WalletFacade.init({
      configuration: {
        networkId: NETWORK,
        costParameters: { feeBlocksMargin: 5 },
        relayURL: new URL(NOWHERE_WS),
        indexerClientConnection: { indexerHttpUrl: NOWHERE_HTTP, indexerWsUrl: NOWHERE_WS },
        txHistoryStorage: new NoOpTransactionHistoryStorage(),
        forks: REHEARSAL_FORKS,
      },
      shielded: () => shielded,
      unshielded: () => unshielded,
      dust: () => dust,
      provingService: () => options.provingService ?? simulatorProving(),
      submissionService: () => options.submissionService ?? simulatorSubmission(simulator),
      fetchBlockData: () => makeV9SimulatorBlockDataFetcher(simulator),
      clock: () => simulatorClock(simulator),
    });

    const seeds = seedsFor(identity, account);
    const fastForward = (seconds: bigint): Promise<void> =>
      Effect.runPromise(simulator.fastForward(seconds));

    await facade.start(seeds);
    await facade.waitForSyncedState();

    if (!options.withoutDust) await registeredForDust(facade, simulator, keystore, fastForward);

    return {
      facade,
      simulator,
      seeds,
      fastForward,
      now: () => simulatorClock(simulator).now(),
      stop: async () => {
        await facade.stop().catch(() => { /* already stopping is fine */ });
        await stopScope().catch(() => { /* scope already closed is fine */ });
      },
    };
  } catch (e) {
    await stopScope().catch(() => { /* scope already closed is fine */ });
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
 * simulator way, injected at the same seam the WASM prover is. */
const slowSimulatorProving = (delayMs: number): FacadeProving => {
  const inner = simulatorProving();
  return {
    prove: async (tx, protocolVersion) => {
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      return inner.prove(tx, protocolVersion);
    },
  };
};

/** A submission door where the network never answers well — after the
 * proof has already succeeded. What it says is what a dropped connection
 * looks like from a browser. */
const refusingSubmission: SubmissionService<FinalizedTx> = {
  submitTransaction: (() => Promise.reject(new Error(
    'the connection to the node closed before any answer arrived'))) as
      SubmissionService<FinalizedTx>['submitTransaction'],
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
 * seam, with doors over the live facade and the WASM prover (`liveDoors`).
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
    /* The unshielded signer, derived per call. The keystore's own
     * `signDataAsync` IS the SDK's `SignSegment` shape, the same function
     * the DUST registration above hands over. */
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
