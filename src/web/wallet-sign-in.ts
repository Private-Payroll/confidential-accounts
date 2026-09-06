import { READY_PING } from 'midnight-identity/profile/channel';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import { signInAsk } from '../core/wallet-sign-in-ask.js';

/**
 * OPENING THE WALLET AND ASKING WHO YOU ARE — the browser half.
 * `docs/scope-payroll-identity.md` §4, `docs/NEXT.md` PI1 §2.
 *
 * ── WHY THIS IS NOT THE CONNECTOR ─────────────────────────────────────────
 *
 * `@midnightntwrk/dapp-connector-api` is INJECTED — *"Wallets inject their
 * Initial API under the `window.midnight` object"* — and injecting into another
 * origin's page is what a browser EXTENSION does. There is no extension.
 * `src/web/connector-wallet.ts` stays for anybody who does have one; it is not
 * the path for our wallet, and this file is the other case. §4.
 *
 * ── WHAT THIS FILE DOES AND DOES NOT DECIDE ───────────────────────────────
 *
 * **IT VERIFIES NOTHING.** The signature is checked on the server, because the
 * server is what mints a session and a check made by the thing being persuaded
 * is not a check. What happens here is the plumbing: open the wallet, wait for
 * it to say it is listening, send one ask, and take one answer.
 *
 * **AND SO IT MUST NOT IMPORT THE THING THAT DOES.** This line
 * read `from '../core/wallet-identity.js'` and that one word is what left the
 * payroll page blank in every real browser: the service verifies, so it reaches
 * the wallet SDK, so it reaches `ledger-v9`, so the page was loading ten
 * megabytes of WebAssembly to build a small JSON object. The ask now lives in
 * `src/core/wallet-sign-in-ask.ts`, which imports one constant and nothing else.
 * `no-wasm-in-the-page.test.ts` is what keeps it that way.
 *
 * **THE ONE JUDGEMENT IT DOES MAKE IS THE ORIGIN**, and only in the narrow
 * sense of refusing to listen to anybody else. `MessageEvent.origin` is filled
 * in by the browser and no page can write it — the same property the wallet
 * relies on, pointing the other way — so an answer from any origin but the
 * wallet's is dropped rather than forwarded. This does not make the sign-in
 * true; it stops the page carrying somebody else's message to the server.
 *
 * ── THE NONCE COMES FROM OUR SERVER AND FROM NOWHERE ELSE ─────────────────
 *
 * Not from the URL, not from a query string, not from anything a link can
 * carry. A page that would sign in over a nonce somebody else chose is a page
 * that can be made to sign somebody else in as this person, and the handle
 * beside it — which never leaves this origin — is the mechanism that makes
 * that a refusal rather than a convention.
 */

/** How long to wait for the wallet to say it is listening, and then to answer. */
export const READY_TIMEOUT_MS = 20_000;
export const ANSWER_TIMEOUT_MS = 5 * 60_000;

export type WalletRefusal =
  | { readonly of: 'declined' }
  | { readonly of: 'expired' }
  | { readonly of: 'no-wallet-tab' }
  | { readonly of: 'gave-up' }
  | { readonly of: 'silent' };

export class WalletClosed extends Error {
  readonly refusal: WalletRefusal;

  constructor(refusal: WalletRefusal, message: string) {
    super(message);
    this.name = 'WalletClosed';
    this.refusal = refusal;
  }
}

export interface AskedFor {
  readonly nonce: string;
  readonly expiresAt: number;
  /** The requester's own words about itself. Untrusted by the wallet, shown as text. */
  readonly name: string;
  readonly rdns: string;
  readonly purpose: string;
}

/**
 * WHAT THIS SIDE NEEDS OF THE WINDOW IT OPENED, and nothing more.
 *
 * `Window` satisfies it. It is written out rather than borrowed so a test can
 * drive the whole conversation with an object, and so the three things `C154`
 * added — bring it forward, close it, notice it has gone — are named here
 * rather than assumed of a global.
 */
export interface WalletWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  focus?(): void;
  close?(): void;
  readonly closed?: boolean;
}

export interface Openable {
  open(url: string, target: string, features?: string): WalletWindow | null;
  addEventListener(type: 'message', handler: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (e: MessageEvent) => void): void;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /**
   * WHERE THE PAGE THAT IS ASKING SITS ON THE SCREEN, so the dialog can be put
   * in front of it rather than in a corner of the display. Optional because a
   * test has no screen and must not have to invent one.
   */
  readonly screenX?: number;
  readonly screenY?: number;
  readonly outerWidth?: number;
  readonly outerHeight?: number;
}

/* ------------------------------------------------------------------------ *
 * THE DIALOG.
 * ------------------------------------------------------------------------ */

/**
 * **ONE NAME, SO A SECOND ASK REUSES THE WINDOW RATHER THAN STACKING ONE.**
 *
 * `window.open` treats its second argument as the target's NAME: opening again
 * with the same name reaches the window already on screen and navigates it,
 * instead of leaving a person with two wallets open and no way to tell which
 * one the page is talking to.
 */
export const WALLET_DIALOG_NAME = 'midnight-wallet';

/** Tall and narrow, because everything on the wallet's screen is a column. */
export const WALLET_DIALOG_SIZE = { width: 460, height: 760 } as const;

/**
 * **THE ASK COUNTER IS WHAT MAKES THE SECOND ASK ARRIVE AT ALL.**
 *
 * The wallet's channel answers ONE request per load and ignores a second, so a
 * reused window has to be RE-NAVIGATED rather than merely focused — otherwise
 * the second ask reaches a page that has already settled and nothing comes
 * back. A browser does not reload a window whose URL is unchanged, and a hash
 * is not a navigation, so the URL carries a number that goes up. It says
 * nothing about anybody: it is a counter in one tab's memory.
 */
let asks = 0;

const dialogUrl = (walletOrigin: string): string =>
  `${walletOrigin}/?ask=${asks += 1}#/approve`;

/** `popup` is what makes it a window rather than a tab. Nothing else does. */
const featuresFor = (view: Openable): string => {
  const { width, height } = WALLET_DIALOG_SIZE;
  const ownerX = typeof view.screenX === 'number' ? view.screenX : 0;
  const ownerY = typeof view.screenY === 'number' ? view.screenY : 0;
  const ownerWidth = typeof view.outerWidth === 'number' ? view.outerWidth : width;
  const ownerHeight = typeof view.outerHeight === 'number' ? view.outerHeight : height;
  /*
   * Centred across the page that opened it and a third of the way down rather
   * than half, because a dialog sitting dead centre of a tall screen reads as
   * further away from the button that was just pressed than one slightly high.
   */
  const left = Math.max(0, Math.round(ownerX + (ownerWidth - width) / 2));
  const top = Math.max(0, Math.round(ownerY + (ownerHeight - height) / 3));
  /*
   * **`noopener` IS NOT SET HERE AND MUST NEVER BE.** It is the one feature
   * that would break this: it withholds the handle this side needs and, worse,
   * `window.opener` on the wallet's side — which is the ONLY thing the wallet
   * has to answer through, and the thing its channel checks the message came
   * from. A feature list is parsed by name, so writing it as `noopener=0` is
   * not a safe way of saying no. It is absent.
   */
  return `popup=1,width=${width},height=${height},left=${left},top=${top}`;
};

/**
 * **THE WINDOW, OPENED WHILE THE CLICK IS STILL BEING HANDLED.**
 *
 * A browser only lets a page open a window while it is handling a person's
 * press. Both wallet paths used to spend that permission on a round trip to
 * this product's own server and then try to open a window with it gone —
 * which Chromium forgives for a few seconds and Safari and Firefox do not, so
 * signing in with a wallet failed outright in browsers nobody had tried, and a
 * slow answer broke it everywhere.
 *
 * So this is separate from `askWallet` and is called FIRST, before anything is
 * awaited. It points at a waiting screen the wallet serves; the ask is posted
 * into the window that is already open once the server has answered.
 *
 * **AND THE PERSON CAN STOP WAITING.** `giveUp` closes the dialog and makes
 * the ask in flight refuse, because a page that offers no way out of a wait is
 * a page people press again.
 */
export interface WalletDialog {
  /** `null` when the browser would not open it. */
  readonly wallet: WalletWindow | null;
  /** Close it and refuse whatever is in flight. Safe to call twice. */
  giveUp(): void;
  /** What `askWallet` runs when the person gives up. One at a time. */
  onGiveUp(run: () => void): void;
}

export function openWalletDialog(view: Openable, walletOrigin: string): WalletDialog {
  const wallet = view.open(dialogUrl(walletOrigin), WALLET_DIALOG_NAME, featuresFor(view));
  /*
   * ALREADY THERE. When the name matched a window this page had open, the
   * browser handed back that same window rather than a new one — so bring it
   * forward. Without this a second ask is answered by a wallet sitting behind
   * the page that asked, and nothing appears to have happened.
   */
  wallet?.focus?.();

  let over = false;
  let onCancel: (() => void) | null = null;
  return {
    wallet: wallet ?? null,
    giveUp(): void {
      if (over) return;
      over = true;
      /* **ONE CLOSE, NOT TWO.** When an ask is in flight, `askWallet`'s own
       * settling is what closes the window — closing it here as well would
       * put a dialog away twice, and the second is a `close()` on a window
       * that is already gone. With nothing in flight there is nobody else to
       * do it. */
      if (onCancel) onCancel(); else wallet?.close?.();
    },
    onGiveUp(run: () => void): void {
      onCancel = run;
      if (over) run();
    },
  };
}

/**
 * **WHAT IS SAID WHEN NO WINDOW OPENED, AND WHOSE FAULT IT NAMES.**
 *
 * It read *"your browser stopped this page opening your wallet. Allow pop-ups
 * for this site"*, which is advice for a problem the person does not have: the
 * usual reason a window does not open is that this page spent the permission
 * before it used it. Telling somebody to change a browser setting they never
 * changed sends them somewhere there is nothing to find.
 */
const NO_WINDOW_SAYS =
  'your wallet window did not open, so nothing has been signed and nothing has been sent. '
  + 'Press the button again. A window can only be opened at the moment a button is '
  + 'pressed, so this is something this page has to get right rather than a setting for '
  + 'you to change.';

const GAVE_UP_SAYS =
  'you stopped waiting for your wallet. Nothing was signed, nothing was released, and '
  + 'nothing has changed here.';

/**
 * OPEN THE WALLET, ASK ONCE, TAKE ONE ANSWER.
 *
 * `view` is the window rather than a global so the whole conversation can be
 * driven in a test with no browser — the wallet's own `channel.ts` is shaped
 * the same way and for the same reason.
 *
 * **THE ASK IS SENT TO THE WALLET'S ORIGIN AND NEVER TO `'*'`.** The ready ping
 * that arrives first may be sent to `'*'` — it carries one constant string and
 * nothing else, which is exactly why that is safe for the wallet to do — but
 * what goes back names the origin it is for, so a tab that navigated somewhere
 * else between opening and answering receives nothing.
 */
export function askWalletToSignIn(
  view: Openable, walletOrigin: string, ask: AskedFor, dialog?: WalletDialog,
): Promise<DisclosureResponse> {
  return askWallet(view, walletOrigin, signInAsk({
    name: ask.name, rdns: ask.rdns, purpose: ask.purpose,
    nonce: ask.nonce, expiresAt: ask.expiresAt,
  }), dialog) as Promise<DisclosureResponse>;
}

/**
 * **ONE PLUMBING, TWO ASKS.**
 *
 * Everything below is what `askWalletToSignIn` was, with the ask it sends
 * passed in rather than built inside. `PI2a` needed the identical conversation
 * for an `unlock` — open the wallet, wait for it to say it is listening, send
 * one ask, take one answer — and a second copy of it is a second place for the
 * origin check to drift. **The one judgement it makes is still the origin**,
 * and still only in the narrow sense of refusing to listen to anybody else.
 *
 * **IT STILL JUDGES NOTHING ABOUT THE ANSWER**, which is why the return type is
 * `unknown`. For a sign-in the server decides, because the server is what mints
 * a session. For an unlock **the browser decides, because the key never reaches
 * the server at all** — and `readRelease` is where that happens, in
 * `wallet-unlock.ts`, one layer up from here.
 *
 * **`dialog` IS THE WINDOW THE CLICK OPENED**, and every path that a person
 * starts passes one. The default is here for a caller with no click to be in —
 * a test, or a retry that is already inside one — and it is the shape `C154`
 * is about, so anything reaching for it should be sure it is not simply the old
 * order wearing a new name.
 */
export function askWallet(
  view: Openable, walletOrigin: string, message: unknown,
  dialog: WalletDialog = openWalletDialog(view, walletOrigin),
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const opened = dialog.wallet;
    if (!opened) {
      reject(new WalletClosed({ of: 'no-wallet-tab' }, NO_WINDOW_SAYS));
      return;
    }
    /* Typed rather than narrowed: `onMessage` below is a hoisted declaration
     * and a narrowing made after it does not reach inside one. */
    const wallet: WalletWindow = opened;

    let done = false;
    let timer = view.setTimeout(() => stop(new WalletClosed(
      { of: 'silent' },
      'your wallet did not answer. It may not have finished loading, or the window may have '
      + 'been closed before it could.')), READY_TIMEOUT_MS);

    const stop = (err?: Error): void => {
      if (done) return;
      done = true;
      view.clearTimeout(timer);
      view.removeEventListener('message', onMessage);
      /*
       * **CLOSED WHEN THE ANSWER ARRIVES OR THE ASK IS REFUSED.** A dialog this
       * page opened is this page's to put away: leaving it up after the
       * conversation is over is how a person ends up looking at a wallet
       * screen that is no longer about anything, and pressing it.
       */
      wallet.close?.();
      if (err) reject(err);
    };

    dialog.onGiveUp(() => stop(new WalletClosed({ of: 'gave-up' }, GAVE_UP_SAYS)));

    function onMessage(event: MessageEvent): void {
      if (done) return;
      /*
       * THE BROWSER'S VALUE, NOT THE MESSAGE'S. Anything from another origin —
       * an extension, a frame, a page that merely has a handle on this window —
       * is not the conversation this page opened.
       */
      if (event.origin !== walletOrigin) return;
      if (event.source !== (wallet as unknown as MessageEventSource)) return;
      const body = (event.data ?? null) as { schema?: unknown; reason?: unknown } | null;
      if (body === null || typeof body !== 'object') return;

      if (body.schema === READY_PING) {
        view.clearTimeout(timer);
        timer = view.setTimeout(() => stop(new WalletClosed(
          { of: 'silent' },
          'your wallet was opened but nothing came back. Nothing has been signed.')),
        ANSWER_TIMEOUT_MS);
        wallet.postMessage(message, walletOrigin);
        return;
      }

      if (body.schema === 'midnight-identity/disclosure-refused/v1') {
        const reason = body.reason === 'expired' ? 'expired' : 'declined';
        stop(new WalletClosed(
          { of: reason },
          reason === 'expired'
            ? 'the request had expired by the time it reached your wallet. Try again.'
            : 'you did not approve it in your wallet, so nothing was signed, nothing was '
              + 'released, and nothing has changed here.'));
        return;
      }

      /*
       * ANYTHING ELSE FROM THE WALLET IS THE ANSWER, and it is handed on
       * WITHOUT BEING JUDGED. There is no shape check here on purpose: a check
       * in the browser would be a second opinion about what is acceptable, and
       * the server's is the only one that decides anything. A malformed answer
       * has to be refused where the session would otherwise be minted.
       */
      const answer = event.data as unknown;
      stop();
      resolve(answer);
    }

    view.addEventListener('message', onMessage);
  });
}
