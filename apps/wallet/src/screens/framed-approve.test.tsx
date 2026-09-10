// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, secretFromWords } from 'midnight-identity/keys/derivation';
import { READY_PING } from 'midnight-identity/profile/channel';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { Approve } from './approve.js';
import { ApproveEntry } from './approve-entry.js';
import { SessionProvider } from '../session.js';
import { DWELL_MS } from '../framing.js';
import { watchedStore } from '../testing/settled-store.js';
import { settled } from '../testing/settled-channel.js';

/**
 * **THE WALLET INSIDE THE PAGE THAT FRAMES IT.**
 *
 * A framed wallet has no `opener`, so everything here is the second shape of the
 * asker check: the parent, at the one origin the wallet was built for. And a
 * framed approval is the one surface a page around it could shrink, cover or
 * slide under a pointer, so its buttons are held until what the person would
 * press has been visible long enough to read.
 */

const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SECRET = secretFromWords(TEST_MNEMONIC);
const EMBEDDER = 'https://app.payroll.example';
const STRANGER = 'https://evil.example';

const signIn = (): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'sign-in',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we know it is you.',
  nonce: 'n1',
  expiresAt: NOW + 600_000,
});

/** The wallet document, framed by `parent`. */
const framed = () => {
  const posted: Array<{ message: unknown; target: string }> = [];
  const parent = { postMessage: (message: unknown, target: string) => { posted.push({ message, target }); } };
  const handlers: Array<(e: MessageEvent) => void> = [];
  const view = {
    opener: null,
    parent,
    self: undefined as unknown,
    location: { ancestorOrigins: [EMBEDDER] },
    addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { handlers.push(h); },
    removeEventListener: () => {},
  };
  view.self = view;
  const from = (origin: string, data: unknown = signIn()) =>
    act(() => { for (const h of handlers) h({ source: parent, origin, data } as unknown as MessageEvent); });
  return { view: view as unknown as ChannelWindow, posted, from };
};

const wait = (ms: number) => act(() => new Promise<void>((r) => { setTimeout(r, ms); }));

beforeEach(() => {
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 460 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
});
afterEach(() => { cleanup(); });

describe('§1 - A FRAMED APPROVAL ANSWERS ITS EMBEDDER AND NOBODY ELSE', () => {
  it('WAITS, rather than saying nothing is asking, while the embedder prepares its request', async () => {
    const { view, posted } = framed();
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    await settled();
    expect(document.querySelector('[data-waiting-for-ask]')).not.toBeNull();
    expect(screen.queryByText('Nothing is asking')).toBeNull();
    expect(posted).toEqual([{ message: { schema: READY_PING }, target: EMBEDDER }]);
  });

  it('IGNORES the parent speaking from any other origin', async () => {
    const { view, from } = framed();
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    from(STRANGER);
    await settled();
    expect(document.querySelector('[data-approve]')).toBeNull();
    expect(document.querySelector('[data-waiting-for-ask]')).not.toBeNull();
  });
});

describe('§2 - THE VISIBILITY GUARD HOLDS THE PRESS UNTIL THE APPROVAL COULD BE READ', () => {
  it('the button is DISABLED, with its reason, until the frame has been in view long enough - then it answers', async () => {
    const { view, posted, from } = framed();
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    from(EMBEDDER);
    await settled();
    const button = document.querySelector<HTMLButtonElement>('[data-approve]')!;
    expect(button.disabled, 'a framed press counted before anybody could read the screen').toBe(true);
    expect(document.querySelector('[data-consent-refused]')?.textContent).toContain('only just appeared');

    await wait(DWELL_MS + 100);
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-consent-refused]')).toBeNull();
    fireEvent.click(button);
    await settled();
    const answer = posted.find((p) => (p.message as { schema?: string }).schema !== READY_PING);
    expect(answer?.target, 'the answer went somewhere other than the embedder').toBe(EMBEDDER);
  });

  it('a frame drawn TOO SMALL to read is never pressable, however long it waits', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 40 });
    const { view, from } = framed();
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    from(EMBEDDER);
    await settled();
    await wait(DWELL_MS + 100);
    expect(document.querySelector<HTMLButtonElement>('[data-approve]')!.disabled).toBe(true);
    expect(document.querySelector('[data-consent-refused]')?.textContent).toContain('too small');
  });

  it('a wallet in a window of its own is not held at all', async () => {
    const opener = { postMessage: () => {} };
    const handlers: Array<(e: MessageEvent) => void> = [];
    const view: ChannelWindow = {
      opener, addEventListener: (_t, h) => { handlers.push(h); }, removeEventListener: () => {},
    };
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    act(() => { for (const h of handlers) h({ source: opener, origin: EMBEDDER, data: signIn() } as unknown as MessageEvent); });
    await settled();
    expect(document.querySelector<HTMLButtonElement>('[data-approve]')!.disabled).toBe(false);
  });
});

describe('§2b - THE WAIT IS TIMED FROM THE REQUEST, NOT FROM THE SCREEN', () => {
  it('a request held back past the wait still arrives with its button held', async () => {
    const { view, from } = framed();
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    await wait(DWELL_MS + 100);
    from(EMBEDDER);
    await settled();
    expect(document.querySelector<HTMLButtonElement>('[data-approve]')!.disabled,
      'a request the page held back arrived pressable').toBe(true);
    expect(document.querySelector('[data-consent-refused]')?.textContent).toContain('only just appeared');
  });

  it('the KEY RELEASE is held the same way as the sign-in', async () => {
    const { view, from } = framed();
    render(<Approve identity={identity} secret={SECRET} port={watchedStore()} view={view} now={() => NOW} embedder={EMBEDDER} />);
    from(EMBEDDER, {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'unlock',
      requester: { name: 'Payroll A', rdns: 'example.payroll-a' }, purpose: 'So we can show you your payslips.',
      company: 'c0'.repeat(32), nonce: 'n1', expiresAt: NOW + 600_000,
    });
    await settled();
    const give = document.querySelector<HTMLButtonElement>('[data-unlock]');
    expect(give, 'the unlock screen did not render').not.toBeNull();
    expect(give!.disabled).toBe(true);
    expect(document.querySelector('[data-consent-refused]')?.textContent).toContain('only just appeared');
    await wait(DWELL_MS + 100);
    expect(give!.disabled).toBe(false);
  });
});

describe('§3 - A FRAMED ENTRY SHOWS NO CONTROL UNTIL THE EMBEDDER HAS SPOKEN', () => {
  it('a LOCKED wallet\'s entry, buttons and all, is not shown before the allowed page asks', async () => {
    const { view, from } = framed();
    render(
      <SessionProvider>
        <ApproveEntry phase={{ name: 'locked' } as never} entry={<button type="button">Unlock with your passkey</button>} view={view} now={() => NOW} embedder={EMBEDDER} />
      </SessionProvider>,
    );
    await settled();
    expect(document.querySelectorAll('button')).toHaveLength(0);
    from(EMBEDDER);
    await settled();
    expect(screen.getByText('Unlock with your passkey')).toBeTruthy();
  });

  it('no "Create your wallet" under a pointer before a request from the allowed page has arrived', async () => {
    const { view, from } = framed();
    render(
      <SessionProvider>
        <ApproveEntry phase={{ name: 'welcome' }} entry={<p>entry</p>} view={view} now={() => NOW} embedder={EMBEDDER} />
      </SessionProvider>,
    );
    await settled();
    expect(document.querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelector('[data-waiting-for-ask]')).not.toBeNull();

    from(STRANGER);
    await settled();
    expect(document.querySelectorAll('button'), 'a stranger speaking unlocked the entry').toHaveLength(0);
  });

  it('and the controls appear once the allowed page asks', async () => {
    const { view, from } = framed();
    render(
      <SessionProvider>
        <ApproveEntry phase={{ name: 'welcome' }} entry={<p>entry</p>} view={view} now={() => NOW} embedder={EMBEDDER} />
      </SessionProvider>,
    );
    from(EMBEDDER);
    await settled();
    expect(screen.getByText('Create your wallet')).toBeTruthy();
    expect(document.body.textContent).toContain(`${EMBEDDER} is asking you for something`);
  });
});
