import { useState, type ReactNode } from 'react';
import { Badge } from 'vaults-ui/components/badge';
import { Popover, PopoverContent, PopoverTrigger } from 'vaults-ui/components/popover';
import { useText } from 'vaults-ui/i18n/provider';

export interface ComingSoonProps {
  /** What the feature will be, in a line or two, already in the person's language. */
  explanation: ReactNode;
}

/**
 * THE `Coming soon` PILL, right after the name of something not built yet.
 * The same everywhere, in the theme's muted colour, never shortened. Hovering
 * or pressing it opens a line saying what the feature will be; nothing about
 * it pretends to work.
 */
export function ComingSoon({ explanation }: ComingSoonProps) {
  const t = useText();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
        <Badge asChild variant="secondary" className="bg-muted text-muted-foreground">
          <button type="button" data-slot="coming-soon">{t('kit.comingSoon.label')}</button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-64 text-sm">{explanation}</PopoverContent>
    </Popover>
  );
}
