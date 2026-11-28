/**
 * `disclose()` IS THE ONE COLUMN THE ARTIFACT CANNOT ANSWER, AND SAYING SO IS
 * PART OF THE COLUMN.
 *
 * `contracts/managed/contract/index.js` and
 * `contracts/managed-vault/contract/index.js` contain ZERO occurrences of
 * `disclose`, against 68 real call sites in `ConfidentialAccount.compact` and 48
 * in `Vault.compact`. It is a compile-time marker for the witness-disclosure
 * checker and the compiler erases it. So this reads the `.compact` SOURCE, and
 * every rendering of the column says that is where it came from.
 *
 * WHAT MAKES THAT SAFE RATHER THAN A HOLE IN THE RULE. Every rendering of the
 * column names the `.compact` source it was read from, so a reader checking a
 * figure opens the file it came from rather than a copy of it. Source-derived
 * and stale-derived are different things, and only the second one is dangerous.
 *
 * FOUR THINGS THAT LOOK LIKE DETAIL AND ARE NOT. Each was measured against the
 * two files rather than assumed:
 *
 *   1. `grep -c disclose` IS WRONG IN BOTH DIRECTIONS: it counts comment prose
 *      as sites, and one line can carry several sites. A column that counts
 *      lines is a measurement of the wrong thing.
 *   2. THE WORST FALSE MATCH IS A CODE EXAMPLE INSIDE A COMMENT: a comment
 *      that writes `x = disclose(f(...))` for an `f` that does not exist makes a
 *      regex over raw text emit a disclosure of a value that is not in the
 *      contract. So
 *      comments are stripped BEFORE anything else, and stripped for the brace
 *      counting too, not only for the matching.
 *   3. `constructor` IS NOT THE KEYWORD `circuit`, and real sites live in
 *      both contracts' constructors. A scan for `circuit NAME(` alone silently
 *      drops them.
 *   4. `Vault.compact` HOLDS A `contract Acct { … }` INTERFACE BLOCK whose
 *      `circuit recordPayment(...)` and `circuit retireVault(...)` are
 *      declarations terminated by `;` WITH NO BODY. A scan that treats them as
 *      bodies invents two circuits, mis-anchors every range after them, and —
 *      because both names collide with real exported circuits in the OTHER
 *      file — merges them into those circuits' rows in any name-keyed index.
 *
 * AND THE CLOSURE, WHICH IS DEPTH ONE AND MUST STILL BE DONE. `requireSigner`
 * discloses the signer merkle root, and exported circuits call it. A DISCLOSES column for `approve`
 * that omits it is not shorter, it is wrong: it says the circuit reveals nothing
 * when it reveals the root of the signer tree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, contractSources } from './contract-sources.mjs';

export type DiscloseSite = {
  /** The file the site was read from, when the scan read a contract's files (`scanSourceFile`). */
  readonly file?: string;
  readonly line: number;
  /** The disclosed expression, as written, whitespace collapsed. */
  readonly text: string;
  /** `[]` when the circuit discloses it itself, else the helper chain. */
  readonly via: readonly string[];
};

export type SourceCircuit = {
  readonly name: string;
  readonly exported: boolean;
  readonly line: number;
  readonly discloses: readonly DiscloseSite[];
  /** Named bodies this one calls, used to inherit their disclosures. */
  readonly calls: readonly string[];
};

/**
 * Comments and string literals blanked to spaces of the same length, so every
 * offset and every line number in the result still points at the real file.
 */
export function blankNonCode(src: string): string {
  return blank(src, true);
}

/** The index just past the `}` closing the `{` at `open`, over code with comments blanked. */
function braceEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const lineOf = (code: string, at: number): number => code.slice(0, at).split('\n').length;

/**
 * Every named body in a `.compact` file, with the disclose sites inside it.
 *
 * A body is `circuit NAME(...) ... { … }`, `export circuit NAME(...) ... { … }`
 * or `constructor(...) { … }`. A `circuit` declaration whose parameter list is
 * followed by a `;` rather than a `{` is an interface member and has no body —
 * that is trap 4 in this file's header, and it is skipped here rather than
 * anywhere downstream.
 */
export function scanSource(text: string): SourceCircuit[] {
  return link([{ text }]);
}

type Body = { name: string; exported: boolean; line: number; from: number; to: number; file: number };

/** Every named body and disclose site across the given files, a helper's sites reaching every circuit that calls it, in any file. */
function link(files: readonly { readonly text: string; readonly file?: string }[]): SourceCircuit[] {
  const codes = files.map((f) => blankNonCode(f.text));
  const bodies: Body[] = [];
  codes.forEach((code, file) => bodies.push(...bodiesOf(code, file)));

  // Innermost wins, so a nested body's sites are not also its parent's.
  const owner = (file: number, at: number) =>
    bodies.filter((b) => b.file === file && at >= b.from && at < b.to).sort((a, b) => b.from - a.from)[0];

  const own = new Map<string, DiscloseSite[]>();
  const calls = new Map<string, Set<string>>();
  for (const b of bodies) {
    own.set(b.name, []);
    calls.set(b.name, new Set());
  }

  const names = new Set(bodies.map((b) => b.name));
  for (const b of bodies) {
    const source = codes[b.file];
    if (source === undefined) continue;
    const body = source.slice(b.from, b.to);
    for (const c of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const callee = c[1];
      if (callee !== undefined && names.has(callee) && callee !== b.name) calls.get(b.name)?.add(callee);
    }
  }

  codes.forEach((code, file) => {
    const entry = files[file];
    if (entry === undefined) return;
    const text = entry.text;
    for (const hit of code.matchAll(/\bdisclose\s*\(/g)) {
      const at = hit.index ?? 0;
      const b = owner(file, at);
      if (!b) continue;
      const openParen = at + hit[0].length - 1;
      let d = 0;
      let end = openParen;
      for (let i = openParen; i < code.length; i += 1) {
        if (code[i] === '(') d += 1;
        else if (code[i] === ')') {
          d -= 1;
          if (d === 0) {
            end = i;
            break;
          }
        }
      }
      const where = entry.file;
      own.get(b.name)?.push({
        ...(where === undefined ? {} : { file: where }),
        line: lineOf(code, at),
        text: text
          .slice(openParen + 1, end)
          .replace(/\s+/g, ' ')
          .trim(),
        via: []
      });
    }
  });

  return bodies.map((b) => {
    const seen = new Set<string>([b.name]);
    const out = [...(own.get(b.name) ?? [])];
    const step = (name: string, via: string[]) => {
      for (const next of calls.get(name) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        for (const s of own.get(next) ?? []) out.push({ ...s, via: [...via, next] });
        step(next, [...via, next]);
      }
    };
    step(b.name, []);
    return { name: b.name, exported: b.exported, line: b.line, discloses: out, calls: [...(calls.get(b.name) ?? [])] };
  });
}

/** The named bodies in one file's blanked code. */
function bodiesOf(code: string, file: number): Body[] {
  const bodies: Body[] = [];

  const decl = /(export\s+)?\b(circuit|constructor)\b\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code)) !== null) {
    const name = m[2] === 'constructor' ? 'constructor' : (m[3] ?? '');
    if (name === '') continue;
    const parenAt = m.index + m[0].length - 1;
    const parenEnd = (() => {
      let d = 0;
      for (let i = parenAt; i < code.length; i += 1) {
        if (code[i] === '(') d += 1;
        else if (code[i] === ')') {
          d -= 1;
          if (d === 0) return i + 1;
        }
      }
      return -1;
    })();
    if (parenEnd === -1) continue;
    // Between the `)` and the body: a return type, or a `;` if there is no body.
    const after = code.slice(parenEnd);
    const brace = after.indexOf('{');
    const semi = after.indexOf(';');
    if (brace === -1 || (semi !== -1 && semi < brace)) continue; // interface member
    const open = parenEnd + brace;
    const close = braceEnd(code, open);
    if (close === -1) continue;
    bodies.push({ name, exported: m[1] !== undefined, line: lineOf(code, m.index), from: open, to: close, file });
    decl.lastIndex = close;
  }
  return bodies;
}

/** A contract read whole: its main file and every file it brings in (`scripts/contract-sources.mjs`), each site naming its file. */
export function scanSourceFile(root: string, rel: string): SourceCircuit[] {
  return link(
    contractSources(root, rel).map((file: string) => ({ file, text: readFileSync(join(root, file), 'utf8') }))
  );
}
