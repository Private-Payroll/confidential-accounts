/*
 * JOINING A COMPANY AS A PAYEE FROM THE PAGE: the join-by-code action asked of the person's wallet, as every action on
 * a company is (`actOnACompanyInTheWallet`). Kept out of the page's first download: the page loads it when somebody
 * joins by an invitation link.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import { actOnACompanyInTheWallet } from './keyring.js';
import { walletInThisPage } from './wallet-frame.js';
import type { Openable } from './wallet-sign-in.js';
import type { ActOutcome } from './wallet-act.js';

/** The invitation joined by, as the page opened it: the company's record, label and account, and the link's token. */
interface JoinAsk { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress; readonly token: string }

/**
 * **JOINS A COMPANY AS A PAYEE FROM THE PERSON'S WALLET**: the join-by-code action, run over one window. The wallet
 * opens the invitation itself with the token, signs the person's code, lists the company among those that pay them
 * and hands the company the code sealed to its inbox key. The fingerprint the person reads to whoever invited them is
 * shown in the wallet's window, not given to this page. Resolves with how the action ended.
 */
export function joinByCodeInTheWallet(
  ask: JoinAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: 'join-by-code', record: ask.record, company: ask.company, account: ask.account, token: ask.token.toLowerCase(),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}
