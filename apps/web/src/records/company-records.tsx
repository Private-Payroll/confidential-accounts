import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Company } from '../adapters/company-records.js';
import { OPENED } from '../adapters/reads.js';
import { companyNamesFor } from '../adapters/session.js';
import type { ActRefusal } from '../adapters/refusals.js';
import { Fault, FAULT } from '../faults.js';
import { VIEWS } from '../pages.js';
import { useSession } from '../session.js';

/* The code that opens a company's records, loaded the first time the frame asks for them rather than with the page. */
const reader = () => import('../adapters/company-records.js');

/**
 * THE SHOWN COMPANY'S RECORDS, READ ONCE FOR EVERY PAGE THAT SHOWS THEM: Home,
 * Proposals, Payroll and a run's page, Vaults and a vault's page, People and
 * Invitations, the menu's count of
 * proposals waiting, and the company switcher's names. Read when the company
 * shown changes, and again when a page asks, after the person opens their
 * saved keys with their account.
 */
export interface Records {
  /** The shown company's records; null while they are read, or when no company is shown. */
  company: Company | null;
  /** Each company's name that this tab can open, by id. */
  names: ReadonlyMap<string, string>;
  /** Read everything again. */
  reload: () => void;
  /** Open the keys saved for the person with their account, then read again; null when it worked, or why it did not. */
  openKeys: () => Promise<ActRefusal | null>;
}

const RecordsContext = createContext<Records | null>(null);

export function CompanyRecordsProvider({ children }: { children?: ReactNode }) {
  const { person, company: shown, viewer } = useSession();
  const reads = viewer.view === VIEWS.company && shown !== null;
  const [company, setCompany] = useState<Company | null>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setCompany(null);
    void companyNamesFor(person.id).then((n) => { if (alive) setNames(n); });
    if (reads) void reader().then(({ readCompany }) => readCompany(person.id, shown)).then((c) => { if (alive) setCompany(c); });
    return () => { alive = false; };
  }, [person.id, shown, reads, asked]);

  const openKeys = useCallback(async (): Promise<ActRefusal | null> => {
    const r = await (await reader()).openWithYourAccount(person.id);
    reload();
    return r.of === 'done' ? null : r.why;
  }, [person.id, reload]);

  const value = useMemo<Records>(() => ({ company: reads ? company : null, names, reload, openKeys }), [reads, company, names, reload, openKeys]);
  return <RecordsContext.Provider value={value}>{children}</RecordsContext.Provider>;
}

/** The shown company's records, for a page of the company view. */
export function useCompanyRecords(): Records {
  const records = useContext(RecordsContext);
  /* The frame of a signed-in person always provides them. */
  if (records === null) throw new Fault(FAULT.noCompanyRecords);
  return records;
}

/** The records when they are open, or null. */
export const openRecords = (company: Company | null) => (company?.of === OPENED.open ? company : null);
