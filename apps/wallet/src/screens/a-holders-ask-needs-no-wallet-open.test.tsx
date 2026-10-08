// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '../testing/render.js';

/*
 * **A PAGE ASKING WHO HOLDS A COMPANY IS ANSWERED WITH NOTHING SHOWN AND
 * NOTHING UNLOCKED.** The answer is public chain facts this wallet reads
 * itself, so a locked wallet, a browser with no wallet in it, and a wallet in
 * a frame the person cannot see all answer it the same, without a press.
 */
vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { HOLDERS_ANSWER_SCHEMA } from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { ApproveEntry } from './approve-entry.js';
import { SessionProvider } from '../session.js';
import type { HoldersReader } from './answer-holders.js';
import type { Phase } from '../session.js';

const NOW = 1_755_000_000_000;
const ASKER = 'https://payroll.example';
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const HOLDERS = {
  committee: [{ tag: 'schnorr', value: '11'.repeat(32) }], threshold: 1, seats: ['5a'.repeat(32)], approvals: 1, adoptedVaults: [],
  founding: '5a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }],
};
const reader: HoldersReader = async () => ({ of: 'read', holders: HOLDERS });
const holdersAsk = {
  schema: 'midnight-identity/disclosure-request/v1', kind: 'holders', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'Who holds the company.', nonce: 'h1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT,
};

/** A window the wallet listens on, with the page that asked as its opener or its parent, and what that page received. */
const asked = (framed: boolean) => {
  const handlers: ((event: MessageEvent) => void)[] = [];
  const received: unknown[] = [];
  const page = { postMessage: (message: unknown) => { received.push(message); } };
  const view = {
    opener: framed ? null : page,
    ...(framed ? { parent: page, location: { ancestorOrigins: [ASKER] } } : {}),
    addEventListener: (_t: string, h: (e: MessageEvent) => void) => { handlers.push(h); },
    removeEventListener: () => { /* torn down by cleanup */ },
  } as unknown as ChannelWindow;
  (view as { self?: unknown }).self = view;
  const send = () => { for (const h of handlers) h({ source: page, origin: ASKER, data: holdersAsk } as unknown as MessageEvent); };
  return { view, received, send };
};

const shown = (phase: Phase, framed: boolean) => {
  const a = asked(framed);
  const r = render(
    <SessionProvider>
      <ApproveEntry phase={phase} entry={<p data-entry-screen>Unlock your wallet</p>} view={a.view} now={() => NOW}
        embedder={framed ? ASKER : null} readHolders={reader} />
    </SessionProvider>);
  a.send();
  return { ...a, r };
};

describe('A HOLDERS ASK NEEDS NO WALLET OPEN', () => {
  it('A LOCKED WALLET ANSWERS IT WITHOUT ASKING TO BE UNLOCKED, AND OFFERS NOTHING TO PRESS', async () => {
    const { received, r } = shown({ name: 'locked' }, false);
    /* RED WHEN: a locked wallet shows its unlock screen for a holders ask instead of answering it. */
    await waitFor(() => expect(received.some((m) => (m as { schema?: unknown }).schema === HOLDERS_ANSWER_SCHEMA)).toBe(true));
    expect(r.container.querySelector('[data-entry-screen]')).toBeNull();
    expect(r.container.querySelector('button')).toBeNull();
  });

  it('A BROWSER WITH NO WALLET, IN A FRAME, ANSWERS IT THE SAME', async () => {
    const { received, r } = shown({ name: 'welcome' }, true);
    /* RED WHEN: a framed wallet answers a holders ask only once it is on screen, unlocked, or after a dwell. */
    await waitFor(() => expect(received.some((m) => (m as { schema?: unknown }).schema === HOLDERS_ANSWER_SCHEMA)).toBe(true));
    expect(r.container.querySelector('button')).toBeNull();
    expect(r.container.textContent).not.toMatch(/You have no wallet yet/);
  });
});
