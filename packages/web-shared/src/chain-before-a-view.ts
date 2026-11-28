/**
 * **THE PAGE'S READS OF THE CHAIN BEFORE ANY VIEW OF A COMPANY IS OPEN**, each asked of the person's own wallet: whether
 * a company being created holds its account on the chain yet, whether its pay key is committed there, and the indexer a
 * super admin, who holds no view of the company, reads the chain through. Once a company's view is open, the chain is
 * read through the view's own doors instead.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { PAY_KEY_COMMITMENT_ENTRY } from 'midnight-identity/profile/records-key';
import { holdersFromTheWallet } from './wallet-asks.js';
import type { Openable } from './wallet-sign-in.js';

/** Where a company is on the chain: its label and its account. */
interface OnTheChain {
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
}

/** Settles once the wallet reads who holds the company's account; throws as the wallet's read throws when it reads nothing. */
export const accountReadByTheWallet = async (
  walletOrigin: string,
  where: OnTheChain,
  view?: Openable,
  atOrigin?: string
): Promise<void> => {
  await holdersFromTheWallet(walletOrigin, where, view, atOrigin);
};

/** True when the person's wallet, reading the account itself, shows the company's pay-record key committed on it. */
export async function walletShowsPayKeyCommitted(
  walletOrigin: string,
  company: CompanyLabel,
  account: AccountAddress,
  view?: Openable,
  atOrigin?: string
): Promise<boolean> {
  const read = await holdersFromTheWallet(
    walletOrigin,
    { company, account, movements: [PAY_KEY_COMMITMENT_ENTRY] },
    view,
    atOrigin
  );
  return read.payments !== undefined && read.payments.payKeyCommitment !== null;
}

/** The indexer the wallet reads the company's chain through, or null when it names none. */
export const indexerNamedByTheWallet = async (walletOrigin: string, where: OnTheChain) =>
  (await holdersFromTheWallet(walletOrigin, where)).indexer;
