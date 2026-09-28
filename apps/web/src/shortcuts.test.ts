import { describe, expect, it } from 'vitest';
import { onAMac, pressed, type Chord, type Press } from './shortcuts.js';

/* One key pressed, with nothing held unless said. */
const key = (over: Partial<Press>): Press => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const K: Chord = { key: 'k', code: 'KeyK', command: true };
const HELP: Chord = { key: '?', code: 'Slash', shift: true };

describe('a press matches a chord', () => {
  /* RED WHEN: the command key is read as Ctrl on a Mac or the other way, a press with more held is taken, or a letter typed with Shift is taken for the letter alone. */
  it('by the command key of the machine, and nothing else held', () => {
    expect(pressed(K, key({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe(true);
    expect(pressed(K, key({ key: 'k', code: 'KeyK', ctrlKey: true }), true)).toBe(false);
    expect(pressed(K, key({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBe(true);
    expect(pressed(K, key({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(pressed(K, key({ key: 'k', code: 'KeyK', metaKey: true, altKey: true }), true)).toBe(false);
    expect(pressed(K, key({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(pressed(K, key({ key: 'k', code: 'KeyK' }), true)).toBe(false);
  });

  /*
   * RED WHEN: a shortcut follows the key's place on a keyboard whose letters
   * are Latin (on a French keyboard, the key where Q is on an English one types
   * A, and must be A), or does not follow it on one whose letters are not.
   */
  it('by the character typed, and by the place only when the keyboard types no Latin character there', () => {
    expect(pressed(K, key({ key: 'л', code: 'KeyK', metaKey: true }), true)).toBe(true);
    expect(pressed({ key: 'a', code: 'KeyA', command: true }, key({ key: 'q', code: 'KeyA', metaKey: true }), true)).toBe(false);
    expect(pressed({ key: 'q', code: 'KeyQ', command: true }, key({ key: 'q', code: 'KeyA', metaKey: true }), true)).toBe(true);
  });

  /* RED WHEN: on a keyboard whose letters are not Latin, one key with and without Shift matches both / and ?, or neither. */
  it('by place, tells a key with Shift from the same key without it', () => {
    const SEARCH: Chord = { key: '/', code: 'Slash' };
    const arabic = (shiftKey: boolean) => key({ key: shiftKey ? '؟' : 'ظ', code: 'Slash', shiftKey });
    expect([pressed(HELP, arabic(true), false), pressed(SEARCH, arabic(true), false)]).toEqual([true, false]);
    expect([pressed(HELP, arabic(false), false), pressed(SEARCH, arabic(false), false)]).toEqual([false, true]);
  });

  /* RED WHEN: a sign typed with Shift, such as ?, is refused for the Shift it needs, or found where another key types it. */
  it('by the sign typed, whatever it takes to type it', () => {
    expect(pressed(HELP, key({ key: '?', code: 'Slash', shiftKey: true }), true)).toBe(true);
    expect(pressed(HELP, key({ key: '?', code: 'Minus', shiftKey: true }), false)).toBe(true);
    expect(pressed(HELP, key({ key: '/', code: 'Slash' }), true)).toBe(false);
  });

  /* RED WHEN: a Mac is not told apart from another machine by its platform. */
  it('tells a Mac by its platform', () => {
    expect([onAMac('MacIntel'), onAMac('iPhone'), onAMac('Win32'), onAMac('Linux x86_64')]).toEqual([true, true, false, false]);
  });
});
