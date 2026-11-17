import type { WalletFacade } from '@midnightntwrk/wallet-sdk';
import type { Identity, Secret } from 'midnight-identity';
import { unshieldedKeystoreFor } from './chain/unshielded.js';
import type { dustWalletFor } from './chain/dust.js';
import { facadeFor, seedsFor } from './chain/facade.js';
import { dustFromSpecks, exactSpecks } from './chain/amount.js';
import { registerNightForDust } from '../../../src/midnight/dust-registration.js';
import type { DustRegistrationWallet } from '../../../src/midnight/dust-registration.js';
import { makePinnedKeyMaterialProvider, recordKeyAsk, recordingKeyMaterial } from './chain/key-material.js';
import { makeBrowserProvingService } from './chain/proving.js';
import { describeFailure } from './lib/failure-text.js';
import { NETWORK_NAME, NIGHT_UNSHIELDED_RAW, finish, flush, result, step } from './probe-record.js';
import { runRealSend } from './probe-real-send.js';

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

/**
 * Registers the wallet's own NIGHT for DUST generation through `registerNightForDust`, the one
 * registration every wallet runs, and reports each stage as a step: estimate the fee → wait until
 * projected generation covers it → register (signed by the unshielded key) → prove in the browser →
 * submit. The wallet handed to it reports its own stages; the send handed to it proves and submits
 * through the facade's own services, so a failed send gives the booked NIGHT coins back.
 */
export async function registerOwnNight(
  facade: WalletFacade, identity: Identity, already: bigint, setStage: (message: string) => void,
): Promise<void> {
  const keystore = unshieldedKeystoreFor(identity, 0);
  const reporting: DustRegistrationWallet = {
    waitForSyncedState: () => facade.waitForSyncedState(),
    estimateRegistration: async (coins) => {
      setStage('estimating the registration fee');
      const estimate = await facade.estimateRegistration(coins);
      step('registration-fee-estimated', `${exactSpecks(estimate.fee)}`
        + (already > 0n ? ' — payable from the DUST already generating'
          : ' — paid out of the DUST the registered NIGHT itself generates; '
            + 'nothing else can pay it, this wallet has no DUST'));
      return estimate;
    },
    waitForGeneratedDust: async (coins, fee, wait) => {
      setStage('waiting until projected generation covers the fee');
      await facade.waitForGeneratedDust(coins, fee, wait);
      step('registration-fee-covered', 'the projected generation covers the fee');
    },
    registerNightUtxosForDustGeneration: async (...asked) => {
      setStage('building and signing the registration');
      const recipe = await facade.registerNightUtxosForDustGeneration(...asked);
      step('registration-built', `${asked[0].length} NIGHT UTXO(s), signed by the unshielded key`);
      return recipe;
    },
  };
  await registerNightForDust(
    reporting,
    { verifyingKey: keystore.getPublicKey(), sign: keystore.signDataAsync },
    {
      waitMs: 300_000,
      send: async (recipe) => {
        setStage('proving the registration in the browser');
        const proveStart = performance.now();
        const finalized = await facade.finalizeRecipe(recipe);
        result.provingMs = Math.round(performance.now() - proveStart);
        step('registration-proved', `${result.provingMs}ms in-browser — a registration `
          + 'carries no circuit, so this is not a proving measurement');

        setStage(`submitting the registration to the ${NETWORK_NAME} node`);
        result.registrationTxId = await facade.submitTransaction(finalized);
        step('registration-submitted', `transaction ${result.registrationTxId}`);
        return result.registrationTxId;
      },
    },
  );
}

/* The registration, then the real send: register the NIGHT (`registerOwnNight`) → wait for DUST →
 * send. Every stage is a step, and a heartbeat keeps the screen honest while the WASM prover grinds. */
export async function runRegistration(
  identity: Identity, secret: Secret, dustW: Awaited<ReturnType<typeof dustWalletFor>>,
): Promise<void> {
  await dustW.stop().catch(() => { /* a wallet that is already stopping is fine */ }); /* the facade runs its own three wallets */
  step('dust-phase', 'registering NIGHT for DUST generation through the SDK\'s WalletFacade');
  let stage = 'assembling the facade';
  const phaseStart = performance.now();
  const heartbeat = setInterval(() => {
    result.progress = `dust phase, ${Math.round((performance.now() - phaseStart) / 1000)}s in — ${stage}`;
    flush();
  }, 1_000);
  let facade: WalletFacade | null = null;
  try {
    /* A pinned, recording key source of its own, like the measurement's, so
     * the REAL send's `getParams(k)` is captured too. */
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
    await facade.start(seedsFor(identity, 0));
    stage = 'waiting for the combined state to sync';
    const synced = await facade.waitForSyncedState();

    const already = synced.dust.balance(new Date());

    /* REGISTER WHATEVER NIGHT IS UNREGISTERED: a coin that reached this
     * wallet without a registration (from a faucet, or from another wallet)
     * generates nothing until it is registered; change from spending a
     * registered coin keeps generating, because the address is still
     * registered. When DUST already exists, a registration hiccup must not
     * fail the run — it is housekeeping then, and it says so instead of
     * flunking the verdict. */
    try {
      await registerOwnNight(facade, identity, already, (message) => { stage = message; });
    } catch (e) {
      if (already <= 0n) throw e; /* no DUST and no registration = a real failure, loud */
      step('re-registration-deferred', `could not register the unregistered NIGHT this `
        + `run (stopped at "${stage}": ${describeFailure(e)}) — `
        + 'DUST already exists, so this is housekeeping; rerun to retry');
    }

    stage = 'waiting for DUST to read above zero';
    const specks = already > 0n ? already : await dustAboveZero(facade, 300_000);
    result.dustSpecks = String(specks);
    step('DUST-EXISTS', `${exactSpecks(specks)} → renders as ${dustFromSpecks(specks)} tDUST`);

    /* ---------- The real send ---------- */
    await runRealSend(identity, secret, facade, synced.unshielded.balances[NIGHT_UNSHIELDED_RAW] ?? 0n,
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
    await facade?.stop().catch(() => { /* a wallet that is already stopping is fine */ });
  }
}
