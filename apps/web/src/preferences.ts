import { BASE_COLORS, DEFAULT_BASE_COLOR, THEMES, type BaseColor, type Theme } from 'vaults-ui';

/**
 * WHAT THIS PERSON CHOSE FOR HOW THE APPLICATION LOOKS AND WHICH LANGUAGE IT
 * SPEAKS, kept in this browser.
 *
 * Each person picks their own, and their pick wins everywhere. Until they
 * pick, the application follows the computer's light or dark setting on the
 * default colour, and the browser's language when there is a file for it.
 * Nothing here leaves the browser: it is not sent to the service.
 */

/** Light, dark, or whatever the computer is set to, in the order they are offered. */
export const MODES = [...THEMES, 'system'] as const;

export type Mode = (typeof MODES)[number];

export interface Preferences {
  mode: Mode;
  base: BaseColor;
  /** The language tag picked, or null to follow the browser. */
  language: string | null;
}

/** The words for each appearance mode, asked for by key. */
export const MODE_NAMES: Readonly<Record<Mode, (t: (key: string) => string) => string>> = {
  light: (t) => t('appearance.mode.light'),
  dark: (t) => t('appearance.mode.dark'),
  system: (t) => t('appearance.mode.system'),
};

/** The language choice that follows the browser's language, which is no language tag. */
export const FOLLOW_BROWSER = '';

export const DEFAULT_PREFERENCES: Preferences = { mode: MODES[2], base: DEFAULT_BASE_COLOR, language: null };

/** Where each choice is kept in the browser, and the media query for the computer's setting. */
const KEPT = {
  mode: 'private-vaults.mode',
  base: 'private-vaults.base',
  language: 'private-vaults.language',
  darkComputer: '(prefers-color-scheme: dark)',
} as const;

/** What is kept, read back, with anything unreadable or unknown taken as not chosen. */
export function readPreferences(storage: Pick<Storage, 'getItem'> | null): Preferences {
  const read = (key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const mode = read(KEPT.mode);
  const base = read(KEPT.base);
  const modes: readonly (string | null)[] = MODES;
  return {
    mode: modes.includes(mode) ? mode as Mode : DEFAULT_PREFERENCES.mode,
    base: (BASE_COLORS as readonly (string | null)[]).includes(base) ? base as BaseColor : DEFAULT_PREFERENCES.base,
    language: read(KEPT.language),
  };
}

/** Keep the choices; a browser that will not keep them still shows them until the tab closes. */
export function keepPreferences(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, preferences: Preferences): void {
  try {
    storage?.setItem(KEPT.mode, preferences.mode);
    storage?.setItem(KEPT.base, preferences.base);
    if (preferences.language === null) storage?.removeItem(KEPT.language);
    else storage?.setItem(KEPT.language, preferences.language);
  } catch { /* kept for this tab only */ }
}

/** The browser's storage, or null where the page may not use it. */
export function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Whether the computer is set to dark. */
export const computerIsDark = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(KEPT.darkComputer).matches;

/** Follow the computer's setting as it changes; returns the way to stop. */
export function followComputer(changed: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(KEPT.darkComputer);
  query.onchange = changed;
  return () => { query.onchange = null; };
}

/** The theme shown for a mode. */
export const themeFor = (mode: Mode, dark: boolean): Theme => (mode === MODES[2] ? (dark ? THEMES[1] : THEMES[0]) : mode);

/** Show a theme and a colour: the kit's stylesheet reads them from the root element. */
export function showAppearance(root: HTMLElement, theme: Theme, base: BaseColor): void {
  root.dataset.theme = theme;
  root.dataset.base = base;
}
