import { CostModel } from '@midnightntwrk/ledger-v9';
import type { ProvingProvider, UnprovenTransaction } from '@midnightntwrk/ledger-v9';
import type { ProvingService, UnboundTransaction } from '@midnightntwrk/wallet-sdk/proving';
import type { KeyMaterialProvider } from '@midnight-ntwrk/zkir-v2';
import { makePinnedKeyMaterialProvider } from './key-material.js';
import { describeFailure } from '../lib/failure-text.js';

/**
 * THE IN-BROWSER PROVER, MADE TO ACTUALLY ANSWER.
 *
 * This is an IMPLEMENTATION of the SDK's one-method proving seam
 * (`ProvingService.prove` — wallet-sdk-capabilities/dist/proving/
 * provingService.d.ts:16), which is what the seam exists for. It does what
 * `makeWasmProvingService` does — `transaction.prove(provider,
 * CostModel.initialCostModel())`, the exact call in provingService.js:26,
 * with the proof computed by `@midnight-ntwrk/zkir-v2` in a web worker —
 * and differs in one MEASURED place and one DECIDED place (the key
 * material's source; below):
 *
 * **The SDK's worker never hears its work order in this app.** Its worker
 * (wallet-sdk-prover-client/dist/proof-worker.js) registers its message
 * listener at the end of a module graph that initialises WASM under a
 * top-level await, while the page side (WasmProver.js:67-71) posts the
 * one-and-only op the moment the worker is constructed. A message posted to
 * a module worker while its top-level await is pending is DROPPED — measured
 * in a real Chromium against the SDK's own worker file: an immediate post is
 * never answered; the same post five seconds later is (it fails the schema
 * decode, which is an ANSWER). There is no ready signal in the SDK's
 * protocol, so every real proof would sit the full ten-minute internal
 * timeout and die with "prove action timed out" — an error that reads like
 * slow proving and is a lost postMessage. Worth telling the Foundation.
 *
 * So this service's worker (`proving-worker.ts`, ours, bundled by vite's
 * own `new Worker(new URL(...))` support) says `ready` AFTER its listener
 * stands, and the page posts nothing before it hears that. Everything else
 * mirrors the SDK: one worker per proof, terminated after; key material
 * fetched on the PAGE side (so the provider's in-memory cache survives
 * across proofs); the SDK's own ten-minute ceiling, kept — a proof that
 * long is a fact the report should carry, not a hang.
 *
 * WHERE KEY MATERIAL COMES FROM — it changed, and the change closed two
 * defects. An earlier build reused the SDK's own default provider, which downloads
 * from a hardcoded Amazon bucket ("dev" in its name, no integrity check —
 * it) — and that bucket has CORS disabled, so no web page can fetch from
 * it at all: measured on a real machine, it killed the first real send at
 * proving. The SDK's own configuration makes the source injectable
 * (`keyMaterialProvider?` — provingService.d.ts:25; a `?` in a type is a
 * door), so the default here is now OUR provider (`key-material.ts`):
 * artefacts vendored to this wallet's own origin by `npm run vendor-keys`,
 * every byte verified against a SHA-256 pinned at vendoring, cached in
 * IndexedDB, and refusing loudly on any mismatch — never falling back to
 * the bucket. The bucket's name no longer appears anywhere in this app's
 * send path, which is the point.
 */

/** The SDK's own ceiling (MAX_TIME_TO_PROCESS, WasmProver.js:27). */
export const PROVING_CEILING_MS = 10 * 60 * 1000;

/** The default key material source — OURS: own origin, hash-pinned,
 * IndexedDB-cached (`key-material.ts`). NOT the SDK's bucket. */
export const defaultKeyMaterial = (): KeyMaterialProvider =>
  makePinnedKeyMaterialProvider();

type FromWorker =
  | { readonly op: 'ready' }
  | { readonly op: 'lookupKey'; readonly askId: number; readonly keyLocation: string }
  | { readonly op: 'getParams'; readonly askId: number; readonly k: number }
  | { readonly op: 'result'; readonly value: unknown }
  | { readonly op: 'failure'; readonly error: string };

export function makeBrowserProvingService(
  keyMaterialProvider?: KeyMaterialProvider,
): ProvingService<UnboundTransaction> {
  const km = keyMaterialProvider ?? defaultKeyMaterial();

  const callWorker = (
    op: 'prove' | 'check', preimage: Uint8Array, overwriteBindingInput?: bigint,
  ): Promise<unknown> => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./proving-worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      worker.terminate();
      settle();
    };
    const ceiling = setTimeout(() => {
      finish(() => reject(new Error(`the ${op} did not finish within ten minutes — `
        + 'the SDK\'s own ceiling for a single proof')));
    }, PROVING_CEILING_MS);
    worker.addEventListener('error', (event) => {
      finish(() => reject(new Error(event.message
        || 'the proving worker failed to load — a bundling fault, not a proving one')));
    });
    worker.addEventListener('message', ({ data }: MessageEvent<FromWorker>) => {
      switch (data.op) {
        case 'ready':
          /* The handshake: only now is the work order posted. */
          worker.postMessage({ op, preimage, overwriteBindingInput });
          return;
        case 'lookupKey':
          km.lookupKey(data.keyLocation)
            .then((value) => worker.postMessage({ op: 'answer', askId: data.askId, ok: true, value }))
            .catch((e: unknown) => worker.postMessage({
              op: 'answer', askId: data.askId, ok: false,
              error: describeFailure(e),
            }));
          return;
        case 'getParams':
          km.getParams(data.k)
            .then((value) => worker.postMessage({ op: 'answer', askId: data.askId, ok: true, value }))
            .catch((e: unknown) => worker.postMessage({
              op: 'answer', askId: data.askId, ok: false,
              error: describeFailure(e),
            }));
          return;
        case 'result':
          finish(() => resolve(data.value));
          return;
        case 'failure':
          finish(() => reject(new Error(data.error)));
      }
    });
  });

  /* The provider shape the ledger calls back into, per proof obligation
   * (`ProvingProvider` — ledger-v9.d.ts:2365). The SDK's worker also drops
   * `keyLocation` on the floor: it is carried inside the preimage
   * (proofDataIntoSerializedPreimage — ledger-v9.d.ts:610). */
  const provider: ProvingProvider = {
    check: (preimage, _keyLocation) =>
      callWorker('check', preimage) as Promise<(bigint | undefined)[]>,
    prove: (preimage, _keyLocation, overwriteBindingInput) =>
      callWorker('prove', preimage, overwriteBindingInput) as Promise<Uint8Array>,
    /* Straight through, as the SDK's own provider passes it
     * (WasmProver.js:132) — key material is page-side either way. */
    lookupKey: (keyLocation) => km.lookupKey(keyLocation),
  };

  return {
    /* The SDK's own invocation, verbatim: provingService.js:26. */
    prove: (transaction: UnprovenTransaction) =>
      transaction.prove(provider, CostModel.initialCostModel()) as Promise<UnboundTransaction>,
  };
}
