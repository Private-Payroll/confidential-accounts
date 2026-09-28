import { formatDate, useLanguage, useText } from 'vaults-ui';
import type { Company } from '../adapters/session.js';

/** How a company's date is written: the day, in the person's language. */
const DAY = { dateStyle: 'medium' } as const;

/** A company's two lines, in the person's language: when it was made, and how many of its signers must approve. */
export function useCompanyWords(): { made: (c: Company) => string; approvals: (c: Company) => string } {
  const t = useText();
  const language = useLanguage();
  return {
    made: (c) => t('switcher.company', { date: formatDate(new Date(c.createdAt), language, DAY) }),
    approvals: (c) => t('switcher.approvals', { needed: c.approvalsNeeded, count: c.signers }),
  };
}

/**
 * A COMPANY, SHOWN BY WHAT THE SERVICE LISTS OF IT: when it was made, and how
 * many of its signers must approve. Its name is sealed and is not shown here.
 * The company switcher and the landing page both show a company this way.
 */
export function CompanyFacts({ company }: { company: Company }) {
  const words = useCompanyWords();
  return (
    <span className="grid flex-1 text-start leading-tight">
      <span>{words.made(company)}</span>
      <span className="text-xs text-muted-foreground">{words.approvals(company)}</span>
    </span>
  );
}
