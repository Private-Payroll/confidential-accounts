/**
 * THE THEMES, AS A LIST.
 *
 * THE RULE: *"Themes as a LIST, not a toggle. Ship dark and light only;
 * the mechanism must accept a third entry without rework."*
 *
 * A TOGGLE IS NOT A SMALL VERSION OF A LIST. A toggle encodes "there are
 * exactly two and the other one is the one you are not in" — in the control's
 * icon, in its label, in the `theme === 'dark' ? 'light' : 'dark'` that decides
 * what pressing it does. None of that has a third answer, so a third theme is
 * not an entry, it is a rewrite of every one of those. This array is the whole
 * mechanism instead: the picker renders it, and adding an entry adds a choice.
 *
 * WHAT A THIRD ENTRY COSTS, EXACTLY, so nobody has to guess later:
 *   1. a line in this array;
 *   2. a `:root[data-theme='<id>']` block in `apps/wallet/app.css` giving every
 *      colour role a value.
 * That is all. `theme-palette.test.ts` fails if step 2 is forgotten, which is
 * the failure worth catching — a theme in the list with no block in the
 * stylesheet is a menu item that silently does nothing.
 *
 * THREE THINGS THE LIST DOES NOT CONTAIN, each for its own reason:
 *
 *   `system` is NOT a theme. It is the absence of a stored choice, and what it
 *     resolves to is the machine's, not ours. It has no block in the stylesheet
 *     because the stylesheet's `prefers-color-scheme` default already answers
 *     it. Putting it in this array would mean writing a palette for it, and
 *     there is no palette to write.
 *
 *   PRINT is NOT a theme. `@media print` forces light over the system AND over
 *     an explicit choice, because recovery pieces get printed and the print rules
 *     govern what appears on a sheet. It is not a thing a person picks, and it
 *     must not become one.
 *
 *   No `high-contrast` yet. It is the obvious third entry and it is not this
 *     change's; naming it here would be a claim that it exists.
 */

export const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
] as const;

export type Theme = typeof THEMES[number]['id'];

/** A stored theme, or `system` for "follow the machine". */
export type ThemeChoice = Theme | 'system';

/** The one place that decides whether a stored string is still a theme this
 * build has. A theme removed from the list above must not go on being applied
 * from somebody's `localStorage`, and a `data-theme` with no stylesheet block
 * is an unstyled wallet. */
export const isTheme = (value: string | null): value is Theme =>
  THEMES.some((theme) => theme.id === value);

/** What the wallet defaults to when nothing else answers — including in
 * environments with no `matchMedia` at all, which is jsdom under the test
 * runner. Dark is this product's default and always has been. */
export const FALLBACK_THEME: Theme = 'dark';
