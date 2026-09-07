import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * BADGE — six statuses, three of them the payment ones.
 *
 * `pending`, `sent` and `failed` are named by the design because they are
 * the states `pending.ts` actually has: an outcome of `sent`, an outcome of
 * `failed`, and a record with no outcome yet.
 *
 * PENDING IS ITS OWN COLOUR AND NOT AMBER, and that is a deliberate split from
 * the home screen. `screens/home.tsx` renders an unresolved payment as an
 * amber `warn-banner` — one payment, on the screen a person lands on, where
 * amber means *read this now*. A LIST is a different job: every unconfirmed
 * row wearing a warning colour makes the colour mean nothing by the third row.
 * So the badge gets a quiet cool tone of its own and the home screen's banner
 * is untouched — it is the pending card and its words are not this change's.
 *
 * A BADGE IS NEVER THE ONLY CARRIER OF A FACT. Colour is not readable to
 * everyone and disappears in the print stylesheet; the word inside it is the
 * fact and the colour is an aid to finding it.
 */

export type BadgeTone = 'neutral' | 'accent' | 'pending' | 'sent' | 'failed' | 'warning';

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-line bg-transparent text-muted',
  accent: 'border-accent/40 bg-accent-dim text-accent',
  pending: 'border-pending-border bg-pending-dim text-pending',
  sent: 'border-good/45 bg-good-dim text-good',
  failed: 'border-bad-border bg-bad-dim text-bad',
  warning: 'border-warn-border bg-warn-dim text-warn-text',
};

export function Badge(
  { tone = 'neutral', className, ...rest }:
  { readonly tone?: BadgeTone } & HTMLAttributes<HTMLSpanElement>,
): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}
