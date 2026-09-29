import { useText } from 'vaults-ui';
import type { Company } from '../adapters/session.js';

/** A company's words, in the person's language: what it is called while its name is not open, and how many of its signers must approve of how many there are. */
export function useCompanyWords(): { unnamed: string; approvals: (c: Company) => string } {
  const t = useText();
  return {
    unnamed: t('switcher.company'),
    approvals: (c) => t('switcher.approvals', { needed: c.approvalsNeeded, signers: c.signers }),
  };
}

/**
 * A COMPANY, SHOWN BY WHAT THE SERVICE LISTS OF IT: its name when it is given
 * (the switcher gives it once the saved keys have opened it), and otherwise
 * the word for a company; and under it how many of its signers must approve,
 * of how many there are. The company switcher and the landing page both show
 * a company this way.
 */
export function CompanyFacts({ company, name = null }: { company: Company; name?: string | null }) {
  const words = useCompanyWords();
  return (
    <span className="grid flex-1 text-start leading-tight">
      {name === null ? <span>{words.unnamed}</span> : <span className="font-medium" data-company-name>{name}</span>}
      <span className="text-xs text-muted-foreground" data-approvals>{words.approvals(company)}</span>
    </span>
  );
}
