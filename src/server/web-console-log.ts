/**
 * WHERE WHAT THE BROWSER SAID IS KEPT. `X4` §1, the service half.
 *
 * The page posts what it observed; this appends it to
 * `logs/REPORT-WEB-CONSOLE.txt` with a timestamp and the page's address. A
 * person walks the app, something goes wrong, and the reason is on disk
 * afterwards without anybody having to have been looking.
 *
 * ── IT REDACTS AGAIN, AND THAT IS NOT BELT AND BRACES ────────────────────
 *
 * `C145`. The page already put every message through `redactSecrets` before it
 * crossed the wire. This does it again on the way to the disk, because **this
 * is the boundary the row is actually about**: the row is not "a secret must
 * not be sent", it is *"nothing this project keeps on disk ever contains a
 * seed, proved by a test that greps its own logs"*. The test that greps this
 * file is aimed at this function, and a mutation that removes this call has to
 * kill it — which it could not do if the only redaction lived in the browser.
 *
 * ── IT APPENDS, AND EVERY OTHER REPORT IN THIS PROJECT IS OVERWRITTEN ────
 *
 * Deliberate, and the one place the convention is broken. Every `.command`
 * writes its whole output fresh because a run is a run. **This file is not a
 * run** — it is whatever a person's session produced, across reloads, across
 * restarts of the service, and a page that reloads after it breaks is the
 * ordinary case rather than the exotic one. Overwriting would throw away the
 * error that caused the reload.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../core/redact-secrets.js';

/** One thing the browser said, as it arrives on the wire. */
export type WebConsoleEntry = { level: string; message: string; stack?: string };

/** How many entries one post may carry. Beyond this the rest are dropped. */
export const MAX_ENTRIES = 200;

/**
 * The file. `WEB_CONSOLE_LOG` overrides it so a test can be given its own,
 * which is the only way a test that greps this report can grep one it made.
 */
export const webConsoleLogPath = (): string =>
  process.env.WEB_CONSOLE_LOG ?? join(process.cwd(), 'logs', 'REPORT-WEB-CONSOLE.txt');

/** Said once, when the file is created, so a stranger opening it knows what it is. */
const HEADER = [
  'REPORT-WEB-CONSOLE  —  what the browser said',
  '',
  'Every uncaught error, rejection, console message and failed request from a page',
  'served by the development build, with the time and the address of the page it',
  'came from. Appended to, not overwritten: a page that reloads after it breaks is',
  'the ordinary case, and overwriting would throw away the reason it reloaded.',
  '',
  'Anything shaped like a key, a seed, a token or a password is removed before it',
  'reaches this file.',
  '',
  '',
].join('\n');

/**
 * What one post looks like in the file.
 *
 * Exported so the format has a test that does not need a filesystem. The page's
 * address goes through the redactor too — a URL carries a query string, and a
 * query string is somewhere a token ends up.
 */
export const renderWebConsole = (
  page: string,
  entries: readonly WebConsoleEntry[],
  at: Date,
): string => {
  const lines = [`${at.toISOString()}  ${redactSecrets(page)}`];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    lines.push(`  ${String(entry.level).slice(0, 20).padEnd(14)} ${redactSecrets(entry.message)}`);
    if (entry.stack) {
      for (const line of redactSecrets(entry.stack).split('\n').slice(0, 20)) {
        if (line.trim()) lines.push(`                 ${line.trim()}`);
      }
    }
  }
  return `${lines.join('\n')}\n\n`;
};

/**
 * Appends one post to the report, creating the file and its folder if needed.
 *
 * Never throws: it is called from a route that must answer whatever the disk
 * is doing, and a page that cannot be observed must still be a page that works.
 */
export const appendWebConsole = (
  page: string,
  entries: readonly WebConsoleEntry[],
  at: Date = new Date(),
): void => {
  const path = webConsoleLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const first = !existsSync(path);
    appendFileSync(path, (first ? HEADER : '') + renderWebConsole(page, entries, at));
  } catch { /* the report is a convenience; the app is not */ }
};
