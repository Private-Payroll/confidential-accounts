import type { Openable, WalletWindow } from './wallet-sign-in.js';

/**
 * **THE WALLET, SHOWN INSIDE THIS PAGE RATHER THAN IN A WINDOW OF ITS OWN.**
 *
 * The wallet and this application are two origins under one site. A frame of
 * one inside the other shares the wallet's real storage - the passkey and the
 * sealed keys are there - so the person meets their own wallet in place, with
 * no second window to find and nothing for a browser's pop-up rules to block.
 *
 * **WHAT THIS FILE IS: the `Openable` the wallet asks already speak to.**
 * `openWalletDialog` calls `open(url, name, features)` and posts into whatever
 * comes back; here `open` points the one frame at that address and hands back a
 * handle whose messages arrive from the frame's window and whose `close` hides
 * and empties it. Nothing above this file had to learn that the window became
 * a frame.
 *
 * **WHAT THIS FILE IS NOT: the check on who may talk to whom.** The wallet
 * answers only its parent at the one origin it was built for; a
 * `frame-ancestors` header naming that origin keeps strangers from framing it
 * wherever the serving host sends one; and its approval screen holds a press
 * until the frame is large enough, showing, and the request has been read. A
 * frame with fewer than all three is worse than the window it replaces, which is
 * why they arrive together.
 */

/**
 * **THE ONLY PERMISSION THE FRAME IS GIVEN: TO USE A PASSKEY.** A browser refuses
 * `navigator.credentials` inside a frame unless the page around it delegates
 * it, and delegates it by name. Written without an origin, each applies to the
 * frame's own origin and nowhere else.
 */
export const WALLET_FRAME_ALLOW = 'publickey-credentials-get; publickey-credentials-create';

/** What this file needs of the `<iframe>` element, and nothing more. */
export interface FrameElement {
  src: string;
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
  focus?(): void;
}

let frame: FrameElement | null = null;
let shown = false;
/* Every `open` is a new generation. A handle from an earlier one is closed. */
let generation = 0;
const watching = new Set<(shown: boolean) => void>();

const setShown = (next: boolean): void => {
  shown = next;
  for (const watch of watching) watch(next);
};

/** Whether the wallet is on screen in this page. */
export const walletFrameShown = (): boolean => shown;

/** Returns the way to stop watching. Call it from an effect's cleanup. */
export function onWalletFrame(watch: (shown: boolean) => void): () => void {
  watching.add(watch);
  return () => { watching.delete(watch); };
}

/**
 * **THE FRAME REGISTERS ITSELF, AND IS NEVER MOVED.** Moving an `<iframe>` in
 * the document reloads it, so the one frame is rendered once, where it stays,
 * and hands itself here. Unmounted, it takes the wallet with it.
 */
export function mountWalletFrame(element: FrameElement | null): void {
  frame = element;
  if (element === null && shown) {
    generation += 1;
    setShown(false);
  }
}

/** Put the wallet away: empty the frame and hide it. Safe to call when nothing is shown. */
export function closeWalletFrame(): void {
  generation += 1;
  if (frame !== null) frame.src = 'about:blank';
  if (shown) setShown(false);
}

/**
 * **THE WINDOW THE WALLET ASKS OPEN, WHEN THE WALLET LIVES IN THIS PAGE.**
 *
 * `view` supplies the listeners and the timers - the page's own window, where
 * the frame's messages arrive. `open` refuses with `null` when no frame is
 * mounted, which the ask reports as a wallet that did not open rather than
 * waiting out a deadline for one that was never there.
 */
export function walletInThisPage(
  view: Pick<Openable, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>,
): Openable {
  return {
    addEventListener: (type, handler) => view.addEventListener(type, handler),
    removeEventListener: (type, handler) => view.removeEventListener(type, handler),
    setTimeout: (handler, ms) => view.setTimeout(handler, ms),
    clearTimeout: (id) => view.clearTimeout(id),
    open(url: string): WalletWindow | null {
      const element = frame;
      if (element === null || element.contentWindow === null) return null;
      generation += 1;
      const mine = generation;
      element.src = url;
      if (!shown) setShown(true);
      const target = element.contentWindow;
      return {
        postMessage: (message, targetOrigin) => target.postMessage(message, targetOrigin),
        messageSource: target,
        focus: () => element.focus?.(),
        /* Only the handle for what is on screen may put it away: an older ask
         * closing late must not hide the newer one a person is reading. */
        close: () => { if (mine === generation) closeWalletFrame(); },
        get closed(): boolean { return mine !== generation || !shown || frame !== element; },
      };
    },
  };
}
