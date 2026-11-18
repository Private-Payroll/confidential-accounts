/*
 * The warning that a company's key has already gone to a different page: which company, where its key went before, and
 * which page is asking now. An unlock gives the fingerprint a mark of its own and ends with an explanation that a move
 * of host can be ordinary; a keyring ask shows the lines alone. It only informs, and an empty list is no refusal.
 */
import type { ReactNode } from 'react';
/* A RENDERING of the company's label and its account together. It is not, and must never
 * become, an input to anything derived; `midnight-identity/profile/fingerprint` says why. */
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { StatusAlert } from '../components/status.js';

interface SeenElsewhere {
  readonly company: CompanyLabel;
  readonly account: AccountAddress | null;
  readonly asking: string;
  readonly elsewhere: readonly string[];
  readonly companyOnChain: boolean;
  readonly withExplanation: boolean;
}

export function seenElsewhere(v: SeenElsewhere): ReactNode {
  const { company, account, asking, elsewhere, companyOnChain, withExplanation } = v;
  return (
    <StatusAlert
      tone="warning"
      title="You have given this company’s key to a different page before"
    >
      {/* **EACH ADDRESS ON ITS OWN LINE.** Found by looking at the first
        * picture of this screen: inline, the previous host wrapped as
        * `https://payroll-a.exampl` / `e.` — a fact a person is being
        * asked to COMPARE, broken in the middle of itself. */}
      <div data-seen-elsewhere>
        {/* WHICH company, said in the form a person was told it
          * in. The warning named two origins and left the company itself
          * to be inferred from the section above. */}
        <p className="m-0">The company is</p>
        <p className="m-0 font-mono tracking-wide text-foreground" {...(withExplanation ? { 'data-warning-fingerprint': true } : {})}>
          {companyOnChain && account !== null ? companyFingerprint(company, account) : 'The company named above, once this wallet has checked it'}
        </p>
        <p className="m-0" style={{ marginTop: '0.5rem' }}>
          Before now, this company’s key has gone to
        </p>
        {elsewhere.map((origin) => (
          <p className="m-0 font-mono text-foreground" key={origin}>{origin}</p>
        ))}
        <p className="m-0" style={{ marginTop: '0.5rem' }}>This page is</p>
        <p className="m-0 font-mono text-foreground">{asking}</p>
      </div>
      {withExplanation && (
        <p className="m-0">
          That can be perfectly ordinary — a company can move, or run its own copy of
          the same thing. It is shown because you are the only one who can tell the
          difference between that and somebody standing in the way.
        </p>
      )}
    </StatusAlert>
  );
}
