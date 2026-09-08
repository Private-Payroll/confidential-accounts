/**
 * **WHY THE SERVICE REFUSED, ON DISK, AFTER THE WINDOW IS CLOSED.**
 *
 * ── THE ROW THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `wrap` in `index.ts` answered every thrown error with `400` and the message
 * in a body, **and logged nothing anywhere.** The browser sink recorded the
 * status and the path and not the body. So on 24 Aug one walk produced ten
 * `400 GET …/state` and three `400 POST /api/accounts`, and **two entirely
 * unrelated failures — a policy check refusing a second company, and a viewing
 * key that could not open a record sealed under an older derivation — were the
 * same event in every artefact this project keeps.** Telling them apart took
 * reading two source files.
 *
 * Every defect since `X2` has been found by starting the thing and looking.
 * **The looking is the slow part, and this is the one avoidable reason.**
 *
 * ── WHAT A LINE CARRIES, AND WHY THE CLASS NAME IS ON IT ─────────────────
 *
 * The method, the path, the status, **the error's constructor name**, and the
 * reason. The class name is the half that would have answered 24 Aug on its
 * own: `NoCompanyAddress` and `ZodError` and a bare `Error` from a policy check
 * are three different mornings, and `400` is none of them. Nothing here is a
 * new refusal — every one of these messages was already being thrown and
 * already being sent to the browser. They were simply not being kept.
 *
 * ── IT REDACTS, AND THAT IS THE POINT RATHER THAN A PRECAUTION ───────────
 *
 * **A refusal about a key is exactly the kind of message that
 * quotes one** — *this viewing key does not open …* — and the path carries a
 * query string, which is where `viewingKey` travels. So the reason and the path
 * both go through `redactSecrets` before anything is written.
 *
 * **THE BROWSER GETS THE RAW SENTENCE AND THE DISK GETS THE REDACTED ONE, AND
 * THIS PARAGRAPH CLAIMED THE OPPOSITE UNTIL `S58`.** `T-326` records it.
 * The paragraph said *the same redactor answers the browser in
 * `wrap`, so the person's sentence and the line on disk are one string rather
 * than two that can drift*. **`wrap` calls no redactor** — it computes one
 * `reason` and forks it, sending it to the browser untouched
 * (`src/server/index.ts`, `res.status(400).json({ error: reason })`) and to
 * `appendRefusal`, which redacts. The path diverges too: the disk gets a
 * redacted `req.originalUrl` and the browser gets no path at all.
 *
 * **AND THE DIVERGENCE IS THE DESIGN, WHICH IS WHY THE SENTENCE IS CORRECTED
 * RATHER THAN THE CODE.** `src/server/index.ts`'s own note above `wrap` states
 * it correctly and always has: *redacted at the boundary it crosses and not
 * here … `renderRefusal` redacts on the way to the disk; the page redacts on
 * the way to the wire. Redacting a third time here would mask both, so a
 * mutation that removed either would survive and prove the opposite of what it
 * looked like it proved.* Two files said different things; **this was the
 * wrong one.**
 *
 * **`C148` HAD TO CLOSE FIRST AND IT DID, IN THIS ROUND.** This file sends more
 * text to disk than this project has ever sent, from a browser, where somebody
 * may have typed anything into the wrong field. A redactor that a single
 * capital letter switches off would have turned this into a leak.
 *
 * ── IT APPENDS, LIKE THE WEB CONSOLE REPORT AND UNLIKE EVERY OTHER ───────
 *
 * A `.command` writes its whole output fresh because a run is a run. **This is
 * not a run** — it is what a service refused across a person's whole session,
 * across reloads and restarts, and the walk that produced thirteen `400`s is
 * the ordinary case rather than the exotic one. Overwriting would keep the last
 * refusal and throw away the twelve that led to it.
 *
 * **THE BOUND ON IT IS TIME AND NOTHING ELSE, AND THAT IS SAID RATHER THAN
 * HIDDEN.** Anybody who can reach the service can make it refuse, so the file
 * grows with the refusals. `RESET-DATA.command` does not clear it and should
 * not; a person who wants it gone deletes it, and a deployment that cannot
 * afford it sets `REFUSAL_LOG` somewhere it can. That is the same posture
 * `REPORT-WEB-CONSOLE.txt` has had since `X4`, taken deliberately rather than
 * by default.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../core/redact-secrets.js';

/**
 * The file. `REFUSAL_LOG` overrides it so a test can be given its own, which is
 * the only way a test that greps this report can grep one it made.
 */
export const refusalLogPath = (): string =>
  process.env.REFUSAL_LOG ?? join(process.cwd(), 'logs', 'REPORT-REFUSALS.txt');

/** Said once, when the file is created, so a stranger opening it knows what it is. */
const HEADER = [
  'REPORT-REFUSALS  —  what the service refused, and why',
  '',
  'One line per request this service answered with a 400: the method, the path, the',
  'kind of error that was thrown, and the sentence the person was given. Appended',
  'to, not overwritten, because a walk that hits thirteen refusals needs all',
  'thirteen and not the last one.',
  '',
  'Reason and path are REDACTED HERE, and the browser received them unredacted: the',
  'page has its own redactor on the way to the wire, and this file has this one on the',
  'way to disk. Anything shaped like a key, a seed, a token or a password is removed',
  'before it reaches this file. So a line here and the sentence a person saw are the',
  'same message and NOT the same string, and where they differ this one is the safe',
  'one. (This header claimed they were identical until S58 — T-326.)',
  '',
  'THE LINE ABOVE IS WORDED THE WAY IT IS ON PURPOSE. C148 made the seed-phrase',
  'shape case-insensitive, and twelve consecutive short words are that shape — so',
  'a header written in short words is a header every grep of this file trips over.',
  'That is the over-redaction the redactor says it accepts, met on the first day.',
  '',
  '',
].join('\n');

/** What one refusal looks like, exported so the format has a test with no filesystem. */
export const renderRefusal = (
  method: string,
  path: string,
  status: number,
  kind: string,
  reason: string,
  at: Date,
): string =>
  `${at.toISOString()}  ${status} ${String(method).slice(0, 10).toUpperCase().padEnd(6)} `
  + `${redactSecrets(path)}\n`
  + `                            ${String(kind).slice(0, 40)}: ${redactSecrets(reason)}\n`;

/**
 * Appends one refusal, creating the file and its folder if needed.
 *
 * **Never throws.** It is called from the one place that answers every error
 * this service produces, and a service that cannot write its own report must
 * still be a service that answers. The same reasoning, and the same shape, as
 * `appendWebConsole`.
 */
export const appendRefusal = (
  method: string,
  path: string,
  status: number,
  kind: string,
  reason: string,
  at: Date = new Date(),
): void => {
  const file = refusalLogPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const first = !existsSync(file);
    appendFileSync(file, (first ? HEADER : '') + renderRefusal(method, path, status, kind, reason, at));
  } catch { /* the report is a convenience; the service is not */ }
};
