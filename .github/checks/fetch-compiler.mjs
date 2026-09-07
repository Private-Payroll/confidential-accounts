/**
 * FETCHES THE PINNED COMPACT COMPILER IF IT IS NOT ALREADY ON THIS MACHINE.
 *
 *   node .github/checks/fetch-compiler.mjs
 *
 * Prints exactly one line on standard output:
 *
 *   COMPACT_HOME=/path/to/the/directory/holding/compactc
 *
 * and everything it has to say about what it did on standard error. That split
 * is what lets the same program serve two callers: a workflow appends the line
 * to the file that carries variables between its steps, and a person runs
 * `export $(node .github/checks/fetch-compiler.mjs)` and has a compiler.
 *
 * -- WHAT IT WILL NOT DO ------------------------------------------------------
 *
 * It will not accept a compiler of the wrong version, and it will not accept
 * one that runs and says nothing, which is a real state a broken unpack leaves
 * behind and which used to look like success. Either is a refusal naming what
 * resolves it, because a wrong compiler produces contracts that are wrong in a
 * way nothing here can see and the chain reports at a deploy.
 *
 * It downloads only when there is no working compiler already: an existing
 * COMPACT_HOME wins, and a compiler unpacked by an earlier run is reused. So a
 * second run costs one process and no network.
 *
 * The choice of version, machine and URL is in `toolchain.mjs`, which is pure
 * and is checked directly. What is here is the part that touches the world.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMPACTC_VERSION, installDir, releaseAsset, releaseUrl, versionProblem } from './toolchain.mjs';

const say = (line) => process.stderr.write(`${line}\n`);

const refuse = (line) => {
  process.stderr.write(`\n  ${line}\n\n`);
  process.exit(1);
};

/**
 * What a candidate compiler reports, or null if it is not one.
 *
 * Verified by RUNNING it rather than by its path existing. The devtools lay
 * down an entry point that resolves its own directory without following
 * symlinks, so a path that exists and is executable is not yet a compiler.
 */
function reports(candidate) {
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    return execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** A directory already holding a working compiler of the pinned version, or null. */
function alreadyHere(dir) {
  const reported = reports(join(dir, 'compactc'));
  return reported !== null && versionProblem(reported) === null ? reported : null;
}

const given = process.env.COMPACT_HOME;
if (given !== undefined && given !== '') {
  const reported = alreadyHere(given);
  if (reported === null) {
    const problem = versionProblem(reports(join(given, 'compactc')) ?? '');
    refuse(`COMPACT_HOME names ${given}, and ${problem}`);
  }
  say(`  the compiler named by COMPACT_HOME is the pinned one: ${reported.trim()}`);
  process.stdout.write(`COMPACT_HOME=${given}\n`);
  process.exit(0);
}

const dir = installDir(homedir(), process.platform, process.arch);

const reused = alreadyHere(dir);
if (reused !== null) {
  say(`  reusing the compiler already unpacked here: ${reused.trim()}`);
  process.stdout.write(`COMPACT_HOME=${dir}\n`);
  process.exit(0);
}

const asset = releaseAsset(process.platform, process.arch);
const url = releaseUrl(asset);
say(`  fetching Compact compiler ${COMPACTC_VERSION}`);
say(`    ${url}`);

const response = await fetch(url, { redirect: 'follow' });
if (!response.ok) {
  refuse(
    `the pinned compiler could not be downloaded: the release answered ${response.status}. ` +
      'Fetch the asset above by hand, unpack it anywhere, and point COMPACT_HOME at the directory holding compactc.',
  );
}
const bytes = Buffer.from(await response.arrayBuffer());

// THE DIGEST IS PRINTED RATHER THAN COMPARED, AND THAT IS A GAP RATHER THAN A
// DESIGN. Comparing it against a written-down value is what would make this
// step tamper-evident, and no such value has been read off this asset by
// anything yet. Printing it is how one gets read off it: the first run of this
// records the number, and the number can then be written above this line and
// compared here.
const digest = createHash('sha256').update(bytes).digest('hex');
say(`    ${bytes.length} bytes, sha256 ${digest}`);

const scratch = join(tmpdir(), `compactc-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const archive = join(scratch, asset);
writeFileSync(archive, bytes);

mkdirSync(dir, { recursive: true });
try {
  execFileSync('unzip', ['-oq', archive, '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (error) {
  refuse(
    `the downloaded compiler could not be unpacked: ${error instanceof Error ? error.message : String(error)}. ` +
      'This needs `unzip`, which is on the machines this is written for; install it, or unpack the asset by hand ' +
      'and point COMPACT_HOME at the directory holding compactc.',
  );
}

// The archive sometimes carries a directory of its own. Flatten it, so what is
// at COMPACT_HOME is the compiler and the tools that sit beside it rather than
// a folder containing them.
if (!existsSync(join(dir, 'compactc'))) {
  const inner = readdirSync(dir).find((name) => {
    const at = join(dir, name);
    return statSync(at).isDirectory() && existsSync(join(at, 'compactc'));
  });
  if (inner !== undefined) {
    say(`    flattening ${inner}`);
    for (const name of readdirSync(join(dir, inner))) {
      writeFileSync(join(dir, name), readFileSync(join(dir, inner, name)));
    }
  }
}

// The archive ships everything read-only, which is fine for running and not for
// anything that has to rewrite it later.
for (const name of readdirSync(dir)) {
  try {
    chmodSync(join(dir, name), 0o755);
  } catch {
    // A directory left behind by the flatten above. Nothing runs from it.
  }
}

const reported = reports(join(dir, 'compactc'));
if (reported === null) {
  refuse(
    `the compiler was unpacked into ${dir} and did not run. ` +
      'Remove that directory and try again, or unpack the asset by hand and point COMPACT_HOME at it.',
  );
}
const problem = versionProblem(reported);
if (problem !== null) {
  refuse(problem);
}

say(`  ${reported.trim()}`);
process.stdout.write(`COMPACT_HOME=${dir}\n`);
