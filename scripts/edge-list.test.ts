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
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { CLIENT_TREES, DYNAMIC, PAYMENT_ROOTS, SHAPES, buildEdgeList, type EdgeList } from './edge-list.js';
import { EDGE_LIST_FILE } from './doc-registry.js';

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
    expect(edges.coverage.clientFilesScanned).toBeGreaterThan(200);
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
    for (const e of edges.edges) expect(['artifact', 'source', 'client']).toContain(e.source);
    // `disclose` cannot come from the artifact and nothing else may come from
    // the source: the compiler erases disclose and nothing else is missing.
    for (const e of edges.edges) {
      if (e.kind === 'discloses') expect(e.source).toBe('source');
      if (e.source === 'source') expect(e.kind).toBe('discloses');
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

  it('every new door is on disk and executable — a refusal may not name a door nobody can open', () => {
    for (const door of ['DOCS.command', 'WHAT-BREAKS.command', 'CITATIONS.command']) {
      const st = statSync(join(ROOT, door));
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o111).toBeGreaterThan(0);
    }
  });
});
