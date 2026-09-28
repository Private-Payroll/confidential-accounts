import { useEffect, useRef } from 'react';
import type { Text } from './pages.js';

/**
 * EVERY KEYBOARD SHORTCUT, IN ONE TABLE, OUTSIDE EVERY LANGUAGE FILE.
 *
 * A shortcut is the same keys in every language: what a language file holds
 * is only the words that say what it does. A key is matched by the character
 * it types, so a shortcut follows the letter printed on the key; on a
 * keyboard whose letters are not Latin, where no key types that character, it
 * is matched by the key's place instead, the place that letter has on an
 * English keyboard.
 *
 * `soon` marks a shortcut whose page is not built yet: it is listed, marked
 * Coming soon, and does nothing. None approves, pays or deposits by itself.
 */

/** One press: a key, whether the command key (Ctrl off a Mac) is held, and whether Shift is. */
export interface Chord {
  /** The character the key types, in lower case. */
  key: string;
  /** Where the key sits, for a keyboard that types another character there. */
  code: string;
  /** The command key on a Mac, Ctrl anywhere else. */
  command?: true;
  shift?: true;
}

export interface Shortcut {
  /** The ways to press it; the first is the one shown. */
  chords: readonly Chord[];
  /** What it does, in the language shown. */
  does: (t: Text) => string;
  /** While its page is not built: what it will do, and it does nothing. */
  soon?: (t: Text) => string;
}

/** The table. */
export const SHORTCUTS = {
  commandBar: { chords: [{ key: 'k', code: 'KeyK', command: true }], does: (t) => t('shortcut.commandBar') },
  everyShortcut: { chords: [{ key: '?', code: 'Slash', shift: true }], does: (t) => t('shortcut.everyShortcut') },
  searchThisPage: { chords: [{ key: '/', code: 'Slash' }], does: (t) => t('shortcut.searchThisPage'), soon: (t) => t('shortcut.searchThisPage.soon') },
  create: { chords: [{ key: 'c', code: 'KeyC' }], does: (t) => t('shortcut.create'), soon: (t) => t('shortcut.create.soon') },
  nextRow: { chords: [{ key: 'j', code: 'KeyJ' }], does: (t) => t('shortcut.nextRow'), soon: (t) => t('shortcut.rows.soon') },
  previousRow: { chords: [{ key: 'k', code: 'KeyK' }], does: (t) => t('shortcut.previousRow'), soon: (t) => t('shortcut.rows.soon') },
  openRow: { chords: [{ key: 'enter', code: 'Enter' }], does: (t) => t('shortcut.openRow'), soon: (t) => t('shortcut.rows.soon') },
  close: { chords: [{ key: 'escape', code: 'Escape' }], does: (t) => t('shortcut.close') },
  toggleMenu: { chords: [{ key: 'b', code: 'KeyB', command: true }], does: (t) => t('shortcut.toggleMenu') },
  switchCompany: { chords: [{ key: '.', code: 'Period', command: true }], does: (t) => t('shortcut.switchCompany') },
  lightOrDark: { chords: [{ key: 'l', code: 'KeyL', command: true, shift: true }], does: (t) => t('shortcut.lightOrDark') },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Each shortcut's id, by its own name, so code names a shortcut without writing it as text. */
export const SHORTCUT = Object.fromEntries(Object.keys(SHORTCUTS).map((id) => [id, id])) as { readonly [K in ShortcutId]: K };

/** Every shortcut, with its id, in the table's order. */
export const EVERY_SHORTCUT: readonly (Shortcut & { id: ShortcutId })[] = (Object.keys(SHORTCUTS) as ShortcutId[]).map((id) => ({ id, ...(SHORTCUTS[id] as Shortcut) }));

/** A computer made by Apple, where the command key is the one held for shortcuts. */
export const onAMac = (platform: string): boolean => /mac|iphone|ipad/i.test(platform);

/** The part of a key event a chord is matched against. */
export type Press = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** A character an English keyboard can type, which a chord's key is written as. */
const LATIN = /^[\x20-\x7e]$/;

/** Whether `press` is `chord`, on a Mac or not. */
export function pressed(chord: Chord, press: Press, mac: boolean): boolean {
  if (press.altKey) return false;
  const command = mac ? press.metaKey : press.ctrlKey;
  const other = mac ? press.ctrlKey : press.metaKey;
  if (command !== (chord.command === true) || other) return false;
  const typed = press.key.toLowerCase();
  /* A character such as ? is typed with Shift, so Shift is read only for a chord that names a letter or a named key. */
  const letterLike = /^[a-z]$/.test(chord.key) || chord.key.length > 1;
  if (letterLike && press.shiftKey !== (chord.shift === true)) return false;
  if (typed === chord.key) return true;
  /* By place, Shift is read for every chord: on a keyboard whose letters are not Latin, / and ? are one key with and without it. */
  return !LATIN.test(press.key) && press.key.length === 1 && press.code === chord.code && press.shiftKey === (chord.shift === true);
}

/** Whether a press is being typed into a field, where a shortcut without the command key is text. */
const intoAField = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return el !== null && (el.isContentEditable === true || /^(input|textarea|select)$/i.test(el.tagName ?? ''));
};

/** The browser's events this file listens for. */
const BROWSER_EVENTS = { key: 'keydown' } as const;

/**
 * RUN THE SHORTCUTS GIVEN, FROM THE TABLE, WHILE THE CALLER IS SHOWN. A
 * shortcut with no command key does nothing while a field has the focus, and
 * a shortcut marked `soon` is never run.
 */
export function useShortcuts(run: Partial<Record<ShortcutId, () => void>>, mac: boolean): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      for (const s of EVERY_SHORTCUT) {
        const action = latest.current[s.id];
        if (action === undefined || s.soon !== undefined) continue;
        const hit = s.chords.find((c) => pressed(c, e, mac));
        if (hit === undefined) continue;
        if (hit.command !== true && intoAField(e.target)) continue;
        e.preventDefault();
        action();
        return;
      }
    };
    document.addEventListener(BROWSER_EVENTS.key, onKey);
    return () => document.removeEventListener(BROWSER_EVENTS.key, onKey);
  }, [mac]);
}
