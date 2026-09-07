/**
 * WHAT HOLDS THE RULES IN `commit.mjs`.
 *
 * The workflow runs these on every push and every pull request, before it runs
 * the rules themselves against a real title. A rule nobody has watched refuse
 * is a rule that may have stopped refusing, and the only evidence that it still
 * does is a case that goes red when the rule is taken out.
 *
 * Every test below names ONE clause. Delete that clause and this test, and no
 * other, fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRANCH_KINDS,
  BRANCH_LIMIT,
  SUBJECT_KINDS,
  SUBJECT_LIMIT,
  branchProblem,
  messageProblem,
  squashedSubject,
  subjectProblem,
} from './commit.mjs';

/** Refuses, and says something. A rule that refuses with silence is unusable. */
const refused = (problem, what) => {
  assert.equal(typeof problem, 'string', `${what} was accepted and should not be`);
  assert.ok(problem.length > 20, `${what} refused without saying why: ${problem}`);
};

const accepted = (problem, what) => assert.equal(problem, null, `${what} was refused: ${problem}`);

test('THE POSITIVE CONTROL: the shapes this repository actually writes are accepted', () => {
  // Without this every rule below is satisfied by a check that refuses
  // everything, which is the failure mode a wall of refusals hides.
  for (const ok of [
    'feat(vault): refuse a payout the ledger cannot settle',
    'fix: put the compiled artefact back before the suite reads it',
    'docs: say what a clone needs before it can build',
    'chore(deps): move the pinned compiler forward',
  ]) {
    accepted(subjectProblem(ok), `subject ${JSON.stringify(ok)}`);
  }
  for (const ok of ['feat/vault-payout-refusal', 'fix/stale-artefact', 'chore/pinned-compiler']) {
    accepted(branchProblem(ok), `branch ${JSON.stringify(ok)}`);
  }
  accepted(
    messageProblem('fix: put the compiled artefact back\n\nThe suite reads it before any worker starts.\n'),
    'a whole message',
  );
});

test('a subject line says what changed, so an empty one is refused', () => {
  refused(subjectProblem(''), 'an empty subject');
  refused(subjectProblem('   '), 'a subject of spaces');
  refused(messageProblem(''), 'an empty message');
});

test('a subject line is at most 72 characters, counted in characters and not in bytes', () => {
  // THE NUMBER IS WRITTEN OUT HERE AND NOT READ OFF THE MODULE, AND THAT IS THE
  // WHOLE OF WHY THIS TEST CAN FAIL. Built from the exported limit, every case
  // below moves with it: raise the limit to two hundred and the long subject
  // grows to match, and a test that measures a constant against itself passes
  // whatever the constant says. 72 is what a log of one-liners can show.
  assert.equal(SUBJECT_LIMIT, 72);
  const at = `feat: ${'a'.repeat(66)}`;
  assert.equal([...at].length, 72);
  accepted(subjectProblem(at), 'a subject of exactly 72 characters');
  refused(subjectProblem(`${at}a`), 'a subject of 73 characters');

  // THE HALF A BYTE COUNT WOULD GET WRONG. This subject is 72 characters and
  // 138 bytes, and it is accepted.
  const wide = `feat: ${'é'.repeat(66)}`;
  assert.equal([...wide].length, 72);
  assert.equal(Buffer.byteLength(wide, 'utf8'), 138);
  accepted(subjectProblem(wide), 'a subject of 72 characters in a wider alphabet');
});

test('a subject line reads "kind: what changed", so prose is refused', () => {
  refused(subjectProblem('Put the compiled artefact back before the suite reads it'), 'a prose subject');
  refused(subjectProblem('fix put the artefact back'), 'a subject with no colon');
});

test('the kind is one of the kinds, in lower case', () => {
  refused(subjectProblem('wip: put the artefact back'), 'an unknown kind');
  refused(subjectProblem('Fix: put the artefact back'), 'a kind in the wrong case');
  for (const kind of SUBJECT_KINDS) {
    accepted(subjectProblem(`${kind}: put the artefact back`), `the kind ${kind}`);
  }
});

test('a scope is lower case, digits, and . _ - / only', () => {
  accepted(subjectProblem('feat(vault): refuse an unsettleable payout'), 'a plain scope');
  accepted(subjectProblem('feat(contracts/vault): refuse an unsettleable payout'), 'a scope with a slash');
  refused(subjectProblem('feat(Vault): refuse an unsettleable payout'), 'a capitalised scope');
  refused(subjectProblem('feat(the vault): refuse an unsettleable payout'), 'a scope with a space');
});

test('a subject line does not end with a full stop', () => {
  refused(subjectProblem('fix: put the artefact back.'), 'a subject ending in a full stop');
});

test('a subject line is not capitalised after the colon', () => {
  refused(subjectProblem('fix: Put the artefact back'), 'a capitalised description');
});

test('a blank line separates the subject from the body', () => {
  refused(messageProblem('fix: put the artefact back\nthe suite reads it first'), 'a body with no blank line');
  accepted(messageProblem('fix: put the artefact back\n\nthe suite reads it first'), 'a body after a blank line');
});

test('an attribution trailer is refused however it is indented or quoted', () => {
  // EVERY ONE OF THESE GOT THROUGH A RULE THAT ONLY MATCHED COLUMN ZERO, and
  // indented is how a trailer usually arrives.
  for (const line of [
    '  Signed-off-by: somebody',
    '    Co-authored-by: somebody',
    '> Signed-off-by: somebody',
    '| Reviewed-by: somebody',
    '  Generated with a thing that writes code',
    '> Authored by a thing that writes code',
  ]) {
    refused(messageProblem(`fix: put the artefact back\n\n${line}`), JSON.stringify(line));
  }
});

test('a path inside a home directory is refused wherever it appears in the line', () => {
  // The first two got through a rule that required a delimiter in front of the
  // path, and the backtick is this project's own way of writing one.
  for (const line of [
    'built from file:///Users/somebody/repo/thing.ts',
    'see `/Users/somebody/repo`',
    'it was at /home/somebody/work',
    'it was at C:\\Users\\somebody\\work',
  ]) {
    refused(messageProblem(`fix: put the artefact back\n\n${line}`), JSON.stringify(line));
  }
});

test('the list of words that cannot be published is passed in, never carried here', () => {
  // THE SEAM. Nothing in this repository holds such a list, so the case below
  // supplies its own: the rule is that a caller which HAS a list can apply it
  // through the same reading, and that the reading without one still runs.
  const also = [{ name: 'a word from the list', pattern: /\bpineapple\b/i, says: 'that word is not published' }];
  accepted(messageProblem('fix: put the pineapple back'), 'the word, with no list given');
  refused(messageProblem('fix: put the pineapple back', also), 'the word, with a list given');
  refused(branchProblem('feat/pineapple-refusal', also), 'the word in a branch name');
  // And the rules that are here still run when a list is given.
  refused(messageProblem('fix: put the artefact back.', also), 'a full stop, with a list given');
});

test('a subject too long BECAUSE of the number appended at merge says so', () => {
  // Somebody who counted to exactly 72 is otherwise told they are at 77, by a
  // number they never typed.
  const title = `feat: ${'a'.repeat(66)}`;
  assert.equal([...title].length, 72);
  const problem = subjectProblem(squashedSubject(title, 12));
  refused(problem, 'a 72-character title as the subject it becomes');
  assert.ok(
    /appended when this is merged/.test(problem) && /the title itself has 66/.test(problem),
    `it did not say where the characters went: ${problem}`,
  );
});

test('an attribution trailer is refused wherever in the message it appears', () => {
  refused(
    messageProblem('fix: put the artefact back\n\nwhy it matters\n\nSigned-off-by: someone'),
    'a sign-off trailer',
  );
  refused(
    messageProblem('fix: put the artefact back\n\nwhy it matters\n\nCo-authored-by: someone'),
    'a co-authorship trailer',
  );
  refused(
    messageProblem('fix: put the artefact back\n\nwhy it matters\n\nReviewed-by: someone'),
    'a trailer this check has never been shown',
  );
});

test('a line saying what produced the change is refused', () => {
  refused(
    messageProblem('fix: put the artefact back\n\nGenerated with a thing that writes code'),
    'a line naming what wrote it',
  );
  refused(
    messageProblem('fix: put the artefact back\n\nAuthored by a thing that writes code'),
    'a line naming what authored it',
  );
});

test('the mark a tool leaves is refused', () => {
  refused(messageProblem('fix: put the artefact back\n\n\u{1F916} and a line'), 'a message carrying a tool mark');
});

test('an address is refused, in a subject and in a body', () => {
  refused(subjectProblem('fix: ask someone@example.com about the artefact'), 'an address in a subject');
  refused(messageProblem('fix: put the artefact back\n\nask someone@example.com'), 'an address in a body');
});

test('a path inside a home directory is refused', () => {
  refused(
    messageProblem('fix: put the artefact back\n\nit was at /Users/somebody/work/thing'),
    'a home path',
  );
  refused(
    messageProblem('fix: put the artefact back\n\nit was at /home/somebody/work/thing'),
    'a home path on another system',
  );
  // AND AN ORDINARY REPOSITORY PATH IS NOT ONE, which is what makes the rule
  // usable at all.
  accepted(
    messageProblem('fix: put the artefact back\n\nit is read from contracts/managed/contract/index.js'),
    'a path inside the repository',
  );
});

test('a dash that is not a hyphen is refused, including the minus sign', () => {
  refused(subjectProblem('fix: put the artefact back \u2014 the suite reads it'), 'an em dash in a subject');
  refused(messageProblem('fix: put the artefact back\n\nthe suite \u2013 which reads it \u2013 starts first'), 'an en dash in a body');
  // NOT IN THE DASH BLOCK, and what a spreadsheet and several keyboards give
  // somebody who meant to type a hyphen.
  refused(subjectProblem('fix: put the artefact back \u2212 the suite reads it'), 'a minus sign in a subject');
  accepted(subjectProblem('fix: put the artefact back, the suite reads it'), 'a subject with no dash at all');
  accepted(subjectProblem('fix: put the artefact back - the suite reads it'), 'a subject with a plain hyphen');
});

test('a branch name says what changed, so an empty one is refused', () => {
  refused(branchProblem(''), 'an empty branch name');
  refused(branchProblem(undefined), 'no branch name at all');
});

test('the branch changes are merged INTO is refused, and named rather than reshaped', () => {
  for (const name of ['main', 'master', 'HEAD']) {
    const problem = branchProblem(name);
    refused(problem, `the branch ${name}`);
    assert.ok(
      /merged INTO/.test(problem),
      `refusing ${name} should say what it is, and it said: ${problem}`,
    );
  }
});

test('a branch name is at most 60 characters', () => {
  // Written out rather than read off the module, for the reason given above the
  // subject-line limit.
  assert.equal(BRANCH_LIMIT, 60);
  const at = `feat/${'a'.repeat(55)}`;
  assert.equal(at.length, 60);
  accepted(branchProblem(at), 'a branch name of exactly 60 characters');
  refused(branchProblem(`${at}a`), 'a branch name of 61 characters');
});

test('a branch name is kind/what-changed, lower case, with single hyphens', () => {
  refused(branchProblem('stale-artefact'), 'a branch name with no kind');
  refused(branchProblem('wip/stale-artefact'), 'a branch name with an unknown kind');
  refused(branchProblem('Feat/stale-artefact'), 'a kind in the wrong case');
  refused(branchProblem('feat/Stale-Artefact'), 'a description that is not lower case');
  refused(branchProblem('feat/stale--artefact'), 'a doubled hyphen');
  refused(branchProblem('feat/-stale-artefact'), 'a leading hyphen');
  refused(branchProblem('feat/stale/artefact'), 'a second slash');
  for (const kind of BRANCH_KINDS) {
    accepted(branchProblem(`${kind}/stale-artefact`), `the branch kind ${kind}`);
  }
});

test('a branch name is read for what must not be published, and read for it FIRST', () => {
  // The name below is refused twice over: it carries an address AND it is not
  // kebab-case. Which refusal comes back is the test. Reported as a shape
  // problem, the reading never ran and the clause that is supposed to catch an
  // address is dead code that no case can reach.
  const problem = branchProblem('feat/fix-for-someone@example.com');
  refused(problem, 'an address in a branch name');
  assert.ok(
    /an address/.test(problem),
    `the address is what is wrong with that name, and it said: ${problem}`,
  );
  // And a name whose only fault is its shape still says so.
  assert.ok(/kind\/what-changed/.test(branchProblem('feat/Stale-Artefact') ?? ''));
});

test('the subject a squashed merge writes is the one that is read', () => {
  // The merge appends the number. A title read without it passes at a length
  // the commit will not have, which is the one case a check on the title alone
  // gets wrong every time.
  const title = `feat: ${'a'.repeat(SUBJECT_LIMIT - 6)}`;
  accepted(subjectProblem(title), 'the title on its own');
  assert.equal(squashedSubject(title, 12), `${title} (#12)`);
  refused(subjectProblem(squashedSubject(title, 12)), 'the same title as the commit it becomes');
});
