import { ensureBuffer } from 'midnight-identity/browser';
ensureBuffer();
import '@fontsource-variable/jetbrains-mono';
import { createRoot } from 'react-dom/client';
import { KitProvider } from 'vaults-ui';
import type { CreationRequest } from 'midnight-identity/profile/request';
import { identityFromWords } from 'midnight-identity/keys/derivation';
import { LANGUAGES } from './languages.js';
import { ApproveCreation } from './screens/approve-creation.js';

/*
 * What the test hands this page, set before it loads: the request the screen is
 * drawn over. What the screen answers is kept where the test can read it.
 */
declare global {
  interface Window {
    __creation?: { request: CreationRequest; words: string };
    __creationAnswer?: unknown;
  }
}

const given = window.__creation;
if (given === undefined) throw new Error('this page is drawn over a request the test hands it, and none was handed.');

createRoot(document.getElementById('app')!).render(
  <KitProvider languages={LANGUAGES}>
    <ApproveCreation
      request={given.request}
      identity={identityFromWords(given.words)}
      channel={{ answer: (a: unknown) => { window.__creationAnswer = a; return true; }, refuse: () => true } as never}
      consent={{ ok: true } as never}
      whoIsAsking={given.request.requester.origin}
      onDecline={() => undefined}
      onPin={async () => undefined}
      drewTheLabel
    />
  </KitProvider>,
);
