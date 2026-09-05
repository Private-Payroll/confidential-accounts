/**
 * WHAT A PAGE SAID, AND HOW IT READS ON DISK. `X4` §2.
 *
 * The observing half of `WEB-CHECK.command`, kept apart from the half that
 * starts servers and launches browsers **so that there is one copy of it.** A
 * report assembled inside a launcher is a report that can only be produced by
 * that launcher, on a machine that can run it; everything below takes a
 * Playwright `page` and gives back text.
 *
 * `renderReport` is a pure function of what was collected, which is why the
 * one thing this file has to get right — **telling "an error" apart from "no
 * errors and an empty page"** — has a test rather than a walk.
 */

/**
 * Wires a page up and returns the collector it fills.
 *
 * Everything is kept in arrival order in one list as well as split by kind,
 * because the order two things happened in is usually the answer.
 *
 * **ONE SOURCE, AND A SECOND ONE WAS TRIED AND REJECTED.** The first walk this
 * wrote reported, in the console section, *"Failed to load resource: the server
 * responded with a status of 404"* — and said `(none)` under every request that
 * failed. That is the exact complaint `scripts/browser-probe.mjs` already
 * carries a comment about: **a 404 that only says "Failed to load resource"
 * names nothing.**
 *
 * The obvious repair was to read the browser's own network log over the
 * debugging protocol as well. **It was written, measured against a page with a
 * missing stylesheet, image and script, and removed again**: both sources
 * reported all three, identically, and NEITHER reported the request that had
 * actually gone missing — the browser's own fetch of a favicon, which is made
 * outside the page and is attributed to nothing. A second source that
 * duplicates the first and does not close the gap it was added for is code
 * nobody can justify keeping.
 *
 * **What closes it is the report saying so**, which `renderReport` does: a
 * console line about a failed load with no request beside it is called out
 * rather than left as a contradiction for somebody to notice.
 */
export const watch = (page) => {
  const collected = {
    console: [],
    errors: [],
    failed: [],
    timeline: [],
  };
  const at = () => new Date().toISOString();

  page.on('console', (message) => {
    const entry = { level: message.type(), text: message.text() };
    collected.console.push(entry);
    collected.timeline.push({ at: at(), kind: `console.${entry.level}`, text: entry.text });
  });

  /*
   * An uncaught error, and its stack, which is the part a console line loses.
   *
   * **AN UNHANDLED REJECTION ARRIVES HERE TOO** — the browser reports both
   * through the same channel, so there is one bucket and not two. The page's
   * own sink, which is running in a development build, does tell them apart;
   * this report says what the browser handed over.
   */
  page.on('pageerror', (error) => {
    const entry = { message: String(error?.message ?? error), stack: String(error?.stack ?? '') };
    collected.errors.push(entry);
    collected.timeline.push({ at: at(), kind: 'uncaught', text: entry.message, stack: entry.stack });
  });

  /*
   * A request that never got an answer — refused, aborted, DNS. Distinct from a
   * 404, which IS an answer, and the two have different causes.
   */
  page.on('requestfailed', (request) => {
    const entry = {
      status: request.failure()?.errorText ?? 'failed',
      url: request.url(),
      method: request.method(),
    };
    collected.failed.push(entry);
    collected.timeline.push({ at: at(), kind: 'request failed', text: `${entry.status} ${entry.method} ${entry.url}` });
  });

  page.on('response', (response) => {
    if (response.status() < 400) return;
    const entry = {
      status: response.status(),
      url: response.url(),
      method: response.request().method(),
    };
    collected.failed.push(entry);
    collected.timeline.push({ at: at(), kind: 'http', text: `${entry.status} ${entry.method} ${entry.url}` });
  });

  return collected;
};

/** What the page rendered, as a person would read it. Never throws. */
export const renderedText = async (page) => {
  try {
    return await page.evaluate(() => ({
      title: document.title ?? '',
      body: (document.body?.innerText ?? '').trim(),
      rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      background: getComputedStyle(document.body).backgroundColor,
    }));
  } catch (e) {
    return { title: '', body: '', rootChildren: 0, background: '', unreadable: String(e?.message ?? e) };
  }
};

const bullet = (lines, empty) => (lines.length ? lines : [empty]);

/**
 * The report.
 *
 * **THE VERDICT IS FOUR CASES AND NOT TWO**, because the round exists for the
 * one in the middle: *no errors and an empty page* is a different fault from
 * *an error*, and a report that cannot say which is a report that sends
 * somebody looking in the wrong place.
 */
export const renderReport = ({ url, collected, rendered, startedAt, finishedAt }) => {
  const errors = collected.errors.length;
  const consoleErrors = collected.console.filter(c => c.level === 'error').length;
  const empty = rendered.rootChildren === 0 && rendered.body.length === 0;
  /*
   * A console line about a failed load with no request beside it. See the note
   * on `watch`: it is a contradiction in the report unless the report says why.
   */
  const unattributed = collected.failed.length === 0
    && collected.console.some(c => /failed to load resource/i.test(c.text));

  const verdict = empty && errors + consoleErrors === 0
    ? 'THE PAGE IS EMPTY AND NOTHING COMPLAINED. Nothing mounted and nothing said why —'
      + ' the fault is upstream of anything that could have thrown.'
    : empty
      ? 'THE PAGE IS EMPTY AND SOMETHING COMPLAINED. The reason is below, in full.'
      : errors + consoleErrors > 0
        ? 'THE PAGE RENDERED AND SOMETHING COMPLAINED. It is up, and not clean.'
        : 'THE PAGE RENDERED AND NOTHING COMPLAINED.';

  const lines = [
    'REPORT-WEB-CHECK  —  what a real browser saw',
    '',
    `address    ${url}`,
    `started    ${startedAt}`,
    `finished   ${finishedAt}`,
    '',
    verdict,
    '',
    '== WHAT THE PAGE RENDERED ============================================',
    '',
    `  title              ${rendered.title || '(none)'}`,
    `  elements in #root  ${rendered.rootChildren}`,
    `  body background    ${rendered.background || '(unreadable)'}`,
    `  visible text       ${rendered.body.length} characters`,
    '',
  ];

  if (rendered.unreadable) {
    lines.push(`  THE PAGE COULD NOT BE READ AT ALL: ${rendered.unreadable}`, '');
  } else if (rendered.body.length === 0) {
    lines.push('  THE PAGE RENDERED NO TEXT AT ALL.', '');
  } else {
    for (const line of rendered.body.split('\n')) lines.push(`  | ${line}`);
    lines.push('');
  }

  lines.push(
    '== EVERY CONSOLE MESSAGE, WITH ITS LEVEL =============================',
    '',
    ...bullet(collected.console.map(c => `  ${c.level.padEnd(8)} ${c.text}`), '  (none)'),
    '',
    '== EVERY UNCAUGHT ERROR AND REJECTION, WITH ITS STACK ================',
    '',
  );
  if (collected.errors.length === 0) {
    lines.push('  (none)', '');
  } else {
    for (const e of collected.errors) {
      lines.push(`  ${e.message}`);
      for (const frame of String(e.stack ?? '').split('\n').slice(0, 25)) {
        if (frame.trim()) lines.push(`      ${frame.trim()}`);
      }
      lines.push('');
    }
  }

  lines.push(
    '== EVERY REQUEST THAT FAILED, WITH ITS STATUS AND PATH ===============',
    '',
    ...bullet(collected.failed.map(f => `  ${String(f.status).padEnd(24)} ${f.method} ${f.url}`), '  (none)'),
    '',
    ...(unattributed ? [
      '  AND THE BROWSER REPORTED A FAILED LOAD IT DID NOT ATTRIBUTE TO A REQUEST.',
      '  The console above carries the line and not the address. A request made by',
      '  the browser on its own behalf — a favicon is the everyday one — is made',
      '  outside the page and is reported to nothing that can name it. If the page',
      '  rendered, this is almost always that. If the page is empty, it is not',
      '  enough to explain it and the sections above are where the answer is.',
      '',
    ] : []),
    '== IN THE ORDER THEY HAPPENED ========================================',
    '',
    ...bullet(collected.timeline.map(t => `  ${t.at}  ${t.kind.padEnd(16)} ${t.text}`), '  (nothing happened)'),
    '',
  );

  return lines.join('\n');
};
