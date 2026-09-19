/**
 * READING A COMPILED ARTIFACT WITHOUT WRITING A JAVASCRIPT PARSER.
 *
 * Everything a description of these contracts needs — which circuit reads which
 * ledger field, which writes it, what it asserts, which witness it consumes,
 * which contract it calls — is in `contracts/managed{,-vault}/contract/index.js`.
 * None of it is in a data structure; all of it is in the shape of emitted code.
 *
 * THE FIRST DRAFT OF THIS FILE MATCHED METHOD BODIES WITH A BRACE COUNTER OVER
 * THE FILE TEXT AND THAT IS THE WRONG INSTRUMENT. The artifact is a valid ES
 * module and node already contains a correct parser for it, so this imports the
 * module and reads `Function.prototype.toString()` off each method. The engine
 * decides where a method begins and ends; this file never does. A brace counter
 * is a second parser that agrees with the first until the day it does not, and
 * the day it does not it emits a document that is confidently wrong.
 *
 * NOTHING IS EXTRACTED FROM AN IDENTIFIER IN THAT TEXT, AND THAT IS A RULE
 * RATHER THAN A HABIT. `Function.prototype.toString()` returns what the loader
 * has, not what the file says: `vitest`'s module runner rewrites namespace
 * imports, so `__compactRuntime.assert(` and `__compactContractsImport_Acct`
 * both come back different there than under `tsx`. Both were read as
 * identifiers once and both produced a generator and a gate that disagreed
 * about the same artifact — once emptying the ASSERTS column, once renaming
 * every cross-contract callee. String literals, property names (`this.witnesses.X`,
 * `this._helper_0`) and punctuation survive every loader; module-scope bindings
 * do not. Where a name is needed, it comes from `compiler/contract-info.json`.
 *
 * AND WHAT KEEPS THAT HONEST IS THAT NOTHING HERE READS A MODULE-SCOPE NAME.
 * A dependence on loader-specific text would show up as a name this scanner
 * cannot find, rather than as a wrong answer it can still produce.
 *
 * WHAT IS STILL SCANNED BY HAND, AND WHY THAT IS AFFORDABLE. Inside one method
 * body the interesting things are argument lists — `queryLedgerState(...)`,
 * `assert(...)`, `crossContractCall(...)`. Those are found by a STRING-AWARE
 * balanced-paren scan, which is a much smaller claim than "I can find a method".
 * String-aware is not decoration: `contracts/managed-vault/contract/index.js`
 * carries the literal
 * `'contract Acct[recordPayment(Bytes<32>, ...): Bytes<32>, retireVault(...)]'`
 * as a type-error message, and a naive paren counter closes on its parens and
 * takes the rest of the method with it.
 *
 * WHAT THIS FILE REFUSES TO GUESS. Three things, each of which would otherwise
 * be a number nobody measured — rule 9:
 *
 *   - THE FIELD-INDEX DESCRIPTOR IS NOT HARDCODED. It is `_descriptor_21` in
 *     the account and `_descriptor_26` in the vault; in the vault
 *     `_descriptor_21` is an `Either`. A generator that hardcoded the account's
 *     number would read the vault's edges off the wrong constant and emit a
 *     plausible table. It is found by its constructor,
 *     `CompactTypeUnsignedInteger(255n, 1)`, and if there is not exactly one
 *     such descriptor this refuses.
 *   - EVERY DECODED FIELD INDEX IS CHECKED against the field table, and the
 *     field table itself is cross-checked between two independent statements of
 *     it — `compiler/contract-info.json`'s `ledger[].index`, which the compiler
 *     wrote, and the `ledger()` accessor functions in `contract/index.js`, which
 *     the compiler also wrote but from a different pass. They agree today. If
 *     they ever disagree this refuses rather than picking one.
 *   - `disclose()` IS NOT IN THE ARTIFACT AT ALL — zero occurrences in either
 *     `index.js`, against 68 real sites in `ConfidentialAccount.compact` and 48
 *     in `Vault.compact`. It is a compile-time marker and the compiler erases
 *     it. So the DISCLOSES column is SOURCE-derived, it is labelled as such
 *     wherever it is rendered, and it is read by `scripts/disclose-scan.ts`
 *     rather than here. What makes that safe rather than sloppy is
 *     `scripts/artifact-freshness.ts`, wired as a `globalSetup` entry: the
 *     suite refuses to run when a `.compact` is newer than the artifact built
 *     from it, so the two columns cannot describe different revisions.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/* ------------------------------------------------------ string-aware scan --- */

/**
 * The index just past the `)` that closes the `(` at `open`, skipping over
 * string literals, template literals and comments. Returns -1 if unbalanced.
 *
 * It handles `'`, `"` and `` ` `` because the generated code uses all three,
 * and `//` and doc comments because a comment containing a bracket is a comment
 * this would otherwise count.
 */
export function spanEnd(text: string, open: number): number {
  const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const close = OPEN[text[open]];
  if (close === undefined) throw new Error(`spanEnd: index ${open} is not an opening bracket`);
  const stack: string[] = [close];
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? text.length : e + 2; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push(OPEN[c]); i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      i += 1;
      if (stack.length === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Every `name(` … `)` argument span in `text`, in source order.
 *
 * THE NEEDLES ARE WRITTEN WITHOUT THE NAMESPACE PREFIX, and that is not
 * cosmetic. The bodies come from `Function.prototype.toString()`, and the text
 * it returns depends on who loaded the module: under `tsx` it is the file on
 * disk, `__compactRuntime.assert(...)`; under `vitest`, whose module runner
 * rewrites a namespace import, the same call comes back through a different
 * identifier. A needle of `__compactRuntime.assert` therefore found every
 * assert in the generator and NONE of them in the test — the same artifact
 * read two ways, with the ASSERTS column silently empty in one of them.
 *
 * Matching `.assert` instead is prefix-agnostic and still anchored: the guard
 * below rejects a match preceded by an identifier character, so `typeAssert(`
 * cannot match. `readContract` additionally refuses a contract from which it
 * extracted no asserts at all, so a future rename cannot empty the column
 * quietly.
 */
export function callSpans(text: string, name: string): { start: number; end: number; args: string }[] {
  const out: { start: number; end: number; args: string }[] = [];
  const needle = name + '(';
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return out;
    // A call, not a longer identifier ending in `name`. A needle that already
    // begins with `.` carries its own anchor — `.assert` cannot be the tail of
    // `typeAssert` — and applying the guard to it would reject every real
    // match, because the character before the dot is the namespace's last
    // letter. That is what the zero-assert refusal below caught.
    const before = at === 0 ? '' : text[at - 1];
    if (!name.startsWith('.') && /[A-Za-z0-9_$]/.test(before)) { from = at + 1; continue; }
    const open = at + needle.length - 1;
    const end = spanEnd(text, open);
    if (end === -1) throw new Error(`callSpans: unbalanced ${name}( at ${at}`);
    out.push({ start: at, end, args: text.slice(open + 1, end - 1) });
    // ADVANCE BY ONE, NOT TO THE END OF THE SPAN. Skipping to `end` finds only
    // the OUTERMOST occurrences, so a call nested inside another of the same
    // name is never returned at all — a dropped edge rather than a wrong one,
    // and dropped edges are the ones nothing disagrees with. Its own test
    // caught this: `q(a, q(b, c), d)` yielded one span, not two.
    from = at + 1;
  }
}

/**
 * The same, but with any span of `name(...)` nested INSIDE another one blanked
 * out of the outer one's text. `contracts/managed-vault/contract/index.js`
 * reads the callee address with a `queryLedgerState` nested inside the argument
 * list of a `crossContractCall`, and one nested inside another
 * `queryLedgerState` would otherwise donate its field index to its parent.
 * Blanking keeps offsets — and therefore any later slicing — honest.
 */
export function callSpansFlat(text: string, name: string): string[] {
  const spans = callSpans(text, name);
  return spans.map((s) => {
    let body = s.args;
    const inner = spans.filter((o) => o.start > s.start && o.end <= s.end);
    for (const o of inner) {
      const rel = o.start - (s.start + name.length + 1);
      if (rel < 0 || rel >= body.length) continue;
      const len = o.end - o.start;
      body = body.slice(0, rel) + ' '.repeat(len) + body.slice(rel + len);
    }
    return body;
  });
}

/** String literals that are DIRECT arguments of a call whose argument text is `args`. */
export function topLevelStrings(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < args.length) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; i += 1; continue; }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < args.length && args[j] !== quote) {
        if (args[j] === '\\') { value += args[j + 1]; j += 2; continue; }
        value += args[j];
        j += 1;
      }
      if (depth === 0) out.push(value);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------- the model --- */

export type LedgerField = {
  readonly name: string;
  /** A bare number at a flat top level; an array once the state has nested. */
  readonly index: number | readonly number[];
  readonly storage: string;
  readonly exported: boolean;
};

export type Use = {
  /** `[]` when the circuit does it itself; otherwise the helper chain that does. */
  readonly via: readonly string[];
};

export type Use2 = Use & { readonly circuit: string };
export type FieldUse = Use & { readonly field: string };
export type AssertUse = Use & { readonly message: string };
export type WitnessUse = Use & { readonly witness: string };
export type CallUse = Use & { readonly contract: string; readonly circuit: string };

export type CircuitModel = {
  readonly name: string;
  /** Circuits of the SAME contract this one calls, directly or through a helper. */
  readonly uses: readonly Use2[];
  readonly pure: boolean;
  readonly signature: string;
  readonly reads: readonly FieldUse[];
  readonly writes: readonly FieldUse[];
  readonly asserts: readonly AssertUse[];
  readonly witnesses: readonly WitnessUse[];
  readonly calls: readonly CallUse[];
  readonly kernel: readonly KernelUse[];
};

/**
 * A verifier key, or the reason there is not one. `null` is not permitted: a
 * blank cell reads as "this circuit has no key", which is a different claim.
 */
export type KeyFact =
  | { readonly measured: true; readonly bytes: number; readonly sha256: string }
  | { readonly measured: false; readonly why: string };

export type ContractModel = {
  readonly label: string;
  /**
   * THE CONSTRUCTOR IS A WRITER AND IT IS NOT A CIRCUIT.
   *
   * `contract-info.json` has no entry for it and its emitted method is
   * `initialState`, which does not match `_<name>_<n>` — so a scan over circuit
   * bodies alone reports that `Vault.account` HAS NO WRITER. It is written, at
   * `contracts/src/Vault.compact:263`, by the constructor, through the exact
   * `{ push: <index> } … { ins: … }` shape `classifyQuery` already recognises.
   *
   * `C286` IS THE ROW THAT SAYS WHY THAT MATTERS. *"What makes our vault
   * unredirectable is only that it declares no circuit that writes `account` —
   * no assert, no guard, no keyword."* An empty `writers` cell in a generated
   * table is that same absence restated by a machine, in the artefact a layout
   * decision is taken from, and a record or `Map` value in Compact is written
   * whole — so merging `account` into a record hands every writer of that
   * record a writer for the contract reference every payout settles against.
   *
   * So it is extracted, and it is kept SEPARATE from the circuits rather than
   * folded in with them: the constructor writes every field once because it
   * initialises them, and a column that mixed that in with the real writers
   * would say all twelve account fields have nine writers and mean nothing.
   */
  readonly ctor: CircuitModel | null;
  readonly source: string;
  readonly artifact: string;
  readonly compilerVersion: string;
  readonly languageVersion: string;
  readonly runtimeVersion: string;
  readonly fields: readonly LedgerField[];
  readonly circuits: readonly CircuitModel[];
  readonly witnessNames: readonly string[];
  readonly keys: ReadonlyMap<string, KeyFact>;
  /** Circuits this contract declares it CALLS on another contract, from `contract-info.json`. */
  readonly declaredCallees: readonly { readonly contract: string; readonly circuit: string }[];
};

/* --------------------------------------------------------- the artifacts --- */

export type ArtifactSpec = {
  readonly label: string;
  /** The `.compact` a person edits. Carried so a refusal can name it. */
  readonly source: string;
  /** Directory holding `contract/` and `compiler/`. */
  readonly managed: string;
};

/**
 * BOTH CONTRACTS, AND THE TABLE IS THE ONLY PLACE EITHER IS NAMED.
 * `scripts/artifact-freshness.ts` learned this the expensive way: a guard that
 * knows about the account alone is a guard the vault walks past.
 */
export const ARTIFACTS: readonly ArtifactSpec[] = [
  {
    label: 'ConfidentialAccount',
    source: 'contracts/src/ConfidentialAccount.compact',
    managed: 'contracts/managed',
  },
  {
    label: 'Vault',
    source: 'contracts/src/Vault.compact',
    managed: 'contracts/managed-vault',
  },
];

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** `Uint<0..255>` — the one-byte cell the runtime addresses a top-level field with. */
export function indexDescriptor(moduleText: string): string {
  const found = [...moduleText.matchAll(/const (_descriptor_\d+) = new __compactRuntime\.CompactTypeUnsignedInteger\(255n, 1\);/g)];
  if (found.length !== 1) {
    throw new Error(
      `artifact-scan: expected exactly ONE Uint<0..255> descriptor to address ledger fields with, found ${found.length}. ` +
        'The field index is decoded through it, so a wrong one is a table of edges that are all subtly misattributed. ' +
        'Nothing was emitted.',
    );
  }
  return found[0][1];
}

/**
 * Field indices as the `ledger()` accessors state them, which is a SECOND
 * statement of what `compiler/contract-info.json` says. Read from the accessor
 * bodies: the first `<indexDescriptor>.toValue(Nn)` in each top-level key.
 */
export function indicesFromLedgerFn(moduleText: string, desc: string): Map<string, number> {
  const at = moduleText.indexOf('export function ledger(');
  if (at === -1) throw new Error('artifact-scan: no `export function ledger(` in the artifact.');
  const bodyOpen = moduleText.indexOf('{', at);
  const body = moduleText.slice(bodyOpen, spanEnd(moduleText, bodyOpen));
  const ret = body.indexOf('return {');
  const obj = body.slice(ret + 'return '.length);
  const objBody = obj.slice(1, spanEnd(obj, 0) - 1);

  const out = new Map<string, number>();
  // Top-level keys of the returned object: `name: {`, `get name()` or `name,`.
  let i = 0;
  let depth = 0;
  let keyStart = 0;
  const escapeRe = new RegExp(desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.toValue\\((\\d+)n\\)');
  while (i < objBody.length) {
    const c = objBody[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i += 1;
      while (i < objBody.length && objBody[i] !== q) i += objBody[i] === '\\' ? 2 : 1;
      i += 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        const head = objBody.slice(keyStart, i);
        const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:?\s*$/.exec(head.replace(/\bget\s+/, ''));
        const end = spanEnd(objBody, i);
        const hit = escapeRe.exec(objBody.slice(i, end));
        if (m && hit) out.set(m[1], Number(hit[1]));
        i = end;
        keyStart = i;
        continue;
      }
      depth += 1; i += 1; continue;
    }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; i += 1; continue; }
    if (c === ',' && depth === 0) { keyStart = i + 1; }
    i += 1;
  }
  return out;
}

/**
 * Verifier keys as they are on disk, or the reason there are none.
 *
 * NOT RENDERED INTO ANY GENERATED DOCUMENT, AND THAT IS THE POINT OF THE
 * `measured` FLAG SURVIVING HERE. What a document may say has to be a function
 * of what this repository contains, and these keys are made by a separate build
 * that most copies of it have never run. So the facts stay available to anything
 * that wants to ask -- a size gate, a deploy check -- and no document quotes
 * them.
 */
function readKeys(root: string, spec: ArtifactSpec, circuitNames: readonly string[]): Map<string, KeyFact> {
  const dir = join(root, spec.managed, 'keys');
  const out = new Map<string, KeyFact>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.verifier'));
  } catch {
    // NOT an error and NOT a blank. An ordinary compile skips the proving
    // backend and leaves no `keys/` at all, which is the state on almost every
    // machine. A number nobody measured is a refusal, so the fact says which
    // measurement was not taken rather than reporting a zero.
    for (const c of circuitNames) {
      out.set(c, { measured: false, why: `${spec.managed}/keys is not on disk` });
    }
    return out;
  }
  for (const c of circuitNames) {
    const file = `${c}.verifier`;
    if (!names.includes(file)) {
      out.set(c, { measured: false, why: `${spec.managed}/keys/${file} is not on disk` });
      continue;
    }
    const bytes = statSync(join(dir, file)).size;
    out.set(c, { measured: true, bytes, sha256: sha256(readFileSync(join(dir, file))) });
  }
  return out;
}

/** `Bytes<32>`, `Uint<0..N>`, `struct X<…>` — as `contract-info.json` states it. */
export function typeText(t: unknown): string {
  if (t === null || t === undefined) return '?';
  const o = t as Record<string, unknown>;
  const n = o['type-name'];
  if (n === 'Bytes') return `Bytes<${String(o.length)}>`;
  if (n === 'Uint') return `Uint<0..${String(o.maxval)}>`;
  if (n === 'Boolean') return 'Boolean';
  if (n === 'Field') return 'Field';
  if (n === 'Vector') return `Vector<${String(o.length)}, ${typeText(o.type)}>`;
  if (n === 'Struct') return `struct ${String(o.name)}`;
  if (n === 'Tuple') return ((o.types as unknown[]) ?? []).length === 0 ? '[]' : `[${((o.types as unknown[]) ?? []).map(typeText).join(', ')}]`;
  if (n === 'Opaque') return `Opaque<${String(o.name)}>`;
  if (n === 'Enum') return `enum ${String(o.name)}`;
  return String(n ?? JSON.stringify(t));
}

/* ------------------------------------------------------------ the reader --- */

type MethodKind = 'circuit' | 'witness' | 'internal';

type Method = {
  readonly name: string;
  readonly kind: MethodKind;
  /** For a witness wrapper, the witness it calls. */
  readonly witness?: string;
  /** For a circuit body, the circuit's name with the `_`/`_N` stripped. */
  readonly circuit?: string;
  readonly text: string;
  readonly callsMethods: readonly string[];
  readonly readsFields: readonly number[];
  readonly writesFields: readonly number[];
  readonly assertMessages: readonly string[];
  readonly crossCalls: readonly { contract: string; circuit: string }[];
  readonly kernelUses: readonly { slot: number | null; kind: 'reads' | 'writes' }[];
};

/**
 * CLASSIFYING `_X_N`, IN THIS ORDER, FIRST MATCH WINNING.
 *
 * The artifact's private methods are four disjoint kinds under one naming
 * convention, and no shape-based rule separates them: `_slotOf_0(path_0)` is a
 * circuit body that takes no context, `_requireSigner_0(context,
 * partialProofData)` has the exact impure-circuit signature and is not a
 * circuit, and `_receiveShielded_0` is stdlib that looks like `_deposit_0`.
 *
 * So the rule is not a shape. A method that calls `this.witnesses.X(` IS the
 * wrapper for `X`; otherwise a method whose name strips to a circuit named by
 * `compiler/contract-info.json` IS that circuit's body; everything else is an
 * internal subroutine or a compiler intrinsic, which this traverses THROUGH but
 * never emits a row for. The two name sets cannot collide — neither contract
 * has a witness and a circuit of the same name — so the first two steps are
 * exclusive rather than merely ordered.
 */
function classify(name: string, text: string, circuitNames: ReadonlySet<string>): { kind: MethodKind; witness?: string; circuit?: string } {
  const w = /this\.witnesses\.([A-Za-z_$][A-Za-z0-9_$]*)\(/.exec(text);
  if (w) return { kind: 'witness', witness: w[1] };
  const bare = /^_(.+)_\d+$/.exec(name)?.[1];
  if (bare && circuitNames.has(bare)) return { kind: 'circuit', circuit: bare };
  return { kind: 'internal' };
}

/**
 * WHICH STATE AN OP ARRAY IS ADDRESSING — AND THIS IS THE ONE THAT NEARLY
 * PRODUCED A FALSE TABLE ABOUT THE MONEY PATH.
 *
 * A `queryLedgerState` op array does NOT always address this contract's ledger.
 * The first op selects the root, and there are two roots:
 *
 *   - THE CONTRACT'S OWN STATE, which is on top of the stack. `{ dup: { n: 0 } }`
 *     to read it; a leading `idx` or a leading push of the FIELD INDEX to write it.
 *   - THE KERNEL CONTEXT, reached by digging past the top of the stack —
 *     `{ dup: { n: 2 } }`, `{ dup: { n: 3 } }` — or by swapping it in,
 *     `{ swap: { n: 0 } }`. Block time, `kernel.self()`, and every Zswap effect
 *     live there.
 *
 * THE SLOT NUMBERS OVERLAP, WHICH IS WHY THIS CANNOT BE LEFT TO A RANGE CHECK.
 * `_sendShielded_0` — reached from `Vault.payout` — writes kernel slots 0, 1
 * and 2 through `{ swap: { n: 0 } }`, and the vault's own fields 0, 1 and 2 are
 * `account`, `notes` and `unshieldedTokens`. A scan that took the first decoded
 * index as a field would report `payout` WRITING the vault's `account` field —
 * the contract reference it settles against — and `SC8` is deciding what to
 * group by writer off exactly this table. In the account contract the same trap
 * is quieter and just as wrong: `_approvalNullifier_0` reads `kernel.self()` at
 * slot 0 and `_blockTimeLt_0` reads block time at slot 2, which would have been
 * read as `signers` and `openProposals`.
 *
 * SO THE SHAPES ARE A WHITELIST AND AN UNKNOWN SHAPE IS A REFUSAL. Four shapes
 * are recognised, every one of them observed in the artifacts on disk. A fifth
 * — a compiler change, a new stdlib operation — stops the generator with the
 * op array printed, rather than being folded into whichever bucket the code
 * happened to fall through to. A classifier with a default branch is a
 * classifier that cannot report that it did not know.
 */
export type QueryKind =
  | { root: 'contract'; kind: 'reads' | 'writes'; index: number }
  | { root: 'kernel'; kind: 'reads' | 'writes'; slot: number | null };

export function classifyQuery(args: string, desc: string): QueryKind {
  const escaped = desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const indexRe = new RegExp(escaped + '\\.toValue\\((\\d+)n\\)');
  const writes = /\{\s*ins\s*:/.test(args);
  const open = args.indexOf('[');
  const flat = args.slice(open + 1).replace(/\s+/g, ' ');

  // The ops, split at the top level of the array, so each is matched whole.
  const ops: string[] = [];
  let i = 0;
  while (i < flat.length) {
    const brace = flat.indexOf('{', i);
    const quote = flat.indexOf("'", i);
    if (brace === -1 && quote === -1) break;
    if (quote !== -1 && (brace === -1 || quote < brace)) {
      const close = flat.indexOf("'", quote + 1);
      ops.push(flat.slice(quote, close + 1));
      i = close + 1;
      continue;
    }
    const end = spanEnd(flat, brace);
    if (end === -1) break;
    ops.push(flat.slice(brace, end));
    i = end;
  }

  /*
   * THE STACK MODEL, WHICH IS WHAT MAKES THIS ARITHMETIC RATHER THAN A GUESS.
   *
   * The array runs against a stack with this contract's state on top. A `push`
   * of a plain VALUE does not change which state is which; it puts one more
   * item above it. So after `p` such pushes the contract's own state is at
   * depth `p`, and `{ dup: { n: p } }` is the op that selects it.
   *
   * Every contract read in both artifacts is `p = 0`, `dup n = 0`. Every kernel
   * access sits two deeper than the contract state at the same `p`: `dup n = 2`
   * with no push (`_blockTimeLt_0`, `_approvalNullifier_0` reading
   * `kernel.self()`), `dup n = 3` after one push (`_unshieldedBalanceGt_0`),
   * and `swap n = 0` for the Zswap effect writes in `_sendShielded_0` and
   * `_sendUnshielded_0`.
   *
   * ONLY `dup n = p` IS CLAIMED AS THIS CONTRACT'S LEDGER. Everything else that
   * digs or swaps is recorded as being outside it, which is the conservative
   * direction: the cost of getting it wrong the other way is a WRITER attributed
   * to a field the circuit never touches, in the table `SC8` reads.
   */
  let pushed = 0;
  for (const op of ops) {
    if (/^\{ push: /.test(op) && !indexRe.test(op)) { pushed += 1; continue; }

    const dug = /^\{ (dup|swap): \{ n: (\d+) \}/.exec(op);
    if (dug) {
      if (dug[1] === 'dup' && Number(dug[2]) === pushed) {
        const hit = indexRe.exec(args);
        if (hit) return { root: 'contract', kind: writes ? 'writes' : 'reads', index: Number(hit[1]) };
        break;
      }
      const slot = indexRe.exec(args);
      return { root: 'kernel', kind: writes ? 'writes' : 'reads', slot: slot ? Number(slot[1]) : null };
    }

    // A leading `idx` into the field, or a push OF THE FIELD INDEX: both are
    // writes to the state already on top, and both carry the index descriptor.
    // The second half of that is load-bearing — `_unshieldedBalanceGt_0` also
    // leads with a push, of an AMOUNT through a different descriptor.
    if ((/^\{ idx: /.test(op) || /^\{ push: /.test(op)) && indexRe.test(op)) {
      const hit = indexRe.exec(op);
      if (hit) return { root: 'contract', kind: writes ? 'writes' : 'reads', index: Number(hit[1]) };
    }
    break;
  }

  throw new Error(
    'artifact-scan: an op array selects its root in a shape this does not recognise, so it is ' +
      'not known whether it addresses the contract ledger or the kernel. Reading it either way ' +
      'would be a guess. Nothing was emitted. The array begins:\n    ' +
      flat.slice(0, 240),
  );
}

/** Kernel state one method touched, named by the intrinsic that touched it. */
export type KernelUse = Use & {
  readonly through: string;
  readonly slot: number | null;
  readonly kind: 'reads' | 'writes';
};

/**
 * The ledger fields and kernel slots one method touches.
 *
 * `ins` DECIDES READ FROM WRITE AND NOT THE ABSENCE OF `idx`, because a map
 * write carries both: it walks into the field and then inserts. Reading that as
 * a read is how a WRITER goes missing from `SC8`'s table, which is the one
 * thing this round was told to get right first.
 */
export function queriesIn(text: string, desc: string, fieldCount: number, where: string): {
  reads: number[];
  writes: number[];
  kernel: { slot: number | null; kind: 'reads' | 'writes' }[];
} {
  const reads: number[] = [];
  const writes: number[] = [];
  const kernel: { slot: number | null; kind: 'reads' | 'writes' }[] = [];
  for (const args of callSpansFlat(text, 'queryLedgerState')) {
    let q: QueryKind;
    try {
      q = classifyQuery(args, desc);
    } catch (e) {
      throw new Error(`${where}: ${String((e as Error).message)}`);
    }
    if (q.root === 'kernel') { kernel.push({ slot: q.slot, kind: q.kind }); continue; }
    if (!Number.isInteger(q.index) || q.index < 0 || q.index >= fieldCount) {
      throw new Error(
        `artifact-scan: ${where} addresses ledger field ${q.index}, and this contract has ${fieldCount} fields. ` +
          'Either the field-index descriptor was decoded wrongly or the state has been reshaped. ' +
          'Nothing was emitted.',
      );
    }
    (q.kind === 'writes' ? writes : reads).push(q.index);
  }
  return { reads, writes, kernel };
}

/** Read both compiled artifacts and both sources into a model of each. */
export async function readContract(root: string, spec: ArtifactSpec): Promise<ContractModel> {
  const infoPath = join(root, spec.managed, 'compiler', 'contract-info.json');
  const artifactPath = join(root, spec.managed, 'contract', 'index.js');
  /*
   * `maxval` IS BIGGER THAN A JAVASCRIPT NUMBER AND `JSON.parse` SILENTLY
   * ROUNDS IT. `contract-info.json` writes `18446744073709551615` and
   * `340282366920938463463374607431768211455`; parsed as numbers they come back
   * as `18446744073709552000` and `3.402823669209385e+38`, and a signature
   * rendered from those is a number no instrument read off anything — rule 9,
   * inside the file that quotes the rule. So the integer literals are turned
   * into strings BEFORE parsing and carried as the exact digits the compiler
   * wrote.
   */
  const infoText = readFileSync(infoPath, 'utf8').replace(/("maxval"\s*:\s*)(\d+)/g, '$1"$2"');
  const info = JSON.parse(infoText) as {
    'compiler-version': string; 'language-version': string; 'runtime-version': string;
    circuits: { name: string; pure: boolean; proof: boolean; arguments?: { name: string; type: unknown }[]; 'result-type'?: unknown }[];
    witnesses: { name: string }[];
    contracts: { name: string; circuits: { name: string }[] }[];
    ledger: { name: string; index: number | number[]; storage: string; exported: boolean }[];
  };

  const moduleText = readFileSync(artifactPath, 'utf8');
  const desc = indexDescriptor(moduleText);

  // TWO INDEPENDENT STATEMENTS OF THE FIELD TABLE, COMPARED. `contract-info.json`
  // is one compiler pass and the `ledger()` accessors are another. They agree
  // today; a generator that read only one would never find out when they stop.
  const declared = new Map(info.ledger.map((f) => [f.name, f.index]));
  const accessors = indicesFromLedgerFn(moduleText, desc);
  const disagreements: string[] = [];
  for (const [name, idx] of declared) {
    const seen = accessors.get(name);
    if (seen === undefined) continue; // a Cell read through a getter with no query
    if (typeof idx !== 'number' || idx !== seen) disagreements.push(`${name}: contract-info says ${JSON.stringify(idx)}, ledger() reads ${seen}`);
  }
  if (disagreements.length > 0) {
    throw new Error(
      `artifact-scan: ${spec.label}'s two statements of the ledger field table disagree:\n  ` +
        disagreements.join('\n  ') +
        '\nEvery edge is decoded through this table, so nothing was emitted.',
    );
  }

  const circuitNames = new Set(info.circuits.map((c) => c.name));
  const mod = (await import(artifactPath)) as { Contract: { prototype: Record<string, unknown> } };
  const proto = mod.Contract.prototype;

  const methods = new Map<string, Method>();
  // `initialState` IS INCLUDED DELIBERATELY. It is the constructor's emitted
  // body and it does not match `_<name>_<n>`; leaving it out is how the
  // constructor's writes went missing.
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (!/^_.+_\d+$/.test(name) && name !== 'initialState') continue;
    const fn = proto[name];
    if (typeof fn !== 'function') continue;
    const text = (fn as { toString(): string }).toString();
    const k = name === 'initialState' ? { kind: 'circuit' as MethodKind, circuit: 'constructor' } : classify(name, text, circuitNames);
    const { reads, writes, kernel } = queriesIn(text, desc, info.ledger.length, `${spec.label}.${name}`);
    const crossCalls = callSpansFlat(text, 'crossContractCall').map((args) => {
      /*
       * THE CALLEE'S CIRCUIT COMES FROM A STRING LITERAL AND ITS CONTRACT COMES
       * FROM `contract-info.json` — NEITHER FROM AN IDENTIFIER IN THIS TEXT.
       *
       * The first version read the contract's name out of the
       * `__compactContractsImport_Acct` argument, and that identifier does not
       * survive every module loader: under `tsx` it is the text on disk, under
       * `vitest`, whose runner rewrites a namespace import, it is something
       * else. One loader produced `Acct.recordPayment` and the other
       * `UNKNOWN.recordPayment` — the same artifact, two answers, and no way
       * to make either of them right.
       * The same fault in the assert needle emptied a whole column earlier in
       * this round.
       *
       * SO THE RULE, AND IT IS WHY THIS COMMENT IS LONG: nothing is extracted
       * from an IDENTIFIER in `toString()` text. String literals, property
       * names and punctuation survive every loader; a module-scope binding does
       * not. `contract-info.json`'s `contracts[]` carries the declaration —
       * `contract Acct { recordPayment, retireVault }` — as data.
       */
      const circuit = topLevelStrings(args)[0] ?? '';
      const declaring = (info.contracts ?? []).find((k) => k.circuits.some((c) => c.name === circuit));
      if (circuit === '' || !declaring) {
        throw new Error(
          `artifact-scan: ${spec.label}.${name} makes a cross-contract call to "${circuit || '(no circuit name found)'}" and ` +
            "compiler/contract-info.json declares no contract with that circuit. The callee cannot be named from data, and " +
            'naming it from an identifier in the emitted text is what made this read differently under two module loaders. Nothing was emitted.',
        );
      }
      return { contract: declaring.name, circuit };
    });
    methods.set(name, {
      name,
      kind: k.kind,
      witness: k.witness,
      circuit: k.circuit,
      text,
      callsMethods: [...new Set([...text.matchAll(/this\._([A-Za-z0-9_$]+_\d+)\(/g)].map((m) => '_' + m[1]))],
      readsFields: reads,
      writesFields: writes,
      assertMessages: callSpansFlat(text, '.assert').map((a) => topLevelStrings(a).at(-1) ?? '').filter((s) => s.length > 0),
      crossCalls,
      kernelUses: kernel,
    });
  }

  const fields = info.ledger.map((f) => ({ name: f.name, index: f.index, storage: f.storage, exported: f.exported }));
  const byIndex = new Map<number, string>(fields.filter((f) => typeof f.index === 'number').map((f) => [f.index as number, f.name]));

  /**
   * THE CLOSURE, AND IT IS NOT OPTIONAL. Not one of the account's ten provable
   * circuits reads `localSecretKey` itself: all three signer witnesses and a
   * `signerPath` are read inside `_requireSigner_0`, which seven circuits call,
   * and `signerPath` is reached again through `_takeVacatedSlot_0` from
   * `_amendSigner_0`. A direct-only scan reports that no circuit on this
   * contract checks who is calling it.
   *
   * `via` is carried rather than flattened because "approve writes `approvals`"
   * and "approve writes `approvals` through `closeProposal`" are different
   * facts to `SC8`, which is deciding what to group by WRITER.
   */
  const walk = (start: string) => {
    const reads: FieldUse[] = [];
    const writes: FieldUse[] = [];
    const asserts: AssertUse[] = [];
    const witnesses: WitnessUse[] = [];
    const calls: CallUse[] = [];
    const kernel: KernelUse[] = [];
    const uses: Use2[] = [];
    const seen = new Set<string>();
    const step = (name: string, via: string[]) => {
      if (seen.has(name)) return;
      seen.add(name);
      const m = methods.get(name);
      if (!m) return;
      if (m.kind === 'witness' && m.witness) witnesses.push({ witness: m.witness, via });
      for (const n of m.readsFields) reads.push({ field: byIndex.get(n) ?? `#${n}`, via });
      for (const n of m.writesFields) writes.push({ field: byIndex.get(n) ?? `#${n}`, via });
      for (const msg of m.assertMessages) asserts.push({ message: msg, via });
      for (const c of m.crossCalls) calls.push({ ...c, via });
      for (const k of m.kernelUses) kernel.push({ ...k, through: name, via });
      for (const next of m.callsMethods) {
        const target = methods.get(next);
        // A CIRCUIT CALLING A CIRCUIT IS AN EDGE IN ITS OWN RIGHT, not merely a
        // route to a ledger field. `Vault.payout` calls `payoutDetails`,
        // `heldCommitmentOf` and `noteBlindingOf`; `recordPayment` calls
        // `proposalIdOf`, `runPayload`, `payoutLeaf` and `paidMovementOf`.
        // Every one of those is pure and touches no field, so a graph built only
        // out of ledger access answers "nothing depends on payoutLeaf" — which
        // is the same answer as "safe to change".
        if (target && target.kind === 'circuit' && target.circuit && target.circuit !== info.circuits.find((c) => `_${c.name}_0` === start)?.name) {
          uses.push({ circuit: target.circuit, via });
        }
        step(next, [...via, next]);
      }
    };
    step(start, []);
    return { reads, writes, asserts, witnesses, calls, kernel, uses };
  };

  const dedupe = <T extends Use>(xs: T[], key: (x: T) => string): T[] => {
    const best = new Map<string, T>();
    for (const x of xs) {
      const k = key(x);
      const have = best.get(k);
      if (!have || x.via.length < have.via.length) best.set(k, x);
    }
    return [...best.values()];
  };

  const build = (name: string, body: string, pure: boolean, signature: string): CircuitModel => {
    const w = walk(body);
    return {
      name,
      pure,
      signature,
      reads: dedupe(w.reads, (x) => x.field).sort((a, b) => a.field.localeCompare(b.field)),
      writes: dedupe(w.writes, (x) => x.field).sort((a, b) => a.field.localeCompare(b.field)),
      asserts: dedupe(w.asserts, (x) => x.message),
      witnesses: dedupe(w.witnesses, (x) => x.witness).sort((a, b) => a.witness.localeCompare(b.witness)),
      calls: dedupe(w.calls, (x) => `${x.contract}.${x.circuit}`),
      kernel: dedupe(w.kernel, (x) => `${x.through}:${String(x.slot)}:${x.kind}`),
      uses: dedupe(w.uses, (x) => x.circuit).sort((a, b) => a.circuit.localeCompare(b.circuit)),
    };
  };

  const circuits0: CircuitModel[] = info.circuits.map((c) => {
    const body = `_${c.name}_0`;
    const w = walk(body);
    const args = (c.arguments ?? []).map((a) => `${a.name}: ${typeText(a.type)}`).join(', ');
    return {
      name: c.name,
      pure: c.pure,
      signature: `${c.name}(${args}): ${typeText(c['result-type'])}`,
      reads: dedupe(w.reads, (x) => x.field).sort((a, b) => a.field.localeCompare(b.field)),
      writes: dedupe(w.writes, (x) => x.field).sort((a, b) => a.field.localeCompare(b.field)),
      asserts: dedupe(w.asserts, (x) => x.message),
      witnesses: dedupe(w.witnesses, (x) => x.witness).sort((a, b) => a.witness.localeCompare(b.witness)),
      calls: dedupe(w.calls, (x) => `${x.contract}.${x.circuit}`),
      kernel: dedupe(w.kernel, (x) => `${x.through}:${String(x.slot)}:${x.kind}`),
      uses: dedupe(w.uses, (x) => x.circuit).sort((a, b) => a.circuit.localeCompare(b.circuit)),
    };
  });

  const ctorArgs = (() => {
    /*
     * THE CONSTRUCTOR'S SIGNATURE COMES OUT OF ITS OWN TYPE CHECKS.
     *
     * `contract-info.json` has NO constructor entry, so the source of truth
     * every circuit signature uses is silent here. The emitted body is
     * `initialState(...args_0)` with the arguments destructured, so the
     * parameter list is not in the function head either.
     *
     * What IS in the artifact is a `typeError` call per argument, carrying the
     * argument's name and its Compact type as the compiler wrote them:
     *   typeError('Contract state constructor', 'argument 1 (…)',
     *             'ConfidentialAccount.compact line NNN char 1',
     *             'Bytes<32>', foundingLeaf_0)
     * The worked example named `requiredApprovals_0` and a line number until
     * `S35d`; the argument is gone (`C340` + `C343`) and the line was three
     * hundred out besides. It carries no number now — an illustration
     * does not need one and this file has no way to keep one true.
     * That is read here rather than invented. If a compiler stops emitting
     * them the signature comes back empty — which is visibly missing rather
     * than quietly wrong.
     */
    const text = typeof proto.initialState === 'function' ? (proto.initialState as { toString(): string }).toString() : '';
    const args: string[] = [];
    for (const m of text.matchAll(/typeError\(\s*'Contract state constructor',\s*'argument \d+[^']*',\s*'[^']*',\s*'([^']*)',\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g)) {
      args.push(`${m[2].replace(/_\d+$/, '')}: ${m[1]}`);
    }
    return args.join(', ');
  })();

  /*
   * A CONTRACT FROM WHICH NO ASSERT WAS EXTRACTED IS AN EXTRACTION FAILURE, not
   * a contract without guards. Both contracts here carry dozens; the ASSERTS
   * column is the one the brief calls a MEASUREMENT rather than a list, because
   * a money circuit with a low count beside a sibling with a higher one is a
   * question worth asking on sight — and a column that silently read zero
   * everywhere would answer that question wrongly and confidently.
   */
  const totalAsserts = circuits0.reduce((n, c) => n + c.asserts.length, 0);
  if (totalAsserts === 0) {
    throw new Error(
      `artifact-scan: ${spec.label} yielded ZERO asserts across ${circuits0.length} circuits. ` +
        'A contract with no guards at all is not what this is; the assert extraction has stopped matching. Nothing was emitted.',
    );
  }

  /*
   * A CONTRACT FROM WHICH NO FIELD ACCESS WAS EXTRACTED IS AN EXTRACTION
   * FAILURE TOO, and this guard exists because the ONE remaining place this
   * file reads an identifier out of `toString()` text fails in that direction.
   *
   * `desc` — `_descriptor_21` on the account, `_descriptor_26` on the vault —
   * is a module-scope binding name, read from the file on disk and then matched
   * against method text. It is safe today, and proven so: the render is
   * byte-identical under `tsx` and under vitest's module runner. But if a loader
   * ever rewrote it, `indexRe` would stop matching, `classifyQuery`'s push
   * counter would miscount, and every contract read would classify as a KERNEL
   * access — leaving the READS and WRITES columns EMPTY rather than throwing.
   * That is the same silent shape the assert guard below was written for, and
   * it had no equivalent until an auditor traced it.
   */
  const totalFields = circuits0.reduce((n, c) => n + c.reads.length + c.writes.length, 0);
  if (totalFields === 0) {
    throw new Error(
      `artifact-scan: ${spec.label} yielded ZERO ledger reads and writes across ${circuits0.length} circuits. ` +
        'A contract that touches no state is not what this is; the field-index descriptor has stopped matching. Nothing was emitted.',
    );
  }

  return {
    label: spec.label,
    source: spec.source,
    artifact: `${spec.managed}/contract/index.js`,
    compilerVersion: info['compiler-version'],
    languageVersion: info['language-version'],
    runtimeVersion: info['runtime-version'],
    fields,
    circuits: circuits0,
    witnessNames: info.witnesses.map((w) => w.name),
    ctor: typeof proto.initialState === 'function' ? build('constructor', 'initialState', false, `constructor(${ctorArgs})`) : null,
    keys: readKeys(root, spec, info.circuits.filter((c) => !c.pure).map((c) => c.name)),
    declaredCallees: (info.contracts ?? []).flatMap((k) => k.circuits.map((c) => ({ contract: k.name, circuit: c.name }))),
  };
}
