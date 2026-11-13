/**
 * **THE CODE A READER GIVES A SIGNER, MADE IN THE READER'S OWN WALLET.** The page asks the wallet for a join code for one
 * company, naming the company by the label and contract address its reader's link carries and the person signed in. The
 * wallet derives the reader's key for that company itself, signs the code, and shows the person its fingerprint to read
 * out to the signer; the page is handed the code's text and never a key. A code the wallet did not sign, or one that
 * names anything but what was asked, is refused by `askWalletForAJoinCode` before it reaches here.
 */
import { writeJoinCode } from 'midnight-identity/profile/join-code';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { askWalletForAJoinCode } from 'vaults-web-shared/wallet-join-code.js';
import { openWalletDialog, US_TO_A_WALLET } from 'vaults-web-shared/wallet-sign-in.js';
import { walletInThisPage } from 'vaults-web-shared/wallet-frame.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';

/** What a reader's join code is for, in the wallet's words, sent and never shown. */
const READER_PARTS = { kind: 'reader' } as const;

export type ReaderCode = { readonly of: typeof ACTED.done; readonly text: string } | { readonly of: typeof ACTED.refused; readonly why: ActRefusal };

/** The reader's code for the company named, as text to hand to a signer, or why the wallet did not make one. */
export async function readerCodeFromTheWallet(
  personId: string, company: { readonly label: CompanyLabel; readonly account: AccountAddress }, appName: string,
): Promise<ReaderCode> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const view = walletInThisPage(window);
    const dialog = openWalletDialog(view, ACCOUNT_ORIGIN);
    try {
      const code = await askWalletForAJoinCode(view, ACCOUNT_ORIGIN, {
        company: company.label, account: company.account, person: personId, parts: READER_PARTS, name: appName, rdns: US_TO_A_WALLET.rdns,
      }, dialog);
      return { of: ACTED.done, text: writeJoinCode(code) };
    } finally {
      dialog.giveUp();
    }
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
