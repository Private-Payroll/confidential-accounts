import { Store01Icon } from '@hugeicons/core-free-icons';
import { Badge, EmptyState, PageHeader, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn } from 'vaults-ui/data-table';
import { INVITE_KIND } from '../adapters/invite.js';
import { READ, type VendorRow, type VendorsRead } from '../adapters/company-records.js';
import { InvitePeople } from '../actions/invite.js';
import { VendorPanel } from '../actions/vendor-panel.js';
import { BELIEF, BeliefLeftOut, CalendarDate, PaidWords, ReadOf, StandingBadge, TermsOf, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';

/** The ids of the vendors table's columns. */
const COLUMN = { name: 'name', standing: 'standing', terms: 'terms', paid: 'paid', started: 'started' } as const;

/** What the vendors' belief check left out, said above the list: the records it does not believe, and the active vendors it will not pay, each with why. */
function VendorsLeftOut({ belief }: { belief: VendorsRead }) {
  const t = useText();
  return (
    <BeliefLeftOut
      mark={BELIEF.vendors} title={t('vendors.belief.title')}
      notBelieved={belief.notBelieved.length === 0 ? null : { count: belief.notBelieved.length, words: t('vendors.belief.notBelieved', { count: belief.notBelieved.length }) }}
      notPayable={belief.notPayable.map((n) => ({ id: n.vendor.id, words: t('vendors.belief.notPayable', { name: n.vendor.name, why: n.why }) }))}
    />
  );
}

/** The company's vendors, each with how they stand and are paid, beside the records the belief check left out, and the way to invite one. */
export function Vendors() {
  const t = useText();
  const panel = usePanel();
  const columns: DataTableColumn<VendorRow>[] = [
    { id: COLUMN.name, header: t('people.column.name'), cell: (v) => <span className="font-medium">{v.name}</span> },
    {
      id: COLUMN.standing, header: t('people.column.standing'),
      cell: (v) => <span className="flex flex-wrap items-center gap-1.5"><StandingBadge standing={v.standing} />{v.notPayable === null ? null : <Badge variant="destructive" data-not-payable={v.id}>{t('people.notPayable.badge')}</Badge>}</span>,
    },
    { id: COLUMN.terms, header: t('vendors.column.terms'), cell: (v) => <TermsOf vendor={v} /> },
    { id: COLUMN.paid, header: t('people.column.paid'), cell: (v) => <span className="text-muted-foreground"><PaidWords paid={v.paid} /></span> },
    { id: COLUMN.started, header: t('vendors.column.started'), cell: (v) => <CalendarDate date={v.startedAt} /> },
  ];
  return (
    <div className="flex flex-col gap-6" data-screen="vendors">
      <PageHeader title={t('page.vendors.name')} actions={<InvitePeople kind={INVITE_KIND.vendor} />} />
      <WithRecords>
        {(records) => (
          <ReadOf read={records.vendorsBelief ?? { of: READ.unreadable }}>
            {(belief) => (
              <>
                <VendorsLeftOut belief={belief} />
                <DataTable
                  label={t('page.vendors.name')}
                  rows={belief.rows}
                  rowId={(v) => v.id}
                  columns={columns}
                  onRowOpen={(v) => panel.open({ title: v.name, body: <VendorPanel id={v.id} /> })}
                  empty={<EmptyState icon={Store01Icon}>{t('vendors.none')}</EmptyState>}
                />
              </>
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
