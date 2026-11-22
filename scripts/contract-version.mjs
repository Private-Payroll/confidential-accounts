#!/usr/bin/env node
/**
 * THE CONTRACT'S VERSION, BY ITS CODE.
 *
 * A contract is its ledger, circuits, constructor, witnesses, types and constants, compiled by one
 * compiler. Its version is a fingerprint of exactly that: the code of
 * contracts/src/ConfidentialAccount.compact and contracts/src/Vault.compact, each with every file it
 * brings in (scripts/contract-sources.mjs), and contracts/src/witnesses.ts, with comments and spacing
 * taken out, plus the compiler version pinned in .github/checks/toolchain.mjs.
 * A comment, spacing or save-time change is never a new version and never asks for a compile or a key
 * build; a change to the code always is, and says so.
 *
 *   node scripts/contract-version.mjs                              each part's fingerprint and the version
 *   node scripts/contract-version.mjs --record <dir>               after a compile: write <dir>/.version
 *   node scripts/contract-version.mjs --current <dir> [record]     exit 0 if <dir> (or its keys, with
 *                                                                  .keys-version) was built from this code
 *   node scripts/contract-version.mjs --since <file>               compare with a recorded version; say what changed
 *   node scripts/contract-version.mjs --record-shipped <file>      write the version and parts to <file>
 * Each takes --root <folder> first to read another copy of the repository (the tests' fixtures).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, codeOf, contractSources } from './contract-sources.mjs';

export { codeOf };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PARTS = { ...CONTRACTS, witnesses: 'contracts/src/witnesses.ts' };
/** Which parts each compiled folder is built from. */
const FOR_DIR = {
  'contracts/managed': ['account', 'witnesses'],
  'contracts/managed-vault': ['vault', 'account', 'witnesses'],
};
/** The parts that change the compiled circuits and keys. The witnesses run on the device and are not
 * compiled into a key, so a witness-only change is a new version with nothing to rebuild. */
const COMPILED = new Set(['account', 'vault', 'compiler']);

const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** One file's code fingerprint. */
export const codeHash = (path) => short(codeOf(readFileSync(path, 'utf8')));

/** The files one part is compiled from: a contract's main file and what it brings in; a witnesses file alone. */
export const filesOf = (root, rel) => (rel.endsWith('.compact') ? contractSources(root, rel) : [rel]);

/**
 * One part's fingerprint over all its files. A part of one file keeps that file's fingerprint, so a
 * contract with nothing brought in has the version it always had; every further file adds its path and
 * its code, so a helper moved from one file to another is a new version.
 */
export function partHash(root, rel) {
  const [main, ...more] = filesOf(root, rel);
  const code = [codeOf(readFileSync(join(root, main), 'utf8')), ...more.map((f) => `${f} ${codeOf(readFileSync(join(root, f), 'utf8'))}`)];
  return short(code.join(' '));
}

function compiler(root) {
  const t = readFileSync(join(root, '.github/checks/toolchain.mjs'), 'utf8');
  return /COMPACTC_REPORTS\s*=\s*['"]([^'"]+)/.exec(t)?.[1] ?? 'unknown';
}

export function parts(root = ROOT) {
  const p = {};
  for (const [k, v] of Object.entries(PARTS)) p[k] = partHash(root, v);
  p.compiler = short(compiler(root));
  return p;
}

export const version = (p) => short(JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]])));

const changed = (old, now) => Object.keys(now).sort().filter((k) => old[k] !== now[k]);

function main(args) {
  const root = args[0] === '--root' ? args[1] : ROOT;
  const a = args[0] === '--root' ? args.slice(2) : args;
  const p = parts(root);
  const v = version(p);
  if (a.length === 0) {
    for (const [k, h] of Object.entries(p)) console.log(`  ${k.padEnd(10)} ${h}`);
    console.log(`  version    ${v}`);
    return 0;
  }
  const [flag, arg, rec] = a;
  if (flag === '--record') {
    const d = arg.replace(/\/$/, '');
    // Each file's own fingerprint, by path, so the freshness check can name the file that changed.
    const files = (FOR_DIR[d] ?? []).filter((k) => PARTS[k]).flatMap((k) => filesOf(root, PARTS[k]));
    const sources = Object.fromEntries(files.map((f) => [f, codeHash(join(root, f))]));
    writeFileSync(join(root, d, '.version'), JSON.stringify({ version: v, parts: p, sources }, null, 1) + '\n');
    return 0;
  }
  if (flag === '--record-shipped' && arg) {
    writeFileSync(join(root, arg), JSON.stringify({ version: v, parts: p }, null, 1) + '\n');
    return 0;
  }
  if (flag === '--current') {
    const f = join(root, arg, rec ?? '.version');
    if (!existsSync(f)) return 2;
    const old = JSON.parse(readFileSync(f, 'utf8')).parts ?? {};
    const mine = new Set(FOR_DIR[arg.replace(/\/$/, '')] ?? []);
    const need = changed(old, p).filter((k) => COMPILED.has(k) && (k === 'compiler' || mine.has(k)));
    return need.length ? 1 : 0;
  }
  if (flag === '--since') {
    const f = join(root, arg);
    if (!existsSync(f)) { console.log(`  no recorded version at ${arg}`); return 2; }
    const rec0 = JSON.parse(readFileSync(f, 'utf8'));
    const ch = changed(rec0.parts ?? {}, p);
    if (ch.length === 0) { console.log(`  contract version ${v}: unchanged`); return 0; }
    const comp = ch.filter((k) => COMPILED.has(k));
    console.log(`  CONTRACT VERSION CHANGED: ${rec0.version} -> ${v} (code changed in: ${ch.join(', ')})`);
    console.log(comp.length ? '  the compiled contracts and their keys must be rebuilt'
      : '  the witnesses changed: no compile or key build is needed');
    return comp.length ? 3 : 4;
  }
  console.log('usage: node scripts/contract-version.mjs [--record <dir> | --current <dir> [record] | --since <file> | --record-shipped <file>]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
