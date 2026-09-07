import type { ReactNode } from 'react';
import { Moon } from '../components/ui.js';

/** No WebAuthn here. Nothing works without it, so say so and stop. */
export function Unsupported(): ReactNode {
  return (
    <div className="hero">
      <Moon large />
      <h1>This browser can&rsquo;t do passkeys.</h1>
      <p className="lede">
        A passkey — Face&nbsp;ID, a fingerprint, or a security key — is the only way
        into this wallet. There is no password to fall back to, on purpose.
      </p>
      <p className="muted">
        Open this page in Safari, Chrome or Edge on a machine with a screen lock or
        a security key. It must be served from <span className="mono">localhost</span> or
        over <span className="mono">https</span> — passkeys refuse anything else.
      </p>
    </div>
  );
}
