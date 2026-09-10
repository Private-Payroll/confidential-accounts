import { useEffect, useState } from 'react';
import * as keyring from './keyring.js';
import {
  WALLET_FRAME_ALLOW, closeWalletFrame, mountWalletFrame, onWalletFrame, walletFrameShown,
} from './wallet-frame.js';

/**
 * **THE WALLET, IN THIS PAGE, AND THE PAGE SAYING WHAT IT IS WAITING FOR.**
 *
 * Every wallet ask in `keyring.ts` announces itself here, whichever screen
 * started it. **The wallet is shown in a frame, in the middle of the page and
 * above everything else on it** - above the proving panel as well, because it
 * is the one surface in this product where a person consents to something, and
 * nothing is allowed to sit on top of it.
 *
 * **THE FRAME IS RENDERED ONCE AND NEVER MOVED.** It is mounted beside the
 * application rather than inside any one screen, because a screen changing
 * underneath an ask would take the frame with it, and moving a frame reloads
 * whatever wallet was in it.
 *
 * ── IT IS NOT THE ASKING, AND IT MUST NEVER BECOME IT ─────────────────────
 *
 * Nothing here draws anything a person approves. The approving happens on the
 * wallet's own screen, inside the frame, where this page can draw nothing.
 * This is a label and a way out, and the moment it grew a button that meant
 * *yes* it would be a consent this page could forge.
 *
 * **AND A WAY OUT, ALWAYS.** `giveUp` puts the wallet away and makes the ask in
 * flight refuse; with no ask left but a wallet still showing, the same button
 * puts the wallet away on its own, so a page can never hold one on screen with
 * nothing able to close it.
 */
export function WalletWaiting() {
  const [dialog, setDialog] = useState<keyring.WalletDialog | null>(null);
  const [inPage, setInPage] = useState<boolean>(walletFrameShown());
  useEffect(() => keyring.onWalletWaiting(setDialog), []);
  useEffect(() => onWalletFrame(setInPage), []);

  const stop = (): void => {
    if (dialog) dialog.giveUp();
    else closeWalletFrame();
  };

  return (
    <>
      {dialog && !inPage && (
        <div className="walletwait" role="status" data-wallet-waiting>
          <div className="walletwait-body">
            <strong>Waiting for your wallet…</strong>
            <p>
              Your wallet has opened in its own window. Look at the address at the top of it —
              that is the only thing on your screen this page cannot write. Nothing is signed
              until you press the button there.
            </p>
            <button type="button" onClick={stop} data-wallet-give-up>
              Stop waiting
            </button>
          </div>
        </div>
      )}
      <div className="walletsheet" hidden={!inPage} data-wallet-sheet>
        <div className="walletsheet-card">
          {inPage && (
            <div className="walletsheet-head" role="status" data-wallet-waiting>
              <div>
                <strong>Waiting for your wallet…</strong>
                <p>
                  Your wallet is below. Nothing is signed and nothing is released until you
                  press a button inside it.
                </p>
              </div>
              <button type="button" onClick={stop} data-wallet-give-up>
                Stop waiting
              </button>
            </div>
          )}
          <iframe
            ref={mountWalletFrame}
            className="walletsheet-frame"
            title="Your wallet"
            allow={WALLET_FRAME_ALLOW}
            data-wallet-frame
          />
        </div>
      </div>
    </>
  );
}
