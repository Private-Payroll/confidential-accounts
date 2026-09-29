import { render as renderBare } from '@testing-library/react';
import type { RenderOptions } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KitProvider } from 'vaults-ui';
import { LANGUAGES } from '../languages.js';

export * from '@testing-library/react';

/**
 * RENDER, WITH WHAT THE WALLET PUTS ABOVE EVERY SCREEN. The kit's parts take
 * their words from the language provider and their tooltips' timing from its
 * provider, so a screen drawn in a test sits under the same `KitProvider`,
 * with the wallet's own language files, that `main.tsx` mounts it under.
 */
export function render(ui: ReactNode, options?: Omit<RenderOptions, 'queries'>) {
  const Outer = options?.wrapper;
  return renderBare(ui, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) => (
      <KitProvider languages={LANGUAGES}>
        {Outer === undefined ? children : <Outer>{children}</Outer>}
      </KitProvider>
    ),
  });
}
