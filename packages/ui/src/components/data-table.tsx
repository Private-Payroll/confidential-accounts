import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import {
  createColumnHelper, createPaginatedRowModel, FlexRender, rowPaginationFeature, rowSelectionFeature, tableFeatures, useTable,
  type PaginationState, type RowData, type RowSelectionState,
} from '@tanstack/react-table';
import { Button } from 'vaults-ui/components/button';
import { Checkbox } from 'vaults-ui/components/checkbox';
import { CountPill } from 'vaults-ui/components/section';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from 'vaults-ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'vaults-ui/components/table';
import { Skeleton } from 'vaults-ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from 'vaults-ui/components/tabs';
import { useText } from 'vaults-ui/i18n/provider';

/** One column: its heading, and what it shows for a row. */
export interface DataTableColumn<T> {
  id: string;
  /** The column's heading, already in the person's language. */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Set against the end of the row, as figures are. */
  end?: boolean;
}

/** A filter: a tab above the table, with how many rows it keeps in a pill. */
export interface DataTableFilter<T> {
  id: string;
  /** The tab's name, already in the person's language. */
  label: ReactNode;
  keeps: (row: T) => boolean;
}

export interface DataTableProps<T> {
  /** The table's accessible name. */
  label: string;
  rows: readonly T[];
  /** Each row's own id: a row chosen stays chosen as the rows change. */
  rowId: (row: T) => string;
  columns: readonly DataTableColumn<T>[];
  /** The filters, as tabs above the table; the first is shown first. None, and there are no tabs. */
  filters?: readonly DataTableFilter<T>[];
  /** What can be done with the table, at the end of the line above it. */
  actions?: ReactNode;
  /** What can be done with one row, at the end of the row. */
  rowActions?: (row: T) => ReactNode;
  /** Given, rows can be chosen one by one or a page at a time, and this is called with the ids chosen, in the order listed. */
  onChosen?: (ids: readonly string[]) => void;
  /** How many rows a page of the table shows at first. */
  pageSize?: DataTablePageSize;
  /** Shown instead of the table when the filter shown keeps no rows: the kit's empty state. */
  empty: ReactNode;
  /** The rows are still loading: the table is drawn as the table loading, its columns across. */
  loading?: boolean;
}

/** The page sizes the person can choose from, keyed by the text each option shows. */
const PAGE_SIZES = { '5': 5, '10': 10, '20': 20, '50': 50 } as const;

export type DataTablePageSize = (typeof PAGE_SIZES)[keyof typeof PAGE_SIZES];

/** The ids of the table's own columns, and the primitive's name for a box that is partly ticked. Compared by the code, never shown. */
const DATA_TABLE = { choose: 'choose', rowActions: 'row-actions', someChosen: 'indeterminate' } as const;

const features = /* @__PURE__ */ tableFeatures({ rowPaginationFeature, rowSelectionFeature, paginatedRowModel: /* @__PURE__ */ createPaginatedRowModel() });

/**
 * THE KIT'S ONE TABLE, in the shape of shadcn's data table: filters as the
 * kit's tabs above it, each with its count; the table's own actions at the
 * end of that line; columns and rows in a bordered box, headings on the muted
 * shade; a
 * row's own actions at its end; rows chosen with a box at their start where a
 * page needs it; and pages of rows below, with how many a page shows. A page
 * draws its lists of rows with columns with this rather than its own.
 */
export function DataTable<T extends RowData>(props: DataTableProps<T>) {
  /* The loading state stands for the whole table: its columns, and the box to choose a row and the row's actions when the table has them. */
  const columns = props.columns.length + (props.onChosen === undefined ? 0 : 1) + (props.rowActions === undefined ? 0 : 1);
  if (props.loading === true) return <DataTableLoading columns={columns} filters={(props.filters ?? []).length > 0} />;
  return <LoadedTable {...props} />;
}

function LoadedTable<T extends RowData>({ label, rows, rowId, columns, filters = [], actions, rowActions, onChosen, pageSize = 10, empty }: DataTableProps<T>) {
  const t = useText();
  const [filter, setFilter] = useState<string | undefined>(filters[0]?.id);
  const [chosen, setChosen] = useState<RowSelectionState>({});
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize });
  const shown = useMemo(() => {
    const f = filters.find((x) => x.id === filter);
    return f === undefined ? [...rows] : rows.filter(f.keeps);
  }, [rows, filters, filter]);

  const helper = createColumnHelper<typeof features, T>();
  const defs = useMemo(() => helper.columns([
    ...(onChosen === undefined ? [] : [helper.display({
      id: DATA_TABLE.choose,
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && DATA_TABLE.someChosen)}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v === true)}
          aria-label={t('kit.table.chooseAll')}
        />
      ),
      cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(v === true)} aria-label={t('kit.table.chooseRow')} />,
    })]),
    ...columns.map((c) => helper.display({ id: c.id, header: () => c.header, cell: ({ row }) => c.cell(row.original) })),
    ...(rowActions === undefined ? [] : [helper.display({ id: DATA_TABLE.rowActions, header: () => null, cell: ({ row }) => rowActions(row.original) })]),
  ]), [columns, rowActions, onChosen, t]);

  const table = useTable({
    features,
    data: shown,
    columns: defs,
    state: { rowSelection: chosen, pagination },
    getRowId: (row) => rowId(row),
    enableRowSelection: onChosen !== undefined,
    onRowSelectionChange: setChosen,
    onPaginationChange: setPagination,
  });

  /* A filter changed goes back to its first page. */
  useEffect(() => { setPagination((p) => ({ ...p, pageIndex: 0 })); }, [filter]);
  /* The page is told the rows chosen in the order they are listed. */
  useEffect(() => { onChosen?.(rows.map(rowId).filter((id) => chosen[id] === true)); }, [chosen, onChosen]);

  const endOf = (id: string): boolean => id === DATA_TABLE.rowActions || columns.find((c) => c.id === id)?.end === true;
  const pages = Math.max(1, table.getPageCount());
  const chosenCount = Object.values(chosen).filter(Boolean).length;
  const paged = shown.length > PAGE_SIZES['5'] || onChosen !== undefined;
  const sizeChosen = (Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).find((k) => PAGE_SIZES[k] === pagination.pageSize);

  return (
    <div className="flex flex-col gap-3" data-slot="data-table">
      {filters.length === 0 && actions === undefined ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2" data-slot="data-table-bar">
          {filters.length === 0 ? <span /> : (
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList aria-label={label}>
                {filters.map((f) => (
                  <TabsTrigger key={f.id} value={f.id} data-filter={f.id}>
                    {f.label}
                    <CountPill count={rows.filter(f.keeps).length} />
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2" data-slot="data-table-actions">{actions}</div>}
        </div>
      )}
      {shown.length === 0 ? empty : (
        <div className="overflow-hidden rounded-lg border">
          <Table aria-label={label}>
            <TableHeader className="bg-muted">
              {table.getHeaderGroups().map((g) => (
                <TableRow key={g.id}>
                  {g.headers.map((h) => (
                    <TableHead key={h.id} className={endOf(h.column.id) ? 'text-end' : undefined}>
                      {h.isPlaceholder ? null : <FlexRender header={h} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((r) => (
                <TableRow key={r.id} data-selected={r.getIsSelected()} data-row={r.id}>
                  {r.getAllCells().map((c) => (
                    <TableCell key={c.id} className={endOf(c.column.id) ? 'text-end' : undefined}>
                      <FlexRender cell={c} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {shown.length === 0 || !paged ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm" data-slot="data-table-pages">
          <span className="text-muted-foreground" data-chosen={chosenCount}>
            {onChosen === undefined ? null : t('kit.table.chosen', { count: shown.length, chosen: chosenCount })}
          </span>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{t('kit.table.rowsPerPage')}</span>
              <Select value={sizeChosen} onValueChange={(v) => table.setPageSize(PAGE_SIZES[v as keyof typeof PAGE_SIZES])}>
                <SelectTrigger size="sm" aria-label={t('kit.table.rowsPerPage')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <span data-page={pagination.pageIndex + 1}>{t('kit.table.page', { page: pagination.pageIndex + 1, count: pages })}</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label={t('kit.table.previous')} data-action="previous-page">
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="rtl:rotate-180" />
              </Button>
              <Button variant="outline" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label={t('kit.table.next')} data-action="next-page">
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="rtl:rotate-180" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A TABLE WHILE ITS ROWS LOAD: a bar where the filters will be, then the
 * bordered box with its heading row and one bar per row to come, `columns`
 * across, so the page keeps the table's shape and nothing reads as a row.
 */
export function DataTableLoading({ rows = 5, columns = 4, filters = true }: { rows?: number; columns?: number; filters?: boolean }) {
  const cells = Array.from({ length: columns }, (_, c) => c);
  return (
    <div data-slot="data-table-loading" aria-busy={true} className="flex flex-col gap-3">
      {filters ? <Skeleton data-bar="filters" className="h-9 w-64" /> : null}
      <div className="flex flex-col overflow-hidden rounded-lg border">
        <div data-bar="head-row" className="flex gap-4 bg-muted px-2 py-3">{cells.map((c) => <Skeleton key={c} className="h-4 flex-1" />)}</div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} data-bar="row" className="flex gap-4 border-t px-2 py-3">{cells.map((c) => <Skeleton key={c} className="h-4 flex-1" />)}</div>
        ))}
      </div>
    </div>
  );
}
