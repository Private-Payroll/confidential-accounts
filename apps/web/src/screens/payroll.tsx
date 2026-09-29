import type { ReactNode } from 'react';
import { Invoice01Icon } from '@hugeicons/core-free-icons';
import { EmptyState, PageHeader, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn } from 'vaults-ui/data-table';
import type { RunRow } from '../adapters/company-records.js';
import { PAGE } from '../pages.js';
import { PageLink } from '../router.js';
import { ReadOf, RunMoney, RunStatus, UnbuiltAction, useMonth, WithRecords } from '../records/parts.js';

/** The ids of the runs table's columns, compared by the code and never shown. */
const COLUMN = { month: 'month', people: 'people', total: 'total', status: 'status' } as const;

/**
 * PAYROLL: every payroll run, newest month first, in the kit's table, each
 * with how many it pays, what it pays in each currency, privately and publicly
 * on their own lines, and where it stands. A run's month opens the run's own
 * page, which is shown here in place of the list. Starting a run is not built
 * yet and is shown disabled.
 */
export function Payroll({ children }: { children?: ReactNode }) {
  const t = useText();
  const month = useMonth();
  if (children !== undefined) return <>{children}</>;
  const columns: DataTableColumn<RunRow>[] = [
    { id: COLUMN.month, header: t('payroll.column.month'), cell: (r) => <PageLink to={PAGE.run} params={{ run: r.id }} className="font-medium underline-offset-4 hover:underline">{month(r.period)}</PageLink> },
    { id: COLUMN.people, header: t('payroll.column.people'), cell: (r) => t('payroll.people', { count: r.payees.length }) },
    { id: COLUMN.total, header: t('payroll.column.total'), cell: (r) => <RunMoney run={r} /> },
    { id: COLUMN.status, header: t('payroll.column.status'), cell: (r) => <RunStatus run={r} /> },
  ];
  return (
    <div className="flex flex-col gap-6" data-screen="payroll">
      <PageHeader title={t('page.payroll.name')} actions={<UnbuiltAction data-action="new-run">{t('payroll.newRun')}</UnbuiltAction>} />
      <WithRecords>
        {(records) => (
          <ReadOf read={records.runs}>
            {(runs) => (
              <DataTable
                label={t('page.payroll.name')}
                rows={runs}
                rowId={(r) => r.id}
                columns={columns}
                empty={<EmptyState icon={Invoice01Icon}>{t('payroll.none')}</EmptyState>}
              />
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
