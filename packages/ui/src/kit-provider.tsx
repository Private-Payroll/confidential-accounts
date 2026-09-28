import type { ReactNode } from 'react';
import { TooltipProvider } from 'vaults-ui/components/tooltip';
import { LanguageProvider, type LanguageProviderProps } from 'vaults-ui/i18n/provider';

/** EVERYTHING THE KIT'S COMPONENTS NEED ABOVE THEM: the language, and the tooltips' shared timing. Mounted once, at the root. */
export function KitProvider({ children, ...language }: LanguageProviderProps & { children?: ReactNode }) {
  return (
    <LanguageProvider {...language}>
      <TooltipProvider>{children}</TooltipProvider>
    </LanguageProvider>
  );
}
