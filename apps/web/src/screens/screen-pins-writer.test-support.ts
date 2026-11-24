/*
 * Writes the pinned reads of the screens and panels from what the count files measured. The pins file is this writer's
 * output: each count file renders every table it measures, from its own run, through `tableSource`, and holds the file's
 * table to the render, so a pin that is not what a run measured fails, and a pin is changed only by running the count file
 * that measures it with WRITE_PINS=1, which rewrites that table, or the rows of the pages and panels it counted, from the run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What one opening read: each route and wallet ask by name, and each read through a door by door and ask, with its count. */
export type PinnedReads = Readonly<Record<string, number>>;
/** A panel opened inside its screen: what the opening read, and what a press on it read where one is run. */
export interface PinnedOpening { readonly opened: PinnedReads; readonly pressed?: PinnedReads }
/** One table of the pins file: its name, what it pins, whether its rows are reads or openings, and its rows by the page, panel or opening they are of. */
export type PinTable =
  | { readonly name: string; readonly about: string; readonly of: 'reads'; readonly rows: Readonly<Record<string, PinnedReads>> }
  | { readonly name: string; readonly about: string; readonly of: 'openings'; readonly rows: Readonly<Record<string, PinnedOpening>> };

const PINS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'screen-count-pins.test-support.ts');

const HEADER = `/*
 * What each page of each screen, each action panel and each first opening reads, on the company the count harness makes at
 * its first size: three people, two vendors, two vaults and one open proposal, in one anchored batch. Every route by name,
 * every ask of the person's wallet and every read through a door by door and ask. A file that counts them on another size of
 * the company holds them to these. Each table is written by the pins writer from a run of the count file that measures
 * it, with WRITE_PINS=1; not changed by hand.
 */
`;
const READS = 'Readonly<Record<string, Readonly<Record<string, number>>>>';
const OPENINGS = 'Readonly<Record<string, { readonly opened: Readonly<Record<string, number>>; readonly pressed?: Readonly<Record<string, number>> }>>';

const readsSource = (reads: PinnedReads): string => `{${Object.keys(reads).sort().map((k) => `'${k}': ${reads[k]}`).join(', ')}}`;
const openingSource = (name: string, row: PinnedOpening): string =>
  `  '${name}': {\n    opened: ${readsSource(row.opened)},\n${row.pressed === undefined ? '' : `    pressed: ${readsSource(row.pressed)},\n`}  },\n`;

/** The text of one table of the pins file, as the writer writes it. */
export const tableSource = (t: PinTable): string => {
  const rows = t.of === 'reads' ? Object.entries(t.rows).map(([n, r]) => `  '${n}': ${readsSource(r)},\n`) : Object.entries(t.rows).map(([n, r]) => openingSource(n, r));
  return `/* ${t.about} */\nexport const ${t.name}: ${t.of === 'reads' ? READS : OPENINGS} = {\n${rows.join('')}};\n`;
};

/* The text of the table named `name` in the pins file's text, from its comment to its close, or null. */
const tableIn = (file: string, name: string): string | null =>
  new RegExp(`/\\* [^\\n]*\\*/\\nexport const ${name}: [^\\n]*\\n(?:[^\\n]*\\n)*?\\};\\n`, 'u').exec(file)?.[0] ?? null;
/* The rows of a table's text, each by its name, in the order the text holds them. */
const rowsIn = (table: string): Map<string, string> =>
  new Map([...table.matchAll(/^ {2}'([^']+)': (?:\{[^\n]*\},\n|\{\n(?:[^\n]*\n)*? {2}\},\n)/gmu)].map((m) => [m[1]!, m[0]]));
/* A table's text from its opening lines and the rows given, in their order. */
const withRows = (table: string, rows: Iterable<string>): string => `${table.slice(0, table.indexOf('= {\n') + 4)}${[...rows].join('')}};\n`;

/**
 * The table named `measured.name` as the pins file holds it, or, when the run counted only some of the table's rows, the
 * rows it counted, in the order it counted them (`not pinned` for one the file has none of). With WRITE_PINS=1 the file's
 * table is first written from `measured`: rewritten whole where it stands, or added at the end, when every row was counted;
 * and when only some were, each of their rows rewritten where it stands, or added after the others. The caller holds what
 * this returns to a second render of its run.
 */
export const tableHeld = (measured: PinTable, everyRowCounted: boolean): string | null => {
  const file = readFileSync(PINS_FILE, 'utf8');
  const was = tableIn(file, measured.name);
  const made = tableSource(measured);
  if (process.env['WRITE_PINS'] === '1') {
    const headed = file.replace(/^\/\*[\s\S]*?\*\/\n/u, HEADER);
    const merged = was === null || everyRowCounted ? made : withRows(made, new Map([...rowsIn(was), ...rowsIn(made)]).values());
    writeFileSync(PINS_FILE, was === null ? `${headed.trimEnd()}\n\n${merged}` : headed.replace(was, () => merged));
  }
  const held = tableIn(readFileSync(PINS_FILE, 'utf8'), measured.name);
  if (held === null || everyRowCounted) return held;
  const rows = rowsIn(held);
  return withRows(held, [...rowsIn(made).keys()].map((n) => rows.get(n) ?? `  '${n}': not pinned\n`));
};
