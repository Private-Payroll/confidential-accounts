import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { INDEXER_HOST, INDEXER_HTTP_URL } from '../config.js';
import { fromIndexerAt, labelOnAccount } from '../chain/company-label-on-chain.js';
import type { LabelOnAccount } from '../chain/company-label-on-chain.js';
import { StatusAlert } from '../components/status.js';

/**
 * **THE COMPANY, AS A PERSON CHECKS IT BEFORE THIS WALLET GIVES OR SIGNS
 * ANYTHING FOR IT.**
 *
 * A page names a company by its label and names the account it says carries
 * that label. This reads the account itself, over this wallet's own connection
 * to the chain, and shows one of two things: the company's fingerprint, which
 * covers the label and the account together, when the account carries the
 * label; or why nothing can be given, when it does not. **There is no state in
 * which this shows a fingerprint of the label alone**, because the same label
 * can be written into a second account, and a fingerprint that did not cover
 * the account would let that second company wear the first one's face.
 */

/** How a screen asks the chain which label an account carries. Replaceable so a test can answer. */
export type LabelReader = (account: AccountAddress) => Promise<LabelOnAccount>;

/** The chain, read through the indexer this wallet reads its own balance from. */
export const liveLabelReader: LabelReader = (account) => labelOnAccount(account, fromIndexerAt(INDEXER_HTTP_URL));

export type CompanyCheck =
  | { readonly of: 'checking' }
  /** The page named no account: the company has none yet. */
  | { readonly of: 'no-account-yet' }
  | LabelOnAccount;

/**
 * Reads the account once per label and account, and says what it found. With
 * no label there is nothing to check and nothing is read.
 */
export function useCompanyCheck(
  label: CompanyLabel | null, account: AccountAddress | null, read: LabelReader,
): CompanyCheck {
  /* Each answer is kept with the label and account it was read for, so an
   * answer for one request is never shown against the next. */
  const [read_, setRead] = useState<{ label: CompanyLabel; account: AccountAddress; check: CompanyCheck } | null>(null);
  useEffect(() => {
    if (label === null || account === null) return undefined;
    let alive = true;
    read(account).then(
      (found) => { if (alive) setRead({ label, account, check: found }); },
      () => { if (alive) setRead({ label, account, check: { of: 'unreadable', why: 'the read did not come back.' } }); },
    );
    return () => { alive = false; };
  }, [label, account, read]);
  if (label === null || account === null) return { of: 'no-account-yet' };
  return read_ !== null && read_.label === label && read_.account === account ? read_.check : { of: 'checking' };
}

/** Whether the account was read and carries exactly this label. The only state a screen may give or sign in. */
export const accountCarriesTheLabel = (check: CompanyCheck, label: CompanyLabel | null): boolean =>
  label !== null && check.of === 'carries' && check.label === label;

/**
 * THE SECTION ITSELF. `fingerprintClass` lets each screen keep its own size for
 * the one thing a person compares; `doing` is what the screen would do for the
 * company - give its key, sign, or pay - so every sentence says that.
 */
export function CompanyOnChain(props: {
  readonly label: CompanyLabel;
  readonly account: AccountAddress | null;
  readonly check: CompanyCheck;
  readonly fingerprintClass?: string;
  readonly doing?: 'given' | 'signed' | 'paid';
}): ReactNode {
  /* Announced as it changes, so a person who cannot see the screen hears why the button is held or let go. */
  return <div aria-live="polite" data-company-section><CompanySection {...props} /></div>;
}

function CompanySection({
  label, account, check, fingerprintClass = 'text-xl', doing = 'given',
}: {
  readonly label: CompanyLabel;
  readonly account: AccountAddress | null;
  readonly check: CompanyCheck;
  readonly fingerprintClass?: string;
  readonly doing?: 'given' | 'signed' | 'paid';
}): ReactNode {
  if (check.of === 'no-account-yet') {
    return (
      <div data-company-check="no-account-yet">
        <p className="m-0 text-foreground" data-no-account-yet>
          {`This company has no account on the chain yet, so this wallet has nothing to check it against and no fingerprint to compare. Nothing can be ${doing}. Ask the company to finish setting up, then try again.`}
        </p>
        <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>The company&rsquo;s label, in full</p>
        <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-company-label>{label}</p>
      </div>
    );
  }
  if (check.of === 'checking') {
    return (
      <p className="m-0 text-foreground" data-company-check="checking">
        {`Reading this company's account from ${INDEXER_HOST}, to check it is the company the page names. Nothing can be ${doing} until it is.`}
      </p>
    );
  }
  if (check.of === 'carries' && check.label === label && account !== null) {
    return (
      <div data-company-check="carries">
        <p className={`m-0 font-mono tracking-wide text-foreground ${fingerprintClass}`} data-company-fingerprint>
          {companyFingerprint(label, account)}
        </p>
        <p className="m-0 text-sm text-muted-foreground">
          Those twenty characters stand for this company and its account together, and are the same in every wallet,
          for ever. Ask the company for its fingerprint and check that every character matches, not only the ends.
        </p>
        <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
          {`This wallet read the account from ${INDEXER_HOST} and it carries this company's label.`}
        </p>
        <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.5rem' }}>The account, in full</p>
        <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-company-account>{account}</p>
        <p className="m-0 text-sm text-muted-foreground">The company&rsquo;s label, in full</p>
        <p className="m-0 font-mono break-all text-sm text-muted-foreground" data-company-label>{label}</p>
      </div>
    );
  }
  const nothing = `Nothing can be ${doing}.`;
  const says = check.of === 'carries'
    ? `The account the page named belongs to a different company from the one it asks about. That is what it would look like if somebody were trying to pass one company off as another. ${nothing} Do not continue, and tell the company by a way of reaching them that is not this page.`
    : check.of === 'no-account'
      ? `There is no account on the chain at the address the page gave. ${nothing} If the company was set up in the last few minutes, refuse this and try again shortly; otherwise tell the company.`
      : check.of === 'no-label'
        ? `The contract at the address the page gave is not a company account: it carries no company label. ${nothing} Tell whoever sent you to this page.`
        : `This wallet could not read the company's account from ${INDEXER_HOST}: ${check.why} ${nothing} Refuse this, and ask the page again; if it happens again, tell whoever runs that site.`;
  return (
    <StatusAlert
      tone="danger"
      title={check.of === 'carries' ? 'This is not the company the page names'
        : check.of === 'no-account' ? 'This company\'s account could not be found' : 'This company could not be checked'}
    >
      <p className="m-0" data-company-check={check.of === 'carries' ? 'another-company' : check.of}>{says}</p>
    </StatusAlert>
  );
}
