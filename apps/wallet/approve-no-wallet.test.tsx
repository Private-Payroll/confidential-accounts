// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

/**
 * **AN INVITEE WITH NO WALLET, AND THE WINDOW THAT OPENED FOR THEM.**
 *
 * The hiring journey works — **for somebody who already has
 * a wallet.** This file is the other case, which is nearly everybody: a person
 * who has just been hired, opening a link a colleague sent them, in a browser
 * with nothing in it.
 *
 * **TWO THINGS HAVE TO BE TRUE AND ONLY ONE OF THEM IS WORDS.** The screen has
 * to say what state this is, and the wallet has to tell the page that opened it
 * that somebody is here — because the asking side gives a wallet twenty seconds
 * to say so, and twenty seconds is a page load rather than a first-time person
 * reading a screen and making a passkey. `screens/approve-entry.tsx` carries
 * the argument.
 */

vi.mock('midnight-identity/browser', () => ({
  ensureBuffer: (): void => {},
  passkeysAvailable: (): boolean => true,
  createPasskey: vi.fn(),
  usePasskey: vi.fn(),
}));

import { Buffer as PolyfillBuffer } from 'buffer/';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

import { READY_PING } from 'midnight-identity/profile/channel';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { newSecret } from 'midnight-identity/keys/derivation';
import { App } from './app.js';
import { ApproveEntry } from './screens/approve-entry.js';
import { SessionProvider } from './session.js';
import { savePasskey, saveSecret } from './storage.js';
import { ORIGINAL_SLOT } from './wallets-held.js';
import type { Passkey } from 'midnight-identity/passkey/verify';

const NOW = 1_755_000_000_000;
const ASKER = 'https://payroll.example';

const passkeyFixture = (credentialId: string): Passkey => ({
  credentialId,
  personHandle: 'person-1',
  publicKeySpki: new Uint8Array([1, 2, 3]),
  algorithm: -7,
  signCount: 0,
  provenBySignIn: false,
  rpId: 'localhost',
  syncsToACloud: false,
  backedUpNow: false,
  transports: [],
});

/** What the page that opened this window would receive. */
let posted: { message: unknown; target: string }[] = [];

/** jsdom has no opener, and the opener is the entire conversation. */
const withAnOpener = (): void => {
  posted = [];
  Object.defineProperty(window, 'opener', {
    configurable: true,
    value: {
      postMessage: (message: unknown, target: string) => { posted.push({ message, target }); },
    },
  });
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '#/approve';
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  withAnOpener();
});

const mount = (): void => {
  render(<SessionProvider><App /></SessionProvider>);
};

describe('§1 — a window opened for a request, with no wallet in it', () => {
  it('SAYS SO, AND OFFERS TO MAKE ONE HERE', () => {
    /*
     * **THE STATE HAD NO WORDS AND THIS IS THEM.** The ordinary welcome screen
     * is a correct screen for somebody who wandered in and the wrong one for
     * somebody whose employer's page is waiting behind this window: it says
     * nothing about a question being asked, so a person who has been told to
     * approve something reads a product pitch and closes it.
     *
     * The heading is asserted as well as its absence, because *the old screen
     * is gone* and *the right screen is here* are two different facts and only
     * one of them is worth anything.
     */
    mount();
    expect(screen.getByText('You have no wallet yet.')).toBeTruthy();
    expect(screen.getByText('Create your wallet')).toBeTruthy();
    expect(screen.queryByText('Your wallet on Midnight.')).toBeNull();
    /* And the thing a person actually worries about at this moment: where the
     * offer they were reading has gone. The wallet is a dialog, so it
     * has gone nowhere. */
    expect(screen.getByText(/still open behind this window/)).toBeTruthy();
  });

  it('AND TELLS THE ASKING PAGE A WALLET IS LISTENING, SO THE OFFER IS NOT LOST', () => {
    /*
     * **THE HALF THAT IS NOT WORDS.** Before this, nothing was said to the
     * opener from any phase but `unlocked`, so the asking page's twenty-second
     * ready window expired while the person was reading — and a person who did
     * exactly what the screen asked came back to an offer that had given up.
     *
     * The ping carries one constant string and nothing else, which is why it
     * may go to `'*'` — `profile/channel.ts` is where that is argued — so this
     * asserts both: that it was sent, and that it carried nothing.
     */
    mount();
    expect(posted.map((p) => p.message)).toContainEqual({ schema: READY_PING });
    expect(posted.every((p) => Object.keys(p.message as object).length === 1)).toBe(true);
  });

  it('AND A BROWSER THAT HAS A WALLET STILL GETS ITS OWN SCREEN, LISTENING TOO',
    async () => {
      /*
       * The wrapper is not a replacement for the entry screens: `entryFor` is
       * still the one decision about which screen a phase means. **What every
       * phase gains is the ping** — a locked wallet is the ordinary case for a
       * second ask, and it was inside the same twenty seconds.
       */
      savePasskey(passkeyFixture('cred-1'), ORIGINAL_SLOT);
      await saveSecret(newSecret());
      mount();
      await waitFor(() => {
        if (!screen.queryByText('Welcome back.')) throw new Error('waiting');
      });
      expect(screen.queryByText('You have no wallet yet.')).toBeNull();
      expect(posted.map((p) => p.message)).toContainEqual({ schema: READY_PING });
    });

  it('NAMES THE PAGE THAT ASKED BY THE ORIGIN THE BROWSER OBSERVED', async () => {
    /*
     * The rule reaches here in the simplest possible form: the origin is a
     * FACT the browser filled in, the name is a CLAIM the asking page chose,
     * and there is nothing on this screen for a person to weigh a claim
     * against — so the claim is not rendered at all and the fact is.
     */
    const handlers: ((event: MessageEvent) => void)[] = [];
    const opener = { postMessage: () => { /* not read here */ } };
    const view: ChannelWindow = {
      opener: opener as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => { /* torn down by cleanup */ },
    };
    render(
      <SessionProvider>
        <ApproveEntry
          phase={{ name: 'welcome' }}
          entry={null}
          view={view}
          now={() => NOW}
        />
      </SessionProvider>);
    for (const h of handlers) {
      h({
        source: opener,
        origin: ASKER,
        data: {
          schema: 'midnight-identity/disclosure-request/v1',
          kind: 'sign-in',
          requester: { name: 'Something Else Entirely', rdns: 'example.payroll' },
          purpose: 'So we know it is you.',
          nonce: 'n1',
          expiresAt: NOW + 60_000,
        },
      } as unknown as MessageEvent);
    }
    await waitFor(() => {
      if (!screen.queryByText(new RegExp(ASKER))) throw new Error('waiting');
    });
    expect(screen.queryByText(/Something Else Entirely/)).toBeNull();
  });
});
