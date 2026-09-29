import { visibilityOf, type PrivateAmount, type PublicAmount } from 'vaults-ui/format/token-amount';
import { useText } from 'vaults-ui/i18n/provider';
import { Amount, AmountFigure } from 'vaults-ui/components/amount';
import { PublicPill } from 'vaults-ui/components/public-pill';
import { Skeleton } from 'vaults-ui/components/skeleton';

export interface BalanceProps {
  /** What only the holder, and those they share it with, can read. A public amount here does not typecheck. */
  private: PrivateAmount;
  /** What anyone can look up. A private amount here does not typecheck. */
  public: PublicAmount;
}

/**
 * A BALANCE: PRIVATE AND PUBLIC MONEY ON TWO LINES, NEVER ADDED TOGETHER.
 * There is no total to pass and none is worked out, so the two can never be
 * shown as one figure.
 *
 * THE PUBLIC LINE IS LABELLED BY THE PUBLIC PILL ITSELF, so the word appears
 * once on that line rather than as a label and a pill. The pill explains, on
 * hover, focus or a tap, that anyone can look the amount up and the account it
 * is in. The private line is labelled in words and carries no pill.
 *
 * IT TAKES NO CLASS FROM A SCREEN, for the reason `Amount` takes none.
 */
export function Balance({ private: held, public: shown }: BalanceProps) {
  const t = useText();
  /* The types already refuse a swap; this refuses one that a cast let through, rather than show public money as private. */
  if (visibilityOf(held) !== 'private' || visibilityOf(shown) !== 'public') {
    throw new Error('a balance takes a private amount on its private side and a public amount on its public side');
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-sm" data-slot="balance">
      <dt className="text-muted-foreground">{t('kit.balance.private')}</dt>
      <dd className="text-end"><Amount value={held} kind="balance" /></dd>
      <dt><PublicPill kind="balance" /></dt>
      <dd className="text-end" data-slot="amount" data-visibility="public"><AmountFigure value={shown} /></dd>
    </dl>
  );
}

/** A BALANCE WHILE IT IS READ: its two lines, each a bar where the label and the figure will be, and no figure on either, so neither can be read as money. */
export function BalanceLoading() {
  return (
    <div data-slot="balance-loading" aria-busy={true} className="grid grid-cols-2 items-center gap-x-4 gap-y-2">
      <Skeleton data-bar="label" className="h-4 w-16" /><Skeleton data-bar="figure" className="h-4 w-24 justify-self-end" />
      <Skeleton data-bar="label" className="h-4 w-16" /><Skeleton data-bar="figure" className="h-4 w-24 justify-self-end" />
    </div>
  );
}
