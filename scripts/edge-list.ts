/**
 * THE EDGE LIST. ITS FIRST CONSUMER IS `SC8`, NOT THE DOC SET, AND THAT DECIDED
 * WHAT IS IN IT.
 *
 * The doc set needs *what exists*. `SC8` needs *who writes each field and what
 * the payment path reaches*, which is a harder extraction and the one this was
 * built for first (`docs/the-doc-set.md` §2a). A field list without its writers
 * is useless to `SC8` and merely incomplete for the docs.
 *
 * WHY THE TWO COLLISIONS ARE DIFFERENT AND BOTH ARE HERE. `B5` reopens on a
 * WRITER collision — a merge that would let `approve` write a value only
 * `propose` may write. The retirement/payment contention is a HEAT collision —
 * cold registry data sharing a map entry with a value the spend path reads.
 * `SC8` is deciding whether to group the contract's state by writer and heat
 * instead of by subject, so this emits `writers`, `readers` and `hot`
 * separately rather than one merged "touched by" set.
 *
 * ── WHAT IS DERIVED, AND HOW SURE EACH PART IS ───────────────────────────────
 *
 * Not every edge is measured the same way, and a list that hid that would be
 * inviting `SC8` to trust the weakest part as much as the strongest. Every edge
 * carries its `source`:
 *
 *   `artifact`  — read out of the compiled module. Circuit→field reads and
 *                 writes, cross-contract calls, witness use, kernel access.
 *                 These are the load-bearing ones and they are exact.
 *   `source`    — read out of the `.compact`. `disclose()` only, because the
 *                 compiler erases it (`scripts/disclose-scan.ts`).
 *   `client`    — matched in TypeScript by call shape. THE WEAKEST, and it is
 *                 labelled so. See the next paragraph.
 *
 * ── THE CLIENT EDGES ARE INCOMPLETE BY CONSTRUCTION AND SAY SO ───────────────
 *
 * Five indirection layers stand between a product call and a circuit, three of
 * which RENAME: `MidnightLedger.addSigner` and `.removeSigner` both reach
 * `amendSigner`, `proposeRun` reaches `propose`, `MidnightCommitments.assetKey`
 * reaches `assetKeyOf`, `.proposalId` reaches `proposalIdOf`,
 * `.changeCommitment` reaches `changeCommitmentOf`, and
 * `AccountSimulator`'s methods rename again. THREE dispatchers pick the circuit
 * from a RUNTIME STRING — `src/midnight/ledger.ts:1796`,
 * `src/midnight/vault-ledger.ts:530` and `scripts/sponsor-test.ts:457` — so at
 * those three lines there is no name in the text at all. **THIS SENTENCE SAID
 * TWO, AND NAMED A LINE THAT HAD MOVED.** The count and the locations are read
 * off the unresolved edges this file emits, which is the only place they cannot
 * go stale independently of the thing they describe.
 *
 * A scanner that resolved all of that would be a TypeScript analyser, and a
 * scanner that pretended to would emit a call graph with holes nobody could
 * see. So this matches the shapes that carry a literal name, records every
 * dynamic dispatch site as an UNRESOLVED edge with its file and line rather
 * than dropping it, and puts the count of both in the generated block. A reader
 * is told what the list does not know. `C238` is the same lesson one level up:
 * a check over nothing cannot fail, and a graph that silently omits cannot be
 * questioned.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ARTIFACTS, readContract, type ContractModel } from './artifact-scan.js';
import { scanSourceFile, type SourceCircuit } from './disclose-scan.js';
import { IMPORT_SHAPES, absentFrom, buildModuleGraph, type ModuleNode } from './module-graph.js';

export type EdgeSource = 'artifact' | 'source' | 'client' | 'module';

export type Edge =
  | { kind: 'reads' | 'writes'; source: 'artifact'; circuit: string; field: string; via: string[] }
  /** The constructor. Kept a separate kind so it can never be counted as a circuit writer. */
  | { kind: 'writes-at-construction'; source: 'artifact'; circuit: string; field: string; via: string[] }
  | { kind: 'calls'; source: 'artifact'; circuit: string; callee: string; via: string[] }
  | { kind: 'uses'; source: 'artifact'; circuit: string; callee: string; via: string[] }
  | { kind: 'witness'; source: 'artifact'; circuit: string; witness: string; via: string[] }
  | { kind: 'kernel'; source: 'artifact'; circuit: string; through: string; slot: number | null; access: 'reads' | 'writes'; via: string[] }
  | { kind: 'discloses'; source: 'source'; circuit: string; at: string; text: string; via: string[] }
  | { kind: 'invokes'; source: 'client'; from: string; circuit: string; shape: string }
  | { kind: 'invokes-unresolved'; source: 'client'; from: string; shape: string; note: string }
  /**
   * ONE TYPESCRIPT MODULE IMPORTING ANOTHER. Until this existed every client
   * edge in this list ran from a file to a CIRCUIT, so the list could say what
   * calls the chain and could not say what calls what -- and nothing could draw
   * the layers between a screen and a payment.
   */
  | { kind: 'imports'; source: 'module'; from: string; to: string; spec: string; at: string }
  /** A specifier that named nothing. Reported, exactly as an unresolved circuit is. */
  | { kind: 'imports-unresolved'; source: 'module'; from: string; spec: string; at: string; note: string };

export type FieldRow = {
  name: string;
  qualified: string;
  index: number | number[];
  storage: string;
  /** Circuits that write it. The CONSTRUCTOR is not one and is carried separately. */
  writers: string[];
  readers: string[];
  /**
   * THE CONSTRUCTOR WRITES EVERY FIELD, because it initialises them, so it is
   * never in `writers` — a column where every row said "and the constructor"
   * would say nothing. It is here so that `writers: []` cannot be read as
   * "nothing writes this", which is the `C286` shape: the vault's `account`
   * field is unredirectable ONLY because no circuit writes it, and an empty
   * cell restates that absence as though it were a guarantee.
   */
  writtenByConstructor: boolean;
  hot: boolean;
};

export type EdgeList = {
  compiler: { compact: string; language: string; runtime: string };
  contracts: {
    label: string;
    source: string;
    artifact: string;
    fields: FieldRow[];
    circuits: { name: string; qualified: string; pure: boolean; signature: string }[];
  }[];
  edges: Edge[];
  paymentPath: { roots: string[]; circuits: string[]; fields: string[] };
  coverage: {
    clientFilesScanned: number;
    resolvedInvocations: number;
    unresolvedInvocations: number;
    renamingLayers: string[];
  };
  /** One row per `.ts`, `.tsx` or `.mjs` module in the three client trees. */
  modules: ModuleSummary[];
  /** The full reference detail, for the declared money-path set only. */
  moneyPath: ModuleNode[];
  moduleCoverage: {
    modulesWalked: number;
    importEdges: number;
    unreadableModules: number;
    unresolvedSpecifiers: number;
    /**
     * Specifiers that name a REAL file this walk does not cover — a contract's
     * generated module, a config, a probe tree. Not an edge and not a defect,
     * and the largest hole in the graph, so it is counted where the other
     * holes are counted rather than left to be discovered.
     */
    resolvedOutsideTheWalkedSet: number;
    /** Members of `MONEY_PATH` that the walk did not find. Always empty or a refusal. */
    declaredButAbsent: string[];
    shapes: string[];
    knownBlind: string[];
  };
};

/**
 * WHAT GOES IN THE MACHINE LIST FOR EVERY MODULE, AS OPPOSED TO WHAT GOES IN
 * THE DOCUMENT FOR FOURTEEN OF THEM.
 *
 * `importedBy` is DERIVABLE from the `imports` edges and is carried anyway,
 * because the question a reader arrives with is *what breaks if I change this*
 * and answering it should not require them to invert a 300-node graph first.
 * `imports` is NOT carried here, because it is exactly the edge list and a
 * second copy of it could disagree with the first.
 */
export type ModuleSummary = {
  file: string;
  importedBy: string[];
  external: string[];
  builtin: string[];
  circuits: string[];
  circuitsReached: string[];
  exportedNames: string[];
  refusalCount: number;
  byteWidthSites: number;
};

const q = (label: string, name: string) => `${label}.${name}`;

/**
 * THE PAYMENT PATH IS ROOTED HERE, AND THE LIST IS A JUDGEMENT RATHER THAN A
 * MEASUREMENT — which is why it is one exported constant and not three literals
 * buried in a walk.
 *
 * `hot` means: reachable forward from one of these, following cross-contract
 * calls and intra-contract circuit calls. It does NOT mean "safe to merge" and
 * `cold` does not mean "safe" — contention is created by a writer in ANOTHER
 * transaction touching what a payment reads, and this is within-transaction
 * reachability. The generated document says so where a reader will see it.
 *
 * WHAT IS DELIBERATELY NOT A ROOT, so that a later round can disagree on
 * purpose rather than by accident: `Vault.retire`, which also calls across
 * contracts. Folding it in would make the flag mean "touched by anything
 * cross-contract", which is a different question.
 */
/**
 * THE DECLARED MONEY-PATH SET -- THE MODULES THE GENERATED REFERENCE COVERS IN
 * FULL, AS OPPOSED TO THE 300-ODD IT DRAWS EDGES BETWEEN.
 *
 * TIER 1 computes a value the contracts compare; TIER 2 is a boundary the money
 * crosses. Both are in the reference; the distinction is which of them owes a
 * changelog line when it changes, and that is not this file's question.
 *
 * **THIS LIST IS A SECOND COPY AND NOTHING CHECKS IT AGAINST THE FIRST.** The
 * set is declared in a working document that does not ship, and shipping code
 * may not cite a file a reader of the published repository cannot open -- so
 * the choice is between a copy nothing reconciles and a citation nobody can
 * follow. The copy is the lesser of the two AND IT IS A REAL EXPOSURE: a module
 * added to the declared set and not to this line is a module the reference goes
 * on omitting, silently, while every gate stays green.
 *
 * A MEMBER THAT IS NOT ON DISK IS A REFUSAL rather than a quietly shorter
 * document, for the reason the payment roots are checked the same way below: a
 * renamed file would empty its own row and nothing anywhere would be red.
 */
export const MONEY_PATH: readonly string[] = [
  'src/midnight/payout-tree.ts',
  'src/midnight/run-keys.ts',
  'src/midnight/commitments.ts',
  'src/core/signer-leaf.ts',
  'src/core/crypto.ts',
  'src/midnight/payee-address.ts',
  'src/core/payslip-key.ts',
  'src/core/payslip-key-derive.ts',
  'src/midnight/ledger.ts',
  'src/midnight/vault-ledger.ts',
  'src/midnight/vault-notes.ts',
  'src/midnight/vault-coins.ts',
  'src/core/movement.ts',
  'src/midnight/run-status.ts',
];

export const PAYMENT_ROOTS: readonly string[] = [
  'ConfidentialAccount.recordPayment',
  'Vault.payout',
  'Vault.payoutUnshielded',
];

/* ------------------------------------------------------- the client scan --- */

/**
 * Shapes that carry a LITERAL circuit name. Each was found in the tree rather
 * than imagined, and each is anchored so that a longer identifier ending in the
 * same characters does not match.
 */
export const SHAPES: readonly { name: string; re: RegExp }[] = [
  { name: 'impureCircuits.X', re: /\.impureCircuits\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },
  { name: 'provableCircuits.X', re: /\.provableCircuits\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },
  { name: 'callTx.X', re: /\.callTx(?:\s+as\s+any)?\)?\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },
  { name: 'pureCircuits.X', re: /(?:pureCircuits|vaultCircuits)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g },
  { name: "circuit: 'X'", re: /\bcircuit(?:Id)?\s*:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g },
  { name: "call(addr, 'X')", re: /\.call(?:WithoutPool)?\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*,\s*'([A-Za-z_][A-Za-z0-9_]*)'/g },
  { name: "planCall('X')", re: /planCall\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g },
  { name: "Opts('X')", re: /(?:accountOpts|vaultOpts|tryCircuit)\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g },
  { name: "createCircuitContext('X')", re: /createCircuitContext(?:<[^>]*>)?\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g },
  { name: "run('X')", re: /this\.run\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g },
];

/** Sites where the circuit is a runtime string. Named, never counted as an edge. */
export const DYNAMIC: readonly { name: string; re: RegExp }[] = [
  { name: 'callTx[<expr>]', re: /\.callTx(?:\s+as\s+any)?\)?\s*\[/g },
  { name: 'createCallTxOptions(<expr>)', re: /createCallTxOptions\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*,\s*(?!')/g },
];

export const CLIENT_TREES = ['src', 'scripts', join('contracts', 'test')];
const CLIENT_EXT = /\.(ts|tsx|mjs)$/;

function clientFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const child = join(rel, n);
      const st = statSync(join(root, child));
      if (st.isDirectory()) walk(child);
      else if (st.isFile() && CLIENT_EXT.test(n)) out.push(child.split(sep).join('/'));
    }
  };
  for (const t of CLIENT_TREES) walk(t);
  return out;
}

const lineAt = (text: string, at: number) => text.slice(0, at).split('\n').length;

/* ------------------------------------------------------------ the build --- */

/**
 * `payoutDetails` exists on the vault and nowhere else; `recordPayment` is
 * declared by BOTH contracts — really on the account, and as an interface
 * member on the vault's `contract Acct`. A name in two circuit sets is
 * AMBIGUOUS and is resolved by which artifact the file imports; a file that
 * imports neither leaves it ambiguous, and an ambiguous edge is recorded as
 * such rather than assigned to whichever contract was checked first.
 */
function resolveContract(
  name: string,
  fileText: string,
  models: readonly ContractModel[],
): { label: string } | { ambiguous: string[] } | null {
  const owners = models.filter((m) => m.circuits.some((c) => c.name === name));
  if (owners.length === 0) return null;
  if (owners.length === 1) return { label: owners[0].label };
  const imported = owners.filter((m) => fileText.includes(m.artifact.replace('contracts/', '')));
  if (imported.length === 1) return { label: imported[0].label };
  return { ambiguous: owners.map((m) => m.label) };
}

export async function buildEdgeList(root: string): Promise<EdgeList> {
  const models: ContractModel[] = [];
  for (const spec of ARTIFACTS) models.push(await readContract(root, spec));

  const sources = new Map<string, SourceCircuit[]>();
  for (const spec of ARTIFACTS) sources.set(spec.label, scanSourceFile(root, spec.source));

  const edges: Edge[] = [];

  for (const m of models) {
    const src = sources.get(m.label) ?? [];
    if (m.ctor) {
      const self = q(m.label, 'constructor');
      for (const w of m.ctor.writes) edges.push({ kind: 'writes-at-construction', source: 'artifact', circuit: self, field: q(m.label, w.field), via: [...w.via] });
      for (const r of m.ctor.reads) edges.push({ kind: 'reads', source: 'artifact', circuit: self, field: q(m.label, r.field), via: [...r.via] });
      const sc = src.find((x) => x.name === 'constructor');
      for (const d of sc?.discloses ?? []) edges.push({ kind: 'discloses', source: 'source', circuit: self, at: `${m.source}:${d.line}`, text: d.text, via: [...d.via] });
    }
    for (const c of m.circuits) {
      const self = q(m.label, c.name);
      for (const r of c.reads) edges.push({ kind: 'reads', source: 'artifact', circuit: self, field: q(m.label, r.field), via: [...r.via] });
      for (const w of c.writes) edges.push({ kind: 'writes', source: 'artifact', circuit: self, field: q(m.label, w.field), via: [...w.via] });
      for (const w of c.witnesses) edges.push({ kind: 'witness', source: 'artifact', circuit: self, witness: q(m.label, w.witness), via: [...w.via] });
      for (const k of c.kernel) edges.push({ kind: 'kernel', source: 'artifact', circuit: self, through: k.through, slot: k.slot, access: k.kind, via: [...k.via] });
      for (const u of c.uses) edges.push({ kind: 'uses', source: 'artifact', circuit: self, callee: q(m.label, u.circuit), via: [...u.via] });
      for (const x of c.calls) {
        // `__compactContractsImport_Acct` names the IMPORT, and the import is
        // the account's generated module through the `contracts/Acct` symlink.
        // The callee is resolved by which contract actually declares the
        // circuit, so a renamed import does not silently retarget the edge.
        const owner = models.find((o) => o.label !== m.label && o.circuits.some((cc) => cc.name === x.circuit));
        if (!owner) {
          // AN UNRESOLVED CALLEE STOPS THE REACHABILITY WALK, so it is a
          // refusal rather than an edge with a label that can never match.
          // Both callees resolve today only because there are exactly two
          // contracts; a third would make this silent.
          throw new Error(
            `edge-list: ${self} calls "${x.contract}.${x.circuit}" and no contract in ARTIFACTS declares that circuit. ` +
              'The payment path would stop there and every field beyond it would be reported cold. Nothing was emitted.',
          );
        }
        edges.push({ kind: 'calls', source: 'artifact', circuit: self, callee: q(owner.label, x.circuit), via: [...x.via] });
      }
      const sc = src.find((s) => s.name === c.name);
      for (const d of sc?.discloses ?? []) {
        edges.push({ kind: 'discloses', source: 'source', circuit: self, at: `${m.source}:${d.line}`, text: d.text, via: [...d.via] });
      }
    }
  }

  /* ---- client edges ---- */
  const files = clientFiles(root);
  let resolved = 0;
  let unresolved = 0;
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const shape of SHAPES) {
      for (const hit of text.matchAll(shape.re)) {
        const name = hit[1];
        const owner = resolveContract(name, text, models);
        if (owner === null) continue; // not a circuit of either contract
        const from = `${rel}:${lineAt(text, hit.index ?? 0)}`;
        if ('ambiguous' in owner) {
          unresolved += 1;
          edges.push({ kind: 'invokes-unresolved', source: 'client', from, shape: shape.name, note: `"${name}" is declared by ${owner.ambiguous.join(' and ')} and this file imports neither artifact directly` });
          continue;
        }
        resolved += 1;
        edges.push({ kind: 'invokes', source: 'client', from, circuit: q(owner.label, name), shape: shape.name });
      }
    }
    for (const shape of DYNAMIC) {
      for (const hit of text.matchAll(shape.re)) {
        unresolved += 1;
        edges.push({ kind: 'invokes-unresolved', source: 'client', from: `${rel}:${lineAt(text, hit.index ?? 0)}`, shape: shape.name, note: 'the circuit is a runtime string; there is no name at this call site' });
      }
    }
  }

  /* ---- module-to-module edges ---- */
  /*
   * THE SAME FILE LIST THE CIRCUIT SCAN USED, so the two halves of this list
   * cannot disagree about which files exist. `read` and `exists` are handed in
   * rather than reached for inside the walker: everything the walker DECIDES
   * lives in `scripts/module-graph.ts`, where a test can hand it a fixture and
   * watch an assertion go red without breaking this tree.
   */
  const graph = buildModuleGraph({
    files,
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => { try { return statSync(join(root, rel)).isFile(); } catch { return false; } },
    invocations: edges.flatMap((e) => (e.kind === 'invokes' ? [{ from: e.from.split(':')[0], circuit: e.circuit }] : [])),
    /*
     * BOTH KINDS, AND THE CROSS-CONTRACT ONE IS THE POINT. `Vault.payout` lands
     * `ConfidentialAccount.recordPayment` on chain and no import says so; the
     * same pair of edge kinds is what the heat flag walks, so the two columns
     * cannot disagree about what a circuit runs.
     */
    circuitCalls: edges.flatMap((e) => ((e.kind === 'calls' || e.kind === 'uses') ? [{ from: e.circuit, to: e.callee }] : [])),
  });

  for (const e of graph.edges) {
    edges.push({ kind: 'imports', source: 'module', from: e.from, to: e.to, spec: e.spec, at: `${e.from}:${String(e.line)}` });
  }
  for (const u of graph.unresolved) {
    edges.push({
      kind: 'imports-unresolved', source: 'module', from: u.from, spec: u.spec,
      at: `${u.from}:${String(u.line)}`,
      note: `nothing on disk answers to this specifier; ${String(u.tried.length)} name(s) were tried`,
    });
  }

  /*
   * A MODULE THAT COULD NOT BE READ IS A REFUSAL AND NOT A SHORTER GRAPH.
   * The circuit scan above has already read every one of these files, so
   * reaching here means the second read failed where the first succeeded --
   * which is a tree changing underneath a running walk, and a graph built half
   * from before and half from after is worse than none.
   */
  if (graph.unreadable.length > 0) {
    throw new Error(
      `edge-list: ${String(graph.unreadable.length)} module(s) could not be read while the graph was built, ` +
        `after the same files had been read once: ${graph.unreadable.map((u) => u.file).join(', ')}. ` +
        'Nothing was emitted, because a graph missing a node is indistinguishable from a module nothing imports.',
    );
  }

  /*
   * A DECLARED MEMBER THAT IS NOT THERE EMPTIES ITS OWN ROW AND NOTHING ELSE
   * GOES RED, which is the failure the payment roots are checked against below
   * and the same answer applies: refuse, and name what is missing.
   */
  const byFile = new Map(graph.modules.map((m) => [m.file, m]));
  const declaredButAbsent = absentFrom(MONEY_PATH, graph.modules.map((m) => m.file));
  if (declaredButAbsent.length > 0) {
    throw new Error(
      `edge-list: the reference is declared over ${declaredButAbsent.join(', ')}, which the walk did not find. ` +
        'Each one would render as a module with no imports, no importers and no reachable circuits — ' +
        'a row that reads as a measurement and is an absence. Nothing was emitted.',
    );
  }

  /* ---- the payment path ---- */
  /*
   * FORWARD REACHABILITY FROM THE THREE ROOTS THE BRIEF NAMES, and nothing
   * wider. `Vault.retire` also calls the account (`retireVault`) and is NOT a
   * payment root — that edge is in the list and a reader can see it, but
   * folding it into `hot` would make the heat flag mean "touched by anything
   * cross-contract", which is not the question `SC8` is asking.
   */
  const roots = [...PAYMENT_ROOTS];
  // A ROOT THAT IS NOT IN THE GRAPH IS A SILENTLY EMPTY WALK. Rename `payout`
  // in a rebuild and every field only it touches reads `cold`, with nothing
  // red anywhere — the heat flag would go on being printed, about nothing.
  // A check over nothing cannot fail.
  const allCircuits = new Set(models.flatMap((m) => m.circuits.map((c) => q(m.label, c.name))));
  const absent = roots.filter((r) => !allCircuits.has(r));
  if (absent.length > 0) {
    throw new Error(
      `edge-list: the payment path is rooted at ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not a circuit ` +
        'of either contract. Every field reachable only from there would be reported cold. ' +
        'PAYMENT_ROOTS in scripts/edge-list.ts is out of date with the contracts. Nothing was emitted.',
    );
  }
  const reach = new Set<string>();
  const frontier = [...roots];
  while (frontier.length > 0) {
    const cur = frontier.pop() as string;
    if (reach.has(cur)) continue;
    reach.add(cur);
    // BOTH EDGE KINDS. `Vault.payout` reaches `ConfidentialAccount.recordPayment`
    // across contracts and `Vault.payoutDetails` inside its own — a heat flag
    // that followed only the first would call every pure circuit on the spend
    // path cold.
    for (const e of edges) {
      if ((e.kind === 'calls' || e.kind === 'uses') && e.circuit === cur && !reach.has(e.callee)) frontier.push(e.callee);
    }
  }
  const hotFields = new Set<string>();
  for (const e of edges) {
    if ((e.kind === 'reads' || e.kind === 'writes') && reach.has(e.circuit)) hotFields.add(e.field);
  }

  const contracts = models.map((m) => ({
    label: m.label,
    source: m.source,
    artifact: m.artifact,
    fields: m.fields.map((f) => {
      const qualified = q(m.label, f.name);
      return {
        name: f.name,
        qualified,
        index: f.index as number | number[],
        storage: f.storage,
        writers: [...new Set(edges.filter((e) => e.kind === 'writes' && e.field === qualified).map((e) => (e as { circuit: string }).circuit))].sort(),
        readers: [...new Set(edges.filter((e) => e.kind === 'reads' && e.field === qualified).map((e) => (e as { circuit: string }).circuit))].sort(),
        writtenByConstructor: edges.some((e) => e.kind === 'writes-at-construction' && (e as { field: string }).field === qualified),
        hot: hotFields.has(qualified),
      };
    }),
    circuits: m.circuits.map((c) => ({ name: c.name, qualified: q(m.label, c.name), pure: c.pure, signature: c.signature })),
  }));

  const modules = graph.modules.map((m) => ({
    file: m.file,
    importedBy: [...m.importedBy],
    external: [...m.external],
    builtin: [...m.builtin],
    circuits: [...m.circuits],
    circuitsReached: [...m.circuitsReached],
    exportedNames: [...new Set(m.exports.map((x) => x.name))].sort(),
    refusalCount: m.refusals.length,
    byteWidthSites: m.byteWidths.length,
  }));

  return {
    compiler: { compact: models[0].compilerVersion, language: models[0].languageVersion, runtime: models[0].runtimeVersion },
    contracts,
    edges,
    paymentPath: { roots, circuits: [...reach].sort(), fields: [...hotFields].sort() },
    coverage: {
      clientFilesScanned: files.length,
      resolvedInvocations: resolved,
      unresolvedInvocations: unresolved,
      renamingLayers: [
        'src/midnight/ledger.ts — MidnightLedger: addSigner/removeSigner both reach amendSigner; proposeRun reaches propose',
        'src/midnight/commitments.ts — MidnightCommitments: assetKey/proposalId/changeCommitment rename assetKeyOf/proposalIdOf/changeCommitmentOf',
        'contracts/test/simulator.ts — AccountSimulator: addSigner/removeSigner reach amendSigner; proposeRun reaches propose',
        'src/core/ledger.ts — LedgerPort/SimulatedLedger: method names SHADOW circuit names and reach no circuit at all',
        'src/midnight/vault-recovery.ts, src/midnight/payout-tree.ts — circuits passed as function-valued parameters; no name at the call site',
      ],
    },
    modules,
    moneyPath: MONEY_PATH.map((f) => byFile.get(f) as ModuleNode),
    moduleCoverage: {
      modulesWalked: graph.modules.length,
      importEdges: graph.edges.length,
      unreadableModules: graph.unreadable.length,
      unresolvedSpecifiers: graph.unresolved.length,
      resolvedOutsideTheWalkedSet: graph.outsideTheWalkedSet.length,
      declaredButAbsent,
      shapes: IMPORT_SHAPES.map((x) => x.name),
      /*
       * WHAT THE MODULE WALK CANNOT SEE, NAMED RATHER THAN IMPLIED COMPLETE.
       * The circuit scan carries the same section for the same reason: a graph
       * that omits silently cannot be questioned.
       */
      knownBlind: [
        'a specifier built from a variable — there is no name at the site, exactly as at a dynamic circuit dispatch',
        'a multi-line import whose brace list carries a semicolon inside a comment — measured at zero occurrences here',
        'the second and any later static import statement written on one physical line — this occurs ONCE in this tree and costs two platform modules',
        'an indented static import — measured at zero occurrences here; the column-zero anchor is what keeps prose out of the graph',
        'a dynamic import written on a line this treats as a comment line',
        'the text of a dynamic import written inside a string is MATCHED rather than missed — it invents a dependency, and the two shapes that can do it now refuse a match preceded by a dot, a quote, a backtick or a word character',
        're-exports are edges to the module named, never to wherever the name was originally declared',
        'a specifier naming a real file outside these three trees — a compiled contract module, a config, a probe tree — is counted above and is not an edge',
      ],
    },
  };
}
