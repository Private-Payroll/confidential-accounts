/**
 * M-3 / M-5: put the account contract on the preview network and read it back.
 *
 * Run it with DEPLOY-PREVIEW.command, or:
 *   npx tsx scripts/deploy-preview.ts
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It uses ONE wallet, which pays its own
 * fees. It does not exercise the two-phase fee sponsorship of decision 0001.
 * That is the next script, and it is separate on purpose: six failures in a row
 * came from changing several things at once and not knowing which layer broke.
 * Deployment and sponsorship are two variables. Prove the first, then add the
 * second.
 *
 * STRUCTURE. Every stage announces itself before it runs and prints what it
 * learned after. When it fails, the last line printed names the layer. That is
 * the whole point: previously each failure cost a round trip to locate.
 *
 * WHY tsx AND NOT node. This imports contracts/src/witnesses.ts through a .js
 * specifier, which is the TypeScript convention. Plain node cannot resolve it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import {
  StaticProofServerContainer,
  WalletSeeds,
  MidnightWalletProvider,
  createDefaultTestLogger,
} from '@midnight-ntwrk/testkit-js';
import { withRetry } from '../src/midnight/retry.js';
import { MidnightLedger, privateStateKey } from '../src/midnight/ledger.js';
import {
  requireMaintenanceAuthority, describeMaintenanceAuthority,
  type MaintenanceAuthorityChoice,
} from '../src/midnight/partial-contract.js';
import { DEPLOYED_CIRCUITS, DEFERRED_CIRCUITS } from '../src/midnight/deferral.js';
import { FileSealedStateStore } from '../src/midnight/sealed-store.js';
import { GENESIS_KEY_EPOCH } from '../src/core/account.js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract, ledger as readLedger } from '../contracts/managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../contracts/src/witnesses.js';
import { applyNetworkId, networkFromEnv, ENDPOINTS } from '../src/midnight/network.js';
import type { AccountOpening } from '../src/core/ledger.js';
import { toHex as toHexBytes, randomBytes } from '../src/core/crypto.js';
import { assets, type AssetId } from '../src/core/assets.js';
import { explainNodeError, NODE_ERROR_CODES } from './node-errors.js';
import { installDustWallet, saveDustState, waitForDustCatchUp } from './dust-wallet.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { readOrCreatePreviewSigners } from './preview-signers.js';
import { storedSignerLeaf } from '../src/core/signer-leaf.js';
import { MidnightCommitments } from '../src/midnight/commitments.js';
import { collapseRepeatedLines, describeDropped, serialiseWholeDetailed } from './error-report.js';
import {
  compareAgainstLimits, compareCost, limitsFromLedger, measuringProviders,
  type BlockLimits, type TxMeasurement,
} from './tx-size.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
/*
 * Per network, not per project.
 *
 * These were hardcoded to `preview-*` while there was only ever one network. A
 * contract address is meaningless on a different chain, and Stagenet is wiped
 * on a schedule, so reading a stale address is a guaranteed confusing failure.
 * The wallet seed is chain-agnostic — the same key, funded separately on each
 * network — so it deliberately keeps one name.
 */
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
/*
 * The maintenance authority the deploy will set, chosen OUTSIDE this script.
 * S8c, C225. There is no default and no sampling: an absent file is a refusal
 * at stage 1, with the options printed. Single-key mode holds key material,
 * which is why this lives beside wallet.seed in the gitignored state
 * directory rather than anywhere the repo carries.
 */
const AUTHORITY_FILE = join(STATE_DIR, 'maintenance-authority.json');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');

const OUT_FILE = join(STATE_DIR, `${NETWORK}-contract.json`);
const ARTIFACTS = join(ROOT, 'contracts', 'managed');

/**
 * The private state store, per network.
 *
 * It was `confidential-accounts-preview` everywhere, hardcoded, from when there
 * was one network. On Stagenet the deploy wrote its state under one id and the
 * read-back looked for another, and `findDeployedContract` failed with
 * "No private state found at private state ID 'confidential-accounts-preview'"
 * — after a successful deployment, which is the worst moment to find out.
 *
 * Deliberately network-scoped rather than global: the private state holds
 * signer secrets tied to a specific deployment, and two chains sharing one
 * store would silently mix them.
 */
const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;

/*
 * The account this script drives, and where its private state is filed.
 *
 * `PRIVATE_STATE_ID` is the level-db store NAME; `PRIVATE_STATE_KEY` is the key
 * inside it. They were the same string until M-68, when the deploy moved into
 * `MidnightLedger` — which serves many accounts and therefore composes the key.
 * Two conventions would mean the run script looking for a key the deploy never
 * wrote, so the composition is one exported function and both sides call it.
 */
const ACCOUNT_ID = 'default';
const PRIVATE_STATE_KEY = privateStateKey(PRIVATE_STATE_ID, ACCOUNT_ID);
/*
 * **THE DEMO SIGNERS' MATERIAL, WHICH THIS SCRIPT NO LONGER COMPUTES FROM A
 * FORMULA.** `C334`, `S35`. `scripts/preview-signers.ts` is where the reasoning
 * is; what matters here is that the file is per network AND per account, is
 * generated once with real entropy, is reused for ever after, and lives under
 * `.midnight/`, which is gitignored.
 */
/*
 * 6301, NOT 6300. M-144.
 *
 * Two proof servers run on this machine: `8.1.0` on 6300 and the pinned one on
 * 6301. The pinned image is `9.0.0-rc.3` — the prover built from the ledger
 * release the running node is built from
 * (midnight-node@d9729c13/Cargo.toml:445 -> crate-ledger-9.1.0.0-rc.3 ->
 * proof-server/Cargo.toml 9.0.0-rc.3), alongside ledger 1.0.0-rc.3, onchain
 * runtime 4.0.0-rc.3, midnight.js 5.0.0-beta.4 and compiler 0.33.0 — every one
 * of which we already match.
 *
 * IT SAID `9.0.0-rc.5_experimental` UNTIL 28 AUG 2026, on the authority of
 * Midnight's Stagenet delivery document — a draft edited forward of the running
 * network. rc.5 was published between ledger releases and is built from none
 * this node uses, which left the proof server as the single component pointed
 * at the wrong build. `docs/stagenet.md` carries the derivation;
 * `DEPLOY-PREVIEW.command:32` the full reason. The port was separately wrong in
 * every script except `sponsor-test.ts`.
 *
 * A proof server from a different line produces proofs the node's fee check
 * refuses, which is `InvalidDustSpendProof` — node error 170.
 */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);

/**
 * **HOW MANY APPROVALS THE DEPLOYED ACCOUNT WILL REQUIRE, AND SINCE `S35d` IT
 * IS ONE AND IS NOT A CHOICE.** `C340` + `C343`, the founder, 2 Sep.
 *
 * The constructor took the threshold as an argument and this constant was what
 * the deploy passed. It takes no threshold now and sets `threshold = 1`, so
 * **the chain's number is a literal in the contract** and nothing this script
 * chooses can change it.
 *
 * `ACCOUNT_THRESHOLD` IS THEREFORE GONE RATHER THAN IGNORED. An environment
 * variable that reads as a knob and moves nothing is worse than no variable:
 * the read-back check below would have thrown on a spent fee the first time
 * anybody set it, which is exactly what this constant did before it was
 * corrected.
 *
 * The value is still written into the opening — `AccountOpening` still carries
 * it, `SimulatedLedger` still uses it, and `MidnightLedger.open` still refuses
 * a bad one for our own record — so it is stated here once, as the number the
 * contract will actually hold.
 */
const THRESHOLD = 1n;

/**
 * WHICH ASSET the run script will move on this account. M-125.
 *
 * The account itself is not tied to it. IT USED TO HOLD ONE `assetBalances`
 * entry per asset, opened by the first `credit` of each; the map and every
 * circuit that wrote it went under `C292`/`S26`, and the account keeps no books
 * of its own. What this names is the asset the SCRIPTS drive, and it has to be
 * written down here because the view file below is what tells `run-preview.ts`
 * and `sponsor-test.ts` which asset they are working in — the asset a
 * proposal's change commitment is bound to. An amount with no asset has no
 * decimal place and no meaning, so there is deliberately no default further
 * down the line.
 *
 * Resolved through the registry at startup rather than trusted, so an unknown
 * code fails here in a second instead of inside a proof after four minutes of
 * wallet sync.
 */
const RUN_ASSET: AssetId = (process.env.ACCOUNT_ASSET || 'GBP').toUpperCase();

/**
 * Encrypts the private state store at rest.
 *
 * Validated at startup against the SDK's own rules: 16+ characters and at
 * least 3 of uppercase / lowercase / digits / special.
 */
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';


let stage = 'startup';

/**
 * HOW LONG EACH PHASE TOOK, RECORDED AS IT GOES.
 *
 * `R1b` requires the elapsed time of each phase in the report. It is not
 * cosmetic: the only proving figure this project has ever reasoned from is a
 * number derived from a settlement total (`C180`), and a phase table is the
 * cheapest honest observation of where a deploy's minutes actually go. It is
 * printed on SUCCESS AND ON REFUSAL alike — a refusal after nine minutes in
 * "Deploying" and a refusal after four seconds are different failures, and the
 * error text is identical in both.
 *
 * Wall clock, one process, no averaging and no estimate. A phase that never
 * started has no row rather than a zero.
 */
const phases: { name: string; ms: number }[] = [];
let phaseStartedAt = Date.now();

/** Closes the phase named by `stage` and starts the clock on the next one. */
const closePhase = () => {
  phases.push({ name: stage, ms: Date.now() - phaseStartedAt });
  phaseStartedAt = Date.now();
};

/**
 * `outcome` is 'finished' when the last phase completed and 'stopped' when it
 * did not. The distinction is the point: an unfinished phase's elapsed time is
 * how long the run spent before giving up, and labelling it like a completed
 * one would report a duration for work that never happened.
 */
const printPhases = (outcome: 'finished' | 'stopped') => {
  const rows = [
    ...phases,
    { name: outcome === 'finished' ? stage : `${stage}  (did not finish)`, ms: Date.now() - phaseStartedAt },
  ];
  const w = Math.max(...rows.map((r) => r.name.length), 5);
  console.log();
  console.log('  \x1b[1mHow long each phase took\x1b[0m');
  for (const r of rows) console.log(`    ${r.name.padEnd(w)}  ${(r.ms / 1000).toFixed(1)}s`);
  console.log(`    ${'total'.padEnd(w)}  ${(rows.reduce((t, r) => t + r.ms, 0) / 1000).toFixed(1)}s`);
};

const begin = (n: number, of: number, name: string) => {
  closePhase();
  stage = name;
  console.log(`\n\x1b[1m${n} of ${of}  ${name}\x1b[0m`);
};
const note = (s: string) => console.log(`  ${s}`);
const good = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
/*
 * `hex` USED TO BE HERE. It existed to print the on-chain `stateCommitment`,
 * which M-125 replaced with a map of per-asset commitments — none of which a
 * fresh deploy holds. Nothing in this script has bytes to print any more, and a
 * helper kept for the day something might is a helper nobody checks.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * The rejection code arrives on the console, not in the exception.
 *
 * Polkadot's RPC layer logs `1010: Invalid Transaction: Custom error: 170` and
 * then throws a `SubmissionError: Transaction submission error` that carries
 * none of it. Annotating the log line is the only place the number and its
 * meaning can be put next to each other.
 */
let annotatedConsole = false;

/**
 * EVERY LINE THE NODE'S RPC LAYER PRINTED THAT CARRIES A REJECTION, VERBATIM.
 *
 * `R1b`: *"on refusal: the node's error IN FULL, with its numeric code,
 * unabridged and unparaphrased."* The exception cannot supply that — it is
 * `SubmissionError: Transaction submission error` and carries neither the code
 * nor the node's words. The code arrives on the console, from Polkadot's RPC
 * layer, and is discarded the moment it scrolls.
 *
 * So it is kept here, untruncated and unparsed, and reprinted in the failure
 * block. `describeError` explains and abbreviates, which is right for a reader
 * and wrong for evidence; these are the node's own bytes.
 */
const rawNodeLines: string[] = [];

/**
 * The proof server this run used, by image and by what it answered.
 *
 * Module level rather than local so the FAILURE path can print it too. A
 * refusal that does not say which prover built the proof is worth nothing to
 * `C211`, which is the question this whole run exists to settle.
 */
let proofServerImage = '(not established)';
let proofServerVersion = '(not asked)';

/**
 * HOW BIG THE TRANSACTION WAS, AND HOW BIG A BLOCK IS. `C218`, `R1c` item 3.
 *
 * Module level for the same reason `proofServerImage` is: the FAILURE path has
 * to print them. The 28 Aug run was refused with
 * *"Transaction would exhaust the block limits"* and nothing in the report said
 * how big the transaction was — the one number that would have answered it.
 *
 * Filled by the measuring wrappers in `scripts/tx-size.ts` as each stage of the
 * pipeline hands a transaction on, and printed by `printTxSize()` on BOTH
 * paths. `R1c`: *"on every run, success or failure. It costs nothing and it is
 * the number this round exists to produce."*
 */
const txMeasurements: TxMeasurement[] = [];
let blockLimits: BlockLimits | null = null;
/**
 * The ledger's `LedgerParameters`, held so the FIVE dimensions can be read off
 * each transaction and not just its byte count.
 *
 * `block_usage` is one of five — read time, compute time, block usage, bytes
 * written, bytes churned — and the node takes the LARGEST
 * (`midnight-node@d9729c13`, `ledger/src/versions/common/mod.rs:1165`). A
 * report of the byte count alone answers the easy half of `C218` and would
 * have missed the answer: measured offline by `MEASURE-TX-SIZE.command` on
 * 28 Aug, the deploy is 17.0% of the block-usage limit and 82.2% of the
 * bytes-written one, before it is proven or balanced.
 */
let ledgerParameters: any = null;

/**
 * The size block. Printed on success and on refusal alike.
 *
 * SAYS SO WHEN IT HAS NOTHING. A run that stops before a transaction is built
 * has no size to report, and printing nothing at all would read like the
 * measurement was forgotten rather than never reached.
 */
function printTxSize() {
  console.log();
  console.log('  \x1b[1mHow big the transaction is, against what the chain will carry\x1b[0m');
  if (!txMeasurements.length) {
    console.log('    NO TRANSACTION WAS BUILT IN THIS RUN, so there is no size to report.');
    console.log('    The stage named above says how far it got.');
    if (blockLimits?.blockUsage != null) {
      console.log(`    The block usage limit is ${blockLimits.blockUsage.toLocaleString()} bytes regardless — ${blockLimits.source}.`);
    }
    return;
  }
  // Every stage, because the growth between them is itself the finding: what
  // proving adds and what balancing adds are separate questions.
  for (const m of txMeasurements) {
    console.log(`    ${m.stage.padEnd(10)} ${m.bytes === null ? `(not measured: ${m.problem ?? 'unknown'})` : `${m.bytes.toLocaleString()} bytes`}`);
  }
  // The comparison is made against the LAST measurement — the bytes actually
  // handed to the node — because that is what the limit applies to.
  const last = txMeasurements[txMeasurements.length - 1]!;
  const limits = blockLimits ?? {
    readTime: null, computeTime: null, blockUsage: null, bytesWritten: null, bytesChurned: null,
    source: '(not derived — the ledger parameters were never read in this run)',
  };
  console.log();
  for (const line of compareAgainstLimits(last, limits)) console.log(`    ${line}`);
  if (last.cost) {
    console.log();
    for (const line of compareCost(last.cost, limits)) console.log(`    ${line}`);
  }
}

function annotateNodeErrorsOnConsole() {
  if (annotatedConsole) return;
  annotatedConsole = true;
  for (const key of ['log', 'error', 'warn'] as const) {
    const original = console[key].bind(console);
    console[key] = (...args: unknown[]) => {
      original(...args);
      try {
        const joined = args.map(String).join(' ');
        // Kept whole. A rejection line is short and this run produces at most a
        // handful; truncating evidence to save bytes is how C180 happened.
        if (/Custom error:\s*\d+|Invalid Transaction|SubmissionError|1010:|dispatch|Priority is too low/i.test(joined)) {
          rawNodeLines.push(joined);
        }
        const explained = explainNodeError(joined);
        if (explained) original(`  \x1b[1m\x1b[33m^ ${explained}\x1b[0m`);
      } catch { /* never let annotation break logging */ }
    };
  }
}

/**
 * Everything an error is actually carrying.
 *
 * `e.message` alone gave us "Transaction submission error" and nothing else,
 * which cost a round trip. These libraries wrap: the useful cause is under
 * `.cause`, `.errors`, or an axios `.response.data`, sometimes two deep.
 */
function describeError(e: any, depth = 0): string {
  if (e == null || depth > 4) return String(e);
  const pad = '  '.repeat(depth);
  const bits: string[] = [];
  const msg = e.message ?? String(e);
  bits.push(`${pad}${e.name ? e.name + ': ' : ''}${msg}`);
  const explained = explainNodeError(String(msg));
  if (explained) bits.push(`${pad}  \x1b[1m${explained}\x1b[0m`);
  // A dropped websocket carries no rejection code, because the chain never saw
  // the transaction. Without saying so it reads like a protocol failure and
  // sends you looking in the wrong place. M-23, M-59.
  if (/normal closure|disconnected|socket hang up|ECONNRESET/i.test(String(msg))) {
    bits.push(`${pad}  \x1b[1mthe node websocket dropped — the transaction was never submitted, so this is worth retrying\x1b[0m`);
  }
  if (e.code) bits.push(`${pad}  code: ${e.code}`);
  const data = e.response?.data;
  if (data) bits.push(`${pad}  response: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) bits.push(describeError(sub, depth + 1));
  if (e.cause && e.cause !== e) bits.push(describeError(e.cause, depth + 1));
  return bits.join('\n');
}

/**
 * Retries something that talks to the network.
 *
 * The node's websocket closes with a clean 1000 shortly after connecting, and
 * a submit landing in that gap fails with a message that says nothing about
 * connections. Observed on preview: submitAndWatchExtrinsic disconnected
 * "1000:: Normal Closure" seven seconds after the wallet started. Retrying is
 * the correct response to a dropped socket; failing the whole run is not.
 */
/**
 * Retrying, in this script's voice.
 *
 * The mechanism moved to `src/midnight/retry.ts` — it was written out here and
 * again in run-preview.ts, the eighth instance of one rule in two files, and
 * M-50/55/58/61/65 were each that pattern costing a run. What stays here is the
 * formatting, which is this script's business and not the ledger's.
 */
/**
 * ONE ATTEMPT. `attempts: 1` IS THE WHOLE POINT AND IT WAS 4.
 *
 * `R1b`: *"ONE ATTEMPT. No retry, no fallback to another port, image or
 * network. A retry that succeeds after a failure hides which one was real — and
 * this run's entire value is that it changes exactly one thing."*
 *
 * THIS RUN IS AN EXPERIMENT, NOT A DEPLOYMENT. Every submission since 16 Aug
 * 03:49 has come back with node error 170 after successful runs on 15 Aug with
 * nothing changed locally, and the one thing this round changes is the proof
 * server image: `9.0.0-rc.5_experimental` to `9.0.0-rc.3`, the prover built
 * from the ledger release the running node is built from. Four attempts make
 * the answer unreadable in both directions: a success on attempt three says
 * nothing about whether the pin fixed anything, and four consecutive 170s
 * produce four sets of console output of which the report shows the last.
 *
 * THE COST IS REAL AND IT IS ACCEPTED. `M-23` is not a flake: the node's
 * websocket closes with a clean 1000 a few seconds after the wallet connects,
 * on preview and on Stagenet alike, and a submission landing in that gap fails
 * with "Transaction submission error" and NO rejection code — because the chain
 * never saw it. Retrying is the correct response to that, and with `attempts: 1`
 * this run will sometimes stop on it having measured nothing.
 *
 * **THAT IS A DIFFERENT OUTCOME FROM A REFUSAL AND THE REPORT MUST NOT CONFUSE
 * THE TWO.** `describeError` already separates them by name — a dropped socket
 * prints "the transaction was never submitted, so this is worth retrying" — and
 * the failure block below prints the node's own lines, which are empty in that
 * case and carry a code in the other. A run that ends with no node line and a
 * dropped socket is not evidence about the pin; run the file again.
 *
 * `src/midnight/retry.ts` is UNCHANGED and so is `run-preview.ts`: the four
 * attempts stay everywhere the goal is to get work done. This one instrument
 * asks a question instead, and a question is asked once.
 */
const retryOptions = {
  attempts: 1,
  onRetry: ({ label, attempt, of, waitMs, error }: {
    label: string; attempt: number; of: number; waitMs: number; error: unknown;
  }) => {
    note(`${label} failed (attempt ${attempt} of ${of}), retrying in ${waitMs / 1000}s`);
    note(`  \x1b[2m${String((error as any)?.message ?? error).split('\n')[0]}\x1b[0m`);
  },
};

/* ------------------------------------------------------------------ */

/**
 * The deliberately chosen maintenance authority, or a refusal that says how
 * to choose one. Never a sample: `deployContract`'s own `sampleSigningKey()`
 * default is exactly how C225 happened, and this script exists downstream of
 * that lesson.
 */
function loadMaintenanceAuthority(): MaintenanceAuthorityChoice {
  if (!existsSync(AUTHORITY_FILE)) {
    throw new Error(
      `no maintenance authority has been chosen: ${AUTHORITY_FILE.replace(ROOT + '/', '')} does not exist.\n\n` +
      'The deploy refuses to sample one. Whoever holds this authority can change which\n' +
      'proofs the deployed contract accepts — alone, outside the company threshold — and\n' +
      'if the key is lost the contract can never be maintained (C225). Write the file as\n' +
      'ONE of, then run this again:\n\n' +
      '  { "kind": "committee", "committee": [{"tag":"schnorr","value":"…"}, …], "threshold": N }\n' +
      '      M-of-N verifying keys, assembled by hand (the SDK helper takes one key).\n' +
      '      Verifying keys come from signatureVerifyingKey(signingKey); each member\n' +
      '      keeps their own signing key.\n' +
      '  { "kind": "single-key", "signingKey": {"tag":"schnorr","value":"…"},\n' +
      '    "temporary": { "fixedBy": "<the round that replaces it>" } }\n' +
      '      One key, deliberately, as a RECORDED temporary state. Mint one with:\n' +
      '        npx tsx -e "import(\'@midnight-ntwrk/compact-runtime\').then(m => ' +
      'console.log(JSON.stringify(m.sampleSigningKey())))"\n' +
      '      and keep this file: it then holds the only key that can maintain the contract.\n' +
      '  { "kind": "unmaintainable" }\n' +
      '      An empty committee: no maintenance update can ever verify, for anyone, ever.\n\n' +
      'What each costs is laid out by the deploy layer\'s own refusal text\n' +
      '(src/midnight/partial-contract.ts) and in the S8c build-log entry. The choice is a\n' +
      'governance decision; this script only records it.',
    );
  }
  const parsed = JSON.parse(readFileSync(AUTHORITY_FILE, 'utf8'));
  // The same validation the deploy layer applies — surfaced here, at stage 1,
  // rather than after the DUST wait. Anything knowable up front belongs up front.
  return requireMaintenanceAuthority(parsed);
}

async function main() {
  annotateNodeErrorsOnConsole();
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  Deploying the account contract to ${NETWORK}`);
  console.log('────────────────────────────────────────────────────────────');

  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

  /* -------------------------------------------------- 1 */
  begin(1, 6, 'Preparing the compiled contract');

  // The SDK wants a CompiledContract, not a `new Contract(...)` instance.
  // Handing it an instance is the mistake M-16 lost a round to. Verified
  // offline: make(tag, ctor).pipe(withWitnesses, withCompiledFileAssets).
  const compiled = CompiledContract.make('ConfidentialAccount', Contract as any).pipe(
    CompiledContract.withWitnesses(witnesses as any),
    CompiledContract.withCompiledFileAssets(ARTIFACTS as never),
  ) as any;
  good(`compiled contract "${compiled.tag}", assets at contracts/managed`);

  // Check the private-state password NOW, not when the deploy uses it.
  // It failed once at stage 5, after four minutes of waiting for DUST, for a
  // reason that was knowable before anything started. Anything checkable up
  // front belongs up front.
  /*
   * The asset, resolved before anything touches the network. M-125.
   *
   * `require` throws with a readable message on an unknown code. Checking it
   * here rather than at the point of use is the same rule as the password check
   * below: anything knowable up front belongs up front, because the alternative
   * is discovering it after the DUST wait.
   */
  const runAsset = assets.require(RUN_ASSET);
  /*
   * ENABLED, not merely resolvable. M-137.
   *
   * `require` answers for every asset the registry has ever known, enabled or
   * not, and it must: an account holding a since-retired asset has to stay able
   * to name it. That is the wrong question at a DEPLOY, which is choosing what
   * an account will hold from now on. With `ACCOUNT_ASSET=ETH` this wrote a
   * view file naming a disabled asset and announced it as the one the run would
   * move.
   */
  if (!runAsset.enabled) {
    throw new Error(
      `${runAsset.code} (${runAsset.name}) is not enabled in the asset registry, so a fresh ` +
        'account should not be opened in it. Enable it in src/core/assets.ts, or set ' +
        `ACCOUNT_ASSET to one of: ${assets.enabled().map(a => a.code).join(', ')}.`,
    );
  }
  good(
    `the run script will move ${runAsset.code} (${runAsset.name}), ` +
      `${runAsset.decimals} decimal places — amounts are integers in its smallest unit`,
  );

  const { validatePassword } = await import('@midnight-ntwrk/midnight-js-utils');
  try {
    validatePassword(PRIVATE_STATE_PASSWORD);
    good('private state password meets the SDK rules');
  } catch (e: any) {
    throw new Error(
      `the private state store password is not acceptable to the SDK: ${e?.message ?? e}\n` +
        `  It needs at least 16 characters and 3 of: uppercase, lowercase, digits, special.\n` +
        `  Set MIDNIGHT_PRIVATE_STATE_PASSWORD, or fix the default in this script.`,
    );
  }

  /*
   * The maintenance authority, checked FIRST. S8c, C225.
   *
   * Same rule as the password and the asset: anything knowable up front
   * belongs up front, and this one is more than knowable — it is a governance
   * decision the deploy refuses to make by defaulting. An absent or invalid
   * file stops the run here, before any wallet or DUST wait, with the options
   * printed.
   */
  const maintenanceAuthority = loadMaintenanceAuthority();
  const authorityShape = describeMaintenanceAuthority(maintenanceAuthority);
  good(
    `maintenance authority chosen deliberately: ${authorityShape.kind} — ` +
      `committee of ${authorityShape.committeeSize}, threshold ${authorityShape.threshold}` +
      (authorityShape.fixedBy ? ` (TEMPORARY, replaced by: ${authorityShape.fixedBy})` : ''),
  );
  if (authorityShape.kind === 'single-key') {
    note('  a single key is C225\'s shape, accepted only as a recorded temporary state;');
    note(`  the round that replaces it is named above and in the deploy record`);
  }
  if (authorityShape.kind === 'unmaintainable') {
    note('  nobody will ever be able to change this deployment\'s verifier keys — including us');
  }

  /* -------------------------------------------------- 2 */
  begin(2, 6, 'Setting the network id');

  // A number here silently produces addresses the network rejects. See
  // src/midnight/network.ts. This is the bug that would have failed every
  // transaction on every network.
  await applyNetworkId(NETWORK);
  good(`network id is the string "${NETWORK}"`);

  /* -------------------------------------------------- 3 */
  begin(3, 6, 'Connecting to the network and the proof server');

  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK} — ${how}`);
  // Reuse the proof server already running on PROVER_PORT (6301) rather than letting
  // testcontainers start a second one. PREFLIGHT confirmed the image is there.
  // Retried, because this same call is retried in run-preview.ts for a reason
  // that applies identically here: the testkit's health check has a hardcoded
  // one-second timeout against public endpoints. M-116/M-137.
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`node      ${cfg.node}`);
  good(`indexer   ${cfg.indexer}`);
  good(`prover    ${cfg.proofServer}`);

  /*
   * WHICH PROOF SERVER THIS MEASUREMENT WAS TAKEN AGAINST. `R1b`, and `C180`.
   *
   * *"It must print which proof server it used, by image and by what /version
   * answered, in the same report. A measurement that cannot say what it
   * measured against is C180 again."*
   *
   * BOTH, because neither alone is enough. The image is what the container was
   * started FROM and is the thing this round changed; `/version` is what the
   * process actually answers, and the two disagreeing is precisely the failure
   * `DEPLOY-PREVIEW.command`'s image check exists to catch — a server left
   * running on this port from an earlier stack, silently serving a different
   * one. The image reaches here through MIDNIGHT_PROOF_IMAGE, exported by
   * `DEPLOY-PREVIEW.command`; run by hand with nothing exported it says so
   * rather than inventing a value.
   *
   * Note the expected shape: the pin is `9.0.0-rc.3` and a 9.0.0-rc.x server
   * has been observed answering `/version` with the bare `9.0.0-rc.5` — no
   * `_experimental` suffix — so an exact string match between the two is NOT
   * expected and is not asserted here. Both are recorded; the reader compares.
   */
  proofServerImage = process.env.MIDNIGHT_PROOF_IMAGE
    ?? '(not exported — run through DEPLOY-PREVIEW.command to record it)';
  try {
    const res = await withTimeout('the proof server /version', 10_000, fetch(`${cfg.proofServer}/version`));
    proofServerVersion = (await res.text()).trim().slice(0, 200) || `(empty, HTTP ${res.status})`;
  } catch (e: any) {
    proofServerVersion = `(did not answer: ${String(e?.message ?? e).slice(0, 80)})`;
  }
  good(`prover image    ${proofServerImage}`);
  good(`prover /version ${proofServerVersion}`);

  /*
   * THE CHAIN'S LIMITS, READ BEFORE ANYTHING IS BUILT. `C218`.
   *
   * Read here rather than at the point of comparison so that a run which never
   * reaches a transaction can still report what the limit is. The derivation is
   * in `scripts/tx-size.ts` and is a probe of the ledger's own
   * `normalizeFullness`, not a number copied out of a source file.
   *
   * `initialParameters()`, NOT THE LIVE ON-CHAIN PARAMETERS, AND THAT IS A REAL
   * GAP. The chain's parameters can differ from the initial ones. The runtime
   * API that would answer it is `MidnightRuntimeApi_get_ledger_parameters`
   * (`midnight-node@d9729c13/runtime/src/lib.rs:1302`), reachable over RPC as
   * `state_call`, and its result is a tagged-serialised `LedgerParameters` that
   * `LedgerParameters.deserialize` reads. That is named as work rather than
   * guessed at here: decoding the SCALE `Result<Vec<u8>, _>` wrapper by hand is
   * exactly the kind of guess `CLAUDE.md` opens with.
   */
  try {
    const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    ledgerParameters = LedgerParameters;
    blockLimits = limitsFromLedger(LedgerParameters);
    good(`block usage limit ${blockLimits.blockUsage === null ? '(could not derive)' : `${blockLimits.blockUsage.toLocaleString()} bytes`}`);
  } catch (e: any) {
    note(`the block limits could not be read: ${String(e?.message ?? e)}`);
  }

  /* -------------------------------------------------- 4 */
  begin(4, 6, 'Getting a funded wallet');

  // Reuse the same wallet across runs. A fresh wallet every run means asking
  // the faucet every run, and the faucet is rate limited and wants a captcha
  // token, which is not something a script can produce. The master seed is
  // 32 bytes of hex and every other key derives from it deterministically.
  let masterSeed: string;
  if (existsSync(SEED_FILE)) {
    masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
    note(`reusing the wallet in ${SEED_FILE.replace(ROOT + '/', '')}`);
  } else {
    masterSeed = WalletSeeds.generateRandom().masterSeed;
    writeFileSync(SEED_FILE, masterSeed, { mode: 0o600 });
    note('no saved wallet, made a new one');
    good(`seed saved to ${SEED_FILE.replace(ROOT + '/', '')} — gitignored, but it holds test funds, so keep it`);
  }

  // NOT startMidnightWalletProviders(). That calls wallet.start() with its
  // default, which blocks until the testkit considers the wallet "strictly
  // complete" on all three sub-wallets at once: shielded, unshielded and dust.
  //
  // On a wallet whose only funds are unshielded NIGHT from the faucet, the
  // shielded and dust sub-wallets never reach that state, so it emits the same
  // line every two seconds forever. Observed: 900+ identical emissions of
  // `{ shielded=false, unshielded=true, dust=false }`.
  //
  // We do not need that gate. We need two specific things, and we can wait for
  // each of them by name, with a timeout and something to look at.
  const wallet: any = await MidnightWalletProvider.build(logger, cfg, masterSeed);

  // The dust sub-wallet, cached across runs and given a non-zero fee floor.
  // Both problems and the reasoning are in scripts/dust-wallet.ts (M-47, M-52).
  {
    const installed = await installDustWallet(wallet, cfg, masterSeed, NETWORK, ROOT);
    if (installed.how === 'restored') good(`dust wallet restored from the last run — ${installed.detail}`);
    else if (installed.how === 'fresh') note(`dust wallet rebuilt — ${installed.detail}`);
    else note(`  using the SDK's own dust wallet: ${installed.detail}`);
  }

  await wallet.start(false); // start the wallet, skip the testkit's sync gate

  const unshieldedAddress = wallet.unshieldedKeystore?.getBech32Address?.()?.asString?.();
  if (unshieldedAddress) good(`address  ${unshieldedAddress}`);

  const { unshieldedToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const NIGHT = (unshieldedToken() as any).raw;

  // A live view of wallet state, without pulling in rxjs.
  let latest: any = null;
  const subscription = wallet.wallet.state().subscribe({ next: (s: any) => (latest = s) });

  const nightOf = (s: any) => BigInt(s?.unshielded?.balances?.[NIGHT] ?? 0n);
  const dustOf = (s: any) => {
    try { return BigInt(s?.dust?.balance(new Date()) ?? 0n); } catch { return 0n; }
  };

  /**
   * How far each sub-wallet has actually synced.
   *
   * Without this, "DUST 0" is ambiguous: it means either "registered, not yet
   * accrued" or "the dust wallet never synced so it cannot see anything". Those
   * need opposite responses, and guessing between them costs a round trip.
   *
   * Field names read off SyncProgress.d.ts in wallet-sdk-abstractions, not
   * guessed: appliedIndex, highestIndex, highestRelevantIndex, isConnected.
   * The guessed names (appliedId, highestTransactionId) are why dust and
   * shielded printed `?/?` here for the whole session — M-26.
   */
  const progressOfOne = (p: any, name: string) => {
    if (!p) return `${name} —`;
    const applied = p.appliedIndex ?? p.appliedId ?? '?';
    const highest = p.highestRelevantIndex ?? p.highestIndex ?? p.highestTransactionId ?? '?';
    const conn = p.isConnected === false ? ' OFFLINE' : '';
    return `${name} ${applied}/${highest}${caughtUp(p) ? '✓' : ''}${conn}`;
  };

  /**
   * Caught up, not identical to the tip.
   *
   * `isStrictlyComplete()` wants appliedIndex === highestIndex, which on a chain
   * that keeps producing blocks asks the wallet to outrun it. The SDK ships
   * `isCompleteWithin(gap)` for exactly this.
   */
  const caughtUp = (p: any): boolean => {
    if (!p) return false;
    try { if (typeof p.isCompleteWithin === 'function') return !!p.isCompleteWithin(10n); } catch { /* fall through */ }
    try { if (typeof p.isStrictlyComplete === 'function') return !!p.isStrictlyComplete(); } catch { /* fall through */ }
    const a = p.appliedIndex ?? p.appliedId;
    const h = p.highestRelevantIndex ?? p.highestIndex ?? p.highestTransactionId;
    if (a == null || h == null) return false;
    return BigInt(a) + 10n >= BigInt(h);
  };

  const dustProgress = (s: any) => s?.dust?.state?.progress ?? s?.dust?.progress;

  const progressOf = (s: any) =>
    [
      progressOfOne(s?.unshielded?.progress ?? s?.unshielded?.state?.progress, 'unshielded'),
      progressOfOne(dustProgress(s), 'dust'),
      progressOfOne(s?.shielded?.state?.progress ?? s?.shielded?.progress, 'shielded'),
    ].join('  ');

  /** Waits for `done(state)`, printing what it sees, and gives up out loud. */
  /**
   * Runs a promise, or gives up on it. M-112.
   *
   * **A `try/catch` cannot save you from a promise that never settles**, and
   * that is not hypothetical: a deploy sat silent for seven minutes inside
   * `estimateRegistration` after the node websocket closed with a normal
   * closure. That call has no timeout of its own, so it waited on a connection
   * that was gone — and the perfectly good fallback fifteen lines below, "could
   * not estimate the fee, use a fixed target", was unreachable because nothing
   * was ever thrown.
   *
   * Any SDK call here that can wait on a socket belongs in this. A wrong answer
   * is recoverable and a slow answer is annoying; silence is the one outcome
   * nobody can act on, and this script runs with no console to go and inspect.
   */
  async function withTimeout<T>(what: string, ms: number, p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)),
            ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function waitFor(what: string, done: (s: any) => boolean, timeoutMs: number) {
    const started = Date.now();
    let lastPrint = 0;
    for (;;) {
      if (latest && done(latest)) return latest;
      const elapsed = Date.now() - started;
      if (elapsed > timeoutMs) {
        throw new Error(`gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)}s`);
      }
      if (elapsed - lastPrint >= 10_000) {
        lastPrint = elapsed;
        const n = latest ? nightOf(latest) : 0n;
        const d = latest ? dustOf(latest) : 0n;
        note(`  ${String(Math.round(elapsed / 1000)).padStart(3)}s  NIGHT ${n}  DUST ${d}`);
        note(`        sync: ${latest ? progressOf(latest) : 'no state yet'}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  try {
    note('waiting for the faucet funds to appear (checking every second)');
    await waitFor('NIGHT to arrive', (s) => nightOf(s) > 0n, 5 * 60_000);
    good(`NIGHT balance ${nightOf(latest)}`);

    // DUST is what actually pays the fee, and it is generated by *holding*
    // NIGHT rather than being transferable. The NIGHT has to be registered for
    // generation first. Per decision 0001 this is the sponsor's job and a
    // customer wallet must never do it; here one wallet is playing both parts.
    if (dustOf(latest) === 0n) {
      note('no DUST yet; registering the NIGHT for DUST generation');
      const unregistered = (latest.unshielded.availableCoins ?? []).filter(
        (c: any) => c.utxo.type === NIGHT && c.meta.registeredForDustGeneration === false,
      );
      if (unregistered.length === 0) {
        note('nothing left to register; the NIGHT may already be registered');
      } else {
        note(`${unregistered.length} NIGHT UTXO(s) to register`);
        // Give the node websocket a moment to settle. Submitting immediately
        // after the wallet starts is what landed in the disconnect window.
        await sleep(5000);
        const txId = await withRetry('registration', async () => {
          const recipe = await wallet.wallet.registerNightUtxosForDustGeneration(
            unregistered,
            wallet.unshieldedKeystore.getPublicKey(),
        // signDataAsync, not signData.
        //
        // wallet-sdk 2.0 made the signing callback async — `SignSegment` is now
        // `(data: Uint8Array) => Promise<ledger.Signature>` where it used to
        // return a Signature directly — and added a separate method for it. The
        // synchronous `signData` still exists, which is why this type-checks and
        // then fails at runtime with "Wallet.Sign: Signer callback failed", a
        // message that names neither the method nor the reason.
        //
        // Taken from testkit 5.0's own signRecipe call, not guessed.
            (payload: Uint8Array) => wallet.unshieldedKeystore.signDataAsync(payload),
          );
          const finalised = await withTimeout(
            'finalising the dust recipe', 120_000, wallet.wallet.finalizeRecipe(recipe));
          return wallet.wallet.submitTransaction(finalised);
        });
        good(`registration submitted, tx ${String(txId).slice(0, 24)}…`);
      }
      note('DUST accrues over time rather than arriving at once, so this is a wait');
      await waitFor('DUST to start generating', (s) => dustOf(s) > 0n, 10 * 60_000);
    }
    good(`DUST balance ${dustOf(latest)}`);

    /*
     * "Some DUST" is not "enough DUST", and the difference is a failed deploy.
     *
     * The old gate was `dustOf(state) > 0`. On preview that was harmless: the
     * wallet had 2.0e18 by the time anything ran. On a Stagenet minutes past
     * genesis it passed at 1.1e16 and the deploy then died inside the balancer
     * with `Insufficient Funds: could not balance dust` — the coin selector
     * exhausting the available coins without covering the fee.
     *
     * The SDK has the right tools and we were not using them.
     * `estimateRegistration` returns the actual fee for this chain, which is
     * also the only number that tells us the fee SCALE here — ledger 9 is not
     * ledger 8, and on preview `feesWithMargin` was quoting 0 and 1.
     * `waitForGeneratedDust` then waits for a target, checking every second.
     *
     * The target is a multiple of the measured registration fee rather than a
     * constant, so it scales with whatever the chain actually charges instead
     * of encoding today's guess.
     */
    {
      const unregisteredNow = (latest.unshielded.availableCoins ?? []).filter(
        (c: any) => c.utxo.type === NIGHT,
      );
      let target = 0n;
      try {
        // Thirty seconds is generous for a fee quote. Past that the connection
        // is gone rather than slow, and the fallback below is the right answer.
        const est: any = await withTimeout<any>(
          'the fee estimate', 30_000,
          wallet.wallet.estimateRegistration(unregisteredNow));
        const multiple = BigInt(process.env.MIDNIGHT_DUST_FEE_MULTIPLE || 20);
        target = BigInt(est.fee) * multiple;
        good(`this chain charges ${est.fee} for a registration — waiting for ${multiple}x that before deploying`);
      } catch (e: any) {
        note(`  could not estimate the fee (${String(e?.message ?? e).slice(0, 90)})`);
        target = BigInt(process.env.MIDNIGHT_DUST_TARGET || 100_000_000_000_000_000n);
        note(`  falling back to a fixed target of ${target}`);
      }

      if (dustOf(latest) < target) {
        note(`  ${dustOf(latest)} is below it, and DUST accrues over time — waiting`);
        try {
          // The SDK's own waiter, which watches projected generation rather
          // than polling a balance. Bounded, and non-fatal: if it times out we
          // still try, because a deploy that refuses to start teaches nothing.
          await wallet.wallet.waitForGeneratedDust(unregisteredNow, target, { timeoutMs: 10 * 60_000 });
        } catch (e: any) {
          note(`  \x1b[33mstill short after waiting: ${String(e?.message ?? e).slice(0, 120)}\x1b[0m`);
          note('  \x1b[33mgoing ahead anyway — if this fails with "could not balance dust",');
          note('  that is why, and the answer is to wait longer and run again\x1b[0m');
        }
      }
    }
    good(`DUST balance ${dustOf(latest)} — fees can be paid`);

    /*
     * A DUST balance is not the same as a synced dust wallet, and deploying on
     * the difference is what produced `1010: Invalid Transaction: Custom error:
     * 170` — MalformedError::InvalidDustSpendProof in the node's own error
     * table. The dust spend proof is built from the dust wallet's view of
     * generation state; built from a view that is still catching up, the node
     * rejects it.
     *
     * The evidence: the run that worked had `dust ✓` on every line; the deploy
     * that failed showed `dust` never complete, right up to submission. The
     * only gate was `balance > 0`, which goes true long before the wallet has
     * caught up.
     *
     * Bounded and non-fatal: if it does not converge, say so loudly and go
     * anyway, because a deploy that refuses to start is worse than one that
     * fails with a known cause.
     */
    /*
     * A DUST BALANCE IS NOT A SYNCED DUST WALLET, and submitting on the
     * difference is what produced `1010: Invalid Transaction: Custom error:
     * 170` — InvalidDustSpendProof in the node's own error table.
     *
     * The loop that fixes it USED TO BE WRITTEN OUT HERE. It moved into
     * `dust-wallet.ts` at M-141, after `chain-probe.ts` was written without it
     * and hit exactly this error on its first run. A rule that exists as a
     * comment in one file protects that file and nothing else.
     */
    await waitForDustCatchUp({ state: () => latest }, note, progressOf);
    if (caughtUp(dustProgress(latest))) good(`dust wallet caught up — ${progressOf(latest)}`);

    const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
    if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB)`);
  } catch (e: any) {
    subscription?.unsubscribe?.();
    const n = latest ? nightOf(latest) : 0n;
    console.log();
    note(`\x1b[33m${describeError(e)}\x1b[0m`);
    console.log();
    if (n === 0n) {
      note('The wallet still has no NIGHT, so the faucet has not paid out yet.');
      note('Fund this address, then run this again:');
      console.log();
      console.log(`    \x1b[1m${unshieldedAddress ?? (await unshieldedAddressFromSeed(masterSeed))}\x1b[0m`);
      console.log();
      note(`Faucet: ${String(cfg.faucet ?? '').replace('/api/drips', '')}`);
    } else {
      note(`The wallet has ${n} NIGHT but no DUST.`);
      note(`Sync at the end: ${latest ? progressOf(latest) : 'unknown'}`);
      console.log();
      // These two look identical from the balance alone and need opposite
      // responses, so name both rather than assuming the friendlier one.
      note('If the dust line above shows OFFLINE, or applied is far behind');
      note('highest, the dust wallet never synced and waiting will not help.');
      note('If it shows ✓ and DUST is still 0, the registration has not been');
      note('included in a block yet: wait a few minutes and run this again.');
    }
    note('The seed is saved, so it stays the same wallet.');
    throw new Error('wallet not ready to pay fees');
  }
  subscription?.unsubscribe?.();

  /* -------------------------------------------------- 5 */
  begin(5, 6, `Deploying the contract — ${DEPLOYED_CIRCUITS.length} circuits, ${DEFERRED_CIRCUITS.length} deferred (S8b Option B; the split decided by S9)`);
  note('this is the first time a proof is produced for a real network; give it a minute');
  /*
   * The deferral, announced before the transaction exists. S8c: a deploy that
   * omits circuits must say so going in — a deploy that HAPPENED to omit them
   * because a directory was incomplete is C224 again. The lists live in
   * src/midnight/deferral.ts and nowhere else.
   */
  note(`deploying   ${DEPLOYED_CIRCUITS.join(', ')}`);
  note(`deferring   ${DEFERRED_CIRCUITS.join(', ')} — they arrive only in a future deployment`);

  const zkConfigProvider = new NodeZkConfigProvider<string>(ARTIFACTS);
  const providers: any = {
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    privateStateProvider: levelPrivateStateProvider({
      accountId: PRIVATE_STATE_ID,
      privateStateStoreName: PRIVATE_STATE_ID,
      // The SDK encrypts the private state store at rest and requires a
      // password provider. In the product this is the vault key derived from
      // the user's password; here it is a local development value.
      //
      // It is validated, and the rules are not obvious: at least 16 characters
      // and at least 3 of uppercase / lowercase / digits / special. The
      // previous value here had only lowercase and hyphens, which is 2, and it
      // failed inside the deploy rather than at startup. Checked against the
      // real validatePassword() before being put here.
      privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
    } as any),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    walletProvider: wallet,
    midnightProvider: wallet,
  };

  /*
   * MEASURED ON THE WAY THROUGH. `C218`, `R1c` item 3.
   *
   * The deploy (the partial deploy path since S8c — the SDK's `deployContract`
   * cannot build a partial operations map) builds, proves, balances and
   * submits through these same providers, so there is no point in this script
   * that holds the transaction. The providers
   * are the seam: `proveTx` sees it unproven and proven, `balanceTx` sees it
   * balanced, and `submitTx` sees exactly the bytes the node is asked to
   * accept. Wrapping them measures at each of those points and prints as it
   * goes, so a run that dies later still leaves the numbers it had.
   *
   * IT CANNOT CHANGE THE TRANSACTION. Each wrapper delegates, measures the
   * result behind a `try`, and returns what it was given. A failure inside the
   * measurement is not allowed to stop a deploy.
   */
  const measured = measuringProviders(providers, (m) => {
    txMeasurements.push(m);
    note(`transaction size (${m.stage}) ${m.bytes === null ? `not measured: ${m.problem ?? 'unknown'}` : `${m.bytes.toLocaleString()} bytes`}`);
    const w = m.cost?.cost?.bytesWritten;
    if (typeof w === 'number' && blockLimits?.bytesWritten) {
      note(`  bytes written ${w.toLocaleString()} of ${blockLimits.bytesWritten.toLocaleString()} — ${((w / blockLimits.bytesWritten) * 100).toFixed(1)}% of a block`);
    }
    if (m.cost?.exceeded) note(`  THE LEDGER WILL NOT NORMALISE THIS COST: a block limit is exceeded. ${m.cost.exceeded}`);
  }, ledgerParameters);

  /*
   * M-68. The deploy lives in `MidnightLedger.open` now, and this script calls
   * it.
   *
   * It was written out here — constructor witnesses, the websocket settle, the
   * retry, the verifier-key read-back — and `MidnightLedger.open` threw and
   * pointed at this file. Two deploy paths is the most expensive place for the
   * duplication this project keeps hitting, so there is one, and the script is
   * the thin caller.
   *
   * What stays here is genuinely script work: the wallet, the DUST budget, the
   * proof server, the console output, and writing the address where the next
   * run will look for it.
   */
  /*
   * The account's asset blinding, generated once, here, and never rotated.
   *
   * It is what turns an asset code into this account's opaque asset key:
   * `assetKeyOf(assetId, this)`. THAT KEY USED TO ADDRESS AN ENTRY IN AN
   * ON-CHAIN MAP — orphaning `assetBalances` was what made rotating this
   * unthinkable. The map went with the balance ledger under `C292`/`S26`, and
   * since then the key is the first field of the change commitment a proposal
   * is approved under, and nothing else.
   *
   * Every signer must still derive the SAME key from it, so the reason it is
   * account-level, travels in the sealed state, and is carried through a
   * viewing-key rotation unchanged is unchanged too — a signer deriving a
   * different key recomputes a different change commitment from the one the
   * proposer committed to, and their approval is not an approval of that
   * proposal. M-125, K-4.
   *
   * RANDOM, not derived from a seed like the signer keys in this script. A
   * predictable blinding would make every account's asset keys computable by
   * anyone reading this file, which is precisely the linkability the blinding
   * exists to remove — two accounts holding pounds would share a key. The cost
   * is that it exists in exactly two places once this process exits: the
   * device's private state store, and the view file written below.
   *
   * LOSE BOTH AND NO SIGNER CAN DERIVE THIS ACCOUNT'S ASSET KEY AGAIN, so no
   * proposal naming an asset can be raised or approved on it and no payment run
   * can be authorised. It used to be put more directly than that — the money
   * was IN a map under those keys — and that map went with the balance ledger
   * under `C292`/`S26`. The account holds nothing to be locked away now; what
   * is lost is its ability to authorise anything.
   */
  const assetBlinding = toHexBytes(randomBytes(32));

  /*
   * `initial` USED TO BE HERE, and M-125/M-128 removed the thing it opened.
   *
   * It carried `{ balance, entriesDigest, salt }` — one balance for the whole
   * account, and a running entry-log digest to seed. There is neither now.
   * M-125 replaced the single balance with a per-asset map, and `C292`/`S26`
   * removed that map as well: the account keeps no books of its own, so there
   * is no balance anywhere on chain to open at. The entry log is an append-only
   * set of movement commitments, which needs no seed because inserting into a
   * set requires reading nothing.
   *
   * So there is nothing to open at, and the account's opening view is written
   * to the file below rather than passed through here.
   */
  /*
   * **THE FOUNDING SIGNER, AND THIS IS THE WHOLE OF `C334` ON THIS SIDE.**
   *
   * `signerLeaves: []` STOOD HERE, with the comment *"seated by the run script
   * through the bootstrap window"* — true of B and C, and silent about A,
   * because A did not need seating: the CONSTRUCTOR manufactured A's leaf out
   * of this process's own `deployer()`, whose secret was `seededBytes(1)`.
   *
   * A is now a real identity, generated once with real entropy into a
   * gitignored per-account file, and **only the LEAF crosses this boundary.**
   * `AccountOpening` carries leaves and never material — `SignerRef`'s own
   * comment has said why since it was written — and `MidnightLedger` has no
   * `deployer()` injection point any more, so no secret can reach the deploy
   * layer even by accident.
   *
   * **SAID PLAINLY RATHER THAN CLAIMED (RULE 14): THIS SCRIPT IS ALSO THE
   * FOUNDER'S DEVICE.** On a real deployment A's material is born on A's own
   * machine and only this leaf travels. Here one machine plays every part, so
   * A's secret is generated in this process and written to this disk. What is
   * true either way, and is the property `C334` is about, is that **nothing in
   * this repository names A** — no reader of it can take A's seat.
   *
   * The derivation is `storedSignerLeaf`, which is the ONE derivation every
   * writer in the product uses (`C328`, `src/core/signer-leaf.ts:181`), through
   * `MidnightCommitments`, which is the ONE wrapper around the generated
   * circuits (`M-107`). Not a third spelling of the rule that decides who may
   * approve a payment.
   */
  const previewSigners = readOrCreatePreviewSigners(STATE_DIR, NETWORK, ACCOUNT_ID);
  if (previewSigners.created) {
    good(`generated demo signer material — ${previewSigners.file.replace(ROOT + '/', '')}, gitignored`);
  } else {
    note(`reusing the demo signers in ${previewSigners.file.replace(ROOT + '/', '')}`);
  }
  const foundingLeaf = storedSignerLeaf(previewSigners.signers.A, MidnightCommitments);
  good(`founding signer leaf  ${foundingLeaf.slice(0, 24)}…`);

  const opening: AccountOpening = {
    // [0] IS THE FOUNDING SIGNER — the one seat the constructor creates. B and
    // C are seated by the run script through APPROVED ROUNDS, both of them:
    // `S35d` shut the bootstrap window, so there is no unilateral seating left
    // and the founder proposes, approves and amends at their own threshold of
    // one.
    signerLeaves: [foundingLeaf],
    threshold: Number(THRESHOLD),
    assetBlinding,
    sealedState: { keyEpoch: GENESIS_KEY_EPOCH, sealed: { iv: '', tag: '', body: '' } },
  };

  let contractAddress = '';

  const ledger = new MidnightLedger(
    {
      indexerUrl: ENDPOINTS[NETWORK]!.indexerUrl,
      indexerWsUrl: ENDPOINTS[NETWORK]!.indexerWsUrl,
      proverUrl: cfg.proofServer,
      nodeUrl: ENDPOINTS[NETWORK]!.nodeUrl,
      zkConfigPath: ARTIFACTS,
      networkId: NETWORK,
      privateStateId: PRIVATE_STATE_KEY,
    },
    null as any,   // the sponsor: this script is its own, through the wallet provider
    /*
     * A real store, not a stub. M-73.
     *
     * This was `{ put: async () => {}, get: async () => null }` — a store that
     * silently discarded every blob. Only the commitment goes on chain, so a
     * discarded blob is an account that looks healthy on chain and can never be
     * read again. The salt exists nowhere else.
     */
    new FileSealedStateStore(join(STATE_DIR, 'sealed')),
    async () => contractAddress || null,
    async () => measured,
    compiled,
    {
      /*
       * `deployer` STOOD HERE. `C334`.
       *
       * `async () => ({ secretKey: seededBytes(1), blinding: seededBytes(401) })`
       * — the only implementation of that injection point that ever existed,
       * and the reason every account this project deployed carried a seat
       * anybody could take. There is no such field on the deployment bag any
       * more, so this cannot be re-added without the type saying so.
       */
      register: async (_id, address) => { contractAddress = address; },
      // Chosen at stage 1, from the file beside the wallet seed. The deploy
      // layer refuses to run without it, and never samples. C225.
      maintenanceAuthority,
      retry: retryOptions,
    },
  );

  note('letting the node websocket settle before submitting');
  const started = Date.now();
  await ledger.open(ACCOUNT_ID, opening);
  const took = ((Date.now() - started) / 1000).toFixed(1);

  good(`deployed in ${took}s`);
  good(`contract address  ${contractAddress}`);

  /*
   * WHAT THIS DEPLOYMENT IS, in the report, so nothing later mistakes it for
   * a full one. S8c item 4: the circuits by name, both lists, and the
   * authority's SHAPE — committee size and threshold, never key material.
   */
  console.log();
  console.log('  \x1b[1mWhat this deployment carries\x1b[0m');
  console.log(`    a ${DEPLOYED_CIRCUITS.length}-CIRCUIT deployment — ${DEFERRED_CIRCUITS.length} circuits are deferred (S8b Option B; the split decided by S9)`);
  console.log(`    deployed  ${DEPLOYED_CIRCUITS.join(', ')}`);
  console.log(`    deferred  ${DEFERRED_CIRCUITS.join(', ')}`);
  console.log(`    a call to a deferred circuit is refused by the client by name, and by the`);
  console.log(`    chain as VerifierKeyNotPresent; they arrive only in a future deployment`);
  console.log(`    maintenance authority  ${authorityShape.kind} — committee of ` +
    `${authorityShape.committeeSize}, threshold ${authorityShape.threshold}` +
    (authorityShape.fixedBy ? `  (TEMPORARY, replaced by: ${authorityShape.fixedBy})` : ''));

  /*
   * THE FEE ACTUALLY PAID, AND THE BLOCK. `R1b`, and `R9` waits on the number.
   *
   * *"On success: the contract address, the block, the fee actually paid, and
   * the elapsed time of each phase. The fee is the number R9 waits on and no
   * real one has ever been recorded for this contract."*
   *
   * READ OFF THE FINALIZED TRANSACTION, NOT ESTIMATED AND NOT INFERRED. The
   * SDK's `FinalizedTxData` carries it, and the names below are read from the
   * type declaration rather than guessed —
   * `node_modules/@midnight-ntwrk/midnight-js-types/dist/midnight-types.d.ts:177-230`:
   *   `fees: { paidFees: string; estimatedFees: string }`
   *   `blockHeight: number`, `blockHash: string`, `blockTimestamp: number`
   *   `txId`, `txHash`, `status`, `protocolVersion`
   * `paidFees` is documented there as *"the fees that have already been
   * settled"*, which is exactly the number owed, and `estimatedFees` is printed
   * beside it because the gap between the two is itself worth having.
   *
   * WHY IT IS READ HERE RATHER THAN RETURNED BY `MidnightLedger.open`. `open`
   * returns a `TxRef` of `{ ref, at }` and the finalized data is available to
   * it. Widening that return would be a change to the ledger layer — the money
   * path — to serve an instrument's report, and `CLAUDE.md` makes anything
   * touching an asset P0. `watchForDeployTxData` is the SDK's own accessor for
   * exactly this, takes the address this script already holds, and keeps the
   * change inside the instrument. The cost is one indexer round trip against a
   * transaction that has already finalized.
   *
   * IT DOES NOT FAIL THE RUN. The deploy has landed by this point and the
   * address is already written to disk; a report missing its fee is worse than
   * one that says why the fee is missing, and neither is worth discarding a
   * successful deploy over.
   */
  let feeRecord: Record<string, unknown> | null = null;
  try {
    const finalized: any = await withTimeout(
      'the finalized deploy transaction', 60_000,
      (providers as any).publicDataProvider.watchForDeployTxData(contractAddress),
    );
    feeRecord = {
      txId: String(finalized?.txId ?? ''),
      txHash: String(finalized?.txHash ?? ''),
      status: String(finalized?.status ?? ''),
      blockHeight: finalized?.blockHeight ?? null,
      blockHash: String(finalized?.blockHash ?? ''),
      blockTimestamp: finalized?.blockTimestamp ?? null,
      protocolVersion: finalized?.protocolVersion ?? null,
      paidFees: String(finalized?.fees?.paidFees ?? ''),
      estimatedFees: String(finalized?.fees?.estimatedFees ?? ''),
      proofServerImage,
      proofServerVersion,
    };
    console.log();
    console.log('  \x1b[1mWhat the chain charged, and where it landed\x1b[0m');
    console.log(`    fee paid          ${feeRecord.paidFees}`);
    console.log(`    fee estimated     ${feeRecord.estimatedFees}`);
    console.log(`    block height      ${feeRecord.blockHeight}`);
    console.log(`    block hash        ${feeRecord.blockHash}`);
    console.log(`    block timestamp   ${feeRecord.blockTimestamp}`);
    console.log(`    transaction id    ${feeRecord.txId}`);
    console.log(`    transaction hash  ${feeRecord.txHash}`);
    console.log(`    status            ${feeRecord.status}`);
    console.log(`    protocol version  ${feeRecord.protocolVersion}`);
    console.log(`    proof server      ${proofServerImage}  (/version: ${proofServerVersion})`);
  } catch (e: any) {
    console.log();
    console.log(`  \x1b[33mthe deploy succeeded but its finalized transaction could not be read back:\x1b[0m`);
    console.log(`    ${String(e?.message ?? e)}`);
    console.log('    So there is NO recorded fee for this deploy, and R9 still has no number.');
    console.log(`    The contract address above is on chain regardless: ${contractAddress}`);
  }

  // ON THE SUCCESS PATH TOO. A deploy that lands is the second data point for
  // how close this contract is to the limit, and it is free.
  printTxSize();

  writeFileSync(
    OUT_FILE,
    JSON.stringify({
      network: NETWORK,
      contractAddress,
      /* What the CHAIN holds, which since `S35d` is a constant of the contract
       * rather than anything this deploy chose. */
      threshold: Number(THRESHOLD),
      deployedAt: new Date().toISOString(),
      /*
       * A PARTIAL DEPLOYMENT, SAID WHERE THE ADDRESS IS SAID. S8c, S9.
       *
       * This file is where S6 and the client find the address, so it is also
       * where they must find what the address IS: a deployment carrying some
       * of the contract's circuits. Anything reading the address without
       * reading this block would otherwise assume a full contract — which is
       * exactly how a green test against the compiled source mistakes itself
       * for a statement about the chain (C227's shape).
       *
       * EVERY FIELD HERE IS DERIVED FROM THE LISTS, never typed as a number.
       * S9 replaced `elevenCircuitDeployment: true` — a boolean named after a
       * count is a record that goes silently false the day the count changes,
       * which is exactly how the round after next would have gotten this
       * wrong. The lists are the authority; the counts are their lengths.
       */
      partialDeployment: DEFERRED_CIRCUITS.length > 0,
      deployedCircuitCount: DEPLOYED_CIRCUITS.length,
      deferredCircuitCount: DEFERRED_CIRCUITS.length,
      circuits: {
        deployed: [...DEPLOYED_CIRCUITS],
        deferred: [...DEFERRED_CIRCUITS],
      },
      /*
       * The authority's SHAPE only — committee size and threshold, and for a
       * single key the round that replaces it. Never key material: the
       * signing key (when one exists) lives in the private state store and in
       * maintenance-authority.json, both gitignored, neither this file.
       */
      maintenanceAuthority: authorityShape,
      /*
       * The measurement, beside the address. Null when the read-back failed —
       * an absent key and a key holding a made-up number are not the same
       * thing, and only one of them is safe to reason from later.
       */
      deployTx: feeRecord,
    }, null, 2),
  );

  /*
   * The opening this contract was deployed with. M-73.
   *
   * Only commitments go on chain. The account's asset blinding lives off it and
   * cannot be recovered from anything the chain holds — so if this is not
   * written down, no signer can recompute the account's asset key and no
   * proposal on this account can be raised or approved again. A BALANCE AND ITS
   * BLINDING FACTOR WERE THE OTHER TWO THINGS THIS SENTENCE NAMED, and both
   * went with the balance ledger under `C292`/`S26`; the asset blinding is the
   * one thing left that exists nowhere else. In the product this is the sealed
   * blob every signer decrypts with the viewing key (decision 0002); here it is
   * a file, because there is nothing to hide from the person who ran the
   * deploy.
   *
   * THE RUN SCRIPT READS THIS AND NO LONGER WRITES IT BACK. It used to update
   * the file after every state change, because every state change moved a
   * balance; `run-preview.ts` records at its own `writeViewFile` that both of
   * that function's callers went with the balance ledger under `C292`/`S26` and
   * that nothing calls it now. What is in the file is written once, here, and
   * does not move.
   *
   * AFTER THE DEPLOY, NOT BEFORE, and the order is a judgement rather than an
   * accident. Writing it first would close the window in which a crash between
   * `open` and this line loses a brand-new account's blinding — but it would
   * also mean a FAILED deploy overwrote the view of whatever account this file
   * described before, while the contract address file still pointed at it. The
   * account lost by a crash here has never been used and costs one redeploy;
   * the account lost by the other ordering could be a live one with signers
   * seated on it and proposals open, and no way left to raise or approve
   * another. (IT COULD ONCE HAVE BEEN A FUNDED ONE, and that was the sharper
   * version of this argument until `C292`/`S26` left the account with no
   * balance to lose.)
   *
   * THE SHAPE CHANGED WITH M-125, M-128 AND `C292`, and the field names below
   * are not arbitrary — `run-preview.ts` and `sponsor-test.ts` read exactly
   * these, and both refuse BY NAME when they find the old ones rather than
   * guessing:
   *
   *   was   { balance, entriesDigest, salt }
   *   then  { asset, balance, balanceSalt, assetBlinding }
   *   now   { asset, assetBlinding }, beside the network and the address
   *
   *   asset          which asset these scripts work in. An amount with no asset
   *                  has no decimal place, and the asset key a proposal commits
   *                  to is BLINDED, so nothing on chain can say which asset a
   *                  stray figure belongs to.
   *   assetBlinding  account-level, and the one secret written here. With
   *                  `asset` it derives `assetKeyOf(assetId, assetBlinding)`,
   *                  the first field of the change commitment a proposal is
   *                  approved under. Every signer must derive the same one.
   *
   *   entriesDigest and salt ARE GONE. There is no entry-log digest anywhere
   *   any more (M-128), and `salt` was the old whole-account state salt.
   *
   *   `balance` AND `balanceSalt` ARE GONE TOO, under `C292`/`S26`. They were
   *   this file's opening record of what the account held, and the blinding
   *   that record's commitment was made under. The account keeps no books of
   *   its own: there is no on-chain balance for a view to shadow, and no
   *   circuit reads either value as a witness. NOTHING THEY ENFORCED SURVIVES,
   *   because there is nothing left for them to be wrong about.
   *
   * ONE ASSET IN THIS FILE, deliberately, and it is the honest description of
   * what these scripts do rather than of what the contract can do. The scripts
   * drive exactly one asset, named above.
   */
  writeFileSync(
    join(STATE_DIR, `${NETWORK}-view.json`),
    JSON.stringify({
      network: NETWORK,
      contractAddress,
      asset: runAsset.code,
      assetBlinding,
      savedAt: new Date().toISOString(),
    }, null, 2),
  );
  good(`opening view written — ${runAsset.code}`);
  note('  it holds the account\'s asset blinding, which exists nowhere else on disk');
  good(`address written to ${OUT_FILE.replace(ROOT + '/', '')}`);

  /* -------------------------------------------------- 6 */
  begin(6, 6, 'Reading the contract back off the chain');
  /*
   * THIS LINE USED TO BE PRINTED BEFORE THE QUERY BELOW. M-137.
   *
   * Stage 6 performs no `findDeployedContract` — it queries the indexer for the
   * contract's state. The verifier-key comparison is real, but it happens in
   * `MidnightLedger.open` back in stage 5, so an unconditional string here
   * announced a check this stage does not run, in a position where it would
   * have printed identically had the read that follows failed.
   */
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new Error('the indexer has no state for this address yet');
  const parsed = readLedger(state.data);
  good('read back off the chain — the indexer has this contract\'s state');

  /*
   * WHAT IS PRINTED HERE, and what is no longer printable. M-125, M-128.
   *
   * `round`, `proposalOpen`, `approvalCount` and `stateCommitment` used to be
   * these four lines and none of them exist on chain any more:
   *
   *   round             gone. It scoped approval nullifiers, which is what
   *                     limited an account to one proposal at a time. Nullifiers
   *                     bind to the proposal now, so there is no sequence number.
   *   proposalOpen      gone, and `openProposals` is a map — so the question is
   *                     "how many", not "is there one".
   *   approvalCount     gone as a single field. Approvals are counted PER
   *                     proposal, so there is no account-wide number.
   *   stateCommitment   gone. It stood for the whole shielded state; M-125
   *                     replaced it with one commitment per asset in
   *                     `assetBalances`, and `C292`/`S26` removed that map as
   *                     well. There is no shielded balance on chain for any
   *                     commitment to stand for, so there is deliberately
   *                     nothing printed in its place — a digest over nothing
   *                     would look like a state and verify nothing.
   *
   * Every line below is read straight off the contract and is a fact about the
   * account, not a derivation.
   */
  console.log();
  console.log('  \x1b[1mOn-chain state\x1b[0m');
  console.log(`    threshold        ${parsed.threshold}`);
  console.log(`    signers seated   ${parsed.signerLeaves.size()}`);
  /*
   * `assets held` STOOD ON THIS LINE — `assetBalances.size()`. It went with the
   * balance ledger under `C292`/`S26`, and nothing replaces it: the account
   * holds no balances on chain, so there is no count to print and inventing a
   * substitute would be printing a fact that does not exist.
   */
  console.log(`    open proposals   ${parsed.openProposals.size()}`);
  console.log(`    movements        ${parsed.movements.size()}`);

  /*
   * **THE THRESHOLD ON CHAIN IS A LITERAL IN THE CONSTRUCTOR, SO THIS CHECKS
   * THE CONTRACT RATHER THAN THE DEPLOY.** `S35d`.
   *
   * It used to compare the chain against `ACCOUNT_THRESHOLD`, which the deploy
   * passed as the constructor's first argument. Nothing is passed now, so what
   * this reads is whether the deployed artifact assigns what its source says it
   * assigns — which is a REAL check and a different one: it is the only place
   * outside the test suite where `threshold = 1` is read back off a chain.
   */
  if (parsed.threshold !== THRESHOLD) {
    throw new Error(
      `threshold on chain is ${parsed.threshold} and the constructor sets ${THRESHOLD}. ` +
      'Since `C340` the deploy passes no threshold at all, so a difference here means the ' +
      'deployed artifact is not built from this source.',
    );
  }
  good('the threshold on chain is the one the constructor sets, and one is the only value it sets');

  /*
   * A fresh deploy carries no open proposals, checked rather than assumed.
   *
   * THIS REPLACES AN ASSERTION OVER `assetBalances`, which checked that a
   * freshly deployed account held no assets. That map went with the balance
   * ledger under `C292`/`S26`, so the old check could not be kept: it read
   * something that no longer exists. `openProposals` is the equivalent over a
   * map the contract still has, and it is checked for the reason the old one
   * was — not because anyone doubts the constructor, but because a non-empty
   * map here would mean the state read back off the chain is not the state this
   * file believes it just deployed. Only `propose` writes to it, and nothing
   * has proposed on an address that did not exist a minute ago.
   *
   * IT IS A WEAKER CHECK THAN THE ONE IT REPLACES, and saying so is the point:
   * the old assertion was about the account's MONEY, and there is no on-chain
   * money left to assert anything about.
   */
  if (parsed.openProposals.size() !== 0n) {
    throw new Error(
      `a freshly deployed account has ${parsed.openProposals.size()} open proposal(s), which ` +
        'it cannot: only propose writes to that map, and nothing has proposed on this ' +
        'address. A non-empty map here means this is not the contract this file thinks it ' +
        'deployed.',
    );
  }
  good('no proposals are open — this is the state the constructor left behind');

  closePhase();
  stage = 'done';
  printPhases('finished');

  console.log();
  console.log('\x1b[32m\x1b[1m  The contract is live on ' + NETWORK + '.\x1b[0m');
  console.log(`  Proved against ${proofServerImage} (/version: ${proofServerVersion}).`);
  console.log(`  Next: NOT a ${runAsset.code} deposit — the account keeps no books of its own`);
  console.log(`  (C292), so there is no balance on chain to credit and no circuit that could`);
  console.log(`  settle one. What this account CAN do is govern itself and its`);
  console.log(`  vaults: propose → approve → amendSigner / setThreshold / adopt /`);
  console.log(`  setVaultThreshold / retireVault, and pay through a vault's recordPayment.`);

  await env.shutdown(false);
}

/*
 * `seededBytes` USED TO BE DEFINED HERE, identically to the copy in
 * `run-preview.ts`. M-137, and the tenth-something instance of M-104. It was
 * then imported from one place, `scripts/seeded.ts`.
 *
 * **AND SINCE `C334` IT DOES NOT DECIDE AN IDENTITY AT ALL.** Signer A's
 * identity was `seededBytes(1)` and `seededBytes(401)` in both files, and the
 * deploy seated the leaf the run had to prove membership of — so the two files
 * agreeing byte for byte was load-bearing, and the formula being PUBLISHED was
 * the defect. Both scripts now read the same gitignored file
 * (`scripts/preview-signers.ts`), which is the same answer to the same problem
 * — one place, both processes — without the answer being computable by a
 * reader of this repository. `seededBytes` keeps the payload, batch-digest and
 * salt work, where determinism is what is wanted and no money turns on it.
 */

/**
 * The address the faucet wants, derived without starting a wallet.
 *
 * Note it is the UNSHIELDED address, not the coin public key. The testkit's own
 * waitForFunds uses `unshieldedKeystore.getBech32Address()`, and handing the
 * faucet a coin public key instead is a silent no-op.
 *
 * The network id goes into this address too, and passing the wrong thing does
 * not throw: `createKeystore(seed, undefined)` cheerfully returns
 * `mn_addr_undefined1...`. Same failure mode as the setNetworkId bug, in a
 * different library. Verified by executing both.
 */
async function unshieldedAddressFromSeed(masterSeed: string): Promise<string | null> {
  try {
    const { WalletSeeds: WS } = await import('@midnight-ntwrk/testkit-js');
    const { createKeystore } = await import('@midnightntwrk/wallet-sdk');
    const seeds = (WS as any).fromMasterSeed(masterSeed);
    // The first argument became a key descriptor in wallet-sdk 2.0:
    // `createKeystore({ kind: 'schnorr', secret }, networkId)`. Read off
    // testkit 5.0, which builds its keystores exactly this way.
    const ks: any = await (createKeystore as any)({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
    const addr = ks.getBech32Address().asString();
    return addr.includes('undefined') ? null : addr;
  } catch {
    return null;
  }
}

/**
 * THE REFUSAL, UNABRIDGED — AND BOUNDED. `R1b`, and `C217`.
 *
 * *"On refusal: the node's error IN FULL, with its numeric code, unabridged and
 * unparaphrased. A refusal that names a version is worth more than a successful
 * deploy."*
 *
 * `describeError` is kept and printed first, because it is what makes the thing
 * readable — it walks `.cause`, `.errors` and axios `.response.data`, and
 * annotates a `Custom error: N` with what N means. But it truncates responses
 * to 400 characters, stops at three sub-errors and four levels of nesting, and
 * puts our words next to the node's. That is right for a person and wrong for
 * evidence, and this run's ONLY product may be that evidence.
 *
 * So three things are printed, in this order and clearly separated:
 *
 *   1. the explained error, as before;
 *   2. **THE NODE'S OWN LINES, VERBATIM** — every console line the RPC layer
 *      emitted carrying a rejection, uncut and unparaphrased. This is where the
 *      numeric code lives: the exception is `SubmissionError: Transaction
 *      submission error` and carries neither the code nor the node's text;
 *   3. the error object serialised whole, own properties included, so a field
 *      `describeError` does not know to look at is still in the report.
 *
 * **AN EMPTY SECTION 2 IS ITSELF THE FINDING.** No node line means the node
 * never answered — a dropped websocket, `M-23` — and with `attempts: 1` this
 * run stops there. That is NOT a refusal and says nothing about the proof
 * server pin. It is called out by name below rather than left to be misread.
 *
 * **AND ALL THREE ARE NOW BOUNDED, BECAUSE ON 28 AUG (3) REACHED 3.04 GB IN
 * THREE MINUTES.** `C217`. The serialiser lives in `scripts/error-report.ts`
 * with the whole account of why the old `WeakSet` guard could not fire, and it
 * caps depth, width and rendered bytes and de-duplicates repeated errors. Every
 * cap prints its own count: a report that drops evidence silently is worse than
 * a large one. Section 2 keeps every DISTINCT node line whole and collapses
 * only exact repeats — the same line appeared seventeen times in the first 8 KB
 * of that report — and says how many times each occurred, which is the same
 * information and is readable.
 */
main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  Failed during: ${stage}\x1b[0m`);
    console.log(describeError(e).split('\n').map((l) => '  ' + l).join('\n'));
    if (e?.stack) console.log(`\n\x1b[2m${e.stack.split('\n').slice(1, 8).join('\n')}\x1b[0m`);

    printPhases('stopped');

    console.log();
    console.log('  \x1b[1mWhat this was proved against\x1b[0m');
    console.log(`    proof server image    ${proofServerImage}`);
    console.log(`    proof server /version ${proofServerVersion}`);
    console.log('    ONE ATTEMPT was made. No retry, no other port, image or network.');

    printTxSize();

    console.log();
    console.log("  \x1b[1mThe node's own words, verbatim and uncut\x1b[0m");
    if (rawNodeLines.length) {
      // Every distinct line whole; exact repeats collapsed with their count.
      for (const line of collapseRepeatedLines(rawNodeLines)) {
        for (const part of line.split('\n')) console.log(`    ${part}`);
      }
      const codes = [...new Set(rawNodeLines.flatMap((l) => [...l.matchAll(/Custom error:\s*(\d+)/g)].map((m) => m[1])))];
      if (codes.length) {
        console.log();
        for (const c of codes) {
          console.log(`    code ${c} = ${NODE_ERROR_CODES[c] ?? '(not in our table — look it up in the node source, do not guess)'}`);
        }
      } else {
        console.log();
        console.log('    No numeric rejection code appears in the lines above. The node');
        console.log('    answered, but not with a Custom error, so this is a different');
        console.log('    failure from the 170 this run was built to test.');
      }
    } else if (stage === 'Deploying the contract' || /deploy/i.test(stage)) {
      console.log('    NOTHING, AND THE RUN HAD REACHED THE SUBMISSION. The node printed');
      console.log('    no rejection line, so it never answered: the websocket dropped and');
      console.log('    the chain never saw the transaction. M-23.');
      console.log('    THIS IS NOT A REFUSAL AND IT SETTLES NOTHING ABOUT THE PROOF');
      console.log('    SERVER PIN. Run DEPLOY-PREVIEW.command again, unchanged.');
    } else {
      console.log('    NOTHING, AND THE RUN NEVER REACHED THE SUBMISSION — it stopped in');
      console.log(`    "${stage}". So there is no node answer to have, and this failure is`);
      console.log('    local: read the error above and fix that. It says nothing about the');
      console.log('    proof server pin either way.');
    }

    console.log();
    console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
    const serialised = serialiseWholeDetailed(e);
    console.log(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
    console.log();
    for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);

    console.log();
    console.log('  Send this whole output back. The stage name above says which');
    console.log('  layer broke, so the next fix does not have to be a guess.');
    process.exit(1);
  },
);
