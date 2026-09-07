// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { newSecret } from 'midnight-identity/keys/derivation';
import { splitSecret } from 'midnight-identity/recovery/pieces';
import type { Placement } from 'midnight-identity/recovery/pieces';
import { saveSecuredSetup } from '../accounts/storage.js';
import { SessionProvider } from '../session.js';
import { Broken } from './broken.js';

/*
 * THE ONLY SCREEN WITH A DESTRUCTIVE BUTTON, RENDERED. The take-a-copy gate
 * is one line, and both wrong directions were measured surviving the
 * suite: flipped to `setup !== null` the destructive door reappears beside
 * the piece map it erases (in full); flipped to `false` the dead end
 * returns. These renders are what kill both.
 */

const PLACEMENTS: readonly Placement[] = [
  { label: 'My Google account', holder: 'google:me' },
  { label: 'Printed card', holder: 'paper' },
  { label: 'Old laptop', holder: 'device:old' },
];

const MESSAGE = 'there is an account stored in this browser and the key that opens it is gone.';

const mount = (): void => {
  render(<SessionProvider><Broken message={MESSAGE} /></SessionProvider>);
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
});

describe('the broken screen with a piece map on record', () => {
  beforeEach(async () => {
    const secret = newSecret();
    await saveSecuredSetup(secret, await splitSecret(secret, PLACEMENTS, 2), { 'google:me': 'never', paper: null, 'device:old': 'never' });
  });

  it('shows the map, with copy and download', () => {
    mount();
    expect(screen.getByText('Where your pieces are')).toBeTruthy();
    expect(screen.getByText('My Google account')).toBeTruthy();
    expect(screen.getByText('Copy this list')).toBeTruthy();
    expect(screen.getByText('Download it')).toBeTruthy();
  });

  it('finally live: the destructive door sits BEHIND the take-a-copy gate', () => {
    /* With recovery a real flow beside it, the door exists — and the
     * gate is exercised at last: no Start over until the
     * copy of the map is attested, then still a second confirmation. */
    mount();
    expect(screen.queryByText('Start over…')).toBeNull();
    expect(screen.queryByText(/forget this account/)).toBeNull();
    fireEvent.click(screen.getByText('I have taken a copy of the list'));
    expect(screen.getByText('Start over…')).toBeTruthy();
    fireEvent.click(screen.getByText('Start over…'));
    expect(screen.getByText('I understand — forget this account')).toBeTruthy();
    /* The stakes for THIS person: pieces exist; the map is what dies. */
    expect(screen.getByText(/If your pieces are not placed somewhere safe/)).toBeTruthy();
    fireEvent.click(screen.getByText('Keep it'));
    expect(screen.queryByText('I understand — forget this account')).toBeNull();
  });

  it('shows the stored message verbatim', () => {
    mount();
    expect(screen.getByText(MESSAGE)).toBeTruthy();
  });
});

describe('the broken screen with nothing on record', () => {
  it('shows no map and no claim that one exists', () => {
    mount();
    expect(screen.queryByText('Where your pieces are')).toBeNull();
    expect(screen.queryByText(/the only note of where your pieces are/)).toBeNull();
  });

  it('offers start-over: nothing to destroy must mean a working door', () => {
    mount();
    expect(screen.getByText('Start over…')).toBeTruthy();
  });

  it('start-over is a second, explicit step that can be backed out of', () => {
    mount();
    /* No take-a-copy gate: there is no list to copy. */
    expect(screen.queryByText(/taken a copy of the list/)).toBeNull();
    fireEvent.click(screen.getByText('Start over…'));
    expect(screen.getByText('I understand — forget this account')).toBeTruthy();
    /* The stakes are this person's stakes: never secured, nothing to find later. */
    expect(screen.getByText(/never secured from this browser/)).toBeTruthy();
    fireEvent.click(screen.getByText('Keep it'));
    expect(screen.queryByText('I understand — forget this account')).toBeNull();
  });
});
