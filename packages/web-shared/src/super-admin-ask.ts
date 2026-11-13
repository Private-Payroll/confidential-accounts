/**
 * **WHAT A SUPER ADMIN'S PAGE ASKS OF THE PERSON'S WALLET, AND THE REQUEST IT CARRIES TO THE SERVICE.**
 *
 * A super admin need not hold a seat, so the page names the company by its label and account as a link gave them,
 * and the wallet checks both on the chain before it signs anything. The wallet's signature on the request
 * (`superAdminRequestBytes`) rides on every call to the routes of a change of the super admins, and the service lets it
 * in only while the key holds the company's account on the chain or joins it in a change kept there.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { superAdminHeaderFor, SUPER_ADMIN_HEADER } from '../../../src/midnight/super-admin-request.js';
import type { SuperAdminDoors } from './super-admin-change.js';
import { currentUser, isSignedIn, showWaitingFor } from './keyring.js';
import { walletInThisPage } from './wallet-frame.js';
import { openWalletDialog, US_TO_A_WALLET, type Openable, type WalletDialog } from './wallet-sign-in.js';
import { askWalletToSignSuperAdminUpdates, askWalletToSignTheChange, askWalletToSignTheRequest } from './wallet-committee.js';

type Key = { readonly tag: string; readonly value: string };

/** A company as a super admin's page names it: the service's record, the label its keys are drawn for, and its account. */
export interface SuperAdminCompany {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
}

/** Opens the wallet for one ask, shows the page waiting on it, and closes it when the ask fails. */
async function inTheWallet<T>(walletOrigin: string, view: Openable, ask: (dialog: WalletDialog) => Promise<T>): Promise<T> {
  if (!isSignedIn()) throw new Error('not signed in');
  const dialog = openWalletDialog(view, walletOrigin);
  const done = showWaitingFor(dialog);
  try {
    return await ask(dialog);
  } catch (e) {
    dialog.giveUp();
    throw e;
  } finally {
    done();
  }
}

/** The signed request, per company and person, for this visit only: one press in the wallet serves every call after it. */
const signed = new Map<string, { readonly key: Key; readonly header: string }>();

/**
 * **THE PERSON'S KEY FOR THE COMPANY, AND THE HEADER THAT CARRIES THEIR SIGNED REQUEST.** Asked of the wallet once per
 * company and person on a visit; the key is the one the wallet signed the request with, so the page never takes a key
 * on the service's word.
 */
export async function superAdminSigned(
  company: SuperAdminCompany, walletOrigin: string, view: Openable = walletInThisPage(window), atOrigin: string = window.location.origin,
): Promise<{ readonly key: Key; readonly headers: Record<string, string> }> {
  const user = currentUser()?.id;
  if (user === undefined) throw new Error('not signed in');
  const at = `${company.accountId} ${user}`;
  let held = signed.get(at);
  if (held === undefined) {
    const answer = await inTheWallet(walletOrigin, view, (dialog) => askWalletToSignTheRequest(view, walletOrigin, {
      company: company.label, account: company.account, record: company.accountId, user, atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns,
    }, dialog));
    held = { key: answer.signer, header: superAdminHeaderFor({ key: answer.signer, signature: answer.signature }) };
    signed.set(at, held);
  }
  return { key: held.key, headers: { [SUPER_ADMIN_HEADER]: held.header } };
}

/** The wallet as a super admin's doors reach it: its key for the company, its update signatures and its own signature on a change. */
export function superAdminWallet(
  company: SuperAdminCompany, walletOrigin: string, view: Openable = walletInThisPage(window), atOrigin: string = window.location.origin,
): SuperAdminDoors['wallet'] {
  const asking = { atOrigin, name: US_TO_A_WALLET.name, rdns: US_TO_A_WALLET.rdns };
  return {
    key: async () => (await superAdminSigned(company, walletOrigin, view, atOrigin)).key,
    signUpdates: async (ask) => inTheWallet(walletOrigin, view, async (dialog) => {
      const read = await askWalletToSignSuperAdminUpdates(view, walletOrigin, { ...asking, ...ask }, dialog);
      return { signer: read.signer, signatures: read.signatures };
    }),
    signJoin: async (ask) => inTheWallet(walletOrigin, view, (dialog) => askWalletToSignTheChange(view, walletOrigin, { ...asking, ...ask }, dialog)),
  };
}
