/**
 * NO CONTRACT MAY DECLARE MORE THAN FIFTEEN TOP-LEVEL LEDGER FIELDS, AND THE
 * COMPILER DOES NOT REFUSE ONE THAT DOES.
 *
 * Sixteen top-level fields compile: the compiler batches the top level into
 * nested arrays, so every field's path moves, field 0 included, and the build
 * and the deploy both succeed. Every client, test and stored decoder that reads
 * a field by its path would then read the wrong place with no error anywhere.
 * So the compiled output of every contract in the table is checked here before
 * the suite runs, and an over-limit or nested ledger stops it.
 *
 * ── WHAT IS COUNTED, AND WHY IT IS NOT THE OBVIOUS THING ─────────────────────
 *
 * NOT THE SOURCE. The source is what a person miscounts, and a field behind an
 * include is counted wrongly by exactly the reader who is already wrong. The
 * compiled output is what deploys.
 *
 * NOT A WHOLE-FILE COUNT OF `newArray()` EITHER. The account's generated module
 * holds more than one `newArray()` call with a flat top level: one builds the
 * field array and others build values pushed inside it. Indentation does not
 * separate them; in the sixteen-field fixture the nested arrays sit at the same
 * indent as the top-level one.
 *
 * ── TWO INSTRUMENTS, AND A DISAGREEMENT IS ITSELF A REFUSAL ──────────────────
 *
 * (1) `compiler/contract-info.json`'s `ledger[].index`. The compiler states the
 *     path of every field, and the SHAPE of that value is the answer: a bare
 *     number while the top level is flat, an ARRAY once it has nested. On the
 *     sixteen-field fixture the indices are `[0,0]`, `[1,0]`, `[1,1]` … `[1,14]`.
 * (2) The constructor's own accumulator in `contract/index.js`: the slice from
 *     `let stateValue_0 = …newArray();` to `state_0.data = …`. One `newArray`
 *     inside it is flat; more is nested. On the sixteen-field fixture that slice
 *     holds three, and `stateValue_0` receives no `newNull()` push: it receives
 *     two nested arrays instead.
 *
 * They are read from two files written by two compiler passes. Where they
 * disagree this refuses rather than picking one.
 *
 * ── WHY THE GENERATED `.d.ts` IS NOT A THIRD INSTRUMENT ──────────────────────
 *
 * The sixteen-field fixture's generated `Ledger` type declares sixteen flat
 * keys, the same shape as the fifteen-field fixture's fifteen. The TypeScript
 * surface carries no sign that anything moved, so a guard comparing key counts
 * learns nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_TABLE } from './contract-sources.mjs';

export type LedgerLimitTarget = {
  readonly label: string;
  /** Directory holding `compiler/contract-info.json` and `contract/index.js`. */
  readonly managed: string;
  /**
   * The command that rebuilds this artifact, for a refusal to name. A command
   * this repository defines rather than a file on one machine: a refusal
   * pointing at something a reader's copy does not contain is not one they can
   * act on.
   */
  readonly door: string;
};

/**
 * EVERY CONTRACT IN THE TABLE (`CONTRACT_TABLE` in scripts/contract-sources.mjs), each by its compiled
 * folder. A contract far below the ceiling is guarded too, so a field added later is caught when it is
 * added. `npm run compact:fast` compiles every contract in the table, so it is the one door.
 */
export const LEDGER_LIMIT_TARGETS: readonly LedgerLimitTarget[] = Object.values(CONTRACT_TABLE).map((c) => ({
  label: c.name, managed: c.compiled, door: 'npm run compact:fast',
}));

/** The compiler's own top-level segment length, past which it nests the ledger. Not chosen here. */
export const MAX_LEDGER_FIELDS = 15;

export type Layout = {
  readonly fields: number;
  /** True when the compiler has batched the top level into nested arrays. */
  readonly reshaped: boolean;
  /** `newArray()` calls inside the constructor's own accumulator slice. */
  readonly constructorArrays: number;
  /** Direct `newNull()` pushes onto the top-level accumulator. */
  readonly topLevelPushes: number;
};

export type LimitRefusalKind = 'missing' | 'instruments-disagree' | 'reshaped' | 'over-limit';

export type LimitRefusal = {
  readonly kind: LimitRefusalKind;
  readonly label: string;
  readonly door: string;
  readonly detail: string;
  readonly layout: Layout | null;
};

/** Instrument (1): what the compiler says the field paths are. */
export function layoutFromInfo(infoText: string): { fields: number; reshaped: boolean } {
  const info = JSON.parse(infoText) as { ledger?: { name: string; index: number | number[] }[] };
  const ledger = info.ledger ?? [];
  return { fields: ledger.length, reshaped: ledger.some((f) => Array.isArray(f.index)) };
}

/**
 * Instrument (2): the constructor's own accumulator.
 *
 * The slice is anchored on the two lines that open and close it rather than on
 * a line number or an indent, because both of those are compiler formatting and
 * neither is a promise.
 */
export function layoutFromArtifact(moduleText: string): { constructorArrays: number; topLevelPushes: number; reshaped: boolean } {
  const open = moduleText.indexOf('let stateValue_0 = __compactRuntime.StateValue.newArray();');
  if (open === -1) {
    throw new Error(
      'ledger-limit: the artifact has no `let stateValue_0 = …newArray();` — the constructor does not build ' +
        'a top-level field array in the shape this guard knows how to count. Reading it any other way would be a guess.',
    );
  }
  const close = moduleText.indexOf('state_0.data = new __compactRuntime.ChargedState(stateValue_0);', open);
  if (close === -1) {
    throw new Error('ledger-limit: the constructor accumulator opens and is never handed to ChargedState. The artifact is not the shape this guard knows how to count.');
  }
  const slice = moduleText.slice(open, close);
  const constructorArrays = (slice.match(/__compactRuntime\.StateValue\.newArray\(\)/g) ?? []).length;
  const topLevelPushes = (slice.match(/stateValue_0 = stateValue_0\.arrayPush\(__compactRuntime\.StateValue\.newNull\(\)\);/g) ?? []).length;
  return { constructorArrays, topLevelPushes, reshaped: constructorArrays > 1 };
}

/** Both instruments over one compiled artifact directory. */
export function readLayout(root: string, managed: string): Layout {
  const info = layoutFromInfo(readFileSync(join(root, managed, 'compiler', 'contract-info.json'), 'utf8'));
  const art = layoutFromArtifact(readFileSync(join(root, managed, 'contract', 'index.js'), 'utf8'));
  if (info.reshaped !== art.reshaped) {
    throw new Error(
      `ledger-limit: the two instruments disagree about ${managed}. contract-info.json says the top level is ` +
        `${info.reshaped ? 'NESTED' : 'FLAT'} and the constructor says it is ${art.reshaped ? 'NESTED' : 'FLAT'} ` +
        `(${art.constructorArrays} newArray, ${art.topLevelPushes} top-level pushes). One of them is being read wrongly ` +
        'and this guard will not pick. Nothing was asserted.',
    );
  }
  return { fields: info.fields, reshaped: info.reshaped, constructorArrays: art.constructorArrays, topLevelPushes: art.topLevelPushes };
}

/**
 * Every artifact that stops the build.
 *
 * IT THROWS ON AN EMPTY TARGET LIST. A check over nothing
 * cannot fail, and the only way to disarm this guard from inside is to hand it
 * nothing to check.
 */
export function limitRefusals(root: string, targets: readonly LedgerLimitTarget[]): LimitRefusal[] {
  if (targets.length === 0) {
    throw new Error(
      'ledger-limit: asked to check ZERO artifacts. A check over nothing cannot fail, so this is an ' +
        'error rather than a pass. Something has emptied LEDGER_LIMIT_TARGETS.',
    );
  }
  const out: LimitRefusal[] = [];
  for (const t of targets) {
    const dir = join(root, t.managed);
    if (!existsSync(join(dir, 'compiler', 'contract-info.json')) || !existsSync(join(dir, 'contract', 'index.js'))) {
      out.push({ kind: 'missing', label: t.label, door: t.door, detail: `${t.managed} has not been compiled here`, layout: null });
      continue;
    }
    let layout: Layout;
    try {
      layout = readLayout(root, t.managed);
    } catch (e) {
      out.push({ kind: 'instruments-disagree', label: t.label, door: t.door, detail: String((e as Error).message), layout: null });
      continue;
    }
    // RESHAPED IS CHECKED FIRST AND SEPARATELY FROM THE COUNT. They are the
    // same fault at different stages: over-limit is what a person can still
    // fix in the source, reshaped is what the artifact on disk already is.
    // Collapsing them into one message loses which of those is true.
    if (layout.reshaped) {
      out.push({ kind: 'reshaped', label: t.label, door: t.door, detail: `${layout.fields} fields; the compiler has nested the top level`, layout });
      continue;
    }
    if (layout.fields > MAX_LEDGER_FIELDS) {
      out.push({ kind: 'over-limit', label: t.label, door: t.door, detail: `${layout.fields} fields`, layout });
    }
  }
  return out;
}

export function limitRefusalText(refusals: readonly LimitRefusal[]): string {
  const out: string[] = [];
  out.push('');
  out.push('  THE BUILD DID NOT RUN.');
  out.push('');
  out.push('  A LEDGER WITH MORE THAN FIFTEEN TOP-LEVEL FIELDS COMPILES AND DEPLOYS, AND EVERY');
  out.push('  FIELD PATH MOVES — FIELD 0 INCLUDED. Nothing in the compiler refuses it, so every');
  out.push('  client, test and stored decoder would read the wrong places with no error anywhere.');
  out.push('');
  for (const r of refusals) {
    out.push(`  ${r.label}  —  ${r.detail}`);
    if (r.layout) {
      out.push('');
      out.push(`      fields declared            ${r.layout.fields}   (the ceiling is ${MAX_LEDGER_FIELDS})`);
      out.push(`      constructor newArray()     ${r.layout.constructorArrays}   (1 is a flat top level)`);
      out.push(`      top-level newNull() pushes ${r.layout.topLevelPushes}   (0 once the state has nested)`);
    }
    out.push('');
    if (r.kind === 'reshaped' || r.kind === 'over-limit') {
      out.push('      NO DOOR RESOLVES THIS. Recompiling reproduces it. The contract must declare');
      out.push(`      at most ${MAX_LEDGER_FIELDS} top-level ledger fields — group them into a record, or drop one.`);
    } else if (r.kind === 'missing') {
      out.push(`      Run ${r.door}, then run this again.`);
    } else {
      out.push('      NO DOOR RESOLVES THIS. Two instruments read the same artifact differently and');
      out.push('      one of them is wrong; scripts/ledger-limit.ts is where that is settled.');
    }
    out.push('');
  }
  return out.join('\n');
}

export function assertLedgerLimit(root: string, targets: readonly LedgerLimitTarget[] = LEDGER_LIMIT_TARGETS): void {
  const refusals = limitRefusals(root, targets);
  if (refusals.length > 0) throw new Error(limitRefusalText(refusals));
}
