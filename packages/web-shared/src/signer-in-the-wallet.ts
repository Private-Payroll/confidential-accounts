/*
 * APPROVING AND FINISHING ADDING A SIGNER FROM THE PAGE: the approve-signer and admit-signer actions asked of the
 * person's wallet, as every action on a company is (`actOnACompanyInTheWallet`). Kept out of the page's first download:
 * the page loads it when a signer is approved or admitted.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import { actOnACompanyInTheWallet } from './keyring.js';
import { walletInThisPage } from './wallet-frame.js';
import type { Openable } from './wallet-sign-in.js';
import type { ActOutcome } from './wallet-act.js';

/** The company an action on a signer is asked on, as the page names it. */
interface CompanyAsked { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress }

/**
 * A proposal to seat a private address, as the page shows it before it is approved: its name in the company's records,
 * and what it invites as the proposal carries it (the person's name, their role, the commitment to their address, the
 * rights and the coin key of the address). The wallet opens the proposal itself and approves nothing else.
 */
type ApproveSignerAsk = CompanyAsked & {
  readonly proposal: string; readonly name: string; readonly role: string; readonly address: string; readonly scope: string; readonly coinKey: string;
};

/**
 * **APPROVES A SIGNER INVITED BY ADDRESS FROM THE PERSON'S WALLET**: the approve-signer action, run over one window.
 * The wallet approves the proposal only when it invites exactly what this page showed, and raises nothing. Resolves
 * with how the action ended.
 */
export function approveSignerInTheWallet(
  ask: ApproveSignerAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: 'approve-signer', record: ask.record, company: ask.company, account: ask.account, proposal: ask.proposal,
    personName: ask.name, role: ask.role, address: ask.address.toLowerCase(), scope: ask.scope.toLowerCase(), coinKey: ask.coinKey.toLowerCase(),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}

/** A signer waiting to be admitted, as the page shows them: their request's id in the company, and their name. */
type AdmitSignerAsk = CompanyAsked & { readonly signer: string; readonly name: string };

/**
 * **FINISHES ADDING A SIGNER WHO TOOK THEIR SEAT BY ADDRESS, FROM THE PERSON'S WALLET**: the admit-signer action, run
 * over one window. The wallet admits them only when the network shows their invitation's proposal took the seat they
 * ask for. Resolves with how the action ended.
 */
export function admitSignerInTheWallet(
  ask: AdmitSignerAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: 'admit-signer', record: ask.record, company: ask.company, account: ask.account, signer: ask.signer, personName: ask.name,
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}
