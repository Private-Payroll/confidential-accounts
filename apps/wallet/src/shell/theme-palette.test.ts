import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES } from './themes.js';

/*
 * THE PALETTE, CHECKED AGAINST THE STYLESHEETS.
 *
 * The wallet's colours are two sheets now: the kit's theme, which draws every
 * surface, word and control, and the wallet's own, which adds the three status
 * colours the kit has no word for and forces a printed sheet to black on white.
 * The constraints are the same three they always were:
 *
 *   1. **Every theme in `shell/themes.ts` has a palette behind it**, in the
 *      kit's theme and in the wallet's status colours. A theme with no block
 *      is a menu item that writes `data-theme` and changes nothing.
 *   2. **The four status colours stay distinguishable in every theme**, and
 *      the colour on every primary button never reads as one of them.
 *   3. **Print always forces light**, over the machine and over a choice,
 *      because recovery pieces get printed.
 *
 * IT READS THE CSS AS TEXT, ON PURPOSE. jsdom does not compute custom
 * properties across attribute selectors and media queries; the stylesheets are
 * the artefact, and parsing them is reading the artefact.
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const WALLET = strip(readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8'));
const KIT = strip(readFileSync(
  fileURLToPath(new URL('../../../../packages/ui/src/theme/themes.css', import.meta.url)), 'utf8'));

/** Every `--name: value;` inside the first block whose selector list is exactly `selector`. */
function blockFor(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no block for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const found: Record<string, string> = {};
  for (const line of css.slice(open + 1, end).split(';')) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) found[match[1]] = match[2].trim();
  }
  return found;
}

/**
 * A colour as sRGB channels, 0 to 255: `#rrggbb`, `rgba(r, g, b, a)`, or the
 * kit's `oklch(l c h)`. Anything else is a failure - a colour written in a form
 * this cannot read is a colour nothing is checking.
 */
function channels(value: string): readonly [number, number, number] {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (rgb?.[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (ok?.[1] !== undefined && ok[2] !== undefined && ok[3] !== undefined) {
    const L = Number(ok[1]);
    const C = Number(ok[2]);
    const h = (Number(ok[3]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    const gamma = (x: number): number => {
      const c = Math.min(1, Math.max(0, x));
      return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    };
    return [gamma(lin[0]!), gamma(lin[1]!), gamma(lin[2]!)];
  }
  throw new Error(`not a colour this test can read: ${value}`);
}

/** Perceptual-ish distance: a tripwire, weighted so two colours a person would
 * call the same amber score low and two they would call different score high. */
function apart(a: string, b: string): number {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

/** Below this two colours read as the same colour at a glance. */
const DISTINGUISHABLE = 120;

/**
 * EACH THEME, AND WHERE ITS TWO HALVES ARE. The wallet sets no base colour, so
 * the kit's default blocks are the ones that apply; light is the root's own and
 * dark is chosen by `data-theme`, in both sheets.
 */
const PLACES: Record<string, { readonly kit: string; readonly wallet: string }> = {
  light: { kit: ":root,\n:root[data-base='zinc']", wallet: ':root' },
  dark: { kit: ":root[data-theme='dark'],\n:root[data-base='zinc'][data-theme='dark']", wallet: ":root[data-theme='dark']" },
};

const LISTED = THEMES.map((theme) => ({ id: theme.id }));

/** The roles every block of the kit's theme gives a value, read off the light block. */
const KIT_ROLES = Object.keys(blockFor(KIT, PLACES['light']!.kit));
const WALLET_ROLES = ['--good', '--good-dim', '--warn', '--warn-text', '--warn-dim', '--warn-border',
  '--pending', '--pending-dim', '--pending-border'] as const;

/** Both halves of a theme, as one palette: the kit's roles and the wallet's statuses. */
const paletteOf = (id: string): Record<string, string> => {
  const where = PLACES[id];
  expect(where, `the theme ${id} is in the list and this test does not know where it is drawn`).toBeDefined();
  return { ...blockFor(KIT, where!.kit), ...blockFor(WALLET, where!.wallet) };
};

describe('every theme in the list has a palette behind it', () => {
  /* RED WHEN: a theme is added to the list with no block in either sheet. */
  it.each(LISTED)('$id has a block in the kit\'s theme and in the wallet\'s', ({ id }) => {
    const palette = paletteOf(id);
    expect(KIT_ROLES.length).toBeGreaterThan(20);
    expect(KIT_ROLES.filter((role) => palette[role] === undefined)).toEqual([]);
    expect(WALLET_ROLES.filter((role) => palette[role] === undefined)).toEqual([]);
  });
});

describe('the four status colours stay apart in every theme', () => {
  /* Danger is the kit's own `destructive`; the other three are the wallet's. */
  const STATUS = ['--good', '--warn', '--destructive', '--pending'] as const;

  /* RED WHEN: two of the four drift onto one colour in any theme. */
  it.each(LISTED)('$id keeps good, warn, danger and pending distinguishable', ({ id }) => {
    const palette = paletteOf(id);
    for (const one of STATUS) {
      for (const other of STATUS) {
        if (one >= other) continue;
        expect(palette[one], one).toBeDefined();
        expect(palette[other], other).toBeDefined();
        expect(apart(palette[one]!, palette[other]!), `${one} and ${other} are too close to tell apart`)
          .toBeGreaterThan(DISTINGUISHABLE);
      }
    }
  });

  /* The colour of every primary button, which must never read as something
   * having happened. RED WHEN: `--primary` moves onto good, warn or danger. */
  it.each(LISTED)('$id keeps the primary colour clear of good, warn and danger', ({ id }) => {
    const palette = paletteOf(id);
    for (const status of ['--good', '--warn', '--destructive'] as const) {
      expect(apart(palette['--primary']!, palette[status]!), `the primary colour collides with ${status}`)
        .toBeGreaterThan(DISTINGUISHABLE);
    }
  });
});

describe('print forces light over everything', () => {
  /*
   * A SPECIFICITY CHECK, which is what actually decides this. The kit chooses
   * dark with `:root[data-theme='dark']`; the print block's `html:root[data-theme]`
   * carries a type selector as well, so it wins over any theme a person chose.
   * The kit's base-colour blocks are one attribute stronger, and the wallet
   * never sets a base colour - which is checked below, not assumed.
   */
  it('outranks a chosen theme', () => {
    const printAt = WALLET.indexOf('@media print');
    expect(printAt).toBeGreaterThan(-1);
    const head = WALLET.slice(printAt, WALLET.indexOf('{', WALLET.indexOf('{', printAt) + 1));
    expect(head).toContain('html:root[data-theme]');
    /* And in no cascade layer: the kit's theme is unlayered, and an unlayered
     * rule beats every layered one whatever its selector says. */
    const depthOfLayers = (() => {
      const stack: boolean[] = [];
      for (const m of WALLET.slice(0, printAt).matchAll(/@layer[^{;]*\{|\{|\}/g)) {
        if (m[0] === '}') stack.pop();
        else stack.push(m[0].startsWith('@layer'));
      }
      return stack.filter(Boolean).length;
    })();
    expect(depthOfLayers, 'the print block sits inside a cascade layer').toBe(0);
  });

  it('repaints the page, the frame and a box white and the ink black', () => {
    const printAt = WALLET.indexOf('@media print');
    const printed = blockFor(WALLET.slice(printAt), '  html:root,\n  html:root[data-theme]');
    for (const surface of ['--background', '--surface-frame', '--surface-page', '--surface-box', '--card']) {
      expect(printed[surface], surface).toBe('#ffffff');
    }
    expect(printed['--foreground']).toBe('#000000');
  });

  /* RED WHEN: a wallet source writes a base colour, which would put a kit block above print. */
  it('holds because the wallet never chooses a base colour', () => {
    const SRC = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|html)$/.test(name) && !/\.test\./.test(name)) files.push(path);
      }
    };
    walk(SRC);
    files.push(fileURLToPath(new URL('../../index.html', import.meta.url)));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /data-base|dataset\.base/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
