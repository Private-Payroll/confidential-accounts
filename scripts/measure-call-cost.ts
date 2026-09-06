/**
 * WHAT A CALL COSTS AT RUN TIME, NOT WHAT THE DEPLOY COSTS. `S8` item 3.
 *
 * Run it with MEASURE-CALL-COST.command, or:
 *   npx tsx scripts/measure-call-cost.ts
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `MEASURE-TX-SIZE.command` measures the DEPLOY. A deploy happens once; a
 * payroll RUN is many transactions and every payment crosses the account↔vault
 * boundary. **Nobody had ever measured one.**
 *
 * That outranks the deploy rather than following it: a contract that deploys
 * and cannot be paid from is worse than one that does not deploy.
 *
 * ── HOW IT RUNS WITH NO CHAIN ────────────────────────────────────────────────
 *
 * Two facts this repository already relies on:
 *
 *   1. `contracts/test/simulator.ts` drives the account's circuits in process
 *      against a real `ContractState`, so a state from which a call is legal
 *      can be BUILT here rather than fetched;
 *   2. `createUnprovenCallTxFromInitialStates` takes those initial states
 *      directly, and its `crossContract` argument takes a `publicDataProvider`
 *      — so a cross-contract callee resolves from memory instead of the
 *      indexer (`V-39`, the door `scripts/cross-contract-spike.ts` opened).
 *
 * No node, no indexer, no proof server, no wallet. Nothing is spent and
 * nothing is submitted.
 *
 * ── WHAT ITS NUMBERS ARE ─────────────────────────────────────────────────────
 *
 * **FLOORS, and each is labelled one.** Every transaction here is UNPROVEN and
 * UNBALANCED: proving replaces each `ProofPreimage` with a larger `Proof`, and
 * balancing adds the Zswap offer and the DUST spends that pay the fee.
 *
 * A floor already over a limit is a finding. A floor under one settles nothing
 * on its own, and this file says so rather than implying otherwise.
 *
 * ── THE CEILING IS DERIVED, AND IT IS ~65%, NOT 75% ──────────────────────────
 *
 * `midnight-node@d9729c13`, `pallets/midnight/src/lib.rs:611-615` scales the
 * largest normalised dimension by the WHOLE block's `ref_time`, and
 * `check_weight` in `pre_dispatch` judges a normal extrinsic against the
 * NORMAL class's PER-EXTRINSIC budget — `max_extrinsic` = 0.75 − 0.10 −
 * base_extrinsic ≈ 0.65 of the block, NOT the 75% class total this file used
 * to hold as a literal (`C238`: 35,748 bytesWritten sat under the "75%
 * ceiling" and was refused with 1010). `scripts/dispatch-ceiling.ts` derives
 * the number, cites every source line, prints the chain on every run, and is
 * calibrated against the two real submissions by
 * `scripts/dispatch-ceiling.test.ts`. Every dimension below is reported
 * against the DERIVED per-extrinsic ceiling.
 *
 * ── WHICH CONTRACT. ──────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/measure-call-cost.ts            the account (default)
 *   npx tsx scripts/measure-call-cost.ts vault      the vault
 *
 * **One contract per run, and the default is the account**, so everything that
 * ran this before the argument existed produces the same rows.
 *
 * The vault is why the argument exists. It had never had verifier keys built
 * — `COMPILE-VAULT.command` is the file that builds them — so `payout`
 * has never been measured by anything, and `payout` is the one that matters: it
 * carries the vault's own call AND the account's `recordPayment` in ONE INTENT,
 * which is the first measurement of what a cross-contract transaction costs.
 * Bounded below by `recordPayment`'s 3.83% and otherwise unknown.
 *
 * **THERE IS NO VAULT SIMULATOR, and that is a finding rather than an
 * omission.** `contracts/test/simulator.ts` drives the ACCOUNT only; every vault
 * test builds its own vault inline from `createConstructorContext` and
 * `createCircuitContext`, and that state-driving has been copied into seven test
 * files. This file needs the same thing again and builds it the same way — from
 * the contract's own constructor and its own `deposit` — rather than inventing
 * an eighth variant of a state the contract could not reach. What it does NOT
 * copy is the witness: it uses the CLIENT's `witnessesOver`
 * (`src/midnight/vault-notes.ts`), because the transaction being measured is
 * the one the client will build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as CC from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { createUnprovenCallTxFromInitialStates } from '@midnight-ntwrk/midnight-js-contracts';
import { ZswapChainState, LedgerParameters } from '@midnight-ntwrk/midnight-js-protocol/ledger';
/*
 * `ContractOperation` FROM THE RUNTIME, NOT FROM THE LEDGER, and the two are
 * different WASM classes with the same name. The simulator's `ContractState`
 * comes from `@midnightntwrk/onchain-runtime-v4`, and `setOperation` checks the
 * instance: handed the ledger's it answers *"expected instance of
 * ContractOperation"*, which reads like a type error and is really two modules.
 */
import {
  ContractOperation, ChargedState, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, pureCircuits } from '../contracts/managed/contract/index.js';
import {
  Contract as VaultContract, pureCircuits as vaultCircuits,
} from '../contracts/managed-vault/contract/index.js';
import { witnessesOver, type Note } from '../src/midnight/vault-notes.js';
import { witnesses, type AccountPrivateState, NO_VAULT } from '../contracts/src/witnesses.js';
import {
  AccountSimulator, privateStateFor, change, GBP, ZERO_32,
} from '../contracts/test/simulator.js';
import { buildPayoutTree, type PayoutLeafInput } from '../src/midnight/payout-tree.js';
import { applyNetworkId, networkFromEnv } from '../src/midnight/network.js';
import { toHex, fromHex } from '../src/core/crypto.js';
import {
  classCeiling, extrinsicCeiling, extrinsicFraction, printDerivation,
} from './dispatch-ceiling.js';
import {
  limitsFromLedger, measureCost, measureTransaction, type BlockLimits,
} from './tx-size.js';

const ROOT = process.cwd();
const ACCOUNT_ARTEFACTS = join(ROOT, 'contracts', 'managed');
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');
const NETWORK = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');

/**
 * What a NORMAL extrinsic may take of one dimension — DERIVED, never a
 * literal. ~0.65 of the limit, not 0.75: see
 * scripts/dispatch-ceiling.ts for the chain and its calibration test.
 */
const ceilingOf = (limit: number): number => extrinsicCeiling(limit);

/**
 * WHICH CONTRACT IS BEING MEASURED. The argument first, the environment
 * second, the ACCOUNT last — the default is what every existing caller passes,
 * which is nothing.
 */
type Target = 'account' | 'vault';
const TARGET_ARG = (process.argv[2] ?? process.env.MEASURE_TARGET ?? 'account').toLowerCase();
if (TARGET_ARG !== 'account' && TARGET_ARG !== 'vault') {
  console.log(`\n  \x1b[31mUnknown contract "${TARGET_ARG}".\x1b[0m Say "account" or "vault".\n`);
  process.exit(2);
}
const TARGET = TARGET_ARG as Target;
const ARTEFACTS = TARGET === 'vault' ? VAULT_ARTEFACTS : ACCOUNT_ARTEFACTS;
/** What builds the keys for this target, named in every refusal. */
const BUILT_BY = TARGET === 'vault' ? 'COMPILE-VAULT.command' : 'DEPLOY-PREVIEW.command';

/**
 * The block a cross-contract callee's state is read at.
 *
 * Offline, so nothing resolves it: the resolver passes it to the provider this
 * file supplies and the runtime carries it as `parentBlockHash`. Thirty-two
 * zero bytes, which is what every vault test uses.
 */
const BLOCK = '0'.repeat(64);

/**
 * The clock, in seconds since the epoch.
 *
 * REAL, not the simulator's fixed instant, and the reason is not laziness: the
 * SDK builds its own circuit context and takes the block time from the machine,
 * so a run's window has to be placed around the same clock the transaction will
 * be built against or every window assert fails for the wrong reason.
 */
const NOW = Math.floor(Date.now() / 1000);
const LIVE_FROM = BigInt(NOW - 3_600);
const LIVE_UNTIL = BigInt(NOW + 3_600);
const PAST_FROM = BigInt(NOW - 7_200);
const PAST_UNTIL = BigInt(NOW - 3_600);

const line = (s = '') => console.log(s);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const fill = (n: number) => new Uint8Array(32).fill(n);

const DIMENSIONS = ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned'] as const;

interface Measured {
  name: string;
  what: string;
  bytes: number | null;
  cost: Record<string, number | null> | null;
  exceeded?: string;
  problem?: string;
}

const results: Measured[] = [];

async function main() {
  line('────────────────────────────────────────────────────────────');
  line(`  What does a CALL cost — not the deploy? — ${TARGET === 'vault' ? 'THE VAULT' : 'the account'}`);
  line('────────────────────────────────────────────────────────────');
  line();
  line('  No node, no indexer, no proof server, no wallet. Nothing is spent and');
  line('  nothing is submitted.');
  line();

  const ledgerWasm: any = await import('@midnightntwrk/ledger-v9');
  await applyNetworkId(NETWORK);
  line(`  network id  ${NETWORK}`);
  line(`  block time  ${NOW} (seconds since the epoch, this machine's clock)`);
  line(`  contract    ${TARGET}  (${ARTEFACTS.replace(`${ROOT}/`, '')})`);

  /*
   * THE KEYS, OR NOTHING.
   *
   * A call transaction cannot be built without the verifier key of the circuit
   * being called — the key is hashed into the call — so a missing key directory
   * is a refusal here rather than a page of identical "not built" rows that a
   * reader has to diagnose one by one.
   */
  if (!existsSync(join(ARTEFACTS, 'keys'))) {
    line();
    line(`  \x1b[31m${ARTEFACTS.replace(`${ROOT}/`, '')}/keys does not exist — no call can be built.\x1b[0m`);
    if (TARGET === 'vault') {
      line('  The vault has never had verifier keys built (C226), so no payout');
      line('  transaction has ever been built by anything.');
    }
    line(`  Run ${bold(BUILT_BY)} once, then run this again.`);
    line('  Nothing was measured and no number was estimated.');
    process.exit(1);
  }

  const limits = limitsFromLedger(LedgerParameters);
  line();
  line(`  ${bold("The chain's limits, derived from this project's own ledger")}`);
  for (const d of DIMENSIONS) {
    const v = (limits as any)[d] as number | null;
    const c = v === null ? null : ceilingOf(v);
    line(`    ${d.padEnd(14)} ${v === null ? '(could not derive)'
      : `${v.toLocaleString().padStart(17)}   class ${classCeiling(v).toLocaleString().padStart(14)}   extrinsic ${c!.toLocaleString().padStart(14)}`}`);
  }
  line(`    ${limits.source}`);
  line();
  printDerivation(line, limits.bytesWritten);

  /* ------------------------------------------------ the compiled contracts */
  const accountCompiled = CC.make('ConfidentialAccount', Contract as any).pipe(
    CC.withWitnesses(witnesses as any),
    CC.withCompiledFileAssets(ACCOUNT_ARTEFACTS as never),
  ) as any;
  const accountZk = new NodeZkConfigProvider<string>(ACCOUNT_ARTEFACTS);

  const coinPk = ledgerWasm.sampleCoinPublicKey();
  const encPk = ledgerWasm.sampleEncryptionPublicKey();

  /**
   * Builds one unproven call transaction and measures it.
   *
   * EVERY FAILURE IS REPORTED AND NONE IS ESTIMATED. A circuit whose
   * transaction cannot be built leaves a row saying why, because a missing row
   * that reads like a zero is worse than an honest gap.
   */
  const measure = async (
    name: string, what: string, opts: Record<string, unknown>,
    zk: NodeZkConfigProvider<string>, crossContract?: unknown,
  ): Promise<any> => {
    try {
      const built: any = await createUnprovenCallTxFromInitialStates(
        zk, opts as any, encPk, crossContract as any);
      const tx = built?.private?.unprovenTx ?? built?.unprovenTx;
      if (!tx) throw new Error('the SDK returned no unprovenTx — its shape has changed');
      const m = measureTransaction(tx, 'unproven, unbalanced');
      const c = measureCost(tx, LedgerParameters);
      results.push({ name, what, bytes: m.bytes, cost: c.cost, exceeded: c.exceeded, problem: c.problem });
      line(`    ${name.padEnd(20)} ${m.bytes === null ? 'not measurable' : `${m.bytes.toLocaleString().padStart(8)} bytes`}`);
      /*
       * The BUILT call is handed back so a caller can carry the state forward:
       * the vault's rows are measured from the state its own previous call
       * left, which is the only honest sequence for a contract whose circuits
       * spend what an earlier one deposited.
       */
      return built;
    } catch (e: any) {
      results.push({ name, what, bytes: null, cost: null, problem: String(e?.message ?? e) });
      line(`    ${name.padEnd(20)} \x1b[33mnot built: ${String(e?.message ?? e).slice(0, 400)}\x1b[0m`);
      return null;
    }
  };

  /* ================= THE KEYS, WHICHEVER CONTRACT THIS IS ================ */
  /*
   * THE SIMULATOR'S STATE CARRIES NO VERIFIER KEYS, AND A CALL NEEDS THEM.
   *
   * `contract.initialState` produces a `ContractState` whose operations exist
   * and are empty — the simulator never deploys, and nothing it does needs a
   * key. `createUnprovenCallTxFromInitialStates` does: it refuses with
   * *"has no verifier key ... which the call's key location hashes"*, because
   * the key is hashed into the call.
   *
   * So the keys are attached here from the same files the deploy would deploy,
   * `contracts/managed/keys/<circuit>.verifier`, read off disk and set on the
   * state. Nothing is invented: these are the bytes MEASURE-TX-SIZE.command
   * counts and the bytes a deploy would carry.
   */
  const attachVerifierKeys = (cs: any, artefacts: string) => {
    for (const name of cs.operations()) {
      const f = join(artefacts, 'keys', `${name}.verifier`);
      if (!existsSync(f)) continue;
      const op = new ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(f));
      cs.setOperation(name, op);
    }
    return cs;
  };

  /* ============================== THE VAULT ============================== */
  /*
   * ONE CONTRACT PER RUN, AND THE VAULT'S PATH ENDS HERE.
   *
   * Not because the two could not be printed together, but because a report
   * that can be about either contract is a report nobody can quote — and
   * because the account's rows are what six documents already cite. The vault
   * writes REPORT-CALL-COST-VAULT.txt and leaves the account's alone.
   */
  if (TARGET === 'vault') {
    await measureVault(measure, attachVerifierKeys, coinPk, encPk);
    report(results, limits);
    line();
    line('  Nothing was submitted and nothing was spent.');
    return;
  }

  /* ============================ THE ACCOUNT ============================== */
  const ada = privateStateFor(1);
  const blake = privateStateFor(2);
  const sim = await AccountSimulator.create(ada);
  sim.at(NOW);

  const accountOpts = (circuitId: string, args: unknown[], priv: AccountPrivateState) => ({
    compiledContract: accountCompiled,
    circuitId,
    contractAddress: sim.address,
    args,
    initialPrivateState: priv,
    initialContractState: attachVerifierKeys(sim.contractStateForCall, ACCOUNT_ARTEFACTS),
    initialZswapChainState: new ZswapChainState(),
    ledgerParameters: LedgerParameters.initialParameters(),
    coinPublicKey: coinPk,
  });

  line();
  line(`  ${bold('Seating a signer')}`);
  /*
   * **MEASURED ON THE APPROVED PATH, BECAUSE SINCE `S35d` THERE IS NO OTHER
   * ONE — AND THE NUMBER THIS PRODUCES IS NOT THE OLD NUMBER.**
   *
   * This used to measure the BOOTSTRAP path: `create(ada, 2n)` gave one seat
   * against a bar of two, so `amendSigner` could be called with `ZERO_32` as
   * its proposal and the gate skipped `requireApproved` entirely. The
   * constructor no longer takes a threshold, so every account is founded at one
   * seat and one approval and that branch is unreachable. **The circuit is the
   * same circuit; the path through it is not, and this measurement now includes
   * `requireApproved` and `closeProposal`.** A reader comparing this row
   * against an older report is comparing two different paths, which is why it
   * is said here rather than left to the diff.
   */
  const seating = change(0n, 40);
  const seatPayload = pureCircuits.signerAddPayload(sim.leafOf(blake));
  await sim.as(sim.applying(ada, seating)).propose(seatPayload);
  const seatId = sim.proposalId(seatPayload, seating.salt);
  await sim.as(sim.applying(ada, seating)).approve(seatId);
  await measure('amendSigner (seat)', 'seats a signer: membership proof plus a tree insert',
    accountOpts('amendSigner', [sim.leafOf(blake), seatId, false, false],
      sim.applying(ada, seating)), accountZk);
  await sim.as(sim.applying(ada, seating)).addSigner(sim.leafOf(blake), seatId);

  /*
   * `credit` AND `execute` ARE BOTH GONE FROM THE CONTRACT. S23 shed `credit`;
   * `C292`/`S26` removed `execute` along with `assetBalances`, `settled` and
   * the account's balance ledger entire.
   *
   * There is no longer a row for either, and no `funded` view to measure from:
   * `applying` takes the change alone. THE NUMBER THIS FILE MUST NOW PRODUCE IS
   * A NEW ONE — every circuit below is smaller than it was measured at, because
   * the contract lost two ledger fields and a circuit, so the whole table is
   * re-read rather than adjusted.
   */

  line();
  line(`  ${bold('The governance path')}`);
  const payload = fill(0x11);
  const paying = change(1_500_00n, 41);
  const proposer = sim.applying(ada, paying);
  await measure('propose (opaque)', 'opens a proposal over a committed payload',
    accountOpts('propose',
      [payload, ZERO_32, 0n, 0n, 0n, false, NO_VAULT], proposer), accountZk);
  await sim.as(proposer).propose(payload);
  const govId = sim.proposalId(payload, paying.salt);

  await measure('approve', "one signer's approval of one proposal",
    accountOpts('approve', [govId], sim.applying(ada, paying)), accountZk);
  await sim.as(sim.applying(ada, paying)).approve(govId);
  await sim.as(sim.applying(blake, paying)).approve(govId);

  line();
  line(`  ${bold('The rest of governance')}`);

  /**
   * Raises a proposal over `payload`, takes it to the account's threshold and
   * hands back the id — the pattern every governance test uses, so the states
   * these calls are measured from are states the contract can actually be in.
   */
  const approvedRound = async (p: Uint8Array, c = change(0n, 51)) => {
    const d = sim.applying(ada, c);
    await sim.as(d).propose(p);
    const id = sim.proposalId(p, c.salt);
    await sim.as(sim.applying(ada, c)).approve(id);
    await sim.as(sim.applying(blake, c)).approve(id);
    return { id, c };
  };

  /* cancel — measured on a proposal that is open and unspent. */
  {
    const c = change(0n, 52);
    const d = sim.applying(ada, c);
    await sim.as(d).propose(fill(0x12));
    const id = sim.proposalId(fill(0x12), c.salt);
    await measure('cancel', 'withdraws a proposal that has not been executed',
      accountOpts('cancel', [id], sim.applying(ada, c)), accountZk);
    await sim.as(sim.applying(ada, c)).cancel(id);
  }

  /* setThreshold — M of N changed through an approved round. */
  {
    const { id, c } = await approvedRound(pureCircuits.setThresholdPayload(2n), change(0n, 53));
    await measure('setThreshold', 'changes M in M-of-N through an approved round',
      accountOpts('setThreshold', [2n, id], sim.applying(ada, c)), accountZk);
    await sim.as(sim.applying(ada, c)).setThreshold(2n, id);
  }

  /* adopt — declares a vault this company's. */
  const vaultAddrBytes = fill(0x5a);
  {
    const { id, c } = await approvedRound(pureCircuits.adoptVaultPayload(vaultAddrBytes), change(0n, 54));
    await measure('adopt', "declares a vault this account's, through an approved round",
      accountOpts('adopt', [vaultAddrBytes, id], sim.applying(ada, c)), accountZk);
    await sim.as(sim.applying(ada, c)).adopt(vaultAddrBytes, id);
  }

  /* setVaultThreshold — ONE VAULT's threshold, judged at the ACCOUNT's. */
  {
    const { id, c } = await approvedRound(
      pureCircuits.setVaultThresholdPayload(vaultAddrBytes, 2n), change(0n, 55));
    await measure('setVaultThreshold',
      "gives one vault its own threshold; judged at the ACCOUNT's threshold (S6b)",
      accountOpts('setVaultThreshold', [vaultAddrBytes, 2n, id], sim.applying(ada, c)), accountZk);
    await sim.as(sim.applying(ada, c)).setVaultThreshold(vaultAddrBytes, 2n, id);
  }

  /* removeSigner — clears one slot, through an approved round. */
  {
    const cleo = privateStateFor(3);
    const seat = await approvedRound(pureCircuits.signerAddPayload(sim.leafOf(cleo)), change(0n, 56));
    await sim.as(sim.applying(ada, seat.c)).addSigner(sim.leafOf(cleo), seat.id);
    const { id, c } = await approvedRound(
      pureCircuits.removeSignerPayload(sim.leafOf(cleo)), change(0n, 57));
    await measure('amendSigner (unseat)', 'clears one signer\'s slot, through an approved round',
      accountOpts('amendSigner',
        [sim.leafOf(cleo), id, false, true], sim.applying(ada, c)), accountZk);
  }

  /*
   * `retireVault` IS NOT MEASURED HERE, AND THE REASON IS THE DESIGN.
   * Retirement is refused while the vault still holds notes, and only the vault
   * can see its own pool — so the account's half is reachable ONLY as a
   * cross-contract call from `Vault.retire`. Measuring it as a root call would
   * be measuring a route no caller has.
   */
  results.push({
    name: 'retireVault', bytes: null, cost: null,
    what: "the account's half of retiring a vault; reachable only from Vault.retire",
    problem: 'reachable only as a cross-contract call, which needs the vault\'s verifier keys',
  });

  /* ------------------------------------------------------ the payment path */
  line();
  line(`  ${bold('The payment path')}`);

  const ALICE = fill(0x0a);

  const runChange = change(0n, 31);
  const leaves: PayoutLeafInput[] = [{
    details: toHex(vaultCircuits.payoutDetails(ALICE, GBP, 250n, fill(0x40))),
    nonce: toHex(fill(0xc1)),
  }];
  const tree = buildPayoutTree(leaves);
  const runPayload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, LIVE_FROM, LIVE_UNTIL);

  const runProposer = sim.applying(ada, runChange);
  await measure('propose (run)', 'raises a payroll run: a payout root, a count and a window',
    accountOpts('propose',
      [ZERO_32, fromHex(tree.root), tree.payees, LIVE_FROM, LIVE_UNTIL, true, vaultAddrBytes],
      runProposer), accountZk);
  await sim.as(runProposer).proposeRun({
    root: fromHex(tree.root), payees: tree.payees,
    from: LIVE_FROM, until: LIVE_UNTIL, vault: vaultAddrBytes });
  const runId = sim.proposalId(runPayload, runChange.salt, vaultAddrBytes);
  await sim.as(sim.applying(ada, runChange)).approve(runId);
  await sim.as(sim.applying(blake, runChange)).approve(runId);

  /*
   * `recordPayment` MEASURED AS A ROOT CALL, and that is honest rather than a
   * shortcut. It takes every argument and reads not one witness (V-38), and it
   * does not assert who called it — so the transcript a root call produces is
   * the transcript the vault's cross-contract call produces. What a root call
   * leaves out is the VAULT's own half, which is measured separately below.
   */
  await measure('recordPayment', "the account's half of one payment; the callee across the boundary",
    accountOpts('recordPayment', [
      runId, vaultAddrBytes, fromHex(tree.root), tree.payees, LIVE_FROM, LIVE_UNTIL,
      runChange.salt, fromHex(leaves[0].details), fromHex(leaves[0].nonce), tree.pathFor(0),
    ], sim.applying(ada, runChange)), accountZk);

  /* A second run, already expired, so the sweep has something to sweep. */
  const pastChange = change(0n, 33);
  const pastPayload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, PAST_FROM, PAST_UNTIL);
  await sim.as(sim.applying(ada, pastChange)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees,
    from: PAST_FROM, until: PAST_UNTIL, vault: vaultAddrBytes });
  const pastId = sim.proposalId(pastPayload, pastChange.salt, vaultAddrBytes);
  await measure('closeExpiredRun', 'sweeps a run whose window has closed; PERMISSIONLESS, no tree',
    accountOpts('closeExpiredRun', [pastId], sim.applying(ada, pastChange)), accountZk);

  /* ------------------------------------------------------------- the vault */
  line();
  line(`  ${bold('The vault')}`);
  if (!existsSync(join(VAULT_ARTEFACTS, 'keys'))) {
    line('    \x1b[33mTHE VAULT HAS NO VERIFIER KEYS ON DISK.\x1b[0m');
    line('    contracts/managed-vault/ holds compiler/, contract/ and zkir/ and no keys/:');
    line('    COMPILE-CONTRACT.command compiles with proving keys SKIPPED, and');
    line('    DEPLOY-PREVIEW.command builds them for the ACCOUNT only. So a vault');
    line('    payout transaction cannot be built here, and the vault deploy has');
    line('    never been measured by anything.');
    line('    THE TWO DOORS, IN ORDER: COMPILE-VAULT.command builds the keys, then');
    line('    MEASURE-CALL-COST-VAULT.command measures the vault\x27s own circuits,');
    line('    payout included. Until then the vault\x27s half of a payment is');
    line('    unmeasured and is reported as unmeasured.');
    results.push({
      name: 'payout', bytes: null, cost: null,
      what: 'the vault pays one payee and calls recordPayment across the boundary',
      problem: 'contracts/managed-vault/keys does not exist — the vault has never had verifier keys built',
    });
  }

  report(results, limits);
  line();
  line('  Nothing was submitted and nothing was spent.');
}


/**
 * THE VAULT'S FOUR CIRCUITS, MEASURED FROM STATES THE VAULT CAN ACTUALLY BE IN.
 *
 *
 * ── THERE IS NO VAULT SIMULATOR ──────────────────────────────────────────────
 *
 * `contracts/test/simulator.ts` is the ACCOUNT's. Seven vault test files each
 * build their own vault inline — `createConstructorContext` for the
 * constructor, `createCircuitContext` per call, a hand-written provider for the
 * cross-contract read — and none of that is shared code. So the state-driving
 * here is the eighth copy of a pattern this repository has never extracted, and
 * saying so is part of the measurement: **if the vault's states were reachable
 * through one object the way the account's are, this function would be twenty
 * lines.** Extracting it is not this round's, and doing it while measuring
 * would put an untested helper between the contract and its own numbers.
 *
 * What is NOT copied from those tests is the witness. They each declare a local
 * `noteToSpend` that answers with whatever the test is holding; this uses the
 * CLIENT's `witnessesOver` from `src/midnight/vault-notes.ts`, because the
 * transaction being measured is the one the client will build, and coin
 * selection is part of it.
 *
 * ── HOW THE STATE MOVES ──────────────────────────────────────────────────────
 *
 * From the contract's own calls, in order: the constructor gives an empty
 * vault, `deposit` puts a note in it, and every later row is measured from the
 * state the previous call returned. Nothing here hand-builds a ledger.
 *
 * ── WHAT CROSSES THE BOUNDARY ────────────────────────────────────────────────
 *
 * `payout` and `retire` call the ACCOUNT. Their transactions are built with a
 * `crossContract` config whose `publicDataProvider` answers from an in-memory
 * `AccountSimulator` instead of the indexer (`V-39`) — and the account's state
 * carries its real verifier keys, because the runtime compares the sha256 of
 * the deployed key against the fingerprint the compiler baked into the vault's
 * module (`docs/midnight/01` §E.6).
 *
 * `deposit` and `splitNote` need no account at all, which is why they are
 * measured first: if they build and `payout` does not, the boundary is the
 * cause and not the vault.
 */
/**
 * **CARRIES A CONTRACT STATE FORWARD FROM A CALL THAT BUILT. `T-35`.**
 *
 * This is the whole of the crash that has hidden `splitNote`, `payout` and
 * `retire` since the vault instrument was written — *"cs.operations is not a
 * function"* at `attachVerifierKeys`, on the row AFTER `deposit`.
 *
 * **`nextContractState` IS NOT A `ContractState`.** It is that state's DATA.
 * Read from the SDK rather than inferred: `createUnprovenCallTxFromInitialStates`
 * returns `public.nextContractState = rootCall.public.contractState`, which is
 * `entry.finalQueryContext.state.state` in compact-js — a `StateValue`. The one
 * place midnight-js consumes it says so in a single line
 * (`midnight-js-contracts/dist/index.mjs`):
 *
 *     contractState.data = new ChargedState(callData.public.nextContractState);
 *
 * It keeps the SAME `ContractState` object — with its operations and their
 * verifier keys — and replaces only the data. Assigning `nextContractState`
 * over the whole state, as this file did, threw the operations away, and the
 * next row's `attachVerifierKeys` found nothing to iterate.
 *
 * **SO THIS IS THE SDK'S OWN LINE, NOT A SECOND MODEL OF IT.** `M-104`: a
 * hand-rolled "apply the new data" would be a second implementation of the one
 * step that decides whether every later row is measured against a ledger the
 * contract actually produced.
 *
 * A call that did not build carries nothing forward — the state is returned
 * unchanged — so a failed row leaves the next one measuring the last ledger the
 * contract really reached rather than an invented one.
 */
function advance(state: any, built: any): any {
  const next = built?.public?.nextContractState;
  if (!next) return state;
  state.data = new ChargedState(next);
  return state;
}

async function measureVault(
  measure: (
    name: string, what: string, opts: Record<string, unknown>,
    zk: NodeZkConfigProvider<string>, crossContract?: unknown,
  ) => Promise<any>,
  attachVerifierKeys: (cs: any, artefacts: string) => any,
  coinPk: unknown,
  /** The encryption key a payee must be mapped to, or `payout` cannot be built. */
  encPk: unknown,
): Promise<void> {
  const ALICE = fill(0x0a);

  /* ------------------------------------------------- the account behind it */
  const ada = privateStateFor(1);
  const blake = privateStateFor(2);
  /* Two seats at a bar of two, reached the way the chain now requires: the
   * constructor founds at one and `liveAccount` runs the governed rounds.
   */
  const sim = await AccountSimulator.liveAccount([ada, blake], 2n);
  sim.at(NOW);
  /*
   * NOTHING FUNDS THE ACCOUNT AND NOTHING BELOW NEEDS IT TO: a run authorises
   * payments out of the VAULT's pool, and neither `recordPayment` nor
   * `retireVault` ever consulted the account's own balance. `C292` removed
   * that balance; this measurement never read it.
   */

  /** The account, as the cross-contract resolver asks for it, keys attached. */
  const crossContract = {
    publicDataProvider: {
      queryContractState: async (address: unknown) =>
        (String(address) === String(sim.address)
          ? attachVerifierKeys(sim.contractStateForCall, ACCOUNT_ARTEFACTS)
          : null),
    },
    blockHash: BLOCK,
  };

  /* ------------------------------------------------------------- the vault */
  /** The pool the client's witness selects from. */
  const pool: { notes: Note[] } = { notes: [] };
  const pending: { spending?: string } = {};
  const vaultWitnesses = witnessesOver(() => pool as never, pending as never);

  const vaultCompiled = CC.make('Vault', VaultContract as any).pipe(
    CC.withWitnesses(vaultWitnesses as any),
    CC.withCompiledFileAssets(VAULT_ARTEFACTS as never),
  ) as any;
  const vaultZk = new NodeZkConfigProvider<string>(VAULT_ARTEFACTS);

  /** A vault married to this account at construction. `V-37`. */
  const newVault = async () => {
    const v: any = new VaultContract(vaultWitnesses as never);
    const init: any = await v.initialState(
      createConstructorContext({} as never, BLOCK),
      { bytes: fromHex(String(sim.address)) } as never);
    return { address: String(sampleContractAddress()), state: init.currentContractState as any };
  };

  /**
   * **THE VAULT'S OWN ZSWAP CHAIN STATE, CARRIED FORWARD LIKE THE LEDGER ONE.**
   * `T-35`, second half.
   *
   * `splitNote` and `payout` SPEND a note, and a spend is
   * `ZswapInput.newContractOwned(qualifiedCoin, segment, address, chainState)`
   * — the merkle path comes out of the chain state at the coin's `mt_index`.
   * Handed a fresh `new ZswapChainState()` every row, as this file did, the
   * tree is empty and the deposit's note is at no index at all: *"invalid index
   * into sparse merkle tree: 0"*. **That is not a fault in the circuit and it
   * is not a floor** — it is the instrument measuring a spend against a chain
   * where nothing was ever deposited.
   */
  let vaultZswap = new ZswapChainState();

  const vaultOpts = (circuitId: string, args: unknown[], address: string, state: any) => ({
    compiledContract: vaultCompiled,
    circuitId,
    contractAddress: address,
    args,
    initialPrivateState: pool,
    initialContractState: attachVerifierKeys(state, VAULT_ARTEFACTS),
    initialZswapChainState: vaultZswap,
    ledgerParameters: LedgerParameters.initialParameters(),
    coinPublicKey: coinPk,
    /*
     * **WHO MAY BE PAID, AND WITHOUT THIS `payout` CANNOT BE BUILT AT ALL.**
     * `V-77`, and it is the second half of `T-35`'s crash: *"Unable to resolve
     * encryption public key for recipient 0a0a…"*.
     *
     * midnight-js attaches a coin ciphertext to every shielded output bound for
     * a USER, encrypted to a key it resolves from the wallet's own key, the
     * burn address, and this mapping — and refuses to build the transaction
     * when it can find none. ALICE is not this process's wallet, so the mapping
     * is what makes her payable, exactly as `VaultLedger.payout` supplies it in
     * production from the payee's own address (`A-1`).
     *
     * Given for every row rather than only for `payout`: a row that has no
     * user-addressed output never consults it, and one code path is worth more
     * here than a conditional nobody exercises.
     */
    additionalCoinEncPublicKeyMappings: new Map([[toHex(ALICE), encPk]]),
  });

  const vault = await newVault();
  let vaultState = vault.state;

  /**
   * Applies a built call's own Zswap offer to the vault's tree, and answers
   * where the tree filed the commitment it inserted.
   *
   * **`ZswapChainState.tryApply` IS THE ONLY SURFACE IN THIS STACK THAT MAPS A
   * COMMITMENT TO AN INDEX** — it returns `[state, Map<CoinCommitment, bigint>]`,
   * *"a map on newly inserted coin commitments to their inserted indices"*
   * (`@midnightntwrk/ledger-v9/ledger-v9.d.ts`). That is worth naming here
   * because it is also the answer to where a CLIENT would get a note's
   * `mt_index` — and why it cannot simply take it: this works offline only
   * because this process is the whole chain, so nothing else inserted into the
   * tree first. On a real chain it is a prediction, and `V-60` makes many
   * payments of one run settle in the same block, each moving the next one's
   * index. `S6f` carries that as a finding.
   *
   * Whitelisted to the vault, so the map holds this contract's insertions and
   * not the payee's output.
   */
  const applyToVaultTree = (built: any): bigint | undefined => {
    const tx = built?.private?.unprovenTx;
    if (!tx) return undefined;
    const offers = [tx.guaranteedOffer, ...[...(tx.fallibleOffer?.values() ?? [])]]
      .filter((o: unknown) => o !== undefined && o !== null);
    let filed: bigint | undefined;
    for (const offer of offers) {
      const [next, inserted] = vaultZswap.tryApply(offer as never, new Set([vault.address]));
      vaultZswap = next;
      for (const at of inserted.values()) filed = at;
    }
    return filed;
  };

  /* ------------------------------------------------------ value arriving */
  line();
  line(`  ${bold('Value arriving — no account, no approval, nothing across the boundary')}`);
  const NOTE = { nonce: fill(0x77), color: GBP, value: 1_000n };
  const deposited = await measure(
    'deposit', 'a coin arrives and the vault records its commitment; needs no account',
    vaultOpts('deposit', [NOTE], vault.address, vaultState), vaultZk);
  /*
   * The pool is seeded whether or not the transaction built, so that a later
   * row fails for its OWN reason rather than for an empty pool — and the state
   * is carried forward only if it did, so no row is ever measured against a
   * ledger the contract did not produce.
   */
  vaultState = advance(vaultState, deposited);
  /*
   * **THE INDEX IS THE TREE'S ANSWER, NOT A ZERO.** It used to be `0n`, and
   * `0n` is where the sparse-merkle-tree error came from: nothing had ever been
   * inserted, so index 0 held nothing. Taken from `tryApply` above, the note the
   * pool offers is the note the tree actually holds — which is what makes the
   * two spending rows below measurable at all.
   *
   * The pool is seeded whether or not the transaction built, so that a later
   * row fails for its OWN reason rather than for an empty pool — and the state
   * is carried forward only if it did, so no row is ever measured against a
   * ledger the contract did not produce.
   */
  const filedAt = applyToVaultTree(deposited);
  pool.notes = [{
    nonce: toHex(NOTE.nonce), token: toHex(GBP), value: NOTE.value, index: filedAt ?? 0n,
  }];
  if (filedAt === undefined) {
    line('    \x1b[33mthe deposit built no Zswap offer this could read, so the rows that SPEND'
      + ' below are measured against an empty tree and will say so\x1b[0m');
  }

  /* ------------------------------------------------------------ splitting */
  line();
  line(`  ${bold('Maintenance — one note into two, still with no account')}`);
  await measure(
    'splitNote', 'divides a note the vault holds; a payment\x27s shape with no payee',
    vaultOpts('splitNote', [GBP, 400n], vault.address, vaultState), vaultZk);

  /* -------------------------------------------------------------- payment */
  line();
  line(`  ${bold('THE ONE THAT MATTERS: a payment — both contracts, one intent')}`);
  const vaultBytes = fromHex(vault.address);
  const leaves: PayoutLeafInput[] = [{
    details: toHex(vaultCircuits.payoutDetails(ALICE, GBP, 250n, fill(0x40))),
    nonce: toHex(fill(0xc1)),
  }];
  const tree = buildPayoutTree(leaves);
  const runChange = change(0n, 31);
  const runPayload = pureCircuits.runPayload(
    fromHex(tree.root), tree.payees, LIVE_FROM, LIVE_UNTIL);
  await sim.as(sim.applying(ada, runChange)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees,
    from: LIVE_FROM, until: LIVE_UNTIL, vault: vaultBytes });
  const runId = sim.proposalId(runPayload, runChange.salt, vaultBytes);
  await sim.as(sim.applying(ada, runChange)).approve(runId);
  await sim.as(sim.applying(blake, runChange)).approve(runId);

  await measure(
    'payout',
    'the vault pays one payee AND calls the account\x27s recordPayment, in one intent',
    vaultOpts('payout', [
      runId, fromHex(tree.root), tree.payees, LIVE_FROM, LIVE_UNTIL, runChange.salt,
      ALICE, GBP, 250n, fill(0x40), fill(0xc1), tree.pathFor(0),
    ], vault.address, vaultState), vaultZk, crossContract);

  /* ------------------------------------------------------------ retiring */
  line();
  line(`  ${bold('Retiring an EMPTY vault — the account\x27s half, by its only route')}`);
  /*
   * A SECOND VAULT, EMPTY, because retirement is refused while a vault holds
   * notes and the one above holds one. Measuring `retire` against a funded
   * vault would measure the refusal.
   */
  const empty = await newVault();
  const emptyBytes = fromHex(empty.address);

  const adoptChange = change(0n, 54);
  const adoptPayload = pureCircuits.adoptVaultPayload(emptyBytes);
  await sim.as(sim.applying(ada, adoptChange)).propose(adoptPayload);
  const adoptId = sim.proposalId(adoptPayload, adoptChange.salt);
  await sim.as(sim.applying(ada, adoptChange)).approve(adoptId);
  await sim.as(sim.applying(blake, adoptChange)).approve(adoptId);
  await sim.as(sim.applying(ada, adoptChange)).adopt(emptyBytes, adoptId);

  const retireChange = change(0n, 58);
  const retirePayload = pureCircuits.retireVaultPayload(emptyBytes);
  await sim.as(sim.applying(ada, retireChange)).propose(retirePayload);
  const retireId = sim.proposalId(retirePayload, retireChange.salt);
  await sim.as(sim.applying(ada, retireChange)).approve(retireId);
  await sim.as(sim.applying(blake, retireChange)).approve(retireId);

  await measure(
    'retire', 'the vault retires itself and calls the account\x27s retireVault across the boundary',
    vaultOpts('retire', [retireId, retireChange.salt], empty.address, empty.state),
    vaultZk, crossContract);

  /*
   * AND WHAT THIS RUN STILL DOES NOT SETTLE, said in the report rather than
   * left to be inferred from a row that is not there.
   */
  results.push({
    name: 'proving+balancing', bytes: null, cost: null,
    what: 'what a PROVEN, BALANCED payout costs on top of the floors above',
    problem: 'unmeasured — every transaction here is unproven and unbalanced, and the '
      + 'one observation this repository has (about 257 bytes) is the ACCOUNT\x27s DEPLOY',
  });
}

function report(rows: Measured[], limits: BlockLimits) {
  const limitOf: Record<string, number | null> = {
    readTime: limits.readTime, computeTime: limits.computeTime, blockUsage: limits.blockUsage,
    bytesWritten: limits.bytesWritten, bytesChurned: limits.bytesChurned,
  };

  line();
  line(`  ${bold(`Every call as a percentage of the DERIVED ~${(extrinsicFraction() * 100).toFixed(0)}% PER-EXTRINSIC CEILING — the largest dimension decides`)}`);
  line();
  line(`    ${'circuit'.padEnd(18)}${'bytes'.padStart(9)}  ${DIMENSIONS.map((d) => d.padStart(13)).join('')}`);
  for (const r of rows) {
    if (!r.cost) { line(`    ${r.name.padEnd(18)}   \x1b[2m${(r.problem ?? 'not measured').slice(0, 84)}\x1b[0m`); continue; }
    const cells = DIMENSIONS.map((d) => {
      const v = r.cost![d]; const l = limitOf[d];
      if (v === null || l === null || l === 0) return '—'.padStart(13);
      return `${((v / ceilingOf(l)) * 100).toFixed(2)}%`.padStart(13);
    });
    line(`    ${r.name.padEnd(18)}${(r.bytes ?? 0).toLocaleString().padStart(9)}  ${cells.join('')}`);
  }

  line();
  line(`  ${bold('The binding dimension, per call')}`);
  for (const r of rows) {
    if (!r.cost) { line(`    ${r.name.padEnd(18)} \x1b[2mnot measured\x1b[0m`); continue; }
    let worst = { name: '(none)', share: -1, raw: 0, limit: 0 };
    for (const d of DIMENSIONS) {
      const v = r.cost[d]; const l = limitOf[d];
      if (v === null || l === null || l === 0) continue;
      const share = v / ceilingOf(l);
      if (share > worst.share) worst = { name: d, share, raw: v, limit: l };
    }
    const flag = worst.share > 1 ? '   \x1b[31mOVER THE CEILING\x1b[0m'
      : worst.share > 0.75 ? '   \x1b[33mwithin 25% of it\x1b[0m' : '';
    line(`    ${r.name.padEnd(18)} ${worst.name.padEnd(12)} ${worst.raw.toLocaleString().padStart(16)} of ` +
      `${ceilingOf(worst.limit).toLocaleString().padStart(16)}   ` +
      `${(worst.share * 100).toFixed(2)}%${flag}`);
    if (r.exceeded) line(`      \x1b[31mthe ledger REFUSED to normalise this cost\x1b[0m: ${r.exceeded}`);
  }

  line();
  line(`  ${bold('What each row is')}`);
  for (const r of rows) line(`    ${r.name.padEnd(18)} ${r.what}`);

  line();
  line(`  ${bold('These are FLOORS')}`);
  line('    Every transaction above is UNPROVEN and UNBALANCED. Proving replaces');
  line('    each proof preimage with a larger proof; balancing adds the Zswap');
  line('    offer and the DUST spends that pay the fee. A floor already over a');
  line('    limit is a finding; a floor under one settles nothing on its own.');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  It did not finish: ${String(e?.message ?? e)}\x1b[0m`);
    if (e?.stack) console.log(`\x1b[2m${String(e.stack).split('\n').slice(1, 10).join('\n')}\x1b[0m`);
    process.exit(1);
  },
);
