/**
 * The Midnight implementation of the ledger boundary declared in core/ledger.ts, for a company's account contract.
 * Each step is checked against the chain's current state, built, proved and sent, and the service's fee payer
 * balances the fee, so a company never holds a token to pay fees with. `open` refuses on a ledger built without
 * deployment credentials. What signers share off the chain is sealed under the company's viewing key and filed
 * under `viewDigestOf([])`, one constant for every account, so nothing on the chain makes that record tamper evident.
 */
import { contractStateAt } from './contract-state-at.js';
import { sealedPayKeyIn } from './pay-key-round.js';
import type {
  Ledger, LedgerAddress, LedgerRecord, TxRef,
  StateChange, LedgerStatus, SignerRef, AccountOpening,
  PaymentsAmong, RunProposal,
} from '../core/ledger.js';
import type { AssetId } from '../core/assets.js';
import type { PolicyOpening } from './spending-policy.js';
import { viewDigestOf } from '../core/ledger.js';
import { assetIdBytes, NO_ASSET } from '../core/assets.js';
import { shownAddress } from '../core/networks.js';
import { MidnightCommitments } from './commitments.js';
import type { Sealed, Hex } from '../core/crypto.js';
import { fromHex, randomBytes } from '../core/crypto.js';
import { companyLabelBytes, readCompanyLabel, type CompanyLabel } from 'midnight-identity/profile/company-label';
/*
 * A contract's verifier keys - what a write of one must be and whether a contract
 * carries this build's - are one module the wallet, the page and this service
 * share, re-exported here so every existing caller keeps its import.
 */
export {
  compareVerifierKeys, operationsFromContractState, verifierKeyRefusals,
  type OnChainOperation, type OperationsRead, type VerifierKeyComparison, type VerifierKeyVerdict, type VerifierKeyWrite,
} from 'midnight-identity/profile/contract-keys';
import type { NetworkName } from './network.js';
import { arityFrom, assertArity } from './circuit-arity.js';
import { withRetry, sleep } from './retry.js';
import { isDeferredCircuit, deferredCircuitError } from './deferral.js';
import { refuseACallWithoutItsPrivateState } from './governed-call.js';
import { paysNoFees } from './fee-seat.js';
import {
  UndecodedLedgerField,
} from './contract-state-fields.js';
import { AccountSteps, privateStateKey } from './account-steps.js';
export { privateStateKey } from './account-steps.js';
import { alreadyPaidOf, OCCURRENCES_ASKED, type AlreadyPaid, type PaidFor } from './already-paid.js';
export { UndecodedLedgerField, paidMovementsIn } from './contract-state-fields.js';
export { MidnightProofSystem } from './proof-system.js';
export {
  authorityShapeOf, authorityFromContractState, readContractAuthority, intendedAuthorityValue, compareAuthority,
  type AuthorityShape, type OnChainAuthority, type AuthorityRead, type ContractStateReader, type AuthorityVerdict,
  type AuthorityComparison,
} from './contract-authority-read.js';
export {
  planAuthorityReplacement, checkEndState,
  type MaintenancePlan, type MaintenanceEndStateRecord, type EndStateVerdict, type EndStateCheck,
  type MaintenanceSignature,
} from './maintenance-plan.js';
export {
  OCCURRENCES_ASKED, alreadyPaidOf, alreadyPaidSentence, seatBarParts, type PaidFor, type AlreadyPaid,
} from './already-paid.js';
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
  | { kind: 'propose'; payloadHash: Hex; change: StateChange; vault: Hex; raiseBy?: bigint }
  /**
   * `opening` is what a run's id opens to. A seat given rights needs it to show
   * the run's vault is one it may approve on; a seat with every right on every
   * vault, and every governance proposal, needs none.
   */
  | { kind: 'approve'; proposalId: Hex; opening?: RunOpeningHex }
  | { kind: 'cancel'; proposalId: Hex }
  /**
   * **A RUN HELD BY A SIGNER WHO MAY HOLD RUNS ON ITS VAULT.** It is neither
   * charged nor paid until the hold is released. `opening` as for `approve`.
   */
  | { kind: 'holdRun'; proposalId: Hex; opening?: RunOpeningHex }
  /**
   * **A HELD RUN RELEASED**: at once by the signer who held it, otherwise one
   * agreement more towards the approvals the run needs. Any seated signer may.
   */
  | { kind: 'releaseHold'; proposalId: Hex }
  /**
   * **ONE SEATED LEAF REPLACED BY ANOTHER IN ITS SLOT**, under an approved proposal
   * over `reseatPayload(oldLeaf, newLeaf)`. How a signer's rights change, and
   * the chain counts it as a removal.
   */
  | { kind: 'reseatSigner'; oldLeaf: Hex; newLeaf: Hex; proposalId: Hex }
  /**
   * **THE APPROVALS A POLICY CHANGE NEEDS**, set under an approved proposal over
   * `setPolicyBarPayload(newBar)` at the bar that stands today.
   */
  | { kind: 'setPolicyBar'; newBar: number; proposalId: Hex }
  | { kind: 'removeSigner'; removedLeaf: Hex; proposalId: Hex }
  | { kind: 'setThreshold'; newThreshold: number; proposalId: Hex }
  /**
   * `vault` is the vault being GIVEN a threshold, and it is in the
   * payload the proposal committed to — not in the proposal's identity, which
   * names `noVault()` because this is a governance round.
   */
  | { kind: 'setVaultThreshold'; vault: Hex; newThreshold: number; proposalId: Hex }
  /**
   * A PAYROLL RUN, RAISED WITH ITS WINDOW AND ITS VAULT.
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
  | {
    kind: 'proposeRun'; root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex;
    required?: bigint; change: StateChange; raiseBy?: bigint;
  }
  /**
   * Sweeping a run whose window has closed.
   *
   * Permissionless on chain, and it asserts nothing about completeness — a run
   * whose window passed with three payees unpaid closes exactly the same way.
   * What was paid is in `movements`, permanently, and that is the only honest
   * source. See `run-status.ts`.
   */
  | { kind: 'closeExpiredRun'; proposalId: Hex }
  /**
   * **THE CALLING SIGNER'S OWN COPY OF THE PAY-RECORD KEY, SEALED ON CHAIN.**
   * `wrap` is the four 32-byte entries `sealPayKeyTo` makes. The first copy
   * any signer seals also writes the account's commitment to the key, which
   * needs `proposalId`: a governance round over `payKeyPayloadOf(commitment)`,
   * approved. Every later copy names the commitment already there, and the
   * proposal is not read.
   */
  | { kind: 'sealPayKey'; wrap: Hex[]; commitment: Hex; proposalId: Hex | null }
  /**
   * **ONE VAULT'S SPENDING POLICY FOR ONE TOKEN, SET UNDER AN APPROVED ROUND.**
   * The chain derives where the policy sits from the vault and the token's
   * blinded key, so `asset` is staged as the token the policy is for, beside the
   * salt the proposal was raised with. The policy itself is staged too: the chain
   * opens it to learn its highest band, and never publishes the policy.
   */
  | { kind: 'setPolicy'; vault: Hex; asset: AssetId; policy: PolicyOpening; proposalId: Hex }
  /**
   * **AN APPROVED RUN CHARGED TO ITS VAULT'S PERIOD, ONCE, INSIDE ITS WINDOW.**
   * Everything that identifies the run is an argument; the policy's opening,
   * the token and what the period has already been charged are staged on the
   * device and never leave it.
   */
  | {
    kind: 'clearRun'; proposalId: Hex; run: RunProposal; salt: Hex; fresh: Hex; asset: AssetId;
    top: bigint; total: bigint; period: bigint; policy: PolicyOpening; spent: bigint;
  };

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
   * Load bearing: what a circuit is not handed as an argument it reads
   * from this store as a witness, so a caller has to write there before
   * it calls. `propose` is the one that has it: the change and the
   * proposal salt are staged by `stageChange` below. Keyed per network,
   * because one deployment's private state must never be read on another
   * chain.
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
   * Two-phase balancing:
   *   customer  balanceUnboundTransaction(tx, { ttl, tokenKindsToBalance: ['shielded','unshielded'] })
   *   sponsor   balanceFinalizedTransaction(tx, { ttl, tokenKindsToBalance: ['dust'] })
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
   * TIMES, AND WITHOUT THIS MEMBER NOTHING BETWEEN THEM COULD LET GO.**
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
   * Whether the chain shows a transaction this sponsor finalised: true when it
   * does; false only when it can no longer land - the sponsor's view is up to
   * date, does not show it, and the newest finalized block's time is past
   * `deadline`; null when it cannot tell. A transaction handed back to be
   * submitted elsewhere may land without this sponsor submitting it, so a
   * booking is released only on false: DUST the chain shows spent, or may yet
   * spend, is never booked as free again. Absent, the sponsor cannot read the
   * chain.
   */
  landed?(finalisedTransaction: unknown, deadline: Date): Promise<boolean | null>;

  /**
   * Adds the fee to a transaction that will be handed back for someone else to
   * submit, under the shorter rules such a booking is held to, with a name for
   * the booking. Absent, `addFeeAndFinalise` serves and nothing names it.
   */
  addFeeToHandBack?(customerFinalised: unknown, ttl: Date): Promise<{ finalised: unknown; booking: string | null }>;

  /** Tells the fee payer the holder of a handed-back booking is done with it; nothing is released. */
  done?(booking: string): Promise<void>;

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
   * Filed under the commitment AND the key epoch.
   *
   * The commitment alone does not identify a blob: the value passed here is
   * `viewDigestOf([])`, one constant, so it separates nothing at all. The key
   * epoch names the key a blob opens with.
   */
  put(accountId: string, commitment: Hex, keyEpoch: number, sealed: Sealed): Promise<void>;
  get(accountId: string, commitment: Hex, keyEpoch: number): Promise<Sealed | null>;
}

/**
 * **THE CIRCUITS THAT READ NO WITNESS, AND THEREFORE NEED NO PRIVATE STATE.**
 *
 * Taken from the contract and nowhere else: a circuit is on this list only if
 * it, and everything it calls, reads none of the nine witnesses.
 * `closeExpiredRun` is the only one of the seven circuits this client drives
 * that qualifies - it opens no signer check, reads no salt and reads no asset,
 * and it is permissionless on chain by design.
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
 * They are written here, once, rather than at the nine places a step is
 * turned into a call, for one reason: **the answer to whether a step
 * needs the calling device's private state is not a property of the
 * step, it is a property of the CIRCUIT the step calls**, and with the
 * names spread across nine branches there would be nowhere to compute
 * that from.
 *
 * Two steps can name the same circuit and two circuits can be named by one
 * step's neighbours, which is why this is a table and not a convention: a
 * governance round and a payroll run are both `propose`.
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
  /* A removal that keeps the threshold in force: the removal circuit, naming 0 as the threshold. */
  removeSigner: 'removeSignerAndSetThreshold',
  setThreshold: 'setThreshold',
  setVaultThreshold: 'setVaultThreshold',
  closeExpiredRun: 'closeExpiredRun',
  sealPayKey: 'sealPayKey',
  setPolicy: 'setPolicy',
  clearRun: 'clearRun',
  holdRun: 'holdRun',
  releaseHold: 'releaseHold',
  reseatSigner: 'reseatSigner',
  setPolicyBar: 'setPolicyBar',
};

/** What a run's id opens to, as a device holds it: the payload, the vault and the salt. */
export interface RunOpeningHex {
  payload: Hex;
  vault: Hex;
  salt: Hex;
}

export class MidnightLedger extends AccountSteps implements Ledger {
  /** Everything this class writes goes to a chain, or it does not get written. */
  readonly wiring = 'chain' as const;

  /* ------------------------------------------------------------ *
   * the lifecycle
   *
   * One named method per circuit, no guessing, and a gap that shows up
   * as a missing method rather than as a mystery at deploy time. The
   * account keeps no book, so there is no write that carries a balance or
   * a commitment from the caller.
   * ------------------------------------------------------------ */

  /**
   * Deploying the contract.
   *
   * Not implemented here on purpose. Deployment is `deployContract` with
   * the constructor's witnesses, a funded wallet, a DUST budget measured
   * against the live chain and a retry around a websocket that drops, all
   * of which `scripts/deploy-preview.ts` already does. Reimplementing it
   * behind this method would be a second copy of the one thing in this
   * project with the worst record for drifting out of sync.
   *
   * So it throws, and says where the working one is.
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
     * IT IS REFUSED BECAUSE THE CONTRACT CANNOT REFUSE IT LATER. A seat after
     * the first is taken only on an invitation a seated signer raised, so an
     * account deployed with no seat can never have one added — it is dead on arrival, permanently, along with
     * every vault that names it as its authority and the money in them. The
     * constructor's own two guards catch a leaf that is zero or the vacancy
     * marker; nothing on chain can catch an argument that was never supplied,
     * because there would be no deploy to catch it in.
     *
     * `SimulatedLedger.open` has always refused a threshold it cannot reach;
     * this path never did, and the deploy script passed an empty array
     * against a threshold of two for as long as the deployer supplied the
     * seat itself.
     */
    const foundingLeaf = opening.signerLeaves[0];
    if (!foundingLeaf) {
      throw new Error(
        `cannot open "${accountId}": the opening names no founding signer. The account's ` +
          'first seat is the leaf handed to the constructor, and an account deployed ' +
          'without one can never have a signer added — every later seat is taken on an invitation ' +
          'an existing signer raised, so there would be nobody able to invite the first.',
      );
    }
    /*
     * This path seats one signer, so it refuses an opening that names more
     * than one rather than seating the first and dropping the rest.
     *
     * `SimulatedLedger.open` seats every leaf it is given and
     * `AccountService` writes all N onto the durable record. Without this,
     * a 2-of-3 company would be created, the roster would say three
     * signers, the chain would hold one, `open` would return success and
     * nobody would be told. A client record and a chain that disagree about
     * who may approve is the worst shape this boundary can take.
     *
     * It is a refusal and not a warning because the alternative is a
     * deployed contract and a spent fee. Until the seating screen exists,
     * this says so out loud.
     */
    /*
     * The company's label, and an opening without one is refused here
     * rather than deployed. The constructor writes it into the account, and
     * every signer's wallet derives this company's keys from it and reads
     * it back off the account before it gives or signs anything. It is
     * drawn by the founding signer's wallet, so there is nothing here to
     * draw one with: an account deployed with any other value would be a
     * company no wallet could open.
     */
    const label = opening.companyLabel === undefined || opening.companyLabel === null
      ? null : readCompanyLabel(opening.companyLabel);
    if (label === null) {
      throw new Error(
        `cannot open "${accountId}": no company label was given, or what was given is not one. A company's `
          + 'account is created with the label its founding signer\'s wallet made up for it, and nothing '
          + 'here makes one up instead. Nothing was deployed and nothing was spent.');
    }
    /* The contract's own refusal, reached before a deploy and a fee rather
     * than after. An unusable founding seat is not recoverable at all: every
     * later seat needs an invitation an existing signer raised. */
    await this.refuseUnusableLeaf(foundingLeaf, `the founding signer leaf for "${accountId}"`);
    if (opening.signerLeaves.length > 1) {
      throw new Error(
        `cannot open "${accountId}": the opening names ${opening.signerLeaves.length} founding ` +
          'signers and this path can seat exactly one. The constructor creates the founding ' +
          'signer\'s seat; every seat after it is an invitation the signers raise and approve and the ' +
          'invitee takes from their own wallet (`seatInvited`), and there is no screen for that yet. ' +
          'Open with the founding signer alone.',
      );
    }
    /*
     * This refusal guards our own records, not the chain. The constructor
     * takes no threshold and sets `threshold = 1`, so a zero threshold is
     * unrepresentable on chain (a zero would pass the approval check with
     * nobody having approved), and nothing this refuses reaches the
     * constructor. It stays for three reasons.
     * (1) `opening.threshold` is still consumed by `SimulatedLedger.open`
     * and still becomes `account.policy.threshold`, so a non-integer or a
     * zero is still a bad value entering our own records; this refuses it
     * at the boundary both ledgers share, where the two implementations are
     * meant to agree.
     * (2) The `Number.isInteger` clause is not redundant with `< 1`:
     * `NaN < 1` is `false`, so without it a `NaN` passes.
     * (3) It is the only place the Midnight path states what an opening
     * must look like, and the tests exercise each of the three refusals.
     */
    if (!Number.isInteger(opening.threshold) || opening.threshold < 1) {
      throw new Error(
        `cannot open "${accountId}": a threshold of ${opening.threshold} is not a rule. It is ` +
          'refused here because it would enter our own record of the account as its policy. ' +
          'The chain never sees it: the constructor takes no threshold and founds ' +
          'every account at one, raised afterwards through the ordinary approval path.',
      );
    }
    /*
     * **ON A CHAIN, A COMPANY IS MADE ON ITS FOUNDING SIGNER'S DEVICE, AND
     * NOTHING HERE OPENS ONE.** Its secrets are made there and its first state
     * sealed there; what this service keeps of it is filed by
     * the company's signed state record, and the account is deployed from that device.
     */
    throw new Error(
      `cannot open "${accountId}": on a chain, a company's account is created only from its founding signer's `
        + 'browser, held by their own committee key from its first transaction, and this service deploys none. '
        + 'Create the company from the product\'s own page, in the founding signer\'s browser. Nothing was deployed '
        + 'and nothing was spent.',
    );
  }

  /** Only on a deployment whose companies are made on their founding signer's device. */
  get takesCompaniesFromTheirFoundingSigner(): boolean {
    return this.deployment?.fromTheFoundingSigner === true;
  }

  /**
  /**
   * Deploys from this process, under a key it holds. Nothing calls it: on
   * a chain a company's account is created from its founding signer's
   * browser. It is left whole until the operator paths that reached it
   * are removed with it; protected rather than private only so the
   * compiler's check for unused code does not ask for it to go before
   * then.
   */
  protected async deployFromThisProcess(accountId: string, opening: AccountOpening, foundingLeaf: string, label: CompanyLabel): Promise<TxRef> {
    if (!this.deployment || this.deployment.maintenanceAuthority === undefined) {
      throw new Error(`cannot open "${accountId}": this deployment has no maintenance authority to deploy under.`);
    }
    /*
     * Not the SDK's `deployContract`: the deployment carries the circuits
     * the partial-deploy module names, because the full contract exceeded
     * the chain's write ceiling, and the SDK can neither build a partial
     * operations map nor read one back. The account is created in the two
     * steps that module names, so the map this builds is its first step.
     * The path also pins the operations map to a decided list rather than
     * to whatever compiled, and the partial deploy refuses to run without
     * a deliberate maintenance authority.
     */
    const {
      submitPartialDeployTx, submitCreationInsertTx, findDeployedPartialContract,
      requireCreatableAuthority,
    } = await import('./partial-contract.js');
    // Validated BEFORE the retry loop: a missing or malformed authority is a
    // refusal to explain, not a transient to retry. And an authority that could
    // not sign the creation's second step is refused here, before a fee is spent.
    requireCreatableAuthority(this.deployment.maintenanceAuthority);
    const providers = await this.providers();

    /*
     * An account holds nothing, ever, so there is no balance to open at and
     * no asset entry on chain. The salt below is still a real random value
     * rather than a zero: it is the proposal salt every witness has to
     * answer with, and a predictable one would make a proposal id
     * guessable.
     */
    const genesisSalt = randomBytes(32);
    /*
     * The record the deploy persists carries no signing secret, no blinding
     * and no scope: the constructor reads none of them as witnesses, so
     * there is nothing for this process to answer with and nothing for it
     * to hold. They are absent, not defaulted or zeroed: a zero secret is
     * still a secret-shaped value that a later reader could mistake for a
     * device's, and this record must not be able to name a signer.
     *
     * What the SDK requires is the shape, not the contents: the partial
     * deploy types `initialPrivateState` as `unknown` and persists it
     * verbatim. `AccountPrivateState` is this repository's own interface;
     * `requireSigner()` reads all three on every governed circuit, so a
     * signer's device holds them. A deployer is not a signer, so the record
     * it writes does not.
     *
     * The four fields that remain are the account's, not a device's: its
     * asset blinding, the reserved "no asset" the constructor names, and a
     * genesis salt that is a real random value rather than a zero because a
     * predictable proposal salt would make a proposal id guessable.
     */
    const initialPrivateState = {
      assetBlinding: fromHex(opening.assetBlinding),
      // The constructor names no asset and writes no commitment of any kind:
      // it seats the founding signer's leaf and sets the threshold, and
      // nothing else. Every witness still has to answer, so this is the
      // reserved "no asset".
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
         * Two arguments, and nothing in TypeScript checks that: the SDK types
         * `args` as `unknown[]` and `contract-info.json` carries no constructor
         * entry, so `circuit-arity.ts` does not guard this call either. The
         * generated `initialState` asserts the arity itself and would refuse at
         * deploy time with a funded wallet.
         *
         * The first is the founding signer's leaf. The threshold is not passed
         * at all: the constructor takes none and sets `threshold = 1`, so
         * `opening.threshold` never reaches the chain; what it still does is
         * above, at the refusal that reads it.
         *
         * The second is the company's label, which the account keeps in
         * `signerRoles` from the moment it exists: its thirty-two bytes, as the
         * founding signer's wallet drew them.
         */
        args: [fromHex(foundingLeaf), companyLabelBytes(label)],
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
     * THE SECOND STEP OF THE CREATION. The deploy carried only the circuits a
     * company needs to govern itself; one maintenance update, signed by the key
     * the deploy installed, inserts the rest. Until it lands the account can pay
     * nothing, and the read-back below refuses it by name. It is safe to retry:
     * it reads the account first and refuses to insert twice.
     */
    await withRetry(
      'finish the creation',
      () => submitCreationInsertTx(providers as any, {
        contractAddress: address,
        maintenanceAuthority: this.deployment!.maintenanceAuthority,
      }),
      this.deployment.retry,
    );

    /*
     * The real check, not a formality. The partial find reads public state
     * through the indexer and compares the on-chain verifier keys against
     * the ones we compiled, for the circuits this deployment carries (the
     * SDK's `findDeployedContract` would compare every compiled key and
     * refuse its own deployment). It also checks the deferred circuits are
     * absent, which is inert while nothing is deferred. The private state
     * was already written by `submitPartialDeployTx`, under this contract's
     * address.
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
     * `open` seats exactly one signer, the founding signer. Later signers
     * are invited by the signers and take their seats from their own
     * wallets (`seatInvited`). This process holds no secret that satisfies
     * `requireSigner()`, so it cannot seat anyone itself, and a loop that
     * seated the rest "as the deployer" would be a deployer's seat under
     * another name.
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
       * No "is it really open" check either: a proposal that has settled or
       * been cancelled is removed from the map, so presence is the answer and
       * there is no stale value for a caller to believe.
       */
      openProposals: s.openProposals,
      threshold: Number(s.threshold),
      /* Absence means inherit, so an account with no exceptions reports
       * an empty array and every vault is judged by `threshold` above. */
      vaultThresholds: s.vaultThresholds,
      signerCount: Number(s.signerCount), // a count derived from the set's size: see readContractState
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
  /**
   * **WHETHER THE ACCOUNT'S SIGNER SET HOLDS THIS LEAF**, as the contract's own
   * decoded set answers it. Null when the account is not on the chain to ask; a
   * set that does not decode refuses rather than reading as "no".
   */
  async holdsSigner(accountId: string, leaf: Hex): Promise<boolean | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;
    const { ledger: readLedger } = await import('../../contracts/managed/contract/index.js');
    const providers = await this.providers();
    const state = await contractStateAt(providers.publicDataProvider, address);
    if (!state) return null;
    const leaves = (readLedger(state.data) as any)?.signerLeaves;
    if (leaves == null || typeof leaves.member !== 'function') {
      throw new UndecodedLedgerField('signerLeaves', 'set');
    }
    return Boolean(leaves.member(fromHex(leaf)));
  }

  async paidAmong(accountId: string, leaves: Hex[]): Promise<PaymentsAmong | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;

    const { ledger: readLedger, pureCircuits } = await import(
      '../../contracts/managed/contract/index.js');
    const providers = await this.providers();

    const state = await contractStateAt(providers.publicDataProvider, address);
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
   * **WHICH OF THESE NONCES THE ACCOUNT HAS RECORDED A PAYMENT FOR.** The same
   * read as `paidAmong`, testing the contract's own `paidOnceOf` of each nonce.
   */
  async paidOnceAmong(accountId: string, nonces: Hex[]): Promise<PaymentsAmong | null> {
    const movements = await this.movementsOf(accountId);
    if (!movements) return null;
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    return {
      known: true,
      paid: nonces.filter((nonce) => movements.member(pureCircuits.paidOnceOf(fromHex(nonce)))),
    };
  }

  /**
   * **WHAT THE APPROVING DEVICE CAN SAY ABOUT EACH PERSON ON A RUN, FROM ONE
   * READ OF THE ACCOUNT AND THE PAY-RECORD KEY**: which occurrences of their
   * kind of pay for their month the chain has recorded as paid. One read of the
   * whole state, then membership tests on the device; nothing tested leaves it.
   * Null when the account is not on this ledger. See `alreadyPaidOf`.
   */
  async alreadyPaid(
    accountId: string, key: Hex, asked: readonly PaidFor[], upTo = OCCURRENCES_ASKED,
  ): Promise<AlreadyPaid[] | null> {
    const movements = await this.movementsOf(accountId);
    if (!movements) return null;
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    return alreadyPaidOf(
      (nonce) => Boolean(movements.member(pureCircuits.paidOnceOf(fromHex(nonce)))), key, asked, upTo);
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
    raiseBy?: bigint,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'propose', payloadHash, change, vault, raiseBy });
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
    /* The vault the caller named, not `noVault()` assumed. The id the
     * chain holds is derived from it, so checking against any other value
     * would report a landed proposal as missing. */
    const id = MidnightCommitments.proposalId(payloadHash, change.salt, vault);
    const landed = after?.openProposals.find(p => p.id === id);
    /*
     * Found by id. Several proposals are open at once, so "the change the
     * chain recorded" is only a question about one of them, and asking it
     * of the account as a whole would compare this proposal against
     * whichever one happened to be written last.
     */
    if (!landed) {
      /*
       * Two opposite faults, two messages. `landed` is undefined
       * either because the state read came back empty — so nothing was ever
       * searched — or because the state is fine and no id matches, meaning the
       * proposal is genuinely absent or our derivation of the id disagrees with
       * the chain's. A read that failed and a commitment that disagrees are
       * diagnosed in opposite directions, so the message names which one it is,
       * and in the no-match case prints what we looked for beside what is
       * actually held.
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
   * RAISES A PAYROLL RUN.
   *
   * The same post-check as `propose`, and it earns its keep more here: a run's
   * id is computed from four values rather than one, so there are four ways to
   * build a proposal nobody can ever pay against. Finding that out now costs a
   * refused call; finding it out later costs an approval round from every
   * signer and is discovered on payday.
   */
  async proposeRun(
    accountId: string,
    run: { root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex; required?: bigint },
    change: StateChange,
    by: SignerRef,
    raiseBy?: bigint,
  ): Promise<TxRef & { proposalId: Hex }> {
    /*
     * A run must name a real vault. The contract's run branch takes the
     * vault opaque and asserts nothing about it (only the governance branch
     * asserts `vault == noVault()`). So a run raised at the sentinel
     * settles, collects its approvals and burns its fee, and
     * `recordPayment` can never be handed it, because a vault presents
     * itself and recomputes the id from its own address.
     *
     * `AccountService.proposeRun` refuses it upstream, so nothing loses
     * money, but the two implementations of one boundary method must refuse
     * the same sequences, and this is the one that pays a fee.
     */
    if (run.vault === MidnightCommitments.noVault()) {
      throw new Error(
        'a payroll run must name the vault that will pay it: the vault is folded into the ' +
          'proposal id and recordPayment recomputes the id from the vault it is handed, so a ' +
          'run raised at the no-vault sentinel is one no vault can ever present.',
      );
    }
    const call = await this.prepare(accountId, { kind: 'proposeRun', ...run, change, raiseBy });
    const result = await this.buildCall(call.address, call.circuit, call.args, call.privateStateId);

    const payloadHash = MidnightCommitments.runPayload(
      run.root, run.payees, run.opensAt, run.closesAt, run.required ?? 0n);
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
   * Sweeps a run whose window has closed.
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
  async approve(accountId: string, proposalId: Hex, by: SignerRef, opening?: RunOpeningHex): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'approve', proposalId, opening });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * **HOLDS A RUN.** Only a signer whose seat lets them hold runs on the run's
   * vault; a seat given rights hands `opening` to show which vault that is.
   * The run is neither charged nor paid until the hold is released.
   *
   * **NEVER RUN AGAINST A NODE.** It type-checks against the generated ABI and
   * its contract half is tested in the simulator; no further claim is made.
   */
  async holdRun(accountId: string, proposalId: Hex, by: SignerRef, opening?: RunOpeningHex): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'holdRun', proposalId, opening });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * **RELEASES A HELD RUN**, or adds this signer's agreement to releasing it.
   * Never run against a node, as above.
   */
  async releaseHold(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'releaseHold', proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * **REPLACES ONE SEATED LEAF WITH ANOTHER IN ITS SLOT**, which is how a
   * signer's rights change. The chain counts it as a removal, so every
   * governance proposal raised before it must be raised again. Never run
   * against a node, as above.
   */
  async reseatSigner(
    accountId: string, oldLeaf: Hex, newLeaf: Hex, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'reseatSigner', oldLeaf, newLeaf, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * **SETS THE APPROVALS A POLICY CHANGE NEEDS**, under a round approved at the
   * bar that stands today. Never run against a node, as above.
   */
  async setPolicyBar(accountId: string, newBar: number, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'setPolicyBar', newBar, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }


  /*
   * NO METHOD SEATS A SIGNER HERE. A seat after the founding one is taken by the
   * invitee's own wallet (`seatInvited`), which proves it holds the invited
   * address's coin secret key; this process never holds that key, so it cannot
   * make the call.
   */

  /*
   * Removing a signer clears one slot and needs no list, so there is no
   * slot width, no cap, and no number for the two sides to disagree
   * about.
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
   * **SEALS THE PAY-RECORD KEY TO THE CALLING SIGNER, ON CHAIN.** Each signer
   * seals their own copy, once, under entries derived from their own secret
   * key, so no signer can write another's. The first copy also writes the
   * account's commitment to the key, under an approved round; see the step.
   *
   * **NEVER RUN AGAINST A NODE.** It type-checks against the generated ABI and
   * its contract half is tested in the simulator; no further claim is made.
   */
  async sealPayKey(
    accountId: string, wrap: Hex[], commitment: Hex, proposalId: Hex | null, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'sealPayKey', wrap, commitment, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }
  /**
   * **SETS ONE VAULT'S SPENDING POLICY FOR ONE TOKEN**, under a governance round
   * over `setPolicyPayloadOf(vault, asset key, commitment)` that is approved at
   * the higher of the account's bar and the bar the company set for policy
   * changes. From then on the vault pays only runs charged to its periods, and
   * refuses a token it has no policy for; a policy change, and any change of who
   * is seated, needs at least the approvals of the policy's highest band.
   */
  async setPolicy(
    accountId: string, vault: Hex, asset: AssetId, policy: PolicyOpening, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'setPolicy', vault, asset, policy, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }

  /**
   * **CHARGES AN APPROVED RUN TO ITS VAULT'S PERIOD**, once, inside its window.
   * `tree` is the run's own payout tree, whose total and top node the root
   * commits to; `spent` is what the period has been charged already, which the
   * account's stored total must open to. `fresh` is the fresh half of the run's
   * salt, `retrySaltOf(no leg, fresh)`: this charges a run of its own, never a
   * retry against its leg.
   */
  async clearRun(
    accountId: string,
    args: {
      proposalId: Hex; run: RunProposal; salt: Hex; fresh: Hex; asset: AssetId;
      tree: { top: bigint; total: bigint }; period: bigint; policy: PolicyOpening; spent: bigint;
    },
    by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, {
      kind: 'clearRun', proposalId: args.proposalId, run: args.run, salt: args.salt, fresh: args.fresh, asset: args.asset,
      top: args.tree.top, total: args.tree.total, period: args.period, policy: args.policy, spent: args.spent,
    });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args, call.privateStateId), by);
  }


  /**
   * **THE ACCOUNT'S COMMITMENT TO ITS PAY-RECORD KEY**, or null when none has
   * been written yet. Read from the account's shared map under the key the
   * contract derives for it.
   */
  async payKeyCommitment(accountId: string): Promise<Hex | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;
    return this.payKeyCommitmentAt(address);
  }

  /**
   * **ONE SIGNER'S SEALED COPY OF THE PAY-RECORD KEY**, as the four entries the
   * account holds under keys derived from that signer's secret key and this
   * account, or null when they have not sealed one. `secretKey` never leaves
   * the device: the keys are worked out here and only looked up, by the one
   * reader a device's own standing uses too.
   */
  async sealedPayKeyOf(accountId: string, secretKey: Hex): Promise<Hex[] | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;
    const read = await this.signerRolesAt(String(address));
    if (read === null) return null;
    return sealedPayKeyIn(read.pureCircuits, read.roles, String(address), secretKey);
  }

  /**
   * One vault's own threshold, on chain. Mirrors the `setVaultThreshold`
   * circuit.
   *
   * Never run against a node: it type-checks against the generated ABI
   * and no further claim is made for it here.
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
   * There is no `credit`: the account keeps no book, so no value arrives
   * at it. Money is held by a vault and reaches one through the vault's
   * own deposit path. What leaves is in `movements`, written by
   * `recordPayment`.
   */

  /* ------------------------------------------------------------------ *
   * the same proposal, one step at a time
   *
   * Everything above builds, proves, balances and submits in a single
   * call, which is right for a script and wrong for a queue. A job has to
   * be able to do the expensive, effect-free part, building and proving,
   * and stop, then submit later, possibly after a crash.
   *
   * `prepare` is that first half, and it is the same first half: the
   * methods above call it rather than repeating their own checks. One
   * copy of each rule, because a procedure written twice with the second
   * copy missing a line is the failure this boundary guards against.
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
      case 'propose': case 'proposeRun': case 'closeExpiredRun': case 'approve': case 'cancel':
      case 'holdRun': case 'releaseHold':
        return this.prepareRunStep(accountId, step, address, privateStateId, circuit);
      case 'reseatSigner': case 'setPolicyBar': case 'setThreshold': case 'removeSigner':
        return this.prepareSeatStep(accountId, step, address, privateStateId, circuit);
      case 'setVaultThreshold':
        return this.prepareVaultThresholdStep(accountId, step, address, privateStateId, circuit);
      case 'setPolicy': case 'clearRun': case 'sealPayKey':
        return this.preparePolicyStep(accountId, step, address, privateStateId, circuit);
    }
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
          'Either the blob is missing, or the account record names a key epoch the state ' +
          'store holds nothing under.',
      );
    }

    return { commitment: viewDigestOf([]), sealedState: sealed, updatedAt: state.updatedAt };
  }

  /**
   * **WHAT IS WIRED, NOT WHETHER IT WORKS.** A fee payer in the seat is named as
   * the one fees go to; nothing here has watched it pay.
   */
  describe(): string {
    return `Midnight ${this.cfg.networkId} via ${shownAddress(this.cfg.nodeUrl)}, `
      + (paysNoFees(this.sponsor)
        ? 'with no fee payer, so nothing can be written'
        : 'with fees paid by the fee payer it was given');
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
   * chain match the ones we compiled, and hands back a typed `callTx`.
   * Doing this by hand has cost more than it saved.
   *
   * The verifier key check is not a formality. If Midnight ships a proof
   * system change and our contract was deployed frozen, this is where it
   * surfaces, as a mismatch rather than a mystery.
   */
  private async connect(address: string, privateStateId: string | null) {
    /*
     * Not `findDeployedContract`: against a partial deployment, the SDK's
     * find compares all fifteen compiled verifier keys against the deployed
     * state and throws `ContractTypeError` naming the deferred circuits as
     * "undefined or have mismatched verifier keys", on every call, deferred
     * or not, in words that read as key corruption. The partial find keeps
     * what matters: the deployed keys are compared byte-for-byte against the
     * compiled ones, through the SDK's own `verifyContractState`, for the
     * deployed circuits that exist; it checks the deferred ones are absent
     * and hands back the same typed `callTx`.
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
       * Passed rather than spread: the find takes the answer as
       * `string | null` and requires it, so leaving it out is a compile error
       * there and an omitted answer is refused at run time, which is worth more
       * here than a line that cannot say `null` out loud. The SDK's own gate is
       * truthiness rather than presence, so it treats an absent field and a
       * `null` one the same; a sentence that overstates what holds a line up is
       * how the line comes to be simplified away.
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
     * Before connecting: a deferred circuit fails here, naming the cause.
     * Left to run on, the failure would be the chain's
     * `VerifierKeyNotPresent` after a proof was paid for, or, worse, the
     * SDK's generic error with the cause a guess. A call to a circuit the
     * deployment defers must say so, not fail generically.
     */
    if (isDeferredCircuit(circuit)) {
      throw deferredCircuitError(circuit);
    }
    const contract = await this.connect(address, privateStateId);
    const call = (contract.callTx as any)[circuit];
    if (typeof call !== 'function') {
      throw new Error(`the deployed contract has no circuit "${circuit}"`);
    }
    // Arity is read from the contract's declared ABI and not from
    // `call.length`, which is always 0: every generated circuit function is
    // `(...args) => {…}` and a rest parameter contributes nothing to
    // Function.length. A test stub written with `(...args)` shares that
    // blind spot, so the arity check must not rely on it.
    assertArity(arityFrom(this.cfg.zkConfigPath), circuit, args.length);
    return call(...args);
  }
}

/* The verifier keys are read back and compared by the module the wallet, the page and this service share
 * (`midnight-identity/profile/contract-keys`), re-exported at the top of this file. */





/** One person on a run, as the approving device asks about them: everything but the occurrence. */
