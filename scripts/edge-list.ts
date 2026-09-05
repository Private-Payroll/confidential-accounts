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
 * `AccountSimulator`'s methods rename again. Two dispatchers pick the circuit
 * from a RUNTIME STRING — `src/midnight/ledger.ts:1653` and
 * `src/midnight/vault-ledger.ts:530` — so at those two lines there is no name in
 * the text at all.
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

export type EdgeSource = 'artifact' | 'source' | 'client';

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
  | { kind: 'invokes-unresolved'; source: 'client'; from: string; shape: string; note: string };

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
  // `C238`: a check over nothing cannot fail.
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
  };
}
