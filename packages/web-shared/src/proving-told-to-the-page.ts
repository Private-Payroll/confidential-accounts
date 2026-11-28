/**
 * **WHAT THE VAULT WORKER TELLS THE PAGE ABOUT ITS PROVING WORK.** Each fetch of proving material and each proof
 * is told to the page as it starts and as it ends, so the page can time it and show it; a refusal of proving
 * material the prover passed on only as text is matched back to the refusal it carries.
 */
import { ProvingMaterialRefused, type ArtefactSource } from './key-material.js';
import { whyItFailed } from './why-it-failed.js';
import type { VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** Posts a word to the page; a word that cannot be posted is dropped, since a word is never an answer. */
export const toldThePage = (scope: { postMessage(m: unknown): void }, word: unknown): void => {
  try {
    scope.postMessage(word);
  } catch {
    /* the next word or the answer still reaches the page */
  }
};

/**
 * **THE REFUSALS OF PROVING MATERIAL THIS WORKER SAW**, newest last, each with
 * the number it was seen at. The prover runs its key fetches inside the
 * WebAssembly, which hands a refusal back to the proof as text only, so a proof
 * that failed is matched to the refusal it carries by that refusal's whole
 * message (`provingToldOf`). Only the most recent are kept.
 */
const refusals: Array<{ readonly seen: number; readonly refusal: ProvingMaterialRefused }> = [];
let refusalsSeen = 0;
const KEPT_REFUSALS = 32;
const refusedLately = (refusal: ProvingMaterialRefused): void => {
  refusalsSeen += 1;
  refusals.push({ seen: refusalsSeen, refusal });
  if (refusals.length > KEPT_REFUSALS) refusals.shift();
};
/** The refusal seen since `since` whose whole message, its final full stop aside, is in the text of `e`, or null. */
const refusalCarriedBy = (e: unknown, since: number): ProvingMaterialRefused | null => {
  if (e instanceof ProvingMaterialRefused) return null;
  const text = `${typeof e === 'string' ? e : ''} ${whyItFailed(e)}`;
  for (let i = refusals.length - 1; i >= 0; i -= 1) {
    const { seen, refusal } = refusals[i]!;
    /* The prover's own check passes a refusal on without its final full stop; the rest of the sentence must be there whole. */
    const whole = refusal.message.trim().replace(/\.$/u, '').trimEnd();
    if (seen > since && whole.length > 0 && text.includes(whole)) return refusal;
  }
  return null;
};

/**
 * **A SOURCE OF PROVING MATERIAL THAT SAYS WHEN IT IS WORKING**: `word` is
 * called once as each fetch of a key, a file or the parameters starts and once
 * as it ends, refused or not. The page's time limit restarts at each word.
 */
export const toldOfEachCall = (source: ArtefactSource, word: () => void): ArtefactSource => {
  const told = async <T>(work: () => Promise<T>): Promise<T> => {
    word();
    try {
      return await work();
    } catch (e) {
      if (e instanceof ProvingMaterialRefused) refusedLately(e);
      throw e;
    } finally {
      word();
    }
  };
  return {
    lookupKey: (keyLocation) => told(() => source.lookupKey(keyLocation)),
    getParams: (k) => told(() => source.getParams(k)),
    artefact: (kind, keyLocation) => told(() => source.artefact(kind, keyLocation))
  };
};

/**
 * What one ask is built with: `deps`, with each proof told to the page as it
 * starts and as it ends, under the ask's own id. Asks run at the same time in
 * this worker, so each ask carries its own. A proof that fails carrying the
 * whole message of a refusal of proving material seen while it ran fails as
 * that refusal.
 */
export const provingToldOf =
  (
    deps: () => Promise<WorkerDeps>,
    ask: Pick<VaultAsk, 'id' | 'ask'>,
    say: (word: unknown) => void
  ): (() => Promise<WorkerDeps>) =>
  () =>
    deps().then((d) => ({
      ...d,
      prove: async (unproven: any, circuit?: string) => {
        const word = (state: 'started' | 'ended') =>
          say({ kind: 'vault-proof', id: ask.id, ask: ask.ask, circuit: circuit ?? null, state });
        const since = refusalsSeen;
        word('started');
        try {
          return await d.prove(unproven, circuit);
        } catch (e) {
          /* A refusal the prover passed on as text is answered as that refusal, with its kind, and what the prover said beneath it. */
          const refused = refusalCarriedBy(e, since);
          if (refused === null) throw e;
          const again = new ProvingMaterialRefused(refused.kind, refused.keyLocation, refused.message);
          Object.defineProperty(again, 'cause', { value: e, enumerable: false, writable: true, configurable: true });
          throw again;
        } finally {
          word('ended');
        }
      }
    }));
