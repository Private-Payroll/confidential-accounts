import { redactSecrets } from '../core/redact-secrets.js';
import { recordShownError } from './error-sink.js';

/**
 * **THE PLACE THAT TURNS AN ERROR INTO A SENTENCE ON A SCREEN ALSO RECORDS
 * IT.** `docs/NEXT.md` `X11` §5, `docs/how-money-can-be-lost.md` `C159`.
 *
 * ── ONE FUNCTION, AND THAT IS THE WHOLE DESIGN ───────────────────────────
 *
 * `X4` built the sink and `X10` gave refusals their reason, and on the first
 * walk after both, **the failure the founder actually hit reached neither
 * report.** `logs/REPORT-REFUSALS.txt` did not have it — it was thrown in the
 * browser, not refused by the service — and the sink did not have it either,
 * because the sink watches uncaught errors, unhandled rejections, `console`
 * calls and failed requests, **and this was none of them: the application
 * caught it and rendered it, which is correct.**
 *
 * So the one class of failure that by definition reaches a human was the one
 * class no artefact kept. The fix is not another watcher. It is that **showing
 * and keeping become the same act**: every `catch` in this application ends
 * here, and this both returns the sentence for the screen and puts it in the
 * report. Two habits can drift apart; one function cannot.
 *
 * ── THROUGH `redactSecrets`, LIKE EVERYTHING ELSE THAT REACHES DISK ──────
 *
 * An error message can carry anything — a key, a seed, a
 * session token, a company address, a password typed into the wrong field. It
 * is redacted HERE, before it crosses the wire, and again in the service before
 * it reaches the disk, which is the same two-layer arrangement the sink already
 * has and for the same reason.
 *
 * **THE SCREEN IS SHOWN THE REDACTED SENTENCE TOO, AND THAT IS DELIBERATE.**
 * The alternative is a person reading one thing and the report keeping another,
 * which is the exact confusion an instrument exists to remove — and a secret is
 * no safer on a screen somebody is about to photograph than in a file. It costs
 * a hex string in a message becoming `<redacted:hex>` for a person who was
 * probably not going to read it anyway.
 *
 * ── IT NEVER THROWS, BECAUSE OF WHERE IT IS CALLED FROM ──────────────────
 *
 * Every caller is inside a `catch`. A failure here would replace a screen that
 * was about to explain a problem with a blank one, which is worse than the
 * problem. `recordShownError` swallows its own failures for the same reason,
 * and this adds the second half: whatever arrives, a sentence comes back.
 */

/** The last resort, for a thrown value that is not an error and not a string. */
const UNKNOWN = 'something went wrong, and whatever failed did not say what.';

/**
 * **THE SENTENCE A PERSON READS, AND THE LINE THE REPORT KEEPS.**
 *
 * `where` is a short label naming the journey — *accepting an invitation*,
 * *signing in* — because a report full of sentences with no context is a report
 * that says what went wrong and not what somebody was doing. It is not shown to
 * the person; the sentence they read is the one the failure wrote.
 */
export function shownError(failure: unknown, where: string): string {
  let sentence: string;
  let stack: string | undefined;
  try {
    if (typeof failure === 'string') {
      sentence = failure;
    } else if (failure instanceof Error) {
      sentence = failure.message || `${failure.name}`;
      stack = failure.stack;
    } else if (failure && typeof (failure as { message?: unknown }).message === 'string') {
      sentence = String((failure as { message: string }).message);
    } else {
      sentence = UNKNOWN;
    }
    if (sentence.trim() === '') sentence = UNKNOWN;
    sentence = redactSecrets(sentence);
  } catch {
    sentence = UNKNOWN;
    stack = undefined;
  }
  recordShownError(`${where}: ${sentence}`, stack === undefined ? undefined : redactSecrets(stack));
  return sentence;
}
