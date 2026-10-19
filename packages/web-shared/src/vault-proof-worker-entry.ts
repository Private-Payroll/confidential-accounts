/**
 * **ONE PROOF AT A TIME, ON A THREAD OF ITS OWN**, started by the vault worker
 * so that the proofs one transaction needs run side by side instead of one
 * after another on the vault worker's single thread.
 *
 * It does exactly what the vault worker's in-thread prover does for one proof -
 * `check` or `prove` from `@midnight-ntwrk/zkir-v2` - and nothing else but
 * keep what it is handed for the next time it is asked. The
 * proving material is asked of the vault worker over messages, so the vault
 * worker's own source, its cache and its checks stay the only way material
 * reaches a proof.
 *
 * **IT SAYS `ready` ONLY AFTER ITS LISTENER STANDS.** A module worker drops
 * what is posted to it while it is still loading, and this one loads the
 * prover's WebAssembly first; the vault worker posts nothing before it hears
 * `ready`.
 */
import { check, prove } from '@midnight-ntwrk/zkir-v2';

type FromTheVaultWorker =
  | { readonly op: 'prove'; readonly preimage: Uint8Array; readonly overwriteBindingInput?: bigint }
  | { readonly op: 'check'; readonly preimage: Uint8Array }
  | { readonly op: 'answer'; readonly askId: number; readonly ok: boolean; readonly value?: unknown; readonly error?: string };

declare const self: {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: FromTheVaultWorker }) => void): void;
};

const waiting = new Map<number, { resolve: (value: never) => void; reject: (e: Error) => void }>();
let nextAskId = 0;

const ask = (payload: { op: 'lookupKey'; keyLocation: string } | { op: 'getParams'; k: number }): Promise<never> =>
  new Promise<never>((resolve, reject) => {
    const askId = nextAskId;
    nextAskId += 1;
    waiting.set(askId, { resolve, reject });
    self.postMessage({ ...payload, askId });
  });

/*
 * **ASKED ONCE PER THREAD, AND THE REASON KEPT WHEN IT IS REFUSED.** The prover
 * asks for the same location's material, and the same parameters, more than
 * once in one proof, and every answer crosses from the vault worker as a copy of
 * tens of megabytes; so the first answer for each is kept for this thread's
 * life, which ends soon after its last proof. A refused ask is not kept, so the
 * next proof asks again. The prover's own failure does not carry the reason the
 * vault worker gave, so that reason is what this thread reports: the circuit
 * the chain holds is not this build's, the service sent other bytes, or the
 * download did not arrive.
 */
const asked = new Map<string, Promise<never>>();
let refusedBecause: string | null = null;

const once = (key: string, payload: { op: 'lookupKey'; keyLocation: string } | { op: 'getParams'; k: number }): Promise<never> => {
  const held = asked.get(key);
  if (held !== undefined) return held;
  const answer = ask(payload);
  asked.set(key, answer);
  answer.catch(() => { if (asked.get(key) === answer) asked.delete(key); });
  return answer;
};

/* The material comes from the vault worker, which owns the source, its checks and its cache; this thread owns nothing but the compute. */
const material = {
  lookupKey: (keyLocation: string) => once(`key ${keyLocation}`, { op: 'lookupKey', keyLocation }),
  getParams: (k: number) => once(`params ${k}`, { op: 'getParams', k }),
};

const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

self.addEventListener('message', ({ data }) => {
  if (data.op === 'answer') {
    const w = waiting.get(data.askId);
    waiting.delete(data.askId);
    if (w === undefined) return;
    if (data.ok) w.resolve(data.value as never);
    else {
      const because = data.error ?? 'the vault worker could not supply the proving material';
      refusedBecause ??= because;
      w.reject(new Error(because));
    }
    return;
  }
  refusedBecause = null;
  const work = data.op === 'prove'
    ? prove(data.preimage, material as never, data.overwriteBindingInput)
    : check(data.preimage, material as never);
  work.then(
    (value) => self.postMessage({ op: 'result', value }),
    (e: unknown) => self.postMessage({ op: 'failure', error: refusedBecause ?? failure(e) }),
  );
});

/* THE HANDSHAKE: after the listener, and not a line before. */
self.postMessage({ op: 'ready' });
