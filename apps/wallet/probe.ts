import { ensureBuffer } from 'midnight-identity/browser';

/* FIRST, exactly as main.tsx does it — that fix is part of what is being
 * probed: the address codec needs Buffer and a browser has none. */
ensureBuffer();

import { MidnightBech32m, ShieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { nativeToken, shieldedToken } from '@midnightntwrk/ledger-v9';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { Identity, Secret } from 'midnight-identity';
import { addressFor, identityFromSecret, newSecret } from 'midnight-identity';
import { secretKeysFor, walletFor } from './balance.js';
import { unshieldedAddressFor, unshieldedKeystoreFor, unshieldedWalletFor } from './unshielded.js';
import { SUBWALLET_ACCOUNTS, slotNumberOf } from './subwallets.js';
import { dustAddressFor, dustSecretKeyFor, dustWalletFor } from './dust.js';
import { facadeFor, facadeKeysFor } from './facade.js';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from './amount.js';
import { INDEXER_HTTP_URL, NETWORK } from './config.js';
import { makePinnedKeyMaterialProvider, recordKeyAsk, recordingKeyMaterial } from './key-material.js';
import { makeBrowserProvingService } from './proving.js';
import { startRehearsal } from './rehearsal.js';
import { parseRecipient, startSend } from './send.js';
import type { SendDoors, SendState } from './send.js';
import {
  loadPendingSends, observedPendingGuard, outcomeOfAnswer, resolvePendingSends,
  transactionStatusOnChain, unresolvedPendingSends,
} from './pending.js';
import type { PendingSend } from './pending.js';
import { describeFailure } from './failure-text.js';

/**
 * THE PROBE. Runs the app's OWN wiring (`walletFor`,
 * `unshieldedWalletFor` — the right doors) in a real browser and reports
 * each stage with a timestamp, so the report can say exactly how far the
 * stack got and how long a cold sync takes. Verdicts:
 *
 *   FULL                        both wallets started, synced to the tip,
 *                               both balances read.
 *   STACK-OK-NETWORK-UNREACHED  every local stage passed — modules, WASM,
 *                               Effect runtime, construction, BOTH address
 *                               agreements — but the indexer never answered.
 *                               In a sandbox that blocks the host this is
 *                               the expected verdict and it still answers
 *                               most of the question; run it again on a
 *                               machine with ordinary network for the rest.
 *   SYNC-INCOMPLETE             connected and applying, but a tip was not
 *                               reached inside the probe's patience. Stack
 *                               and network both work; rerun with a longer
 *                               timeout for a trustworthy number. THIS
 *                               verdict is RESERVED for exactly
 *                               that — a sync that ran out of patience —
 *                               never for an act that failed.
 *   ACT-FAILED                  the syncs completed; an ACT (registration,
 *                               measurement, the real send) then failed.
 *                               `verdictAdvice` says — composed where the
 *                               failure happened — whether rerunning can
 *                               change the answer, because "rerun with more
 *                               patience" about a permanent refusal is how
 *                               real defects get dismissed, measured twice
 *                               before this.
 *   FAILED                      a LOCAL stage threw. That is the SDK not
 *                               working in a browser — a result worth having.
 *
 * THREE WALLETS: shielded, then unshielded (the kind the faucet
 * pays), then DUST — the token fees are paid in. And the probe has a SECOND
 * MODE: normally it builds a THROWAWAY identity from fresh random bytes,
 * but when the driver injects `window.__TEST_WALLET_SEED__` (read from the
 * gitignored `test-wallet.seed`), it probes
 * the STABLE TEST WALLET instead. A run measured §7.17's NIGHT split
 * this way (5000 tNIGHT read back as 5,000,000,000 STARs).
 *
 * THE ACT — the one thing this probe now DOES rather than reads, and only
 * ever on the test wallet: register the wallet's NIGHT for DUST generation
 * through the SDK's `WalletFacade`, prove the registration IN THE BROWSER
 * (`makeWasmProvingService` — the first in-browser proving measurement this
 * project has), submit it to the stagenet node, and wait until the DUST
 * balance reads above zero. DUST cannot be fauceted; without it no fee can
 * ever be paid; so this single registration is what makes sending possible
 * at all. A throwaway wallet holds no NIGHT and registers nothing — its
 * dust phase only reads the (empty) balance, proving the third stack runs.
 *
 * THE DANGEROUS MIDDLE (carried into the send era): if the
 * registration is submitted and DUST does not appear in the probe's
 * patience, the report says exactly that — submitted, with the transaction
 * identifier — and never guesses either way.
 */

interface ProbeStep { readonly name: string; readonly ms: number; readonly detail?: string }
interface ProbeResult {
  done: boolean;
  verdict: 'FULL' | 'SYNC-INCOMPLETE' | 'ACT-FAILED' | 'STACK-OK-NETWORK-UNREACHED' | 'FAILED' | null;
  steps: ProbeStep[];
  error?: string;
  testWallet: boolean;
  coldSyncMs?: number;
  balanceEntries?: number;
  progress?: string;
  /** Unshielded NIGHT in STARs, as a decimal string — the §7.17 measurement
   * when the test wallet is funded. */
  unshieldedStars?: string;
  unshieldedSyncMs?: number;
  /** DUST in SPECKs, as a decimal string — the registration's result when above zero. */
  dustSpecks?: string;
  /** The registration transaction's identifier, the moment it is submitted
   * — reported even if DUST never appears, because "submitted, unknown" is
   * a different fact from "nothing happened". */
  registrationTxId?: string;
  /** How long the in-browser WASM proof of the registration took. */
  provingMs?: number;
  /** The measurement. Key material fetches, timed, with sizes. */
  keyMaterial?: { circuit: string; ms: number; proverBytes: number; irBytes: number }[];
  /** WHICH PARAMETER SIZE a real proof asks for (`getParams(k)`,
   * watched through the recording provider). This is the number the
   * key-hosting decision needs: a send fetches one k, not nine. */
  paramsFetched?: { k: number; ms: number; bytes: number }[];
  /** WHICH CIRCUITS a real proof asks for (`lookupKey`, watched
   * through the same recorder). `KeyMaterialAsk` has carried a `'circuit'`
   * variant for a while (`key-material.ts:281`) and both callbacks handled
   * only `'params'`, so the parameter half of the hosting number was
   * measured and the circuit half was asserted — 20.75 MB summed from what
   * was VENDORED, including `zswap/sign`, which no report says any proof
   * ever asked for. `askedBy` separates the probe's own warm-up loop from
   * a prover's ask, because a pre-fetch is the probe telling itself what to
   * fetch and proves nothing about what a proof needs. */
  circuitsAsked?: {
    keyLocation: string; ms: number; proverBytes: number;
    askedBy: 'probe-prefetch' | 'proof';
  }[];
  /** THE PENDING GUARD against a REAL send: the pending record as it stood ON DISK
   * at the moment it was written, BEFORE the network was touched. Read back
   * out of storage inside the engine's own `write` door, so it is the stored
   * record rather than the draft that was handed to it. */
  pendingBeforeSubmit?: {
    key: string; identifiers: readonly string[]; kind: string;
    recipientBech32: string; stars: string; feeSpecks: string;
    submittedAt: number; ttlAt: number; outcome: string;
  };
  /** What the ENGINE settled the record as, and from what. */
  pendingSettled?: { key: string; outcome: string; from: string };
  /** The record read off disk AFTER the send, independently. */
  pendingAfter?: { key: string; outcome: string } | 'no record on disk';
  /** THE RESOLUTION AGAINST THE CHAIN: the same identifier asked of the
   * indexer with the same call the home screen's resolver uses, and the same
   * `outcomeOfAnswer` applied to what came back. Silence resolves nothing —
   * that is the property, not a failure. */
  pendingChainResolution?: { identifier: string; answer: string; resolvedTo: string };
  /** HOW LONG THE INDEXER TAKES TO SHOW A TRANSACTION THE NODE
   * HAS ALREADY FINALISED. Measured by asking, by the record's own
   * identifier, until it is found. This is the number `TTL_SETTLE_MARGIN_MS`
   * should be set from — it was chosen to cover clock disagreement and has
   * been defending against the wrong thing. */
  indexerLag?: {
    identifier: string;
    /** ms from the successful submit to the indexer first reporting it, or
     * null if it was never found within this run's patience. */
    foundAfterMs: number | null;
    asks: number;
    patienceMs: number;
    answer: string;
  };
  /** Anything a PREVIOUS run left unresolved, and what this run's
   * start-up resolution did with it. The home screen's behaviour, run by the
   * probe: nobody presses anything. */
  pendingCarriedIn?: { key: string; outcome: string }[];
  /** One sentence, composed WHERE the failure happened, saying
   * whether rerunning can change the answer — printed under the verdict so
   * a permanent refusal is never dressed as "try again". */
  verdictAdvice?: string;
  /** THE NUMBER: real in-browser proofs of a plain shielded transfer
   * (zswap spend + two outputs + a dust spend), cold then warm. */
  shieldedProofMs?: number[];
  /** Why the measurement did not produce a number, when it did not. */
  measurementNote?: string;
  /** The real send: proving time of the live transaction (its dust
   * spend), the identifier, and the recipient's balance read afterwards. */
  realSendProvingMs?: number;
  realSendTxId?: string;
  realSendIdentifiers?: string[];
  realSendStars?: string;
  realSendRecipientStars?: string;
}

/** How long the two syncs together get before the probe calls the network
 * half unanswered. Generous: a cold shielded sync reads the chain from
 * event zero. */
const SYNC_TIMEOUT_MS = 150_000;

/** Unshielded NIGHT, exactly as `unshielded.ts` keys the balances record. */
const NIGHT_UNSHIELDED_RAW = nativeToken().raw;

const t0 = performance.now();
const result: ProbeResult = { done: false, verdict: null, steps: [], testWallet: false };
(window as unknown as { __PROBE__: ProbeResult }).__PROBE__ = result;

const logEl = document.getElementById('log');
const outEl = document.getElementById('probe-out');
const flush = (): void => { if (outEl) outEl.textContent = JSON.stringify(result, null, 2); };
const step = (name: string, detail?: string): void => {
  result.steps.push({ name, ms: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) });
  if (logEl) logEl.textContent += `${String(Math.round(performance.now() - t0)).padStart(7)}ms  ${name}${detail ? ` — ${detail}` : ''}\n`;
  flush();
};
const finish = (verdict: ProbeResult['verdict'], error?: string): void => {
  result.verdict = verdict;
  if (error) result.error = error;
  result.done = true;
  step(`verdict: ${verdict}`, error);
  flush();
};

/** The injected seed, if the driver found `test-wallet.seed` on disk. */
function injectedSecret(): Secret | null {
  const hex = (window as unknown as { __TEST_WALLET_SEED__?: unknown }).__TEST_WALLET_SEED__;
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Set by the driver when `PROBE_SAME_PAYMENT=1` — see `recipientAccountFor`. */
const forcedSamePayment = (): boolean =>
  (window as unknown as { __PROBE_SAME_PAYMENT__?: unknown }).__PROBE_SAME_PAYMENT__ === true;

/**
 * WHICH SUBWALLET THIS RUN PAYS — and why it is not the same one every time.
 *
 * The duplicate guard keys on RECIPIENT AND AMOUNT (`pending.ts`,
 * `duplicateUnresolved`), and every probe run used to send exactly 25 tNIGHT
 * to subwallet 1. So a run that left a record unresolved — which the killed
 * run does BY DESIGN — made every later run's payment identical to it, and
 * the guard refused it. Correctly: it IS the same payment. The consequence
 * was that the kill test and the lag measurement could not both happen in
 * the same hour, and the lag measurement never ran at all.
 *
 * **This is not a way around the guard.** The point of the guard is that the
 * IDENTICAL payment is not made twice while its outcome is unknown, and a
 * payment to a different wallet is a different payment — not the same one
 * wearing a different key. Cycling the RECIPIENT rather than nudging the
 * amount is deliberate for exactly that reason: 25 tNIGHT to subwallet 3 is
 * a payment somebody could mean to make, while 25.000001 tNIGHT to
 * subwallet 1 is the same payment with the key filed off.
 *
 * The account is chosen from the minute the run starts, cycling through the
 * ten subwallets (accounts 2–11, `subwallets.ts`). Two runs in the same
 * minute get the same recipient, which is right — that really is a repeat.
 *
 * `PROBE_SAME_PAYMENT=1` pins it to subwallet 1 so a collision can be caused
 * ON PURPOSE and the guard stays exercised. That matters: a guard nothing
 * ever trips is a guard nobody would notice had broken.
 */
function recipientAccountFor(): number {
  if (forcedSamePayment()) return SUBWALLET_ACCOUNTS[0] ?? 2;
  const minute = Math.floor(Date.now() / 60_000);
  return SUBWALLET_ACCOUNTS[minute % SUBWALLET_ACCOUNTS.length] ?? 2;
}

async function run(): Promise<void> {
  step('modules-loaded', navigator.userAgent);

  /* Normally a THROWAWAY identity: fresh random bytes, discarded with the
   * tab — the probe must not teach the indexer a real wallet's address. The
   * TEST WALLET is the exception, and it is the point: a fixture the faucet
   * paid once, so the balance read here is a measurement. */
  const injected = injectedSecret();
  result.testWallet = injected !== null;
  /* The secret itself, kept: `pendingGuardFor` is bound to it, and the
   * pending store is fingerprint-named per account, so a record can
   * only ever be read back under the wallet that wrote it. */
  const secret: Secret = injected ?? newSecret();
  const identity = identityFromSecret(secret);
  step('identity-built', injected
    ? 'THE STABLE TEST WALLET — from the gitignored test-wallet.seed'
    : 'a throwaway — fresh random bytes, discarded with this tab');

  /* THE HOME SCREEN'S OWN BEHAVIOUR, run here: anything a PREVIOUS
   * run left unresolved is resolved against the chain now, with nobody
   * pressing anything. This is also the duplicate guard's supply — an
   * unresolved record for the same payment REFUSES the send below, which is
   * the guard working, not a fault. Silence still resolves nothing. */
  const carriedIn = unresolvedPendingSends(secret);
  if (carriedIn.length > 0) {
    step('pending-carried-in', `${carriedIn.length} payment(s) from an earlier run are still `
      + `unresolved on disk — ${carriedIn.map((r) => r.key.slice(0, 18)).join(', ')}… — `
      + 'resolving them against the chain before anything else');
    const settled = await resolvePendingSends(secret).catch(() => [] as PendingSend[]);
    result.pendingCarriedIn = carriedIn.map((r) => {
      const now = settled.find((x) => x.key === r.key);
      return {
        key: r.key,
        outcome: now?.outcome
          ? now.outcome.name
          : 'STILL unresolved — the chain has not answered, and silence decides nothing',
      };
    });
    for (const r of result.pendingCarriedIn) {
      step('pending-carried-in-resolved', `${r.key.slice(0, 18)}… → ${r.outcome}`);
    }
  }

  const shown = addressFor(identity.moneyAt(0).zswap, NETWORK).bech32;
  step('address-derived', `${shown.slice(0, 30)}…`);

  const wallet = walletFor(identity, 0);
  step('wallet-constructed', 'via startWithSecretKeys — the right door');

  const reported = MidnightBech32m.encode(NETWORK, await wallet.getAddress()).asString();
  if (reported !== shown) {
    finish('FAILED', `address disagreement: wallet reports ${reported.slice(0, 30)}…, `
      + `the card would show ${shown.slice(0, 30)}… — the §1.1 failure, live`);
    return;
  }
  step('address-agrees', 'the synced wallet IS the displayed wallet');

  /* The unshielded door, held to the same bar BEFORE any syncing. */
  const nightShown = unshieldedAddressFor(identity, 0);
  step('unshielded-address-derived', `${nightShown.slice(0, 30)}… — the one the faucet pays`);
  const nightWallet = unshieldedWalletFor(identity, 0);
  step('unshielded-wallet-constructed', 'schnorr keystore → startWithPublicKey');
  const nightReported = MidnightBech32m.encode(NETWORK, await nightWallet.getAddress()).asString();
  if (nightReported !== nightShown) {
    finish('FAILED', `unshielded address disagreement: wallet reports `
      + `${nightReported.slice(0, 30)}…, the card would show ${nightShown.slice(0, 30)}… `
      + '— the §1.1 failure through the address door, live');
    return;
  }
  step('unshielded-address-agrees', 'the synced unshielded wallet IS the displayed one');

  /* The DUST door, held to the same bar. */
  const dustShown = dustAddressFor(identity, 0);
  step('dust-address-derived', `${dustShown.slice(0, 30)}… — where generated DUST is credited`);
  const dustW = dustWalletFor(identity, 0);
  step('dust-wallet-constructed', 'DustSecretKey.fromSeed over the DUST role → startWithSecretKey');
  const dustReported = MidnightBech32m.encode(NETWORK, await dustW.getAddress()).asString();
  if (dustReported !== dustShown) {
    finish('FAILED', `DUST address disagreement: wallet reports ${dustReported.slice(0, 30)}…, `
      + `the app derives ${dustShown.slice(0, 30)}… — the §1.1 failure through the DUST door, live`);
    return;
  }
  step('dust-address-agrees', 'the syncing dust wallet IS the derived one');

  /* ---------- THE MEASUREMENT — the first act, before anything else ---------- */
  await runMeasurement(identity);

  /* ---------- the shielded sync ---------- */

  let sawConnection = false;
  let startedAt = 0;
  const subscription = wallet.state.subscribe({
    next: (state) => {
      const progress = state.progress;
      result.progress = `shielded: ${progress.appliedIndex} events applied; newest event the `
        + `indexer has reported: ${progress.highestIndex === 0n ? 'none yet' : progress.highestIndex}; `
        + `connected: ${String(progress.isConnected)}`;
      flush();
      if (progress.isConnected && !sawConnection) {
        sawConnection = true;
        step('indexer-answered', result.progress);
      }
      if (sawConnection && progress.isStrictlyComplete() && result.coldSyncMs === undefined && !result.done) {
        result.coldSyncMs = Math.round(performance.now() - startedAt);
        result.balanceEntries = Object.keys(state.balances).length;
        step('synced', `shielded cold sync ${result.coldSyncMs}ms; `
          + `${result.balanceEntries} token balances; `
          + `night=${String(state.balances[
            '0000000000000000000000000000000000000000000000000000000000000000'] ?? 0n)}`);
        void wallet.stop().catch(() => {});
        subscription.unsubscribe();
        runUnshieldedPhase();
      }
    },
    error: (e: unknown) => {
      if (result.done) return;
      /* A sync error is a NETWORK answer, not a stack failure: everything
       * local already passed by the time the socket speaks. */
      finish('STACK-OK-NETWORK-UNREACHED', describeFailure(e));
      void wallet.stop().catch(() => {});
      void nightWallet.stop().catch(() => {});
      void dustW.stop().catch(() => {});
    },
  });

  /* Set when the two balance syncs are done: the global sync timeout stands
   * down, because the dust phase (proving can take minutes) keeps its own
   * time and reports its own stage. */
  let syncPhasesDone = false;

  /* ---------- phase 3 of 4: the unshielded sync — the faucet's side ---------- */

  function runUnshieldedPhase(): void {
    const nightStartedAt = performance.now();
    let nightConnected = false;
    const nightSubscription = nightWallet.state.subscribe({
      next: (state) => {
        const progress = state.progress;
        result.progress = `unshielded: ${progress.appliedId} transactions applied; highest the `
          + `indexer has reported: ${progress.highestTransactionId === 0n ? 'none yet' : progress.highestTransactionId}; `
          + `connected: ${String(progress.isConnected)}`;
        flush();
        if (progress.isConnected && !nightConnected) {
          nightConnected = true;
          step('unshielded-indexer-answered', result.progress);
        }
        if (nightConnected && progress.isStrictlyComplete() && !result.done) {
          result.unshieldedSyncMs = Math.round(performance.now() - nightStartedAt);
          /* The SAME record key the app's engine reads — nativeToken().raw. */
          const stars = state.balances[NIGHT_UNSHIELDED_RAW] ?? 0n;
          result.unshieldedStars = String(stars);
          step('unshielded-synced', `sync ${result.unshieldedSyncMs}ms; `
            + `unshielded NIGHT = ${exactStars(stars)} → renders as ${nightFromStars(stars)} tNIGHT`);
          if (result.testWallet) {
            step('§7.17-measurement', stars === 0n
              ? 'the test wallet holds nothing yet — fund it with the faucet '
                + '(the test-wallet tool prints the address) and run this again'
              : `MEASURED: ${exactStars(stars)}. A faucet payment is 5000 tNIGHT — the split `
                + `holds exactly when this reads 5,000,000,000 STARs; it renders as `
                + `${nightFromStars(stars)} tNIGHT`);
          }
          void nightWallet.stop().catch(() => {});
          nightSubscription.unsubscribe();
          syncPhasesDone = true;
          runDustPhase(stars);
        }
      },
      error: (e: unknown) => {
        if (result.done) return;
        finish('SYNC-INCOMPLETE', `the shielded phase completed but the unshielded sync `
          + `died: ${describeFailure(e)}`);
        void nightWallet.stop().catch(() => {});
      },
    });
    step('unshielded-start-called', `syncing against ${INDEXER_HTTP_URL}`);
    nightWallet.start().catch((e: unknown) => {
      if (!result.done) {
        finish('SYNC-INCOMPLETE', `the shielded phase completed but the unshielded start `
          + `failed: ${describeFailure(e)}`);
      }
    });
  }

  /* ---------- phase 4 of 4: DUST — read it, and on the test wallet, MAKE it ---------- */

  function runDustPhase(nightStars: bigint): void {
    if (result.testWallet && nightStars > 0n) {
      void runRegistration();
    } else {
      readDustAlone();
    }
  }

  /* The reading half alone — a throwaway (or an unfunded test wallet) has
   * no NIGHT to register, so this proves the third stack syncs in a browser
   * and reads its honest zero. */
  function readDustAlone(): void {
    const dustStartedAt = performance.now();
    let dustConnected = false;
    const dustSubscription = dustW.state.subscribe({
      next: (state) => {
        const progress = state.progress;
        result.progress = `dust: ${progress.appliedIndex} events applied; newest the indexer `
          + `has reported: ${progress.highestIndex === 0n ? 'none yet' : progress.highestIndex}; `
          + `connected: ${String(progress.isConnected)}`;
        flush();
        if (progress.isConnected && !dustConnected) {
          dustConnected = true;
          step('dust-indexer-answered', result.progress);
        }
        if (dustConnected && progress.isStrictlyComplete() && !result.done) {
          const specks = state.balance(new Date());
          result.dustSpecks = String(specks);
          step('dust-synced', `sync ${Math.round(performance.now() - dustStartedAt)}ms; `
            + `DUST = ${exactSpecks(specks)} → renders as ${dustFromSpecks(specks)} tDUST`
            + (result.testWallet
              ? ' — fund the wallet, then rerun: the funded run registers NIGHT and makes DUST'
              : ' — a throwaway registers nothing; the test-wallet run is where DUST gets made'));
          finish('FULL');
          void dustW.stop().catch(() => {});
          dustSubscription.unsubscribe();
        }
      },
      error: (e: unknown) => {
        if (result.done) return;
        finish('SYNC-INCOMPLETE', `the balance phases completed but the dust sync died: `
          + `${describeFailure(e)}`);
        void dustW.stop().catch(() => {});
      },
    });
    step('dust-start-called', `syncing against ${INDEXER_HTTP_URL}`);
    dustW.start(dustSecretKeyFor(identity, 0)).catch((e: unknown) => {
      if (!result.done) {
        finish('SYNC-INCOMPLETE', `the balance phases completed but the dust start failed: `
          + `${describeFailure(e)}`);
      }
    });
    setTimeout(() => {
      if (result.done) return;
      finish('SYNC-INCOMPLETE',
        `the balance phases completed but the dust sync did not finish in 60s — `
        + `${result.progress ?? 'no progress seen'}`);
      dustSubscription.unsubscribe();
      void dustW.stop().catch(() => {});
    }, 60_000);
  }

  /* Waits until the facade's dust wallet reads above zero — the moment DUST
   * exists to reach. */
  function dustAboveZero(facade: WalletFacade, timeoutMs: number): Promise<bigint> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription2.unsubscribe();
        reject(new Error(`no DUST visible within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const subscription2 = facade.state().subscribe({
        next: (state) => {
          const specks = state.dust.balance(new Date());
          if (specks > 0n) {
            clearTimeout(timer);
            subscription2.unsubscribe();
            resolve(specks);
          }
        },
        error: (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(describeFailure(e), { cause: e }));
        },
      });
    });
  }

  /* ---------- The measurement --------------
   *
   * THE NUMBER THIS PROJECT HAS WAITED FOR: how long a REAL proof of a
   * plain shielded transfer takes in this browser. Nothing measured before
   * says it — the 7ms registration carries no circuit, and the rehearsal
   * erases proofs entirely — and the number cannot be taken on stagenet
   * directly, because this ledger has NO SHIELD DOOR: shielded value is
   * minted by contracts, and a transaction netting unshielded NIGHT against
   * a shielded output is refused by the ledger's own balancing (measured,
   * and pinned in send.test.ts). So the transaction is built on the SDK's
   * simulated chain, where shielded coins exist by genesis — and PROVED BY
   * THE REAL PROVER: the real zkir circuits, the real key material from the
   * Foundation's bucket, the real WASM, in this real browser. The proof is
   * anchored to a pretend chain and could never be submitted anywhere; the
   * TIME is the measurement, and the circuits are exactly a live transfer's
   * (zswap spend, two outputs, a dust spend — the same manifest a real
   * send's proof asks the key provider for, watched live).
   *
   * TWICE, because the first proof also pays the one-time costs (parameter
   * downloads the provider caches); cold and warm are both reported. Runs
   * on every probe — it needs no funds — and a machine that cannot reach
   * the key bucket says so in one honest step and moves on.
   */
  async function runMeasurement(probeIdentity: Identity): Promise<void> {
    step('measurement-phase', 'a REAL in-browser proof of a plain shielded transfer — '
      + 'the number this measurement exists to take');

    /* Preflight OUR OWN key material. The Foundation's bucket is out
     * of the page entirely (it refuses web pages — CORS is not enabled for
     * it, measured), so the keys come vendored, pinned and served
     * from this wallet's own origin. No manifest means not vendored yet,
     * and that is a fact rerunning cannot change — the advice says so in
     * those words. */
    try {
      const preflight = await fetch('/keys/manifest.json', {
        signal: AbortSignal.timeout(10_000),
      });
      if (!preflight.ok) throw new Error(`answered ${preflight.status}`);
      /* A dev server answers a missing file with the app page (200) — only
       * a parseable manifest counts as vendored. */
      await preflight.json();
    } catch (e) {
      result.measurementNote = 'the key material is not vendored on this wallet\'s own '
        + `origin (/keys/manifest.json ${describeFailure(e)}). `
        + 'This will fail every time until `npm run vendor-keys` has been run once on '
        + 'this machine — rerunning the probe without it will not change the answer.';
      step('measurement-skipped', result.measurementNote);
      return;
    }

    let stage = 'fetching key material';
    const phaseStart = performance.now();
    const heartbeat = setInterval(() => {
      result.progress = `measurement, ${Math.round((performance.now() - phaseStart) / 1000)}s in — ${stage}`;
      flush();
    }, 1_000);
    let rehearsal: Awaited<ReturnType<typeof startRehearsal>> | null = null;
    try {
      /* The key material, timed per circuit — the download-and-verify half
       * of a first proof's cost, separated from the compute half on purpose.
       * OUR provider (pinned, own origin, IndexedDB-cached — key-material.ts),
       * WRAPPED so every ask is recorded: `getParams(k)` was invisible until
       * recently, and which k a real proof asks for is the number the hosting
       * decision needs. ONE instance, so its caches serve the proofs below. */
      /* The warm-up loop below asks for three circuits BY NAME. Those
       * asks are the probe telling itself what to fetch; they are not
       * evidence about what a proof needs, and recording them as if they
       * were is how the circuit half of the hosting number came to be
       * asserted while the parameter half was measured. */
      let keyAskSource: 'probe-prefetch' | 'proof' = 'probe-prefetch';
      const keys = recordingKeyMaterial(makePinnedKeyMaterialProvider(), (ask) => {
        recordKeyAsk(result, ask, keyAskSource);
        if (ask.kind === 'params') {
          step(`params k=${ask.k}`, `${ask.ms}ms; ${ask.bytes.toLocaleString()} bytes — `
            + 'THE PARAMETER SIZE a real proof asks for (the hosting decision\'s number)');
          return;
        }
        if (keyAskSource === 'proof') {
          step(`circuit ${ask.keyLocation}`, `${ask.ms}ms; prover key `
            + `${ask.proverBytes.toLocaleString()} bytes — THE CIRCUIT a real proof `
            + 'ASKS FOR (the other half of the hosting decision\'s number)');
        }
      });
      result.keyMaterial = [];
      for (const circuit of ['midnight/zswap/spend', 'midnight/zswap/output', 'midnight/dust/spend'] as const) {
        stage = `fetching and verifying key material — ${circuit}`;
        const fetchStart = performance.now();
        const material = await keys.lookupKey(circuit);
        const ms = Math.round(performance.now() - fetchStart);
        if (!material) throw new Error(`the provider has no key material for ${circuit}`);
        result.keyMaterial.push({
          circuit, ms,
          proverBytes: material.proverKey.byteLength,
          irBytes: material.ir.byteLength,
        });
        step(`key-material — ${circuit}`, `${ms}ms fetched AND hash-verified; prover key `
          + `${material.proverKey.byteLength.toLocaleString()} bytes — PRE-FETCHED BY THIS `
          + 'PROBE, not asked for by a proof');
      }
      /* Everything from here is a PROVER asking. */
      keyAskSource = 'proof';

      stage = 'raising the pretend chain the transaction is built on';
      rehearsal = await startRehearsal(probeIdentity, 0, {
        provingService: makeBrowserProvingService(keys),
      });

      const recipient = MidnightBech32m
        .parse(addressFor(probeIdentity.moneyAt(2).zswap, NETWORK).bech32)
        .decode(ShieldedAddress, NETWORK);
      const facadeKeys = {
        shieldedSecretKeys: secretKeysFor(probeIdentity, 0),
        dustSecretKey: dustSecretKeyFor(probeIdentity, 0),
      };
      result.shieldedProofMs = [];
      for (const round of ['cold', 'warm'] as const) {
        stage = `building a shielded transfer to prove (${round})`;
        const ttl = new Date(rehearsal.now().getTime() + 60 * 60 * 1000);
        const recipe = await rehearsal.facade.transferTransaction([{
          type: 'shielded',
          outputs: [{ type: shieldedToken().raw, receiverAddress: recipient, amount: 10_000_000n }],
        }], facadeKeys, { ttl });
        stage = `PROVING (${round}) — a real zswap spend, two outputs and a dust spend; `
          + 'this is the wait the send screen was built for';
        const proveStart = performance.now();
        const finalized = await rehearsal.facade.finalizeRecipe(recipe);
        const ms = Math.round(performance.now() - proveStart);
        result.shieldedProofMs.push(ms);
        step(`THE MEASUREMENT (${round})`, `${ms}ms — a real in-browser proof of a plain `
          + 'shielded transfer');
        stage = 'releasing the rehearsal coins';
        await rehearsal.facade.revert(finalized).catch(() => { /* release is best effort */ });
      }
    } catch (e) {
      result.measurementNote = `the measurement stopped at "${stage}": `
        + `${describeFailure(e)}`;
      step('measurement-failed', result.measurementNote);
    } finally {
      clearInterval(heartbeat);
      await rehearsal?.stop().catch(() => { /* already stopping is fine */ });
    }
  }

  /* ---------- The real send --------------
   *
   * REAL tNIGHT MOVES BETWEEN TWO WALLETS ON STAGENET: 25 tNIGHT from the
   * test wallet's main account to its own subwallet 1 — two wallets, one
   * identity, so nothing leaves the fixture however many times this runs.
   * It goes UNSHIELDED because that is the only kind of NIGHT this ledger
   * lets a wallet hold without a contract (the no-shield-door fact, pinned)
   * — and the transaction is still REALLY PROVED: its fee is paid from real
   * DUST, and a dust spend carries a real circuit, proved by the same
   * in-browser prover the measurement timed, then accepted by the real
   * chain. The dangerous middle is handled the way the send screen handles
   * it: identifiers taken BEFORE submission, and a failure after proving
   * reported as exactly what is known, never a guess.
   */
  async function runRealSend(
    facade: WalletFacade, unshieldedStars: bigint, setStage: (message: string) => void,
  ): Promise<void> {
    const AMOUNT = 25_000_000n; /* 25 tNIGHT */
    if (unshieldedStars < AMOUNT) {
      step('real-send-skipped', `the wallet holds ${exactStars(unshieldedStars)} unshielded — `
        + 'not enough to move 25 tNIGHT; fund it and rerun');
      return;
    }
    const recipientAccount = recipientAccountFor();
    const slot = slotNumberOf(recipientAccount);
    setStage('building the real send');
    step('real-send-phase', `moving ${nightFromStars(AMOUNT)} tNIGHT on stagenet — main wallet `
      + `to subwallet ${slot}, real money, irreversible`
      + (forcedSamePayment()
        ? ' — PROBE_SAME_PAYMENT=1, so this run deliberately repeats the payment '
          + 'subwallet 1 always gets, to exercise the duplicate guard'
        : ' — the recipient cycles per run (a run that leaves a record '
          + 'unresolved must not refuse the NEXT run\'s payment, and a different '
          + 'wallet is a different payment)'));
    const recipientBech = unshieldedKeystoreFor(identity, recipientAccount)
      .getBech32Address().asString();

    /* THE PENDING GUARD AGAINST A REAL SEND — the whole point of this change.
     *
     * Until recently this function built, signed, proved and submitted a transfer
     * BY HAND, past the send engine. So the machinery the guard exists for — the
     * payment written down BEFORE the network is touched, the duplicate
     * refused while one is in flight, the record resolved against the chain
     * by its own identifier — had never met a real event, however green its
     * tests were. It now runs THE ENGINE, with the same doors the send
     * screen builds (`screens/send.tsx:94`): the real facade, the real
     * signer, `pendingGuardFor` over real storage, and the indexer as the
     * thing the middle asks.
     *
     * The pending doors are WRAPPED, not replaced. Every call goes to the
     * real guard first; the wrapper only watches, and what it reports about
     * the record it reads BACK OUT OF STORAGE rather than echoing the draft
     * it was handed — the draft is what the engine intended, the store is
     * what a killed tab would leave behind. */
    /* The wrapper lives in `pending.ts` — beside the guard it wraps, where a
     * test can reach it (`recordKeyAsk`'s lesson). */
    /* WHICH ANSWER SETTLED IT. The engine settles a successful submit from
     * the submission's own reply; if the submission goes quiet or throws it
     * says `unknown` FIRST and then settles from the chain, through its
     * watcher. Seeing `unknown` is therefore how this run tells the two
     * apart — and they are different claims, so the report says which. */
    let sawUnknown = false;
    const pending = observedPendingGuard(secret, 0, {
      wrote: (stored) => {
        result.pendingBeforeSubmit = {
          key: stored.key,
          identifiers: stored.identifiers,
          kind: stored.kind,
          recipientBech32: stored.recipientBech32,
          stars: stored.stars,
          feeSpecks: stored.feeSpecks,
          submittedAt: stored.submittedAt,
          ttlAt: stored.ttlAt,
          outcome: stored.outcome === null ? 'null — unresolved' : stored.outcome.name,
        };
        step('pending-written', 'the payment is ON DISK before the network is touched — '
          + `key ${stored.key.slice(0, 18)}…, ${stored.identifiers.length} identifier(s), `
          + `${exactStars(BigInt(stored.stars))}, outcome `
          + `${result.pendingBeforeSubmit.outcome}`);
      },
      settled: (key, outcome) => {
        result.pendingSettled = {
          key,
          outcome: outcome.name,
          from: sawUnknown
            ? 'the engine\'s watcher, asking the CHAIN by identifier'
            : 'the submission\'s own answer',
        };
        step('pending-settled', `the record is resolved: ${outcome.name}`
          + (outcome.name === 'failed' ? ` — ${outcome.reason}` : ''));
      },
    });

    const doors: SendDoors = {
      facade: async () => facade,
      keys: () => ({
        shieldedSecretKeys: secretKeysFor(identity, 0),
        dustSecretKey: dustSecretKeyFor(identity, 0),
      }),
      signSegment: () => unshieldedKeystoreFor(identity, 0).signDataAsync,
      ownUnshieldedHex: unshieldedKeystoreFor(identity, 0).getAddress(),
      pending,
      transactionStatus: transactionStatusOnChain,
    };

    /* The engine's states, watched the way a screen watches them — and the
     * proving time taken from the stage boundaries rather than from a
     * stopwatch this function holds, because the engine owns the stages now. */
    let stageEnteredAt = performance.now();
    let currentStage: string | null = null;
    let controller: ReturnType<typeof startSend> | null = null;
    /* HOW LONG THIS RUN WAITS FOR A MIDDLE TO END. A watched middle may
     * legitimately last until the transaction's TTL plus its margin — over
     * an hour — and a probe cannot sit there. When patience runs out the run
     * says so and stops watching FROM HERE; the record stays on disk,
     * unresolved, and the next run's start-up resolution (and the home
     * screen) carry it to its answer. An unresolved middle is not a failed
     * send and this run must not write it down as one. */
    const MIDDLE_PATIENCE_MS = 180_000;
    const finished = await new Promise<SendState | 'patience-ran-out'>((resolve) => {
      const patience = setTimeout(() => {
        controller?.detach();
        resolve('patience-ran-out');
      }, MIDDLE_PATIENCE_MS);
      const done = (state: SendState): void => { clearTimeout(patience); resolve(state); };
      controller = startSend(doors, {
        recipient: parseRecipient(recipientBech, NETWORK), stars: AMOUNT,
      }, (state) => {
        if (state.name === 'working') {
          if (state.stage === currentStage) return;
          if (currentStage === 'proving') {
            result.realSendProvingMs = Math.round(performance.now() - stageEnteredAt);
            step('real-send-proved', `${result.realSendProvingMs}ms in-browser — a REAL proof `
              + 'on a REAL transaction (the fee\'s dust spend)');
          }
          currentStage = state.stage;
          stageEnteredAt = performance.now();
          setStage(`the send engine: ${state.stage}`);
          return;
        }
        if (state.name === 'confirm') {
          result.realSendStars = String(state.facts.stars);
          step('real-send-balanced', 'fee, read back from the recipe\'s own dust spends: '
            + `${exactSpecks(state.facts.feeSpecks)}`);
          step('real-send-signed', 'the engine signs the unshielded inputs before proving '
            + 'and counts them off the transaction — its own step, not this one\'s');
          /* The person's yes. There is nobody here, so the probe says it —
           * and says so, rather than letting the log read as if a human
           * approved a real payment. */
          step('real-send-confirmed', 'THE PROBE confirmed on the person\'s behalf — an '
            + 'unattended run, and the engine required a decision before proving');
          controller?.confirm();
          return;
        }
        if (state.name === 'unknown') {
          sawUnknown = true;
          step('real-send-UNKNOWN-middle', 'the submission has not answered — the engine is '
            + 'now watching the chain by identifier, and the record is on disk either way');
          return;
        }
        done(state);
      });
    });

    if (finished === 'patience-ran-out') {
      step('real-send-STILL-UNRESOLVED', `no answer within ${MIDDLE_PATIENCE_MS / 1000}s. `
        + 'The payment is written down on disk and is NOT resolved. Whether the money '
        + 'moved is not known from here — it is not a failure and must not be read as '
        + 'one. Rerun the probe: its start-up resolution asks the chain again.');
    }
    const outcome: SendState | 'patience-ran-out' = finished;
    if (outcome === 'patience-ran-out') {
      /* nothing more to say here — the disk read and the chain resolution
       * below are exactly what an unresolved middle is entitled to. */
    } else if (outcome.name === 'sent') {
      result.realSendTxId = outcome.txId;
      result.realSendIdentifiers = [...(result.pendingBeforeSubmit?.identifiers ?? [outcome.txId])];
      step('real-send-submitted', `FINALIZED on stagenet — transaction ${outcome.txId}`);
    } else if (outcome.name === 'unknown') {
      result.realSendIdentifiers = [...outcome.identifiers];
      step('real-send-UNKNOWN', `${outcome.message}`);
    } else if (outcome.name === 'failed') {
      result.realSendIdentifiers = [...outcome.identifiers];
      step('real-send-failed', outcome.message);
    } else if (outcome.name === 'refused') {
      step('real-send-refused', outcome.message);
    } else {
      step('real-send-cancelled', 'the engine reported cancelled, which nothing here asked for');
    }

    /* WHAT IS ON DISK NOW, read independently of anything the engine said. */
    const after = loadPendingSends(secret).find(
      (r) => r.key === result.pendingBeforeSubmit?.key);
    result.pendingAfter = after
      ? { key: after.key, outcome: after.outcome === null ? 'null — still unresolved' : after.outcome.name }
      : 'no record on disk';

    /* THE RESOLUTION AGAINST THE CHAIN — asked separately, by the record's
     * own identifier, with the call the home screen's resolver uses, and
     * read through the same `outcomeOfAnswer`. The engine settles a
     * successful submit from the submission's own answer; this asks the
     * CHAIN, which is a different question and the one the guard is about.
     * SILENCE RESOLVES NOTHING and that is reported as the property it is. */
    const key = result.pendingBeforeSubmit?.key;
    if (key && after) {
      setStage('resolving the pending record against the chain');
      try {
        const answer = await transactionStatusOnChain(key);
        const resolved = outcomeOfAnswer({ ttlAt: after.ttlAt }, answer, Date.now());
        result.pendingChainResolution = {
          identifier: key,
          answer: answer.found ? `found, status ${answer.status}` : 'not found',
          resolvedTo: resolved === null
            ? 'NOTHING — the chain has not answered yet, and no answer decides nothing'
            : resolved.name,
        };
        step('pending-chain-resolution', `asked the indexer by the record's own identifier: `
          + `${result.pendingChainResolution.answer} → resolves to `
          + `${result.pendingChainResolution.resolvedTo}`);
      } catch (e) {
        result.pendingChainResolution = {
          identifier: key,
          answer: `the indexer did not answer: ${describeFailure(e)}`,
          resolvedTo: 'NOTHING — silence about the chain is not an answer about the chain',
        };
        step('pending-chain-resolution', 'the indexer did not answer, so the record resolves '
          + 'to NOTHING — silence decides nothing, which is the property');
      }
    }

    /* THE MEASUREMENT NOBODY HAD TAKEN.
     *
     * The node finalised a transaction and 168ms later the indexer, asked by
     * that transaction's own identifier, said `not found`. The wallet read
     * nothing into that and was right to. But `outcomeOfAnswer` turns a
     * SUSTAINED not-found past the deadline into `failed`, and the margin
     * defending that sentence — `TTL_SETTLE_MARGIN_MS`, five minutes — was
     * chosen to cover clock disagreement between this machine and the
     * chain. Nobody had measured indexer lag, because nobody had yet watched
     * a finalised transaction be invisible.
     *
     * So: keep asking, by the record's own identifier, until the chain shows
     * it. Time it. The margin should be set from THIS number and not from a
     * guess about clocks. A run that never finds it is not a failure of the
     * send — the send is finalised — it is a lag longer than this run's
     * patience, and that is reported as exactly that. */
    if (outcome !== 'patience-ran-out' && outcome.name === 'sent' && key) {
      const LAG_PATIENCE_MS = 240_000;
      const LAG_ASK_EVERY_MS = 1_000;
      setStage('timing how long the indexer takes to show a finalised transaction');
      const lagStart = performance.now();
      let asks = 0;
      let foundAfterMs: number | null = null;
      let answerText = 'never found within this run\'s patience';
      while (performance.now() - lagStart < LAG_PATIENCE_MS) {
        asks += 1;
        try {
          const answer = await transactionStatusOnChain(key);
          if (answer.found) {
            foundAfterMs = Math.round(performance.now() - lagStart);
            answerText = `found, status ${answer.status}`;
            break;
          }
        } catch {
          /* An indexer that will not answer is not an indexer that says no.
           * Keep asking; the count below says how many asks it took. */
        }
        await new Promise((r) => setTimeout(r, LAG_ASK_EVERY_MS));
      }
      result.indexerLag = {
        identifier: key,
        foundAfterMs,
        asks,
        patienceMs: LAG_PATIENCE_MS,
        answer: answerText,
      };
      step('indexer-lag', foundAfterMs === null
        ? `the indexer did NOT show this finalised transaction within `
          + `${LAG_PATIENCE_MS / 1000}s (${asks} asks). The send is finalised; this is `
          + 'the lag being longer than this run waited, and it is the number the '
          + 'settle margin needs.'
        : `the indexer first showed this finalised transaction after ${foundAfterMs}ms `
          + `(${asks} ask(s)) — ${answerText}. THIS is what TTL_SETTLE_MARGIN_MS must `
          + 'be set from.');
    }

    if (outcome === 'patience-ran-out' || outcome.name !== 'sent') return;

    /* End to end: the RECIPIENT wallet reads the money, on its own sync. */
    setStage('reading the recipient wallet');
    const recipientStars = await new Promise<bigint>((resolve, reject) => {
      const recipientWallet = unshieldedWalletFor(identity, recipientAccount);
      const timer = setTimeout(() => {
        recipientSub.unsubscribe();
        void recipientWallet.stop().catch(() => {});
        reject(new Error('the recipient wallet did not sync within 120s — the send is '
          + 'finalised; rerun to read it'));
      }, 120_000);
      const recipientSub = recipientWallet.state.subscribe({
        next: (state) => {
          if (state.progress.isConnected && state.progress.isStrictlyComplete()) {
            clearTimeout(timer);
            recipientSub.unsubscribe();
            void recipientWallet.stop().catch(() => {});
            resolve(state.balances[NIGHT_UNSHIELDED_RAW] ?? 0n);
          }
        },
        error: (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(describeFailure(e), { cause: e }));
        },
      });
      recipientWallet.start().catch((e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(describeFailure(e), { cause: e }));
      });
    });
    result.realSendRecipientStars = String(recipientStars);
    step('real-send-landed', `subwallet ${slot} now reads ${exactStars(recipientStars)} `
      + `(${nightFromStars(recipientStars)} tNIGHT) — moved end to end on stagenet`);
    step('registration-note', 'the spent NIGHT UTXO\'s dust registration ended with it '
      + '(generation follows the coin) — the change came back unregistered, and the next '
      + 'run of this probe re-registers it');
  }

  /* One sentence saying whether rerunning can change the answer,
   * decided by the REASON, not by hope. Failure classes this project has
   * actually met, most specific first; anything unrecognised is honestly
   * marked as unclassified rather than guessed either way. */
  function adviceFor(message: string): string {
    if (message.includes('npm run vendor-keys')) {
      return 'This will fail every time until `npm run vendor-keys` has been run on this '
        + 'machine — the key material is not vendored (or not fully), and rerunning '
        + 'the probe without it will not change the answer.';
    }
    if (message.includes('does not match its pin')) {
      return 'This will fail every time until somebody finds out why an artefact no '
        + 'longer matches its pinned hash — read the refusal above; rerunning will '
        + 'not change it, and it must not be made to.';
    }
    if (message.includes('CORS') || message.includes('Access-Control-Allow-Origin')) {
      return 'This will fail every time until the blocked host enables CORS — a '
        + 'server configuration owned by somebody else; rerunning cannot change it.';
    }
    if (/timed? ?out|within \d+m?s|patience|did not finish/iu.test(message)) {
      return 'This looks like exhausted patience, not a refusal — rerunning with the '
        + 'same command MAY produce a different answer.';
    }
    if (/Failed to fetch|network|ECONN|ENOTFOUND|disconnected/iu.test(message)) {
      return 'This looks like the network, not the stack — if this machine can reach '
        + 'the hosts named above, rerunning may change the answer; from a sandbox '
        + 'that blocks them it will fail every time.';
    }
    return 'UNCLASSIFIED — this failure is not one the probe knows the shape of. Do '
      + 'not assume rerunning fixes it; read the reason above and decide.';
  }

  /* The registration, the Foundation's own flow: estimate → wait until projected
   * generation covers the fee → register (signed by the unshielded key) →
   * prove in the browser → submit → wait for DUST. Every stage is a step,
   * and a heartbeat keeps the screen honest while the WASM prover grinds. */
  async function runRegistration(): Promise<void> {
    await dustW.stop().catch(() => {}); /* the facade runs its own three wallets */
    step('dust-phase', 'registering NIGHT for DUST generation through the SDK\'s WalletFacade');
    let stage = 'assembling the facade';
    const phaseStart = performance.now();
    const heartbeat = setInterval(() => {
      result.progress = `dust phase, ${Math.round((performance.now() - phaseStart) / 1000)}s in — ${stage}`;
      flush();
    }, 1_000);
    let facade: WalletFacade | null = null;
    try {
      /* The same pinned-and-recorded key source the measurement used, so
       * the REAL send's own `getParams(k)` is captured too. */
      const keyMaterial = recordingKeyMaterial(makePinnedKeyMaterialProvider(), (ask) => {
        /* This provider is fresh and nothing pre-fetches through it,
         * so every circuit ask here is the REAL SEND'S prover asking. */
        recordKeyAsk(result, ask, 'proof');
        if (ask.kind === 'params') {
          step(`params k=${ask.k}`, `${ask.ms}ms; ${ask.bytes.toLocaleString()} bytes — `
            + 'asked for by the REAL send');
          return;
        }
        step(`circuit ${ask.keyLocation}`, `${ask.ms}ms; prover key `
          + `${ask.proverBytes.toLocaleString()} bytes — asked for by the REAL send`);
      });
      facade = await facadeFor(identity, 0, makeBrowserProvingService(keyMaterial));
      stage = 'starting all three wallets';
      const keys = facadeKeysFor(identity, 0);
      await facade.start(keys.shielded, keys.dust);
      stage = 'waiting for the combined state to sync';
      const synced = await facade.waitForSyncedState();

      const already = synced.dust.balance(new Date());
      const unregistered = synced.unshielded.availableCoins
        .filter((coin) => !coin.meta.registeredForDustGeneration);

      /* REGISTER WHATEVER IS UNREGISTERED — this was widened from the earlier
       * "register once": spending a registered UTXO ends its generation
       * (the change comes back as a NEW, unregistered coin), so after any
       * real send the next run heals the registration here. When DUST
       * already exists, a registration hiccup must not fail the run — it is
       * housekeeping then, and it says so instead of flunking the verdict. */
      if (unregistered.length > 0) {
        try {
          stage = 'estimating the registration fee';
          const { fee } = await facade.estimateRegistration(unregistered);
          step('registration-fee-estimated', `${exactSpecks(fee)}`
            + (already > 0n ? ' — payable from the DUST already generating'
              : ' — paid out of the DUST the registered NIGHT itself generates; '
                + 'nothing else can pay it, this wallet has no DUST'));

          stage = 'waiting until projected generation covers the fee';
          await facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: 300_000 });
          step('registration-fee-covered', 'the projected generation covers the fee');

          stage = 'building and signing the registration';
          const keystore = unshieldedKeystoreFor(identity, 0);
          const recipe = await facade.registerNightUtxosForDustGeneration(
            unregistered, keystore.getPublicKey(), keystore.signDataAsync);
          step('registration-built', `${unregistered.length} NIGHT UTXO(s), signed by the unshielded key`);

          stage = 'proving the registration in the browser';
          const proveStart = performance.now();
          const finalized = await facade.finalizeRecipe(recipe);
          result.provingMs = Math.round(performance.now() - proveStart);
          step('registration-proved', `${result.provingMs}ms in-browser — a registration `
            + 'carries no circuit, so this is not a proving measurement');

          stage = 'submitting the registration to the stagenet node';
          result.registrationTxId = await facade.submitTransaction(finalized);
          step('registration-submitted', `transaction ${result.registrationTxId}`);
        } catch (e) {
          if (already <= 0n) throw e; /* no DUST and no registration = a real failure, loud */
          step('re-registration-deferred', `could not register the unregistered NIGHT this `
            + `run (stopped at "${stage}": ${describeFailure(e)}) — `
            + 'DUST already exists, so this is housekeeping; rerun to retry');
        }
      }

      stage = 'waiting for DUST to read above zero';
      const specks = already > 0n ? already : await dustAboveZero(facade, 300_000);
      result.dustSpecks = String(specks);
      step('DUST-EXISTS', `${exactSpecks(specks)} → renders as ${dustFromSpecks(specks)} tDUST`);

      /* ---------- The real send ---------- */
      await runRealSend(facade, synced.unshielded.balances[NIGHT_UNSHIELDED_RAW] ?? 0n,
        (message) => { stage = message; });
      finish('FULL');
    } catch (e) {
      /* THE ORDER MATTERS: the reason is FORMATTED BEFORE
       * `adviceFor` classifies it. The 20 Aug run reported
       * "UNCLASSIFIED — this failure is not one the probe knows the shape
       * of", which reads like the instrument declining to guess. It was
       * not: `e.message` was the empty string, so the classifier was handed
       * a blank and had nothing to classify. It behaved correctly on the
       * input it was given; the input was the defect. Anything that moves
       * this line below `adviceFor` restores that. */
      const message = describeFailure(e);
      /* THE VERDICT COMES FROM THE PHASE THAT FAILED AND THE REASON IT
       * GAVE. The syncs completed (this function does not run before they
       * have), so SYNC-INCOMPLETE — whose remedy is patience — would be a
       * wrong diagnosis here by construction: the 20 Aug run proved it,
       * ending "rerun with more patience" over a permanent CORS refusal.
       * An ACT failed; the advice below says whether rerunning can change
       * the answer, decided by what the reason actually was. */
      result.verdictAdvice = adviceFor(message);
      /* The act may be half-done. Say exactly what is known. */
      finish('ACT-FAILED', `the balance syncs COMPLETED (their numbers stand above); the `
        + `act stopped at "${stage}": ${message}. `
        + (result.registrationTxId
          ? `The registration WAS submitted — transaction ${result.registrationTxId} — so DUST `
            + 'may still appear on its own; rerun this probe to read the truth rather than guess.'
          : 'Nothing was submitted; the wallet is exactly as it was.'));
    } finally {
      clearInterval(heartbeat);
      await facade?.stop().catch(() => {});
    }
  }

  startedAt = performance.now();
  step('start-called', `syncing against ${INDEXER_HTTP_URL}`);
  wallet.start(secretKeysFor(identity, 0)).catch((e: unknown) => {
    if (!result.done) {
      finish('STACK-OK-NETWORK-UNREACHED', describeFailure(e));
    }
  });

  setTimeout(() => {
    if (result.done || syncPhasesDone) return;
    finish(
      sawConnection ? 'SYNC-INCOMPLETE' : 'STACK-OK-NETWORK-UNREACHED',
      sawConnection
        ? `still applying after ${SYNC_TIMEOUT_MS}ms (${result.progress ?? 'no progress seen'}) `
          + '— the stack and the network both work; rerun with more patience for a '
          + 'trustworthy number.'
        : `no connection within ${SYNC_TIMEOUT_MS}ms — ${result.progress ?? 'no progress seen'}`);
    subscription.unsubscribe();
    void wallet.stop().catch(() => {});
    void nightWallet.stop().catch(() => {});
    void dustW.stop().catch(() => {});
  }, SYNC_TIMEOUT_MS);
}

run().catch((e: unknown) => {
  finish('FAILED', e instanceof Error ? `${describeFailure(e)}\n${e.stack ?? ''}` : describeFailure(e));
});
