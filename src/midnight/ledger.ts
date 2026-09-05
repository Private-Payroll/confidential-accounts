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
 *    balance ledger (`C292`); the value a blob is filed under is now
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
  SealedStateAt,
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
import type { MaintenanceAuthorityChoice } from './partial-contract.js';

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */

/**
 * One step of a round, described rather than performed. M-82.
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
   * `R5`. `vault` is the vault being GIVEN a threshold, and it is in the
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
  privateStateId: string;
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
   * (`C292`); `propose` is the one that has it now — the change and the
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

  /** Remaining DUST capacity, so we can alarm before customers start failing. */
  capacity(): Promise<{ dust: bigint; night: bigint }>;
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
 * this time — it is the ninth instance of the pattern. M-68.
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
 * The truthful missing-private-state message. C228.
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

export class MidnightLedger implements Ledger {
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
       * (C225). The deploy refuses to run rather than sample —
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
   * M-29. This class used to have one write method, `publish(accountId,
   * commitment, sealedState)`, and it could not be implemented. `execute()`
   * derived the new commitment from the witnesses `nextBalance`,
   * `nextEntriesDigest` and `nextStateSalt` — deliberately, so that no public
   * parameter could carry a balance onto the chain — and this class was handed a
   * finished commitment and a ciphertext it could open neither of.
   *
   * The boundary passed the OPENING instead, which is what those witnesses
   * wanted, and named each step of the round rather than collapsing them into
   * one write. **THE OPENING, THE WITNESSES AND `execute` ARE ALL GONE**
   * (`C292`), and `credit` — the one operation this class used to refuse by
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
     * nothing else wired. `S35`.
     */
    /*
     * **THE FOUNDING SIGNER, AND AN OPENING WITHOUT ONE IS REFUSED HERE RATHER
     * THAN DEPLOYED.** `C334`.
     *
     * `signerLeaves[0]` is the founding signer — the type says the array is the
     * founding signers' leaves and this is the first of them, so there is ONE
     * place the answer comes from and no second field to keep in step (M-104).
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
     * `money-safety-auditor`, `S35`.
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
     * (S25), so the map this builds is currently the whole contract; the path
     * stays because it is also what pins the operations map to a decided list
     * rather than to whatever compiled (`C224`). The partial deploy also
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
     * the balance ledger; the paragraph below is what is true now. `C292`.
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
     * AND NO SCOPE.** `C334`.
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
     * on purpose. M-23.
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
         * time with a funded wallet. `T-137`.
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
     * The opening blob, stored. M-73.
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
     * check that is INERT while nothing is deferred (S25), and filed as such
     * rather than widened here. The private state was already written by
     * `submitPartialDeployTx`, under this contract's address.
     */
    await findDeployedPartialContract(providers as any, {
      compiledContract: this.compiled as any,
      contractAddress: address,
    });

    /*
     * **THE LOOP THAT SEATED THE REST OF THE FOUNDERS STOOD HERE, AND IT WENT
     * WITH THE DEPLOYER'S SEAT.** `C334`.
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
   * `PI2a`, `C136`.
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
     * `PI2b`, `C140`. `addressOf` reads back what
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
       * Every proposal open at once, not "the" open one. M-128.
       *
       * No "is it really open" dance either: a proposal that has been executed
       * or cancelled is REMOVED from the map, so presence is the answer. The old
       * shape had to check `proposalOpen` before reporting `proposal`, because
       * the contract zeroed the field rather than deleting it, and a caller
       * reading it raw would believe a closed round was open.
       */
      openProposals: s.openProposals,
      threshold: Number(s.threshold),
      /* `R5`. Absence means inherit, so an account with no exceptions reports
       * an empty array and every vault is judged by `threshold` above. */
      vaultThresholds: s.vaultThresholds,
      signerCount: Number(s.signerCount), // `T-220` rides this line: see readContractState
      movementCount: Number(s.movementCount), retiredVaults: s.retiredVaults };
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
    const result = await this.buildCall(call.address, call.circuit, call.args);

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
     * `money-safety-auditor` against the round's own change.
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
    const result = await this.buildCall(call.address, call.circuit, call.args);

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
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
  }

  /**
   * One approval per signer per PROPOSAL. M-128.
   *
   * Deliberately does NOT pre-check whether this signer has already approved.
   * It cannot: the nullifier is `H(domain, contractAddress, proposal, secretKey)`
   * and the secret never leaves the signer's device, which is the entire point
   * of the scheme. The contract rejects the duplicate, and a local check that
   * looked authoritative would be a lie about what we can know.
   */
  async approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'approve', proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
  }

  /*
   * `settleRound` AND `sendTransition` STOOD HERE. `C292`, `S26`.
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
   * M-69. Puts a signer's leaf in the on-chain tree.
   *
   * The circuit decides which of its two paths applies — bootstrap or approved
   * round — from `signerCount < threshold`, and this does not second-guess it.
   * It does check the obvious refusals first, because each one otherwise costs a
   * block time and a fee to discover.
   *
   * The proposal salt is staged for the same reason `propose` stages it: on the
   * approved path the circuit recomputes the proposal's id from it, and the
   * adding device has to be using the proposer's. `execute` was the other
   * circuit that read it and is gone (`C292`); `amendSigner`, `setThreshold`,
   * `setVaultThreshold`, `adopt`, `retireVault` and `recordPayment` are the
   * readers that are left.
   */
  async addSigner(
    accountId: string, leaf: Hex, proposalId: Hex | null, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'addSigner', leaf, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
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
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
  }

  async setThreshold(
    accountId: string, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const call = await this.prepare(
      accountId, { kind: 'setThreshold', newThreshold, proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
  }

  /**
   * **ONE VAULT'S OWN THRESHOLD, ON CHAIN.** `R5`, `C172`. Mirrors
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
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
  }

  async cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const call = await this.prepare(accountId, { kind: 'cancel', proposalId });
    return this.txRef(await this.buildCall(call.address, call.circuit, call.args), by);
  }

  /*
   * `credit` STOOD HERE AND REFUSED BY NAME. `C292`, `V-246`, `S26`.
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
   * M-65, M-72, M-75.
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
    const privateStateId = privateStateKey(this.cfg.privateStateId, accountId);

    switch (step.kind) {
      case 'propose': {
        /*
         * NO "a proposal is already open" REFUSAL, and its absence is the
         * feature. M-128. This used to be the check that stopped an admin
         * raising a vendor invoice while payroll collected signatures.
         *
         * M-70/M-71. `propose` records the change, and it reads it from the
         * caller's private state because there is no argument for it. Staging
         * is therefore not optional here. `execute` was the other reader and is
         * gone (`C292`), so this is the ONLY circuit that opens what is staged
         * below and nothing on chain reopens what it commits to.
         */
        /*
         * **THE VAULT IS REFUSED BEFORE ANYTHING IS STAGED.** `C367`, `T-237`,
         * `S55`. `contracts/src/ConfidentialAccount.compact:2319` asserts it on
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
         * The MERGED `propose` (S11): the opaque path. `isRun` false, the run
         * parts zero — the branch that would read them is not taken, exactly
         * as `addSigner`'s unused `proposal` is zeroes on the bootstrap path.
         */
        return {
          address, privateStateId, circuit: 'propose',
          args: [
            fromHex(step.payloadHash), fromHex(ZERO_32), 0n, 0n, 0n, false, fromHex(step.vault),
          ],
        };
      }

      case 'proposeRun': {
        /*
         * **REFUSE EARLY, AND ALL THREE REFUSALS ARE FREE OF SIDE EFFECTS.**
         * `T-324`, `S55`, `S58`. They read `step` alone — nothing `stageChange`
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
        /* The MERGED `propose` (S11): the run path. `isRun` true, opaque hash zero. */
        return {
          address, privateStateId, circuit: 'propose',
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
        return {
          address, privateStateId, circuit: 'closeExpiredRun',
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
          address, privateStateId, circuit: 'approve', args: [fromHex(step.proposalId)],
        };
      }

      case 'cancel': {
        await this.requireOpen(address, step.proposalId, 'cancel');
        return {
          address, privateStateId, circuit: 'cancel', args: [fromHex(step.proposalId)],
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
         * fixed; the branch that would read them is not taken. M-37, M-128.
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
        /* The MERGED `amendSigner` (S11), seating direction: `removing` false. */
        return {
          address, privateStateId, circuit: 'amendSigner',
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
         * DISAGREED. `T-200` `P2`, `S46`.** `setVaultThreshold` below refused
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
          address, privateStateId, circuit: 'setThreshold',
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
          address, privateStateId, circuit: 'setVaultThreshold',
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
         * The MERGED `amendSigner` (S11), unseating direction: `removing`
         * true; `intoVacatedSlot` is ignored on this path and passed false.
         */
        return {
          address, privateStateId, circuit: 'amendSigner',
          args: [fromHex(step.removedLeaf), fromHex(step.proposalId), false, true],
        };
      }
    }
  }

  /**
   * Has any slot been vacated by a removal? M-106.
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
   * `ConfidentialAccount.compact:1508-1509` refuses a founding leaf that is
   * `default<Bytes<32>>` or `vacantSlot()`; `:1859-1860` refuses the same two
   * for a leaf being seated by `amendSigner`. **Both were unmirrored**, so
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
   * source rather than inherited (rule 23). `T-279`.
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
        `${what} is thirty-two zero bytes, which the contract refuses: it is the value an `
        + 'empty slot reads as, so a seat holding it is a seat nothing can ever prove. '
        + 'ConfidentialAccount.compact:1508-1509, :1859-1860.');
    }
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    if (leaf === toHex(pureCircuits.vacantSlot())) {
      throw new Error(
        `${what} is the vacancy marker itself, which the contract refuses: the tree uses it `
        + 'to mean THIS SLOT IS EMPTY, so seating it makes a slot that is simultaneously '
        + 'taken and free. ConfidentialAccount.compact:1508-1509, :1859-1860.');
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
   * Is this proposal open on chain? M-128.
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
   * `stageState`, `checkAfter` AND `viewDigestAfter` STOOD HERE. `C292`, `S26`.
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
   * `C292`: the blob is filed under `viewDigestOf([])`, one constant. The new
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

  describe(): string {
    return `Midnight ${this.cfg.networkId} via ${this.cfg.nodeUrl}, fees sponsored`;
  }

  /* ---------------- internals ---------------- */

  /*
   * `leafOf` STOOD HERE AND IT IS REMOVED, NOT LEFT UNUSED. `C334`.
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
   * (`M-107`, `C328`, `T-116`), and `src/core/signer-leaf.ts:181-190`'s
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
   * `stageView` STOOD HERE. `C292`, `S26`.
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
   * balance ledger (`C292`); decision 0004 binds what is left.
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
   * and `S27` corrected it (`T-62`)** — it is executable text a customer is
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
    // from the account this stage is for, never inherited. C228.
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
      // key from it. M-125. It was BOTH ends of a round until `C292` removed
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
  private async connect(address: string) {
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
   * type is untyped here. M-28.
   *
   * `args` is `unknown[]`, which is how `execute` came to be called with an
   * argument it did not take. The arity is checked below so that mistake
   * fails immediately, with the circuit named, rather than inside the SDK.
   */
  private async buildCall(address: string, circuit: string, args: unknown[]) {
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
    const contract = await this.connect(address);
    const call = (contract.callTx as any)[circuit];
    if (typeof call !== 'function') {
      throw new Error(`the deployed contract has no circuit "${circuit}"`);
    }
    // Arity is checked against the CONTRACT's declared ABI, not against this
    // wrapper's signature.
    //
    // The first version of this guard read `call.length`, which is always 0:
    // every generated circuit function is `(...args) => {…}` and a rest
    // parameter contributes nothing to Function.length. So it never fired, and
    // the exact M-27 mistake would have sailed through it. The test missed it
    // because the stub was also written with `(...args)`. A test built from the
    // same wrong model as the fix cannot catch the model. M-38.
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
    /* `T-220`, `S52`. The two `docs/accepted-risks.md` §1's detector needs. */
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
     * THAN RETURNING A STATUS WITH A ZERO IN IT.** `C188`.
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
    // and `execute`, which this sentence used to name, are both gone. `C292`.
    return {

      /*
       * NO ASSETS, AND THIS IS READ OFF THE CONTRACT RATHER THAN ASSUMED.
       * `C292`.
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
       * anything that gets compared has to be stable. M-128.
       *
       * **THE APPROVAL COUNT COMES THROUGH `mapField` TOO, AND UNTIL `S6c` IT
       * DID NOT.** `C188`. `R5b` guarded three of the contract's four maps and
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
       * callers and is gone (`C292`), which is why this sentence used to name
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
       * `C172`. `thresholds` is an `export ledger` map
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
       * is `C188` exactly. Found by S35c's `test-auditor` and its
       * `money-safety-auditor`, independently. What it costs unguarded is not a
       * crash: `?? 0n` is the repair anybody reaches for, and a seat count of
       * zero makes this client believe the M-37 bootstrap window is open, refuse
       * every threshold change and refuse every removal — the contract still
       * refuses correctly, and OUR refusals stop refusing.
       */
      signerCount: setSize(parsed, 'signerLeaves'),
      /*
       * **THE TWO FIELDS `docs/accepted-risks.md` §1's DETECTOR NEEDS, AND THE
       * ONLY REASON EITHER IS READ.** `T-220`, `S52`. `SC10` measured that
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
       * retired* (`C362`) and the marker value it stores carries nothing else.
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
 * `assetBalances` went with the balance ledger (`C292`), which is a map
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
 * iterator, and `lookup` is how a count is fetched for one proposal. `C188`.
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
 * ONE WE MEANT TO INSTALL. `C354` `P0`, board row `2y9-1`, `S61`.
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
 * **`C393`, MEASURED RATHER THAN TAKEN FROM THE BRIEF, AND IT IS BROADER THAN
 * THE BRIEF SAYS.** `S61`'s brief warns that a new TEST file makes the generated
 * doc set stale. It is not about tests: `docs/design/ledger-fields.md:78` and
 * `docs/design/edges.json`'s `clientFilesScanned` record the NUMBER OF FILES
 * SCANNED under `src`, `scripts` and `contracts/test`, so **any new file in
 * those trees turns the gate red** — a source module exactly as much as a test.
 * Measured: adding two files moved `298` to `300` and `scripts/doc-freshness.ts`
 * refused. And it refuses in `globalSetup`, so it does not merely make
 * `TEST.command` refuse — **it stops every named-file `vitest` run**, which is
 * the only measuring instrument rule 3 leaves a round. A new file would have
 * cost this round the red measurement `§6` requires. So this is appended to an
 * existing file, at its END, where it moves no line: `src/midnight/ledger.ts`'s
 * last `docs/design/edges.json` locator is `:1672`.
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
 * interface OFF for that contract, permanently** (`SC6b`). Under a committee no
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
 *      three — three were measured. Caught by `S61`'s `money-safety-auditor`;
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
 * **`anyone` EXISTS BECAUSE `S61`'s `money-safety-auditor` CAUGHT THIS ROUND
 * REPORTING THE MOST DANGEROUS VALUE ON CHAIN WITH THE NAME OF THE SAFEST.**
 * A threshold of ZERO is not *unmaintainable*: `verify.rs:1789` is
 * `if self.signatures.len() < authority.threshold as usize`, and it is the ONLY
 * read of `threshold` in the whole ledger crate — so at `0`, `0 < 0` is false, a
 * maintenance update carrying NO SIGNATURES AT ALL is well-formed, and the
 * verification loop at `:1775` never runs, so committee membership is never
 * consulted either. **Anybody in the world can rewrite that contract's rules.**
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
   * IT LOOKS LIKE.** Raised by `S61`'s `platform-fact-checker`, as a READING of
   * `midnight-src/midnight-ledger/` at 8.2.0-rc.1 and not a measurement.
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

const isAuthorityKey = (k: unknown): k is AuthorityKey =>
  !!k && typeof k === 'object' &&
  typeof (k as AuthorityKey).tag === 'string' && typeof (k as AuthorityKey).value === 'string';

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
       * NEAR-MISS.** `S61`'s `money-safety-auditor` found that a `0` typed into
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
          `a maintenance authority at threshold ${choice.threshold} is not a committee: at a ` +
            'threshold below one, `verify.rs:1789` accepts a maintenance update carrying NO ' +
            'SIGNATURES AT ALL and never consults the committee, so ANYBODY can rewrite this ' +
            'contract\'s rules. This refuses rather than comparing it against the chain.',
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
