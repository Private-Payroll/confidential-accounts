/**
 * *"IF I CHANGE `payoutDetails`, WHAT ELSE IS AFFECTED?"*
 *
 * A graph of interconnectedness, so that a change in one place shows its
 * cascade. A DIAGRAM SHOWS THAT; A QUERY ANSWERS IT (`docs/the-doc-set.md` §7).
 * Until this file existed the answer came from somebody's recollection, which is
 * not a thing a money system should rest on.
 *
 * It reads `docs/design/edges.json` and computes nothing of its own. The edge
 * list is generated at a door from the compiled artifacts; this is a reader,
 * and keeping it a reader is what stops two implementations of the same graph
 * from drifting apart.
 *
 * IT REFUSES A NAME IT DOES NOT KNOW, AND SUGGESTS. Answering *nothing depends
 * on it* for a misspelling is the worst possible output: it is the same answer
 * as *this is safe to change*, and a person acts on it.
 *
 * WHAT IT REPORTS IS NOT ONLY WHAT READS THE THING. For a ledger field, the
 * WRITERS are the answer to `B5`'s question and the READERS are the answer to
 * the contention one, so both are listed and kept apart. The payment-path flag
 * is carried through, because *what breaks* and *what breaks the money* are
 * different questions and the second one is the one that matters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EdgeList } from './edge-list.js';
import { EDGE_LIST_FILE } from './doc-registry.js';

export function loadEdges(root: string): EdgeList {
  const path = join(root, EDGE_LIST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${EDGE_LIST_FILE} is not on disk, so there is no graph to query.\n\n` +
        '  Run DOCS.command, then run this again.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as EdgeList;
}

export type Subject =
  | { kind: 'field'; qualified: string }
  | { kind: 'circuit'; qualified: string }
  | { kind: 'witness'; qualified: string };

/** Every name the graph knows, qualified and bare. */
export function known(edges: EdgeList): Map<string, Subject[]> {
  const out = new Map<string, Subject[]>();
  const add = (key: string, s: Subject) => out.set(key, [...(out.get(key) ?? []), s]);
  for (const c of edges.contracts) {
    for (const f of c.fields) { add(f.qualified, { kind: 'field', qualified: f.qualified }); add(f.name, { kind: 'field', qualified: f.qualified }); }
    for (const x of c.circuits) { add(x.qualified, { kind: 'circuit', qualified: x.qualified }); add(x.name, { kind: 'circuit', qualified: x.qualified }); }
  }
  for (const e of edges.edges) {
    if (e.kind !== 'witness') continue;
    add(e.witness, { kind: 'witness', qualified: e.witness });
    add(e.witness.split('.')[1], { kind: 'witness', qualified: e.witness });
  }
  return out;
}

/**
 * SUGGESTIONS ARE RANKED BY SHARED PREFIX, not by substring.
 *
 * A substring filter is what a first version did and it is worse than useless
 * on the names this graph holds: `payoutDetal` — one letter short of
 * `payoutDetails` — matched `payout` and MISSED `payoutDetails`, because the
 * typo is not a substring of the right answer and the wrong answer is a prefix
 * of the typo. A person reading that concludes the name they wanted does not
 * exist.
 */
const near = (name: string, keys: Iterable<string>): string[] => {
  const lower = name.toLowerCase();
  const prefix = (a: string, b: string): number => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
  };
  const scored = [...new Set(keys)]
    .map((k) => {
      const bare = (k.toLowerCase().split('.').pop() ?? '');
      return { k, score: Math.max(prefix(lower, bare), prefix(lower, k.toLowerCase())) + (bare.includes(lower) || lower.includes(bare) ? 1 : 0) };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || a.k.localeCompare(b.k));
  return scored.slice(0, 12).map((x) => x.k);
};

export function answer(edges: EdgeList, name: string): string {
  const index = known(edges);
  const hits = index.get(name);
  if (!hits || hits.length === 0) {
    const suggestions = near(name, index.keys());
    return [
      '',
      `  "${name}" IS NOT IN THE GRAPH, so this cannot say what depends on it.`,
      '',
      '  Answering "nothing" for a name that is not there is the same answer as',
      '  "this is safe to change", and that is the one mistake this must not make.',
      '',
      suggestions.length > 0 ? '  Did you mean:\n' + suggestions.map((s) => `      ${s}`).join('\n') : '  Nothing in the graph resembles it.',
      '',
    ].join('\n');
  }

  const out: string[] = [''];
  for (const hit of hits) {
    const n = hit.qualified;
    if (hit.kind === 'field') {
      const contract = edges.contracts.find((c) => c.fields.some((f) => f.qualified === n));
      const f = contract?.fields.find((x) => x.qualified === n);
      out.push(`  LEDGER FIELD  ${n}`);
      out.push(`      slot ${JSON.stringify(f?.index)} · ${f?.storage} · ${f?.hot ? 'ON THE PAYMENT PATH' : 'not on the payment path'}`);
      out.push('');
      out.push(`      WRITTEN BY  ${f?.writers.length ? f.writers.join(', ') : 'nothing — only the constructor'}`);
      out.push(`      READ BY     ${f?.readers.length ? f.readers.join(', ') : 'NOTHING — a field written and never read'}`);
      out.push('');
      const viaHelpers = edges.edges.filter((e) => (e.kind === 'reads' || e.kind === 'writes') && e.field === n && e.via.length > 0);
      if (viaHelpers.length > 0) {
        out.push('      reached through helpers:');
        for (const e of viaHelpers) out.push(`        ${(e as { circuit: string }).circuit}  →  ${(e as { via: string[] }).via.join(' → ')}`);
        out.push('');
      }
      continue;
    }
    if (hit.kind === 'witness') {
      out.push(`  WITNESS  ${n}`);
      out.push('      A witness is implemented by the CLIENT. Changing what it returns changes what');
      out.push('      every circuit below sees, and the contract cannot tell.');
      out.push('');
      const users = edges.edges.filter((e) => e.kind === 'witness' && e.witness === n);
      for (const e of users) out.push(`      CONSUMED BY  ${(e as { circuit: string }).circuit}${(e as { via: string[] }).via.length ? `  (through ${(e as { via: string[] }).via.join(' → ')})` : ''}`);
      out.push('');
      continue;
    }

    const c = edges.contracts.flatMap((x) => x.circuits).find((x) => x.qualified === n);
    out.push(`  CIRCUIT  ${n}`);
    out.push(`      ${c?.signature ?? ''}`);
    out.push(`      ${edges.paymentPath.circuits.includes(n) ? 'ON THE PAYMENT PATH' : 'not on the payment path'}`);
    out.push('');
    const w = edges.edges.filter((e) => e.kind === 'writes' && (e as { circuit: string }).circuit === n).map((e) => (e as { field: string }).field);
    const r = edges.edges.filter((e) => e.kind === 'reads' && (e as { circuit: string }).circuit === n).map((e) => (e as { field: string }).field);
    out.push(`      IT WRITES   ${w.length ? [...new Set(w)].join(', ') : 'nothing'}`);
    out.push(`      IT READS    ${r.length ? [...new Set(r)].join(', ') : 'nothing'}`);
    const calls = edges.edges.filter((e) => e.kind === 'calls' && (e as { circuit: string }).circuit === n).map((e) => (e as { callee: string }).callee);
    const callers = edges.edges.filter((e) => e.kind === 'calls' && (e as { callee: string }).callee === n).map((e) => (e as { circuit: string }).circuit);
    out.push(`      IT CALLS    ${calls.length ? calls.join(', ') : 'no other contract'}`);
    out.push(`      CALLED BY   ${callers.length ? callers.join(', ') : 'no other contract'}`);
    // USES/USED BY is the intra-contract half, and it is the half that answers
    // the question a pure helper raises: `payoutDetails` calls nothing
    // and is called by nothing across contracts, and changing it changes what
    // `Vault.payout` commits to.
    const uses = [...new Set(edges.edges.filter((e) => e.kind === 'uses' && (e as { circuit: string }).circuit === n).map((e) => (e as { callee: string }).callee))];
    const usedBy = [...new Set(edges.edges.filter((e) => e.kind === 'uses' && (e as { callee: string }).callee === n).map((e) => (e as { circuit: string }).circuit))];
    out.push(`      IT USES     ${uses.length ? uses.join(', ') : 'no other circuit'}`);
    out.push(`      USED BY     ${usedBy.length ? usedBy.join(', ') : 'no other circuit'}`);
    out.push('');
    const clients = edges.edges.filter((e) => e.kind === 'invokes' && (e as { circuit: string }).circuit === n).map((e) => (e as { from: string }).from);
    out.push(`      INVOKED FROM ${clients.length} site${clients.length === 1 ? '' : 's'} that name it literally:`);
    for (const s of clients.slice(0, 24)) out.push(`        ${s}`);
    if (clients.length > 24) out.push(`        … and ${clients.length - 24} more`);
    if (clients.length === 0) {
      out.push('        NONE. Either nothing calls it, or every caller reaches it through one of the');
      out.push('        renaming layers or a runtime string — see docs/design/ledger-fields.md.');
    }
    out.push('');
    const sharers = edges.contracts
      .flatMap((x) => x.fields)
      .filter((f) => f.writers.includes(n) && f.writers.length > 1);
    if (sharers.length > 0) {
      out.push('      FIELDS IT WRITES THAT SOMETHING ELSE ALSO WRITES — the B5 shape:');
      for (const f of sharers) out.push(`        ${f.qualified}  also written by ${f.writers.filter((x) => x !== n).join(', ')}`);
      out.push('');
    }
  }
  return out.join('\n');
}

/** The whole index, which is what a double-click with no name prints. */
export function index(edges: EdgeList): string {
  const out: string[] = [''];
  out.push('  THE WHOLE GRAPH, BY FIELD. Ask about any name below by running:');
  out.push('      ./WHAT-BREAKS.command <name>');
  out.push('');
  for (const c of edges.contracts) {
    out.push(`  ${c.label}`);
    for (const f of c.fields) {
      out.push(`      ${f.hot ? 'HOT ' : '    '}${f.name.padEnd(18)} written by ${String(f.writers.length).padStart(2)}   read by ${String(f.readers.length).padStart(2)}`);
    }
    out.push('');
  }
  out.push(`  Payment path: ${edges.paymentPath.circuits.join(', ')}`);
  out.push(`  Hot fields:   ${edges.paymentPath.fields.join(', ')}`);
  out.push('');
  return out.join('\n');
}
