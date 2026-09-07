import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { Icon } from './icon.js';
import type { IconSvgElement } from './icon.js';

/**
 * EMPTY STATE — a room that is empty, said honestly.
 *
 * TWO THINGS IT MUST NEVER BECOME, both of them already rows in this project:
 *
 *   - **A wait that never ends.** A dead network may not read as an
 *     empty list. "Nothing here yet" and "we could not ask" are different
 *     sentences and the screen has to know which one is true before it renders
 *     either. If a screen cannot tell, it says so — that is an `Alert`, not
 *     this.
 *   - **A zero.** An empty list of transactions is not a statement
 *     about money. Nothing in this component ever prints a balance.
 *
 * The `action` is optional because most empty rooms have nothing to do in
 * them, and a button that leads somewhere unrelated is worse than a full stop.
 */
export function EmptyState({ icon, title, children, action, className }: {
  /* A HugeIcons glyph is DATA, not a component: `GLYPH.inbox`, not
   * `Inbox`. `kit/icon.js` is the only place that difference is visible. */
  readonly icon?: IconSvgElement;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-card border border-dashed border-line',
        'px-6 py-10 text-center',
        className,
      )}
    >
      {icon !== undefined && (
        <span
          className="flex size-11 items-center justify-center rounded-pill bg-sunken text-faint"
          aria-hidden="true"
        >
          <Icon glyph={icon} />
        </span>
      )}
      <p className="m-0 text-base font-semibold text-ink">{title}</p>
      {children !== undefined && (
        <p className="m-0 max-w-prose text-sm text-muted">{children}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
