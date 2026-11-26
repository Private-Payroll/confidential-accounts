/**
 * A CHECK THAT CANNOT FAIL HAS ALREADY FAILED.
 *
 * A ledger past fifteen top-level fields compiles, deploys and produces no error
 * anywhere, so a guard against it is unusually easy to write, wire, and never
 * see fire. The fixtures below are the real thing:
 * `contracts/fixtures/ledger-limit/fifteen` and `.../sixteen` are the compiled
 * outputs of a fifteen-field and a sixteen-field contract, each beside its
 * `source.compact`.
 *
 * THEY ARE MEASUREMENTS, NOT HAND-WRITTEN FIXTURES. A hand-written
 * `contract-info.json` asserting what a sixteen-field compile looks like would
 * be this repository asserting its own belief about the compiler; these came
 * out of the compiler, whose version each fixture's own `contract-info.json`
 * records, and a test below holds that to the installed compiler's.
 *
 * WHAT WOULD MAKE THEM STALE: a compiler upgrade. The guard reads real
 * artifacts compiled by whatever version is installed, so a compiler that
 * changed the emitted shape would fail `layoutFromArtifact`'s anchors loudly
 * rather than passing quietly.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LEDGER_LIMIT_TARGETS,
  MAX_LEDGER_FIELDS,
  assertLedgerLimit,
  layoutFromArtifact,
  layoutFromInfo,
  limitRefusalText,
  limitRefusals,
  readLayout,
} from './ledger-limit.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = 'contracts/fixtures/ledger-limit';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('THE FIFTEEN-FIELD FIXTURE — what a legal ledger looks like', () => {
  it('the compiler states fifteen flat indices', () => {
    expect(layoutFromInfo(read(`${FIXTURES}/fifteen/contract-info.json`))).toEqual({ fields: 15, reshaped: false });
  });

  it('the constructor builds ONE array with fifteen direct pushes', () => {
    expect(layoutFromArtifact(read(`${FIXTURES}/fifteen/index.js`))).toEqual({
      constructorArrays: 1,
      topLevelPushes: 15,
      reshaped: false,
    });
  });

  it('fifteen is not over the limit — the boundary is checked from BOTH sides', () => {
    expect(MAX_LEDGER_FIELDS).toBe(15);
    expect(15 > MAX_LEDGER_FIELDS).toBe(false);
  });
});

describe('THE SIXTEENTH FIELD — THE REFUSAL FIRES, which is why this file exists', () => {
  it('the compiler nests every index, field 0 included', () => {
    // This is the whole defect in one assertion: not an error, not a rejected
    // build — sixteen paths that all MOVED.
    const info = JSON.parse(read(`${FIXTURES}/sixteen/contract-info.json`)) as { ledger: { name: string; index: number | number[] }[] };
    expect(info.ledger).toHaveLength(16);
    expect(info.ledger[0].index).toEqual([0, 0]);
    expect(info.ledger[1].index).toEqual([1, 0]);
    expect(info.ledger.every((f) => Array.isArray(f.index))).toBe(true);
    expect(layoutFromInfo(read(`${FIXTURES}/sixteen/contract-info.json`))).toEqual({ fields: 16, reshaped: true });
  });

  it('the constructor builds THREE arrays and pushes nothing at the top level', () => {
    expect(layoutFromArtifact(read(`${FIXTURES}/sixteen/index.js`))).toEqual({
      constructorArrays: 3,
      topLevelPushes: 0,
      reshaped: true,
    });
  });

  it('THE GUARD REFUSES IT — the whole guard, over a tree holding the real artifact', () => {
    // NOT the two readers called by hand: `limitRefusals` itself, over a tree
    // laid out exactly as a compiled contract is, holding the sixteen-field
    // artifact compactc actually emitted. This is the assertion that would go
    // red if the guard were wired to look at the wrong thing, defaulted its way
    // past a reshape, or reported it as a pass.
    const tree = mkdtempSync(join(tmpdir(), 'ledger-limit-'));
    try {
      const managed = 'contracts/managed-sixteen';
      mkdirSync(join(tree, managed, 'compiler'), { recursive: true });
      mkdirSync(join(tree, managed, 'contract'), { recursive: true });
      writeFileSync(join(tree, managed, 'compiler/contract-info.json'), read(`${FIXTURES}/sixteen/contract-info.json`));
      writeFileSync(join(tree, managed, 'contract/index.js'), read(`${FIXTURES}/sixteen/index.js`));

      const target = { label: 'sixteen', managed, door: 'npm run compile:sixteen' };
      const refusals = limitRefusals(tree, [target]);
      expect(refusals).toHaveLength(1);
      expect(refusals[0].kind).toBe('reshaped');
      expect(refusals[0].layout).toEqual({ fields: 16, reshaped: true, constructorArrays: 3, topLevelPushes: 0 });
      expect(() => assertLedgerLimit(tree, [target])).toThrow(/THE BUILD DID NOT RUN/);

      // And the same tree with the FIFTEEN artifact passes, so the refusal
      // above is the sixteenth field and not the fixture being unreadable.
      writeFileSync(join(tree, managed, 'compiler/contract-info.json'), read(`${FIXTURES}/fifteen/contract-info.json`));
      writeFileSync(join(tree, managed, 'contract/index.js'), read(`${FIXTURES}/fifteen/index.js`));
      expect(limitRefusals(tree, [target])).toEqual([]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('THE `.d.ts` CANNOT SEE IT, which is why it is not a third instrument', () => {
    // The generated TypeScript surface is FLAT in both fixtures. A reader
    // trusting index.d.ts, or a guard comparing key counts, learns nothing.
    // This is asserted rather than left in a comment because it is the reason
    // the guard reads what it reads.
    const sixteen = read(`${FIXTURES}/sixteen/source.compact`);
    expect((sixteen.match(/export ledger /g) ?? []).length).toBe(16);
    const fifteen = read(`${FIXTURES}/fifteen/source.compact`);
    expect((fifteen.match(/export ledger /g) ?? []).length).toBe(15);
  });
});

describe('the refusal is one a person can act on', () => {
  it('says NO DOOR resolves an over-limit contract, because recompiling reproduces it', () => {
    const text = limitRefusalText([
      { kind: 'reshaped', label: 'Fixture', door: 'npm run compile:fixture', detail: '16 fields', layout: { fields: 16, reshaped: true, constructorArrays: 3, topLevelPushes: 0 } },
    ]);
    expect(text).toContain('THE BUILD DID NOT RUN');
    expect(text).toContain('NO DOOR RESOLVES THIS');
    expect(text).not.toContain('Run npm run compile:fixture');
    // It shows its working: all three measured numbers.
    expect(text).toContain('fields declared            16');
    expect(text).toContain('constructor newArray()     3');
    expect(text).toContain('top-level newNull() pushes 0');
    expect(text).not.toMatch(/environment variable|SKIP|set [A-Z_]+=/);
  });

  it('names the compiler door when an artifact has simply not been built', () => {
    const refusals = limitRefusals(ROOT, [{ label: 'Nowhere', managed: 'contracts/not-compiled-here', door: 'npm run compile:nowhere' }]);
    expect(refusals[0].kind).toBe('missing');
    expect(limitRefusalText(refusals)).toContain('Run npm run compile:nowhere');
  });

  it('REFUSES RATHER THAN PICKING when the two instruments disagree', () => {
    // `readLayout` returns `reshaped` from instrument (1) alone, so without the
    // disagreement branch instrument (2) would be decoration. The disagreeing
    // pair is built here, from the two real fixtures, crossed.
    const tree = mkdtempSync(join(tmpdir(), 'ledger-limit-x-'));
    try {
      const managed = 'contracts/managed-crossed';
      mkdirSync(join(tree, managed, 'compiler'), { recursive: true });
      mkdirSync(join(tree, managed, 'contract'), { recursive: true });
      // FIFTEEN's flat indices against SIXTEEN's nested constructor.
      writeFileSync(join(tree, managed, 'compiler/contract-info.json'), read(`${FIXTURES}/fifteen/contract-info.json`));
      writeFileSync(join(tree, managed, 'contract/index.js'), read(`${FIXTURES}/sixteen/index.js`));
      expect(() => readLayout(tree, managed)).toThrow(/two instruments disagree/);
      const refusals = limitRefusals(tree, [{ label: 'crossed', managed, door: 'npm run compile:crossed' }]);
      expect(refusals[0].kind).toBe('instruments-disagree');
      expect(limitRefusalText(refusals)).toContain('NO DOOR RESOLVES THIS');
      // And the other crossing too, so neither direction is the untested one.
      writeFileSync(join(tree, managed, 'compiler/contract-info.json'), read(`${FIXTURES}/sixteen/contract-info.json`));
      writeFileSync(join(tree, managed, 'contract/index.js'), read(`${FIXTURES}/fifteen/index.js`));
      expect(() => readLayout(tree, managed)).toThrow(/two instruments disagree/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
    expect(() => readLayout(ROOT, 'contracts/managed')).not.toThrow();
    expect(() => layoutFromArtifact('export const nothing = 1;\n')).toThrow(/newArray|shape this guard knows/);
  });

  it('THE FIXTURES WERE BUILT BY THE COMPILER THAT IS INSTALLED', () => {
    // The fixtures are measurements, and a measurement carries the instrument
    // that took it. A compiler upgrade would change the emitted shape and the
    // real artifacts would fail `layoutFromArtifact`'s anchors loudly — but the
    // fixtures would go on asserting the OLD compiler's `3 newArray` and
    // `[0,0]`, which is a guard proving something about a compiler nobody runs.
    const installed = (JSON.parse(read('contracts/managed/compiler/contract-info.json')) as { 'compiler-version': string })['compiler-version'];
    for (const n of ['fifteen', 'sixteen']) {
      const v = (JSON.parse(read(`${FIXTURES}/${n}/contract-info.json`)) as { 'compiler-version': string })['compiler-version'];
      expect(v).toBe(installed);
    }
  });

  it('cannot be disarmed by being given nothing to check', () => {
    expect(() => limitRefusals(ROOT, [])).toThrow(/ZERO artifacts/);
  });
});

describe('the guard is WIRED IN, and every contract is under it', () => {
  it('vitest.config.ts really HOLDS the globalSetup value — read, not grepped', async () => {
    const config = (await import('../vitest.config.ts')).default as { test?: { globalSetup?: string | string[] } };
    const wired = config.test?.globalSetup;
    expect(Array.isArray(wired) ? wired : [wired]).toContain('./scripts/ledger-limit.globalSetup.ts');
  });

  it('THE WIRED MODULE ITSELF REFUSES — its default export, called, over a tree with no artifacts', async () => {
    const mod = await import('./ledger-limit.globalSetup.js');
    expect(typeof mod.default).toBe('function');
    expect(() => mod.default(undefined, join(ROOT, 'scripts'))).toThrow(/THE BUILD DID NOT RUN/);
  });

  it('every contract in the table is checked, each with the door that rebuilds it', () => {
    /* RED WHEN: a contract is dropped from the guard's targets, or a target names a folder no compile writes. */
    expect(LEDGER_LIMIT_TARGETS.map((t) => [t.label, t.managed, t.door])).toEqual([
      ['ConfidentialAccount', 'contracts/managed', 'npm run compact:fast'],
      ['Vault', 'contracts/managed-vault', 'npm run compact:fast'],
      ['PrivateRegistry', 'contracts/managed-registry', 'npm run compact:fast'],
    ]);
    // AND EACH IS A COMMAND A READER CAN ACTUALLY RUN. Read as a path, this
    // passed only in the one folder that happened to hold a file of that name.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const t of LEDGER_LIMIT_TARGETS) {
      const named = /^npm run ([A-Za-z0-9:_-]+)$/.exec(t.door);
      expect({ door: t.door, defined: named !== null && typeof pkg.scripts[named[1]] === 'string' })
        .toEqual({ door: t.door, defined: true });
    }
  });

  it('THE REAL CONTRACTS ARE UNDER THE CEILING — the live default, no arguments', () => {
    expect(() => assertLedgerLimit(ROOT)).not.toThrow();
    // And the headroom is stated, so a round that spends it can see what it spent.
    for (const t of LEDGER_LIMIT_TARGETS) {
      const l = readLayout(ROOT, t.managed);
      expect(l.reshaped).toBe(false);
      expect(l.fields).toBeLessThanOrEqual(MAX_LEDGER_FIELDS);
      expect(l.topLevelPushes).toBe(l.fields);
    }
  });
});
