import { useState } from 'react';
import { Badge } from 'vaults-ui/components/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from 'vaults-ui/components/tooltip';
import { useText } from 'vaults-ui/i18n/provider';

/**
 * What a public amount is: a payment made, whose receiver anyone can see; a
 * payment to be made (a run's money before the run is known to be paid, a
 * person's pay), whose receiver anyone can see from the day it is made; or a
 * balance, whose account anyone can see. A payment made keeps the value
 * `payment` it had before there was a third kind.
 */
export const AMOUNT_KIND = { paid: 'payment', toBePaid: 'to-be-paid', held: 'balance' } as const;
export type AmountKind = (typeof AMOUNT_KIND)[keyof typeof AMOUNT_KIND];

/** Every kind, so a kind that is none of them is refused rather than guessed. */
export const AMOUNT_KINDS: readonly AmountKind[] = Object.values(AMOUNT_KIND);

/**
 * THE `Public` PILL. Anything anyone can look up carries it; nothing private
 * does. Hovering, focusing or tapping it says what public means for what it
 * stands beside, so the explanation can be read on a touch screen too.
 */
export function PublicPill({ kind }: { kind: AmountKind }) {
  if (!AMOUNT_KINDS.includes(kind)) {
    throw new Error(`a public amount is a payment, a payment to be made or a balance, and this one is ${String(kind)}`);
  }
  const t = useText();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild onClick={() => setOpen((o) => !o)}>
        <Badge asChild variant="outline">
          <button type="button" data-slot="public-pill">{t('kit.public.label')}</button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {kind === AMOUNT_KIND.held ? t('kit.public.explanation.balance') : kind === AMOUNT_KIND.toBePaid ? t('kit.public.explanation.toBePaid') : t('kit.public.explanation.payment')}
      </TooltipContent>
    </Tooltip>
  );
}
