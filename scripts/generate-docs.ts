/**
 * THE GENERATOR. `npm run docs` IS ITS ONLY DOOR AND THAT IS THE WHOLE DESIGN.
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
 * with `--skip-zk` and delete `keys/` as they go, which is the state
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
import { MONEY_PATH, buildEdgeList, type EdgeList } from './edge-list.js';
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

/**
 * A TABLE CELL, WITH THE BACKSLASH ESCAPED BEFORE THE PIPE AND NOT AFTER.
 *
 * The order is the whole correction. Escaping only the pipe turns `A\|B` into
 * `A\\|B`, which a markdown table reader parses as an escaped BACKSLASH
 * followed by a live delimiter — so the cell that was being protected is the
 * cell that splits the row. Measured at zero occurrences in the declared set
 * today; a regular expression in an exported declaration is how one arrives.
 */
const cell = (s: string): string => (s.length === 0 ? '—' : s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'));
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

function modulesBlock(edges: EdgeList): string {
  const out: string[] = [];
  const tier1 = new Set(MONEY_PATH.slice(0, 8));

  out.push('');
  out.push('Every module the money path is declared over, in full, and the import graph of the');
  out.push('whole client tree around them. **Generated — nothing in this block is hand-written.**');
  out.push('');
  out.push('**THIS CARRIES NO DESCRIPTION OF WHAT A MODULE IS FOR, AND THE OMISSION IS THE DESIGN.**');
  out.push('A description is prose, the generator writes none, and a sentence copied out of a');
  out.push('source comment is a sentence nothing keeps true. What a module IS, here, is its');
  out.push('exported surface, what it refuses, where it fixes a width, and what it can reach.');
  out.push('');
  out.push('**THE IMPORT GRAPH IS MATCHED, NOT PARSED, AND THE SHAPES ARE NAMED BELOW.** A');
  out.push('specifier built from a variable has no name at its site and is invisible to all of');
  out.push('them — the same limit the circuit scan carries, for the same reason. What the walk');
  out.push('could not read or could not resolve is COUNTED here and NAMED in the machine-');
  out.push('readable edge list beside this document, never dropped: a module missing from a');
  out.push('graph looks exactly like a module nothing imports, and *nothing imports this* is a');
  out.push('conclusion somebody acts on.');
  out.push('');
  out.push('**`reaches` IS NOT A CALL GRAPH AND MUST NOT BE READ AS ONE.** It is two closures,');
  out.push('one after the other: forward along imports, importer to imported; then forward along');
  out.push('what those circuits themselves run, including across the contract boundary. So a');
  out.push('module that imports a boundary reaches every circuit that boundary names, whether or');
  out.push('not any particular function of it does, and reaches whatever those circuits land on');
  out.push('chain. Within the import graph it is an upper bound.');
  out.push('');
  out.push('**IT IS STILL NOT A LOWER BOUND ON WHAT REACHES THE CHAIN**, and the gap is named');
  out.push('rather than left: a call made through a runtime string has no circuit name at its');
  out.push('site, so a module whose only route to a circuit runs through one of those does not');
  out.push('show it here. Those sites are counted and named in the field reference beside this');
  out.push('one — **not in the table below**, whose zero is about import specifiers and is a');
  out.push('different question.');
  out.push('');
  out.push('**AND TWO TABLES BELOW ARE MATCHED RATHER THAN UNDERSTOOD, WHICH IS SAID HERE');
  out.push('BECAUSE AN EMPTY CELL IN EITHER WOULD OTHERWISE READ AS A GUARANTEE.** *What it');
  out.push('refuses* finds a `throw`, an `assert` and an `invariant` whose message is written');
  out.push('from literals; a refusal raised some other way, or carrying no literal at all, is');
  out.push('not here. *Where a width is fixed* finds a width written as a number or as a');
  out.push('capitalised constant; a width arriving in a variable is not here. **AND IT');
  out.push('OVER-MATCHES AS WELL AS UNDER-MATCHING** — a length compared against a small');
  out.push('number, or a slice taken of a string, looks the same to a matcher as a byte width');
  out.push('and appears here. A row is a site the shapes matched, never a byte width');
  out.push('confirmed. Neither table is a proof that a module refuses nothing or fixes');
  out.push('nothing.');
  out.push('');

  const mc = edges.moduleCoverage;
  const sites = new Set(edges.edges.flatMap((e) => (e.kind === 'invokes' ? [`${e.from} ${e.circuit}`] : [])));
  out.push('## What the walk covered');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| modules walked | ${String(mc.modulesWalked)} |`);
  out.push(`| module-to-module import sites | ${String(mc.importEdges)} |`);
  out.push(`| modules that could not be read | ${String(mc.unreadableModules)} |`);
  out.push(`| specifiers that resolved to nothing | ${String(mc.unresolvedSpecifiers)} |`);
  out.push(`| specifiers naming a real file outside the walked set | ${String(mc.resolvedOutsideTheWalkedSet)} |`);
  out.push(`| call sites carrying a literal circuit name | ${String(sites.size)} |`);
  out.push('');
  out.push('The last row counts a SITE once. A site whose text answers to more than one of the');
  out.push('circuit-scan shapes is one call, and counting it twice would overstate how much of');
  out.push('the product this list has actually seen.');
  out.push('');
  out.push('The shapes an import is recognised by:');
  out.push('');
  for (const sh of mc.shapes) out.push(`- \`${sh}\``);
  out.push('');
  out.push('What the import walk cannot see, named rather than implied complete:');
  out.push('');
  for (const b of mc.knownBlind) out.push(`- ${b}`);
  out.push('');

  out.push('## The declared set, at a glance');
  out.push('');
  out.push('| module | tier | imports | imported by | exports | refuses | fixed widths | reaches |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const m of edges.moneyPath) {
    out.push(
      `| \`${m.file}\` | ${tier1.has(m.file) ? '1' : '2'} | ${String(m.imports.length)} | ${String(m.importedBy.length)} | ` +
        `${String(new Set(m.exports.map((x) => x.name)).size)} | ${String(m.refusals.length)} | ${String(m.byteWidths.length)} | ` +
        `${String(m.circuitsReached.length)} |`,
    );
  }
  out.push('');

  out.push('## Every circuit, and what reaches it');
  out.push('');
  out.push('**THIS IS THE COLUMN AN AUDIT OF A CONTRACT ARRIVES WANTING.**');
  out.push('');
  out.push('**THE TWO COLUMNS ANSWER DIFFERENT QUESTIONS AND A ROW CAN BE EMPTY IN THE FIRST');
  out.push('AND NOT THE SECOND.** *Naming* means a TypeScript file writes that circuit\'s name at');
  out.push('a call site. *Reaching* includes a circuit that another circuit runs, across the');
  out.push('contract boundary — so **NONE** in the first column does not mean the circuit is');
  out.push('never invoked here, only that no TypeScript names it directly. Read the two');
  out.push('together: **NONE** with a reaching count above zero is a circuit only ever entered');
  out.push('through another contract, which is a fact about the design and not a dead circuit.');
  out.push('');
  out.push('| circuit | modules naming it | modules reaching it |');
  out.push('|---|---|---|');
  for (const c of edges.contracts) {
    for (const circuit of c.circuits) {
      const naming = edges.modules.filter((m) => m.circuits.includes(circuit.qualified)).map((m) => m.file);
      const reaching = edges.modules.filter((m) => m.circuitsReached.includes(circuit.qualified));
      out.push(
        `| \`${circuit.qualified}\` | ${naming.length === 0 ? '**NONE**' : cell(naming.map((f) => `\`${f}\``).join(' '))} | ${String(reaching.length)} |`,
      );
    }
  }
  out.push('');

  for (const m of edges.moneyPath) {
    out.push(`## \`${m.file}\``);
    out.push('');
    out.push(`Tier ${tier1.has(m.file) ? '1' : '2'} of the declared set.`);
    out.push('');
    out.push(`- **imports** — ${m.imports.length === 0 ? '*nothing in these trees*' : m.imports.map((x) => `\`${x}\``).join(', ')}`);
    out.push(`- **imported by** — ${m.importedBy.length === 0 ? '*nothing in these trees*' : m.importedBy.map((x) => `\`${x}\``).join(', ')}`);
    out.push(`- **outside packages** — ${m.external.length === 0 ? '*none*' : m.external.map((x) => `\`${x}\``).join(', ')}`);
    out.push(`- **platform modules** — ${m.builtin.length === 0 ? '*none*' : m.builtin.map((x) => `\`${x}\``).join(', ')}`);
    out.push(`- **circuits named here** — ${m.circuits.length === 0 ? '*none*' : m.circuits.map((x) => `\`${x}\``).join(', ')}`);
    out.push(`- **circuits reached** — *through imports, then through what those circuits themselves run* — ${m.circuitsReached.length === 0 ? '*none*' : m.circuitsReached.map((x) => `\`${x}\``).join(', ')}`);
    out.push('');

    out.push(`### \`${m.file}\` — exported surface`);
    out.push('');
    if (m.exports.length === 0) {
      out.push('*Nothing is exported.*');
    } else {
      out.push('| line | name | as written |');
      out.push('|---|---|---|');
      for (const x of m.exports) out.push(`| ${String(x.line)} | \`${x.name}\` | \`${cell(x.signature)}\` |`);
    }
    out.push('');

    out.push(`### \`${m.file}\` — what it refuses`);
    out.push('');
    if (m.refusals.length === 0) {
      out.push('*No refusal here matches the shapes above.* That is a statement about the');
      out.push('matcher and not about the module: read it as "look for yourself", never as');
      out.push('"every value that reaches this module is one it accepts".');
    } else {
      out.push('| line | kind | message |');
      out.push('|---|---|---|');
      for (const r of m.refusals) out.push(`| ${String(r.line)} | ${r.kind} | ${cell(r.message)} |`);
    }
    out.push('');

    out.push(`### \`${m.file}\` — where a width is fixed`);
    out.push('');
    if (m.byteWidths.length === 0) {
      out.push('*No width here matches the shapes above.* A width this module works to may');
      out.push('arrive in a variable, and this list sees only a number or a capitalised constant.');
    } else {
      out.push('| line | site | what fixes it |');
      out.push('|---|---|---|');
      for (const w of m.byteWidths) out.push(`| ${String(w.line)} | \`${cell(w.text)}\` | ${w.why} |`);
    }
    out.push('');
  }

  return out.join('\n');
}

/**
 * THE BYTES, PRODUCED ONCE, FOR BOTH THE WRITER AND THE GATE.
 *
 * `generate()` writes what this returns and `scripts/doc-freshness.ts`
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
    ['modules', modulesBlock(edges)],
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
  // The gate compares rendered against on-disk, so an empty render
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
