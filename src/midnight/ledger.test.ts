/**
 * MidnightLedger's lifecycle, against a fake chain.
 *
 * These pin bugs that all type-checked and none of which could have been caught
 * by reading: M-27 (an argument passed to a circuit that takes none), M-28
 * (submitting the same transaction twice), M-29 (a boundary that handed this
 * class a commitment it could not open, and collapsed a four-step approval round
 * into one write).
 *
 * M-125 and M-128 changed the SHAPE of most of what is checked here without
 * changing what is at stake. There was no single state commitment — a map of
 * per-asset balance commitments took its place — and no round: an account holds
 * several proposals at once and every step names the one it is spending. So the
 * assertions below moved from "a round is open" to "this proposal is open".
 *
 * **`C292`/`S26` THEN REMOVED THE ACCOUNT'S BOOK ENTIRELY, AND WITH IT ROUGHLY A
 * THIRD OF THIS FILE.** The account keeps no balance: the `execute` circuit, the
 * `assetBalances` and `settled` ledger fields, `settleRound`, `sendTransition`,
 * `credit`, `stageState`, `checkAfter`, `viewDigestAfter` and `stageView` are
 * all gone. Every test whose SUBJECT was a balance went with them and says so
 * where it stood.
 *
 * **WHAT DID NOT GO IS WORTH NAMING, BECAUSE IT IS EASY TO DELETE BY ACCIDENT.**
 * Four rules those tests happened to be the only carrier of are not rules about
 * money at all — callTx submits and must not be submitted again (M-28), a
 * device with no private state refuses before calling (M-29), a proposal below
 * its threshold refuses before a fee is spent, and a transaction id comes from
 * the chain's answer rather than being invented. All four are REPOINTED onto
 * surviving circuits below rather than deleted.
 *
 * No node, no proof server, no Docker. The point is that this whole class of bug
 * was reachable offline: the only thing needed was a stand-in for `callTx` that
 * records what it was called with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MidnightLedger, type MidnightConfig, type FeeSponsor, type SealedStateStore } from './ledger.js';
/*
 * `StateOpening`, `StateView`, `RoundSettlement` and `TxRef` were imported here
 * too. `C292`, `S26`: the first three are gone from `core/ledger.ts` or emptied
 * of everything this file used, and `TxRef` was only the return type of the
 * `sendTransition` seam.
 */
import type { StateChange, SignerRef, AccountOpening } from '../core/ledger.js';
import { MidnightCommitments } from './commitments.js';
import type { Sealed, Hex } from '../core/crypto.js';
import { fromHex, toHex } from '../core/crypto.js';
import { assetIdBytes } from '../core/assets.js';
import { arityFrom } from './circuit-arity.js';
/*
 * The generated contract, imported for real and handed back to the ledger by
 * the mock below. Only the STATE READER is faked; the commitment circuits are
 * the contract's own, because what is under test is that this class asks the
 * contract for a commitment rather than hashing the values itself (decision
 * 0004) — and a stub that answered every question with the same bytes could not
 * tell the two apart. They are pure circuits, so they need no proof server, no
 * node and no proving keys.
 */
import { pureCircuits } from '../../contracts/managed/contract/index.js';

const CFG: MidnightConfig = {
  indexerUrl: 'http://indexer', indexerWsUrl: 'ws://indexer', proverUrl: 'http://prover',
  nodeUrl: 'http://node',
  // A real path, so the arity guard reads the real compiled ABI rather than a
  // stub that would share the bug's blind spot. M-38.
  zkConfigPath: new URL('../../contracts/managed', import.meta.url).pathname,
  networkId: 'preview',
  privateStateId: 'confidential-accounts-preview',
};

const SEALED_BYTES = { iv: '00', ct: '11', tag: '22' } as unknown as Sealed;
/*
 * `SEALED` — a sealed state and the key epoch that sealed it, K-4 — STOOD HERE
 * AND HAS NO CALLER LEFT. `C292`, `S26`: it was passed to `settleRound`,
 * `sendTransition` and the `execute` prepare step, and `stageState` was the
 * only thing that ever wrote it down. `SEALED_BYTES` survives because the blob
 * store below still has to answer a `get`.
 *
 * K-4 IS NOT REPEALED. `MidnightLedger.reseal` and `.fetch` are the methods
 * that carry it and both survive this round untouched. **Neither is covered by
 * any test in this file, and neither was before this round** — the only
 * `reseal` in the suite is `core.test.ts:2985`, against the SIMULATED ledger.
 * That gap is older than `C292` and is not made by it; it is stated here rather
 * than left to be inferred from a deleted constant.
 */
const OTHER = 'bb'.repeat(32) as Hex;
const PAYLOAD_HASH = 'cc'.repeat(32) as Hex;

/**
 * ONE ASSET, NAMED EVERYWHERE. M-125.
 *
 * The account's asset blinding is what turns a code into the opaque key the
 * on-chain map is filed under, so it has to be the same value in the device's
 * private state and in the view the caller passes. A test that let the two
 * differ would be testing a device that cannot find its own money.
 */
const ASSET = 'GBP';
const ASSET_BLINDING = '44'.repeat(32) as Hex;

/*
 * `CURRENT` AND `NEXT` STOOD HERE. `C292`, `S26`.
 *
 * A `StateView` at 500,000 and a `StateOpening` at 480,000 — the balance a
 * transition moved an asset FROM and TO. Both types are gone or emptied and no
 * surviving call takes either. Nothing below needs a balance to say what it
 * says: what the signers approve is a CHANGE, and the change is still here.
 */

/**
 * The approved change: relative, and since M-125 it NAMES THE ASSET — approving
 * a payment of £200 must not authorise moving the same integer in euros.
 *
 * The asset is still part of what the signers approve after `C292`/`S26`. What
 * changed is where the money is: the account holds none and never did, and the
 * change now describes what a VAULT may pay rather than what an account
 * ledger deducts. `changeCommitmentOf` binds the asset either way, which is
 * why `ASSET_KEY` below survives.
 */
const CHANGE: StateChange = {
  asset: ASSET,
  amount: 20_000n,
  batchDigest: '11'.repeat(32),
  salt: '22'.repeat(32),
};

const BY: SignerRef = { signerId: 'sgn_1', leaf: 'ff'.repeat(32) };

/*
 * What the chain should hold, computed by the contract's own circuits.
 *
 * Written out here rather than asserted as opaque constants so that a test
 * failure names which rule broke: the asset key, the proposal id, or the
 * change commitment.
 *
 * The list used to include a balance commitment and a digest over the balance
 * map. `C292`, `S26` — see the note below where they stood.
 */
const ASSET_KEY = MidnightCommitments.assetKey(ASSET, ASSET_BLINDING);
/*
 * `BALANCE_BEFORE`, `BALANCE_AFTER` AND `VIEW_AFTER` STOOD HERE. `C292`, `S26`.
 *
 * The first two came from `MidnightCommitments.balanceCommitment`, which is
 * gone with the contract circuit it wrapped; `VIEW_AFTER` was the digest over a
 * one-entry balance map, and was the address a sealed blob was filed under.
 *
 * `ASSET_KEY` SURVIVES and is not a balance: it is the opaque key an asset is
 * named by, derived by the contract from the account's own blinding, and the
 * change commitment below is still built on it. That is the M-125 rule — which
 * asset moves is part of what the signers approve — and this round does not
 * touch it.
 */
const PROPOSAL_ID = MidnightCommitments.proposalId(PAYLOAD_HASH, CHANGE.salt);
const CHANGE_COMMITMENT = MidnightCommitments.changeCommitment(
  ASSET_KEY, CHANGE.amount, CHANGE.batchDigest, CHANGE.salt);

const argHex = (a: unknown): string => Buffer.from(a as Uint8Array).toString('hex');

/*
 * ───────────────────────── X21 DIAGNOSTIC SCAFFOLDING ─────────────────────────
 *
 * **WHICH `harness()` SERVED THE CALL, AND WHICH ONE SERVED THE READ.**
 *
 * `X21`. The failure this exists for is intermittent — it survived two passes of
 * `SUITE-BISECT` and failed in the run straight after — and it fires on the
 * NO-MATCH branch with `ids on chain (0): none`. The state read back fine and
 * held nothing. So the question is not how an id is derived. It is how
 * `record('propose')`'s `proposals.set(…)` fails to be visible to the
 * `queryContractState` that runs microseconds later, when both close over the
 * same `Map` in the same `harness()` call.
 *
 * Two answers are possible and they are diagnosed in opposite directions:
 *
 *   · SAME harness id on both lines, size 0 at the read → **the write never
 *     happened.** Look at what ran instead of the `propose` branch.
 *   · DIFFERENT harness ids → **the call and the read were in different
 *     harnesses.** The `set` landed in a map nobody read. That is a fault in
 *     how the module mock is bound, not in the ledger.
 *
 * ONE LINE SETTLES IT, so one line is what this prints.
 *
 * **IT IS SILENT ON THE PASSING PATH.** The trace is registered through the
 * test context's `onTestFailed`, which was MEASURED to fire only on a failing
 * test and to fire after the failure — a passing test prints nothing at all.
 * `afterEach` reading `task.result.state` was measured to work too; the
 * documented hook is used because it cannot report `undefined` and silently
 * print nothing.
 *
 * **THIS IS SCAFFOLDING AND IT STAYS.** It costs one array push per circuit
 * call and one per state read, it prints only when a test has already failed,
 * and the fault it is aimed at has not been caught yet. Removing it the moment
 * the suite next comes back green is how the next intermittent failure arrives
 * with nothing attached to it.
 */

/** Bumped once per `harness()` call, for the lifetime of this module. */
let HARNESS_SEQ = 0;

/** What the current test's harnesses did, in order. Cleared before each test. */
const TRACE: string[] = [];

beforeEach((ctx) => {
  TRACE.length = 0;
  ctx.onTestFailed(() => {
    // `console.error`, so it reaches the same stream the failure does and is
    // attributed to the test by the reporter. `SUITE-BISECT.command` greps for
    // the marker below, so the words are a string two files depend on.
    console.error(`harness trace: ${TRACE.length === 0 ? 'no harness activity' : TRACE.join('  ')}`);
  });
});

/**
 * **WHICH HARNESS A LEDGER IS BOUND TO, AND IT IS NOT "THE LAST ONE BUILT".**
 * `C222`.
 *
 * The three module mocks below used to be registered INSIDE `harness()`, each
 * factory closing over that call's `callTx`. `vi.doMock` keeps one factory per
 * module path for the whole file, so the binding from a ledger to its fake
 * chain was module-scoped: every `harness()` call overwrote it, and
 * `MidnightLedger.connect` resolves it LAZILY — `await import(…)` at call time,
 * not at construction — so a ledger got whichever factory the registry happened
 * to hold when the circuit was called, not the one built beside it.
 *
 * **That is `C222` and it is `C228`'s family: a mutable binding at module scope
 * deciding where state is read from.** The write landed in one harness's
 * `proposals` map and the post-check read another's, which is exactly what the
 * trace printed — `call h#10 propose proposals 1->1   read h#11 proposals 0`,
 * two ids, one line. It fails ONLY in the full suite because alone in this file
 * every test builds exactly one harness before using it, so "the last one
 * built" and "mine" are the same object; add a second harness and they are not.
 * **`C222 REPRODUCED` below makes that deterministic, in one file, with no
 * suite** — and it fails with the row's own signature, `ids on chain (0): none`.
 *
 * **THE FIX IS IN THE HARNESS, NOT IN WHAT THE HARNESS WIRES UP.** Nothing in
 * `src/` changed and nothing in `src/` was wrong: `connect`'s lazy import is
 * correct for the product, where there is one implementation of that module and
 * not one per test. What was wrong was a test fixture that made a per-instance
 * seam module-global. So the mocks are registered ONCE, here, and they are
 * STATELESS — they read the harness off the providers bundle the ledger was
 * constructed with, which is the only per-ledger handle that reaches them:
 * `connect` passes `await this.providers()` straight into
 * `findDeployedPartialContract`.
 */
const HARNESS = Symbol('harness');

const callTxOf = (providers: any) => {
  const bound = providers?.[HARNESS];
  if (!bound) {
    /*
     * Refused rather than defaulted. A ledger whose providers carry no harness
     * is a ledger nothing in this file built, and answering it with SOME
     * harness's `callTx` is the defect this whole block exists to remove.
     */
    throw new Error(
      'these providers carry no harness, so there is no callTx that belongs to them. ' +
      'Every ledger under test is built by harness(); binding one to the most recently ' +
      'constructed harness instead is C222.');
  }
  return bound.callTx;
};

/*
 * The generated module and the SDK are both replaced, so nothing here needs a
 * network. `ledger` is faked down to identity — the test supplies the parsed
 * public state directly — while `pureCircuits` is the REAL one, so every
 * commitment this class produces is the one the chain would.
 *
 * Registered at module scope and never re-registered: these factories hold no
 * per-test state, so there is nothing for a later `harness()` call to overwrite.
 */
vi.doMock('../../contracts/managed/contract/index.js', () => ({
  ledger: (d: any) => d,
  pureCircuits,
}));
vi.doMock('@midnight-ntwrk/midnight-js-contracts', () => ({
  findDeployedContract: async (providers: any) => ({ callTx: callTxOf(providers) }),
}));
/*
 * S8c: `connect` goes through the partial-aware find now — the SDK's
 * `findDeployedContract` refuses a partial deployment outright — so the seam
 * this harness replaces moved with it. Same shape: hand back the fake `callTx`
 * BELONGING TO THESE PROVIDERS and let the class's own logic run.
 */
vi.doMock('./partial-contract.js', async () => ({
  /*
   * **THE REAL MODULE FIRST, AND ONLY WHAT NEEDS A NETWORK IS REPLACED.**
   * `S40`, 2 Sep.
   *
   * This factory returned `findDeployedPartialContract` ALONE, so the module
   * `MidnightLedger.open` imports at `ledger.ts:488-489` carried no
   * `requireMaintenanceAuthority` — a pure validator with no network in it,
   * removed by a mock that never meant to touch it. A test reaching `open`'s
   * next gate would have died on `requireMaintenanceAuthority is not a
   * function` and read as a refusal from the class under test. **A module mock
   * that removes a GUARD is how a check stops being exercised without anybody
   * deleting it**, and the spread is what stops the next export added to that
   * module from disappearing the same way.
   *
   * `submitPartialDeployTx` IS still replaced, and with a refusal rather than a
   * stub: it is the one export here that reaches a chain, and this harness has
   * none.
   */
  ...(await vi.importActual<typeof import('./partial-contract.js')>('./partial-contract.js')),
  findDeployedPartialContract: async (providers: any) => ({ callTx: callTxOf(providers) }),
  submitPartialDeployTx: async () => {
    throw new Error(
      'submitPartialDeployTx was reached in a unit test and this harness has no chain. '
      + 'Nothing in ledger.test.ts deploys: a test that gets this far has passed every '
      + 'guard open() has, and wants a harness that was built to answer a node.');
  },
}));

/** A chain whose state we control, and which records every circuit call. */
function harness(chain: {
  /*
   * `assets` STOOD HERE — the on-chain balance map, defaulting to one entry.
   * `C292`, `S26`: the contract has no `assetBalances` map, so a fake chain
   * that still handed one over would be a fake carrying a field the deployed
   * contract does not have. That is the same defect as the `proposeRun` stub
   * that outlived its circuit (S11b), pointing the other way.
   */
  /** Every proposal open at once. M-128 — there is no longer "the" open one. */
  openProposals?: Array<{ id: Hex; change: Hex }>;
  approvals?: bigint;
  threshold?: bigint;
  /**
   * **THE VAULTS SOMEBODY GAVE THEIR OWN THRESHOLD.** `R5b`, and the default is
   * an EMPTY map rather than a missing one — which is the state every account
   * is in, and is not the same state as a map the reader did not hand over.
   *
   * **THIS FIELD WAS ABSENT AND THAT IS WHY 35 TESTS FAILED.** The comment on
   * the fake state below already said what the rule was — *"a fake chain that
   * omitted one the deployed contract has is a fake that lets a broken read
   * pass"* — and `R5` added a field to the contract's decoded state without
   * adding it here. It did not let a broken read pass; it threw. The rule holds
   * either way and this is the entry it was missing.
   *
   * `null` to simulate the reader NOT handing the map over at all, which is the
   * case `mapField` exists to refuse.
   */
  vaultThresholds?: Array<[Hex, bigint]> | null;
  /**
   * **THE FOURTH MAP.** `C188`, and it is an option here for the same reason
   * `vaultThresholds` is: `null` simulates the reader NOT handing it over,
   * which is the case the boundary must refuse rather than read as *nobody has
   * approved anything*.
   */
  approvalCounts?: null;
  /* THREE READS, ONE RULE: `null` omits the accessor entirely, which the
   * boundary must REFUSE rather than read as zero. Seats are
   * `signerLeaves.size()` since S35c; `T-220`/`S52` added completions and
   * `retiredAt`'s KEYS — *ever* retired, not *is* (`C362`) — for `T-183`. */
  signerCount?: bigint | null;
  movementCount?: bigint | null;
  retiredVaults?: Array<[Hex, bigint]> | null;
  /*
   * `balanceAfterMove` STOOD HERE — what an asset's entry became once `execute`
   * landed, so a chain committing to a DIFFERENT balance could be simulated.
   * `C292`, `S26`: no circuit moves a balance and no map records one.
   */
  /** What the chain records for a proposal, so a mismatch can be exercised. */
  changeOnPropose?: Hex;
  /** False to simulate a propose that produced no proposal on chain. */
  proposeLands?: boolean;
  /**
   * True to make the state read AFTER the first circuit call come back empty,
   * while the read before it still works.
   *
   * `propose`'s post-check has two ways to find nothing — a read that returned
   * nothing, and a read that returned a state holding no matching id — and they
   * are diagnosed in opposite directions. Simulating them separately is the
   * only way to pin that the refusal names the right one.
   */
  stateGoneAfterCall?: boolean;
  /** Omit to simulate a device that holds no private state for this account. */
  privateState?: Record<string, unknown> | null;
},
/**
 * **THE DEPLOYMENT BAG, AND IT IS A SEPARATE ARGUMENT BECAUSE IT IS A SEPARATE
 * CONSTRUCTOR SLOT.** `S40`, 2 Sep.
 *
 * `undefined` by default, which is what every test here but `C334`'s four
 * wants: a client that only calls an existing account has no business holding
 * deployment credentials, and `open` is the only method that reads them
 * (`ledger.ts:377`, `:518`, `:608`, `:610`, `:637`). **Re-anchored by `S35d`**,
 * which rewrote `open`'s threshold refusal and its justification and moved
 * everything below them; `C366`.
 *
 * Typed off the constructor by POSITION rather than restated, so a slot
 * inserted before it changes this type instead of silently re-aiming the
 * argument — which is the defect this parameter exists to close.
 */
deployment?: ConstructorParameters<typeof MidnightLedger>[6]) {
  const harnessId = ++HARNESS_SEQ;
  const calls: Array<{ circuit: string; args: unknown[] }> = [];
  const proposals = new Map<Hex, Hex>(
    (chain.openProposals ?? [{ id: PROPOSAL_ID, change: CHANGE_COMMITMENT }])
      .map(p => [p.id, p.change] as [Hex, Hex]),
  );

  const record = (circuit: string) => async (...args: unknown[]) => {
    calls.push({ circuit, args });
    const proposalsBefore = proposals.size;
    /*
     * AN `execute` BRANCH STOOD HERE, moving ONE asset's entry and leaving
     * every other exactly as it was — M-125 seen from the chain's side.
     * `C292`, `S26` removed the circuit and the map it wrote.
     */
    // Cancelling REMOVES the proposal rather than zeroing a flag beside it,
    // which is why presence is the whole answer to "is it open".
    if (circuit === 'cancel') proposals.delete(toHex(args[0] as Uint8Array) as Hex);
    if (circuit === 'closeExpiredRun') {
      proposals.delete(toHex(args[0] as Uint8Array) as Hex);
    }
    if (circuit === 'propose' && (chain.proposeLands ?? true)) {
      /*
       * The id the MERGED contract keys it under (S11): one circuit, two
       * derivations, and `args[5]` — `isRun` — picks between them exactly as
       * the contract's own branch does. THE CONTRACT IS THE AUTHORITY for
       * this shape; a fake chain still modelling the pre-merge siblings is
       * how twelve tests failed while the wiring under test was right.
       *
       * The run path builds its payload from the call's OWN four parts plus
       * the vault it names — written out the long way on purpose: a run has
       * four ways to produce an id nobody can pay against, and a fake chain
       * that shortcut this would hide all of them. The opaque path commits
       * the payload hash it was just given under the proposer's salt and THE
       * VAULT THIS CALL NAMED — from the call's own arguments rather than
       * from what the code under test believes it sent, so agreement is a
       * fact about the wire, not a coincidence of shared constants.
       */
      proposals.set(
        (args[5] as boolean)
          ? MidnightCommitments.proposalId(
              MidnightCommitments.runPayload(
                toHex(args[1] as Uint8Array),
                args[2] as bigint, args[3] as bigint, args[4] as bigint),
              CHANGE.salt,
              toHex(args[6] as Uint8Array))
          : MidnightCommitments.proposalId(
              toHex(args[0] as Uint8Array), CHANGE.salt, toHex(args[6] as Uint8Array)),
        chain.changeOnPropose ?? CHANGE_COMMITMENT,
      );
    }
    TRACE.push(`call h#${harnessId} ${circuit} proposals ${proposalsBefore}->${proposals.size}`);
    return { public: { txId: 'tx_deadbeef' } };
  };

  // Declared with rest parameters so Function.length is 0, exactly like the
  // generated interface. M-38: a stub written any other way shares the guard's
  // blind spot.
  const callTx: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    /*
     * `execute` WAS FAKED HERE AND IS NOT ANY MORE. `C292`, `S26`, and the
     * check below is why it had to go in the same turn: S11b's rule is that
     * the fake must not outlive the contract it fakes. It survives that check
     * TODAY only because `contracts/managed/` is the previous compile and
     * still declares it — which is a stale artefact, not a licence.
     */
    propose: record('propose'),
    approve: record('approve'),
    cancel: record('cancel'),
    closeExpiredRun: record('closeExpiredRun'),
  };
  /*
   * THE FAKE MUST NOT OUTLIVE THE CONTRACT IT FAKES. S11b.
   *
   * This harness held a `proposeRun` stub after the S11 merge deleted the
   * circuit, and the stub stayed reachable enough to feed undefineds into the
   * real `runPayload` — while the `propose` stub, still modelling the
   * pre-merge two-argument shape, derived plausible ids that belonged to no
   * contract anywhere. So every name faked here is checked against the real
   * compiled ABI at construction: the next merge fails THIS line, by name,
   * instead of twelve tests by arithmetic. Same lesson as M-38 — a stub
   * written from the code's own wrong model checks nothing — enforced where
   * this file builds its model.
   */
  {
    const declared = arityFrom(CFG.zkConfigPath);
    for (const name of Object.keys(callTx)) {
      if (declared(name) === null) {
        throw new Error(
          `harness fakes circuit "${name}", which the compiled contract does not declare`);
      }
    }
  }

  const submits: unknown[] = [];
  const sponsor: FeeSponsor = {
    addFeeAndFinalise: async (tx) => tx,
    submit: async (tx) => { submits.push(tx); return { ref: 'sponsor_submit', at: '' }; },
    capacity: async () => ({ dust: 0n, night: 0n }),
  };

  const puts: Array<{ commitment: Hex; keyEpoch: number }> = [];
  const blobs: SealedStateStore = {
    put: async (_id, c, keyEpoch) => { puts.push({ commitment: c, keyEpoch }); },
    get: async () => SEALED_BYTES,
  };

  // What `stageChange` wrote, so a test can assert the witnesses actually
  // reached the place the circuit reads them from. `stageView` wrote here too
  // until `C292`/`S26` removed it with the balance opening it staged.
  const staged: Array<{ key: string; value: any }> = [];
  // Every contract address the class set on the provider before staging. C228.
  const addressed: string[] = [];
  const held = chain.privateState === undefined
    ? {
        secretKey: new Uint8Array(32),
        blinding: new Uint8Array(32),
        /*
         * The account's, not this signer's, and every signer holds the same
         * one. M-125: it is what turns an asset code into the opaque key the
         * contract derives, and `changeCommitmentOf` still needs it on every
         * propose.
         *
         * `current: null` and `next: null` stood beside it and went with the
         * balance opening they held. `C292`, `S26` removed both fields from
         * `AccountPrivateState`.
         */
        assetBlinding: fromHex(ASSET_BLINDING),
      }
    : chain.privateState;

  const providers = async () => ({
    /*
     * **WHICH HARNESS THIS BUNDLE BELONGS TO.** `C222`.
     *
     * The module mock reads `callTx` from here rather than from a closure, so
     * a ledger is served by the harness it was CONSTRUCTED with and by no
     * other. A symbol key, so nothing in `MidnightLedger` can see it, spread
     * it away or collide with it — the class passes this object straight
     * through to `findDeployedPartialContract`, which is the whole mechanism.
     */
    [HARNESS]: { id: harnessId, callTx },
    publicDataProvider: {
      queryContractState: async () => {
        /*
         * **WHICH HARNESS ANSWERED THIS READ, AND WHAT IT HELD.** `X21`, and
         * the other half of the line `record` writes. A read that reports a
         * different `h#` from the call that preceded it is the whole finding;
         * the same `h#` with `proposals 0` is a different finding entirely.
         */
        if (chain.stateGoneAfterCall && calls.length > 0) {
          TRACE.push(`read h#${harnessId} state withheld`);
          return null;
        }
        TRACE.push(`read h#${harnessId} proposals ${proposals.size}`);
        return {
          data: {
            /*
             * The contract's public fields, as the generated reader hands them
             * over: maps that iterate as [key, value] pairs of raw bytes. A fake
             * chain that omitted one the deployed contract has is a fake that
             * lets a broken read pass — and a fake that hands over one the
             * deployed contract does NOT have is the same defect pointing the
             * other way. `assetBalances` was here and went with the map
             * (`C292`, `S26`), so the reader below is asked for three maps and
             * gets three.
             */
            openProposals: [...proposals].map(([id, change]) => [fromHex(id), fromHex(change)]),
            /*
             * **A MAP THAT ITERATES AS WELL AS LOOKS UP, BECAUSE THE GENERATED
             * READER'S DOES.** `C188`, and this fake used to declare only
             * `lookup` — which is precisely the half `mapField` cannot check,
             * so a harness shaped like this could never have caught the
             * unguarded read. `contracts/managed/contract/index.d.ts:281-287`.
             *
             * `null` here means the reader handed the map over not at all,
             * the same case `vaultThresholds: null` covers one map along.
             */
            approvalCounts: chain.approvalCounts === null ? undefined : {
              lookup: (_id: Uint8Array) => chain.approvals ?? 2n,
              [Symbol.iterator]: function* () {
                for (const id of proposals.keys()) yield [fromHex(id), chain.approvals ?? 2n];
              },
            },
            threshold: chain.threshold ?? 2n,
            /*
             * `thresholds` in the contract, `vaultThresholds` on our boundary.
             * `[Uint8Array, bigint]` pairs, matching the generated reader's own
             * declared iterator (`contracts/managed/contract/index.d.ts:277`).
             * `null` here means the reader handed nothing over. `R5b`.
             */
            thresholds: chain.vaultThresholds === null
              ? undefined
              : (chain.vaultThresholds ?? []).map(([v, t]) => [fromHex(v), t]),
            /*
             * `signerLeaves`, because S35c deleted `signerCount` and the
             * boundary derives it with `.size()`. The dial above keeps its name:
             * what a test wants to say is "this chain has N signers", and which
             * field answers that is the boundary's business. `null` omits the
             * accessor, which is the reader handing over less than it declares.
             */
            signerLeaves: chain.signerCount === null ? undefined : { size: () => chain.signerCount ?? 3n },
            movements: chain.movementCount === null ? undefined : { size: () => chain.movementCount ?? 0n },
            retiredAt: chain.retiredVaults === null ? undefined : (chain.retiredVaults ?? []).map(([v, t]) => [fromHex(v), t]),
          },
        };
      },
    },
    privateStateProvider: {
      /*
       * S8c/C228: the class now sets the contract address explicitly before
       * every private-state read or write, so the stub must accept the call.
       * Recorded rather than ignored, so a test can assert the address was
       * set — and set to the account's OWN address — before anything staged.
       */
      setContractAddress: (address: string) => { addressed.push(address); },
      get: async () => held,
      set: async (key: string, value: any) => { staged.push({ key, value }); },
    },
  });

  /*
   * The module mocks are registered ONCE, at module scope, and they read this
   * harness's `callTx` off the providers bundle. See `HARNESS` — a factory that
   * closed over `callTx` here is `C222`.
   */

  /*
   * **SLOT SIX IS `compiled`. IT IS NOT THE DEPLOYMENT BAG, AND READING IT AS
   * ONE MADE FOUR `C334` TESTS UNREACHABLE FOR TWO DAYS.** `S40`, 2 Sep.
   *
   * The constructor takes SEVEN arguments (`ledger.ts:291-340`) and this call
   * passed six: `{}` landed on `compiled`, `deployment` was `undefined`, and
   * `open`'s first guard refused every opening before any `C334` refusal could
   * fire. **`tsc` cannot see it** — `compiled` is typed `unknown` so it accepts
   * anything, and `deployment` is optional so its absence is legal. This is the
   * positional-argument trap `BACKLOG.md` already records against
   * `vault-ledger.test.ts`: a hand-written double is the one place this
   * repository cannot lean on the compiler, so the slots are named here
   * instead.
   */
  const ledger = new MidnightLedger(
    CFG,
    sponsor,
    blobs,
    async () => 'addr_1',
    providers as any,
    /* compiled — nothing in this file calls a circuit through it. */ {},
    deployment,
  );
  /*
   * A `sendTransition` SEAM STOOD HERE — one deliberately ugly cast, reaching
   * past the boundary at the transition half that `R6` had left with no public
   * door. `C292`, `S26`: the half it reached is gone, so the seam is gone with
   * it rather than being pointed somewhere else. **A cast that survives the
   * thing it was built to reach is how a test file acquires a door nobody
   * decided on.**
   */
  return { ledger, calls, submits, puts, staged, addressed };
}

/**
 * **THE FOUR RULES THE TRANSITION HALF WAS THE ONLY CARRIER OF.** `C292`, `S26`.
 *
 * `describe('MidnightLedger: the transition half, built and unreachable')` stood
 * here with NINE tests, driving `sendTransition` through a harness seam, and
 * `describe('MidnightLedger.settleRound')` stood after it with one. Both are
 * deleted: `settleRound`, `sendTransition`, `stageState`, `checkAfter`,
 * `viewDigestAfter` and the contract's `execute` are gone, and a test aimed at
 * a method that does not exist is not coverage.
 *
 * **FIVE OF THE NINE WERE ABOUT THE BALANCE AND ARE SIMPLY GONE.** Named, so
 * nobody has to reconstruct them from a diff:
 *
 *   · `M-27: passes the proposal id and nothing else — never a commitment`.
 *     It pinned that `execute` was called with the public proposal id and NOT
 *     with a balance commitment, which would have published every company's
 *     balance on the network. There is no such argument and no such circuit.
 *   · `writes the blob before touching the chain, under the digest the CONTRACT
 *     computes`. Decision 0002's *a commitment with no blob is an account
 *     nobody can open*, applied to `stageState`. **The DECISION is not
 *     repealed** — `src/midnight/ledger.ts` says so where the three methods
 *     stood, and the vault path is where it is next spent — but nothing in this
 *     class writes a blob before a call any more, so there is nothing here to
 *     point it at.
 *   · `M-29: stages the view and the next state where the witnesses will find
 *     them`. The `current`/`next` half is gone. **Its other half survives
 *     below**: `M-70: stages the approved change at propose time` makes the
 *     same claim about `stageChange`, which is the staging this class still
 *     does, and `private-state-addressing.test.ts` holds the C228 half.
 *   · `M-29: refuses when that proposal is not open`. Covered twice over by
 *     `approve refuses when that proposal is not open` and by `prepare`'s
 *     `refuses before doing any work, not after`, both below.
 *   · `M-29: fails loudly when the chain ends up committing to a different
 *     balance`. `checkAfter`, comparing the commitment the chain then held
 *     against the one the opening produced. There is no per-asset commitment on
 *     chain to compare against, so the check has no subject.
 *
 * **THE FOUR BELOW ARE NOT ABOUT MONEY AND HAD NO OTHER CARRIER IN THIS FILE.**
 * Each is repointed onto a surviving circuit that reaches the same line of
 * `MidnightLedger` the deleted test did — `buildCall`, `stageChange`,
 * `requireApproved`, `txRef` — so the rule is exercised by the same code path
 * and only the caller changed.
 */
describe('MidnightLedger: the rules the transition half was the only carrier of', () => {
  it('M-28: does not submit a second time; callTx already submitted', async () => {
    /*
     * REPOINTED FROM `sendTransition` ONTO `approve`. The rule is `buildCall`'s
     * and belongs to every circuit alike: the SDK's `callTx` PROVES, BALANCES
     * AND SUBMITS, and this class must not submit the result again. It read the
     * other way once, and `publish` acted on it — that is M-28, and
     * `src/midnight/ledger.ts` still carries the note above `buildCall`.
     *
     * `approve` is the substitute because it is the shortest path through
     * `buildCall`, and there is no path through it that submits differently.
     */
    const { ledger, submits } = harness({});
    await ledger.approve('acct', PROPOSAL_ID, BY);
    expect(submits).toEqual([]);
  });

  it('M-29: refuses when the device holds no private state for the account', async () => {
    /*
     * REPOINTED FROM `sendTransition` ONTO `propose`. Both reached the same
     * method: `stageChange` reads the device's record, and refuses rather than
     * writing a fresh one, because a stage that invents a record replaces the
     * secret key and blinding that are the signer's only way back into their
     * own account.
     *
     * `propose` is the substitute because it is the surviving caller of
     * `stageChange` — the same line, from the door that is still open.
     */
    const { ledger, calls } = harness({ openProposals: [], privateState: null });
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault()))
      .rejects.toThrow(/no private state/);
    // And nothing reached the chain, which is the half that costs a fee.
    expect(calls).toHaveLength(0);
  });

  it('M-29: refuses below the threshold, before spending anything', async () => {
    /*
     * REPOINTED FROM `sendTransition` ONTO `prepare({ kind: 'setThreshold' })`.
     *
     * `requireApproved` is untouched by this round and has FOUR live callers —
     * `addSigner`, `setThreshold`, `setVaultThreshold`, `removeSigner`
     * (`src/midnight/ledger.ts:1218`, `:1251`, `:1278`, `:1304`) — and this was
     * the only test of THIS CLASS's refusal anywhere in `src/`. It says the
     * same thing through one of the four. (The contract has a circuit helper of
     * the same name; `contracts/test/` covers that one, and it is not this.) The same refusal discovered on chain costs a
     * block time, a fee and the proving before it.
     */
    const { ledger, calls } = harness({ approvals: 1n, threshold: 2n });
    await expect(ledger.prepare('acct', {
      kind: 'setThreshold', newThreshold: 3, proposalId: PROPOSAL_ID,
    })).rejects.toThrow(/1 of 2 approvals/);
    expect(calls).toHaveLength(0);
  });

  it('returns the transaction id from the call, not a fabricated one', async () => {
    /*
     * REPOINTED FROM `sendTransition` ONTO `approve`. `txRef` reads the id out
     * of whichever field this SDK version answers in, and every method on this
     * class returns through it. A fabricated id is worse than none: it is a
     * handle a person can look up and never find.
     */
    const { ledger } = harness({});
    const ref = await ledger.approve('acct', PROPOSAL_ID, BY);
    expect(ref.ref).toBe('tx_deadbeef');
  });
});

describe('MidnightLedger: the rest of the round', () => {
  it('propose passes the payload hash and the no-vault scope, and nothing else', async () => {
    /*
     * V-32 ADDED THE SECOND ARGUMENT, and the name of this test used to say
     * "and nothing else" about one argument. A proposal now names the vault it
     * concerns, and the value this boundary must pass is `noVault()` — nothing
     * reachable from here raises a proposal against a vault, and passing a real
     * vault by accident would make the proposal claimable by that vault's
     * signers at that vault's threshold.
     *
     * The sentinel is asserted EXPLICITLY rather than by re-reading whatever
     * the ledger passed: the point is which scope, not that some scope arrived.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault());
    expect(calls).toHaveLength(1);
    expect(calls[0].circuit).toBe('propose');
    expect(calls[0].args).toHaveLength(7);
    expect(argHex(calls[0].args[0])).toBe(PAYLOAD_HASH);
    /*
     * S11: one merged circuit, so the run's four slots and the discriminator
     * travel too. `isRun` is false and the fillers are zero — the branch that
     * would read them is not taken, the same pattern `addSigner`'s bootstrap
     * path already used. The vault sentinel is still asserted EXPLICITLY:
     * the point is which scope, not that some scope arrived.
     */
    expect(argHex(calls[0].args[1])).toBe('00'.repeat(32));
    expect(calls[0].args[2]).toBe(0n);
    expect(calls[0].args[3]).toBe(0n);
    expect(calls[0].args[4]).toBe(0n);
    expect(calls[0].args[5]).toBe(false);
    expect(argHex(calls[0].args[6])).toBe(toHex(pureCircuits.noVault()));
  });

  /*
   * X20. THE TWO WAYS `propose`'S POST-CHECK FINDS NOTHING, PINNED SEPARATELY.
   *
   * `landed` is undefined either because the state read came back empty — so
   * nothing was ever searched — or because a state arrived and holds no
   * matching id. A read that failed and a commitment that disagrees are
   * diagnosed in opposite directions, and one message for both is what made a
   * real failure in the full suite unreadable: it named neither, and there was
   * no test here that made it name either.
   */
  it('X20: says the state could not be read back when the post-check read returns nothing', async () => {
    const { ledger } = harness({ openProposals: [], stateGoneAfterCall: true });
    const failed = await ledger
      .propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault())
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/could not be read back/);
    // And NOT the other branch's words: naming the wrong fault is the defect.
    expect(failed?.message).not.toMatch(/has no open proposal with this id/);
    expect(failed?.message).toContain(`looked for id: ${PROPOSAL_ID}`);
    expect(failed?.message).toContain('state read back: none');
  });

  it('X20: says no id matched, and prints the id looked for beside the ids held', async () => {
    // Any payload but this test's, so the id differs from PROPOSAL_ID. It used
    // to be derived from `VIEW_AFTER`, which went with the balance map
    // (`C292`, `S26`); nothing here ever needed that value to BE a view digest.
    const OTHER = MidnightCommitments.proposalId('99'.repeat(32) as Hex, CHANGE.salt);
    const { ledger } = harness({
      openProposals: [{ id: OTHER, change: CHANGE_COMMITMENT }],
      proposeLands: false,
    });
    const failed = await ledger
      .propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault())
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toMatch(/has no open proposal with this id/);
    expect(failed?.message).not.toMatch(/could not be read back/);
    expect(failed?.message).toContain(`looked for id: ${PROPOSAL_ID}`);
    // The ids actually held, so a mismatch can be READ rather than guessed at.
    expect(failed?.message).toContain(`ids on chain (1): ${OTHER}`);
  });

  it('X20: says how many ids were held when the chain holds none at all', async () => {
    const { ledger } = harness({ openProposals: [], proposeLands: false });
    const failed = await ledger
      .propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault())
      .then(() => null, (e: Error) => e);
    expect(failed?.message).toContain('ids on chain (0): none');
  });

  it('M-70: stages the approved change at propose time, not just at execute time', async () => {
    // The circuit reads the change from private state here too. Without
    // staging, the round reaches its threshold and can then never settle —
    // with the fees already paid.
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault());
    expect(staged).toHaveLength(1);
    expect(staged[0].value.changeAmount).toBe(20_000n);
    // Which asset leaves, because since M-125 that is part of what the signers
    // approve rather than something the executor picks.
    expect(staged[0].value.assetId).toEqual(assetIdBytes(ASSET));
    // The proposer's salt, which execute must reuse or nothing settles.
    expect(staged[0].value.proposalSalt).toBeInstanceOf(Uint8Array);
  });

  /*
   * "propose refuses while a round is already open" USED TO BE HERE, and M-128
   * DELETED THE RULE IT CHECKED rather than the check drifting out of use.
   *
   * The contract permitted exactly one open proposal per account, so this class
   * refused early to save a block time and a fee. That single-proposal limit is
   * what stopped an admin raising a vendor invoice while payroll collected
   * signatures, and it is gone: `openProposals` is a map keyed by proposal id
   * and nothing anywhere refuses a second one. The test below is the same fact
   * from the other side.
   */
  it('M-128: a second proposal may be raised while the first is still collecting approvals', async () => {
    const { ledger, calls } = harness({});
    const invoice = 'dd'.repeat(32) as Hex;
    await ledger.propose('acct', invoice, CHANGE, BY, MidnightCommitments.noVault());
    expect(calls.map(c => c.circuit)).toEqual(['propose']);
  });

  it('propose fails loudly when the chain records a different change', async () => {
    /*
     * Every approval gathered against a proposal whose recorded change is not
     * the one supplied is unusable, and the round can never settle. Found by
     * id, because "the change the chain recorded" is only a question about one
     * proposal now — asking it of the account would compare this proposal
     * against whichever was written last. M-128.
     */
    const { ledger } = harness({ openProposals: [], changeOnPropose: OTHER });
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault()))
      .rejects.toThrow(/recorded a different change/);
  });

  it('approve names the proposal, and nothing about the signer', async () => {
    /*
     * One argument, and it is public on chain already. WHO approved is still
     * absent: the nullifier is H(domain, address, proposal, secretKey), derived
     * inside the circuit from a secret that never leaves the device. M-128 made
     * this take the proposal id because an account holds several at once, and
     * approving payroll is no longer the same act as approving whatever else
     * happens to be open.
     */
    const { ledger, calls } = harness({});
    await ledger.approve('acct', PROPOSAL_ID, BY);
    expect(calls[0].circuit).toBe('approve');
    expect(calls[0].args).toHaveLength(1);
    expect(argHex(calls[0].args[0])).toBe(PROPOSAL_ID);
  });

  it('approve refuses when that proposal is not open', async () => {
    const { ledger } = harness({ openProposals: [] });
    await expect(ledger.approve('acct', PROPOSAL_ID, BY)).rejects.toThrow(/no open proposal/);
  });

  it('cancel closes the proposal it names, and only that one', async () => {
    const other = 'ab'.repeat(32) as Hex;
    const { ledger, calls } = harness({
      openProposals: [
        { id: PROPOSAL_ID, change: CHANGE_COMMITMENT },
        { id: other, change: CHANGE_COMMITMENT },
      ],
    });
    await ledger.cancel('acct', PROPOSAL_ID, BY);
    expect(calls[0].circuit).toBe('cancel');
    expect(argHex(calls[0].args[0])).toBe(PROPOSAL_ID);
    // The other proposal is untouched: there is no round to rotate, so nobody
    // else's approvals are burned. M-128.
    expect((await ledger.status('acct'))?.openProposals.map(p => p.id)).toEqual([other]);
  });

  it('status reports every open proposal, and no assets at all', async () => {
    /*
     * `proposalOpen`/`proposal`/`proposedChange`/`approvalCount` USED TO BE
     * FOUR SCALAR FIELDS here, and the old test checked that a closed round
     * reported `proposal: null` — the contract zeroed the field rather than
     * clearing it, so reporting the stale bytes would have let a caller believe
     * a closed round was open. M-128 made a settled proposal ABSENT from the
     * map, so presence is the whole answer and there is no stale value to
     * misread.
     */
    const other = 'ab'.repeat(32) as Hex;
    const open = harness({
      openProposals: [
        { id: PROPOSAL_ID, change: CHANGE_COMMITMENT },
        { id: other, change: OTHER },
      ],
      approvals: 1n,
      threshold: 2n,
    });
    expect(await open.ledger.status('acct')).toEqual({
      /*
       * **EMPTY, ALWAYS, AND READ OFF THE CONTRACT RATHER THAN ASSUMED.**
       * `C292`, `S26`. The account keeps no book, so there is no map of
       * per-asset commitments to report and nothing that could put an entry
       * here. The field stays on `LedgerStatus` because it is the shape both
       * implementations answer in (`src/core/ledger.ts:911` is the simulated
       * one saying the same thing).
       *
       * This assertion used to name one asset at its balance commitment. It is
       * kept as `[]` rather than dropped from the whole-object `toEqual`,
       * because a field silently disappearing from a boundary is exactly what
       * `R5b` added this style of assertion to catch.
       */
      assets: [],
      openProposals: [
        { id: other, change: OTHER, approvals: 1 },
        { id: PROPOSAL_ID, change: CHANGE_COMMITMENT, approvals: 1 },
      ].sort((x, y) => x.id.localeCompare(y.id)),
      threshold: 2,
      /*
       * **ASSERTED RATHER THAN TOLERATED.** `R5b`, and `T-220`/`S52` is the
       * second round it caught: a whole-object `toEqual`, so every field the
       * boundary grows makes it fail — one that grows silently is one whose
       * readers each discover it separately. Empty and zero are STATEMENTS,
       * not defaults; the `null` dials tell them from a field never sent.
       */
      vaultThresholds: [],
      signerCount: 3,
      movementCount: 0,
      retiredVaults: [],
    });

    const quiet = harness({ openProposals: [] });
    const status = await quiet.ledger.status('acct');
    // An account proposing nothing reports two empty lists — and the empty
    // asset list is not a zero balance. "Holds none" and "has never held" were
    // already the same fact to this boundary; since `C292` the chain is not
    // asked at all.
    expect(status?.openProposals).toEqual([]);
    expect(status?.assets).toEqual([]);
  });
});

/*
 * `describe('M-67: credit')` WAS HERE — four tests — AND S25 DELETED IT.
 *
 * `S23` shed the `credit` circuit from the contract. The harness above checks
 * every name it fakes against the compiled ABI (S11b: "the fake must not
 * outlive the contract it fakes"), so from the shed until now EVERY test in
 * this file failed at construction, not just these four. They are deleted
 * rather than pointed at a surviving circuit: what they asserted — that this
 * class drives `credit` as carefully as `execute` — is not a claim that can be
 * made about a circuit that does not exist.
 *
 * **`MidnightLedger.credit` NO LONGER EXISTS EITHER, AND NEITHER DOES THE
 * REFUSAL THAT REPLACED IT.** `C292`, `S26`. `S25` left it in place refusing by
 * name, because `AccountService.deposit` called it and whether the account keeps
 * a book of its own was the founder's to decide. It was decided — the account
 * keeps no books — so `deposit`, `Ledger.credit` and `MidnightLedger.credit`
 * went together, and there is no shape left here to pin.
 */

/**
 * M-38: the arity guard must fire against the REAL shape of a generated circuit
 * function, which is `(...args) => {}` and therefore has length 0.
 *
 * The first version of this test stubbed callTx with `(...args)` too, so it
 * shared the bug's blind spot and passed against a guard that could never fire.
 * This one asserts the guard rejects a wrong-arity call.
 */
describe('M-38: buildCall arity, against the real wrapper shape', () => {
  /*
   * THE ZERO-ARGUMENT HALF OF THIS GUARD IS NO LONGER REACHABLE, and the test
   * that exercised it is deleted rather than aimed at a circuit with
   * arguments. `credit()` was the contract's only zero-argument circuit and
   * S23 shed it; every circuit the contract now declares takes at least one.
   * A test passing ['deadbeef'] to any of them would exercise the WRONG arm of
   * the same guard, which the one below already covers.
   */

  /*
   * **BOTH OF THESE DROVE `execute` AND NOW DRIVE `approve`.** `C292`, `S26`.
   *
   * The guard is `buildCall`'s and knows nothing about which circuit it is
   * checking — it reads the declared arity out of the compiled
   * `contract-info.json` and compares. `approve` is the substitute because it
   * is the one-argument circuit `execute` was: the SAME arm of the SAME guard,
   * with the same expected message.
   *
   * Repointed rather than left, because `execute` is not a circuit any more:
   * the harness no longer fakes it, so these would have failed with
   * `no circuit "execute"` — the arity guard never reached, and the test
   * reporting green-adjacent noise about the wrong thing.
   */
  it('rejects a call that omits an argument the contract declares', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall('addr_1', 'approve', []),
    ).rejects.toThrow(/takes 1 argument/);
  });

  it('accepts the correct arity', async () => {
    const { ledger } = harness({});
    await expect(
      (ledger as any).buildCall('addr_1', 'approve', [fromHex(PROPOSAL_ID)]),
    ).resolves.toBeDefined();
  });

  it('V-73: the run circuits, against the REAL generated wrapper and not the harness stub', async () => {
    /*
     * The harness records calls without checking how many arguments a circuit
     * takes, so every test above would pass with a five-argument call built
     * wrong. This one goes at the generated contract, which is the only thing
     * that actually knows.
     */
    const { ledger } = harness({});
    /*
     * S11 merged `proposeRun` into `propose`: SEVEN declared arguments, and
     * the real `contract-info.json` is what says so. Yesterday's correct
     * five-argument call must be refused by the guard with the arity named —
     * not discovered by the runtime as an undefined halfway into
     * `runPayload`, which is exactly how this test failed when it still
     * believed in the sibling.
     */
    await expect((ledger as any).buildCall('addr_1', 'propose', [
      fromHex('00'.repeat(32)), fromHex('aa'.repeat(32)), 50n, 1_800_000_000n, 1_800_604_800n,
      true, fromHex('bb'.repeat(32)),
    ])).resolves.toBeDefined();
    await expect((ledger as any).buildCall('addr_1', 'propose', [
      fromHex('aa'.repeat(32)), 50n, 1_800_000_000n, 1_800_604_800n, fromHex('bb'.repeat(32)),
    ])).rejects.toThrow(/takes 7 argument/);
    // The sibling entry point is GONE from the contract, and a call to it
    // must fail BY NAME, not by a guess about its arguments.
    await expect((ledger as any).buildCall('addr_1', 'proposeRun', [
      fromHex('aa'.repeat(32)), 50n, 1_800_000_000n, 1_800_604_800n, fromHex('bb'.repeat(32)),
    ])).rejects.toThrow(/no circuit "proposeRun"/);
    await expect((ledger as any).buildCall('addr_1', 'closeExpiredRun', [fromHex(PROPOSAL_ID)]))
      .resolves.toBeDefined();
  });
});

describe('V-73: a payroll run, raised and swept through the client', () => {
  const RUN = {
    root: 'aa'.repeat(32) as Hex,
    payees: 50n,
    opensAt: 1_800_000_000n,
    closesAt: 1_800_604_800n,   // seven days later
    vault: 'bb'.repeat(32) as Hex,
  };

  const runId = () => MidnightCommitments.proposalId(
    MidnightCommitments.runPayload(RUN.root, RUN.payees, RUN.opensAt, RUN.closesAt),
    CHANGE.salt, RUN.vault);

  it('names the merged circuit, the run parts, isRun — and THE VAULT, not the sentinel', async () => {
    /*
     * The vault is committed inside the proposal's identity, so passing
     * `noVault()` here would not fail loudly. It would produce a proposal that
     * looks perfectly healthy, collects its approvals, and matches no payment
     * any vault can ever make.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await ledger.proposeRun('acct', RUN, CHANGE, BY);

    expect(calls).toHaveLength(1);
    /* S11: the run travels through the MERGED `propose`, `isRun` true. */
    expect(calls[0].circuit).toBe('propose');
    expect(calls[0].args).toHaveLength(7);
    /* The opaque payload slot is a filler the run branch never reads. */
    expect(argHex(calls[0].args[0])).toBe('00'.repeat(32));
    expect(argHex(calls[0].args[1])).toBe(RUN.root);
    expect(calls[0].args[2]).toBe(50n);
    expect(calls[0].args[3]).toBe(RUN.opensAt);
    expect(calls[0].args[4]).toBe(RUN.closesAt);
    expect(calls[0].args[5]).toBe(true);
    expect(argHex(calls[0].args[6])).toBe(RUN.vault);
    expect(argHex(calls[0].args[6])).not.toBe(toHex(pureCircuits.noVault()));
  });

  /*
   * **THE SLOT ORDER, READ OFF THE COMPILED ARTIFACT RATHER THAN WRITTEN OUT A
   * SECOND TIME.** `S54`, board row `2y7f2c`. `T-213` / `C375`'s client arm.
   *
   * **WHAT THE CASE ABOVE PINS, AND WHAT IT DOES NOT.** It asserts
   * `args[1] === RUN.root`, `args[3] === RUN.opensAt`, `args[4] === RUN.closesAt`
   * and so on — **against indices a person typed into this file.** So the
   * vector at `src/midnight/ledger.ts:1187-1190` and the expectations here are
   * TWO HAND-WRITTEN COPIES OF ONE SLOT ORDER, and they agree because the same
   * person wrote both. **A transposition applied to both in one edit is green
   * everywhere**, because nothing else in this file's reach ever asks the
   * contract what order it declared.
   *
   * **THAT IS `F6`'s SHAPE ON THE DOOR THAT PAYS** — `docs/scope-the-ledger-boundary.md`
   * §5 `F6` found the same pairwise pinning on `proposalId`'s arguments, where
   * `type Hex = string` hides a swap from the compiler. Here `payees`, `opensAt`
   * and `closesAt` are all `bigint` and `root`/`vault` are both `Bytes<32>`, so
   * **the compiler cannot see a swap among them either.**
   *
   * **WHY IT MATTERS ON THIS PARTICULAR VECTOR AND NOT MERELY IN PRINCIPLE.**
   * A run's identity is `proposalIdOf(runPayload(root, payees, opensAt,
   * closesAt), vault, salt)` (`contracts/src/ConfidentialAccount.compact:2198-2200`),
   * and `recordPayment` recomputes it from ITS OWN arguments (`:2672-2676`).
   * Transpose `opensAt` and `closesAt` here and the chain opens a run whose
   * window is inverted — `assert(opensAt < closesAt)` (`:2127`) refuses it, which
   * is loud — but transpose them in `MidnightLedger` ONLY, while
   * `MidnightCommitments` computes the id the honest way, and the client's
   * post-check at `src/midnight/ledger.ts:869-876` is what fires instead. **The
   * arity guard cannot see any of it: all seven slots are still there**
   * (`assertArity`, `src/midnight/ledger.ts:1809`).
   *
   * **SO THE THIRD PARTY IS THE ARTIFACT.** `contract-info.json` is the
   * compiler's own declaration of `propose`'s argument NAMES in order, and this
   * case maps value to slot BY NAME. **Nothing here is derived from
   * `src/midnight/ledger.ts` and nothing is typed twice**, so an edit to the
   * vector alone reddens it and an edit to the vector AND this file cannot make
   * them agree — the order is not ours to state. **Rule 41's own prescription:
   * read the fact from DATA.**
   *
   * `arityFrom` (`src/midnight/circuit-arity.ts:63`) reads this same file and
   * keeps only the COUNT, which is why the names are read here rather than
   * through it — and why this is a test-local read rather than a new production
   * export nothing in `src/` would call (`T-281`'s fault).
   *
   * **AND THE JUSTIFICATION IS MEASURED RATHER THAN ARGUED, WHICH IS THE ONLY
   * REASON THIS CASE EARNS ITS PLACE BESIDE THE ONE ABOVE.** `S54` transposed
   * `opensAt` and `closesAt` and ran this file three times:
   *
   *   1. **the vector alone** (`src/midnight/ledger.ts:1187-1188`) — 8 of 50
   *      red, this case among them, and so is the case above. Either would
   *      have caught a lone edit.
   *   2. **the vector plus the case above's typed indices** — still red,
   *      because a THIRD hand-written copy reads the same slots: the fake chain
   *      at `:429-431`, whose own comment claims *"agreement is a fact about
   *      the wire, not a coincidence of shared constants."* **It is not — it
   *      reads `args[3]` and `args[4]` exactly as the case above does.**
   *   3. **the vector plus BOTH typed copies, all three agreeing on the WRONG
   *      order — 49 of 50 GREEN, and the only red in this file is this case.**
   *      That is the whole of why it exists.
   *
   * Nothing was left transposed: `src/midnight/ledger.ts` was restored and
   * compared byte for byte, and this round edited none of it.
   */
  it('puts every run part in the slot the COMPILED ARTIFACT names for it, not the slot we typed',
    async () => {
      /*
       * **READ DYNAMICALLY, AND THE REASON IS `C393` RATHER THAN STYLE.** A
       * top-level `import` here adds two lines above `:794` and `:1125`, which
       * `docs/design/edges.json` cites — and a moved citation turns the doc set
       * stale and refuses EVERY test file in the repository until a person runs
       * `DOCS.command` (rule 38's gate). Measured, not assumed: the import was
       * written, the gate refused with those two line numbers, and it was taken
       * out again. `S54`.
       */
      const { readFileSync } = await import('node:fs');
      const info = JSON.parse(
        readFileSync(`${CFG.zkConfigPath}/compiler/contract-info.json`, 'utf8'));
      const declared: Array<{ name: string }> =
        info.circuits.find((c: { name: string }) => c.name === 'propose').arguments;

      /*
       * The artifact is only a third party if it really answered. A lookup that
       * silently returned nothing would make every assertion below vacuous,
       * which is the `M-38` failure this repository has already paid for once.
       */
      const slot = (name: string): number => {
        const i = declared.findIndex((a) => a.name === name);
        if (i < 0) throw new Error(`the compiled contract declares no argument "${name}" on propose`);
        return i;
      };
      expect(declared).toHaveLength(7);

      const { ledger, calls } = harness({ openProposals: [] });
      await ledger.proposeRun('acct', RUN, CHANGE, BY);
      const args = calls[0].args;

      expect(argHex(args[slot('root')])).toBe(RUN.root);
      expect(args[slot('payees')]).toBe(RUN.payees);
      expect(args[slot('opensAt')]).toBe(RUN.opensAt);
      expect(args[slot('closesAt')]).toBe(RUN.closesAt);
      expect(args[slot('isRun')]).toBe(true);
      expect(argHex(args[slot('vault')])).toBe(RUN.vault);
      /* The opaque slot the run branch never reads (`compact:2107`). */
      expect(argHex(args[slot('payloadHash')])).toBe('00'.repeat(32));

      /*
       * **AND THE FOUR RUN PARTS ARE DISTINCT VALUES, WHICH IS WHAT MAKES THE
       * ASSERTIONS ABOVE CAPABLE OF FAILING.** `T-116`'s lesson: a fixture
       * whose fields collide pins nothing, because a swap of two equal values
       * is invisible. `payees` is small and the two times are seconds apart, so
       * no two of them can be confused for one another.
       */
      expect(new Set([RUN.root, RUN.vault]).size).toBe(2);
      expect(new Set([RUN.payees, RUN.opensAt, RUN.closesAt]).size).toBe(3);
    });

  /*
   * **THE GOVERNANCE TWIN IS PINNED THE SAME WAY AND IT IS NOT THIS ROUND'S,
   * FOR A MEASURED REASON RATHER THAN A SCOPE ONE.** `S54`.
   *
   * `src/midnight/ledger.ts:1141-1146` has the identical two-copies defect on
   * the identical seven slots — `:781-794` above asserts it against indices
   * typed into this file — and it is the vector `C375` actually lived on
   * (`isRun: false`, `:1144`). **The case was written, run, and taken out
   * again.** Adding one invocation carrying a literal circuit name moves
   * `docs/design/ledger-fields.md`'s count from 525 to 526 and **995 lines of
   * `docs/design/edges.json`** — measured by the freshness gate refusing this
   * file, not estimated — which under rule 38 turns the doc set stale and
   * refuses EVERY test in the repository until a person runs `DOCS.command`.
   * **The run vector's own case above adds no such invocation**, because the
   * account contract declares no `proposeRun` circuit (`:1082-1084` pins that),
   * so pinning the half this row is FOR costs the doc set nothing.
   *
   * **A `DOCS.command` debt is not worth spending on a vector outside this
   * row's one subject.** `T-293` is this repository's precedent and its
   * disposal: a round already regenerating the doc set takes it. `BACKLOG.md`
   * carries the row.
   */
  it('hands back the id every approval and every payment will be made against', async () => {
    const { ledger } = harness({ openProposals: [] });
    const r = await ledger.proposeRun('acct', RUN, CHANGE, BY);
    expect(r.proposalId).toBe(runId());
  });

  it('stages the change, because the circuit reads it from private state', async () => {
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.proposeRun('acct', RUN, CHANGE, BY);
    expect(staged).toHaveLength(1);
    expect(staged[0].value.proposalSalt).toBeInstanceOf(Uint8Array);
  });

  it('REFUSES A WINDOW IN MILLISECONDS, which would build a run that opens in the year 56000',
    async () => {
    /*
     * The contract compares against `secondsSinceEpoch`. A JavaScript timestamp
     * passed straight through is approved, paid for, and unpayable, with
     * nothing anywhere to say why. The mistake costs one character to make.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: 1_800_000_000_000n, closesAt: 1_800_604_800_000n }, CHANGE, BY))
      .rejects.toThrow(/not a time in seconds|year 5/i);
    expect(calls).toEqual([]);
  });

  it('refuses a backwards window and an empty run before spending a fee', async () => {
    const { ledger, calls } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: RUN.closesAt, closesAt: RUN.opensAt }, CHANGE, BY))
      .rejects.toThrow(/no payment could ever fall inside it/i);
    await expect(ledger.proposeRun('acct', { ...RUN, payees: 0n }, CHANGE, BY))
      .rejects.toThrow(/at least one payee/i);
    expect(calls).toEqual([]);
  });

  it('SAYS SO when the run did not land, rather than returning an id nobody can pay', async () => {
    const { ledger } = harness({ openProposals: [], proposeLands: false });
    await expect(ledger.proposeRun('acct', RUN, CHANGE, BY))
      .rejects.toThrow(/no open proposal with this run's id/i);
  });

  it('SAYS SO when the chain recorded a different change', async () => {
    const { ledger } = harness({ openProposals: [], changeOnPropose: 'cd'.repeat(32) as Hex });
    await expect(ledger.proposeRun('acct', RUN, CHANGE, BY))
      .rejects.toThrow(/different change/i);
  });

  it('V-66: raise-and-approve is TWO transactions, because they are two acts', async () => {
    /*
     * The contract keeps the stricter meaning — auto-approving the proposer
     * would quietly turn a three-of-five into a two-of-five — so the client
     * closes the gap by doing both, visibly.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    const r = await ledger.raiseAndApproveRun('acct', RUN, CHANGE, BY);

    expect(calls.map(c => c.circuit)).toEqual(['propose', 'approve']);
    expect(argHex(calls[1].args[0])).toBe(r.proposalId);
    expect(r.approved).not.toBeNull();
    expect(r.approvalError).toBeUndefined();
  });

  it('V-66: SAYS SO LOUDLY when the run was raised and the approval did not land', async () => {
    /*
     * There is nothing to roll back to — the proposal is on chain. A caller who
     * believes they approved and did not is the exact confusion this method
     * exists to remove, so the half-done state is reported rather than thrown
     * away with the id.
     */
    const { ledger } = harness({ openProposals: [] });
    (ledger as any).approve = async () => { throw new Error('wallet said no'); };

    const r = await ledger.raiseAndApproveRun('acct', RUN, CHANGE, BY);
    expect(r.proposalId).toBe(runId());
    expect(r.approved).toBeNull();
    expect(r.approvalError).toMatch(/raised as .* YOUR APPROVAL DID NOT LAND.*wallet said no/is);
    expect(r.approvalError).toMatch(/open with no approvals/i);
  });

  it('sweeps an expired run by id, and takes it out of the open set', async () => {
    const { ledger, calls } = harness({ openProposals: [] });
    const r = await ledger.proposeRun('acct', RUN, CHANGE, BY);
    await ledger.closeExpiredRun('acct', r.proposalId, BY);

    const sweep = calls.find(c => c.circuit === 'closeExpiredRun');
    expect(sweep).toBeDefined();
    expect(argHex(sweep!.args[0])).toBe(r.proposalId);
  });

  it('does not pre-check the window before sweeping, because we have no second opinion on the time',
    async () => {
    /*
     * The contract asserts the window has closed. Refusing here would need our
     * own view of the block time, which is a guess — and a guess that refuses
     * is worse than a transaction that fails, because it cannot be retried into
     * correctness.
     */
    const { ledger } = harness({ openProposals: [] });
    await expect(ledger.closeExpiredRun('acct', runId(), BY)).resolves.toBeDefined();
  });
});

describe('prepare: the same round, stopped before the chain', () => {
  /*
   * `prepare` is the half of each method that a job needs on its own — check
   * and stage, then stop. Decision 0008, M-82.
   *
   * It is not a second implementation. Every method above now calls it, so the
   * tests already in this file are testing it too; mutating a guard out of
   * `prepare` fails one of them. What is left to test here is what only
   * `prepare` can get wrong: submitting when it should not, and staging or
   * refusing in the wrong order.
   *
   * **"and getting the recovery commitment wrong" STOOD IN THAT SENTENCE.**
   * `C292`, `S26`: no case of `prepare` sets `expectCommitment` any more, so
   * there is no longer a recovery commitment for it to get wrong. See the note
   * beside the deleted test below.
   */

  /*
   * **THIS STEP WAS `{ kind: 'execute', … }` AND IS NOW A `propose`.** `C292`,
   * `S26`. `PreparedStep` has no `execute` member and `prepare` has no
   * `execute` case; the balance opening and the sealed state the old step
   * carried have nowhere to go.
   *
   * `propose` is the substitute for the three tests below that are about
   * `prepare` ITSELF rather than about a spend: it stages before it returns,
   * it names a circuit and an arity, and it refuses on a chain read — which is
   * the whole of what those tests ask. The `approve` step already used further
   * down covers the check-only path.
   */
  const step = {
    kind: 'propose' as const,
    payloadHash: PAYLOAD_HASH,
    change: CHANGE,
    vault: MidnightCommitments.noVault(),
  };

  it('touches nothing on chain', async () => {
    // The whole point. Proving is eighty seconds against the WASM prover, and a
    // job has to be able to do all of this, crash, and owe the chain nothing.
    const { ledger, calls, submits, ...rest } = harness({ openProposals: [] });
    await ledger.prepare('acct', step);
    expect(calls).toEqual([]);
    expect(submits).toEqual([]);
    void rest;
  });

  it('stages the witnesses, because the circuit reads them from private state', async () => {
    /*
     * Staging is not a side effect that can be deferred to submission time. The
     * circuit reads the approved change out of THIS DEVICE's private state —
     * there is no argument for it — so it has to be there before the
     * transaction is BUILT, not before it is sent.
     *
     * **`expect(puts).toEqual([{ commitment: VIEW_AFTER, keyEpoch: 0 }])` STOOD
     * ON THE LINE BELOW AND WENT WITH `stageState`.** `C292`, `S26`: nothing in
     * this class writes a sealed blob any more, so `puts` is empty for every
     * step and asserting it would assert nothing. The rule it carried —
     * decision 0002, a commitment with no blob is an account nobody can open —
     * is recorded where `stageState` stood in `src/midnight/ledger.ts` and is
     * owed by whatever the vault path seals.
     */
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.prepare('acct', step);
    expect(staged.length).toBeGreaterThan(0);
  });

  it('names the circuit and passes the arity the contract declares', async () => {
    const { ledger } = harness({ openProposals: [] });
    const call = await ledger.prepare('acct', step);
    expect(call.circuit).toBe('propose');
    // Seven since the S11 merge, and the guard reads that off the compiled ABI.
    expect(call.args).toHaveLength(7);
    expect(argHex(call.args[0])).toBe(PAYLOAD_HASH);
    expect(call.address).toBe('addr_1');
  });

  /*
   * `it('hands back the commitment an interrupted job is recovered against')`
   * STOOD HERE. `C292`, `S26`.
   *
   * It read `expectCommitment` back as this asset's balance commitment after
   * the move — the value M-82 turned *"did my payment go out?"* from a guess
   * into a question with an answer. There is no such commitment.
   *
   * **AND THE FIELD OUTLIVED ITS ONLY PRODUCER, WHICH IS WORTH SAYING OUT
   * LOUD.** `PreparedCall.expectCommitment` is still declared
   * (`src/midnight/ledger.ts:140`) and NO case of `prepare` sets it any more —
   * `execute` was the only one. So it is `undefined` for every step there is,
   * and the test below, which asserts exactly that for `approve`, is now true
   * of everything rather than of the steps that move no state. **It is left
   * asserting the narrow claim rather than widened to the general one**: a test
   * saying *no step ever sets this* would pin the dead field in place, and
   * whether it comes back with the vault path is not a test's decision.
   */

  it('leaves it unset for the steps that move no state', async () => {
    // `approve` changes no commitment, so there is nothing to compare against —
    // what makes a retry safe there is the circuit's own nullifier instead.
    const { ledger } = harness({});
    const call = await ledger.prepare('acct', { kind: 'approve', proposalId: PROPOSAL_ID });
    expect(call.expectCommitment).toBeUndefined();
    expect(call.circuit).toBe('approve');
  });

  it('refuses before doing any work, not after', async () => {
    /*
     * Every refusal here is free. The same refusal discovered on chain costs a
     * block time, a fee, and eighty seconds of proving before it.
     *
     * REPOINTED ONTO THE `approve` STEP, because `propose` deliberately has no
     * "already open" refusal (M-128) and so cannot demonstrate this. `approve`
     * goes through `requireOpen`, which is the same read this test always
     * exercised.
     */
    const { ledger, puts } = harness({ openProposals: [] });
    await expect(ledger.prepare('acct', { kind: 'approve', proposalId: PROPOSAL_ID }))
      .rejects.toThrow(/no open proposal/);
    expect(puts).toEqual([]);
  });
});

/**
 * **R5b — AN EMPTY MAP AND A MISSING ONE ARE DIFFERENT ANSWERS, AND THE
 * BOUNDARY KEEPS THEM APART.**
 *
 * Written after `R5` shipped a read that assumed a decoded field was present,
 * both typechecks passed it — `tsconfig.scripts.json` has `strict: false` and
 * the generated types are loose enough — and 35 tests in this file died on
 * `parsed.thresholds is not iterable`.
 *
 * **THE SHAPE WAS NEVER THE PROBLEM.** The generated reader declares all three
 * maps as non-optional accessors iterating as pairs
 * (`contracts/managed/contract/index.d.ts:256`, `:277`, `:298`), which is
 * exactly what was assumed. What was assumed and is NOT declared anywhere is
 * that the field would be THERE.
 *
 * **THE OBVIOUS REPAIR IS THE DEFECT.** `?? []` makes the failure go away and
 * turns *"we could not read the exceptions"* into *"there are no exceptions"* —
 * and for `thresholds` those have opposite consequences, because *no
 * exceptions* means every vault inherits the account's threshold. A vault
 * somebody deliberately gave a HIGHER threshold would then be judged by the
 * account's lower one, and its rounds would settle early. **This is `C184`'s
 * family with a worse shape**: `NaN` at least fails a `< 1` check somewhere,
 * while `[]` passes every check there is.
 *
 * So both sides are pinned. A property that holds only while nobody writes
 * `?? []` is not a property.
 */
describe('R5b/C188: the boundary tells an empty map apart from a missing one', () => {
  /**
   * **DROPS ONE MAP FROM WHAT THE READER HANDS OVER, AND CHANGES NOTHING ELSE.**
   *
   * Reaching past the fake's own state is the only way to exercise a reader
   * that returns less than it declares — which is the case that actually
   * happened (`R5` added a field to the decoded state and not to the fixture)
   * and the one no type can express, because the generated `.d.ts` declares
   * every one of these maps as a non-optional accessor.
   */
  const withoutMap = (ledger: unknown, field: string) => {
    const inner: any = ledger;
    const original = inner.providers;
    inner.providers = async () => {
      const p = await original.call(inner);
      const state = await p.publicDataProvider.queryContractState();
      delete state.data[field];
      return { ...p, publicDataProvider: { queryContractState: async () => state } };
    };
  };

  /*
   * **ONE TEST PER MAP, AND THE COUNT IS THE POINT.** `C188`.
   *
   * The previous shape was one test for `thresholds` and one loop over the two
   * maps the wrong analogy was drawn from — three maps, and the contract
   * exported four. `approvalCounts` was not in the loop because it was not
   * behind the guard, and nothing here said so. A test per map is the shape
   * where a map added to the contract and not to this list is a gap somebody
   * can SEE, rather than a loop that still passes.
   *
   * Every one of them pins BOTH sides. A refusal test alone would pass against
   * a boundary that refused everything, and an empty-map test alone is what
   * `?? []` passes.
   *
   * **THERE ARE THREE MAPS AND ONE SET, AND THERE ARE FOUR TESTS.** `C292`,
   * `S26`, and this is the paragraph `src/midnight/ledger.ts` predicted somebody
   * would read: *"if a fourth is ever exported again, this paragraph is where
   * somebody will find out that the count is a thing this file states out
   * loud."* It moved the other way first — `assetBalances` was removed from the
   * CONTRACT, a map gone rather than a guard dropped — and then it moved back:
   * **`S35c` deleted the `signerCount` ledger field on 2 Sep and made the seat
   * count a read of `signerLeaves`, which is a SET.** `setSize` is `mapField`'s
   * sibling and the fourth test below is this one's. The three guards over
   * `openProposals`, `approvalCounts` and `thresholds` are untouched.
   *
   * **AND THE PREDICTION DID NOT FIRE BY ITSELF.** `S35c`'s first draft read
   * `parsed.signerLeaves.size()` directly, past the guard, and two of its
   * auditors found it independently. A paragraph is not a gate; what caught it
   * was somebody looking. That is worth knowing before trusting this one.
   *
   * `it('assetBalances: empty means the account holds nothing; missing refuses')`
   * STOOD FIRST IN THIS LIST AND IS DELETED WITH THE MAP. **It was the only one
   * of the four whose empty case was about money** — *the account holds
   * nothing* — and the account now holds nothing by construction. What it
   * protected is not lost: `withoutMap` and the `UndecodedLedgerField` refusal
   * are exercised by each of the three below, and `status reports every open
   * proposal, and no assets at all` above is what pins the empty side.
   */

  it('openProposals: empty means nothing is open; missing refuses', async () => {
    const empty = harness({ openProposals: [] });
    expect((await empty.ledger.status('acct'))!.openProposals).toEqual([]);

    const absent = harness({});
    withoutMap(absent.ledger, 'openProposals');
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"openProposals" map was not in the decoded state/);
  });

  it('thresholds: empty means every vault inherits; missing refuses, and says so', async () => {
    const { ledger } = harness({ vaultThresholds: [] });
    const status = await ledger.status('acct');
    expect(status!.vaultThresholds).toEqual([]);
    // And the account's own threshold is still answered, because nothing failed.
    expect(status!.threshold).toBe(2);

    /*
     * `null` is the fake reader omitting the field, which is precisely what it
     * did before this was noticed. The refusal has to NAME the field and has to
     * say that missing is not empty — a `TypeError` about an internal
     * expression is the right outcome for the wrong reason, and it is one
     * careless `?? []` away from becoming the wrong outcome.
     */
    const absent = harness({ vaultThresholds: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"thresholds" map was not in the decoded state/);
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);
  });

  it('approvalCounts: empty means nobody has approved anything; missing refuses', async () => {
    /*
     * **THE FOURTH MAP, AND THE ONE THAT WAS READ OUTSIDE THE GUARD.** `C188`.
     *
     * An account with no open proposals has an EMPTY `approvalCounts` — the
     * contract inserts a zero at `propose` and removes it at `execute` or
     * `cancel` — and that is a true statement about the account: nothing is
     * open, so nothing has approvals. A map the reader never supplied is not
     * that, and the refusal is what keeps them apart.
     *
     * **What it cost while it did not: `Number(undefined.lookup(id))` is a
     * `TypeError` naming an internal expression, and the repair anybody reaches
     * for is `?? 0n` — a proposal that HAS the approvals it needs reported as
     * having none, and a round nobody reading this boundary can settle.**
     */
    const empty = harness({ openProposals: [] });
    expect((await empty.ledger.status('acct'))!.openProposals).toEqual([]);

    /*
     * Absent WITH a proposal open, because that is the only state in which the
     * count is ever fetched — a missing map behind an empty proposal list would
     * pass against the unguarded read too, and would prove nothing.
     */
    const absent = harness({ approvalCounts: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"approvalCounts" map was not in the decoded state/);
    // NOT a TypeError about an internal expression, which is what it threw before.
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);
  });

  it('signerLeaves: the seat count is read, and a missing SET refuses rather than reading zero', async () => {
    /*
     * **THE FOURTH COLLECTION, AND THE FIRST THAT IS NOT A MAP.** `S35c`, and it
     * is the read `src/midnight/ledger.ts` predicted somebody would add without
     * a guard — which is what its first draft did.
     *
     * The empty side is not reachable for this field and that is the point of
     * the contract rather than of this boundary: the constructor seats exactly
     * one signer, so a live account's set is never empty. What IS reachable is a
     * reader that hands the accessor over and one that does not, and those two
     * must not produce the same number.
     *
     * **What zero would cost, which is why this is a refusal and not a `?? 0n`:**
     * `signerCount: 0` makes `bootstrapping` true on a live account, refuses
     * every `setThreshold` and refuses every `removeSigner` — the CONTRACT still
     * refuses correctly and OUR refusals stop refusing, which is denial rather
     * than loss and is still the wrong answer given confidently.
     */
    const seated = harness({ signerCount: 4n });
    expect((await seated.ledger.status('acct'))!.signerCount).toBe(4);

    const absent = harness({ signerCount: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"signerLeaves" set was not in the decoded state/);
    // The noun is `set`, not `map`, and the sentence that matters is the same one.
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);
  });

  it('reports the exceptions the chain holds, sorted, when there are some', async () => {
    const A = 'a1'.repeat(32) as Hex;
    const B = 'b2'.repeat(32) as Hex;
    // Supplied out of order, because a map's iteration order is not a promise
    // and anything that gets compared has to be stable.
    const { ledger } = harness({ vaultThresholds: [[B, 4n], [A, 2n]] });
    const status = await ledger.status('acct');
    expect(status!.vaultThresholds).toEqual([
      { vault: A, threshold: 2 },
      { vault: B, threshold: 4 },
    ]);
  });

  it('reports the approvals the chain holds for an open proposal', async () => {
    /*
     * The everyday path, pinned so a refusal is not the only thing this map is
     * tested for. A guard nobody can see working is a guard somebody removes.
     */
    const { ledger } = harness({ approvals: 3n });
    const status = await ledger.status('acct');
    expect(status!.openProposals).toHaveLength(1);
    expect(status!.openProposals[0].approvals).toBe(3);
  });
});

/**
 * **`C222` REPRODUCED, DETERMINISTICALLY, IN ONE FILE.**
 *
 * The row records a failure seen only in the full suite — *fail, fail, pass,
 * pass, fail* across five runs — and passing every time this file was run
 * alone or in any subset tried. **The reason it hid is that it needs TWO
 * harnesses to exist before a ledger is used**, and alone in this file every
 * test built exactly one and used it immediately, so "the harness I built" and
 * "the harness the module registry holds" were the same object.
 *
 * Build a second one first and the failure is not intermittent at all. It is
 * every time, with the row's own signature — `ids on chain (0): none`, the
 * NO-MATCH branch, the state read back fine and holding zero proposals.
 *
 * **So this is the test the row was owed**: it fails on the pre-fix harness
 * and it needs no suite, no bisect and no repetition to say so.
 */
describe('C222: a ledger is bound to the harness it was built with', () => {
  it('keeps using ITS OWN chain after a later harness is constructed', async () => {
    const first = harness({ openProposals: [] });
    /*
     * A second harness, built before the first one is used — which is all the
     * full suite was ever doing, spread across two tests instead of two lines.
     */
    const second = harness({});

    await first.ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault());

    // The call landed in the first harness, and the first harness read it back.
    expect(first.calls.map(c => c.circuit)).toEqual(['propose']);
    // And nothing at all reached the second, which is the other half of the claim.
    expect(second.calls).toEqual([]);
  });

  it('serves each of two live ledgers from its own chain, in either order', async () => {
    /*
     * The same property from the direction the suite actually failed in: the
     * OLDER harness's `callTx` serving the NEWER ledger. One binding per
     * providers bundle makes both directions impossible rather than making one
     * of them rarer.
     */
    const a = harness({ openProposals: [] });
    const b = harness({ openProposals: [] });

    await b.ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault());
    await a.ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault());

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});

/**
 * **`C334`: WHAT `open` REFUSES BEFORE IT SPENDS ANYTHING.** `S35`, board `2y6`.
 *
 * Three refusals were added to `MidnightLedger.open` this round and none of
 * them had a test — which `S35`'s `test-auditor` named, and which matters more
 * than usual here because each one is the last thing between a mistake and a
 * DEPLOYED contract: past this point there is a transaction on chain, a fee
 * spent, and an account that may be impossible to fix.
 *
 * They run before the maintenance-authority check and before any provider is
 * built, so a harness with nothing else wired reaches them. That ordering is
 * the reason they are testable and it is stated at the call site.
 *
 * **BUT THEY ARE NOT THE FIRST GUARD IN `open`, AND FOR TWO DAYS THESE FOUR
 * TESTS REACHED NONE OF THEM.** `S40`, 2 Sep.
 *
 * `open` refuses a ledger built without deployment credentials before it looks
 * at the opening at all (`ledger.ts:377-384`) — a guard OLDER than `C334` and
 * unrelated to it. The comment that stood here said this harness *"passes `{}`
 * for the deployment bag"*. It did not: it built the ledger with SIX arguments
 * where the constructor takes seven, so `{}` landed on `compiled` and
 * `deployment` was `undefined`. All three refusal tests failed with the
 * credentials message and the positive control passed on it, because the
 * credentials message matches none of the three patterns it rules out — the
 * `C238` shape, inside the control written to prevent exactly that.
 *
 * **NOTHING MOVED AND NOTHING WAS UNGUARDED.** The three refusals are where
 * `S35` put them (`ledger.ts:414-421`, `:438-447`, `:493-500`). **RE-ANCHORED
 * BY `S35d`, WHICH IS `C366` HAPPENING TO THIS SENTENCE:** the ranges `S35b`
 * cited on 1 Sep were right when written and the third refusal's justification
 * was rewritten under them, moving everything below. The refusals themselves
 * did not move and none was unguarded), and the credentials guard
 * predates them. These tests had simply never executed: `S35` edited a
 * `.compact`, `C294`'s freshness guard refused every test file in the
 * repository, and rule 11 was discharged at `TEST.command` — which is where
 * they first ran and first failed.
 *
 * So each test below hands `open` a REAL deployment bag and gets past the
 * credentials guard deliberately. **The three refusals are now reached because
 * the credentials are PRESENT, not because they are missing.**
 *
 * **THE MESSAGE IS READ, NOT THE FACT OF A THROW.** `S34`'s standing note:
 * `rejects.toThrow()` passes for a `TypeError` from a renamed helper, and all
 * three of these refusals would otherwise be indistinguishable from each other.
 * That note is the only reason this was found rather than repaired quietly:
 * reading the message is what showed the wrong refusal firing.
 *
 * **WHAT THIS BLOCK DOES NOT COVER, SAID HERE BECAUSE IT IS FOUR GREEN TESTS
 * NAMED AFTER A `P0` AND WILL BE READ AS THAT `P0`'s COVERAGE.** `S40`, from
 * this round's `money-safety-auditor`. Rule 14.
 *
 * `C334`'s client-side half is two claims and these tests hold NEITHER of them
 * directly. That an opening's leaf can be DERIVED by somebody is `C339` (`P0`,
 * open, board `2y8`): `open` refuses an absent leaf and a malformed opening and
 * never asks whether the leaf it has belongs to anyone, so an account can still
 * be founded on 32 bytes nobody holds and be dead the moment it deploys. That
 * the deploying PROCESS holds no founder's secret is `C341` (`P0`, open, board
 * `4b`): `AccountService.create` still mints every signer's material inside the
 * process that deploys. **What is green here is that `open` refuses four
 * specific malformed openings before it spends anything. It is not that the
 * founding seat is safe.** The contract's half of `C334` is pinned separately,
 * in `contracts/test/what-a-signer-is.test.ts`.
 */
describe('C334: MidnightLedger.open refuses an opening it cannot honour', () => {
  const opening = (over: Partial<AccountOpening> = {}): AccountOpening => ({
    signerLeaves: ['aa'.repeat(32)],
    threshold: 2,
    assetBlinding: 'bb'.repeat(32),
    sealedState: { keyEpoch: 1, sealed: { iv: '', tag: '', body: '' } },
    ...over,
  });

  /**
   * **CREDENTIALS THAT EXIST, CARRYING AN AUTHORITY THE NEXT GATE REFUSES —
   * AND BOTH HALVES ARE DELIBERATE.** `S40`.
   *
   * They must EXIST, or `open`'s first guard fires and none of the three
   * refusals below is ever reached. The authority must be REFUSABLE, or the
   * positive control runs on past `requireMaintenanceAuthority` into
   * `submitPartialDeployTx` and a chain this harness does not have.
   *
   * A `single-key` authority whose `temporary.fixedBy` names no round is
   * refused by name (`partial-contract.ts:198-204`) — `C225`'s rule that one
   * key is acceptable only as a RECORDED temporary state. That refusal is what
   * the control asserts it reached, which is a statement about WHERE `open`
   * stopped rather than about which messages it avoided.
   */
  const deployment: ConstructorParameters<typeof MidnightLedger>[6] = {
    register: async () => {},
    maintenanceAuthority: {
      kind: 'single-key',
      signingKey: { tag: 'schnorr', value: 'ff'.repeat(32) },
      temporary: { fixedBy: '' },
    },
  };

  it('refuses an opening that names no founding signer', async () => {
    /*
     * The account's only seat is the constructor's argument. Deployed without
     * one, `amendSigner`'s `requireSigner()` means nobody can ever add the
     * first — the account is dead, permanently, along with every vault that
     * named it. There is no on-chain guard for an argument never supplied.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({ signerLeaves: [] })))
      .rejects.toThrow(/names no founding signer/);
  });

  it('refuses an opening that names more than one, rather than seating the first and dropping the rest', async () => {
    /*
     * `SimulatedLedger` seats every leaf and `AccountService` writes all N onto
     * the durable record. Silently seating one would leave a roster saying
     * three signers and a chain holding one — a client and a chain that
     * disagree about who may approve.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({
      signerLeaves: ['aa'.repeat(32), 'cc'.repeat(32)],
    }))).rejects.toThrow(/can seat exactly one/);
  });

  it('refuses a threshold the chain will never be told about', async () => {
    /*
     * **THIS TEST WAS CALLED *"refuses a threshold of zero, which the CONTRACT
     * does not refuse"* AND ITS SUBJECT CHANGED UNDER IT.** `S35d`.
     *
     * What it pinned: the constructor took the threshold as argument one, and
     * `requireApproved` asserts `!(approvals < threshold)` — at zero that is
     * `!(0 < 0)` and it PASSES with nobody having approved, so `recordPayment`
     * would move money on a proposal no signer voted for. `C340`. This refusal
     * was the only thing enforcing it and the name said so.
     *
     * **WHAT IS TRUE NOW: THE CONSTRUCTOR TAKES NO THRESHOLD AND SETS
     * `threshold = 1`** (`C340` + `C343`, the founder, 2 Sep). Zero is
     * unrepresentable on chain rather than refused here. So this refusal is no
     * longer what stands between an account and `C340`, and a name claiming it
     * were would be a rule-14 falsehood in a test title — which is the worst
     * place for one, because a title is what a reader trusts without opening.
     *
     * **WHAT IT PINS TODAY, WHICH IS WHY IT IS NOT DELETED.**
     * `opening.threshold` never reaches the chain and still becomes
     * `account.policy.threshold` and still drives `SimulatedLedger.open`, so a
     * zero, a negative or a `NaN` is still a bad value entering OUR record of
     * the account. The four cases below are unchanged and so is the door they
     * name; only the reason is different, and it is now the boundary's own
     * rather than the contract's.
     */
    const h = harness({}, deployment);
    await expect(h.ledger.open('acct', opening({ threshold: 0 })))
      .rejects.toThrow(/is not a rule/);
    await expect(h.ledger.open('acct', opening({ threshold: -1 })))
      .rejects.toThrow(/is not a rule/);
    /*
     * **AND THE OTHER HALF OF THE GUARD, WHICH ZERO AND MINUS ONE DO NOT
     * REACH.** `S40`, from this round's `money-safety-auditor`.
     *
     * The refusal is `!Number.isInteger(opening.threshold) || opening.threshold
     * < 1`. Both cases above are caught by the SECOND clause alone, so deleting
     * `!Number.isInteger(...)` left this test green — a clause `MUTATE` is
     * about to score and nothing was pinning. `NaN < 1` is `false`, so without
     * that clause a `NaN` threshold passes the door.
     *
     * **WHAT THAT USED TO COST AND WHAT IT COSTS NOW.** It reached
     * `BigInt(opening.threshold)` in the constructor's argument list and the
     * operator got a `RangeError` after a six-second wait instead of a refusal
     * that names the door (rule 19). `S35d` deleted that argument, so today a
     * `NaN` gets no further than `account.policy.threshold` and
     * `SimulatedLedger`, where it makes every later comparison against the
     * policy `false` silently. **The clause is still load-bearing and what it
     * prevents is now a wrong number in our own record rather than a
     * `RangeError` at deploy.** No money moves on either path, which is why
     * this is a pin and not a row.
     */
    await expect(h.ledger.open('acct', opening({ threshold: 1.5 })))
      .rejects.toThrow(/is not a rule/);
    await expect(h.ledger.open('acct', opening({ threshold: NaN })))
      .rejects.toThrow(/is not a rule/);
  });

  it('lets a well-formed opening past all three', async () => {
    /*
     * **THE POSITIVE CONTROL, AND WITHOUT IT THE THREE ABOVE PASS ON A METHOD
     * THAT REFUSES EVERYTHING.** It is not asserted that this deploys — the
     * harness has no chain — only that it gets PAST these three and fails
     * further in, at the maintenance authority, which is the next gate.
     */
    const h = harness({}, deployment);
    /* `rejects.not.toThrow` is not a thing, and a bare `rejects.toThrow()` here
     * would pass for the very refusals this is meant to rule out — so the
     * message is caught and read. */
    const why = await h.ledger.open('acct', opening()).then(() => '', (e: Error) => e.message);
    expect(why).not.toMatch(/names no founding signer|can seat exactly one|is not a rule/);
    /*
     * **AND WHERE IT DID STOP, NAMED.** `S40`.
     *
     * The line above is a NEGATIVE, and a negative was satisfied for two days
     * by a refusal that fired BEFORE all three — so this control was green
     * while every test it controls was unreachable. It now says which gate was
     * reached: `requireMaintenanceAuthority`, which `open` calls immediately
     * after the three (`ledger.ts:492`). A refusal from anywhere earlier fails
     * this line, including the credentials one.
     */
    expect(why).toMatch(/single-key maintenance authority is accepted only as a RECORDED/);
  });
});

/**
 * **`T-220`'s TWO READS, AND THE GUARDS THAT WERE ENFORCED BY NOTHING UNTIL
 * THIS BLOCK.** `S52`, and it exists because `S52`'s own `test-auditor` found
 * the gap in `S52`'s own work.
 *
 * `LedgerStatus` gained `movementCount` and `retiredVaults` for
 * `docs/accepted-risks.md` §1's detector (`T-183`). Both go through
 * `setSize`/`mapField`, which refuse rather than repairing — `C188`'s rule, and
 * `src/midnight/ledger.ts`'s own note beside `signerCount` spells out what
 * skipping them costs. **The round added the harness dials that make a refusal
 * test possible and then did not write one**, and the auditor measured the
 * consequence: replacing both reads with the `?? 0n` / `?? []` repair those
 * paragraphs warn against left every test in this file green.
 *
 * **AND THE ASSERTION THAT DID EXIST WAS THE ONE THAT COULD NOT HELP.** The
 * whole-object `toEqual` above asserts `movementCount: 0, retiredVaults: []` —
 * **exactly the values an unguarded read produces** — so it agreed with the
 * defect. A test that agrees with the repair it was written to forbid is
 * `C286`'s shape, and this is the round paying for it in the same turn.
 *
 * **WHY IT MATTERS MORE HERE THAN FOR THE OTHER FOUR COLLECTIONS.** A confident
 * zero from `movements` is not a missing number, it is a WRONG ANSWER TO THE
 * ONLY QUESTION THE FIELD EXISTS FOR: the detector compares Σ`payments` against
 * this count, and a silent zero reports a burn that has not happened — or, once
 * `payments` is also zero on a quiet account, hides one that has. That is a
 * detector that answers instead of refusing, which is worse than no detector.
 */
describe('T-220: the detector\'s two fields are read, and a reader that omits them REFUSES', () => {
  it('reports the count and the retired vaults the chain holds, sorted', async () => {
    /*
     * **THE NON-DEFAULT READ, WHICH IS WHAT SAYS THE FIELDS ARE WIRED TO THE
     * RIGHT COLLECTIONS AT ALL.** Zero and empty are what a wrong wiring
     * produces too. A count of five and two retired vaults are not.
     *
     * Supplied out of order for the reason the `vaultThresholds` case above
     * gives: a map's iteration order is not a promise, and anything compared
     * has to be stable. **And the VALUES are deliberately not 1**, so a reader
     * that returned `retiredAt`'s values instead of its keys could not pass —
     * the contract stores a marker there (`retireVault` inserts `1`), and
     * *ever retired* is the KEY's presence (`C362`).
     */
    const A = 'a1'.repeat(32) as Hex;
    const B = 'b2'.repeat(32) as Hex;
    const { ledger } = harness({ movementCount: 5n, retiredVaults: [[B, 7n], [A, 9n]] });
    const status = await ledger.status('acct');
    expect(status!.movementCount).toBe(5);
    expect(status!.retiredVaults).toEqual([A, B]);
  });

  it('refuses when the reader hands over no "movements" set, rather than reporting zero', async () => {
    /*
     * **THE WHOLE POINT OF THE GUARD, AND THE DIRECTION MATTERS.** *No payment
     * has completed* is a statement about the account; *we could not read
     * `movements`* is our ignorance. The detector cannot tell them apart from a
     * number, so the boundary must not hand it one.
     */
    const absent = harness({ movementCount: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"movements" set was not in the decoded state/);
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);

    /* The positive control: present and empty is an ANSWER, and it lands. */
    expect((await harness({ movementCount: 0n }).ledger.status('acct'))!.movementCount).toBe(0);
  });

  it('refuses when the reader hands over no "retiredAt" map, rather than reporting none retired', async () => {
    /*
     * Same rule, the other collection and the other noun — `mapField` says
     * *map* where `setSize` says *set*, and the sentence they share is the one
     * that carries the meaning.
     */
    const absent = harness({ retiredVaults: null });
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/"retiredAt" map was not/);
    await expect(absent.ledger.status('acct'))
      .rejects.toThrow(/not the same as the map being empty/);

    expect((await harness({ retiredVaults: [] }).ledger.status('acct'))!.retiredVaults).toEqual([]);
  });
});

/**
 * **THE GOVERNANCE BRANCH REFUSES A VAULT, AT THE LAYER THAT PAYS FOR IT.**
 * `C367`, `T-237`, `S55`.
 *
 * **APPENDED AT THE END OF THIS FILE RATHER THAN BESIDE THE `propose` CASES IT
 * BELONGS WITH, AND `C393` IS THE REASON.** `docs/design/edges.json` cites this
 * file by `file:line` — `:794` and `:1125` — and the doc-freshness `globalSetup`
 * turns EVERY test file in the repository red when a generated citation moves.
 * Rule 1 forbids a session the recompile door that would fix it, so a case
 * inserted in the middle of this file would have cost the round its suite. Below
 * the last cited line nothing moves.
 */
describe('C367: a governance round may not name a vault, and the boundary says so first', () => {
  it('propose REFUSES a real vault before the fee and before the proving', async () => {
    /*
     * `Accounts.propose` carried a documented `vault?: Hex` and this boundary
     * threaded it into the governance branch **verbatim**. On chain that branch
     * asserts `vault == noVault()` (`contracts/src/ConfidentialAccount.compact:2319`),
     * so the call was a silent no-op until `C363` added the assert and a
     * **paid-for failed transaction** after it — arriving after eighty seconds
     * of WASM proving, which is exactly what `prepare` exists to avoid (its own
     * job 1). Its tests were green because they ran on `SimulatedLedger`.
     *
     * **NO CIRCUIT CALL IS MADE, AND THAT IS THE HALF A THROWN ERROR CANNOT
     * SHOW:** a refusal that still built and proved has saved nothing.
     */
    const { ledger, calls } = harness({ openProposals: [] });
    await expect(ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, 'a1'.repeat(32)))
      .rejects.toThrow(/governance round cannot name a vault/);
    expect(calls).toHaveLength(0);

    /*
     * **THE POSITIVE CONTROL.** The sentinel still goes through, so this is a
     * refusal of one value and not of the door — and `proposeRun`, which is the
     * branch that DOES carry a vault, is untouched and pinned above (`V-73`).
     */
    await ledger.propose('acct', PAYLOAD_HASH, CHANGE, BY, MidnightCommitments.noVault());
    expect(calls).toHaveLength(1);
  });
});

/**
 * **A REFUSED `proposeRun` STAGES NOTHING.** `T-324`, `S55`, `S58`.
 *
 * **APPENDED AT THE END OF THIS FILE FOR `C393`'s REASON, WHICH `S55` ALREADY
 * MET HERE.** `docs/design/edges.json` cites this file at `:794` and `:1125`,
 * and the doc-freshness `globalSetup` turns EVERY test file in the repository
 * red when a generated citation moves. Rule 1 forbids a session the recompile
 * that would fix it. Below the last cited line, nothing moves.
 *
 * **AND THE FIX IT PINS WAS MADE LINE-NEUTRAL IN `src/midnight/ledger.ts` FOR
 * THE SAME REASON** — `edges.json` cites that file at FOURTEEN lines, of which
 * thirteen, `:1186` through `:1796`, fall below the block that was reordered
 * (the fourteenth, `:1142`, sits above it). **This comment said ten until this
 * round's auditor counted them; rule 9.** The three
 * refusals moved above `stageChange` without the enclosing `case` changing
 * length. Measured, not assumed: the same gate refused an earlier draft of this
 * fix that added twenty-nine lines, naming `ledger.ts:1422` against `:1451`.
 */
describe('T-324: a refused run leaves no salt behind, because nothing was staged', () => {
  const RUN = {
    root: 'aa'.repeat(32) as Hex,
    payees: 50n,
    opensAt: 1_800_000_000n,
    closesAt: 1_800_604_800n,
    vault: 'bb'.repeat(32) as Hex,
  };

  /*
   * **WHAT A DURABLE WRITE ON A REFUSED CALL ACTUALLY COSTS**, and it is not
   * the write. `stageChange` puts one record per `(network, account)` holding
   * `proposalSalt`, and that salt is the witness every governance apply-circuit
   * reads to recompute the proposal's id. A refusal AFTER the write clobbers
   * the salt of whatever round the device was already holding — so the next
   * apply for a LEGITIMATELY OPEN proposal recomputes the wrong id and is
   * refused about the wrong thing, with nothing for an operator to attribute it
   * to. The refused call is not the victim; the round already open is.
   *
   * **`calls` WAS ALREADY ASSERTED AND `staged` WAS NOT**, which is why the
   * three refusals had cases and the defect survived them: no fee was spent, so
   * the tests were right about what they checked and silent about this.
   */
  it('refuses a window in milliseconds without staging a salt', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: 1_800_000_000_000n, closesAt: 1_800_604_800_000n }, CHANGE, BY))
      .rejects.toThrow(/not a time in seconds|year 5/i);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  it('refuses a backwards window without staging a salt', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    await expect(ledger.proposeRun(
      'acct', { ...RUN, opensAt: RUN.closesAt, closesAt: RUN.opensAt }, CHANGE, BY))
      .rejects.toThrow(/no payment could ever fall inside it/i);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  it('refuses an empty run without staging a salt', async () => {
    const { ledger, calls, staged } = harness({ openProposals: [] });
    await expect(ledger.proposeRun('acct', { ...RUN, payees: 0n }, CHANGE, BY))
      .rejects.toThrow(/at least one payee/i);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
  });

  /*
   * **THE POSITIVE CONTROL, AND WITHOUT IT THE THREE ABOVE PASS ON A DOOR THAT
   * STAGES NOTHING AT ALL.** Staging is not optional on this branch — the
   * circuit reads the change from private state because there is no argument
   * for it — so a run that is ACCEPTED must still stage exactly one record
   * carrying the salt.
   */
  it('and an accepted run still stages exactly one record, carrying the salt', async () => {
    const { ledger, staged } = harness({ openProposals: [] });
    await ledger.proposeRun('acct', RUN, CHANGE, BY);
    expect(staged).toHaveLength(1);
    expect(staged[0].value.proposalSalt).toBeInstanceOf(Uint8Array);
  });
});

/**
 * **THE TWO COMMITTEE REFUSALS, PINNED THROUGH THE ACCOUNT DOOR — AND THE
 * ACCOUNT DOOR IS THE ONLY ONE THAT REACHES THEM IN PRODUCT SHAPE.** `T-345`,
 * `SC13` §4 `F6`, `S58`.
 *
 * `requireMaintenanceAuthority` has four refusals and two were asserted by
 * nothing: `partial-contract.ts:181` (an empty or non-array committee) and
 * `:191` (a threshold outside 1…size). **Measured, not assumed:**
 * `grep -rn "needs at least one verifying key"` and `grep -rn "cannot have
 * threshold"` over every `.ts`/`.tsx`/`.mjs` in this repository each returned
 * exactly ONE hit, both in `partial-contract.ts`, and zero in any test file.
 *
 * **WHY NOT THROUGH THE VAULT DOOR, WHICH IS WHERE THE OTHER TWO ARE PINNED.**
 * `requireVaultMaintenanceAuthority` narrows to `single-key` and refuses every
 * other kind by name (`vault-contract.ts:242`), and `deployVaultContract`'s
 * first statement calls it — so **no vault deployment can carry a committee at
 * all**, well-formed or not. A committee case written there would be asserting
 * a branch with no product meaning for a vault; `vault-contract.test.ts`'s own
 * committee case steers around it deliberately, passing a WELL-FORMED committee
 * so it survives `:241` and reaches the narrowing refusal it is actually about.
 * **The account is where a committee is a real answer, so the account is where
 * these two are pinned.**
 *
 * **AND `partial-contract.ts` STILL HAS NO OWNING TEST FILE**, which is the
 * other half of `T-345` and is not this round's to create — `C393`: a new test
 * file makes the generated doc set stale and refuses the whole suite until a
 * person runs `DOCS.command`. The row stays open for it.
 */
describe('T-345: a committee the SDK could never sign with is refused at the account door', () => {
  const opening = (over: Partial<AccountOpening> = {}): AccountOpening => ({
    signerLeaves: ['aa'.repeat(32)],
    threshold: 2,
    assetBlinding: 'bb'.repeat(32),
    sealedState: { keyEpoch: 1, sealed: { iv: '', tag: '', body: '' } },
    ...over,
  });

  /* The type is reached THROUGH the constructor rather than imported: an added
   * import line at the top of this file moves `:794` and `:1125`, which
   * `docs/design/edges.json` cites and the freshness gate refuses. `C393`. */
  type Deployment = NonNullable<ConstructorParameters<typeof MidnightLedger>[6]>;
  const withAuthority = (
    maintenanceAuthority: Deployment['maintenanceAuthority'],
  ): Deployment => ({ register: async () => {}, maintenanceAuthority });

  const KEY = { tag: 'schnorr', value: 'ff'.repeat(32) } as const;

  it('refuses an EMPTY committee by name, rather than deploying an unmaintainable contract quietly',
    async () => {
    /*
     * An empty committee is the `unmaintainable` state arrived at by omission.
     * The refusal exists so that the two are never the same keystroke: saying
     * *no maintenance, ever* has to be said, and `[]` is not saying it.
     */
    const h = harness({}, withAuthority({ kind: 'committee', committee: [], threshold: 1 }));
    await expect(h.ledger.open('acct', opening()))
      .rejects.toThrow(/needs at least one verifying key/);
  });

  it('refuses a threshold ABOVE the committee size, which is unmaintainable wearing a committee\'s clothes',
    async () => {
    const h = harness({}, withAuthority({ kind: 'committee', committee: [KEY], threshold: 2 }));
    await expect(h.ledger.open('acct', opening()))
      .rejects.toThrow(/cannot have threshold/);
  });

  it('refuses a threshold BELOW one, which is the same refusal reached from the other side',
    async () => {
    /*
     * The guard is one expression with three clauses — non-integer, `< 1`, and
     * `> size`. A case for only the upper bound would stay green against a
     * mutation that dropped the lower one, which is `C286`'s shape.
     */
    const h = harness({}, withAuthority({ kind: 'committee', committee: [KEY], threshold: 0 }));
    await expect(h.ledger.open('acct', opening()))
      .rejects.toThrow(/cannot have threshold/);
  });

  /*
   * **THE POSITIVE CONTROL, AND WITHOUT IT ALL THREE ABOVE PASS ON A VALIDATOR
   * THAT REFUSES EVERY COMMITTEE.** A well-formed committee must be ACCEPTED
   * and handed back unchanged.
   *
   * **IT IS TAKEN AT THE VALIDATOR AND NOT AT `open`, AND THE REASON WAS
   * MEASURED RATHER THAN ASSUMED.** `S58`. The first draft drove it through
   * `open` like the three above and **timed out at 30,000 ms** — a well-formed
   * committee passes the authority gate and carries on into
   * `submitPartialDeployTx`, against a harness that has no chain. That is a
   * real demonstration that the gate was passed, and it is not a test. The
   * three refusals above still go through `open`, which is where `T-345` asks
   * for them; only the control steps in one layer.
   *
   * **THE IMPORT IS DYNAMIC BECAUSE A TOP-OF-FILE IMPORT LINE WOULD MOVE
   * `:794` AND `:1125`**, which `docs/design/edges.json` cites. `C393` again.
   * It resolves through this file's own `vi.doMock`, which spreads the real
   * module — so the validator under test is the shipped one.
   */
  it('and a well-formed committee is ACCEPTED, unchanged', async () => {
    const { requireMaintenanceAuthority } = await import('./partial-contract.js');
    const choice = { kind: 'committee' as const, committee: [KEY], threshold: 1 };
    expect(requireMaintenanceAuthority(choice)).toEqual(choice);
  });
});

/* ================================================================== *
 * THE READ-BACK AND THE THREE-STATE COMPARISON — `C354` `P0`, `2y9-1`, `S61`
 * ================================================================== */

/**
 * **APPENDED TO THIS FILE RATHER THAN GIVEN ITS OWN, AND THE REASON IS
 * MEASURED.** `C393` is broader than `S61`'s brief states it: the generated doc
 * set records the NUMBER OF FILES SCANNED under `src`, `scripts` and
 * `contracts/test` (`docs/design/ledger-fields.md:78`, `edges.json`'s
 * `clientFilesScanned`), so ANY new file in those trees turns the gate red — a
 * source module exactly as much as a test. Measured: two new files moved `298`
 * to `300` and `scripts/doc-freshness.ts` refused. It refuses in `globalSetup`,
 * so it stops every named-file `vitest` run and not only `TEST.command` — which
 * would have cost this round the red measurement `§6` requires. Appended at the
 * END, where no line moves: this file's last `edges.json` locator is `:1125`.
 *
 * **EVERY COMMITTEE KEY BELOW IS A FIXED PUBLIC CONSTANT, NOT A GENERATED ONE.**
 * `AUTH_KEY_1`/`_2`/`_3` are the verifying keys of the signing values 1, 2 and 3
 * — the secp256k1 generator and its first two multiples, published everywhere.
 * `S61` ran under rule 2 (no deploy, no key generation, no transaction) and
 * these are literals so that stays true every time the suite runs.
 *
 * **`LIVE_*` ARE WHAT THE CHAIN ACTUALLY ANSWERED** on 5 Sep for the two
 * contracts this project has deployed on stagenet, read with one query each.
 * They are here so the shape this file asserts is the shape the chain really
 * produced, rather than one invented to match the code.
 */
describe('reading a deployed contract\'s maintenance authority back off the chain', () => {
  const authKey = (value: string) => ({ tag: 'schnorr', value });
  const AUTH_KEY_1 = authKey('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const AUTH_KEY_2 = authKey('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const AUTH_KEY_3 = authKey('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const LIVE_ACCOUNT_KEY = authKey('50101e92e4679df5c9ddac69c5acb491d24ee42467e972d97ff99960a94ae8b1');

  const stateWith = (committee: unknown[], threshold: number, counter: unknown = 0n) =>
    ({ data: {}, maintenanceAuthority: { committee, threshold, counter } });

  it('reads the committee, the threshold and the counter off a queried contract state', async () => {
    const { readContractAuthority } = await import('./ledger.js');
    const r = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 2, 4n), 'addr',
    );
    expect(r.state).toBe('read');
    if (r.state !== 'read') return;
    expect(r.authority.committee).toEqual([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3]);
    expect(r.authority.threshold).toBe(2);
    expect(r.authority.counter).toBe(4n);
    expect(r.authority.shape).toBe('committee');
  });

  it('reads a committee the same way it reads one key, because it consults no signing key', async () => {
    /*
     * `SC6b`: a committee switches the SDK's whole maintenance interface OFF for
     * that contract, permanently — every SDK entry point opens by asserting a
     * stored signing key (`index.mjs:398-399`, `:470-471`, `:547-548`) and under
     * a committee none is stored (`partial-contract.ts:358-360`). This read is a
     * ledger property and touches no key, so the two cost the same. **That is
     * the property `2y9-2` and `2y9-3` inherit** and it is pinned here.
     */
    const { readContractAuthority } = await import('./ledger.js');
    const one = await readContractAuthority(async () => stateWith([AUTH_KEY_1], 1), 'a');
    const many = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 3), 'b');
    expect(one.state).toBe('read');
    expect(many.state).toBe('read');
    if (one.state !== 'read' || many.state !== 'read') return;
    /*
     * **THE CONTENTS, NOT ONLY THE STATE.** `S61`'s `money-safety-auditor`
     * graded the first version of this test `P2` for asserting only
     * `state === 'read'` on both: it passed against any implementation that
     * returned a `read` with a garbage authority, and would have passed
     * unchanged if the committee had been silently truncated to one key — rule
     * 27, against the test whose own comment claimed to pin the property.
     */
    expect(one.authority.committee).toEqual([AUTH_KEY_1]);
    expect(one.authority.threshold).toBe(1);
    expect(many.authority.committee).toEqual([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3]);
    expect(many.authority.threshold).toBe(3);
    expect(many.authority.shape).toBe('committee');
  });

  it('calls a threshold of zero `anyone` and never `no-one`, at any committee size', async () => {
    /*
     * **THE MOST DANGEROUS VALUE ON CHAIN, AND THE FIRST DRAFT REPORTED IT WITH
     * THE NAME OF THE SAFEST.** Found by `S61`'s `money-safety-auditor`.
     * `verify.rs:1789` — `if self.signatures.len() < authority.threshold` — is
     * the ONLY read of `threshold` in the ledger crate, so at zero an update
     * with NO signatures is well-formed and the committee is never consulted.
     * `no-one` is this codebase's word for `unmaintainable`
     * (`partial-contract.ts:118-130`), which is the exact opposite state.
     */
    const { authorityShapeOf } = await import('./ledger.js');
    expect(authorityShapeOf([], 0)).toBe('anyone');
    expect(authorityShapeOf([AUTH_KEY_1], 0)).toBe('anyone');
    expect(authorityShapeOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 0)).toBe('anyone');
    expect(authorityShapeOf([], 0)).not.toBe('no-one');
    expect(authorityShapeOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 0)).not.toBe('committee');
  });

  it('reports a committee that lists one key more than once, because its threshold is not what it looks like', async () => {
    /*
     * Raised by `S61`'s `platform-fact-checker`, as a READING of ledger
     * 8.2.0-rc.1 rather than a measurement: `data_to_sign`
     * (`structure.rs:2737-2747`) does not cover the signer index, so one
     * signature is valid at every index whose committee slot holds that key —
     * and `[K,K,K]` at threshold 3 is satisfied by one holder of `K`.
     * `requireMaintenanceAuthority` checks size and range and not distinctness.
     */
    const { readContractAuthority } = await import('./ledger.js');
    const dup = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_1, AUTH_KEY_2], 3), 'a');
    const clean = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 3), 'b');
    expect(dup.state).toBe('read');
    expect(clean.state).toBe('read');
    if (dup.state !== 'read' || clean.state !== 'read') return;
    expect(dup.authority.hasDuplicateMembers).toBe(true);
    expect(clean.authority.hasDuplicateMembers).toBe(false);
  });

  it('reports the SHAPE of the value and never claims to know which kind was chosen', async () => {
    /*
     * MEASURED, byte-identical: a `single-key` authority over one key and a
     * `committee` of that one key at threshold one serialize to the same bytes.
     * The chain carries no kind. Anything reading `one-key` as *the choice was
     * `single-key`* is reading something that is not there — rule 27, in the
     * direction that matters.
     */
    const { authorityShapeOf } = await import('./ledger.js');
    expect(authorityShapeOf([AUTH_KEY_1], 1)).toBe('one-key');
    expect(authorityShapeOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 2)).toBe('committee');
    expect(authorityShapeOf([AUTH_KEY_1], 2)).toBe('no-one');
    expect(authorityShapeOf([], 1)).toBe('no-one');
  });

  it('answers `absent` and not `unreachable` when the provider holds no state', async () => {
    const { readContractAuthority } = await import('./ledger.js');
    expect((await readContractAuthority(async () => null, 'addr')).state).toBe('absent');
  });

  it('answers `unreachable` and not `absent` when the provider throws', async () => {
    /* `R4`. An unreachable chain is not an empty one, and the round that shipped
     * this backwards shipped a `P1` (`S55`). */
    const { readContractAuthority } = await import('./ledger.js');
    const r = await readContractAuthority(async () => { throw new Error('ECONNREFUSED'); }, 'addr');
    expect(r.state).toBe('unreachable');
    if (r.state !== 'unreachable') return;
    expect(r.why).toContain('ECONNREFUSED');
  });

  it('refuses state whose authority field is missing or the wrong shape rather than guessing', async () => {
    const { readContractAuthority } = await import('./ledger.js');
    expect((await readContractAuthority(async () => ({ data: {} }), 'a')).state).toBe('unreadable');
    /* A `counter` that arrived as a number rather than a bigint is a changed
     * runtime, not a readable authority. It refuses instead of comparing. */
    const wrong = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1], 1, 0), 'a');
    expect(wrong.state).toBe('unreadable');
    if (wrong.state !== 'unreadable') return;
    expect(wrong.why).toContain('counter');
  });

  it('reads the shape the stagenet account contract actually answered on 5 Sep', async () => {
    const { authorityFromContractState } = await import('./ledger.js');
    const a = authorityFromContractState(stateWith([LIVE_ACCOUNT_KEY], 1, 0n));
    expect('why' in a).toBe(false);
    if ('why' in a) return;
    expect(a.committee).toEqual([LIVE_ACCOUNT_KEY]);
    expect(a.threshold).toBe(1);
    expect(a.shape).toBe('one-key');
  });
});

describe('comparing the chain against the maintenance authority chosen on disk', () => {
  const authKey = (value: string) => ({ tag: 'schnorr', value });
  const AUTH_KEY_1 = authKey('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const AUTH_KEY_2 = authKey('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const AUTH_KEY_3 = authKey('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');

  /**
   * **A PLACEHOLDER ADDRESS, FOR THE SAME REASON THE SIGNING KEY BELOW IS ONE.**
   *
   * This was the live stagenet account contract's address, written out here as
   * a literal. **It is gone, and nothing was lost: MEASURED, the address is
   * only ever carried through `readOf` into `compareAuthority`, which copies it
   * onto its result and never compares it** (`ledger.ts:2565-2613` — every
   * branch decides on `threshold`, `committee` and order, and not one reads
   * `address`). So a placeholder exercises exactly the same paths, which is the
   * argument `C232` already made about the signing key.
   *
   * **AND THE LITERAL WAS A LIABILITY IN TWO DIRECTIONS.** It is a value this
   * folder's own scanner reads out of `.midnight/` and refuses in a file that
   * ships. It also goes stale the day the account contract is redeployed,
   * leaving a public repository whose tests name a dead address — **and a test
   * that reads it from a fixture instead would be worse, because a clone has no
   * such fixture and would fail for want of a deployment it cannot reach.**
   * A constant nothing compares is the only one of the three that is true in
   * every clone.
   */
  const PLACEHOLDER_ACCOUNT_ADDRESS = 'an-account-address-that-is-not-a-real-one';

  /**
   * The account's real on-chain VERIFYING key, and it stays. It is on a public
   * chain, it is the value this comparison is actually about, and it is not a
   * value any secret root carries.
   */
  const LIVE_ACCOUNT_KEY = authKey('50101e92e4679df5c9ddac69c5acb491d24ee42467e972d97ff99960a94ae8b1');

  /**
   * **A PLACEHOLDER, AND THE REAL ONE IS DELIBERATELY NOT HERE. `C232`.**
   *
   * `S61` first wrote `.midnight/maintenance-authority.json`'s ACTUAL
   * `signingKey` into this file, so that the pair under test would be the pair
   * the chain carries. **Its `money-safety-auditor` graded that `P0` and it was
   * removed in the same round.** That key is what `C353` is about — whoever
   * holds it can swap `recordPayment`'s verifier key and every vault's
   * unshielded money leaves — and this file is tracked, in a repository rule 10
   * says is going public, while `.midnight/` is mode `0600` and gitignored.
   *
   * **AND IT BOUGHT NOTHING**, which is why the correction costs nothing: the
   * constant is only ever compared against itself through `derive` below, so a
   * placeholder exercises exactly the same paths. **The real pair was measured
   * where a real pair belongs — against the live chain, by
   * `MAINTENANCE-AUTHORITY-CHECK.command`, which derives it at run time from
   * the `0600` file and never writes it anywhere.** A test cannot establish
   * that two real keys correspond; only the chain can, and it did.
   *
   * The VERIFYING key above is the account's real on-chain one and stays: it is
   * on a public chain and is the value this comparison is about.
   */
  const PLACEHOLDER_SIGNING_KEY = authKey('a-signing-key-that-is-not-a-real-one');

  /** The runtime's derivation, stubbed. Never the runtime's own on this path. */
  const derive = (sk: { tag: string; value: string }) =>
    sk.value === PLACEHOLDER_SIGNING_KEY.value ? LIVE_ACCOUNT_KEY : authKey(`vk-of-${sk.value}`);

  const readOf = (committee: unknown[], threshold: number, counter: bigint, shape: string,
                  address = 'addr') =>
    ({ state: 'read' as const, address, authority: { committee, threshold, counter, shape } });

  it('says AGREE when the chain carries the key the single-key file on disk derives to', async () => {
    /* The real pair: `.midnight/maintenance-authority.json`'s signing key and
     * the verifying key the stagenet account actually carries. Measured. */
    const { compareAuthority, intendedAuthorityValue } = await import('./ledger.js');
    const intended = intendedAuthorityValue(
      { kind: 'single-key', signingKey: PLACEHOLDER_SIGNING_KEY,
        temporary: { fixedBy: 'a round that has not run' } } as never, derive as never);
    const r = compareAuthority(
      readOf([LIVE_ACCOUNT_KEY], 1, 0n, 'one-key', PLACEHOLDER_ACCOUNT_ADDRESS) as never, intended);
    expect(r.verdict).toBe('agree');
  });

  it('says AGREE when only the replay counter differs, because the end state is what is compared', async () => {
    /* `SC6b`: compare the LIVE AUTHORITY against the intended END STATE, not
     * against a counter. A settled contract whose counter has moved is settled. */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 2, 9n, 'committee') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('agree');
  });

  it('says DISAGREE when the chain carries a different key set at the same threshold', async () => {
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_1, AUTH_KEY_2], 2, 0n, 'committee') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('disagree');
  });

  it('says DISAGREE when the chain still carries one key and a committee was intended', async () => {
    /* **The half-applied change `C354` exists for**: the account took the update
     * and a vault did not, or the reverse. Either way this is what it looks like,
     * and until this round nothing in this repository could see it. */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_1], 1, 0n, 'one-key') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('disagree');
  });

  it('says DISAGREE and names the reason when the members match but the order does not', async () => {
    /* MEASURED: the same three keys in a different order serialize to different
     * bytes, so the on-chain VALUE differs while the signers do not. Said out
     * loud so `2y9-2` does not spend a real update replacing a value with an
     * equivalent one. */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_3, AUTH_KEY_2, AUTH_KEY_1], 2, 0n, 'committee') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('disagree');
    expect(r.why).toContain('SAME MEMBERS, DIFFERENT ORDER');
  });

  it('says UNKNOWN and never DISAGREE when the chain could not be asked', async () => {
    /*
     * **THE ONE THIS ROUND EXISTS TO GET RIGHT.** `R4`'s distinction, and `S55`
     * shipped a `P1` by collapsing exactly this three into two: *the ledger
     * cannot answer* is NOT *the answer is no*. A comparison returning
     * `disagree` here would send `2y9-2` to re-sign and resubmit a maintenance
     * update against a chain it never read.
     */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      { state: 'unreachable', address: 'addr', why: 'the indexer did not answer' },
      { committee: [AUTH_KEY_1], threshold: 1 });
    expect(r.verdict).toBe('unknown');
    expect(r.verdict).not.toBe('disagree');
  });

  it('says UNKNOWN and not DISAGREE when the provider holds no state for the address', async () => {
    /*
     * `queryContractState` answers `null` both for an address with no contract
     * AND for an indexer that has not caught up (`index.mjs:1354` cannot tell
     * them apart). Reading it as *your change did not land* is `S55`'s error in
     * a new shape: a definite negative from an ambiguous answer.
     */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      { state: 'absent', address: 'addr', why: 'no contract state at this address' },
      { committee: [AUTH_KEY_1], threshold: 1 });
    expect(r.verdict).toBe('unknown');
  });

  it('REFUSES to compare a chosen threshold of zero rather than agreeing about it', async () => {
    /*
     * **THE NEAR-MISS `S61`'s `money-safety-auditor` CAUGHT.** A `0` typed into
     * a committee choice file would have made `intendedAuthorityValue` return
     * `threshold: 0`, the chain carry `0`, and `compareAuthority` answer
     * `agree` — the door then printing *"Every contract carries the authority
     * recorded for it"* over a contract anybody in the world can maintain. A
     * comparator that agrees about a value neither side should ever hold is
     * worse than one that refuses.
     */
    const { intendedAuthorityValue } = await import('./ledger.js');
    expect(() => intendedAuthorityValue(
      { kind: 'committee', committee: [AUTH_KEY_1, AUTH_KEY_2], threshold: 0 } as never,
      derive as never)).toThrow(/threshold below one|NO SIGNATURES AT ALL/);
  });

  it('projects all three choices on disk to the value the deploy path builds', async () => {
    /* `partial-contract.ts:311-316` is the only place these three are ever turned
     * into an on-chain value; this restates it so a comparison is possible
     * without deploying, and goes red if that mapping changes. */
    const { intendedAuthorityValue } = await import('./ledger.js');
    const chosen = (c: unknown) => intendedAuthorityValue(c as never, derive as never);
    expect(chosen({ kind: 'unmaintainable' })).toEqual({ committee: [], threshold: 1 });
    expect(chosen({ kind: 'committee', committee: [AUTH_KEY_1, AUTH_KEY_2], threshold: 2 }))
      .toEqual({ committee: [AUTH_KEY_1, AUTH_KEY_2], threshold: 2 });
    expect(chosen({ kind: 'single-key', signingKey: PLACEHOLDER_SIGNING_KEY,
      temporary: { fixedBy: 'x' } }))
      .toEqual({ committee: [LIVE_ACCOUNT_KEY], threshold: 1 });
  });
});
