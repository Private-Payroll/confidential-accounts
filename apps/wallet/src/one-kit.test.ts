import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * ONE KIT. The wallet is drawn with the shared kit's parts, the same ones the
 * payroll application is drawn with, so the two read as one product and a
 * part fixed once is fixed in both. The way that stops being true is quiet: a
 * part copied into the wallet and restyled there, which looks like the kit
 * until the kit changes. These are the marks such a copy would leave.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The import specifiers of a file, read from its `from '...'` and `import('...')`. */
const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]!);

/*
 * What a component library's parts are built from. The kit builds its parts
 * from these; the wallet builds its screens from the kit's parts.
 */
const PART_MATERIALS = /^(?:radix-ui|@radix-ui\/|class-variance-authority$|tailwind-merge$|clsx$)/;

describe('the wallet keeps no kit of its own', () => {
  const files = sources(SRC);

  it('reads the wallet\'s sources at all', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => /screens[\\/]approve\.tsx$/.test(f))).toBe(true);
  });

  /* RED WHEN: a folder of parts comes back inside the wallet. */
  it('has no folder of parts', () => {
    expect(existsSync(join(SRC, 'kit'))).toBe(false);
    expect(existsSync(join(SRC, 'components', 'ui'))).toBe(false);
  });

  /* RED WHEN: a wallet file builds a part from what parts are built from - a
   * Radix primitive, a variant table, a class joiner - instead of taking the
   * kit's. */
  it('builds nothing from what the kit\'s parts are built from', () => {
    const found = files.flatMap((f) => importsOf(readFileSync(f, 'utf8'))
      .filter((spec) => PART_MATERIALS.test(spec))
      .map((spec) => `${relative(SRC, f)}: ${spec}`));
    expect(found).toEqual([]);
  });

  /* RED WHEN: a wallet file reaches for a kit that is not the shared one. */
  it('takes its parts from the shared kit and from nowhere else', () => {
    const found = files.flatMap((f) => importsOf(readFileSync(f, 'utf8'))
      .filter((spec) => /(?:^|\/)kit(?:\/|$)|^@\/(?:kit|components\/ui)\b/.test(spec))
      .map((spec) => `${relative(SRC, f)}: ${spec}`));
    expect(found).toEqual([]);
  });
});
