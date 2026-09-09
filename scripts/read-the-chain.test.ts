/**
 * THE RULES THE CHAIN READ IS HELD TO, AND A WATCHED FAILURE FOR EVERY ONE.
 *
 * ── WHY EVERY ASSERTION HERE CARRIES ITS OWN MUTATION ────────────────────
 *
 * The instrument these rules belong to reads a live chain and writes a report
 * somebody acts on, so it is started by a person and never by whoever wrote it.
 * That leaves an ordinary unit test proving only that the code does what it
 * currently does. **So each rule below is also run against a DELIBERATELY
 * BROKEN COPY of the module, and the test fails if the broken copy passes.**
 * Nine assertions state a rule and nine mutations exist, one each.
 * An assertion that cannot be made to fail is not evidence, and this file makes
 * that a property the suite checks rather than a claim its author makes.
 *
 * ── THE COPY IS OUTSIDE THIS REPOSITORY, AND IT IS A COPY ────────────────
 *
 * Every mutation is applied to text written into the system temporary
 * directory. Nothing in this tree is edited, at any point, by any test in this
 * file - a suite that edits its own repository puts every other file asserting
 * the repository is clean inside its window, and the result is a red run on a
 * correct tree. The copy is also asserted to be a copy: its real path is
 * resolved, this repository's real path is resolved, and the first must not sit
 * under the second. **BOTH SIDES ARE RESOLVED.** A comparison between a
 * resolved path and an unresolved one is true on one operating system and false
 * on another, because a temporary directory is reached through a symbolic link
 * on some of them and not on others.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  sayReading, carriesNumbers, compareField, compareReadbacks, vaultNumbers, verdict,
  type Reading, type Run,
} from './read-the-chain-rules.js';

const RULES = fileURLToPath(new URL('./read-the-chain-rules.ts', import.meta.url));
const REPO = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const SOURCE = readFileSync(RULES, 'utf8');

/**
 * Write a named mutation of the rules module somewhere this repository is not,
 * and hand back its exports.
 *
 * **THE SUBSTITUTION IS REQUIRED TO BITE.** A mutation whose `from` text is no
 * longer in the module applies nothing, and the "broken" copy then passes for
 * the same reason the real one does - a green result that means the opposite of
 * what it looks like. So a miss throws here rather than being discovered as a
 * confusing pass three lines later.
 */
async function broken(name: string, from: string, to: string): Promise<any> {
  if (!SOURCE.includes(from)) {
    throw new Error(
      `the mutation "${name}" no longer matches the rules module, so it changes nothing and `
      + 'the assertion it is meant to break would pass for the wrong reason. Update the '
      + 'mutation to the text that is there now.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'read-the-chain-mutation-'));
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, SOURCE.replace(from, to));

  /* Both sides resolved, for the reason in this file's header. */
  expect(realpathSync(file).startsWith(REPO + '/')).toBe(false);

  return import(pathToFileURL(file).href);
}

const NUMBERS = { threshold: 1, signerCount: 1, openProposals: 0, movementCount: 0 };
const ANSWERED: Reading = { kind: 'answered', numbers: NUMBERS };
const NEVER_ASKED: Reading = { kind: 'never-asked' };
const NO_STATE: Reading = { kind: 'no-state' };

/**
 * Phrases that assert something about the CONTRACT rather than about the read.
 *
 * **THIS IS A NET AND NOT A PROOF, AND SAYING SO IS THE POINT.** A list of
 * phrases catches a rewrite that reaches for one of them and misses one that
 * does not: "there is no state for this contract" evades every entry here. So
 * each sentence is also asserted POSITIVELY, against the words that say a
 * reading did not happen, and that is the assertion doing the work.
 */
const ASSERTS_ABSENCE = /\b(is empty|has no state|is not there|does not exist|nothing is there)\b/i;

describe('an unanswered read is never reported as an answer', () => {
  /*
   * RED WHEN: the sentence for a question that was never sent is replaced by
   * the sentence for a question that was sent and came back with no state.
   */
  it('does not describe a question that was never sent as a fact about the contract', async () => {
    const said = sayReading(NEVER_ASKED);
    expect(said).toMatch(/NOT ASKED/);
    expect(said).toMatch(/no question left this machine/);
    expect(said).not.toMatch(ASSERTS_ABSENCE);

    const m = await broken('never-asked-becomes-no-state',
      "    case 'never-asked':\n      return 'NOT ASKED.",
      "    case 'never-asked':\n      return 'the account has no state on chain. NOT ASKED.");
    expect(m.sayReading(NEVER_ASKED)).toMatch(ASSERTS_ABSENCE);
  });

  /*
   * RED WHEN: the sentence stops distinguishing an answer that carried no state
   * from an account that is empty, which is the reading a person acts on.
   */
  it('does not describe an answer carrying no state as an empty account', async () => {
    const said = sayReading(NO_STATE);
    expect(said).toMatch(/not the same as an empty account/);
    expect(said).toMatch(/has not yet caught up/);
    expect(said).not.toMatch(ASSERTS_ABSENCE);

    const m = await broken('no-state-becomes-empty',
      "'ASKED, AND THE ANSWER CARRIED NO STATE for that contract. That is not the same '",
      "'ASKED. The account has no state on chain. It is not the same '");
    expect(m.sayReading(NO_STATE)).toMatch(ASSERTS_ABSENCE);
  });

  /*
   * RED WHEN: the gate widens to "anything that did not fail", which lets a
   * question that was never sent contribute numbers to the report.
   */
  it('lets only an answering read carry numbers', async () => {
    expect(carriesNumbers(ANSWERED)).toBe(true);
    expect(carriesNumbers(NEVER_ASKED)).toBe(false);
    expect(carriesNumbers(NO_STATE)).toBe(false);
    expect(carriesNumbers({ kind: 'failed', cause: 'unreachable' })).toBe(false);

    const m = await broken('anything-that-did-not-fail-carries-numbers',
      "  r.kind === 'answered';",
      "  r.kind !== 'failed';");
    expect(m.carriesNumbers(NEVER_ASKED)).toBe(true);
  });
});

describe('two readings of the same numbers', () => {
  /*
   * RED WHEN: a comparison with one side missing is called agreement, which is
   * the shape that turns a measurement nobody took into one that passed.
   */
  it('never calls a missing side agreement', async () => {
    expect(compareField(1, 1)).toBe('agree');
    expect(compareField(1, 2)).toBe('differ');
    expect(compareField(1, undefined)).toBe('incomparable');
    expect(compareField(undefined, 1)).toBe('incomparable');
    expect(compareField(undefined, undefined)).toBe('incomparable');

    const m = await broken('missing-side-agrees',
      "  if (a === undefined || b === undefined) return 'incomparable';",
      "  if (a === undefined || b === undefined) return 'agree';");
    expect(m.compareField(1, undefined)).toBe('agree');
  });

  /*
   * RED WHEN: the roll-up prefers agreement to difference, so three matching
   * fields hide the fourth that does not.
   */
  it('lets one differing field decide the whole comparison', async () => {
    const recorded = { ...NUMBERS };
    const read = { ...NUMBERS, movementCount: 7 };

    const out = compareReadbacks(recorded, read);
    expect(out.perField.threshold).toBe('agree');
    expect(out.perField.movementCount).toBe('differ');
    expect(out.overall).toBe('differ');

    expect(compareReadbacks(recorded, { ...NUMBERS }).overall).toBe('agree');
    expect(compareReadbacks(recorded, { threshold: 1 }).overall).toBe('incomparable');

    const m = await broken('difference-loses-to-agreement',
      "  const overall: FieldComparison = values.includes('differ')\n    ? 'differ'\n"
      + "    : values.includes('incomparable') ? 'incomparable' : 'agree';",
      "  const overall: FieldComparison = values.includes('agree')\n    ? 'agree'\n"
      + "    : values.includes('incomparable') ? 'incomparable' : 'differ';");
    expect(m.compareReadbacks(recorded, read).overall).toBe('agree');
  });
});

describe('a state that only half decoded', () => {
  /*
   * RED WHEN: the half that survived the decoding is reported on its own, which
   * puts a real looking number beside a refusal.
   */
  it('reports both vault numbers or neither', async () => {
    expect(vaultNumbers({ payments: '3', notes: '5' }))
      .toEqual({ reportable: true, payments: '3', notes: '5' });
    expect(vaultNumbers({ payments: '3' })).toEqual({ reportable: false });
    expect(vaultNumbers({ notes: '5' })).toEqual({ reportable: false });
    expect(vaultNumbers({})).toEqual({ reportable: false });

    const m = await broken('half-a-decode-is-reportable',
      '  if (forced.payments === undefined || forced.notes === undefined)'
      + ' return { reportable: false };',
      '  if (forced.payments === undefined && forced.notes === undefined)'
      + ' return { reportable: false };');
    expect(m.vaultNumbers({ payments: '3' }).reportable).toBe(true);
  });
});

describe('the verdict', () => {
  const run = (over: Partial<Run>): Run => ({
    deploymentResolved: true,
    asConfigured: NEVER_ASKED,
    withAddressSupplied: NEVER_ASKED,
    ...over,
  });

  /*
   * RED WHEN: the unmeasured question is asked after the answering ones, so a
   * run that never resolved a deployment can report the same code as a run that
   * reached the chain.
   */
  it('asks whether anything was measured before anything else', async () => {
    const nothing = run({ deploymentResolved: false, asConfigured: ANSWERED });
    expect(verdict(nothing).code).toBe(3);
    expect(verdict(nothing).headline).toMatch(/UNMEASURED/);

    const m = await broken('unmeasured-asked-last',
      '  if (!run.deploymentResolved) {\n    return { code: 3, headline:',
      '  if (false as boolean) {\n    return { code: 3, headline:');
    expect(m.verdict(nothing).code).toBe(0);
  });

  /*
   * RED WHEN: the handed-address route is allowed to produce the settling code,
   * which reports the product as reading the chain on the strength of a read
   * this deployment cannot perform.
   */
  it('settles only on the product as this deployment is configured', async () => {
    const supplied = run({ asConfigured: NEVER_ASKED, withAddressSupplied: ANSWERED });
    expect(verdict(supplied).code).toBe(1);
    expect(verdict(supplied).headline).toMatch(/CANNOT USE IT/);

    expect(verdict(run({ asConfigured: ANSWERED })).code).toBe(0);

    const m = await broken('supplied-address-settles-it',
      '  if (carriesNumbers(run.asConfigured)) {',
      '  if (carriesNumbers(run.asConfigured) || carriesNumbers(run.withAddressSupplied)) {');
    expect(m.verdict(supplied).code).toBe(0);
  });

  /*
   * RED WHEN: a run in which nothing answered falls through to a substantive
   * code, so an unreachable indexer reports the same verdict as a product that
   * reached the chain and could not use it.
   */
  it('is unmeasured when neither route produced a reading', async () => {
    const neither = run({ asConfigured: NO_STATE, withAddressSupplied: NO_STATE });
    expect(verdict(neither).code).toBe(3);
    expect(verdict(run({
      asConfigured: { kind: 'failed', cause: 'unreachable' },
      withAddressSupplied: { kind: 'failed', cause: 'unreachable' },
    })).code).toBe(3);

    const m = await broken('nothing-answered-is-a-finding',
      "  return { code: 3, headline:\n    'UNMEASURED. Neither route produced a reading",
      "  return { code: 1, headline:\n    'UNMEASURED. Neither route produced a reading");
    expect(m.verdict(neither).code).toBe(1);
  });
});
