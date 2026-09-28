import { useState } from 'react';
import { Badge } from 'vaults-ui/components/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from 'vaults-ui/components/tooltip';
import { useText } from 'vaults-ui/i18n/provider';

/**
 * THE `Public` PILL. Anything anyone can look up carries it; nothing private
 * does. Hovering, focusing or tapping it says what public means, so the
 * explanation can be read on a touch screen too.
 */
export function PublicPill() {
  const t = useText();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild onClick={() => setOpen((o) => !o)}>
        <Badge asChild variant="outline">
          <button type="button" data-slot="public-pill">{t('kit.public.label')}</button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{t('kit.public.explanation')}</TooltipContent>
    </Tooltip>
  );
}
