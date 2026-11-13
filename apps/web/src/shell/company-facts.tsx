import { useEffect, useState } from 'react';
import { Badge, formatDate, useLanguage, useText } from 'vaults-ui';
import { creationOfCompany } from '../setup/creation-on-demand.js';
import { approvalsNeededFor, type Company, type SeatBarRead } from '../adapters/session.js';
import type { ActRefusal } from '../adapters/refusals.js';
import { useSessionIfAny } from '../session.js';

/** How the day a company started is written: in the person's language. */
const STARTED_ON = { dateStyle: 'medium' } as const;

/**
 * HOW MANY OF A COMPANY'S SIGNERS MUST APPROVE, as the person's own wallet reads it off the chain, by company. Empty
 * until it is read, and for a company the wallet cannot read: no figure is shown for those, and the service's own
 * number is never put in its place.
 */
function useApprovalsNeeded(): ReadonlyMap<string, SeatBarRead> {
  const person = useSessionIfAny()?.person.id ?? null;
  const [needed, setNeeded] = useState<ReadonlyMap<string, SeatBarRead>>(new Map());
  useEffect(() => {
    if (person === null) return undefined;
    let alive = true;
    void approvalsNeededFor(person).then((n) => { if (alive) setNeeded(n); });
    return () => { alive = false; };
  }, [person]);
  return needed;
}

/** A company's words, in the person's language: what it is called while its name is not open, and how many of its signers must approve of how many there are, once the chain says. */
/**
 * THE ONE WAY A COMPANY IS NAMED IN A LIST: by the name this device holds for it, or, where it holds none, as "A company
 * you started on <day>", the day being the one the service lists the company's account as made (a day, never a name).
 * Without a readable day it is "A company you started". The result is never empty, so no screen shows a blank.
 */
export function useCompanyName(): (company: { createdAt?: string }, name?: string | null) => string {
  const t = useText();
  const language = useLanguage();
  return (company, name = null) => {
    if (typeof name === 'string' && name.trim() !== '') return name;
    const made = new Date(company.createdAt ?? '');
    return Number.isNaN(made.getTime())
      ? t('company.started')
      : t('company.startedOn', { date: formatDate(made, language, STARTED_ON) });
  };
}


export function useCompanyWords(): { approvals: (c: Company) => string; why: (c: Company) => string } {
  const t = useText();
  const needed = useApprovalsNeeded();
  return {
    approvals: (c) => {
      const bar = needed.get(c.id);
      return bar === undefined ? t('switcher.signersOnly', { count: c.signers }) : t('switcher.approvals', { needed: bar.needed, signers: c.signers });
    },
    why: (c) => {
      const bar = needed.get(c.id)?.because;
      return bar === undefined ? '' : bar === 'account' ? t('switcher.because.account') : bar === 'policy-bar' ? t('switcher.because.policyBar') : t('switcher.because.vault');
    },
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
 * Where its name did not open on this device, why is said under the word for it, wrapping within the row. A company
 * the wallet has not opened is said in the words of a list (`inList`: one with no button of its own says where to open it).
 */
export function CompanyFacts({ company, name = null, whyUnnamed = null, inList = false }: {
  company: Company; name?: string | null; whyUnnamed?: ActRefusal | null; inList?: boolean;
}) {
  const words = useCompanyWords();
  const nameOf = useCompanyName();
  const t = useText();
  const notFinished = useNotFinished(company.id);
  /* Why the name did not open on this device, in the person's words; any other reason is said as an action that did not finish. */
  const unnamedBecause = whyUnnamed === null ? undefined : whyUnnamed === 'roster-not-believed' ? t('act.refused.rosterNotBelieved')
    : whyUnnamed === 'no-keys-here' ? t('act.refused.noKeysHere')
      : whyUnnamed === 'not-opened-yet' ? (inList ? t('company.notOpenedYet.switcher') : t('company.notOpenedYet')) : t('act.refused.didNotFinish');
  return (
    <span className="grid min-w-0 flex-1 text-start leading-tight">
      {name === null || name.trim() === ''
        ? <span data-company-unnamed data-why={whyUnnamed ?? undefined}>{nameOf(company)}</span>
        : <span className="font-medium" data-company-name>{name}</span>}
      {unnamedBecause === undefined ? null : <span className="whitespace-normal text-xs text-muted-foreground" data-unnamed-why>{unnamedBecause}</span>}
      <span className="text-xs text-muted-foreground" data-approvals>{words.approvals(company)}</span>
      {words.why(company) === '' ? null : <span className="text-xs text-muted-foreground" data-approvals-why>{words.why(company)}</span>}
      {notFinished ? <Badge variant="outline" className="mt-1 justify-self-start" data-not-finished>{t('company.notFinished')}</Badge> : null}
    </span>
  );
}
