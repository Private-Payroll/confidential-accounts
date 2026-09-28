import { cn } from 'vaults-ui/lib/utils';
import type { TokenAmount } from 'vaults-ui/format/token-amount';
import { useText } from 'vaults-ui/i18n/provider';
import { Amount } from 'vaults-ui/components/amount';

export interface BalanceProps {
  /** What only the holder, and those they share it with, can read. */
  private: TokenAmount;
  /** What anyone can look up. */
  public: TokenAmount;
  className?: string;
}

/**
 * A BALANCE: PRIVATE AND PUBLIC MONEY ON TWO LABELLED LINES, NEVER ADDED
 * TOGETHER. There is no total to pass and none is worked out, so the two can
 * never be shown as one figure.
 */
export function Balance({ private: held, public: shown, className }: BalanceProps) {
  const t = useText();
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-sm', className)} data-slot="balance">
      <dt className="text-muted-foreground">{t('kit.balance.private')}</dt>
      <dd className="text-end"><Amount value={held} visibility="private" kind="balance" /></dd>
      <dt className="text-muted-foreground">{t('kit.balance.public')}</dt>
      <dd className="text-end"><Amount value={shown} visibility="public" kind="balance" /></dd>
    </dl>
  );
}
