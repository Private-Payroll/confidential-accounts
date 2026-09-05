/**
 * Whose bug is it? Prove the smallest circuit and the failing one, side by side.
 *
 *   npx tsx scripts/prove-compare.ts     (or PROVE-TEST.command)
 *
 * `addSigner` blocks for 20+ minutes inside `unprovenTx.prove()` — a WASM
 * method in @midnight-ntwrk/ledger — even though the proof server answers
 * `/check` in 7ms and `/prove` in 2.03s and is then never contacted again.
 *
 * That stall is inside a Foundation package. It does not follow that it is a
 * Foundation bug: we hand `prove()` a transaction we built, and a bad input
 * could make their WASM spin. This test tells the two apart.
 *
 *   attestSolvency   2.2K zkir, 2.7M prover key, no Merkle path, no tree insert
 *   addSigner        9.5K zkir, 5.0M prover key, membership proof + insert
 *
 * If the small one proves and the big one hangs, the problem is specific to
 * `addSigner` or to the transaction we build for it, and it is ours.
 * If both hang, it is environmental or in the SDK.
 *
 * NO WALLET, NO DUST, NO SUBMITTING. It builds and proves, nothing else, so it
 * costs about a minute instead of the five spent waiting for a dust wallet to
 * sync. Nothing is spent and nothing reaches the chain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import * as CC from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { createUnprovenCallTxFromInitialStates } from '@midnight-ntwrk/midnight-js-contracts';
import { ContractState } from '@midnight-ntwrk/compact-runtime';

/**
 * `ContractState.deserialize` takes (bytes, networkId) at runtime — verified by
 * executing it — but the published .d.ts declares a single parameter. Aliased
 * here so the discrepancy is stated once, rather than hidden under an `as any`
 * at the call site. Casts at call sites are what hid M-19a, M-27 and M-28.
 */
const deserializeContractState =
  ContractState.deserialize as unknown as (bytes: Uint8Array, networkId: string) => any;
import { ZswapChainState, LedgerParameters } from '@midnight-ntwrk/midnight-js-protocol/ledger';

import { Contract, pureCircuits } from '../contracts/managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../contracts/src/witnesses.js';
import { applyNetworkId, networkFromEnv, ENDPOINTS } from '../src/midnight/network.js';
import { assetIdBytes } from '../src/core/assets.js';
import { isDeployedCircuit } from '../src/midnight/deferral.js';
import {
  previewSignersFile, readOrCreatePreviewSigners, signerBytes,
} from './preview-signers.js';

const ROOT = process.cwd();
const ARTIFACTS = join(ROOT, 'contracts', 'managed');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');

const CONTRACT_FILE = join(ROOT, '.midnight', `${NETWORK}-contract.json`);
const PROVER = `http://localhost:${process.env.MIDNIGHT_PROVER_PORT || 6301}`;
/** Per circuit. Two circuits, so the whole test is bounded at twice this. */
const PER_CIRCUIT_MS = Number(process.env.MIDNIGHT_PROVE_TIMEOUT_MS || 4 * 60_000);

const good = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const note = (s: string) => console.log(`  ${s}`);

const seededBytes = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};

/*
 * WHAT THIS COPY IS STILL FOR, NOW THAT IT DECIDES NO IDENTITY. `C334`.
 *
 * It fills the asset blinding, the proposal salt and the batch digest below —
 * values a measurement needs to be the same on two runs and that no seat
 * depends on. The two it USED to fill, `secretKey` and `blinding`, are read
 * from `.midnight/` instead.
 */
const STATE_DIR = join(ROOT, '.midnight');
const ACCOUNT_ID = 'default';

/**
 * **SIGNER A AND B ARE READ FROM `.midnight/`, NOT COMPUTED.** `C334`, `S35`.
 *
 * Their identities used to be `seededBytes(1)`/`seededBytes(401)` and
 * `seededBytes(2)`/`seededBytes(402)` — a published formula, on signers seated
 * on a real account. `DEPLOY-PREVIEW.command` now writes real entropy into a
 * gitignored per-account file and this reads it, so this script still
 * reconstructs exactly the devices the deploy seated and nothing in the
 * repository names either of them.
 *
 * A REFUSAL RATHER THAN A FRESH SET: `readOrCreatePreviewSigners` would make
 * one, and a fresh set is a device that is not on the account this script is
 * about to read. The door that creates the file is named (rule 19).
 */
const previewSignersPath = previewSignersFile(STATE_DIR, NETWORK, ACCOUNT_ID);
if (!existsSync(previewSignersPath)) {
  throw new Error(
    `there is no demo signer material for "${ACCOUNT_ID}" on ${NETWORK}: ` +
      `${previewSignersPath.replace(ROOT + '/', '')} does not exist.\n` +
      'Run DEPLOY-PREVIEW.command, then run this again.',
  );
}
const PREVIEW_SIGNERS = readOrCreatePreviewSigners(STATE_DIR, NETWORK, ACCOUNT_ID).signers;

/**
 * Which asset this is measuring against. M-125.
 *
 * A circuit moves ONE asset, and every witness below is about that one. Nothing
 * here is a currency decision — proving cost does not depend on which asset it
 * is.
 *
 * IT USED TO MATTER MORE THAN THAT. `attestSolvency` asserted the account held
 * this asset before it would look at a balance, so the code named here had to
 * be one the chain actually carried. `S23` shed that circuit, and `C292`/`S26`
 * shed the balance ledger it read, so there is no such precondition left to
 * satisfy — and nothing here is proved today in any case; see the refusal in
 * `main`.
 */
const ASSET = 'GBP';

/**
 * Signer A's private state, identical to what the deploy used.
 *
 * `current` AND `next` STOOD HERE — a `{ balance, balanceSalt }` pair each, one
 * standing for 0 and the other for 250,000 minor units. Both went with the
 * balance ledger under `C292`/`S26`: `AccountPrivateState` no longer carries
 * them, and the four witnesses that read them are gone from the contract.
 *
 * WHAT THEY ENFORCED WAS AGREEMENT WITH THE CHAIN — `attestSolvency`
 * recomputed the balance commitment from these witnesses and asserted it
 * equalled the on-chain entry before it would answer. None of that survives:
 * `S23` shed the circuit, `C292` shed the map, and no circuit the contract
 * still declares compares this device's state against anything on chain.
 *
 * `assetId` and `assetBlinding` ARE still read. They no longer address a map
 * entry; `assetKeyOf(assetId, assetBlinding)` is now the first field of the
 * change commitment a proposal is approved under, and the blinding still has to
 * be the one the deploy wrote or a signer recomputes a different commitment
 * from the one the proposer made.
 *
 * M-128 removed `entriesDigest`: the entry log was a running digest every
 * transition had to carry, and the chain holds an append-only set of movement
 * commitments instead, which needs nothing carried between transactions.
 */
const signerA: AccountPrivateState = {
  ...signerBytes(PREVIEW_SIGNERS.A),
  scope: pureCircuits.allVaults(),
  assetBlinding: seededBytes(501),
  assetId: assetIdBytes(ASSET),
  proposalSalt: seededBytes(301),
  // Unused by the constructor, but the type is one record and a partial one
  // would not typecheck. M-71.
  changeAmount: 0n,
  changeBatchDigest: seededBytes(601),
  pinnedPath: null,
};

async function main() {
  console.log('────────────────────────────────────────────────────────────');
  console.log('  Prove the smallest circuit, then the failing one');
  console.log('────────────────────────────────────────────────────────────');
  console.log();

  if (!existsSync(CONTRACT_FILE)) throw new Error('no deployed contract; run DEPLOY-PREVIEW.command first');
  const { contractAddress } = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  await applyNetworkId(NETWORK);

  // The proof server has to be up, but nothing else does.
  const health = await fetch(`${PROVER}/health`).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`no proof server at ${PROVER}. Start it, or run RUN-PROPOSAL.command once.`);
  good(`proof server responding at ${PROVER}`);

  const e = ENDPOINTS[NETWORK]!;
  const publicData: any = indexerPublicDataProvider(e.indexerUrl, e.indexerWsUrl);
  const tuple: any = await publicData.queryZSwapAndContractState(contractAddress);
  if (!tuple) throw new Error('the indexer has no state for this contract');
  const [zswapChainState, contractStateFromIndexer] = tuple;
  good('fetched contract and zswap state from the indexer');

  const contractState =
    contractStateFromIndexer ??
    deserializeContractState(new Uint8Array(readFileSync(join(ROOT, '.midnight', `${NETWORK}-state.dump`))), NETWORK);

  const compiled = CC.make('ConfidentialAccount', Contract as any).pipe(
    CC.withWitnesses(witnesses as any),
    CC.withCompiledFileAssets(ARTIFACTS as never),
  ) as any;
  const zkConfigProvider = new NodeZkConfigProvider<string>(ARTIFACTS);
  const proofProvider: any = httpClientProofProvider(PROVER, zkConfigProvider);

  /* --- the watchdog, so a hang is bounded and named rather than endless --- */
  // Nine slots, not seven: the watchdog reads two more (M-46 fee accounting).
  const sharedBuffer = new SharedArrayBuffer(9 * 8);
  const shared = new BigInt64Array(sharedBuffer);
  const PULSE = 0, IN_FLIGHT = 1, STEP = 2, STEP_START = 3;
  const pulse = () => Atomics.store(shared, PULSE, BigInt(Date.now()));
  pulse();
  setInterval(pulse, 2000).unref();
  const watchdog = new Worker(new URL('./watchdog.mjs', import.meta.url), {
    workerData: { sharedBuffer, timeoutMs: PER_CIRCUIT_MS, heartbeatMs: 15_000, label: 'proving', witnessNames: [] },
  });
  watchdog.unref();

  /** Builds a transaction for one circuit and proves it, timing both halves. */
  async function tryCircuit(circuitId: string, args: unknown[]) {
    console.log();
    console.log(`\x1b[1m  ${circuitId}\x1b[0m`);
    watchdog.postMessage({ label: `proving ${circuitId}` });

    const tBuild = Date.now();
    let unproven: any;
    try {
      unproven = await createUnprovenCallTxFromInitialStates(
        zkConfigProvider,
        {
          compiledContract: compiled,
          circuitId,
          contractAddress,
          args,
          initialPrivateState: signerA,
          initialContractState: contractState,
          initialZswapChainState: zswapChainState ?? new ZswapChainState(),
          ledgerParameters: LedgerParameters.initialParameters(),
          coinPublicKey: '00'.repeat(32),
        } as any,
        '00'.repeat(32),
      );
    } catch (err: any) {
      bad(`could not even build the transaction: ${String(err?.message ?? err).slice(0, 160)}`);
      return { circuitId, build: Date.now() - tBuild, prove: null, error: String(err?.message ?? err) };
    }
    good(`built the unproven transaction in ${((Date.now() - tBuild) / 1000).toFixed(1)}s`);

    // The line that hangs for addSigner. Everything above it is known good.
    Atomics.store(shared, STEP_START, BigInt(Date.now()));
    Atomics.store(shared, IN_FLIGHT, 1n);
    Atomics.add(shared, STEP, 1n);
    pulse();
    const tProve = Date.now();
    try {
      await proofProvider.proveTx(unproven.private.unprovenTx, { circuitId });
      const secs = (Date.now() - tProve) / 1000;
      Atomics.store(shared, IN_FLIGHT, 0n);
      good(`\x1b[1mPROVED in ${secs.toFixed(1)}s\x1b[0m`);
      return { circuitId, build: Date.now() - tBuild, prove: secs, error: null };
    } catch (err: any) {
      Atomics.store(shared, IN_FLIGHT, 0n);
      bad(`proving failed after ${((Date.now() - tProve) / 1000).toFixed(1)}s`);
      note(`  ${String(err?.message ?? err).slice(0, 200)}`);
      return { circuitId, build: Date.now() - tBuild, prove: null, error: String(err?.message ?? err) };
    }
  }

  /*
   * SMALLEST FIRST — AND THE SMALLEST ONE NO LONGER EXISTS. S25.
   *
   * `attestSolvency` was this comparison's small end: 2.2K zkir, 2.7M prover
   * key, no Merkle path, no tree insert. `S23` shed it from the contract, so
   * `tryCircuit` would now fail on an undefined circuit and the comparison
   * would report a hang where there is only a missing name.
   *
   * Refusing rather than substituting: every circuit the contract still
   * declares writes state, so a replacement is a deliberate choice of WHAT to
   * write and to which account, not a name swapped in here. That decision is
   * `M-152`, which `scripts/sponsor-test.ts` is already blocked on for the same
   * reason.
   */
  if (!isDeployedCircuit('attestSolvency')) {
    console.log();
    console.log('  REFUSED before anything was built or proved.');
    console.log('  This comparison\'s small circuit is attestSolvency, which S23 shed from the');
    console.log('  contract. There is no drop-in replacement: every circuit the account still');
    console.log('  declares writes state, so choosing one is a decision about what this script');
    console.log('  is allowed to change — M-152, the same door SPONSOR-TEST.command waits at.');
    process.exitCode = 1;
    return;
  }
  const small = await tryCircuit('attestSolvency', [0n]);

  const bBytes = signerBytes(PREVIEW_SIGNERS.B);
  const leafB = pureCircuits.signerLeaf(
    pureCircuits.signerPublicKey(bBytes.secretKey), bBytes.blinding, pureCircuits.allVaults());
  /*
   * Three arguments, and the last two are what M-128 and M-106 added.
   *
   *   proposal          which approved proposal authorises this. Ignored on the
   *                     bootstrap path, which is the path this takes — an
   *                     account below its own threshold is still being set up —
   *                     so a 32-byte zero is the honest filler. It is a value
   *                     `persistentCommit` can never produce, so it cannot
   *                     collide with a real proposal id.
   *   intoVacatedSlot   false: append into a fresh slot rather than reusing one
   *                     a removal freed. Nothing has been removed here, and
   *                     asking to reuse would fail the proof — which would
   *                     answer a question this script is not asking.
   */
  /* Since S11 the seating circuit is `amendSigner`: two more Booleans —
   * `intoVacatedSlot` false as before, and `removing` false (this is a seat). */
  const big = await tryCircuit('amendSigner', [leafB, new Uint8Array(32), false, false]);

  console.log();
  console.log('\x1b[1m  Result\x1b[0m');
  for (const r of [small, big]) {
    const p = r.prove === null ? '\x1b[31mfailed or hung\x1b[0m' : `\x1b[32m${r.prove.toFixed(1)}s\x1b[0m`;
    console.log(`    ${r.circuitId.padEnd(16)} build ${(r.build / 1000).toFixed(1)}s   prove ${p}`);
  }

  console.log();
  if (small.prove !== null && big.prove === null) {
    console.log('  \x1b[1mThe small circuit proves and the big one does not.\x1b[0m');
    console.log('  The problem is specific to addSigner or to the transaction we');
    console.log('  build for it. That is ours to find, not the Foundation\'s.');
  } else if (small.prove === null && big.prove === null) {
    console.log('  \x1b[1mNeither proves.\x1b[0m');
    console.log('  Not circuit-specific, so it is environmental or in the SDK.');
    console.log('  Now it is worth reporting, with these numbers.');
  } else if (small.prove !== null && big.prove !== null) {
    console.log('  \x1b[1mBoth prove.\x1b[0m Whatever broke the earlier run is not here —');
    console.log('  most likely something about the wallet or submission path, which');
    console.log('  this test deliberately skips.');
  } else {
    console.log('  \x1b[1mThe big one proves and the small one does not.\x1b[0m Unexpected;');
    console.log('  send this output back.');
  }
  console.log();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  Could not finish: ${e?.message ?? e}\x1b[0m`);
    if (e?.stack) console.log(`\x1b[2m${e.stack.split('\n').slice(1, 6).join('\n')}\x1b[0m`);
    process.exit(1);
  },
);
