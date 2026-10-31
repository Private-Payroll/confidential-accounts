/*
 * INVITING SOMEBODY FROM THE PAGE: the invite action asked of the person's wallet, as every action on a company is
 * (`actOnACompanyInTheWallet`). Kept out of the page's first download: the page loads it when somebody is invited.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import { invitationIdOf, invitationLink, newInvitationToken } from '../../../src/core/invitation.js';
import type { Hex } from '../../../src/core/crypto.js';
import { actOnACompanyInTheWallet } from './keyring.js';
import { walletInThisPage } from './wallet-frame.js';
import type { Openable } from './wallet-sign-in.js';
import type { ActOutcome } from './wallet-act.js';

/** What `newInvitationToken` gives: sixty-four lower-case hex characters. */
const TOKEN = /^[0-9a-f]{64}$/u;

/** Who is invited, as the page asks: the company, the kind, and the person's details in the page's own words. */
export type InviteAsk = { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress } & (
  | {
    readonly kind: 'employee'; readonly name: string; readonly email?: string; readonly title: string; readonly asset: string;
    readonly units: bigint; readonly startDate: string; readonly endDate?: string; readonly classification: string; readonly address?: string;
  }
  | {
    readonly kind: 'vendor'; readonly name: string; readonly email?: string; readonly startDate: string; readonly endDate?: string;
    readonly address?: string; readonly terms: { readonly kind: 'one-off' } | { readonly kind: 'monthly'; readonly asset: string; readonly units: bigint };
  }
  | { readonly kind: 'signer'; readonly name: string; readonly role: string; readonly address: string; readonly scope?: string }
);

/**
 * **INVITES SOMEBODY TO THE COMPANY FROM THE PERSON'S WALLET**: the invite action, run over one window as every action
 * on a company is (`actOnACompanyInTheWallet`). This page makes the invitation's token and so the link itself; the
 * wallet seals, signs and files the invitation with its own seat, and for a signer raises the proposal to seat the
 * address, keeping the invitation in the saved keys first. The person's details go to the wallet only, as the
 * action's words. Resolves with how the action ended and the link to give the person, which is theirs only once the
 * action says the invitation was filed (or, raised and not filed, to give them by hand).
 * `opts.token`, when given, is used as it is (and the link is made from it), so a press again of an invitation the wallet
 * kept carries on that same invitation; it must be what `newInvitationToken` gives, sixty-four lower-case hex characters,
 * and anything else is refused before the wallet is asked. Without it a fresh token is made.
 */
export async function inviteInTheWallet(
  ask: InviteAsk,
  walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void; readonly origin?: string; readonly token?: string } = {},
  view: Openable = walletInThisPage(window),
): Promise<{ readonly ended: ActOutcome; readonly link: string; readonly id: string }> {
  if (opts.token !== undefined && !TOKEN.test(opts.token)) throw new Error('that is not an invitation token, so nobody was invited.');
  const token = (opts.token ?? newInvitationToken()) as Hex;
  const fields: Record<string, string> = { record: ask.record, company: ask.company, account: ask.account, token, kind: ask.kind, personName: ask.name };
  const put = (k: string, v: string | undefined): void => { if (v !== undefined && v !== '') fields[k] = v; };
  if (ask.kind === 'employee') {
    put('email', ask.email); put('title', ask.title); put('asset', ask.asset); put('amount', ask.units.toString());
    put('startDate', ask.startDate); put('endDate', ask.endDate); put('classification', ask.classification); put('address', ask.address);
  } else if (ask.kind === 'vendor') {
    put('email', ask.email); put('startDate', ask.startDate); put('endDate', ask.endDate); put('address', ask.address);
    put('terms', ask.terms.kind);
    if (ask.terms.kind === 'monthly') { put('termsAsset', ask.terms.asset); put('termsAmount', ask.terms.units.toString()); }
  } else {
    put('role', ask.role); put('address', ask.address); put('scope', ask.scope);
  }
  const ended = await actOnACompanyInTheWallet({ name: 'invite', ...fields }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
  return { ended, link: invitationLink(opts.origin ?? window.location.origin, token), id: invitationIdOf(token) };
}
