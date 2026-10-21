/** The one bound on every read this page makes of the service or the chain while a company is being finished or its vault made. */
export const SERVICE_READ_BOUND_MS = 20_000;

/** The same bound in seconds, for the words that name it. */
export const SERVICE_READ_BOUND_SECONDS = '20';

/** A read that was given SERVICE_READ_BOUND_MS and did not answer. Only reads raise it: a send is never cut short. */
export class ReadRanOutOfTime extends Error {
  constructor(readonly what: string) {
    super(`${what} did not answer within ${SERVICE_READ_BOUND_SECONDS} seconds, so this page stopped waiting for it. Nothing was changed by this read.`);
    this.name = 'ReadRanOutOfTime';
  }
}

/** Runs one read with an abort signal; once the bound has passed the signal is aborted and the read is refused with ReadRanOutOfTime. */
export function boundedRead<T>(what: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((answer, refuse) => {
    const stopper = new AbortController();
    const timer = setTimeout(() => {
      stopper.abort();
      refuse(new ReadRanOutOfTime(what));
    }, SERVICE_READ_BOUND_MS);
    work(stopper.signal).then(
      (v) => { clearTimeout(timer); answer(v); },
      (e: unknown) => { clearTimeout(timer); refuse(e); },
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
