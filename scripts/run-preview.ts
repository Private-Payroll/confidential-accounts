/**
 * M-3, second half: propose → approve → approve on the deployed contract.
 *
 *   npx tsx scripts/run-preview.ts        (or RUN-PROPOSAL.command)
 *
 * The deploy proved the plumbing. This proves the product: an M-of-N approval
 * where the chain enforces the rule and learns neither the signers nor what
 * they approved. It is the first time the interesting circuits — the Merkle
 * membership proof, the approval nullifiers, the threshold check — run anywhere
 * other than in-process simulation.
 *
 * It also yields M-16's number, which is the per-circuit proving time, as a
 * side effect rather than as a special measuring rig that gets thrown away.
 *
 * WHAT IT DOES, and why in this order:
 *
 *   1. addSigner(B)   the constructor enrolled only the deployer, and the
 *                     threshold is 2, so one signer can never reach it alone
 *   2. propose        opens a proposal; only a commitment reaches the chain,
 *                     and the proposal's id is computed here, before it is
 *                     submitted, so an approval can be prepared without a
 *                     round trip
 *   3. approve as A   that proposal's count 0 -> 1, one nullifier appears
 *   4. approve as B   that proposal's count 1 -> 2, a second nullifier appears
 *
 * WHAT STOOD EITHER SIDE OF THAT AND IS GONE.
 *
 * A credit before the round and a settlement after it: money in, then the
 * threshold met and the asset's balance commitment moved. The account keeps no
 * books of its own now — the on-chain balance map, the tree of settled
 * proposals and the circuits that wrote them all went with the decision — so
 * there is no balance here to fund, to move, or to check afterwards.
 *
 * What survives is the part those two steps were wrapped around and never
 * enforced: the chain counts approvals, binds each to one proposal and one
 * signer, and refuses a second from the same signer. A proposal that reaches
 * its threshold is LEFT OPEN on the account, because nothing on this contract
 * spends one any more — the housekeeping cancel in stage 4 is what clears it,
 * on the next run.
 *
 * WHAT M-125 AND M-128 CHANGED IN HERE, because it is most of the diff:
 *
 *   - every amount is a bigint in the asset's smallest unit, and every figure
 *     printed below says which asset it is in. `250000` is a number; `250000
 *     GBP minor units` is an amount
 *   - there is no single `stateCommitment` to watch. M-125 made it one per
 *     asset, keyed by a blinded asset key; `C292` then took the balances
 *     themselves, so there is no commitment left for this script to watch at
 *     all, and nothing below claims to have checked one
 *   - there is no `round` and no "the" open proposal. Every call that names a
 *     proposal names which one, and the id is `proposalIdOf(payload, salt)`
 *   - there is no entry-log digest anywhere. Movements are an append-only set,
 *     written by `recordPayment` alone and by nothing this script calls
 *
 * THE PART WORTH UNDERSTANDING. Every circuit reads its inputs from the
 * caller's private state, which on a real deployment is one device's own store.
 * Acting as two signers therefore means swapping the private state between
 * calls, which is what `becomeSigner()` does. It is not a shortcut around the
 * design: it is one process standing in for two devices, and the contract
 * cannot tell the difference because the proof is over the witnesses either way.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from '@noble/hashes/utils.js';
import { join } from 'node:path';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import {
  StaticProofServerContainer,
  MidnightWalletProvider,
  createDefaultTestLogger,
} from '@midnight-ntwrk/testkit-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract, ledger as readLedger, pureCircuits } from '../contracts/managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../contracts/src/witnesses.js';
import { privateStateKey } from '../src/midnight/ledger.js';
import { applyNetworkId, theNetwork } from '../src/midnight/network.js';
import {
  assets as assetRegistry, assetIdBytes, formatAmount, NO_ASSET,
  type Asset, type AssetId,
} from '../src/core/assets.js';
import { viewDigestOf } from '../src/core/ledger.js';
import { isDeployedCircuit } from '../src/midnight/deferral.js';
import { saveDustState } from './dust-wallet.js';
import { bringUpWallet } from './wallet-bringup.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { seededBytes } from './seeded.js';
import {
  readOrCreatePreviewSigners, previewSignersFile, signerBytes, type PreviewSignerId,
} from './preview-signers.js';

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
const NETWORK = theNetwork();

const CONTRACT_FILE = join(STATE_DIR, `${NETWORK}-contract.json`);
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
 * 6301, NOT 6300.
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
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';

let stage = 'startup';
const begin = (n: number, of: number, name: string) => {
  stage = name;
  console.log(`\n\x1b[1m${n} of ${of}  ${name}\x1b[0m`);
};
const note = (s: string) => console.log(`  ${s}`);
const good = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
import { JobQueue } from '../src/core/jobs.js';
import { KeyValueJobStore, MemoryKeyValue } from '../src/core/jobs-store.js';
import { MidnightJobRunner, expectationFor } from '../src/midnight/job-runner.js';
import {
  CIRCUITS_THAT_READ_NO_WITNESS, refuseACallWithoutItsPrivateState,
} from '../src/midnight/governed-call.js';
import type { Job } from '../src/core/jobs.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeError(e: any, depth = 0): string {
  if (e == null || depth > 4) return String(e);
  const pad = '  '.repeat(depth);
  const bits: string[] = [`${pad}${e.name ? e.name + ': ' : ''}${e.message ?? String(e)}`];
  if (e.code) bits.push(`${pad}  code: ${e.code}`);
  const data = e.response?.data;
  if (data) bits.push(`${pad}  response: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) bits.push(describeError(sub, depth + 1));
  if (e.cause && e.cause !== e) bits.push(describeError(e.cause, depth + 1));
  return bits.join('\n');
}

/*
 * There is no retry wrapper here, and that is deliberate.
 *
 * This script had its own copy of `withRetry` and never called it — dead code
 * from the day it was written, which is why the drift that cost M-50/55/58/61/65
 * never bit here. `callCircuit` below is what this script actually uses, and it
 * does more: `withRetry` catches a throw, and the failure seen on preview was a
 * **hang**. A wait with no bound throws nothing and retries never.
 */

/**
 * How far each sub-wallet has synced, as one line.
 *
 * Defined at module scope deliberately. The previous version called a
 * `progressOf` that existed only in diagnose-state.ts and deploy-preview.ts —
 * a ReferenceError that fired inside the balanceTx wrapper, three times, and
 * cost a run. It is used from a closure built in one stage and invoked in
 * another, so it must not depend on where it sits inside main().
 */
const progressOf = (s: any): string => {
  const one = (p: any, name: string) => {
    if (!p) return `${name} —`;
    // The real field names, read off SyncProgress.d.ts in
    // @midnight-ntwrk/wallet-sdk-abstractions rather than guessed at. The
    // guessed ones (`appliedId`, `highestTransactionId`) are why dust and
    // shielded printed `?/?` for this entire session — M-26. The old names are
    // kept as a fallback because the unshielded wallet does answer to them.
    const applied = p.appliedIndex ?? p.appliedId ?? '?';
    const highest = p.highestRelevantIndex ?? p.highestIndex ?? p.highestTransactionId ?? '?';
    const conn = p.isConnected === false ? ' OFFLINE' : '';
    let done = '';
    try {
      // isCompleteWithin, not isStrictlyComplete: the chain keeps producing
      // blocks, so "applied === highest" is a moving target that a live wallet
      // may never hit. A small gap is what "caught up" actually means here.
      if (typeof p.isCompleteWithin === 'function') done = p.isCompleteWithin(10n) ? '✓' : '';
      else if (typeof p.isStrictlyComplete === 'function') done = p.isStrictlyComplete() ? '✓' : '';
    } catch { /* a progress object that throws is still worth printing */ }
    return `${name} ${applied}/${highest}${done}${conn}`;
  };
  try {
    return [
      one(s?.unshielded?.progress ?? s?.unshielded?.state?.progress, 'unshielded'),
      one(s?.dust?.state?.progress ?? s?.dust?.progress, 'dust'),
      one(s?.shielded?.state?.progress ?? s?.shielded?.progress, 'shielded'),
    ].join('  ');
  } catch {
    return 'could not read sync state';
  }
};

/**
 * A PROPOSAL SALT, AND IT MUST BE DIFFERENT ON EVERY RUN.
 *
 * Everything else in this script is seeded on purpose — signer A's key has to
 * match what the deploy wrote or A is not a signer on the account. A proposal
 * salt is the one thing that cannot be, and the reason is M-128.
 *
 * A proposal's id is `commit(payloadHash, salt)`, an approval's nullifier is
 * bound to that id, and `approvals` is a set the contract NEVER CLEARS — that
 * is what makes an approval unrepeatable, and it is the whole point of the
 * design. A fixed salt therefore produces the same id on every run against the
 * same deployment, and the second run dies on `you have already approved this
 * proposal` at the first `approve`, having burned the nullifier a year ago.
 *
 * Cancelling does not help: `cancel` frees the id and deliberately leaves the
 * nullifiers burned. The contract says as much in its own note — a re-proposal
 * takes a fresh salt. This is that fresh salt.
 */
const freshSalt = (): Uint8Array => randomBytes(32);

/**
 * One per proposal this run raises, drawn once so propose, approve and the call
 * that spends the proposal all commit under the same bytes.
 */
const PAYMENT_SALT = freshSalt();
const JOB_SALT = freshSalt();
const ADD_B_SALT = freshSalt();
const ADD_C_SALT = freshSalt();

/* ------------------------------------------------------------------ *
 * the two signers
 *
 * A IS THE FOUNDING SIGNER — the one seat the CONSTRUCTOR creates — and it is
 * no longer "the deployer". Its secret and blinding MUST be the
 * ones `deploy-preview.ts` used, or A is not in the tree and every circuit
 * fails with "not a signer".
 *
 * **AND THEY ARE READ FROM A FILE NOW RATHER THAN COMPUTED FROM A FORMULA.**
 * A was `seededBytes(1)`/`seededBytes(401)` in both scripts, which made the two
 * processes agree — and made every one of these five identities computable by
 * anyone who reads this repository, on an account these scripts seat them on.
 * `scripts/preview-signers.ts` keeps the agreement and removes the
 * computability: real entropy, generated once, written under `.midnight/`,
 * per network AND per account.
 *
 * **A REFUSAL HERE IS THE HONEST ONE.** If the file is absent this script does
 * NOT invent a signer set — it would deploy nothing and simply fail against a
 * live account minutes later. `DEPLOY-PREVIEW.command` is the door that creates
 * the file, and it is named in the refusal (rule 19).
 *
 * WHAT IS NO LONGER SET HERE, and why the placeholders below are safe.
 *
 * The account's asset blinding — which is what turns an asset code into the key
 * a change commitment names — is not knowable until the view file has been
 * read. So both of the asset-shaped fields below are placeholders that nothing
 * reads: `becomeSigner()` overwrites `assetId` and `assetBlinding` on every
 * single call, from the view file and from the change in flight.
 *
 * `current` and `next` STOOD HERE TOO, with a placeholder view of their own.
 * They carried the balance a call read and the balance it would write, and they
 * went with the balance ledger under `C292`/`S26` — the private-state type has
 * no such fields and no witness reads one. The rule they were here to enforce
 * survives in the two that are left: a device stages what a call needs BEFORE
 * the call, from the view file, never from whatever the last call happened to
 * leave behind.
 *
 * A placeholder blinding cannot be used by accident and land somewhere wrong.
 * It derives a key nothing on this account answers to, so a call that somehow
 * skipped the staging fails inside its own proof rather than committing to a
 * change no signer can recognise.
 * ------------------------------------------------------------------ */

/** 32 bytes of zero, for the two fields `becomeSigner` overwrites per call. */
const PLACEHOLDER_32 = new Uint8Array(32);

/**
 * The digest over the entries a change appends to the log.
 *
 * Still a real value even though there is no log to chain it onto any more: the
 * contract commits to it inside `changeCommitmentOf`, which is what makes two
 * otherwise identical payments distinguishable movements in the set. Stands in
 * here for the digest of a real payroll batch.
 *
 * `CHANGE_AMOUNT` and `NEXT` USED TO BE HERE. The amount is now decided at the
 * point each round is raised, in the asset's smallest unit. `NEXT` described
 * the state a call would write, and there is no such state left to describe:
 * the account keeps no balance, so a change is an amount of an
 * asset that the signers approve, and nothing else. What this digest is for is
 * untouched by that.
 */
const CHANGE_BATCH = seededBytes(601);

/**
 * A 32-byte zero, for the circuit arguments that are passed and never read.
 *
 * **IT USED TO FILL `amendSigner`'s PROPOSAL SLOT ON THE BOOTSTRAP PATH, AND
 * THERE IS NO SUCH PATH ANY MORE.** `S35d` deleted the constructor's threshold
 * argument, so every account is founded with one signer and `threshold = 1` and
 * `signerLeaves.size() < threshold` is false from birth and cannot become true.
 * The proof is written out in the contract beside `threshold = 1`; the
 * consequence is `docs/company-accounts.md` section 10a. Every seat this script
 * takes, B's included, names a real approved proposal.
 *
 * WHAT IS LEFT FOR IT is `propose`'s `root`, which is read only when `isRun` is
 * true and this script raises no run proposals. A circuit's arity is fixed, so
 * something has to go in that slot. Zero is the honest filler:
 * `persistentCommit` can never produce it, so it cannot collide with a real
 * payroll root, and the branch that would read it is not taken. The same
 * constant for the same reason as `ZERO_32` in src/midnight/ledger.ts.
 */
const ZERO_32 = new Uint8Array(32);

/**
 * THE FIVE, FROM THE FILE `DEPLOY-PREVIEW.command` WROTE.
 *
 * Not created here. `readOrCreatePreviewSigners` would happily make a fresh set
 * if the file were missing, and a fresh set is five identities that are not on
 * the account this script is about to call — so this checks first and names the
 * door instead of manufacturing a failure for later.
 */
const previewSignersFileForRun = previewSignersFile(STATE_DIR, NETWORK, ACCOUNT_ID);
if (!existsSync(previewSignersFileForRun)) {
  throw new Error(
    `there is no demo signer material for "${ACCOUNT_ID}" on ${NETWORK}: ` +
      `${previewSignersFileForRun.replace(ROOT + '/', '')} does not exist. It is written by the ` +
      'deploy, which seats signer A from it, so a run without it is a run against an account ' +
      'whose signers this machine does not know.\n' +
      'Run DEPLOY-PREVIEW.command, then run this again.',
  );
}
const PREVIEW_SIGNERS = readOrCreatePreviewSigners(STATE_DIR, NETWORK, ACCOUNT_ID).signers;

/** One signer's device. Everything asset-shaped is staged per call. */
const device = (id: PreviewSignerId): AccountPrivateState => ({
  ...signerBytes(PREVIEW_SIGNERS[id]),
  // Reserved, not enforced. Every signer is seated with all-vaults scope (V-33).
  scope: pureCircuits.allVaults(),
  // Overwritten by becomeSigner() from the view file. See the note above.
  assetBlinding: PLACEHOLDER_32,
  assetId: PLACEHOLDER_32,
  // `current` and `next` stood here, staging the balance a call read and the
  // balance it would write. Both went with the balance ledger.
  // What decision 0002 said about them still holds for what is left: every
  // signer opens the same shielded state with the viewing key shared off chain,
  // and only the secret and the blinding differ.
  proposalSalt: PAYMENT_SALT,
  changeAmount: 0n,
  changeBatchDigest: CHANGE_BATCH,
  pinnedPath: null,
});

const signerA = device('A');
const signerB = device('B');

/**
 * A third signer. **Seated through the approved path — which since `S35d` is
 * the only path there is.** The sentence that stood here set C against B's
 * bootstrap seat; the window is shut by construction on every account now, B
 * goes the same way C does, and the contrast went with it
 * (`docs/company-accounts.md` section 10a).
 *
 * WHAT C STILL ADDS OVER B IS THE SECOND APPROVER. B's addition is approved by
 * A alone, because A is the only signer on the account at that point. C's is
 * approved by A and by whoever is seated second, which is the shape every
 * addition after the first has.
 *
 * Shares the proposal salt with A and B for the same reason they share
 * it with each other: the salt travels with the payload off chain, and without
 * it a signer cannot open the commitment they are being asked to approve — nor,
 * since M-128, compute the proposal's id, which is itself `commit(payload, salt)`.
 */
const signerC = device('C');

/*
 * Two more devices, used only by the governance run. Four signers is
 * the smallest account in which somebody can be removed from the MIDDLE, which
 * is the only arrangement that tells a correct slot derivation apart from
 * several wrong ones; the fifth is the one that reuses the vacated slot.
 */
const signerD = device('D');
const signerE = device('E');

const leafOf = (s: AccountPrivateState) =>
  pureCircuits.signerLeaf(pureCircuits.signerPublicKey(s.secretKey), s.blinding, s.scope);

/* ------------------------------------------------------------------ */

/**
 * Every circuit this script CALLS, so it can refuse before it spends.
 *
 * Not derived from the code below — that is the point. A list a reader can
 * check against the calls, so a circuit this run drives can never be one the
 * deployment does not carry.
 *
 * IT LISTED FOUR IT NEVER CALLS UNTIL S27, and a list that overstates
 * is a guard that refuses runs which would have worked — the opposite failure
 * from the one it exists to prevent, and just as expensive to diagnose. The
 * four were `closeExpiredRun`, `adopt`, `recordPayment` and `setVaultThreshold`.
 *
 * BOTH PATHS ARE COVERED, and that is why `setThreshold` is here while nothing
 * in `main` below calls it. This guard runs before the branch at
 * `MIDNIGHT_GOVERNANCE_RUN`, so the list has to be the union of what either
 * path drives:
 *
 *   the default path   `cancel`, `propose`, `approve`, `amendSigner`
 *   the governance path (`GOVERNANCE-RUN.command` sets the variable, and the
 *                        steps live in `scripts/governance-steps.ts`)
 *                      `propose`, `approve`, `cancel`, `amendSigner`,
 *                      `setThreshold`
 *
 * Checked against every `found.callTx.<circuit>(` in this file and in
 * `scripts/governance-steps.ts`, which is the check the comment above invites.
 */
const CIRCUITS_THIS_RUN_DRIVES = [
  'amendSigner', 'propose', 'approve', 'cancel', 'setThreshold',
] as const;

async function main() {
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  propose → approve → approve on ${NETWORK}`);
  console.log('────────────────────────────────────────────────────────────');

  /*
   * BEFORE A WALLET SYNCS, A PROOF IS BUILT OR A TRANSACTION IS SUBMITTED.
   *
   * Not theoretical. The circuits this run does call are called well inside it,
   * after `cancel`, `amendSigner`, `propose` and two `approve`s have each been
   * proven, balanced and SUBMITTED for real. Reaching a missing circuit there
   * costs a live account those transactions and their fees before the failure
   * appears — and it appears as an SDK TypeError on an undefined callTx member,
   * which names nothing.
   *
   * IT FIRED, AND IT NO LONGER DOES. It was standing on `credit` and `execute`,
   * which this run drove and the deployment did not carry. `C292` decided the
   * account keeps no books and `S26` carried it out: both circuits are gone
   * from the contract, and both are gone from the list above, so the list and
   * the deployment agree and there is nothing here to refuse.
   *
   * THE GUARD STAYS, because what it checks did not change with them. The list
   * above is maintained by hand and the deployment is decided in
   * src/midnight/deferral.ts against a per-extrinsic ceiling; two lists kept
   * apart drift, and the cheapest moment to discover it is before the wallet is
   * brought up rather than eight proofs in.
   */
  const undeployed = CIRCUITS_THIS_RUN_DRIVES.filter((c) => !isDeployedCircuit(c));
  if (undeployed.length > 0) {
    console.log();
    console.log('  REFUSED before anything ran, was proven or was spent.');
    console.log(`  This run drives ${undeployed.join(', ')}, which the deployment`);
    console.log('  src/midnight/deferral.ts describes does not carry, so this script has');
    console.log('  no path that reaches its own assertions.');
    console.log('  It is not a retry away. Either the contract regained a circuit the');
    console.log('  deployment was never re-decided for, or this run was pointed at one that');
    console.log('  was shed — and which circuits a deployment carries is decided against the');
    console.log('  per-extrinsic ceiling, not here.');
    console.log('  MEASURE-DEPLOY-SHAPE.command scores the compiled set against that ceiling;');
    console.log('  DEPLOY-PREVIEW.command is what puts a re-decided set on chain.');
    process.exitCode = 1;
    return;
  }

  /* -------------------------------------------------- 1 */
  /* ---------- watchdog and phase instrumentation, before anything uses them ---------- */

  /**
   * Runs a circuit call with an upper bound, a heartbeat, and a check before
   * any retry.
   *
   * `withRetry` alone is not enough: it catches a throw, and the failure seen
   * on preview was a **hang**. `addSigner` sat for sixteen minutes in silence.
   * It was not proving — the proof provider gives up after 300s — it was
   * waiting for confirmation over an indexer subscription that had closed
   * four seconds after the wallet started. A wait with no bound throws nothing
   * and retries never.
   *
   * `landed()` is what makes retrying safe. A timeout waiting for confirmation
   * does not mean the transaction failed, and re-running `addSigner` blindly
   * would insert the same signer's leaf a second time. So on timeout we ask
   * the chain what actually happened before deciding.
   */
  /**
 * How long a single circuit call may take before the watchdog stops it.
 *
 * Was six minutes, and six minutes was the wrong number: it killed the run
 * while the proof server was still fetching its shared reference string from
 * srs.midnight.network. Every "six minute hang" was really "my ceiling fired
 * during a large one-time download". The server sat at 0.18% CPU throughout,
 * which is what a download looks like and what computation does not.
 *
 * Thirty minutes, so the first proof has room to fetch what it needs. Once the
 * container has those parameters it keeps them, and later proofs should be in
 * seconds — that is the number M-16 has always been asking for.
 */
/**
 * Three minutes, not thirty.
 *
 * Thirty was a debug ceiling chosen while a single call could block for six
 * minutes and we needed to see how far it would go. That cause is fixed,
 * and a ceiling that high now just means a failure takes half an hour to
 * surface — with three retries behind it. The longest legitimate wait here is
 * the indexer confirming a transaction, which is a block or two.
 */
const CALL_TIMEOUT_MS = Number(process.env.MIDNIGHT_CALL_TIMEOUT_MS || 3 * 60_000);

  /*
   * The watchdog runs on a worker thread, because the main thread cannot be
   * relied upon to notice its own problems. M-33: the previous heartbeat and
   * timeout were both event-loop timers, and a circuit call blocks the loop
   * synchronously, so neither ever fired. Zero heartbeat lines on a sixteen
   * minute hang.
   *
   * A worker has its own loop. It reads a timestamp the main thread stamps
   * into shared memory, so it can measure the stall without the main thread
   * participating, and it can force an exit that a blocked loop cannot.
   */
  const { Worker } = await import('node:worker_threads');
  const sharedBuffer = new SharedArrayBuffer(9 * 8);
  // BigInt64Array, not Float64Array: Atomics only accepts integer typed arrays.
  const shared = new BigInt64Array(sharedBuffer);
  const PULSE = 0, IN_FLIGHT = 1, STEP = 2, STEP_START = 3, PHASE = 4, WITNESS_CALLS = 5, LAST_WITNESS = 6;
  /** M-46: how many times the ledger has been asked to price a transaction, and the last price. */
  const FEE_CALLS = 7, LAST_FEE = 8;

  /**
   * Phase codes, matching the table in watchdog.mjs.
   *
   * `callTx` is a single opaque call, so when it blocks there is no way to tell
   * which part blocked. Recording the phase in shared memory before entering
   * each provider method means the watchdog can name it even after the main
   * thread has stopped responding — which is exactly when we need to know.
   */
  const PH = {
    idle: 0, build: 1, readKey: 2, prove: 3, submit: 4, confirm: 5,
    queryState: 6, privateState: 7, balance: 8,
    // `balance` is three SDK calls, not one. Reading testkit-js:
    //   balanceTx = balanceUnboundTransaction -> signRecipe -> finalizeRecipe
    // The 40s stack sample landed inside unsymbolised WASM under `balance`,
    // which is as far as one phase code can take us. Splitting it costs
    // nothing and names which of the three actually blocks.
    balanceUnbound: 9, signRecipe: 10, finalizeRecipe: 11,
  };
  const setPhase = (p: number) => Atomics.store(shared, PHASE, BigInt(p));

  /**
   * The phase to fall back to when a provider method finishes.
   *
   * The first version reset to `idle`, which meant the 365s stall reported
   * "idle" — true but useless, because it conflated "no provider was ever
   * called" with "a provider finished and we are back inside SDK code". The
   * ambient phase during a call is transaction assembly, so say that.
   */
  let ambientPhase = PH.idle;
  const setAmbient = (p: number) => { ambientPhase = p; setPhase(p); };

  // The liveness pulse. This timer only runs when the event loop is free, so a
  // stale pulse is precisely the signal that the main thread is blocked —
  // which is the thing no in-process timeout could detect.
  const pulse = () => Atomics.store(shared, PULSE, BigInt(Date.now()));
  pulse();
  setInterval(pulse, 2000).unref();

  const beginStep = () => {
    pulse();
    Atomics.store(shared, STEP_START, BigInt(Date.now()));
    Atomics.store(shared, IN_FLIGHT, 1n);
    Atomics.add(shared, STEP, 1n);
  };
  const endStep = () => { Atomics.store(shared, IN_FLIGHT, 0n); setAmbient(PH.idle); pulse(); };

  /**
   * Wraps a provider method so it records which phase it is in.
   *
   * Deliberately wrapping the providers rather than reassembling the call from
   * `createUnprovenCallTx` and `submitTx` by hand: hand-assembly is what M-16
   * lost six rounds to, and the point here is to observe the SDK doing its
   * normal thing, not to build a second way of doing it.
   */
  const timed = <T extends object>(obj: T, phases: Partial<Record<keyof T & string, number>>): T => {
    const proto = Object.getPrototypeOf(obj) ?? Object.prototype;
    // Keeping the prototype matters: this SDK does `instanceof` checks, and
    // M-30 was three hours of a failing `instanceof`. Verified that
    // `wrapped instanceof ZKConfigProvider` still holds.
    const out: any = Object.create(proto);
    // Only the object's own and its immediate prototype's members. Walking into
    // Object.prototype would wrap `constructor` and friends, which is asking
    // for trouble for no benefit.
    const protoKeys = proto === Object.prototype ? [] : Object.getOwnPropertyNames(proto);
    for (const key of new Set([...Object.keys(obj as any), ...protoKeys])) {
      if (key === 'constructor') continue;
      const v: any = (obj as any)[key];
      if (typeof v !== 'function') { try { out[key] = v; } catch {} continue; }
      const phase = (phases as any)[key];
      out[key] = (...args: any[]) => {
        if (phase !== undefined) { setPhase(phase); pulse(); }
        const r = v.apply(obj, args);
        if (r && typeof r.then === 'function') {
          return r.finally(() => { pulse(); if (phase !== undefined) setPhase(ambientPhase); });
        }
        pulse();
        if (phase !== undefined) setPhase(ambientPhase);
        return r;
      };
    }
    return out;
  };

  /**
   * Counts every witness invocation, and pulses while doing it.
   *
   * The witnesses are our own JavaScript, called back from the WASM circuit
   * runtime. That makes them the only window into what assembly is actually
   * doing: `signerPath` costs 0.7ms (measured), so half a million calls would
   * be 350 seconds, which is exactly the stall we see.
   *
   * Pulsing here matters too. The liveness pulse is a `setInterval`, which does
   * not run during synchronous WASM even when WASM calls back into JS. So if
   * the counter climbs while the pulse looks stale, the main thread is busy
   * rather than deadlocked — a distinction worth having.
   */
  const WITNESS_NAMES = Object.keys(witnesses as any).sort();
  const countedWitnesses = Object.fromEntries(
    Object.entries(witnesses as any).map(([name, fn]) => [
      name,
      (...args: any[]) => {
        Atomics.add(shared, WITNESS_CALLS, 1n);
        Atomics.store(shared, LAST_WITNESS, BigInt(WITNESS_NAMES.indexOf(name)));
        Atomics.store(shared, PULSE, BigInt(Date.now()));
        return (fn as any)(...args);
      },
    ]),
  );

  let currentStepName = '';
  const watchdog = new Worker(new URL('./watchdog.mjs', import.meta.url), {
    workerData: {
      sharedBuffer, timeoutMs: CALL_TIMEOUT_MS, heartbeatMs: 15_000,
      label: 'the current step', witnessNames: WITNESS_NAMES,
    },
  });


  /* --------------------------------------------------------------- M-46
   *
   * Count every fee computation, and record the last fee, into shared memory.
   *
   * The stall is `computeBalancingRecipe` in wallet-sdk-dust-wallet: a
   * fixed-point loop that picks dust to cover the fee, recomputes the fee with
   * those dust spends added, and repeats `while (!converged)` — no iteration
   * cap, no deadline, `Effect.runSync`. Each pass calls `feesWithMargin`.
   *
   * So the call count IS the iteration count, and the returned value IS the
   * sequence it is failing to converge on. Climbing, oscillating and flat need
   * different fixes and cannot be told apart by reading the code.
   *
   * Written into the watchdog's shared buffer rather than logged, deliberately:
   * the main thread is blocked during the loop, `console.log` to a pipe is
   * asynchronous in node, and `RUN-PROPOSAL.command` pipes through `tee`. Every
   * line logged from inside the stall would sit in a buffer until the stall
   * ended. The watchdog writes with `writeSync` from a thread that still runs.
   *
   * Patching the prototype of the same module object the dust wallet imports
   * (`@midnightntwrk/ledger-v9` on the 5.0 stack — the scope lost its hyphen
   * and the ledger went from v8 to v9; `npm dedupe` guarantees one copy, M-30).
   * Read-only: it calls through and returns the real value.
   */
  try {
    const ledger: any = await import('@midnightntwrk/ledger-v9');
    const txProto: any = ledger?.Transaction?.prototype;
    if (typeof txProto?.feesWithMargin === 'function') {
      const original = txProto.feesWithMargin;
      txProto.feesWithMargin = function patched(this: any, ...args: any[]) {
        const fee = original.apply(this, args);
        try {
          Atomics.add(shared, FEE_CALLS, 1n);
          Atomics.store(shared, LAST_FEE, BigInt(fee));
        } catch { /* never let instrumentation break the call */ }
        return fee;
      };
      good('fee accounting attached (M-46)');
    } else {
      note('  could not attach fee accounting: feesWithMargin not found on Transaction');
    }
  } catch (e: any) {
    note(`  could not attach fee accounting: ${String(e?.message ?? e).slice(0, 120)}`);
  }  watchdog.unref();
  // No message handler for output: the watchdog writes straight to fd 1,
  // because a handler here would run on the very thread that is blocked.

  begin(1, 7, 'Checking what we need before touching the network');

  if (!existsSync(CONTRACT_FILE)) {
    throw new Error(
      `no deployed contract recorded.\n` +
        `  Expected ${CONTRACT_FILE.replace(ROOT + '/', '')}.\n` +
        `  Run DEPLOY-PREVIEW.command first.`,
    );
  }
  const deployed = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  const contractAddress: string = deployed.contractAddress;
  good(`contract ${contractAddress.slice(0, 24)}… on ${deployed.network}`);

  /*
   * The account as every signer's device currently sees it.
   *
   * Shared across all three signers, because that is decision 0002: they all
   * open the same sealed blob with the same viewing key.
   *
   * IT USED TO HAVE TO BE UPDATED THE MOMENT A CALL LANDED, or the next one
   * failed as "stale" — since M-70 every state-moving circuit checked it
   * against the chain. Those circuits checked a balance, and both went with
   * What is left does not move within a run.
   *
   * The `assetId` and `assetBlinding` on the signer constants above are
   * placeholders that nothing reads — `becomeSigner()` overrides both per
   * call, from this.
   *
   * READ IN STAGE 1, before the wallet is brought up, because everything it can
   * refuse for is knowable now and the alternative is discovering it after four
   * minutes of DUST sync. Same rule as the contract-address check above.
   */
  /*
   * THE ACCOUNT'S CURRENT OPENING, persisted between runs.
   *
   * This started as a hardcoded `CURRENT` — the state as it was at deploy — and
   * that worked exactly once. The second run against the same contract failed
   * with `failed assert: your view of the account is stale`, because the first
   * run had moved the account and nothing wrote down where it moved to.
   *
   * THE STALENESS ASSERT WENT WITH THE BOOKS. Since M-70 every
   * state-moving circuit had checked the caller's view against the chain — and
   * what it checked was a balance the account no longer keeps, so the check and
   * the circuits that made it are gone together. Nothing left in this file can
   * go stale: it is the account's own asset blinding, which never rotates.
   *
   * It is still the half that cannot be recovered. Only COMMITMENTS are on
   * chain and the blinding lives off them, so nothing the chain holds can
   * reproduce it. In the product that is the sealed blob every signer opens
   * with the viewing key (decision 0002). This script has no blob store, so it
   * keeps a file — the same idea, minus the encryption, because there is
   * nothing here worth hiding from the person running it.
   *
   * Lose this file and the account is unopenable. That is not a flaw in the
   * script; it is the actual property of the design, in miniature.
   *
   * THE SHAPE, and the names below are the ones `deploy-preview.ts` writes and
   * `sponsor-test.ts` reads:
   *
   *   { network, contractAddress, asset, assetBlinding, savedAt }
   *
   * A BALANCE AND THE BLINDING FACTOR IT WAS COMMITTED UNDER STOOD IN IT, and
   * they went with the balance ledger; `entriesDigest` went earlier, with the
   * entry log. What is left is the pair that still decides anything: which
   * asset this run drives, and the account-level value that turns an asset code
   * into the key every change on this account is committed under. The blinding
   * appears nowhere else on disk.
   *
   * ONE ASSET IN THIS FILE, deliberately. The account may hold any number; this
   * script drives exactly the one the deploy named, and a map here would
   * suggest it tracks all of them.
   */
  const VIEW_FILE = join(STATE_DIR, `${NETWORK}-view.json`);

  /** The account as this device sees it, for ONE asset. Mirrors `StateView`. */
  interface AccountView {
    asset: AssetId;
    /** Account-level and never rotated. The same for every asset and signer. */
    assetBlinding: Uint8Array;
  }

  /**
   * Reads the view, and REFUSES BY NAME rather than guessing.
   *
   * A view written before the multi-asset change says nothing about which
   * asset it describes, and the account's blinding — which is what derives the
   * key — does not appear in it at all. Defaulting to something would produce a
   * key nothing on this account answers to, and the failure would surface
   * inside the change commitment a proposal is built from: true of the key, and
   * completely misleading about the cause.
   *
   * Word for word the check `sponsor-test.ts` makes, because the two read the
   * same file and a rule written twice with one copy missing a line is this
   * project's oldest failure.
   */
  const readViewFile = (): AccountView => {
    if (!existsSync(VIEW_FILE)) {
      throw new Error(
        `there is no saved view at ${VIEW_FILE.replace(ROOT + '/', '')}.\n` +
          "    It holds the account's asset blinding, which cannot be recovered from\n" +
          '    anything the chain holds — so without it this device cannot derive the key\n' +
          '    every change on this account is committed under, and can raise nothing the\n' +
          '    other signers would recognise.\n\n' +
          '    Deploy a fresh contract (DEPLOY-PREVIEW.command) and run this again. That is\n' +
          '    not a workaround: an account whose opening is lost really is unopenable, which\n' +
          '    is the property this design has by construction.',
      );
    }
    const raw = JSON.parse(readFileSync(VIEW_FILE, 'utf8'));
    /*
     * EVERY FIELD THIS FUNCTION GOES ON TO READ IS IN THIS LOOP, and M-137 is
     * the record of what one gap costs: `balance` was missing from it, and a
     * file without that field reached `BigInt(undefined)` and threw *Cannot
     * convert undefined to a BigInt* — a stack trace where each of its siblings
     * got a sentence naming the file, the field, and what to do about it.
     *
     * `balance` and the blinding factor it was committed under have since left
     * the file altogether, with the balance ledger. The rule
     * M-137 bought is what stays, and it is why this list is not now shorter
     * than what is read below: two fields are read, and both are named here.
     */
    for (const field of ['asset', 'assetBlinding'] as const) {
      if (raw[field] === undefined || raw[field] === null || raw[field] === '') {
        throw new Error(
          `${VIEW_FILE.replace(ROOT + '/', '')} has no "${field}", so it predates the ` +
            'multi-asset change (M-125) and cannot say which balance it describes. ' +
            'Redeploy to write a current view.',
        );
      }
    }
    /*
     * THE VIEW AND THE CONTRACT FILE MUST DESCRIBE THE SAME ACCOUNT.
     *
     * The deploy writes `${NETWORK}-contract.json` and then `${NETWORK}-view.json`,
     * so a crash between the two leaves a pair that disagree. Nothing compared
     * them, and the run went on to fail several minutes later on a commitment
     * mismatch — an answer this check already had before a single proof was
     * generated.
     */
    if (raw.contractAddress && raw.contractAddress !== contractAddress) {
      throw new Error(
        `${VIEW_FILE.replace(ROOT + '/', '')} describes a different account.\n` +
          `    the view says     ${raw.contractAddress}\n` +
          `    the contract file ${contractAddress}\n` +
          '    A deploy that was interrupted between writing the two leaves this. Redeploy.',
      );
    }
    const bytes = (field: 'assetBlinding'): Uint8Array => {
      /*
       * `Buffer.from(x, 'hex')` TRUNCATES rather than throwing.
       *
       * One bad character yields a short — often empty — buffer, and the first
       * thing to touch it is `assetKeyOf` inside WASM, which fails naming
       * neither the field nor the file.
       */
      const out = Uint8Array.from(Buffer.from(String(raw[field]), 'hex'));
      if (out.length !== 32) {
        throw new Error(
          `${VIEW_FILE.replace(ROOT + '/', '')} has a corrupt "${field}": ${out.length} bytes ` +
            'of valid hex where 32 are needed. The file has been edited or truncated, and ' +
            'the value cannot be recovered from anything the chain holds — redeploy.',
        );
      }
      return out;
    };
    return {
      asset: String(raw.asset),
      assetBlinding: bytes('assetBlinding'),
    };
  };

  /**
   * Writes the view back.
   *
   * NOTHING IN THIS SCRIPT CALLS IT ANY MORE, and that is worth saying rather
   * than leaving to be noticed. Its two callers were the credit step and the
   * settlement step, which wrote the balance each had just moved; both went
   * with the balance ledger under `C292`/`S26`, and what is left in the file —
   * the asset and the account's blinding — is written once by the deploy and
   * never moves.
   *
   * Left in place rather than deleted because it is this script's only
   * statement of the shape it agrees with `deploy-preview.ts` and
   * `sponsor-test.ts` on, and because whether anything here should write the
   * file again depends on a circuit that records something, which this contract
   * does not yet have. A row for the register, not a repair to make here.
   */
  const writeViewFile = (v: AccountView) => {
    writeFileSync(VIEW_FILE, JSON.stringify({
      network: NETWORK,
      contractAddress,
      asset: v.asset,
      assetBlinding: hex(v.assetBlinding),
      savedAt: new Date().toISOString(),
    }, null, 2));
  };

  let accountView = readViewFile();

  /**
   * The asset this run's round is denominated in, out of the registry rather
   * than as a bare code. It moves nothing — the account keeps no balances
   * — but the amount the signers approve still names it.
   *
   * The registry is the only place that knows how many decimal places it has,
   * which is what makes every figure printed below unambiguous. `require`
   * throws with a readable message on a code that is not in the table — which
   * includes `NONE`, deliberately: nothing may be denominated in it.
   */
  const ASSET: Asset = assetRegistry.require(accountView.asset);

  /**
   * How every amount in this report is written.
   *
   * MINOR UNITS AND THE ASSET, always, because "250000" is a number and not an
   * amount: it is £2,500.00, or a quarter of a USDC, or a rounding error in
   * ether, and a report a person reads to decide whether something worked must
   * not leave that open. The human figure comes along for the ride.
   */
  const minor = (v: bigint) =>
    `${v} ${ASSET.code} minor units (${formatAmount(v, ASSET)} ${ASSET.code})`;

  /**
   * The key an asset's changes are committed under, on this account.
   *
   * IT ADDRESSED AN ENTRY IN THE ON-CHAIN BALANCE MAP, and that map went with
   * the balance ledger. The key outlived it, because `propose`
   * still binds it inside the change commitment
   * (contracts/src/ConfidentialAccount.compact:2130,2283) — which is what makes
   * an approval to pay dollars not an approval to move the same integer of
   * anything else.
   *
   * Computed by the CONTRACT'S own pure circuit, never reimplemented here: the
   * chain and the client have to agree on it byte for byte, or a proposal
   * raised on this device commits to a change no other signer can recognise.
   */
  const keyFor = (asset: AssetId) =>
    pureCircuits.assetKeyOf(assetIdBytes(asset), accountView.assetBlinding);

  good(`view file read — ${ASSET.code} (${ASSET.name}), and the account's asset blinding`);
  note(`  changes on this asset commit under ${hex(keyFor(ASSET.code)).slice(0, 24)}…`);


  if (!existsSync(SEED_FILE)) throw new Error('no wallet seed; run DEPLOY-PREVIEW.command first');
  const masterSeed = readFileSync(SEED_FILE, 'utf8').trim();

  const { validatePassword } = await import('@midnight-ntwrk/midnight-js-utils');
  try { validatePassword(PRIVATE_STATE_PASSWORD); good('private state password meets the SDK rules'); }
  catch (e: any) { throw new Error(`private state password rejected: ${e?.message ?? e}`); }

  const compiled = CompiledContract.make('ConfidentialAccount', Contract as any).pipe(
    CompiledContract.withWitnesses(countedWitnesses as any),
    CompiledContract.withCompiledFileAssets(ARTIFACTS as never),
  ) as any;
  good('compiled contract ready');

  // Both leaves are computed by the contract's own pure circuits, so the client
  // and the chain cannot disagree about what a leaf is. That seam is M-14.
  good(`signer A leaf  ${hex(leafOf(signerA)).slice(0, 24)}…`);
  good(`signer B leaf  ${hex(leafOf(signerB)).slice(0, 24)}…`);

  await applyNetworkId(NETWORK);

  /* -------------------------------------------------- 2 */
  begin(2, 7, 'Connecting and starting the wallet');

  const logger = createDefaultTestLogger();
  // Stagenet has no testkit class, so this may route through the environment
  // variables instead. See scripts/test-environment.ts.
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK} — ${how}`);
  /*
   * Retried, because the testkit's own startup health check gives each endpoint
   * ONE SECOND.
   *
   * `env.start()` pings the node, the indexer, the proof server and the faucet
   * with `axios … { timeout: 1000 }` — the value is hardcoded in four places in
   * `testkit-js`, so it cannot be configured from here. Against public internet
   * endpoints that is marginal by design: the run that worked measured 500ms,
   * 670ms and 870ms, so a slow moment anywhere kills the run before it starts,
   * with `AxiosError: timeout of 1000ms exceeded` and nothing to say which
   * endpoint was slow.
   *
   * A retry is the right shape rather than a workaround. The check is a
   * liveness probe with no side effects, so running it again costs a second and
   * is safe by construction — and the thing it is actually detecting, a
   * transient blip, is exactly what a retry is for. If the network really is
   * down, three attempts say so just as clearly.
   */
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`node ${cfg.node}`);

  const { unshieldedToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const NIGHT = (unshieldedToken() as any).raw;
  let sub: any = null;
  const dustOf = (s: any) => { try { return BigInt(s?.dust?.balance(new Date()) ?? 0n); } catch { return 0n; } };

  /* ------------------------------------------------------------- M-40 / dust cache
   *
   * The dust sub-wallet has no persistence. Every start replays the chain from
   * genesis to rebuild its own state, which measured 284s on the last three
   * runs. The DUST is already on chain and already registered; the wallet
   * simply cannot see it until it has caught up. That is a five minute tax on
   * every single experiment and it has nothing to do with what we are debugging.
   *
   * `DustWallet(config).restore(serialized)` exists. `WalletFactory` does not
   * expose it — `createDustWallet` only ever calls `startWithSeed` — so the
   * wallet is built the normal way and its dust sub-wallet is swapped for a
   * restored one before `start()`. `facade.dust` is a plain public field.
   *
   * NOT TESTED END TO END, and it cannot be without a route to the preview
   * network. So it is built to fail cheaply instead. Any throw
   * anywhere in the restore falls back to a normal wallet, and if a restored
   * wallet has not produced a DUST balance within 2 minutes the cache is
   * deleted and the wallet is rebuilt from scratch in the same run. Worst case
   * costs 2 minutes once; best case saves 4-5 minutes on every run after this.
   */
  /*
   * Bring-up lives in `scripts/wallet-bringup.ts` now.
   *
   * This block was the original, and it was correct. The problem was that
   * `sponsor-test.ts` was written from memory of it rather than from it, and
   * ended up missing `wallet.start(false)` — so its wallets never synced, and
   * three runs went into diagnosing one absent line.
   *
   * Everything that made this version worth keeping moved across intact: the
   * cache-invalidation retry (a stale cache looks exactly like a slow network),
   * the two different deadlines, and waiting on DUST rather than on sync
   * progress. It is under test now, which this never was.
   */
  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, {
    withDust: true,
    requireDust: true,
    onNote: note,
  });
  const wallet: any = live.wallet;
  /*
   * `live.state()` stays LIVE, and that is not incidental.
   *
   * The first version of this swap wrote `live.state() = live.state()` — a snapshot
   * — and everything downstream kept reading it: the DUST accrual wait, the
   * sync report, and the per-call "wallet sync at this moment" line. All three
   * would have frozen at the value they held the instant the wallet came up,
   * and the DUST wait would have spun until it timed out no matter how much
   * DUST arrived. A getter keeps them reading through to the subscription.
   */
  sub = { unsubscribe: () => live.stop() };

  good(`wallet ready — NIGHT ${live.night()}, DUST ${live.dust()}`);

  /*
   * Enough DUST for EVERY circuit a full run submits, not just enough to be
   * non-zero. The number is the enumeration below and nothing else.
   *
   * **THE HEADING SAID NINE AND THE GATE SAID ELEVEN, AND THEY HAD DISAGREED
   * SINCE BEFORE THIS ROUND.** `S35d`, rule 14: this is a sentence claiming
   * what a check covers, so it is corrected where it is written rather than
   * left for whoever next reads the two together. The count now lives in one
   * place — the enumeration beside `CIRCUITS` — and this paragraph names no
   * figure of its own.
   *
   * The deploy learned this the hard way: `dust > 0` passed at 1.1e16 on
   * a young Stagenet and the transaction then died inside the coin selector
   * with "Insufficient Funds: could not balance dust". This script does far
   * more work than the deploy — a dozen circuits rather than one — so it is
   * strictly more exposed, and it was still using the old gate.
   *
   * Measured on Stagenet, ledger 9: a single circuit costs 7.5e13 to 4.6e14,
   * so a full run is on the order of 3e15. Ledger 8 on preview quoted 0 and 1
   * for the same operations, which is exactly why this cannot be
   * a constant — it is measured per chain via `estimateRegistration`, the only
   * fee number the SDK will tell you without building a transaction first.
   *
   * Non-fatal. If the wait times out it says so and proceeds, because a run
   * that refuses to start teaches nothing and DUST keeps accruing anyway.
   */
  {
    /*
     * Every transaction a full run against a fresh deploy submits.
     * Thirteen, counted off the call sites: the approved add of B (propose, one
     * approve, amendSigner), then the approved add of C (propose, two approves,
     * amendSigner), the payment round (propose, two approves), and the job
     * section's propose, approve and cancel.
     *
     * IT WAS ELEVEN, AND SEATING B IS WHY IT MOVED. `S35d` shut the bootstrap
     * window by construction (`docs/company-accounts.md` section 10a), so B's
     * single `amendSigner` became three transactions, for ever. IT WAS FOURTEEN
     * BEFORE THAT: two credits and a settlement went with the balance ledger
     *. Revised rather than left generous, because the number IS
     * the enumeration — under-counting makes this gate pass and then run out of
     * DUST partway through, the failure it exists to prevent.
     *
     * **HAND-COUNTED DELIBERATELY — `T-344`, `SC13` §4 `F5`.**
     * `src/midnight/run-cost.ts` DERIVES a count and is called by nothing,
     * which looks like a missed wiring. It is not: `circuitsForRun` models ONE
     * payroll run with no term for `amendSigner` or `cancel`, so no input
     * yields this scripted walk. Its own file carries the reciprocal.
     */
    const CIRCUITS = 13;
    const nightUtxos = (live.state()?.unshielded?.availableCoins ?? []).filter((c: any) => c.utxo?.type === NIGHT);
    let target = 0n;
    try {
      const est = await wallet.wallet.estimateRegistration(nightUtxos);
      const per = BigInt(est.fee);
      // Four circuits' worth of headroom on top: the fee varies by circuit, and
      // an interrupted earlier run leaves proposals this one cancels before it
      // starts — one proof each, and they are not in the count above.
      target = per * BigInt(CIRCUITS + 4);
      good(
        `a transaction costs about ${per} here — ${CIRCUITS} circuits plus headroom for a few ` +
          `tidy-up cancels needs ${target}`,
      );
    } catch (e: any) {
      note(`  could not estimate the fee (${String(e?.message ?? e).slice(0, 90)}); not gating on it`);
    }

    if (target > 0n && dustOf(live.state()) < target) {
      note(`  ${dustOf(live.state())} is short of that — waiting for DUST to accrue`);
      try {
        await wallet.wallet.waitForGeneratedDust(nightUtxos, target, { timeoutMs: 10 * 60_000 });
        good(`DUST now ${dustOf(live.state())}`);
      } catch (e: any) {
        note(`  \x1b[33mstill short: ${String(e?.message ?? e).slice(0, 110)}\x1b[0m`);
        note('  \x1b[33mgoing ahead — if a circuit fails with "could not balance dust",');
        note('  that is why, and the answer is to wait and run again\x1b[0m');
      }
    }
  }

  // Cached immediately, not at the end: a run that later stalls on M-46 must
  // still leave a usable cache behind, or the next experiment pays the sync again.
  {
    const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
    if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB) — the next run skips the long sync`);
  }

  /* ------------------------------------------------- is the wallet actually synced?
   *
   * DUST > 0 was never the right gate. It says the dust sub-wallet has caught
   * up far enough to see a balance; it says nothing about the shielded and
   * unshielded sub-wallets, and balancing needs those to pick coins.
   *
   * We start the wallet with `start(false)` to skip the testkit's own sync gate
   * (M-22, which never completed). That workaround is the leading suspect for
   * the balancing stall: we told the wallet not to finish syncing and then
   * asked it to balance a transaction. This measures whether it ever does
   * finish, on a bound, and prints the answer either way.
   *
   * Deliberately NOT fatal. If it does not converge we still proceed, because
   * "it balanced anyway" and "it hung again" are both useful, and a hard stop
   * here would tell us neither.
   */
  {
    // One dump of the real shape. `progressOf` guesses where each sub-wallet
    // keeps its progress and only ever finds the unshielded one, so
    // every sync number for dust and shielded has been `?/?` for the whole
    // session. This prints the truth once and ends the guessing.
    const shapeOf = (o: any) => { try { return Object.keys(o ?? {}).join(', ') || '(none)'; } catch { return '(unreadable)'; } };
    note(`  wallet state keys: ${shapeOf(live.state())}`);
    for (const k of ['unshielded', 'shielded', 'dust'] as const) {
      note(`    ${k}: ${shapeOf(live.state()?.[k])}`);
      if (live.state()?.[k]?.state) note(`    ${k}.state: ${shapeOf(live.state()[k].state)}`);
    }

    /** Every progress object we can actually find, with a name. */
    const progresses = (st: any): Array<[string, any]> => {
      const out: Array<[string, any]> = [];
      const push = (name: string, p: any) => { if (p && typeof p === 'object') out.push([name, p]); };
      push('unshielded', st?.unshielded?.progress ?? st?.unshielded?.state?.progress);
      push('shielded', st?.shielded?.state?.progress ?? st?.shielded?.progress);
      push('dust', st?.dust?.state?.progress ?? st?.dust?.progress);
      return out;
    };
    const complete = (p: any): boolean => {
      // Within a small gap, not strictly equal. Preview produces blocks the
      // whole time, so demanding appliedIndex === highestIndex is demanding the
      // wallet outrun the chain: the shielded sub-wallet sat at "not complete"
      // for 63s and would have sat there forever.
      try { if (typeof p.isCompleteWithin === 'function') return !!p.isCompleteWithin(10n); } catch { /* fall through */ }
      try { if (typeof p.isStrictlyComplete === 'function') return !!p.isStrictlyComplete(); } catch { /* fall through */ }
      const a = p?.appliedIndex ?? p?.appliedId;
      const h = p?.highestRelevantIndex ?? p?.highestIndex ?? p?.highestTransactionId;
      if (a == null || h == null) return false;
      return BigInt(a) + 10n >= BigInt(h);
    };

    // Advisory, not a gate: it reports and moves on. 60s is plenty to tell
    // "caught up" from "not catching up", and waiting longer buys nothing.
    const SYNC_BOUND_MS = 60_000;
    const syncStart = Date.now();
    let printed = 0;
    let all = false;
    for (;;) {
      const found = progresses(live.state());
      all = found.length > 0 && found.every(([, p]) => complete(p));
      if (all) break;
      const elapsed = Date.now() - syncStart;
      if (elapsed > SYNC_BOUND_MS) break;
      if (elapsed - printed >= 10_000) {
        printed = elapsed;
        note(`  ${String(Math.round(elapsed / 1000)).padStart(3)}s  ${progressOf(live.state())}`);
      }
      await sleep(1000);
    }
    const took = Math.round((Date.now() - syncStart) / 1000);
    if (all) good(`every sub-wallet reports fully synced after a further ${took}s — ${progressOf(live.state())}`);
    else note(`  \x1b[33mnot fully synced after ${took}s: ${progressOf(live.state())} — continuing anyway, on purpose\x1b[0m`);
  }

  /* -------------------------------------------------- 3 */
  begin(3, 7, 'Finding the contract and reading its state');

  const rawZkConfigProvider = new NodeZkConfigProvider<string>(ARTIFACTS);
  const zkConfigProvider = timed(rawZkConfigProvider, {
    getProverKey: PH.readKey, getVerifierKey: PH.readKey, getZKIR: PH.readKey,
    get: PH.readKey, getVerifierKeys: PH.readKey,
  } as any);
  /*
   * Proving in this process, behind a flag.
   *
   * Decision 0007 rules out a hosted proof server: the preimage IS the private
   * input. So the customer's device has to prove, and for a web product that
   * device is a browser tab. `@midnight-ntwrk/zkir-v2` ships the prover as WASM
   * with a browser entry point, and `provingProvider` returns the same shape
   * `createProofProvider` already consumes here.
   *
   * Behind a flag, and defaulting OFF, because the containerised path is proven
   * eleven circuits deep and this one has never settled a transaction. The
   * experiment is worth running; making it the default before it has run is
   * how a working path gets lost.
   *
   * `MIDNIGHT_WASM_PROVING=1`, and stop the proof server first — if it settles
   * with no container running, browser proving is real.
   */
  const rawProofProvider = process.env.MIDNIGHT_WASM_PROVING === '1'
    ? await (async () => {
        const { wasmProofProvider, fileKeyMaterialSource } = await import('../src/midnight/wasm-proving.js');
        note('proving IN PROCESS via zkir WASM — no proof server (M-77)');
        return wasmProofProvider(await fileKeyMaterialSource(ARTIFACTS, join(STATE_DIR, 'params')));
      })()
    : httpClientProofProvider(cfg.proofServer, rawZkConfigProvider);

  const providers: any = {
    zkConfigProvider,
    proofProvider: timed(rawProofProvider as any,
      { proveTx: PH.prove, check: PH.prove, prove: PH.prove } as any),
    // Wrapped like the rest. Leaving this one bare is why five runs reported
    // the stall as the ambient "building the transaction" phase: a hang in
    // here was indistinguishable from a hang in the SDK's own code.
    privateStateProvider: timed(levelPrivateStateProvider({
      accountId: PRIVATE_STATE_ID,
      privateStateStoreName: PRIVATE_STATE_ID,
      privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
    } as any) as any, {
      get: PH.privateState, set: PH.privateState, remove: PH.privateState,
      clear: PH.privateState, getSigningKey: PH.privateState, setSigningKey: PH.privateState,
      setContractAddress: PH.privateState,
    } as any),
    publicDataProvider: timed(indexerPublicDataProvider(cfg.indexer, cfg.indexerWS) as any,
      { queryContractState: PH.queryState, watchForTxData: PH.confirm, watchForContractState: PH.confirm,
        queryZSwapAndContractState: PH.queryState, queryDeployContractState: PH.queryState } as any),
    // The wallet gets instrumented too. `submitTx` does three things — prove,
    // balance, submit — and labelling the whole call `prove` hid the other two
    // for four runs. Proving is measured at 1.4s; balancing is the suspect,
    // and it is the job we handed to a wallet we told not to finish syncing.
    walletProvider: timed({
      balanceTx: async (tx: any, ttl?: Date) => {
        // Wrapped in try/catch on purpose: instrumentation must never be the
        // reason a call fails. The previous version threw a ReferenceError
        // here and killed three attempts before reaching the real balanceTx.
        try {
          note(`  balancing — wallet sync at this moment: ${live.state() ? progressOf(live.state()) : 'unknown'}`);
        } catch { /* reporting is not worth failing the call over */ }

        // Do by hand exactly what testkit's balanceTx does, so each of its
        // three steps gets its own phase code and its own number. Copied from
        // the installed testkit-js, not from the GitHub repo, which is ahead
        // of what npm publishes.
        
        // If any field it needs is missing — a version bump renames one, say —
        // fall straight back to the SDK's own method rather than failing.
        const inner = wallet.wallet;
        const zk = wallet.zswapSecretKeys;
        const dk = wallet.dustSecretKey;
        const ks = wallet.unshieldedKeystore;
        if (!inner?.balanceUnboundTransaction || !zk || !dk || !ks?.signDataAsync) {
          note('  (using the SDK balanceTx: the decomposed path is not available on this build)');
          return wallet.balanceTx(tx, ttl);
        }

        const deadline = ttl ?? new Date(Date.now() + 60 * 60_000);
        const at = Date.now();
        const lap = (what: string) => note(`    ${what} in ${((Date.now() - at) / 1000).toFixed(1)}s`);

        setAmbient(PH.balanceUnbound);
        const recipe = await inner.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys: zk, dustSecretKey: dk },
          { ttl: deadline },
        );
        lap('balanceUnboundTransaction');

        setAmbient(PH.signRecipe);
        // signDataAsync: the callback is async in wallet-sdk 2.0. See deploy-preview.ts.
        const signed = await inner.signRecipe(recipe, (payload: any) => ks.signDataAsync(payload));
        lap('signRecipe');

        setAmbient(PH.finalizeRecipe);
        const done = await inner.finalizeRecipe(signed);
        lap('finalizeRecipe');

        setAmbient(PH.balance);
        return done;
      },
      getCoinPublicKey: () => wallet.getCoinPublicKey(),
      getEncryptionPublicKey: () => wallet.getEncryptionPublicKey(),
    } as any, { balanceTx: PH.balance } as any),
    midnightProvider: timed({ submitTx: (tx: any) => wallet.submitTx(tx) } as any, { submitTx: PH.submit } as any),
  };

  // Required before any private state get/set, and it throws unhelpfully if
  // skipped. Not optional just because it looks like bookkeeping.
  providers.privateStateProvider.setContractAddress?.(contractAddress);

  /**
   * The change the round in flight is for.
   *
   * `asset` is part of it since M-125, and it is not decoration: `propose`
   * derives the key from the caller's `assetId` witness and binds it inside the
   * change commitment, so what the signers approve says which asset it is in.
   * It used to be checked at BOTH ends of a round; the far end was the
   * settlement, and that went with the balance ledger, so the
   * binding is made once, at the end that still exists. Governance rounds move
   * no money and carry the reserved `NONE`.
   */
  let pendingChange: { asset: AssetId; amount: bigint; batch: Uint8Array; salt: Uint8Array } = {
    asset: ASSET.code,
    amount: 0n,
    batch: CHANGE_BATCH,
    salt: PAYMENT_SALT,
  };

  /**
   * What the chain calls the proposal in flight: `commit(payloadHash, salt)`.
   *
   * COMPUTED HERE, BEFORE ANYTHING IS SUBMITTED. Every call that spends
   * a proposal names which one, and a signer's device needs the id to approve —
   * so it has to be derivable without a round trip, which is why the contract
   * exports `proposalIdOf` rather than writing the commitment inline.
   */
  const proposalIdFor = (payloadHash: Uint8Array, salt = pendingChange.salt) =>
    pureCircuits.proposalIdOf(payloadHash, pureCircuits.noVault(), salt);

  /*
   * A STATE-STAGING HELPER STOOD HERE and is gone.
   *
   * It computed the balance a call would land on — what the account holds now,
   * less the change in flight, plus anything credited — and the salt that
   * balance would be committed under, and `becomeSigner` staged the pair as the
   * caller's `next` view. There is no balance for a call to land on any more,
   * so there is nothing to compute and nothing to stage.
   *
   * ITS SALT NOTE IS WORTH KEEPING FOR WHOEVER WRITES THE NEXT ONE. The salt
   * was derived from the resulting balance rather than drawn at random, so an
   * interrupted run could be recovered by hand from the arithmetic — at the
   * price that two states holding the SAME balance committed to the same value,
   * which tells an observer the account has returned to a figure it held
   * before. That trade was accepted here and nowhere else, on a test network
   * with a seeded signing key. Anything that commits to a balance in the
   * product draws a fresh salt per write.
   */

  /** Swaps whose device we are pretending to be for the next circuit call. */
  const becomeSigner = async (
    s: AccountPrivateState,
    name: string,
  ) => {
    await providers.privateStateProvider.set(PRIVATE_STATE_KEY, {
      ...s,
      /*
       * THE ASSET, STAGED PER CALL.
       *
       * `assetId` says which asset this call concerns and `assetBlinding` is
       * the account-level value that turns it into the key the change
       * commitment names. Both are read by the circuit as witnesses — there is
       * no argument to pass them in — so forgetting either does not fail, it
       * proves against whatever was left from the last call, which means the
       * account collects an approval for a change nobody meant to approve.
       *
       * IT MEANT WRITING TO AN ENTRY NO SIGNER COULD SPEND FROM, when there
       * were entries. The on-chain balance map went with `C292`/`S26`; the
       * staging discipline did not, because `propose` still binds this key.
       */
      assetId: assetIdBytes(pendingChange.asset),
      assetBlinding: accountView.assetBlinding,
      proposalSalt: pendingChange.salt,
      changeAmount: pendingChange.amount,
      changeBatchDigest: pendingChange.batch,
    });
    note(`acting as signer ${name}`);
  };

  /* ------------------------------------------------------------------ *
   * reading the account
   *
   * Three small readers over the public state, because M-125 and M-128 turned
   * scalar fields into maps and every question this script used to ask of a
   * field is now a question about one entry in one of them.
   *
   * A FOURTH READ THE ACCOUNT'S ASSETS — every entry in the on-chain balance
   * map, as opaque keys, sorted, because only the count was ever public. The
   * map went with the balance ledger and the reader went with
   * it. What it was for survives in the three below: the account still answers
   * questions about itself, and every one of them is now about a proposal.
   *
   * They mirror `MidnightLedger.readContractState` on purpose and are sorted
   * for the same reason it sorts: a map's iteration order is not a promise, and
   * anything that gets compared has to be stable.
   * ------------------------------------------------------------------ */

  /** Every proposal open at once, not "the" open one. */
  const openProposalsOf = (l: any): Array<{ id: string; change: string; approvals: number }> =>
    [...l.openProposals]
      .map(([id, change]: [Uint8Array, Uint8Array]) => ({
        id: hex(id), change: hex(change), approvals: Number(l.approvalCounts.lookup(id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

  /**
   * Is this proposal open? BY ID, and BY PRESENCE.
   *
   * The contract removes a proposal when it settles or is cancelled rather than
   * zeroing a flag beside it, so presence is the whole answer — where the old
   * shape had to read `proposalOpen` and a commitment and hope they agreed.
   */
  const isOpen = (l: any, id: Uint8Array): boolean =>
    openProposalsOf(l).some(p => p.id === hex(id));

  /**
   * How many approvals THAT proposal has. Zero once it is gone.
   *
   * Read off the list rather than by looking the id up directly, because
   * `lookup` on a key a map does not hold is an error rather than a zero, and
   * "the proposal has settled" is a perfectly ordinary thing to be asking about.
   */
  const approvalsFor = (l: any, id: Uint8Array): number =>
    openProposalsOf(l).find(p => p.id === hex(id))?.approvals ?? 0;

  /*
   * TWO BALANCE READERS AND THE CREDIT STEP STOOD HERE.
   *
   * One read the commitment the chain held for the asset this run moves, and
   * answered null when the account had never held it — an asset never held was
   * ABSENT from the map rather than zero, because "holds none" and "has never
   * held" are the same fact. The other recomputed that commitment from the
   * balance this device believed in, using the contract's own pure circuit, so
   * the two could be compared. The third recorded value arriving, with no
   * approval round at all, because nobody needs permission to be paid,
   * and it was how an asset first appeared on an account.
   *
   * All three read or wrote a book the account does not keep. What they were
   * for is not replaced here, and this script must not pretend otherwise: there
   * is no circuit on this contract that moves value, so there is nothing for a
   * run to fund and nothing for it to check afterwards. The exercise that
   * survives is the approval itself, below.
   */

  await becomeSigner(signerA, 'A');

  /*
   * The PARTIAL find, since S8c: the deployment was a subset of the compiled
   * circuits, and the SDK's `findDeployedContract` refuses that shape outright
   * (it compares every compiled key). This verifies the deployed keys
   * byte-for-byte and checks the deferred circuits are absent — the second
   * check is inert since S25 emptied the deferred list. It does NOT follow that
   * every circuit this run drives is deployed — the deployed set and the list
   * this script keeps are maintained apart, which is what the refusal at the
   * top of `main` exists for, and it fired on `credit` until `S26` removed the
   * calls. `attestSolvency` was shed by S23 and is no longer a name anything
   * here can call; `retireVault` is DEPLOYED now, which is what closes C288.
   */
  const { findDeployedPartialContract } = await import('../src/midnight/partial-contract.js');
  const found: any = await findDeployedPartialContract(providers, {
    compiledContract: compiled,
    contractAddress,
    privateStateId: PRIVATE_STATE_KEY,
  });
  good('found on chain, the deployed verifier keys match, the deferred circuits are absent');

  const readState = async () => {
    const st = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!st) throw new Error('the indexer has no state for this contract');
    return readLedger(st.data);
  };

  /*
   * WHAT THIS PRINTS, and what it no longer can.
   *
   *   round             gone. It scoped approval nullifiers, which is what
   *                     limited an account to one proposal at a time.
   *   proposalOpen      gone. `openProposals` is a map, so the question is how
   *                     many, and which.
   *   approvals         no longer an account-wide number. Counted per proposal,
   *                     so it is printed against each one.
   *   stateCommitment   gone. There was no single value standing for the whole
   *                     shielded state once M-125 split it per asset, and there
   *                     is no per-asset one either since `C292`/`S26`.
   *
   *   assets held       gone with them. It counted the entries in the on-chain
   *                     balance map, which the account no longer keeps.
   *
   *   the balance line  gone. It printed the ONE asset this run moved and named
   *                     which asset that was. Nothing here commits to a
   *                     balance now, and a line standing where it stood would
   *                     be read as one that does.
   *
   * `movements` STAYS, and is the one count on this line that still describes
   * money: it is the append-only set of what a vault has been recorded as
   * paying, and no circuit this script calls writes to it.
   */
  const show = (l: any, label: string) => {
    console.log(`  \x1b[1m${label}\x1b[0m`);
    console.log(
      `    threshold ${l.threshold}   signers ${l.signerLeaves.size()}   ` +
        `movements ${l.movements.size()}`,
    );
    const open = openProposalsOf(l);
    if (open.length === 0) console.log('    no open proposals');
    for (const p of open) {
      console.log(`    proposal ${p.id.slice(0, 24)}…  ${p.approvals} of ${l.threshold} approvals`);
    }
  };

  let before = await readState();
  show(before, 'before');

  /* -------------------------------------------------- 4 */
  begin(4, 7, 'Making sure there are two signers and no stale proposal');

  const timings: Array<[string, number]> = [];
  const callCircuit = async (
    name: string,
    fn: () => Promise<any>,
    landed?: () => Promise<boolean>,
    attempts = 3,
  ) => {
    const started = Date.now();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const t = Date.now();
      currentStepName = name;
      watchdog.postMessage({ label: name });
      beginStep();
      setAmbient(PH.build);
      try {
        // No Promise.race here, deliberately. A race needs a tick to resolve,
        // and the failure this is guarding against is the loop not ticking.
        // The watchdog thread is what bounds this call now.
        const res = await fn();
        endStep();
        const secs = (Date.now() - t) / 1000;
        timings.push([name, secs]);
        good(`${name} settled in ${secs.toFixed(1)}s`);
        return res;
      } catch (e: any) {
        endStep();
        note(`${name} failed on attempt ${attempt} of ${attempts}: ${String(e?.message ?? e).split('\n')[0]}`);
        // Ask the chain rather than assuming. The transaction may well have
        // landed while we stopped listening.
        if (landed) {
          try {
            if (await landed()) {
              const secs = (Date.now() - started) / 1000;
              timings.push([name, secs]);
              good(`${name} actually landed on chain despite the error (${secs.toFixed(1)}s)`);
              return undefined;
            }
            note(`  checked the chain: ${name} did not take effect, so retrying is safe`);
          } catch { /* fall through to the retry */ }
        }
        if (attempt === attempts) throw e;
        await sleep(5000 * attempt);
      }
    }
  };

  /** Kept for the non-circuit paths. */
  const call = callCircuit;

  /* -------------------------------------------------- 3b, and only on request
   *
   * The governance run: remove a signer, reuse the slot, move the threshold.
   *
   *
   * It branches HERE, after the contract is found and before the spending path
   * begins, and returns rather than falling through. Everything above this line
   * — wallet, dust, providers, the watchdog — is what those steps need and is
   * already proven working; everything below proves a different thing and would
   * be ten minutes of proving in the way.
   *
   * Off by default. `GOVERNANCE-RUN.command` sets the variable.
   */
  if (process.env.MIDNIGHT_GOVERNANCE_RUN === '1') {
    begin(4, 4, 'Removing a signer, reusing the slot, moving the threshold');
    /*
     * THE WARNING THAT USED TO BE HERE IS GONE BECAUSE IT IS NO LONGER TRUE,
     * and it is worth a line rather than a silent deletion.
     *
     * `scripts/governance-steps.ts` had not been ported to the post-M-128
     * circuits: it called `approve()`, `cancel()` and `propose()` as though
     * there were one open proposal to act on, and read `round`, `proposalOpen`
     * and `approvalCount` off a ledger that no longer had them. It compiled
     * only because its context typed those reads as `any` — ten wrong call
     * sites and zero compile errors, which is M-42's lesson in disguise.
     *
     * It is ported, the `any` is gone, and the compiler can see it now. **A
     * stale warning is its own defect**: left here it would tell whoever runs
     * GOVERNANCE-RUN that a working step is broken, which is exactly the kind
     * of thing that gets a real warning ignored later.
     */
    // Governance rounds move no money, so they carry the reserved "no asset"
    // rather than a real one — see NO_ASSET in src/core/assets.ts. Picking a
    // real code would put a lie in the ledger a client could read as "this
    // round concerns pounds".
    pendingChange = { ...pendingChange, asset: NO_ASSET, amount: 0n };
    const { runGovernanceSteps } = await import('./governance-steps.js');
    await runGovernanceSteps({
      found, readState, callCircuit, becomeSigner,
      // The salt the next `propose` commits under. The governance calls
      // recompute that commitment from the CALLER'S private state, so the two
      // have to agree or the round reaches its threshold and is then refused.
      setProposalSalt: (salt: Uint8Array) => { pendingChange = { ...pendingChange, salt }; },
      seededBytes, freshSalt, note, good,
      signers: { A: signerA, B: signerB, C: signerC, D: signerD, E: signerE },
    });
    await env.shutdown(false);
    return;
  }


  /*
   * Clearing out anything an earlier run left open.
   *
   * This used to be one `if (before.proposalOpen)`, because an account could
   * hold exactly one proposal and a stale one would make the next `propose`
   * fail. An account holds as many as have been raised now, so this cancels
   * EACH of them by id — and cancelling one leaves every other proposal on the
   * account exactly as it was, which is the whole of M-128 and is why this is
   * a loop rather than a single blind call.
   *
   * WHY IT IS STILL DONE, now that the reason it was written has gone.
   *
   * The old justification was that this run re-proposed the same payload under
   * the same salt every time, so a leftover proposal held the id this run needed
   * and `propose` would refuse it. Salts are fresh per run now, so no leftover
   * can ever collide with anything raised below.
   *
   * It stays because an interrupted run leaves proposals nothing will ever
   * spend, and an account accumulating them makes every later reading of the
   * chain harder to follow — and because a proposal left open is a proposal
   * somebody could still approve to the threshold. Housekeeping,
   * not a precondition. Each cancel costs a proof, which is why the DUST gate
   * above budgets for a few of them.
   */
  const stale = openProposalsOf(before);
  if (stale.length) {
    note(`${stale.length} proposal(s) left open by an earlier run; cancelling each by id`);
    for (const p of stale) {
      await becomeSigner(signerA, 'A');
      const id = Uint8Array.from(Buffer.from(p.id, 'hex'));
      await callCircuit(`cancel ${p.id.slice(0, 12)}…`, () => found.callTx.cancel(id),
        async () => !isOpen(await readState(), id));
    }
    before = await readState();
  }

  /*
   * WHICHEVER SECOND SIGNER IS ACTUALLY SEATED, rather than B by name.
   *
   * This script used to insist on B, and bootstrap-add them when absent. That
   * was correct on an account nothing else had touched, and it stopped being
   * correct the moment `GOVERNANCE-RUN.command` existed: that run REMOVES B on
   * purpose — proving a removal clears the right slot is most of what it is for
   * — and seats D and E in their place.
   *
   * So this script arrived at an account with four perfectly good signers,
   * decided the one it wanted was missing, and tried to seat them through the
   * bootstrap window. The contract refused, exactly as designed. The failure
   * read as `there is no open proposal with that id`, which is true and says
   * nothing about the cause.
   *
   * A run that only works on an account no other run has touched is a test of
   * a fresh deployment, not of the product. It now uses whoever is there.
   *
   * **AND THE WINDOW IT FELL INTO IS SHUT ON EVERY ACCOUNT NOW, FROM BIRTH.**
   * `S35d`, `C340` + `C343`, ruled by the founder on 2 Sep. The constructor
   * takes no threshold any more: it seats one signer and sets `threshold = 1`,
   * so `signerLeaves.size() < threshold` — the condition the free branch
   * needs — is false at creation, and the only other writers of those two
   * quantities each assert it stays that way. The proof is four lines of
   * `grep` and it is written out in the contract beside `threshold = 1`; the
   * consequence is `docs/company-accounts.md` section 10a.
   *
   * SO THE SENTENCE ABOVE ABOUT AN ACCOUNT BEING "LIVE" NO LONGER PICKS
   * ANYTHING OUT. The same refusal now meets a bare seat on a FRESH deployment,
   * which is why the block below proposes B rather than seating them, and why
   * the refusal underneath is about the THRESHOLD rather than about the window.
   */
  const secondCandidates: [string, AccountPrivateState][] =
    [['B', signerB], ['C', signerC], ['D', signerD], ['E', signerE]];
  const seatedAlready = secondCandidates.filter(
    ([, who]) => !!before.signers.findPathForLeaf(leafOf(who)));

  let second = signerB;
  let secondName = 'B';
  if (seatedAlready.length) {
    [secondName, second] = seatedAlready[0];
    good(`using signer ${secondName} as the second approver — already seated on this account`);
  } else if (Number(before.threshold) > 1) {
    /*
     * THE REFUSAL IS ABOUT THE THRESHOLD, NOT THE WINDOW.
     *
     * It used to fire on `signerLeaves.size() >= threshold` and say the
     * bootstrap window was closed. That condition is TRUE OF EVERY ACCOUNT
     * NOW — it holds from the constructor onward — so it would refuse the fresh
     * deployment this script is meant to run against, and it named a cause that
     * no longer distinguishes one account from another.
     *
     * What actually stops a run is arithmetic. Seating B is an approved
     * proposal like any other; `requireApproved` wants `threshold` approvals;
     * `approve` burns one nullifier per signer per proposal, so signer A can
     * contribute exactly one, ever. This branch is the one where none of B, C,
     * D or E is seated, so above a threshold of one there is nobody left whose
     * material this machine holds.
     */
    throw new Error(
      `this account has a threshold of ${before.threshold}, and none of the signers this script ` +
      'knows about (B, C, D, E) is seated on it.\n' +
      '    Seating one is an approved proposal like any other — the bootstrap window that used to ' +
      'take the first few has been shut by construction since S35d — and signer A can approve it ' +
      'once, so a threshold above one cannot be reached from here. Deploy a fresh account ' +
      '(DEPLOY-PREVIEW.command) and run this again.',
    );
  }

  if (!seatedAlready.length) {
    /*
     * SEATING B, THROUGH THE ONLY PATH THERE IS.
     *
     * This was ONE call — `amendSigner(leaf, ZERO_32, false, false)` — straight
     * through the bootstrap window, and it would now be refused on a real chain
     * after a real fee and real proving time, with `there is no open proposal
     * with that id`. It is propose → approve → amendSigner instead, the same
     * three steps C takes below.
     *
     * The window is shut by CONSTRUCTION, not by this account having grown:
     * `S35d` deleted the constructor's threshold argument (`C340` + `C343`), so
     * every account is founded with one signer and `threshold = 1` and
     * `signerLeaves.size() < threshold` is false from birth and cannot become
     * true. The proof is written out in the contract beside `threshold = 1`;
     * what it costs — three transactions where there was one, for ever — is
     * `docs/company-accounts.md` section 10a, ruled by the founder on 2 Sep.
     *
     * **ONE APPROVAL, AND THE NUMBER IS READ OFF THE CHAIN RATHER THAN
     * ASSUMED.** `requireApproved` asserts `!(approvalCounts.lookup(id) <
     * threshold)`; the constructor sets `threshold = 1` and `setThreshold` is
     * the only thing that moves it, so a fresh account needs exactly one. One
     * is also all that is available: this branch is the one where none of B, C,
     * D or E is seated, so A is the only signer who can approve, and `approve`
     * burns a nullifier per signer per proposal — A cannot approve twice. The
     * check above has already refused a threshold higher than one; the assert
     * below refuses it again against what the chain actually counted, rather
     * than against this paragraph.
     */
    const approvalsNeeded = Number(before.threshold);
    note('signer B is not in the tree yet, and there is no bootstrap window to seat them through');
    note(`this account's threshold is ${approvalsNeeded}, so B is seated by propose → approve → amendSigner, and signer A's is the one approval it needs`);

    /*
     * The proposal must commit to THIS leaf, via the add-signer domain
     * separator, exactly as C's does below: an approved payroll proposal must
     * not authorise an addition. `amendSigner` recomputes the same id from the
     * caller's `proposalSalt` witness and refuses if it does not match.
     */
    const addBPayload = pureCircuits.signerAddPayload(leafOf(signerB));

    /*
     * A governance round moves no money, so it carries the reserved "no asset"
     * — the reasoning is written out at C's round below and is unchanged here.
     *
     * Its own salt, so this proposal's id cannot collide with C's addition or
     * with the payment round raised further down.
     */
    pendingChange = { asset: NO_ASSET, amount: 0n, batch: seededBytes(602), salt: ADD_B_SALT };

    /*
     * The proposal's id, computed BEFORE it is submitted.
     *
     * `commit(payloadHash, salt)`, from the contract's own circuit. The approve
     * binds its nullifier to it and the `amendSigner` below names it.
     */
    const addBId = proposalIdFor(addBPayload, ADD_B_SALT);
    note(`the add-signer proposal for B is ${hex(addBId).slice(0, 24)}…`);

    await becomeSigner(signerA, 'A');
    await callCircuit('propose (add signer B)',
      () => found.callTx.propose(addBPayload, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
      async () => isOpen(await readState(), addBId));

    await becomeSigner(signerA, 'A');
    // Counted PER PROPOSAL, so "did it land" is "has THIS proposal's count gone
    // up" — an unrelated approval on another proposal must not read as ours.
    const beforeApproveBseat = approvalsFor(await readState(), addBId);
    await callCircuit('approve add B (A)', () => found.callTx.approve(addBId),
      async () => approvalsFor(await readState(), addBId) > beforeApproveBseat);

    /*
     * COUNTED, NOT ASSUMED, AND REFUSED HERE WHERE IT IS FREE. The seat below
     * costs a proof and a fee and `requireApproved` is what would refuse it, so
     * the count is compared against the threshold the chain reports before the
     * transaction is built rather than after it is paid for.
     */
    const readyForB = await readState();
    if (approvalsFor(readyForB, addBId) < Number(readyForB.threshold)) {
      throw new Error(
        `the proposal to seat signer B has ${approvalsFor(readyForB, addBId)} approval(s) and this ` +
        `account requires ${readyForB.threshold}. Signer A is the only signer seated on it, and a ` +
        'signer may approve a proposal once, so nothing here can raise that count.\n' +
        '    Deploy a fresh account (DEPLOY-PREVIEW.command) and run this again.',
      );
    }

    await becomeSigner(signerA, 'A');
    // The landed-check still matters, and WHAT IT PROTECTS AGAINST CHANGED with
    // `S35d`. A retry of this seat is refused on chain now whichever way it is
    // read — the duplicate assert fires, and the approved proposal the first
    // attempt consumed is gone — where the free path it used to take would have
    // put signer B in the tree at two indices. What the check saves today is
    // the fee and the proving time that refusal would cost.
    
    // DECOMPOSED, deliberately. `callTx` is one opaque call and three separate
    // hypotheses about where its six minutes go have now been wrong: the
    // `settled` tree depth, the Merkle path shape, and the Zswap chain state's
    // postBlockUpdate. Each was ruled out by measurement, and each cost a run.
    
    // `createUnprovenCallTx` reproduces with every real input — contract
    // state, Zswap state, ledger parameters — in 161ms elsewhere. So the stall
    // is somewhere else in `callTx`, and the only honest way to find out is to
    // run the steps separately and time each one.
    await callCircuit('amendSigner (seat B, approved)', async () => {
      const { createUnprovenCallTx, submitTx } = await import('@midnight-ntwrk/midnight-js-contracts');

      /*
       * THE FOURTH PLACE A CALL IS BUILT, AND THE ONLY ONE THAT IS A DOOR
       * RATHER THAN THE PRODUCT. It reaches neither the client's call builder
       * nor the find nor the queue, so neither of their refusals is on this
       * path - and the whole argument object below is behind a cast, which is
       * exactly the shape that let a dropped answer through everywhere else.
       */
      refuseACallWithoutItsPrivateState(
        'amendSigner', PRIVATE_STATE_KEY, CIRCUITS_THAT_READ_NO_WITNESS);

      setAmbient(PH.build);
      const t1 = Date.now();
      const unproven: any = await createUnprovenCallTx(providers, {
        compiledContract: compiled,
        circuitId: 'amendSigner',
        contractAddress,
        /*
         * FOUR arguments, and the second one is the whole of this round's
         * change.
         *
         *   leaf              who is being seated
         *   proposal          WHICH approved proposal authorises it. **A REAL
         *                     ID, WHERE THIS PASSED `ZERO_32` UNTIL `S35d`.**
         *                     The zero was the bootstrap window's filler: with
         *                     fewer signers than the threshold the contract did
         *                     not look for a proposal, and the branch that
         *                     reads this was not taken. That state is now
         *                     unreachable on every account from birth — the
         *                     constructor seats one signer and sets
         *                     `threshold = 1`, and the proof is written out
         *                     beside that line, with `docs/company-accounts.md`
         *                     section 10a for what it costs. So the branch IS
         *                     taken, and a zero here buys `there is no open
         *                     proposal with that id` after a real fee and real
         *                     proving time.
         *   intoVacatedSlot   `false` means append into a fresh slot rather
         *                     than reuse one a removal freed. This account has
         *                     never lost anybody, so there is nothing vacated
         *                     to take — and asking for a vacated slot when none
         *                     exists is refused, not silently corrected.
         *   removing          `false`: a seat, not a removal. S11 merged the
         *                     two circuits and this is the discriminator.
         *
         * This call site is `as any` all the way down, so the typechecker
         * cannot see the arity. That is M-107 exactly: the compiler caught the
         * three TYPED call sites when the signature changed and said nothing
         * about the two hidden behind a cast. Which is why the argument list
         * here was checked against contracts/managed/contract/index.d.ts by
         * hand rather than against memory — **and why the ZERO above survived a
         * signature change: no typechecker anywhere can see that this argument
         * is now read.**
         */
        args: [leafOf(signerB), addBId, false, false],
        privateStateId: PRIVATE_STATE_KEY,
      } as any);
      good(`  step 1 — build the unproven transaction: ${((Date.now() - t1) / 1000).toFixed(1)}s`);

      setAmbient(PH.prove);
      const t2 = Date.now();
      // SubmitTxOptions is exactly { unprovenTx, circuitId? } — checked against
      // the installed .d.ts rather than guessed, since guessing the shape of
      // this SDK is what M-16 lost six rounds to.
      const result: any = await submitTx(providers, {
        unprovenTx: unproven.private.unprovenTx,
        circuitId: 'amendSigner',
      } as any);
      good(`  step 2 — prove and submit: ${((Date.now() - t2) / 1000).toFixed(1)}s`);
      setAmbient(PH.build);
      return result;
    }, async () => !!(await readState()).signers.findPathForLeaf(leafOf(signerB)));

    const afterB = await readState();
    if (!afterB.signers.findPathForLeaf(leafOf(signerB))) throw new Error('signer B was not added');
    // Consumed means REMOVED from the map, not a flag cleared beside it. C's
    // block below makes the same check for the same reason, and it is the one
    // that tells an approved seat from the free one this call used to take.
    if (isOpen(afterB, addBId)) throw new Error('the proposal to seat B was not consumed');
    good(
      `signer B added by approval — ${afterB.signerLeaves.size()} signers, and that proposal is ` +
        `gone from the chain (${afterB.openProposals.size()} still open)`,
    );
  } else {
    // NAMED, rather than 'signer B is already a signer', which is what stood
    // here and is false whenever M-143's fallback picked somebody else — a
    // GOVERNANCE-RUN account has B removed and D and E seated.
    good(`signer ${secondName} is already seated, so there is nothing to add here`);
  }

  /*
   * M-37, the half the simulator cannot prove: seating a signer through the
   * approved path, on a real chain, with a second signer voting.
   *
   * **THIS PARAGRAPH SAID SIGNER B WAS SEATED DURING THE BOOTSTRAP WINDOW, AND
   * THERE IS NO SUCH WINDOW ANY MORE.** `S35d`, `C340` + `C343`: the
   * constructor takes no threshold, seats one signer and sets `threshold = 1`,
   * so `signerLeaves.size() < threshold` is false from birth and no writer of
   * either quantity can make it true. The proof is written out in the contract
   * beside `threshold = 1`; what it costs is `docs/company-accounts.md`
   * section 10a. B is seated by an approved proposal above, exactly as C is
   * here.
   *
   * **SO WHAT THIS BLOCK ADDS OVER B'S IS THE SECOND APPROVER, NOT THE PATH.**
   * B's round had one signer on the account to approve it and A supplied it.
   * C's is proposed, approved by A and by whoever is seated second, and only
   * then applied — an addition carrying more than one person's approval, which
   * is the shape the simulator can only assert and this can prove. Eight
   * simulator tests cover the logic; this is the one that costs real proofs and
   * a real ledger.
   *
   * Self-disabling: once C is in the tree, later runs skip it. Otherwise this
   * adds four circuit calls, about ninety seconds, to every run forever.
   */
  const stateForC = await readState();
  if (!stateForC.signers.findPathForLeaf(leafOf(signerC))) {
    note(`signer C is not in the tree (${stateForC.signerLeaves.size()} signers, threshold ${stateForC.threshold})`);
    note('a seat is an approved proposal on every account since S35d, so adding C goes through propose → approve → approve');

    // The proposal must commit to THIS leaf, via the add-signer domain
    // separator. An approved payroll proposal must not authorise an addition.
    const addPayload = pureCircuits.signerAddPayload(leafOf(signerC));

    /*
     * A governance round moves no money, so it carries the reserved "no asset".
     *
     * It still goes through `propose`, and `propose` commits to
     * `changeCommitmentOf(assetKey, amount, batch, salt)` — which needs an
     * asset. Naming a real one would put a claim in the ledger that this round
     * concerns pounds, and `NONE` derives a perfectly valid key that addresses
     * nothing — which used to be a statement about the on-chain balance map,
     * and is now simply true of every key: the account keeps no balances at
     * all.
     *
     * Its own salt, so this proposal's id cannot collide with the payment round
     * raised further down.
     */
    const addSalt = ADD_C_SALT;
    pendingChange = { asset: NO_ASSET, amount: 0n, batch: seededBytes(603), salt: addSalt };

    /*
     * The proposal's id, computed BEFORE it is submitted.
     *
     * `commit(payloadHash, salt)`, from the contract's own circuit. Every call
     * below names it: `approve` binds its nullifier to it, and `addSigner`
     * recomputes it from the caller's `proposalSalt` witness to check that the
     * proposal it was handed really is the one committing to this leaf.
     */
    const addId = proposalIdFor(addPayload, addSalt);
    note(`the add-signer proposal is ${hex(addId).slice(0, 24)}…`);

    await becomeSigner(signerA, 'A');
    await callCircuit('propose (add signer C)', () => found.callTx.propose(addPayload, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
      async () => isOpen(await readState(), addId));

    await becomeSigner(signerA, 'A');
    // Counted PER PROPOSAL now, so "did it land" is "has THIS proposal's count
    // gone up" — an unrelated approval on another proposal must not read as ours.
    const beforeApproveA = approvalsFor(await readState(), addId);
    await callCircuit('approve add (A)', () => found.callTx.approve(addId),
      async () => approvalsFor(await readState(), addId) > beforeApproveA);

    await becomeSigner(second, secondName);
    const beforeApproveB = approvalsFor(await readState(), addId);
    await callCircuit(`approve add (${secondName})`, () => found.callTx.approve(addId),
      async () => approvalsFor(await readState(), addId) > beforeApproveB);

    // Back to A: addSigner reads proposalSalt() from the caller's private
    // state, and the id on chain was made with A's salt. Any signer can apply
    // it, but only one holding the same salt can reproduce the id. That was
    // once the same constraint the settlement circuit had with its next-state
    // witnesses; those went with the balance ledger and the
    // constraint on the salt is unchanged by it.
    await becomeSigner(signerA, 'A');
    // `addId` names which approved proposal authorises this, and `false` takes
    // a fresh slot. See the note on the addSigner above.
    await callCircuit('addSigner C (approved)',
      () => found.callTx.amendSigner(leafOf(signerC), addId, false, false),
      async () => !!(await readState()).signers.findPathForLeaf(leafOf(signerC)));

    const afterAdd = await readState();
    if (!afterAdd.signers.findPathForLeaf(leafOf(signerC))) throw new Error('signer C was not added');
    // Consumed means REMOVED from the map, not a flag cleared beside it.
    if (isOpen(afterAdd, addId)) throw new Error('the add-signer proposal was not consumed');
    good(
      `signer C added by approval — ${afterAdd.signerLeaves.size()} signers, and that proposal is ` +
        `gone from the chain (${afterAdd.openProposals.size()} still open)`,
    );
  } else {
    good('signer C is already a signer');
  }

  /* -------------------------------------------------- 5 */
  begin(5, 7, 'propose → approve → approve');

  /*
   * A VIEW-AGAINST-CHAIN CHECK STOOD HERE, AND IT IS NOT MERELY MOVED. M-73,
   *
   *
   * It compared the balance commitment this device believed in against the one
   * the chain held for this asset, before anything was spent, so that a stale
   * view surfaced here rather than as `failed assert: your view of the account
   * is stale` from inside a proof, after three retries, four minutes of wallet
   * sync and a fee. Both sides of that comparison are gone: the chain holds no
   * balance commitment, and the view file holds no balance to build one from.
   *
   * NOTHING REPLACES IT, and nothing should pretend to. What made it worth
   * having was that a device could be wrong about the account in a way the
   * account would only notice mid-proof. There is nothing left in this file
   * that can be wrong in that way — an asset code and a blinding either match
   * the deployment or fail the very first `propose` — and the mismatch that
   * WOULD matter, the view file describing a different account, is caught by
   * the contract-address check `readViewFile` already makes.
   */

  const payloadHash = seededBytes(777); // stands in for a real payroll payload

  /*
   * THE CREDIT THAT OPENED THIS STAGE IS GONE.
   *
   * Money went in first, and since M-125 that was not merely sensible ordering
   * but the only order that worked: a deployed account held nothing, the first
   * credit of an asset was what created its entry, and a settlement was refused
   * on chain twice over without one. The account keeps no balances now, so
   * there is nothing to fund and no order left to get right.
   *
   * WHAT THE ROUND BELOW IS FOR HAS NOT CHANGED WITH IT. The signers approve a
   * change — this much of this asset — and the chain enforces the threshold
   * over it without learning either. That the change is not then applied by
   * this contract is `C292`'s decision, not an omission of this script's, and
   * the amount below is real: it is bound inside the commitment both approvals
   * are given against.
   */
  const PAYING = 20_000n;

  /*
   * The change this round is for: an amount OF AN ASSET.
   *
   * The asset is part of what the signers approve, and it is bound inside
   * `changeCommitmentOf`. Without it the approved change would say "20,000
   * minor units leave" and not say of what — so an approval to pay pounds would
   * be an approval to move the same integer of anything.
   */
  pendingChange = {
    asset: ASSET.code, amount: PAYING, batch: seededBytes(802), salt: PAYMENT_SALT,
  };

  /*
   * The proposal's id, before it exists on chain.
   *
   * Everything below names it: both approvals bind their nullifiers to it. It
   * is what makes an approval an approval OF SOMETHING rather than a vote on
   * the account, and it is why a second proposal raised in the same run cannot
   * collect the first one's approvals.
   */
  const proposalId = proposalIdFor(payloadHash);
  note(`proposing to pay ${minor(PAYING)} — proposal ${hex(proposalId).slice(0, 24)}…`);

  await becomeSigner(signerA, 'A');
  await callCircuit('propose', () => found.callTx.propose(payloadHash, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
    async () => isOpen(await readState(), proposalId));

  await becomeSigner(signerA, 'A');
  // Counted per proposal, so "did it land" is "has THIS proposal's count gone
  // up" — another proposal being approved in the same minute is not our answer.
  const countBeforeA = approvalsFor(await readState(), proposalId);
  await callCircuit('approve (A)', () => found.callTx.approve(proposalId),
    async () => approvalsFor(await readState(), proposalId) > countBeforeA);

  const midway = await readState();
  note(`this proposal now has ${approvalsFor(midway, proposalId)} of ${midway.threshold} approvals`);
  if (approvalsFor(midway, proposalId) >= Number(midway.threshold)) {
    note('threshold already met with one approval; the second is still worth running');
  }

  /*
   * A DEPOSIT IN THE MIDDLE OF AN OPEN ROUND STOOD HERE. M-71.
   *
   * It was the whole reason the contract binds a change rather than a resulting
   * state. Under the design M-71 replaced, the approved outcome was an absolute
   * balance computed before the deposit existed, so settling would have written
   * that figure back and the money that arrived mid-round would have vanished
   * from the record with nothing to show it ever came. The only safe response
   * was to refuse deposits while a round was open — friction directly on the
   * main path, since companies fund an account and then run payroll.
   *
   * There is no deposit to make now: the account keeps no balance, and the
   * circuit that recorded value arriving is gone. THE PROPERTY M-71 BOUGHT IS
   * NOT DEMONSTRATED ANYWHERE ELSE IN THIS SCRIPT, and saying so is the point
   * of this paragraph — an absent test reads as a risk retired unless somebody
   * writes down that it is not. What the contract still does, binding a change
   * rather than a state, is what would make it hold again the moment anything
   * moves money. Nothing here shows it today.
   */

  await becomeSigner(second, secondName);
  const countBeforeB = approvalsFor(await readState(), proposalId);
  await callCircuit(`approve (${secondName})`, () => found.callTx.approve(proposalId),
    async () => approvalsFor(await readState(), proposalId) > countBeforeB);

  /*
   * THE THRESHOLD IS MET, AND THAT IS WHERE THIS ROUND ENDS.
   *
   * A settlement stood here. It named which proposal it spent, moved the
   * asset's balance commitment, inserted the movement into the audit trail and
   * removed the proposal from the chain — and it was the single point at which
   * the account's books were written. All of it went with the decision.
   *
   * So the proposal is LEFT OPEN, at or above its threshold, and that is the
   * end state rather than a failure: an approved proposal on this contract is
   * an authorisation that nothing yet spends. The stale-proposal sweep in stage
   * 4 is what cancels it, on the next run against this account.
   *
   * The reads below are what is still answerable, and they were the settlement's
   * pre-conditions before they were its result. M-137's lesson governs them
   * either way: a post-condition compared against `before`, read at the top of
   * the run, is satisfied by whatever else the run has already done — so what
   * is claimed here is read at the moment it is claimed.
   */
  const afterApprovals = await readState();
  const approvalsNow = approvalsFor(afterApprovals, proposalId);
  note(`this proposal now has ${approvalsNow} of ${afterApprovals.threshold} approvals`);
  if (approvalsNow < Number(afterApprovals.threshold)) {
    throw new Error(
      `only ${approvalsNow} approvals but the threshold is ${afterApprovals.threshold}; ` +
        'the two signers above did not carry this proposal to its threshold',
    );
  }

  pendingChange = { ...pendingChange, amount: 0n };

  /* -------------------------------------------------- 6 */
  begin(6, 7, 'Checking what the chain now holds');

  const after = await readState();
  show(after, 'after');
  /*
   * `sub.unsubscribe()` USED TO BE HERE, and it calls `live.stop()`.
   *
   * Stage 7 below submits three more transactions — a propose, an approve
   * through the job runner, and a cancel — every one of which balances against
   * this wallet. Stopping it here means the rest of the run works against a
   * wallet that has been told to stop, which fails in ways that name the SDK
   * rather than the cause. It now happens where the deploy script already does
   * it: after the last wallet use, immediately before shutdown.
   */

  const failures: string[] = [];

  /*
   * WHAT IS CHECKED HERE, AND WHAT IS NO LONGER CHECKABLE. M-125, M-128,
   *
   *
   * Every check that stood here read a book the account no longer keeps. The
   * list is written out with what became of each, rather than quietly
   * shortened, because a verification section that gets smaller without saying
   * so reads as a section that had less to prove:
   *
   *   the state commitment changed, then THIS ASSET'S commitment changed
   *       GONE. There is no commitment on chain for any balance, because the
   *       account holds no balance.
   *
   *   the round advanced
   *       GONE with the round itself, long before this.
   *
   *   the proposal is no longer open
   *       INVERTED, and this is the substantive change. Nothing on this
   *       contract spends a proposal, so the claim is now that it IS still
   *       open at its threshold: an authorisation standing, unspent.
   *
   *   no other asset moved
   *       GONE. It was the property M-125 split the commitment for. There are
   *       no per-asset commitments to compare, and nothing this run calls
   *       could move one.
   *
   *   the approved change is in the audit trail
   *       GONE FROM THIS RUN. `movements` is still on the contract and is
   *       still the audit trail, but only `recordPayment` writes to it
   *       (contracts/src/ConfidentialAccount.compact:2663) and nothing here
   *       calls it. A membership test over a set this run never inserts into
   *       would pass on a value some earlier run left and prove nothing.
   *
   *   the proposal is in the tree of settled proposals
   *       GONE with the tree.
   *
   *   the new commitment is the one the scheme predicts
   *       GONE. It ran the contract's own pure circuit over the balance this
   *       device believed it had landed on and compared the result with the
   *       chain — decision 0004's subject, and the bug M-12 was. Neither side
   *       of that comparison exists now.
   *
   *   the arithmetic
   *       GONE, and it is the loss worth naming. It was the part a customer
   *       cares about — that the round ran on the right numbers — and nothing
   *       below stands in for it. This contract moves no numbers.
   */
  if (!isOpen(after, proposalId)) {
    failures.push(
      'the proposal this run approved is no longer open on chain, and nothing this run calls ' +
        'removes one — so something outside this run cancelled or closed it',
    );
  } else if (approvalsFor(after, proposalId) < Number(after.threshold)) {
    failures.push(
      `this proposal is open with ${approvalsFor(after, proposalId)} approval(s) against a ` +
        `threshold of ${after.threshold}, so the approvals above did not hold`,
    );
  }

  console.log();
  if (failures.length) {
    console.log('  \x1b[31m\x1b[1mThe chain did not end up where it should have:\x1b[0m');
    for (const f of failures) console.log(`    • ${f}`);
    throw new Error('post-conditions failed');
  }

  good(
    `the proposal is open on chain with ${approvalsFor(after, proposalId)} of ` +
      `${after.threshold} approvals, and the chain enforced the threshold without learning ` +
      'who approved',
  );
  good(
    'it is left open, because no circuit on this contract spends an approved proposal — ' +
      'the sweep in stage 4 cancels it on the next run',
  );

  console.log();
  console.log('  \x1b[1mProving and settlement time per circuit\x1b[0m  \x1b[2m(M-16)\x1b[0m');
  for (const [name, secs] of timings) {
    // Wider than it was: step names carry a proposal id now, because a call
    // that spends a proposal names which one.
    console.log(`    ${name.padEnd(24)} ${secs.toFixed(1)}s`);
  }

  console.log();
  console.log('\x1b[32m\x1b[1m  A proposal reached its threshold on ' + NETWORK + '.\x1b[0m');
  console.log(`  It authorises ${minor(PAYING)}. The chain counted two approvals`);
  console.log('  without learning who gave them, and neither the amount nor the asset');
  console.log('  it is denominated in ever left the device.');
  console.log('  Nothing spent it. This account keeps no books of its own, so there is');
  console.log('  no settlement circuit for the authorisation to reach (C292).');

  /* -------------------------------------------------- 7 */
  begin(7, 7, 'The same round again, as durable jobs (decision 0008, M-82)');

  /*
   * Everything above proved the CIRCUITS work. This proves the queue does —
   * that an approval can be built and proved as one step, submitted as a
   * separate step, and recovered afterwards by asking the chain rather than by
   * guessing.
   *
   * It runs here, at the end of a run that has already succeeded, deliberately.
   * The wallet, the providers, the contract and the signers are all set up and
   * proven by this point, so anything that fails below is the queue and not the
   * plumbing. Building a second script would have meant a second copy of that
   * setup, which is M-75 and the five failed runs it cost.
   */

  /*
   * The account's public state, in the shape the boundary declares.
   *
   * `LedgerStatus` used to be eight scalars, four of which described the one
   * proposal an account could have. It is now two lists and two numbers, and
   * the runner reads them for exactly one purpose: deciding whether a job that
   * was interrupted after submission actually landed. `viewDigestOf` — the
   * shared definition in core/ledger.ts, not a copy — turns the asset list into
   * the single handle recovery compares against.
   *
   * `assets` IS EMPTY AND IS READ OFF NOTHING. The on-chain
   * balance map is gone, so there is nothing to decode. The field stays on
   * `LedgerStatus` because it is the shape both ledger implementations answer
   * in, and `MidnightLedger.readContractState` answers it the same way
   * (src/midnight/ledger.ts:1540) — an empty literal rather than a reader over
   * a map that is not there.
   */
  const ledgerStatus = async () => {
    const l = await readState();
    return {
      assets: [] as Array<{ key: string; commitment: string }>,
      openProposals: openProposalsOf(l),
      threshold: Number(l.threshold),
      /*
       * The vaults somebody deliberately gave their own threshold — read
       * from the contract's own `thresholds` map, empty on every account this
       * script drives, because nothing here sets one.
       */
      vaultThresholds: [...l.thresholds]
        .map(([vault, threshold]: [Uint8Array, bigint]) =>
          ({ vault: hex(vault), threshold: Number(threshold) }))
        .sort((a: { vault: string }, b: { vault: string }) => a.vault.localeCompare(b.vault)),
      signerCount: Number(l.signerLeaves.size()), // Derived; S35c deleted the counter.
      movementCount: Number(l.movements.size()), retiredVaults: [...l.retiredAt].map(([v]) => hex(v)).sort(), // `T-220`, `S52`; on ONE line because the doc set cites this file by line.
    };
  };

  /*
   * The proposal the queued approval is for.
   *
   * Held in a variable rather than looked up, because `approve` NAMES the
   * proposal it approves since M-128 — so the plan below has an argument to
   * fill, where every circuit this section used to drive took none.
   */
  const jobPayload = seededBytes(901);
  const jobSalt = JOB_SALT;
  const jobProposalId = proposalIdFor(jobPayload, jobSalt);

  const seen: string[] = [];
  const queue = new JobQueue(
    new MidnightJobRunner({
      providers,
      compiled,
      circuitsThatReadNoWitness: CIRCUITS_THAT_READ_NO_WITNESS,
      /*
       * Staging is MOST of `plan` here — the witnesses are read from this
       * device's private state — but no longer all of it: `approve` takes the
       * proposal id, so the plan has one argument to carry.
       */
      plan: async (job: Job) => {
        await becomeSigner(signerA, 'A');
        return {
          contractAddress,
          circuit: job.kind,
          args: [jobProposalId],
          privateStateId: PRIVATE_STATE_KEY,
        };
      },
      status: ledgerStatus,
      /*
       * `expectationFor` takes the PROPOSAL now, where it took the round.
       *
       * "Has the account moved on" was the round's question and it was too
       * coarse: an unrelated payment settling would have declared this job
       * unusable. The question that matters is whether the proposal this job
       * was built against is still there.
       */
      expectation: async (job: Job) =>
        expectationFor(job, hex(jobProposalId), (job.payload.expect as any) ?? null),
    }),
    {
      store: new KeyValueJobStore(new MemoryKeyValue()),
      // Every transition, which in the product is what a notification and an
      // optimistic UI subscribe to. Here it is the evidence.
      onChange: (j) => { seen.push(j.state); note(`  job ${j.kind} -> ${j.state}`); },
    },
  );

  // A fresh proposal to approve. `propose` goes through the normal path because
  // it is not what is under test. Its own salt, so its id cannot collide with
  // the payment round that has just settled.
  pendingChange = { asset: ASSET.code, amount: 0n, batch: seededBytes(902), salt: jobSalt };
  await becomeSigner(signerA, 'A');
  await callCircuit('propose (for the job run)', () => found.callTx.propose(jobPayload, ZERO_32, 0n, 0n, 0n, false, pureCircuits.noVault()),
    async () => isOpen(await readState(), jobProposalId));

  const approvalsBefore = approvalsFor(await readState(), jobProposalId);

  const approveJob = await queue.enqueue({ accountId: ACCOUNT_ID, kind: 'approve', signerId: 'A' });
  good(`job ${approveJob.id} is durable before anything has been proved`);
  await queue.drain();

  const doneJob = await queue.get(approveJob.id);
  const jobFailures: string[] = [];

  if (doneJob?.state !== 'settled') {
    jobFailures.push(`the job ended ${doneJob?.state}, not settled — ${doneJob?.error ?? 'no reason given'}`);
  }
  if (!doneJob?.txRef) jobFailures.push('the job settled without a transaction id');

  // The transitions matter as much as the outcome: `proven` existing at all is
  // the claim that proving and submitting are separable, which is the whole of
  // decision 0008.
  const EXPECTED_STATES = ['queued', 'proving', 'proven', 'submitting', 'settled'];
  if (seen.join(',') !== EXPECTED_STATES.join(',')) {
    jobFailures.push(`the job passed through ${seen.join(' -> ')}, expected ${EXPECTED_STATES.join(' -> ')}`);
  }

  // That proposal's count, not the account's — there is no account-wide count
  // any more, and an approval given to something else is not evidence about this.
  const approvalsAfter = approvalsFor(await readState(), jobProposalId);
  if (approvalsAfter <= approvalsBefore) {
    jobFailures.push(
      `this proposal's approval count did not rise (${approvalsBefore} -> ${approvalsAfter})`,
    );
  }

  if (jobFailures.length) {
    console.log();
    for (const f of jobFailures) console.log(`    • ${f}`);
    throw new Error('the job queue did not drive the approval correctly');
  }
  good(`approved through the queue: ${seen.join(' -> ')}`);
  good(
    `proposal ${hex(jobProposalId).slice(0, 12)}… went from ${approvalsBefore} to ` +
      `${approvalsAfter} approvals, tx ${doneJob!.txRef}`,
  );

  /*
   * RECOVERY, against the live chain. The part that cannot be tested with fakes.
   *
   * A job found in `submitting` after a crash is genuinely unknown: the
   * transaction may have settled or may never have arrived. `watchForTxData`
   * cannot answer that — it waits indefinitely and never resolves "no" — so the
   * question is asked of the ACCOUNT instead.
   */
  const runner = new MidnightJobRunner({
    providers, compiled,
    circuitsThatReadNoWitness: CIRCUITS_THAT_READ_NO_WITNESS,
    /*
     * NEVER REACHED — `recover` plans nothing, it reads the account. It names
     * `approve` because a plan naming a circuit the contract does not have is a
     * trap for whoever wires a second caller to this runner; it named `credit`,
     * which went with the balance ledger.
     */
    plan: async () => ({
      contractAddress, circuit: 'approve', args: [jobProposalId],
      privateStateId: PRIVATE_STATE_KEY,
    }),
    status: ledgerStatus,
    /*
     * NULL for the proposal, and it is the right answer rather than a shortcut:
     * the three jobs below are synthetic stand-ins for a crash and name no
     * proposal this run raised. Passing the payment round's id here would make
     * a case fail with "built against a proposal that is no longer open", which
     * would be true of the id and completely wrong about the job.
     */
    expectation: async (job: Job) =>
      expectationFor(job, null, (job.payload.expect as any) ?? null),
  });

  const inFlight = (expect: string | null, kind: any = 'approve'): Job => ({
    id: 'job_crashed', accountId: ACCOUNT_ID, kind, state: 'submitting', signerId: 'A',
    payload: { expect }, attempts: 1, txRef: 'tx_unknown',
    createdAt: 'x', updatedAt: 'x',
  });

  /*
   * 1. The handle matches, so recovery says settled.
   *
   * THE HANDLE IS THE VIEW DIGEST, where it used to be the state commitment.
   * M-125 left no single commitment to compare, so `viewDigestOf` — one
   * definition, in core/ledger.ts, shared with both ledger implementations —
   * digests the public asset list instead.
   *
   * IT NO LONGER DISTINGUISHES ANYTHING, AND THIS SAYS SO. The
   * asset list is empty for every account and every state, so the digest is one
   * constant and a job whose handle is that constant is "settled" whether it
   * landed or not. What this still exercises is that the branch is wired and
   * reads the account rather than the transaction. What it no longer exercises
   * is the property recovery is FOR — that a handle moves only when the effect
   * lands — and nothing on this contract supplies one. A row for the register,
   * not something to paper over with a stronger sentence below.
   */
  const recovered = await runner.recover(inFlight(viewDigestOf((await ledgerStatus()).assets)));
  if (!recovered?.settled) throw new Error('recover failed to see a state the chain plainly holds');
  good('recover: reads the account rather than the transaction, and says settled');
  note('  (the handle is constant while the account keeps no assets, so this does not tell');
  note('   a job that landed from one that did not — C292)');

  // 2. The handle does NOT match, and the circuit rejects a duplicate on chain,
  //    so redoing it is safe. `approve` is that circuit: a signer's nullifier is
  //    burned per proposal, so a second attempt is refused rather than counted
  //    twice. It stood on `credit`, which carried a staleness assert and went
  //    with the balance ledger; this is repointed to a circuit
  //    the contract still has rather than left naming one it does not.
  const redo = await runner.recover(inFlight('00'.repeat(32)));
  if (redo !== null) throw new Error('recover should have allowed a redo of a guarded circuit');
  good('recover: sees nothing landed, and allows a redo the circuit would reject twice');

  // 3. The runner records NO on-chain duplicate check for `addSigner`, so it
  //    refuses rather than guessing, and this branch proves it still refuses.
  
  //    THE REASON IT RECORDS IS STALE, AND SAYING SO HERE IS CHEAPER THAN
  //    RE-DERIVING IT. `src/midnight/job-runner.ts:333` names M-83's bootstrap
  //    path — insert the leaf, close no round, nothing stopping it twice — and
  //    `S35d` made that path unreachable on every account from birth: the
  //    constructor seats one signer and sets `threshold = 1`, so
  //    `signerLeaves.size() < threshold` is false from birth and cannot become
  //    true (the paragraph beside `threshold = 1` in the contract, and
  //    `docs/company-accounts.md` section 10a). Every seat closes an approved
  //    proposal now, so a replay is refused on chain like any other.
  
  //    The refusal below is therefore CONSERVATIVE rather than required. That
  //    is the safe direction and it is another file's line to change, so this
  //    round names it and leaves it.
  let refused = false;
  try {
    await runner.recover(inFlight(null, 'addSigner'));
  } catch (e: any) {
    refused = /cannot be checked automatically/.test(String(e?.message));
  }
  if (!refused) throw new Error('recover should refuse to guess where a duplicate is not rejected on chain');
  good('recover: refuses to guess where a retry could apply twice');

  // Leave the account as this stage found it. Cancelling names which proposal
  // it withdraws, and touches no other — including any this run never raised.
  await becomeSigner(signerA, 'A');
  await callCircuit('cancel (tidying up)', () => found.callTx.cancel(jobProposalId),
    async () => !isOpen(await readState(), jobProposalId));

  console.log();
  console.log('\x1b[32m\x1b[1m  An approval settled on ' + NETWORK + ' as a durable job.\x1b[0m');
  console.log('  Proving and submitting were separate steps, and an interrupted');
  console.log('  submission was resolved by asking the chain rather than guessing.');

  sub?.unsubscribe?.();
  await env.shutdown(false);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  Failed during: ${stage}\x1b[0m`);
    console.log(describeError(e).split('\n').map((l) => '  ' + l).join('\n'));
    if (e?.stack) console.log(`\n\x1b[2m${e.stack.split('\n').slice(1, 8).join('\n')}\x1b[0m`);
    console.log();
    console.log('  Send this whole output back. The stage name above says which');
    console.log('  layer broke, so the next fix does not have to be a guess.');
    process.exit(1);
  },
);
