import type { HTMLAttributes, ReactNode } from 'react';
import { Skeleton } from 'vaults-ui/components/skeleton';
import { SectionLoading } from 'vaults-ui/components/section';

/*
 * THE TWO LAYOUTS A PAGE IS DRAWN IN, and the only places a page's width is
 * set. A page never chooses its own width, background or outer spacing: the
 * application puts every page in one of these, and they take no class from
 * it.
 */

/**
 * THE PAGE: what sits in the inset panel beside the menu. At most a readable
 * width (80rem), centred, so a page on a 27-inch monitor does not run edge to
 * edge; the full width of the panel below that, down to a phone.
 */
export function PageLayout({ children }: { children?: ReactNode }) {
  return (
    <div data-slot="page-layout" className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  /** The page's heading, already in the person's language. */
  title: ReactNode;
  /** A pill after the heading, such as Coming soon, kept out of the heading's own words. */
  badge?: ReactNode;
  /** A line under the heading. */
  description?: ReactNode;
  /** What can be done on the page, at the end of the heading's line. */
  actions?: ReactNode;
}

/** A page's heading: its title and a pill after it, a line under it, and its actions at the end of the line. */
export function PageHeader({ title, badge, description, actions }: PageHeaderProps) {
  return (
    <div data-slot="page-header" className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        {description === undefined ? null : <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface FocusedLayoutProps {
  /** What the person is doing, named across the top, already in their language. */
  title: ReactNode;
  /** The way back to the rest of the application, at the end of the top bar. */
  exit: ReactNode;
  children?: ReactNode;
}

/**
 * ONE FOCUSED FULL PAGE, WITH NO MENU: for a task done from start to end,
 * such as setting a company up. The frame's shade all round, the task's name
 * and its way out across the top, and the page as one inset panel, its
 * content narrower than a page's so the task reads as one column.
 */
export function FocusedLayout({ title, exit, children }: FocusedLayoutProps) {
  return (
    <div data-slot="focused-layout" className="flex min-h-svh flex-col bg-sidebar text-sidebar-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4">
        <span className="truncate text-sm font-medium" data-slot="focused-title">{title}</span>
        <div className="ms-auto">{exit}</div>
      </header>
      <div className="flex flex-1 px-2 pb-2 md:px-3 md:pb-3">
        <main className="flex flex-1 rounded-xl bg-background text-foreground shadow-sm ring-1 ring-foreground/5">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">{children}</div>
        </main>
      </div>
    </div>
  );
}

/**
 * A PAGE WHILE ITS SCREEN OR ITS DATA LOADS: a bar where the heading will
 * be, and two sections loading, in the page's own width, so the page keeps
 * a page's shape rather than a few loose lines, and nothing on it can be
 * read as an answer.
 */
export function PageLoading(marks: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className' | 'style'>) {
  return (
    <div data-slot="page-loading" aria-busy={true} className="flex flex-col gap-6" {...marks}>
      <Skeleton data-bar="heading" className="h-8 w-56" />
      <SectionLoading rows={3} />
      <SectionLoading rows={2} />
    </div>
  );
}
