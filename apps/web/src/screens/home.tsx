import { useEffect, useState } from 'react';
import { Badge, Button, ComingSoon, useText } from 'vaults-ui';
import { STANDING as PERSON, type CompanyRecords } from '../adapters/company-records.js';
import { readHandover, type Handover } from '../adapters/handover-state.js';
import { HOME, PAGE } from '../pages.js';
import { go, PageLink } from '../router.js';
import { useSession } from '../session.js';
import { skippedFor, STANDING, standingOf, stepsLeft } from '../setup/standing.js';
import { startSetupAt } from '../setup/asked.js';
import { Approvals, ProposalWhat, ReadOf, RunMoney, RunStatus, SoonAction, useMonth, VaultTile, WithRecords } from '../records/parts.js';

/** How many rows of a list Home shows before "View all". */
const SHOWN = 3;

/**
 * HOME: WHAT NEEDS THIS PERSON ON TOP, MONEY IN THE MIDDLE, THE REST BELOW.
 * The setup card while any setup step is left; proposals waiting and people
 * waiting to join; the vaults; the latest payroll run and the proposals
 * recently passed. Each part is read on its own, so one that could not be
 * read says so and hides nothing else.
 */
export function Home() {
  const t = useText();
  return (
    <div className="flex flex-col gap-8" data-screen="home">
      <WithRecords>
        {(records) => (
          <>
            <h1 className="text-xl font-semibold" data-company-name>{records.name}</h1>
            <SetupCard company={records.id} />
            <section className="flex flex-col gap-3" data-part="needs-you">
              <h2 className="text-sm font-medium text-muted-foreground">{t('home.needsYou')}</h2>
              <div className="grid gap-4 md:grid-cols-2">
                <ProposalsWaiting records={records} />
                <PeopleWaiting records={records} />
              </div>
            </section>
            <Vaults records={records} />
            <div className="grid gap-4 md:grid-cols-2">
              <NextRun records={records} />
              <RecentlyPassed records={records} />
            </div>
            <section className="flex items-center gap-2" data-part="recent-activity">
              <h2 className="text-sm font-medium text-muted-foreground">{t('home.recentActivity')}</h2>
              <ComingSoon explanation={t('home.recentActivity.soon')} />
            </section>
          </>
        )}
      </WithRecords>
    </div>
  );
}

/**
 * THE SETUP CARD: every setup step not done yet, each opening the wizard at
 * it. A step skipped is not done, so it is here, marked Skipped. It goes when
 * every step is done.
 */
function SetupCard({ company }: { company: string }) {
  const t = useText();
  const { person } = useSession();
  const [handover, setHandover] = useState<Handover | null>(null);
  useEffect(() => {
    let alive = true;
    void readHandover(person.id, company).then((h) => { if (alive) setHandover(h); });
    return () => { alive = false; };
  }, [person.id, company]);
  const facts = { company, handover };
  const left = stepsLeft(facts);
  if (left.length === 0) return null;
  const skipped = skippedFor(company);
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" data-part="setup-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t('home.setup.title')}</h2>
        <span className="text-sm text-muted-foreground" data-steps-left={left.length}>{t('home.setup.left', { count: left.length })}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {left.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3" data-step={s.id} data-standing={standingOf(s, facts, skipped)}>
            <span className="flex items-center gap-2 text-sm">
              {s.name(t)}
              {standingOf(s, facts, skipped) === STANDING.skipped ? <Badge variant="outline" data-skipped>{t('setup.skipped')}</Badge> : null}
            </span>
            <Button variant="outline" size="sm" onClick={() => { startSetupAt(s.id); go(HOME.setup); }} data-action="open-step">{t('home.setup.open')}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProposalsWaiting({ records }: { records: CompanyRecords }) {
  const t = useText();
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" data-part="proposals-waiting">
      <ReadOf read={records.proposals}>
        {(rows) => {
          const waiting = rows.filter((r) => r.status === 'open');
          return (
            <>
              <h3 className="font-medium" data-count={waiting.length}>{t('home.proposalsWaiting', { count: waiting.length })}</h3>
              {waiting.length === 0 ? <p className="text-sm text-muted-foreground">{t('home.proposalsWaiting.none')}</p> : (
                <ul className="flex flex-col gap-1 text-sm">
                  {waiting.slice(0, SHOWN).map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2" data-proposal={r.id}><ProposalWhat row={r} /><Approvals row={r} /></li>
                  ))}
                </ul>
              )}
              <PageLink to={PAGE.proposals} className="text-sm underline-offset-4 hover:underline">{t('home.viewAllProposals')}</PageLink>
            </>
          );
        }}
      </ReadOf>
    </section>
  );
}

function PeopleWaiting({ records }: { records: CompanyRecords }) {
  const t = useText();
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" data-part="people-waiting">
      <ReadOf read={records.people}>
        {(rows) => {
          const waiting = rows.filter((p) => p.standing === PERSON.waitingForCheck);
          return (
            <>
              <h3 className="font-medium" data-count={waiting.length}>{t('home.peopleWaiting', { count: waiting.length })}</h3>
              {waiting.length === 0 ? <p className="text-sm text-muted-foreground">{t('home.peopleWaiting.none')}</p> : (
                <ul className="flex flex-col gap-2 text-sm">
                  {waiting.slice(0, SHOWN).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2" data-person={p.id}>
                      <span>{p.name}</span>
                      <SoonAction label={t('people.checkFingerprint')} soon={t('people.checkFingerprint.soon')} data-action="check-fingerprint" />
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </ReadOf>
    </section>
  );
}

function Vaults({ records }: { records: CompanyRecords }) {
  const t = useText();
  return (
    <section className="flex flex-col gap-3" data-part="vaults">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t('page.vaults.name')}</h2>
        <SoonAction label={t('vaults.create')} soon={t('vaults.create.soon')} data-action="create-vault" />
      </div>
      <ReadOf read={records.vaults}>
        {(rows) => rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('vaults.none')}</p> : (
          <div className="grid gap-4 md:grid-cols-3">{rows.map((v, i) => <VaultTile key={v.vault} vault={v} index={i} />)}</div>
        )}
      </ReadOf>
    </section>
  );
}

/** The latest payroll run: the newest month. Whether it has been paid is not said here: the record does not say it. */
function NextRun({ records }: { records: CompanyRecords }) {
  const t = useText();
  const month = useMonth();
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" data-part="next-run">
      <h2 className="font-medium">{t('home.nextRun')}</h2>
      <ReadOf read={records.runs}>
        {(runs) => {
          const next = runs[0];
          if (next === undefined) return <p className="text-sm text-muted-foreground">{t('home.nextRun.none')}</p>;
          return (
            <PageLink to={PAGE.run} params={{ run: next.id }} className="flex flex-col gap-1 text-sm hover:underline" data-run={next.id}>
              <span className="font-medium">{month(next.period)}</span>
              <span>{t('payroll.people', { count: next.payees.length })}</span>
              <RunStatus run={next} />
              <RunMoney run={next} />
            </PageLink>
          );
        }}
      </ReadOf>
    </section>
  );
}

/** The proposals passed most recently. */
function RecentlyPassed({ records }: { records: CompanyRecords }) {
  const t = useText();
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" data-part="recently-passed">
      <h2 className="font-medium">{t('home.recentlyPassed')}</h2>
      <ReadOf read={records.proposals}>
        {(rows) => {
          const passed = rows.filter((r) => r.status === 'approved' || r.status === 'executed').sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)).slice(0, SHOWN);
          return passed.length === 0 ? <p className="text-sm text-muted-foreground">{t('home.recentlyPassed.none')}</p> : (
            <ul className="flex flex-col gap-1 text-sm">{passed.map((r) => <li key={r.id} data-proposal={r.id}><ProposalWhat row={r} /></li>)}</ul>
          );
        }}
      </ReadOf>
    </section>
  );
}
