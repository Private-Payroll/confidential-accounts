/**
 * How this page talks to the service. Every call is one fetch (`pageFetch`), made through `api`, or through
 * `serviceAnswered` where the caller reads the answer's status itself; each sends the person's sign-in only to this
 * page's own origin and says who this tab was prepared for, so the service can refuse a request whose sign-in has
 * become somebody else's, and a request that got no answer is `ServiceNotReached`. An answer that is not a
 * success comes back as an error a screen can tell apart: signed out, signed in as somebody else, could not check, no
 * such record, or refused. This file holds no sign-in of its own: the module that holds it hands it in once
 * (`theSignInIsHeldBy`), and this file asks it who is signed in and tells it when the service has ended the sign-in.
 */
import { isReadMethod, serviceRead } from './read-bound.js';
import { ServiceNotReached } from './hand-over.js';

/** What this file needs from the sign-in this tab holds, handed in once by the module that holds it. */
interface SignInHeld {
  /** The person this tab is signed in as, or null. */
  readonly person: () => { readonly id: string } | null;
  /** Whether this tab has a live session. */
  readonly isLive: () => boolean;
  /**
   * The service said the sign-in is gone (`no-session`) or now belongs to somebody else (`another-person`): forget
   * everything held locally, and remember which of the two it was.
   */
  readonly lost: (why: 'no-session' | 'another-person') => void;
}

/* Until a sign-in is handed in, nobody is signed in and there is nothing to forget. */
let signIn: SignInHeld = { person: () => null, isLive: () => false, lost: () => undefined };

/** Hands this file the sign-in this tab holds. */
export function theSignInIsHeldBy(held: SignInHeld): void {
  signIn = held;
}

/** Whether this tab has a live session: the one question the wallet asks and the company's creation put to the sign-in. */
export const sessionIsLive = (): boolean => signIn.isLive();

export class AuthError extends Error {}
/**
 * The sign-in this tab sent belongs to somebody else. Still an `AuthError` to
 * every caller that only asks whether the tab is signed in; told apart where it
 * matters, which is signing out - that session is still live in this browser.
 */
export class AnotherPersonError extends AuthError {}

/**
 * The service answered 503 `could-not-check`: it could not look up whether this sign-in is live. It
 * says nothing about the person, so it is NOT an `AuthError`: nobody is signed out for it and
 * nothing is forgotten. The page keeps the person signed in and asks again.
 */
export class CouldNotCheckError extends Error {}

/** The service holds no record at the address asked for (a 404). The message is the service's own. */
export class NotOnTheService extends Error {}

/**
 * The service refused a request, and what its refusal carried besides the words: whether nothing was sent, and for what.
 * `code` is the reason a fee was not paid (`fee-not-paid`, `network-refused`), kept only from a 422 whose body says
 * nothing was sent; any other answer, a 502 included, leaves it unset.
 */
export class ServiceRefused extends Error {
  readonly code: 'fee-not-paid' | 'network-refused' | undefined;
  constructor(
    message: string,
    readonly body: Record<string, unknown>,
    status?: number
  ) {
    super(message);
    const named = body['code'];
    this.code =
      status === 422 && body['nothingWasSent'] === true && (named === 'fee-not-paid' || named === 'network-refused')
        ? named
        : undefined;
  }
}

/** A request's status and body, as one fetch of the service answered it; a body that is not JSON is `{}`. */
interface PageAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * **THE PAGE'S ONE FETCH OF THE SERVICE**, which every send on this page is built on: to this product's own server only
 * (a path under `/api/`; any other is refused, nothing sent), with the sign-in cookie, and saying which person this tab
 * was prepared for (`who`), so a sign-in changed in another tab is refused rather than written under. A request that got
 * no answer at all is `ServiceNotReached`, never an answer: the browser cannot tell whether what it carried arrived, so
 * whoever sent it decides. It tells the sign-in nothing; any status comes back with its body.
 */
const pageFetch = async (path: string, init: RequestInit, who: string | null): Promise<PageAnswer> => {
  if (!path.startsWith('/api/')) throw new Error("a request is sent to this product's own server and nowhere else");
  let r: Response;
  try {
    r = await fetch(path, {
      ...init,
      /* The sign-in cookie rides on this, and only to this page's own origin. */
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        /* **WHO THIS TAB WAS PREPARED FOR.** The sign-in is the browser's, so a
         * sign-in in another tab changes it under this one; the server refuses a
         * request whose session is somebody else, rather than letting this tab's
         * keys be written under them. */
        ...(who ? { 'x-signed-in-as': who } : {}),
        ...(init.headers ?? {})
      }
    });
  } catch (e) {
    throw new ServiceNotReached(
      `the company's service could not be reached (${String((e as Error)?.message ?? e).replace(/\.\s*$/u, '')})`,
      false
    );
  }
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

const apiOnce = async (path: string, opts: RequestInit = {}) => {
  const { status, body: answered } = await pageFetch(path, opts, signIn.person()?.id ?? null);
  /* The service's answer, read as the body of a JSON response is: its fields are each caller's to check. */
  const body: Awaited<ReturnType<Response['json']>> = answered;
  if (status === 401) {
    signIn.lost('no-session');
    throw new AuthError(body?.error ?? 'not signed in');
  }
  if (status === 409 && body?.code === 'another-person') {
    signIn.lost('another-person');
    throw new AnotherPersonError(body.error);
  }
  if (status === 503 && body?.code === 'could-not-check')
    throw new CouldNotCheckError(body?.error ?? 'the service could not check your sign-in');
  if (status === 404) throw new NotOnTheService(body?.error ?? `request failed: ${status}`);
  if (status < 200 || status > 299)
    throw new ServiceRefused(
      body?.error ?? `request failed: ${status}`,
      typeof body === 'object' && body !== null ? body : {},
      status
    );
  return body;
};

export const api = (path: string, opts?: RequestInit & { read?: boolean }) => {
  const { read, ...init } = opts ?? {};
  if (read !== true && !isReadMethod(init.method)) return apiOnce(path, init);
  return serviceRead(`The service (${path.split('?')[0]})`, (signal) => apiOnce(path, { ...init, signal }));
};

/**
 * The page's one transport to the service, as the company's records source takes it (records-source.ts,
 * `serviceSource`): the same function as `api`, named for what reads the company through it.
 */
export const serviceCall = api;

/** A request as the quiet form sends it, and the status and body it was answered with. */
export type PageSend = (
  path: string,
  init: { readonly method: 'GET' | 'PUT' | 'POST'; readonly body?: string; readonly signal?: AbortSignal }
) => Promise<PageAnswer>;

/**
 * **THE QUIET FORM: ONE REQUEST WHOSE ANSWER THE CALLER READS ITSELF** (`pageFetch`), saying it was prepared for the
 * person `signedInAs` names. Any status comes back with its body and nothing is told to the sign-in this tab holds, so a
 * 401 signs nothing out; a read is not bounded or tried again; a request that got no answer is `ServiceNotReached`.
 */
export const serviceAnswered =
  (signedInAs: () => string | null): PageSend =>
  (path, init) =>
    pageFetch(
      path,
      {
        method: init.method,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal })
      },
      signedInAs()
    );
