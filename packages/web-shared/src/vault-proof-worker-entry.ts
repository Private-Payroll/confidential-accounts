/**
 * **ONE PROOF AT A TIME, ON A THREAD OF ITS OWN**, started by the vault worker
 * so that the proofs one transaction needs run side by side instead of one
 * after another on the vault worker's single thread.
 *
 * It does exactly what the vault worker's in-thread prover does for one proof -
 * `check` or `prove` from `@midnight-ntwrk/zkir-v2` - and nothing else. The
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

/* The material comes from the vault worker, which owns the source and its cache; this thread owns nothing but the compute. */
const material = {
  lookupKey: (keyLocation: string) => ask({ op: 'lookupKey', keyLocation }),
  getParams: (k: number) => ask({ op: 'getParams', k }),
};

const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

self.addEventListener('message', ({ data }) => {
  if (data.op === 'answer') {
    const w = waiting.get(data.askId);
    waiting.delete(data.askId);
    if (w === undefined) return;
    if (data.ok) w.resolve(data.value as never);
    else {
      w.reject(new Error(
        'This device could not load what it needs to work out the proof for this transaction, so nothing was sent. '
        + 'Check your connection and try again.',
        { cause: new Error(data.error ?? 'the vault worker could not supply the proving material') }));
    }
    return;
  }
  const work = data.op === 'prove'
    ? prove(data.preimage, material as never, data.overwriteBindingInput)
    : check(data.preimage, material as never);
  work.then(
    (value) => self.postMessage({ op: 'result', value }),
    (e: unknown) => self.postMessage({ op: 'failure', error: failure(e) }),
  );
});

/* THE HANDSHAKE: after the listener, and not a line before. */
self.postMessage({ op: 'ready' });
