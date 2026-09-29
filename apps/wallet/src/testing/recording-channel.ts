import type { Channel, ProgressStage } from 'midnight-identity/profile/channel';

/**
 * **A CHANNEL THAT KEEPS WHAT A SCREEN SENT, AND KEEPS THE ONE RULE THE REAL
 * ONE KEEPS: ONE TERMINAL MESSAGE.** `answers` holds each terminal message that
 * went, in the shape the screen tests have always read (`{ refused, why }` for a
 * refusal); a terminal message after the first is refused exactly as the real
 * channel refuses it, and counted in `dropped`. `progress` holds every stage the
 * screen said, whether or not a page would have heard it.
 */
export function recordingChannel(
  answers: unknown[], progress: ProgressStage[] = [], dropped: unknown[] = [],
): Channel {
  let ended = false;
  const end = (message: unknown): boolean => {
    if (ended) { dropped.push(message); return false; }
    ended = true;
    answers.push(message);
    return true;
  };
  return {
    answer: (a) => end(a),
    refuse: ((r: string, why?: string) => end(why === undefined ? { refused: r } : { refused: r, why })) as Channel['refuse'],
    progress: (stage) => { if (ended) return false; progress.push(stage); return true; },
    over: () => ended,
    stop: () => {},
  };
}
