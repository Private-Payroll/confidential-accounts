#!/usr/bin/env node
/**
 * THE CONTRACT'S VERSION, BY ITS CODE.
 *
 * A contract is its ledger, circuits, constructor, witnesses, types and constants, compiled by one
 * compiler. Its version is a fingerprint of exactly that: the code of
 * contracts/src/ConfidentialAccount.compact, contracts/src/Vault.compact and contracts/src/witnesses.ts
 * with comments and spacing taken out, plus the compiler version pinned in .github/checks/toolchain.mjs.
 * A comment, spacing or save-time change is never a new version and never asks for a compile or a key
 * build; a change to the code always is, and says so.
 *
 *   node scripts/contract-version.mjs                              each part's fingerprint and the version
 *   node scripts/contract-version.mjs --record <dir>               after a compile: write <dir>/.version
 *   node scripts/contract-version.mjs --current <dir> [record]     exit 0 if <dir> (or its keys, with
 *                                                                  .keys-version) was built from this code
 *   node scripts/contract-version.mjs --since <file>               compare with a recorded version; say what changed
 *   node scripts/contract-version.mjs --record-shipped             write .midnight/contract-version.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PARTS = {
  account: 'contracts/src/ConfidentialAccount.compact',
  vault: 'contracts/src/Vault.compact',
  witnesses: 'contracts/src/witnesses.ts',
};
/** Which parts each compiled folder is built from. */
const FOR_DIR = {
  'contracts/managed': ['account', 'witnesses'],
  'contracts/managed-vault': ['vault', 'account', 'witnesses'],
};
/** The parts that change the compiled circuits and keys. The witnesses run on the device and are not
 * compiled into a key, so a witness-only change is a new version with nothing to rebuild. */
const COMPILED = new Set(['account', 'vault', 'compiler']);

/** The code with comments and spacing taken out. Strings are kept whole, so a // inside one stays. */
export function codeOf(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith('//', i)) {
      const j = text.indexOf('\n', i);
      i = j < 0 ? text.length : j;
    } else if (text.startsWith('/*', i)) {
      const j = text.indexOf('*/', i + 2);
      i = j < 0 ? text.length : j + 2;
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** One file's code fingerprint. */
export const codeHash = (path) => short(codeOf(readFileSync(path, 'utf8')));

function compiler() {
  const t = readFileSync(join(ROOT, '.github/checks/toolchain.mjs'), 'utf8');
  return /COMPACTC_REPORTS\s*=\s*['"]([^'"]+)/.exec(t)?.[1] ?? 'unknown';
}

export function parts() {
  const p = {};
  for (const [k, v] of Object.entries(PARTS)) p[k] = codeHash(join(ROOT, v));
  p.compiler = short(compiler());
  return p;
}

export const version = (p) => short(JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]])));

const changed = (old, now) => Object.keys(now).sort().filter((k) => old[k] !== now[k]);

function main(a) {
  const p = parts();
  const v = version(p);
  if (a.length === 0) {
    for (const [k, h] of Object.entries(p)) console.log(`  ${k.padEnd(10)} ${h}`);
    console.log(`  version    ${v}`);
    return 0;
  }
  const [flag, arg, rec] = a;
  if (flag === '--record') {
    const d = arg.replace(/\/$/, '');
    const sources = Object.fromEntries((FOR_DIR[d] ?? []).filter((k) => PARTS[k]).map((k) => [PARTS[k], p[k]]));
    writeFileSync(join(ROOT, d, '.version'), JSON.stringify({ version: v, parts: p, sources }, null, 1) + '\n');
    return 0;
  }
  if (flag === '--record-shipped') {
    writeFileSync(join(ROOT, '.midnight/contract-version.json'), JSON.stringify({ version: v, parts: p }, null, 1) + '\n');
    return 0;
  }
  if (flag === '--current') {
    const f = join(ROOT, arg, rec ?? '.version');
    if (!existsSync(f)) return 2;
    const old = JSON.parse(readFileSync(f, 'utf8')).parts ?? {};
    const mine = new Set(FOR_DIR[arg.replace(/\/$/, '')] ?? []);
    const need = changed(old, p).filter((k) => COMPILED.has(k) && (k === 'compiler' || mine.has(k)));
    return need.length ? 1 : 0;
  }
  if (flag === '--since') {
    const f = join(ROOT, arg);
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
  console.log('usage: node scripts/contract-version.mjs [--record <dir> | --current <dir> [record] | --since <file> | --record-shipped]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
