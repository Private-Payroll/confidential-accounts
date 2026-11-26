/**
 * Which ledger fields each proving circuit writes, read from the compiled contract's own JavaScript. Every write
 * the compiler emits is a ledger query holding an insert, a removal or an increment; the field it lands in is the
 * first step of its first path that is kept for the write, or the field's own index when a whole cell is set.
 * A query that begins by swapping in the transaction's effects writes no ledger field and is passed over.
 */

const METHOD = /^ {2}(?:async )?(_[A-Za-z0-9]+_\d+)\(/gmu;
const CALL = /this\.(_[A-Za-z0-9]+_\d+)\(/gu;
const QUERY = /queryLedgerState\(context,\s*partialProofData,\s*\[/gu;
const WRITES = /\{ (?:ins|rem|addi|subi): /u;
const EFFECTS = /^\[\s*\{ swap: /u;
const KEPT_PATH = /\{ idx: \{ cached: (?:true|false),\s*pushPath: true,\s*path: \[\s*\{ tag: 'value',\s*value: \{ value: _descriptor_\d+\.toValue\((\d+)n\)/u;
const WHOLE_CELL = /^\[\s*\{ push: \{ storage: false,\s*value: __compactRuntime\.StateValue\.newCell\(\{ value: _descriptor_\d+\.toValue\((\d+)n\)/u;

/** Each method of the compiled contract class, by its compiled name, with its text. */
export function methodsOf(js: string): Map<string, string> {
  const starts = [...js.matchAll(METHOD)].map((m) => ({ name: m[1]!, at: m.index }));
  const end = js.indexOf('\nexport function ledger');
  if (starts.length === 0 || end < 0) throw new Error('the compiled contract has no class methods or no ledger reader where they are expected');
  return new Map(starts.map((s, i) => [s.name, js.slice(s.at, i + 1 < starts.length ? starts[i + 1]!.at : end)]));
}

/** The text of a bracketed list or call starting at `open`, from its opening bracket to the one that closes it. */
export function listAt(text: string, open: number): string {
  const closer = text[open] === '(' ? ')' : ']';
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === closer && (depth -= 1) === 0) return text.slice(open, i + 1);
  }
  throw new Error('a list or call in the compiled contract is never closed');
}

/** The field indexes one method's own queries write; refuses a write it cannot place in a field. */
function fieldsWrittenIn(body: string, method: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(QUERY)) {
    const ops = listAt(body, m.index + m[0].length - 1);
    if (EFFECTS.test(ops) || !WRITES.test(ops)) continue;
    const field = KEPT_PATH.exec(ops)?.[1] ?? WHOLE_CELL.exec(ops)?.[1];
    if (field === undefined) throw new Error(`${method} writes the ledger in a form this reader cannot place in a field`);
    out.push(Number(field));
  }
  return out;
}

/**
 * The fields each named circuit writes, by name and in the ledger's order: its own method and every method it
 * reaches. Refuses a circuit the compiled code has no method for.
 */
export function writesOfCircuits(js: string, circuits: readonly string[], fields: readonly string[]): Record<string, string[]> {
  const methods = methodsOf(js);
  return Object.fromEntries(circuits.map((circuit) => {
    const entry = `_${circuit}_0`;
    if (!methods.has(entry)) throw new Error(`the compiled contract has no method for the circuit ${circuit}`);
    const seen = new Set<string>();
    const written = new Set<number>();
    const todo = [entry];
    while (todo.length > 0) {
      const name = todo.pop()!;
      const body = methods.get(name);
      if (seen.has(name) || body === undefined) continue;
      seen.add(name);
      for (const f of fieldsWrittenIn(body, name)) written.add(f);
      for (const c of body.matchAll(CALL)) todo.push(c[1]!);
    }
    return [circuit, [...written].sort((a, b) => a - b).map((i) => fields[i] ?? `field ${i}`)];
  }));
}
