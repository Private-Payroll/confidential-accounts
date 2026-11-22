#!/usr/bin/env node
/**
 * THE FILES A CONTRACT IS COMPILED FROM, READ OFF ITS OWN SOURCE.
 *
 * A contract is its main file and every file that file brings in. Every reader that asks "has the
 * contract changed" (the freshness check, the version fingerprint, the disclose scan, the mutation
 * harness, the tests that read source) takes its list from here, so no reader keeps a list of its own.
 *
 * Three statements are read, and only three: `import "<path>";` and `include "<path>";` bring in
 * `<path>.compact`, found from the folder of the file that holds the statement (as the compiler finds
 * it first), and `import CompactStandardLibrary;` brings in no file. Every other import form also
 * compiles (a bare `import M;`, `import { f } from "<path>";`, a `prefix`), and each is refused at its
 * file and line, so a file can never reach the compiler by a road this list does not walk. A path that
 * is absolute or leaves `contracts/src/`, a file that is not there, and a cycle are refused too. The
 * compiler's search path is consulted only when the file is not found next to the importer, and a
 * file not found there is refused here first.
 *
 *   node scripts/contract-sources.mjs [--root <folder>] <main.compact>   one root-relative path a line, main first
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Each contract by its main file, the one table every reader of the contracts takes them from. */
export const CONTRACTS = {
  account: 'contracts/src/ConfidentialAccount.compact',
  vault: 'contracts/src/Vault.compact',
};

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

/** Comments, and strings too when `strings` is set (quotes included), blanked to spaces; offsets and lines kept. */
export function blank(src, strings) {
  const out = src.split('');
  const wipe = (from, to) => { for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  for (let i = 0; i < src.length; ) {
    if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      wipe(i, end);
      i = end;
    } else if (src.startsWith('//', i)) {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      wipe(i, end);
      i = end;
    } else if (src[i] === '"' || src[i] === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== src[i]) j += src[j] === '\\' ? 2 : 1;
      if (strings) wipe(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else i += 1;
  }
  return out.join('');
}

const lineAt = (text, at) => text.slice(0, at).split('\n').length;

/** Every `import` and `include` statement in one file: `{ line, text, path? }`, or a refusal. */
export function statementsOf(text, file) {
  const code = blank(text, false);
  const bare = blank(text, true);
  const found = [];
  for (const m of bare.matchAll(/\b(import|include)\b/g)) {
    const at = m.index ?? 0;
    const end = bare.indexOf(';', at);
    const stmt = code.slice(at, end < 0 ? code.length : end + 1).replace(/\s+/g, ' ').trim();
    const line = lineAt(text, at);
    const byPath = /^(?:import|include) "([^"\\]*)" ?;$/.exec(stmt);
    if (byPath) found.push({ line, text: stmt, path: byPath[1] });
    else if (/^import CompactStandardLibrary ?;$/.test(stmt)) found.push({ line, text: stmt });
    else {
      throw new Error(`${file}:${line}: \`${stmt}\` brings a file in by a form the contract's source list does not read; ` +
        'write it as import "<path>"; (or include "<path>";), so every reader of the contract sees the file');
    }
  }
  return found;
}

/** The main file, then every file it brings in, in the order they are reached, each once. */
export function contractSources(root, main) {
  const out = [];
  const walk = (file, chain) => {
    if (chain.includes(file)) throw new Error(`${file} is brought in by a file it brings in (${[...chain, file].join(' -> ')}); break the cycle`);
    if (out.includes(file)) return;
    const abs = posix.join(root.split('\\').join('/'), file);
    if (!existsSync(abs)) {
      const by = chain.length ? ` (brought in by ${chain[chain.length - 1]})` : '';
      throw new Error(`${file} is not on disk${by}; restore it, or remove the statement that brings it in`);
    }
    out.push(file);
    for (const s of statementsOf(readFileSync(abs, 'utf8'), file)) {
      if (s.path === undefined) continue;
      const where = `${file}:${s.line}`;
      if (s.path.startsWith('/')) throw new Error(`${where}: \`${s.text}\` names an absolute path; name it from ${posix.dirname(file)}/`);
      const next = posix.normalize(posix.join(posix.dirname(file), `${s.path}.compact`));
      if (!next.startsWith('contracts/src/')) throw new Error(`${where}: \`${s.text}\` reaches ${next}, outside contracts/src/; keep every contract file under contracts/src/`);
      walk(next, [...chain, file]);
    }
  };
  walk(posix.normalize(main), []);
  return out;
}

/**
 * What a file other than a main file must never do, read from its executing code: declare a ledger field
 * or a witness, or reach the kernel or a circuit that moves money. The compiler takes all of these from
 * a module imported by path and makes them the contract's, so nothing but this keeps a module a helper.
 */
export function moduleStateOf(text, file) {
  const code = blank(text, true);
  const said = [];
  const rule = [
    [/\b(?:export\s+)?(?:sealed\s+)?ledger\s+[A-Za-z_]/g, 'declares a ledger field'],
    [/\bwitness\s+[A-Za-z_]/g, 'declares a witness'],
    [/\bkernel\s*\./g, 'reaches the kernel'],
    [/\b(?:receiveUnshielded|sendUnshielded|mintUnshieldedToken|receiveShielded|sendShielded|sendImmediateShielded|mintShieldedToken|mergeCoin|mergeCoinImmediate|createZswapInput|createZswapOutput|ownPublicKey)\s*\(/g, 'calls a circuit that moves money or reads the caller'],
  ];
  for (const [re, what] of rule) for (const m of code.matchAll(re)) said.push(`${file}:${lineAt(text, m.index ?? 0)}: ${what}; keep it in the main file`);
  return said;
}

/** Every file of the list, read and joined, for a reader that searches the contract's whole text. */
export const contractSourceText = (root, main) =>
  contractSources(root, main).map((f) => readFileSync(posix.join(root.split('\\').join('/'), f), 'utf8')).join('\n');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    const root = args[0] === '--root' ? args[1] : ROOT;
    const main = args[0] === '--root' ? args[2] : args[0];
    if (!main) throw new Error('usage: node scripts/contract-sources.mjs [--root <folder>] <main.compact>');
    for (const f of contractSources(root, main)) console.log(f);
  } catch (e) {
    console.error(`contract-sources: ${e.message}`);
    process.exit(1);
  }
}
