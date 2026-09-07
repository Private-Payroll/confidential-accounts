import { check, prove } from '@midnight-ntwrk/zkir-v2';
import { describeFailure } from '../lib/failure-text.js';

/**
 * THE PROVING WORKER — ours, and the reason it exists is a measured defect
 * in the SDK's own (`proving.ts` tells the whole story): the SDK's worker
 * registers its message listener at the END of a module graph that loads
 * WASM under a TOP-LEVEL AWAIT, while the page posts the one-and-only work
 * order the moment the worker is constructed — and a message posted to a
 * module worker during its top-level await is DROPPED, so every real proof
 * hangs for the SDK's ten-minute timeout and dies. Measured in a real
 * browser: an immediate post is never answered; the same post five seconds
 * later is.
 *
 * So this worker's contract is a HANDSHAKE: it says `ready` only after its
 * listener stands, and the page posts nothing before it hears that. The
 * proving itself is the SDK's own dependency doing the SDK's own work —
 * `check` and `prove` from `@midnight-ntwrk/zkir-v2`, exactly the two calls
 * the SDK's worker makes (wallet-sdk-prover-client/dist/proof-worker.js) —
 * with key material asked of the page over the same kind of message bridge.
 */

type Ask =
  | { readonly op: 'lookupKey'; readonly askId: number; readonly keyLocation: string }
  | { readonly op: 'getParams'; readonly askId: number; readonly k: number };

type FromPage =
  | { readonly op: 'prove'; readonly preimage: Uint8Array; readonly overwriteBindingInput?: bigint }
  | { readonly op: 'check'; readonly preimage: Uint8Array }
  | { readonly op: 'answer'; readonly askId: number; readonly ok: boolean; readonly value?: unknown; readonly error?: string };

const pending = new Map<number, { resolve: (value: never) => void; reject: (e: Error) => void }>();
let nextAskId = 0;

const ask = <T>(payload: Omit<Ask, 'askId'>): Promise<T> => new Promise<T>((resolve, reject) => {
  const askId = nextAskId;
  nextAskId += 1;
  pending.set(askId, { resolve: resolve as (value: never) => void, reject });
  postMessage({ ...payload, askId });
});

/** Key material comes from the page — the page owns the provider (and its
 * cache), the worker owns nothing but compute. */
const keyMaterial = {
  lookupKey: (keyLocation: string) => ask<never>({ op: 'lookupKey', keyLocation } as Omit<Ask, 'askId'>),
  getParams: (k: number) => ask<never>({ op: 'getParams', k } as Omit<Ask, 'askId'>),
};

addEventListener('message', ({ data }: MessageEvent<FromPage>) => {
  if (data.op === 'answer') {
    const waiting = pending.get(data.askId);
    pending.delete(data.askId);
    if (!waiting) return;
    if (data.ok) waiting.resolve(data.value as never);
    else waiting.reject(new Error(data.error ?? 'the page could not supply key material'));
    return;
  }
  if (data.op === 'prove') {
    prove(data.preimage, keyMaterial, data.overwriteBindingInput)
      .then((value) => postMessage({ op: 'result', value }))
      .catch((e: unknown) => postMessage({
        op: 'failure', error: describeFailure(e),
      }));
    return;
  }
  if (data.op === 'check') {
    check(data.preimage, keyMaterial)
      .then((value) => postMessage({ op: 'result', value }))
      .catch((e: unknown) => postMessage({
        op: 'failure', error: describeFailure(e),
      }));
  }
});

/* THE HANDSHAKE — after the listener, and not a line before. */
postMessage({ op: 'ready' });
