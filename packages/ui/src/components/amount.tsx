import { cn } from 'vaults-ui/lib/utils';
import { formatTokenAmount, type TokenAmount } from 'vaults-ui/format/token-amount';
import { useLanguage } from 'vaults-ui/i18n/provider';
import { PublicPill, type AmountKind } from 'vaults-ui/components/public-pill';

/** Whether anyone can look an amount up. Read from how the money is held or paid, never from a setting. */
export type Visibility = 'private' | 'public';

export interface AmountProps {
  /** The amount, made by `tokenAmount`: its units, its token's decimals and its token's code. */
  value: TokenAmount;
  /** Required, with no default: an amount nobody marked cannot be shown. */
  visibility: Visibility;
  /** Whether it is a payment or a balance, which says what the Public pill explains. */
  kind: AmountKind;
  className?: string;
}

/**
 * THE ONE WAY AN AMOUNT REACHES A SCREEN. Exact, in the person's language,
 * with its code, and with the `Public` pill when anyone can look it up. The
 * figures and the code are always written left to right, whatever the
 * language's direction.
 */
export function Amount({ value, visibility, kind, className }: AmountProps) {
  if (visibility !== 'private' && visibility !== 'public') {
    throw new Error(`an amount is shown as private or public, and this one is ${String(visibility)}`);
  }
  const language = useLanguage();
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} data-slot="amount" data-visibility={visibility}>
      <span dir="ltr">{formatTokenAmount(value, language)}{' '}{value.code}</span>
      {visibility === 'public' ? <PublicPill kind={kind} /> : null}
    </span>
  );
}
