import { act } from '@testing-library/react';

/**
 * **A WAY FOR A TEST TO AWAIT THE ANSWER RATHER THAN POLL FOR IT.** A flake,
 * reopened.
 *
 * ── THE FAILURE THIS EXISTS FOR, AND WHY A BIGGER NUMBER DID NOT FIX IT ───
 *
 * Twice on a real machine: **2 failed, 1,091 passed**, both
 * `Error: waiting`, both at about **5,014 milliseconds** — one tick past the
 * budget had just been raised from 1,000ms to 5,000ms — and **the failing test
 * NAMES CHANGED between the two runs**, in the same two files. That is a race,
 * not a regression: both files run alone and together give 36
 * passed in 705ms and 1.4s. They fail only inside the full 64-file parallel
 * run, on a loaded machine.
 *
 * **RAISING THE NUMBER WAS NOT A FIX, IT WAS A DELAY.** A budget can always be
 * defeated by a busier machine, and the row's own warning is what nearly
 * happened: *a project whose people learn that red means run it again has no
 * suite at all*, because the next failure is real and is dismissed in the same
 * breath.
 *
 * ── WHAT WAS ACTUALLY BEING WAITED FOR, IN BOTH FAILURES ──────────────────
 *
 * `waitFor(() => { if (sent.length < 2) throw new Error('waiting') })` and its
 * twin, a wait for the heading that appears after a press. **Both are waiting
 * for the same thing: a real Schnorr signature over the ledger's own code.**
 * That is the one genuinely CPU-hungry step in either file, and it is the step
 * that loses a race for a core when sixty other files are running. Every other
 * wait in these files is for markup that is already in hand a microtask later.
 *
 * **SO THE ANSWER IS AWAITED INSTEAD.** `postMessage` is what the screen calls
 * when the answer crosses, so `postMessage` is what resolves the promise. There
 * is no interval, no budget and nothing to lose a race to: a busier machine
 * makes it slower and cannot make it fail. The test's own `testTimeout` is
 * still there, so a signature that never arrives is still a failing test rather
 * than a suite that hangs.
 *
 * ── WHY NOT BOUND THE PARALLELISM INSTEAD ─────────────────────────────────
 *
 * That was the other option and it is another number: *how many files may run
 * at once* is a value that a machine busy with something else — a build, a
 * browser, another suite — defeats exactly as it defeated the wait budget. It
 * would also slow every run in the project to fix two waits in two files.
 * **The race is removed here rather than made less likely.**
 */

export interface Posted {
  readonly message: unknown;
  readonly target: string;
}

export interface WatchedOpener {
  /** Everything the screen has posted back, in order. */
  readonly sent: Posted[];
  /** What the screen is handed as `window.opener`. */
  postMessage(message: unknown, target: string): void;
  /**
   * Resolves once `nth` messages have been posted — **resolved by the post
   * itself.** Already there is answered immediately; a test that calls this
   * after the fact does not hang.
   */
  posted(nth: number): Promise<Posted>;
}

export function watchedOpener(): WatchedOpener {
  const sent: Posted[] = [];
  const waiting: { nth: number; resolve: (p: Posted) => void }[] = [];
  return {
    sent,
    postMessage(message: unknown, target: string): void {
      sent.push({ message, target });
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        const w = waiting[i]!;
        if (sent.length >= w.nth) {
          waiting.splice(i, 1);
          w.resolve(sent[w.nth - 1]!);
        }
      }
    },
    posted(nth: number): Promise<Posted> {
      const already = sent[nth - 1];
      if (already) return Promise.resolve(already);
      return new Promise<Posted>((resolve) => { waiting.push({ nth, resolve }); });
    },
  };
}

/**
 * **THE READY PING IS THE FIRST THING POSTED, SO THE ANSWER IS THE SECOND.**
 * `channel.ts` posts `{ schema: READY_PING }` the moment it starts listening,
 * before anything has been asked. Counting from there is what `sent.length < 2`
 * was doing, spelled once.
 */
export const THE_ANSWER = 2;

/**
 * **CALL IT AFTER THE PRESS, AND AWAIT IT.**
 *
 *     fireEvent.click(screen.getByText(signInTo()));
 *     await answered();          // the answer has crossed AND the screen knows
 *
 * Two things, and both are needed. The first is the answer itself, resolved by
 * the `postMessage` that carries it. The second is `act`, because the screen
 * answers BEFORE it sets its own state — `channel.answer(response)` comes
 * first in `approve.tsx` and `setSentAt` after it — so a test that read the
 * DOM on the next line would be reading it one render early. **That is not a
 * poll: `act` flushes work that is already queued and returns.**
 */
export async function afterTheAnswer(
  opener: WatchedOpener, nth: number = THE_ANSWER,
): Promise<Posted> {
  const posted = await opener.posted(nth);
  await act(async () => { await Promise.resolve(); });
  return posted;
}

/**
 * **A FIXED NUMBER OF TURNS OF THE LOOP, WHICH IS NOT A WAIT.**
 *
 * `approve.tsx` reads the profile in an effect: `load(port, identity)` against
 * an in-memory store, so what a test is waiting for is not work that might take
 * a while — **it is a promise that has already resolved, needing the loop to
 * come round and React to render.** A `waitFor` there is a poll with a
 * deadline, and a deadline is the thing this is about.
 *
 * So this checks nothing and can time nothing out. It runs the loop a fixed
 * number of times inside `act`, so a loaded machine changes how LONG it takes
 * and never WHETHER it passes. If the screen genuinely stops rendering what a
 * test expects, the test fails on every machine rather than on one in ten —
 * which is the difference between a defect and a habit.
 */
export async function settled(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
}
