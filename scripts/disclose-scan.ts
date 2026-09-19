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
 * (It used to say the gate hashed these sources into a digest. It did, and
 * `T-167` deleted the digest: a list of inputs was a proxy that was wrong three
 * times in one round.)
 *
 * FOUR THINGS THAT LOOK LIKE DETAIL AND ARE NOT. Each was measured against the
 * two files rather than assumed:
 *
 *   1. `grep -c disclose` IS WRONG IN BOTH DIRECTIONS. It counts 76 lines in
 *      `ConfidentialAccount.compact` where there are 68 sites: 19 of the matches
 *      are comment prose, and two lines carry FOUR sites each (`:1782`, `:2071`).
 *      A column that counts lines is a measurement of the wrong thing.
 *   2. THE WORST FALSE MATCH IS A FABRICATED CODE EXAMPLE INSIDE A COMMENT —
 *      `ConfidentialAccount.compact:1290` writes
 *      `stateCommitment = disclose(stateCommitmentOf(...))`, and
 *      `stateCommitmentOf` does not exist anywhere in the file. A regex over raw
 *      text emits a disclosure of a value that is not in the contract. So
 *      comments are stripped BEFORE anything else, and stripped for the brace
 *      counting too, not only for the matching.
 *   3. `constructor` IS NOT THE KEYWORD `circuit`, and two real sites live in
 *      one — `:1590` in the account and `:263` in the vault. It was four until
 *      `S35d`; the account's constructor lost both of its threshold argument's
 *      disclosures with the argument. A scan for `circuit NAME(` alone silently
 *      drops the rest.
 *   4. `Vault.compact:88-126` IS A `contract Acct { … }` INTERFACE BLOCK whose
 *      `circuit recordPayment(...)` and `circuit retireVault(...)` are
 *      declarations terminated by `;` WITH NO BODY. A scan that treats them as
 *      bodies invents two circuits, mis-anchors every range after them, and —
 *      because both names collide with real exported circuits in the OTHER
 *      file — merges them into those circuits' rows in any name-keyed index.
 *
 * AND THE CLOSURE, WHICH IS DEPTH ONE AND MUST STILL BE DONE. `requireSigner`
 * (`ConfidentialAccount.compact:1251-1272`) discloses the signer merkle root at
 * `:1270`, and seven exported circuits call it. A DISCLOSES column for `approve`
 * that omits it is not shorter, it is wrong: it says the circuit reveals nothing
 * when it reveals the root of the signer tree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DiscloseSite = {
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
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? src.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e === -1 ? src.length : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
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
  const code = blankNonCode(text);
  const bodies: { name: string; exported: boolean; line: number; from: number; to: number }[] = [];

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
        else if (code[i] === ')') { d -= 1; if (d === 0) return i + 1; }
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
    bodies.push({ name, exported: m[1] !== undefined, line: lineOf(code, m.index), from: open, to: close });
    decl.lastIndex = close;
  }

  // Innermost wins, so a nested body's sites are not also its parent's.
  const owner = (at: number) =>
    bodies
      .filter((b) => at >= b.from && at < b.to)
      .sort((a, b) => b.from - a.from)[0];

  const own = new Map<string, DiscloseSite[]>();
  const calls = new Map<string, Set<string>>();
  for (const b of bodies) {
    own.set(b.name, []);
    calls.set(b.name, new Set());
  }

  const names = new Set(bodies.map((b) => b.name));
  for (const b of bodies) {
    const body = code.slice(b.from, b.to);
    for (const c of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (names.has(c[1]) && c[1] !== b.name) calls.get(b.name)?.add(c[1]);
    }
  }

  for (const hit of code.matchAll(/\bdisclose\s*\(/g)) {
    const at = hit.index ?? 0;
    const b = owner(at);
    if (!b) continue;
    const openParen = at + hit[0].length - 1;
    let d = 0;
    let end = openParen;
    for (let i = openParen; i < code.length; i += 1) {
      if (code[i] === '(') d += 1;
      else if (code[i] === ')') { d -= 1; if (d === 0) { end = i; break; } }
    }
    own.get(b.name)?.push({
      line: lineOf(code, at),
      text: text.slice(openParen + 1, end).replace(/\s+/g, ' ').trim(),
      via: [],
    });
  }

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

export function scanSourceFile(root: string, rel: string): SourceCircuit[] {
  return scanSource(readFileSync(join(root, rel), 'utf8'));
}
