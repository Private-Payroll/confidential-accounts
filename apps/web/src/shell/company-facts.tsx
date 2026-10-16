import { useEffect, useState } from 'react';
import { useText } from 'vaults-ui';
import { approvalsNeededFor, type Company } from '../adapters/session.js';
import { useSessionIfAny } from '../session.js';

/**
 * HOW MANY OF A COMPANY'S SIGNERS MUST APPROVE, as the person's own wallet reads it off the chain, by company. Empty
 * until it is read, and for a company the wallet cannot read: no figure is shown for those, and the service's own
 * number is never put in its place.
 */
function useApprovalsNeeded(): ReadonlyMap<string, number> {
  const person = useSessionIfAny()?.person.id ?? null;
  const [needed, setNeeded] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (person === null) return undefined;
    let alive = true;
    void approvalsNeededFor(person).then((n) => { if (alive) setNeeded(n); });
    return () => { alive = false; };
  }, [person]);
  return needed;
}

/** A company's words, in the person's language: what it is called while its name is not open, and how many of its signers must approve of how many there are, once the chain says. */
export function useCompanyWords(): { unnamed: string; approvals: (c: Company) => string } {
  const t = useText();
  const needed = useApprovalsNeeded();
  return {
    unnamed: t('switcher.company'),
    approvals: (c) => (needed.has(c.id) ? t('switcher.approvals', { needed: needed.get(c.id), signers: c.signers }) : ''),
  };
}

/**
 * A COMPANY, SHOWN BY WHAT THE SERVICE LISTS OF IT: its name when it is given
 * (the switcher gives it once the saved keys have opened it), and otherwise
 * the word for a company; and under it how many of its signers must approve,
 * of how many there are, once the person's own wallet has read that off the
 * chain. The company switcher and the landing page both show a company this way.
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
