/*
 * The fake chain the ledger tests run against: a harness that records every circuit call,
 * the module mocks that hand it back to the ledger, and the values every test shares.
 */
import { served, testAddress } from '../testing/served-state.js';
import { vi, beforeEach } from 'vitest';
import { MidnightLedger, type MidnightConfig, type FeeSponsor, type SealedStateStore } from './ledger.js';
import type { StateChange, SignerRef } from '../core/ledger.js';
import { MidnightCommitments } from './commitments.js';
import { fromHex, toHex } from '../core/crypto.js';
import type { Sealed, Hex } from '../core/crypto.js';
import { arityFrom } from './circuit-arity.js';
/*
 * The generated contract, imported for real and handed back to the ledger by
 * the mock below. Only the state reader is faked; the commitment circuits are
 * the contract's own, because what is under test is that this class asks the
 * contract for a commitment rather than hashing the values itself, and a stub
 * that answered every question with the same bytes could not tell the two
 * apart. They are pure circuits, so they need no proof server, no node and no
 * proving keys.
 */
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { TEST_TOKEN } from '../testing/assets.js';


export const CFG: MidnightConfig = {
  indexerUrl: 'http://indexer', indexerWsUrl: 'ws://indexer', proverUrl: 'http://prover',
  nodeUrl: 'http://node',
  // A real path, so the arity guard reads the real compiled ABI rather than a
  // stub that would share the bug's blind spot.
  zkConfigPath: new URL('../../contracts/managed', import.meta.url).pathname,
  networkId: 'preview',
  privateStateId: 'confidential-accounts-preview',
};

const SEALED_BYTES = { iv: '00', ct: '11', tag: '22' } as unknown as Sealed;
/*
 * The blob store below answers every `get` with `SEALED_BYTES`. The state is
 * filed under its key epoch: `MidnightLedger.fetch` reads it back by epoch.
 * `fetch` is not covered by any test in this file.
 */
export const OTHER = 'bb'.repeat(32) as Hex;
export const PAYLOAD_HASH = 'cc'.repeat(32) as Hex;
/* The deadline every raise here carries: the last block time, in seconds, it may land at. */
export const RAISE_BY = 1_800_086_400n;

/**
 * ONE ASSET, NAMED EVERYWHERE.
 *
 * The account's asset blinding is what turns a code into the opaque key the
 * on-chain map is filed under, so it has to be the same value in the device's
 * private state and in the view the caller passes. A test that let the two
 * differ would be testing a device that cannot find its own money.
 */
export const ASSET = TEST_TOKEN;
const ASSET_BLINDING = '44'.repeat(32) as Hex;


/**
 * The approved change: relative, and it names the asset, because approving a
 * payment of £200 must not authorise moving the same integer in euros.
 *
 * The account holds no money; the change describes what a vault may pay.
 * `changeCommitmentOf` binds the asset either way, which is why `ASSET_KEY`
 * below exists.
 */
export const CHANGE: StateChange = {
  asset: ASSET,
  amount: 20_000n,
  batchDigest: '11'.repeat(32),
  salt: '22'.repeat(32),
};

export const BY: SignerRef = { signerId: 'sgn_1', leaf: 'ff'.repeat(32) };

/*
 * What the chain should hold, computed by the contract's own circuits.
 *
 * Written out here rather than asserted as opaque constants so that a test
 * failure names which rule broke: the asset key, the proposal id, or the
 * change commitment.
 */
const ASSET_KEY = MidnightCommitments.assetKey(ASSET, ASSET_BLINDING);
/*
 * `ASSET_KEY` is not a balance: it is the opaque key an asset is named by,
 * derived by the contract from the account's own blinding, and the change
 * commitment below is built on it. Which asset moves is part of what the
 * signers approve.
 */
export const PROPOSAL_ID = MidnightCommitments.proposalId(PAYLOAD_HASH, CHANGE.salt);
export const CHANGE_COMMITMENT = MidnightCommitments.changeCommitment(
  ASSET_KEY, CHANGE.amount, CHANGE.batchDigest, CHANGE.salt);

export const argHex = (a: unknown): string => Buffer.from(a as Uint8Array).toString('hex');

/*
 * Diagnostic trace: which `harness()` served a call, and which one served the
 * read.
 *
 * It exists for an intermittent failure on the no-match branch of
 * `propose`'s post-check (`ids on chain (0): none`): the state read back fine
 * and held nothing. The question is not how an id is derived but whether
 * `record('propose')`'s `proposals.set(…)` is visible to the
 * `queryContractState` that runs after it, when both close over the same
 * `Map` in the same `harness()` call. Two answers are possible:
 *
 *   · the same harness id on both lines, size 0 at the read: the write never
 *     happened. Look at what ran instead of the `propose` branch.
 *   · different harness ids: the call and the read were in different
 *     harnesses, so the `set` landed in a map nobody read. That is a fault in
 *     how the module mock is bound, not in the ledger.
 *
 * It is silent on the passing path: the trace is registered through the test
 * context's `onTestFailed`, which fires only after a failing test. It stays
 * because it costs one array push per circuit call and one per state read,
 * and prints only when a test has already failed.
 */

/** Bumped once per `harness()` call, for the lifetime of this module. */
let HARNESS_SEQ = 0;

/** What the current test's harnesses did, in order. Cleared before each test. */
const TRACE: string[] = [];

beforeEach((ctx) => {
  TRACE.length = 0;
  ctx.onTestFailed(() => {
    // `console.error`, so it reaches the same stream the failure does and is
    // attributed to the test by the reporter. The marker below is a string other
    // tooling may search for, so the words stay.
    console.error(`harness trace: ${TRACE.length === 0 ? 'no harness activity' : TRACE.join('  ')}`);
  });
});

/**
 * Which harness a ledger is bound to, which is not "the last one built".
 *
 * The three module mocks below are registered once, here, and are stateless.
 * `vi.doMock` keeps one factory per module path for the whole file, and
 * `MidnightLedger.connect` resolves the module lazily (`await import(…)` at
 * call time), so mocks registered inside `harness()` would let a ledger get
 * whichever factory the registry held when the circuit was called, not the one
 * built beside it: the write would land in one harness's `proposals` map and
 * the post-check would read another's (`call h#10 propose proposals 1->1
 * read h#11 proposals 0`). That fails only when a file builds more than one
 * harness. So the mocks read the harness off the providers bundle the ledger
 * was constructed with, the only per-ledger handle that reaches them:
 * `connect` passes `await this.providers()` straight into
 * `findDeployedPartialContract`. `connect`'s lazy import is correct for the
 * product, where there is one implementation of that module and not one per
 * test.
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
      'constructed harness instead is the defect this file exists to prevent.');
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
 * `connect` goes through the partial-aware find, because the SDK's
 * `findDeployedContract` refuses a partial deployment outright, so the seam
 * this harness replaces is that one. Same shape: hand back the fake `callTx`
 * belonging to these providers and let the class's own logic run.
 */
vi.doMock('./partial-contract.js', async () => ({
  /*
   * The real module first, and only what needs a network is replaced. A
   * factory returning `findDeployedPartialContract` alone would drop every other
   * export of the module `MidnightLedger.open` imports, such as
   * `requireMaintenanceAuthority`, a pure validator with no network in it. A
   * test reaching `open`'s next gate would then die on
   * `requireMaintenanceAuthority is not a function` and read as a refusal from
   * the class under test. A module mock that removes a guard is how a check
   * stops being exercised without anybody deleting it, and the spread stops the
   * next export added to that module from disappearing the same way.
   *
   * `submitPartialDeployTx` is still replaced, with a refusal rather than a
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
export function harness(chain: {
  /*
   * There is no `assets` option: the contract has no balance map, so a fake
   * chain that handed one over would carry a field the deployed contract does
   * not have.
   */
  /** Every proposal open at once: there is no single "the" open one. */
  openProposals?: Array<{ id: Hex; change: Hex }>;
  approvals?: bigint;
  threshold?: bigint;
  /**
   * The vaults somebody gave their own threshold. The default is an empty map
   * rather than a missing one, which is the state every account is in and is
   * not the same state as a map the reader did not hand over.
   *
   * The fake state must carry every field the deployed contract's decoded state
   * has: a fake chain that omitted one lets a broken read pass, or throws.
   *
   * `null` simulates the reader not handing the map over at all, which is the
   * case `mapField` exists to refuse.
   */
  vaultThresholds?: Array<[Hex, bigint]> | null;
  /**
   * The fourth map, an option for the same reason `vaultThresholds` is: `null`
   * simulates the reader not handing it over, which the boundary must refuse
   * rather than read as "nobody has approved anything".
   */
  approvalCounts?: null;
  /* Three reads, one rule: `null` omits the accessor entirely, which the
   * boundary must refuse rather than read as zero. Seats are
   * `signerLeaves.size()`; `retiredAt` is read for its keys, meaning ever
   * retired, not is retired. */
  signerCount?: bigint | null;
  movementCount?: bigint | null;
  retiredVaults?: Array<[Hex, bigint]> | null;
  /** The vaults the company holds. Omitted, every vault asked about is held. */
  heldVaults?: Hex[];
  /** Each proposal's bar and removal count when raised. Omitted, a bar of 0 at the removals now. */
  holds?: Array<[Hex, { needed: bigint; removals: bigint }]>;
  /** The account's removal count. 0 by default. */
  removalsSoFar?: bigint;
  /*
   * There is no `balanceAfterMove`: no circuit moves a balance and no map
   * records one.
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
  /** The account's shared map, as [key, value] pairs of hex. Empty by default. */
  signerRoles?: Array<[Hex, Hex]>;
  /** The values `movements` holds, for membership tests. Its size stays `movementCount`'s. */
  movementValues?: Hex[];
  /** The address the account is found at. `testAddress(1)` by default. */
  address?: string;
  /**
   * Refuse at once when anything asks this chain for its providers, for a test
   * whose subject must stop before a call ever needs them. Without it a call
   * that went too far waits out the deploy path's pause and retries.
   */
  providersRefused?: boolean;
  /**
   * The blob store starts empty and answers only what was put into it, for a
   * test of what is kept. Without it every read answers one sealed state.
   */
  keptOnly?: boolean;
},
/**
 * The deployment bag, a separate argument because it is a separate
 * constructor slot.
 *
 * `undefined` by default, which is what every test here but the deployment
 * ones wants: a client that only calls an existing account has no business
 * holding deployment credentials, and `open` is the only method that reads
 * them.
 *
 * Typed off the constructor by position rather than restated, so a slot
 * inserted before it changes this type instead of silently re-aiming the
 * argument.
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
     * There is no `execute` branch: the account holds no balance and no circuit
     * moves one.
     */
    // Cancelling REMOVES the proposal rather than zeroing a flag beside it,
    // which is why presence is the whole answer to "is it open".
    if (circuit === 'cancel') proposals.delete(toHex(args[0] as Uint8Array) as Hex);
    if (circuit === 'closeExpiredRun') {
      proposals.delete(toHex(args[0] as Uint8Array) as Hex);
    }
    if (circuit === 'propose' && (chain.proposeLands ?? true)) {
      /*
       * The id the MERGED contract keys it under: one circuit, two
       * derivations, and `args[6]` — `isRun` — picks between them exactly as
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
        (args[6] as boolean)
          ? MidnightCommitments.proposalId(
              MidnightCommitments.runPayload(
                toHex(args[1] as Uint8Array),
                args[2] as bigint, args[3] as bigint, args[4] as bigint, args[5] as bigint),
              CHANGE.salt,
              toHex(args[7] as Uint8Array))
          : MidnightCommitments.proposalId(
              toHex(args[0] as Uint8Array), CHANGE.salt, toHex(args[7] as Uint8Array)),
        chain.changeOnPropose ?? CHANGE_COMMITMENT,
      );
    }
    TRACE.push(`call h#${harnessId} ${circuit} proposals ${proposalsBefore}->${proposals.size}`);
    return { public: { txId: 'tx_deadbeef' } };
  };

  // Declared with rest parameters so Function.length is 0, exactly like the
  // generated interface: a stub written any other way shares the arity guard's
  // blind spot.
  const callTx: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    propose: record('propose'),
    approve: record('approve'),
    cancel: record('cancel'),
    closeExpiredRun: record('closeExpiredRun'),
    sealPayKey: record('sealPayKey'),
  };
  /*
   * The fake must not outlive the contract it fakes. A stub that stays
   * reachable after its circuit is deleted feeds undefineds into the real code,
   * and a stub modelling an old argument shape derives plausible ids that
   * belong to no contract. So every name faked here is checked against the real
   * compiled ABI at construction: a contract change fails this line, by name,
   * instead of a dozen tests by arithmetic. A stub written from the code's own
   * wrong model checks nothing; this is where the file enforces its model.
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
  const releases: unknown[] = [];
  const paidFor: string[] = [];
  const sponsor: FeeSponsor = {
    addFeeAndFinalise: async (tx) => tx,
    submit: async (tx) => { submits.push(tx); return { ref: 'sponsor_submit', at: '' }; },
    // Recorded rather than ignored: a release on this path would be a booking
    // this ledger let go of, and a double that swallowed it would hide that.
    release: async (booking) => { releases.push(booking); },
    // Recorded for the same reason: whose transaction the fee payer was told it
    // was paying for is the one fact that cannot be recovered afterwards.
    payingFor: (accountId) => { paidFor.push(accountId); },
    capacity: async () => ({ dust: 0n, night: 0n }),
  };

  const puts: Array<{ commitment: Hex; keyEpoch: number }> = [];
  const kept = new Map<string, unknown>();
  const blobs: SealedStateStore = {
    put: async (id, c, keyEpoch, sealed) => { puts.push({ commitment: c, keyEpoch }); kept.set(`${id}|${c}|${keyEpoch}`, sealed); },
    get: async (id, c, keyEpoch) => (chain.keptOnly ? (kept.get(`${id}|${c}|${keyEpoch}`) ?? null) : SEALED_BYTES) as never,
  };

  // What `stageChange` wrote, so a test can assert the witnesses actually
  // reached the place the circuit reads them from.
  const staged: Array<{ key: string; value: any }> = [];
  // Every contract address the class set on the provider before staging.
  const addressed: string[] = [];
  const held = chain.privateState === undefined
    ? {
        secretKey: new Uint8Array(32),
        blinding: new Uint8Array(32),
         /*
          * The account's, not this signer's, and every signer holds the same one. It
          * turns an asset code into the opaque key the contract derives, and
          * `changeCommitmentOf` needs it on every propose.
          */
        assetBlinding: fromHex(ASSET_BLINDING),
      }
    : chain.privateState;

  const providers = async () => (chain.providersRefused ? (() => {
    throw new Error('the providers were asked for: the call went past the gate this test stops it at');
  })() : {
    /*
     * **WHICH HARNESS THIS BUNDLE BELONGS TO.**
     *
     * The module mock reads `callTx` from here rather than from a closure, so
     * a ledger is served by the harness it was CONSTRUCTED with and by no
     * other. A symbol key, so nothing in `MidnightLedger` can see it, spread
     * it away or collide with it — the class passes this object straight
     * through to `findDeployedPartialContract`, which is the whole mechanism.
     */
    [HARNESS]: { id: harnessId, callTx },
    publicDataProvider: {
      queryContractState: async () => served((() => {
        /*
         * Which harness answered this read, and what it held: the other half of the
         * line `record` writes. A read that reports a different `h#` from the call
         * that preceded it means the call and the read were in different harnesses;
         * the same `h#` with `proposals 0` means the write never happened.
         */
        if (chain.stateGoneAfterCall && calls.length > 0) {
          TRACE.push(`read h#${harnessId} state withheld`);
          return null;
        }
        TRACE.push(`read h#${harnessId} proposals ${proposals.size}`);
        return {
          data: {
            /*
             * The contract's public fields, as the generated reader hands them over:
             * maps that iterate as [key, value] pairs of raw bytes. A fake chain that
             * omitted a field the deployed contract has lets a broken read pass, and a
             * fake that hands over one the deployed contract does not have is the same
             * defect pointing the other way. The contract has no balance map, so the
             * reader is asked for the maps it exports and gets exactly those.
             */
            openProposals: [...proposals].map(([id, change]) => [fromHex(id), fromHex(change)]),
            /*
             * A map that iterates as well as looks up, because the generated reader's
             * does. A fake declaring only `lookup` would be the half `mapField` cannot
             * check, so a harness shaped like that could never catch an unguarded read.
             *
             * `null` here means the reader handed the map over not at all, the same case
             * `vaultThresholds: null` covers one map along.
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
             * `[Uint8Array, bigint]` pairs, matching the generated reader's own declared
             * iterator. `null` here means the reader handed nothing over.
             */
            thresholds: chain.vaultThresholds === null
              ? undefined
              : (chain.vaultThresholds ?? []).map(([v, t]) => [fromHex(v), t]),
            /*
             * `signerLeaves`, because the boundary derives the signer count with
             * `.size()`. The option above keeps its name: what a test wants to say is
             * "this chain has N signers", and which field answers that is the
             * boundary's business. `null` omits the accessor, which is the reader
             * handing over less than it declares.
             */
            signerLeaves: chain.signerCount === null ? undefined : { size: () => chain.signerCount ?? 3n },
            movements: chain.movementCount === null ? undefined : {
              size: () => chain.movementCount ?? 0n,
              member: (v: Uint8Array) => (chain.movementValues ?? []).includes(toHex(v) as Hex),
            },
            signerRoles: {
              member: (k: Uint8Array) => (chain.signerRoles ?? []).some(([key]) => key === toHex(k)),
              lookup: (k: Uint8Array) => fromHex((chain.signerRoles ?? []).find(([key]) => key === toHex(k))![1]),
            },
            retiredAt: chain.retiredVaults === null ? undefined : (chain.retiredVaults ?? []).map(([v, t]) => [fromHex(v), t]),
            vaults: { member: (v: Uint8Array) => chain.heldVaults === undefined || chain.heldVaults.includes(toHex(v) as Hex) },
            proposalHolds: {
              member: () => true,
              lookup: (k: Uint8Array) => {
                if (toHex(k) === toHex(pureCircuits.removalCountKey())) return { needed: 0n, removals: chain.removalsSoFar ?? 0n };
                const own = (chain.holds ?? []).find(([id]) => id === toHex(k));
                return own ? own[1] : { needed: 0n, removals: chain.removalsSoFar ?? 0n };
              },
            },
          },
        };
      })()),
    },
    privateStateProvider: {
      /*
       * The class sets the contract address explicitly before every private-state
       * read or write, so the stub must accept the call. Recorded rather than
       * ignored, so a test can assert the address was set, and set to the
       * account's own address, before anything staged.
       */
      forContract: (address: string) => (addressed.push(address), {
        get: async () => held, set: async (key: string, value: any) => { staged.push({ key, value }); },
      }),
    },
  });

  /*
   * The module mocks are registered once, at module scope, and they read this
   * harness's `callTx` off the providers bundle. See `HARNESS`: a factory that
   * closed over `callTx` here would bind every ledger to the last harness built.
   */

  /*
   * The constructor takes seven arguments, and the sixth is `compiled`, not the
   * deployment bag. A call passing six lands `{}` on `compiled`, leaves
   * `deployment` undefined, and `open`'s first guard then refuses every opening
   * before any deployment refusal can fire. `tsc` cannot see it: `compiled` is
   * typed `unknown` so it accepts anything, and `deployment` is optional so its
   * absence is legal. A hand-written double is the one place the compiler
   * cannot be leaned on, so the slots are named here instead.
   */
  const ledger = new MidnightLedger(
    CFG,
    sponsor,
    blobs,
    async () => chain.address ?? testAddress(1),
    providers as any,
    /* compiled — nothing in this file calls a circuit through it. */ {},
    deployment,
  );
  /*
   * There is no seam past the public boundary here: a test cast that outlives
   * what it was built to reach is how a test file acquires a door nobody
   * decided on.
   */
  return { ledger, calls, submits, puts, staged, addressed };
}
