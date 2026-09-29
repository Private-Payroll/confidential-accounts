import { formatTokenAmount, visibilityOf, type TokenAmount } from 'vaults-ui/format/token-amount';
import { useLanguage } from 'vaults-ui/i18n/provider';
import { AMOUNT_KINDS, PublicPill, type AmountKind } from 'vaults-ui/components/public-pill';
import { Skeleton } from 'vaults-ui/components/skeleton';

export interface AmountProps {
  /** The amount, made by `publicAmount` or `privateAmount`: its units, its token's decimals and code, and whether anyone can look it up. */
  value: TokenAmount;
  /** Whether it is a payment made, a payment to be made or a balance, which says what the Public pill explains. Required on every amount, private ones too. */
  kind: AmountKind;
}

/** Refuses a kind that is not one of `AMOUNT_KIND`, so the pill never guesses what public means. */
function checkedKind(kind: AmountKind): AmountKind {
  if (!AMOUNT_KINDS.includes(kind)) {
    throw new Error(`an amount is a payment, a payment to be made or a balance, and this one is ${String(kind)}`);
  }
  return kind;
}

/**
 * THE FIGURE AND THE CODE, WITHOUT THE PILL, for the balance, which puts the
 * pill in the line's label instead. Not re-exported by the kit, and the kit's
 * own check refuses it anywhere but here and in the balance: a public amount
 * shown through it anywhere else would have no pill.
 */
export function AmountFigure({ value }: { value: TokenAmount }) {
  const language = useLanguage();
  return <span dir="ltr">{formatTokenAmount(value, language)}{' '}{value.code}</span>;
}

/**
 * THE ONE WAY AN AMOUNT REACHES A SCREEN, WITH THE BALANCE. Exact, in the
 * person's language, with its code, and with the `Public` pill when anyone can
 * look it up, which is read from the amount itself and never passed in. The
 * figures and the code are always written left to right, whatever the
 * language's direction.
 *
 * IT TAKES NO CLASS FROM A SCREEN: a class on the element that holds the pill
 * could hide it. A screen places an amount by what it puts around it.
 */
export function Amount({ value, kind }: AmountProps) {
  const visibility = visibilityOf(value);
  const shown = checkedKind(kind);
  return (
    <span className="inline-flex items-center gap-1.5" data-slot="amount" data-visibility={visibility}>
      <AmountFigure value={value} />
      {visibility === 'public' ? <PublicPill kind={shown} /> : null}
    </span>
  );
}

/** AN AMOUNT WHILE IT IS READ: a bar the width of a figure, in the line, with no figure and no pill, so nothing can be read as the amount. */
export function AmountLoading() {
  return <span data-slot="amount-loading" aria-busy={true} className="inline-flex align-middle"><Skeleton data-bar="figure" className="h-4 w-24" /></span>;
}
