import { useEffect, useState } from 'react';
import { Badge, useText } from 'vaults-ui';
import { creationOfCompany } from '../setup/creation-on-demand.js';
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
 * WHETHER THE COMPANY'S CREATION IS NOT FINISHED, as the creation adapter marks it. False until it has said, and for a
 * company it could not read: no mark is better than a wrong one. The adapter is loaded when first needed, so the first page does not carry it. The adapter keeps one read per company for the sign-in,
 * so a list of companies asks the service once for each.
 */
function useNotFinished(company: string): boolean {
  const [notFinished, setNotFinished] = useState(false);
  useEffect(() => {
    let alive = true;
    setNotFinished(false);
    creationOfCompany(company).then((creation) => { if (alive) setNotFinished(creation.mark !== null); }, () => {});
    return () => { alive = false; };
  }, [company]);
  return notFinished;
}


/**
 * A COMPANY, SHOWN BY WHAT THE SERVICE LISTS OF IT: its name when it is given
 * (the switcher gives it once the saved keys have opened it), and otherwise
 * the word for a company; under it how many of its signers must approve,
 * of how many there are, once the person's own wallet has read that off the
 * chain; and, when the company's creation is not finished, a badge saying so.
 * The company switcher and the landing page both show a company this way.
 */
export function CompanyFacts({ company, name = null }: { company: Company; name?: string | null }) {
  const words = useCompanyWords();
  const t = useText();
  const notFinished = useNotFinished(company.id);
  return (
    <span className="grid flex-1 text-start leading-tight">
      {name === null ? <span>{words.unnamed}</span> : <span className="font-medium" data-company-name>{name}</span>}
      <span className="text-xs text-muted-foreground" data-approvals>{words.approvals(company)}</span>
      {notFinished ? <Badge variant="outline" className="mt-1 justify-self-start" data-not-finished>{t('company.notFinished')}</Badge> : null}
    </span>
  );
}
