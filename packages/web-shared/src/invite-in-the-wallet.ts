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
  | {
    readonly kind: 'signer'; readonly name: string; readonly role: string; readonly address: string; readonly scope?: string;
    /** The approvals the company needs once the seat is taken; left out, the number in force is kept. */
    readonly threshold?: number;
  }
);

/**
 * **INVITES SOMEBODY TO THE COMPANY FROM THE PERSON'S WALLET**: the invite action, run over one window as every action
 * on a company is (`actOnACompanyInTheWallet`). For an employee or a vendor this page makes the invitation's token and
 * so the link itself; for a signer it sends no token and gets none back: the wallet makes the token, keeps the
 * invitation in the saved keys, raises the proposal to seat the address (with the approvals the company needs once the
 * seat is taken, where `threshold` is given) and shows the link in its own window, for the person inviting to send.
 * The wallet seals, signs and files the invitation with its own seat. The person's details go to the wallet only, as
 * the action's words. Resolves with how the action ended and, for an employee or a vendor, the link to give the
 * person, which is theirs only once the action says the invitation was filed; null for a signer.
 * `opts.token`, when given for an employee or a vendor, is used as it is (and the link is made from it), so a press
 * again carries on that same invitation; it must be what `newInvitationToken` gives, sixty-four lower-case hex
 * characters, and anything else is refused before the wallet is asked. Without it a fresh token is made. A token is
 * refused for a signer before the wallet is asked.
 */
export async function inviteInTheWallet(
  ask: InviteAsk,
  walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void; readonly origin?: string; readonly token?: string } = {},
  view: Openable = walletInThisPage(window),
): Promise<{ readonly ended: ActOutcome; readonly link: string | null; readonly id: string | null }> {
  if (opts.token !== undefined && (ask.kind === 'signer' || !TOKEN.test(opts.token))) {
    throw new Error('that is not an invitation token this page may give, so nobody was invited.');
  }
  const linkSecret: Hex | null = ask.kind === 'signer' ? null : opts.token ?? newInvitationToken();
  const fields: Record<string, string> = { record: ask.record, company: ask.company, account: ask.account, kind: ask.kind, personName: ask.name };
  if (linkSecret !== null) fields['token'] = linkSecret;
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
    put('threshold', ask.threshold === undefined ? undefined : String(ask.threshold));
  }
  const ended = await actOnACompanyInTheWallet({ name: 'invite', ...fields }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
  return linkSecret === null ? { ended, link: null, id: null }
    : { ended, link: invitationLink(opts.origin ?? window.location.origin, linkSecret), id: invitationIdOf(linkSecret) };
}
