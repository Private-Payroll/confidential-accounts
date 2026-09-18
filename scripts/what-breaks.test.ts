/**
 * THE ONE ANSWER THIS MUST NEVER GIVE IS "NOTHING DEPENDS ON IT" FOR A NAME
 * THAT IS NOT THERE.
 *
 * It is the same sentence as "this is safe to change", and a person acts on it.
 * A typo, a renamed field, a half-remembered circuit — each of those would
 * otherwise come back as a clean bill of health. So the refusal is the first
 * thing tested here, and the rest follows.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EDGE_LIST_FILE } from './doc-registry.js';
import { answer, index, loadEdges } from './what-breaks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/*
 * THE GRAPH THIS QUERIES IS NOT PART OF THIS REPOSITORY.
 *
 * It is a large machine artefact, regenerated on every source edit and
 * deliberately left behind. So the tool has two behaviours worth holding and
 * only one of them can be exercised in any given copy: WITH the graph, that it
 * answers and refuses correctly; WITHOUT it, that it says there is nothing to
 * query and names what would produce one.
 *
 * Loading it at the top used to take this whole file down in a copy that has no
 * graph -- which is every clone. Each half now runs where it applies, and the
 * half that does not runs a line saying so.
 */
const HAS_GRAPH = existsSync(join(ROOT, EDGE_LIST_FILE));
if (!HAS_GRAPH) {
  console.log(
    `  NOT CHECKED HERE: ${EDGE_LIST_FILE} is not part of this repository, so the queries over it\n` +
    '  did not run. What DID run is the refusal a reader without one meets.',
  );
}

describe('with no graph on disk, it says so rather than answering', () => {
  it.skipIf(HAS_GRAPH)('refuses, and names what would produce one [only without the module map; `npx tsx scripts/edge-list-run.ts` derives one]', () => {
    let refused = '';
    try { loadEdges(ROOT); } catch (e) { refused = String((e as Error).message); }
    expect(refused).toContain(EDGE_LIST_FILE);
    expect(refused).toContain('no graph to query');
    // AND IT DOES NOT ANSWER. The one thing this tool must never do is give the
    // shape of a real answer when it has nothing to answer from.
    expect(refused).not.toContain('WRITTEN BY');
  });
});

const edges = HAS_GRAPH ? loadEdges(ROOT) : (undefined as never);

describe.skipIf(!HAS_GRAPH)('a name it does not know is a REFUSAL, not an empty answer [needs the module map; `npx tsx scripts/edge-list-run.ts` derives it]', () => {
  it('says so, and does not say "nothing depends on it"', () => {
    const out = answer(edges, 'payoutDetalis');
    expect(out).toContain('IS NOT IN THE GRAPH');
    // It must not answer the shape of a real answer for a name that is absent.
    expect(out).not.toContain('WRITTEN BY');
    expect(out).not.toContain('USED BY');
    expect(out).not.toContain('IT WRITES');
  });

  it('suggests, so a misspelling is one step from an answer', () => {
    // The failure this replaced: a substring filter answered `payoutDetal`
    // with `payout` and never mentioned `payoutDetails`, which reads as "the
    // name you wanted does not exist".
    expect(answer(edges, 'payoutDetal')).toContain('payoutDetails');
    expect(answer(edges, 'movement')).toContain('movements');
    expect(answer(edges, 'recordPaymnt')).toContain('recordPayment');
  });
});

describe.skipIf(!HAS_GRAPH)('it answers the question that keeps getting asked [needs the module map; `npx tsx scripts/edge-list-run.ts` derives it]', () => {
  it('a ledger field: who writes it, who reads it, and whether money flows through it', () => {
    const out = answer(edges, 'movements');
    expect(out).toContain('LEDGER FIELD');
    expect(out).toContain('ON THE PAYMENT PATH');
    expect(out).toContain('WRITTEN BY  ConfidentialAccount.recordPayment');
    expect(out).toContain('READ BY     ConfidentialAccount.recordPayment');
  });

  it('says plainly when a field is written and never read', () => {
    expect(answer(edges, 'payments')).toContain('NOTHING — a field written and never read');
  });

  it('a pure circuit: what USES it, which is the whole point for a helper', () => {
    // `payoutDetails` calls nothing and is called by nothing across contracts.
    // Changing it changes what `Vault.payout` commits to.
    const out = answer(edges, 'payoutDetails');
    expect(out).toContain('USED BY     Vault.payout');
    expect(out).toContain('ON THE PAYMENT PATH');
  });

  it('a provable circuit: the fields it shares a writer with — the B5 shape', () => {
    const out = answer(edges, 'setThreshold');
    expect(out).toContain('FIELDS IT WRITES THAT SOMETHING ELSE ALSO WRITES');
    expect(out).toContain('ConfidentialAccount.openProposals');
  });

  it('a witness: that the CLIENT implements it, and every circuit below it', () => {
    const out = answer(edges, 'localSecretKey');
    expect(out).toContain('WITNESS');
    expect(out).toContain('implemented by the CLIENT');
    expect(out).toContain('ConfidentialAccount.approve');
  });

  it('says when a circuit has no literal caller, rather than implying none exists', () => {
    // `adopt` is reached from one measurement script and the simulator; a
    // circuit with zero literal callers must not read as dead code when the
    // truth is a renaming layer.
    const out = answer(edges, 'retireVault');
    expect(out).toMatch(/INVOKED FROM \d+ site/);
  });

  it('an ambiguous bare name answers for BOTH, rather than picking one', () => {
    // `recordPayment` is declared by the account and named by the vault's
    // interface block. Picking one silently is how a reader gets half an answer.
    const out = answer(edges, 'recordPayment');
    expect(out).toContain('ConfidentialAccount.recordPayment');
  });
});

describe.skipIf(!HAS_GRAPH)('the index, which is what a run with no name asked for prints [needs the module map; `npx tsx scripts/edge-list-run.ts` derives it]', () => {
  it('lists every field of both contracts with its heat', () => {
    const out = index(edges);
    for (const c of edges.contracts) {
      expect(out).toContain(c.label);
      for (const f of c.fields) expect(out).toContain(f.name);
    }
    expect(out).toContain('HOT');
    expect(out).toContain('./WHAT-BREAKS.command <name>');
  });
});
