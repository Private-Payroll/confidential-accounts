import { Children, type HTMLAttributes, type ReactNode } from 'react';
import { Badge } from 'vaults-ui/components/badge';
import { Skeleton } from 'vaults-ui/components/skeleton';

/**
 * HOW MANY THERE ARE, beside a section's title or on a filter's tab: a small
 * round pill. Shown at zero too, so a count never disappears as it falls.
 */
export function CountPill({ count }: { count: number }) {
  return <Badge variant="secondary" className="h-5 min-w-5 rounded-full px-1.5" data-slot="count-pill" data-count={count}>{count}</Badge>;
}

type Marks = Omit<HTMLAttributes<HTMLElement>, 'title' | 'children' | 'className' | 'style'>;

interface SectionCommon extends Marks {
  /** The section's title, already in the person's language. */
  title: ReactNode;
  /** How many there are, shown in a pill beside the title; left out where a count would say nothing. */
  count?: number;
  /** A line under the title. */
  description?: ReactNode;
  /** What can be done here, at the end of the title's line. */
  actions?: ReactNode;
  /** What the section shows is still loading: it is drawn as the section loading, the shape of what is to come. */
  loading?: boolean;
}

export type SectionProps = SectionCommon & (
  /** A list: `children` are its rows, each a `SectionRow`; with none, `empty` is shown instead. */
  | { list?: true; empty: ReactNode; children?: ReactNode }
  /**
   * Something else under the title, such as the kit's table, which shows
   * its own empty state. With `box` false the section is drawn on the
   * page with no box of its own, for what is already in boxes: tiles.
   */
  | { list: false; empty?: never; box?: boolean; children: ReactNode }
);

/**
 * A SECTION OF A PAGE: one box, a shade apart from the page, with a title and
 * a count, actions at the end of the title's line, and one row per item, or
 * the empty state when there are none. A page draws its sections with this
 * rather than building its own, so they all look the same; the
 * application's foundation test holds every page to it.
 */
export function Section(props: SectionProps) {
  const { title, count, description, actions, list, empty, children, loading, ...rest } = props;
  const { box, ...marks } = rest as typeof rest & { box?: boolean };
  const rows = Children.toArray(children);
  const boxed = list !== false || box !== false;
  if (loading === true) return <SectionLoading box={boxed} {...marks} />;
  return (
    <section
      data-slot="section"
      data-box={boxed}
      className={boxed
        ? 'flex min-w-0 flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground shadow-xs ring-1 ring-foreground/10 md:p-5'
        : 'flex min-w-0 flex-col gap-3'}
      {...marks}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-slot="section-header">
        <div className="flex flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-base font-medium">{title}</h2>
            {count === undefined ? null : <CountPill count={count} />}
          </div>
          {description === undefined ? null : <div className="text-sm text-muted-foreground" data-slot="section-description">{description}</div>}
        </div>
        {actions === undefined ? null : <div className="ms-auto flex flex-wrap items-center gap-2" data-slot="section-actions">{actions}</div>}
      </div>
      {list === false
        ? children
        : rows.length === 0
          ? empty
          : <ul className="flex flex-col divide-y" data-slot="section-rows">{rows}</ul>}
    </section>
  );
}

/** One row of a section: what the item is at the start, and what can be done with it at the end. */
export function SectionRow({ children, actions, ...marks }: { children: ReactNode; actions?: ReactNode } & Omit<HTMLAttributes<HTMLLIElement>, 'children' | 'className' | 'style'>) {
  return (
    <li data-slot="section-row" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0" {...marks}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">{children}</div>
      {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2" data-slot="section-row-actions">{actions}</div>}
    </li>
  );
}

type LoadingMarks = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'style'>;

/**
 * A SECTION WHILE WHAT IT SHOWS LOADS: the same box, a bar where the title
 * and its count will be, and one bar per row to come, so the page keeps its
 * shape and nothing on it can be read as an answer. `rows` is how many to
 * draw; with `box` false it is drawn on the page, as a section of tiles is.
 */
export function SectionLoading({ rows = 3, box = true, ...marks }: { rows?: number; box?: boolean } & LoadingMarks) {
  return (
    <div
      data-slot="section-loading"
      aria-busy={true}
      className={box ? 'flex flex-col gap-4 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10 md:p-5' : 'flex flex-col gap-3'}
      {...marks}
    >
      <div className="flex items-center gap-2"><Skeleton data-bar="title" className="h-5 w-40" /><Skeleton data-bar="count" className="h-5 w-6 rounded-full" /></div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} data-bar="row" className="h-9 w-full" />)}
      </div>
    </div>
  );
}
