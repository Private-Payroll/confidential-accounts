import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * SEPARATOR — a rule that says it is one.
 *
 * `role="separator"` with an orientation, rather than a bare `<hr>` or a
 * styled `<div>`, because a rule between two groups of controls is structure
 * and a screen reader should hear it. Where a rule is pure decoration —
 * inside a card that already has a header — pass `decorative`, which drops it
 * out of the accessibility tree instead of announcing furniture.
 */
export function Separator({ orientation = 'horizontal', decorative, className, ...rest }: {
  readonly orientation?: 'horizontal' | 'vertical';
  readonly decorative?: boolean;
} & HTMLAttributes<HTMLDivElement>): ReactNode {
  const semantics = decorative === true
    ? { 'aria-hidden': true as const }
    : { role: 'separator', 'aria-orientation': orientation };
  return (
    <div
      {...semantics}
      className={cn(
        'shrink-0 border-0 bg-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className,
      )}
      {...rest}
    />
  );
}
