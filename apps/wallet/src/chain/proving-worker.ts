import { zkirEngineFor } from '../../../../src/midnight/wasm-proving.js';
import { describeFailure } from '../lib/failure-text.js';

/**
 * THE PROVING WORKER: one proof at a time, for the page or the wallet's account
 * builder that started it. It says `ready` only after its listener stands, and
 * whoever started it posts nothing before it hears that, because a message
 * posted to a module worker while its WebAssembly is still loading is dropped.
 * Each proof names its key's location, and is proved by the engine that
 * location calls for (`zkirEngineFor`: zkir-v3 for a contract's circuit, zkir-v2
 * for one of the network's own keys); a location that names neither is refused
 * before anything is proved. Key material is asked of the thread that started
 * it over a message bridge.
 */

type Ask =
  | { readonly op: 'lookupKey'; readonly askId: number; readonly keyLocation: string }
  | { readonly op: 'getParams'; readonly askId: number; readonly k: number };

type FromPage =
  | {
      readonly op: 'prove';
      readonly keyLocation: string;
      readonly preimage: Uint8Array;
      readonly overwriteBindingInput?: bigint;
    }
  | { readonly op: 'check'; readonly keyLocation: string; readonly preimage: Uint8Array }
  | {
      readonly op: 'answer';
      readonly askId: number;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: string;
    };

const pending = new Map<number, { resolve: (value: never) => void; reject: (e: Error) => void }>();
let nextAskId = 0;

const ask = <T>(payload: Omit<Ask, 'askId'>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const askId = nextAskId;
    nextAskId += 1;
    pending.set(askId, { resolve: resolve as (value: never) => void, reject });
    postMessage({ ...payload, askId });
  });

/** Key material comes from the thread that started this worker (the page, or
 * the wallet's account builder): it owns the provider and its cache, and moves
 * each answer here rather than copying it. The worker owns nothing but compute,
 * and holds a key only for the proof that asked for it. */
const keyMaterial = {
  lookupKey: (keyLocation: string) => ask<never>({ op: 'lookupKey', keyLocation } as Omit<Ask, 'askId'>),
  getParams: (k: number) => ask<never>({ op: 'getParams', k } as Omit<Ask, 'askId'>)
};

addEventListener('message', ({ data }: MessageEvent<FromPage>) => {
  if (data.op === 'answer') {
    const waiting = pending.get(data.askId);
    pending.delete(data.askId);
    if (!waiting) return;
    if (data.ok) waiting.resolve(data.value as never);
    else waiting.reject(new Error(data.error ?? 'no key material was supplied for this proof'));
    return;
  }
  const work = zkirEngineFor(data.keyLocation).then((engine): Promise<Uint8Array | (bigint | undefined)[]> => {
    const prover = engine.provingProvider(keyMaterial);
    return data.op === 'prove'
      ? prover.prove(data.preimage, data.keyLocation, data.overwriteBindingInput)
      : prover.check(data.preimage, data.keyLocation);
  });
  work
    .then((value) => postMessage({ op: 'result', value }))
    .catch((e: unknown) =>
      postMessage({
        op: 'failure',
        error: describeFailure(e)
      })
    );
});

/* THE HANDSHAKE — after the listener, and not a line before. */
postMessage({ op: 'ready' });
