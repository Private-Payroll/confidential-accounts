// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://identity.pp.localhost:5180/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALHOST_FLAG } from 'midnight-identity/profile/origin';

/**
 * **WHICH NAME THIS WALLET'S PASSKEYS ARE MADE FOR, READ OFF THE CONFIG THE WALLET ACTUALLY LOADS.**
 *
 * The defect this pins was one line - the relying party was this page's host -
 * and it arrived with nothing to notice it. So the case below loads the real
 * `config.ts` on the host the wallet is served from in the product's layout, and
 * refuses unless the passkey's name is the site the wallet shares with the page
 * that frames it. **Put the host back and it goes red.**
 */

const load = async () => { vi.resetModules(); return import('./config.js'); };

afterEach(() => { vi.unstubAllEnvs(); });

describe('the relying party the wallet makes passkeys for', () => {
  it('is the SITE shared with the embedder - never `identity.`, which the application is refused', async () => {
    vi.stubEnv(LOCALHOST_FLAG, '1');
    vi.stubEnv('VITE_APP_ORIGIN', 'http://app.pp.localhost:5173');
    const config = await load();
    expect(window.location.hostname).toBe('identity.pp.localhost');
    expect(config.EMBEDDER).toBe('http://app.pp.localhost:5173');
    expect(config.RP_ID).toBe('pp.localhost');
  });

  it('a wallet with no embedder keeps its passkeys on its own host, as it always has', async () => {
    vi.stubEnv(LOCALHOST_FLAG, '1');
    vi.stubEnv('VITE_APP_ORIGIN', '');
    const config = await load();
    expect(config.EMBEDDER).toBeNull();
    expect(config.RP_ID).toBe('identity.pp.localhost');
  });

  it('a production build told to trust an `http` embedder stops at load, before any screen', async () => {
    vi.stubEnv(LOCALHOST_FLAG, '');
    vi.stubEnv('VITE_APP_ORIGIN', 'http://app.pp.localhost:5173');
    await expect(load()).rejects.toThrow(/is not an address it can trust/);
  });
});
