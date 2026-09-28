/**
 * Reads the theme blocks out of a stylesheet, for the theme's check. Kept out
 * of the check itself so the reader has its own test.
 */
export interface Block { selector: string; body: string }
export interface ThemeBlock { selector: string; colour: string; theme: 'light' | 'dark'; bare: boolean; tokens: string[] }

/** Every rule of a flat stylesheet: its selector and its body. Comments are dropped first. */
export function blocksOf(css: string): Block[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
}

/**
 * The blocks whose selectors are all on the root element. A selector names a
 * colour with `data-base`, or is bare and so applies with none chosen; it is
 * dark when it carries `data-theme='dark'`. The tokens come back sorted.
 */
export function themeBlocks(css: string): ThemeBlock[] {
  const out: ThemeBlock[] = [];
  for (const b of blocksOf(css)) {
    const parts = b.selector.split(',').map((s) => s.trim());
    if (!parts.every((p) => p.startsWith(':root'))) continue;
    const colours = new Set<string>();
    const themes = new Set<string>();
    let bare = false;
    for (const p of parts) {
      const base = /\[data-base='([a-z]+)'\]/.exec(p)?.[1];
      if (base === undefined) bare = true; else colours.add(base);
      themes.add(/\[data-theme='dark'\]/.test(p) ? 'dark' : 'light');
    }
    if (colours.size !== 1) throw new Error(`${b.selector} names ${colours.size === 0 ? 'no colour' : 'two colours'}`);
    if (themes.size !== 1) throw new Error(`${b.selector} is both light and dark`);
    const tokens = [...b.body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).sort();
    out.push({ selector: b.selector, colour: [...colours][0]!, theme: [...themes][0] as 'light' | 'dark', bare, tokens });
  }
  return out;
}
