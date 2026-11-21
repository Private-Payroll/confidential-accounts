/**
 * THE CONTRACT'S SOURCE LIST, AND EVERY READER ON IT SEEING AN EDIT MADE ONLY IN A MODULE.
 *
 * Fixtures are written to a temporary folder, never into contracts/. The freshness check has the same
 * test in artifact-freshness.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contractSourceText, contractSources, moduleStateOf } from './contract-sources.mjs';
import { codeHash, partHash } from './contract-version.mjs';
import { scanSourceFile } from './disclose-scan.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = 'contracts/src/Main.compact';
let root = '';
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  return 'no refusal';
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'contract-sources-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the list is read off the source, by the three statements the compiler takes a file from', () => {
  it('reads import and include by path, found from the importing file\'s folder, each file once, main first', () => {
    put(MAIN, 'import CompactStandardLibrary;\n// import "modules/Gone";\nimport "modules/A";\ninclude "frag";\nimport\n  "modules/B";\n');
    put('contracts/src/modules/A.compact', 'module A { import CompactStandardLibrary; import "B"; }\n');
    put('contracts/src/modules/B.compact', 'module B { import CompactStandardLibrary; }\n');
    put('contracts/src/frag.compact', 'circuit f(): [] {}\n');
    expect(contractSources(root, MAIN)).toEqual([
      MAIN, 'contracts/src/modules/A.compact', 'contracts/src/modules/B.compact', 'contracts/src/frag.compact',
    ]);
  });

  it.each([
    ['a bare module name', 'import M;'],
    ['a selective import', 'import { f } from "modules/M";'],
    ['a prefixed import', 'import "modules/M" prefix P_;'],
    ['an include by name', 'include M;'],
  ])('refuses %s at its file and line', (_what, stmt) => {
    put(MAIN, `import CompactStandardLibrary;\n${stmt}\n`);
    put('contracts/src/modules/M.compact', 'module M { }\n');
    put('contracts/src/M.compact', 'module M { }\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(new RegExp(`^${MAIN}:2: .*write it as import "<path>";`));
  });

  it('refuses an absolute path, a path leaving contracts/src, a missing file and a cycle, each by name', () => {
    put(MAIN, 'import "/tmp/M";\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(/Main\.compact:1: .*absolute path/);
    put(MAIN, 'import "../M";\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(/reaches contracts\/M\.compact, outside contracts\/src\//);
    put(MAIN, 'import "modules/Gone";\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(/modules\/Gone\.compact is not on disk \(brought in by contracts\/src\/Main\.compact\)/);
    put(MAIN, 'import "modules/C";\n');
    put('contracts/src/modules/C.compact', 'module C { import "../Main"; }\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(/break the cycle/);
  });

  it('the two contracts today: each list is its main file', () => {
    expect(contractSources(ROOT, 'contracts/src/ConfidentialAccount.compact')).toEqual(['contracts/src/ConfidentialAccount.compact']);
    expect(contractSources(ROOT, 'contracts/src/Vault.compact')).toEqual(['contracts/src/Vault.compact']);
  });
});

describe('an edit made only in a module is seen by every reader of the contract\'s source', () => {
  const MODULE = 'contracts/src/modules/Part.compact';
  const moduleWith = (body: string): string =>
    `module Part {\n  import CompactStandardLibrary;\n  export circuit part(x: Field): Field {\n    ${body}\n  }\n}\n`;
  beforeEach(() => {
    put(MAIN, 'import CompactStandardLibrary;\nimport "modules/Part";\nexport circuit c(x: Field): Field {\n  return part(x);\n}\n');
    put(MODULE, moduleWith('return x;'));
  });

  it('the version fingerprint changes', () => {
    const before = partHash(root, MAIN);
    put(MODULE, moduleWith('return x + 1;'));
    expect(partHash(root, MAIN)).not.toBe(before);
  });

  it('the disclose scan finds the site, in the module, and in the circuit that calls it', () => {
    expect(scanSourceFile(root, MAIN).find((c) => c.name === 'c')?.discloses).toEqual([]);
    put(MODULE, moduleWith('return disclose(x);'));
    const c = scanSourceFile(root, MAIN).find((b) => b.name === 'c');
    expect(c?.discloses).toEqual([{ file: MODULE, line: 4, text: 'x', via: ['part'] }]);
  });

  it('the text the source-reading tests search holds the module', () => {
    put(MODULE, moduleWith('return x + 7;'));
    expect(contractSourceText(root, MAIN)).toContain('return x + 7;');
  });
});

describe('a module stays a helper', () => {
  it('no file either contract brings in, past its main file, declares state or reaches the kernel', () => {
    for (const main of ['contracts/src/ConfidentialAccount.compact', 'contracts/src/Vault.compact']) {
      for (const f of contractSources(ROOT, main).slice(1)) expect(moduleStateOf(readFileSync(join(ROOT, f), 'utf8'), f)).toEqual([]);
    }
  });

  it('names, at its line, a module that declares a ledger field or a witness, or reaches the kernel or money', () => {
    const text = 'module M {\n  // ledger x: Field; witness w(): Field; in a comment is prose\n  export ledger hidden: Uint<64>;\n' +
      '  witness w(): Bytes<32>;\n  circuit k(): Bytes<32> { return kernel.self().bytes; }\n  circuit r(): [] { receiveUnshielded(t, 1); }\n}\n';
    expect(moduleStateOf(text, 'contracts/src/modules/M.compact')).toEqual([
      'contracts/src/modules/M.compact:3: declares a ledger field; keep it in the main file',
      'contracts/src/modules/M.compact:4: declares a witness; keep it in the main file',
      'contracts/src/modules/M.compact:5: reaches the kernel; keep it in the main file',
      'contracts/src/modules/M.compact:6: calls a circuit that moves money or reads the caller; keep it in the main file',
    ]);
  });

  it('names every call that moves money or reads the caller, and never a word inside a string', () => {
    const calls = ['receiveUnshielded', 'sendUnshielded', 'mintUnshieldedToken', 'receiveShielded', 'sendShielded',
      'sendImmediateShielded', 'mintShieldedToken', 'mergeCoin', 'mergeCoinImmediate', 'createZswapInput', 'createZswapOutput', 'ownPublicKey'];
    for (const c of calls) {
      expect(moduleStateOf(`module M {\n  circuit x(): [] { ${c}(a); }\n}\n`, 'M.compact'), c).toHaveLength(1);
    }
    const quoted = 'module M {\n  circuit x(): [] { assert(y, "no kernel. here, no ledger z, no witness w, no ownPublicKey(a)"); }\n}\n';
    expect(moduleStateOf(quoted, 'M.compact')).toEqual([]);
  });
});

describe('a contract that brings nothing in keeps the version it always had', () => {
  it('a one-file list fingerprints as that one file, so no recorded version changes', () => {
    put('contracts/src/Solo.compact', 'import CompactStandardLibrary;\nexport circuit s(): [] {}\n');
    expect(partHash(root, 'contracts/src/Solo.compact')).toBe(codeHash(join(root, 'contracts/src/Solo.compact')));
  });
});
