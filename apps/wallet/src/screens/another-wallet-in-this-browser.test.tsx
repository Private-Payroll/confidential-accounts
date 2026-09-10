// @vitest-environment jsdom
/**
 * **A SECOND WALLET IN THIS BROWSER IS NOT TOLD ITS DETAILS WERE ALTERED.**
 *
 * The browser keeps one set of saved details, sealed by whichever wallet saved
 * them. The first wallet to approve anything writes that record. Every other
 * wallet held here then reads a record that will not open with its key - and
 * both the profile screen and the approval screen used to show it under a
 * danger heading, with a sentence offering *altered* as the explanation.
 *
 * These render both screens for a wallet whose browser holds two wallets, with
 * the other wallet's details in the store, and read what a person is told.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { GIVEN_NAME, REGISTRY } from 'midnight-identity/profile/attributes';
import { emptyProfile, selfAssert } from 'midnight-identity/profile/model';
import { putSealed, save, sealedIn } from 'midnight-identity/profile/store';
import type { ChannelWindow } from 'midnight-identity/profile/channel';
import { watchedStore } from '../testing/settled-store.js';
import type { WatchedPort } from '../testing/settled-store.js';
import { settled, watchedOpener } from '../testing/settled-channel.js';
import { saveSecret } from '../accounts/storage.js';
import { forgetOpenWallet } from '../accounts/wallets-held.js';
import { ProfileScreen } from './profile.js';
import { Approve } from './approve.js';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const NOW = 1_755_000_000_000;

let port: WatchedPort;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  forgetOpenWallet();
  port = watchedStore();
});
afterEach(() => cleanup());

/** Two wallets held here; the FIRST saved its details. Returns the second, which is asking. */
async function twoWalletsAndTheFirstSavedItsDetails() {
  const first = newSecret();
  const second = newSecret();
  await saveSecret(first);
  await saveSecret(second);
  await save(port, identityFromSecret(first),
    selfAssert(emptyProfile(NOW), REGISTRY, GIVEN_NAME, 'Founder', 'legal', NOW));
  return { secret: second, identity: identityFromSecret(second) };
}

const signIn = {
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'sign-in',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'We need to know it is you.',
  nonce: 'n1',
  expiresAt: NOW + 600_000,
};

function approveFor(identity: ReturnType<typeof identityFromSecret>, secret: ReturnType<typeof newSecret>) {
  const opener = watchedOpener();
  const handlers: ((event: MessageEvent) => void)[] = [];
  const view: ChannelWindow = {
    opener: opener as ChannelWindow['opener'],
    addEventListener: (_t, h) => { handlers.push(h); },
    removeEventListener: () => { /* torn down by cleanup */ },
  };
  render(<Approve identity={identity} secret={secret} port={port} view={view} now={() => NOW} />);
  for (const h of handlers) {
    h({ source: opener, origin: 'https://payroll-a.example', data: signIn } as unknown as MessageEvent);
  }
}

describe('a wallet that did not save the details kept in this browser', () => {
  it('ON ITS PROFILE: is told they were most likely saved by another wallet used here, not that they were altered', async () => {
    const { identity } = await twoWalletsAndTheFirstSavedItsDetails();
    const before = port.getItem('midnight-identity:profile');
    render(<ProfileScreen identity={identity} port={port} />);
    await screen.findByText('The details kept in this browser are not this wallet\'s');
    const why = document.querySelector('[data-unopenable-why]')?.textContent ?? '';
    expect(why).toContain('This browser holds 2 wallets');
    expect(document.body.textContent).not.toMatch(/altered/);
    expect(document.body.textContent).toContain('Nothing has been changed or deleted');
    expect(document.querySelector('[data-add]')).toBeNull();
    expect(port.getItem('midnight-identity:profile')).toBe(before);
    /* The approval screen's extra line is about answering requests; this screen answers none. */
    expect(document.querySelector('[data-cannot-answer-here]')).toBeNull();
  });

  it('ON AN APPROVAL: is told the same, beside the screen\'s own nothing-was-sent line', async () => {
    const { identity, secret } = await twoWalletsAndTheFirstSavedItsDetails();
    approveFor(identity, secret);
    await settled();
    const why = document.querySelector('[data-unopenable-why]')?.textContent ?? '';
    expect(why).toContain('most likely saved by another wallet used in this browser');
    expect(document.body.textContent).not.toMatch(/altered/);
    expect(document.querySelector('[data-cannot-answer-here]')?.textContent)
      .toBe('While they are here, this wallet cannot answer requests in this browser.');
    expect(document.body.textContent).toContain('Nothing has been sent and nothing has been changed');
  });

  it('but a record that is DAMAGED, not merely another key\'s, still raises the warning', async () => {
    const { identity } = await twoWalletsAndTheFirstSavedItsDetails();
    putSealed(port, { ...sealedIn(port)!, v: 99 });
    render(<ProfileScreen identity={identity} port={port} />);
    await screen.findByText('There are details here that this account cannot open');
    expect(document.querySelector('[data-unopenable-why]')?.textContent)
      .toContain('this wallet did not seal');
  });
});
