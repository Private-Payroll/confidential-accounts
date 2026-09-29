import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from 'vaults-ui/lib/utils';
import { Alert, AlertDescription, AlertTitle, Badge } from 'vaults-ui';
import { GLYPH, Glyph } from '../glyphs.js';
import type { IconSvgElement } from '../glyphs.js';

/**
 * THE KIT'S ALERT AND BADGE, IN THE WALLET'S FOUR STATUSES.
 *
 * The kit draws an alert and a badge plainly or as destructive. The wallet
 * also has to say that something is a warning, went through, or is still
 * waiting, and a warning that an amount is public has to look like a warning.
 * So these take a tone and hand the kit's own parts the wallet's three status
 * colours; danger is the kit's `destructive` itself.
 */

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<AlertTone, string> = {
  info: '*:[svg]:text-primary',
  success: 'border-good/45 bg-good-dim *:[svg]:text-good',
  warning: 'border-warn-border bg-warn-dim *:[svg]:text-warn',
  danger: 'border-destructive/40 bg-destructive/10',
};

const SEVERITY_GLYPH: Record<AlertTone, IconSvgElement> = {
  info: GLYPH.info,
  success: GLYPH.success,
  warning: GLYPH.warning,
  danger: GLYPH.danger,
};

/*
 * WHO HEARS IT AT ONCE. A danger interrupts; a warning is announced politely;
 * information and success are read in their place. A caller can say otherwise,
 * and `null` means no role at all.
 */
const DEFAULT_ROLE: Record<AlertTone, string | undefined> = {
  info: undefined,
  success: undefined,
  warning: 'status',
  danger: 'alert',
};

export function StatusAlert({ tone = 'info', title, children, role, className }: {
  readonly tone?: AlertTone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly role?: string | null;
  readonly className?: string;
}): ReactNode {
  return (
    <Alert
      variant={tone === 'danger' ? 'destructive' : 'default'}
      role={role === undefined ? DEFAULT_ROLE[tone] : (role ?? undefined)}
      data-tone={tone}
      className={cn(TONE[tone], className)}
    >
      <Glyph icon={SEVERITY_GLYPH[tone]} />
      {title !== undefined && <AlertTitle>{title}</AlertTitle>}
      {children !== undefined && <AlertDescription>{children}</AlertDescription>}
    </Alert>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'pending' | 'sent' | 'failed' | 'warning';

const BADGE: Record<BadgeTone, { readonly variant: 'outline' | 'secondary' | 'destructive'; readonly look: string }> = {
  neutral: { variant: 'outline', look: 'text-muted-foreground' },
  accent: { variant: 'secondary', look: '' },
  pending: { variant: 'outline', look: 'border-pending-border bg-pending-dim text-pending' },
  sent: { variant: 'outline', look: 'border-good/45 bg-good-dim text-good' },
  failed: { variant: 'destructive', look: '' },
  warning: { variant: 'outline', look: 'border-warn-border bg-warn-dim text-warn-text' },
};

export function StatusBadge(
  { tone = 'neutral', className, ...rest }:
  { readonly tone?: BadgeTone } & HTMLAttributes<HTMLSpanElement>,
): ReactNode {
  const { variant, look } = BADGE[tone];
  return <Badge variant={variant} data-tone={tone} className={cn(look, className)} {...rest} />;
}
