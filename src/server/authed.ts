import type express from 'express';
import {
  SIGNED_IN_AS_HEADER, anotherPersonRefusal, clearedSessionCookie, credentialOf, crossSiteWriteRefusal,
  sessionCookie, type CookieScope,
} from './session-cookie.js';
import { CouldNotCheck, NoSuchUser } from '../core/identity.js';
import { appendRefusal } from './refusal-log.js';

/** The one code a 401 carries for every state of a token. Which state it was goes to the refusal log only. */
export const SESSION_NOT_VALID = 'session-not-valid';

const USER_ID_LOGGED_CHARS = 8;

/** What a 503 from the sign-in check says: a failure to look, never an answer about the person. */
export const COULD_NOT_CHECK = {
  code: 'could-not-check',
  error: 'the service could not check your sign-in. You are still signed in; nothing was changed. Try again in a moment.',
  retryAfterSeconds: 2,
} as const;

/**
 * The gate every signed-in route goes through. Only a definite "no such live session" or "no such
 * person" answers 401, which is what makes a page sign the person out. Every 401 says "not signed in".
 * Its `code` names a cause only where the caller already knows it from its own request (`no-credential`,
 * `two-session-cookies`); every state of a token (revoked, never issued or run out, a person this service
 * does not hold) is the one code `session-not-valid`, so a token holder learns nothing about the token.
 * The service writes the real cause (never the token) to its refusal log. A failure to look (the
 * database unreachable, slow, dropped, out of connections) answers 503 `could-not-check`.
 * A session that is running low is renewed here, and a cookie-borne one gets its cookie renewed too.
 */
export const authedBy = (deps: {
  readonly identity: {
    verify(token: string): Promise<string>;
    renew(token: string): Promise<string | null>;
  };
  readonly cookieScope: CookieScope;
  readonly appOrigin: () => string | undefined;
}): express.RequestHandler => async (req, res, next) => {
  const credential = credentialOf(req.headers);
  const refusal = crossSiteWriteRefusal({
    method: req.method,
    via: credential.via,
    origin: req.headers.origin,
    fetchSite: req.headers['sec-fetch-site'] as string | undefined,
  }, deps.appOrigin());
  if (refusal !== null) {
    res.status(403).json({ error: refusal });
    return;
  }
  const refused = (cause: string, person?: string): void => {
    appendRefusal(req.method, req.baseUrl + req.path, 401, cause,
      person === undefined ? 'not signed in' : `not signed in (person ${person.slice(0, USER_ID_LOGGED_CHARS)})`);
  };
  if (credential.via === 'none') {
    refused(credential.why);
    res.status(401).json({ error: 'not signed in', code: credential.why });
    return;
  }
  let userId: string;
  try {
    userId = await deps.identity.verify(credential.token);
  } catch (e: any) {
    if (e instanceof CouldNotCheck) {
      res.setHeader('Retry-After', String(COULD_NOT_CHECK.retryAfterSeconds));
      res.status(503).json({
        error: COULD_NOT_CHECK.error, code: COULD_NOT_CHECK.code, retryAfterSeconds: COULD_NOT_CHECK.retryAfterSeconds,
      });
      return;
    }
    if (e instanceof NoSuchUser && credential.via === 'cookie') {
      res.setHeader('Set-Cookie', clearedSessionCookie(deps.cookieScope));
    }
    refused(e?.code ?? 'session-unknown-or-expired', e instanceof NoSuchUser ? e.userId : undefined);
    res.status(401).json({ error: e?.message ?? 'not signed in', code: SESSION_NOT_VALID });
    return;
  }

  const another = anotherPersonRefusal(req.headers[SIGNED_IN_AS_HEADER], userId);
  if (another !== null) {
    res.status(409).json({ error: another, code: 'another-person' });
    return;
  }
  const renewedTo = await deps.identity.renew(credential.token);
  if (renewedTo !== null && credential.via === 'cookie') {
    res.setHeader('Set-Cookie', sessionCookie(credential.token, renewedTo, deps.cookieScope));
  }
  req.userId = userId;
  next();
};
