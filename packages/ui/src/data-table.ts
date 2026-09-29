/**
 * THE KIT'S TABLE, AS AN ENTRY OF ITS OWN. The table and the library it is
 * built on are needed only by pages loaded when they are opened, so they are
 * reached here rather than through the kit's index, which the first page
 * loads: through the index they would be in every first download.
 */
export { COLUMN_SIZE, DataTable, DataTableLoading, type DataTableColumn, type DataTableFilter, type DataTablePageSize, type DataTableProps } from './components/data-table.js';
