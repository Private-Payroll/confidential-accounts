import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * LIST ROW — the shape Activity, the address book and the account switcher all
 * turn out to be.
 *
 * IT IS THE RIGHT ELEMENT FOR WHAT IT DOES, and this is the whole reason it is
 * a component rather than a div with classes: a row that navigates is an `<a>`
 * so it can be opened in a new tab and appears in a screen reader's link list;
 * a row that acts is a `<button>` so Space and Enter both work and it is in
 * the tab order; a row that only displays is a `<div>` so it is NOT in the tab
 * order, because a focus stop that does nothing is a keyboard user's dead end.
 * Getting that wrong is invisible with a mouse and immediate without one.
 *
 * 44px MINIMUM, and no hover-only affordance: hover changes the background and
 * reveals nothing. A control that appears on hover does not exist on a phone.
 *
 * `trailing` IS WHERE THE NUMBER GOES, and it is the caller's job to make it
 * mono and to say what it is. This component never formats an amount — money
 * is formatted by `amount.ts` and nowhere else.
 */

export interface ListRowProps {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly meta?: ReactNode;
  readonly href?: string;
  readonly onClick?: () => void;
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

const SHARED = [
  'flex w-full min-h-touch items-center gap-3 rounded-tight border px-3 py-2 text-left',
  'bg-transparent font-normal no-underline',
  'transition-colors duration-(--motion-quick)',
].join(' ');

export function ListRow({
  leading, title, subtitle, trailing, meta, href, onClick, current, disabled, className,
}: ListRowProps): ReactNode {
  const interactive = href !== undefined || onClick !== undefined;
  const look = cn(
    SHARED,
    current === true
      ? 'border-line-strong bg-sunken'
      : 'border-transparent',
    interactive && disabled !== true
      && 'cursor-pointer hover:border-line hover:bg-sunken focus-visible:border-line',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    disabled === true && 'pointer-events-none opacity-55',
    className,
  );

  const body = (
    <>
      {leading !== undefined && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{title}</span>
        {subtitle !== undefined && (
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        )}
      </span>
      {(trailing !== undefined || meta !== undefined) && (
        <span className="shrink-0 text-right">
          {trailing !== undefined && (
            <span className="block text-sm font-medium text-ink">{trailing}</span>
          )}
          {meta !== undefined && <span className="block text-xs text-faint">{meta}</span>}
        </span>
      )}
    </>
  );

  if (href !== undefined) {
    return <a href={href} className={look} aria-current={current === true ? 'true' : undefined}>{body}</a>;
  }
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled === true}
        aria-current={current === true ? 'true' : undefined}
        className={look}
      >
        {body}
      </button>
    );
  }
  return <div className={look}>{body}</div>;
}

/** Rows in a stack, separated by a rule rather than by margin — so a list
 * reads as one object and an empty one collapses to nothing. */
export function ListRows({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={cn('flex flex-col divide-y divide-line', className)}>{children}</div>;
}
