import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { GLYPH, Icon } from './icon.js';
import type { IconSvgElement } from './icon.js';

/**
 * ALERT — four severities, and the amber one is the one that matters.
 *
 * THE AMBER ALERT LIVES HERE. The design
 * settles what it says: **it states what is at risk, not what is undone.**
 * *"Back up your wallet"* is a chore. *"If you lose this device your money is
 * gone — nobody can recover it, including us"* is a fact, and facts do not
 * read as nagging. There is no close button on this component and there is not
 * going to be one: §7.7's standing notice *"stays until it is
 * untrue"*, and a dismissible fact is a fact somebody can switch off.
 *
 * THE ROLE IS DECIDED BY THE SEVERITY, and it is overridable because the right
 * answer depends on whether the thing appeared in response to something a
 * person just did:
 *   `danger`  → `role="alert"`   — interrupts; something failed.
 *   `warning` → `role="status"`  — announced politely; something is at risk.
 *   others    → no role          — read in document order, like prose.
 * A standing banner that has been on screen since load should pass
 * `role={null}` — announcing it on every render is the screen-reader
 * equivalent of a notification that will not stop. `null` is "no role" and
 * omitting the prop is "the severity's default"; they are different answers
 * and a single `undefined` could not tell them apart.
 *
 * THE ICON IS `aria-hidden` IN EVERY CASE. It repeats the severity, which the
 * role and the words already carry, and a decorative glyph with a name is one
 * more thing read aloud before the sentence that matters.
 */

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<AlertTone, { readonly box: string; readonly icon: string }> = {
  info: { box: 'border-line bg-raised', icon: 'text-accent' },
  success: { box: 'border-good/45 bg-good-dim', icon: 'text-good' },
  warning: { box: 'border-warn-border bg-warn-dim', icon: 'text-warn' },
  danger: { box: 'border-bad-border bg-bad-dim', icon: 'text-bad' },
};

/* HugeIcons. The names come from `kit/icon.js`, which is the only file
 * in this repository that knows which icon set is installed. */
const SEVERITY_GLYPH: Record<AlertTone, IconSvgElement> = {
  info: GLYPH.info,
  success: GLYPH.success,
  warning: GLYPH.warning,
  danger: GLYPH.danger,
};

const DEFAULT_ROLE: Record<AlertTone, string | undefined> = {
  info: undefined,
  success: undefined,
  warning: 'status',
  danger: 'alert',
};

export function Alert({ tone = 'info', title, children, role, className }: {
  readonly tone?: AlertTone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  /** Omit for the severity's default; pass `null` for a standing banner that
   * must not be re-announced. */
  readonly role?: string | null;
  readonly className?: string;
}): ReactNode {
  return (
    <div
      role={role === undefined ? DEFAULT_ROLE[tone] : (role ?? undefined)}
      className={cn('flex gap-3 rounded-card border p-4 text-ink', TONE[tone].box, className)}
    >
      <Icon glyph={SEVERITY_GLYPH[tone]} className={cn('mt-0.5', TONE[tone].icon)} />
      <div className="min-w-0 flex-1">
        {title !== undefined && (
          <p className="m-0 text-sm font-semibold text-ink">{title}</p>
        )}
        {children !== undefined && (
          <div className={cn('text-sm text-muted', title !== undefined && 'mt-1')}>{children}</div>
        )}
      </div>
    </div>
  );
}
