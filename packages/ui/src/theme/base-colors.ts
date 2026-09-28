/**
 * THE BASE COLOURS A COMPANY CAN CHOOSE FROM, IN THE ORDER THEY ARE OFFERED.
 *
 * This list is the only place the colours are named. `themes.css` beside it
 * holds a light and a dark block for each, the switcher offers exactly these,
 * and the kit's check reads this list and the stylesheet together: a colour
 * here without both its blocks, or a block for a colour not here, fails it.
 */
export const BASE_COLORS = ['neutral', 'stone', 'zinc', 'mauve', 'olive', 'mist', 'taupe'] as const;

export type BaseColor = (typeof BASE_COLORS)[number];

/** The colour a company has until it chooses one. The kit's `components.json` names the same one. */
export const DEFAULT_BASE_COLOR: BaseColor = 'zinc';

/** Light and dark, chosen by `data-theme` on the root element. */
export const THEMES = ['light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];
