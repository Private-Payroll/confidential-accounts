import { useMemo } from 'react';
import { CheckListIcon } from '@hugeicons/core-free-icons';
import { EmptyState, PageHeader, useText } from 'vaults-ui';
import { DataTable, type DataTableColumn, type DataTableFilter } from 'vaults-ui/data-table';
import { ASKS_UNREAD, type ProposalRow } from '../adapters/company-records.js';
import { Details } from '../records/details.js';
import { Approvals, Day, ProposalStatus, ProposalsNotRead, ProposalWhat, ReadOf, WithRecords } from '../records/parts.js';
import { Approve } from '../actions/approve.js';
import { Withdraw } from '../actions/withdraw.js';
import { canApprove, canWithdraw } from '../adapters/proposal-acts.js';
import { usePanel } from '../shell/right-panel.js';

/** The ids of the proposals table's columns and filters, compared by the code and never shown. */
const COLUMN = { what: 'what', raisedBy: 'raised-by', approvals: 'approvals', raised: 'raised', status: 'status' } as const;
const FILTER = { all: 'all', pending: 'pending', approved: 'approved' } as const;

/**
 * PROPOSALS: every proposal the signers raised, newest first, in the kit's
 * table, filtered by all of them, those waiting and those approved. A row
 * opens its panel, where a signer approves it and the signer who raised it
 * may withdraw it. Nothing here declines a proposal.
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
  const filters = useMemo<DataTableFilter<ProposalRow>[]>(() => [
    { id: FILTER.all, label: t('proposals.tab.all'), keeps: () => true },
    { id: FILTER.pending, label: t('proposals.tab.pending'), keeps: (r) => r.status === 'open' },
    { id: FILTER.approved, label: t('proposals.tab.approved'), keeps: (r) => r.status === 'approved' || r.status === 'executed' },
  ], [t]);
  return (
    <div className="flex flex-col gap-3">
      <ProposalsNotRead rows={rows} />
    <DataTable
      label={t('page.proposals.name')}
      rows={newestFirst}
      rowId={(r) => r.id}
      columns={columns}
      filters={filters}
      onRowOpen={(r) => panel.open({ title: t('proposals.panel.title'), body: <ProposalPanel key={r.id} row={r} /> })}
      empty={<EmptyState icon={CheckListIcon}>{t('proposals.none')}</EmptyState>}
    />
    </div>
  );
}

/**
 * Who raised a proposal, by the name the company's record gives them: with why this device does not believe their entry
 * when it does not, with no name when their entry did not check out, or that the record no longer lists them.
 */
function RaisedBy({ row }: { row: ProposalRow }) {
  const t = useText();
  const why = row.raiserNotBelieved ?? null;
  /* An entry not as its own wallet signed it is said with no name: nothing vouches for the one it gives. */
  if (why !== null && row.raisedBy === null) return <span data-raiser-not-believed={why}>{t('proposals.raisedBy.notAsSigned')}</span>;
  if (row.raisedBy === null) return <>{t('proposals.raisedBy.unknown')}</>;
  if (why === null) return <>{row.raisedBy}</>;
  /* A seat not held now, or a holder who has not opened the company yet. */
  const says = why === 'no-entry-of-their-own' ? t('proposals.raisedBy.notOpened', { name: row.raisedBy })
    : why === 'seat-retired' ? t('proposals.raisedBy.retired', { name: row.raisedBy }) : t('proposals.raisedBy.notSeated', { name: row.raisedBy });
  return <span data-raiser-not-believed={why}>{says}</span>;
}

/** A proposal's panel: what it does, who raised it, how many have approved, Approve, and Withdraw for the signer who raised it. */
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
      <div className="flex flex-wrap items-start gap-3">
        <Approve row={row} />
        {canWithdraw(row) ? <Withdraw row={row} /> : null}
      </div>
      {row.status === 'open' && !canApprove(row) ? <NotApprovedHere row={row} /> : null}
    </div>
  );
}

/**
 * Why a waiting proposal has no Approve here: its record, or what it pays, was not read or not believed on this device,
 * so it is not to be approved until it reads; the network has never held it raised; or this page does not approve its kind.
 */
function NotApprovedHere({ row }: { row: ProposalRow }) {
  const t = useText();
  const why = row.asksUnread ?? null;
  const says = why === ASKS_UNREAD.notRead ? t('proposals.approve.notRead') : why === ASKS_UNREAD.notRaised ? t('proposals.approve.notRaised') : t('proposals.approve.notHere');
  return <p className="text-muted-foreground" data-approve-not-here={why ?? ''}>{says}</p>;
}
