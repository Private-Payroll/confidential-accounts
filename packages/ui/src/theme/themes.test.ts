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
