/**
 * The Midnight implementation of the boundary declared in core/ledger.ts.
 *
 * Status, corrected 27 Aug 2026. This header used to say the file had never been
 * run against a node. That stopped being true on 13 Aug: a full multi-signer
 * lifecycle settled on stagenet — credit, propose, approve, a mid-round deposit,
 * a second approve and execute, four of which have since been DELETED by `C292`
 * — with the chain's own state read back afterwards
 * and the new state commitment matching the contract's own scheme
 * (`REPORT-WASM-PROVING.txt:488-504`). It was proved in process through zkir
 * WASM with no proof server, at 94.2s to 114.5s per circuit end to end
 * (`:494-500`).
 *
 * WHAT IS STILL UNRUN, AND IT IS NOT A DETAIL. `settle` USED TO THROW HERE —
 * value movement was not wired, deliberately, rather than faked — and `C292`
 * removed the method rather than leaving a refusal to integrate against; there
 * is no value movement at this boundary at all. `open` throws without
 * deployment credentials (`:377`), pointing at `scripts/deploy-preview.ts`
 * as the one working deploy path. And `MidnightProofSystem` at the foot of this
 * file is a shell: `prove` and `verify` both throw (`:2019`, `:2023`) and ALL
 * THREE of the logical circuits map to nothing (`CIRCUIT_MAP`, `:2007`) — it
 * was two of three until `S23` shed `attestSolvency`.
 *
 * So: the methods the settled lifecycle exercised have been run against a node,
 * every method it did not exercise remains unverified until a transaction
 * settles through it, and the ones it exercised that no longer exist prove
 * nothing about what is here now.
 *
 * Everything is written against evidence rather than memory: the ABI in
 * contracts/managed/compiler/contract-info.json, the installed packages in
 * node_modules rather than the midnight-js source repo, which is ahead of what
 * npm publishes, and the Foundation's own DUST sponsorship example.
 *
 * Three things resolved during the spike, all of which shaped this file.
 *
 * 1. FEE SPONSORSHIP IS A FIRST CLASS FEATURE, NOT A WORKAROUND.
 *
 *    DUST is non-transferable, so it cannot be topped up into a contract-owned
 *    account. The protocol answer is two-phase balancing: the user balances the
 *    shielded and unshielded legs of the transaction and signs, then a sponsor
 *    balances only the dust leg and submits. The user wallet does not need to
 *    hold NIGHT or register for DUST generation at all.
 *
 *    This is exactly the SaaS shape we wanted. The customer never sees a token.
 *    We run the sponsor as a service, hold NIGHT, and pay their fees.
 *
 * 2. THERE IS NO SHARED PRIVATE STATE PRIMITIVE, SO WE BUILD ONE.
 *
 *    Midnight private state is per party and client held. A witness runs on one
 *    device against that device's own store. Nothing in the protocol lets N
 *    signers read the same confidential balance.
 *
 *    So the account layer supplies it: state is sealed under a viewing key and
 *    the key is wrapped to each signer's x25519 public key. That is already how
 *    core/account.ts works, which means the simulation was not a shortcut, it
 *    was the design. A commitment to the sealed state WENT ON CHAIN as well,
 *    and no longer does.
 *
 *    **AND NOTHING MAKES THE OFF-CHAIN BLOB TAMPER EVIDENT TODAY.** The
 *    contract's `stateCommitment` field was what did, and it went with the
 *    balance ledger; the value a blob is filed under is now
 *    `viewDigestOf([])`, one constant for every account and every state, which
 *    commits to nothing. Said in those words because rule 27 requires it: this
 *    property holds against nobody, and a vault-side commitment is what would
 *    restore it.
 *
 * 3. MIDNIGHT HAS NO ACCOUNT ABSTRACTION.
 *
 *    The Foundation's own wallet documentation lists the smart contract and
 *    account abstraction row as empty across every interface. Nothing to
 *    integrate with, and nothing competing.
 */
import type {
  Ledger, LedgerAddress, LedgerRecord, TxRef, ProofSystem, Circuit,
  StateView, StateChange, LedgerStatus, SignerRef, AccountOpening,
  SealedStateAt, PaymentsAmong,
} from '../core/ledger.js';
import { viewDigestOf } from '../core/ledger.js';
import type { AssetId } from '../core/assets.js';
import { assetIdBytes, NO_ASSET } from '../core/assets.js';
import { MidnightCommitments } from './commitments.js';
import type { Sealed, Hex } from '../core/crypto.js';
import { toHex, fromHex, randomBytes } from '../core/crypto.js';
import type { NetworkName } from './network.js';
import { arityFrom, assertArity } from './circuit-arity.js';
import { withRetry, sleep, type RetryOptions } from './retry.js';
import { isDeferredCircuit, deferredCircuitError } from './deferral.js';
import { refuseACallWithoutItsPrivateState } from './governed-call.js';
import type { MaintenanceAuthorityChoice } from './partial-contract.js';
import { paysNoFees } from './fee-seat.js';
import {
  authorityValueRefusals, isAuthorityKey, replaceAuthorityOf, requireBuildableAuthority,
  type AuthorityReplacementPrimitives, type MaintenanceRefusal,
} from './authority-replacement.js';
export {
  authorityValueRefusals, replaceAuthorityOf, requireBuildableAuthority,
  type AuthorityReplacementPrimitives, type MaintenanceRefusal,
} from './authority-replacement.js';

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */

/**
 * One step of a round, described rather than performed.
 *
 * The shape mirrors the circuits exactly, so there is nothing to invent and
 * nothing to keep in sync by hand. A job carries one of these; `prepare` turns
 * it into a call.
 */
export type PreparedStep =
  | { kind: 'propose'; payloadHash: Hex; change: StateChange; vault: Hex }
  | { kind: 'approve'; proposalId: Hex }
  | { kind: 'cancel'; proposalId: Hex }
  | { kind: 'addSigner'; leaf: Hex; proposalId: Hex | null }
  | { kind: 'removeSigner'; removedLeaf: Hex; proposalId: Hex }
  | { kind: 'setThreshold'; newThreshold: number; proposalId: Hex }
  /**
   * `vault` is the vault being GIVEN a threshold, and it is in the
   * payload the proposal committed to — not in the proposal's identity, which
   * names `noVault()` because this is a governance round.
   */
  | { kind: 'setVaultThreshold'; vault: Hex; newThreshold: number; proposalId: Hex }
  /**
   * A PAYROLL RUN, RAISED WITH ITS WINDOW AND ITS VAULT. V-67, V-73.
   *
   * A sibling of `propose` rather than an argument to it, because `propose`
   * takes its payload as an opaque hash — deliberately, so the account never
   * learns what a governance proposal contains — and that opacity is exactly
   * what stops it recording a window it cannot verify. The contract builds the
   * run's payload itself; so does this step.
   *
   * `vault` is not optional and must not be defaulted. It is committed inside
   * the proposal's identity, so a wrong value does not fail loudly — it
   * produces an id no payment can ever match.
   */
  | { kind: 'proposeRun'; root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex; change: StateChange }
  /**
   * Sweeping a run whose window has closed. V-67.
   *
   * Permissionless on chain, and it asserts nothing about completeness — a run
   * whose window passed with three payees unpaid closes exactly the same way.
   * What was paid is in `movements`, permanently, and that is the only honest
   * source. See `run-status.ts`.
   */
  | { kind: 'closeExpiredRun'; proposalId: Hex };

/**
 * A circuit call, checked and staged, not yet built.
 *
 * `expectCommitment` is set only for the steps that move the state, and it is
 * the value the chain should hold once this settles. It is what turns an
 * interrupted job from a guess into a question with an answer: `recover` reads
 * the account and compares. Absent for the steps that change no state, because
 * for those there is nothing to compare and the circuit's own duplicate guard
 * is what makes a retry safe instead.
 */
export interface PreparedCall {
  address: string;
  /**
   * Where this call's private state is filed, or `null` for a circuit that
   * reads none.
   *
   * **`null` IS A STATEMENT AND NOT AN ABSENCE, WHICH IS WHY IT IS NOT
   * OPTIONAL.** Every caller must say which of the two it means, because the
   * SDK cannot tell them apart and neither could a reader: it OMITS the field
   * on a falsy value and then tests for its PRESENCE, so a key that is missing
   * because nobody passed it selects the same branch as a key that is missing
   * on purpose - and for the eight circuits that open with a signer check,
   * that branch hands the executing circuit no private state at all.
   *
   * `closeExpiredRun` is the one circuit here that is `null`. It calls no
   * witness, so it needs no record, and it is permissionless on chain by
   * design: requiring a record would mean a client that had never staged one
   * could not sweep a run whose window has closed, which is the property the
   * contract argues for at length beside that circuit.
   */
  privateStateId: string | null;
  circuit: string;
  args: unknown[];
  expectCommitment?: Hex;
}

export interface MidnightConfig {
  /** Where the indexer serves public contract state. */
  indexerUrl: string;
  indexerWsUrl: string;
  /** The proof server. Local in development, ours in production. */
  proverUrl: string;
  /** A Midnight node RPC endpoint. */
  nodeUrl: string;
  /** Compiled artefacts from contracts/build. */
  zkConfigPath: string;
  /**
   * Which network. A lowercase name string, never the ledger enum: see
   * network.ts for why that distinction is load bearing rather than cosmetic.
   *
   * Note there is no 'stagenet'. The staging networks are named preview and
   * preprod in every artefact that npm publishes.
   */
  networkId: NetworkName;
  /**
   * Where the calling device's private state lives.
   *
   * Load bearing since M-29: what a circuit is not handed as an argument it
   * reads from this store as a witness, so a caller has to write there before
   * it calls. `execute` was the case that established the rule and is gone
   *; `propose` is the one that has it now — the change and the
   * proposal salt are staged by `stageChange` below. Keyed per network — M-61
   * was one deployment's private state being read on another chain because this
   * was a constant.
   */
  privateStateId: string;
}

/**
 * The sponsor. Holds NIGHT, therefore generates DUST, therefore pays everyone's
 * fees. Deliberately a narrow interface: it is the only component in the system
 * that touches a funded wallet, so it should be the only one we have to audit
 * for spend authority, and it should be swappable for an HSM or a queue.
 */
export interface FeeSponsor {
  /*
   * Two-phase balancing, per decision 0001:
   *   customer  balanceUnboundTransaction(tx, keys, { tokenKindsToBalance: ['shielded','unshielded'] })
   *   sponsor   balanceFinalizedTransaction(tx, keys, { tokenKindsToBalance: ['dust'] })
   *
   * The token kinds must not overlap. Re-balancing a kind the other party has
   * already balanced is a double spend and the node rejects it.
   */

  /**
   * Phase 2: balances the dust leg only and finalises. The customer has
   * already balanced and signed their own legs.
   */
  addFeeAndFinalise(customerFinalised: unknown, ttl: Date): Promise<unknown>;

  /** Phase 3: submits. Whoever pays the fee submits. */
  submit(finalisedTransaction: unknown): Promise<TxRef>;

  /**
   * Releases coins a balance booked and no submission took.
   *
   * **THE PHASES ABOVE ARE TWO SEPARATE CALLS THE SDK MAKES AT TWO SEPARATE
   * TIMES, AND UNTIL THIS MEMBER EXISTED NOTHING BETWEEN THEM COULD LET GO.**
   * Phase 2 marks coins in-flight in the wallet's own state and returns; phase
   * 3 is a different entry point the SDK reaches later. Anything that goes
   * wrong in between - proving, staging, an expiry, a caller giving up - ends
   * the operation with the booking still standing, and nothing releases it
   * afterwards: the vendor's time-based sweep is a documented no-op, and its
   * own cleanup only acts on transactions that got an answer from the chain,
   * which one that was never submitted never does.
   *
   * The effect is quiet and cumulative. Each failure takes a little of the fee
   * budget out of circulation, the next attempt balances onto fresh coins
   * because the booked ones are filtered out as pending, and the balance that
   * gets reported looks healthy right up until it does not.
   *
   * **REQUIRED, FOR THE SAME REASON PHASE 3 IS.** An optional member would mean
   * a sponsor could be wired in with no way to release, and every caller above
   * would carry on as though there were one.
   */
  release(booking: unknown): Promise<void>;

  /**
   * Which company the transaction about to be handed over belongs to.
   *
   * **IT IS TOLD RATHER THAN DERIVED, AND THAT IS A PROPERTY OF THE PRODUCT
   * RATHER THAN AN OVERSIGHT.** What a fee payer is given is a bound, shielded
   * transaction; the whole point of it is that it says nothing about whose it
   * is. So attribution cannot be extracted afterwards, from the transaction, a
   * receipt or the chain - and a fee payer that pays for whatever arrives has
   * discarded it before anybody asks. The only place the answer exists is the
   * caller, which is why it is a member here.
   *
   * **NOTHING BILLS, METERS, PRICES OR REFUSES ON THIS.** It is a record, taken
   * while it is free to take, because it cannot be reconstructed later.
   *
   * **ONE OPERATION AT A TIME, STATED RATHER THAN ASSUMED**, and it is the same
   * property the provider bundle above this already rests on: the SDK's two
   * callbacks carry nothing to tell one operation from another, so there is no
   * key to attach this to. The queue drives one job at a time, on purpose and
   * for a different reason. If anything ever drives two operations through one
   * fee payer at once, the second one's company overwrites the first's and the
   * record is wrong rather than absent - and the fix is a fee payer per
   * operation rather than a cleverer field here.
   */
  payingFor(accountId: string): void;

  /** Remaining DUST capacity, so we can alarm before customers start failing. */
  capacity(): Promise<{ dust: bigint; night: bigint }>;

  /**
   * **SET, TO `true`, ONLY BY THE STAND-IN THAT FILLS THIS SEAT WHEN NOBODY
   * PAYS.** Every member of that stand-in refuses; this is how anything that
   * describes itself can say so without calling one.
   */
  readonly paysNothing?: true;
}

/**
 * Where the sealed state blob actually lives. The chain holds the commitment
 * only, so something has to hold the ciphertext.
 *
 * Behind an interface because this is the one place where the operator can
 * still hurt a customer, by withholding the blob. Starting on our own storage
 * is fine. Moving to content addressed storage later removes the withholding
 * risk without touching anything else, because the on-chain commitment is
 * already the pointer.
 */
export interface SealedStateStore {
  /**
   * Filed under the commitment AND the key epoch. K-4.
   *
   * The commitment alone does not identify a blob, and treating it as though it
   * did is what makes rotation destructive. The commitment covered the balance,
   * the entry digest and the salt — the plaintext — so the same state re-sealed
   * under a rotated viewing key had the same commitment and entirely different
   * bytes. `C292` only sharpened this: the value passed here is now
   * `viewDigestOf([])`, one constant, so it separates nothing at all. Under a
   * one-key-per-commitment store, writing the second either
   * silently replaces the first or is silently ignored by the never-overwrite
   * rule, and one of those ends the account.
   */
  put(accountId: string, commitment: Hex, keyEpoch: number, sealed: Sealed): Promise<void>;
  get(accountId: string, commitment: Hex, keyEpoch: number): Promise<Sealed | null>;
}

/**
 * Where one account's private state is filed.
 *
 * Exported, and used by the scripts as well as by this class, because it is a
 * rule and rules in this project have a habit of being written twice. The
 * suffix exists because one `MidnightLedger` serves many accounts while a
 * script drives one; without a shared function the two conventions diverge and
 * the run script looks for a key the deploy never wrote. Caught before shipping
 * this time — it is the ninth instance of the pattern.
 */
export const privateStateKey = (base: string, accountId: string): string =>
  `${base}:${accountId}`;

/* ------------------------------------------------------------------ *
 * ledger
 * ------------------------------------------------------------------ */

/**
 * A 32-byte zero, for the one argument a circuit takes and does not read.
 *
 * `addSigner` on the bootstrap path has no proposal to name, and a circuit's
 * arity is fixed — so something has to be passed. Zero is the honest filler: it
 * is a value `persistentCommit` can never produce, so it cannot collide with a
 * real proposal id, and the branch that would read it is not taken.
 */
const ZERO_32: Hex = '00'.repeat(32);

/**
 * The truthful missing-private-state message.
 *
 * This used to say the device did not hold the account's SECRET KEY, which is
 * one of two causes and not the likelier one once a second contract exists:
 * private state is filed under `${contractAddress}:${key}`, so state written
 * while a different contract was addressed is invisible here without being
 * gone. The message now says what is actually missing — a staged entry for
 * THIS contract — and names both ways that happens, because reporting the
 * wrong one sent people to re-seat signers whose state was one prefix away.
 */
const missingPrivateState = (accountId: string, address: string): string =>
  `no private state for "${accountId}" under contract ${address} on this device. ` +
  'Either this device was never seated on the account — it holds no secret key or ' +
  'blinding factor for it — or the account\'s private state was written under a ' +
  'different contract address. Nothing is staged for THIS contract either way, and ' +
  'proving without it would prove against another contract\'s view.';

/**
 * **THE CIRCUITS THAT READ NO WITNESS, AND THEREFORE NEED NO PRIVATE STATE.**
 *
 * Taken from the contract and nowhere else: a circuit is on this list only if
 * it, and everything it calls, reads none of the nine witnesses.
 * `closeExpiredRun` is the only one of the seven circuits this client drives
 * that qualifies - it opens no signer check, reads no salt and reads no asset,
 * and it is permissionless on chain by design
 * (`contracts/src/ConfidentialAccount.compact:2601`).
 *
 * **IT EXISTS BECAUSE `null` ON ITS OWN IS A CLAIM NOTHING HOLDS UP.** A
 * `PreparedCall` may say it needs no private state, and that is the right
 * shape - but a branch that says it wrongly produces exactly the defect this
 * whole mechanism was added to remove: the circuit runs against nothing, the
 * type checks, and no test anywhere goes red. So the claim is checked against
 * the circuit it is made about, in both directions, at the one point every
 * call THIS CLIENT BUILDS passes through - which is not the same as every
 * governed call in this repository: the job runner assembles the SDK's call
 * options itself and this guard is nowhere on that path.
 */
export { CIRCUITS_THAT_READ_NO_WITNESS } from './governed-call.js';
import { CIRCUITS_THAT_READ_NO_WITNESS } from './governed-call.js';

/**
 * **WHICH CIRCUIT EACH PREPARED STEP CALLS, AS ONE TABLE THE COMPILER KEEPS
 * COMPLETE.**
 *
 * The names used to be written at the nine places a step is turned into a call.
 * They are here instead for one reason: **the answer to whether a step needs
 * the calling device's private state is not a property of the step, it is a
 * property of the CIRCUIT the step calls** - and with the names spread across
 * nine branches there was nowhere to compute that from, so it was written out a
 * second time by hand as well.
 *
 * Two steps can name the same circuit and two circuits can be named by one
 * step's neighbours, which is why this is a table and not a convention: a
 * governance round and a payroll run are both `propose`, and adding a signer
 * and removing one are both `amendSigner`.
 *
 * **A `Record` OVER THE STEP'S OWN UNION, SO A NEW STEP DOES NOT COMPILE UNTIL
 * IT HAS AN ANSWER HERE.** A step added without one would otherwise reach the
 * SDK either with a key for a circuit that reads nothing - which puts it on the
 * path where the record is written back after settlement, for a call that
 * changed nothing in it - or with no key for a circuit that reads one, which
 * runs the circuit against no private state at all.
 *
 * **AND IT COVERS THE CALLS THIS CLASS BUILDS, WHICH IS NOT EVERY GOVERNED
 * CALL IN THIS REPOSITORY.** The job runner assembles the SDK's call options
 * itself, from a plan it is handed, and reaches neither this table nor the
 * both-directions check further down. Anything that builds a call that way
 * answers these two questions for itself, and nothing makes it answer them the
 * same way. Said here rather than left to be discovered by whoever writes the
 * second call builder.
 */
export const CIRCUIT_FOR_STEP: Record<PreparedStep['kind'], string> = {
  propose: 'propose',
  /* A payroll run is the same circuit on its other branch. */
  proposeRun: 'propose',
  approve: 'approve',
  cancel: 'cancel',
  /* Seating and unseating are one circuit, and have been since the rename. */
  addSigner: 'amendSigner',
  removeSigner: 'amendSigner',
  setThreshold: 'setThreshold',
  setVaultThreshold: 'setVaultThreshold',
  closeExpiredRun: 'closeExpiredRun',
};

export class MidnightLedger implements Ledger {
  /** Everything this class writes goes to a chain, or it does not get written. */
  readonly wiring = 'chain' as const;
  constructor(
    private cfg: MidnightConfig,
    private sponsor: FeeSponsor,
    private blobs: SealedStateStore,
    /** Resolves an account id to its deployed contract address. */
    private addressOf: (accountId: string) => Promise<string | null>,
    /** Built once by midnightProviders(). Lazy so construction needs no node. */
    private providers: () => Promise<any>,
    /** The CompiledContract, from CompiledContract.make + withWitnesses. */
    private compiled: unknown,
    /**
     * Deployment, which needs things the rest of the interface deliberately
     * refuses to carry. Optional: a client that only calls an existing account
     * has no business holding either.
     */
    private deployment?: {
      /*
       * `deployer()` STOOD HERE AND IT IS GONE. `C334`, 31 Aug.
       *
       * It handed this class the deploying device's `secretKey` and `blinding`,
       * because the constructor's witnesses needed them and there was no
       * private state yet to read them from. That is exactly what made the
       * deployer a SIGNER: the account's first seat was the leaf those two
       * values commit to, and on the only implementation that ever existed they
       * were `seededBytes(1)` and `seededBytes(401)` — a published formula.
       *
       * THE REMOVAL IS THE POINT, AND LEAVING IT UNUSED WOULD NOT HAVE BEEN.
       * There is no injection point here any more, so no secret can reach this
       * class at deploy: the constructor takes the founding signer's LEAF, a
       * public value, and `AccountOpening` already carries it.
       */
      /**
       * Where a new account's address is recorded, so `addressOf` can find it
       * on the next call. A script writes a file; a service writes a row.
       */
      register: (accountId: string, address: string) => Promise<void>;
      /**
       * The maintenance authority the deployed contract gets. REQUIRED, and
       * never defaulted: `deployContract`'s own default is
       * `sampleSigningKey()`, which is how every earlier deployment acquired
       * a single random key able to change which proofs the contract accepts
       *. The deploy refuses to run rather than sample —
       * `requireMaintenanceAuthority` in partial-contract.ts is the refusal,
       * and its error lays the options out.
       */
      maintenanceAuthority: MaintenanceAuthorityChoice;
      /** Passed through so a script keeps its own logging. */
      retry?: RetryOptions;
    },
  ) {}

  /* ------------------------------------------------------------ *
   * the lifecycle
   *
   * This class used to have one write method, `publish(accountId,
   * commitment, sealedState)`, and it could not be implemented. `execute()`
   * derived the new commitment from the witnesses `nextBalance`,
   * `nextEntriesDigest` and `nextStateSalt` — deliberately, so that no public
   * parameter could carry a balance onto the chain — and this class was handed a
   * finished commitment and a ciphertext it could open neither of.
   *
   * The boundary passed the OPENING instead, which is what those witnesses
   * wanted, and named each step of the round rather than collapsing them into
   * one write. **THE OPENING, THE WITNESSES AND `execute` ARE ALL GONE**
   *, and `credit` — the one operation this class used to refuse by
   * name — went with them, because the account keeps no book for either to
   * write to. WHAT SURVIVES IS THE SHAPE: one named method per circuit, no
   * guessing, and a gap that shows up as a missing method rather than as a
   * mystery at deploy time.
   * ------------------------------------------------------------ */

  /**
   * Deploying the contract.
   *
   * Not implemented here on purpose. Deployment is `deployContract` with the
   * constructor's witnesses, a funded wallet, a DUST budget measured against
   * the live chain and a retry around a websocket that drops — all of which
   * `scripts/deploy-preview.ts` already does and has done successfully on two
   * chains. Reimplementing it behind this method would be a second copy of the
   * one thing in this project with the worst record for drifting out of sync
   * (M-50, M-55, M-58, M-61, M-65 were all one rule written twice).
   *
   * So it throws, and says where the working one is. M-68 is to lift that
   * script into this method so there is one deploy path rather than two.
   */
  async open(accountId: string, opening: AccountOpening): Promise<TxRef> {
    if (!this.deployment) {
      throw new Error(
        `cannot open "${accountId}": this MidnightLedger was built without deployment ` +
          'credentials. Deploying needs a maintenance authority and somewhere to record ' +
          'the address the chain assigns, and a client that only calls an existing account ' +
          'has no business holding either.',
      );
    }
    /*
     * **THE OPENING IS VALIDATED FIRST, BEFORE A MODULE IS LOADED OR A PROVIDER
     * IS BUILT.** These three are pure reads of the argument: they need no
     * node, no indexer and no import, they cannot be transient, and putting
     * them first means the refusals below are reachable from a test that has
     * nothing else wired.
     */
    /*
     * **THE FOUNDING SIGNER, AND AN OPENING WITHOUT ONE IS REFUSED HERE RATHER
     * THAN DEPLOYED.**
     *
     * `signerLeaves[0]` is the founding signer — the type says the array is the
     * founding signers' leaves and this is the first of them, so there is ONE
     * place the answer comes from and no second field to keep in step.
     *
     * IT IS REFUSED BECAUSE THE CONTRACT CANNOT REFUSE IT LATER. `amendSigner`
     * opens with `requireSigner()`, so an account deployed with no seat can
     * never have one added — it is dead on arrival, permanently, along with
     * every vault that names it as its authority and the money in them. The
     * constructor's own two guards catch a leaf that is zero or the vacancy
     * marker; nothing on chain can catch an argument that was never supplied,
     * because there would be no deploy to catch it in.
     *
     * `SimulatedLedger.open` has always refused a threshold it cannot reach
     * (`core/ledger.ts:932`); this path never did, and `deploy-preview.ts`
     * passed an empty array against a threshold of two for as long as the
     * deployer supplied the seat itself.
     */
    const foundingLeaf = opening.signerLeaves[0];
    if (!foundingLeaf) {
      throw new Error(
        `cannot open "${accountId}": the opening names no founding signer. The account's ` +
          'first seat is the leaf handed to the constructor, and an account deployed ' +
          'without one can never have a signer added — `amendSigner` requires an existing ' +
          'signer, so there would be nobody able to seat the first.',
      );
    }
    /*
     * **THIS PATH SEATS ONE SIGNER, SO IT REFUSES AN OPENING THAT NAMES MORE
     * THAN ONE RATHER THAN SEATING THE FIRST AND DROPPING THE REST.**
     * money-safety pass.
     *
     * `SimulatedLedger.open` seats EVERY leaf it is given and `AccountService`
     * writes all N onto the durable record. Without this, the day the wiring
     * points at Midnight a 2-of-3 company is created, the roster says three
     * signers, the chain holds one, `open` returns success and nobody is told.
     * A client record and a chain that disagree about WHO MAY APPROVE is the
     * shape every row in the register is a variety of.
     *
     * It is a refusal and not a warning because the alternative is a deployed
     * contract and a spent fee. `C335` / board `4b` is the seating screen that
     * makes the rest real; until it exists, this says so out loud.
     */
    /* `T-200`: the contract's own refusal, reached before a deploy and a fee
     * rather than after — and an unusable founding seat is not recoverable at
     * all, for the reason `:400-406` above already writes out. */
    await this.refuseUnusableLeaf(foundingLeaf, `the founding signer leaf for "${accountId}"`);
    if (opening.signerLeaves.length > 1) {
      throw new Error(
        `cannot open "${accountId}": the opening names ${opening.signerLeaves.length} founding ` +
          'signers and this path can seat exactly one. The constructor creates the founder\'s ' +
          'seat; every seat after it is `amendSigner`, which requires an existing signer to ' +
          'call it AND, since the constructor stopped taking a threshold, an approved proposal ' +
          'behind it — so the rest are proposed, approved and seated by the founder from their ' +
          'own device, and there is no screen for that yet. Open with the founding signer alone.',
      );
    }
    /*
     * **THIS REFUSAL IS KEPT AND WHAT IT GUARDS HAS CHANGED UNDER IT. SAYING SO
     * IS THE POINT OF THIS PARAGRAPH.** `S35d`, rule 27.
     *
     * **WHAT IT USED TO BE.** `opening.threshold` was argument one of the
     * constructor. `requireApproved` asserts
     * `!(approvalCounts.lookup(proposal) < threshold)`; at zero that is
     * `!(0 < 0)` and it PASSES with nobody having approved, and `thresholdFor`
     * hands the account threshold to any vault with no entry of its own — so an
     * account opened at zero was one where `recordPayment` moved a vault's
     * money on a proposal no signer voted for. That is `C340`, and this line
     * was the only thing refusing it, which is what the paragraph that stood
     * here said.
     *
     * **WHAT IS TRUE NOW.** The constructor takes no threshold and sets
     * `threshold = 1` (`C340` + `C343`, the founder, 2 Sep). A zero threshold
     * is UNREPRESENTABLE on chain rather than refused here, so this line is no
     * longer what stands between an account and `C340`. **Nothing it refuses
     * reaches the constructor any more.**
     *
     * **AND IT CLOSED SOMETHING ELSE ON ITS WAY OUT, WHICH NOBODY HAD CLAIMED.**
     * The refusal above accepts exactly one founding leaf; this one accepted any
     * threshold at or above one. So `open({ signerLeaves: [a], threshold: 5 })`
     * deployed a ONE-SIGNER ACCOUNT AT FIVE — an account that can never reach
     * its own threshold and can never lower it, because `setThreshold` is behind
     * `requireApproved`. That is `C343` reached through this path, it was live,
     * and the constructor change makes it unrepresentable too.
     *
     * **SO WHY IT STAYS.** Three reasons, and none of them is the one it was
     * written for. (1) `opening.threshold` is still consumed by
     * `SimulatedLedger.open` and still becomes `account.policy.threshold`, so a
     * non-integer or a zero is still a bad value entering our own records — this
     * refuses it at the boundary both ledgers share, which is where the two
     * implementations are meant to agree. (2) The `Number.isInteger` clause is
     * not redundant with `< 1`: `NaN < 1` is `false`, so without it a `NaN`
     * passes, and `ledger.test.ts` records that as the reason it is there.
     * (3) **`S40` fixed four tests that had never executed against these three
     * refusals.** Deleting one to tidy up would undo that work and would remove
     * the only place the Midnight path states what an opening must look like.
     *
     * **WHAT IT NO LONGER CLAIMS.** The message used to end *"The contract does
     * not refuse this; this does."* That is now false in both directions — the
     * contract does not ACCEPT it either — and it is corrected below rather than
     * left to be read as a live statement about the chain.
     */
    if (!Number.isInteger(opening.threshold) || opening.threshold < 1) {
      throw new Error(
        `cannot open "${accountId}": a threshold of ${opening.threshold} is not a rule. It is ` +
          'refused here because it would enter our own record of the account as its policy. ' +
          'The chain never sees it: since `C340` the constructor takes no threshold and founds ' +
          'every account at one, raised afterwards through the ordinary approval path.',
      );
    }
    /*
     * NOT the SDK's `deployContract`. S8c: the deployment carries the
     * circuits `deferral.ts` names — the fifteen-circuit contract this path
     * was built for exceeded the chain's write ceiling — and the SDK can
     * neither build a partial operations map nor read one back
     * (`partial-contract.ts` has the file:line for both refusals). The
     * contract is eleven circuits since S23 and the list defers none of them
     *, so the map this builds is currently the whole contract; the path
     * stays because it is also what pins the operations map to a decided list
     * rather than to whatever compiled. The partial deploy also
     * refuses to run without a deliberate maintenance authority, which is
     * C225's fix.
     */
    const { submitPartialDeployTx, findDeployedPartialContract, requireMaintenanceAuthority } =
      await import('./partial-contract.js');
    // Validated BEFORE the retry loop: a missing or malformed authority is a
    // refusal to explain, not a transient to retry.
    requireMaintenanceAuthority(this.deployment.maintenanceAuthority);
    const providers = await this.providers();

    /*
     * The constructor COMMITTED to the opening balance from these witnesses,
     * exactly as every later call did — which is why the boundary passed the
     * opening and not a commitment. `next` mirrored `current` because nothing
     * was moving yet, and leaving it undefined would have had the first
     * `execute` commit to whatever happened to be there. All of that went with
     * the balance ledger; the paragraph below is what is true now.
     */
    /*
     * An account holds nothing, ever — `C292` — so there is no balance to open
     * at and no asset entry on chain. The salt below is still a real random
     * value rather than a zero: it is the proposal salt every witness has to
     * answer with, and a predictable one would make a proposal id guessable.
     */
    const genesisSalt = randomBytes(32);
    /*
     * **THE RECORD THE DEPLOY PERSISTS CARRIES NO SIGNING SECRET, NO BLINDING
     * AND NO SCOPE.**
     *
     * `secretKey`, `blinding` and `scope` STOOD AT THE TOP OF THIS OBJECT, in
     * that order, and they were the deploying device's. They were here because
     * the constructor read all three as witnesses; it reads none of them now,
     * so there is nothing for this process to answer with and nothing for it to
     * hold. **The three fields are not defaulted or zeroed — they are absent.**
     * A zero secret is still a secret-shaped value that a later reader could
     * mistake for a device's, and the whole of `C334` is that this record
     * cannot name a signer.
     *
     * WHAT THE SDK REQUIRES IS THE SHAPE, NOT THE CONTENTS:
     * `partial-contract.ts` types `initialPrivateState` as `unknown` at `:228`
     * and `:236` and persists it verbatim at `:357`. `AccountPrivateState` is
     * this repository's own interface, and it is NOT narrowed by this round —
     * `requireSigner()` reads all three on every governed circuit, so a SIGNER'S
     * device holds them. A DEPLOYER is not a signer any more, so the record it
     * writes does not.
     *
     * `deviceScope` went with them. It was read once and used twice — here and
     * by `leafOf`, and both readers are gone: `leafOf` is removed with the
     * bootstrap loop below (`T-116` recorded the one-place rule; this removes
     * the place rather than leaving it holding nothing).
     *
     * The four fields that remain are the account's, not a device's: its asset
     * blinding, the reserved "no asset" the constructor names, and a genesis
     * salt that is a real random value rather than a zero because a predictable
     * proposal salt would make a proposal id guessable.
     */
    const initialPrivateState = {
      assetBlinding: fromHex(opening.assetBlinding),
      // The constructor names no asset and, since `C292`, writes no commitment
      // of any kind — it seats the founding signer's leaf and sets the
      // threshold, and nothing else. Every witness still has to answer, so this
      // is the reserved "no asset".
      assetId: assetIdBytes(NO_ASSET),
      proposalSalt: genesisSalt,
      changeAmount: 0n,
      changeBatchDigest: genesisSalt,
      pinnedPath: null,
    };

    /*
     * Settle before submitting. The node's websocket closes cleanly ~3s after
     * the wallet connects, so submitting immediately is submitting into the gap
     * on purpose.
     */
    await sleep(6000);

    const deployed: any = await withRetry(
      'deploy',
      () => submitPartialDeployTx(providers as any, {
        compiledContract: this.compiled as any,
        privateStateId: privateStateKey(this.cfg.privateStateId, accountId),
        initialPrivateState,
        /*
         * ONE ARGUMENT SINCE `S35d`, AND NOTHING IN TYPESCRIPT CHECKS THAT.
         * `args` is `unknown[]` at `partial-contract.ts:229` and
         * `contract-info.json` carries no constructor entry, so
         * `circuit-arity.ts` does not guard this call either. The generated
         * `initialState` asserts the arity itself and would refuse at deploy
         * time with a funded wallet.
         *
         * THE THRESHOLD USED TO BE ARGUMENT ONE AND IS NOT PASSED AT ALL NOW.
         * `C340` + `C343`, ruled by the founder 2 Sep: the constructor takes no
         * threshold and sets `threshold = 1`. `opening.threshold` no longer
         * reaches the chain from anywhere; what it still does is above, at the
         * refusal that reads it.
         */
        args: [fromHex(foundingLeaf)],
        maintenanceAuthority: this.deployment!.maintenanceAuthority,
      }),
      this.deployment.retry,
    );

    const address = String(deployed.deployTxData.public.contractAddress);

    /*
     * The opening blob, stored.
     *
     * This was missing, and the gap was the product-path twin of the bug that
     * stopped the run script working twice: `open` was handed a `sealedState`
     * and dropped it, so a freshly created account had a commitment on chain
     * and no blob to open it — `fetch` would throw "committed state could not
     * be retrieved" on the very first read, and there would be nothing to
     * recover, because the salt exists nowhere else.
     */
    await this.blobs.put(
      accountId,
      // A new account holds no assets, so its view digest is the digest of an
      // empty list — deterministic, and what `fetch` will recompute from chain.
      viewDigestOf([]),
      opening.sealedState.keyEpoch,
      opening.sealedState.sealed,
    );

    // Recorded BEFORE the read-back. An address we deployed and did not write
    // down is an account nobody can reach again, which is worse than a failed
    // verification we can retry.
    await this.deployment.register(accountId, address);

    /*
     * The real check, not a formality — M-9's property, kept through the
     * deferral. The partial find reads public state through the indexer AND
     * compares the on-chain verifier keys against the ones we compiled, for
     * the circuits this deployment carries — the SDK's
     * `findDeployedContract` would compare every compiled key and refuse its
     * own deployment. It also checks the deferred circuits are ABSENT — a
     * check that is INERT while nothing is deferred, and filed as such
     * rather than widened here. The private state was already written by
     * `submitPartialDeployTx`, under this contract's address.
     */
    await findDeployedPartialContract(providers as any, {
      compiledContract: this.compiled as any,
      contractAddress: address,
      /*
       * This read verifies the deployment and calls no circuit at all, so it
       * needs no private state - and it says so rather than omitting the
       * answer, because an omitted answer is the one thing the find refuses.
       */
      privateStateId: null,
    });

    /*
     * **THE LOOP THAT SEATED THE REST OF THE FOUNDERS STOOD HERE, AND IT WENT
     * WITH THE DEPLOYER'S SEAT.**
     *
     * It walked `opening.signerLeaves`, skipped the one the deployer's own
     * material derived to, and seated each of the others through the contract's
     * bootstrap window **acting AS the deployer** — `{ signerId: 'deployer',
     * leaf: deployerLeaf }`. That worked for exactly one reason: this process
     * held a secret that satisfied `requireSigner()`. It holds none now, so the
     * loop cannot be kept; a version of it that "still works" would be the
     * deployer's seat back under another name.
     *
     * **SO `open` SEATS EXACTLY ONE SIGNER — THE FOUNDER — AND FOUNDERS 2..N
     * ARE SEATED BY THE FOUNDER FROM THEIR OWN DEVICE**, through the same
     * bootstrap window, which is unchanged and is still what stops a 2-of-3
     * account being wedged at creation. That is the seating screen, `C335`,
     * board `4b`. It is named here rather than left to be discovered.
     *
     * **NOTHING THAT RUNS TODAY LOSES A CAPABILITY, AND THAT IS MEASURED
     * RATHER THAN ASSUMED:** the only caller that ever reached this code is
     * `scripts/deploy-preview.ts`, which passed `signerLeaves: []`, so the loop
     * body never executed once. `docs/corrections.md` records that the skip
     * filter has never seen a real leaf.
     *
     * `leafOf` loses its only caller and is REMOVED with this loop rather than
     * left unused — see the note where it stood, under `internals`. The
     * derivation survives in the one wrapper every product writer already uses.
     */

    return {
      ref: String(deployed.deployTxData.public.txId ?? deployed.deployTxData.public.txHash ?? address),
      at: new Date().toISOString(),
    };
  }


  /**
   * **THE ADDRESS THE CHAIN ASSIGNED, AND NOTHING NEARBY MAY CHOOSE IT.**
   *
   *
   * `addressOf` is the deployment's own registry — the file a script writes or
   * the row a service writes at deploy — so this reads back exactly what
   * `deployTxData.public.contractAddress` said and never computes one. Null for
   * an account this deployment has never deployed, which is a real state and
   * not a failure.
   */
  async address(accountId: string): Promise<LedgerAddress | null> {
    const address = await this.addressOf(accountId);
    /*
     * **`'chain'`, AND IT IS THE ONLY PLACE IN THIS REPOSITORY THAT SAYS SO.**
     * `addressOf` reads back what
     * `deployTxData.public.contractAddress` said at deploy; nothing here
     * computes an address, so nothing here can claim a provenance it does not
     * have.
     */
    return address ? { value: address, source: 'chain' } : null;
  }

  async status(accountId: string): Promise<LedgerStatus | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;
    const s = await this.readContractState(address);
    if (!s) return null;
    return {
      assets: s.assets,
      /*
       * Every proposal open at once, not "the" open one.
       *
       * No "is it really open" dance either: a proposal that has been executed
       * or cancelled is REMOVED from the map, so presence is the answer. The old
       * shape had to check `proposalOpen` before reporting `proposal`, because
       * the contract zeroed the field rather than deleting it, and a caller
       * reading it raw would believe a closed round was open.
       */
      openProposals: s.openProposals,
      threshold: Number(s.threshold),
      /* Absence means inherit, so an account with no exceptions reports
       * an empty array and every vault is judged by `threshold` above. */
      vaultThresholds: s.vaultThresholds,
      signerCount: Number(s.signerCount), // `T-220` rides this line: see readContractState
      movementCount: Number(s.movementCount), retiredVaults: s.retiredVaults };
  }

  /**
   * **WHICH OF THESE PAYEES THE ACCOUNT HAS RECORDED A COMPLETED PAYMENT FOR.**
   *
   * A SECOND READ OF THE CONTRACT'S STATE RATHER THAN A FIELD ADDED TO
   * `status`. The two answer different questions and are asked at different
   * moments: a lifecycle view is read whenever a screen opens, and this is read
   * when somebody asks about one run's people. Folding this into `status` would
   * make every screen in the product pay for a question almost none of them
   * ask, and would need a payee list at a door that has none.
   *
   * **THE MEMBERSHIP TEST IS THE DECODED SET'S OWN, AND THE VALUE TESTED IS THE
   * CONTRACT'S OWN DERIVATION FROM THE LEAF.** Neither is recomputed here. A
   * second derivation of either would answer confidently about the wrong
   * people, and it would answer at the one moment nobody checks: after payday,
   * on the screen somebody opens to find out who is still owed money.
   *
   * **A MISSING SET REFUSES RATHER THAN READING AS "NOBODY".** The same rule
   * every other field on this boundary follows, and here it is the sharpest it
   * gets: a repaired empty answer would report a run of paid people as a run of
   * unpaid ones, which is the exact reading this whole path exists to prevent.
   */
  async paidAmong(accountId: string, leaves: Hex[]): Promise<PaymentsAmong | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;

    const { ledger: readLedger, pureCircuits } = await import(
      '../../contracts/managed/contract/index.js');
    const providers = await this.providers();

    const state = await providers.publicDataProvider.queryContractState(address as any);
    if (!state) return null;

    const parsed: any = readLedger(state.data);
    const movements = parsed?.movements;
    if (movements == null || typeof movements.member !== 'function') {
      throw new UndecodedLedgerField('movements', 'set');
    }

    /*
     * ONE MEMBERSHIP TEST PER PAYEE ASKED ABOUT, AND NO ENUMERATION OF THE SET.
     * The work is the size of the run; the set is the size of everything the
     * account has ever paid, and those two numbers stop being comparable
     * quickly.
     */
    const paid = leaves.filter(
      (leaf) => movements.member(pureCircuits.paidMovementOf(fromHex(leaf))));

    return { known: true, paid };
  }

  /**
   * Opens a round. The chain gets a commitment to the payload, never the
   * payload — `propose(payloadHash)` commits it again under `proposalSalt`, so
   * even the digest is blinded on chain.
   */
  async propose(
    accountId: string,
    payloadHash: Hex,
    change: StateChange,
    by: SignerRef,
    vault: Hex,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'propose', payloadHash, change, vault });
    const result = await this.buildCall(call.address, call.circuit, call.args, call.privateStateId);

    const after = await this.readContractState(call.address);
    /*
     * The account's asset blinding, read from the device's own private state.
     *
     * It is not on the `propose` boundary, and adding it there would be the
     * wrong fix: a proposal carries a change, and the change already names the
     * asset. What the CIRCUIT needs to derive the key is the blinding, which is
     * account-level, arrives at `open` time and lives on the device — the same
     * place `secretKey` and `blinding` do. Reading it here rather than
     * accepting it as an argument is what keeps it off the boundary and out of
     * any server that might be tempted to hold it.
     */
    const expected = await this.changeCommitmentOf(change, await this.assetBlindingOf(accountId));
    /* `R5`: the vault the caller named, not `noVault()` assumed. The id the
     * chain holds is derived from it, so checking against any other value
     * would report a landed proposal as missing. */
    const id = MidnightCommitments.proposalId(payloadHash, change.salt, vault);
    const landed = after?.openProposals.find(p => p.id === id);
    /*
     * FOUND BY ID, where this used to read a single `proposedChange` field.
     * M-128: several proposals are open at once, so "the change the chain
     * recorded" is only a question about one of them, and asking it of the
     * account as a whole would compare this proposal against whichever one
     * happened to be written last.
     */
    if (!landed) {
      /*
       * TWO OPPOSITE FAULTS USED TO SHARE ONE MESSAGE. `landed` is undefined
       * either because the state read came back empty — so nothing was ever
       * searched — or because the state is fine and no id matches, meaning the
       * proposal is genuinely absent or our derivation of the id disagrees with
       * the chain's. A read that failed and a commitment that disagrees are
       * diagnosed in opposite directions, so the message names which one it is,
       * and in the no-match case prints what we looked for beside what is
       * actually held. Failure branch only: nothing above this line changes.
       */
      if (!after) {
        throw new Error(
          'propose succeeded but the account state could not be read back, so it is ' +
            'unknown whether the proposal is open. Approvals gathered against it may be ' +
            'unusable.\n' +
            `  looked for id: ${id}\n` +
            '  state read back: none',
        );
      }
      throw new Error(
        'propose succeeded but the chain has no open proposal with this id. Approvals ' +
          'gathered against it would be unusable.\n' +
          `  looked for id: ${id}\n` +
          `  ids on chain (${after.openProposals.length}): ` +
          (after.openProposals.length === 0
            ? 'none'
            : after.openProposals.map(p => p.id).join(', ')),
      );
    }
    if (landed.change !== expected) {
      throw new Error(
        'propose succeeded but the chain recorded a different change than the one supplied.\n' +
          `  on chain: ${landed.change}\n` +
          `  supplied: ${expected}\n` +
          'Every approval gathered against this proposal would be unusable.',
      );
    }
    return this.txRef(result, by);
  }

  /**
   * RAISES A PAYROLL RUN. V-67, V-73.
   *
   * The same post-check as `propose`, and it earns its keep more here: a run's
   * id is computed from four values rather than one, so there are four ways to
   * build a proposal nobody can ever pay against. Finding that out now costs a
   * refused call; finding it out later costs an approval round from every
   * signer and is discovered on payday.
   */
  async proposeRun(
    accountId: string,
    run: { root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex },
    change: StateChange,
    by: SignerRef,
  ): Promise<TxRef & { proposalId: Hex }> {
    /*
     * **A RUN MUST NAME A REAL VAULT, AND THIS GUARD WAS MISSING WHILE THE
     * SIMULATED ONE HAD IT.** `C375`, `S47`, found by that round's
     * money-safety pass against the round's own change.
     *
     * The contract's run branch takes the vault OPAQUE — it asserts nothing
     * about it (`contracts/src/ConfidentialAccount.compact:2119-2156`; only the
     * governance branch asserts `vault == noVault()` at `:2254`). So a run
     * raised at the sentinel settles, collects its approvals and burns its fee,
     * and `recordPayment` can never be handed it, because **a vault presents
     * ITSELF** and recomputes the id from its own address (`:2586-2609`).
     * That is `C375`'s own shape reached from the other side.
     *
     * `AccountService.proposeRun` refuses it upstream, which is why nothing was
     * losing money — but the two implementations of one boundary method must
     * refuse the same sequences, and this is the one that pays a fee.
     */
    if (run.vault === MidnightCommitments.noVault()) {
      throw new Error(
        'a payroll run must name the vault that will pay it: the vault is folded into the ' +
          'proposal id and recordPayment recomputes the id from the vault it is handed, so a ' +
          'run raised at the no-vault sentinel is one no vault can ever present.',
      );
    }
    const call = await this.prepare(accountId, { kind: 'proposeRun', ...run, change });
    const result = await this.buildCall(call.address, call.circuit, call.args, call.privateStateId);

    const payloadHash = MidnightCommitments.runPayload(
      run.root, run.payees, run.opensAt, run.closesAt);
    const id = MidnightCommitments.proposalId(payloadHash, change.salt, run.vault);

    const after = await this.readContractState(call.address);
    const landed = after?.openProposals.find(p => p.id === id);
    if (!landed) {
      throw new Error(
        'proposeRun succeeded but the chain has no open proposal with this run\'s id. ' +
          'Approvals gathered against it would be unusable, and no payment could ever match it.',
      );
    }
    const expected = await this.changeCommitmentOf(change, await this.assetBlindingOf(accountId));
    if (landed.change !== expected) {
      throw new Error(
        'proposeRun succeeded but the chain recorded a different change than the one supplied.\n' +
          `  on chain: ${landed.change}\n` +
          `  supplied: ${expected}\n` +
          'Every approval gathered against this run would be unusable.',
      );
    }
    return { ...this.txRef(result, by), proposalId: id };
  }

  /**
   * RAISES A RUN AND APPROVES IT, AS ONE ACTION. V-66.
   *
   * Two transactions, because they are two acts: `propose` leaves a proposal at
   * ZERO approvals, and the proposer has drafted something rather than endorsed
   * it. That was read the other way round while working an example — "A creates,
   * B and C approve" reaches TWO of five, not three — and if it reads that way
   * to somebody building this, so will every customer. Gnosis Safe counts
   * the creator's signature, and that is the model people arrive with.
   *
   * **THE FIX IS HERE AND NOT IN THE CONTRACT, deliberately.** Making `propose`
   * auto-approve would quietly turn a three-of-five into a two-of-five: the
   * account would need two deliberate judgements where its policy says three.
   * That is a security change made for a user-interface convenience, and the
   * kind nobody spots afterwards, because nothing about it looks like a change
   * to the threshold.
   *
   * **If the approval fails, the run is left RAISED AND UNAPPROVED rather than
   * rolled back** — there is nothing to roll back to, the proposal is on chain.
   * Reported rather than swallowed, because a caller who believes they approved
   * and did not is the exact confusion this method exists to remove. The run is
   * still perfectly usable: anybody, including the proposer, can approve it.
   */
  async raiseAndApproveRun(
    accountId: string,
    run: { root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex },
    change: StateChange,
    by: SignerRef,
  ): Promise<{ proposalId: Hex; raised: TxRef; approved: TxRef | null; approvalError?: string }> {
    const raised = await this.proposeRun(accountId, run, change, by);
    try {
      const approved = await this.approve(accountId, raised.proposalId, by);
      return { proposalId: raised.proposalId, raised, approved };
    } catch (e: any) {
      return {
        proposalId: raised.proposalId,
        raised,
        approved: null,
        approvalError:
          `the run was raised as ${raised.proposalId} and YOUR APPROVAL DID NOT LAND: ` +
          `${String(e?.message ?? e)}. It is open with no approvals; approve it before counting it.`,
      };
    }
  }

  /**
   * Sweeps a run whose window has closed. V-67.
   *
   * Returns nothing anybody should read as "the run finished". It cannot mean
   * that: a run whose window passed with three payees unpaid closes exactly the
   * same way as one that paid everybody. What was paid is in `movements`, and
   * `runStatus` is the only thing that should be asked.
   */
  async closeExpiredRun(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'closeExpiredRun', proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * One approval per signer per PROPOSAL.
   *
   * Deliberately does NOT pre-check whether this signer has already approved.
   * It cannot: the nullifier is `H(domain, contractAddress, proposal, secretKey)`
   * and the secret never leaves the signer's device, which is the entire point
   * of the scheme. The contract rejects the duplicate, and a local check that
   * looked authoritative would be a lie about what we can know.
   */
  async approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'approve', proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /*
   * `settleRound` AND `sendTransition` STOOD HERE.
   *
   * `settleRound` refused, because on Midnight the transfer and the transition
   * are one transaction and the transfer half was never written.
   * `sendTransition` was the transition half — built, tested, and deliberately
   * unreachable — kept because `R1` would need it.
   *
   * BOTH ARE GONE BECAUSE WHAT THEY MOVED IS GONE. The transition they built
   * called the contract's `execute`, which spent the account's own balance; the
   * balance, the circuit and the ledger fields behind it were removed together.
   * Keeping the half that works would keep a call to a circuit that does not
   * exist.
   *
   * `R6`'s RULE OUTLIVES THEM, and that is why it is written down here rather
   * than deleted with the code: an operation with two halves is ONE transaction
   * or it refuses the whole thing. Paying a run out of a vault is exactly such
   * an operation, and that is where this rule is next spent.
   */

  /**
   * Puts a signer's leaf in the on-chain tree.
   *
   * The circuit decides which of its two paths applies — bootstrap or approved
   * round — from `signerCount < threshold`, and this does not second-guess it.
   * It does check the obvious refusals first, because each one otherwise costs a
   * block time and a fee to discover.
   *
   * The proposal salt is staged for the same reason `propose` stages it: on the
   * approved path the circuit recomputes the proposal's id from it, and the
   * adding device has to be using the proposer's. `execute` was the other
   * circuit that read it and is gone; `amendSigner`, `setThreshold`,
   * `setVaultThreshold`, `adopt`, `retireVault` and `recordPayment` are the
   * readers that are left.
   */
  async addSigner(
    accountId: string, leaf: Hex, proposalId: Hex | null, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'addSigner', leaf, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /*
   * `REMOVE_SIGNER_SLOTS` USED TO BE HERE, and M-106 deleted the cap it named.
   *
   * It had to equal the `Vector<N, Bytes<32>>` the contract was compiled with,
   * because `removeSigner` re-seated the survivors from a statically sized
   * list. A circuit is a fixed shape, so that width was a cost every removal
   * paid whether an account had three signers or sixteen — measured at 135,167
   * bytes of zkir, 5.7x `execute` and the heaviest circuit in the contract. A
   * measurement against a circuit `C292` has since deleted, kept because it is
   * what bought the rule.
   *
   * Clearing one slot needs no list, so there is no width, no cap, and no
   * number for the two sides to disagree about.
   */

  async removeSigner(
    accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(
      accountId, { kind: 'removeSigner', removedLeaf, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  async setThreshold(
    accountId: string, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(
      accountId, { kind: 'setThreshold', newThreshold, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * **ONE VAULT'S OWN THRESHOLD, ON CHAIN.** Mirrors
   * `setVaultThreshold` at `contracts/src/ConfidentialAccount.compact:2699`.
   *
   * **NEVER RUN AGAINST A NODE.** Nothing in this class has been, apart from
   * the lifecycle `REPORT-WASM-PROVING.txt:502` records, and this circuit was
   * not part of it. It type-checks against the generated ABI and no further
   * claim is made for it here.
   */
  async setVaultThreshold(
    accountId: string, vault: Hex, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(
      accountId, { kind: 'setVaultThreshold', vault, newThreshold, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  async cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'cancel', proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /*
   * `credit` STOOD HERE AND REFUSED BY NAME. `C292`, `V-246`.
   *
   * It built a `credit` call — value arriving without an approval round, M-67 —
   * and `S23` had already shed that circuit, so it refused rather than staging
   * an opening for a transaction that could not exist. Its refusal named the
   * founder's decision as the door that resolved it. The decision was taken:
   * the account keeps no book, so there is no method here left to refuse from.
   *
   * Money is held by a VAULT and reaches one through the vault's own deposit
   * path. What LEFT is in `movements`, written by `recordPayment`.
   */

  /* ------------------------------------------------------------------ *
   * the same round, one step at a time
   *
   * Everything above builds, proves, balances and submits in a single call,
   * which is right for a script and wrong for a queue. A job has to be able to
   * do the expensive, effect-free part — building and proving — and stop, then
   * submit later, possibly after a crash. Decision 0008, M-82.
   *
   * `prepare` is that first half, and it is the SAME first half: the methods
   * above now call it rather than repeating their own checks. One copy of each
   * rule, because the failure this project keeps repeating is a procedure
   * written twice with the second copy missing a line — M-50, M-55, M-58, M-61,
   *
   * ------------------------------------------------------------------ */

  /**
   * Everything that must happen before a circuit can be called, and nothing
   * that touches the chain.
   *
   * Two jobs, and they are inseparable, which is why they are one method:
   *
   *   1. REFUSE EARLY. Each refusal here costs nothing; the same refusal
   *      discovered on chain costs a block time and a fee, and against the WASM
   *      prover it costs eighty seconds of proving first.
   *   2. STAGE THE WITNESSES. Several circuits take no arguments at all and read
   *      what they need from the calling device's private state. Forgetting this
   *      does not fail — it commits to whatever was there before, which is how a
   *      round can reach its threshold and then never be able to settle.
   *
   * Returns what the SDK needs and nothing more. Deliberately not a transaction:
   * building one is the caller's business, and the job runner wants to do it at
   * a moment of its own choosing.
   */
  async prepare(accountId: string, step: PreparedStep): Promise<PreparedCall> {
    const address = await this.requireDeployed(accountId);
    /*
     * **BOTH ANSWERS COME FROM THE ONE TABLE.** Which circuit this step calls,
     * and therefore whether it reads anything out of the calling device at all.
     * Derived rather than written per branch, so the two can never disagree and
     * so a step added later cannot be given the wrong one by omission.
     */
    const circuit = CIRCUIT_FOR_STEP[step.kind];
    const privateStateId = CIRCUITS_THAT_READ_NO_WITNESS.has(circuit)
      ? null
      : privateStateKey(this.cfg.privateStateId, accountId);

    switch (step.kind) {
      case 'propose': {
        /*
         * NO "a proposal is already open" REFUSAL, and its absence is the
         * feature. This used to be the check that stopped an admin
         * raising a vendor invoice while payroll collected signatures.
         *
         * M-70/M-71. `propose` records the change, and it reads it from the
         * caller's private state because there is no argument for it. Staging
         * is therefore not optional here. `execute` was the other reader and is
         * gone, so this is the ONLY circuit that opens what is staged
         * below and nothing on chain reopens what it commits to.
         */
        /*
         * **THE VAULT IS REFUSED BEFORE ANYTHING IS STAGED.** `C367`, `T-237`,
         * `contracts/src/ConfidentialAccount.compact:2319` asserts it on
         * this branch; job 1 of this method is to refuse before a fee and before
         * eighty seconds of proving — **and before the durable private-state
         * write below it**, which was this round's auditor's correction: a
         * refusal after `stageChange` leaves the caller's device holding a
         * `proposalSalt` for a round that was never raised, and the next
         * governance apply recomputes the wrong id and refuses about the wrong
         * thing. It reads nothing staging produces, so it belongs above it.
         * TWO arguments since V-32, and `R5` made the CALLER name the second
         * rather than this method supply it. It must not be defaulted at the
         * circuit: the vault is committed inside the proposal's identity, so a
         * wrong value does not fail loudly — it produces an id nobody can claim.
         */
        if (step.vault !== MidnightCommitments.noVault()) throw new Error('a governance round cannot name a vault');
        await this.stageChange(accountId, step.change);
        /*
         * The MERGED `propose`: the opaque path. `isRun` false, the run
         * parts zero — the branch that would read them is not taken, exactly
         * as `addSigner`'s unused `proposal` is zeroes on the bootstrap path.
         */
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(step.payloadHash), fromHex(ZERO_32), 0n, 0n, 0n, false, fromHex(step.vault),
          ],
        };
      }

      case 'proposeRun': {
        /*
         * **REFUSE EARLY, AND ALL THREE REFUSALS ARE FREE OF SIDE EFFECTS.**
         * They read `step` alone — nothing `stageChange`
         * produces — yet sat BELOW it until this round, so a refused call left
         * the device holding a `proposalSalt` for a round never raised and the
         * next apply for a legitimately open proposal recomputed the wrong id
         * and was refused about the wrong thing. `case 'propose'` was `S55`'s;
         * these are older. **`T-324`'s cell is wrong once: `retireVault` takes
         * the salt as an ARGUMENT (`compact:2862`, used `:2867`), not as a
         * witness — `SC19` §1.** The duplication with the chain is deliberate:
         * its asserts give an attacker nothing; these give a person a sentence.
         */
        if (step.payees < 1n) {
          throw new Error('a payroll run needs at least one payee');
        }
        if (step.opensAt >= step.closesAt) {
          throw new Error(
            `this run's window closes at ${step.closesAt} and opens at ${step.opensAt}, ` +
              'so no payment could ever fall inside it');
        }
        /*
         * A WINDOW IN MILLISECONDS IS THE MISTAKE THIS CATCHES. The contract
         * compares against `secondsSinceEpoch`, so a JavaScript timestamp
         * passed straight through builds a run that opens in the year 56000 —
         * approved, paid for, and unpayable, with nothing to say why. Anything
         * past the year 3000 is not a payroll date.
         */
        if (step.closesAt > 32_503_680_000n) {
          throw new Error(
            `${step.closesAt} is not a time in seconds — that is the year ${
              new Date(Number(step.closesAt) * 1000).getUTCFullYear()}. ` +
              'Block time is seconds since the Unix epoch, not milliseconds.');
        }
        await this.stageChange(accountId, step.change);
        /* The MERGED `propose`: the run path. `isRun` true, opaque hash zero. */
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(ZERO_32), fromHex(step.root), step.payees, step.opensAt, step.closesAt, true,
            fromHex(step.vault),
          ],
        };
      }

      case 'closeExpiredRun': {
        /*
         * No `requireOpen` beyond the contract's own. This step removes an
         * authorisation that is already dead — every payment asserts the same
         * bound — so the only thing a stale local view can cause is a refused
         * transaction, and refusing here would need a second opinion about the
         * block time that we do not have.
         */
        /*
         * **AND IT CARRIES NO PRIVATE-STATE KEY, WHICH IS THE ONE `null` IN
         * THIS METHOD - AND IT IS NOW DERIVED RATHER THAN WRITTEN HERE**, from
         * the circuit this step names and the set of circuits that read no
         * witness. This circuit calls no witness - no signer check, no
         * salt, no asset - so there is nothing for a record to answer. Asking
         * for one would refuse a sweep from any client that has never staged
         * a call against this account, and the contract's whole argument for
         * leaving this operation open to anybody is that an account whose
         * signers have all left must still be able to have its expired rows
         * taken out. Passing a key it does not need would also put this call
         * on the path where the SDK writes the record back after settlement,
         * for a circuit that changed nothing in it.
         */
        return {
          address, privateStateId, circuit,
          args: [fromHex(step.proposalId)],
        };
      }

      case 'approve': {
        await this.requireOpen(address, step.proposalId, 'approve');
        /*
         * Deliberately no check for "have I already approved". It cannot be
         * done: the nullifier is H(domain, address, proposal, secretKey) and
         * the secret never leaves the signer's device. The contract rejects the
         * duplicate, and a local check that looked authoritative would be a lie
         * about what we can know.
         */
        return {
          address, privateStateId, circuit, args: [fromHex(step.proposalId)],
        };
      }

      case 'cancel': {
        await this.requireOpen(address, step.proposalId, 'cancel');
        return {
          address, privateStateId, circuit, args: [fromHex(step.proposalId)],
        };
      }

      case 'addSigner': {
        const before = await this.readContractState(address);
        if (!before) throw new Error('the contract has no state on chain');
        const bootstrapping = before.signerCount < before.threshold;
        /*
         * The bootstrap window needs no proposal and the contract does not look
         * for one, so a null id is correct there and an error anywhere else.
         * Zeroes are passed rather than nothing because the circuit's arity is
         * fixed; the branch that would read them is not taken.
         */
        if (!bootstrapping) {
          if (!step.proposalId) {
            throw new Error(
              'adding a signer to a live account needs an approved proposal. ' +
                'Propose the signer, reach the threshold, then add them. M-37.',
            );
          }
          await this.requireApproved(address, step.proposalId, 'add a signer');
        }
        /*
         * THREE ARGUMENTS, and the third was missing until M-128's port was
         * checked against the compiled ABI rather than against memory.
         *
         * `intoVacatedSlot` asks the contract to take a slot a removal freed
         * instead of appending a fresh one. It cannot be inferred here and it
         * cannot be omitted: a circuit's arity is fixed, so a two-argument call
         * is rejected before it is proven — every `addSigner` on this path
         * would have failed. This is the M-107 shape exactly (a call site
         * drifting out of arity), caught this time because nothing casts it away.
         *
         * FALSE unless a slot has actually been vacated. Getting it wrong is
         * harmless in both directions: ask to reuse when nothing was vacated and
         * the proof fails; append when a slot was free and one slot is wasted.
         * So it is derived from the chain rather than guessed.
         */
        /* `T-200`: `ConfidentialAccount.compact:1859-1860` refuses an unusable
         * leaf here too, and this path had no mirror for it either. */
        await this.refuseUnusableLeaf(step.leaf, 'the signer leaf being seated');
        /* The MERGED `amendSigner`, seating direction: `removing` false. */
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(step.leaf),
            fromHex(step.proposalId ?? ZERO_32),
            await this.hasVacatedSlot(address),
            false,
          ],
        };
      }

      case 'setThreshold': {
        const before = await this.readContractState(address);
        if (!before) throw new Error('the contract has no state on chain');
        await this.requireApproved(address, step.proposalId, 'change the threshold');
        /*
         * **`Number.isInteger` IS HERE BECAUSE ITS SIBLING HAS IT AND THE TWO
         * DISAGREED. `T-200` `P2`.** `setVaultThreshold` below refused
         * `NaN`; this one did not, in the same file, on the same kind of value
         * — so `NaN` reached `BigInt(...)` at `:1301` and threw a `RangeError`
         * naming nothing anybody can act on, while the vault path answered in
         * a sentence. Two mirrors of one rule that disagree is the shape this
         * repository files as `M-104`, and one of them being safe is not the
         * same as the pair being right.
         */
        if (!Number.isInteger(step.newThreshold) || step.newThreshold < 1) {
          throw new Error('the threshold must be at least one, and a whole number');
        }
        /*
         * The M-37 guard. `addSigner` opens its bootstrap window whenever
         * `signerCount < threshold`, so raising the threshold above the number
         * of seated signers would let one signer seat their own.
         */
        if (BigInt(step.newThreshold) > before.signerCount) {
          throw new Error(
            `the threshold cannot exceed the ${before.signerCount} signers on this account, ` +
              'or one signer could seat their own.',
          );
        }
        return {
          address, privateStateId, circuit,
          args: [BigInt(step.newThreshold), fromHex(step.proposalId)],
        };
      }

      case 'setVaultThreshold': {
        /*
         * **THE ACCOUNT'S THRESHOLD, NOT THE VAULT'S.** `R5`, and it matches
         * the circuit: `setVaultThreshold` calls `requireApproved(id)` at
         * `:1407`, the entry point with no lookup, because the round behind it
         * names `noVault()`. A vault whose bar is already 1 must not be able to
         * authorise its own further changes with one signature.
         */
        await this.requireApproved(address, step.proposalId, "change a vault's threshold");
        /*
         * **THIS IS NARROWER THAN THE CONTRACT'S CHECK, DELIBERATELY, AND THE
         * SENTENCE BELOW IS THE CONTRACT'S REASON RATHER THAN ITS PREDICATE.**
         * `T-200` `P2`, `S46` — the line that stood here said the contract's
         * own refusal was *reached before a fee is paid*, which reads as an
         * equivalence and is not one.
         *
         * `ConfidentialAccount.compact:2777` refuses exactly `== 0` — **`:2777`
         * and not the `:2712` this comment used to cite, which is a blank line;
         * `T-246`'s +65 shift, read at source by `S46`.** This
         * refuses `NaN`, non-integers and everything below 1. **It errs SAFE —
         * strictly narrower, and `Uint<64>` makes a negative unrepresentable on
         * the far side anyway — but a reader must not be told the two are the
         * same check**, because the obvious tidy is to loosen this line to
         * match the quoted one, and `:481-483` records why a non-integer is a
         * bad value entering our own records in the first place.
         *
         * The quoted sentence is kept because it is the best statement of WHY
         * anywhere in either language: *"a vault threshold of zero would
         * authorise anything"* (`:2777`).
         *
         * **NO SIGNER-COUNT BOUND**, unlike `setThreshold` above, and the
         * omission is the circuit's (`:2758-2762`): a vault has no bootstrap
         * window for an over-high threshold to reopen. The application refuses
         * to RAISE such a round — `AccountService.proposeVaultThresholdChange`
         * — and that refusal is ours and is labelled as ours.
         */
        if (!Number.isInteger(step.newThreshold) || step.newThreshold < 1) {
          throw new Error('a vault threshold of zero would authorise anything');
        }
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(step.vault), BigInt(step.newThreshold), fromHex(step.proposalId),
          ],
        };
      }

      case 'removeSigner': {
        const before = await this.readContractState(address);
        if (!before) throw new Error('the contract has no state on chain');
        await this.requireApproved(address, step.proposalId, 'remove a signer');
        if (before.signerCount - 1n < before.threshold) {
          throw new Error(
            `that would leave ${before.signerCount - 1n} signers against a threshold of ` +
              `${before.threshold}, and the account could never approve anything again.`,
          );
        }
        /*
         * The MERGED `amendSigner`, unseating direction: `removing`
         * true; `intoVacatedSlot` is ignored on this path and passed false.
         */
        return {
          address, privateStateId, circuit,
          args: [fromHex(step.removedLeaf), fromHex(step.proposalId), false, true],
        };
      }
    }
  }

  /**
   * Has any slot been vacated by a removal?
   *
   * Read from the tree rather than remembered, because it is a property of the
   * account rather than of this call: the tree holds the vacancy marker at a
   * cleared slot, so asking it for a path to that marker answers the question
   * exactly. No path means nothing has been vacated and a new signer appends.
   */
  /**
   * **A SIGNER LEAF THE CONTRACT WILL NOT SEAT, REFUSED BEFORE A FEE IS PAID.**
   * `T-200` `P2`, `S46`, mirroring two contract asserts that had no client
   * counterpart at all.
   *
   * The contract's `constructor` refuses a founding leaf that is
   * `default<Bytes<32>>` or `vacantSlot()`, and `amendSigner` refuses the same
   * two for a leaf being seated — both with the same message, *"that is not a
   * usable signer leaf"*. **NAMED RATHER THAN CITED, AND THE CITATIONS THAT
   * STOOD HERE WERE BOTH WRONG:** `:1508-1509` is `requireApproved`'s
   * approval-count assert and `:1859-1860` is `const removedLeaf = leaf;`. The
   * asserts are at `:1613-1614` and `:1964-1965` today and will not stay there.
   * **Both were unmirrored**, so
   * `:611` and `:1271` passed `fromHex(...)` straight through and the refusal
   * arrived from the chain — for the founding leaf, after a deploy and a fee,
   * and `src/midnight/ledger.ts:400-406` already reasons that an unusable
   * founding seat is PERMANENTLY fatal: `amendSigner` requires an existing
   * signer, so nobody can ever seat the first.
   *
   * **THE CONVENTION IS THE FILE'S OWN**, not one invented here: `proposeRun`'s
   * two mirrored asserts (`:1162`, `:1165`) match `ConfidentialAccount.compact`
   * `:2126` and `:2127` exactly, and `:2313-2316` names that convention in the
   * contract's own words.
   *
   * **AND `T-200`'s OWN CITATION OF `:2712` IS STALE — IT IS `:2777`.** `S46`
   * opened the file: `:2712` is blank and `:2777` carries the vault-threshold
   * assert. That is `T-246`'s +65 shift, and the same slip is in `SC9`'s report
   * and in the `T-200` row. Every compact citation in this round was read at
   * source rather than inherited (rule 23).
   *
   * **ONE HELPER AND NOT TWO CHECKS, AND THAT IS NOT `M-106`.** The two
   * contract asserts are the same rule — *a leaf must be a value the tree can
   * hold and can tell apart from an empty slot* — read at two entry points. A
   * shared rule is the mistake when two sites want DIFFERENT rules; here they
   * want the same one, and writing it twice is how they drift.
   *
   * **THE VACANCY MARKER IS READ FROM THE COMPILED ARTIFACT, NEVER RESTATED.**
   * `pureCircuits.vacantSlot()` is the same call `hasVacatedSlot` below makes.
   * A TypeScript constant for it would be a second definition of a value the
   * chain compares against, which is `decision 0004` and `C306`.
   */
  private async refuseUnusableLeaf(leaf: Hex, what: string): Promise<void> {
    if (leaf === ZERO_32) {
      throw new Error(
        `${what} is thirty-two zero bytes. Supply a signer leaf that is neither thirty-two `
        + 'zero bytes nor the vacancy marker. The contract refuses this value — it answers '
        + '"that is not a usable signer leaf", in its constructor for a founding leaf and in '
        + '`amendSigner` for a leaf being seated — because thirty-two zero bytes is what an '
        + 'empty slot reads as, so a seat holding it is a seat nothing can ever prove.');
    }
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    if (leaf === toHex(pureCircuits.vacantSlot())) {
      throw new Error(
        `${what} is the vacancy marker itself. Supply a signer leaf that is neither `
        + 'thirty-two zero bytes nor the vacancy marker. The contract refuses this value — it '
        + 'answers "that is not a usable signer leaf", in its constructor for a founding leaf '
        + 'and in `amendSigner` for a leaf being seated — because the tree uses the marker to '
        + 'mean THIS SLOT IS EMPTY, so seating it makes a slot that is simultaneously taken '
        + 'and free.');
    }
  }

  private async hasVacatedSlot(address: string): Promise<boolean> {
    const { ledger: readLedger, pureCircuits } = await import(
      '../../contracts/managed/contract/index.js');
    const providers = await this.providers();
    const state = await providers.publicDataProvider.queryContractState(address as any);
    if (!state) return false;
    return readLedger(state.data).signers.findPathForLeaf(pureCircuits.vacantSlot()) !== undefined;
  }

  /**
   * Is this proposal open on chain?
   *
   * BY ID, because there is no longer a single "the" open proposal, and BY
   * PRESENCE, because the contract deletes a proposal when it settles or is
   * cancelled rather than zeroing a flag beside it. Presence is therefore the
   * whole answer, where the old shape had to read a boolean and a commitment
   * and hope they agreed.
   */
  private async requireOpen(
    address: string, proposalId: Hex, what: string,
  ): Promise<{ approvals: number; threshold: number }> {
    const before = await this.readContractState(address);
    if (!before) throw new Error('the contract has no state on chain');
    const open = before.openProposals.find(p => p.id === proposalId);
    if (!open) {
      throw new Error(
        `cannot ${what}: there is no open proposal ${proposalId.slice(0, 12)} on this account. ` +
          'It has either settled, been cancelled, or was never raised here.',
      );
    }
    return { approvals: open.approvals, threshold: Number(before.threshold) };
  }

  /**
   * Open AND past the threshold.
   *
   * One copy, because all four circuits that spend an approved proposal need
   * exactly this, and four copies of a rule with one of them missing a line is
   * the failure this project keeps recording (M-50, M-55, M-58, M-61, M-65,
   * M-72, M-75, M-104).
   */
  private async requireApproved(address: string, proposalId: Hex, what: string): Promise<void> {
    const { approvals, threshold } = await this.requireOpen(address, proposalId, what);
    if (approvals < threshold) {
      throw new Error(
        `cannot ${what}: that proposal has ${approvals} of ${threshold} approvals. ` +
          'The contract would reject it.',
      );
    }
  }

  /*
   * `stageState`, `checkAfter` AND `viewDigestAfter` STOOD HERE.
   *
   * All three served one call: the account's own spend. `stageState` wrote the
   * sealed blob and staged the balance opening, `checkAfter` compared the
   * commitment the chain then held against the one the opening produced, and
   * `viewDigestAfter` predicted the address the blob would be looked up at.
   *
   * WHAT THEY CHECKED NO LONGER EXISTS: there is no per-asset commitment on
   * chain to compare against. The rule they enforced — that the caller's
   * private state and the sealed blob must describe the same state, decision
   * 0004 — is not repealed. It applies to whatever the vault path stages, and
   * the shape to copy is the one that stood here: blob first, opening second,
   * chain read third and compared rather than assumed.
   */

  /**
   * Rotation, and it touches no chain. K-4.
   *
   * The state is unchanged — only the key that opens it is — so there is
   * nothing to submit. Nothing on chain describes the state to begin with since
   * The blob is filed under `viewDigestOf([])`, one constant. The new
   * ciphertext is filed alongside the old at a new epoch, which is what lets the
   * account stay readable on both sides of the flip.
   */
  async reseal(accountId: string, next: SealedStateAt): Promise<void> {
    const address = await this.addressOf(accountId);
    if (!address) throw new Error('account not found on this ledger');
    const state = await this.readContractState(address);
    if (!state) throw new Error('account not found on this ledger');

    const already = await this.blobs.get(accountId, viewDigestOf([]), next.keyEpoch);
    if (already) {
      throw new Error(
        `the state for "${accountId}" is already sealed at key epoch ${next.keyEpoch}. ` +
          'Re-sealing over an existing epoch would destroy the only copy under that key.',
      );
    }
    await this.blobs.put(accountId, viewDigestOf([]), next.keyEpoch, next.sealed);
  }

  async fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;

    const state = await this.readContractState(address);
    if (!state) return null;

    const sealed = await this.blobs.get(accountId, viewDigestOf([]), keyEpoch);
    // A commitment with no retrievable blob is the failure mode worth naming
    // loudly rather than returning null and letting it read as "empty account".
    if (!sealed) {
      throw new Error(
        `committed state could not be retrieved for "${accountId}" at key epoch ${keyEpoch}. ` +
          'Either the blob is missing (M-73), or the account record and the state store ' +
          'disagree about which viewing key is current, which is what a half-finished ' +
          'rotation looks like (K-4).',
      );
    }

    return { commitment: viewDigestOf([]), sealedState: sealed, updatedAt: state.updatedAt };
  }

  /**
   * **WHAT IS WIRED, NOT WHETHER IT WORKS.** A fee payer in the seat is named as
   * the one fees go to; nothing here has watched it pay.
   */
  describe(): string {
    return `Midnight ${this.cfg.networkId} via ${this.cfg.nodeUrl}, `
      + (paysNoFees(this.sponsor)
        ? 'with no fee payer, so nothing can be written'
        : 'with fees paid by the fee payer it was given');
  }

  /* ---------------- internals ---------------- */

  /*
   * `leafOf` STOOD HERE AND IT IS REMOVED, NOT LEFT UNUSED.
   *
   * Its own docstring said what it was for: *"It is the only place that
   * computes the deployer's leaf"*. There is no deployer's leaf any more. Its
   * single caller was the bootstrap loop in `open`, which went with the
   * deployer's seat, so what is left would be a private method with no callers
   * on the exact path this round exists to close — and a derivation left lying
   * about is how the next round re-wires it.
   *
   * **THE DERIVATION IS NOT LOST AND IS NOT DUPLICATED.**
   * `MidnightCommitments.signerLeaf` / `.signerPublicKey` are the one wrapper
   *, and `src/core/signer-leaf.ts:181-190`'s
   * `storedSignerLeaf` is the one derivation every product writer calls —
   * including whoever computes the founding leaf this class is now handed.
   */

  private async requireDeployed(accountId: string): Promise<string> {
    const address = await this.addressOf(accountId);
    if (!address) throw new Error(`account "${accountId}" is not deployed on Midnight`);
    return address;
  }

  /*
   * `assetKeyOf`, without the await.
   *
   * `MidnightCommitments` is the one place the generated pure circuits are
   * wrapped for synchronous use, and reusing it here is what keeps the count of
   * definitions at one (decision 0004).
   */
  private assetKeyOfSync(asset: AssetId, assetBlinding: Hex): Hex {
    return MidnightCommitments.assetKey(asset, assetBlinding);
  }



  /*
   * `stageView` STOOD HERE.
   *
   * It wrote the caller's balance opening — `current` and `next` — into private
   * state so the spend circuit could read it as witnesses. There is no such
   * circuit and no such witness.
   *
   * `C228` IS NOT LOST WITH IT, and it is the expensive part: the private-state
   * provider files under `${contractAddress}:${key}` where the address half is
   * a mutable closure set by whichever SDK entry point ran last, so EVERY read
   * or write must call `setContractAddress` first. `stageChange` below does.
   */

  /**
   * The commitment to an approved change, from the CONTRACT'S own circuit.
   *
   * The rule `commitmentOf` used to carry alongside it, and which outlived it:
   * recomputing this hash in TypeScript would be a second definition of a
   * scheme. `commitmentOf` was over the account's state and went with the
   * balance ledger; decision 0004 binds what is left.
   */
  /**
   * The account's asset blinding, from this device's private state.
   *
   * Throws rather than defaulting. A wrong or missing blinding derives a
   * different asset key, so the change commitment `propose` writes is not the
   * one this device recomputes in its own post-check, and the call fails with
   * "the chain recorded a different change than the one supplied" — true of the
   * commitment, and completely misleading about the cause.
   *
   * **IT USED TO SAY THE KEY ADDRESSED NO BALANCE THE ACCOUNT HOLDS.** There is
   * no balance map for a key to address since `C292`, and no circuit compares
   * an asset key to anything on chain. **The error message below said so too,
   * and `S27` corrected it** — it is executable text a customer is
   * shown, which is why it could not be left for a comment sweep.
   *
   * WHAT THE REPLACEMENT DOES AND DOES NOT CLAIM. It says the blinding is what
   * derives the asset key the change commitment is built from, and that every
   * signer needs the same one. It deliberately does NOT say the other signers
   * approve that commitment: `approve` takes a proposal id and nothing else
   * (`contracts/src/ConfidentialAccount.compact:2330`), the id does not contain
   * the change, and since `C292` no circuit reopens the change at all. The
   * consequence that IS true is the one stated above — this device cannot
   * compute or check the commitment a proposal carries.
   */
  private async assetBlindingOf(accountId: string): Promise<Hex> {
    const providers = await this.providers();
    // Read under the account's own contract address, like every other private
    // state access. C228: a read that inherits the last address can answer
    // with another contract's blinding, which derives a different asset key and
    // therefore a change commitment this account's own signers cannot
    // reproduce.
    providers.privateStateProvider.setContractAddress(await this.requireDeployed(accountId));
    const existing = await providers.privateStateProvider.get(
      privateStateKey(this.cfg.privateStateId, accountId));
    if (!existing?.assetBlinding) {
      throw new Error(
        `no asset blinding in the private state for "${accountId}" on this device. ` +
          'It is written when the account is opened and every signer needs the same one — ' +
          'without it this device cannot derive the account\'s asset key, and so cannot ' +
          'compute or check the change commitment a proposal carries.',
      );
    }
    return toHex(existing.assetBlinding);
  }

  private async changeCommitmentOf(c: StateChange, assetBlinding: Hex): Promise<Hex> {
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    /*
     * No `as any`. It carried one until M-125 added the asset parameter — which
     * is precisely the arity change a cast would have hidden, and M-107 is the
     * record of that happening once already.
     */
    return toHex(
      pureCircuits.changeCommitmentOf(
        fromHex(MidnightCommitments.assetKey(c.asset, assetBlinding)),
        c.amount,
        fromHex(c.batchDigest),
        fromHex(c.salt),
      ),
    );
  }

  /**
   * Puts the approved change where the witnesses will find it.
   *
   * `changeAmount`, `changeBatchDigest` and `proposalSalt` were read from the
   * calling device at BOTH ends of a round — the proposer committed to them and
   * `execute` was checked against that commitment. `C292` deleted `execute`, so
   * `propose` is the only circuit that reads them and nothing on chain reopens
   * what it writes. `proposalSalt` is the exception that still has readers at
   * the far end: every governance circuit and `recordPayment` recompute the
   * proposal's id from it.
   *
   * Merged rather than replaced. `stageNext` made the same argument and went
   * with the balance ledger; the reason is unchanged — a device's private state
   * holds more than one call's worth of witnesses, and overwriting the record
   * would drop the ones this call does not set.
   */
  private async stageChange(accountId: string, change: StateChange): Promise<void> {
    const providers = await this.providers();
    // The same rule as stageView, for the same reason: the address is set
    // from the account this stage is for, never inherited.
    const address = await this.requireDeployed(accountId);
    providers.privateStateProvider.setContractAddress(address);
    const key = privateStateKey(this.cfg.privateStateId, accountId);
    const existing = await providers.privateStateProvider.get(key);
    if (!existing) {
      throw new Error(missingPrivateState(accountId, address));
    }
    await providers.privateStateProvider.set(key, {
      ...existing,
      // The asset travels with the change, because `propose` derives the asset
      // key from it. It was BOTH ends of a round until `C292` removed
      // the far one, and there is no map for the key to index any more.
      assetId: assetIdBytes(change.asset),
      changeAmount: change.amount,
      changeBatchDigest: fromHex(change.batchDigest),
      proposalSalt: fromHex(change.salt),
    });
  }

  /**
   * The transaction id, from whichever field this SDK version calls it.
   *
   * `by` is carried only so a failure names the signer whose device made the
   * call. It is not sent anywhere: membership is proven inside the circuit by a
   * Merkle path, and telling the server which leaf acted would hand it exactly
   * the linkage the blinded tree exists to withhold.
   */
  private txRef(result: any, _by: SignerRef): TxRef {
    return {
      ref: String(result?.public?.txId ?? result?.txId ?? result?.public?.txHash ?? ''),
      at: new Date().toISOString(),
    };
  }

  /**
   * Finds the deployed contract and returns its call interface.
   *
   * `findDeployedContract` is the SDK's intended entry point: it reads the
   * contract's public state through the indexer, checks the verifier keys on
   * chain match the ones we compiled, and hands back a typed `callTx`. Doing
   * this by hand is what M-16 tried and lost six rounds to.
   *
   * The verifier key check is not a formality. If Midnight ships a proof
   * system change and our contract was deployed frozen, this is where it
   * surfaces, as a mismatch rather than a mystery. That is M-9.
   */
  private async connect(address: string, privateStateId: string | null) {
    /*
     * NOT `findDeployedContract`. S8c: against a partial deployment,
     * the SDK's find compares all FIFTEEN compiled verifier keys against the
     * deployed state and throws `ContractTypeError` naming the deferred
     * circuits as "undefined or have mismatched verifier keys" — on every
     * call, deferred or not, in words that read as key corruption. The
     * partial find keeps what M-9 valued — the deployed keys are compared
     * byte-for-byte against the compiled ones, through the SDK's own
     * `verifyContractState` — for the deployed circuits that exist, checks
     * the deferred ones are absent, and hands back the same typed `callTx`.
     */
    const { findDeployedPartialContract } = await import('./partial-contract.js');
    const providers = await this.providers();
    return findDeployedPartialContract(providers as any, {
      compiledContract: this.compiled as any,
      contractAddress: address,
      /*
       * WITHOUT THIS, A CIRCUIT THAT READS A WITNESS RUNS WITH NO PRIVATE
       * STATE AT ALL - so the two calls the whole product rests on, opening a
       * round and approving one, were calls no signer could ever have made.
       *
       * The SDK omits the field entirely on a falsy value and then tests for
       * it by PRESENCE, so a key that does not arrive is not a key that is
       * undefined: it selects a different branch, the public-states one, and
       * the executing circuit's `privateState` is literally `undefined`. The
       * witnesses that answer for a signer's secret key, blinding factor and
       * scope read off that object, so what a caller sees is a dereference of
       * `undefined` from inside the circuit runtime, naming none of this.
       *
       * Passed, the same SDK refuses by name instead - "No private state found
       * at private state ID" - which is a sentence a reader can act on.
       *
       * **PASSED RATHER THAN SPREAD, AND THE REASON IS THE FIND RATHER THAN
       * THE SDK.** This line used to spread the field in and leave it out on
       * `null`, because the find's option was an optional string and `null` is
       * not a string. The find now takes the answer as `string | null` and
       * REQUIRES it, so leaving it out is a compile error there and an omitted
       * answer is refused at run time - which is the whole point of the change
       * and is worth more here than a line that cannot say `null` out loud.
       * The SDK's own gate is truthiness rather than presence, so it treats an
       * absent field and a `null` one the same; a later reader should not be
       * told otherwise, because a sentence that overstates what holds a line up
       * is how the line comes to be simplified away.
       */
      privateStateId,
    });
  }

  /**
   * Calls a circuit, and submits it.
   *
   * It submits. The SDK describes `callTx` as lifting each circuit to "a
   * function that builds and submits a call transaction", and it submits via
   * `providers.midnightProvider`, which in our bundle is
   * `sponsoredMidnightProvider` and therefore the sponsor. Fee sponsorship is
   * intact; it simply happens inside this call rather than after it.
   *
   * This comment previously claimed the opposite, and `publish` acted on that
   * claim by submitting a second time. Nothing caught it because the return
   * type is untyped here.
   *
   * `args` is `unknown[]`, which is how `execute` came to be called with an
   * argument it did not take. The arity is checked below so that mistake
   * fails immediately, with the circuit named, rather than inside the SDK.
   */
  /**
   * **ONE CALL AT A TIME THROUGH ONE CLIENT, AND IT IS LOAD-BEARING HERE
   * RATHER THAN MERELY TRUE.**
   *
   * The queue drives one job at a time. That was arranged so that the fee payer
   * knows whose company it is paying for, and it is written down beside the fee
   * payer for that reason - **but a second thing now rests on it, at this
   * method, and nothing said so.**
   *
   * After a call settles entirely, the SDK writes the calling device's record
   * back AS IT WAS WHEN THE CALL STARTED. Between those two moments is a proof
   * that takes minutes. Anything written into that record inside the window is
   * therefore silently reverted - and the writer that lives in that window is
   * the staging a proposal does immediately before it is raised. The field it
   * writes is the salt four governance circuits recompute a proposal's identity
   * from.
   *
   * **A REVERTED SALT IS NOT A WRONG NUMBER. It is a round whose id nobody can
   * reproduce, refusing about the wrong thing**, on an account where the money
   * is fine and no screen can say why the approval will not apply.
   *
   * So: a second call must not be built through this client while one is in
   * flight. If anything ever needs to drive two at once, the answer is a client
   * per operation rather than a cleverer write here - and until then this
   * sentence is what tells whoever adds the second caller what they are
   * standing on.
   */
  /*
   * `privateStateId` IS NOT OPTIONAL AND MUST NOT BE GIVEN A DEFAULT. Every
   * caller has an answer - `prepare` computes the key for the account the call
   * is for, or says `null` for the one circuit that reads no witness - and the
   * whole defect this parameter closes was a value that existed and was
   * dropped. A default here would be this class inventing an answer to a
   * question its caller already answered, which is how the two would come to
   * disagree.
   *
   * **AND THE TYPE IS NOT THE WHOLE GUARD, WHICH IS WHY THERE IS ALSO A
   * RUNTIME ONE.** The compiler holds this for callers it can see; a caller
   * reaching this method through `any` gets `undefined`, and `undefined`
   * behaves exactly like the defect - the SDK omits the field and the circuit
   * runs with nothing. A dropped argument must be a refusal that names itself,
   * not a silent return to the old behaviour.
   */
  private async buildCall(
    address: string, circuit: string, args: unknown[], privateStateId: string | null,
  ) {
    /*
     * **THE ANSWER MUST BE PRESENT, AND IT MUST MATCH THE CIRCUIT, AND THE RULE
     * THAT SAYS SO IS NOT WRITTEN HERE.**
     *
     * It is in `governed-call.js`, which names all four places a call is built
     * in this repository. This was for a while the only one of them that
     * asked. Asking here as well as at the find below is deliberate rather than
     * redundant: this refusal costs nothing and happens before any network
     * read, so a caller of this client learns what it did wrong without waiting
     * for a contract state to come back.
     */
    refuseACallWithoutItsPrivateState(circuit, privateStateId, CIRCUITS_THAT_READ_NO_WITNESS);
    /*
     * BEFORE connecting: a deferred circuit fails here, naming the cause.
     * Left to run on, the failure would be the chain's
     * `VerifierKeyNotPresent` after a proof was paid for — or, worse, the
     * SDK's generic error with the cause a guess. S8c item 1: a call to a
     * circuit the deployment defers must say so, not fail generically.
     */
    if (isDeferredCircuit(circuit)) {
      throw deferredCircuitError(circuit);
    }
    const contract = await this.connect(address, privateStateId);
    const call = (contract.callTx as any)[circuit];
    if (typeof call !== 'function') {
      throw new Error(`the deployed contract has no circuit "${circuit}"`);
    }
    // Arity is checked against the CONTRACT's declared ABI, not against this
    // wrapper's signature.
    
    // The first version of this guard read `call.length`, which is always 0:
    // every generated circuit function is `(...args) => {…}` and a rest
    // parameter contributes nothing to Function.length. So it never fired, and
    // the exact M-27 mistake would have sailed through it. The test missed it
    // because the stub was also written with `(...args)`. A test built from the
    // same wrong model as the fix cannot catch the model.
    assertArity(arityFrom(this.cfg.zkConfigPath), circuit, args.length);
    return call(...args);
  }

  /**
   * The account contract's declared arities.
   *
   * MOVED OUT OF THIS FILE — `circuit-arity.ts`, V-82. It was private here and
   * the vault client never got it, which is precisely how a thirteenth argument
   * to a twelve-argument circuit survived. Two clients, one definition.
   */
  /* Read where it is used rather than held as a field: a field initialiser runs
   * before the constructor's parameter properties exist, and `arityFrom` caches
   * per path at module level, so calling it per call reads the file once. */

  /**
   * Reads the account's committed state from the chain.
   *
   * NOTHING ABOUT WHAT THE ACCOUNT HAS DONE IS ON CHAIN. The ledger of entries
   * is in the sealed blob, which is why `fetch` needs both this and the blob
   * store, and why an account state without a retrievable blob is fatal rather
   * than empty. It used to be "only the commitment is on chain"; `C292` removed
   * the commitment too, so the blob is addressed by a constant and the chain
   * says nothing about its contents at all.
   */
  private async readContractState(address: string): Promise<{
    assets: Array<{ key: string; commitment: Hex }>;
    openProposals: Array<{ id: Hex; change: Hex; approvals: number }>;
    threshold: bigint;
    vaultThresholds: Array<{ vault: Hex; threshold: number }>;
    signerCount: bigint;
    /* The two `docs/accepted-risks.md` §1's detector needs. */
    movementCount: bigint;
    retiredVaults: Hex[];
    updatedAt: string;
  } | null> {
    const { ledger: readLedger } = await import('../../contracts/managed/contract/index.js');
    const providers = await this.providers();

    const state = await providers.publicDataProvider.queryContractState(address as any);
    if (!state) return null;

    const parsed = readLedger(state.data);
    /*
     * **READ BEFORE THE OBJECT BELOW IS BUILT, SO A MISSING MAP REFUSES RATHER
     * THAN RETURNING A STATUS WITH A ZERO IN IT.**
     *
     * The pair type is written here rather than inferred, for the reason
     * `mapField`'s own note gives: `tsconfig.scripts.json` has `strict: false`
     * and will accept an `any` flowing through, so a future mismatch is only a
     * compile error if somebody wrote the shape down.
     * `contracts/managed/contract/index.d.ts:281-287` is where this one is
     * declared, `lookup` included.
     */
    const approvalCounts = mapField<[Uint8Array, bigint]>(parsed, 'approvalCounts') as CountedMap;
    // The lifecycle fields are read because `prepare` has to know whether a
    // circuit is legal before calling it — `requireOpen` and `requireApproved`
    // are what use them — and because they are public by design: the threshold
    // and the approval count are what make the account auditable. See decision
    // 0003. There is no commitment read alongside them any more, and `publish`
    // and `execute`, which this sentence used to name, are both gone.
    return {

      /*
       * NO ASSETS, AND THIS IS READ OFF THE CONTRACT RATHER THAN ASSUMED.
       *
       *
       * `assetBalances` was one of the contract's four public maps and it is
       * gone, so there is nothing to decode and the guard below counts three,
       * not four. The field stays on `LedgerStatus`, empty, because it is the
       * shape both implementations answer in.
       */
      assets: [],
      /*
       * Every open proposal, sorted so two reads of an unchanged account produce
       * an identical array — a map's iteration order is not a promise, and
       * anything that gets compared has to be stable.
       *
       * **THE APPROVAL COUNT COMES THROUGH `mapField` TOO, AND UNTIL `S6c` IT
       * DID NOT.** `R5b` guarded three of the contract's four maps and
       * this line read the fourth off `parsed` directly — `parsed.approvalCounts
       * .lookup(id)` — which is the one shape the guard exists to refuse. A
       * reader that handed over no `approvalCounts` threw a `TypeError` about
       * an internal expression here, and the obvious repair to THAT is `?? 0n`:
       * an unread count becoming a count of zero, which is the same defect as
       * `?? []` one map along and reads just as careful.
       *
       * **A guard on three of four is what makes the fourth look checked**,
       * which is `C188`'s own closing argument turned on the round that wrote
       * it.
       *
       * `lookup` rather than iteration, because the count is fetched per
       * proposal and every open proposal is guaranteed an entry by the contract
       * itself — `propose` does `approvalCounts.insert(id, 0)` on both its
       * branches (`contracts/src/ConfidentialAccount.compact:2139` and
       * `:2314`), and `closeProposal` (`:1321`) removes the two together. Every
       * circuit that spends or withdraws a proposal goes through
       * `closeProposal` and there is no other remover; `execute` was one of its
       * callers and is gone, which is why this sentence used to name
       * it. So a proposal without a count is a contract-level inconsistency and
       * not a case this boundary invents a zero for.
       */
      openProposals: [...mapField<[Uint8Array, Uint8Array]>(parsed, 'openProposals')]
        .map(([id, change]) => ({
          id: toHex(id),
          change: toHex(change),
          approvals: Number(approvalCounts.lookup(id)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      threshold: parsed.threshold,
      /*
       * **THE VAULTS SOMEBODY GAVE THEIR OWN THRESHOLD, AND NO OTHERS.** `R5`,
       * `thresholds` is an `export ledger` map
       * (`contracts/src/ConfidentialAccount.compact:251`), so this is a read of
       * public state and not a derivation.
       *
       * Sorted for the reason `assets` and `openProposals` are: a map's
       * iteration order is not a promise and this array gets compared.
       *
       * **`Number()` ON A `Uint<64>`, and the same reservation applies here as
       * everywhere else in this file** — a threshold is a count of signers, so
       * it cannot approach 2^53 for any account that could ever meet it, and a
       * value that did would be one nobody could satisfy anyway.
       *
       * **AN EMPTY MAP HERE MEANS "NO VAULT HAS ITS OWN THRESHOLD" AND NOTHING
       * ELSE.** `mapField` is what makes that true: a map the reader did not
       * hand over refuses above rather than arriving here as `[]`. See its own
       * note — the distinction is the difference between *inherit* and *we
       * could not read the exceptions*, and those two have opposite meanings.
       */
      vaultThresholds: [...mapField<[Uint8Array, bigint]>(parsed, 'thresholds')]
        .map(([vault, threshold]) => ({ vault: toHex(vault), threshold: Number(threshold) }))
        .sort((a, b) => a.vault.localeCompare(b.vault)),
      /*
       * DERIVED, NOT READ. S35c deleted the `signerCount` ledger field: two
       * public fields meaning the same number is the drift this project keeps
       * recording, and `Set.size()` is an ON-CHAIN read rather than a
       * TypeScript-only one. This is the ONLY place on this boundary that
       * touches the chain for it — everything downstream reads the number this
       * line produces and is unchanged.
       *
       * AND IT GOES THROUGH A GUARD, BECAUSE THE PARAGRAPH BELOW SAID IT WOULD.
       * `mapField`'s note ends *"if a fourth is ever exported again, this
       * paragraph is where somebody will find out"* — S35c is that fourth read,
       * and the first draft of this line spread it off `parsed` directly, which
       * is `C188` exactly. Found by S35c's test-coverage pass and its
       * money-safety pass, independently. What it costs unguarded is not a
       * crash: `?? 0n` is the repair anybody reaches for, and a seat count of
       * zero makes this client believe the M-37 bootstrap window is open, refuse
       * every threshold change and refuse every removal — the contract still
       * refuses correctly, and OUR refusals stop refusing.
       */
      signerCount: setSize(parsed, 'signerLeaves'),
      /*
       * **THE TWO FIELDS `docs/accepted-risks.md` §1's DETECTOR NEEDS, AND THE
       * ONLY REASON EITHER IS READ.** `SC10` measured that
       * `LedgerStatus` carried five of the contract's fourteen public fields
       * and that these two were not among them, so the detector the founder's
       * `C395` ruling rests on could not be written against this boundary.
       *
       * **BOTH GO THROUGH THE SAME GUARDS AS EVERYTHING ELSE HERE**, which is
       * `C188`'s rule and the paragraph above `signerCount` is the worked
       * example of what skipping them costs: a `?? 0n` repair turns *we could
       * not read it* into a confident zero, and a confident zero here would
       * report a burn that had not happened or hide one that had.
       *
       * `movements` is a COUNT — the set's own `size()`, on chain — because the
       * comparison the ruling describes is between magnitudes. `retiredAt` is
       * read for its KEYS only: nothing removes from it, so presence is *ever
       * retired* and the marker value it stores carries nothing else.
       */
      movementCount: setSize(parsed, 'movements'),
      retiredVaults: [...mapField<[Uint8Array, bigint]>(parsed, 'retiredAt')]
        .map(([vault]) => toHex(vault))
        .sort((a, b) => a.localeCompare(b)),
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * **ONE OF THE CONTRACT'S MAPS, OR A REFUSAL NAMING WHICH ONE WAS MISSING.**
 * `R5b`, and it exists because a guess was wrong in a way both typecheckers
 * accepted.
 *
 * `readContractState` spread three of these directly. That is correct about the
 * SHAPE — the generated reader declares all three as non-optional accessors
 * with `[Symbol.iterator](): Iterator<[Uint8Array, …]>`
 * (`contracts/managed/contract/index.d.ts:256`, `:277`, `:298`) — and it says
 * nothing about PRESENCE, which is the assumption that actually broke:
 * `parsed.thresholds` arrived `undefined` and `[...undefined]` threw a
 * `TypeError` naming an internal expression.
 *
 * **THE REFUSAL IS THE POINT AND `?? []` IS THE DEFECT.** The obvious repair is
 * to coerce a missing map to an empty one, and for `thresholds` that is the
 * dangerous direction rather than the safe one:
 *
 *   · an account where nobody has set an exception decodes to an EMPTY map, and
 *     the honest answer is *every vault inherits the account's threshold*
 *   · a map we failed to read is not that, and answering *inherit* for it means
 *     a vault somebody deliberately gave a HIGHER threshold is judged by the
 *     account's lower one — and the round settles early
 *
 * **Those two are distinguishable, and this function is where the distinction
 * is kept.** An empty map is an accessor that iterates zero times; a missing one
 * is not an accessor at all. `midnight-ledger-decodes-what-it-claims.test.ts`
 * pins both sides, because a property that is only true while nobody writes
 * `?? []` is not a property.
 *
 * Applied to all three maps and not only to the new one. The two it was NOT
 * applied to were the analogy the wrong guess was drawn from; a guard on one of
 * three is the shape that makes the other two look checked.
 *
 * **AND THREE OF FOUR IS THE SAME SHAPE ONE LEVEL UP, WHICH IS `C188` AND WHICH
 * `S6c` CLOSED.** `approvalCounts` — then the contract's fourth public map —
 * was read off `parsed` directly at the `openProposals` call site for as long
 * as this function existed, which is to say the sentence above was true of
 * three maps and confidently wrong about the account. It goes through here now,
 * as a `CountedMap`. **THERE ARE NOW THREE MAPS AND THERE ARE THREE GUARDS** —
 * `assetBalances` went with the balance ledger, which is a map
 * removed rather than a guard dropped. **If a fourth is ever exported again,
 * this paragraph is where somebody will find out that the count is a thing
 * this file states out loud.**
 *
 * **AND IT FIRED. `S35c`, 2 Sep.** That round deleted the `signerCount` ledger
 * field and derived the number from `signerLeaves`, which is a fourth
 * collection read off `parsed` — a SET rather than a map, so `mapField`'s
 * pair-iterator test is the wrong shape for it and `setSize` below is its
 * sibling. **The prediction did not fire on its own: the first draft of that
 * line spread it directly and two auditors found it.** So the honest statement
 * of the count is now THREE MAPS AND ONE SET, four guards, and the thing that
 * catches the fifth is somebody reading this paragraph rather than the
 * paragraph itself.
 *
 * `Symbol.iterator` rather than `isEmpty` is the test deliberately: the real
 * reader returns an accessor and the tests supply arrays, and what both promise
 * — and all this function needs — is that they iterate as pairs.
 *
 * **THE PAIR TYPE IS WRITTEN AT EACH CALL SITE, COPIED FROM THE GENERATED
 * `.d.ts` RATHER THAN INFERRED.** `openProposals` is
 * `Iterator<[Uint8Array, Uint8Array]>` and `thresholds` is
 * `Iterator<[Uint8Array, bigint]>`. Writing them down is what makes a
 * future mismatch a compile error in the STRICT tree — `tsconfig.scripts.json`
 * has `strict: false` and accepted the original spread of an `any`, which is
 * how a wrong assumption reached a test run with two green typechecks behind it.
 */
export class UndecodedLedgerField extends Error {
  /*
   * `kind` DEFAULTS TO `map` SO THE THREE EXISTING REFUSALS ARE BYTE-IDENTICAL.
   * `S35c` added a SET to the guarded set and the message has to say which noun
   * it means; rewriting the three map messages to a neutral word would have
   * churned three tests that assert the exact sentence, for nothing.
   */
  constructor(readonly field: string, kind: 'map' | 'set' = 'map') {
    super(
      `the contract's "${field}" ${kind} was not in the decoded state, so this boundary ` +
        'cannot say what it holds. **This is not the same as the map being empty** — an ' +
        'empty map is a true statement about the account and a missing one is our ' +
        'ignorance, and for "thresholds" the two have opposite meanings: empty means every ' +
        'vault inherits the account\'s threshold, missing means a vault with its own may be ' +
        'about to be judged by the wrong number. Read the state again.',
    );
    this.name = 'UndecodedLedgerField';
  }
}

/**
 * A decoded map this boundary LOOKS A KEY UP IN, rather than only iterating.
 *
 * Copied from the generated reader
 * (`contracts/managed/contract/index.d.ts:281-287`) rather than inferred, and
 * the two halves are both used: `mapField` proves the map is THERE by its
 * iterator, and `lookup` is how a count is fetched for one proposal.
 */
type CountedMap = Iterable<[Uint8Array, bigint]> & { lookup(key: Uint8Array): bigint };

const mapField = <T>(parsed: any, field: string): Iterable<T> => {
  const m = parsed?.[field];
  if (m == null || typeof m[Symbol.iterator] !== 'function') {
    throw new UndecodedLedgerField(field);
  }
  return m as Iterable<T>;
};

/**
 * **ONE OF THE CONTRACT'S SETS, COUNTED — OR A REFUSAL NAMING WHICH ONE WAS
 * MISSING.** `mapField`'s sibling, and everything that note argues applies here
 * unchanged; read it first.
 *
 * `S35c` is why this exists. Deleting the `signerCount` ledger field made the
 * seat count a read of `signerLeaves`, and `signerLeaves` is a `Set` accessor —
 * `{ isEmpty, size, member, [Symbol.iterator] }` over single values rather than
 * pairs (`contracts/managed/contract/index.d.ts`). `mapField` would accept it
 * and hand back an iterable this caller does not want; `size()` is the on-chain
 * read and is what the boundary actually needs.
 *
 * **AND THE DIRECTION THAT IS DANGEROUS IS THE SAME ONE.** An account really
 * can have an empty set — never, for `signerLeaves`, since the constructor
 * seats one, which is why this returns the count rather than tolerating zero —
 * but a collection we FAILED TO READ answering `0` is the shape that matters:
 * `signerCount: 0` makes every caller downstream believe the M-37 bootstrap
 * window is open on a live account, refuse every threshold change and refuse
 * every removal. `?? 0n` is the defect, exactly as `?? []` is for a map.
 *
 * `typeof size === 'function'` rather than `Symbol.iterator`, because `size` is
 * the thing being called and a guard that proves a different member is present
 * is a guard on the wrong member.
 */
const setSize = (parsed: any, field: string): bigint => {
  const s = parsed?.[field];
  if (s == null || typeof s.size !== 'function') {
    throw new UndecodedLedgerField(field, 'set');
  }
  return s.size();
};

/* ------------------------------------------------------------------ *
 * proofs
 * ------------------------------------------------------------------ */

/**
 * Maps our three logical circuits onto Compact circuits. NONE OF THEM MAP NOW.
 *
 * `balance-at-least` USED TO MAP onto `attestSolvency`, which returned a
 * boolean and never the balance. **S23 shed `attestSolvency` from the
 * contract**, so that name no longer denotes anything the chain can verify and
 * naming it here would be this file claiming a route it does not have. All
 * three are `null`, and none is stubbed with something that returns true.
 *
 * `MidnightProofSystem.prove` has never proved any of them — it throws "not
 * implemented" for want of the proof server — so no working path is lost here.
 * What the PRODUCT calls solvency attestation runs on a different proof system
 * entirely (`src/core/payroll.ts`), which this map does not reach.
 */
const CIRCUIT_MAP: Record<Circuit, string | null> = {
  'balance-at-least': null,
  'payroll-total': null,
  'payment-record': null,
};

export class MidnightProofSystem implements ProofSystem {
  constructor(private cfg: MidnightConfig) {}

  async prove(circuit: Circuit, _publicInputs: Record<string, unknown>, _witness: unknown): Promise<Hex> {
    const target = CIRCUIT_MAP[circuit];
    if (!target) throw new Error(`no Compact circuit for "${circuit}" yet`);
    throw new Error('not implemented: requires the proof server at ' + this.cfg.proverUrl);
  }

  async verify(_circuit: Circuit, _publicInputs: Record<string, unknown>, _proof: Hex): Promise<boolean> {
    throw new Error('not implemented: verification happens on chain');
  }

  describe(): string {
    return `Midnight proof server at ${this.cfg.proverUrl}`;
  }
}

/* ================================================================== *
 * WHAT AUTHORITY A DEPLOYED CONTRACT ACTUALLY CARRIES — `C354`, `2y9-1`
 * ================================================================== */

/**
 * WHAT AUTHORITY A DEPLOYED CONTRACT CARRIES ON CHAIN, AND WHETHER IT IS THE
 * ONE WE MEANT TO INSTALL. `C354` `P0`, board row `2y9-1`.
 *
 * Nothing in this repository has ever read a contract's maintenance authority
 * back, so a half-applied change has been undetectable. The founder ruled on
 * 5 Sep that the authority moves to the company's own signers, for the account
 * and for the vaults; **nothing could verify that it had been installed until
 * this existed.** A round that installs an authority it cannot read back has
 * proved nothing.
 *
 * **IT IS A READ.** It signs nothing, submits nothing, changes nothing and
 * touches no key. It does not install, replace or propose an authority, and it
 * does not decide which authority is right — that is ruled, and `2y9-3`'s to
 * install.
 *
 * ── WHY IT IS HERE AND NOT IN A FILE OF ITS OWN ──────────────────────────────
 *
 * It is appended to an existing file rather than given one of its own, at the
 * end, where it moves no line above it. That keeps every `file:line` locator
 * elsewhere in this repository pointing at what it pointed at before.
 *
 * **THE HONEST COST OF THAT CHOICE: this file is longer than one subject should
 * make it.** Splitting it is a mechanical change and it is worth doing; it was
 * not worth doing in the same change as the work below.
 *
 * **AND WHERE IT PARTS FROM THE SCOPE DOCUMENT, RULE 20, NEITHER MARKED
 * CORRECT.** `docs/scope-the-vault-rebuild.md` §2.4 says the read-back "is one
 * edit at the existing `queryContractState` reader, `src/midnight/ledger.ts:1834-1848`".
 * **AGAINST THAT, MEASURED:** that reader is `readContractState`, it is private,
 * and its second statement is `readLedger(state.data)` against the ACCOUNT's
 * compiled artifact — so it throws for a vault, and the read-back must serve any
 * address, the vaults above all, because `C349` is the vault half. The file is
 * the scope document's; the method is not. **FOR THE SCOPE DOCUMENT:** one
 * reader is one place to keep correct.
 *
 * ── WHY THIS IS NOT AN SDK CALL, WHICH IS THE POINT ──────────────────────────
 *
 * **THE SDK LOOKS LIKE IT ALREADY DOES THIS AND IT DOES NOT.**
 * `ReplaceAuthority`, `VerifierKeyInsert`, `submitReplaceAuthorityTx` and
 * `MaintenanceUpdate` appear in this repository ONLY IN COMMENTS — `SC20` `F3`,
 * re-confirmed at source by `S61`: six hits across `src/`, `scripts/`,
 * `contracts/` and every `.command`, all of them comment lines.
 *
 * And it matters more than a missing helper, because of what the founder's
 * ruling does: **choosing a committee switches Midnight's SDK maintenance
 * interface OFF for that contract, permanently**. Under a committee no
 * signing key is stored (`partial-contract.ts:358-360`), and every SDK
 * maintenance entry point opens by asserting exactly that slot —
 * `midnight-js-contracts/dist/index.mjs:398-399`, `:470-471`, `:547-548`. **A
 * read-back built on one of those would work today for `single-key` and stop
 * working on the day this project does the thing it has decided to do.**
 *
 * **SO THIS READS A LEDGER PROPERTY, NOT AN SDK ENTRY POINT.**
 * `publicDataProvider.queryContractState` returns a deserialized `ContractState`
 * — the indexer transports it as hex and the provider calls
 * `deserializeCompactContractState`
 * (`midnight-js-indexer-public-data-provider/dist/index.mjs:268`, `:1354`) — and
 * `.maintenanceAuthority` is a field on that object
 * (`@midnightntwrk/ledger-v9/ledger-v9.d.ts:848`, exposing `.committee` `:784`,
 * `.threshold` `:788`, `.counter` `:792`). No signing key is consulted, so a
 * committee costs nothing a single key does not.
 *
 * **MEASURED BY `S61`, NOT REASONED (rule 9), IN TWO PARTS BECAUSE ONE WAS NOT
 * ENOUGH.**
 *
 *   1. **LIVE, ON ALL THREE CONTRACTS** this project has deployed on stagenet —
 *      one GraphQL query each, nothing signed or submitted. The account
 *      `90ebef16…` answered a committee of one, threshold `1`, counter `0`, over
 *      `11` entry points; the vaults `payroll-test-1` `d082252c…` and
 *      `payroll-test-2` `82e1dde9…` answered the same shape over `4`. **AND THE
 *      KEYS MATCH THE DISK EXACTLY, ON ALL THREE**: the verifying key derived
 *      from each `.midnight/*-authority.json` IS that contract's on-chain key.
 *      That is this comparison, run against the real chain, by the door.
 *      *(An earlier draft of this paragraph said "two" and named two of the
 *      three — three were measured. Caught by `S61`'s money-safety pass;
 *      a comment in a money-path file is a truth claim under rule 14.)*
 *   2. **FOR A COMMITTEE**, which is on no disk anywhere and so cannot be read
 *      live: a `ContractState` carrying 2-of-3 and 3-of-3 committees round-trips
 *      through the indexer's own deserializer with committee, threshold and
 *      counter intact, as does an empty committee. **The read is
 *      kind-independent, which is what `§5` asked and is what `2y9-2` and
 *      `2y9-3` inherit.**
 *
 * ── WHAT THE CHAIN CAN AND CANNOT TELL YOU ───────────────────────────────────
 *
 * **THE CHAIN DOES NOT CARRY A KIND. IT CARRIES A VALUE.** There is no
 * `single-key` on chain: the SDK's single key IS a committee of one at threshold
 * one (`compact-js ContractExecutable.js:276-290`, `DEFAULT_CMA_THRESHOLD = 1`),
 * and `partial-contract.ts:311-316` builds all three of this project's kinds into
 * that one struct. **MEASURED, BYTE-IDENTICAL: a `single-key` authority over key
 * A and a `committee` of `[A]` at threshold `1` serialize to the same bytes.** So
 * `authorityShapeOf` reports the shape of the VALUE, and nothing may read
 * `one-key` as *the choice was `single-key`*. **Rule 27 in the direction that
 * matters: the kind is not recoverable, so nothing may claim to have recovered it.**
 *
 * **WHICH IS WHY THE COMPARISON IS OVER THE VALUE AND NOT THE LABEL** —
 * `SC6b`'s rule stated concretely: compare the LIVE AUTHORITY against the
 * intended END STATE, not against a counter. `ReplaceAuthority` replaces
 * WHOLESALE (`semantics.rs:1488-1490`), so *did my change land* is a whole-value
 * equality test and not a diff.
 *
 * **AND THE COUNTER IS DELIBERATELY EXCLUDED.** It increments once per applied
 * update (`semantics.rs:1484-1485`), so a byte-identical resubmission hits
 * `ReplayCounterMismatch` — and that error carries only the address (`:1482`)
 * and cannot say whose update landed. Comparing counters would make a settled
 * contract look unsettled for ever. **MEASURED: the counter IS part of the
 * serialized value (`0` and `7` differ in bytes), so excluding it is a decision
 * taken here, not a property inherited.**
 *
 * ── THE THIRD STATE, WHICH IS THE HALF `C354` IS ACTUALLY ABOUT ──────────────
 *
 * `C354`'s defect is that **a half-applied change is undetectable.** So the
 * answer has THREE states and not two: they agree, they disagree, or **the chain
 * could not be asked.** `R4`'s distinction — and `S55` shipped a `P1` by
 * collapsing exactly this three into two: ***the ledger cannot answer* is NOT
 * *the answer is no*.** `src/core/account.ts`'s `chainHolds` is the same problem
 * solved once already and this copies its shape.
 *
 * **A CONTRACT THE PROVIDER HOLDS NOTHING FOR IS `unknown`, NOT `disagree`, AND
 * THAT IS THE CAREFUL CHOICE.** `queryContractState` answers `null` both for an
 * address with no contract AND for an indexer that has not caught up to the
 * block that deployed one — `index.mjs:1354` cannot tell them apart. Reading
 * `null` as *your change did not land* would be `S55`'s error in a new shape: a
 * definite negative reported from an ambiguous answer. So it refuses rather than
 * proceeding, which is the third outcome `SC6b` asked for — and the READ keeps
 * `absent` and `unreachable` apart, so a caller wanting the distinction has it.
 */

/**
 * The shape of an authority VALUE, which is all the chain carries.
 *
 * `one-key` is named for what it is rather than for a kind, because it is what
 * `single-key` AND a committee of one at threshold one both look like on chain.
 *
 * **`anyone` EXISTS BECAUSE `S61`'s money-safety pass CAUGHT THIS ROUND
 * REPORTING THE MOST DANGEROUS VALUE ON CHAIN WITH THE NAME OF THE SAFEST.**
 * A threshold of ZERO is not *unmaintainable*: `verify.rs:1789` is
 * `if self.signatures.len() < authority.threshold as usize`, and it is the ONLY
 * FUNCTIONAL read of `threshold` in that crate at 8.2 — so at `0`, `0 < 0` is false
 * and a maintenance update carrying NO SIGNATURES AT ALL is well-formed.
 * **Anybody in the world can rewrite that contract's rules.**
 * *(This paragraph used to continue "and the verification loop at `:1775` never
 * runs, so committee membership is never consulted either". **That is FALSE and was
 * measured false on ledger 9 by `S74`'s platform fact-check:** the loop iterates
 * the SIGNATURES, not the threshold, so at threshold zero an out-of-range seat and a
 * wrong signature are both still refused. It has nothing to iterate only when no
 * signatures are attached — the one case that had been tried. The conclusion is
 * unchanged; the mechanism was wrong. `docs/corrections.md`.)*
 * The first draft of this function returned `'no-one'` for it — the word this
 * codebase uses for `unmaintainable`, documented at `partial-contract.ts:118-130`
 * as *"nobody — not us, not a stolen key — can ever change which proofs this
 * deployment accepts"* — and returned `'committee'` for an N-key committee at
 * threshold zero, which reads as *M-of-N is in force*. Both are now `anyone`.
 */
export type AuthorityShape = 'anyone' | 'no-one' | 'one-key' | 'committee';

/** A signing or verifying key as the runtime structures it. */
type AuthorityKey = import('./partial-contract.js').TaggedKey;

/** A contract's maintenance authority exactly as the chain holds it. */
export interface OnChainAuthority {
  /** The committee's verifying keys, IN CHAIN ORDER — the order is part of the value. */
  committee: AuthorityKey[];
  threshold: number;
  /** Replay protection. Read and reported; never compared. */
  counter: bigint;
  shape: AuthorityShape;
  /**
   * **THE COMMITTEE LISTS ONE KEY MORE THAN ONCE, SO ITS THRESHOLD IS NOT WHAT
   * IT LOOKS LIKE.** Raised by `S61`'s platform fact-check as a READING of
   * `midnight-src/midnight-ledger/` at 8.2.0-rc.1 — **AND MEASURED ON LEDGER 9 BY
   * `S74`, WHICH IS THE BUILD THE CHAIN RUNS: it is real. One signature value,
   * attached at three seats holding the same key, satisfies `[K,K,K]` at threshold
   * 3 and the transaction is WELL-FORMED.** `MAINTENANCE-INSTRUCTION-CHECK.command`
   * variant (b) is where a person re-takes that measurement.
   * `committee` is a plain `Vec<VerifyingKey>` (`state.rs:701`) and nothing
   * anywhere requires its entries to be distinct; `data_to_sign`
   * (`structure.rs:2737-2747`) covers address, updates and counter and NOT the
   * signer index, so ONE signature value is valid at EVERY index whose slot
   * holds that key. A committee of `[K, K, K]` at threshold 3 is therefore
   * satisfied by the single holder of `K` signing once and attaching it at
   * indices 0, 1 and 2 — strictly ascending, so the ordering guard at
   * `verify.rs:1757` passes; each verifies against its own slot at `:1782`; and
   * `len() == 3 >= 3` at `:1789`. **`requireMaintenanceAuthority`
   * (`partial-contract.ts:174-205`) checks the committee's SIZE and the
   * threshold's RANGE and does not check for duplicates.** So this is read back
   * and reported rather than assumed away.
   */
  hasDuplicateMembers: boolean;
}

/**
 * Four states, because the read has four honest answers and the comparison's
 * three are built from them rather than guessed at.
 */
export type AuthorityRead =
  | { state: 'read'; address: string; authority: OnChainAuthority }
  /** The provider answered and holds no contract state at this address. */
  | { state: 'absent'; address: string; why: string }
  /** The provider could not be asked, or threw. NEVER read as an answer. */
  | { state: 'unreachable'; address: string; why: string }
  /** State came back in a shape this does not recognise. Refuses; never guesses. */
  | { state: 'unreadable'; address: string; why: string };

/**
 * The shape of a value, from the value alone.
 *
 * A threshold above the committee size is the state the runtime documents as
 * valid and impossible to satisfy — *"If the threshold is greater than the
 * number of committee members, it is impossible for them to sign anything"* —
 * so it is `no-one` however many keys are listed. **MEASURED: the constructor
 * accepts it**, so this is a state that can exist and not a hypothetical.
 */
export function authorityShapeOf(
  committee: readonly AuthorityKey[], threshold: number,
): AuthorityShape {
  /* FIRST, and it must stay first: a threshold below one is satisfied by no
   * signatures at all, whatever the committee holds. */
  if (threshold < 1) return 'anyone';
  if (committee.length === 0) return 'no-one';
  if (threshold > committee.length) return 'no-one';
  if (committee.length === 1 && threshold === 1) return 'one-key';
  return 'committee';
}

/**
 * The authority off a `ContractState`, or a refusal naming what was missing.
 *
 * Structural rather than typed against the runtime class, for the reason
 * `TaggedKey` gives one file over: this boundary states what it relies on, and
 * `tsconfig.scripts.json` has `strict: false` and would let an `any` flow
 * through a mismatch unnoticed.
 */
export function authorityFromContractState(
  state: unknown,
): OnChainAuthority | { why: string } {
  if (!state || typeof state !== 'object') return { why: 'contract state was not an object' };
  const a = (state as { maintenanceAuthority?: unknown }).maintenanceAuthority;
  if (!a || typeof a !== 'object') {
    return { why: 'contract state carries no `maintenanceAuthority` field' };
  }
  const raw = a as { committee?: unknown; threshold?: unknown; counter?: unknown };
  if (!Array.isArray(raw.committee) || !raw.committee.every(isAuthorityKey)) {
    return { why: '`maintenanceAuthority.committee` is not a list of {tag,value} keys' };
  }
  if (typeof raw.threshold !== 'number' || !Number.isInteger(raw.threshold)) {
    return { why: '`maintenanceAuthority.threshold` is not an integer' };
  }
  if (typeof raw.counter !== 'bigint') {
    return { why: '`maintenanceAuthority.counter` is not a bigint' };
  }
  const committee = raw.committee.map((k) => ({ tag: k.tag, value: k.value }));
  const distinct = new Set(committee.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`));
  return {
    committee, threshold: raw.threshold, counter: raw.counter,
    shape: authorityShapeOf(committee, raw.threshold),
    hasDuplicateMembers: distinct.size !== committee.length,
  };
}

/**
 * Just enough of a public data provider to ask one question, so the door passes
 * the real one and a test passes a function. Named rather than `any` so a change
 * in the provider is a compile error here.
 */
export type ContractStateReader = (address: string) => Promise<unknown>;

/**
 * WHAT AUTHORITY THIS DEPLOYED CONTRACT CARRIES ON CHAIN. `C354`, first limb.
 *
 * A READ: one query, nothing signed, nothing submitted, no key touched. A throw
 * from the provider is `unreachable` and never `absent` — the whole point of the
 * row is that those are different.
 */
export async function readContractAuthority(
  read: ContractStateReader, address: string,
): Promise<AuthorityRead> {
  let state: unknown;
  try {
    state = await read(address);
  } catch (e) {
    return {
      state: 'unreachable', address,
      why: `the chain could not be asked: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (state === null || state === undefined) {
    return {
      state: 'absent', address,
      why: 'the provider answered and holds no contract state at this address — either nothing ' +
        'is deployed there, or the indexer has not caught up to the block that deployed it. ' +
        'It is not evidence that an authority is wrong.',
    };
  }
  const authority = authorityFromContractState(state);
  if ('why' in authority) return { state: 'unreadable', address, why: authority.why };
  return { state: 'read', address, authority };
}

/**
 * The on-chain VALUE a choice in `.midnight/*-authority.json` is meant to
 * produce. **Not invented here: it is exactly what `partial-contract.ts:311-316`
 * constructs**, restated so a comparison can be made without deploying anything.
 *
 * `single-key` needs the VERIFYING key and the file holds a SIGNING key, so a
 * derivation is unavoidable — `deriveVerifyingKey` is passed in rather than
 * imported, because it is the runtime's and this module must stay loadable
 * without WASM. **MEASURED against both live contracts: the key derived from
 * each `.midnight/` file IS the key on chain, exactly.**
 */
export function intendedAuthorityValue(
  choice: MaintenanceAuthorityChoice,
  deriveVerifyingKey: (signingKey: AuthorityKey) => AuthorityKey,
): { committee: AuthorityKey[]; threshold: number } {
  switch (choice.kind) {
    case 'committee':
      /*
       * **A THRESHOLD BELOW ONE IS REFUSED HERE AND NOT ONLY IN
       * `requireMaintenanceAuthority`, AND THE REASON IS THIS ROUND'S OWN
       * NEAR-MISS.** `S61`'s money-safety pass found that a `0` typed into
       * a choice file would make this return `threshold: 0`, the chain carry
       * `0`, and `compareAuthority` answer `agree` — the door then printing
       * *"Every contract carries the authority recorded for it"* over a contract
       * anybody in the world can maintain. **A comparator that agrees about a
       * value neither side should ever hold is worse than one that refuses.**
       * `requireMaintenanceAuthority` does catch it, and the door now calls it —
       * but this function is exported and a caller that forgets is exactly how
       * the near-miss happened.
       */
      if (!Number.isInteger(choice.threshold) || choice.threshold < 1) {
        throw new Error(
          `a maintenance authority at threshold ${choice.threshold} is not a committee. Set ` +
            'the threshold to at least one and no more than the number of keys in the ' +
            'committee. A threshold ABOVE the committee size is the unmaintainable state — ' +
            'say { kind: "unmaintainable" } deliberately if that is the intent, rather than ' +
            'reaching it by arithmetic. A threshold BELOW one is WORLD-WRITABLE, not ' +
            'unmaintainable: MEASURED on `@midnightntwrk/ledger-v9@1.0.0-rc.3`, a maintenance ' +
            'update carrying NO SIGNATURES AT ALL is well-formed against an authority at ' +
            'threshold zero, so anybody at all could replace this contract\'s verifier keys ' +
            'while holding nothing. Committee membership IS still checked — a signature at an ' +
            'out-of-range seat is refused, and so is a wrong signature at a valid seat — what ' +
            'is missing is any requirement to attach one. This refuses rather than comparing ' +
            'the value against the chain.',
        );
      }
      return {
        committee: choice.committee.map((k) => ({ tag: k.tag, value: k.value })),
        threshold: choice.threshold,
      };
    case 'single-key': {
      const vk = deriveVerifyingKey(choice.signingKey);
      return { committee: [{ tag: vk.tag, value: vk.value }], threshold: 1 };
    }
    case 'unmaintainable':
      return { committee: [], threshold: 1 };
  }
}

/**
 * THREE STATES, NOT TWO. `R4`; `S55` shipped a `P1` collapsing exactly this.
 *
 * `unknown` means the chain could not be asked and NOTHING may be concluded from
 * it — not that the authority is wrong, and not that it is right.
 */
export type AuthorityVerdict = 'agree' | 'disagree' | 'unknown';

export interface AuthorityComparison {
  verdict: AuthorityVerdict;
  address: string;
  /** Always present. On `unknown` it says why the chain could not answer. */
  why: string;
  /** The chain's value, when there was one. */
  onChain?: OnChainAuthority;
  /** The value the choice on disk is meant to produce. */
  intended?: { committee: AuthorityKey[]; threshold: number };
}

const sameAuthorityKey = (a: AuthorityKey, b: AuthorityKey) =>
  a.tag.toLowerCase() === b.tag.toLowerCase() &&
  a.value.toLowerCase() === b.value.toLowerCase();

const authorityMultiset = (ks: readonly AuthorityKey[]) =>
  ks.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`).sort().join('|');

/**
 * DOES THE CHAIN CARRY WHAT WE MEANT TO INSTALL? `C354`, the half the row is
 * actually about — a half-applied change across N contracts is silent at both
 * ends unless something asks this question, per contract.
 *
 * **ORDER IS PART OF THE VALUE AND IS REPORTED AS SUCH.** MEASURED: the same
 * three keys in a different order serialize to different bytes. Two committees
 * with the same members in a different order authorise exactly the same signers,
 * so calling that `disagree` is defensible only if the reason is said out loud —
 * a round that "fixed" it would spend a real update replacing a value with an
 * equivalent one. It is `disagree` here, because a wholesale replace is a
 * whole-value test, and `why` names it precisely so `2y9-2` decides knowingly
 * rather than discovers it.
 *
 * **THE COUNTER IS NOT COMPARED.** `SC6b`: against the end state, never against
 * a counter.
 */
export function compareAuthority(
  read: AuthorityRead,
  intended: { committee: AuthorityKey[]; threshold: number },
): AuthorityComparison {
  if (read.state !== 'read') {
    return {
      verdict: 'unknown', address: read.address, intended,
      why: `the chain could not be asked what authority this contract carries — ${read.why}`,
    };
  }
  const chain = read.authority;
  const base = { address: read.address, onChain: chain, intended };

  if (chain.threshold !== intended.threshold) {
    return {
      ...base, verdict: 'disagree',
      why: `the chain carries threshold ${chain.threshold} and the intended end state is ` +
        `${intended.threshold}.`,
    };
  }
  if (chain.committee.length !== intended.committee.length) {
    return {
      ...base, verdict: 'disagree',
      why: `the chain carries ${chain.committee.length} key(s) and the intended end state has ` +
        `${intended.committee.length}.`,
    };
  }
  const inOrder = chain.committee.every((k, i) => sameAuthorityKey(k, intended.committee[i]!));
  if (inOrder) {
    return {
      ...base, verdict: 'agree',
      why: 'the chain carries the intended authority: same keys, same order, same threshold. ' +
        `Its replay counter is ${chain.counter}, which is not part of this comparison.`,
    };
  }
  if (authorityMultiset(chain.committee) === authorityMultiset(intended.committee)) {
    return {
      ...base, verdict: 'disagree',
      why: 'SAME MEMBERS, DIFFERENT ORDER. The same people can sign either way, so nothing is ' +
        'newly at risk — but the on-chain VALUE differs, and a wholesale replace is a ' +
        'whole-value test. Reordering the intended list to match the chain settles it without a ' +
        'transaction; installing it costs a real update that changes who can sign by nothing.',
    };
  }
  return {
    ...base, verdict: 'disagree',
    why: 'the chain carries a DIFFERENT SET OF KEYS from the intended end state at the same ' +
      'threshold. On a maintenance authority this is the whole of `C353`: whoever these keys ' +
      'belong to can replace the rules this contract obeys.',
  };
}

/* ================================================================== *
 * BUILDING A MAINTENANCE INSTRUCTION BY HAND — `C351`'s BUILD LIMB,
 * `C354`'s SECOND LIMB. Board row `2y9-2`.
 * ================================================================== */

/**
 * THE MACHINERY THAT BUILDS A MAINTENANCE UPDATE, BECAUSE THE FOUNDER'S RULING
 * SWITCHES THE SDK's OFF. `C351` build limb, `C354` second limb.
 *
 * The founder ruled on 5 Sep that the COMPANY's OWN SIGNERS hold the maintenance
 * authority, for the account and for the vaults, and that we hold nothing. That
 * is the same rule as everything else here — we never custody funds and never
 * hold the wallet key — applied to the key that can replace a contract's
 * verifier keys, which `C353` establishes is a drain key on every vault's
 * unshielded money.
 *
 * **THE COST IS PERMANENT AND WAS ACCEPTED KNOWINGLY: a committee authority
 * switches Midnight's SDK maintenance interface OFF for that contract, for
 * ever.** Under a committee no signing key is stored
 * (`partial-contract.ts:358-360`) and every SDK maintenance entry point opens by
 * asserting exactly that slot (`midnight-js-contracts/dist/index.mjs:398-399`,
 * `:470-471`, `:547-548`). And it would not help if it were there:
 * `createSignedMaintenanceUpdate` always signs at `DEFAULT_SIGNATURE_INDEX = 0`
 * (`ContractExecutable.js:269`, `:31`), a 1-of-N vote the chain refuses at any
 * threshold above one. **So every maintenance instruction this product will ever
 * issue is built here, from `ledger-v9`'s own primitives.**
 *
 * **IT BUILDS. IT DOES NOT SUBMIT.** Nothing in this block sends a transaction,
 * pays a fee, or contacts a chain. Constructing, checking and assembling
 * signatures is a session's work; submitting is a person's act behind a door
 * (rules 1, 42a-i).
 *
 * **AND IT NEVER TOUCHES A SIGNING KEY. NOT AS A PARAMETER, NOT AS A FIXTURE,
 * NOT AS A LITERAL.** `C400` is the reason the sentence is this blunt: on 5 Sep
 * a round put the live maintenance-authority signing key — the key `C353` is
 * about — into a TRACKED source file in a repository that is going public, and
 * its own auditor caught it. **The API below accepts SIGNATURES, which are
 * public the moment they reach a chain, and VERIFYING keys, which are already on
 * one. There is no parameter anywhere in this block that a signing key fits.**
 * Signing happens outside this repository, on the machine that holds the key.
 *
 * ── WHY IT IS APPENDED HERE AND NOT IN A FILE OF ITS OWN ─────────────────────
 *
 * **THE REASON HAS LAPSED AND IS RECORDED RATHER THAN QUIETLY DROPPED.** Every
 * `.ts`/`.tsx`/`.mjs` under `src`, `scripts` and `contracts/test` was once
 * counted into a derived record of this repository's own size, and that record
 * also cited lines in this file, so ONE new file in those trees, or one line
 * inserted above a cited line, made a written-down number wrong. **That record
 * is no longer kept and nothing checks those citations**, so this block sits at
 * the END of the file that already holds the read-back and the comparator for
 * no reason stronger than that it was put there, and it may be moved.
 *
 * ── THE FOUR THINGS `S61` SETTLED BY MEASUREMENT, USED AND NOT RE-LITIGATED ──
 *
 *   1. The read-back is a LEDGER PROPERTY and not an SDK call, so building
 *      without the SDK costs nothing in the ability to verify the work.
 *   2. `compareAuthority` above IS the *did my change land* test — whole-value,
 *      end-state, counter excluded. It is reused; no second comparator is
 *      written.
 *   3. **`unknown` REFUSES.** A plan that treated *the chain could not be asked*
 *      as *disagree* would re-sign against a chain it never read, which is the
 *      whole of `C354`.
 *   4. `T-356`, `T-357`, `T-359` and `T-361` are this block's, and each is
 *      answered below at the place it belongs.
 *
 * ── WHAT WAS MEASURED HERE, AGAINST THE BUILD THE NODE PINS ──────────────────
 *
 * Every claim in this block was taken off `@midnightntwrk/ledger-v9@1.0.0-rc.3` by
 * constructing the object, deploying it into a `LedgerState` and calling
 * `Transaction.wellFormed` (`ledger-v9.d.ts:2508`) with proofs disabled and
 * signature verification ON. **NO PROVING, NO DEPLOY, NO SUBMISSION, NO KEY
 * GENERATED, NO CHAIN CONTACT.** That is `T-360`'s door, and
 * `MAINTENANCE-INSTRUCTION-CHECK.command` is where a person runs it.
 *
 * **AND THE VERSION CLAIM IS STATED AS NARROWLY AS THE EVIDENCE ALLOWS, BECAUSE THIS
 * PROJECT HAS BEEN CORRECTED TWICE FOR THE OPPOSITE.** The node's
 * `midnight-src/midnight-node/Cargo.toml:108` asks for `=1.0.0`, which a pre-release does
 * NOT satisfy; what actually pins the build is the `[patch.crates-io]` entry at `:464`,
 * `tag = "crate-ledger-9.1.0.0-rc.3"`. **So this package carries THE SAME VERSION STRING
 * as the tag the node patches in.** The npm package ships no source and the `.wasm` carries
 * no version string, so *built from that tag* is NOT established — it is the best evidence
 * available and it is not a measurement. `docs/corrections.md`, 1 Sep, twice, for exactly
 * this shape.
 *
 * **AND WHERE THIS BLOCK CITES RUST IT IS CITING LEDGER `8.2.0-rc.1`** — the vendored
 * `midnight-src/midnight-ledger/` tree (`Cargo.toml:4`), which is NOT what the chain runs.
 * Every such citation was checked against the ledger-9 measurement standing beside it and
 * they agree.
 *
 * **THE MEASUREMENTS THAT CHANGED THE DESIGN, RATHER THAN CONFIRMING IT:**
 *
 *   - **`T-357` IS NO LONGER A READING. IT IS MEASURED, ON LEDGER 9.** A
 *     committee of `[K, K, K]` at threshold 3, satisfied by the single holder of
 *     `K` signing ONCE and attaching that one signature at indices 0, 1 and 2,
 *     is **WELL-FORMED**. `T-360` variant (b), answered.
 *   - **`T-356` IS MEASURED TOO.** A contract whose authority is at threshold 0
 *     accepts a maintenance update carrying NO SIGNATURES AT ALL: **WELL-FORMED**.
 *     `T-360` variant (c), answered.
 *   - **AND VARIANT (a) GOES THE OTHER WAY, WHICH IS THE ONE WORTH KNOWING:** the
 *     same signature index twice is refused — *"transaction is not in normal
 *     form"* — so the ascending-index guard DOES reach ledger 9. The bypass lives
 *     in the committee list and not in the signature list, exactly as `T-357`
 *     says and not as the claim `S61` withdrew said.
 *   - **THE NEW AUTHORITY'S OWN COUNTER MUST BE `updateCounter + 1`, AND IT IS
 *     NOT THE CALLER'S TO CHOOSE.** Measured: any other value is refused as *"not
 *     in normal form"*, including `0`. So `buildMaintenanceInstruction` derives
 *     it and takes no parameter for it.
 *   - **`wellFormed` DOES NOT CHECK THE UPDATE's COUNTER AGAINST THE CHAIN.**
 *     Measured: an update built against counter 1 for a contract sitting at
 *     counter 0 is WELL-FORMED, and fails at APPLY with *"the signed counter …
 *     did not match the expected one"* as a `partialSuccess` — on chain, with the
 *     fee spent (`semantics.rs:1481`, and `2.2`'s note that maintenance is
 *     fallible-segment only). **Rule 14: no screen and no door may read a
 *     well-formed verdict as *this will land*.**
 *   - **AND A NEGATIVE THRESHOLD IS NOT REFUSED — IT WRAPS.** Measured: passing `-1` to
 *     `ContractMaintenanceAuthority` installs a threshold of `4294967295`, silently, and it
 *     applies; `-2` gives `4294967294`, and `1.7` truncates to `1`. Nothing throws. The
 *     product is held off it only by `authorityValueRefusals` refusing a NON-INTEGER as
 *     well as a value below one, which is why that check tests both and not just the sign.
 *   - **A THRESHOLD ABOVE THE COMMITTEE SIZE INSTALLS.** Measured: replacing a
 *     1-of-1 with a 2-of-1 is WELL-FORMED and applies. The ledger validates
 *     nothing about a new authority except its counter
 *     (`verify.rs:1749-1798`; apply is `cstate.maintenance_authority = auth`,
 *     `semantics.rs:1488-1490`). **Every refusal below is ours or it is nobody's
 *     — rule 27, and this block is the code that makes it not-nobody's.**
 *
 * The refusals of the authority VALUE itself - the threshold, the committee,
 * repeated and malformed members - live in `authority-replacement.ts`, beside
 * the one function that builds a replacement, so that code a browser runs can
 * reach them without this module. What stays here refuses the verifier keys.
 */

/**
 * WHAT MUST BE REFUSED ABOUT A VERIFIER KEY THIS UPDATE WRITES — `T-359`, from the
 * other side.
 *
 * **THIS EXISTS BECAUSE THE FIRST DRAFT OF THIS BLOCK REFUSED FIVE THINGS ABOUT THE
 * AUTHORITY AND NOTHING AT ALL ABOUT THE VERIFIER KEYS, AND ITS OWN
 * money-safety pass SAID SO FIRST AND LOUDEST.** A `ReplaceAuthority` decides
 * WHO may change a contract; a `VerifierKeyInsert` is the change that actually moves
 * the money — `C353`'s drain is a verifier-key swap performed USING the authority.
 * Building the second with no check at all, in the same function that refuses five
 * things about the first, is the wrong way round.
 *
 * **WHAT IS REFUSED HERE AND WHAT IS NOT, STATED SO THE GAP IS NOT MISTAKEN FOR
 * COVER.** This refuses what can be judged from the write alone: an unnamed entry
 * point, empty bytes, and a version the runtime does not have. **It does NOT check
 * that the bytes are the artefact on disk**, because the artefact set belongs to the
 * caller and this module must stay loadable without a filesystem. That check is
 * `compareVerifierKeys`, against the chain, after the fact — and the round that
 * wires a caller owes it before submission rather than after.
 *
 * **THE VERSION IS NOT COSMETIC AND IT IS NOT FREE-FORM.** Measured: the runtime's
 * `ContractOperationVersionedVerifierKey` performs a VERSION-KEYED HEADER PARSE —
 * `'v3'` requires a `midnight:verifier-key[v6]:` header and `'v4'` requires `[v7]` —
 * and throws on a mismatch, on an unknown version, and on bytes whose header has
 * already been stripped. It cannot silently produce the wrong key, which is the one
 * reassuring thing in this area.
 */
export function verifierKeyRefusals(
  writes: readonly VerifierKeyWrite[],
): MaintenanceRefusal[] {
  const out: MaintenanceRefusal[] = [];
  for (const [i, w] of writes.entries()) {
    if (typeof w?.operation !== 'string' || w.operation.trim() === '') {
      out.push({
        code: 'unnamed-verifier-key-operation',
        why: `verifier-key write [${i}] names no entry point. A key written at an entry point ` +
          'nobody named is a key nothing can read back or compare, which is the state `T-359` ' +
          'exists about.',
      });
    }
    if (!(w?.verifierKey instanceof Uint8Array) || w.verifierKey.length === 0) {
      out.push({
        code: 'empty-verifier-key',
        why: `verifier-key write [${i}] ("${String(w?.operation)}") carries no key bytes. This ` +
          'must be the `.verifier` artefact EXACTLY as it sits on disk, header and all — ' +
          'measured: that is what the chain hands back, not the header-stripped form the ' +
          'runtime constructor is handed.',
      });
    }
    if (w?.version !== 'v3' && w?.version !== 'v4') {
      out.push({
        code: 'unknown-verifier-key-version',
        why: `verifier-key write [${i}] ("${String(w?.operation)}") names version ` +
          `"${String(w?.version)}", and the runtime has exactly two: "v3" and "v4". They are ` +
          'not labels — each one requires its own header tag on the bytes and the constructor ' +
          'throws on a mismatch.',
      });
    }
  }
  return out;
}

/**
 * WHAT TO DO ABOUT ONE CONTRACT, DECIDED BEFORE ANYTHING IS BUILT.
 *
 * Three actions and not two, for the reason `compareAuthority` has three
 * verdicts. **`refuse` is the load-bearing one**: a plan that turned *the chain
 * could not be asked* into *build it again* would re-sign against a chain it
 * never read and spend a real update on a contract that may already be correct.
 */
export type MaintenancePlan =
  | { action: 'settled'; address: string; why: string; comparison: AuthorityComparison }
  | {
      action: 'build'; address: string; why: string; comparison: AuthorityComparison;
      /** The counter the update is valid against: the one just read off the chain. */
      updateCounter: bigint;
      /** What the contract's counter will be once this update applies. */
      expectedCounter: bigint;
      intended: { committee: AuthorityKey[]; threshold: number };
    }
  | { action: 'refuse'; address: string; why: string; refusals: MaintenanceRefusal[]; comparison?: AuthorityComparison };

/**
 * PLAN ONE CONTRACT'S AUTHORITY CHANGE. `C354`'s second limb, stated as code.
 *
 * **THE NO-OP IS NOT A RETRY AND THAT IS THE POINT OF THE ROW.** Resubmitting a
 * byte-identical signed update after it landed hits `ReplayCounterMismatch`
 * (`semantics.rs:1481-1485`), and that error carries only the address (`:1482`) —
 * it cannot say whose update landed. So *did my change land* is asked of the LIVE
 * AUTHORITY against the INTENDED END STATE, whole-value, before anything is
 * built. Equal: do nothing, and doing nothing is the correct outcome rather than
 * a missed opportunity. Not equal: build against the counter JUST READ, because
 * the counter is inside the signed data and every older signature is dead.
 * Unreadable: refuse.
 *
 * **THE COUNTER COMES FROM THE CHAIN READ AND FROM NOWHERE ELSE — AND THE FRESHNESS
 * OF THAT READ IS THE CALLER'S, WHICH THIS CANNOT CHECK.** An earlier draft of this
 * paragraph said the counter is *read here*, and it is not: this takes an
 * `AuthorityRead` a caller supplies, and `AuthorityRead` carries no timestamp and no
 * block height, so a CACHED read passes a stale counter straight through. Found by
 * this round's own money-safety pass against this round's own sentence.
 * **What is true is the narrower thing: no counter enters from any source OTHER than
 * that read, and none is a parameter of anything below.** A stale one is still a fee
 * spent on a recorded on-chain failure — maintenance applies in the fallible segment
 * only, so a refusal lands as `partialSuccess` with the fee already taken. Making a
 * read carry its own age is raised rather than built here.
 */
export function planAuthorityReplacement(
  read: AuthorityRead,
  intended: { committee: readonly AuthorityKey[]; threshold: number },
  opts: { emptyCommitteeIsDeliberate: boolean },
): MaintenancePlan {
  const refusals = authorityValueRefusals(intended.committee, intended.threshold, opts);
  if (refusals.length > 0) {
    return {
      action: 'refuse', address: read.address, refusals,
      why: 'the intended end state is not a value this product will install: ' +
        refusals.map((r) => r.code).join(', ') + '. Nothing was built and no chain was consulted ' +
        'for a verdict on it.',
    };
  }

  const pair = {
    committee: intended.committee.map((k) => ({ tag: k.tag, value: k.value })),
    threshold: intended.threshold,
  };
  const comparison = compareAuthority(read, pair);

  /* `unknown` REFUSES. `S61` §7(3), and `S55` shipped a `P1` collapsing exactly
   * this three into two. *The ledger cannot answer* is NOT *the answer is no*. */
  if (comparison.verdict === 'unknown') {
    return {
      action: 'refuse', address: read.address, comparison, refusals: [],
      why: `NOTHING MAY BE BUILT FOR THIS CONTRACT: ${comparison.why} Building anyway would ` +
        'mean signing a counter nobody read, against a contract that may already carry the ' +
        'intended authority. Ask again when the chain answers.',
    };
  }

  if (comparison.verdict === 'agree') {
    return {
      action: 'settled', address: read.address, comparison,
      why: 'the chain already carries the intended end state, so there is nothing to build and ' +
        'nothing to sign. Re-running this change is a NO-OP here rather than a refusal on ' +
        'chain, which is `C354`\'s second limb.',
    };
  }

  const chain = read.state === 'read' ? read.authority : undefined;
  /* Unreachable in practice: `compareAuthority` returns `unknown` for every
   * non-`read` state and that branch returned above. Stated rather than
   * asserted, because a later edit to either function should fail HERE. */
  if (!chain) {
    return {
      action: 'refuse', address: read.address, comparison, refusals: [],
      why: 'the comparison disagreed without a chain value to disagree with, which is a defect ' +
        'in this module rather than a fact about the contract. Nothing was built.',
    };
  }

  return {
    action: 'build', address: read.address, comparison, intended: pair,
    updateCounter: chain.counter,
    expectedCounter: chain.counter + 1n,
    why: `${comparison.why} The update will be built against counter ${chain.counter}, which is ` +
      `the value just read, and the contract's counter becomes ${chain.counter + 1n} if it lands.`,
  };
}

/**
 * THE DURABLE PER-CONTRACT END-STATE RECORD — `T-361`, and `2.3`'s *what must be
 * durable, and when*.
 *
 * A maintenance change has NO on-chain handle: it is not a circuit call, it
 * leaves no proposal, and the job runner's three recovery branches all miss it
 * (`src/midnight/job-runner.ts:247-299`). So the intended end state and the target
 * address must be written somewhere a second device reads BEFORE anything is
 * submitted, or a device that did not build the change has nothing to compare
 * against.
 *
 * **AND IT CARRIES AN EXPECTED COUNTER, WHICH IS THE PART `T-361` IS ABOUT.**
 * `compareAuthority` deliberately excludes the counter, and that exclusion is
 * correct — `ReplaceAuthority` replaces wholesale, so the VALUE is the
 * settlement, and comparing counters would make every settled contract look
 * unsettled for ever. **But the counter can never be rolled back or reset**
 * (`semantics.rs:1481`, `:1484-1485`; `verify.rs:1771`), which makes it the one
 * monotonic witness the chain offers. Without an expected value, `agree` cannot
 * tell *we installed this* from *somebody replaced it, did something else in the
 * same update, and put an identical authority back* — and one `MaintenanceUpdate`
 * carries `ReplaceAuthority` AND `VerifierKeyInsert` in one `updates` array,
 * which is precisely how `T-359`'s verifier-key swap would be packaged.
 *
 * **NOTHING SECRET GOES IN IT.** Verifying keys are on a public chain; the
 * address is public; the counter is public. There is no field here a signing key
 * fits, and that is deliberate (`C400`, `C232`: a record is a plaintext home for
 * whatever is put in it).
 */
export interface MaintenanceEndStateRecord {
  /** The contract this record is about. One record per contract, never per logical change. */
  address: string;
  /** An operator-facing name, for a screen. Never used in a comparison. */
  label: string;
  committee: AuthorityKey[];
  threshold: number;
  /** The counter the update was signed against — the value read off the chain when it was built. */
  builtAgainstCounter: bigint;
  /** `builtAgainstCounter + 1`. What the contract's counter becomes if this update lands. */
  expectedCounter: bigint;
  /**
   * Entry points whose verifier key this update also writes — **by name AND by the
   * first eight bytes of the key, because the name alone is what a swap leaves
   * unchanged.** `T-359`, and this round's own money-safety pass found the first
   * draft storing the name and discarding the bytes: a record that says *we wrote
   * `recordPayment`* cannot afterwards say WHICH key was written, so `checkEndState`
   * could report `settled` for an update that also rewrote the thing `C353` is
   * about. **Eight bytes is an identifier for a person and not a proof** — the proof
   * is `compareVerifierKeys` over full bytes against the chain.
   */
  verifierKeyInserts: { operation: string; version: string; fingerprint: string }[];
  /** When it was built, for a person reading a stalled change. Never compared. */
  builtAt: string;
}

/**
 * WHAT THE CHAIN SAYS ABOUT A RECORD WE WROTE. Four answers, and the fourth is
 * the one `T-361` buys.
 *
 *   `settled`     — the value matches AND the counter is exactly what we expected.
 *   `not-yet`     — the value does not match; the change has not landed.
 *   `unexplained` — the value matches and the counter does NOT. Something else
 *                   moved this contract. It is not a failure and it is not a
 *                   success, and it must not be printed as either.
 *   `unknown`     — the chain could not be asked.
 */
export type EndStateVerdict = 'settled' | 'not-yet' | 'unexplained' | 'unknown';

export interface EndStateCheck {
  verdict: EndStateVerdict;
  address: string;
  why: string;
  comparison: AuthorityComparison;
}

/**
 * DID THE CHANGE WE RECORDED ACTUALLY LAND, AND DID ANYTHING ELSE HAPPEN HERE?
 *
 * The value half is `compareAuthority` — reused, not rewritten.
 * The counter half is this function's own, and it never turns a `disagree` into
 * an `agree` or the reverse: it only splits `agree` into *settled* and
 * *unexplained*.
 */
export function checkEndState(
  record: MaintenanceEndStateRecord,
  read: AuthorityRead,
): EndStateCheck {
  const comparison = compareAuthority(read, {
    committee: record.committee, threshold: record.threshold,
  });
  if (comparison.verdict === 'unknown') {
    return { verdict: 'unknown', address: record.address, comparison, why: comparison.why };
  }
  if (comparison.verdict === 'disagree') {
    return {
      verdict: 'not-yet', address: record.address, comparison,
      why: `the change recorded for this contract has NOT landed: ${comparison.why}`,
    };
  }
  const actual = read.state === 'read' ? read.authority.counter : undefined;
  if (actual === record.expectedCounter) {
    return {
      verdict: 'settled', address: record.address, comparison,
      why: `the chain carries the recorded end state and its counter is ${actual}, exactly the ` +
        'value this change was expected to leave. Nothing else has been applied here since.',
    };
  }
  return {
    verdict: 'unexplained', address: record.address, comparison,
    why: `THE VALUE MATCHES AND THE COUNTER DOES NOT. Expected ${record.expectedCounter}, the ` +
      `chain carries ${actual}. The counter can never be rolled back or reset, so this contract ` +
      'has taken a maintenance update this record does not account for. One update carries a ' +
      'ReplaceAuthority AND a VerifierKeyInsert in the same array, so an identical authority ' +
      'put back is exactly what a verifier-key swap looks like from here. This is neither a ' +
      'pass nor a failure: somebody reads the verifier keys (`T-359`) before anything else.',
  };
}

/**
 * A signature over a maintenance update, in the shape the runtime uses
 * (`ledger-v9.d.ts:154`). **It is the same `{tag, value}` shape as a key and it
 * is NOT a key**: a signature is public the moment the update reaches a chain,
 * which is why this API accepts one and accepts no signing key anywhere.
 */
export type MaintenanceSignature = AuthorityKey;

/**
 * The `ledger-v9` pieces this builder needs, PASSED IN rather than imported.
 *
 * The same reason `intendedAuthorityValue` takes `deriveVerifyingKey`: this
 * module must stay loadable without ten megabytes of WebAssembly, because the web
 * bundle imports it and `C-` rows already exist about dragging `ledger-v9` into
 * the page. **A named interface rather than `any`, so a change in the runtime is
 * a compile error HERE** — `tsconfig.scripts.json` has `strict: false` and would
 * let an `any` flow through a mismatch unnoticed.
 *
 * Line references are `node_modules/@midnightntwrk/ledger-v9/ledger-v9.d.ts`,
 * read this round: `:779`, `:2251`, `:2276`, `:2238`, `:2312`, `:457`.
 */
export interface MaintenanceUpdateLike {
  readonly dataToSign: Uint8Array;
  readonly counter: bigint;
  readonly signatures: [bigint, MaintenanceSignature][];
  addSignature(idx: bigint, signature: MaintenanceSignature): MaintenanceUpdateLike;
}

export interface MaintenancePrimitives {
  ContractMaintenanceAuthority: new (
    committee: AuthorityKey[], threshold: number, counter?: bigint,
  ) => object;
  ReplaceAuthority: new (authority: object) => object;
  VerifierKeyInsert: new (operation: string, vk: object) => object;
  ContractOperationVersionedVerifierKey: new (
    version: 'v3' | 'v4', rawVk: Uint8Array,
  ) => object;
  MaintenanceUpdate: new (address: string, updates: object[], counter: bigint) => MaintenanceUpdateLike;
  verifySignature: (
    vk: AuthorityKey, data: Uint8Array, signature: MaintenanceSignature,
  ) => boolean;
}

/** One entry point whose verifier key this update writes. `T-359`'s other half. */
export interface VerifierKeyWrite {
  /** The entry-point name exactly as the contract carries it. */
  operation: string;
  /**
   * The operation version, which the runtime has exactly two of
   * (`ledger-v9.d.ts:2239`). **Narrowed from `string` after this round's own
   * money-safety pass pointed out that widening a two-member union is the
   * opposite of what a named interface is for.**
   */
  version: 'v3' | 'v4';
  /**
   * The verifier key EXACTLY AS THE BUILT ARTEFACT HOLDS IT, header included.
   *
   * **MEASURED, AND IT IS THE TRAP IN THIS WHOLE AREA:**
   * `ContractOperationVersionedVerifierKey` STRIPS the 26-byte
   * `midnight:verifier-key[v6]:` header — a 2,119-byte `.verifier` file becomes a
   * 2,093-byte `rawVk` — **and yet what ends up on chain, readable at
   * `ContractOperation.verifierKey` (`ledger-v9.d.ts:752`), is byte-identical to
   * the FILE, header and all.** Deployed one and read it back to check. So the
   * constructor takes the file bytes and `compareVerifierKeys` compares against
   * the file bytes; **a comparison written against `rawVk` reports a MISMATCH on
   * a perfectly correct contract**, and it is the obvious thing to write.
   */
  verifierKey: Uint8Array;
}

/** A built, unsigned-or-partly-signed maintenance instruction, with everything a signer needs. */
export interface BuiltMaintenanceInstruction {
  address: string;
  /** The runtime object. Free-standing and portable: build here, sign on M other machines, submit from a third. */
  update: MaintenanceUpdateLike;
  /** Exactly what each signer signs. Bound to (address, updates, counter) and to nothing else. */
  dataToSign: Uint8Array;
  /** The committee that must sign THIS update: the one on chain NOW, not the one being installed. */
  signWith: AuthorityKey[];
  /** How many of `signWith` must sign. The chain's CURRENT threshold. */
  signaturesRequired: number;
  /**
   * **WHAT THE CONTRACT'S AUTHORITY LOOKS LIKE RIGHT NOW, CARRIED SO A PERSON SEES
   * IT BEFORE SIGNING.** `S61` built `shape` and `hasDuplicateMembers` for exactly
   * this and the first draft of this function read the committee and the threshold
   * and threw both away — found by this round's own money-safety pass, which
   * also named the silent case: **a contract already at threshold ZERO gives
   * `signaturesRequired: 0`, so `signatureProgress` reports `complete` on NO
   * signatures at all, with nothing anywhere saying why.** Repairing such a contract
   * is exactly the right thing to do; doing it without being told what you are
   * repairing is not.
   */
  currentShape: AuthorityShape;
  /** Whether the committee that must sign THIS update lists one key more than once. */
  currentHasDuplicateMembers: boolean;
  /**
   * True when the contract's current authority means this update needs NO signatures
   * — the `anyone` state. **Not a refusal: refusing would strand a contract that can
   * only be repaired this way.** It is a warning, and a door that does not print it
   * is a door that shows a normal-looking instruction for a contract anybody in the
   * world could already have rewritten.
   */
  needsNoSignatures: boolean;
  /** What this update leaves behind, ready to be written down before anything is submitted. */
  endState: MaintenanceEndStateRecord;
}

/**
 * BUILD ONE CONTRACT'S MAINTENANCE UPDATE. **It builds. It does not submit.**
 *
 * **THE COMMITTEE THAT SIGNS IS THE ONE ON CHAIN NOW, NOT THE ONE BEING
 * INSTALLED**, and this is the mistake worth naming because it reads backwards.
 * A 2-of-3 being replaced by a 5-of-7 is signed by two of the OLD three: the
 * ledger verifies each signature against the CURRENT committee (`verify.rs:1782`)
 * and counts against the CURRENT threshold (`:1789`). `signWith` and
 * `signaturesRequired` are therefore taken off the chain read and never off the
 * intended value.
 *
 * **THE NEW AUTHORITY'S OWN COUNTER IS DERIVED AND IS NOT A PARAMETER.** MEASURED
 * on ledger 9: a `ReplaceAuthority` payload whose authority does not carry
 * exactly `updateCounter + 1` is refused as *"transaction is not in normal
 * form"* — including the obvious `0`. There is no reason to let a caller supply
 * a value that has exactly one correct answer.
 *
 * **THE REFUSALS RUN HERE TOO, ON EVERY BUILD — AND THEY NOW COVER BOTH KINDS OF
 * INSTRUCTION AND NOT ONLY THE AUTHORITY.** `planAuthorityReplacement` already ran
 * the authority half, and the recovery path rebuilds against a freshly read counter
 * without necessarily re-planning. `2.6`: a check that ran once when a person
 * pressed something is a check the recovery path walks around. **The verifier-key
 * half exists because the first draft of this function had none at all — five
 * refusals about who may change the contract and nothing whatever about the change
 * that moves the money. Its own money-safety pass said so first and loudest.**
 *
 * **AND THE CURRENT AUTHORITY IS DERIVED FROM THE PLAN RATHER THAN PASSED
 * ALONGSIDE IT.** The first draft took it as a second parameter, so a caller could
 * hand a plan for one contract and an authority from another and nothing would
 * notice — and a `signaturesRequired` lower than the chain's real bar makes
 * `signatureProgress` report `complete` below it, which is a fee spent on a recorded
 * on-chain failure. Every `build` plan already carries `comparison.onChain`, so
 * there was never a second value to disagree with.
 *
 * **NO SIGNING KEY IS A PARAMETER OF THIS FUNCTION OR OF ANYTHING IT CALLS.** It
 * returns the bytes to be signed; signing happens on the machine that holds the
 * key, which is not this one.
 */
export function buildMaintenanceInstruction(
  P: MaintenancePrimitives,
  plan: Extract<MaintenancePlan, { action: 'build' }>,
  opts: {
    label: string;
    emptyCommitteeIsDeliberate: boolean;
    verifierKeys?: readonly VerifierKeyWrite[];
    now?: () => Date;
  },
): BuiltMaintenanceInstruction {
  const chainNow = plan.comparison.onChain;
  if (!chainNow) {
    throw new Error(
      'this plan carries no on-chain authority, so there is nothing to say who must sign the ' +
        'update it describes. A `build` plan always carries one; a plan that does not is a ' +
        'defect in this module rather than a fact about the contract, and building anyway ' +
        'would produce an instruction nobody can be told how to sign.',
    );
  }

  const { committee, threshold } = requireBuildableAuthority(
    plan.intended.committee, plan.intended.threshold,
    { emptyCommitteeIsDeliberate: opts.emptyCommitteeIsDeliberate },
  );
  const keyRefusals = verifierKeyRefusals(opts.verifierKeys ?? []);
  if (keyRefusals.length > 0) {
    throw new Error(
      'these verifier-key writes will not be built:\n' +
        keyRefusals.map((r) => `  - [${r.code}] ${r.why}`).join('\n'),
    );
  }

  const updates: object[] = [
    replaceAuthorityOf(P as unknown as AuthorityReplacementPrimitives, {
      committee, threshold, updateCounter: plan.updateCounter,
      emptyCommitteeIsDeliberate: opts.emptyCommitteeIsDeliberate,
    }),
  ];
  for (const vk of opts.verifierKeys ?? []) {
    updates.push(new P.VerifierKeyInsert(
      vk.operation,
      new P.ContractOperationVersionedVerifierKey(vk.version, vk.verifierKey),
    ));
  }

  const update = new P.MaintenanceUpdate(plan.address, updates, plan.updateCounter);

  return {
    address: plan.address,
    update,
    dataToSign: update.dataToSign,
    signWith: chainNow.committee.map((k) => ({ tag: k.tag, value: k.value })),
    signaturesRequired: chainNow.threshold,
    currentShape: chainNow.shape,
    currentHasDuplicateMembers: chainNow.hasDuplicateMembers,
    needsNoSignatures: chainNow.threshold < 1,
    endState: {
      address: plan.address,
      label: opts.label,
      committee,
      threshold,
      builtAgainstCounter: plan.updateCounter,
      expectedCounter: plan.expectedCounter,
      verifierKeyInserts: (opts.verifierKeys ?? []).map((v) => ({
        operation: v.operation, version: v.version, fingerprint: toHex(v.verifierKey.slice(0, 8)),
      })),
      builtAt: (opts.now ?? (() => new Date()))().toISOString(),
    },
  };
}

/**
 * ATTACH ONE SIGNATURE, HAVING CHECKED IT AGAINST THE SEAT IT CLAIMS.
 *
 * Three refusals, each of which the chain would also make — **and making them
 * here is the difference between a person being told and a fee being spent on a
 * recorded on-chain failure.** Maintenance applies in the fallible segment only,
 * so a refused update lands as `partialSuccess` with the fee already taken.
 *
 *   - **an index outside the current committee.** MEASURED: *"declared signture
 *     for key id 5 does not correspond to a committee member"* (the runtime's own
 *     spelling).
 *   - **an index already signed.** MEASURED: *"transaction is not in normal
 *     form"* — the ascending-index guard, which DOES reach ledger 9. This is the
 *     one place `T-357`'s bypass does not work, and it is why that row is about
 *     the committee list and not the signature list.
 *   - **a signature that does not verify against that seat's key.** MEASURED:
 *     *"signature for key id 0 invalid"*.
 *
 * **A REPEATED KEY IN THE CURRENT COMMITTEE IS NOT REFUSED HERE, DELIBERATELY,
 * AND THE REASON MATTERS.** If the chain already carries `[K, K, K]` then signing
 * it at three seats is the only way to satisfy it, and refusing would leave a
 * contract nobody can fix. **The refusal belongs where such a committee is
 * BUILT** — `authorityValueRefusals` — **and the state is REPORTED instead, on
 * `BuiltMaintenanceInstruction.currentHasDuplicateMembers`, so a person sees it
 * before signing rather than being quietly allowed past it.** An earlier version of
 * this paragraph promised that reporting and nothing carried it; found by this
 * round's own money-safety pass, which is the second time in two rounds that a
 * sentence here was ahead of the code beneath it.
 */
export function attachMaintenanceSignature(
  P: MaintenancePrimitives,
  built: BuiltMaintenanceInstruction,
  index: number,
  signature: MaintenanceSignature,
): BuiltMaintenanceInstruction {
  if (!Number.isInteger(index) || index < 0 || index >= built.signWith.length) {
    throw new Error(
      `seat ${index} is not a seat on the committee that currently maintains ${built.address}: ` +
        `it holds ${built.signWith.length} seat(s), numbered 0 to ${built.signWith.length - 1}. ` +
        'The signatures on a maintenance update are checked against the CURRENT committee, not ' +
        'the one being installed.',
    );
  }
  if (built.update.signatures.some(([i]) => i === BigInt(index))) {
    throw new Error(
      `seat ${index} has already signed this update. A second signature at the same index is ` +
        'refused by the chain as a malformed transaction, and attaching it here would waste a ' +
        'submission rather than add a vote.',
    );
  }
  const seat = built.signWith[index]!;
  if (!P.verifySignature(seat, built.dataToSign, signature)) {
    throw new Error(
      `this signature does not verify against the key in seat ${index} of ${built.address}'s ` +
        'current committee. Either it was made by a different key, or it was made over ' +
        'different data — a signature is bound to (contract address, exact update list, ' +
        'counter), so one collected for another contract, or before the counter moved, is dead.',
    );
  }
  return { ...built, update: built.update.addSignature(BigInt(index), signature) };
}

/** How far along the signing is, without asking anything of a chain. */
export function signatureProgress(
  built: BuiltMaintenanceInstruction,
): { have: number; required: number; complete: boolean; seatsSigned: number[] } {
  const seatsSigned = built.update.signatures.map(([i]) => Number(i)).sort((a, b) => a - b);
  return {
    have: seatsSigned.length,
    required: built.signaturesRequired,
    complete: seatsSigned.length >= built.signaturesRequired,
    seatsSigned,
  };
}

/* ── `T-359` — READING THE VERIFIER KEYS BACK, WHICH IS THE THING `C353`
 *              ACTUALLY SWAPS ────────────────────────────────────────────── */

/**
 * WHAT THE AUTHORITY READ-BACK CANNOT SEE, AND IT IS THE ACT THAT MOVES THE
 * MONEY. `T-359` `P1`.
 *
 * `readContractAuthority` answers WHO MAY CHANGE a contract.
 * **`C353`'s drain is not an authority change — it is a VERIFIER KEY SWAP
 * performed USING the authority.** A contract whose `recordPayment` verifier key
 * has been replaced answers `MAINTENANCE-AUTHORITY-CHECK` with AGREE, and that
 * door prints *"Every contract carries the authority recorded for it."* The
 * sentence is true and reads as more than it says.
 *
 * **THE EVIDENCE COSTS NOTHING, WHICH IS WHY IT IS HERE:** it is on the same
 * `ContractState` object the authority read-back already fetches and discards.
 * `operations()` lists the entry points and `operation(name).verifierKey` is the
 * key itself (`ledger-v9.d.ts:816`, `:822`, `:752`). One query answers both
 * questions.
 *
 * **AND IT SEES ONLY THE LATEST VERSION OF EACH KEY, WHICH IS A LIMIT OF THE
 * RUNTIME AND IS SAID HERE RATHER THAN DISCOVERED.** `ledger-v9.d.ts:742-745`:
 * a `ContractOperation` holds verifier keys *"potentially for different versions of
 * the proving system"* and **"Only the latest available version is exposed to this
 * API."** Versions are the closed pair `'v3' | 'v4'` (`:2239`). So a contract can
 * hold a key at a version this read cannot reach, and nothing here can say whether
 * such a key could verify a call — **the ledger-9 apply path is not vendored, the
 * same limit `docs/scope-the-maintenance-list.md` 2.6 records for `IrRemove` and
 * `IrInsert`.** And the version cannot be stated on any evidence this project
 * holds: the node's `transactionVersion` and this enum's `'v4'` are different
 * numbering schemes that happen to share a digit, so the coincidence licenses
 * nothing. **The
 * `agree` sentence below says what it cannot see rather than claiming more than
 * it looked at.**
 *
 * **AND THE OPERATIONS MAP IS THE WRONG THING TO CHECK, WHICH IS THE HALF THAT
 * MAKES THIS WORTH BUILDING.** `docs/scope-the-upgrade-path.md:216-231`'s
 * SILENTLY WEAKEN is 32 bytes on chain **with the operations map still listing
 * exactly the same names.** `findDeployedPartialContract`, `findDeployedVaultContract`
 * and the SDK's own `verifyContractState` all check that the names are present.
 * **The names being present is what a swap looks like. The keys are the evidence.**
 */
export interface OnChainOperation {
  /** The entry-point name as the chain carries it. */
  name: string;
  /** The verifier key bytes, exactly as the chain holds them. */
  verifierKey: Uint8Array;
}

export type OperationsRead =
  | { state: 'read'; address: string; operations: OnChainOperation[] }
  | { state: 'unreadable'; address: string; why: string };

/**
 * The entry points and their verifier keys off a `ContractState`, or a refusal.
 *
 * Structural rather than typed against the runtime class, for the same reason
 * `authorityFromContractState` is: this is a boundary, and it states what it
 * relies on rather than trusting a type.
 */
export function operationsFromContractState(
  state: unknown, address: string,
): OperationsRead {
  if (!state || typeof state !== 'object') {
    return { state: 'unreadable', address, why: 'contract state was not an object' };
  }
  const s = state as {
    operations?: () => unknown;
    operation?: (name: unknown) => unknown;
  };
  if (typeof s.operations !== 'function' || typeof s.operation !== 'function') {
    return {
      state: 'unreadable', address,
      why: 'contract state does not expose `operations()` and `operation(name)`, so its verifier ' +
        'keys cannot be read. NOTHING may be concluded about them from this.',
    };
  }
  let names: unknown;
  try { names = s.operations(); } catch (e) {
    return {
      state: 'unreadable', address,
      why: `listing this contract's entry points threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!Array.isArray(names)) {
    return { state: 'unreadable', address, why: '`operations()` did not return a list' };
  }
  const operations: OnChainOperation[] = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw : String(raw);
    let op: unknown;
    try { op = s.operation(raw); } catch (e) {
      return {
        state: 'unreadable', address,
        why: `reading entry point "${name}" threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const vk = (op as { verifierKey?: unknown } | undefined)?.verifierKey;
    if (!(vk instanceof Uint8Array)) {
      return {
        state: 'unreadable', address,
        why: `entry point "${name}" carries no readable \`verifierKey\`. A partial answer here is ` +
          'worse than none: it would let a swapped key hide behind an unreadable one.',
      };
    }
    operations.push({ name, verifierKey: vk });
  }
  return { state: 'read', address, operations };
}

export type VerifierKeyVerdict = 'agree' | 'disagree' | 'unknown';

export interface VerifierKeyComparison {
  verdict: VerifierKeyVerdict;
  address: string;
  why: string;
  /** Entry points whose on-chain key is byte-identical to the built artefact. */
  matched: string[];
  /** **Entry points whose on-chain key DIFFERS. This is `C353`'s act, seen.** */
  mismatched: string[];
  /** On chain and not in the artefact: an entry point this build does not know about. */
  onChainOnly: string[];
  /** In the artefact and not on chain: a circuit that was never deployed here. */
  missingOnChain: string[];
  /** First eight bytes of each side, for a person. **Display only — the comparison is over full bytes.** */
  fingerprints: { name: string; onChain: string; expected: string }[];
}

/**
 * DOES EVERY DEPLOYED ENTRY POINT STILL CARRY THE KEY THIS BUILD PRODUCES?
 * `T-359`'s *done when*.
 *
 * **THE COMPARISON IS OVER FULL BYTES AND THE EXPECTED SIDE IS THE `.verifier`
 * FILE EXACTLY AS IT SITS ON DISK, HEADER INCLUDED.** Measured this round by
 * deploying a contract, inserting `contracts/managed/keys/adopt.verifier` through
 * `VerifierKeyInsert` and reading the result back: what the chain returns is
 * byte-identical to the file, all 2,119 bytes of it — **even though the
 * constructor strips the 26-byte `midnight:verifier-key[v6]:` header to a
 * 2,093-byte `rawVk` on the way in.** A comparison written against `rawVk` — the
 * obvious thing to write, since that is what the caller hands the constructor —
 * calls a correct contract WRONG on every entry point.
 *
 * **A MISSING OR EXTRA ENTRY POINT IS NOT A MISMATCH AND IS NOT SILENCE.** It is
 * reported in its own list and it makes the verdict `disagree`, because a build
 * that does not know about an entry point cannot say anything about the key on
 * it, and *cannot say* is not *fine*.
 *
 * **`unknown` REFUSES, EXACTLY AS THE AUTHORITY COMPARISON DOES.** An unreadable
 * state is not a swapped key and is not a clean one. **AND SO DOES AN EMPTY
 * COMPARISON:** both sides empty used to answer `agree` over nothing, which is a pass
 * on no evidence — the shape `C185` is about, where the failure is an ABSENCE where
 * evidence should be.
 */
export function compareVerifierKeys(
  read: OperationsRead,
  expected: ReadonlyMap<string, Uint8Array>,
): VerifierKeyComparison {
  const empty = { matched: [], mismatched: [], onChainOnly: [], missingOnChain: [], fingerprints: [] };
  if (read.state !== 'read') {
    return {
      ...empty, verdict: 'unknown', address: read.address,
      why: `this contract's verifier keys could not be read — ${read.why}. NOTHING may be ` +
        'concluded: an unreadable state is not a clean one.',
    };
  }
  const fp = (b: Uint8Array) => toHex(b.slice(0, 8));
  const matched: string[] = [], mismatched: string[] = [], onChainOnly: string[] = [];
  const fingerprints: VerifierKeyComparison['fingerprints'] = [];
  const seen = new Set<string>();

  for (const op of read.operations) {
    seen.add(op.name);
    const want = expected.get(op.name);
    if (!want) { onChainOnly.push(op.name); continue; }
    const same = op.verifierKey.length === want.length &&
      op.verifierKey.every((b, i) => b === want[i]);
    (same ? matched : mismatched).push(op.name);
    if (!same) fingerprints.push({ name: op.name, onChain: fp(op.verifierKey), expected: fp(want) });
  }
  const missingOnChain = [...expected.keys()].filter((n) => !seen.has(n));

  if (mismatched.length > 0) {
    return {
      verdict: 'disagree', address: read.address, matched, mismatched, onChainOnly,
      missingOnChain, fingerprints,
      why: `${mismatched.length} entry point(s) carry a verifier key this build did not produce: ` +
        `${mismatched.join(', ')}. **THIS IS WHAT \`C353\` LOOKS LIKE FROM OUTSIDE.** Whoever ` +
        'holds the maintenance authority can replace an entry point\'s verifier key, and the ' +
        'contract then accepts proofs of a DIFFERENT statement under the same name, with the ' +
        'operations map unchanged. Do not submit anything against this contract.',
    };
  }
  if (onChainOnly.length > 0 || missingOnChain.length > 0) {
    return {
      verdict: 'disagree', address: read.address, matched, mismatched, onChainOnly,
      missingOnChain, fingerprints,
      why: 'every key this build knows about matches, and the ENTRY POINT SETS DIFFER: ' +
        `${onChainOnly.length} on chain that this build does not know (${onChainOnly.join(', ') || '-'}) ` +
        `and ${missingOnChain.length} in this build that the chain does not carry ` +
        `(${missingOnChain.join(', ') || '-'}). A key this build cannot name is a key nothing here ` +
        'can check, which is a disagreement rather than a silence.',
    };
  }
  if (matched.length === 0) {
    return {
      verdict: 'unknown', address: read.address, matched, mismatched, onChainOnly,
      missingOnChain, fingerprints,
      why: 'there was nothing to compare: the chain carries no entry points this build knows ' +
        'about and this build named none. NOTHING may be concluded — a pass over an empty set ' +
        'is an absence where evidence should be, not evidence of absence.',
    };
  }
  return {
    verdict: 'agree', address: read.address, matched, mismatched, onChainOnly,
    missingOnChain, fingerprints,
    why: `all ${matched.length} deployed entry point(s) carry exactly the verifier key this ` +
      'build produces, compared over FULL BYTES against the artefact on disk — AT THE LATEST ' +
      'VERSION OF EACH, which is the only version the runtime exposes ' +
      '(`ledger-v9.d.ts:742-745`). A key held at an earlier version is not visible from here ' +
      'and this says nothing about one.',
  };
}
