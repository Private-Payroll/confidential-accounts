import { MidnightBech32m, ShieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { shieldedToken } from '@midnightntwrk/ledger-v9';
import type { Identity } from 'midnight-identity';
import { addressFor } from 'midnight-identity';
import { NETWORK } from './config.js';
import { makePinnedKeyMaterialProvider, recordKeyAsk, recordingKeyMaterial } from './chain/key-material.js';
import { makeBrowserProvingService } from './chain/proving.js';
import { startRehearsal } from './chain/rehearsal.js';
import { describeFailure } from './lib/failure-text.js';
import { flush, result, step } from './probe-record.js';

/* ---------- The measurement --------------
 *
 * THE NUMBER THIS PROJECT HAS WAITED FOR: how long a REAL proof of a
 * plain shielded transfer takes in this browser. Nothing measured before
 * says it — the 7ms registration carries no circuit, and the rehearsal
 * erases proofs entirely — and the number cannot be taken on the live network
 * directly, because this ledger has NO SHIELD DOOR: shielded value is
 * minted by contracts, and a transaction netting unshielded NIGHT against
 * a shielded output is refused by the ledger's own balancing (measured,
 * and pinned in send.test.ts). So the transaction is built on the SDK's
 * simulated chain, where shielded coins exist by genesis — and PROVED BY
 * THE REAL PROVER: the real zkir circuits, the real key material (served from
 * this wallet's own origin and checked against pinned hashes), the real WASM,
 * in this real browser. The proof is
 * anchored to a pretend chain and could never be submitted anywhere; the
 * TIME is the measurement, and the circuits are exactly a live transfer's
 * (zswap spend, two outputs, a dust spend — the same manifest a real
 * send's proof asks the key provider for, watched live).
 *
 * TWICE, because the first proof also pays the one-time costs (parameter
 * downloads the provider caches); cold and warm are both reported. Runs
 * on every probe — it needs no funds — and a machine that cannot reach
 * the key material (not vendored here yet) says so in one honest step and moves on.
 */
export async function runMeasurement(probeIdentity: Identity): Promise<void> {
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
     * WRAPPED so every ask is recorded: `getParams(k)` is recorded too, because
     * which k a real proof asks for is the number the hosting decision needs. ONE instance, so its caches serve the proofs below. */
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
    result.shieldedProofMs = [];
    for (const round of ['cold', 'warm'] as const) {
      stage = `building a shielded transfer to prove (${round})`;
      const ttl = new Date(rehearsal.now().getTime() + 60 * 60 * 1000);
      const recipe = await rehearsal.facade.transferTransaction([{
        type: 'shielded',
        outputs: [{ type: shieldedToken().raw, receiverAddress: recipient, amount: 10_000_000n }],
      }], { ttl });
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
