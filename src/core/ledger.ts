/**
 * THE BOUNDARY.
 *
 * Everything above this file is the real product. Everything Midnight-specific
 * lives behind the interfaces declared here, and nothing in core/account.ts,
 * core/payroll.ts or the API needs to know which implementation is running.
 *
 * THERE ARE THREE INTERFACES: Ledger, ProofSystem and CommitmentScheme (below,
 * with its own header). `src/wiring/selection.ts` chooses the ledger, the proof
 * system and the commitment scheme together and offers no way to choose them
 * apart, because the simulated commitment scheme under a real ledger would make
 * leaves and commitments the contract cannot read, with nothing failing until a
 * proof is attempted on chain. This module is imported by the browser entry
 * points, so a Midnight entry has to reach `src/midnight/` behind a dynamic
 * import or it pulls the SDK's WebAssembly into the page. The Midnight
 * scheme is `MidnightCommitments` in `src/midnight/commitments.ts`, declared
 * `CommitmentScheme` so the compiler checks every member against the
 * interface; it calls the generated pure circuits `signerLeaf`, `assetKeyOf` and
 * the rest.
 *
 * What is honest in the simulation:
 *   - shielded state really is encrypted (AES-256-GCM) and the server never holds
 *     the viewing key
 *   - commitments really are content-addressed hashes
 *   - approvals really are ed25519 signatures, verified against the signer set
 *   - the proof system really evaluates the predicate against the private witness
 *     and refuses to issue an attestation when the statement is false
 *
 * What is NOT honest, and must be replaced:
 *   - proofs are HMAC attestations from a trusted prover, not zk-SNARKs. They are
 *     neither zero-knowledge nor succinct, and they assume the prover is honest.
 *     In production these become Compact circuits run through the proof server.
 *   - settlement is a local record, not consensus. No finality, no reorg, no fees.
 *   - there is no DUST accounting. Fee sponsorship for contract-owned accounts is
 *     one of the two unresolved questions and is deliberately not faked here.
 */
import type { Vouched } from '../midnight/record-tree.js';
import { hmac } from '@noble/hashes/hmac.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { WiringName } from './provenance.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Sealed, Hex } from './crypto.js';
import { canonical, toHex, randomBytes, utf8, fromHex as fromHexKey } from './crypto.js';
import type { AssetId } from './assets.js';

/**
 * A transaction handed to the chain: its reference and when. `transactionHash`
 * is set only when the transaction that was sent is not the one the caller
 * handed over (the fee was paid again with a fresh proof after the node
 * refused the first), so the caller watches the hash that can land.
 */
export interface TxRef { ref: string; at: string; transactionHash?: string | null; }

export interface LedgerRecord {
  commitment: Hex;
  sealedState: Sealed;
  updatedAt: string;
}

/**
 * A sealed state, and which viewing key sealed it.
 *
 * The epoch travels with the ciphertext because **the commitment does not
 * identify it.** The value a blob is filed under is `viewDigestOf([])`, ONE
 * CONSTANT for every account and every state, so it distinguishes nothing at
 * all, and the same state sealed under two keys would be filed under one name.
 * The epoch is what names the key a blob opens with.
 */
export interface SealedStateAt {
  keyEpoch: number;
  sealed: Sealed;
}

/* ------------------------------------------------------------------ *
 * the shape of a state change
 * ------------------------------------------------------------------ */

/**
 * The CHANGE a proposal makes, rather than the state it results in.
 *
 * The first fix bound the resulting state, which closed the hole and opened a
 * smaller one: money arriving between the last approval and the execute was
 * silently discarded, because the approved result had been computed before it
 * existed. The only safe response was to refuse deposits during a round —
 * friction sitting directly on the main path, since companies fund an account
 * and then run payroll.
 *
 * A change is relative, so it does not depend on any balance at all — the
 * argument the contract still makes at `propose`. A deposit into the vault
 * mid-round becomes harmless.
 */
export interface StateChange {
  /**
   * WHICH ASSET MOVES. The contract binds it inside `changeCommitmentOf`;
   * this field is the same fact on this side of the boundary.
   *
   * Nothing opens that commitment, so the asset inside it is written and never
   * compared. What refuses a payment in another token is the token inside
   * `payoutDetails`, inside the leaf, inside the approved root, inside the
   * proposal's id; the contract says the same thing over `changeCommitmentOf`
   * and `assetKeyOf`.
   */
  asset: AssetId;
  /**
   * How much leaves the account, in `asset`'s smallest unit.
   *
   * Zero where nothing moves, which is every governance round.
   */
  amount: bigint;
  /** Digest over the entries this change appends to the log. */
  batchDigest: Hex;
  /**
   * The proposal's blinding factor.
   *
   * Generated once at propose time and carried, because it is the PROPOSAL'S
   * salt: `proposalIdOf(payloadHash, vault, salt)` is what every governance
   * circuit and `recordPaymentFromVault` recompute to prove they were handed
   * the proposal the signers approved, so a device without it cannot name the
   * round at all. It travels in the sealed payload, which is how every shared
   * secret moves here.
   */
  salt: Hex;
  /**
   * **WHAT A PAYROLL RUN'S SALT IS MADE FROM**, sealed beside the salt: the head
   * of the company's records its raiser checked and a random value. Every
   * payroll run's salt is the account's `retrySaltOf(leg, fresh)`, its fresh
   * half made from these wherever it is needed (`vouchedFreshOf`), the leg none
   * for a leg of a run and the root of the leg it pays again for a retry. The
   * proposal is the one record that holds them. Absent on every other proposal.
   */
  vouched?: Vouched;
}

/**
 * The caller's view of ONE ASSET before a transition.
 *
 * No method on this boundary takes one, so this type has no reader. It is kept
 * as the shape a vault-side view will need and constrains nothing today.
 *
 * It would be passed across the boundary rather than remembered by the
 * implementation, because the caller has just opened the sealed blob, which is
 * the one source of truth. Movements are an append-only set on chain, and
 * inserting into a set requires reading nothing, so no transition carries a
 * running log.
 */
export interface StateView {
  /** The asset this call concerns. */
  asset: AssetId;
  /**
   * The account's asset blinding, so the implementation can derive the key a
   * change commitment names.
   *
   * Travels on every call rather than being held, because it lives in the
   * sealed state and only a key holder can read it — the ledger cannot fetch it
   * for itself, and a copy it kept would be one more thing to go stale.
   */
  assetBlinding: Hex;
}

/**
 * What the chain says publicly about an account's approval round.
 *
 * Every field here is public in the Compact contract by design — the threshold
 * and the approval count are what make an account auditable without revealing
 * who approved or what was approved (decision 0003). Exposing them on the
 * boundary is therefore not a leak; it is the product.
 */
export interface LedgerStatus {
  /**
   * One entry per asset held.
   *
   * Always empty, on both implementations: the account keeps no books, so
   * there is nothing to report. `SimulatedLedger.status` and
   * `MidnightLedger.status` each answer with a literal `[]`. The field stays
   * because it is the shape both implementations answer in, and because the
   * Midnight one reads that absence off the chain rather than assuming it.
   *
   * An entry's `key` is opaque and not an asset code: on Midnight it is
   * `assetKeyOf(assetId, accountBlinding)`, so only somebody holding the
   * blinding could say which asset an entry is. What is public, in the same
   * class as `signerCount`, is how many assets there are.
   */
  assets: Array<{ key: string; commitment: Hex }>;
  /**
   * EVERY PROPOSAL CURRENTLY OPEN, not "the" open one.
   *
   * This was `proposalOpen: boolean`, `proposal: Hex | null`,
   * `proposedChange: Hex | null` and `approvalCount: number` — one set of
   * fields, because an account could hold exactly one proposal. Payroll and a
   * vendor invoice queued behind each other, and settling either burned every
   * approval on the account.
   *
   * `id` is the proposal's blinded commitment, which is what the contract keys
   * on and what every approval binds to. `approvals` is public on chain and is
   * what makes M-of-N auditable while it is still happening.
   */
  openProposals: Array<{ id: Hex; change: Hex; approvals: number }>;
  /**
   * The account's own threshold — the bar for everything that concerns NO
   * vault, and the bar every vault inherits until somebody gives it another.
   */
  threshold: number;
  /**
   * **ONE ENTRY PER VAULT SOMEBODY DELIBERATELY GAVE ITS OWN RULE, AND NO
   * OTHERS.** Mirrors `thresholds: Map<Bytes<32>, Uint<64>>` at
   * `contracts/src/ConfidentialAccount.compact`.
   *
   * **ABSENCE MEANS INHERIT** (`thresholdFor`), which is what lets a
   * new vault work with no setup at all. A row per vault holding the account's
   * own number is NOT the same state and must never be written: it is a set of
   * deliberate exceptions that happen to agree today, and the day the account's
   * threshold moves they stop agreeing while the map goes on saying the old
   * number. Nothing above this boundary keeps a copy of any of it — the map is
   * read here or it is not known.
   *
   * Public on chain by design, in the same class as `threshold` and
   * `signerCount` (decision 0003): the number of exceptions and their values
   * are visible to anybody reading the contract's state, and putting them on
   * this boundary is therefore not a leak. It is the whole argument for
   * deleting a server-held exception — the rule is SEEN rather than trusted.
   *
   * Empty on every account until a governed `setVaultThreshold` lands, which is
   * the state every account is in today.
   */
  vaultThresholds: Array<{ vault: Hex; threshold: number }>;
  /**
   * How many signers are seated. Public on chain, and on the boundary because
   * a threshold can never be set above it.
   *
   * **ON THE MIDNIGHT LEDGER THAT WINDOW IS NEVER OPEN** — the constructor
   * founds every account at one seat and one approval and nothing can push the
   * threshold above the seat count.
   * `SimulatedLedger` still opens accounts at whatever threshold it is given,
   * so the two ledgers genuinely differ here, and this field is how each one
   * answers for itself rather than being told.
   */
  signerCount: number;
  /**
   * **HOW MANY PAYMENTS THE ACCOUNT HAS RECORDED AS COMPLETED, ACCOUNT-WIDE.**
   * The contract's `movements` (`contracts/src/ConfidentialAccount.compact`,
   * a `Set<Bytes<32>>` of payee leaves).
   *
   * It is here for one consumer that is not built: the detector the accepted
   * *accept and detect* position owes, which compares Σ`payments` across the
   * account's vaults against this number. Without this field and
   * `retiredVaults` below on this boundary that detector could not be written,
   * and *detect* is the whole of the mitigation.
   *
   * **A COUNT AND NOT THE LEAVES, DELIBERATELY.** The comparison the ruling
   * describes is between two magnitudes; the leaves would be an unbounded read
   * of a set that nothing anywhere removes from. The generated reader CAN
   * enumerate it — `contracts/managed/contract/index.d.ts` gives `movements` a
   * `[Symbol.iterator]` over the already-decoded state — so anything that later
   * needs the leaves themselves can have them without a contract change. **What
   * an indexer returns for a very large set at scale is not something this
   * repository can settle, and this sentence is where that is admitted rather
   * than assumed.**
   *
   * `SimulatedLedger` answers 0: nothing in that class writes `movements`. So
   * this field is real on the Midnight side and a constant on the simulated
   * one, which is `LedgerStatus.assets`' shape, and is named here so nobody
   * reads a zero as evidence; a detector cannot run on the simulated ledger.
   */
  movementCount: number;
  /**
   * **EVERY VAULT THIS ACCOUNT HAS EVER RETIRED.** The KEYS of the contract's
   * `retiredAt` (`contracts/src/ConfidentialAccount.compact`, a
   * `Map<Bytes<32>, Uint<64>>`).
   *
   * **EVER RETIRED, NOT IS RETIRED, AND THE DIFFERENCE MATTERS.** Nothing in
   * the contract removes from this map — `retireVault` is its only writer
   * and it inserts a marker — so presence of the key is the whole
   * answer and the VALUE is not carried here. A boundary that reported *is
   * retired* would be answering a question the chain does not hold.
   *
   * It is the pair with `movementCount` that matters, not either alone. A
   * detector needs the vault list from the product's own record rather than
   * from the contract's `vaults` set, which can lose a funded vault that is
   * still paying out, and it needs to know which of those the account has
   * retired. This field answers the second half; `vaults` is deliberately not
   * on this boundary.
   *
   * `SimulatedLedger` answers `[]`: that class models no retirement of any
   * kind, there is no `retireVault` on the `Ledger` interface and no
   * retirement state on `SimAccount`. Same as `movementCount` above.
   */
  retiredVaults: Hex[];
}

/**
 * **THE BAR FOR ONE VAULT: ITS OWN IF SOMEBODY SET ONE, THE ACCOUNT'S
 * OTHERWISE.** One definition, mirroring `thresholdFor` at
 * `contracts/src/ConfidentialAccount.compact`:
 *
 *     thresholds.member(vault) ? thresholds.lookup(vault) : threshold
 *
 * **A TERNARY AND NOT A `??` OVER A DEFAULTED LOOKUP**, for the same reason the
 * contract says it is a ternary and not an `||`: the question is whether the
 * map HOLDS this vault, and a lookup that answers `0` or `undefined` for both
 * "absent" and "set to zero" merges the two states this rule is made of. Zero
 * can never be in the map — the contract refuses to insert it and so
 * does `SimulatedLedger.setVaultThreshold` — but the shape must not depend on
 * that being true somewhere else.
 *
 * `noVault()` is never a key in the map, because it is a hash of a domain
 * string that no vault address can equal, so this returns the account's own
 * threshold for every governance proposal by construction rather than by a
 * branch anybody has to remember. The contract makes the same argument and
 * splits its two entry points on it (`requireApproved`, `requireApprovedForVault`).
 *
 * This number is read to REPORT and to SET A STATUS, never to decide: it goes
 * through `approvalsOnChain` into `account.ts`'s `satisfied`/`short`, which
 * turn it into `status = 'approved'`, while `SimulatedLedger.requireApproved`
 * judges a governance round by the account's own threshold.
 * `recordPaymentFromVault` has no method on the `Ledger` interface: its caller
 * is the vault on chain, and the client's door is `VaultLedger.payout`.
 */
export const thresholdFor = (status: LedgerStatus, vault: Hex): number => {
  const own = status.vaultThresholds.find(v => v.vault === vault);
  return own ? own.threshold : status.threshold;
};

/**
 * Who is acting.
 *
 * Deliberately just an id and a leaf. The secret material a real call needs —
 * `localSecretKey` and `signerBlinding` — is *witness* data: on Midnight it is
 * read from the calling device's own private state store and never travels as a
 * function argument. Putting it in this type would invent a shape the protocol
 * does not have, and would tempt the server into holding it.
 *
 * The leaf is here because it is the public half of membership: it is what the
 * signer tree holds, so it is what an implementation can check without secrets.
 */
export interface SignerRef {
  signerId: string;
  /** The signer's blinded leaf, as the on-chain tree holds it. */
  leaf: Hex;
}

/** What it takes to bring an account into existence on a ledger. */
export interface AccountOpening {
  /**
   * The blinded leaves of the founding signers.
   *
   * `[0]` is the founding signer, the one seat the constructor creates. The
   * constructor takes that leaf as a public argument and calls none of the
   * three identity witnesses, so the deployer is not a signer.
   *
   * **NO SECOND FIELD, DELIBERATELY.** A `foundingSignerLeaf` beside this array
   * would be the same answer written twice, held in step by a comment, which is
   * two derivations of one fact. The first element is the founding signer.
   *
   * The two implementations treat the rest differently. `SimulatedLedger.open`
   * seats every leaf. `MidnightLedger.open` can seat exactly one, the
   * constructor's, because every seat after it is taken by `seatInvited`, from
   * the invitee's own wallet on an invitation an existing signer raised, and
   * the deploy holds no signer's material. So it REFUSES an opening naming more
   * than one rather than seating the first and dropping the rest, which would
   * leave a roster saying three signers and a chain holding one.
   *
   * **AN EMPTY ARRAY IS AN ACCOUNT THAT IS DEAD ON ARRIVAL**, because
   * an invitation needs an existing signer to raise it and there would be none
   * to add the first. Both implementations refuse it: `SimulatedLedger.open` through
   * its threshold check, `MidnightLedger.open` by name.
   */
  signerLeaves: Hex[];
  threshold: number;
  /**
   * **THE COMPANY'S LABEL**, which the account's constructor writes into the
   * account so it is on the chain for as long as the account is. Drawn by the
   * founding signer's wallet and never by this service. A chain refuses to open
   * an account without one; the simulated ledger records none.
   */
  companyLabel?: CompanyLabel | null;
  /**
   * NOTHING TO OPEN AT. An account holds no assets, ever, so there is no
   * balance to seed, and no entry-log digest either, not since the log became a
   * set.
   */
  /**
   * The account's asset blinding, generated once and never made again.
   *
   * A change of the company's key keeps it: every change commitment already
   * approved names its asset as `assetKeyOf(assetId, this)`, so changing it would make a
   * run one signature from settling impossible to present at a vault.
   */
  assetBlinding: Hex;
  sealedState: SealedStateAt;
}

/**
 * THE LIFECYCLE.
 *
 * The previous version of this interface had one write method. That was a
 * faithful model of `SimulatedLedger` and an impossible model of Midnight, where
 * moving the state is the *last step of an approval round* and is only legal
 * once a proposal is open and has reached its threshold.
 *
 * The methods below are one-to-one with the contract's circuits, so an
 * implementation has nothing left to invent, and so a caller that works against
 * the simulation is driving the same sequence it will drive against the chain.
 *
 * Every method here has a circuit behind it. A method added without one is
 * refused by name by the Midnight implementation, so the gap surfaces at once
 * and not as a mystery at deploy time.
 */
/**
 * **WHERE AN ADDRESS CAME FROM.**
 *
 * `'chain'` means a chain assigned it and we read it back. `'simulated'`
 * means THIS PROCESS INVENTED IT — thirty-two random bytes in the spelling a
 * contract address has, which is exactly why the shape cannot tell them apart.
 */
export type AddressSource = 'chain' | 'simulated';

/**
 * **AN ADDRESS AND WHERE IT CAME FROM, AND THEY TRAVEL TOGETHER.**
 *
 * The provenance is not a second method and not a second field to remember. A
 * ledger cannot hand out an address without saying where it got it, because the
 * only way to obtain one is to obtain this — **so the source is written at the
 * same moment the address is, by construction rather than by discipline.**
 *
 * `SimulatedLedger` mints an address the shape check accepts, so a refusal for
 * a company with no address could never fire on it unless the source says the
 * address was invented. A separate `addressSource()` call would leave the same
 * gap: a caller that reads the address and forgets to ask.
 */
export interface LedgerAddress {
  readonly value: string;
  readonly source: AddressSource;
}

/**
 * **A PAYROLL RUN, AS THE CHAIN IS ASKED TO OPEN ONE.**
 *
 * Exactly the run branch's arguments at
 * `contracts/src/ConfidentialAccount.compact`, in the same order, so
 * an implementation has nothing left to invent — the rule the lifecycle note
 * above states for every other method on this interface.
 *
 * **`opensAt` AND `closesAt` ARE SECONDS SINCE THE UNIX EPOCH, NOT
 * MILLISECONDS**, because `blockTimeGte`/`blockTimeLt` compare against block
 * time. A millisecond window builds a run that opens in
 * the year 56000, is approved, and pays nobody — refused by both
 * implementations before a fee rather than discovered on payday.
 *
 * **`vault` IS REQUIRED AND IS NOT `noVault()`.** A run is FOR a vault: the
 * vault is folded inside the proposal's identity (`proposalIdOf`) and
 * `recordPaymentFromVault` is handed it and recomputes the id from it.
 * An approval raised for one vault is not a rejected id at another, it is a
 * different id entirely, matching nothing.
 */
export interface RunProposal {
  /** The payout tree's root. The chain never sees a payee. */
  root: Hex;
  /** How many leaves the tree has. Bound into the payload, so a run cannot be declared finished early. */
  payees: bigint;
  opensAt: bigint;
  closesAt: bigint;
  vault: Hex;
  /**
   * The approvals the run's total needs under its vault's spending policy, bound
   * into the payload so it cannot change after approval. Absent is zero: the
   * vault's own bar and nothing more. A vault under a policy refuses to charge a
   * run raised with fewer than its band needs.
   */
  required?: bigint;
}

/**
 * **WHICH OF A RUN'S PAYEES THE ACCOUNT HAS RECORDED A COMPLETED PAYMENT FOR.**
 *
 * The account records one blinded value per completed payment, derived from the
 * payee's leaf by a rule the contract owns. Asking whether one payee's leaf is
 * among them is a membership test. Asking for the whole set is a different
 * question and this is not it.
 *
 * **BOUNDED BY THE CALLER'S OWN LIST, WHICH IS THE WHOLE DESIGN.** The set is
 * append-only and nothing anywhere removes from it, so it grows for the life of
 * the account and reading it whole is a read nobody can size in advance. A run
 * asks about its own payees and nothing else, so what this costs is the size of
 * the run rather than the age of the company.
 *
 * **AND THE DERIVATION HAPPENS BELOW THIS BOUNDARY RATHER THAN ABOVE IT.** The
 * rule that turns a payee's leaf into the value the account records is the
 * contract's own, and an implementation of this interface is the only layer
 * that holds both that rule and the set. A caller deriving the value itself
 * would be a second definition of the one fact that decides whether somebody
 * has their salary.
 */
export interface PaymentsAmong {
  /**
   * **WHETHER THIS LEDGER CAN ANSWER THE QUESTION AT ALL.**
   *
   * **FALSE IS NOT "NOBODY WAS PAID", AND THE TWO MUST NEVER REACH A SCREEN IN
   * THE SAME SHAPE.** A ledger that records no payments answers false, and its
   * silence is then an absence of knowledge rather than a statement about
   * people. Rendered the other way round it is the worst sentence this product
   * could print: a hundred people shown as still owed money on a run that paid
   * every one of them.
   */
  known: boolean;
  /**
   * The subset of the leaves asked about that the account holds a completed
   * payment for, in the order they were asked about.
   *
   * **ALWAYS EMPTY WHEN `known` IS FALSE, AND EMPTY THEN MEANS NOTHING.** A
   * caller that reads this array without reading `known` first has an answer
   * about nobody.
   */
  paid: Hex[];
}

export interface Ledger {
  /** Brings the account into being. On Midnight, deploying the contract. */
  open(accountId: string, opening: AccountOpening): Promise<TxRef>;

  /**
   * **THE COMPANY'S OWN ADDRESS, AS THE LEDGER ASSIGNED IT.**
   *
   * Null when this ledger has no such account, and null is not an error: an
   * account with no contract has no address, and a caller that needs one has to
   * say so rather than invent a stand-in. **Nothing above this interface may
   * mint this value.** It is asked for once, when the account is opened, and
   * copied onto the durable record — because the key that opens the company's
   * keyring is derived from it and from nothing else, so an address that
   * changes is data that stops opening.
   *
   * **AND IT SAYS WHETHER A CHAIN ASSIGNED IT.** The two
   * arrive together because the shape of a simulated address is deliberately
   * the shape of a real one, so nothing downstream can work it out for itself.
   */
  address(accountId: string): Promise<LedgerAddress | null>;

  /** The public lifecycle state. Null when the account is not on this ledger. */
  status(accountId: string): Promise<LedgerStatus | null>;

  /**
   * **WHICH OF THESE PAYEES HAVE BEEN PAID, ANSWERED BY THE LEDGER.** Null when
   * the account is not on this ledger, exactly as `status` above is null.
   *
   * `leaves` are a run's payout leaves, in the order the run's tree was built.
   * They are not secret to the company and are not on chain — the tree travels
   * as a root — so they come from the company's own record of the run, and the
   * answer that comes back is about exactly those people and no others.
   *
   * **IT IS A READ AND IT MUST STAY ONE.** Nothing here decides whether a
   * payment may be made, and nothing above it may use this answer as an
   * authorisation: the contract is what refuses a payee who has already been
   * paid, and a client that gated on this instead would be a second opinion
   * about the one thing the chain is authoritative on.
   */
  paidAmong(accountId: string, leaves: Hex[]): Promise<PaymentsAmong | null>;

  /**
   * **WHICH OF THESE NONCES THE ACCOUNT HAS RECORDED A PAYMENT FOR**, answered
   * by the ledger, in the shape `paidAmong` answers in. A nonce stands for one
   * person, month, kind of pay and occurrence, and the account records a value
   * made from it beside each payment's leaf. Null when the account is not on
   * this ledger. **A read, never an authorisation**, for `paidAmong`'s reason.
   */
  paidOnceAmong(accountId: string, nonces: Hex[]): Promise<PaymentsAmong | null>;

  /**
   * **WHETHER THE ACCOUNT'S SIGNER SET HOLDS THIS LEAF NOW**, read from the
   * chain, or null when the account is not there to ask. A seat a signer's
   * device sends is written on the record only once this says yes, because the
   * door it goes through can tell which circuit it calls and not which leaf it
   * seats.
   */
  holdsSigner?(accountId: string, leaf: Hex): Promise<boolean | null>;

  /**
   * Opens a round. The chain receives a commitment to the payload, never the
   * payload — and a commitment to the CHANGE as well.
   *
   * `change` is here because approving an instruction is not the same as
   * approving its effect. Without it, the signer who called `execute` picked
   * the next state on their own and the approvals meant nothing.
   *
   * Nothing on chain opens that commitment. It is generated once, here, and
   * carried in the sealed payload, because the proposer's own post-check
   * recomputes it against what the chain recorded and because the salt inside
   * it is the proposal's identity. Nothing on chain compares an approved change
   * to what was done with it.
   */
  /**
   * `vault` is required and has no default. It matches the circuit
   * `export circuit propose(…, vault: Bytes<32>)`,
   * `contracts/src/ConfidentialAccount.compact`, and this interface is
   * one-to-one with the circuits by design.
   *
   * The vault is committed INSIDE the proposal's identity (the contract's
   * `proposalIdOf`), so it is not a label on the proposal: it is part of what
   * the proposal IS. An approval raised for one vault is not a rejected id at
   * another, it is a different id entirely, matching nothing.
   *
   * A caller that concerns no vault passes `CommitmentScheme.noVault()` and
   * says so. It is not defaulted, because a default is a value nobody chose
   * arriving in the field that decides how many approvals the proposal needs.
   *
   * `raiseBy` is the circuit's `deadline`: the block time, in seconds, from which
   * the raise is refused (`raiseByOf` in `proposal-filing.ts`, from the time the
   * proposal was written down). A ledger on the chain refuses a raise without
   * one; this interface's simulated ledger has no block time and only carries it.
   */
  propose(
    accountId: string, payloadHash: Hex, change: StateChange, by: SignerRef, vault: Hex, raiseBy?: bigint,
  ): Promise<TxRef>;
  /**
   * Raises a change to the company as the account's `proposeCompanyChange` circuit does: the
   * proposal names no vault, opens no payment window, and is stored with a fixed mark in place
   * of a change commitment, counting the raiser's approval. `salt` is the proposal's own, and
   * its id is the one `propose` gives the same payload, salt and `noVault()`. `raiseBy` is as
   * `propose`'s. Optional: a ledger that cannot raise one this way raises it through `propose`.
   */
  proposeCompanyChange?(
    accountId: string, payloadHash: Hex, salt: Hex, by: SignerRef, raiseBy?: bigint,
  ): Promise<TxRef>;

  /**
   * Raises a payroll run, a different act from `propose`. Mirrors the RUN
   * branch of the merged circuit, `contracts/src/ConfidentialAccount.compact`,
   * reached by `isRun: true`.
   *
   * `propose`'s `payloadHash` is an APPLICATION digest (`commit(canonical({accountId,
   * kind, sealedPayload, proposedBy}), '')`, `src/core/account.ts`) and its
   * emitted `isRun` is pinned `false` (`src/midnight/ledger.ts`).
   * `recordPaymentFromVault` recomputes `proposalIdOf(runPayload(root, payees,
   * opensAt, closesAt, required), forRun, salt)` and matches only a `runPayload`
   * (in the contract), so a payroll round raised through `propose` would be
   * approved, paid for, and unpayable by any vault, for ever; the governance
   * branch writes no `runWindow` row, so `closeExpiredRun` could not close it
   * either.
   *
   * The five parts are all of the run's identity and none is optional. The id
   * is folded from four of them and the vault; a caller that cannot name one
   * cannot raise a run. `MidnightLedger` post-checks that the chain holds the
   * id it computed, because a run's id is built from four values rather than
   * one and there are therefore four ways to raise a proposal nobody can ever
   * pay against.
   *
   * It returns the id, where `propose` returns only a `TxRef`. The caller
   * cannot recompute it: `runPayload` is the CHAIN's derivation and the salt is
   * inside the change, and a door that made the caller derive the id a second
   * way would hold two derivations of one fact.
   */
  proposeRun(
    accountId: string, run: RunProposal, change: StateChange, by: SignerRef, raiseBy?: bigint,
  ): Promise<TxRef & { proposalId: Hex }>;

  /**
   * One approval per signer PER PROPOSAL.
   *
   * `proposalId` is the proposal's blinded on-chain commitment, and naming it is
   * the whole of the change: an account holds several open proposals at once,
   * and approving payroll is not the same act as approving whatever else
   * happens to be open.
   */
  approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef>;

  /**
   * Withdraws ONE proposal.
   *
   * Every other proposal on the account is untouched, and nobody else's
   * approvals are burned. Nullifiers already spent on this one stay spent,
   * which costs nothing: a re-proposal takes a fresh salt and is a different
   * proposal.
   */
  cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef>;

  /**
   * Removes a signer, by clearing the one slot they occupy.
   *
   * The signer tree is a plain Merkle tree with a slot per signer, so removing
   * somebody touches their position and nobody else's: no generation to
   * advance, no survivors to recompute, and no cap on the approver set.
   *
   * Nobody is named. `removedLeaf` is a blinded commitment that was already
   * published when they were seated, and the caller proves membership exactly
   * as they would to approve a payment.
   */
  removeSigner(accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef): Promise<TxRef>;

  /**
   * Changes M in M of N, on chain.
   *
   * The threshold is a ledger field the circuit rewrites, so the chain and
   * the product's own copy cannot disagree about how many approvals are
   * required.
   *
   * Both directions need the CURRENT threshold behind them. Lowering is not
   * held to a higher standard, because M colluding signers can already reach
   * the same place by removing everybody else one at a time — see the note on
   * the circuit.
   */
  setThreshold(
    accountId: string, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef>;

  /**
   * **GIVES ONE VAULT ITS OWN THRESHOLD, OR CHANGES IT.**
   * Mirrors `setVaultThreshold` at
   * `contracts/src/ConfidentialAccount.compact`.
   *
   * Governance, so it is an approval round like `setThreshold` and is measured
   * against the ACCOUNT's threshold — the proposal behind it concerns no vault
   * (`setVaultThreshold` names `noVault()`), which is why nobody can lower a vault's bar
   * with the vault's own lowered bar.
   *
   * **ZERO IS REFUSED HERE AS WELL AS ON CHAIN** — *"a vault threshold of zero
   * would authorise anything"*. An implementation that relayed it and
   * let the contract refuse would be correct and useless: the refusal has to be
   * reachable before a fee is paid and before anybody signs.
   *
   * **THE CONTRACT BOUNDS IT BY THE SIGNER COUNT**: a vault threshold above
   * the seats is refused on chain, because one above the approvals a policy
   * change needs raises that number to it, and lowering a vault's threshold or
   * raising one past that number needs that many approvals. The Midnight
   * implementation mirrors those refusals before a fee is paid. The application
   * also refuses to raise an unmeetable one, in `AccountService`.
   */
  setVaultThreshold(
    accountId: string, vault: Hex, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef>;

  /**
   * **WHETHER THIS LEDGER TAKES COMPANIES MADE ON THEIR FOUNDING SIGNER'S
   * DEVICE.** True only on a deployment whose companies are made that way: the
   * device seals the first state, signs it as the company's state record, and
   * deploys the account. Absent on every other ledger.
   */
  readonly takesCompaniesFromTheirFoundingSigner?: boolean;

  /** The state as sealed under `keyEpoch`. Null when there is none at that epoch. */
  fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null>;

  describe(): string;

  /**
   * **THE WRITE THIS LEDGER IS WAITING ON, IF IT IS WAITING ON ONE.**
   *
   * Optional, because only an implementation that sends writes somewhere they
   * can stall has anything to say. One that does not implement it is not
   * claiming that nothing is in flight; it is saying nothing. `null` from one
   * that does implement it means nothing is in flight now.
   *
   * It names the kind of write and how long it has been running, and never the
   * company: whoever can read a health check is not thereby entitled to learn
   * which companies are acting.
   */
  writeInFlight?(): WriteInFlight | null;

  /**
   * **SENDS A TRANSACTION A SIGNER'S DEVICE HAS ALREADY PROVED.**
   *
   * The proof is made where the private input lives; what arrives here is the
   * proven, unbound transaction. This balances it and pays its fee through the
   * same parties every other write uses, and submits it. Nothing is proved here.
   *
   * Optional, because only an implementation that can pay fees can send. A
   * refusal that happens before anything is submitted carries the mark that
   * says nothing was sent.
   */
  submitProven?(accountId: string, proven: Uint8Array): Promise<TxRef>;

  /**
   * **THE SAME, FOR A TRANSACTION ABOUT TO BE RECORDED AS ONE PARTICULAR
   * CALL.** Refused, with the mark that nothing was sent, unless it is exactly
   * one call to `circuit` on the company's own contract. Optional for the same
   * reason as above.
   */
  submitProvenCall?(accountId: string, proven: Uint8Array, circuit: string): Promise<TxRef>;

  /**
   * **SENDS A TRANSACTION A SIGNER'S DEVICE BUILT FOR ONE OF THE COMPANY'S
   * VAULTS**: its deploy, its handover to the company's committee, or a deposit
   * the depositor's own wallet has already paid the coins for. `check` reads the
   * transaction and refuses it with a sentence before anything is booked. The
   * fee payer adds only the network fee.
   *
   * Optional, because only an implementation that can pay fees can send.
   */
  sendVault?(
    accountId: string,
    what: string,
    arrival: VaultTxArrival,
    bytes: Uint8Array,
    check: (tx: unknown) => string | null | Promise<string | null>,
    read: (bytes: Uint8Array) => Promise<unknown>,
  ): Promise<VaultTxSent>;

  /**
   * **ADDS ONLY THE NETWORK FEE TO A TRANSACTION A SIGNER'S DEVICE PROVED, AND
   * HANDS IT BACK FINISHED** instead of submitting it, for a company whose calls
   * go through its own service or straight from a person's wallet: that service
   * or that wallet submits it. `check` refuses with a sentence before anything
   * is booked, exactly as for `sendVault`. The fee payer's booking stays until
   * the chain shows the transaction, or its deadline passes with the chain not
   * showing it.
   *
   * Optional, because only an implementation that can pay fees can add one.
   */
  feeAddedTo?(
    accountId: string,
    what: string,
    arrival: VaultTxArrival,
    bytes: Uint8Array,
    check: (tx: unknown) => string | null | Promise<string | null>,
    read: (bytes: Uint8Array) => Promise<unknown>,
  ): Promise<FeeAdded>;

  /**
   * **WHICH IMPLEMENTATION OF THIS BOUNDARY IS ANSWERING, AS A WORD.**
   *
   * `describe()` above is prose for a person and it is free to change; this is
   * the value that gets written onto a record and read back years later, so it
   * is a closed set and nothing formats it.
   *
   * It is on the LEDGER rather than taken from whatever chose the ledger, and
   * that is the whole point of it: a record must be marked by the thing that
   * actually wrote it. A constant somewhere else describing what was meant to
   * be running is a claim; this is an observation, and the address a company is
   * identified by already carries its provenance the same way and for the same
   * reason.
   */
  readonly wiring: WiringName;
}

/** A write that has started and not yet settled, as a person reading a health check sees it. */
export interface WriteInFlight {
  /** What the write is, in the product's words: `opening an account`. */
  readonly what: string;
  /** When it started, as an ISO 8601 instant. */
  readonly since: string;
  /** Whole seconds it has been running. */
  readonly seconds: number;
  /**
   * **TRUE ONCE IT HAS RUN LONGER THAN A WRITE IS EXPECTED TO TAKE.** From then
   * on every later write through the same fee payer is refused rather than
   * queued behind it, and the write itself is left to finish: stopping it
   * would not stop it reaching the chain.
   */
  readonly overdue: boolean;
  /** Later writes queued behind it and not yet refused. */
  readonly waiting: number;
}

export type Circuit = /* NONE of the three exists in either `.compact` — measured, zero occurrences in `ConfidentialAccount.compact` and `Vault.compact`; `MidnightProofSystem.prove` throws for all three, and `SimulatedProofSystem` is symmetric so its verifier must BE its prover. */ 'balance-at-least' | 'payroll-total' | 'payment-record';

export interface ProofSystem {
  prove(circuit: Circuit, publicInputs: Record<string, unknown>, witness: unknown): Promise<Hex>;
  verify(circuit: Circuit, publicInputs: Record<string, unknown>, proof: Hex): Promise<boolean>;
  describe(): string;
}

/* ------------------------------------------------------------------ */

/**
 * A single value standing for what an account holds, for addressing a sealed
 * blob and for telling whether a state-moving job landed.
 *
 * Not a commitment the contract holds, and it must never be treated as one:
 * there is no single state commitment on chain. Both implementations call this
 * with `[]`, so it is ONE CONSTANT, the same for every account and every state.
 * It addresses a blob; it cannot tell two states apart or say that anything
 * moved. Nothing verifies against it, and nothing should.
 *
 * ONE DEFINITION, used by both `SimulatedLedger` and `MidnightLedger`, because
 * a blob filed under one rule and looked up under another is an account nobody
 * can open. It depends only on the public asset list, which both have.
 */
export const viewDigestOf = (assets: ReadonlyArray<{ key: string; commitment: Hex }>): Hex =>
  toHex(sha256(utf8('account-view:' +
    [...assets].map(a => `${a.key}=${a.commitment}`).sort().join(','))));

/**
 * How the simulation identifies an approved change.
 *
 * The contract commits to it under the proposal's salt; here the tuple itself is
 * the key. Same effect — the same three values map to the same identity and no
 * others — without pretending the simulation hides anything, which it does not.
 */
/**
 * What a proposal must commit to for `seatInvited` to accept it: the invited
 * address's commitment, the rights the seat will carry, and the threshold the
 * seat sets once it is taken (0 keeps the one in force).
 *
 * Domain separated from an ordinary payment payload on purpose, and the
 * separator is load bearing: without it, a proposal approved to pay salaries
 * would be a valid authorisation to seat somebody, since both are just "a
 * commitment the signers approved". The SIMULATED half of the contract's
 * `signerInvitePayload`.
 */
const simulatedSignerInvitePayload = (address: Hex, scope: Hex, newThreshold: number): Hex =>
  toHex(sha256(utf8('midnight-accounts:invite-signer:' + address + ':' + scope + ':' + newThreshold)));

/** The SIMULATED half of the contract's `inviteAddressOf`: a commitment to a coin public key under a salt. */
const simulatedInviteAddressOf = (coinPublicKey: Hex, salt: Hex): Hex =>
  toHex(hmac(sha256, fromHexKey(salt), utf8('invite-address:' + coinPublicKey)));

/** The SIMULATED half of the contract's `coinPublicKeyOf`. */
const simulatedCoinPublicKeyOf = (coinSecretKey: Hex): Hex =>
  toHex(sha256(utf8('simulated-coin-pk:' + coinSecretKey)));

/**
 * What a proposal must commit to for `removeSigner` to accept it: the leaf
 * removed and the threshold the removal sets (0 keeps the one in force).
 *
 * Separately domain separated from `signerInvitePayload`, for the same reason
 * that one is separated from a payment: an approval to seat somebody must not
 * double as an approval to remove somebody.
 *
 * The proposal commits to no list of survivors to re-seat: the signer tree
 * clears one slot, so nothing else is supplied and nothing else can be wrong.
 *
 * The SIMULATED half of the contract's `removeAndSetThresholdPayload`, not equal to it.
 */
const simulatedSignerRemovePayload = (removedLeaf: Hex, newThreshold: number): Hex =>
  toHex(sha256(utf8('midnight-accounts:remove-thresh:' + removedLeaf + ':' + newThreshold)));

/**
 * What a proposal must commit to for `setThreshold` to accept it.
 *
 * Domain separated from the add and remove payloads for the same reason those
 * are separated from a payment: an approval to pay a supplier, to seat a signer
 * or to drop one must not double as an approval to change the rule governing
 * all three.
 *
 * The SIMULATED half of the contract's `setThresholdPayload`, not equal to it.
 */
const simulatedSignerThresholdPayload = (newThreshold: number): Hex =>
  toHex(sha256(utf8('midnight-accounts:set-threshold:' + newThreshold)));

/**
 * What a proposal must commit to for `setVaultThreshold` to accept it.
 *
 * The SIMULATED half of `setVaultThresholdPayload` — including its
 * own domain string, separate from `setThresholdPayload`'s. An approval to move
 * ONE vault's bar must not double as an approval to move the ACCOUNT's, and the
 * two are otherwise the same statement about the same kind of number.
 *
 * **THE VAULT IS IN THE PAYLOAD AS WELL AS IN THE PROPOSAL'S IDENTITY, and the
 * duplication is the contract's rather than ours.** The identity binds the
 * vault the proposal is FOR (`noVault()`, because a governance proposal concerns
 * no vault) and the payload binds the vault the proposal is ABOUT. They are
 * different questions with different answers, and folding either into the other
 * would make an approval to raise vault A's bar spend against vault B.
 */
const simulatedVaultThresholdPayload = (vault: Hex, newThreshold: number): Hex =>
  toHex(sha256(utf8('midnight-accounts:vault-thresh:' + vault + ':' + newThreshold)));

/**
 * What the simulated ledger stores beside an open company change: the contract's `companyChangeMark()`, its text's
 * own bytes padded to 32 as the contract's `pad(32, ...)` writes them.
 */
export const SIMULATED_COMPANY_CHANGE_MARK: Hex = (() => {
  const padded = new Uint8Array(32);
  padded.set(utf8('midnight-accounts:company-change'));
  return toHex(padded);
})();


/**
 * Simulated state for one account. Mirrors the contract's public ledger fields
 * one for one, because anything it holds that the contract does not is a place
 * the simulation can succeed where the chain would fail.
 *
 * `signerLeaves` stands in for the `HistoricMerkleTree`, and `spentApprovals`
 * for the contract's `approvals`, its `Set<Bytes<32>>` of nullifiers, with each
 * proposal's own `approvals` standing in for its count. In the contract a
 * nullifier is `approvalNullifier` over the account, the proposal and the
 * signer's secret key, and it hides *which* signer approved; here it is
 * `leaf@proposal`, which does not. That is the one deliberate difference and it
 * is a privacy property, not a rule: both burn once per signer per proposal id
 * for the account's life, so both accept and reject the same sequences.
 */
interface SimAccount {
  signerLeaves: Set<Hex>;
  threshold: number;
  /**
   * WHAT THIS SIMULATION ASSIGNS IN PLACE OF A CONTRACT ADDRESS.
   *
   * Thirty-two random bytes, in the shape and the spelling
   * `encodeContractAddress` produces on the real chain, so the two paths differ
   * in where the value comes from and in nothing else. **It is minted here
   * because in a simulation we ARE the chain** — the same sentence that already
   * covers commitments and proposal ids in this file — and it is handed out
   * once, at `open`, precisely so the caller can write it down somewhere that
   * survives this process. Nothing here is durable: see the class header.
   */
  address: string;
  /**
   * The account's asset blinding.
   *
   * Held so `status()` can report the same opaque keys a real chain would. The
   * simulation keys its own maps by the PLAIN asset code, which is one of two
   * deliberate differences from the contract: on chain nobody can tell which
   * asset an entry is for, here anybody can. It is a privacy property, not a
   * rule — both accept and reject the same sequences.
   */
  assetBlinding: Hex;
  /**
   * Every approval mark ever given on this account, as the contract's `approvals` set: kept across a
   * proposal's close, so a signer who approved a proposal that was withdrawn cannot approve it again
   * when it is raised again with the same salt.
   */
  spentApprovals: Set<string>;
  /**
   * EVERY OPEN PROPOSAL, keyed by its blinded id.
   *
   * A map, so an account holds several open proposals at once: payroll and a
   * vendor invoice queue side by side, and settling one burns no approvals
   * given to the other.
   */
  openProposals: Map<Hex, {
    payloadHash: Hex;
    change: Hex;
    approvals: Set<string>;
    /**
     * **WHICH VAULT THIS PROPOSAL CONCERNS, HELD BECAUSE THE CHAIN CANNOT HOLD
     * IT.**
     *
     * On chain the vault is committed inside the proposal's id and is NOT a
     * field beside it — `openProposals` there is `Map<Bytes<32>, Bytes<32>>`,
     * id to change, and `recordPaymentFromVault` is HANDED the vault and recomputes the
     * id from it (`runIdOf`). So a caller proves which vault a proposal is for
     * by producing an id that matches; it cannot ask the chain.
     *
     * This simulation cannot do that, for the same reason it keeps
     * `payloadHash`: it has no salt at spend time. It keeps the vault it was
     * given at propose time and measures the proposal against that vault's
     * threshold — the same rule, checked the way this layer can check it, and
     * the same accommodation already made one field over.
     */
    vault: Hex;
  }>;
  /**
   * **THE WINDOW OF EVERY OPEN RUN, AND GOVERNANCE ROUNDS ARE NOT IN IT.**
   * The counterpart of the contract's `runWindow`
   * (`contracts/src/ConfidentialAccount.compact`), whose only value-write
   * is in the RUN branch — *"the governance branch below writes none,
   * so a governance proposal has NO ROW in `runWindow` at all"*.
   *
   * **IT IS A SECOND MAP RATHER THAN A FIELD ON `openProposals` FOR EXACTLY
   * THAT REASON.** An optional field on the proposal would make *is this a run*
   * a property every reader has to remember to check; a separate map makes
   * membership the answer, which is the shape the chain has and the shape
   * `cancel` and `closeExpiredRun` read.
   *
   * **WHAT READS IT ON CHAIN AND HAS NO COUNTERPART HERE, SAID OUT LOUD:**
   * `cancel` refuses once a run's window has opened and
   * `closeExpiredRun` refuses until it has closed. Both are
   * `blockTime` comparisons and **this layer has no block time at all**, so
   * neither rule is enforced here. What this map buys today is that a run and a
   * governance round are DISTINGUISHABLE, which is the property whose absence
   * was the defect; the time rules are the chain's until a clock exists at this
   * layer.
   */
  runWindows: Map<Hex, { opensAt: bigint; closesAt: bigint }>;
  /**
   * **THE VAULTS SOMEBODY DELIBERATELY GAVE THEIR OWN THRESHOLD.**
   *
   * A `Map`, mirroring the contract's `thresholds`, and EMPTY on a new account
   * — absence is what "inherit the account's" is made of, so there is no
   * seeding step and nothing to keep in step with `threshold`.
   */
  vaultThresholds: Map<Hex, number>;
  /**
   * Every movement ever settled, as blinded commitments. Append-only.
   *
   * The counterpart to the contract's `movements` set, which replaced a running
   * entry digest — a digest had to be PROVEN before it could be appended to, so
   * two settlements conflicted even when they moved different money.
   *
   * Nothing writes it in this simulation: on chain the writer is
   * `recordPaymentFromVault`, which this layer has no counterpart for. It is
   * initialised empty at `open` and stays empty, so nothing reading it is
   * reading anything.
   */
  movements: Set<Hex>;
  /*
   * One ciphertext per key epoch, not one ciphertext.
   *
   * The same rule the real blob store keeps, and it is here rather than only
   * there so a test cannot pass against behaviour the file store does not have.
   */
  sealedStates: Map<number, Sealed>;
  keyEpoch: number;
  updatedAt: string;
}

/**
 * The lifecycle, locally and without consensus.
 *
 * It enforces the rules rather than recording intentions, so `core/account.ts`
 * cannot drive a sequence the chain would reject and still pass its tests. The
 * simulated and the Midnight ledger refuse the same things:
 *
 *   - acting as someone who is not in the signer set
 *   - approving the same proposal twice
 *   - settling a governance round below the ACCOUNT's threshold
 *   - spending a proposal on a payload other than the one approved
 *
 *
 * What it still does NOT model, and must not be read as modelling: consensus,
 * finality, reorgs, fees, or zero knowledge. It also cannot tell you whether a
 * circuit will *prove* — only whether the sequence is legal.
 */
/**
 * What an invitee's device holds when it takes the seat an approved invitation
 * names: the invitation's proposal, the coin secret key of the address it was
 * invited at with the salt that hides that address, and the public half of the
 * new seat with its blinding and rights. The coin secret key is the wallet's own;
 * on the chain it never leaves the wallet's proof.
 */
export interface InvitedSeat {
  readonly proposalId: Hex;
  readonly coinSecretKey: Hex;
  readonly addressSalt: Hex;
  readonly signerPublicKey: Hex;
  readonly blinding: Hex;
  readonly scope: Hex;
  /** The threshold the invitation sets once the seat is taken; 0 keeps the one in force. */
  readonly newThreshold: number;
}

export class SimulatedLedger implements Ledger {
  /** Nothing this class writes has ever been near a chain, and it says so itself. */
  readonly wiring = 'simulated' as const;
  private accounts = new Map<string, SimAccount>();
  constructor(
    /**
     * Must match the one `AccountService` uses, for the reason in decision 0004.
     *
     * Required, with no default: a default is a SECOND PLACE THE ANSWER CAN
     * COME FROM, one layer below `AccountService`'s. `wiring/selection.ts`
     * passes it explicitly and is the only non-test construction site.
     */
    private commitments: CommitmentScheme,
  ) {}

  /**
   * The scheme this ledger was handed, so identity can be asserted rather than
   * assumed.
   *
   * The pair of ledger and scheme must match, and the constructor's comment is
   * the only place that says so. The product path is closed: `selection.ts`
   * reads `SIMULATED.commitments` off the object rather than naming the class a
   * second time, and `one-wiring-point.test.ts` pins that twice, once over the
   * source text and once over the OBJECT `wiring()` returns. This reader is
   * what lets a test ask a ledger which scheme it holds, so a `createLedger`
   * that builds the right CLASS with the wrong SCHEME fails.
   *
   * It is a reader and not a refusal. Taking the scheme from the same selector
   * would give this class a second place the answer can come from, and refusing
   * a stranger cannot be written honestly: this class has no way to know which
   * scheme is *the* one without being told. `one-wiring-point.test.ts` is where
   * the assertion lives.
   *
   * It is not on the `Ledger` interface, so nothing type-level obliges
   * `MidnightLedger` to answer the same question, and a caller constructing the
   * pair by hand is only checked where somebody writes the check.
   */
  get scheme(): CommitmentScheme {
    return this.commitments;
  }

  async open(accountId: string, opening: AccountOpening): Promise<TxRef> {
    if (this.accounts.has(accountId)) throw new Error('account is already open on this ledger');
    if (opening.threshold < 1 || opening.threshold > opening.signerLeaves.length) {
      throw new Error(
        `threshold ${opening.threshold} is not valid for ${opening.signerLeaves.length} signers`,
      );
    }
    const at = new Date().toISOString();
    this.accounts.set(accountId, {
      signerLeaves: new Set(opening.signerLeaves),
      threshold: opening.threshold,
      /* Sixty-four lower-case hex characters, which is what the chain's own
       * serialisation of a contract address is. `toHex` lower-cases. */
      address: toHex(randomBytes(32)),
      assetBlinding: opening.assetBlinding,
      // Empty, exactly as the contract's constructor leaves `openProposals`.
      openProposals: new Map(),
      // Empty, exactly as the contract's constructor leaves `approvals`.
      spentApprovals: new Set(),
      // Empty, exactly as the contract's constructor leaves `thresholds`.
      vaultThresholds: new Map(),
      // Empty, exactly as the contract's constructor leaves `runWindow`.
      runWindows: new Map(),
      movements: new Set(),
      sealedStates: new Map([[opening.sealedState.keyEpoch, opening.sealedState.sealed]]),
      keyEpoch: opening.sealedState.keyEpoch,
      updatedAt: at,
    });
    return this.ref(at);
  }

  /**
   * **AND IT IS FORGOTTEN WHEN THIS PROCESS ENDS, WHICH IS WHY IT IS COPIED.**
   *
   * Every value in this class lives in a `Map` on the instance. A restart is a
   * new world with new addresses, so anything that needs the address after
   * today — and a derived key needs it for ever — has to have written it down
   * when the account was opened. `AccountService.create` is the one caller and
   * that is exactly what it does.
   */
  async address(accountId: string): Promise<LedgerAddress | null> {
    const a = this.accounts.get(accountId);
    /*
     * **`'simulated'`, AND THAT ONE WORD IS THE WHOLE POINT.** The value above
     * is `toHex(randomBytes(32))` — sixty-four lower-case hex characters,
     * indistinguishable by shape from an address a chain assigned, on purpose,
     * so that the two paths differ in where the value comes from and in nothing
     * else. **That is precisely why it cannot be left to be inferred.**
     *
     * Saying so here does not stop anything: `companyForSession` decides what
     * to do about it, and development turns the refusal off deliberately. What
     * it stops is real data being sealed under a number this process invented
     * and then losing its key on the day a contract is deployed.
     */
    return a ? { value: a.address, source: 'simulated' } : null;
  }

  async status(accountId: string): Promise<LedgerStatus | null> {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    return {
      // No assets, ever. The account keeps no book, so there is no map
      // of per-asset commitments to report and nothing that could ever put one
      // here. The field stays, empty, because `LedgerStatus` is the shape both
      // implementations answer in and the Midnight one reads the same absence
      // off the chain.
      assets: [],
      openProposals: [...a.openProposals.entries()]
        .map(([id, p]) => ({ id, change: p.change, approvals: p.approvals.size }))
        .sort((x, y) => x.id.localeCompare(y.id)),
      threshold: a.threshold,
      /*
       * SORTED BY VAULT, for the same reason `assets` is sorted by key: the
       * boundary's answer must not depend on insertion order, or two reads of
       * an unchanged account differ and a caller comparing them sees a change
       * that did not happen.
       */
      vaultThresholds: [...a.vaultThresholds.entries()]
        .map(([vault, threshold]) => ({ vault, threshold }))
        .sort((x, y) => x.vault.localeCompare(y.vault)),
      signerCount: a.signerLeaves.size,
      /*
       * **ZERO AND EMPTY, ALWAYS, AND THE FIELDS ARE HERE ANYWAY.**
       * `movements` is declared on `SimAccount` and initialised empty at
       * `open` and nothing writes it; retirement is not modelled in this class
       * at all. Reporting them is what makes `LedgerStatus` one shape both
       * implementations answer in — the same reason `assets` is `[]` above —
       * and the interface's own comments say which side is real. **A reader
       * that treats a 0 here as "no payments have completed" is reading a
       * simulator, and the *accept and detect* detector must not be
       * pointed at this class.**
       */
      movementCount: a.movements.size,
      retiredVaults: [],
    };
  }

  /**
   * This class records no payments, so it answers that it does not know.
   *
   * `movements` is declared on the simulated account and initialised empty, and
   * nothing in this class writes to it, so every membership test over it would
   * answer false for every payee of every run, for ever.
   *
   * `known: false` rather than an empty `paid` is the whole reason the field
   * exists. An empty answer with `known: true` says *these hundred people have
   * not been paid*, which is a claim this class is
   * in no position to make about anybody. Saying instead that it cannot answer
   * leaves the screen with an absence to render, and an absence is the truth.
   *
   * A caller wanting the real answer wires a ledger that reads a chain. That is
   * a choice made in one place, and this method does not pretend to be it.
   */
  async paidAmong(accountId: string, _leaves: Hex[]): Promise<PaymentsAmong | null> {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    return { known: false, paid: [] };
  }

  /** This class records no payments, so it answers that it does not know; see `paidAmong`. */
  async paidOnceAmong(accountId: string, _nonces: Hex[]): Promise<PaymentsAmong | null> {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    return { known: false, paid: [] };
  }

  async holdsSigner(accountId: string, leaf: Hex): Promise<boolean | null> {
    const a = this.accounts.get(accountId);
    return a ? a.signerLeaves.has(leaf) : null;
  }

  async propose(
    accountId: string,
    payloadHash: Hex,
    change: StateChange,
    by: SignerRef,
    vault: Hex,
    _raiseBy?: bigint,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    /*
     * A governance proposal names no vault, as the contract refuses one: with a real vault a
     * payload of `runPayload(...)` would mint the same id a run mints, with no payment window,
     * which a payment could be recorded against and `cancel` could not stop. On simulated wiring
     * this check is the only one there is. Several proposals may be open at once.
     */
    if (vault !== this.commitments.noVault()) {
      throw new Error(
        'a governance round cannot name a vault: it would mint the same id a payroll run ' +
          'mints, with no payment window, which recordPayment can pay and cancel cannot stop.');
    }
    const id = this.commitments.proposalId(payloadHash, change.salt, vault);
    /*
     * The payload hash is kept beside the change: the governance methods check the payload, and
     * the contract binds it through the id, which this simulation cannot recompute without the salt
     * at spend time, so it compares the payload directly.
     */
    return this.openProposal(a, id, payloadHash, this.changeCommitmentOf(a, change), by, vault);
  }

  async proposeCompanyChange(
    accountId: string, payloadHash: Hex, salt: Hex, by: SignerRef, _raiseBy?: bigint,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    const vault = this.commitments.noVault();
    const id = this.commitments.proposalId(payloadHash, salt, vault);
    return this.openProposal(a, id, payloadHash, SIMULATED_COMPANY_CHANGE_MARK, by, vault);
  }

  /**
   * Opens a proposal with `stored` beside it, refusing an id already open. The raise counts as the
   * raiser's approval, as the contract counts it: their own `approve` is then refused. The raiser's
   * mark is added to the account's spent marks without checking it, as the contract adds it, so a
   * raiser raising again with the same salt is counted once more.
   */
  private openProposal(a: SimAccount, id: Hex, payloadHash: Hex, stored: Hex, by: SignerRef, vault: Hex): TxRef {
    if (a.openProposals.has(id)) throw new Error('that proposal is already open');
    const raiser = `${by.leaf}@${id}`;
    a.spentApprovals.add(raiser);
    a.openProposals.set(id, { payloadHash, change: stored, approvals: new Set([raiser]), vault });
    return this.touch(a);
  }

  /**
   * **RAISES A PAYROLL RUN, AND THE DISTINCTION FROM `propose` IS KEPT RATHER
   * THAN CLAIMED.** The counterpart of the RUN branch at
   * `contracts/src/ConfidentialAccount.compact`.
   *
   * **THE THREE THINGS THAT MAKE IT A RUN AND NOT A GOVERNANCE ROUND WITH A
   * DIFFERENT NAME**, each mirroring a line of that branch:
   *   1. the payload is `runPayload(root, payees, opensAt, closesAt, required)` and not an
   *      application digest, so the id is one `recordPaymentFromVault` can recompute;
   *   2. it writes `runWindows`, which `propose` above writes never;
   *   3. It REQUIRES a real vault; `propose` above refuses one.
   *
   * **WHAT THIS LAYER STILL CANNOT DO, WRITTEN DOWN RATHER THAN LEFT TO BE
   * DISCOVERED:** there is no `recordPaymentFromVault` here and no block time, so
   * nothing consumes the window and nothing pays against the id. **A green run
   * through this class is evidence that the client builds the right id, and is
   * not evidence that a vault could spend it** — that is what `contracts/test/`
   * is for, and this project paid to learn the difference.
   */
  async proposeRun(
    accountId: string, run: RunProposal, change: StateChange, by: SignerRef, _raiseBy?: bigint,
  ): Promise<TxRef & { proposalId: Hex }> {
    const a = this.requireSigner(accountId, by);

    /*
     * **REFUSED HERE AS WELL AS ON CHAIN, AND THE DUPLICATION IS DELIBERATE** —
     * `MidnightLedger`'s own words at `src/midnight/ledger.ts`. The
     * contract's asserts give an attacker nothing; these give a person a
     * sentence, before a fee and before anybody signs. The first two mirror
     * the contract's own refusals of a run with no payees and of a window that ends before it opens.
     */
    if (run.payees < 1n) throw new Error('a payroll run needs at least one payee');
    if (run.opensAt >= run.closesAt) {
      throw new Error(
        `this run's window closes at ${run.closesAt} and opens at ${run.opensAt}, ` +
          'so no payment could ever fall inside it',
      );
    }
    /*
     * **THE MILLISECOND GUARD HAS NO CONTRACT COUNTERPART AND IS MIRRORED
     * ANYWAY**, from `src/midnight/ledger.ts`. Not for symmetry: a
     * guard the Midnight ledger has and this one does not is this class
     * accepting a sequence the product's other ledger refuses, in the
     * permissive direction, which is the dangerous one. Block time is seconds
     * since the Unix epoch; a millisecond window opens in the year 56000.
     */
    if (run.closesAt > 32_503_680_000n) {
      throw new Error(
        `this run's window closes in the year ${new Date(Number(run.closesAt) * 1000)
          .getUTCFullYear()}, which is not a time in seconds. Block time is seconds since the ` +
          'Unix epoch, not milliseconds.',
      );
    }
    /*
     * A RUN NAMES A VAULT, and `noVault()` is not one. The contract does not
     * assert this — its run branch takes the vault opaque — but a run raised at
     * the no-vault sentinel is one `recordPaymentFromVault` can never be handed, because
     * a vault presents ITSELF and recomputes the id from its own address
     * (`runIdOf`). Refused here rather than approved and then
     * unpayable, which is the same failure shape one layer along.
     */
    if (run.vault === this.commitments.noVault()) {
      throw new Error(
        'a payroll run must name the vault that will pay it: the vault is folded into the ' +
          'proposal id and recordPayment recomputes the id from it, so a run raised at the ' +
          'no-vault sentinel is one no vault can ever present.',
      );
    }

    const payloadHash = this.commitments.runPayload(
      run.root, run.payees, run.opensAt, run.closesAt, run.required ?? 0n);
    const id = this.commitments.proposalId(payloadHash, change.salt, run.vault);

    /*
     * The raise counts as the raiser's approval. The contract counts a run's raiser only when their rights let them
     * approve on the run's vault; this simulation holds no rights, so every raiser here may approve and is counted.
     */
    this.openProposal(a, id, payloadHash, this.changeCommitmentOf(a, change), by, run.vault);
    /* The contract's only write of a run's window is in `propose`'s run branch, and it is here for the
     * same reason it is there: the two branches are told apart by this row. */
    a.runWindows.set(id, { opensAt: run.opensAt, closesAt: run.closesAt });
    return { ...this.touch(a), proposalId: id };
  }

  /**
   * A run's approved window, or `undefined` if that id is not a run.
   *
   * A distinction nothing can observe is not a distinction: this read is what
   * lets a test see that `proposeRun` writes the window, which is how this
   * class tells a run from a governance round.
   *
   * **OFF THE `Ledger` INTERFACE, DELIBERATELY, LIKE `publicView`.** The
   * counterpart on chain is a public ledger field anybody can read
   * (`contracts/src/ConfidentialAccount.compact`) and
   * `contracts/test/simulator.ts` already exposes it the same way for the
   * same purpose. Putting it on the boundary would oblige `MidnightLedger` to
   * answer it, which is a chain read nobody has built and nothing needs — and
   * an interface method with an invented implementation is the rule
   * `CommitmentScheme`'s own note spends a paragraph on.
   */
  runWindowOf(accountId: string, proposalId: Hex): { opensAt: bigint; closesAt: bigint } | undefined {
    return this.accounts.get(accountId)?.runWindows.get(proposalId);
  }

  async approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    const p = a.openProposals.get(proposalId);
    if (!p) throw new Error('there is no open proposal with that id');
    /*
     * `leaf@proposal`, where the contract burns `approvalNullifier`. Ours names the
     * signer and the contract's does not, the privacy difference `SimAccount`
     * describes. Both are kept for the account's life, across a proposal's close,
     * so both accept and reject the same sequences.
     */
    const nullifier = `${by.leaf}@${proposalId}`;
    if (a.spentApprovals.has(nullifier)) throw new Error('you have already approved this proposal');
    a.spentApprovals.add(nullifier);
    p.approvals.add(nullifier);
    return this.touch(a);
  }

  async cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    if (!a.openProposals.has(proposalId)) {
      throw new Error('there is no open proposal with that id');
    }
    // One proposal closes. Nobody else's approvals are touched, because there is
    // no round to rotate.
    a.openProposals.delete(proposalId);
    /*
     * **AND ITS WINDOW GOES WITH IT**, as `closeProposal` drops the contract's
     * row at `contracts/src/ConfidentialAccount.compact`. A window
     * outliving its proposal would make `runWindows.has(id)` answer *yes, a
     * run* about an id that is no longer open — the stale half of that
     * distinction. Governance rounds have no row, so this deletes nothing for
     * them and needs no branch.
     */
    a.runWindows.delete(proposalId);
    return this.touch(a);
  }

  /**
   * The invitee takes the seat an approved invitation names, as the contract's
   * `seatInvited` does: the invitation must commit to the address worked out
   * from `seat.coinSecretKey` and `seat.addressSalt`, to `seat.scope`, and to
   * `seat.newThreshold`; the leaf is built here from the seat's public key,
   * blinding and that scope, never handed in. Refuses a leaf already seated, an
   * invitation not yet approved, a threshold that is not a whole number from 0
   * up (the range the contract's `Uint<64>` keeps; every safe integer is in it),
   * and a threshold above the signers seated once the seat is taken; a threshold
   * other than 0 is then written. The invitee need not be a signer.
   */
  async seatInvited(accountId: string, seat: InvitedSeat): Promise<TxRef> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error('account is not open on this ledger');
    const address = this.commitments.inviteAddressOf(this.commitments.coinPublicKeyOf(seat.coinSecretKey), seat.addressSalt);
    const approved = this.requireApproved(a, seat.proposalId);
    if (approved.payloadHash !== this.commitments.signerInvitePayload(address, seat.scope, seat.newThreshold)) {
      throw new Error('that proposal does not invite this wallet with these rights');
    }
    const leaf = this.commitments.signerLeaf(seat.signerPublicKey, seat.blinding, seat.scope);
    if (a.signerLeaves.has(leaf)) throw new Error('that signer is already on this account');
    /* The contract's `Uint<64>` keeps the range its type holds; a `number` here keeps it by this check. */
    if (!Number.isSafeInteger(seat.newThreshold) || seat.newThreshold < 0) {
      throw new Error('the threshold an invitation sets must be a whole number; 0 keeps the one in force');
    }
    if (seat.newThreshold !== 0 && a.signerLeaves.size + 1 < seat.newThreshold) {
      throw new Error('the threshold an invitation sets cannot exceed the signers seated once it is taken');
    }
    a.signerLeaves.add(leaf);
    if (seat.newThreshold !== 0) a.threshold = seat.newThreshold;
    a.openProposals.delete(seat.proposalId);
    return this.touch(a);
  }

  async removeSigner(
    accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    const approved = this.requireApproved(a, proposalId);
    if (approved.payloadHash !== this.commitments.signerRemovePayload(removedLeaf, 0)) {
      throw new Error('that proposal is not for this removal');
    }
    if (!a.signerLeaves.has(removedLeaf)) throw new Error('that leaf is not on this account');
    /*
     * Refused BEFORE the removal, unlike the contract, which decrements and then
     * checks. Same rule either way — an account left below its own threshold
     * could never approve anything again, including a proposal to add somebody
     * back, so it is finished with the balance inside it.
     */
    if (a.signerLeaves.size - 1 < a.threshold) {
      throw new Error(
        `that would leave ${a.signerLeaves.size - 1} signers against a threshold of ` +
          `${a.threshold}, and the account could never approve anything again`,
      );
    }

    a.signerLeaves.delete(removedLeaf);
    a.openProposals.delete(proposalId);
    return this.touch(a);
  }

  async setThreshold(
    accountId: string, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    const approved = this.requireApproved(a, proposalId);
    if (approved.payloadHash !== this.commitments.signerThresholdPayload(newThreshold)) {
      throw new Error('that proposal is not for this threshold');
    }
    /*
     * **`Number.isInteger` IS HERE BECAUSE ITS SIBLING HAS IT AND THE TWO
     * DISAGREED.** `setVaultThreshold` below refuses a non-integer at BOTH
     * boundaries and `setThreshold` refused it at NEITHER, and the same
     * asymmetry was closed one layer down at `src/midnight/ledger.ts` —
     * leaving this the last of the pair. Six spellings of one floor across two
     * operations is how one of them stops matching, which is what this is for
     * rather than for anything being wrong today: the direction was already
     * safe and loud, because `BigInt(2.5)` throws a `RangeError` before any
     * binding.
     */
    if (!Number.isInteger(newThreshold) || newThreshold < 1) {
      throw new Error('the threshold must be at least one');
    }
    /*
     * A threshold above the number of seated signers would leave an account
     * that can never approve anything again.
     */
    if (newThreshold > a.signerLeaves.size) {
      throw new Error(
        `the threshold cannot exceed the ${a.signerLeaves.size} signers on this account, ` +
          'or one signer could seat their own',
      );
    }

    a.threshold = newThreshold;
    /*
     * Every other open proposal keeps its approvals and will be measured against
     * the NEW threshold when it settles. Nothing here burns the approvals already
     * given, so a payment a signature from settling stays a signature from it.
     */
    a.openProposals.delete(proposalId);
    return this.touch(a);
  }

  /**
   * **ONE VAULT'S OWN THRESHOLD.** The counterpart of
   * `setVaultThreshold` at `contracts/src/ConfidentialAccount.compact`,
   * check for check.
   *
   * `requireApproved` and not a vault-aware read, deliberately and matching the
   * circuit: the proposal behind this names `noVault()`, so it is measured against
   * the ACCOUNT's threshold. **A vault's own lowered bar can never be the bar
   * that lowers it further** — otherwise one governed round down to 1 would make
   * every subsequent change to that vault a single signature.
   */
  async setVaultThreshold(
    accountId: string, vault: Hex, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    const approved = this.requireApproved(a, proposalId);
    if (approved.payloadHash !== this.commitments.vaultThresholdPayload(vault, newThreshold)) {
      throw new Error('that proposal does not authorise this vault threshold');
    }
    /*
     * **THE CONTRACT'S OWN SENTENCE, AND ITS OWN REASON.** *"a vault
     * threshold of zero would authorise anything"* — `thresholdFor` would
     * answer 0, `approvals >= 0` holds before anybody has approved, and every
     * payment out of that vault would settle on the proposer's word alone. It
     * is a ceiling that authorises everything, written into chain state. `< 1`
     * rather than `=== 0`, because a negative or fractional number is not a
     * threshold either and `Uint<64>` is what the contract's type refuses on
     * its side.
     */
    if (!Number.isInteger(newThreshold) || newThreshold < 1) {
      throw new Error('a vault threshold of zero would authorise anything');
    }
    /*
     * **NO SIGNER-COUNT BOUND, COPIED RATHER THAN OVERLOOKED**:
     * a vault has no bootstrap window to reopen, so an unmeetable vault bar is
     * recoverable rather than dangerous. **The application still refuses to
     * RAISE one** (`AccountService.proposeVaultThresholdChange`), and that
     * refusal belongs there: a rule only one implementation has is two.
     *
     * **AND NO `noVault()` REFUSAL EITHER, AND THAT IS DELIBERATE.**
     * The contract's `thresholdFor(noVault())` cannot occur *by
     * construction*, but `setVaultThreshold` inserts whatever key it is handed, so the
     * construction is a CLIENT HABIT — `AccountService.setVaultThreshold`
     * refuses the sentinel on BOTH paths. **Not added here: the chain has none,
     * and `MidnightLedger` has none either, so the INTER-LEDGER parity this
     * file really applies does not compel it.**
     */
    a.vaultThresholds.set(vault, newThreshold);
    a.openProposals.delete(proposalId);
    return this.touch(a);
  }


  async fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null> {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    const sealedState = a.sealedStates.get(keyEpoch);
    if (!sealedState) {
      throw new Error(
        `no sealed state for "${accountId}" at key epoch ${keyEpoch}. The account record names ` +
          'a key epoch the state store holds nothing under, so the two disagree about which ' +
          'viewing key is current.',
      );
    }
    return { commitment: this.viewDigest(a), sealedState, updatedAt: a.updatedAt };
  }

  /** Everything an outside observer could see. Used to prove the isolation claim. */
  publicView() {
    return {
      commitments: [...this.accounts.entries()].map(([accountId, a]) => ({
        accountId, commitment: this.viewDigest(a), updatedAt: a.updatedAt,
      })),
      /*
       * There is no `settlements` here, and its absence is the claim.
       *
       * This method is the evidence behind *a public observer learns nothing*,
       * so what it omits has to be omitted on purpose. Nothing settles at the
       * account: it is an authority over a vault rather than a holder of money.
       * An isolation property held by an empty data structure names nothing
       * that enforces it.
       *
       * Whoever builds vault payroll decides what an observer sees of it, and
       * this is where that decision lands. A settlement row would carry the
       * asset and the amount as a real integer to an endpoint with no sign-in on
       * it, so its shape has to be argued rather than inherited. This method
       * shows commitments and the public face of a proposal, and says so.
       */
      /* Public by design, per decision 0003. */
      proposals: [...this.accounts.entries()].flatMap(([accountId, a]) =>
        [...a.openProposals.entries()].map(([id, p]) => ({
          accountId, id, approvalCount: p.approvals.size, threshold: a.threshold,
        }))),
    };
  }

  describe() { return 'SimulatedLedger (local, no consensus)'; }

  /* ---------------- internals ---------------- */

  /**
   * The change commitment, under the same scheme the client uses.
   *
   * ONE definition. It was called by `propose`, `execute` and `credit`, because
   * "what was approved" and "what happened" had to be the same value or the
   * check comparing them was decorative. `propose` is the only caller left, and
   * nothing compares the result to anything.
   */
  private changeCommitmentOf(a: SimAccount, c: StateChange): Hex {
    return this.commitments.changeCommitment(
      this.commitments.assetKey(c.asset, a.assetBlinding), c.amount, c.batchDigest, c.salt);
  }

  /**
   * The counterpart to the contract's `requireApproved`: open, and past the
   * threshold. Returns what was approved, so the caller cannot do the
   * arithmetic against anything else.
   */
  private requireApproved(
    a: SimAccount, proposalId: Hex,
  ): { payloadHash: Hex; change: Hex } {
    const p = a.openProposals.get(proposalId);
    if (!p) throw new Error('there is no open proposal with that id');
    /*
     * The bar is the account's threshold, never a vault's, as in the
     * contract's `requireApproved`, which reads `threshold` with no map lookup.
     * The four callers below are all governance (`seatInvited`,
     * `removeSigner`, `setThreshold`, `setVaultThreshold`). The contract's
     * vault-aware `requireApprovedForVault` has three callers, `requirePayable`
     * (which serves `recordPaymentFromVault` and `recordBatchFromVault`),
     * `approveVaultChange` and `clearRun`; that rule is modelled separately by
     * `thresholdFor`, reached through `approvalsOnChain`.
     *
     * Pinned by the cases under "a governance round is judged by the ACCOUNT's
     * threshold" in `src/core/a-vault-s-own-threshold.test.ts`, which drive this
     * class directly (the product doors all pass `noVault()`, `account.ts`).
     *
     * Of the contract's other guards on a governance round, this ledger has none:
     * the contract also refuses a governance proposal that names a vault
     * (`proposeCompanyChange`) and derives a governance proposal's id with
     * `noVault()` folded in (`governanceIdOf`), while these methods compare
     * `approved.payloadHash` and never re-derive the id. Only four of the
     * contract's governance circuits have a method here (`seatInvited`,
     * `removeSignerAndSetThreshold`, `setThreshold`, `setVaultThreshold`); there
     * is none for `adopt` or `retireVault`.
     */
    const bar = a.threshold;
    if (p.approvals.size < bar) {
      throw new Error(`not enough approvals yet: ${p.approvals.size} of ${bar}`);
    }
    /*
     * Both halves are returned and the caller picks: the governance methods
     * compare the payload. The change half has no reader now that no balance
     * ledger executes a proposal.
     */
    return { payloadHash: p.payloadHash, change: p.change };
  }

  private requireSigner(accountId: string, by: SignerRef): SimAccount {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error('account is not open on this ledger');
    // The contract proves membership with a Merkle path and never learns which
    // leaf. Here it is a set lookup. Same answer, different privacy.
    if (!a.signerLeaves.has(by.leaf)) throw new Error('not a signer on this account');
    return a;
  }

  /**
   * A single value standing for the whole account, for `fetch` and
   * `publicView`. NOT a commitment the contract holds, and not the same thing
   * as one.
   *
   * There is no single state commitment on chain, and nothing per-asset to
   * digest, so this is a digest over nothing and is ONE CONSTANT. It addresses
   * a stored blob; it cannot show an observer that something changed. Nothing
   * verifies against it, and nothing should, which is why it is built from the
   * scheme's own outputs rather than being a further commitment scheme
   * (decision 0004).
   */
  private viewDigest(_a: SimAccount): Hex {
    // Over nothing, because there is nothing per-asset on chain.
    // Kept as a call rather than inlined so the one definition of
    // "what an observer sees" stays in `viewDigestOf`.
    return viewDigestOf([]);
  }

  private touch(a: SimAccount): TxRef {
    const at = new Date().toISOString();
    a.updatedAt = at;
    return this.ref(at);
  }

  private ref(at: string): TxRef {
    return { ref: 'sim:' + toHex(randomBytes(8)), at };
  }
}

/**
 * Evaluates the predicate against the private witness and issues a bound
 * attestation only when it holds. Correct semantics, wrong trust model.
 * Replace with Compact circuits plus the Midnight proof server.
 */
export class SimulatedProofSystem implements ProofSystem {
  constructor(private provingKey: Hex = toHex(randomBytes(32))) {}

  private predicateHolds(circuit: Circuit, publicInputs: Record<string, unknown>, witness: any): boolean {
    switch (circuit) {
      /*
       * Every comparison below is bigint to bigint.
       *
       * Comparing a bigint balance with `typeof witness.balance === 'number'`
       * would be false, so `prove` would refuse EVERY solvency attestation with
       * "statement is false" for a true statement. `Number(…)` on the public
       * inputs would be the unsafe direction: it silently rounds anything past
       * 2^53, so an ETH floor and an ETH balance differing by a few hundred wei
       * would compare EQUAL and a false statement would prove.
       */
      case 'balance-at-least':
        return typeof witness?.balance === 'bigint'
          && witness.balance >= BigInt(publicInputs.threshold as bigint);
      case 'payroll-total': {
        if (!Array.isArray(witness?.amounts)) return false;
        if (!witness.amounts.every((x: unknown) => typeof x === 'bigint')) return false;
        const sum = witness.amounts.reduce((a: bigint, b: bigint) => a + b, 0n);
        return sum === BigInt(publicInputs.total as bigint)
          && witness.amounts.length === Number(publicInputs.headcount);
      }
      case 'payment-record':
        return witness?.employeeId === publicInputs.employeeId
          && typeof witness?.amount === 'bigint'
          && witness.amount === BigInt(publicInputs.amount as bigint)
          && witness?.asset === publicInputs.asset
          && witness?.period === publicInputs.period;
      default:
        return false;
    }
  }

  async prove(circuit: Circuit, publicInputs: Record<string, unknown>, witness: unknown): Promise<Hex> {
    if (!this.predicateHolds(circuit, publicInputs, witness)) {
      throw new Error(`proof refused: statement is false for circuit "${circuit}"`);
    }
    return this.tag(circuit, publicInputs);
  }

  async verify(circuit: Circuit, publicInputs: Record<string, unknown>, proof: Hex): Promise<boolean> {
    return this.tag(circuit, publicInputs) === proof;
  }

  private tag(circuit: Circuit, publicInputs: Record<string, unknown>): Hex {
    return toHex(hmac(sha256, fromHexKey(this.provingKey), utf8(circuit + '|' + canonical(publicInputs))));
  }

  describe() { return 'SimulatedProofSystem (trusted prover, not zero-knowledge)'; }
}

/* ------------------------------------------------------------------ *
 * commitments
 * ------------------------------------------------------------------ */

/**
 * How the client computes the commitments the contract cares about.
 *
 * This is an interface for the same reason `Ledger` is. The contract computes
 * these with `persistentCommit`, a ZK-friendly hash the circuit can prove over.
 * `core/` cannot call it: doing so would mean importing generated Midnight code
 * into the isomorphic layer, which is the one dependency rule that keeps the
 * standalone build working.
 *
 * So `core/` uses the simulated scheme below, and `src/midnight/` provides one
 * that calls the generated pure circuits — `MidnightCommitments`, in
 * `src/midnight/commitments.ts`. The client picks whichever matches the ledger
 * it is talking to, and the two never have to agree, because a leaf or a change
 * commitment computed under one scheme is only ever checked against the same
 * scheme.
 *
 * What must never happen is a third definition appearing somewhere (decision 0004).
 */
export interface CommitmentScheme {
  /**
   * **A SIGNER'S PUBLIC IDENTITY, FROM THEIR SIGNING SECRET.**
   *
   * The first argument of `signerLeaf`. `signerPublicKey` in
   * `contracts/src/ConfidentialAccount.compact` is
   * `persistentHash([pad(32, "midnight-accounts:signer:pk:"), sk])` over the
   * SECRET, and `requireSigner()` builds the leaf it looks for in the tree from
   * that. `ed25519.getPublicKey(sk)` is a scalar multiplication and is
   * different, uncorrelated 32 bytes, so a seat written from an ed25519 key is
   * a seat no device could ever prove.
   *
   * It is on the scheme for the reason `noVault` and `allVaults` are: `core/`
   * cannot import the generated code, a dependency rule that keeps the
   * standalone build working and is stated at the head of this interface. So
   * `core/` asks the scheme it was handed, and the Midnight scheme's
   * implementation is one line that calls `pureCircuits.signerPublicKey`.
   * Nothing restates the hash in TypeScript, because a second derivation is a
   * second place the answer can come from.
   *
   * The simulated scheme derives its own, deliberately unrelated — the rule
   * that `SimulatedCommitments` must never agree with the contract, and the
   * same rule the two sentinels already follow.
   *
   * The argument is the secret, which is why this is not on the ledger
   * boundary: a scheme is a pure function table with no state and no network,
   * and `SignerRef` excludes secrets on purpose.
   */
  signerPublicKey(signingSecret: Hex): Hex;
  /**
   * A signer's blinded leaf in the signer tree.
   *
   * `commit(publicKey, blinding)`, and nothing else — decision 0003's shape.
   *
   * The tree has a slot per signer, so one slot can be cleared on its own: a
   * leaf never has to change and nothing needs stamping on it.
   */
  signerLeaf(signerPublicKey: Hex, blinding: Hex, scope?: Hex): Hex;
  /**
   * Which asset a change commitment names, and that is the only thing it does:
   * there is no on-chain map for it to index.
   *
   * Blinded for the same reason a signer's leaf is (decision 0003): the plain
   * code would publish that this company runs payroll in euros, and every
   * account dealing in euros would share the same key.
   *
   * The blinding is the ACCOUNT's, not a signer's, and every signer must derive
   * the same key from it — otherwise the id one signer approved is not the id
   * the next one recomputes, and an approved run could never be presented.
   */
  assetKey(asset: AssetId, assetBlinding: Hex): Hex;
  /**
   * What the chain calls a proposal.
   *
   * `commit([tag, payloadHash, vault], salt)` — blinded, unique because the
   * salt is fresh, and already the value every approval nullifier is derived
   * from. The preimage holds the vault and a DOMAIN TAG; without the tag this
   * derivation and `signerLeaf` would be the same function up to a
   * permutation of their arguments. The contract's own shape is
   * `proposalIdOf` in `contracts/src/ConfidentialAccount.compact`. Computed by
   * the client so that a proposal has an identity before it is submitted, which
   * is what lets an approval be prepared without a round trip.
   */
  /**
   * What a payroll run is, before it has an identity.
   *
   * `SimulatedLedger.proposeRun` raises one and really computes this value to
   * build the id it hands back, so neither side invents an implementation to
   * satisfy a type, and no second definition of a rule is created by having it
   * here.
   *
   * The two spellings stay apart. `MidnightCommitments.runPayload`
   * is one line calling `pureCircuits.runPayload`, so the client never derives
   * the payload a second way — `recordPaymentFromVault` recomputes it on every payment
   * (`contracts/src/ConfidentialAccount.compact`) and a second
   * derivation is a proposal id no payment can match, discovered after the
   * approvals were collected and the fees paid. `SimulatedCommitments` keeps
   * its own `sha256`, deliberately unequal, like `signerPublicKey` and the two
   * sentinels; `contracts/test/one-definition.test.ts` pins both halves.
   *
   * Seconds, not milliseconds, for the reason on `RunProposal`.
   */
  runPayload(root: Hex, payees: bigint, opensAt: bigint, closesAt: bigint, required?: bigint): Hex;
  proposalId(payloadHash: Hex, salt: Hex, vault?: Hex): Hex;
  /**
   * The two reserved sentinels.
   *
   * `noVault` is what a proposal names when it concerns no vault — governance,
   * and the account's own internal ledger. `allVaults` is the scope every
   * signer is seated with while per-vault signer sets are reserved but not yet
   * enforced.
   *
   * ON THE SCHEME rather than written as constants, because both are values the
   * chain will compare against and a constant computed on our side is a second
   * definition waiting to drift (decision 0004). The simulated scheme derives
   * its own; the Midnight scheme reads the contract's.
   */
  noVault(): Hex;
  allVaults(): Hex;
  /**
   * The commitment to an approved change.
   *
   * The contract records a movement as `paidMovementOf(leaf)` (that circuit in
   * `contracts/src/ConfidentialAccount.compact`, inserted by `recordPaymentFromVault`,
   * its only writer), derived from the payee's leaf and not from this. Decision
   * 0004 binds each of them separately: one derivation per fact, in one
   * place.
   */
  changeCommitment(assetKey: Hex, amount: bigint, batchDigest: Hex, salt: Hex): Hex;
  /**
   * What is being approved, in the four governance rounds.
   *
   * `AccountService` reaches these through the scheme it was handed, whatever
   * ledger is wired beneath it, while the executing circuits re-derive the same
   * four with `persistentHash` over a padded tag
   * (`contracts/src/ConfidentialAccount.compact`). The two must agree:
   * `propose` takes the payload hash as an OPAQUE argument and asserts nothing
   * about it, so a payload derived the wrong way is raised, collects its
   * approvals and burns its fees, and then `removeSignerAndSetThreshold`,
   * `setThreshold` and `setVaultThreshold` refuse, each recomputing the payload
   * with its own circuit and comparing the id.
   *
   * They are on this interface because both implementations really produce
   * these values: `SimulatedLedger` seats a signer, removes one, and moves both
   * the account's and a vault's threshold, and recomputes all four payloads to
   * check the proposal it is handed (`seatInvited`, `removeSigner`,
   * `setThreshold`, `setVaultThreshold` below). The rule is that a value stays
   * OFF the shared interface when one side would have to invent an
   * implementation of it to satisfy a type (`src/midnight/commitments.ts`);
   * neither is invented here.
   *
   * The simulated scheme keeps its own `sha256` spelling and the two stay
   * apart, the same arrangement as `signerPublicKey` and the two sentinels, and
   * the same one `what-a-signer-is.test.ts` pins as deliberate.
   * `contracts/test/one-definition.test.ts` asserts both halves: that the
   * Midnight side EQUALS the circuit, and that the simulated side does not.
   *
   * **THREE OF THE FOUR NAMES DIFFER FROM THE CIRCUITS' AND THAT IS WHERE A
   * MIS-WIRE LANDS.** `signerRemovePayload` is the circuit's
   * `removeAndSetThresholdPayload`; `signerThresholdPayload` is its
   * `setThresholdPayload`; `vaultThresholdPayload` is its
   * `setVaultThresholdPayload`. `signerInvitePayload` matches. What catches a
   * swap is the mirrored entry per circuit in `one-definition.test.ts`, which
   * is mechanical.
   *
   * **THE THRESHOLDS ARE `number` HERE AND `Uint<64>` THERE.** The Midnight
   * implementation converts; the binding refuses a JavaScript `number` by name:
   * *"type error: setThresholdPayload argument 1 ... expected value
   * of type Uint<0..18446744073709551616> but received 2"*.
   */
  signerInvitePayload(address: Hex, scope: Hex, newThreshold: number): Hex;
  /** A hiding commitment to an invited address's coin public key under `salt`. */
  inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex;
  /** The coin public key a wallet's coin secret key makes. */
  coinPublicKeyOf(coinSecretKey: Hex): Hex;
  signerRemovePayload(removedLeaf: Hex, newThreshold: number): Hex;
  signerThresholdPayload(newThreshold: number): Hex;
  vaultThresholdPayload(vault: Hex, newThreshold: number): Hex;
  describe(): string;
}

export const SimulatedCommitments: CommitmentScheme = {
  /**
   * **DELIBERATELY NOT THE CONTRACT'S DERIVATION, AND IT MUST NEVER BECOME
   * IT.**
   *
   * The contract hashes `[tag, sk]` with `persistentHash`; this keys an HMAC
   * with the secret, which is the same construction its siblings below use and
   * is not `persistentHash` in any spelling. The two schemes never mix — a
   * commitment is only ever checked against the scheme that made it — so what
   * matters is that this one is internally consistent and that no value it
   * produces can be mistaken for one the chain would accept.
   *
   * The public half is derived from the SECRET on both sides, so the shape of
   * the rule is the same everywhere and only the algorithm differs.
   */
  signerPublicKey(signingSecret) {
    return toHex(hmac(sha256, fromHexKey(signingSecret), utf8('simulated-signer-pk')));
  },

  /*
   * `scope` is accepted and folded in, the same as the real scheme folds it into
   * the leaf commitment. Defaulted to `allVaults()` so every existing caller is
   * unchanged, and so a caller with no business choosing a scope cannot.
   */
  signerLeaf(signerPublicKey, blinding, scope) {
    /* `this`, NOT `SimulatedCommitments`: the interface
     * puts the sentinels on the SCHEME so a scheme is one definition, and a
     * member reaching past the object it was called on would ignore a scheme
     * that overrode a sentinel. */
    const sc = scope ?? this.allVaults();
    return toHex(hmac(sha256, fromHexKey(blinding),
      utf8('signer-leaf:' + signerPublicKey + ':' + sc)));
  },

  /*
   * Domain-separated hashes, matching the CONTRACT'S construction in kind if
   * not in algorithm: something no real value can collide with. The two schemes
   * never mix — a commitment is only ever checked against the scheme that made
   * it — so what matters is that each is internally consistent and that neither
   * sentinel can arise by accident.
   */
  noVault() {
    return toHex(sha256(utf8('midnight-accounts:vault:none')));
  },
  allVaults() {
    return toHex(sha256(utf8('midnight-accounts:scope:all')));
  },
  assetKey(asset, assetBlinding) {
    return toHex(hmac(sha256, fromHexKey(assetBlinding), utf8('asset-key:' + asset)));
  },
  /*
   * The vault is folded in: two different vaults produce different ids, so an
   * approval collected for one never counts towards the other. The Midnight
   * scheme folds it in the same way (`src/midnight/commitments.ts`).
   *
   * Defaulted to `noVault()` for the same reason that scheme defaults it: the
   * two must agree about what "no vault" means, and a caller with no vault
   * still needs a value in the slot.
   */
  /**
   * **DELIBERATELY NOT THE CONTRACT'S DERIVATION**, and the same arrangement as
   * `signerPublicKey`, the two sentinels and the four governance payloads: the
   * contract's is `persistentHash` over a padded tag
   * (`contracts/src/ConfidentialAccount.compact`), this is `sha256`
   * over a domain string, and the two schemes never mix — a commitment is only
   * ever checked against the scheme that made it.
   *
   * **THE ARGUMENTS ARE STRINGIFIED IN FULL AND NOT NARROWED.** `${payees}` on
   * a bigint is its decimal digits with nothing to round, which is the same
   * reason `changeCommitment` spells its amount that way. A `Number()` here
   * would collapse two windows a second apart past 2^53 into one value, and two
   * runs with one id is the failure this whole derivation exists to prevent.
   */
  runPayload(root, payees, opensAt, closesAt, required = 0n) {
    return toHex(sha256(utf8(
      `midnight-accounts:run:${root}:${payees}:${opensAt}:${closesAt}:${required}`)));
  },
  proposalId(payloadHash, salt, vault) {
    const v = vault ?? this.noVault(); // `this`, not the name.
    return toHex(hmac(sha256, fromHexKey(salt), utf8('proposal:' + payloadHash + ':' + v)));
  },
  changeCommitment(assetKey, amount, batchDigest, salt) {
    // `${amount}` on a bigint is its decimal digits, with nothing to round.
    return toHex(hmac(sha256, fromHexKey(salt),
      utf8(`change:${assetKey}:${amount}:${batchDigest}`)));
  },
  /*
   * **THE FOUR GOVERNANCE PAYLOADS, SIMULATED — AND THEY KEEP `sha256`.**
   *
   * They are deliberately NOT the contract's, exactly like `signerPublicKey`
   * and the two sentinels above, and `one-definition.test.ts` pins that they
   * stay apart. The two schemes never mix: a commitment is only ever checked
   * against the scheme that made it.
   */
  signerInvitePayload(address, scope, newThreshold) {
    return simulatedSignerInvitePayload(address, scope, newThreshold);
  },
  inviteAddressOf(coinPublicKey, salt) {
    return simulatedInviteAddressOf(coinPublicKey, salt);
  },
  coinPublicKeyOf(coinSecretKey) {
    return simulatedCoinPublicKeyOf(coinSecretKey);
  },
  signerRemovePayload(removedLeaf, newThreshold) {
    return simulatedSignerRemovePayload(removedLeaf, newThreshold);
  },
  signerThresholdPayload(newThreshold) {
    return simulatedSignerThresholdPayload(newThreshold);
  },
  vaultThresholdPayload(vault, newThreshold) {
    return simulatedVaultThresholdPayload(vault, newThreshold);
  },
  describe() {
    return 'simulated commitments (HMAC-SHA256, not provable in a circuit)';
  },
};

/**
 * What a paid vault transaction came to: the reference the fee payer's
 * submission gave, and the hash of the transaction exactly as it was sent,
 * which is what a note is later named by.
 */
export interface VaultTxSent extends TxRef {
  readonly transactionHash: string | null;
}

/**
 * A device's transaction with only the network fee added, finished and ready
 * for whoever submits it, and the hash it will land under.
 */
export interface FeeAdded {
  readonly tx: Uint8Array;
  readonly transactionHash: string | null;
  /** Tells the fee payer whoever was handed it is done with it, submitted or not; nothing is released. */
  readonly done?: () => Promise<void>;
}

/** How a transaction a device sends for a vault arrives. */
export type VaultTxArrival =
  /** Proven by the device and moving no coins: a vault's deploy, or its handover. */
  | 'proven-moving-nothing'
  /** Proven by the device and finished by the depositor's own wallet: a deposit. */
  | 'finished-by-the-depositor'
  /**
   * Proven by the device, moving only a vault's own coins, which balance among
   * themselves: a private payment out. Nobody's wallet signs for it, so it is
   * bound where it is paid for, as a transaction that moves nothing is.
   */
  | 'proven-moving-the-vaults-own-coins';
