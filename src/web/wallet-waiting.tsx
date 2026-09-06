import { useEffect, useState } from 'react';
import * as keyring from './keyring.js';

/**
 * **THE PAGE BEHIND THE WALLET WAITS VISIBLY, AND OFFERS A WAY OUT.**
 *
 * The dialog opens on top of this page, and then it can be moved, or covered,
 * or sent behind the window that opened it by anything the person does next.
 * **A page that goes quiet while that happens teaches people to press the
 * button again**, and a second press is a second ask — a second nonce, a second
 * approval screen, and two conversations where the wallet answers one.
 *
 * So this says what is being waited for, and it offers the thing a spinner
 * never does: **stopping.** `giveUp` closes the dialog and makes the ask in
 * flight refuse with `gave-up`, so nothing is left half-open on either side.
 *
 * ── IT IS NOT THE ASKING, AND IT MUST NEVER BECOME IT ─────────────────────
 *
 * Nothing here draws anything a person approves. The approving happens in the
 * wallet's own window, where the browser's chrome shows the wallet's real
 * origin — the one piece of evidence a page cannot forge. This is a label on
 * an empty room, and the moment it grew a button that meant *yes* it would be
 * the modal `C154` refuses.
 */
export function WalletWaiting() {
  const [dialog, setDialog] = useState<keyring.WalletDialog | null>(null);
  useEffect(() => keyring.onWalletWaiting(setDialog), []);
  if (!dialog) return null;

  return (
    <div className="walletwait" role="status" data-wallet-waiting>
      <div className="walletwait-body">
        <strong>Waiting for your wallet…</strong>
        <p>
          Your wallet has opened in its own window. Look at the address at the top of it —
          that is the only thing on your screen this page cannot write. Nothing is signed
          until you press the button there.
        </p>
        <button type="button" onClick={() => dialog.giveUp()} data-wallet-give-up>
          Stop waiting
        </button>
      </div>
    </div>
  );
}
