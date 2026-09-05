/**
 * THE SUITE REFUSES TO RUN AGAINST AN ARTIFACT OLDER THAN THE SOURCE IT WAS
 * BUILT FROM. `C294`, and it is `M-85` one level up.
 *
 * `TEST.command:112-134` already made this call for the account contract: a
 * stale compile is worse than no compile, because a test run against the wrong
 * artefact is not a weaker signal, it is a FALSE one. That guard RECOMPILES.
 * This one REFUSES, and the difference is not a preference:
 *
 *   - `TEST.command` is a door. A person opened it, so it may open the compiler.
 *   - The suite is not a door. It is run by sessions that rule 1 forbids to
 *     compile, by `MUTATE.command`, and by anything that types `vitest`. A
 *     harness that quietly repaired itself would be doing the one thing the
 *     session running it is not allowed to do.
 *
 * So this refuses and names the door, which is the only outcome a person can
 * act on and the only one that leaves the round's log honest.
 *
 * WHY IT IS NOT IN `contracts/test/simulator.ts`. `V-249`(b) proposed exactly
 * that — two `statSync` calls in the simulator's constructor. Measured, the
 * simulator is NOT the single seam `C294` calls it: the artifacts are imported
 * from twenty-nine sites across twenty-one files, fifteen of them inside
 * collected test files themselves, and four `contracts/test/*.test.ts` files
 * never import the simulator at all — `one-definition.test.ts:33` and
 * `run-keys.test.ts` reach the artifacts by other routes. Ten of the files that
 * DO import it also import the artifact directly on an adjacent line, so a
 * check there would be racing declaration order rather than gating anything.
 * A guard bolted into one file is the shape that let this happen.
 *
 * A `globalSetup` entry is the only chokepoint: one module, run once, in the
 * main process, before any worker evaluates any test module. It cannot be
 * out-ordered by an import, it covers all three `include` globs rather than
 * `contracts/test/**`, and a refusal is ONE message instead of ninety-nine
 * file-level failures. It carries no environment variable and no flag, and
 * `vitest`'s CLI publishes no `--globalSetup` option to override it with
 * (`node_modules/vitest/dist/chunks/cac.DdICfEr1.js:1264` lists it `null`,
 * which is that table's way of saying the option is not on the command line).
 *
 * WHAT DISARMS IT, MEASURED RATHER THAN ASSUMED. An earlier draft of this
 * comment said the only way past was deleting the `globalSetup` key. That was
 * false and an auditor demonstrated it, so it is written here as what it is:
 *
 *   - `vitest --config <other>` REPLACES THE WHOLE CONFIG and therefore this
 *     guard, and that flag is upstream of anything a config can say. Nothing
 *     inside vitest can close it. What keeps it shut is that neither door uses
 *     it: `TEST.command` runs `npx vitest run` and `MUTATE.command` runs
 *     `./node_modules/.bin/vitest run contracts/test`, both unflagged.
 *   - Renaming `vitest.config.ts` makes vitest fall back to `vite.config.ts`,
 *     which has no `test` block and no guard. DELETING it is caught, because
 *     the test below reads it and throws; renaming is not.
 *   - Deleting, commenting out or neutering the `globalSetup` key. This one IS
 *     closed: `artifact-freshness.test.ts` imports `vitest.config.ts` as a
 *     module and reads the value rather than grepping the text, and it calls
 *     this module's own default export against a stale fixture. A commented-out
 *     key is not a value, and a swallowed throw is not a throw. `C263`: a guard
 *     nobody wired in is invisible to a unit test of the guard, and a guard
 *     whose wiring is checked by substring is invisible to a comment character.
 */
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** A source a person edits, the artifact the tests import, and the door between them. */
export type ArtifactPair = {
  /** Repository-relative path to the `.compact` a person edits. */
  readonly source: string;
  /** Repository-relative path to the generated module the tests actually import. */
  readonly artifact: string;
  /** The `.command` that regenerates the artifact from the source. Rule 19. */
  readonly door: string;
};

/**
 * BOTH CONTRACTS, AND THE VAULT IS NOT AN AFTERTHOUGHT HERE.
 *
 * `TEST.command:119-120` guards `ConfidentialAccount.compact` alone, and
 * `package.json`'s `pretest` runs `compact:fast`, which is
 * `./scripts/compile-contract.sh` — the ACCOUNT only. So nothing in this
 * repository has ever checked the vault's artifact against the vault's source,
 * and `contracts/managed-vault/contract/index.js:2` imports the account's
 * generated module through the `contracts/Acct` symlink, which means loading
 * the vault artifact loads the account artifact too. A vault-only check would
 * be as wrong as the account-only one.
 */
export const CONTRACT_ARTIFACTS: readonly ArtifactPair[] = [
  {
    source: 'contracts/src/ConfidentialAccount.compact',
    artifact: 'contracts/managed/contract/index.js',
    door: 'COMPILE-CONTRACT.command',
  },
  {
    source: 'contracts/src/Vault.compact',
    artifact: 'contracts/managed-vault/contract/index.js',
    door: 'COMPILE-VAULT.command',
  },
];

export type RefusalKind =
  /** The source is newer than the artifact. The tests would report on code that is not the code. */
  | 'stale'
  /** The artifact has never been built, or was deleted. */
  | 'artifact-missing'
  /** The source named in the table above is not on disk. The table is wrong, and no door fixes that. */
  | 'source-missing';

export type Refusal = {
  readonly kind: RefusalKind;
  readonly pair: ArtifactPair;
  /** Milliseconds, as read off the filesystem. `null` when the file is not there. */
  readonly sourceMs: number | null;
  readonly artifactMs: number | null;
};

const mtimeMsOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

const under = (root: string, path: string): string => (isAbsolute(path) ? path : join(root, path));

/**
 * Every pair that stops the suite, in table order. An empty array means the
 * artifacts on disk were built from the sources on disk.
 *
 * IT THROWS ON AN EMPTY TABLE RATHER THAN RETURNING NO REFUSALS. `C238`,
 * `C263`: a check over zero things cannot fail, and a check that cannot fail
 * has already failed. The only way this guard could ever be disarmed from
 * inside is by handing it nothing to check, so that is an error and not a pass.
 *
 * `pairs` IS REQUIRED HERE AND DEFAULTED IN `assertArtifactsFresh` ALONE. Two
 * defaults for one decision means one of them is dead code, and a dead default
 * is a thing a mutation can change without any test noticing — which is how an
 * auditor found this one. There is exactly one place the live table is bound.
 */
export function findRefusals(root: string, pairs: readonly ArtifactPair[]): Refusal[] {
  if (pairs.length === 0) {
    throw new Error(
      'artifact-freshness: asked to check ZERO source/artifact pairs. A check over ' +
        'nothing cannot fail, so this is an error rather than a pass. Something has ' +
        'emptied CONTRACT_ARTIFACTS.',
    );
  }

  const refusals: Refusal[] = [];
  for (const pair of pairs) {
    const sourceMs = mtimeMsOf(under(root, pair.source));
    const artifactMs = mtimeMsOf(under(root, pair.artifact));

    if (sourceMs === null) {
      refusals.push({ kind: 'source-missing', pair, sourceMs, artifactMs });
      continue;
    }
    if (artifactMs === null) {
      refusals.push({ kind: 'artifact-missing', pair, sourceMs, artifactMs });
      continue;
    }
    // Strictly newer. A compile writes the artifact after it reads the source,
    // so equal timestamps are what an untouched pair looks like on a filesystem
    // with coarse resolution, and are not evidence of anything being stale.
    if (sourceMs > artifactMs) {
      refusals.push({ kind: 'stale', pair, sourceMs, artifactMs });
    }
  }
  return refusals;
}

/** IST. Rule 22. The times are read off the filesystem and not computed from anything. */
const ist = (ms: number | null): string =>
  ms === null
    ? 'NOT ON DISK'
    : new Date(ms).toLocaleString('en-GB', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }) + ' IST';

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/**
 * What a person reads when the suite stops. It names the file and the door and
 * prints the two times it compared, because a refusal that does not show its
 * working is a refusal somebody argues with instead of acting on.
 */
export function refusalText(refusals: readonly Refusal[]): string {
  const out: string[] = [];
  out.push('');
  out.push('  THE SUITE DID NOT RUN.');
  out.push('');
  out.push('  A test run against the wrong artefact is not a weaker signal, it is a FALSE');
  out.push('  one. M-85 for the account; C294 is the same fault reaching the whole harness.');
  out.push('');

  const doors: string[] = [];
  for (const r of refusals) {
    const width = Math.max(r.pair.source.length, r.pair.artifact.length) + 2;
    if (r.kind === 'source-missing') {
      out.push(`  ${r.pair.source}`);
      out.push('      is named in this guard\'s own table and is not on disk. The guard cannot');
      out.push('      answer the question it exists to answer, so it refuses rather than');
      out.push('      passing a pair it could not read.');
      out.push('');
      out.push('      NO DOOR RESOLVES THIS. A source was renamed or removed and');
      out.push('      scripts/artifact-freshness.ts was not changed in the same turn.');
      out.push('');
      continue;
    }
    if (r.kind === 'artifact-missing') {
      out.push(`  ${r.pair.source} has never been compiled here.`);
      out.push('');
      out.push(`      source    ${pad(r.pair.source, width)}${ist(r.sourceMs)}`);
      out.push(`      artifact  ${pad(r.pair.artifact, width)}NOT BUILT`);
      out.push('');
      doors.push(r.pair.door);
      continue;
    }
    out.push(`  ${r.pair.source} was edited after the artifact the tests import was built.`);
    out.push('');
    out.push(`      source    ${pad(r.pair.source, width)}${ist(r.sourceMs)}`);
    out.push(`      artifact  ${pad(r.pair.artifact, width)}${ist(r.artifactMs)}`);
    out.push('');
    doors.push(r.pair.door);
  }

  const unique = doors.filter((d, i) => doors.indexOf(d) === i);
  if (unique.length > 0) {
    const list =
      unique.length === 1
        ? unique[0]
        : unique.slice(0, -1).join(', ') + ' and ' + unique[unique.length - 1];
    out.push(`  Run ${list}, then run this again.`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * The whole guard in one call: read the two pairs, and throw the refusal if
 * there is one. `globalSetup` calls this and nothing else.
 */
export function assertArtifactsFresh(
  root: string,
  pairs: readonly ArtifactPair[] = CONTRACT_ARTIFACTS,
): void {
  const refusals = findRefusals(root, pairs);
  if (refusals.length > 0) {
    throw new Error(refusalText(refusals));
  }
}
