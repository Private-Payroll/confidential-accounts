import { render as renderBare } from '@testing-library/react';
import type { RenderOptions } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KitProvider } from 'vaults-ui';
import { LANGUAGES } from '../languages.js';
import { KeysReaderContext } from '../screens/build-stamp.js';
import type { KeysReader } from '../screens/build-stamp.js';

export * from '@testing-library/react';

/** The keys reader every test screen gets unless a provider inside hands in its own: it reads nothing, so no test reaches the network. */
const readsNothing: KeysReader = () => Promise.resolve({ of: 'unchecked' });

/**
 * RENDER, WITH WHAT THE WALLET PUTS ABOVE EVERY SCREEN. The kit's parts take
 * their words from the language provider and their tooltips' timing from its
 * provider, so a screen drawn in a test sits under the same `KitProvider`,
 * with the wallet's own language files, that `main.tsx` mounts it under. It
 * also hands every screen a keys reader that reads nothing, so no test reaches
 * the network.
 */
export function render(ui: ReactNode, options?: Omit<RenderOptions, 'queries'>) {
  const Outer = options?.wrapper;
  return renderBare(ui, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) => (
      <KitProvider languages={LANGUAGES}>
        <KeysReaderContext.Provider value={readsNothing}>
          {Outer === undefined ? children : <Outer>{children}</Outer>}
        </KeysReaderContext.Provider>
      </KitProvider>
    ),
  });
}
