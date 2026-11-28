/**
 * THE CONTRACT'S SOURCE LIST, AND EVERY READER ON IT SEEING AN EDIT MADE ONLY IN A MODULE.
 *
 * Fixtures are written to a temporary folder, never into contracts/. The freshness check has the same
 * test in artifact-freshness.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_TABLE,
  contractSourceText,
  contractSources,
  moduleStateOf,
  tableRefusals
} from './contract-sources.mjs';
import { codeHash, current, partHash, zkirFormat } from './contract-version.mjs';
import { scanSourceFile } from './disclose-scan.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = 'contracts/src/Main.compact';
let root = '';
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no refusal';
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contract-sources-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the list is read off the source, by the three statements the compiler takes a file from', () => {
  it("reads import and include by path, found from the importing file's folder, each file once, main first", () => {
    put(
      MAIN,
      'import CompactStandardLibrary;\n// import "modules/Gone";\nimport "modules/A";\ninclude "frag";\nimport\n  "modules/B";\n'
    );
    put('contracts/src/modules/A.compact', 'module A { import CompactStandardLibrary; import "B"; }\n');
    put('contracts/src/modules/B.compact', 'module B { import CompactStandardLibrary; }\n');
    put('contracts/src/frag.compact', 'circuit f(): [] {}\n');
    expect(contractSources(root, MAIN)).toEqual([
      MAIN,
      'contracts/src/modules/A.compact',
      'contracts/src/modules/B.compact',
      'contracts/src/frag.compact'
    ]);
  });

  it.each([
    ['a bare module name', 'import M;'],
    ['a selective import', 'import { f } from "modules/M";'],
    ['a prefixed import', 'import "modules/M" prefix P_;'],
    ['an include by name', 'include M;']
  ])('refuses %s at its file and line', (_what, stmt) => {
    put(MAIN, `import CompactStandardLibrary;\n${stmt}\n`);
    put('contracts/src/modules/M.compact', 'module M { }\n');
    put('contracts/src/M.compact', 'module M { }\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(
      new RegExp(`^${MAIN}:2: .*write it as import "<path>";`)
    );
  });

  it('refuses an absolute path, a path leaving contracts/src, a missing file and a cycle, each by name', () => {
    put(MAIN, 'import "/tmp/M";\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(/Main\.compact:1: .*absolute path/);
    put(MAIN, 'import "../M";\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(
      /reaches contracts\/M\.compact, outside contracts\/src\//
    );
    put(MAIN, 'import "modules/Gone";\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(
      /modules\/Gone\.compact is not on disk \(brought in by contracts\/src\/Main\.compact\)/
    );
    put(MAIN, 'import "modules/C";\n');
    put('contracts/src/modules/C.compact', 'module C { import "../Main"; }\n');
    expect(refusal(() => contractSources(root, MAIN))).toMatch(/break the cycle/);
  });

  it('the two contracts today: each main file, then its modules in import order', () => {
    const m = (n: string) => `contracts/src/modules/${n}.compact`;
    expect(contractSources(ROOT, 'contracts/src/ConfidentialAccount.compact')).toEqual([
      'contracts/src/ConfidentialAccount.compact',
      m('Seats'),
      m('Commitments'),
      m('Policy'),
      m('RunInterface')
    ]);
    expect(contractSources(ROOT, 'contracts/src/Vault.compact')).toEqual([
      'contracts/src/Vault.compact',
      m('RunInterface'),
      m('Notes'),
      m('SecretCopies')
    ]);
  });
});

describe("an edit made only in a module is seen by every reader of the contract's source", () => {
  const MODULE = 'contracts/src/modules/Part.compact';
  const moduleWith = (body: string): string =>
    `module Part {\n  import CompactStandardLibrary;\n  export circuit part(x: Field): Field {\n    ${body}\n  }\n}\n`;
  beforeEach(() => {
    put(
      MAIN,
      'import CompactStandardLibrary;\nimport "modules/Part";\nexport circuit c(x: Field): Field {\n  return part(x);\n}\n'
    );
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
      for (const f of contractSources(ROOT, main).slice(1))
        expect(moduleStateOf(readFileSync(join(ROOT, f), 'utf8'), f)).toEqual([]);
    }
  });

  it('names, at its line, a module that declares a ledger field or a witness, or reaches the kernel or money', () => {
    const text =
      'module M {\n  // ledger x: Field; witness w(): Field; in a comment is prose\n  export ledger hidden: Uint<64>;\n' +
      '  witness w(): Bytes<32>;\n  circuit k(): Bytes<32> { return kernel.self().bytes; }\n  circuit r(): [] { receiveUnshielded(t, 1); }\n}\n';
    expect(moduleStateOf(text, 'contracts/src/modules/M.compact')).toEqual([
      'contracts/src/modules/M.compact:3: declares a ledger field; keep it in the main file',
      'contracts/src/modules/M.compact:4: declares a witness; keep it in the main file',
      'contracts/src/modules/M.compact:5: reaches the kernel; keep it in the main file',
      'contracts/src/modules/M.compact:6: calls a circuit that moves money or reads the caller; keep it in the main file'
    ]);
  });

  it('names every call that moves money or reads the caller, and never a word inside a string', () => {
    const calls = [
      'receiveUnshielded',
      'sendUnshielded',
      'mintUnshieldedToken',
      'receiveShielded',
      'sendShielded',
      'sendImmediateShielded',
      'mintShieldedToken',
      'mergeCoin',
      'mergeCoinImmediate',
      'createZswapInput',
      'createZswapOutput',
      'ownPublicKey'
    ];
    for (const c of calls) {
      expect(moduleStateOf(`module M {\n  circuit x(): [] { ${c}(a); }\n}\n`, 'M.compact'), c).toHaveLength(1);
    }
    const quoted =
      'module M {\n  circuit x(): [] { assert(y, "no kernel. here, no ledger z, no witness w, no ownPublicKey(a)"); }\n}\n';
    expect(moduleStateOf(quoted, 'M.compact')).toEqual([]);
  });
});

describe('a contract that brings nothing in keeps the version it always had', () => {
  it('a one-file list fingerprints as that one file, so no recorded version changes', () => {
    put('contracts/src/Solo.compact', 'import CompactStandardLibrary;\nexport circuit s(): [] {}\n');
    expect(partHash(root, 'contracts/src/Solo.compact')).toBe(codeHash(join(root, 'contracts/src/Solo.compact')));
  });

  it('a contract that brings modules in fingerprints them all, not its main file alone', () => {
    for (const main of ['contracts/src/ConfidentialAccount.compact', 'contracts/src/Vault.compact']) {
      expect(contractSources(ROOT, main).length).toBeGreaterThan(1);
      expect(partHash(ROOT, main)).not.toBe(codeHash(join(ROOT, main)));
    }
  });
});

describe('the contract table refuses a row it cannot be read by', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    source: 'contracts/src/A.compact',
    compiled: 'contracts/managed-a',
    name: 'A',
    builtFrom: ['a'],
    links: {},
    ...over
  });

  it('accepts the table as it stands, and a sound table', () => {
    expect(tableRefusals(CONTRACT_TABLE)).toEqual([]);
    expect(
      tableRefusals({
        a: row(),
        b: row({
          source: 'contracts/src/B.compact',
          compiled: 'contracts/managed-b',
          name: 'B',
          builtFrom: ['b', 'a', 'witnesses'],
          links: { A: 'a' }
        })
      })
    ).toEqual([]);
  });

  it('names a missing field, a builtFrom without the row itself or naming no row, a link out of order, and a folder held twice', () => {
    /* RED WHEN: a malformed row is taken as it is, so a reader drops a part it does not know or compiles in the wrong order. */
    expect(tableRefusals({ a: row({ compiled: '' }) })).toEqual(['a: compiled is missing or empty']);
    expect(tableRefusals({ a: row({ builtFrom: ['witnesses'] }) })).toEqual([
      'a: builtFrom leaves out the contract itself'
    ]);
    expect(tableRefusals({ a: row({ builtFrom: ['a', 'acount'] }) })).toEqual([
      'a: builtFrom names acount, which is no row'
    ]);
    expect(
      tableRefusals({
        a: row({ links: { B: 'b' } }),
        b: row({ source: 'contracts/src/B.compact', compiled: 'contracts/managed-b', builtFrom: ['b'] })
      })
    ).toEqual(['a: links B to b, which is not a row compiled before it']);
    expect(tableRefusals({ a: row(), b: row({ source: 'contracts/src/B.compact', builtFrom: ['b'] }) })).toEqual([
      'compiled contracts/managed-a is held by two rows'
    ]);
    expect(tableRefusals({ a: row({ links: undefined }) })).toEqual(['a: links is missing']);
  });

  it('stops every reader at once when the table itself is malformed', async () => {
    /* RED WHEN: a malformed table loads, so each reader goes on with a row it cannot read. */
    const dir = mkdtempSync(join(tmpdir(), 'contract-table-'));
    try {
      const own = readFileSync(fileURLToPath(new URL('./contract-sources.mjs', import.meta.url)), 'utf8');
      writeFileSync(
        join(dir, 'contract-sources.mjs'),
        own.replace("builtFrom: ['registry']", "builtFrom: ['registri']")
      );
      await expect(import(join(dir, 'contract-sources.mjs'))).rejects.toThrow(
        /contract table is malformed[\s\S]*registry: builtFrom/u
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('keys built in another key format never count as current', () => {
  it('records the format, and a key build in the other format is stale while one recorded before the format was is not', () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-keys-format-'));
    try {
      const here = fileURLToPath(new URL('..', import.meta.url));
      for (const f of [
        ...new Set(Object.values(CONTRACT_TABLE).flatMap((c) => contractSources(here, c.source))),
        'contracts/src/witnesses.ts',
        '.github/checks/toolchain.mjs'
      ]) {
        mkdirSync(dirname(join(root, f)), { recursive: true });
        writeFileSync(join(root, f), readFileSync(join(here, f)));
      }
      const dir = CONTRACT_TABLE.registry.compiled;
      mkdirSync(join(root, dir), { recursive: true });
      execFileSync('node', [
        fileURLToPath(new URL('./contract-version.mjs', import.meta.url)),
        '--root',
        root,
        '--record',
        dir
      ]);
      const recorded = JSON.parse(readFileSync(join(root, dir, '.version'), 'utf8'));
      expect([recorded.parts.zkir, zkirFormat({}), zkirFormat({ COMPACT_ZKIR_V3: '1' })]).toEqual([
        'default',
        'default',
        'zkir-v3'
      ]);
      expect(current(root, dir)).toBe(0);
      /* RED WHEN: the key format is left out of the fingerprint, so keys built in ZKIR version 3 are kept as this build's. */
      writeFileSync(
        join(root, dir, '.keys-version'),
        JSON.stringify({ ...recorded, parts: { ...recorded.parts, zkir: 'zkir-v3' } })
      );
      expect(current(root, dir, '.keys-version')).toBe(1);
      /* RED WHEN: a record written before the format was recorded is read as another format, and every kept key is set aside. */
      const { zkir: _zkir, ...older } = recorded.parts;
      writeFileSync(join(root, dir, '.keys-version'), JSON.stringify({ ...recorded, parts: older }));
      expect(current(root, dir, '.keys-version')).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
