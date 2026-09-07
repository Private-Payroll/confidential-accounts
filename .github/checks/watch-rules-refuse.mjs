/**
 * WATCHES EVERY RULE IN THIS DIRECTORY REFUSE.
 *
 *   node .github/checks/watch-rules-refuse.mjs
 *
 * `commit.test.mjs` and `toolchain.test.mjs` show that the rules accept what
 * they should and refuse what they should. This shows something they cannot:
 * that each case is refused BECAUSE OF the clause it names. A test can pass by
 * measuring a constant against itself, or by tripping a different clause than
 * the one it was written for, and both look exactly like a test that works.
 *
 * So each clause is taken out, one at a time, on a COPY, and the run has to go
 * red. A clause whose removal changes nothing is a clause nothing is holding.
 *
 * -- TWO PROPERTIES THIS HAS THAT MATTER MORE THAN THE COUNT ------------------
 *
 * NOTHING IS WRITTEN INSIDE THE REPOSITORY. Every mutation is applied to a copy
 * in a temporary directory, made with symlinks resolved rather than followed,
 * and removed afterwards. A run that is killed leaves this tree untouched.
 *
 * A MUTATION THAT MATCHES NOTHING IS A REFUSAL RATHER THAN A PASS. When a rule
 * is rewritten, the mutation aimed at it stops matching; scored as a kill, this
 * program would then report that a clause nothing tests any more is well
 * covered. It says REFUSED instead, and exits non-zero.
 *
 * A RUN THAT COLLECTED NOTHING IS ALSO A REFUSAL, AND THIS IS THE ONE THAT HAS
 * TO BE SAID OUT LOUD BECAUSE IT LOOKS EXACTLY LIKE SUCCESS. A mutation can
 * break the file so badly that the module will not parse. The run is then red,
 * every case in it is red, and a program that scored on "did anything fail"
 * would call that a kill: the clause is reported as held by a test when what
 * actually happened is that nothing was tested. So every run is scored on the
 * COUNT OF CASES IT COLLECTED as well as on what failed, and a run that
 * collected none is named as such and never counted. The baseline is held to
 * the same question, which is why it asserts a number and not an absence.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

/** The directory this file is in, unless one is named, so it usually needs no argument. */
const SOURCE = process.argv[2] ?? fileURLToPath(new URL('.', import.meta.url));

const M = [
  ['subject limit raised past what a log can read', 'commit.mjs', 'export const SUBJECT_LIMIT = 72;', 'export const SUBJECT_LIMIT = 200;'],
  ['subject counted in bytes instead of characters', 'commit.mjs', 'const length = [...subject].length;', 'const length = Buffer.byteLength(subject, "utf8");'],
  ['an empty subject accepted', 'commit.mjs', "return 'a subject line has to say what the change does, and this one is empty';", 'return null;'],
  ['the kinds no longer close the shape', 'commit.mjs', '`^(${SUBJECT_KINDS.join(\'|\')})', '`^([a-z]+)'],
  ['the scope charset widened to anything', 'commit.mjs', '(\\\\(([a-z0-9][a-z0-9._/-]*)\\\\))?', '(\\\\(([^()]*)\\\\))?'],
  ['a trailing full stop allowed', 'commit.mjs', "return 'a subject line does not end with a full stop';", 'return null;'],
  ['a capital after the colon allowed', 'commit.mjs', "return 'a subject line is not capitalised after the colon';", 'return null;'],
  ['the blank line no longer required', 'commit.mjs', "return 'a blank line separates the subject from the body';", 'return null;'],
  ['the attribution trailer rule removed', 'commit.mjs', 'pattern: /^[\\s>|]*[a-z]+(-[a-z]+)*-by:/im,', 'pattern: /$^/,'],
  ['the produced-by rule removed', 'commit.mjs', 'pattern: /^[\\s>|]*(co-)?(generated|authored|created|written)\\s+(with|by)\\b/im,', 'pattern: /$^/,'],
  ['the tool mark rule removed', 'commit.mjs', 'pattern: /[\\u{1F916}\\u{1F9BE}]/u,', 'pattern: /$^/u,'],
  ['the address rule removed', 'commit.mjs', 'pattern: /[^\\s@<>]+@[^\\s@<>]+\\.[a-z]{2,}/i,', 'pattern: /$^/,'],
  ['the home-path rule removed', 'commit.mjs', 'pattern: /(\\/Users\\/|\\/home\\/|~\\/|[A-Za-z]:\\\\Users\\\\)[A-Za-z0-9._-]+/,', 'pattern: /$^/,'],
  ['the dash rule removed', 'commit.mjs', 'pattern: /[\\u2010-\\u2015\\u2212]/u,', 'pattern: /$^/u,'],
  ['the merged-into branch no longer named', 'commit.mjs', 'if (PROTECTED.includes(branch)) {', 'if (false) {'],
  ['branch limit raised', 'commit.mjs', 'export const BRANCH_LIMIT = 60;', 'export const BRANCH_LIMIT = 200;'],
  ['the branch shape widened to anything', 'commit.mjs', "const BRANCH = new RegExp(`^(${BRANCH_KINDS.join('|')})\\\\/[a-z0-9]+(-[a-z0-9]+)*$`);", 'const BRANCH = /^.+$/;'],
  ['a branch name no longer read for what must not be published', 'commit.mjs', "const carried = unpublishable(branch, 'a branch name', also);", 'const carried = null;'],
  ['a branch read for what must not be published only AFTER its shape', 'commit.mjs', "  const carried = unpublishable(branch, 'a branch name', also);\n  if (carried !== null) {\n    return carried;\n  }\n", '  '],
  ['a body no longer read for what must not be published', 'commit.mjs', "return unpublishable(lines.slice(1).join('\\n'), 'a commit message', also);", 'return null;'],
  ['the trailer rule anchored at column zero again', 'commit.mjs', 'pattern: /^[\\s>|]*[a-z]+(-[a-z]+)*-by:/im,', 'pattern: /^[a-z]+(-[a-z]+)*-by:/im,'],
  ['the produced-by rule anchored at column zero again', 'commit.mjs', 'pattern: /^[\\s>|]*(co-)?(generated', 'pattern: /^(co-)?(generated'],
  ['the home-path rule needing a delimiter in front again', 'commit.mjs', 'pattern: /(\\/Users\\/', 'pattern: /(^|[\\s])(\\/Users\\/'],
  ['the minus sign no longer counted as a dash', 'commit.mjs', 'pattern: /[\\u2010-\\u2015\\u2212]/u,', 'pattern: /[\\u2010-\\u2015]/u,'],
  ['a list handed in by a caller ignored', 'commit.mjs', 'for (const rule of [...FORBIDDEN, ...also]) {', 'for (const rule of FORBIDDEN) {'],
  ['the appended number no longer explained', 'commit.mjs', "        : `${[...appended[0]].length} of those are the number appended when this is merged, so the title itself has ${SUBJECT_LIMIT - [...appended[0]].length}`;", "        : 'the detail belongs in the body';"],
  ['the number a squashed merge appends is dropped', 'commit.mjs', 'return `${title} (#${number})`;', 'return `${title}`;'],
  ['the compiler version no longer checked', 'toolchain.mjs', "if (!reported.includes(COMPACTC_REPORTS)) {", 'if (false) {'],
  ['a compiler that says nothing accepted', 'toolchain.mjs', "return 'the compiler did not say which version it is, so it cannot be the pinned one';", 'return null;'],
  ['an unpublished machine given a compiler anyway', 'toolchain.mjs', '  if (target === undefined) {', '  if (target === undefined) { return TARGETS["linux/x64"]; }\n  if (false) {'],
  ['the release fetched over an unprotected connection', 'toolchain.mjs', "const RELEASE = 'https://github.com", "const RELEASE = 'http://github.com"],
  ['the version dropped from the unpack path', 'toolchain.mjs', 'return `${home}/.compact/versions/${COMPACTC_VERSION}/${targetFor(platform, arch)}`;', 'return `${home}/.compact/versions/${targetFor(platform, arch)}`;'],
  ['two machines unpacked to one place', 'toolchain.mjs', "  'darwin/arm64': 'aarch64-darwin',", "  'darwin/arm64': 'x86_64-unknown-linux-musl',"],
  ['the asset no longer names the pinned version', 'toolchain.mjs', 'return `compactc_v${COMPACTC_VERSION}_${targetFor(platform, arch)}.zip`;', 'return `compactc_${targetFor(platform, arch)}.zip`;'],
];

/**
 * What a run of the cases did: how many it COLLECTED, and which of them failed.
 *
 * The count comes from the runner's own summary rather than from counting the
 * lines that failed, because those are the same number when nothing ran.
 */
const run = (dir) => {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['--test', join(dir, 'commit.test.mjs'), join(dir, 'toolchain.test.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = `${e.stdout ?? ''}`;
  }
  // A case that failed by NAME. A line naming a FILE instead is the runner
  // reporting one it could not load, which is not a case at all.
  //
  // Matched on being an absolute path to one of these files, and not on
  // containing a slash: two of the case names below carry one, and filtering on
  // that hid two real kills the first time this was written.
  const red = [...out.matchAll(/^not ok \d+ - (.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((name) => !(name.startsWith('/') && name.endsWith('.mjs')));
  const passed = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? '0');
  const failed = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? '0');
  return { collected: passed + failed, red, broke: /MODULE FAILED TO LOAD|Cannot find module/.test(out) };
};

const base = mkdtempSync(join(tmpdir(), 'rules-baseline-'));
cpSync(SOURCE, base, { recursive: true, dereference: true });
const clean = run(base);
rmSync(base, { recursive: true, force: true });
if (clean.collected === 0) {
  console.error(
    `THE BASELINE COLLECTED NO CASES AT ALL, so nothing below would mean anything.\n` +
      `  Looked in ${SOURCE} for commit.test.mjs and toolchain.test.mjs.`,
  );
  process.exit(1);
}
if (clean.red.length !== 0) {
  console.error('THE BASELINE IS NOT GREEN, so a kill below could be something already broken:', clean.red);
  process.exit(1);
}
console.log(`baseline: ${clean.collected} cases, all green (${M.length} mutations to apply)\n`);

let survived = 0;
for (const [name, file, from, to] of M) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-'));
  cpSync(SOURCE, dir, { recursive: true, dereference: true });
  const at = join(dir, file);
  const text = readFileSync(at, 'utf8');
  if (!text.includes(from)) {
    console.log(`REFUSED  ${name}\n         its target is not in ${file}, so it would have scored a kill it did not earn`);
    rmSync(dir, { recursive: true, force: true });
    survived++;
    continue;
  }
  writeFileSync(at, text.replace(from, to));
  const after = run(dir);
  rmSync(dir, { recursive: true, force: true });
  if (after.collected < clean.collected || after.broke) {
    // THE ONE THAT LOOKS LIKE SUCCESS. The run is red and no case decided it:
    // the mutation broke the file rather than the rule, so this says nothing
    // about whether anything holds that clause.
    console.log(
      `REFUSED  ${name}\n` +
        `         it broke the file rather than the rule: ${after.collected} of ${clean.collected} cases even ran, ` +
        'so nothing here was measured. Write it as a change the file can still parse.',
    );
    survived++;
    continue;
  }
  if (after.red.length === 0) {
    console.log(`SURVIVED ${name}`);
    survived++;
  } else {
    console.log(`killed   ${name}`);
    for (const r of after.red) console.log(`           red: ${r}`);
  }
}
console.log(`\n${M.length - survived} of ${M.length} killed, ${survived} survived`);
process.exit(survived === 0 ? 0 : 1);
