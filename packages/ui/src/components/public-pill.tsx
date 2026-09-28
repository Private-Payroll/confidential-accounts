import { useState } from 'react';
import { Badge } from 'vaults-ui/components/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from 'vaults-ui/components/tooltip';
import { useText } from 'vaults-ui/i18n/provider';

/** What a public amount is: a payment, whose receiver anyone can see, or a balance, whose account anyone can see. */
export type AmountKind = 'payment' | 'balance';

/**
 * THE `Public` PILL. Anything anyone can look up carries it; nothing private
 * does. Hovering, focusing or tapping it says what public means for what it
 * stands beside, so the explanation can be read on a touch screen too.
 */
export function PublicPill({ kind }: { kind: AmountKind }) {
  if (kind !== 'payment' && kind !== 'balance') {
    throw new Error(`a public amount is a payment or a balance, and this one is ${String(kind)}`);
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
      <TooltipContent>{kind === 'balance' ? t('kit.public.explanation.balance') : t('kit.public.explanation.payment')}</TooltipContent>
    </Tooltip>
  );
}
