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
import { PROGRESS_SCHEMA, REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import { readBalancedAnswer, type LeavesTheWallet } from 'midnight-identity/profile/balance';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { toHex, randomBytes } from '../../../src/core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/**
 * How long the wallet has to answer: long enough to synchronise and prove.
 * **IT IS ALSO THE LONGEST THIS PAGE WAITS**, because the wait ends at the
 * ask's own deadline; while it lasts, the deposit is held as in flight, so it
 * must stay shorter than the time a deposit is kept as in flight.
 */
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
  /** The company's label, and the account that carries it: the wallet reads one off the other. */
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly vault: VaultAddress;
  /** Base64 of the proven, unbound transaction. */
  readonly transaction: string;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/**
 * The ask on the wire. No amount travels: the wallet reads that from the
 * transaction. **`progress` says this page knows the wallet's word for being
 * at work**, so a private deposit's minutes of reading and proving reach this
 * page as a wallet at work rather than as silence.
 */
export const balanceAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  company: CompanyLabel; account: AccountAddress; vault: VaultAddress; transaction: string;
}) => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: 'balance' as const,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  progress: PROGRESS_SCHEMA,
  company: parts.company,
  account: parts.account,
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
    account: ask.account,
    vault: ask.vault,
    transaction: ask.transaction,
  }), dialog);
  const read = readBalancedAnswer(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account, vault: ask.vault,
  });
  if (read.ok === false) throw new WalletDidNotPay(read.code, read.says);
  return { transaction: read.transaction, leaves: read.leaves };
}
