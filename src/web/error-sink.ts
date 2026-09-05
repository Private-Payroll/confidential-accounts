/**
 * WHAT THE BROWSER SAID, ON DISK, WITHOUT ANYBODY HAVING BEEN LOOKING. `X4` §1.
 *
 * ── WHY THIS IS THE FIRST IMPORT IN `main.tsx` ───────────────────────────
 *
 * The app opened to a completely white page in a real browser and nothing in
 * this project could see why. Four rounds running, every defect was found by
 * starting the thing rather than by a test, and each time the evidence was a
 * memory of what a screen looked like. **Every future flow — creating a
 * company, hiring somebody, paying them, opening a payslip — will be walked the
 * same way.** This module is what survives that walk.
 *
 * It observes four things and posts them to the service, which appends them to
 * `logs/REPORT-WEB-CONSOLE.txt`:
 *
 *   · uncaught errors            · unhandled promise rejections
 *   · `console.error` / `.warn`  · fetches that failed, by status and path
 *
 * **IT IS THE FIRST LINE OF `main.tsx` AND THAT IS LOAD-BEARING.** ES module
 * imports are evaluated in source order, so importing this one first means it
 * is installed before React, before `App`, before the stylesheet — and
 * therefore before anything that could throw while a module is still being
 * evaluated. Calling an `install()` from the body of `main.tsx` would not do
 * it: every import is hoisted above every statement, so the app would already
 * have been evaluated by the time the call ran.
 *
 * ── THE THREE RULES, AND WHERE EACH ONE IS ENFORCED ──────────────────────
 *
 * **1. DEVELOPMENT ONLY, THROUGH THE PATTERN THAT ALREADY EXISTS.** `ARMED`
 * below is a build-time constant. `import.meta.env.DEV` is replaced by `false`
 * in a production build, so the whole of `install` becomes unreachable and the
 * bundler removes it — **a production build does not contain this code at
 * all**, which is a stronger claim than "it does not run", and it is the claim
 * `sink-not-in-production.test.ts` builds the app to check. The second half of
 * the guard is the `C140` shape: the relaxation is declared in the `dev` script
 * in `package.json` and nowhere a person types.
 *
 * **2. IT NEVER WRITES A SECRET.** `C145`. Every message goes through
 * `redactSecrets` HERE, before it crosses the wire, and again in the service
 * before it reaches the disk. An error message can carry anything — a key, a
 * seed, a session token, a password typed into the wrong field.
 *
 * **3. IT NEVER CHANGES WHAT THE APP DOES.** It observes and re-throws. A sink
 * that swallows an error is worse than no sink, because the screen then fails
 * silently and the report says everything is fine. Concretely:
 *
 *   · errors and rejections are watched with `addEventListener`, never by
 *     assigning `window.onerror` — assigning it would clobber whatever else set
 *     it, and returning `true` from it would suppress the browser's own report.
 *   · nothing calls `preventDefault()`.
 *   · the console wrappers always call the original, even if recording throws.
 *   · the `fetch` wrapper returns the very same response object, and re-throws
 *     the very same rejection.
 *
 * ── AND IT DOES NOT WATCH ITSELF ─────────────────────────────────────────
 *
 * The reference to `fetch` is taken before the wrapper is installed, and the
 * sink posts through that one. Otherwise a service that is down would produce a
 * failed fetch, which would be recorded, which would be posted, which would
 * fail — a loop that fills a disk with its own noise.
 */
import { redactSecrets } from '../core/redact-secrets.js';

/** Where the service takes them. Proxied to :8787 by the dev server. */
export const SINK_PATH = '/api/dev/web-console';

/** One thing the browser said. */
export type SinkEntry = {
  /**
   * `error`, `rejection`, `console.error`, `console.warn`, `fetch` — or
   * `shown`, which is `C159`: an error the application CAUGHT and rendered
   * onto a screen for a person to read. See `recordShownError` below.
   */
  readonly level: string;
  readonly message: string;
  readonly stack?: string;
};

/** What a post carries: the page's address, and what it said. */
export type SinkPost = { readonly page: string; readonly entries: readonly SinkEntry[] };

/**
 * Only what this module touches, so it can be driven by a fake in a test
 * without a DOM. Everything here exists in a browser.
 */
export type SinkWindow = {
  addEventListener(type: string, handler: (event: any) => void, capture?: boolean): void;
  fetch: (...args: any[]) => Promise<any>;
  console: { error: (...a: any[]) => void; warn: (...a: any[]) => void };
  location: { href: string };
  setTimeout: (fn: () => void, ms: number) => any;
};

/**
 * **HOW MUCH OF A REFUSAL'S BODY IS KEPT BESIDE ITS STATUS.** `C157`.
 *
 * The sink recorded `400 POST /api/accounts` and stopped there, so a policy
 * refusal and a viewing key that could not open a record were the same line.
 * The reason was in the body all along and nothing read it.
 *
 * Three hundred characters is longer than every sentence this service throws
 * and far short of an HTML error page, which is the other thing that arrives
 * with `ok === false`.
 */
const BODY_CHARS = 300;

/** How many entries are held before a post is forced, and how many are kept. */
const FLUSH_AT = 40;
const QUEUE_CAP = 200;
/** Long enough that a burst of console noise is one post, short enough to be there. */
const FLUSH_AFTER_MS = 250;

/**
 * **THE REASON OUT OF A REFUSAL'S BODY — REDACTED FIRST, CUT SECOND.** `C157`.
 *
 * ── THAT ORDER IS THE WHOLE OF THIS FUNCTION ─────────────────────────────
 *
 * `redactSecrets` replaces a secret it can SEE. A sixty-four character key cut
 * in half by a length cap is twenty hex characters, which is under every
 * threshold the redactor has — **so cutting first and redacting second posts a
 * fragment of a real key and nothing anywhere notices.** Redacting first turns
 * the key into `<redacted:hex>` before any cut can reach it, and the cut then
 * lands on text that has nothing left in it.
 *
 * **This is why this call exists at all when `record` redacts as well.** The
 * one below cannot save this: by the time it runs, the cut has happened.
 * `scripts/mutate-refusals.mjs` 02 swaps the order back.
 *
 * The body is JSON with an `error` in it for everything `wrap` answers, and
 * something else entirely for an error page a proxy wrote. Both are kept —
 * *what the service said* is the useful thing either way.
 */
const reasonOf = (body: string): string => {
  let text = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === 'string') text = parsed.error;
  } catch { /* not JSON, so whatever arrived is what the service said */ }
  return redactSecrets(text).slice(0, BODY_CHARS);
};

/** What an argument to `console.error` looks like as text. */
const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
};

/**
 * **THE ONE CLASS OF FAILURE THE SINK COULD NOT SEE, AND `C159` IS ITS ROW.**
 * `docs/NEXT.md` `X11` §5.
 *
 * The four things installed below are all failures **nobody was handling**:
 * uncaught errors, unhandled rejections, `console` calls, failed fetches. On
 * the first walk after `X10`, the failure the founder actually hit reached
 * neither report — **the application CAUGHT it and rendered it onto the
 * screen**, which is the correct thing to do with an error a person needs to
 * read, and none of the four saw it. So the one class of failure that by
 * definition reaches a human was the one class no artefact kept.
 *
 * This is the seam that closes it. `shown-error.ts` is the single function
 * every screen turns an error into a sentence with, and it calls this — **so
 * showing a person what went wrong and keeping it are one act rather than two
 * habits.**
 *
 * ── IT IS A HOOK AND NOT A SECOND QUEUE ──────────────────────────────────
 *
 * A shown error goes into the SAME queue, with the same redaction, the same
 * batching and the same post as everything else, because a second path to disk
 * is a second thing that can be armed differently, redact differently, or fail
 * differently. **Before `installErrorSink` runs, and in a production build
 * where it never runs, this is a no-op** — which is the honest behaviour: the
 * sink is a development instrument and `sink-not-in-production.test.ts` is what
 * holds that.
 */
let recorder: ((level: string, message: unknown, stack?: unknown) => void) | null = null;

/** Called by `shown-error.ts`. Never by a screen directly. */
export const recordShownError = (message: string, stack?: string): void => {
  /* Rule 3: recording may never change what the app does. */
  try { recorder?.('shown', message, stack); } catch { /* nothing the page can do */ }
};

/** For a test that drives the sink without a window. */
export const forgetSinkForTest = (): void => { recorder = null; };

/**
 * Installs the sink on a window and returns nothing anybody needs.
 *
 * `post` is injectable so the tests can read exactly what would have crossed
 * the wire. In a browser it defaults to the `fetch` captured before wrapping.
 */
export const installErrorSink = (
  w: SinkWindow,
  post?: (body: SinkPost) => void,
): void => {
  /* TAKEN BEFORE THE WRAPPER GOES ON. See the note at the top. */
  const originalFetch = w.fetch.bind(w);
  const originalError = w.console.error.bind(w.console);
  const originalWarn = w.console.warn.bind(w.console);

  const send = post ?? ((body: SinkPost) => {
    /*
     * ITS OWN FAILURES ARE ITS OWN. A service that is not up must not turn into
     * an error in the page, and must not be recorded — see the loop above.
     */
    try {
      void originalFetch(SINK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch { /* nothing the page can do about it, and nothing it should see */ }
  });

  let queue: SinkEntry[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (queue.length === 0) return;
    const entries = queue;
    queue = [];
    try { send({ page: w.location.href, entries }); } catch { /* never the app's problem */ }
  };

  const record = (level: string, message: unknown, stack?: unknown) => {
    try {
      if (queue.length >= QUEUE_CAP) return;
      queue.push({
        level,
        message: redactSecrets(asText(message)),
        ...(stack === undefined ? {} : { stack: redactSecrets(String(stack)) }),
      });
      if (queue.length >= FLUSH_AT) { flush(); return; }
      if (!scheduled) { scheduled = true; w.setTimeout(flush, FLUSH_AFTER_MS); }
    } catch { /* rule 3: recording may never change what the app does */ }
  };

  /*
   * **THE SHOWN-ERROR SEAM IS POINTED AT THE SAME `record`.** `C159`, `X11` §5.
   * Registered here rather than exported from the closure so that a page which
   * never installed a sink has a `recordShownError` that does nothing at all,
   * rather than one that throws into a screen already showing a failure.
   */
  recorder = record;

  /*
   * ---- uncaught errors, and nothing suppressed ----
   *
   * **CAPTURING, AND THAT IS THE HALF THAT MATTERS FOR A WHITE PAGE.** A script
   * or stylesheet that fails to load fires `error` at the ELEMENT, and that
   * event does not bubble — it only reaches `window` on the way down. So a
   * listener registered without `capture` sees uncaught exceptions and misses
   * exactly the failure that leaves a page blank with nothing else to say.
   */
  w.addEventListener('error', (event: any) => {
    const target = event?.target;
    if (target && target !== w && (target.src || target.href)) {
      record('resource', `failed to load — ${asText(target.src ?? target.href)}`);
      return;
    }
    const error = event?.error;
    const where = event?.filename
      ? ` (${event.filename}:${event.lineno ?? '?'}:${event.colno ?? '?'})`
      : '';
    record('error', `${asText(error ?? event?.message ?? 'unknown error')}${where}`, error?.stack);
  }, true);

  w.addEventListener('unhandledrejection', (event: any) => {
    const reason = event?.reason;
    record('rejection', asText(reason ?? 'unknown rejection'), reason?.stack);
  });

  /* ---- the console, original always called ---- */
  w.console.error = (...args: any[]) => {
    record('console.error', args.map(asText).join(' '));
    originalError(...args);
  };
  w.console.warn = (...args: any[]) => {
    record('console.warn', args.map(asText).join(' '));
    originalWarn(...args);
  };

  /**
   * **THE STATUS, THE PATH, AND THE REASON — WITHOUT TOUCHING THE RESPONSE.**
   * `C157`.
   *
   * ── `clone()`, AND IT IS NOT AN OPTIMISATION ─────────────────────────────
   *
   * A body can be read once. Calling `response.text()` here would drain the
   * stream the CALLER is about to read, so every screen that shows a refusal
   * would show an empty one — **the sink changing what the app does, which is
   * rule 3 and the reason this file exists in the shape it does.** The clone
   * carries its own copy of the stream; the response handed back is untouched.
   *
   * ── AND NOTHING IS AWAITED BEFORE THE RESPONSE GOES BACK ─────────────────
   *
   * The read is started and left to finish on its own. Awaiting it would put
   * the sink's latency in front of every failed request in the app, and a sink
   * that slows the thing it watches gets switched off.
   *
   * A response with no `clone` — a fake in a test, an older runtime — records
   * the line it always recorded. Losing the reason is a worse report; throwing
   * here would be a worse app.
   */
  const keepTheReason = (response: any, line: string) => {
    let body: Promise<string> | null = null;
    try {
      if (typeof response.clone === 'function') body = response.clone().text();
    } catch { body = null; }
    if (!body) { record('fetch', line); return; }
    void body.then(
      (text: string) => record('fetch', text ? `${line} — ${reasonOf(text)}` : line),
      () => record('fetch', line),
    );
  };

  /* ---- failed fetches: the status, the path, the reason, response untouched ---- */
  w.fetch = async (...args: any[]) => {
    const url = asText(args[0]?.url ?? args[0]);
    let response: any;
    try {
      response = await originalFetch(...args);
    } catch (failure) {
      record('fetch', `${asText(failure)} — ${url}`);
      /*
       * RE-THROWN, NOT RETURNED. Whatever the caller would have caught, it
       * still catches. Rule 3, and the mutation that takes this line out is in
       * the round's mutation set.
       */
      throw failure;
    }
    if (response && response.ok === false) keepTheReason(response, `${response.status} ${url}`);
    /*
     * RETURNED IMMEDIATELY, WITH ITS BODY UNREAD. `keepTheReason` never
     * awaits anything on this path — see rule 3 at the top of the file.
     */
    return response;
  };
};

/**
 * **THE GUARD, AND IT IS A BUILD-TIME CONSTANT ON BOTH SIDES.**
 *
 * `import.meta.env.DEV` is `false` in a production build whatever else is set,
 * so no production build can be talked into shipping this — not by a stale
 * `.env`, not by a name on a command line. `VITE_DEV_ERROR_SINK` is the `C140`
 * half: declared by the `dev` script in `package.json`, so a development build
 * that did not ask for the sink does not get one either.
 */
const ARMED = import.meta.env.DEV && import.meta.env.VITE_DEV_ERROR_SINK === '1';

if (ARMED) installErrorSink(window as unknown as SinkWindow);
