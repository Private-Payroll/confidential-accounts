/**
 * **WHAT THE PERSON SIGNED IN ASKS OF THE SERVICE FOR THEMSELF**, and the paths each ask is sent to, before and beside
 * any company's view. Kept apart from the company's records (`records-source.ts`) so a page that only signs a person in
 * and asks who is signed in does not load the records' own code.
 */

/** The path that answers who is signed in now. */
export const WHO_IS_SIGNED_IN = '/api/me';

/** A request as a page's asks send it: a path, and how to ask it. */
export type PathAsk<R> = (path: string, init?: { readonly method?: 'GET' | 'PUT' | 'POST'; readonly body?: string; readonly signal?: AbortSignal }) => Promise<R>;

/**
 * What the person signed in asks of the service for themself, before and beside any company's view: their sign-in (its
 * challenge, the wallet's answer to it, who is signed in now, its end), their sessions, their saved keys, the companies
 * they belong to, and the name of one of them for their wallet to check. Each answers as `call` does.
 */
export interface PersonAsks<R> {
  challenge(): Promise<R>;
  signIn(answer: unknown): Promise<R>;
  me(signal?: AbortSignal): Promise<R>;
  signOut(): Promise<R>;
  sessions(): Promise<R>;
  endSession(session: string): Promise<R>;
  endOtherSessions(): Promise<R>;
  savedKeys(): Promise<R>;
  keepSavedKeys(kept: unknown): Promise<R>;
  companies(): Promise<R>;
  companyNamed(company: string): Promise<R>;
}

/** How an ask that posts is sent: as a POST, with `body` as its JSON when there is one. */
export const posted = (body?: unknown) => ({ method: 'POST' as const, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** The person's own asks, through `call`. */
export const personAsks = <R>(call: PathAsk<R>): PersonAsks<R> => Object.freeze<PersonAsks<R>>({
  challenge: () => call('/api/auth/wallet/challenge', posted()),
  signIn: (answer) => call('/api/auth/wallet', posted(answer)),
  me: (signal) => call(WHO_IS_SIGNED_IN, signal === undefined ? undefined : { method: 'GET', signal }),
  signOut: () => call('/api/auth/logout', posted()),
  sessions: () => call('/api/me/sessions'),
  endSession: (session) => call(`/api/me/sessions/${session}/revoke`, posted()),
  endOtherSessions: () => call('/api/me/sessions/others/revoke', posted()),
  savedKeys: () => call('/api/me/keys'),
  keepSavedKeys: (kept) => call('/api/me/keys', { method: 'PUT', body: JSON.stringify(kept) }),
  companies: () => call('/api/accounts'),
  companyNamed: (company) => call(`/api/accounts/${company}/unlock`, posted()),
});
