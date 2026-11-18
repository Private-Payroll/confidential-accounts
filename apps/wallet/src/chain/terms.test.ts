// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { loadTermsSeen, recordTermsSeen } from './terms.js';
import { liveDoors } from './send-context.js';
import { unshieldedKeystoreFor } from './unshielded.js';
import { NETWORK } from '../config.js';

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

beforeEach(() => { localStorage.clear(); });

describe('the terms record — a network fact, kept plainly', () => {
  it('round-trips, and the key carries the network name', () => {
    expect(loadTermsSeen()).toBeNull();
    recordTermsSeen({ hash: 'cafe'.repeat(16), url: 'https://terms.example/t' });
    const seen = loadTermsSeen();
    expect(seen?.hash).toBe('cafe'.repeat(16));
    expect(seen?.url).toBe('https://terms.example/t');
    expect(typeof seen?.seenAt).toBe('number');
    /* Scoped to the network, so a testnet record can never stand in for
     * the compiled network's. */
    expect(localStorage.getItem(`midnight-identity:terms:${NETWORK}`)).toBeTruthy();
  });

  it('a damaged record is a cache miss, never a dead end — the terms just show again', () => {
    localStorage.setItem(`midnight-identity:terms:${NETWORK}`, 'not json');
    expect(loadTermsSeen()).toBeNull();
    localStorage.setItem(`midnight-identity:terms:${NETWORK}`, JSON.stringify({ hash: 7 }));
    expect(loadTermsSeen()).toBeNull();
  });
});

describe('the live doors — the live half of the seam', () => {
  const ours = identityFromWords(TEST_MNEMONIC);

  it('the DEFAULT wiring is live — the seam flipped, and this is the flip', async () => {
    const { SendContext } = await import('./send-context.js');
    /* Read the default straight off the context object — no render, no dial. */
    const wiring = (SendContext as unknown as {
      _currentValue: import('./send-context.js').SendWiring;
    })._currentValue;
    expect(wiring.live).not.toBeNull();
    expect(typeof wiring.live?.doorsFor).toBe('function');
    expect(typeof wiring.live?.fetchTerms).toBe('function');
    expect(typeof wiring.rehearsalDoorsFor).toBe('function');
  });

  it('constructing the doors dials NOTHING; the facade starts on first use only', async () => {
    /* No network exists in this test, so if construction dialled, something
     * here would hang or throw. It must not: the deliberate press is where
     * the first connection happens (the click-to-check rule). */
    const doors = liveDoors(ours, 2);
    expect(typeof doors.facade).toBe('function');
    await doors.stop();
  });

  it('the change-detection address is the same wallet the keystore pays from', () => {
    const doors = liveDoors(ours, 2);
    expect(doors.ownUnshieldedHex).toBe(unshieldedKeystoreFor(ours, 2).getAddress());
  });

  it('refuses the reserved account, like every other door', () => {
    expect(() => liveDoors(ours, 1).ownUnshieldedHex).toThrow(/authority/);
  });
});
