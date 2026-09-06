/**
 * HOW BIG IS THE DEPLOY TRANSACTION — WITHOUT A CHAIN AND WITHOUT A PROVER.
 * `C218`, `R1c` item 3.
 *
 * Run it with MEASURE-TX-SIZE.command, or:
 *   npx tsx scripts/measure-tx-size.ts
 *
 * ── WHAT THIS ANSWERS, AND WHAT IT CANNOT ────────────────────────────────────
 *
 * On 28 Aug the deploy was refused with *"Transaction would exhaust the block
 * limits"* and nobody knew how big the transaction was. `deploy-preview.ts` now
 * prints that on every run, but a run needs a funded wallet, a live node and
 * the RIGHT proof server — and on 28 Aug the wrong one held the port.
 *
 * **THIS FILE NEEDS NONE OF THEM.**
 * `createUnprovenDeployTxFromVerifierKeys` builds the deploy transaction from
 * the compiled artefacts on disk and two sampled public keys. No node, no
 * indexer, no proof server, no wallet, nothing spent.
 *
 * WHAT IT PRODUCES IS A FLOOR, NOT THE NUMBER. The transaction it builds is
 * UNPROVEN and UNBALANCED:
 *
 *   - proving replaces each `ProofPreimage` with a `Proof`, which is larger;
 *   - balancing adds the Zswap offer and the DUST spends that pay the fee.
 *
 * **What it measures exactly is the part neither of those changes: the
 * `ContractDeploy` and its initial `ContractState`, which carries one verifier
 * key per circuit and is identical in the transaction the node refused.** That
 * is the part `R1c` asks to isolate — *"if the size is dominated by per-circuit
 * artefacts, say so with the numbers"* — and it is the part a contract split
 * would change. So the floor is the number that decides the question the round
 * is actually asking, and the total is reported as a floor and labelled one.
 *
 * ── THE COMPARISON ───────────────────────────────────────────────────────────
 *
 * Against `block_limits.block_usage`, and the derivation of that limit, the
 * `serialize()`-is-the-right-number argument and the node's path from
 * `ExhaustsResources` to `1010` are all set out in `scripts/tx-size.ts`. This
 * file is the instrument; that one is the reasoning and the `file:line`s.
 *
 * ── THE PRIVATE STATE HERE IS A FIXTURE AND CHANGES NO SIZE ──────────────────
 *
 * The constructor's witnesses are shaped after `MidnightLedger.open`
 * (`src/midnight/ledger.ts:346-373`), which is the authority; that path is NOT
 * modified and is not called. The values are deterministic filler because none
 * of them can change a byte count: they are hashed into fixed-width
 * commitments, and a commitment is the same size whatever it commits to. If
 * that ever stops being true this file's number stops being a floor, and the
 * check for it is cheap — the per-circuit verifier-key total printed below is
 * read off the built transaction, not off the disk, so a shape change shows up
 * as a disagreement with `contracts/managed/keys`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';

import { Contract } from '../contracts/managed/contract/index.js';
import { witnesses } from '../contracts/src/witnesses.js';
import { applyNetworkId, networkFromEnv } from '../src/midnight/network.js';
import { assetIdBytes, NO_ASSET } from '../src/core/assets.js';
import { compareAgainstLimits, compareCost, limitsFromLedger, measureCost, measureTransaction } from './tx-size.js';

const ROOT = process.cwd();
const ARTIFACTS = join(ROOT, 'contracts', 'managed');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');
const THRESHOLD = 2;

const line = (s = '') => console.log(s);
const bytes = (n: number) => `${n.toLocaleString()} bytes`;

async function main() {
  line('────────────────────────────────────────────────────────────');
  line('  How big is the account deploy transaction?');
  line('────────────────────────────────────────────────────────────');
  line();
  line('  No node, no indexer, no proof server, no wallet. Nothing is spent and');
  line('  nothing is submitted.');
  line();

  const ledger: any = await import('@midnightntwrk/ledger-v9');
  applyNetworkId(NETWORK);
  line(`  network id  ${NETWORK}`);

  /* ---------------------------------------------------- the artefacts on disk */
  
  // Read first and printed first, because it is the free measurement and it is
  // the one that survives if everything below fails.
  const keysDir = join(ARTIFACTS, 'keys');
  const verifiersOnDisk = readdirSync(keysDir)
    .filter((f) => f.endsWith('.verifier'))
    .map((f) => ({ name: f.replace(/\.verifier$/, ''), size: statSync(join(keysDir, f)).size }))
    .sort((a, b) => b.size - a.size);
  const verifierTotal = verifiersOnDisk.reduce((t, v) => t + v.size, 0);

  line();
  line(`  \x1b[1mVerifier keys on disk — ${verifiersOnDisk.length} circuits\x1b[0m`);
  for (const v of verifiersOnDisk) line(`    ${v.name.padEnd(20)} ${String(v.size).padStart(8)}`);
  line(`    ${'TOTAL'.padEnd(20)} ${String(verifierTotal).padStart(8)}`);

  /* --------------------------------------------------------------- the limits */
  const limits = limitsFromLedger(ledger.LedgerParameters);
  line();
  line('  \x1b[1mThe chain\x27s limits, derived from this project\x27s own ledger\x1b[0m');
  line(`    block usage    ${limits.blockUsage === null ? '(could not derive)' : bytes(limits.blockUsage)}`);
  line(`    bytes written  ${limits.bytesWritten === null ? '(could not derive)' : bytes(limits.bytesWritten)}`);
  line(`    bytes churned  ${limits.bytesChurned === null ? '(could not derive)' : bytes(limits.bytesChurned)}`);
  line(`    read time      ${limits.readTime === null ? '(could not derive)' : `${limits.readTime.toLocaleString()} ps`}`);
  line(`    compute time   ${limits.computeTime === null ? '(could not derive)' : `${limits.computeTime.toLocaleString()} ps`}`);
  line(`    ${limits.source}`);
  if (limits.problem) line(`    could not derive: ${limits.problem}`);

  /* --------------------------------------------- build the unproven deploy tx */
  line();
  line('  \x1b[1mBuilding the deploy transaction (unproven, unbalanced)\x1b[0m');

  const compiledContract = CompiledContract.make('ConfidentialAccount', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(ARTIFACTS),
  );
  const zkConfigProvider = new NodeZkConfigProvider<string>(ARTIFACTS);

  const filler = (b: number) => new Uint8Array(32).fill(b);
  /*
   * `view` STOOD HERE — `{ balance, balanceSalt }`, handed in twice as
   * `current` and `next`. It went with the balance ledger under `C292`/`S26`:
   * the account keeps no books of its own, `AccountPrivateState` no longer
   * carries a `current`/`next` pair, and the contract declares no witness that
   * would read one.
   *
   * NOTHING IT ENFORCED SURVIVES HERE, and nothing needed to: this script
   * measures the SIZE of a deploy transaction. The fields below are what a
   * device still holds, filled with stand-in bytes because only their shape
   * affects the measurement.
   *
   * **"THE CONSTRUCTOR READS NONE OF THESE WITNESSES" STOOD IN THIS COMMENT
   * AND WAS FALSE WHEN IT WAS WRITTEN.** The constructor read `localSecretKey`,
   * `signerBlinding` and `signerScope` at `ConfidentialAccount.compact:1210-1211`
   * and seated the leaf it committed from them. **`C334` made the sentence
   * true**, so it is kept — and `secretKey`, `blinding` and `scope` are gone
   * from the record below, because a filler for a witness nothing calls is
   * three lines pretending to matter.
   */
  const initialPrivateState: any = {
    assetBlinding: filler(4),
    assetId: assetIdBytes(NO_ASSET),
    proposalSalt: filler(5),
    changeAmount: 0n,
    changeBatchDigest: filler(6),
    pinnedPath: null,
  };

  let unprovenTx: any;
  try {
    const built: any = await contracts.createUnprovenDeployTxFromVerifierKeys(
      zkConfigProvider,
      ledger.sampleCoinPublicKey(),
      {
        compiledContract,
        /*
         * TWO ARGUMENTS SINCE `C334`: the threshold, then the FOUNDING
         * SIGNER'S LEAF. The leaf is a stand-in here for the same reason every
         * other value in this file is — only its SIZE reaches the measurement,
         * and a leaf is 32 bytes whoever it belongs to. It must not be zero or
         * `vacantSlot()`: the constructor's own guards refuse both, and a
         * refusal here would be measured as a transaction that does not build.
         */
        args: [BigInt(THRESHOLD), filler(7)],
        initialPrivateState,
        signingKey: ledger.sampleSigningKey(),
      } as any,
      ledger.sampleEncryptionPublicKey(),
    );
    unprovenTx = built?.private?.unprovenTx ?? built?.unprovenTx;
    if (!unprovenTx) throw new Error('the SDK returned no unprovenTx — its shape has changed');
  } catch (e: any) {
    line();
    line(`  \x1b[33mThe transaction could not be built: ${String(e?.message ?? e)}\x1b[0m`);
    line();
    line('  NOTHING BELOW WAS ESTIMATED. The verifier-key total above is still a');
    line('  real measurement and is still the part a contract split would change.');
    line(`  Verifier keys, ${verifiersOnDisk.length} circuits: ${bytes(verifierTotal)}.`);
    if (limits.blockUsage !== null) {
      line(`  Block usage limit: ${bytes(limits.blockUsage)} — the keys alone are ` +
           `${((verifierTotal / limits.blockUsage) * 100).toFixed(1)}% of it.`);
    }
    process.exit(2);
  }

  const m = measureTransaction(unprovenTx, 'unproven, unbalanced');
  line(`    built — ${m.bytes === null ? `not measurable: ${m.problem}` : bytes(m.bytes)}`);

  line();
  line('  \x1b[1mThe comparison\x1b[0m');
  for (const l of compareAgainstLimits(m, limits)) line(`    ${l}`);

  /* THE OTHER FOUR DIMENSIONS. Bytes are one of five and the largest decides. */
  line();
  for (const l of compareCost(measureCost(unprovenTx, ledger.LedgerParameters), limits)) line(`    ${l}`);

  line();
  line('  \x1b[1mWhat this number is and is not\x1b[0m');
  line('    IT IS A FLOOR. This transaction is unproven and unbalanced. Proving');
  line('    replaces each proof preimage with a larger proof, and balancing adds');
  line('    the Zswap offer and the DUST spends that pay the fee. The submitted');
  line('    transaction is larger than this, and by how much is not known from');
  line('    here — DEPLOY-PREVIEW.command prints the submitted size on every run.');
  line('    The contract deploy and its verifier keys are the same in both.');

  line();
  line('  Nothing was submitted and nothing was spent.');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  It did not finish: ${String(e?.message ?? e)}\x1b[0m`);
    if (e?.stack) console.log(`\x1b[2m${String(e.stack).split('\n').slice(1, 8).join('\n')}\x1b[0m`);
    process.exit(1);
  },
);
