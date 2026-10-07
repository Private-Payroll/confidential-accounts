import { askWalletToSignIn, openWalletDialog, WalletClosed, type WalletDialog } from 'vaults-web-shared/wallet-sign-in.js';
import { closeWalletFrame, mountWalletFrame, onWalletFrame, walletFrameShown, walletInThisPage, WALLET_FRAME_ALLOW } from 'vaults-web-shared/wallet-frame.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import { keepSignIn } from './kept-sign-in.js';
import { tabStorage } from './kept-skips.js';

/*
 * The shared keyring, loaded after the service's first answer rather than
 * with the page, so the first download does not carry the code that opens a
 * company.
 */
const keyring = () => import('vaults-web-shared/keyring.js');


/*
 * WHO IS SIGNED IN, SIGNING IN WITH THE PERSON'S ACCOUNT, AND SIGNING OUT.
 *
 * Signing in is three steps and no password: this service hands over a
 * one-time challenge, the person's account signs it in its own screen, shown
 * in a frame on this page, and the service checks the signature and sets its
 * sign-in cookie, which this page cannot read. The shared code does the talk
 * with the account (`openWalletDialog`, `askWalletToSignIn`); this file does
 * the talk with the service, and keeps nothing but who is signed in.
 *
 * IT OPENS NO COMPANY AND HOLDS NO KEY. The keys that open a company's records
 * are released by the account separately and are not asked for here. What a
 * sign-in leaves in the tab is the person's id, sent with every request, so a
 * sign-in as somebody else in another tab is refused by the service rather
 * than acted on under the wrong person.
 *
 * THE SHARED KEYRING IS TOLD WHO SIGNED IN, AND FORGETS WHEN THEY GO. Creating
 * or opening a company is the keyring's work, and it saves a person's first
 * keys only under the account that holds the address they signed in as; so
 * the service's answer to the sign-in is handed to it as it came back, and
 * who signed in and the address it was for are kept in this tab
 * (`kept-sign-in.ts`), so a reload can hand the address back. When the person
 * signs out, or the service says nobody or somebody else is signed in now,
 * the keyring forgets this tab's keys and what was kept goes too.
 *
 * None of the service's or the shared code's words are handed on: a screen is
 * handed a reason, one of a fixed set, and says it in its own phrases.
 */

/** The service's addresses and the words of its protocol, never shown. */
const SERVICE = {
  challenge: '/api/auth/wallet/challenge',
  signIn: '/api/auth/wallet',
  me: '/api/me',
  signOut: '/api/auth/logout',
  post: 'POST',
  sameOrigin: 'same-origin',
  contentType: 'content-type',
  json: 'application/json',
  signedInAs: 'x-signed-in-as',
  anotherPerson: 'another-person',
  mixedRecords: 'records-from-more-than-one-ledger',
  staleChallenge: 'stale-challenge',
  expiredClaim: 'expired-claim',
  rdns: 'social.lemonade.confidential-accounts',
} as const;

/** Where the person's account is served, set when the page is built. Empty when it is not set. */
export const ACCOUNT_ORIGIN = (import.meta.env.VITE_WALLET_ORIGIN ?? '').replace(/\/+$/, '');

/** A person signed in. */
export interface Person {
  id: string;
  /** Their name, as their account gave it. */
  name: string;
}

/** A company the person signs for, as the service lists it: its name is sealed, and opens only with the person's account. */
export interface Company {
  id: string;
  /** When it was made, as the service wrote it. */
  createdAt: string;
  /** How many sign for it. Public, as the chain publishes it. */
  signers: number;
  /** How many of them must approve. Public, as the chain publishes it. */
  approvalsNeeded: number;
}

/**
 * WHY SIGNING IN DID NOT HAPPEN, one of a fixed set a screen says in its own
 * words: the page was built without the account's address; no account window
 * could be shown, or it went; the person declined, or the request expired; the
 * account did not answer; the person stopped waiting; the account could not
 * finish; the service refused the signature; too many tries; the service
 * cannot sign anyone in; the service could not be reached.
 */
export const REFUSAL = {
  notSetUp: 'not-set-up', noWindow: 'no-window', windowGone: 'window-gone', declined: 'declined', expired: 'expired',
  silent: 'silent', gaveUp: 'gave-up', didNotFinish: 'did-not-finish', refused: 'refused', tooMany: 'too-many',
  unavailable: 'unavailable', unreachable: 'unreachable',
} as const;

export type SignInRefusal = (typeof REFUSAL)[keyof typeof REFUSAL];

/** What an answer from this file is. */
export const OF = {
  signedIn: 'signed-in', refused: 'refused', recordsApart: 'records-apart', nobody: 'nobody', unreachable: 'unreachable',
  signedOut: 'signed-out', notConfirmed: 'not-confirmed',
} as const;

export type SignedIn =
  | { of: typeof OF.signedIn; person: Person; firstTime: boolean }
  | { of: typeof OF.refused; why: SignInRefusal; retryAfterSeconds: number | null };

/** Who is signed in, found when the page loads. */
export type WhoIsSignedIn =
  | { of: typeof OF.signedIn; person: Person; companies: readonly Company[] }
  /** Signed in, but the service will not list their companies together: some were written on a chain and some were not. */
  | { of: typeof OF.recordsApart }
  | { of: typeof OF.nobody }
  | { of: typeof OF.unreachable };

/** The one person this tab was prepared for, sent with every request. */
let prepared: string | null = null;

/** Ask the service; a failure to reach it is `null`. */
async function ask(path: string, method?: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const headers: Record<string, string> = { [SERVICE.contentType]: SERVICE.json };
  if (prepared !== null) headers[SERVICE.signedInAs] = prepared;
  let r: Response;
  try {
    r = await fetch(path, { method, credentials: SERVICE.sameOrigin, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return null;
  }
  const answer = await r.json().catch(() => ({})) as unknown;
  return { status: r.status, body: (answer !== null && typeof answer === 'object' ? answer : {}) as Record<string, unknown> };
}

const personFrom = (user: unknown): Person | null => {
  const u = (user ?? {}) as { id?: unknown; name?: unknown };
  return typeof u.id === 'string' && typeof u.name === 'string' ? { id: u.id, name: u.name } : null;
};

/** The service's rows, each read for what may be shown without opening it; a row that is not one is left out. */
export function companiesFrom(rows: unknown): Company[] {
  if (!Array.isArray(rows)) return [];
  const out: Company[] = [];
  for (const row of rows as unknown[]) {
    const r = (row ?? {}) as { id?: unknown; createdAt?: unknown; signerCount?: unknown; threshold?: unknown };
    if (typeof r.id !== 'string' || typeof r.createdAt !== 'string' || !Number.isSafeInteger(r.signerCount) || !Number.isSafeInteger(r.threshold)) continue;
    out.push({ id: r.id, createdAt: r.createdAt, signers: r.signerCount as number, approvalsNeeded: r.threshold as number });
  }
  return out;
}

/**
 * WHO IS SIGNED IN, asked of the service: the sign-in cookie is the browser's,
 * and this page cannot read it. When somebody else has since signed in, in
 * another tab of this browser, the service refuses a request made for the
 * person this tab was prepared for; the tab then asks again for whoever is
 * signed in now, and is prepared for them.
 */
export async function whoIsSignedIn(): Promise<WhoIsSignedIn> {
  let r = await ask(SERVICE.me);
  if (r !== null && r.status === 409 && r.body.code === SERVICE.anotherPerson) { prepared = null; r = await ask(SERVICE.me); }
  if (r === null) return { of: OF.unreachable };
  if (r.status === 401) { prepared = null; keepSignIn(tabStorage(), null); (await keyring()).forgetLocally(); return { of: OF.nobody }; }
  if (r.status === 409 && r.body.code === SERVICE.mixedRecords) return { of: OF.recordsApart };
  const person = r.status === 200 ? personFrom(r.body.user) : null;
  if (person === null) return { of: OF.unreachable };
  prepared = person.id;
  /* The keyring holds keys for one person; a tab now signed in as somebody else drops them. */
  const { currentUser, forgetLocally } = await keyring();
  if (currentUser()?.id !== person.id) forgetLocally();
  listed = { person: person.id, rows: Array.isArray(r.body.accounts) ? r.body.accounts as unknown[] : [] };
  return { of: OF.signedIn, person, companies: companiesFrom(r.body.accounts) };
}

/** The service's rows of the one list of companies, as last asked for, and whom they were listed for. Each row's name is sealed. */
let listed: { person: string; rows: readonly unknown[] } = { person: '', rows: [] };

/**
 * THE NAME OF EACH COMPANY IN THE ONE LIST, by id, opened with the keys saved
 * for the person. A company this tab cannot open has none, and so does every
 * company when the list was asked for somebody else. The list is not asked
 * for again: it is the one `whoIsSignedIn` read. The keyring may ask the
 * service who is signed in, when it does not know yet.
 */
export async function companyNamesFor(personId: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  try {
    if (listed.person !== personId) return out;
    const [{ keyringFor }, { openedHere }] = await Promise.all([import('./keyring-person.js'), import('./filing-judge.js')]);
    if (!(await keyringFor(personId))) return out;
    for (const row of listed.rows) {
      /* A company whose roster this device does not believe has no name shown, and the others are still read. */
      let opened: Awaited<ReturnType<typeof openedHere>> = null;
      try { opened = await openedHere(row as SealedAccount); } catch { opened = null; }
      if (opened !== null && typeof opened.name === 'string') out.set(opened.id, opened.name);
    }
  } catch { /* a name not opened is not shown */ }
  return out;
}

/** What the account is told about who is asking. The account shows these as the asker's own words, beside the address it saw. */
export interface Asking {
  name: string;
  purpose: string;
}

/** The dialog open for a sign-in in flight, so the person can stop waiting for it. */
let inFlight: WalletDialog | null = null;
const waiting = new Set<(waitingNow: boolean) => void>();
const nowWaiting = (dialog: WalletDialog | null): void => { inFlight = dialog; for (const w of waiting) w(dialog !== null); };

/** Follow whether a sign-in is waiting on the person's account; returns the way to stop. */
export function onWaiting(watch: (waitingNow: boolean) => void): () => void {
  waiting.add(watch);
  return () => { waiting.delete(watch); };
}

/** Stop waiting: the account is put away and the sign-in in flight refuses. With nothing in flight, the account is put away. */
export function stopWaiting(): void {
  if (inFlight !== null) inFlight.giveUp();
  else closeWalletFrame();
}

const refusalOf = (e: unknown): SignInRefusal => {
  if (!(e instanceof WalletClosed)) return REFUSAL.didNotFinish;
  switch (e.refusal.of) {
    case 'declined': return REFUSAL.declined;
    case 'expired': return REFUSAL.expired;
    case 'no-wallet-tab': return REFUSAL.noWindow;
    case 'window-gone': return REFUSAL.windowGone;
    case 'gave-up': return REFUSAL.gaveUp;
    case 'silent': return REFUSAL.silent;
    default: return REFUSAL.didNotFinish;
  }
};

/**
 * SIGN IN WITH THE PERSON'S ACCOUNT.
 *
 * THE CHALLENGE IS ASKED FOR FIRST, AND THE ACCOUNT SHOWN AFTER. The account
 * says once, as it loads, that it is listening, and the shared code starts
 * listening only when it asks; an account shown before the challenge came back
 * could say so before anyone was listening, and the sign-in would then wait
 * out its whole deadline. The account is shown in a frame on this page, which
 * a browser lets a page do at any time, not only in the press of a button.
 */
export async function signIn(asking: Asking): Promise<SignedIn> {
  if (ACCOUNT_ORIGIN === '') return { of: OF.refused, why: REFUSAL.notSetUp, retryAfterSeconds: null };
  const refused = (why: SignInRefusal, retryAfterSeconds: number | null = null): SignedIn => ({ of: OF.refused, why, retryAfterSeconds });
  prepared = null;
  const challenge = await ask(SERVICE.challenge, SERVICE.post);
  if (challenge === null) return refused(REFUSAL.unreachable);
  if (challenge.status === 429) return refused(REFUSAL.tooMany, retryAfter(challenge.body));
  if (challenge.status !== 200) return refused(REFUSAL.unavailable);
  const { handle, nonce, expiresAt } = challenge.body as { handle?: unknown; nonce?: unknown; expiresAt?: unknown };
  if (typeof handle !== 'string' || typeof nonce !== 'string' || typeof expiresAt !== 'string') return refused(REFUSAL.unavailable);

  const view = walletInThisPage(window);
  const dialog = openWalletDialog(view, ACCOUNT_ORIGIN);
  nowWaiting(dialog);
  try {
    let response: unknown;
    try {
      response = await askWalletToSignIn(view, ACCOUNT_ORIGIN, {
        nonce, expiresAt: Date.parse(expiresAt), name: asking.name, rdns: SERVICE.rdns, purpose: asking.purpose,
      }, dialog);
    } catch (e) {
      return refused(refusalOf(e));
    }
    const answer = await ask(SERVICE.signIn, SERVICE.post, { handle, nonce, response });
    if (answer === null) return refused(REFUSAL.unreachable);
    if (answer.status === 429) return refused(REFUSAL.tooMany, retryAfter(answer.body));
    if (answer.status === 401) return refused(answer.body.code === SERVICE.staleChallenge || answer.body.code === SERVICE.expiredClaim ? REFUSAL.expired : REFUSAL.refused);
    const person = answer.status === 200 ? personFrom(answer.body.user) : null;
    if (person === null) return refused(REFUSAL.unavailable);
    prepared = person.id;
    /*
     * The keyring takes the answer as its own sign-in would. An answer it will
     * not take (no address in it) leaves it knowing nobody: this tab is still
     * signed in, and a company is opened only once the keyring has picked the
     * sign-in up from the service, as a reloaded tab does; a person's first
     * company cannot be created that way, and they are asked to sign in again.
     */
    /* Whatever the keyring held for somebody else is dropped first, a company they left unfinished included. */
    const { currentUser, forgetLocally, signedInByAnotherScreen } = await keyring();
    if (currentUser()?.id !== person.id) forgetLocally();
    keepSignIn(tabStorage(), null);
    try {
      signedInByAnotherScreen(answer.body);
      /* Kept only once the keyring has taken it, so what is kept is what the keyring holds. */
      keepSignIn(tabStorage(), { personId: person.id, address: answer.body.address as string });
    } catch { forgetLocally(); }
    return { of: OF.signedIn, person, firstTime: answer.body.created === true };
  } finally {
    /* However it ended, the account is put away: an ask that finished has closed it already, and a second close is not a second event. */
    dialog.giveUp();
    nowWaiting(null);
  }
}

const retryAfter = (body: Record<string, unknown>): number | null =>
  Number.isSafeInteger(body.retryAfterSeconds) ? body.retryAfterSeconds as number : null;

/** Whether signing out worked: the service ended the sign-in, or could not be reached and the sign-in may still be live. */
export type SignedOut = { of: typeof OF.signedOut } | { of: typeof OF.notConfirmed };

/**
 * SIGN OUT: the service ends the sign-in and clears its cookie. This tab
 * forgets the person and the keyring forgets their keys however the service
 * answers, so a screen that goes on to show nobody signed in is never showing
 * it over keys still open.
 */
export async function signOut(): Promise<SignedOut> {
  const r = await ask(SERVICE.signOut, SERVICE.post);
  prepared = null;
  keepSignIn(tabStorage(), null);
  (await keyring()).forgetLocally();
  return r !== null && (r.status === 200 || r.status === 401) ? { of: OF.signedOut } : { of: OF.notConfirmed };
}


/** THE FRAME THE PERSON'S ACCOUNT IS SHOWN IN, handed to the shared code once, when it is on the page. */
export const accountFrame = {
  mount: mountWalletFrame,
  close: closeWalletFrame,
  onShown: onWalletFrame,
  shown: walletFrameShown,
  allow: WALLET_FRAME_ALLOW,
} as const;
