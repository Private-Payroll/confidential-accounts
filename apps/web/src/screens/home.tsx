import { useEffect, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Activity01Icon, Add01Icon, ArrowDown01Icon, ArrowUp01Icon, CheckListIcon, Invoice01Icon, SafeIcon, UserAdd01Icon } from '@hugeicons/core-free-icons';
import { Badge, Button, ComingSoon, EmptyState, PageHeader, Progress, Section, SectionRow, StatTiles, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn, type DataTableFilter } from 'vaults-ui/data-table';
import { READ, STANDING as PERSON, type CompanyRecords, type ProposalRow, type Read } from '../adapters/company-records.js';
import { readHandover, type Handover } from '../adapters/handover-state.js';
import { browserKeep, keepFold, readFolds } from '../adapters/kept-folds.js';
import { HOME, PAGE } from '../pages.js';
import { go, PageLink } from '../router.js';
import { useSession } from '../session.js';
import { skippedFor, STANDING, standingOf, stepsLeft } from '../setup/standing.js';
import { startSetupAt } from '../setup/asked.js';
import { EVERY_STEP } from '../setup/steps.js';
import { Approvals, Day, ProposalStatus, ProposalWhat, ReadOf, RunMoney, RunStatus, UnbuiltAction, useMonth, VaultTile, WithRecords } from '../records/parts.js';

/** How many rows of a list Home shows before "View all". */
const SHOWN = 3;

/** The ids of the recently passed table's columns and filters, and the two statuses it keeps, compared by the code and never shown; the words shown come from the language file. */
const PASSED = { what: 'what', approvals: 'approvals', status: 'status', raised: 'raised', all: 'all', approved: 'approved', executed: 'executed' } as const;

/**
 * HOME: WHAT IS WAITING ON THIS PERSON ON TOP, MONEY IN THE MIDDLE, THE REST
 * BELOW. The setup card while any setup step is left; proposals and people
 * pending approval; the vaults; the latest payroll run and the proposals
 * recently passed; and recent activity, not built yet. Every part is the
 * kit's section, tile, table or empty state, and each is read on its own, so
 * one that could not be read says so and hides nothing else.
 *
 * AN ACTION NOT BUILT YET IS SHOWN WHERE IT WILL BE, DISABLED, with nothing
 * beside it.
 */
export function Home() {
  const t = useText();
  return (
    <div className="flex flex-col gap-6" data-screen="home">
      <WithRecords>
        {(records) => (
          <>
            <PageHeader title={<span data-company-name>{records.name}</span>} />
            <SetupCard company={records.id} vaults={records.vaults} />
            <div className="flex flex-col gap-3" data-part="pending-approval">
              <h2 className="text-sm font-medium text-muted-foreground">{t('home.pendingApproval')}</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                <ProposalsWaiting records={records} />
                <PeopleWaiting records={records} />
              </div>
            </div>
            <Vaults records={records} />
            <div className="grid items-start gap-4 xl:grid-cols-3">
              <LatestRun records={records} />
              <div className="min-w-0 xl:col-span-2"><RecentlyPassed records={records} /></div>
            </div>
            <Section
              title={<span className="flex items-center gap-2">{t('home.recentActivity')}<ComingSoon explanation={t('home.recentActivity.soon')} /></span>}
              empty={<EmptyState icon={Activity01Icon}>{t('home.recentActivity.none')}</EmptyState>}
              data-part="recent-activity"
            />
          </>
        )}
      </WithRecords>
    </div>
  );
}

/**
 * ONE PART OF HOME, READ ON ITS OWN: drawn by `children` from what was read,
 * or, when it could not be read, as a section under its usual title that
 * says it could not be read, so a part not read is never shown as a part
 * with nothing in it.
 */
function Part<T>({ read, title, children, ...marks }: { read: Read<T>; title: ReactNode; children: (value: T) => ReactNode; 'data-part': string }) {
  if (read.of === READ.unreadable) return <Section title={title} list={false} {...marks}><ReadOf read={read}>{() => null}</ReadOf></Section>;
  return <>{children(read.value)}</>;
}

/**
 * FINISH SETTING UP: how far setup has come, as a bar and in words, and every
 * step not done yet, each opening the wizard at it. A step skipped is not
 * done, so it is here, marked Skipped. The card can be folded to its title and
 * bar, and stays as the person left it for this company, in this browser. It
 * goes when every step is done.
 */
function SetupCard({ company, vaults }: { company: string; vaults: CompanyRecords['vaults'] }) {
  const t = useText();
  const { person } = useSession();
  const [handover, setHandover] = useState<Handover | null>(null);
  const [folded, fold] = useState(() => readFolds(browserKeep()).has(company));
  useEffect(() => {
    let alive = true;
    void readHandover(person.id, company).then((h) => { if (alive) setHandover(h); });
    return () => { alive = false; };
  }, [person.id, company]);
  useEffect(() => { fold(readFolds(browserKeep()).has(company)); }, [company]);
  /* Vaults that could not be read are read as none created, so the step is never shown done on a guess. */
  const facts = { company, handover, vaults: vaults.of === READ.read ? vaults.value : [] };
  const left = stepsLeft(facts);
  if (left.length === 0) return null;
  const skipped = skippedFor(company);
  const standings = EVERY_STEP.map((s) => standingOf(s, facts, skipped));
  const done = standings.filter((s) => s === STANDING.done).length;
  const progress = t('setup.progress', { done, count: EVERY_STEP.length });
  const toggle = (): void => { keepFold(browserKeep(), company, !folded); fold(!folded); };
  const header = {
    title: t('home.setup.title'),
    description: (
      <div className="flex max-w-md flex-col gap-2 pt-1">
        <Progress steps={EVERY_STEP.map((s, i) => ({ id: s.id, done: standings[i] === STANDING.done }))} getValueLabel={() => progress} data-setup-progress />
        <span data-steps-left={left.length} data-steps-done={done}>{progress}</span>
      </div>
    ),
    actions: (
      <Button variant="ghost" size="icon-sm" onClick={toggle} aria-expanded={!folded} aria-label={folded ? t('home.setup.unfold') : t('home.setup.fold')} data-action="fold-setup">
        <HugeiconsIcon icon={folded ? ArrowDown01Icon : ArrowUp01Icon} strokeWidth={2} />
      </Button>
    ),
  };
  if (folded) return <Section {...header} list={false} data-part="setup-card" data-folded>{null}</Section>;
  return (
    <Section {...header} empty={null} data-part="setup-card">
      {left.map((s) => (
        <SectionRow
          key={s.id}
          data-step={s.id}
          data-standing={standingOf(s, facts, skipped)}
          actions={<Button variant="outline" size="sm" onClick={() => { startSetupAt(s.id); go(HOME.setup); }} data-action="open-step">{t('home.setup.open')}</Button>}
        >
          <HugeiconsIcon icon={s.icon} strokeWidth={2} className="size-4 text-muted-foreground" />
          <span>{s.name(t)}</span>
          {standingOf(s, facts, skipped) === STANDING.skipped ? <Badge variant="outline" data-skipped>{t('setup.skipped')}</Badge> : null}
        </SectionRow>
      ))}
    </Section>
  );
}

/** Proposals waiting for approval. Approving and declining are built together with raising a proposal; until then both are shown disabled. */
function ProposalsWaiting({ records }: { records: CompanyRecords }) {
  const t = useText();
  const create = <UnbuiltAction data-action="create-proposal">{<HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />}{t('home.proposals.create')}</UnbuiltAction>;
  return (
    <Part read={records.proposals} title={t('page.proposals.name')} data-part="proposals-waiting">
      {(rows) => {
        const waiting = rows.filter((r) => r.status === 'open');
        return (
          <Section
            title={t('page.proposals.name')}
            count={waiting.length}
            actions={<>{create}<Button variant="outline" asChild><PageLink to={PAGE.proposals} data-action="view-all-proposals">{t('home.viewAll')}</PageLink></Button></>}
            empty={<EmptyState icon={CheckListIcon}>{t('home.proposalsWaiting.none')}</EmptyState>}
            data-part="proposals-waiting"
          >
            {waiting.slice(0, SHOWN).map((r) => (
              <SectionRow
                key={r.id}
                data-proposal={r.id}
                actions={(
                  <>
                    <UnbuiltAction size="sm" data-action="approve">{t('proposals.approve')}</UnbuiltAction>
                    <UnbuiltAction size="sm" variant="outline" data-action="decline">{t('proposals.decline')}</UnbuiltAction>
                  </>
                )}
              >
                <span className="font-medium"><ProposalWhat row={r} /></span>
                <span className="text-muted-foreground"><Approvals row={r} /></span>
              </SectionRow>
            ))}
          </Section>
        );
      }}
    </Part>
  );
}

/** People to be paid waiting to join. Inviting and the fingerprint check that lets a person in are built together with joining; until then both are shown disabled. */
function PeopleWaiting({ records }: { records: CompanyRecords }) {
  const t = useText();
  const invite = <UnbuiltAction data-action="invite">{<HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />}{t('people.invite')}</UnbuiltAction>;
  return (
    <Part read={records.people} title={t('page.people.name')} data-part="people-waiting">
      {(rows) => {
        const waiting = rows.filter((p) => p.standing === PERSON.waitingForCheck);
        return (
          <Section
            title={t('page.people.name')}
            count={waiting.length}
            actions={invite}
            empty={<EmptyState icon={UserAdd01Icon}>{t('home.peopleWaiting.none')}</EmptyState>}
            data-part="people-waiting"
          >
            {waiting.slice(0, SHOWN).map((p) => (
              <SectionRow key={p.id} data-person={p.id} actions={<UnbuiltAction size="sm" data-action="check-fingerprint">{t('people.checkFingerprint')}</UnbuiltAction>}>
                <span className="font-medium">{p.name}</span>
              </SectionRow>
            ))}
          </Section>
        );
      }}
    </Part>
  );
}

/** One tile per vault, or the empty state; creating one leads to the Vaults page. */
function Vaults({ records }: { records: CompanyRecords }) {
  const t = useText();
  /* Creating a vault is done on the Vaults page, from the one component the setup wizard's step shows too. */
  const create = <Button variant="outline" asChild><PageLink to={PAGE.vaults} data-action="create-vault"><HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />{t('vaults.create')}</PageLink></Button>;
  return (
    <Part read={records.vaults} title={t('page.vaults.name')} data-part="vaults">
      {(rows) => (
        <Section title={t('page.vaults.name')} count={rows.length} actions={rows.length === 0 ? undefined : create} list={false} box={false} data-part="vaults">
          {rows.length === 0
            ? <EmptyState icon={SafeIcon} action={create}>{t('vaults.none')}</EmptyState>
            : <StatTiles>{rows.map((v, i) => <VaultTile key={v.vault} company={records.id} vault={v} index={i} />)}</StatTiles>}
        </Section>
      )}
    </Part>
  );
}

/** The latest payroll run: the newest month. Whether it has been paid is not said here: the record does not say it. */
function LatestRun({ records }: { records: CompanyRecords }) {
  const t = useText();
  const month = useMonth();
  const newRun = <UnbuiltAction data-action="new-run">{t('payroll.newRun')}</UnbuiltAction>;
  return (
    <Part read={records.runs} title={t('home.nextRun')} data-part="next-run">
      {(runs) => {
        const latest = runs[0];
        return (
          <Section
            title={t('home.nextRun')}
            actions={latest === undefined ? undefined : <Button variant="outline" asChild><PageLink to={PAGE.payroll} data-action="view-all-runs">{t('home.viewAll')}</PageLink></Button>}
            empty={<EmptyState icon={Invoice01Icon} action={newRun}>{t('home.nextRun.none')}</EmptyState>}
            data-part="next-run"
          >
            {latest === undefined ? null : (
              <SectionRow key={latest.id} data-run={latest.id}>
                <div className="flex flex-col gap-1">
                  <PageLink to={PAGE.run} params={{ run: latest.id }} className="font-medium underline-offset-4 hover:underline">{month(latest.period)}</PageLink>
                  <span className="text-muted-foreground">{t('payroll.people', { count: latest.payees.length })}</span>
                  <RunStatus run={latest} />
                  <RunMoney run={latest} />
                </div>
              </SectionRow>
            )}
          </Section>
        );
      }}
    </Part>
  );
}

/** The proposals passed, newest raised first, in the kit's table: all of them, or those approved, or those carried out. */
function RecentlyPassed({ records }: { records: CompanyRecords }) {
  const t = useText();
  const columns: DataTableColumn<ProposalRow>[] = [
    { id: PASSED.what, header: t('home.recentlyPassed.what'), cell: (r) => <ProposalWhat row={r} /> },
    { id: PASSED.approvals, header: t('home.recentlyPassed.approvals'), cell: (r) => <Approvals row={r} /> },
    { id: PASSED.status, header: t('home.recentlyPassed.status'), cell: (r) => <ProposalStatus row={r} /> },
    { id: PASSED.raised, header: t('home.recentlyPassed.raised'), cell: (r) => <Day at={r.raisedAt} /> },
  ];
  const filters: DataTableFilter<ProposalRow>[] = [
    { id: PASSED.all, label: t('home.recentlyPassed.all'), keeps: () => true },
    { id: PASSED.approved, label: t('proposals.status.approved'), keeps: (r) => r.status === PASSED.approved },
    { id: PASSED.executed, label: t('proposals.status.executed'), keeps: (r) => r.status === PASSED.executed },
  ];
  return (
    <Part read={records.proposals} title={t('home.recentlyPassed')} data-part="recently-passed">
      {(rows) => {
        const passed = rows.filter((r) => r.status === 'approved' || r.status === 'executed').sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
        return (
          <Section title={t('home.recentlyPassed')} list={false} data-part="recently-passed">
            <DataTable
              label={t('home.recentlyPassed')}
              rows={passed}
              rowId={(r) => r.id}
              columns={columns}
              filters={filters}
              rowActions={() => <Button variant="ghost" size="sm" asChild><PageLink to={PAGE.proposals} data-action="view-proposal">{t('home.recentlyPassed.view')}</PageLink></Button>}
              pageSize={5}
              empty={<EmptyState icon={CheckListIcon}>{t('home.recentlyPassed.none')}</EmptyState>}
            />
          </Section>
        );
      }}
    </Part>
  );
}
