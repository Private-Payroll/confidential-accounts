import { useMemo } from 'react';
import { CheckListIcon } from '@hugeicons/core-free-icons';
import { EmptyState, PageHeader, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn, type DataTableFilter } from 'vaults-ui/data-table';
import type { ProposalRow } from '../adapters/company-records.js';
import { Details } from '../records/details.js';
import { Approvals, Day, ProposalStatus, ProposalWhat, ReadOf, UnbuiltAction, WithRecords } from '../records/parts.js';
import { usePanel } from '../shell/right-panel.js';

/** The ids of the proposals table's columns and filters, compared by the code and never shown. Declined is Coming soon: nothing declines a proposal today. */
const COLUMN = { what: 'what', raisedBy: 'raised-by', approvals: 'approvals', raised: 'raised', status: 'status' } as const;
const FILTER = { all: 'all', pending: 'pending', approved: 'approved', declined: 'declined' } as const;

/**
 * PROPOSALS: every proposal the signers raised, newest first, in the kit's
 * table, filtered by all of them, those waiting and those approved; declined
 * is not built yet and its tab is shown disabled. A row opens its panel.
 * Declining and approving are not built yet and are shown disabled.
 */
export function Proposals() {
  const t = useText();
  return (
    <div className="flex flex-col gap-6" data-screen="proposals">
      <PageHeader title={t('page.proposals.name')} />
      <WithRecords>
        {(records) => <ReadOf read={records.proposals}>{(rows) => <ProposalsTable rows={rows} />}</ReadOf>}
      </WithRecords>
    </div>
  );
}

/**
 * The proposals, newest raised first, in the kit's table. The rows and the
 * filters are made once for the proposals read, so the table keeps its page
 * when the page is drawn again, as it is when a panel opens.
 */
function ProposalsTable({ rows }: { rows: readonly ProposalRow[] }) {
  const t = useText();
  const panel = usePanel();
  const newestFirst = useMemo(() => [...rows].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)), [rows]);
  const columns: DataTableColumn<ProposalRow>[] = [
    { id: COLUMN.what, header: t('proposals.column.what'), cell: (r) => <ProposalWhat row={r} /> },
    { id: COLUMN.raisedBy, header: t('proposals.column.raisedBy'), cell: (r) => <RaisedBy row={r} /> },
    { id: COLUMN.approvals, header: t('proposals.column.approvals'), cell: (r) => <Approvals row={r} /> },
    { id: COLUMN.raised, header: t('proposals.column.raised'), cell: (r) => <Day at={r.raisedAt} /> },
    { id: COLUMN.status, header: t('proposals.column.status'), cell: (r) => <ProposalStatus row={r} /> },
  ];
  const filters = useMemo(() => {
    const built: DataTableFilter<ProposalRow>[] = [
      { id: FILTER.all, label: t('proposals.tab.all'), keeps: () => true },
      { id: FILTER.pending, label: t('proposals.tab.pending'), keeps: (r) => r.status === 'open' },
      { id: FILTER.approved, label: t('proposals.tab.approved'), keeps: (r) => r.status === 'approved' || r.status === 'executed' },
    ];
    return [...built, { id: FILTER.declined, label: t('proposals.tab.declined'), soon: t('proposals.declined.soon') }];
  }, [t]);
  return (
    <DataTable
      label={t('page.proposals.name')}
      rows={newestFirst}
      rowId={(r) => r.id}
      columns={columns}
      filters={filters}
      onRowOpen={(r) => panel.open({ title: t('proposals.panel.title'), body: <ProposalPanel row={r} /> })}
      empty={<EmptyState icon={CheckListIcon}>{t('proposals.none')}</EmptyState>}
    />
  );
}

/** Who raised a proposal, by the name the company's record gives them, or that the record no longer lists them. */
function RaisedBy({ row }: { row: ProposalRow }) {
  const t = useText();
  return <>{row.raisedBy ?? t('proposals.raisedBy.unknown')}</>;
}

/** A proposal's panel: what it does, who raised it, how many have approved, and Approve and Decline, both not built yet and shown disabled. */
function ProposalPanel({ row }: { row: ProposalRow }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-4 text-sm" data-proposal-panel={row.id}>
      <p className="font-medium"><ProposalWhat row={row} /></p>
      <Details
        rows={[
          [t('proposals.column.raisedBy'), <RaisedBy row={row} />],
          [t('proposals.column.raised'), <Day at={row.raisedAt} />],
          [t('proposals.column.approvals'), <Approvals row={row} />],
          [t('proposals.column.status'), <ProposalStatus row={row} />],
        ]}
      />
      <div className="flex flex-wrap gap-3">
        <UnbuiltAction data-action="approve">{t('proposals.approve')}</UnbuiltAction>
        <UnbuiltAction data-action="decline">{t('proposals.decline')}</UnbuiltAction>
      </div>
    </div>
  );
}
