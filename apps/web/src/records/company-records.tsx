import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Company } from '../adapters/company-records.js';
import { OPENED } from '../adapters/reads.js';
import { companyNamesFor, NO_NAMES, type CompanyNames } from '../adapters/session.js';
import type { ActRefusal } from '../adapters/refusals.js';
import type { PageView } from '../adapters/filing-judge.js';
import { Fault, FAULT } from '../faults.js';
import { VIEWS } from '../pages.js';
import { useAddress } from '../router.js';
import { useSession } from '../session.js';

/* The code that opens a company's records, loaded the first time the frame asks for them rather than with the page. */
const reader = () => import('../adapters/company-records.js');
/* The code that opens the company's view, loaded with it. */
const views = () => import('../adapters/filing-judge.js');

/**
 * THE SHOWN COMPANY'S RECORDS, READ ONCE FOR EVERY PAGE THAT SHOWS THEM: Home,
 * Proposals, Payroll and a run's page, Vaults and a vault's page, People and
 * Invitations, the menu's count of
 * proposals waiting, and the company switcher's names. Each opening of a page
 * reads the company through one view of it (`view`), which every tile and
 * hook of that page reads through too. The records are read when the company
 * shown changes and again when a page asks, after the person opens their
 * saved keys with their account, and the page is blank while they are; they
 * are read again, kept on the page meanwhile, when the person moves to
 * another page, their wallet releases the company's key, or an action in
 * their wallet has run on the company.
 */
export interface Records {
  /** The shown company's records; null while they are read, or when no company is shown. */
  company: Company | null;
  /** The shown company's view for this opening of the page; null until it is open, or when no company is shown. */
  view: PageView | null;
  /** Each company's name that this tab can open, by id, and why each other company's did not open. */
  names: CompanyNames;
  /** Read everything again. */
  reload: () => void;
  /** Open the keys saved for the person with their account, then read again; null when it worked, or why it did not. */
  openKeys: () => Promise<ActRefusal | null>;
}

const RecordsContext = createContext<Records | null>(null);

export function CompanyRecordsProvider({ children }: { children?: ReactNode }) {
  const { person, company: shown, viewer } = useSession();
  const reads = viewer.view === VIEWS.company && shown !== null;
  const place = useAddress();
  const [company, setCompany] = useState<Company | null>(null);
  const [names, setNames] = useState<CompanyNames>(NO_NAMES);
  const [asked, setAsked] = useState(0);
  const [renewed, setRenewed] = useState(0);
  const [view, setView] = useState<PageView | null>(null);
  const reload = useCallback(() => setAsked((n) => n + 1), []);

  /* The page goes blank when the company is read afresh, and the names are read with it. */
  useEffect(() => {
    let alive = true;
    setCompany(null);
    void companyNamesFor(person.id).then((n) => { if (alive) setNames(n); });
    return () => { alive = false; };
  }, [person.id, shown, reads, asked]);

  /*
   * One view for each opening of a page, and the company read through it; what was read before stays on the page
   * meanwhile. The view ends when the opening does, and at once when the wallet releases the company's key, an action
   * in the wallet has run on the company or the sign-in changes; the page then opens another, unless the sign-in ended.
   */
  useEffect(() => {
    setView(null);
    if (!reads) return undefined;
    let alive = true;
    let close = (): void => {};
    void Promise.all([views(), reader()]).then(([{ openViewOf, watchViewEndsFor, ENDED }, { readCompany }]) => {
      if (!alive) return;
      const mine = openViewOf(shown);
      const stop = watchViewEndsFor(shown, (why, again) => {
        mine.end(why);
        if (again) setRenewed((n) => n + 1);
        else setView(null);
      });
      close = () => { stop(); mine.end(ENDED.movedOn); };
      setView(mine);
      void readCompany(person.id, mine).then((c) => { if (alive) setCompany(c); });
    });
    return () => { alive = false; close(); };
  }, [person.id, shown, reads, asked, place, renewed]);

  const openKeys = useCallback(async (): Promise<ActRefusal | null> => {
    const r = await (await reader()).openWithYourAccount(person.id);
    reload();
    return r.of === 'done' ? null : r.why;
  }, [person.id, reload]);

  const value = useMemo<Records>(() => ({ company: reads ? company : null, view: reads ? view : null, names, reload, openKeys }), [reads, company, view, names, reload, openKeys]);
  return <RecordsContext.Provider value={value}>{children}</RecordsContext.Provider>;
}

/** The shown company's records, for a page of the company view. */
export function useCompanyRecords(): Records {
  const records = useContext(RecordsContext);
  /* The frame of a signed-in person always provides them. */
  if (records === null) throw new Fault(FAULT.noCompanyRecords);
  return records;
}

/**
 * The shown company's view for this opening of the page, which every tile and hook reads through; null until it is
 * open, and once it has ended, until the page has opened the next.
 */
export function useCompanyView(): PageView | null {
  const { view } = useCompanyRecords();
  return view !== null && view.ended === null ? view : null;
}

/** The records when they are open, or null. */
export const openRecords = (company: Company | null) => (company?.of === OPENED.open ? company : null);
