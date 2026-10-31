/// <reference types="vite/client" />
/** The one bound on every read this page makes of the service or the chain while a company is being finished or its vault made. */
export const SERVICE_READ_BOUND_MS = 20_000;

/** The same bound in seconds, for the words that name it. */
export const SERVICE_READ_BOUND_SECONDS = '20';

/**
 * **WHERE THE PAGE'S READS ARE WRITTEN DOWN, IN A DEVELOPMENT BUILD.** With the console report on (`error-sink.ts`, on
 * the same test), each read bound here writes one console warning when it ends, which the report carries to the
 * service's log: what it read, its status and how long it took, what it failed with, or that it ran out of time. Only
 * the read's name, a status, a time and an error's kind and message: never what it answered. Every line sits behind
 * `import.meta.env.DEV`, so a production build carries none of it; outside a bundler `import.meta` has no `env` and
 * nothing is written.
 */
const readsAreNoted = (): boolean => import.meta.env?.DEV === true && import.meta.env.VITE_DEV_ERROR_SINK === '1';
const noteRead = (line: string): void => { try { console.warn(`read ${line}`); } catch { /* a line that cannot be written never stops a read */ } };
const statusOf = (v: unknown): string => {
  const o = (v ?? {}) as { status?: unknown; response?: { status?: unknown } };
  const status = typeof o.status === 'number' ? o.status : typeof o.response?.status === 'number' ? o.response.status : null;
  return status === null ? '' : `${status} `;
};
const errorOf = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * **A STEP THE PAGE TOOK WHILE PREPARING AN ASK, WRITTEN THE SAME WAY.** One line on the same console report as the
 * reads, so a report shows which step an ask stopped at between the reads it made. The caller writes only the step's
 * name and an error's kind: never a key, a secret, an address or an amount.
 */
export function notePreparing(line: string): void {
  if (import.meta.env?.DEV && readsAreNoted()) noteRead(line);
}

/**
 * A read that was given SERVICE_READ_BOUND_MS and did not answer. Only reads raise it: a send is never cut short.
 * Made wherever a read is bounded, so it is also where every read that ran out of time is written down.
 */
export class ReadRanOutOfTime extends Error {
  constructor(readonly what: string) {
    super(`${what} did not answer within ${SERVICE_READ_BOUND_SECONDS} seconds, so this page stopped waiting for it. Nothing was changed by this read.`);
    this.name = 'ReadRanOutOfTime';
    if (import.meta.env?.DEV && readsAreNoted()) {
      noteRead(`${what}: did not answer within ${SERVICE_READ_BOUND_SECONDS} seconds, so the page stopped waiting for it`);
    }
  }
}

/** Runs one read with an abort signal; once the bound has passed the signal is aborted and the read is refused with ReadRanOutOfTime. */
export function boundedRead<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const started = import.meta.env?.DEV ? Date.now() : 0;
  return new Promise<T>((answer, refuse) => {
    const stopper = new AbortController();
    const timer = setTimeout(() => {
      stopper.abort();
      refuse(new ReadRanOutOfTime(what));
    }, SERVICE_READ_BOUND_MS);
    work(stopper.signal).then(
      (v) => {
        clearTimeout(timer);
        if (import.meta.env?.DEV && readsAreNoted()) noteRead(`${what}: answered ${statusOf(v)}in ${Date.now() - started} ms`);
        answer(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        if (import.meta.env?.DEV && readsAreNoted()) noteRead(`${what}: failed after ${Date.now() - started} ms: ${errorOf(e)}`);
        refuse(e);
      },
    );
  });
}

const ofTheService = new Set<Promise<unknown>>();

/** A bounded read of the service, remembered until it has answered, been refused or run out of time, so a sign-out can wait for it. */
export function serviceRead<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const read = boundedRead(what, work);
  ofTheService.add(read);
  const ended = (): void => { ofTheService.delete(read); };
  read.then(ended, ended);
  return read;
}

/** How long a sign-out waits for the reads of the service that were in flight when it was pressed. */
export const SIGN_OUT_WAITS_MS = 5_000;

/** Settles once every read of the service in flight now has ended, or after `boundMs`, whichever is first. Reads started later are not waited for. */
export function readsAnswered(boundMs: number): Promise<void> {
  const inFlight = [...ofTheService];
  if (inFlight.length === 0) return Promise.resolve();
  return new Promise<void>((done) => {
    const timer = setTimeout(done, boundMs);
    void Promise.allSettled(inFlight).then(() => { clearTimeout(timer); done(); });
  });
}

/** A request with no method, or GET, is a read. */
export const isReadMethod = (method: string | undefined): boolean => method === undefined || method.toUpperCase() === 'GET';
