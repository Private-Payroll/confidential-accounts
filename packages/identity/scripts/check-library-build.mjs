/**
 * IS THE PUBLISHED PACKAGE USABLE BY SOMEBODY WHO IS NOT US?.
 *
 * WHAT IT ANSWERS, AND WHY NOTHING ELSE IN THIS REPOSITORY ANSWERS IT.
 * Every test here runs under `vitest`, and every consumer in the other
 * repository runs under `vite`, `vitest` or `tsx`. All four transpile
 * TypeScript, so all four load this package no matter what its `exports` map
 * points at. The one shape nobody exercises is the only shape a stranger uses:
 * a PLAIN NODE LOADER resolving the package by NAME. That is the gap this
 * checks, and it is the gap that made this worth building — it is invisible until
 * somebody outside tries it, which is the first thing a reviewer does.
 *
 * HOW IT IS OUTSIDE. It builds a consumer in the system temp directory with a
 * `node_modules/midnight-identity` symlink to this folder, and imports every
 * key in the `exports` map by PACKAGE SPECIFIER. Importing by relative path
 * would prove nothing: it is the `exports` map that is under test, and a path
 * import goes around it.
 *
 * WHAT MAKES IT A FAIR TEST, MEASURED RATHER THAN ASSERTED: run against the
 * `exports` map as it stood before the library build existed, this same
 * program fails on the first specifier with `ERR_MODULE_NOT_FOUND`. A checker
 * that cannot fail is not a checker.
 *
 * IT IS A CHECKER OVER THIS PACKAGE'S OWN BUILD OUTPUT. It writes nothing
 * inside this folder, reads no key material, touches no network and takes no
 * measurement of anything but `lib/`.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = pkg.name;

const fail = (m) => { console.error(`REFUSED: ${m}`); process.exit(1); };

/* ---- 1. every target named by the exports map is on disk ---------------- */

const entries = Object.entries(pkg.exports ?? {});
if (entries.length === 0) fail('package.json declares no exports map');

const missing = [];
for (const [subpath, target] of entries) {
  const targets = typeof target === 'string' ? [target] : Object.values(target);
  for (const t of targets) if (!existsSync(join(root, t))) missing.push(`${subpath} -> ${t}`);
}
if (missing.length) {
  console.error('REFUSED: the exports map names files that are not on disk.');
  console.error('Run `npm run build` first; `lib/` is a build artefact and is not committed.');
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

/* ---- 2. nothing in the emitted library reaches back into TypeScript ------ */

const tsTargets = entries.flatMap(([subpath, target]) => {
  const targets = typeof target === 'string' ? [target] : Object.values(target);
  return targets.filter((t) => t.endsWith('.ts') && !t.endsWith('.d.ts')).map((t) => `${subpath} -> ${t}`);
});
if (tsTargets.length) {
  console.error('REFUSED: the exports map points at raw TypeScript. A plain Node loader cannot execute it.');
  for (const t of tsTargets) console.error(`  ${t}`);
  process.exit(1);
}

/* ---- 3. a consumer outside this folder imports every entry by name ------ */

const dir = mkdtempSync(join(tmpdir(), 'identity-consumer-'));
let exitCode = 0;

try {
  const { mkdirSync } = await import('node:fs');
  const mods = join(dir, 'node_modules');
  mkdirSync(mods, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'outside-consumer', private: true, type: 'module', version: '0.0.0',
  }, null, 2));
  const link = join(mods, name);
  if (!existsSync(link)) symlinkSync(root, link, 'dir');

  const probe = join(dir, 'probe.mjs');
  const specifiers = entries.map(([subpath]) =>
    subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`);
  writeFileSync(probe, [
    'const out = [];',
    `for (const spec of ${JSON.stringify(specifiers)}) {`,
    '  const m = await import(spec);',
    '  out.push([spec, Object.keys(m).length]);',
    '}',
    'console.log(JSON.stringify(out));',
  ].join('\n'));

  const { execFileSync } = await import('node:child_process');
  const raw = execFileSync(process.execPath, [probe], { cwd: dir, encoding: 'utf8' });
  const loaded = JSON.parse(raw.trim().split('\n').pop());

  console.log(`${name} — the library build, checked from outside the folder`);
  console.log('');
  console.log(`  node            ${process.version}`);
  console.log(`  entry points    ${entries.length}`);
  console.log('');
  for (const [spec, n] of loaded) {
    console.log(`  ok   ${String(n).padStart(3)} exports   ${spec}`);
  }
  console.log('');
  console.log(`  ALL ${loaded.length} ENTRY POINTS RESOLVED THROUGH THE EXPORTS MAP AND LOADED.`);
} catch (e) {
  exitCode = 1;
  console.error('REFUSED: a consumer outside this folder could not load the package.');
  console.error(String(e?.stdout ?? '') + String(e?.stderr ?? e?.message ?? e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
