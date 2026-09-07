/**
 * THE EDGE LIST IS EVIDENCE FOR A DECISION ABOUT THE CONTRACT'S SHAPE, so what
 * it gets wrong is not a documentation defect.
 *
 * `SC8` reads it to decide whether the account contract is edited or rebuilt,
 * and whether its state should be grouped by writer and heat instead of by
 * subject. The two things it must not do are attribute a WRITER that is not
 * there and omit one that is — `B5` reopens on exactly the first — and mark a
 * field cold that the spend path reaches.
 *
 * The last group asserts against the real contracts. That is deliberate: a test
 * over fixtures alone proves the code can compute a graph, not that the graph
 * it computes is this repository's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { CLIENT_TREES, DYNAMIC, MONEY_PATH, PAYMENT_ROOTS, SHAPES, buildEdgeList, type EdgeList } from './edge-list.js';
import { EDGE_LIST_FILE, GENERATED_BLOCKS, GENERATED_FILES } from './doc-registry.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let edges: EdgeList;

beforeAll(async () => { edges = await buildEdgeList(ROOT); }, 60_000);

const field = (q: string) => edges.contracts.flatMap((c) => c.fields).find((f) => f.qualified === q);

describe('WRITERS — the half `B5` turns on', () => {
  it('names every writer of a field, including ones that reach it through a helper', () => {
    // `closeProposal` writes four fields on behalf of eight circuits. A
    // direct-only scan credits none of them and the table says those fields
    // have one writer.
    expect(field('ConfidentialAccount.openProposals')?.writers.sort()).toEqual([
      'ConfidentialAccount.adopt', 'ConfidentialAccount.amendSigner', 'ConfidentialAccount.cancel',
      'ConfidentialAccount.closeExpiredRun', 'ConfidentialAccount.propose', 'ConfidentialAccount.retireVault',
      'ConfidentialAccount.setThreshold', 'ConfidentialAccount.setVaultThreshold',
    ]);
  });

  it('does NOT credit a writer that only reads', () => {
    // `recordPayment` reads `openProposals` through `requireApprovedForVault`
    // and never writes it. A scan that took `ins` for granted would say it does.
    expect(field('ConfidentialAccount.openProposals')?.writers).not.toContain('ConfidentialAccount.recordPayment');
    expect(field('ConfidentialAccount.openProposals')?.readers).toContain('ConfidentialAccount.recordPayment');
  });

  it('NO CIRCUIT WRITES `Vault.account` — AND THE CONSTRUCTOR DOES, and both are said', () => {
    // THIS TEST PREVIOUSLY PINNED THE WRONG VALUE. It asserted `writers: []`
    // with a comment noting the constructor writes it — so the omission was
    // held in place by a passing test and a correction would have read as a
    // regression. `C286` is the row: what makes the vault unredirectable is
    // ONLY that no circuit writes `account` — no assert, no guard, no keyword —
    // and an empty cell restates that absence as though it were a guarantee.
    // In Compact a record or map value is written whole, so merging `account`
    // into a record hands every writer of that record a writer for the contract
    // reference every payout settles against.
    expect(field('Vault.account')?.writers).toEqual([]);
    expect(field('Vault.account')?.writtenByConstructor).toBe(true);
    expect(field('Vault.account')?.readers.length).toBeGreaterThan(0);
    // The constructor is never counted among the circuit writers, of anything.
    for (const c of edges.contracts) {
      for (const f of c.fields) {
        expect(f.writtenByConstructor).toBe(true);
        expect(f.writers).not.toContain(`${c.label}.constructor`);
      }
    }
    // And it is a separate edge kind, so it cannot be folded in by accident.
    expect(edges.edges.some((e) => e.kind === 'writes-at-construction' && (e as { field: string }).field === 'Vault.account')).toBe(true);
  });

  it('THE THREE RESERVED FIELDS ARE WRITTEN BY NOTHING — AND THE CONSTRUCTOR WRITES THEM, and both are said', () => {
    /*
     * `S35c` declared four ledger fields for features that do not exist, because
     * storage is fixed at construction and circuits are not. Three of them are
     * declarations and NOTHING ELSE, and that is a property somebody can break
     * in one line while believing they are finishing a job.
     *
     * `C286` is why this is asserted rather than commented: `successor`'s own
     * declaration says nothing writes it *and for no other reason*, which is
     * exactly the sentence that reads as a guarantee when what holds it is an
     * absence. `Vault.account` is the same class and is pinned above; these are
     * its three new neighbours.
     */
    for (const q of ['ConfidentialAccount.proposalHolds',
                     'ConfidentialAccount.successor',
                     'ConfidentialAccount.signerRoles']) {
      expect(field(q)?.writers).toEqual([]);
      expect(field(q)?.readers).toEqual([]);
      // The other half, so the empty cell above is not read as "unreachable".
      expect(field(q)?.writtenByConstructor).toBe(true);
    }
    // And the fourth one IS written, by exactly one circuit.
    expect(field('ConfidentialAccount.retiredAt')?.writers).toEqual(['ConfidentialAccount.retireVault']);
  });

  it('`propose` is the only VALUE-writer of `runWindow`, which is what B5 rests on', () => {
    /*
     * This column counts a REMOVAL as a write, and `closeProposal`
     * removes the window on behalf of every circuit that closes a proposal — so
     * the writer set below is eight names and the number that matters is ONE.
     * The distinction is the whole of `B5`: `cancel` can be trusted to know
     * whether a run has started only while nothing but `propose` puts a window
     * on chain, and `approve` in particular must never appear here.
     */
    const writers = field('ConfidentialAccount.runWindow')?.writers ?? [];
    expect(writers).toContain('ConfidentialAccount.propose');
    expect(writers).not.toContain('ConfidentialAccount.approve');
    expect(writers).not.toContain('ConfidentialAccount.recordPayment');
    // And the two circuits that READ it are the two that tell a run from a
    // governance proposal, and nothing else.
    expect(field('ConfidentialAccount.runWindow')?.readers.sort()).toEqual([
      'ConfidentialAccount.cancel', 'ConfidentialAccount.closeExpiredRun',
    ]);
  });

  it('reports a field written and never read — the C354 shape, visible on sight', () => {
    expect(field('Vault.payments')?.writers.length).toBeGreaterThan(0);
    expect(field('Vault.payments')?.readers).toEqual([]);
  });
});

describe('HEAT — what the payment path reaches', () => {
  it('follows cross-contract calls out of the vault into the account', () => {
    expect(edges.paymentPath.circuits).toContain('Vault.payout');
    expect(edges.paymentPath.circuits).toContain('ConfidentialAccount.recordPayment');
  });

  it('follows INTRA-contract circuit calls too, or every pure helper reads cold', () => {
    // `Vault.payout` calls `payoutDetails`; `recordPayment` calls `payoutLeaf`
    // and `paidMovementOf`. All pure, all touching no field — so a reachability
    // walk over cross-contract edges alone calls them cold, and "nothing
    // depends on payoutLeaf" is the same answer as "safe to change".
    expect(edges.paymentPath.circuits).toContain('Vault.payoutDetails');
    expect(edges.paymentPath.circuits).toContain('ConfidentialAccount.payoutLeaf');
    expect(edges.paymentPath.circuits).toContain('ConfidentialAccount.paidMovementOf');
  });

  it('marks the fields the path touches hot and leaves the rest cold', () => {
    for (const q of ['ConfidentialAccount.movements', 'ConfidentialAccount.thresholds', 'Vault.notes', 'Vault.payments']) {
      expect(field(q)?.hot).toBe(true);
    }
    // Signer governance and the vault registry are NOT on the payment path.
    for (const q of ['ConfidentialAccount.signers', 'ConfidentialAccount.signerLeaves', 'ConfidentialAccount.vaults']) {
      expect(field(q)?.hot).toBe(false);
    }
  });

  it('THE CONTENTION IS VISIBLE — a cold-written field the spend path reads', () => {
    // This is the retirement/payment shape SC8 was told to look for, and the
    // list is the evidence for it: `thresholds` is written only by governance
    // and read by `recordPayment`.
    const t = field('ConfidentialAccount.thresholds');
    expect(t?.hot).toBe(true);
    expect(t?.writers).toEqual(['ConfidentialAccount.setVaultThreshold']);
    expect(t?.readers).toEqual(['ConfidentialAccount.recordPayment']);
  });

  it('does NOT fold `retire` into the payment path, though it also calls across', () => {
    // Widening heat to "anything cross-contract" would make the flag mean
    // something else. `Vault.retire → ConfidentialAccount.retireVault` is in
    // the list and a reader can see it.
    expect(edges.paymentPath.circuits).not.toContain('Vault.retire');
    expect(edges.edges.some((e) => e.kind === 'calls' && e.circuit === 'Vault.retire')).toBe(true);
  });
});

describe('the list says what it does NOT know', () => {
  it('THE SCAN TABLES ARE PINNED — dropping a shape is silent otherwise', () => {
    // An auditor dropped 7 of the 10 literal-name shapes, both dynamic shapes,
    // and two of the three scanned trees, and the suite stayed green every
    // time: nothing asserted what the scanner LOOKS for, only that the numbers
    // it produced were self-consistent.
    expect(SHAPES.map((s) => s.name)).toEqual([
      'impureCircuits.X', 'provableCircuits.X', 'callTx.X', 'pureCircuits.X',
      "circuit: 'X'", "call(addr, 'X')", "planCall('X')", "Opts('X')",
      "createCircuitContext('X')", "run('X')",
    ]);
    expect(DYNAMIC.map((s) => s.name)).toEqual(['callTx[<expr>]', 'createCallTxOptions(<expr>)']);
    expect(CLIENT_TREES).toEqual(['src', 'scripts', 'contracts/test']);
  });

  it('COVERAGE IS A MEASUREMENT, so it carries floors rather than only self-consistency', () => {
    // `expect(unresolved.length).toBe(coverage.unresolvedInvocations)` is the
    // counter agreeing with the array it was incremented beside. These are the
    // numbers printed into a public document, so they get floors.
    // `clientFilesScanned` IS THE SAME NUMBER AS `modulesWalked` — one file
    // list, counted twice — so it is asserted as equal rather than floored
    // twice, and the module-graph block carries the tighter floor.
    expect(edges.coverage.clientFilesScanned).toBe(edges.moduleCoverage.modulesWalked);
    expect(edges.coverage.resolvedInvocations).toBeGreaterThan(300);
    // And the dynamic dispatchers are FOUND, not merely counted: with both
    // dynamic shapes deleted the old test still passed, because ambiguous
    // resolutions bump the same counter.
    const shapes = edges.edges.filter((e) => e.kind === 'invokes-unresolved').map((e) => (e as { shape: string }).shape);
    expect(shapes).toContain('callTx[<expr>]');
    // The two product dispatchers, by file, so a rename cannot hide them.
    const from = edges.edges.filter((e) => e.kind === 'invokes-unresolved').map((e) => (e as { from: string }).from.split(':')[0]);
    expect(from).toContain('src/midnight/ledger.ts');
    expect(from).toContain('src/midnight/vault-ledger.ts');
  });

  it('THE PAYMENT ROOTS ARE PINNED, and a root that has vanished is a refusal', () => {
    // The root set is a judgement, not a measurement, and it was three string
    // literals inside a walk. Rename `payout` in a rebuild and every field only
    // it touches reads cold with nothing red — the flag would go on being
    // printed, about nothing.
    expect(PAYMENT_ROOTS).toEqual([
      'ConfidentialAccount.recordPayment', 'Vault.payout', 'Vault.payoutUnshielded',
    ]);
    for (const r of PAYMENT_ROOTS) {
      expect(edges.contracts.flatMap((c) => c.circuits).map((c) => c.qualified)).toContain(r);
    }
  });

  it('counts unresolved dynamic dispatch instead of dropping it', () => {
    expect(edges.coverage.unresolvedInvocations).toBeGreaterThan(0);
    const unresolved = edges.edges.filter((e) => e.kind === 'invokes-unresolved');
    expect(unresolved.length).toBe(edges.coverage.unresolvedInvocations);
    // Each one names a real file and line a person can open.
    for (const e of unresolved) {
      const [file] = (e as { from: string }).from.split(':');
      expect(existsSync(join(ROOT, file))).toBe(true);
    }
  });

  it('names the renaming layers, because a reader cannot infer them', () => {
    expect(edges.coverage.renamingLayers.length).toBeGreaterThanOrEqual(5);
    expect(edges.coverage.renamingLayers.join('\n')).toContain('amendSigner');
  });

  it('every edge carries which instrument produced it', () => {
    // `module` JOINED THIS LIST WITH THE IMPORT GRAPH and the list is asserted
    // rather than derived: an edge with an instrument nobody named is an edge a
    // reader cannot weigh, and the four are not equally sure of themselves.
    for (const e of edges.edges) expect(['artifact', 'source', 'client', 'module']).toContain(e.source);
    // `disclose` cannot come from the artifact and nothing else may come from
    // the source: the compiler erases disclose and nothing else is missing.
    for (const e of edges.edges) {
      if (e.kind === 'discloses') expect(e.source).toBe('source');
      if (e.source === 'source') expect(e.kind).toBe('discloses');
    }
  });
});

describe('THE IMPORT GRAPH — the half that did not exist', () => {
  it('THE DECLARED SET IS PINNED, and every member is a module the walk found', () => {
    // RED WHEN: a path is removed from MONEY_PATH, or one is added that is not
    // on disk. The list is a SECOND COPY of a set declared elsewhere and
    // nothing reconciles the two, so the only thing standing between a
    // silently shorter reference and a reader is this assertion.
    expect(MONEY_PATH).toEqual([
      'src/midnight/payout-tree.ts', 'src/midnight/run-keys.ts', 'src/midnight/commitments.ts',
      'src/core/signer-leaf.ts', 'src/core/crypto.ts', 'src/midnight/payee-address.ts',
      'src/core/payslip-key.ts', 'src/core/payslip-key-derive.ts',
      'src/midnight/ledger.ts', 'src/midnight/vault-ledger.ts', 'src/midnight/vault-notes.ts',
      'src/midnight/vault-coins.ts', 'src/core/movement.ts', 'src/midnight/run-status.ts',
    ]);
    expect(edges.moduleCoverage.declaredButAbsent).toEqual([]);
    expect(edges.moneyPath.map((m) => m.file)).toEqual([...MONEY_PATH]);
    for (const f of MONEY_PATH) expect(existsSync(join(ROOT, f))).toBe(true);
    /*
     * AND THE TIER IS THE FIRST EIGHT, WHICH THE ARRAY ALONE DOES NOT SAY.
     * `scripts/generate-docs.ts` reads tier off array POSITION, so reordering
     * this list republishes a boundary module as one that computes a value the
     * contracts compare — and the two tiers owe different halves of the parity
     * rule. RED WHEN: an entry moves across the eighth position.
     */
    expect(MONEY_PATH.slice(0, 8)).toEqual([
      'src/midnight/payout-tree.ts', 'src/midnight/run-keys.ts', 'src/midnight/commitments.ts',
      'src/core/signer-leaf.ts', 'src/core/crypto.ts', 'src/midnight/payee-address.ts',
      'src/core/payslip-key.ts', 'src/core/payslip-key-derive.ts',
    ]);
  });

  it('THE HOLES ARE COUNTED, INCLUDING THE BIG ONE THAT IS NOT A DEFECT', () => {
    // A specifier naming a real file outside the three walked trees is not an
    // edge and not an error — a compiled contract module is a real dependency
    // of a test and not a module of this graph — and it is 86 sites here, the
    // largest single thing the graph does not draw. Counted where the other
    // holes are counted. RED WHEN: the counter is dropped, or the branch that
    // records it is removed.
    expect(edges.moduleCoverage.resolvedOutsideTheWalkedSet).toBeGreaterThan(50);
  });

  it('REACHING CROSSES THE CONTRACT BOUNDARY, so the column answers its own heading', () => {
    // `Vault.payout` lands `ConfidentialAccount.recordPayment` on chain and no
    // IMPORT says so. Before the second closure, the vault boundary reached 24
    // circuits and not that one — the column read as an upper bound on what can
    // end up on chain and was a lower one. RED WHEN: `circuitCalls` stops being
    // passed to the walker, or the second flood is removed.
    const vault = edges.modules.find((m) => m.file === 'src/midnight/vault-ledger.ts');
    expect(vault?.circuits).toContain('Vault.payout');
    expect(vault?.circuits).not.toContain('ConfidentialAccount.recordPayment');
    expect(vault?.circuitsReached).toContain('ConfidentialAccount.recordPayment');
    // And the cross-contract edge it rides is in this same list, so a reader
    // can follow the hop rather than take the column's word for it.
    expect(edges.edges.some((e) => e.kind === 'calls' && e.circuit === 'Vault.payout'
      && e.callee === 'ConfidentialAccount.recordPayment')).toBe(true);
  });

  it('THERE ARE MODULE-TO-MODULE EDGES AT ALL, which is the whole point of the row', () => {
    // Before this existed every client edge ran from a file to a CIRCUIT and
    // none ran from a file to a file — 529 to 0 — so nothing could draw the
    // layers. A floor rather than a self-consistency check: the count is the
    // measurement, so it gets a number to fall below.
    const imports = edges.edges.filter((e) => e.kind === 'imports');
    expect(imports.length).toBeGreaterThan(800);
    expect(edges.moduleCoverage.importEdges).toBe(imports.length);
    expect(edges.moduleCoverage.modulesWalked).toBe(edges.modules.length);
    // 309 TODAY, AND NINE FILES OF SLACK IS THE TIGHTEST FLOOR HERE. A red on
    // this line means COUNT THE FILES, not "the walker broke" — a consolidation
    // round that removes ten modules trips it with nothing wrong.
    expect(edges.moduleCoverage.modulesWalked).toBeGreaterThan(300);
  });

  it('EVERY EDGE NAMES TWO FILES THAT EXIST, at both ends', () => {
    // An edge to a path nothing answers to is worse than a missing edge: it
    // reads as a dependency and sends a reader to nothing.
    for (const e of edges.edges) {
      if (e.kind !== 'imports') continue;
      expect(existsSync(join(ROOT, e.from))).toBe(true);
      expect(existsSync(join(ROOT, e.to))).toBe(true);
      expect(e.at.startsWith(`${e.from}:`)).toBe(true);
    }
  });

  it('NOTHING WAS SKIPPED SILENTLY — the two loud counters agree with their lists', () => {
    // A walk that drops what it cannot read reports a graph with a hole in it,
    // and a hole looks exactly like a module nothing imports — a check over
    // nothing cannot fail. Both counters are asserted against their arrays AND
    // against the tree, so a counter incremented beside an empty list fails.
    expect(edges.moduleCoverage.unreadableModules).toBe(0);
    const unresolved = edges.edges.filter((e) => e.kind === 'imports-unresolved');
    expect(edges.moduleCoverage.unresolvedSpecifiers).toBe(unresolved.length);
    /*
     * AND IT IS ZERO TODAY, WHICH IS A STRONGER STATEMENT THAN THE ONE ABOVE.
     * A counter agreeing with the array it was incremented beside says nothing
     * about the tree; this says every specifier in the three client trees
     * resolves. RED WHEN: an import names a file that is not there, or a string
     * literal somewhere carries the text of a dynamic import — which is a real
     * shape and cost three phantom entries the first time this walker read its
     * own test file.
     */
    expect(edges.moduleCoverage.unresolvedSpecifiers).toBe(0);
    for (const e of unresolved) {
      if (e.kind !== 'imports-unresolved') continue;
      expect(existsSync(join(ROOT, e.from))).toBe(true);
    }
  });

  it('REACHING IS WIDER THAN NAMING, and never narrower, for every circuit', () => {
    // The invariant behind the column. A module that names a circuit must
    // reach it; a module that reaches one need not name it, and the difference
    // between the two sets IS the layering the row was opened for. Reversing
    // the walk, or dropping the transitive step, breaks this in one direction
    // each.
    let widened = 0;
    for (const c of edges.contracts) {
      for (const circuit of c.circuits) {
        const naming = edges.modules.filter((m) => m.circuits.includes(circuit.qualified)).map((m) => m.file);
        const reaching = new Set(edges.modules.filter((m) => m.circuitsReached.includes(circuit.qualified)).map((m) => m.file));
        for (const f of naming) expect(reaching.has(f)).toBe(true);
        if (reaching.size > naming.length) widened += 1;
      }
    }
    // And it is wider somewhere, or the transitive walk is not running at all.
    expect(widened).toBeGreaterThan(0);
  });

  it('A MODULE`S OWN EDGES ARE THE INVERSE OF EVERYBODY ELSE`S, over the real tree', () => {
    // The fixture pins this shape; this pins it against 300-odd real modules,
    // where an off-by-one in the inversion is the kind of thing a fixture of
    // two files cannot show.
    const byFile = new Map(edges.modules.map((m) => [m.file, m]));
    for (const e of edges.edges) {
      if (e.kind !== 'imports') continue;
      expect(byFile.get(e.to)?.importedBy).toContain(e.from);
    }
  });
});

describe('the generated artefacts on disk are the ones this produces', () => {
  it('edges.json exists', () => {
    // It used to also assert that "the inputs it declares are all on disk".
    // `edges.json` no longer declares inputs — `T-167` removed the list, because
    // a list of inputs was a proxy that was wrong three times in one round — so
    // that assertion was statusing something nothing consumes.
    expect(existsSync(join(ROOT, EDGE_LIST_FILE))).toBe(true);
  });

  /*
   * THE LIVE `assertDocsFresh(ROOT)` ASSERTION IS NOT HERE, AND THAT IS A RACE
   * RATHER THAN AN OVERSIGHT — do not re-add it.
   *
   * It used to be, as `expect(() => assertDocsFresh(ROOT)).not.toThrow()`.
   * `T-167` made that function ASYNC, and a synchronous matcher on an async
   * function never fails: the arrow returns a promise and throws nothing, so
   * the assertion passed for every possible state of the doc set. An auditor
   * proved it — gate unwired, docs genuinely stale, this file reported PASSED.
   *
   * Awaiting it properly then went red for a second reason, which is the one
   * that decided where it lives: `scripts/doc-freshness.test.ts` TEMPORARILY
   * MODIFIES a file in a scanned tree, on purpose, to watch the gate refuse.
   * vitest runs files in parallel workers, so any other file asserting that the
   * doc set is current is racing that window and fails intermittently — for a
   * correct repository. Two real defects in this project were dismissed as
   * flakiness before.
   *
   * So the live gate assertion has ONE owner, and it is the file that owns the
   * mutation: `scripts/doc-freshness.test.ts`, sequential within itself.
   */

  it('every door a refusal names is one a reader of the published repository can open', () => {
    /*
     * THIS USED TO STAT THREE `.command` FILES, AND IT PASSED FOR THE WRONG
     * REASON. A clone has none of them — they are on no take list and cannot
     * be — so "a refusal may not name a door nobody can open" was checked
     * against a folder the reader does not have. What the doc set's refusals
     * name now is a script in the shipping `package.json`, and that is what is
     * asserted: the script exists, and it runs something that ships.
     */
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.docs).toBe('tsx scripts/docs-run.ts');
    expect(existsSync(join(ROOT, 'scripts/docs-run.ts'))).toBe(true);
    // And the entry point it names is the one the generator's own registry
    // points at, so the two cannot drift into naming different things.
    for (const b of [...GENERATED_BLOCKS, ...GENERATED_FILES]) expect(b.door).toBe('npm run docs');
  });
});
