/**
 * Patch one line in the Foundation's dust wallet, because it cannot pay a fee.
 *
 *   node scripts/patch-sdk.mjs        (run by every .command after npm install)
 *
 * WHAT IS WRONG (M-46, M-48)
 *
 * `computeBalancingRecipe` in @midnight-ntwrk/wallet-sdk-dust-wallet asks the
 * balancer for a recipe using the fee as the imbalance:
 *
 *   initialImbalances: CapImbalances.fromEntry('dust', currentFee)
 *
 * The balancer's convention is that an imbalance is what the transaction has
 * MINUS what it owes, so a shortfall is negative. Handed a positive number it
 * reads "this transaction has spare dust", creates an output and selects no
 * inputs. Coverage is then 0, `converged: newFee <= recipeAmountCoverage` can
 * never be true for any positive fee, and the loop — which has no iteration
 * cap, no deadline, and runs under Effect.runSync — spins forever on the main
 * thread. Measured on preview: 71,013 iterations, 1.4 GB resident, no end.
 *
 * It only bites when `initialFees` comes out as zero or positive, which is what
 * our contract-call transactions produce. That is why it is not hitting
 * everyone, and why it looked like our bug for six runs.
 *
 * PROVEN, OFFLINE, AGAINST THE REAL WALLET STATE
 *
 * Replaying the exact loop against the cached dust state from this machine:
 *
 *   unpatched  initialFees 0        never converges (fee stuck at 1)
 *   unpatched  initialFees 1        never converges (fee stuck at 1)
 *   unpatched  initialFees -250000  converges in 1     <- everyone else's path
 *   patched    initialFees 0        converges in 2
 *   patched    initialFees 1        converges in 1
 *   patched    initialFees -250000  converges in 1
 *
 * The same code is in 4.1.0, 4.2.0, 5.0.0-beta.2 and the 4 Aug 2026 canary, so
 * upgrading does not fix it and neither does moving to stagenet.
 *
 * WHY PATCH node_modules AT ALL
 *
 * Nothing reachable from our side changes the outcome: the imbalance is built
 * inside their method, the loop is not configurable, and every published
 * version has it. This is a two-line, reversible, verified change with an
 * upstream report to follow. It refuses to run if the source is not exactly
 * what it expects, so a version bump stops the build rather than silently
 * patching the wrong thing.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Two scopes, because 5.0 renamed one of them.
 *
 * 4.1.1 ships the wallet SDK under `@midnight-ntwrk/` (hyphenated). 5.0 moves
 * it to `@midnightntwrk/` (no hyphen) while leaving the midnight-js packages
 * where they were, so both scopes exist side by side. Verified by installing
 * the 5.0 matrix: `@midnightntwrk/wallet-sdk-dust-wallet@2.0.0-beta.2`.
 *
 * The defect is byte-identical in both, so the same two anchors match. Checking
 * both paths means this keeps working across the migration instead of failing
 * on the day we bump versions.
 */
const CANDIDATES = [
  'node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Transacting.js',
  'node_modules/@midnightntwrk/wallet-sdk-dust-wallet/dist/v1/Transacting.js',
].map((p) => join(process.cwd(), p));

const TARGETS = CANDIDATES.filter((p) => existsSync(p));

const MARKER = 'CONFIDENTIAL-ACCOUNTS-PATCH-M48';

/** The fee is a shortfall. Say so in the sign the balancer actually reads. */
const SIGN_FROM = "                        initialImbalances: CapImbalances.fromEntry('dust', currentFee),";
const SIGN_TO = `                        // ${MARKER}: a fee is a shortfall, so it must be negative here.
                        // Positive made the balancer add an output and select no inputs,
                        // so coverage was 0 and the loop below could never converge.
                        initialImbalances: CapImbalances.fromEntry('dust', currentFee > 0n ? -currentFee : currentFee),`;

/** A fixed-point loop with no bound is a hang waiting to happen. Give it one. */
const CAP_FROM = `        return pipe(Effect.iterate({ currentFee: initialFees, recipeInputs: [], converged: false }, {
            while: (s) => !s.converged,
            body: ({ currentFee }) => Effect.try({
                try: () => {`;
const CAP_TO = `        // ${MARKER}: bound the iteration. Unbounded fixed-point loops do not
        // fail, they hang, and this one hangs on the main thread under runSync.
        let __caIterations = 0;
        return pipe(Effect.iterate({ currentFee: initialFees, recipeInputs: [], converged: false }, {
            while: (s) => !s.converged,
            body: ({ currentFee }) => Effect.try({
                try: () => {
                    if (++__caIterations > 64) {
                        throw new Error('dust fee balancing did not converge in 64 iterations (bounded by ${MARKER}; see BACKLOG M-46/M-48)');
                    }`;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

if (TARGETS.length === 0) {
  console.log(red('  ✗ the dust wallet package is not installed under either scope'));
  for (const c of CANDIDATES) console.log(`    looked in ${c}`);
  process.exit(1);
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

let failed = false;
for (const target of TARGETS) {
  const label = target.includes('@midnightntwrk/') ? '@midnightntwrk' : '@midnight-ntwrk';
  const before = readFileSync(target, 'utf8');

  if (before.includes(MARKER)) {
    console.log(green(`  ✓ dust wallet already patched (M-48, ${label})`));
    continue;
  }

  const missing = [];
  if (!before.includes(SIGN_FROM)) missing.push('the imbalance sign line');
  if (!before.includes(CAP_FROM)) missing.push('the balancing loop header');

  if (missing.length) {
    console.log(red(`  ✗ the dust wallet source in ${label} is not what this patch expects`));
    console.log(`    could not find: ${missing.join(', ')}`);
    console.log('    The package has probably changed version. Do NOT run anything until');
    console.log('    this is checked — unpatched, fee balancing hangs forever (M-46).');
    failed = true;
    continue;
  }

  // Exactly once each, or something is being matched that was not intended.
  if (count(before, SIGN_FROM) !== 1 || count(before, CAP_FROM) !== 1) {
    console.log(red(`  ✗ the patch anchors appear more than once in ${label}; refusing to guess`));
    failed = true;
    continue;
  }

  writeFileSync(target, before.replace(SIGN_FROM, SIGN_TO).replace(CAP_FROM, CAP_TO));
  console.log(green(`  ✓ patched the dust wallet fee balancer (M-48, ${label})`));
  console.log('    a fee is now passed to the balancer as a shortfall, and the loop is bounded');
}

process.exit(failed ? 1 : 0);
