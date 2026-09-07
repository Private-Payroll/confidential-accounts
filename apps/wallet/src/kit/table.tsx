import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn.js';

/**
 * TABLE — for things that are genuinely tabular, and scrolling on its own.
 *
 * THE WRAPPER IS NOT OPTIONAL. A table is the one element that cannot be made
 * narrow, and a table wide enough to scroll the PAGE sideways breaks every
 * other screen on a phone. So `Table` renders its own `overflow-x-auto` box:
 * the table scrolls, the page never does. This is the same rule the shell
 * follows and the reason it is enforced here rather than asked for.
 *
 * WHEN NOT TO USE IT: a list of payments on a phone is not a table, it is
 * `ListRow`. A table earns its place when a person compares the same field
 * DOWN a column — which is a desktop reading and rarely what a wallet screen
 * is doing.
 */

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>): ReactNode {
  return (
    <div className="w-full overflow-x-auto rounded-card border border-line">
      <table
        className={cn('w-full border-collapse text-left text-sm', className)}
        {...rest}
      />
    </div>
  );
}

export function TableCaption(
  { className, ...rest }: HTMLAttributes<HTMLTableCaptionElement>,
): ReactNode {
  return (
    <caption className={cn('px-4 py-3 text-left text-sm text-muted', className)} {...rest} />
  );
}

export function TableHead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return <thead className={cn('bg-sunken', className)} {...rest} />;
}

export function TableBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return <tbody className={cn('', className)} {...rest} />;
}

export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>): ReactNode {
  return <tr className={cn('border-t border-line', className)} {...rest} />;
}

/** A column heading. `scope="col"` by default because a header cell with no
 * scope leaves a screen reader guessing which cells it describes. */
export function TableHeader(
  { className, scope = 'col', ...rest }: ThHTMLAttributes<HTMLTableCellElement>,
): ReactNode {
  return (
    <th
      scope={scope}
      className={cn(
        'px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase whitespace-nowrap',
        className,
      )}
      {...rest}
    />
  );
}

export function TableCell(
  { className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>,
): ReactNode {
  return <td className={cn('px-4 py-2.5 align-middle text-ink', className)} {...rest} />;
}
