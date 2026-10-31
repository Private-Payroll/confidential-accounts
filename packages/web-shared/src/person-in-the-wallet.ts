/*
 * ADMITTING AND CHANGING A PERSON OR A VENDOR FROM THE PAGE: the admit-person and change-person actions asked of the
 * person's wallet, as every action on a company is (`actOnACompanyInTheWallet`). The page names who and what; the
 * wallet reads the person's record itself, holds what the page showed to it, and files with its own seat. Kept out of
 * the page's first download: the page loads it when a person is admitted or changed.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import { actOnACompanyInTheWallet } from './keyring.js';
import { walletInThisPage } from './wallet-frame.js';
import type { Openable } from './wallet-sign-in.js';
import type { ActOutcome } from './wallet-act.js';

/** The person or vendor an action is asked on, as the page names them: the company, their kind, their record and name. */
interface PersonAsked {
  readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
  readonly kind: 'employee' | 'vendor'; readonly person: string; readonly name: string;
}

/**
 * What the page asks changed. A date given as `null` is taken off. Amounts are in the currency's smallest unit. An
 * employee's status is asked on its own, or with a leaver's leaving date; the wallet refuses it with anything else.
 */
interface PersonChangeAsked {
  readonly pay?: { readonly amount: bigint; readonly asset: string; readonly from: string };
  readonly classification?: { readonly classification: 'full-time' | 'part-time'; readonly from: string };
  readonly endDate?: string | null;
  readonly leavingDate?: string | null;
  readonly status?: 'active' | 'leaver';
  readonly terms?: { readonly kind: 'one-off' } | { readonly kind: 'monthly'; readonly asset: string; readonly amount: bigint };
}

const asked = (ask: PersonAsked) => ({
  record: ask.record, company: ask.company, account: ask.account, kind: ask.kind, person: ask.person, personName: ask.name,
});
const stepOf = (opts: { readonly onStep?: (at: StepAt) => void }) => (opts.onStep === undefined ? {} : { onStep: opts.onStep });

/**
 * **ADMITS AN EMPLOYEE OR A VENDOR FROM THE PERSON'S WALLET**: the admit-person action, run over one window. The
 * fingerprint is the one the person read out from their own wallet; someone added at a public address is admitted on
 * their wallet's signed claim, with none. Resolves with how the action ended.
 */
export function admitPersonInTheWallet(
  ask: PersonAsked & { readonly fingerprint?: string }, walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  const fingerprint = ask.fingerprint?.trim();
  return actOnACompanyInTheWallet({
    name: 'admit-person', ...asked(ask), ...(fingerprint === undefined || fingerprint === '' ? {} : { fingerprint }),
  }, walletOrigin, stepOf(opts), view);
}

/**
 * **CHANGES AN EMPLOYEE'S OR A VENDOR'S RECORD FROM THE PERSON'S WALLET**: the change-person action, run over one
 * window. Each change becomes the action's own field; dates taken off are named together. Resolves with how the
 * action ended.
 */
export function changePersonInTheWallet(
  ask: PersonAsked & { readonly change: PersonChangeAsked }, walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  const c = ask.change;
  const fields: Record<string, string> = {};
  if (c.pay !== undefined) Object.assign(fields, { payAmount: c.pay.amount.toString(10), asset: c.pay.asset.toLowerCase(), payFrom: c.pay.from });
  if (c.classification !== undefined) Object.assign(fields, { classification: c.classification.classification, classificationFrom: c.classification.from });
  const cleared: string[] = [];
  for (const k of ['endDate', 'leavingDate'] as const) {
    const day = c[k];
    if (day === null) cleared.push(k);
    else if (day !== undefined) fields[k] = day;
  }
  if (c.terms !== undefined) {
    fields['terms'] = c.terms.kind;
    if (c.terms.kind === 'monthly') Object.assign(fields, { termsAsset: c.terms.asset.toLowerCase(), termsAmount: c.terms.amount.toString(10) });
  }
  if (c.status !== undefined) fields['status'] = c.status;
  if (cleared.length > 0) fields['clear'] = cleared.join(',');
  return actOnACompanyInTheWallet({ name: 'change-person', ...asked(ask), ...fields }, walletOrigin, stepOf(opts), view);
}
