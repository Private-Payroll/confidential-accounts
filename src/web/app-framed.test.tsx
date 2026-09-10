// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * **THE APPLICATION INSIDE SOMEBODY ELSE'S PAGE SHOWS NOTHING.** It frames the
 * person's wallet, and the wallet answers it because it is this origin, so this
 * page inside a stranger's would put the stranger around both.
 */

afterEach(() => { cleanup(); });

describe('the application in a frame', () => {
  it('renders the refusal, and neither the sign-in nor the wallet frame', async () => {
    const realTop = Object.getOwnPropertyDescriptor(window, 'top');
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) });
    try {
      const { default: App } = await import('./App.js');
      const { SimulatedCommitments } = await import('../core/ledger.js');
      const { container } = render(<App commitments={SimulatedCommitments} />);
      expect(container.querySelector('[data-framed-refusal]')).not.toBeNull();
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.textContent).not.toContain('Sign in with your wallet');
    } finally {
      if (realTop) Object.defineProperty(window, 'top', realTop);
    }
  });
});
