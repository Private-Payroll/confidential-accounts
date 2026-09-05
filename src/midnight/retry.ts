/**
 * Retrying a submission, in one place.
 *
 * This existed twice — once in `deploy-preview.ts` and once in
 * `run-preview.ts` — which made it the eighth instance in this project of one
 * rule written in two files. The others cost real runs: M-50, M-55, M-58,
 * M-61, M-65 were each a fix applied to one copy and not the other.
 *
 * It is worth having at all because of M-23, which is not a flake and does not
 * go away by wishing:
 *
 *     submitAndWatchExtrinsic ... disconnected: 1000 Normal Closure
 *
 * The node's websocket closes cleanly a few seconds after the wallet connects,
 * on preview and on Stagenet alike. A submission landing in that gap fails with
 * "Transaction submission error" and nothing else — no rejection code, because
 * the chain never saw it. A dropped socket deserves a retry; it does not
 * deserve a failed run and a re-sync.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** How many total attempts. Four is what the deploy has used successfully. */
  attempts?: number;
  /** Backoff base in ms; attempt N waits `base * N`. */
  baseDelayMs?: number;
  /**
   * Told about each failure, so a script can print it in its own style.
   *
   * Silence here is how a run that took four attempts reads as a run that took
   * one, which matters when the question is whether the network is degrading.
   */
  onRetry?: (info: { label: string; attempt: number; of: number; waitMs: number; error: unknown }) => void;
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 5000;

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt === attempts) break;
      const waitMs = base * attempt;
      options.onRetry?.({ label, attempt, of: attempts, waitMs, error });
      await sleep(waitMs);
    }
  }
  throw last;
}
