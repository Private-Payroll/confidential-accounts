/**
 * THE FAILURE REPORT, BOUNDED. `C217`, `R1c` item 2.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────────
 *
 * On 28 Aug `DEPLOY-PREVIEW.command` produced a `REPORT-DEPLOY.txt` of
 * **3,043,525,639 bytes in about three minutes** — roughly 35 MB/s. The
 * READABLE report inside it was **8.9 KB**. Everything else was indentation.
 *
 * The old serialiser was `JSON.stringify(e, replacer, 2)` with a `WeakSet`
 * cycle guard, and the guard could not fire. Its replacer turned every `Error`
 * into a FRESH plain object before the `seen.add(v)` line was ever reached, so
 * an `Error` was never added to the set and a `cause` chain that comes back to
 * an error already printed recursed without bound. An Effect `FiberFailure`
 * nests the same `SubmissionError` inside itself; each level re-printed the
 * node's two lines two spaces further right, and the INDENT is what filled the
 * disk.
 *
 * A cycle guard stops CYCLES. It does not stop DEPTH, it does not stop WIDTH,
 * and it does not stop the same message being written seventeen times.
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────
 *
 * Four independent bounds, and a footer that says which of them fired and what
 * it cost. **A report that silently drops evidence is worse than a large one**,
 * so nothing is dropped quietly: every cap prints its own count.
 *
 *   DEPTH      `maxDepth` levels. Deeper nodes become one sentinel string.
 *   BYTES      `maxBytes` on the FINAL RENDERED TEXT, after indentation. The
 *              cap has to be applied where the bytes actually were.
 *   WIDTH      `maxArray` entries per array, `maxString` characters per string.
 *   REPEATS    an error whose `name: message` has already been printed is not
 *              printed again; it becomes one line carrying its occurrence
 *              number, and the footer carries the totals.
 *
 * And the cycle guard is fixed: `seen` now takes EVERY object, `Error`
 * instances first, before anything is derived from them.
 *
 * ── DE-DUPLICATION IS AN EVIDENCE DECISION, NOT A TIDYING ONE ────────────────
 *
 * The node's rejection line appeared seventeen times in the first 8 KB of that
 * report and uncountably after. **One occurrence plus a count is the same
 * information and is readable**, and `R1b` — "the node's error IN FULL,
 * unabridged and unparaphrased" — is satisfied by it: nothing is paraphrased
 * and no distinct line is dropped. What is dropped is the seventeenth copy of
 * a line already printed whole, and the report says it dropped sixteen.
 *
 * ── WHY THIS IS A MODULE AND NOT A FUNCTION IN THE SCRIPT ────────────────────
 *
 * `scripts/deploy-preview.ts` runs `main()` on import, so nothing in it can be
 * tested without deploying. `R1b` FORCED the failure path and missed this
 * defect anyway, because it forced it with a bare string throw — a shape with
 * no nesting at all. **A guard proved against the easy shape is not proved.**
 * `scripts/error-report.test.ts` forces the SDK shape: an `Error` whose
 * `cause` chain is deep and self-referential.
 */

export type SerialiseLimits = {
  /** Levels of nesting kept. Deeper becomes one sentinel string. */
  maxDepth: number;
  /** Hard cap on the FINAL rendered text, indentation included. */
  maxBytes: number;
  /** Entries kept per array. */
  maxArray: number;
  /** Characters kept per string. */
  maxString: number;
};

/**
 * 6 levels, 256 KB, 20 entries, 4000 characters.
 *
 * 256 KB is about thirty times the readable report that run produced and about
 * twelve thousand times smaller than what it wrote. It is chosen to be
 * generous against any error a person would read and still bounded against one
 * no person can.
 */
export const DEFAULT_LIMITS: SerialiseLimits = {
  maxDepth: 6,
  maxBytes: 256 * 1024,
  maxArray: 20,
  maxString: 4000,
};

export type Dropped = {
  /** Nodes replaced because they were deeper than `maxDepth`. */
  depth: number;
  /** Nodes replaced because the same object had already been printed. */
  circular: number;
  /** Errors replaced because the same `name: message` had already been printed. */
  repeats: number;
  /** Array entries not printed. */
  arrayEntries: number;
  /** Characters cut from over-long strings. */
  stringChars: number;
  /** Bytes cut from the end of the rendered text, after indentation. */
  bytes: number;
  /** Every collapsed message, with how many times it occurred in total. */
  messages: Array<{ message: string; occurrences: number }>;
};

export type SerialiseResult = { text: string; dropped: Dropped };

const SENTINEL_DEPTH = (n: number) => `[depth cap: ${n} levels reached, nothing below this was printed]`;
const SENTINEL_CIRCULAR = '[circular: this object was already printed above]';
const SENTINEL_REPEAT = (msg: string, n: number) =>
  `[occurrence ${n} of an error already printed above: ${msg}]`;

/**
 * Everything an error is carrying, bounded, with the bounds declared.
 *
 * Returns the text AND the counts, so a caller can print a footer that names
 * exactly what was dropped rather than leaving a reader to wonder whether the
 * evidence was complete.
 */
export function serialiseWholeDetailed(e: unknown, limits: SerialiseLimits = DEFAULT_LIMITS): SerialiseResult {
  const dropped: Dropped = {
    depth: 0, circular: 0, repeats: 0, arrayEntries: 0, stringChars: 0, bytes: 0, messages: [],
  };
  /* EVERY object goes in here, Errors included. The old guard added plain
   * objects only, which is precisely why a self-referential `cause` chain of
   * Errors ran away. */
  const seen = new WeakSet<object>();
  /* `name: message` to how many times it has been seen. The first occurrence
   * is printed whole; later ones become one line each. */
  const messageCounts = new Map<string, number>();

  const cap = (s: string): string => {
    if (s.length <= limits.maxString) return s;
    dropped.stringChars += s.length - limits.maxString;
    return `${s.slice(0, limits.maxString)}…[${s.length - limits.maxString} more characters]`;
  };

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'string') return cap(v);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'function') return `[function ${(v as { name?: string }).name || 'anonymous'}]`;
    if (typeof v === 'symbol') return String(v);
    if (typeof v !== 'object') return String(v);

    const obj = v as object;
    if (seen.has(obj)) { dropped.circular += 1; return SENTINEL_CIRCULAR; }
    if (depth >= limits.maxDepth) { dropped.depth += 1; return SENTINEL_DEPTH(limits.maxDepth); }
    seen.add(obj);

    if (v instanceof Error) {
      const key = `${v.name}: ${v.message}`;
      const n = (messageCounts.get(key) ?? 0) + 1;
      messageCounts.set(key, n);
      if (n > 1) { dropped.repeats += 1; return SENTINEL_REPEAT(cap(key), n); }
      const own: Record<string, unknown> = { name: v.name, message: cap(String(v.message)) };
      /* `stack` stays out, as it did before: it is printed separately and in
       * full by the caller, and duplicating it here doubled the report. */
      for (const k of Object.getOwnPropertyNames(v)) {
        if (k === 'stack' || k === 'name' || k === 'message') continue;
        own[k] = walk((v as unknown as Record<string, unknown>)[k], depth + 1);
      }
      return own;
    }

    if (Array.isArray(v)) {
      const keep = v.slice(0, limits.maxArray).map((x) => walk(x, depth + 1));
      if (v.length > limits.maxArray) {
        dropped.arrayEntries += v.length - limits.maxArray;
        keep.push(`[${v.length - limits.maxArray} more entries not printed]`);
      }
      return keep;
    }

    if (v instanceof Map) return walk(Object.fromEntries(v as Map<unknown, unknown>) as unknown, depth);
    if (v instanceof Set) return walk([...(v as Set<unknown>)], depth);

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth + 1);
    return out;
  };

  let text: string;
  try {
    text = JSON.stringify(walk(e, 0), null, 2) ?? String(e);
  } catch (err: unknown) {
    text = `(could not serialise the error object: ${String((err as { message?: string })?.message ?? err)})`;
  }

  /* THE LAST CAP IS ON THE RENDERED TEXT, AND IT IS THE ONE THAT MATTERS.
   * The 3.04 GB was indentation — bytes that do not exist until the tree is
   * printed. A cap applied only while building the tree would not have seen
   * them. */
  if (text.length > limits.maxBytes) {
    dropped.bytes = text.length - limits.maxBytes;
    text = `${text.slice(0, limits.maxBytes)}\n[byte cap: ${dropped.bytes} more bytes were not printed]`;
  }

  for (const [message, occurrences] of messageCounts) {
    if (occurrences > 1) dropped.messages.push({ message, occurrences });
  }
  dropped.messages.sort((a, b) => b.occurrences - a.occurrences);

  return { text, dropped };
}

/**
 * The line a reader needs in order to trust the report above it.
 *
 * Always returned, even when nothing was dropped — "nothing was dropped" is
 * itself the fact that makes the rest of the report evidence.
 */
export function describeDropped(d: Dropped): string[] {
  const bits: string[] = [];
  if (d.depth) bits.push(`${d.depth} node(s) deeper than the depth cap`);
  if (d.circular) bits.push(`${d.circular} object(s) already printed above`);
  if (d.repeats) bits.push(`${d.repeats} repeat(s) of an error already printed`);
  if (d.arrayEntries) bits.push(`${d.arrayEntries} array entr(ies)`);
  if (d.stringChars) bits.push(`${d.stringChars} character(s) from over-long strings`);
  if (d.bytes) bits.push(`${d.bytes} byte(s) past the size cap`);

  const lines: string[] = [];
  lines.push(bits.length ? `What was dropped: ${bits.join(', ')}.` : 'Nothing was dropped: the object above is complete.');
  for (const m of d.messages) {
    lines.push(`  the same error occurred ${m.occurrences} times and is printed once: ${m.message}`);
  }
  return lines;
}

/** The whole thing as one block: the object, then what was dropped from it. */
export function serialiseWhole(e: unknown, limits: SerialiseLimits = DEFAULT_LIMITS): string {
  const { text, dropped } = serialiseWholeDetailed(e, limits);
  return [text, '', ...describeDropped(dropped)].join('\n');
}

/**
 * The node's own lines, every DISTINCT one kept whole, repeats counted.
 *
 * `R1b` requires the node's words unabridged and unparaphrased, and this keeps
 * that promise exactly: no line is shortened and no distinct line is dropped.
 * What goes is the second and subsequent copy of a line already printed in
 * full, replaced by a count on the line itself. Seventeen identical copies of
 * one rejection is not seventeen pieces of evidence.
 */
export function collapseRepeatedLines(lines: readonly string[]): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!counts.has(line)) order.push(line);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return order.map((l) => {
    const n = counts.get(l) ?? 1;
    return n > 1 ? `${l}\n      [the line above was emitted ${n} times, identically]` : l;
  });
}
