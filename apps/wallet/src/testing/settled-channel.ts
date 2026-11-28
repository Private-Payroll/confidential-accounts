import { act } from '@testing-library/react';

/* Lets a test await the answer the screen posts rather than poll for it, so a loaded machine makes a test slower
 * and never makes it fail. */

export interface Posted {
  readonly message: unknown;
  readonly target: string;
}

export interface WatchedOpener {
  /** Everything the screen has posted back, in order. */
  readonly sent: Posted[];
  /** What the screen is handed as `window.opener`. */
  postMessage(message: unknown, target: string): void;
  /** Resolves once `nth` messages have been posted, at once when they already have been. */
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
      return new Promise<Posted>((resolve) => {
        waiting.push({ nth, resolve });
      });
    }
  };
}

/** The ready ping is the first message posted, so the answer is the second. */
export const THE_ANSWER = 2;

/** Awaits the answer's post, then flushes the render the screen makes after answering. Call it after the press.
 * The screen answers before it sets its own state, so the DOM read without the `act` would be one render early. */
export async function afterTheAnswer(opener: WatchedOpener, nth: number = THE_ANSWER): Promise<Posted> {
  const posted = await opener.posted(nth);
  await act(async () => {
    await Promise.resolve();
  });
  return posted;
}

/** Runs the event loop a fixed number of turns inside `act`, so already-resolved loads render; it times nothing out.
 * Used where a `waitFor` would be a poll with a deadline that a loaded machine can miss. */
export async function settled(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}
