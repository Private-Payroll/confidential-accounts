import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { Badge, EmptyState, PageHeader, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn } from 'vaults-ui/data-table';
import { READ, type PeopleBelief, type PersonRow } from '../adapters/company-records.js';
import { InvitePeople } from '../actions/invite.js';
import { PersonPanel } from '../actions/person-panel.js';
import { BELIEF, BeliefLeftOut, PaidWords, PayOf, ReadOf, StandingBadge, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';


const COLUMN = { name: 'name', title: 'title', standing: 'standing', pay: 'pay', paid: 'paid' } as const;


/** The people the belief check left out or will not pay, each said once: shown whenever there is any, never only the rows. */
function PeopleLeftOut({ belief }: { belief: PeopleBelief }) {
  const t = useText();
  return (
    <BeliefLeftOut
      mark={BELIEF.people} title={t('people.belief.title')}
      notBelieved={belief.notBelieved.length === 0 ? null : { count: belief.notBelieved.length, words: t('people.belief.notBelieved', { count: belief.notBelieved.length }) }}
      refused={belief.refused.map((r) => ({ id: r.id, words: t('people.belief.refused', { id: r.id, why: r.why }) }))}
      notPayable={belief.notPayable.map((n) => ({ id: n.person.id, words: t('people.belief.notPayable', { name: n.person.name, why: n.why }) }))}
    />
  );
}


export function People() {
  const t = useText();
  const panel = usePanel();
  const columns: DataTableColumn<PersonRow>[] = [
    { id: COLUMN.name, header: t('people.column.name'), cell: (p) => <span className="font-medium">{p.name}</span> },
    { id: COLUMN.title, header: t('people.column.title'), cell: (p) => p.title },
    { id: COLUMN.standing, header: t('people.column.standing'), cell: (p) => <span className="flex flex-wrap items-center gap-1.5"><StandingBadge standing={p.standing} />{p.notPayable === null ? null : <Badge variant="destructive" data-not-payable={p.id}>{t('people.notPayable.badge')}</Badge>}</span> },
    { id: COLUMN.pay, header: t('people.column.pay'), cell: (p) => <PayOf person={p} /> },
    { id: COLUMN.paid, header: t('people.column.paid'), cell: (p) => <span className="text-muted-foreground"><PaidWords paid={p.paid} /></span> },
  ];
  return (
    <div className="flex flex-col gap-6" data-screen="people">
      <PageHeader title={t('page.people.name')} actions={<InvitePeople />} />
      <WithRecords>
        {(records) => (
          <ReadOf read={records.peopleBelief ?? { of: READ.unreadable }}>
            {(belief) => (
              <>
                <PeopleLeftOut belief={belief} />
                <DataTable
                  label={t('page.people.name')}
                  rows={belief.rows}
                  rowId={(p) => p.id}
                  columns={columns}
                  onRowOpen={(p) => panel.open({ title: p.name, body: <PersonPanel id={p.id} /> })}
                  empty={<EmptyState icon={UserGroupIcon}>{t('people.none')}</EmptyState>}
                />
              </>
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
