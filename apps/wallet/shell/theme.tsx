import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { DropdownMenu as Menu } from 'radix-ui';
import { GLYPH, Icon, glyphFor } from '../kit/icon.js';
import { readPref, writePref } from './prefs.js';
import { FALLBACK_THEME, THEMES, isTheme } from './themes.js';
import type { Theme, ThemeChoice } from './themes.js';

/**
 * WHICH THEME IS ON, AND HOW SOMEBODY CHANGES IT.
 *
 * THE THEMES THEMSELVES ARE DATA AND LIVE IN `./themes.ts`. THE RULE: *"Themes as
 * a LIST, not a toggle."* Nothing in this file knows how many there are or what
 * they are called; it renders the array. That is the whole difference between
 * "ship two, accept a third" and "ship two".
 *
 * THE THIRD STATE IS NOT A THIRD THEME. A stored choice is one of the list; NO
 * stored choice is "whatever this machine is set to", which is what a person
 * who has never opened this menu expects and what the pure-CSS default in
 * `app.css` already does with `prefers-color-scheme`. So the unset state writes
 * NO attribute and the stylesheet is left to answer.
 *
 * WHY THE ATTRIBUTE AND NOT A CLASS: `index.html` is not this change's to change
 * and it carries `<meta name="color-scheme" content="dark">`. A `color-scheme`
 * declaration on the root element supersedes that meta, so a light theme gets
 * light scrollbars, light form controls and a light canvas rather than dark
 * ones under a light page — which is the usual tell of a light theme bolted
 * onto a dark app.
 *
 * WHERE THE CHOICE IS KEPT: `./prefs.ts`, which holds the argument for why it
 * is not `storage.ts`.
 */

const KEY = 'theme';

/** What the machine itself is set to. Dark — the product's default — in any
 * environment without `matchMedia`, which is jsdom under the test runner. */
function systemTheme(): Theme {
  if (typeof window.matchMedia !== 'function') return FALLBACK_THEME;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function storedChoice(): ThemeChoice {
  const raw = readPref(KEY);
  return isTheme(raw) ? raw : 'system';
}

/**
 * THE CHOICE IS ONE VALUE WITH A CHANGE EVENT, NOT A COPY PER PICKER.
 *
 * The design puts the theme in Settings as well as in the rail's
 * footer, and says exactly what that must be: *"`ThemePicker` already exists
 * and this is a SECOND DOOR onto the same control, not a second
 * implementation."*
 *
 * **A second `useState` would have been a second implementation wearing the
 * same component's name.** Two `useTheme()` instances would each hold their own
 * idea of the choice; changing it in Settings would write the preference and
 * repaint the page — and leave the rail's trigger showing the old one until
 * something remounted it. Two surfaces disagreeing about a fact they both
 * display is `shell/wallets.ts`'s defect exactly, one layer down in stakes, and
 * this is the same fix: **the preference is still the only copy of the answer,
 * and this adds the change event `prefs.ts` cannot emit.**
 *
 * `storedChoice` IS THE SNAPSHOT AND IT NEEDS NO CACHE, because it returns a
 * STRING: `useSyncExternalStore` compares snapshots with `Object.is`, and two
 * reads of an unchanged preference are the same string. A cached object would
 * have been a second copy again.
 */
const listeners = new Set<() => void>();

function subscribeToChoice(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export interface ThemeControl {
  /** What is stored: a theme from the list, or `system`. */
  readonly choice: ThemeChoice;
  /** What is actually on screen right now. Never `system`. */
  readonly theme: Theme;
  setChoice(next: ThemeChoice): void;
}

export function useTheme(): ThemeControl {
  /* The third argument is the server snapshot; there is no server (
   * §7.8) and this never renders on one, but the hook requires it whenever the
   * getter touches anything a server would not have. */
  const choice = useSyncExternalStore(subscribeToChoice, storedChoice, storedChoice);
  const [fromSystem, setFromSystem] = useState<Theme>(systemTheme);

  /* The machine's own setting can change while the app is open — a laptop
   * flipping at sunset — and with no stored choice that IS the theme. */
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => setFromSystem(query.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice): void => {
    writePref(KEY, next === 'system' ? null : next);
    /* Every picker in the app re-reads the one record, at the same moment. */
    for (const listener of [...listeners]) listener();
  }, []);

  return { choice, theme: choice === 'system' ? fromSystem : choice, setChoice };
}

/** `dark` -> `themeDark`. One rule, so a third theme brings its glyph by
 * naming convention rather than by being added to a switch here. */
const glyphNameOf = (id: string): string =>
  `theme${id.charAt(0).toUpperCase()}${id.slice(1)}`;

const glyphNameFor = (theme: Theme, choice: ThemeChoice, chosen: string): string =>
  (choice === 'system' ? glyphNameOf(theme) : chosen);

/** The menu's entries: every theme in the list, then the machine. The machine
 * is LAST because it is the default, and a default at the top reads as the
 * recommended choice rather than as the absence of one. */
const SYSTEM_ENTRY = { value: 'system', label: 'Follow this machine', glyph: 'themeSystem' } as const;

interface Entry {
  readonly value: ThemeChoice;
  readonly label: string;
  readonly glyph: string;
}

export const THEME_ENTRIES: readonly Entry[] = [
  ...THEMES.map((theme) => ({
    value: theme.id,
    label: theme.label,
    /* `themeDark`, `themeLight` — the convention that lets a third theme bring
     * its glyph without this file learning its name. A theme whose glyph is
     * missing falls back to the machine's, which is a dull icon rather than a
     * crash. */
    glyph: glyphNameOf(theme.id),
  })),
  SYSTEM_ENTRY,
];

/**
 * THE PICKER. It shows WHAT IS ON, not what pressing it would do.
 *
 * That is the opposite of a toggle, and the reason is the list: a toggle
 * could honestly show the destination because there was exactly one. A menu
 * has several, so the trigger's job goes back to being a status — and the
 * destinations are the menu, where they are named in words.
 */
export function ThemePicker({ choice, theme, onChoose, wide }: {
  readonly choice: ThemeChoice;
  readonly theme: Theme;
  readonly onChoose: (next: ThemeChoice) => void;
  /** In the rail, where labels are shown, the trigger carries its words. */
  readonly wide?: boolean;
}): ReactNode {
  const current = THEME_ENTRIES.find((entry) => entry.value === choice) ?? SYSTEM_ENTRY;
  const resolvedLabel = THEMES.find((entry) => entry.id === theme)?.label ?? theme;
  /* Named for what it IS and what it DOES, because the trigger's glyph shows
   * the resolved theme and a screen reader gets neither for free. */
  const label = choice === 'system'
    ? `Theme: following this machine (${theme}) — change`
    : `Theme: ${current.label} — change`;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          data-theme-choice={choice}
          aria-label={label}
          title={label}
          className={[
            'flex min-h-touch items-center gap-2 rounded-tight border border-transparent',
            'bg-transparent px-2 py-2 text-sm font-normal text-muted',
            'transition-colors duration-(--motion-quick)',
            'hover:border-line hover:text-ink focus-visible:border-line focus-visible:text-ink',
            wide === true ? 'w-full justify-start' : 'size-touch justify-center p-0',
          ].join(' ')}
        >
          {/* The trigger shows the theme that is ACTUALLY ON. Following the
            * machine at night and following it at noon are the same choice and
            * two different screens, and the icon says which one you are
            * looking at. */}
          <Icon glyph={glyphFor(glyphNameFor(theme, choice, current.glyph))} />
          {/* THE WORD IS THE THEME THAT IS ON, NEVER THE CHOICE. "Follow this
            * machine" is three words wide in a rail that is fourteen
            * characters, and it names a rule rather than a state — a person
            * glancing at the rail wants to know it is dark, not how it came to
            * be. The accessible name carries both, and the menu's tick carries
            * which choice is set. */}
          {wide === true && <span className="truncate">{resolvedLabel}</span>}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="start"
          sideOffset={8}
          className={[
            'z-50 min-w-52 rounded-card border border-line bg-raised p-1.5 shadow-lg',
            'motion-safe:data-[state=open]:animate-[shell-fade_var(--motion-quick)_var(--motion-ease)]',
          ].join(' ')}
        >
          {THEME_ENTRIES.map((entry) => (
            <Menu.Item
              key={entry.value}
              data-theme-option={entry.value}
              onSelect={() => onChoose(entry.value)}
              className={[
                'flex min-h-touch cursor-pointer items-center gap-3 rounded-tight px-3 py-2',
                'text-sm text-ink outline-none',
                'data-highlighted:bg-sunken data-highlighted:text-ink',
              ].join(' ')}
            >
              <Icon glyph={glyphFor(entry.glyph)} className="text-muted" />
              <span className="flex-1">{entry.label}</span>
              {entry.value === choice && <Icon glyph={GLYPH.chosen} className="size-4 text-accent" />}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
