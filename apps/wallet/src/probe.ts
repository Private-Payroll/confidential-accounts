import { ensureBuffer } from 'midnight-identity/browser';


/* FIRST, exactly as main.tsx does it — that fix is part of what is being
 * probed: the address codec needs Buffer and a browser has none. */
ensureBuffer();

import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import type { Secret } from 'midnight-identity';
import { addressFor, identityFromSecret, newSecret } from 'midnight-identity';
import { shieldedKeysFor, walletFor } from './chain/balance.js';
import { unshieldedAddressFor, unshieldedWalletFor } from './chain/unshielded.js';
import { dustAddressFor, dustKeysFor, dustWalletFor } from './chain/dust.js';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from './chain/amount.js';
import { INDEXER_HTTP_URL, NETWORK } from './config.js';
import { resolvePendingSends, unresolvedPendingSends } from './chain/pending.js';
import type { PendingSend } from './chain/pending.js';
import { describeFailure } from './lib/failure-text.js';
import { runMeasurement } from './probe-measurement.js';
import { NIGHT_UNSHIELDED_RAW, carriedInOutcomes, finish, flush, probeWindow, result, step, syncingAgainst } from './probe-record.js';
import { runRegistration } from './probe-registration.js';


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
 * THE ACTS — what this probe DOES rather than reads. Every run times a real
 * in-browser proof on the pretend chain (`probe-measurement.ts`). On the test
 * wallet only, it registers the wallet's NIGHT for DUST generation through the
 * shared registration (`registerNightForDust`), proves the registration IN THE
 * BROWSER (`makeBrowserProvingService`), submits it to the network's node, waits
 * until the DUST balance reads above zero, and then makes a real send
 * (`probe-real-send.ts`). DUST cannot be fauceted; without it no fee can ever be
 * paid; so the registration is what makes sending possible at all. A throwaway
 * wallet holds no NIGHT and registers nothing — its dust phase only reads the
 * (empty) balance, proving the third stack runs.
 *
 * THE DANGEROUS MIDDLE: if the
 * registration is submitted and DUST does not appear in the probe's
 * patience, the report says exactly that — submitted, with the transaction
 * identifier — and never guesses either way.
 */

/** How long the two syncs together get before the probe calls the network
 * half unanswered. Generous: a cold shielded sync reads the chain from
 * event zero. */
const SYNC_TIMEOUT_MS = 150_000;

/** The injected seed, if the driver found `test-wallet.seed` on disk. */
function injectedSecret(): Secret | null {
  const hex = probeWindow.__TEST_WALLET_SEED__;
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
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
    let settled: PendingSend[] = [];
    let failed: string | null = null;
    try {
      settled = await resolvePendingSends(secret);
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
      step('pending-carried-in-unread', `resolving them failed before the chain answered: ${failed}`);
    }
    result.pendingCarriedIn = carriedInOutcomes(carriedIn, settled, failed);
    for (const r of result.pendingCarriedIn) {
      step('pending-carried-in-resolved', `${r.key.slice(0, 18)}… → ${r.outcome}`);
    }
  }

  const shown = addressFor(identity.moneyAt(0).zswap, NETWORK).bech32;
  step('address-derived', `${shown.slice(0, 30)}…`);

  const wallet = await walletFor(identity, 0);
  step('wallet-constructed', 'via startWithKeys — the right door');

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
  const nightWallet = await unshieldedWalletFor(identity, 0);
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
  const dustW = await dustWalletFor(identity, 0);
  step('dust-wallet-constructed', 'DustSecretKey.fromSeed over the DUST role → startWithKeys');
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
        void wallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
        subscription.unsubscribe();
        runUnshieldedPhase();
      }
    },
    error: (e: unknown) => {
      if (result.done) return;
      /* A sync error is a NETWORK answer, not a stack failure: everything
       * local already passed by the time the socket speaks. */
      finish('STACK-OK-NETWORK-UNREACHED', describeFailure(e));
      void wallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
      void nightWallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
      void dustW.stop().catch(() => { /* a wallet that is already stopping is fine */ });
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
          void nightWallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
          nightSubscription.unsubscribe();
          syncPhasesDone = true;
          runDustPhase(stars);
        }
      },
      error: (e: unknown) => {
        if (result.done) return;
        finish('SYNC-INCOMPLETE', `the shielded phase completed but the unshielded sync `
          + `died: ${describeFailure(e)}`);
        void nightWallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
      },
    });
    step('unshielded-start-called', syncingAgainst(INDEXER_HTTP_URL));
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
      void runRegistration(identity, secret, dustW);
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
          void dustW.stop().catch(() => { /* a wallet that is already stopping is fine */ });
          dustSubscription.unsubscribe();
        }
      },
      error: (e: unknown) => {
        if (result.done) return;
        finish('SYNC-INCOMPLETE', `the balance phases completed but the dust sync died: `
          + `${describeFailure(e)}`);
        void dustW.stop().catch(() => { /* a wallet that is already stopping is fine */ });
      },
    });
    step('dust-start-called', syncingAgainst(INDEXER_HTTP_URL));
    dustW.start(dustKeysFor(identity, 0)).catch((e: unknown) => {
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
      void dustW.stop().catch(() => { /* a wallet that is already stopping is fine */ });
    }, 60_000);
  }

  startedAt = performance.now();
  step('start-called', syncingAgainst(INDEXER_HTTP_URL));
  wallet.start(shieldedKeysFor(identity, 0)).catch((e: unknown) => {
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
    void wallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
    void nightWallet.stop().catch(() => { /* a wallet that is already stopping is fine */ });
    void dustW.stop().catch(() => { /* a wallet that is already stopping is fine */ });
  }, SYNC_TIMEOUT_MS);
}

run().catch((e: unknown) => {
  finish('FAILED', e instanceof Error ? `${describeFailure(e)}\n${e.stack ?? ''}` : describeFailure(e));
});
