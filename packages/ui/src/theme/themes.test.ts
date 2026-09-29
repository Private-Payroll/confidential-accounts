import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_COLORS, DEFAULT_BASE_COLOR, THEMES } from './base-colors.js';
import { blocksOf, themeBlocks } from './themes-css.test-support.js';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const THEMES_CSS = read('./themes.css');
const STYLES_CSS = read('../styles.css');
const COMPONENTS_JSON = JSON.parse(read('../../components.json')) as { tailwind: { baseColor: string } };

describe('every base colour has a light and a dark block, and nothing else does', () => {
  const blocks = themeBlocks(THEMES_CSS);

  /* RED WHEN: the stylesheet is emptied or its selectors change shape, so every check below would pass over nothing. */
  it('reads fourteen blocks', () => {
    expect(blocks.length).toBe(BASE_COLORS.length * THEMES.length);
  });

  /* RED WHEN: a colour in the list has no block for a theme, or has two. */
  it.each(BASE_COLORS.flatMap((c) => THEMES.map((t) => [c, t] as const)))('%s, %s', (colour, theme) => {
    expect(blocks.filter((b) => b.colour === colour && b.theme === theme).length).toBe(1);
  });

  /* RED WHEN: a block names a colour the list does not, so the switcher could never offer it. */
  it('names no colour the list does not', () => {
    expect(blocks.filter((b) => !(BASE_COLORS as readonly string[]).includes(b.colour)).map((b) => b.selector)).toEqual([]);
  });

  /* RED WHEN: one block defines a token another does not, so switching colour would leave it from the last one. */
  it('defines the same tokens in every block', () => {
    const first = blocks[0]!.tokens;
    expect(first.length).toBeGreaterThan(20);
    for (const b of blocks) expect(b.tokens, b.selector).toEqual(first);
  });

  /* RED WHEN: the page with no colour chosen falls to another colour than the default, or to none. */
  it('gives a page with no colour chosen the default colour', () => {
    const bare = blocks.filter((b) => b.bare);
    expect(bare.map((b) => [b.colour, b.theme])).toEqual([[DEFAULT_BASE_COLOR, 'light'], [DEFAULT_BASE_COLOR, 'dark']]);
    expect(COMPONENTS_JSON.tailwind.baseColor).toBe(DEFAULT_BASE_COLOR);
  });

  /* RED WHEN: a token the stylesheet maps to a colour utility is defined in no block, so the utility has no colour. */
  it('defines every token the stylesheet turns into a colour', () => {
    const used = [...STYLES_CSS.matchAll(/--color-[a-z0-9-]+:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    for (const token of used) expect(blocks[0]!.tokens, token).toContain(token);
  });
});

/** The three surfaces, each with the token of shadcn's inset layout it paints with: the frame and menu its sidebar, the page its background, a box its card. */
const SURFACES = { '--surface-frame': '--sidebar', '--surface-page': '--background', '--surface-box': '--card' } as const;
/** The least lightness between the frame and the page that still reads as the page set in it. */
const ONE_SHADE = 0.012;

/** A block's tokens and their values. */
const valuesOf = (css: string, selector: string): Record<string, string> => {
  const body = blocksOf(css).find((b) => b.selector === selector)!.body;
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
};
/** The lightness of an `oklch()` colour, or null for any other value. */
const lightnessOf = (value: string): number | null => {
  const m = /^oklch\(\s*([\d.]+)(%?)\s/.exec(value);
  return m === null ? null : Number(m[1]) / (m[2] === '%' ? 100 : 1);
};

describe('the three surfaces', () => {
  const blocks = themeBlocks(THEMES_CSS);

  /*
   * RED WHEN: a block leaves out a surface, or a surface is not the value
   * shadcn's inset layout paints that part with in that block (the frame its
   * sidebar, the page its background, a box its card), in any base colour,
   * light or dark; or the frame and the page are too close to tell apart.
   */
  it.each(BASE_COLORS.flatMap((c) => THEMES.map((t) => [c, t] as const)))('%s, %s: the surfaces are shadcn\'s inset layout\'s', (colour, theme) => {
    const block = blocks.find((b) => b.colour === colour && b.theme === theme)!;
    const values = valuesOf(THEMES_CSS, block.selector);
    for (const [surface, token] of Object.entries(SURFACES)) {
      expect(values[surface], `${colour} ${theme} ${surface}`).toBeDefined();
      expect(values[surface], `${colour} ${theme} ${surface}`).toBe(values[token]);
    }
    const frame = lightnessOf(values['--surface-frame']!);
    const page = lightnessOf(values['--surface-page']!);
    expect(frame !== null && page !== null, `${colour} ${theme}`).toBe(true);
    expect(Math.abs(frame! - page!), `${colour} ${theme} frame to page`).toBeGreaterThanOrEqual(ONE_SHADE);
  });

  /* RED WHEN: the menu, the page or a box is painted with anything but its surface, so a component painting one of them would choose its own shade. */
  it('paints the menu, the page and every box with the surfaces', () => {
    const painted = Object.fromEntries([...STYLES_CSS.matchAll(/(--color-(?:sidebar|background|card)):\s*var\((--[a-z0-9-]+)\)/g)].map((m) => [m[1]!, m[2]!]));
    expect(painted).toEqual({ '--color-sidebar': '--surface-frame', '--color-background': '--surface-page', '--color-card': '--surface-box' });
  });

  /* RED WHEN: the lightness reader misreads a value, so the order above is checked against the wrong numbers. */
  it('reads a colour\'s lightness', () => {
    expect([lightnessOf('oklch(0.955 0.001 286)'), lightnessOf('oklch(95% 0 0)'), lightnessOf('oklch(1 0 0 / 10%)'), lightnessOf('#fff')]).toEqual([0.955, 0.95, 1, null]);
  });
});

describe('the block reader', () => {
  /* RED WHEN: the reader takes a block with a colour it cannot name, or misreads which theme or colour a selector is. */
  it('reads each selector shape and nothing else', () => {
    const css = `:root, :root[data-base='zinc'] { --a: 1; --b: 2; }
      :root[data-theme='dark'],
      :root[data-base='zinc'][data-theme='dark'] { --a: 1; }
      :root[data-base='stone'] { --b: 1; --a: 2; }
      .other { --z: 1; }`;
    expect(blocksOf(css).map((b) => b.selector)).toEqual([
      ":root, :root[data-base='zinc']", ":root[data-theme='dark'],\n      :root[data-base='zinc'][data-theme='dark']",
      ":root[data-base='stone']", '.other',
    ]);
    expect(themeBlocks(css).map((b) => [b.colour, b.theme, b.bare, b.tokens])).toEqual([
      ['zinc', 'light', true, ['--a', '--b']], ['zinc', 'dark', true, ['--a']], ['stone', 'light', false, ['--a', '--b']],
    ]);
    expect(() => themeBlocks(":root[data-base='zinc'], :root[data-base='stone'] { --a: 1; }")).toThrow(/two colours/);
  });
});
