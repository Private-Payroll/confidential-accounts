/*
 * FIRST, AND IT HAS TO BE. `address-format` uses Node's `Buffer` and a browser
 * has none — without this the wallet throws the moment it shows somebody their
 * own address. It is CALLED, not merely imported, because a bare
 * side-effect import is exactly what a bundler once deleted.
 */
import { ensureBuffer } from 'midnight-identity/browser';

ensureBuffer();

/*
 * Self-hosted fonts, from pinned packages. A wallet page must not phone a
 * font CDN — a network request per page view is a beacon this product has no
 * business emitting — so the files ship in the bundle instead.
 */
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { ErrorBoundary } from './error-boundary.js';
import { SessionProvider } from './session.js';

const mount = document.getElementById('app');
if (!mount) throw new Error('index.html has no #app element.');

createRoot(mount).render(
  <StrictMode>
    <ErrorBoundary>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ErrorBoundary>
  </StrictMode>,
);
