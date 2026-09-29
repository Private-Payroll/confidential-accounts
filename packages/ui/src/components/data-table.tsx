import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import {
  createColumnHelper, createPaginatedRowModel, FlexRender, rowPaginationFeature, rowSelectionFeature, tableFeatures, useTable,
  type PaginationState, type RowData, type RowSelectionState,
} from '@tanstack/react-table';
import { Button } from 'vaults-ui/components/button';
import { Checkbox } from 'vaults-ui/components/checkbox';
import { ComingSoon } from 'vaults-ui/components/coming-soon';
import { CountPill } from 'vaults-ui/components/section';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from 'vaults-ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'vaults-ui/components/table';
import { Skeleton } from 'vaults-ui/components/skeleton';
import { Tabs, TabsList, TabsTrigger } from 'vaults-ui/components/tabs';
import { useText } from 'vaults-ui/i18n/provider';
import { cn } from 'vaults-ui/lib/utils';

/** One column: its heading, and what it shows for a row. */
export interface DataTableColumn<T> {
  id: string;
  /** The column's heading, already in the person's language. */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Set against the end of the row, as figures are. */
  end?: boolean;
  /** Set in the middle of the column, heading and entries alike, so each heading sits over its entries. */
  centred?: boolean;
  /**
   * From a tablet up: `wide` takes half the table's width, `narrow` an eighth,
   * and every column given neither takes an equal share of what is left, so
   * the table reads evenly. A table with no column given one is laid out by
   * its contents.
   */
  size?: (typeof COLUMN_SIZE)[keyof typeof COLUMN_SIZE];
}

/** How much of a table's width a column takes, compared by the code and never shown. */
export const COLUMN_SIZE = { wide: 'wide', narrow: 'narrow' } as const;

/** A filter: a tab above the table, with how many rows it keeps in a pill. */
export interface DataTableFilter<T> {
  id: string;
  /** The tab's name, already in the person's language. */
  label: ReactNode;
  keeps: (row: T) => boolean;
  soon?: never;
}

/**
 * A filter not built yet: its tab is shown where it will be, disabled, with
 * the Coming soon pill saying what it will be. It keeps no rows, has no count
 * and can never be chosen.
 */
interface DataTableFilterSoon {
  id: string;
  /** The tab's name, already in the person's language. */
  label: ReactNode;
  /** What the filter will be, in a line or two, already in the person's language. */
  soon: ReactNode;
  keeps?: never;
}

export interface DataTableProps<T> {
  /** The table's accessible name. */
  label: string;
  rows: readonly T[];
  /** Each row's own id: a row chosen stays chosen as the rows change. */
  rowId: (row: T) => string;
  columns: readonly DataTableColumn<T>[];
  /** The filters, as tabs above the table; the first built one is shown first. None, and there are no tabs. */
  filters?: readonly (DataTableFilter<T> | DataTableFilterSoon)[];
  /** What can be done with the table, at the end of the line above it. */
  actions?: ReactNode;
  /** What can be done with one row, at the end of the row. */
  rowActions?: (row: T) => ReactNode;
  /** Given, pressing a row opens it: this is called with the row pressed. */
  onRowOpen?: (row: T) => void;
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

/** No filters: one list, so a table given none keeps the same rows, and the same page, each time it is drawn. */
const NO_FILTERS: readonly never[] = [];

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

/** Whether a filter is built: it keeps rows and can be chosen. */
const isBuilt = <T,>(f: DataTableFilter<T> | DataTableFilterSoon): f is DataTableFilter<T> => f.keeps !== undefined;

function LoadedTable<T extends RowData>({ label, rows, rowId, columns, filters: every = NO_FILTERS, actions, rowActions, onRowOpen, onChosen, pageSize = 10, empty }: DataTableProps<T>) {
  const t = useText();
  /* Kept while the filters given are the same, so the rows shown, and the page they are on, are not made again on every draw. */
  const filters = useMemo(() => every.filter(isBuilt), [every]);
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
  const column = (id: string) => columns.find((c) => c.id === id);
  /* Below a tablet's width a cell wraps its words, so a line of a row fits a phone rather than scrolling sideways. */
  const placed = (id: string): string | undefined => cn(
    'whitespace-normal md:whitespace-nowrap', endOf(id) && 'text-end', column(id)?.centred === true && 'text-center',
    column(id)?.size === COLUMN_SIZE.wide && 'md:w-1/2', column(id)?.size === COLUMN_SIZE.narrow && 'md:w-1/8',
  ) || undefined;
  const spaced = columns.some((c) => c.size !== undefined);
  const pages = Math.max(1, table.getPageCount());
  const chosenCount = Object.values(chosen).filter(Boolean).length;
  const paged = shown.length > PAGE_SIZES['5'] || onChosen !== undefined;
  const sizeChosen = (Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).find((k) => PAGE_SIZES[k] === pagination.pageSize);

  return (
    <div className="flex flex-col gap-3" data-slot="data-table">
      {every.length === 0 && actions === undefined ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2" data-slot="data-table-bar">
          {every.length === 0 ? <span /> : (
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList aria-label={label}>
                {every.map((f) => (isBuilt(f)
                  ? (
                    <TabsTrigger key={f.id} value={f.id} data-filter={f.id}>
                      {f.label}
                      <CountPill count={rows.filter(f.keeps).length} />
                    </TabsTrigger>
                  )
                  /*
                   * The tab, disabled, and its pill beside it rather than in it: the pill is a
                   * button that can still be pressed to say what the filter will be, and a
                   * tab holds nothing that can be pressed on its own.
                   */
                  : (
                    <span key={f.id} className="inline-flex items-center" data-filter-soon={f.id}>
                      <TabsTrigger value={f.id} disabled asChild data-filter={f.id}>
                        <span className="cursor-default opacity-50 hover:text-muted-foreground">{f.label}</span>
                      </TabsTrigger>
                      <ComingSoon explanation={f.soon} />
                    </span>
                  )))}
              </TabsList>
            </Tabs>
          )}
          {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2" data-slot="data-table-actions">{actions}</div>}
        </div>
      )}
      {shown.length === 0 ? empty : (
        <div className="overflow-hidden rounded-lg border">
          {/*
            * ON A PHONE, below a tablet's width, each row is drawn as a block,
            * one line to a column, the column's heading at the start of the
            * line and its entry at the end, so every column is still there and
            * nothing scrolls sideways. The headings row is kept for a screen
            * reader and not shown, and the heading beside each entry is hidden
            * from a screen reader, which has the headings row. From a tablet up
            * the table is drawn as a table.
            */}
          <Table aria-label={label} className={cn('max-md:block', spaced && 'md:table-fixed')} data-spaced={spaced ? '' : undefined}>
            <TableHeader className="bg-muted max-md:sr-only">
              {table.getHeaderGroups().map((g) => (
                <TableRow key={g.id}>
                  {g.headers.map((h) => (
                    <TableHead key={h.id} className={placed(h.column.id)}>
                      {h.isPlaceholder ? null : <FlexRender header={h} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody className="max-md:block">
              {table.getRowModel().rows.map((r) => (
                <TableRow
                  key={r.id}
                  data-selected={r.getIsSelected()}
                  data-row={r.id}
                  className={cn('max-md:flex max-md:flex-col max-md:py-2', onRowOpen !== undefined && 'cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset')}
                  /* A row that opens is reached with the keyboard too, and opened with Enter or Space, as it is by a press. */
                  tabIndex={onRowOpen === undefined ? undefined : 0}
                  onClick={onRowOpen === undefined ? undefined : () => onRowOpen(r.original)}
                  onKeyDown={onRowOpen === undefined ? undefined : (e) => {
                    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                    e.preventDefault();
                    onRowOpen(r.original);
                  }}
                >
                  {r.getAllCells().map((c) => {
                    const heading = column(c.column.id)?.header;
                    return (
                      <TableCell key={c.id} className={cn(placed(c.column.id), 'max-md:flex max-md:items-center max-md:justify-between max-md:gap-4 max-md:py-1 max-md:text-end')}>
                        {heading === undefined ? null : <span aria-hidden className="text-start font-medium text-muted-foreground md:hidden" data-slot="data-table-label">{heading}</span>}
                        <div data-slot="data-table-value"><FlexRender cell={c} /></div>
                      </TableCell>
                    );
                  })}
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
