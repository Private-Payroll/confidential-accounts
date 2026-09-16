/**
 * **ASKING THE SIGNED-IN PERSON'S OWN WALLET TO PUT IN THE COINS A DEPOSIT
 * NEEDS.**
 *
 * The page has built and proved a call into the company's vault. The call needs
 * a coin this page does not hold and must never hold; the person's wallet adds
 * it from their own balance, shows them what leaves, signs what it added, and
 * hands the finished transaction back. The wallet balances the shielded and
 * unshielded legs only; the company's fee payer adds the network fee.
 *
 * Every expectation the answer is checked against is this page's own: where it
 * is, the nonce it chose, and the company and vault it asked about.
 */
import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import { readBalancedAnswer, type LeavesTheWallet } from 'midnight-identity/profile/balance';
import { toHex, randomBytes } from '../core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/** How long the wallet has to answer: long enough to synchronise and prove. */
export const BALANCE_WINDOW_MS = 30 * 60_000;

export const BALANCE_PURPOSE =
  'So the money you chose goes from your own wallet into your company\'s vault. Your wallet shows '
  + 'you exactly what leaves it. The network fee is paid by the company, not by you.';

export class WalletDidNotPay extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletDidNotPay';
  }
}

export interface BalanceAsked {
  readonly company: string;
  readonly vault: string;
  /** Base64 of the proven, unbound transaction. */
  readonly transaction: string;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/** The ask on the wire. No amount travels: the wallet reads that from the transaction. */
export const balanceAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  company: string; vault: string; transaction: string;
}) => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: 'balance' as const,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
  vault: parts.vault,
  transaction: parts.transaction,
});

export async function askWalletToPay(
  view: Openable, walletOrigin: string, ask: BalanceAsked, dialog?: WalletDialog,
): Promise<{ transaction: string; leaves: readonly LeavesTheWallet[] }> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, balanceAsk({
    name: ask.name,
    rdns: ask.rdns,
    purpose: BALANCE_PURPOSE,
    nonce,
    expiresAt: now() + BALANCE_WINDOW_MS,
    company: ask.company,
    vault: ask.vault,
    transaction: ask.transaction,
  }), dialog);
  const read = readBalancedAnswer(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, vault: ask.vault,
  });
  if (!read.ok) throw new WalletDidNotPay(read.code, read.says);
  return { transaction: read.transaction, leaves: read.leaves };
}
