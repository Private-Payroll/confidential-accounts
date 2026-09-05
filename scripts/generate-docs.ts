/**
 * THE GENERATOR. `DOCS.command` IS ITS ONLY DOOR AND THAT IS THE WHOLE DESIGN.
 *
 * This reads the COMPILED artifact, so it is only correct where a compile is
 * correct. Rule 1 forbids a session to compile. Therefore generation cannot be
 * something the suite does for itself: a generator that quietly regenerated
 * from a stale artifact would emit a document that is confidently wrong, which
 * is worse than one that is missing. `scripts/doc-freshness.ts` REFUSES and
 * names this door; it never runs anything in this file.
 *
 * WHAT IS NOT WRITTEN HERE. No prose, no narrative, no claim about why anything
 * is built the way it is. `docs/the-doc-set.md` §9 gives every design document
 * three bands and only the first is machine-written; `docs/design/circuits.md`
 * and `docs/design/ledger-fields.md` are generated REFERENCES rather than
 * documents — nobody opens them to read them, they search them (§4) — and they
 * are one band all the way down.
 *
 * WHAT IT REFUSES TO WRITE. The verifier-key column, when there are no verifier
 * keys on disk. `COMPILE-CONTRACT.command` and `COMPILE-VAULT.command` compile
 * with `--skip-zk` and delete `keys/` as they go (`C327`), which is the state
 * after every ordinary compile — so this is the NORMAL case, not an edge one.
 * The cell then says the measurement was not taken and names the door that
 * would take it. Rule 9: a measurement you could not take is a refusal, and the
 * one thing it must not be is blank, because a blank cell reads as "this
 * circuit has no verifier key".
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ARTIFACTS, readContract, type ContractModel, type KeyFact } from './artifact-scan.js';
import { scanSourceFile, type SourceCircuit } from './disclose-scan.js';
import { buildEdgeList, type EdgeList } from './edge-list.js';
import { GENERATED_BLOCKS, GENERATED_FILES } from './doc-registry.js';
import { digest, replaceBlock } from './generated-blocks.js';

/**
 * The one line of a generated file that changes on every run whether or not
 * anything else did. Anchored to the start of a line and to the top-level
 * two-space indent, so it cannot match a `generatedAt` nested in the payload.
 */
export const stripGeneratedAt = (s: string): string => s.replace(/^ {2}"generatedAt": "[^"]*",\n/m, '');

/** IST. Rule 22. */
export const ist = (d: Date): string =>
  d.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST';

const cell = (s: string): string => (s.length === 0 ? '—' : s.replace(/\|/g, '\\|'));
const list = (xs: readonly string[]): string => (xs.length === 0 ? '—' : xs.join(', '));

const keyCell = (k: KeyFact | undefined): string => {
  if (!k) return '—';
  return k.measured === true
    ? `${k.bytes.toLocaleString('en-GB')} B \`${k.sha256.slice(0, 12)}\``
    : `**NOT MEASURED** — ${k.why}; run \`${k.door}\``;
};

function circuitsBlock(models: readonly ContractModel[], sources: ReadonlyMap<string, SourceCircuit[]>): string {
  const out: string[] = [];
  out.push('');
  out.push('Every circuit on both contracts. **Generated — nothing in this block is hand-written.**');
  out.push('');
  out.push('**THE CONSTRUCTOR IS THE FIRST ROW OF EACH CONTRACT AND IT IS NOT A CIRCUIT.**');
  out.push('`compiler/contract-info.json` has no entry for it and its emitted body is named');
  out.push('`initialState`, so a scan over circuits alone reports that fields only it writes have');
  out.push('no writer at all. It writes every field, because it initialises them.');
  out.push('');
  out.push('`READS`, `WRITES`, `ASSERTS` and the cross-contract calls are read off the compiled');
  out.push('module and are TRANSITIVE: a circuit that reaches a ledger field through a private');
  out.push('helper is shown as reaching it, with the helper named. `DISCLOSES` is read off the');
  out.push('`.compact` SOURCE, because the compiler erases `disclose()` and the artifact contains');
  out.push('none — the freshness gate is what keeps the two in step.');
  out.push('');
  out.push('**`DISCLOSES` IS NOT A LIST OF WHAT IS PUBLIC, AND MUST NOT BE READ AS ONE.**');
  out.push('`disclose()` has no runtime effect whatsoever; it tells the COMPILER to stop treating');
  out.push('an expression as witness-derived. Around a circuit argument — which the caller already');
  out.push('supplies in the clear — it publishes nothing at all and only silences a check. It is');
  out.push('therefore neither necessary nor sufficient for a value being observable on chain: a');
  out.push('ledger field written in the clear is public with no `disclose()` anywhere near it, and');
  out.push('the shape of a transaction leaks things no marker mentions. What this column IS is the');
  out.push('exact set of places the contract asserts that witness-derived data may cross into');
  out.push('public state — which is the trust boundary, and a different question. The enumeration');
  out.push('of what is actually public belongs in `docs/design/privacy.md` and is not this.');
  out.push('');

  for (const m of models) {
    const src = sources.get(m.label) ?? [];
    out.push(`## ${m.label}`);
    out.push('');
    out.push(`\`${m.source}\` → \`${m.artifact}\` · compactc ${m.compilerVersion} · language ${m.languageVersion} · runtime ${m.runtimeVersion}`);
    out.push('');
    out.push('| circuit | kind | reads | writes | asserts | discloses | calls | verifier key |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const c of m.ctor ? [m.ctor] : []) {
      const sc = src.find((s2) => s2.name === 'constructor');
      out.push(
        `| \`constructor\` | **constructor** | ${cell(list(c.reads.map((r) => r.field)))} | ${cell(list(c.writes.map((w) => w.field)))} | ${c.asserts.length} | ${sc?.discloses.length ?? 0} | ${cell(list(c.calls.map((x) => x.circuit)))} | — (not a circuit) |`,
      );
    }
    for (const c of m.circuits) {
      const sc = src.find((s) => s.name === c.name);
      const d = sc?.discloses.length ?? 0;
      out.push(
        `| \`${c.name}\` | ${c.pure ? 'pure' : 'provable'} | ${cell(list(c.reads.map((r) => r.field)))} | ${cell(list(c.writes.map((w) => w.field)))} | ${c.asserts.length} | ${d} | ${cell(list(c.calls.map((x) => x.circuit)))} | ${c.pure ? '— (pure)' : keyCell(m.keys.get(c.name))} |`,
      );
    }
    out.push('');
    out.push(`### ${m.label} — per circuit, in full`);
    out.push('');
    for (const c of [...(m.ctor ? [m.ctor] : []), ...m.circuits]) {
      const sc = src.find((s) => s.name === c.name);
      out.push(`#### \`${c.name}\``);
      out.push('');
      out.push('```');
      out.push(c.signature);
      out.push('```');
      out.push('');
      const via = (v: readonly string[]) => (v.length === 0 ? '' : ` *(through ${v.map((x) => `\`${x}\``).join(' → ')})*`);
      out.push(`- **reads** — ${c.reads.length === 0 ? '*nothing*' : c.reads.map((r) => `\`${r.field}\`${via(r.via)}`).join('; ')}`);
      out.push(`- **writes** — ${c.writes.length === 0 ? '*nothing*' : c.writes.map((r) => `\`${r.field}\`${via(r.via)}`).join('; ')}`);
      out.push(`- **witnesses** — ${c.witnesses.length === 0 ? '*none*' : c.witnesses.map((r) => `\`${r.witness}\`${via(r.via)}`).join('; ')}`);
      out.push(`- **kernel** — ${c.kernel.length === 0 ? '*none*' : c.kernel.map((k) => `${k.kind} slot ${String(k.slot)} through \`${k.through}\``).join('; ')}`);
      out.push(`- **calls** — ${c.calls.length === 0 ? '*none*' : c.calls.map((x) => `\`${x.contract}.${x.circuit}\`${via(x.via)}`).join('; ')}`);
      out.push(`- **uses** — ${c.uses.length === 0 ? '*no other circuit*' : c.uses.map((x) => `\`${x.circuit}\`${via(x.via)}`).join('; ')}`);
      if (c.asserts.length === 0) {
        out.push('- **asserts** — *none*');
      } else {
        out.push('- **asserts**');
        for (const a of c.asserts) out.push(`    - "${a.message}"${via(a.via)}`);
      }
      const ds = sc?.discloses ?? [];
      if (ds.length === 0) {
        out.push('- **discloses** — *nothing*');
      } else {
        out.push(`- **discloses** — ${ds.length} site${ds.length === 1 ? '' : 's'}`);
        for (const s of ds) out.push(`    - \`${m.source}:${s.line}\` — \`${s.text}\`${via(s.via)}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function fieldsBlock(edges: EdgeList): string {
  const out: string[] = [];
  out.push('');
  out.push('Every ledger field on both contracts, with **who writes it**, **who reads it**, and');
  out.push('whether the **payment path** reaches it. **Generated — nothing here is hand-written.**');
  out.push('');
  out.push(`\`hot\` means the field is read or written by a circuit reachable from ${edges.paymentPath.roots.map((r) => `\`${r}\``).join(', ')}.`);
  out.push('');
  out.push('**A field with many writers is where a merge can let one circuit write a value only');
  out.push('another may write.** Reading down the writers column answers that.');
  out.push('');
  out.push('**`hot` DOES NOT MEAN "SAFE TO MERGE WITH ANOTHER HOT FIELD", AND `cold` DOES NOT MEAN');
  out.push('"SAFE TO MERGE".** Contention is created by a writer in ANOTHER transaction touching');
  out.push('what a payment reads, and heat as measured here is within-transaction reachability, so');
  out.push('it is neither necessary nor sufficient for that. Two fields in this table make the');
  out.push('point: `Vault.account` is hot and no circuit writes it, so it can never contend; and');
  out.push('`openProposals` is hot and is written by `closeExpiredRun`, which anyone may call. The');
  out.push('column is evidence for a merge question, not an answer to one.');
  out.push('');
  out.push('**`written by circuits` EXCLUDES THE CONSTRUCTOR, WHICH WRITES EVERY FIELD** because it');
  out.push('initialises them — a column that said so on every row would say nothing. `NO CIRCUIT`');
  out.push('therefore means exactly that, and not that the field is never written: in Compact a');
  out.push('record or map value is written whole, so a field no circuit writes today acquires every');
  out.push('writer of any record it is merged into.');
  out.push('');
  for (const c of edges.contracts) {
    out.push(`## ${c.label}`);
    out.push('');
    out.push('| # | field | storage | heat | written by circuits | read by circuits | constructor |');
    out.push('|---|---|---|---|---|---|---|');
    for (const f of c.fields) {
      const short = (xs: string[]) => (xs.length === 0 ? '**NO CIRCUIT**' : xs.map((x) => `\`${x.split('.')[1]}\``).join(' '));
      out.push(`| ${JSON.stringify(f.index)} | \`${f.name}\` | ${f.storage} | ${f.hot ? '**hot**' : 'cold'} | ${short(f.writers)} | ${short(f.readers)} | ${f.writtenByConstructor ? 'writes it' : '—'} |`);
    }
    out.push('');
  }
  out.push('## Cross-contract calls');
  out.push('');
  out.push('| caller | callee |');
  out.push('|---|---|');
  for (const e of edges.edges) if (e.kind === 'calls') out.push(`| \`${e.circuit}\` | \`${e.callee}\` |`);
  out.push('');
  out.push('## What the client-side scan does NOT know');
  out.push('');
  out.push(`Scanned ${edges.coverage.clientFilesScanned} files; ${edges.coverage.resolvedInvocations} invocations carry a literal circuit name and ${edges.coverage.unresolvedInvocations} do not.`);
  out.push('');
  out.push('Five layers stand between a product call and a circuit, three of which rename:');
  out.push('');
  for (const l of edges.coverage.renamingLayers) out.push(`- ${l}`);
  out.push('');
  out.push('Unresolved call sites, named rather than dropped:');
  out.push('');
  for (const e of edges.edges) if (e.kind === 'invokes-unresolved') out.push(`- \`${e.from}\` — ${e.shape}: ${e.note}`);
  out.push('');
  return out.join('\n');
}

/**
 * THE BYTES, PRODUCED ONCE, FOR BOTH THE WRITER AND THE GATE.
 *
 * `T-167`. `generate()` writes what this returns and `scripts/doc-freshness.ts`
 * COMPARES what this returns against what is on disk. One function, so the two
 * cannot disagree about what a current document is — which is what a list of
 * input files could never guarantee, because it was always a guess about what
 * the render depends on rather than the render itself.
 *
 * `generatedAt` IS THE ONLY VOLATILE BYTE and it is not produced here. The
 * writer stamps it on the way out; the gate never sees it. A clock inside a
 * digest is a digest that never matches.
 */
export type Rendered = {
  /** Block id → the body between the two delimiters. */
  readonly blocks: ReadonlyMap<string, string>;
  /** File path → the whole file, minus the `generatedAt` line. */
  readonly files: ReadonlyMap<string, string>;
};

export async function render(root: string): Promise<Rendered> {
  const models: ContractModel[] = [];
  for (const spec of ARTIFACTS) models.push(await readContract(root, spec));
  const sources = new Map<string, SourceCircuit[]>();
  for (const spec of ARTIFACTS) sources.set(spec.label, scanSourceFile(root, spec.source));
  const edges = await buildEdgeList(root);

  const bodies = new Map<string, string>([
    ['circuits', circuitsBlock(models, sources)],
    ['ledger-fields', fieldsBlock(edges)],
  ]);
  for (const spec of GENERATED_BLOCKS) {
    if (!bodies.has(spec.id)) {
      throw new Error(`generate-docs: no renderer for block "${spec.id}", which scripts/doc-registry.ts names.`);
    }
  }

  const files = new Map<string, string>();
  for (const spec of GENERATED_FILES) {
    const body = JSON.stringify({ generatedBy: spec.door, ...edges }, null, 2) + '\n';
    files.set(spec.file, ['{', `  "payload": ${JSON.stringify(digest(body))},`, body.slice(1)].join('\n'));
  }

  // A RENDER THAT PRODUCED NOTHING IS AN ERROR RATHER THAN A CLEAN COMPARISON.
  // `C238`: the gate compares rendered against on-disk, so an empty render
  // would make every document look current, for ever, silently.
  for (const [id, body] of bodies) {
    if (body.trim().length === 0) throw new Error(`generate-docs: block "${id}" rendered EMPTY. Nothing was written and nothing was compared.`);
  }
  for (const [file, text] of files) {
    if (text.trim().length < 32) throw new Error(`generate-docs: ${file} rendered EMPTY. Nothing was written and nothing was compared.`);
  }

  return { blocks: bodies, files };
}

/** Where the writer stamps the clock, and the only place it exists. */
export const withGeneratedAt = (text: string, at: Date): string =>
  ['{', `  "generatedAt": ${JSON.stringify(ist(at))},`, text.slice(1).replace(/^\n/, '')].join('\n');

export async function generate(root: string): Promise<string[]> {
  const rendered = await render(root);
  const written: string[] = [];

  for (const spec of GENERATED_BLOCKS) {
    const path = join(root, spec.file);
    if (!existsSync(path)) {
      throw new Error(
        `generate-docs: ${spec.file} is not on disk. A generator does not create a document; it fills ` +
          'a region in one that already carries the delimiters, so that a regeneration can never invent a file or move a block.',
      );
    }
    const before = readFileSync(path, 'utf8');
    const after = replaceBlock(before, { id: spec.id, door: spec.door }, rendered.blocks.get(spec.id) as string);
    if (after !== before) { writeFileSync(path, after); written.push(spec.file); }
  }

  for (const spec of GENERATED_FILES) {
    const path = join(root, spec.file);
    mkdirSync(dirname(path), { recursive: true });
    const next = withGeneratedAt(rendered.files.get(spec.file) as string, new Date());
    const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
    // The timestamp changes on every run, so compare everything but it: a
    // regeneration that changed nothing should leave the file alone rather than
    // producing a diff a reader has to inspect to find is empty.
    if (stripGeneratedAt(next) !== stripGeneratedAt(prev)) { writeFileSync(path, next); written.push(spec.file); }
  }

  return written;
}
