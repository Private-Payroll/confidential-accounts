// Pure rules the probe driver reports by. Plain JS with no imports so both
// the probe driver and a test under `src/` can load it — the
// driver itself has never had a test, and this is what that costs.

/**
 * WHAT A RUN IS CALLED.
 *
 * `FAILED` in every other run means something went wrong. The killed-tab
 * run closes its own tab ON PURPOSE, so calling that failure teaches a
 * reader to stop believing verdicts, which is the disease in the one place this
 * project can least afford it.
 *
 * `killed` wins over everything except a viewing key on the wire, because a
 * run that ended where it meant to is not an unfinished run — and the page
 * it was reading from is gone, so `done` will always be false.
 */
export function verdictFor({ killed = false, done = false, pageVerdict = null } = {}) {
  if (killed) return 'ABANDONED-BY-DESIGN';
  if (done && pageVerdict) return pageVerdict;
  return 'FAILED';
}

/** The exit code that verdict deserves. An abandoned-by-design run
 * succeeded, so it exits 0; a wallet that leaked a viewing key never does.
 *
 * The parameter is spelled without the indexer's field name in it, and that is
 * deliberate rather than terse: the source scan that guards this rule matches
 * on the field's spelling, so an identifier carrying it here would be an
 * offender in a file that only reports the answer and never looks for it. The
 * one place that spells it is `scripts/viewing-key-tripwire.mjs`. */
export function exitCodeFor(verdict, keyOnTheWire = false) {
  if (keyOnTheWire) return 1;
  if (verdict === 'FULL' || verdict === 'ABANDONED-BY-DESIGN') return 0;
  if (verdict === 'FAILED') return 1;
  return 2;
}

/**
 * THE SENTENCE ABOUT NOT FINISHING, WHICH MAY ONLY BE SAID WHEN IT IS TRUE.
 *
 * It used to print whenever the page had not finished, quoting the whole
 * leash however long the driver had actually waited. The killed-tab run
 * ended in 189 seconds and told its reader it had waited 2,700,000ms; the
 * reader read that sentence as forty-five minutes,
 * and the two report timestamps on disk say three minutes. A report that
 * misdescribes its own run is worse than one that says nothing.
 *
 * Returns null when there is nothing truthful to say.
 */
export function unfinishedSentence({
  killed = false, done = false, waitedMs = 0, leashMs = 0, progress = null,
} = {}) {
  if (killed || done) return null;
  const latest = progress ?? 'nothing';
  if (waitedMs >= leashMs) {
    return `The probe did not finish within ${leashMs}ms (waited ${waitedMs}ms); latest: ${latest}`;
  }
  return `The probe stopped before finishing, after ${waitedMs}ms — NOT a timeout `
    + `(the leash is ${leashMs}ms); latest: ${latest}`;
}

/**
 * HOW MANY CLEAN RUNS BEFORE "every run found it" IS WORTH PRINTING.
 *
 * **Ten, and the number is a floor for the claim rather than a proof of it.**
 * Three reasons, written down because a threshold nobody can justify is the
 * same defect one layer along:
 *
 * 1. **Ten is where the sentence stops being absurd, not where it becomes
 *    strong.** By the rule of three, ten runs that all found the transaction
 *    put a 95% upper bound of roughly 26% on the rate of runs that would not
 *    have. That is a weak statement, and it is meant to be read as one: no
 *    number of healthy samples bounds a tail. What ten buys is that the worst
 *    figure came from ten independent runs instead of one.
 * 2. **It has to be reachable by a person.** Each run is a real payment on
 *    stagenet — a real fee, four to five minutes, and up to four more waiting
 *    on the lag. Ten is an afternoon. Thirty is a threshold nobody would ever
 *    cross, and an unreachable threshold means the flag says `NO` for ever,
 *    which teaches people to ignore it.
 * 3. **Ten runs are spread across sittings**, so they sample more than one
 *    state of the indexer. One run samples one moment.
 *
 * **What the flag is for, said plainly: stopping one number from reading as a
 * conclusion.** It does not certify the margin. The margin's real defence is
 * headroom — 300,000ms against a measured 1,345ms — and the regime that would
 * actually threaten it (an indexer down for minutes) is one that more samples
 * of a healthy indexer will never reveal.
 */
export const LAG_BOUND_MIN_RUNS = 10;

/**
 * THE WORST INDEXER LAG SEEN, and the reason it is a function.
 *
 * `TTL_SETTLE_MARGIN_MS` has to be set from a BOUND, and there are TWO ways a
 * history can fail to be one. A run in which the indexer never showed the
 * transaction is not a bound: it is a lag longer than that run waited — that
 * was guarded. **And too few runs is not a bound either**, which was
 * not: the flag reported `yes` on a sample of ONE, because it asked "did any
 * run fail to find it?" and answered "is this enough runs to say?".
 * Both conditions are now required, and the answer carries its sample size.
 */
export function worstLag(history = [], minRuns = LAG_BOUND_MIN_RUNS) {
  const found = history.filter((h) => typeof h?.foundAfterMs === 'number');
  const neverFound = history.length - found.length;
  const allFound = history.length > 0 && neverFound === 0;
  const enoughRuns = history.length >= minRuns;
  return {
    runs: history.length,
    found: found.length,
    neverFound,
    worstFoundMs: found.length ? found.reduce((a, h) => Math.max(a, h.foundAfterMs), 0) : null,
    minRuns,
    allFound,
    enoughRuns,
    isBound: allFound && enoughRuns,
  };
}

/**
 * THE LINE A PERSON ACTUALLY READS — and therefore the line under test.
 *
 * It was a summary sentence claiming more than the numbers printed
 * directly above it, which is the sixth time in this project a summary has
 * done that. So the sentence lives here, beside the rule, where a test can
 * hold it: a `yes` must name how many runs it came from, and a `NO` must say
 * which condition is missing rather than leaving a reader to work it out.
 */
export function boundSentence(seen) {
  if (seen.isBound) {
    return `yes — ${seen.found} of ${seen.runs} runs found it (minimum ${seen.minRuns}), `
      + `worst ${seen.worstFoundMs}ms`;
  }
  if (!seen.allFound) {
    return `NO — ${seen.neverFound} of ${seen.runs} run(s) never found it, so the true `
      + 'worst is longer than those runs waited and is unknown';
  }
  return `NO — only ${seen.runs} run(s) recorded and all found it; ${seen.minRuns} are `
    + 'needed before "every run found it" says anything about a worst case';
}
