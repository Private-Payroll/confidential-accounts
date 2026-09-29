// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxIcon } from '@hugeicons/core-free-icons';
import { KitProvider } from '../kit-provider.js';
import { languagesFrom } from '../i18n/languages.js';
import { AmountLoading } from './amount.js';
import { BalanceLoading } from './balance.js';
import { Button } from './button.js';
import { ComingSoon } from './coming-soon.js';
import { DataTable, DataTableLoading } from './data-table.js';
import { EmptyState } from './empty-state.js';
import { FocusedLayout, PageLayout, PageLoading } from './page-layout.js';
import { Progress } from './progress.js';
import { Section, SectionLoading, SectionRow } from './section.js';
import { SoonAction } from './soon-action.js';
import { StatTile, StatTileLoading } from './stat-tile.js';

/*
 * THE FOUNDATION'S LOOK, AS THE KIT DRAWS IT: an action outweighs Coming
 * soon; a section has its title, count, actions, rows and empty state; a
 * tile its figure and, only when given one, its change; the table its
 * filters, pages and chosen rows; and each layout sets the page's width.
 */
afterEach(cleanup);
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/src/locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const inKit = (ui: React.ReactNode) => render(<KitProvider languages={LANGUAGES} pick="en">{ui}</KitProvider>);
const q = (c: ParentNode, sel: string) => c.querySelector(sel) as HTMLElement | null;
const all = (c: ParentNode, sel: string) => [...c.querySelectorAll(sel)] as HTMLElement[];

/** How heavy an element's own classes draw it: its height, in Tailwind's steps, and its font weight. Classes behind a variant (`hover:`) are not its resting look. */
const WEIGHTS = { normal: 400, medium: 500, semibold: 600, bold: 700 } as const;
function weightOf(className: string): { height: number | null; weight: number } {
  const plain = className.split(/\s+/).filter((c) => c !== '' && !c.includes(':'));
  const h = plain.map((c) => /^(?:h|size)-(\d+(?:\.\d+)?)$/.exec(c)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  const w = plain.map((c) => /^font-(normal|medium|semibold|bold)$/.exec(c)?.[1]).filter((x): x is keyof typeof WEIGHTS => x !== undefined).map((k) => WEIGHTS[k]);
  return { height: h.length === 0 ? null : h[h.length - 1]!, weight: w.length === 0 ? WEIGHTS.normal : w[w.length - 1]! };
}

describe('an action outweighs Coming soon', () => {
  /* RED WHEN: the reader of a class's weight stops reading a height, a size or a weight, or reads one behind a variant as the resting look. */
  it('reads how heavy a class draws an element', () => {
    expect(weightOf('h-8 font-medium hover:font-bold')).toEqual({ height: 8, weight: 500 });
    expect(weightOf('size-7 text-sm')).toEqual({ height: 7, weight: 400 });
    expect(weightOf('h-5 h-4 font-medium font-normal')).toEqual({ height: 4, weight: 400 });
  });

  /*
   * RED WHEN: the Coming soon pill is as tall as, or taller than, the
   * smallest button an action is drawn with; is written as heavy; is filled
   * (any background at rest but none); or loses the muted colour at rest.
   */
  it('draws the pill shorter, lighter and quieter than any action beside it', () => {
    const { container } = inKit(<><Button data-t="default">A</Button><Button size="sm" data-t="sm">B</Button><ComingSoon explanation="x" /></>);
    const pill = q(container, '[data-slot=coming-soon]')!;
    const p = weightOf(pill.className);
    for (const size of ['default', 'sm']) {
      const b = weightOf(q(container, `[data-t=${size}]`)!.className);
      expect(p.height, size).not.toBeNull();
      expect(p.height!, size).toBeLessThan(b.height!);
      expect(p.weight, size).toBeLessThan(b.weight);
    }
    const resting = pill.className.split(/\s+/).filter((c) => c !== '' && !c.includes(':'));
    expect(resting).toContain('text-muted-foreground');
    expect(resting.filter((c) => /^text-/.test(c) && !/^text-(xs|sm|base|muted-foreground)$/.test(c))).toEqual([]);
    expect(resting.filter((c) => /^bg-/.test(c) && c !== 'bg-transparent')).toEqual([]);
  });

  /* RED WHEN: an action not built yet can be pressed, loses its pill, or is drawn in another size or variant than the same action will be once built. */
  it.each([['default', 'default'], ['outline', 'sm']] as const)('draws an action not built yet as it will be (%s, %s), disabled, with its pill', (variant, size) => {
    const { container } = inKit(<><SoonAction variant={variant} size={size} label="Create" soon="later" data-t="soon" /><Button variant={variant} size={size} data-t="built">Create</Button></>);
    const soon = q(container, '[data-t=soon] button:not([data-slot=coming-soon])')!;
    expect(soon.hasAttribute('disabled')).toBe(true);
    expect(q(container, '[data-t=soon] [data-slot=coming-soon]')).not.toBeNull();
    expect(soon.className).toBe(q(container, '[data-t=built]')!.className);
  });
});

describe('a section', () => {
  /* RED WHEN: a section loses its title, its count pill, its actions at the end, its rows, or its box. */
  it('has a title with a count, actions at the end, one row per item, in a box', () => {
    const { container } = inKit(
      <Section title="Proposals" count={2} actions={<button type="button" data-t="act">+</button>} empty={<span data-t="empty" />} data-part="p">
        <SectionRow data-t="r1" actions={<button type="button">a</button>}>One</SectionRow>
        <SectionRow data-t="r2">Two</SectionRow>
      </Section>,
    );
    const s = q(container, '[data-part=p]')!;
    expect(q(s, 'h2')!.textContent).toBe('Proposals');
    expect(q(s, '[data-slot=count-pill]')!.textContent).toBe('2');
    expect(q(s, '[data-slot=section-actions] [data-t=act]')).not.toBeNull();
    expect(all(s, '[data-slot=section-rows] > [data-slot=section-row]').map((r) => r.dataset.t)).toEqual(['r1', 'r2']);
    expect(q(s, '[data-t=empty]')).toBeNull();
    expect(s.className).toContain('bg-card');
  });

  /* RED WHEN: a section with no rows shows an empty list instead of its empty state, or its count disappears at none. */
  it('shows its empty state when there are no rows, and a count of none', () => {
    const { container } = inKit(<Section title="People" count={0} empty={<EmptyState icon={InboxIcon} action={<button type="button" data-t="next">Invite</button>}>Nobody yet.</EmptyState>}>{[]}</Section>);
    expect(q(container, '[data-slot=section-rows]')).toBeNull();
    expect(q(container, '[data-slot=empty-state] [data-slot=empty-state-line]')!.textContent).toBe('Nobody yet.');
    expect(q(container, '[data-slot=empty-state] svg')).not.toBeNull();
    expect(q(container, '[data-slot=empty-state] [data-t=next]')).not.toBeNull();
    expect(q(container, '[data-slot=count-pill]')!.textContent).toBe('0');
  });

  /* RED WHEN: a section holding something other than rows, such as a table, loses its box. */
  it('keeps its box when it holds something other than rows', () => {
    const { container } = inKit(<Section title="Recently passed" list={false}><p>table</p></Section>);
    const s = q(container, '[data-slot=section]')!;
    expect(s.getAttribute('data-box')).toBe('true');
    expect(s.className).toContain('bg-card');
  });

  /* RED WHEN: a section of tiles is drawn in a box, so the tiles, which are boxes themselves, no longer stand a shade apart from what they sit on. */
  it('draws a section of tiles on the page, with no box', () => {
    const { container } = inKit(<Section title="Vaults" list={false} box={false}><StatTile title="Vault 1" /></Section>);
    const s = q(container, '[data-slot=section]')!;
    expect(s.getAttribute('data-box')).toBe('false');
    expect(s.className).not.toContain('bg-card');
    expect(q(s, '[data-slot=stat-tile]')!.className).toContain('bg-card');
  });
});

describe('a stat tile', () => {
  /* RED WHEN: the tile loses its title, figure, tagline or subtext, or shows a change it was not given. */
  it('shows its title, figure, tagline and subtext, and no change unless given one', () => {
    const { container } = inKit(<StatTile title="Held" figure="12" tagline="Held by your signers" subtext="Created Sep 1" />);
    expect(q(container, '[data-slot=stat-tile-title]')!.textContent).toBe('Held');
    expect(q(container, '[data-slot=stat-tile-figure]')!.textContent).toBe('12');
    expect(q(container, '[data-slot=stat-tile-tagline]')!.textContent).toBe('Held by your signers');
    expect(q(container, '[data-slot=stat-tile-subtext]')!.textContent).toBe('Created Sep 1');
    expect(q(container, '[data-slot=stat-tile-change]')).toBeNull();
  });

  /* RED WHEN: a change given is not shown, or does not say which way it went. */
  it('shows a change given, up or down, with its label', () => {
    const { container } = inKit(<><StatTile title="a" change={{ direction: 'up', label: '+4%' }} /><StatTile title="b" change={{ direction: 'down', label: '-2%' }} /></>);
    expect(all(container, '[data-slot=stat-tile-change]').map((e) => [e.dataset.direction, e.textContent])).toEqual([['up', '+4%'], ['down', '-2%']]);
  });

  /* RED WHEN: a tile given a link is not that link, or loses what it shows inside it. */
  it('becomes the link it is given, with what it shows inside', () => {
    const { container } = inKit(<StatTile title="Vault 1" link={<a href="/vaults/v1" data-t="link" />} />);
    const link = q(container, 'a[data-t=link]')!;
    expect(link.getAttribute('data-slot')).toBe('stat-tile');
    expect(q(link, '[data-slot=stat-tile-title]')!.textContent).toBe('Vault 1');
  });
});

describe('the layouts', () => {
  /* RED WHEN: the page layout loses its maximum width or its centring, so a page on a wide monitor runs edge to edge. */
  it('holds a page to a maximum width, centred', () => {
    const { container } = inKit(<PageLayout><p>x</p></PageLayout>);
    const l = q(container, '[data-slot=page-layout]')!.className.split(/\s+/);
    expect(l).toEqual(expect.arrayContaining(['max-w-7xl', 'mx-auto', 'w-full']));
  });

  /* RED WHEN: the focused layout loses its way out, its title, its inset page on the frame's shade, or its width. */
  it('draws a focused page on the frame, with its title and way out across the top', () => {
    const { container } = inKit(<FocusedLayout title="Set up" exit={<button type="button" data-t="exit">Exit</button>}><p data-t="body">x</p></FocusedLayout>);
    const l = q(container, '[data-slot=focused-layout]')!;
    expect(l.className).toContain('bg-sidebar');
    expect(q(l, '[data-slot=focused-title]')!.textContent).toBe('Set up');
    expect(q(l, 'header [data-t=exit]')).not.toBeNull();
    const page = q(l, 'main')!;
    expect(page.className).toContain('bg-background');
    expect(q(page, '[data-t=body]')!.parentElement!.className).toContain('max-w-4xl');
  });
});

describe('progress', () => {
  /* RED WHEN: a mark is filled for a step not done, or not for one done, whatever order they were done in; or the bar says a different number done. */
  it('fills the mark of each step done, and says how many', () => {
    const { container } = inKit(<Progress steps={[{ id: 'a', done: true }, { id: 'b', done: false }, { id: 'c', done: true }]} getValueLabel={() => '2 of 3'} />);
    expect(all(container, '[data-slot=progress-mark]').map((m) => [m.dataset.mark, m.dataset.filled])).toEqual([['a', 'true'], ['b', 'false'], ['c', 'true']]);
    const bar = q(container, '[data-slot=progress]')!;
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax'), bar.getAttribute('aria-valuetext')]).toEqual(['2', '3', '2 of 3']);
  });
});

describe('the table', () => {
  interface Row { id: string; name: string; done: boolean }
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ id: `r${i + 1}`, name: `Row ${i + 1}`, done: i % 3 === 0 }));
  const columns = [{ id: 'name', header: 'Name', cell: (r: Row) => r.name }, { id: 'state', header: 'State', cell: (r: Row) => (r.done ? 'done' : 'open'), end: true }];
  const filters = [{ id: 'all', label: 'All', keeps: () => true }, { id: 'done', label: 'Done', keeps: (r: Row) => r.done }];
  const table = (over: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) => inKit(
    <DataTable<Row> label="Things" rows={rows} rowId={(r) => r.id} columns={columns} filters={filters} pageSize={5}
      actions={<button type="button" data-t="add">Add</button>} rowActions={(r) => <button type="button" data-t={`open-${r.id}`}>Open</button>}
      empty={<span data-t="empty" />} {...over} />,
  );

  /* RED WHEN: the table loses its headings, its rows' order, a row's own actions at its end, or its actions above it. */
  it('draws its columns, a page of rows with their actions at the end, and its actions above', () => {
    const { container } = table();
    expect(all(container, 'thead th').map((h) => h.textContent)).toEqual(['Name', 'State', '']);
    expect(all(container, 'tbody tr').map((r) => r.dataset.row)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(q(container, 'tbody tr[data-row=r1] td:last-child [data-t=open-r1]')).not.toBeNull();
    expect(q(container, '[data-slot=data-table-actions] [data-t=add]')).not.toBeNull();
    expect(q(container, 'thead th:nth-child(2)')!.className).toContain('text-end');
  });

  /* RED WHEN: the filters are not the kit's tabs, lose their counts, or choosing one does not keep only its rows. */
  it('filters by the kit\'s tabs, each with its count', async () => {
    const { container } = table();
    const tabs = all(container, '[data-slot=tabs-list] [data-filter]');
    expect(tabs.map((t) => [t.dataset.filter, q(t, '[data-slot=count-pill]')!.textContent])).toEqual([['all', '12'], ['done', '4']]);
    await act(async () => { fireEvent.mouseDown(tabs[1]!, { button: 0 }); });
    expect(all(container, 'tbody tr').map((r) => r.dataset.row)).toEqual(['r1', 'r4', 'r7', 'r10']);
  });

  /* RED WHEN: the table shows every row at once past a page, or its pages do not move forward and back. */
  it('shows its rows a page at a time', async () => {
    const { container } = table();
    expect(q(container, '[data-page]')!.textContent).toBe('Page 1 of 3');
    await act(async () => { fireEvent.click(q(container, '[data-action=next-page]')!); });
    expect(all(container, 'tbody tr').map((r) => r.dataset.row)).toEqual(['r6', 'r7', 'r8', 'r9', 'r10']);
    expect(q(container, '[data-page]')!.textContent).toBe('Page 2 of 3');
    await act(async () => { fireEvent.click(q(container, '[data-action=previous-page]')!); });
    expect(all(container, 'tbody tr')[0]!.dataset.row).toBe('r1');
  });

  /* RED WHEN: rows cannot be chosen where the page asks for it, the page is not told which are chosen, or a table that does not ask draws the boxes. */
  it('lets rows be chosen only where the page asks, and says which', async () => {
    expect(q(table().container, '[role=checkbox]')).toBeNull();
    cleanup();
    const chosen = vi.fn();
    const { container } = table({ onChosen: chosen });
    const boxes = all(container, 'tbody [role=checkbox]');
    expect(boxes.length).toBe(5);
    await act(async () => { fireEvent.click(boxes[1]!); });
    expect(chosen).toHaveBeenLastCalledWith(['r2']);
    expect(q(container, 'tbody tr[data-row=r2]')!.getAttribute('data-selected')).toBe('true');
    await act(async () => { fireEvent.click(q(container, 'thead [role=checkbox]')!); });
    expect(chosen).toHaveBeenLastCalledWith(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(q(container, '[data-chosen]')!.textContent).toBe('5 of 12 rows selected');
  });

  /* RED WHEN: a table with no rows, or a filter that keeps none of the rows there are, draws an empty table instead of the empty state. */
  it('shows its empty state when nothing is kept', async () => {
    const { container } = table({ rows: [] });
    expect(q(container, '[data-t=empty]')).not.toBeNull();
    expect(q(container, 'table')).toBeNull();
    cleanup();
    const kept = table({ filters: [...filters, { id: 'none', label: 'None', keeps: () => false }] });
    expect(q(kept.container, 'table')).not.toBeNull();
    await act(async () => { fireEvent.mouseDown(q(kept.container, '[data-filter=none]')!, { button: 0 }); });
    expect(q(kept.container, '[data-t=empty]')).not.toBeNull();
    expect(q(kept.container, 'table')).toBeNull();
  });
});

describe('loading states', () => {
  /**
   * THE KIT'S FILES THAT DRAW NOTHING A PAGE WAITS TO READ, each with why. Every
   * other component file draws something that loads, and exports a loading
   * state shaped like it (`...Loading`).
   */
  const DRAWN_WITHOUT_LOADING: Readonly<Record<string, string>> = {
    'alert.tsx': 'a message the page already has to say',
    'avatar.tsx': 'a picture or initials beside a name the page already has',
    'badge.tsx': 'a word the page already has',
    'button.tsx': 'a control; what it acts on loads, not the button',
    'card.tsx': 'a box a part fills; the part inside it has the loading state',
    'checkbox.tsx': 'a control in a row of the table, which has its own loading state',
    'coming-soon.tsx': 'a fixed label for something not built',
    'confirm-in-your-account.tsx': 'a step the person answers; nothing is read to draw it',
    'dialog.tsx': 'an overlay; what it holds has its own loading state',
    'dropdown-menu.tsx': 'a menu of choices the page already has',
    'empty-state.tsx': 'shown once a read has finished with nothing in it',
    'input.tsx': 'a field the person types into',
    'kbd.tsx': 'the keys of a shortcut, fixed',
    'label.tsx': 'the name of a field, fixed',
    'popover.tsx': 'an overlay; what it holds has its own loading state',
    'progress.tsx': 'marks for steps the page already holds; the section around it has the loading state',
    'public-pill.tsx': 'a fixed label on an amount, which has its own loading state',
    'radio-group.tsx': 'choices the page already has',
    'select.tsx': 'choices the page already has',
    'separator.tsx': 'a rule between parts',
    'sheet.tsx': 'an overlay; what it holds has its own loading state',
    'sidebar.tsx': 'the menu, drawn from the list of pages the application holds before its first frame',
    'skeleton.tsx': 'the bar every loading state is made of',
    'soon-action.tsx': 'an action not built yet; nothing is read to draw it',
    'table.tsx': 'the rows of the kit\'s table, which has its own loading state',
    'tabs.tsx': 'a page\'s own tabs, from what the page already holds',
    'tooltip.tsx': 'an overlay of words the page already has',
  };
  const HERE = dirname(fileURLToPath(import.meta.url));
  const FILES = readdirSync(HERE).filter((n) => n.endsWith('.tsx') && !/\.test(-support)?\./.test(n)).sort();
  const loadingsOf = (name: string): string[] => [...readFileSync(`${HERE}/${name}`, 'utf8').matchAll(/export function (\w+Loading)\b/g)].map((m) => m[1]!);

  /*
   * RED WHEN: a kit component that draws something a page waits to read has
   * no loading state, or a file is let off without a reason, or one let off
   * is gone, or a folder is added under the components, where the rule does
   * not read. It reads a file, not each part in it: a new part added to a
   * file let off is caught only by that file's reason no longer being true.
   */
  it('gives every part that draws what loads a loading state of its own', () => {
    expect(FILES.length).toBeGreaterThan(30);
    /* The rule reads this folder alone; a part in a folder under it would not be read. */
    expect(readdirSync(HERE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)).toEqual([]);
    expect(FILES.filter((n) => !(n in DRAWN_WITHOUT_LOADING) && loadingsOf(n).length === 0)).toEqual([]);
    expect(Object.keys(DRAWN_WITHOUT_LOADING).filter((n) => !FILES.includes(n))).toEqual([]);
    for (const why of Object.values(DRAWN_WITHOUT_LOADING)) expect(why.length).toBeGreaterThan(10);
    expect(Object.fromEntries(FILES.filter((n) => loadingsOf(n).length > 0).map((n) => [n, loadingsOf(n)]))).toEqual({
      'amount.tsx': ['AmountLoading'], 'balance.tsx': ['BalanceLoading'], 'data-table.tsx': ['DataTableLoading'],
      'page-layout.tsx': ['PageLoading'], 'section.tsx': ['SectionLoading'], 'stat-tile.tsx': ['StatTileLoading'],
    });
  });

  /**
   * Each loading state, drawn, and the bars it must have, by the mark each
   * carries, so a bar left out is found and not only a bar that is there.
   */
  const SHAPES: Readonly<Record<string, { drawn: React.ReactNode; slot: string; bars: Readonly<Record<string, number>> }>> = {
    PageLoading: { drawn: <PageLoading />, slot: 'page-loading', bars: { heading: 1, title: 2, count: 2, row: 5 } },
    SectionLoading: { drawn: <SectionLoading rows={4} />, slot: 'section-loading', bars: { title: 1, count: 1, row: 4 } },
    StatTileLoading: { drawn: <StatTileLoading />, slot: 'stat-tile-loading', bars: { title: 1, figure: 1, tagline: 1, subtext: 1 } },
    DataTableLoading: { drawn: <DataTableLoading rows={3} columns={5} />, slot: 'data-table-loading', bars: { filters: 1, 'head-row': 1, row: 3 } },
    AmountLoading: { drawn: <AmountLoading />, slot: 'amount-loading', bars: { figure: 1 } },
    BalanceLoading: { drawn: <BalanceLoading />, slot: 'balance-loading', bars: { label: 2, figure: 2 } },
  };

  /*
   * RED WHEN: a loading state is not marked busy, carries words or a figure
   * that could be read as an answer, loses a bar of the shape it stands for
   * (a heading, a title, a count, a row, a figure, a tagline, subtext, the
   * filters, the heading row), draws a bar that is not the kit's skeleton, or
   * a loading state the kit exports is not drawn here.
   */
  it.each(Object.keys(SHAPES))('draws %s busy, wordless, and shaped like what loads', (name) => {
    const { drawn, slot, bars } = SHAPES[name]!;
    const { container } = inKit(<>{drawn}</>);
    const e = q(container, `[data-slot=${slot}]`)!;
    expect(e, name).not.toBeNull();
    expect(e.getAttribute('aria-busy'), name).toBe('true');
    expect(e.textContent, name).toBe('');
    const counted: Record<string, number> = {};
    for (const b of all(e, '[data-bar]')) counted[b.dataset.bar!] = (counted[b.dataset.bar!] ?? 0) + 1;
    expect(counted, name).toEqual(bars);
    /* Every bar is the kit's skeleton, or, for a row of cells, made of it. */
    for (const b of all(e, '[data-bar]')) {
      const skeletons = b.matches('[data-slot=skeleton]') ? [b] : all(b, '[data-slot=skeleton]');
      expect(skeletons.length, `${name} ${b.dataset.bar}`).toBeGreaterThan(0);
      for (const k of skeletons) expect(k.className, `${name} ${b.dataset.bar}`).toContain('animate-pulse');
    }
  });

  /* RED WHEN: the shapes above leave out a loading state the kit exports, so one is pinned without its shape ever being checked. */
  it('checks the shape of every loading state the kit exports', () => {
    expect(Object.keys(SHAPES).sort()).toEqual(FILES.flatMap(loadingsOf).sort());
  });

  /* RED WHEN: a table's loading state has fewer or more columns than the table (its box to choose a row and its row actions counted), or draws a filter bar for a table with no filters. */
  it('draws a table\'s loading state with the table\'s own columns, and filters only where it has them', () => {
    const columns = [{ id: 'x', header: 'X', cell: (r: { id: string }) => r.id }, { id: 'y', header: 'Y', cell: () => 'y' }];
    const { container } = inKit(<>
      <div data-t="plain"><DataTable label="t" rows={[{ id: 'a' }]} rowId={(r) => r.id} columns={columns} empty={null} loading /></div>
      <div data-t="full"><DataTable label="t" rows={[{ id: 'a' }]} rowId={(r) => r.id} columns={columns} filters={[{ id: 'f', label: 'F', keeps: () => true }]} onChosen={() => {}} rowActions={() => null} empty={null} loading /></div>
    </>);
    const cellsIn = (t: string) => q(container, `[data-t=${t}] [data-bar=row]`)!.querySelectorAll('[data-slot=skeleton]').length;
    expect(cellsIn('plain')).toBe(2);
    expect(cellsIn('full')).toBe(4);
    expect(q(container, '[data-t=plain] [data-bar=filters]')).toBeNull();
    expect(q(container, '[data-t=full] [data-bar=filters]')).not.toBeNull();
    expect(q(container, 'table')).toBeNull();
  });

  /* RED WHEN: a part told its data is loading draws its content, or anything but its own loading state, or loses its box or the marks a page finds it by. */
  it('draws a part whose data is loading as its loading state', () => {
    const { container } = inKit(<>
      <Section title="Proposals" count={2} empty={null} loading data-part="p"><SectionRow>One</SectionRow></Section>
      <Section title="Vaults" list={false} box={false} loading data-part="v"><p>tiles</p></Section>
      <StatTile title="Vault 1" figure="12" loading />
    </>);
    expect(q(container, '[data-part=p]')!.getAttribute('data-slot')).toBe('section-loading');
    expect(q(container, '[data-part=p]')!.className).toContain('bg-card');
    expect(q(container, '[data-part=v]')!.getAttribute('data-slot')).toBe('section-loading');
    expect(q(container, '[data-part=v]')!.className).not.toContain('bg-card');
    expect(container.textContent).toBe('');
    expect(q(container, '[data-slot=stat-tile-loading]')).not.toBeNull();
  });
});
