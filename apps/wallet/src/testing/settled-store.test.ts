/**
 * **THE WAIT FOR A WRITE NOBODY AWAITS RETURNS AFTER THAT WRITE, AND NOT AFTER
 * WHATEVER HAPPENED TO BE WRITTEN FIRST.**
 *
 * A press on a sign-in writes a small note at once and the sealed history later,
 * after real crypto. These drive the store the same way with a timer standing
 * in for the crypto, long enough that no number of quiet turns of the loop can
 * cover it, so the answer is the same on an idle machine and a loaded one.
 */
import { describe, expect, it } from 'vitest';
import { afterWrites, watchedStore } from './settled-store.js';

const SEALED = JSON.stringify({ v: 1, iv: 'aaaa', sealed: 'bbbb' });
const later = (ms: number, act: () => void): void => { setTimeout(act, ms); };

describe('afterWrites', () => {
  it('WAITS PAST A PLAIN WRITE for the sealed record that follows it', async () => {
    /*
     * No timer races the helper here. The sealed record is written only after the
     * test has let the loop turn many times more than the helper's quiet period
     * and seen the wait still pending, so a helper that returned on the plain
     * write has returned by then on any machine, however loaded.
     */
    const port = watchedStore();
    const written = afterWrites(port);
    let returned = false;
    const waiting = written().then(() => { returned = true; });
    port.setItem('note', JSON.stringify({ wallet: 'w' }));
    for (let i = 0; i < 20; i += 1) await new Promise((r) => { setTimeout(r, 0); });
    expect(returned, 'the wait returned on a plain write, before any sealed record').toBe(false);
    port.setItem('record', SEALED);
    await waiting;
    expect(port.getItem('record')).toBe(SEALED);
  });

  it('and once the sealed record is written, waits for the writes that follow it to stop', async () => {
    const port = watchedStore();
    const written = afterWrites(port);
    port.setItem('record', SEALED);
    later(0, () => port.setItem('after', 'x'));
    await written();
    expect(port.getItem('after'), 'a write in the turn after the sealed record was still coming').toBe('x');
  });

  it('counts a sealed record by its shape, and nothing else as one', () => {
    const port = watchedStore();
    port.setItem('a', JSON.stringify({ wallet: 'w' }));
    port.setItem('b', 'not json');
    port.setItem('c', JSON.stringify({ v: 1, iv: 'x' }));
    port.setItem('d', 'null');
    expect(port.sealedWrites()).toBe(0);
    port.setItem('e', SEALED);
    expect(port.sealedWrites()).toBe(1);
    expect(port.writes()).toBe(5);
  });
});
