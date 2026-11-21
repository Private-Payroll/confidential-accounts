import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { namedIn, type PageView } from './filing-judge.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';

/** The company as an action in the person's wallet is asked to name it. */
interface NamedForTheWallet { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress }

/**
 * What is checked before the wallet is asked to act on the company the screen's `view` reads: the site is set up, the
 * person is signed in here, and the company can be named (it has its account on the chain). The company's record,
 * label and account, or the refusal that stops the press before the wallet is asked.
 */
export async function namedBefore(personId: string, view: PageView): Promise<NamedForTheWallet | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedIn(view);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}
