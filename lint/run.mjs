// Lints the named files, or every file when none are named, one process per TypeScript program so each holds one.
// Usage: node lint/run.mjs [file ...]   or   node lint/run.mjs --list -   (one path per line on standard input)

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const LINTED = /\.(ts|tsx|mts|mjs)$/;
// A process's memory grows with the files it lints, not only with its program, so a large program is linted in parts.
const PART = 250;

// The program that types each file, first match wins; it matches the project each block of eslint.config.mjs names.
export const GROUPS = [
  ['untyped', (f) => f.endsWith('.mjs') || f === 'packages/identity/vitest.config.ts'],
  ['scripts and contracts', (f) => /^(scripts|contracts)\//.test(f) || f === 'vitest.config.ts'],
  [
    'the wallet',
    (f) =>
      f.startsWith('apps/wallet/') ||
      /^packages\/identity\/src\/profile\/(registry-open\.test\.tsx|unlock\.test\.ts)$/.test(f)
  ],
  ['the web app', (f) => f.startsWith('apps/web/')],
  ['the shared web code', (f) => f.startsWith('packages/web-shared/')],
  ['the identity library', (f) => f.startsWith('packages/identity/')],
  ['the interface kit', (f) => f.startsWith('packages/ui/')],
  ['the service', (f) => f.startsWith('src/')],
  ['the rest', () => true]
];

export const everyFile = async () => {
  const { ESLint } = createRequire(join(root, 'lint', 'package.json'))('eslint');
  const eslint = new ESLint({ cwd: root });
  const found = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || !LINTED.test(path) || path.endsWith('.d.ts') || /(^|\/)(node_modules|\.git)\//.test(path))
      continue;
    if (!(await eslint.isPathIgnored(join(root, path)))) found.push(path);
  }
  return found;
};

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const files = (
    args[0] === '--list' ? readFileSync(0, 'utf8').split('\n') : args.length > 0 ? args : await everyFile()
  ).filter((f) => LINTED.test(f) && !f.endsWith('.d.ts'));
  if (files.length === 0) {
    console.error('no file to lint');
    process.exit(1);
  }

  const parts = new Map(GROUPS.map(([name]) => [name, []]));
  for (const f of [...new Set(files)].sort()) parts.get(GROUPS.find(([, has]) => has(f))[0]).push(f);
  let failed = 0;
  const runs = [...parts].flatMap(([name, all]) => {
    const count = Math.ceil(all.length / PART);
    return Array.from({ length: count }, (_, i) => [
      count > 1 ? `${name}, part ${i + 1} of ${count}` : name,
      all.slice(i * PART, (i + 1) * PART)
    ]);
  });
  for (const [name, part] of runs) {
    const started = Date.now();
    process.stdout.write(`  ${name}: ${part.length} files `);
    const run = spawnSync(join(root, 'lint', 'node_modules', '.bin', 'eslint'), ['--max-warnings', '0', ...part], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    });
    const took = Math.round((Date.now() - started) / 1000);
    if (run.status === 0) {
      console.log(`clean (${took}s)`);
    } else {
      failed += 1;
      console.log(`FAILED (${took}s)`);
      process.stdout.write(
        run.stdout +
          run.stderr +
          (run.error ? `${String(run.error)}\n` : '') +
          (run.signal ? `stopped by ${run.signal}, most often for want of memory\n` : '')
      );
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
