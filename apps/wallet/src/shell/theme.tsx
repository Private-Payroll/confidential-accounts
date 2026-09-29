import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from 'vaults-ui';
import { Glyph, glyphFor } from '../glyphs.js';
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

  /* The root carries the theme that is ON, the machine's when the person
   * follows it, because the kit's theme is chosen by that attribute alone. */
  const shown: Theme = choice === 'system' ? fromSystem : choice;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', shown);
  }, [shown]);

  const setChoice = useCallback((next: ThemeChoice): void => {
    writePref(KEY, next === 'system' ? null : next);
    /* Every picker in the app re-reads the one record, at the same moment. */
    for (const listener of [...listeners]) listener();
  }, []);

  return { choice, theme: shown, setChoice };
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={wide === true ? 'default' : 'icon'}
          data-theme-choice={choice}
          aria-label={label}
          title={label}
          className={wide === true ? 'flex-1 justify-start font-normal text-muted-foreground' : 'text-muted-foreground'}
        >
          {/* The trigger shows the theme that is ACTUALLY ON. Following the
            * machine at night and following it at noon are the same choice and
            * two different screens, and the icon says which one you are
            * looking at. */}
          <Glyph icon={glyphFor(glyphNameFor(theme, choice, current.glyph))} />
          {/* THE WORD IS THE THEME THAT IS ON, NEVER THE CHOICE. "Follow this
            * machine" is three words wide in a rail that is fourteen
            * characters, and it names a rule rather than a state — a person
            * glancing at the rail wants to know it is dark, not how it came to
            * be. The accessible name carries both, and the menu's tick carries
            * which choice is set. */}
          {wide === true && <span className="truncate">{resolvedLabel}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-auto min-w-52">
        {/* The choices are one set and one is on, so they are a radio group:
            a screen reader hears which is chosen, and the kit draws the tick. */}
        <DropdownMenuRadioGroup value={choice} onValueChange={(next) => onChoose(next as ThemeChoice)}>
          {THEME_ENTRIES.map((entry) => (
            <DropdownMenuRadioItem key={entry.value} value={entry.value} data-theme-option={entry.value}>
              <Glyph icon={glyphFor(entry.glyph)} className="text-muted-foreground" />
              <span className="flex-1">{entry.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
