import type { ReactNode } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

export interface EmptyStateProps {
  /** What is not there yet, as a picture. */
  icon: IconSvgElement;
  /** What is not there, as a heading, where one line is not enough to name it. */
  title?: ReactNode;
  /** One line saying what is not there, already in the person's language. */
  children: ReactNode;
  /** The next thing to do about it: an action, or an action not built yet with its Coming soon pill. */
  action?: ReactNode;
}

/**
 * WHERE THERE IS NOTHING TO SHOW YET: an icon, one line, and the next action,
 * so a part of a page with nothing in it still says what comes next and never
 * looks bare. A page draws every part with nothing in it with this, and the
 * application's foundation test holds every page to it.
 */
export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  return (
    <div data-slot="empty-state" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" />
      </span>
      {title === undefined ? null : <h2 className="font-heading text-base font-medium" data-slot="empty-state-title">{title}</h2>}
      <p className="max-w-md text-sm text-muted-foreground" data-slot="empty-state-line">{children}</p>
      {action === undefined ? null : <div className="flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
