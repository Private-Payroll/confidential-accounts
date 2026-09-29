import type { ReactElement, ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDownRight01Icon, ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { Slot } from 'radix-ui';
import { Badge } from 'vaults-ui/components/badge';
import { Skeleton } from 'vaults-ui/components/skeleton';

/** Which way a figure moved since what it is compared with. */
export const CHANGE = { up: 'up', down: 'down' } as const;

export interface StatTileChange {
  direction: (typeof CHANGE)[keyof typeof CHANGE];
  /** How much, as the page writes it (a percentage), already in the person's language. */
  label: ReactNode;
}

export interface StatTileProps {
  /** What the figure is, small, at the top. */
  title: ReactNode;
  /** The figure itself, large. An amount is passed as the kit's amount component, never as text. */
  figure?: ReactNode;
  /**
   * How the figure moved since something it is really compared with. Left
   * out when the page has nothing to compare it with: the tile never shows a
   * change it was not given.
   */
  change?: StatTileChange;
  /** A line under the figure. */
  tagline?: ReactNode;
  /** A quieter line under that. */
  subtext?: ReactNode;
  /** More lines, below the rest. */
  children?: ReactNode;
  /** An element to draw the tile as, given with no children of its own: a link to the page the figure is about. */
  link?: ReactElement;
  /** The figure is still loading: the tile is drawn as the tile loading. */
  loading?: boolean;
}

/**
 * A FIGURE ON ITS OWN TILE: a small title, the figure large, a badge for how
 * it changed when there is something to compare it with, then a tagline and a
 * line of subtext. A box on the card surface; in light, where a box is the
 * page's white, it is tinted towards the primary colour from its foot, as
 * shadcn's dashboard draws its figures, and in dark it is the card's shade.
 */
export function StatTile({ title, figure, change, tagline, subtext, children, link, loading }: StatTileProps) {
  if (loading === true) return <StatTileLoading />;
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm text-muted-foreground" data-slot="stat-tile-title">{title}</span>
          {figure === undefined ? null : <span className="font-heading text-2xl font-semibold" data-slot="stat-tile-figure">{figure}</span>}
        </div>
        {change === undefined ? null : (
          <Badge variant="outline" data-slot="stat-tile-change" data-direction={change.direction}>
            <HugeiconsIcon icon={change.direction === CHANGE.up ? ArrowUpRight01Icon : ArrowDownRight01Icon} strokeWidth={2} />
            {change.label}
          </Badge>
        )}
      </div>
      {tagline === undefined && subtext === undefined && children === undefined ? null : (
        <div className="flex flex-col gap-1 text-sm">
          {tagline === undefined ? null : <span className="font-medium" data-slot="stat-tile-tagline">{tagline}</span>}
          {subtext === undefined ? null : <span className="text-muted-foreground" data-slot="stat-tile-subtext">{subtext}</span>}
          {children}
        </div>
      )}
    </>
  );
  if (link === undefined) {
    return <div data-slot="stat-tile" className="flex flex-col gap-4 rounded-xl bg-card bg-gradient-to-t from-primary/5 to-card p-4 text-card-foreground shadow-xs ring-1 ring-foreground/10 dark:bg-none">{inner}</div>;
  }
  /* The link becomes the tile: its own props are kept, the tile's are added, and what the tile shows goes inside it. */
  return (
    <Slot.Root data-slot="stat-tile" className="flex flex-col gap-4 rounded-xl bg-card bg-gradient-to-t from-primary/5 to-card p-4 text-card-foreground shadow-xs ring-1 ring-foreground/10 dark:bg-none outline-none transition-shadow hover:ring-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50">
      <Slot.Slottable>{link}</Slot.Slottable>
      {inner}
    </Slot.Root>
  );
}

/** Tiles side by side, as many to a row as the page is wide enough for, one to a row on a phone. */
export function StatTiles({ children }: { children: ReactNode }) {
  return <div data-slot="stat-tiles" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{children}</div>;
}

/** A TILE WHILE ITS FIGURE LOADS: the same box, with bars where the title, the figure, the tagline and the subtext will be. */
export function StatTileLoading() {
  return (
    <div data-slot="stat-tile-loading" aria-busy={true} className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
      <div className="flex flex-col gap-2"><Skeleton data-bar="title" className="h-4 w-24" /><Skeleton data-bar="figure" className="h-8 w-32" /></div>
      <div className="flex flex-col gap-2"><Skeleton data-bar="tagline" className="h-4 w-40" /><Skeleton data-bar="subtext" className="h-4 w-28" /></div>
    </div>
  );
}
