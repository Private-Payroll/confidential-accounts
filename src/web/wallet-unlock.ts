import { readRelease } from 'midnight-identity/profile/unlock';
import type { ReleaseFailure } from 'midnight-identity/profile/unlock';
import { toHex, randomBytes } from '../core/crypto.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from '../core/wallet-unlock.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/**
 * **OPENING THE WALLET AND ASKING IT TO RELEASE ONE COMPANY'S KEY.**
 * `docs/NEXT.md` PI2a §1, `C129`.
 *
 * ── THE ONE PLACE IN THIS PRODUCT THAT RECEIVES A SECRET ON THE WIRE ──────
 *
 * A sign-in response is a signature: it proves something and gives nothing
 * away, so this side forwards it to the server unjudged and the server decides.
 * **A release is a key.** It arrives in this tab, it is used in this tab, and
 * it goes nowhere else — so there is no server to defer to and the checking has
 * to happen here.
 *
 * That is `readRelease`, and it is imported from the wallet's own package
 * rather than reimplemented, for the reason `PI1` imported `verify`: the thing
 * payroll runs should be the thing the wallet's round tested, not a description
 * of it. It reads **none of its three expectations out of the message** — the
 * origin is ours, the nonce is the one this function generated, and the company
 * is the one the session told us — because a value that agrees with itself is
 * what a forged one looks like.
 *
 * ── THE NONCE IS THIS PAGE'S OWN, AND IT IS NOT THE SERVER'S ──────────────
 *
 * A sign-in nonce comes from our server, because the server is the party that
 * has to be sure the answer is fresh. **Nothing about a release reaches the
 * server**, so a server-issued nonce here would be a round trip that proves
 * nothing to anybody, and would put a value belonging to one conversation into
 * another party's hands. It is generated here and compared here.
 *
 * ── WHAT THIS FUNCTION RETURNS, AND WHAT IT DELIBERATELY DOES NOT DO ──────
 *
 * It returns thirty-two bytes and nothing else — not the message, not the
 * wallet's clock reading, not the origin it echoed. **Nothing here logs, stores
 * or transmits the key**, and the caller (`keyring.ts`) keeps it in a module
 * variable for the life of the tab, exactly where the password-derived key used
 * to sit. A reload asks the wallet again.
 */

export type UnlockFailure = ReleaseFailure | 'wallet-refused';

export class UnlockRefused extends Error {
  readonly code: UnlockFailure;
  constructor(code: UnlockFailure, message: string) {
    super(message);
    this.name = 'UnlockRefused';
    this.code = code;
  }
}

export interface UnlockAsked {
  /** From `POST /api/accounts/:id/unlock`. **Never from anything a caller sent.** */
  readonly company: string;
  /** This page's own origin, as the browser knows it. Not a value we were sent. */
  readonly atOrigin: string;
  /** The requester's own words about itself. Untrusted by the wallet, shown as text. */
  readonly name: string;
  readonly rdns: string;
  /** Injectable so a test can drive the whole conversation with no browser. */
  readonly now?: () => number;
  readonly nonce?: string;
}

/**
 * ASK ONCE, TAKE ONE ANSWER, CHECK IT AGAINST WHAT WE OURSELVES CHOSE.
 *
 * `view` is the window rather than a global so the conversation can be driven
 * in a test — the wallet's own `channel.ts` is shaped the same way and for the
 * same reason.
 */
export async function askWalletToUnlock(
  view: Openable, walletOrigin: string, ask: UnlockAsked, dialog?: WalletDialog,
): Promise<Uint8Array> {
  const now = ask.now ?? (() => Date.now());
  /* Sixteen random bytes. It ties one answer to one question and is not a
   * secret; it is generated here because nobody else is a party to it. */
  const nonce = ask.nonce ?? toHex(randomBytes(16));

  const answer = await askWallet(view, walletOrigin, unlockAsk({
    name: ask.name,
    rdns: ask.rdns,
    purpose: UNLOCK_PURPOSE,
    nonce,
    expiresAt: now() + UNLOCK_WINDOW_MS,
    company: ask.company,
  }), dialog);

  /*
   * **THREE EXPECTATIONS, ALL THREE OURS.** `atOrigin` is where this page is
   * running, `expectingNonce` is what we just generated, `forCompany` is what
   * the session told us. A release that answers a different origin, a different
   * question or a DIFFERENT COMPANY is refused rather than used — the last of
   * those is the one only this side can catch, and using the wrong company's
   * key would seal records nobody can open again.
   */
  const read = readRelease(answer, {
    atOrigin: ask.atOrigin,
    expectingNonce: nonce,
    forCompany: ask.company,
  });
  if (!read.ok) throw new UnlockRefused(read.code, read.says);
  return read.key;
}
