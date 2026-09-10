// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { listen } from 'midnight-identity/profile/channel';
import type { ChannelState, ChannelWindow } from 'midnight-identity/profile/channel';

/**
 * **THE TWO THINGS THAT MUST STAND BEHIND A FRAMED WALLET, IN ONE CASE, SO NEITHER CAN LAND ALONE.**
 *
 * A wallet that answers its parent is a wallet ANY page can put inside itself
 * and talk to, unless two things hold at once:
 *
 *   1. **the server says who may frame it** - `frame-ancestors`, sent with every
 *      wallet document, naming the one embedder and nothing else, so a stranger's
 *      page cannot load the wallet at all; and
 *   2. **the wallet answers only that embedder** - a parent speaking from any
 *      other origin is not heard, which is what still holds in a browser, or on
 *      a host, where the header did not arrive.
 *
 * Remove the header from the wallet's server config, or let the channel hear a
 * parent at any origin, and this case fails. It reads the REAL config file the
 * dev and preview servers load, not a copy of the policy.
 */

const EMBEDDER = 'http://localhost:5173';
const STRANGER = 'https://evil.example';

afterEach(() => { vi.unstubAllEnvs(); });

describe('a framed wallet is framed by its embedder, and hears nobody else', () => {
  it('THE HEADER NAMES ONLY THE EMBEDDER, AND THE CHANNEL REFUSES A STRANGER PARENT', { timeout: 60_000 }, async () => {
    /* ── 1. what the wallet's own servers send ─────────────────────────── */
    vi.stubEnv('VITE_ALLOW_LOCALHOST_ORIGIN', '1');
    vi.stubEnv('VITE_APP_ORIGIN', EMBEDDER);
    const file = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, file, undefined, 'silent');
    const config = loaded!.config as { server?: { headers?: Record<string, string> }; preview?: { headers?: Record<string, string> } };
    expect(config.server?.headers?.['Content-Security-Policy']).toBe(`frame-ancestors ${EMBEDDER}`);
    expect(config.preview?.headers?.['Content-Security-Policy']).toBe(`frame-ancestors ${EMBEDDER}`);

    /* ── 2. who the wallet answers inside the frame ─────────────────────── */
    const parent = { postMessage: () => {} };
    let handler: ((e: MessageEvent) => void) | null = null;
    const view = {
      opener: null, parent, self: undefined as unknown, location: { ancestorOrigins: [EMBEDDER] },
      addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { handler = h; },
      removeEventListener: () => {},
    };
    view.self = view;
    const states: ChannelState[] = [];
    listen(view as unknown as ChannelWindow, () => 0, (s) => states.push(s), EMBEDDER);
    const request = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in',
      requester: { name: 'x', rdns: 'x.x' }, purpose: 'x', nonce: 'n', expiresAt: 60_000,
    };
    handler!({ source: parent, origin: STRANGER, data: request } as unknown as MessageEvent);
    expect(states.map((s) => s.of), 'a parent at a stranger\'s origin was heard').toEqual(['waiting']);
    handler!({ source: parent, origin: EMBEDDER, data: request } as unknown as MessageEvent);
    expect(states.map((s) => s.of)).toEqual(['waiting', 'request']);
  });

  it('AND A WALLET WITH NO EMBEDDER IS FRAMED BY NOBODY', { timeout: 60_000 }, async () => {
    vi.stubEnv('VITE_APP_ORIGIN', '');
    const file = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, file, undefined, 'silent');
    const config = loaded!.config as { server?: { headers?: Record<string, string> }; preview?: { headers?: Record<string, string> } };
    for (const headers of [config.server?.headers, config.preview?.headers]) {
      expect(headers?.['Content-Security-Policy']).toBe("frame-ancestors 'none'");
      expect(headers?.['X-Frame-Options']).toBe('DENY');
    }
  });
});
