import { payeeAsk } from '../core/wallet-payee-ask.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/**
 * **OPENING THE WALLET AND ASKING IT WHERE TO PAY YOU — the browser half.**
 * `docs/NEXT.md` X8 §2, `docs/how-money-can-be-lost.md` `C153`.
 *
 * ── IT JUDGES NOTHING, AND THAT IS THE DIFFERENCE FROM THE UNLOCK ─────────
 *
 * `src/web/wallet-unlock.ts` checks what comes back, because a released KEY
 * arrives in this tab and goes nowhere else, so there is no server to defer to.
 * **An address is the other case.** It is a claim that ends up on a company's
 * roster, the server is what writes it, and a check made in the page would be a
 * second opinion about a value the server has to judge for itself. So this
 * forwards the answer unjudged, exactly as `askWalletToSignIn` does, and
 * `src/core/wallet-payee.ts` decides.
 *
 * **THE ONE JUDGEMENT MADE HERE IS THE ORIGIN**, and only in the narrow sense
 * of refusing to listen to anybody else: `askWallet` drops any message whose
 * `MessageEvent.origin` is not the wallet's. That does not make the answer
 * true; it stops this page carrying somebody else's message to the server.
 *
 * ── THE NONCE COMES FROM OUR SERVER, NOT FROM THIS PAGE ───────────────────
 *
 * The opposite of the unlock, and for the reason the sign-in has it that way:
 * **the server is the party that has to be sure the answer is fresh**, because
 * the server is what writes the record. It arrives with a HANDLE that never
 * leaves this origin and must be presented alongside, so a nonce on its own is
 * not an address — the same fixation defence `WalletIdentityService.challenge`
 * is built around.
 *
 * ── AND THIS FILE IMPORTS NOTHING THAT VERIFIES ───────────────────────────
 *
 * `wallet-payee-ask.ts` imports one constant;
 * `wallet-payee.ts` is the half that reaches `ledger-v9` and is never imported
 * from `src/web/`. `no-wasm-in-the-page.test.ts` is what keeps that true.
 */

export interface PayeeAsked {
  /** From `POST /api/accounts/:id/payee-challenge`. Never from a link. */
  readonly nonce: string;
  /** The CHALLENGE's own deadline. The wallet refuses an ask that has already
   * expired, so this is that one number rather than a second that could
   * disagree with it. */
  readonly expiresAt: number;
  /** What this deployment calls itself. Untrusted by the wallet, shown as text. */
  readonly name: string;
  readonly rdns: string;
  /** Ask for the PUBLIC receiving address: the money has no private form. */
  readonly publicly?: boolean;
}

/**
 * ASK ONCE, TAKE ONE ANSWER, HAND IT ON WITHOUT READING IT.
 *
 * The return type is `unknown` and that is deliberate: **there is no shape
 * check here on purpose.** A malformed answer has to be refused where the
 * record would otherwise be written.
 */
export async function askWalletForPayeeAddress(
  view: Openable, walletOrigin: string, ask: PayeeAsked, dialog?: WalletDialog,
): Promise<unknown> {
  return askWallet(view, walletOrigin, payeeAsk({
    name: ask.name,
    rdns: ask.rdns,
    nonce: ask.nonce,
    expiresAt: ask.expiresAt,
    publicly: ask.publicly === true,
  }), dialog);
}
