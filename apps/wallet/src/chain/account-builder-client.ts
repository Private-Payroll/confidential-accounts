import type { AccountBuilderAnswer, AccountBuilderAsk } from './account-builder.js';

/**
 * THE WALLET'S WAY TO ITS OWN ACCOUNT BUILDER: one ask at a time to the worker
 * that builds and proves a company account's calls (`account-builder-worker.ts`),
 * each answered by its own id.
 *
 * What it trusts: the worker, which is this wallet's own code started from its
 * own origin. It hands the worker only what the action already holds, and
 * hands back only what the worker built. A worker that reports a failure is
 * answered as a thrown error carrying the worker's own words; one that never
 * answers is ended, and its asks refused, rather than waited on.
 */

/** Asks of the builder, without the id the client gives each. */
export type AskOfTheBuilder = AccountBuilderAsk extends infer A ? A extends { readonly id: number } ? Omit<A, 'id'> : never : never;

/** The builder's answer to an ask of kind `K`. */
export type AnswerTo<K> = Extract<AccountBuilderAnswer, { ok: true }> extends infer X
  ? X extends { readonly ask: infer Q } ? K extends Q ? X : never : never : never;

/** What an action calls to have the builder build one thing. */
export type AccountBuilding = <A extends AskOfTheBuilder>(ask: A) => Promise<AnswerTo<A['ask']>>;

/** The part of a worker this needs. */
export interface BuilderWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: { message?: string }) => void): void;
  terminate?(): void;
}

/**
 * How long the builder has to say it is listening. It loads the contract's code
 * and the ledger before it can, which takes about a second; a builder silent this
 * long never started.
 */
export const BUILDER_STARTS_WITHIN_MS = 60_000;

/**
 * How long the builder has to answer an ask that proves nothing: the account's
 * deploy, its second step, both carried again, and where the pay-record key
 * stands. Each is built in about a second; one unanswered this long never will be.
 * An ask that proves is bounded by the prover's own ceiling for each proof.
 */
export const BUILDER_ANSWERS_WITHIN_MS = 2 * 60_000;

/** The asks that prove nothing, and so are answered within `BUILDER_ANSWERS_WITHIN_MS`. */
const PROVES_NOTHING: ReadonlySet<string> = new Set(['account-deploy', 'finished-creation', 'creation-again', 'pay-key-standing']);

const seconds = (ms: number): number => Math.round(ms / 1000);

/**
 * One builder, started once, asked in turn. An ask is posted only once the
 * builder has said it is listening: a worker drops a message that arrives while
 * its code is still loading, and the ask would then wait for an answer that never
 * comes. A builder that fails to load, fails to read what it was sent, does not
 * start, or does not answer in time ends every ask waiting on it with an error
 * that says so, and the next ask starts a new one.
 * `spawn` is replaceable so a test can answer with the builder itself.
 */
export function accountBuilding(
  spawn: () => BuilderWorkerLike = startTheWorker,
  limits: { readonly startsWithinMs: number; readonly answersWithinMs: number } = {
    startsWithinMs: BUILDER_STARTS_WITHIN_MS, answersWithinMs: BUILDER_ANSWERS_WITHIN_MS,
  },
): AccountBuilding {
  interface Started { readonly worker: BuilderWorkerLike; readonly ready: Promise<void> }
  let started: Started | null = null;
  let next = 1;
  const waiting = new Map<number, { resolve: (answer: AccountBuilderAnswer) => void; reject: (e: Error) => void }>();

  /* Ends this builder: every ask waiting on it is refused with `why`, and the next ask starts another. */
  const giveUp = (of: Started | null, why: string): void => {
    if (of === null || started !== of) return;
    started = null;
    try { of.worker.terminate?.(); } catch { /* already gone */ }
    for (const [id, w] of [...waiting]) {
      waiting.delete(id);
      w.reject(new Error(why));
    }
  };

  const theWorker = (): Started => {
    if (started !== null) return started;
    const worker = spawn();
    let listening!: () => void;
    let notListening!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { listening = resolve; notListening = reject; });
    ready.catch(() => { /* each ask awaits it and is told */ });
    const self: Started = { worker, ready };
    const fail = (why: string): void => {
      clearTimeout(startTimer);
      notListening(new Error(why));
      giveUp(self, why);
    };
    const startTimer = setTimeout(() => fail(`the wallet's account builder did not start within ${seconds(limits.startsWithinMs)} seconds, `
      + 'so nothing was built or sent. Close this window and press again.'), limits.startsWithinMs);
    worker.addEventListener('message', ({ data }) => {
      if (typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === 'account-builder-ready') {
        clearTimeout(startTimer);
        listening();
        return;
      }
      const answer = data as AccountBuilderAnswer | null;
      if (typeof answer !== 'object' || answer === null || typeof (answer as { id?: unknown }).id !== 'number' || !('ok' in answer)) return;
      const done = waiting.get(answer.id);
      if (done === undefined) return;
      waiting.delete(answer.id);
      done.resolve(answer);
    });
    worker.addEventListener('error', (event) => fail(`the wallet's account builder stopped (${event.message || 'it failed to load'}), `
      + 'so nothing was built or sent. Close this window and press again.'));
    worker.addEventListener('messageerror', () => fail('the wallet\'s account builder could not read what it was sent, '
      + 'so nothing was built or sent. Close this window and press again.'));
    started = self;
    return self;
  };

  return (async (ask: AskOfTheBuilder) => {
    const id = next;
    next += 1;
    const builder = theWorker();
    await builder.ready;
    const answer = await new Promise<AccountBuilderAnswer>((resolve, reject) => {
      const deadline = PROVES_NOTHING.has(ask.ask)
        ? setTimeout(() => giveUp(builder, `the wallet's account builder did not answer within ${seconds(limits.answersWithinMs)} seconds, `
          + 'so nothing was built or sent. Close this window and press again.'), limits.answersWithinMs)
        : null;
      const settled = (): void => { if (deadline !== null) clearTimeout(deadline); };
      waiting.set(id, { resolve: (a) => { settled(); resolve(a); }, reject: (e) => { settled(); reject(e); } });
      builder.worker.postMessage({ ...ask, id });
    });
    if (!answer.ok) throw new Error(answer.error);
    if (answer.ask !== ask.ask) throw new Error('the wallet\'s account builder answered another ask than the one it was given.');
    return answer;
  }) as AccountBuilding;
}

const startTheWorker = (): BuilderWorkerLike =>
  new Worker(new URL('./account-builder-worker.ts', import.meta.url), { type: 'module' }) as unknown as BuilderWorkerLike;
