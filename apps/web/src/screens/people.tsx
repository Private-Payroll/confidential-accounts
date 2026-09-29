import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { Amount, Badge, EmptyState, PageHeader, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn } from 'vaults-ui/data-table';
import { STANDING, type PersonRow, type PersonStanding } from '../adapters/company-records.js';
import { Details } from '../records/details.js';
import { Day, PaidWords, ReadOf, UnbuiltAction, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';

/** The ids of the people table's columns, compared by the code and never shown. */
const COLUMN = { name: 'name', title: 'title', standing: 'standing', pay: 'pay', paid: 'paid' } as const;

/**
 * PEOPLE: everyone the company pays, in the kit's table, each with their
 * title, where they stand, their pay and whether they are paid privately or
 * publicly. A row opens the person's panel. Inviting someone is not built yet
 * and is shown disabled.
 */
export function People() {
  const t = useText();
  const panel = usePanel();
  const columns: DataTableColumn<PersonRow>[] = [
    { id: COLUMN.name, header: t('people.column.name'), cell: (p) => <span className="font-medium">{p.name}</span> },
    { id: COLUMN.title, header: t('people.column.title'), cell: (p) => p.title },
    { id: COLUMN.standing, header: t('people.column.standing'), cell: (p) => <StandingBadge standing={p.standing} /> },
    { id: COLUMN.pay, header: t('people.column.pay'), cell: (p) => <Pay person={p} /> },
    { id: COLUMN.paid, header: t('people.column.paid'), cell: (p) => <span className="text-muted-foreground"><PaidWords paid={p.paid} /></span> },
  ];
  return (
    <div className="flex flex-col gap-6" data-screen="people">
      <PageHeader title={t('page.people.name')} actions={<UnbuiltAction data-action="invite">{t('people.invite')}</UnbuiltAction>} />
      <WithRecords>
        {(records) => (
          <ReadOf read={records.people}>
            {(rows) => (
              <DataTable
                label={t('page.people.name')}
                rows={rows}
                rowId={(p) => p.id}
                columns={columns}
                onRowOpen={(p) => panel.open({ title: p.name, body: <PersonPanel person={p} /> })}
                empty={<EmptyState icon={UserGroupIcon}>{t('people.none')}</EmptyState>}
              />
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}

function StandingBadge({ standing }: { standing: PersonStanding }) {
  const t = useText();
  const says: Record<PersonStanding, string> = {
    [STANDING.invited]: t('people.standing.invited'),
    [STANDING.waitingForCheck]: t('people.standing.waitingForCheck'),
    [STANDING.active]: t('people.standing.active'),
    [STANDING.leaver]: t('people.standing.left'),
  };
  return <Badge variant="outline" data-standing={standing}>{says[standing]}</Badge>;
}

/** A person's pay each run, or that it is in a currency this app does not know. */
function Pay({ person }: { person: PersonRow }) {
  const t = useText();
  return person.pay === null ? <>{t('records.unrecognisedOne')}</> : <Amount value={person.pay} kind="to-be-paid" />;
}

/** A person's panel: their details and pay. Their payslips are not built yet and are shown disabled. */
function PersonPanel({ person }: { person: PersonRow }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-4 text-sm" data-person-panel={person.id}>
      <Details
        rows={[
          [t('people.column.title'), person.title],
          [t('people.column.standing'), <StandingBadge standing={person.standing} />],
          [t('people.started'), <Day at={person.startedAt} />],
          [t('people.column.pay'), <Pay person={person} />],
          [t('people.column.paid'), <PaidWords paid={person.paid} />],
        ]}
      />
      <UnbuiltAction data-action="payslips">{t('people.payslips')}</UnbuiltAction>
    </div>
  );
}
