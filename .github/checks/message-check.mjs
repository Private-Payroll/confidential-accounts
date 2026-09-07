/**
 * READS A COMMIT MESSAGE, AND THE BRANCH IT IS ON, AGAINST THE RULES IN
 * `commit.mjs`.
 *
 *   node .github/checks/message-check.mjs <file> [--branch <name>]
 *
 * Exit 0 and print what conformed. Exit 1 and print what is wrong and what
 * would fix it. Exit 2 if the message could not be read at all, because a check
 * that did not run is not a clean message.
 *
 * The workflow puts a pull request title and body through this as the message a
 * squashed merge is about to write, which is when it can still be changed. The
 * same program reads a message file before a commit is made, so there is one
 * set of rules rather than two that could drift apart.
 */

import { readFileSync } from 'node:fs';

import { branchProblem, messageProblem } from './commit.mjs';

const args = process.argv.slice(2);
const path = args[0];
if (path === undefined || path.startsWith('--')) {
  process.stderr.write('\n  name the file holding the message\n\n');
  process.exit(2);
}

const branchAt = args.indexOf('--branch');
let branch;
if (branchAt !== -1) {
  branch = args[branchAt + 1];
  if (branch === undefined || branch.startsWith('--')) {
    process.stderr.write('\n  --branch names the branch it applies to\n\n');
    process.exit(2);
  }
}

let message;
try {
  message = readFileSync(path, 'utf8');
} catch (error) {
  process.stderr.write(`\n  ${path} could not be read: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(2);
}

const problem = messageProblem(message);
if (problem !== null) {
  process.stderr.write(`\n  THIS MESSAGE CANNOT BE COMMITTED AS IT STANDS.\n\n      ${problem}\n\n`);
  process.stderr.write(`  What it says now:\n\n${message.split('\n').map((l) => `      ${l}`).join('\n')}\n\n`);
  process.exit(1);
}

if (branch !== undefined) {
  const wrong = branchProblem(branch);
  if (wrong !== null) {
    process.stderr.write(`\n  THIS BRANCH CANNOT CARRY THE CHANGE AS NAMED.\n\n      ${wrong}\n\n`);
    process.exit(1);
  }
}

const subject = message.split('\n')[0] ?? '';
process.stdout.write(`  the message reads as it will be committed:  ${subject}\n`);
if (branch !== undefined) {
  process.stdout.write(`  the branch names the change:                ${branch}\n`);
}
