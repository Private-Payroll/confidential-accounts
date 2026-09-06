/**
 * THE BOUNDARY.
 *
 * Everything above this file is the real product. Everything Midnight-specific
 * lives behind the interfaces declared here, and nothing in core/account.ts,
 * core/payroll.ts or the API needs to know which implementation is running.
 *
 * THERE ARE THREE INTERFACES, NOT TWO. Ledger and ProofSystem are the two this
 * comment named for most of its life; CommitmentScheme (below, with its own
 * header) is the third, and leaving it out is what made the sentence that
 * followed wrong. It said moving to the real network meant writing two classes
 * and changing one line in the wiring. Read on 27 Aug 2026, the boundary was
 * real and both named classes existed, and the line count was not close:
 *
 *   - `src/server/index.ts` constructed the ledger and the proof system;
 *   - `src/standalone/main.tsx` constructed the same two again, its own copy;
 *   - `src/core/account.ts` took the commitment scheme from a DEFAULT parameter,
 *     which the server accepted by passing only two arguments;
 *   - `src/web/App.tsx` imported a commitment scheme at module scope and
 *     computed an invited signer's leaf from it, with no argument to change.
 *
 * Four files, and the fourth was not a wiring decision at all. Changing the
 * "one line" would have left the simulated commitment scheme running under a
 * real ledger — leaves and balance commitments the contract cannot read, with
 * nothing failing until a proof is attempted on chain.
 *
 * SO THE WIRING IS NOW ONE PLACE AND THE SENTENCE IS TRUE AGAIN, WITH ITS PRICE
 * NAMED: `src/wiring/selection.ts` chooses ledger, proof system and commitment
 * scheme together and offers no way to choose them apart. Selecting Midnight
 * from there still needs work that is not a line: MidnightProofSystem's prove
 * and verify both throw, neither it nor MidnightLedger constructs without
 * configuration, and this module is imported by the browser entry points, so a
 * Midnight entry has to reach `src/midnight/` behind a dynamic import or it
 * pulls the SDK's WebAssembly into the page.
 *
 * THE COMMITMENT SCHEME IS NOT ON THAT LIST, AND A PREVIOUS ROUND PUT IT THERE.
 * This sentence said "no Midnight CommitmentScheme has been written yet". It has
 * been: `MidnightCommitments` in `src/midnight/commitments.ts:72`, declared
 * `CommitmentScheme` — a type annotation rather than a cast, so
 * the compiler checks every member against the interface — calling the
 * generated pure circuits `signerLeaf`, `assetKeyOf` and the rest. The claim came from a grep that looked for a CLASS IMPLEMENTING the
 * interface; this is an object literal ANNOTATED with it, so the search could
 * not see it and returned nothing, which was read as there being nothing. That
 * is the same failure as searching for `new Simulated…` and missing a multi-line
 * import: A SEARCH THAT CANNOT SEE A WHOLE FORM PROVES NOTHING BY FINDING
 * NOTHING. Corrected here and in the selector's header, which had made the
 * missing scheme its stated reason for having one entry rather than two.
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
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Sealed, Hex } from './crypto.js';
import { canonical, toHex, randomBytes, utf8, fromHex as fromHexKey } from './crypto.js';
import type { AssetId } from './assets.js';

export interface TxRef { ref: string; at: string; }

/*
 * `GENESIS_SIGNER_GENERATION` USED TO BE HERE. M-106 removed the generation.
 *
 * A leaf is `commit(publicKey, blinding)` again — decision 0003's shape, with
 * nothing stamped on it. Removal clears one slot rather than invalidating every
 * leaf at once, so there is no generation for a leaf to belong to and no value
 * the client and the contract have to agree on before an account can be used.
 */

export interface LedgerRecord {
  commitment: Hex;
  sealedState: Sealed;
  updatedAt: string;
}

/**
 * A sealed state, and which viewing key sealed it. K-4.
 *
 * The epoch travels with the ciphertext because **the commitment does not
 * identify it.** It never did: it was taken over the balance, the entry digest
 * and the salt — the PLAINTEXT — so re-sealing the same state under a rotated
 * key produced identical commitments and completely different bytes. `C292`
 * made that sharper rather than softer, because the value a blob is filed under
 * is now `viewDigestOf([])`, ONE CONSTANT for every account and every state, so
 * it distinguishes nothing at all. Filing both under it alone means one
 * silently replaces the other.
 *
 * Which matters more than it sounds, because either order of a naive rotation
 * destroys the account:
 *
 *   - replace the blob first, then the records: a crash between them leaves the
 *     state sealed under a key that exists only in the rotating client's memory
 *     and was never wrapped to anybody. Unrecoverable.
 *   - replace the records first, then the blob: a crash between them leaves the
 *     records under the new key and the state under the old one, whose wrapped
 *     copies have just been thrown away. Also unrecoverable.
 *
 * Carrying the epoch is what lets both exist at once, so the rotation is a
 * single flip with a readable account either side of it. That is the M-74 rule
 * — write the complete new set, flip one pointer, then drop the old — and this
 * type is what makes the first step possible at all.
 */
export interface SealedStateAt {
  keyEpoch: number;
  sealed: Sealed;
}

/* ------------------------------------------------------------------ *
 * the shape of a state change
 * ------------------------------------------------------------------ */

/**
 * The OPENING of a state commitment — never the commitment itself.
 *
 * This distinction is the whole of M-29, so it is worth being exact about.
 *
 * The old interface was `publish(accountId, commitment, sealedState)`: a hash
 * and a ciphertext. `SimulatedLedger` could honour that, because publishing a
 * commitment is a complete operation when you are the only authority. The
 * Compact contract cannot, and not by accident:
 *
 *     stateCommitment =
 *       disclose(stateCommitmentOf(nextBalance(), nextEntriesDigest(), nextStateSalt()));
 *
 * `execute()` took no arguments. It *derived* the commitment from three
 * witnesses supplied by the calling device, precisely so that no public
 * parameter could carry a balance onto the chain (decision 0004). A commitment
 * handed in from outside was a number the circuit could not check and could not
 * reproduce — `MidnightLedger` could open neither argument it was given, so it
 * could not make the contract commit to the state it was asked to publish.
 *
 * So the boundary passed the three values instead, and the implementation
 * computed the commitment under the scheme matching the chain it talked to. The
 * caller never computed one, which also removed the second place a commitment
 * scheme could be defined — exactly the failure decision 0004 exists to prevent.
 *
 * `C292` DELETED THE CIRCUIT, THE WITNESSES AND THE BALANCE THEY OPENED. Kept
 * in the past tense as the record of why this boundary is a sequence of named
 * steps rather than one `publish`, which is still the shape below. Nothing
 * described in this paragraph runs.
 */
/**
 * The CHANGE a proposal makes, rather than the state it results in.
 *
 * The first fix for M-70 bound the resulting state, which closed the hole and
 * opened a smaller one: money arriving between the last approval and the
 * execute was silently discarded, because the approved result had been computed
 * before it existed. The only safe response was to refuse deposits during a
 * round — friction sitting directly on the main path, since companies fund an
 * account and then run payroll.
 *
 * A change is relative, so it does not depend on any balance at all — the
 * argument the contract still makes at `propose`. A deposit into the vault
 * mid-round becomes harmless.
 */
export interface StateChange {
  /**
   * WHICH ASSET MOVES. M-125, and it is part of what the signers approve.
   *
   * Without it the approved change was an amount and a batch of entries saying
   * nothing about which balance they came out of — so a round approved to pay a
   * month of dollar salaries would have authorised moving the same integer out
   * of the ether balance, and the signer who called `execute` would have
   * picked. The contract still binds it inside `changeCommitmentOf`; this field
   * is the same fact on this side of the boundary.
   *
   * **AND SINCE `C292` NOTHING OPENS THAT COMMITMENT.** `execute` was its only
   * reader, so the asset inside it is written and never compared. What refuses
   * the substitution now is the token inside `payoutDetails`, inside the leaf,
   * inside the approved root, inside the proposal's id — the contract says the
   * same thing over `changeCommitmentOf` and `assetKeyOf`. Rule 27: the
   * enforcer is named where the property is claimed, or it is not enforced.
   */
  asset: AssetId;
  /**
   * How much leaves the account, in `asset`'s smallest unit.
   *
   * Zero where nothing moves, which is every governance round. It read "zero
   * for a credit" until `C292` removed `credit` and with it the only way value
   * ever arrived at an account.
   */
  amount: bigint;
  /** Digest over the entries this change appends to the log. */
  batchDigest: Hex;
  /**
   * The proposal's blinding factor.
   *
   * Generated once at propose time and carried. It was carried because the
   * contract recomputed the change commitment at execute time and the two had
   * to agree; `C292` removed that reader. It is still carried because it is the
   * PROPOSAL'S salt: `proposalIdOf(payloadHash, vault, salt)` is what every
   * governance circuit and `recordPayment` recompute to prove they were handed
   * the proposal the signers approved, so a device without it cannot name the
   * round at all. It travels in the sealed payload, which is how every shared
   * secret moves here.
   */
  salt: Hex;
}

/**
 * The caller's view of ONE ASSET before a transition.
 *
 * **NO METHOD ON THIS BOUNDARY TAKES ONE ANY MORE.** `C292` removed the calls
 * that did, so this type — whose builder `S52` deleted — has no
 * reader left. Kept as the shape a vault-side view will need; it constrains
 * nothing today.
 *
 * PASSED ACROSS THE BOUNDARY RATHER THAN REMEMBERED, which M-125 forced and
 * which is an improvement on its own terms. The Midnight implementation used to
 * keep "current" in the device's persisted private state and trust it to still
 * be right; with a balance per asset there was no single current to keep — the
 * last call may have moved a different asset entirely — and the caller had just
 * opened the sealed blob, which is the one source of truth.
 *
 * `log` USED TO BE HERE and M-128 removed it. The account's entry log was a
 * running digest that had to be proven before it could be appended to, so every
 * transition carried it and two transitions prepared against the same log
 * conflicted even when they moved different money. Movements are an append-only
 * set on chain now, and inserting into a set requires reading nothing.
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

/*
 * `StateOpening` STOOD HERE AND IS GONE WITH THE BALANCE.
 *
 * It described the balance a transition moved an asset TO, and it existed for
 * `settleRound` and `credit`, both of which are gone. The account keeps no
 * books: it decides what a vault may pay, and records what a vault paid.
 */

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
   * **ALWAYS EMPTY SINCE `C292`, ON BOTH IMPLEMENTATIONS.** The account keeps
   * no books, `assetBalances` is gone from the contract, and there is nothing
   * to report: `SimulatedLedger.status` and `MidnightLedger.status` each answer
   * with a literal `[]`. The field stays because it is the shape both
   * implementations answer in, and because the Midnight one reads that absence
   * off the chain rather than assuming it.
   *
   * WHAT IT MEANT WHILE IT HELD ANYTHING, kept because a vault's holding will
   * need the same treatment: `key` was OPAQUE and not an asset code — on
   * Midnight `assetKeyOf(assetId, accountBlinding)`, so only somebody holding
   * the blinding could say which asset an entry was — and what was public,
   * deliberately and in the same class as `signerCount`, was HOW MANY assets
   * there were.
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
   * `contracts/src/ConfidentialAccount.compact:251`.
   *
   * **ABSENCE MEANS INHERIT** (`thresholdFor`, `:1358`), which is what lets a
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
   * it is what decides whether `addSigner`'s bootstrap window is open.
   *
   * **ON THE MIDNIGHT LEDGER THAT WINDOW IS NEVER OPEN SINCE `S35d`** — the
   * constructor founds every account at one seat and one approval and nothing
   * can push the threshold above the seat count (`docs/company-accounts.md`
   * section 10a). `SimulatedLedger` still opens accounts at whatever threshold
   * it is given, so the two ledgers genuinely differ here, and this field is
   * how each one answers for itself rather than being told.
   */
  signerCount: number;
  /**
   * **HOW MANY PAYMENTS THE ACCOUNT HAS RECORDED AS COMPLETED, ACCOUNT-WIDE.**
   * The contract's `movements` (`contracts/src/ConfidentialAccount.compact:215`,
   * a `Set<Bytes<32>>` of payee leaves).
   *
   * **IT IS HERE FOR ONE NAMED CONSUMER AND THAT CONSUMER IS NOT BUILT.**
   * `docs/accepted-risks.md` §1 is a ruling — *accept and detect* — and the
   * detector it owes compares Σ`payments` across the account's vaults
   * against this number. **`SC10` measured that neither this field nor
   * `retiredVaults` below was on this boundary, so the detector could not have
   * been written against it**, and the founder's 4 Sep ruling on `C395` made
   * that load-bearing rather than tidy: *detect* is the whole of the mitigation.
   *
   * **A COUNT AND NOT THE LEAVES, DELIBERATELY.** The comparison the ruling
   * describes is between two magnitudes; the leaves would be an unbounded read
   * of a set that nothing anywhere removes from. The generated reader CAN
   * enumerate it — `contracts/managed/contract/index.d.ts` gives `movements` a
   * `[Symbol.iterator]` over the already-decoded state — so a later round that
   * needs the leaves themselves can have them without a contract change. **What
   * an indexer returns for a very large set at scale is not something this
   * repository can settle, and this sentence is where that is admitted rather
   * than assumed.**
   *
   * **`SimulatedLedger` ANSWERS 0 FOR EVER AND SAYS SO**: nothing in that class
   * writes `movements` — `settleRound` was its only writer and went with
   * So this field is real on the Midnight side and a constant on the
   * simulated one, which is `LedgerStatus.assets`' shape and is named here so
   * nobody reads a zero as evidence. The product runs the simulated wiring
   * (`src/wiring/selection.ts:144`), so **today this number is 0 on the path
   * the product takes, and the detector cannot run there at all.**
   */
  movementCount: number;
  /**
   * **EVERY VAULT THIS ACCOUNT HAS EVER RETIRED.** The KEYS of the contract's
   * `retiredAt` (`contracts/src/ConfidentialAccount.compact:517`, a
   * `Map<Bytes<32>, Uint<64>>`).
   *
   * **EVER RETIRED, NOT IS RETIRED, AND THE DIFFERENCE IS `C362`.** Nothing in
   * the contract removes from this map — `retireVault` is its only writer
   * (`:2890`) and it inserts a marker — so presence of the key is the whole
   * answer and the VALUE is not carried here. A boundary that reported *is
   * retired* would be answering a question the chain does not hold.
   *
   * **THE PAIR WITH `movementCount` IS THE POINT, NOT EITHER ALONE.**
   * `docs/accepted-risks.md` §1's detector needs the account's vault list from
   * the PRODUCT's own record rather than from the contract's `vaults` set —
   * because §2 of that same file permits `vaults` to lose precisely the funded
   * vault that is still paying out — and it needs to know which of those the
   * account has retired. This field answers the second half. **It does not
   * answer the first, and `vaults` is deliberately still not on this boundary:
   * putting it here would invite exactly the naive detector §1 was corrected to
   * forbid.**
   *
   * **`SimulatedLedger` ANSWERS `[]` FOR EVER**: that class models no
   * retirement of any kind — there is no `retireVault` on the `Ledger`
   * interface and no retirement state on `SimAccount`. Same admission as
   * `movementCount` above.
   */
  retiredVaults: Hex[];
  /*
   * `round` IS GONE.
   *
   * It existed to scope approval nullifiers, which is why an account could hold
   * one proposal at a time. Nullifiers bind to the proposal now, so there is no
   * global sequence number and nothing to report — and anything that was using
   * the round to ask "has the account moved on" should be asking about the
   * proposal it actually cares about.
   */
}

/**
 * **THE BAR FOR ONE VAULT: ITS OWN IF SOMEBODY SET ONE, THE ACCOUNT'S
 * OTHERWISE.** One definition, mirroring `thresholdFor` at
 * `contracts/src/ConfidentialAccount.compact:1358`:
 *
 *     thresholds.member(vault) ? thresholds.lookup(vault) : threshold
 *
 * **A TERNARY AND NOT A `??` OVER A DEFAULTED LOOKUP**, for the same reason the
 * contract says it is a ternary and not an `||`: the question is whether the
 * map HOLDS this vault, and a lookup that answers `0` or `undefined` for both
 * "absent" and "set to zero" merges the two states this rule is made of. Zero
 * can never be in the map — the contract refuses to insert it (`:2777`) and so
 * does `SimulatedLedger.setVaultThreshold` — but the shape must not depend on
 * that being true somewhere else.
 *
 * `noVault()` is never a key in the map, because it is a hash of a domain
 * string that no vault address can equal, so this returns the account's own
 * threshold for every governance proposal by construction rather than by a
 * branch anybody has to remember. The contract makes the same argument at
 * `:1362-1382` and splits its two entry points on it.
 *
 * **RULE 27 — WHAT CONSUMES THIS NUMBER, AND THE HONEST ANSWER IS *NOTHING
 * THAT SETTLES ANYTHING*.** `T-218` `P1`, `C367` generalised.
 *
 * The chain side is a straight line with no branches: `thresholds` is read in
 * exactly one place, `thresholdFor` (`compact:1358`); its one caller is
 * `requireApprovedForVault` (`:1384`); its one caller is `recordPayment`
 * (`:2697`) — **and `recordPayment` has no method on the `Ledger` interface at
 * all, WHICH IS DELIBERATE AND IS `S54`'s RULING** (see below). Meanwhile
 * `propose` asserts `vault == noVault()` (`:2319`): no governance round names one.
 * **So the value is durable, governed, publicly visible and inert.**
 *
 * **AND `S52` MADE THAT MORE TRUE RATHER THAN LESS, WHICH IS WHY THIS
 * PARAGRAPH IS HERE AND NOT A FIX.** `C376` removed the one place in this file
 * that consumed a vault's threshold to DECIDE anything —
 * `SimulatedLedger.requireApproved` — because deciding governance on it was the
 * defect. What is left reads it to REPORT and to SET A STATUS: this function,
 * through `approvalsOnChain`, into `approvalRound` — which nothing outside the
 * tests reads — and into `account.ts:460`'s `satisfied`/`short`, which
 * `:2693` turns into `status = 'approved'`. **`T-296`, corrected by `S56`.**
 *
 * **`T-218` IS CLOSED AND THIS PARAGRAPH IS THE BRANCH THAT CLOSED IT. `S54`
 * CORRECTED THE SENTENCE THAT STOOD HERE**, which said the row stays open and
 * closes when `recordPayment` gains a boundary method, citing `T-213`. `T-218`
 * took THIS branch (`S52`, `97e5014`) and `T-213` is `proposeRun`, now shipped.
 * **`S54` RULES `recordPayment` MUST NOT GAIN A METHOD HERE: its only callers
 * are the VAULT on chain (`Vault.compact:597`, `:770`), the client's door is
 * `VaultLedger.payout`, and a method nothing calls is `T-281`'s fault.**
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
   * **AND `[0]` IS THE FOUNDING SIGNER — THE ONE SEAT THE CONSTRUCTOR CREATES.**
   *
   *
   * The account's first seat used to be derived, inside the constructor, from
   * the witnesses of whatever process ran the deploy — so the deployer was a
   * signer on every account this project would ever create, and on the only
   * implementation that existed its secret was a formula anyone reading the
   * repository could compute. The constructor now takes a leaf as a public
   * argument and calls none of the three identity witnesses, and this array is
   * where that leaf comes from.
   *
   * **NO SECOND FIELD, DELIBERATELY.** A `foundingSignerLeaf` beside this array
   * would be the same answer written twice, held in step by a comment, which is
   * `M-104` exactly. The first element is the founder.
   *
   * **AND THE TWO IMPLEMENTATIONS DO DIFFERENT THINGS WITH THE REST, WHICH IS
   * WRITTEN HERE RATHER THAN LEFT TO BE DISCOVERED.** `SimulatedLedger.open`
   * seats every leaf. `MidnightLedger.open` can seat exactly one — the
   * constructor's — because every seat after it is `amendSigner`, which
   * requires an existing signer to call it, and the deploy holds no signer's
   * material any more. **So it REFUSES an opening naming more than one** rather
   * than seating the first and dropping the rest, which would leave a roster
   * saying three signers and a chain holding one. `C335` / board `4b` is the
   * screen that seats the others from the founder's own device.
   *
   * **AN EMPTY ARRAY IS AN ACCOUNT THAT IS DEAD ON ARRIVAL**, because
   * `amendSigner` requires an existing signer and there would be none to add
   * the first. Both implementations refuse it: `SimulatedLedger.open` through
   * its threshold check, `MidnightLedger.open` by name.
   */
  signerLeaves: Hex[];
  threshold: number;
  /**
   * NOTHING TO OPEN AT. An account holds no assets, ever — `C292` — so there is
   * no balance to seed, and since M-128 no entry-log digest either.
   */
  /**
   * The account's asset blinding, generated once and never rotated.
   *
   * Not rotated by K-4 and this is the one exception to "rotation re-seals
   * everything": every change commitment already approved names its asset as
   * `assetKeyOf(assetId, this)`, so changing it would make a run one signature
   * from settling impossible to present at a vault.
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
 * THERE IS NO LONGER A METHOD HERE WITHOUT A CIRCUIT BEHIND IT. `credit` and
 * `settleRound` were the two, and `C292` removed both along with the balance
 * they moved. If one is ever added again, the interface says so and the
 * Midnight implementation refuses by name — a gap surfacing as a mystery at
 * deploy time is what that rule was bought with.
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
 * `PI2a` shipped a correct refusal for a company with no address and it could
 * never fire, because `SimulatedLedger` mints something the shape check
 * accepts. A separate `addressSource()` call would have been the same bug with
 * one more step: a caller that reads the address and forgets to ask.
 */
export interface LedgerAddress {
  readonly value: string;
  readonly source: AddressSource;
}

/*
 * `RoundSettlement` STOOD HERE.
 *
 * It was the argument to `settleRound`, the merged transfer-and-transition that
 * closed a round by moving the account's own balance. Both are gone with the
 * balance. `R6`'s rule — that an operation with two halves must be one
 * transaction or refuse — is not repealed by this. It is what the VAULT path
 * has to satisfy when it is built.
 */

/**
 * **A PAYROLL RUN, AS THE CHAIN IS ASKED TO OPEN ONE.**
 *
 * Exactly the run branch's arguments at
 * `contracts/src/ConfidentialAccount.compact:2109-2115`, in the same order, so
 * an implementation has nothing left to invent — the rule the lifecycle note
 * above states for every other method on this interface.
 *
 * **`opensAt` AND `closesAt` ARE SECONDS SINCE THE UNIX EPOCH, NOT
 * MILLISECONDS**, because `blockTimeGte`/`blockTimeLt` compare against block
 * time (`compact:2629-2630`). A millisecond window builds a run that opens in
 * the year 56000, is approved, and pays nobody — refused by both
 * implementations before a fee rather than discovered on payday.
 *
 * **`vault` IS REQUIRED AND IS NOT `noVault()`.** A run is FOR a vault: the
 * vault is folded inside the proposal's identity (`proposalIdOf`, `:874`) and
 * `recordPayment` is handed it and recomputes the id from it (`:2606-2609`).
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
   * Opens a round. The chain receives a commitment to the payload, never the
   * payload — and, since M-70, a commitment to the CHANGE as well.
   *
   * `change` is here because approving an instruction is not the same as
   * approving its effect. Without it, the signer who called `execute` picked
   * the next state on their own and the approvals meant nothing.
   *
   * **THE CIRCUIT THAT CHECKED IT IS GONE.** `C292` deleted `execute`, so the
   * same `change` is no longer handed to anything and the commitment raised
   * here is opened by nothing on chain. It is still generated once, here, and
   * carried in the sealed payload, because the proposer's own post-check
   * recomputes it against what the chain recorded and because the salt inside
   * it is the proposal's identity. Rule 27, in those words: nothing on chain
   * compares an approved change to what was done with it.
   */
  /**
   * **`vault` IS REQUIRED AND HAS NO DEFAULT.** It matches the circuit —
   * `export circuit propose(…, vault: Bytes<32>)`,
   * `contracts/src/ConfidentialAccount.compact:2105`, whose parameter list grew
   * the run's own parts when `S11` merged `proposeRun` into it — and this
   * interface is one-to-one with the circuits by design.
   *
   * The vault is committed INSIDE the proposal's identity (`proposalIdOf`,
   * `:874`), so it is not a label on the round: it is part of what the round
   * IS. An approval raised for one vault is not a rejected id at another, it is
   * a different id entirely, matching nothing.
   *
   * A caller that concerns no vault passes `CommitmentScheme.noVault()` and
   * says so. It is not defaulted, because a default is a value nobody chose
   * arriving in the field that decides how many approvals the round needs.
   */
  propose(
    accountId: string, payloadHash: Hex, change: StateChange, by: SignerRef, vault: Hex,
  ): Promise<TxRef>;

  /**
   * **RAISES A PAYROLL RUN, AND IT IS A DIFFERENT ACT FROM `propose`.** `C375`,
   * Mirrors the RUN branch of the merged circuit —
   * `contracts/src/ConfidentialAccount.compact:2119-2156`, reached by
   * `isRun: true`.
   *
   * **WHY IT IS ON THIS INTERFACE AT ALL, WHICH IS THE WHOLE OF `C375`.** It
   * was not, and `MidnightLedger.proposeRun` (`src/midnight/ledger.ts:828`)
   * existed anyway — public on the class, off the boundary, driven by ten cases
   * in its own test file and called by nothing in `src/`. So the only propose
   * door anything above this interface could reach was `propose`, whose
   * `payloadHash` is an APPLICATION digest
   * (`commit(canonical({accountId, kind, sealedPayload, proposedBy}), '')`,
   * `src/core/account.ts:2252-2254`) and whose emitted `isRun` is pinned
   * `false` (`src/midnight/ledger.ts:1113-1117`). **`recordPayment` recomputes
   * `proposalIdOf(runPayload(root, payees, opensAt, closesAt), forVault, salt)`
   * and matches only a `runPayload`** (`compact:2606-2609`), so every payroll
   * round the product raised was approved, paid for, and unpayable by any
   * vault, for ever — and the governance branch writes no `runWindow` row
   * (`compact:2140-2156`), so `closeExpiredRun` could not close it either.
   *
   * **THE FIVE PARTS ARE ALL OF THE RUN'S IDENTITY AND NONE IS OPTIONAL.** The
   * id is folded from four of them and the vault; a caller that cannot name one
   * cannot raise a run, and refusing is the whole point. `MidnightLedger`
   * post-checks that the chain holds the id it computed, because a run's id is
   * built from four values rather than one and there are therefore four ways to
   * raise a proposal nobody can ever pay against.
   *
   * **IT RETURNS THE ID, WHERE `propose` RETURNS ONLY A `TxRef`.** The caller
   * cannot recompute it: `runPayload` is the CHAIN's derivation and the salt is
   * inside the change. A door that made the caller derive the id a second way
   * is the shape `C371` and `C373` both had.
   */
  proposeRun(
    accountId: string, run: RunProposal, change: StateChange, by: SignerRef,
  ): Promise<TxRef & { proposalId: Hex }>;

  /**
   * One approval per signer PER PROPOSAL.
   *
   * `proposalId` is the proposal's blinded on-chain commitment, and naming it is
   * the whole of the change: an account holds several open proposals at once,
   * and approving payroll is no longer the same act as approving whatever else
   * happens to be open.
   */
  approve(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef>;

  /**
   * Withdraws ONE proposal.
   *
   * It no longer rotates a round or burns anybody else's approvals — there is
   * no round, and every other proposal on the account is untouched. Nullifiers
   * already spent on this one stay spent, which costs nothing: a re-proposal
   * takes a fresh salt and is a different proposal.
   */
  cancel(accountId: string, proposalId: Hex, by: SignerRef): Promise<TxRef>;

  /**
   * Puts a signer's leaf in the on-chain tree.
   *
   * Two paths, and which one applies is not the caller's choice. While the
   * account still has fewer signers than its threshold it is being set up and
   * any existing signer may add another — otherwise a 2-of-3 account could
   * never reach three signers, because it would need two approvals it cannot
   * yet collect.
   *
   * Once the account is live, adding a signer IS an approval round: propose,
   * reach the threshold, then call this. Before M-37 a single existing signer
   * could add signers freely, which made the threshold decorative — one stolen
   * key could manufacture as many approvers as it liked.
   *
   * On the boundary at all because `grantAccess` used to skip it entirely: a
   * granted signer could read the account and not act on it, and every approval
   * they made failed inside a proof.
   */
  addSigner(accountId: string, leaf: Hex, proposalId: Hex | null, by: SignerRef): Promise<TxRef>;

  /**
   * Removes a signer, by clearing the one slot they occupy.
   *
   * ONE ARGUMENT, where this used to take a sixteen-wide list of survivors to
   * re-seat. The signer tree is a plain Merkle tree with a slot per signer, so
   * removing somebody touches their position and nobody else's — no generation
   * to advance, no survivors to recompute, and no cap on the approver set.
   *
   * Nobody is named. `removedLeaf` is a blinded commitment that was already
   * published when they were seated, and the caller proves membership exactly
   * as they would to approve a payment.
   */
  removeSigner(accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef): Promise<TxRef>;

  /**
   * Changes M in M of N, on chain.
   *
   * The threshold used to be a `sealed` ledger field — writable once, in the
   * constructor — so this could not exist and the product's version of it wrote
   * only our own copy. That was worse than a missing feature: it told a
   * customer three approvals were required while the chain settled at two.
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
   * `contracts/src/ConfidentialAccount.compact:2699`.
   *
   * Governance, so it is an approval round like `setThreshold` and is measured
   * against the ACCOUNT's threshold — the proposal behind it concerns no vault
   * (`:2708` names `noVault()`), which is why nobody can lower a vault's bar
   * with the vault's own lowered bar.
   *
   * **ZERO IS REFUSED HERE AS WELL AS ON CHAIN** — *"a vault threshold of zero
   * would authorise anything"* (`:2777`). An implementation that relayed it and
   * let the contract refuse would be correct and useless: the refusal has to be
   * reachable before a fee is paid and before anybody signs.
   *
   * **NOT BOUNDED BY THE SIGNER COUNT, and the omission is the contract's**
   * (`:2693-2697`): a vault has no bootstrap window, so a vault threshold above
   * the seats does not reopen one. What it does instead is make that vault
   * unspendable until the threshold is lowered again, which is a governed round
   * at the ACCOUNT's threshold and is therefore recoverable. **The refusal that
   * stops an unmeetable one being raised at all is the application's and lives
   * in `AccountService`, not here** — this interface stays one-to-one with the
   * circuit, and a guard here that the Midnight implementation cannot have is
   * two boundaries with different rules.
   */
  setVaultThreshold(
    accountId: string, vault: Hex, newThreshold: number, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef>;

  /*
   * `credit` STOOD HERE.
   *
   * Value never arrived at the account: this contract has no receive operation
   * and never had one. `credit` wrote a number into the account's own book, and
   * `S23` had already shed its circuit, so it was a local-only write with
   * nothing on chain behind it. The book is gone; money is held by a vault.
   */

  /**
   * Replaces the ciphertext of the CURRENT state without touching the chain. K-4.
   *
   * Rotation re-encrypts what the account already holds. The plaintext — the
   * entry log and its blindings — is unchanged, so there is nothing for the
   * chain to record and no approval round to run. That is the whole reason
   * changing the locks is cheap. Since `C292` there is nothing on chain that
   * describes the state in any case: the value a blob is filed under is
   * `viewDigestOf([])`, one constant.
   *
   * It writes ALONGSIDE the existing epoch rather than over it. Nothing here
   * decides when to start using the new one — that is one flip in the account
   * record, and it belongs there because the account record is what says which
   * epoch is current.
   */
  reseal(accountId: string, next: SealedStateAt): Promise<void>;

  /** The state as sealed under `keyEpoch`. Null when there is none at that epoch. */
  fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null>;

  describe(): string;
}

export type Circuit = /* `T-217`: NONE of the three exists in either `.compact` — measured, zero occurrences in `ConfidentialAccount.compact` and `Vault.compact`; `MidnightProofSystem.prove` throws for all three, and `SimulatedProofSystem` is symmetric so its verifier must BE its prover. */ 'balance-at-least' | 'payroll-total' | 'payment-record';

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
 * NOT A COMMITMENT THE CONTRACT HOLDS, and it must never be treated as one.
 * There is no single state commitment on chain — M-125 replaced it with a map
 * of per-asset commitments and M-128 replaced the entry digest with a set — so
 * the honest answer was a digest OVER the map, computed from the chain's own
 * public state. **`C292` REMOVED THE MAP, AND BOTH IMPLEMENTATIONS NOW CALL
 * THIS WITH `[]`.** It is therefore ONE CONSTANT, the same for every account
 * and every state: it still addresses a blob, and it can no longer tell two
 * states apart or say that anything moved. Nothing verifies against it, and
 * nothing should.
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
 * What a proposal must commit to for `addSigner` to accept it.
 *
 * Domain separated from an ordinary payment payload on purpose, and the
 * separator is load bearing: without it, a proposal approved to pay salaries
 * would be a valid authorisation to add a signer, since both are just "a
 * commitment the signers approved". The thing being approved has to be part of
 * what is approved. The SIMULATED half of the contract's `signerAddPayload`.
 */
const simulatedSignerAddPayload = (leaf: Hex): Hex =>
  toHex(sha256(utf8('midnight-accounts:add-signer:' + leaf)));

/**
 * What a proposal must commit to for `removeSigner` to accept it.
 *
 * Separately domain separated from `signerAddPayload`, for the same reason that
 * one is separated from a payment: an approval to add somebody must not double
 * as an approval to remove somebody.
 *
 * M-106 dropped the survivor list it used to carry. Under the generation design
 * the caller supplied the leaves to re-seat, the ledger could not check them —
 * a leaf is opaque by construction — and wrong ones would have produced an
 * account whose signers can prove nothing while looking like a clean removal.
 * Committing to the list was the guard. Nothing is supplied any more, so the
 * whole failure mode is gone rather than guarded.
 *
 * The SIMULATED half of the contract's `removeSignerPayload`, not equal to it.
 */
const simulatedSignerRemovePayload = (removedLeaf: Hex): Hex =>
  toHex(sha256(utf8('midnight-accounts:remove-signer:' + removedLeaf)));

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
 * The SIMULATED half of `setVaultThresholdPayload` (`:1148`) — including its
 * own domain string, separate from `setThresholdPayload`'s. An approval to move
 * ONE vault's bar must not double as an approval to move the ACCOUNT's, and the
 * two are otherwise the same statement about the same kind of number.
 *
 * **THE VAULT IS IN THE PAYLOAD AS WELL AS IN THE PROPOSAL'S IDENTITY, and the
 * duplication is the contract's rather than ours.** The identity binds the
 * vault the round is FOR — `noVault()`, because a governance round concerns no
 * vault — and the payload binds the vault the round is ABOUT. They are
 * different questions with different answers, and folding either into the other
 * would make an approval to raise vault A's bar spend against vault B.
 */
const simulatedVaultThresholdPayload = (vault: Hex, newThreshold: number): Hex =>
  toHex(sha256(utf8('midnight-accounts:vault-thresh:' + vault + ':' + newThreshold)));

/*
 * `changeKey` STOOD HERE AND `S52` DELETED IT. `T-226` `P3`.
 *
 * Its sole occurrence in the repository was its own definition: `settleRound`
 * was its only caller and went with the balance ledger. It said so in
 * its own comment, which is to this file's credit — **and the row is that
 * nothing MEASURED it.** `tsc --noEmit` cannot: `tsconfig.json` sets `strict`
 * and not `noUnusedLocals`, so five dead members sat here declaring their own
 * deadness and no door read the declaration.
 *
 * **WHAT IT KNEW, KEPT BECAUSE THE NEXT ROUND TO NEED IT WOULD OTHERWISE GET
 * IT WRONG:** the asset was its FIRST field, and leaving it out is the one
 * substitution `M-125` existed to prevent — a round approved to move dollars
 * settling against pounds.
 */


/**
 * Simulated state for one account. Mirrors the contract's public ledger fields
 * one for one, because anything it holds that the contract does not is a place
 * the simulation can succeed where the chain would fail.
 *
 * `signerLeaves` stands in for the `HistoricMerkleTree`, and the per-proposal
 * `approvals` set for the contract's `Set<Bytes<32>>` of nullifiers. In the
 * contract a nullifier is `H(domain, contractAddress, proposal, secretKey)` —
 * `approvalNullifier`, `contracts/src/ConfidentialAccount.compact:916` — and it
 * hides *which* signer approved; here it is `leaf@proposal`, which does not.
 * M-128 moved both off the round. That is the one deliberate difference and it
 * is a privacy property, not a rule: both burn exactly once per signer per
 * proposal, so both accept and reject the same sequences.
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
   * EVERY OPEN PROPOSAL, keyed by its blinded id.
   *
   * A map, where this used to be four scalar fields describing the one proposal
   * an account was allowed to have. Payroll and a vendor invoice no longer
   * queue, and settling one no longer burns approvals given to the other.
   */
  openProposals: Map<Hex, {
    payloadHash: Hex;
    change: Hex;
    approvals: Set<string>;
    /**
     * **WHICH VAULT THIS ROUND CONCERNS, HELD BECAUSE THE CHAIN CANNOT HOLD
     * IT.**
     *
     * On chain the vault is committed inside the proposal's id and is NOT a
     * field beside it — `openProposals` there is `Map<Bytes<32>, Bytes<32>>`,
     * id to change, and `recordPayment` is HANDED the vault and recomputes the
     * id from it (`:2706-2708`). So a caller proves which vault a round is for
     * by producing an id that matches; it cannot ask the chain.
     *
     * This simulation cannot do that, for the same reason it keeps
     * `payloadHash`: it has no salt at spend time. It keeps the vault it was
     * given at propose time and measures the round against that vault's
     * threshold — the same rule, checked the way this layer can check it, and
     * the same accommodation M-130 already made one field over.
     */
    vault: Hex;
  }>;
  /**
   * **THE WINDOW OF EVERY OPEN RUN, AND GOVERNANCE ROUNDS ARE NOT IN IT.**
   * The counterpart of the contract's `runWindow`
   * (`contracts/src/ConfidentialAccount.compact:354`), whose only value-write
   * is in the RUN branch (`:2156`) — *"the governance branch below writes none,
   * so a governance proposal has NO ROW in `runWindow` at all"*.
   *
   * **IT IS A SECOND MAP RATHER THAN A FIELD ON `openProposals` FOR EXACTLY
   * THAT REASON.** An optional field on the proposal would make *is this a run*
   * a property every reader has to remember to check; a separate map makes
   * membership the answer, which is the shape the chain has and the shape
   * `cancel` and `closeExpiredRun` read.
   *
   * **WHAT READS IT ON CHAIN AND HAS NO COUNTERPART HERE, SAID OUT LOUD UNDER
   * RULE 27:** `cancel` refuses once a run's window has opened
   * (`:2404`) and `closeExpiredRun` refuses until it has closed (`:2453-2454`).
   * Both are `blockTime` comparisons and **this layer has no block time at
   * all**, so neither rule is enforced here. What this map buys today is that a
   * run and a governance round are DISTINGUISHABLE, which is the property
   * `C375` was the absence of; the time rules are the chain's until a clock
   * exists at this layer.
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
   * **NOTHING WRITES IT IN THIS SIMULATION.** `settleRound` was its only writer
   * and went with the balance ledger; on chain the writer is
   * `recordPayment`, which this layer has no counterpart for. It is initialised
   * empty at `open` and stays empty, so nothing reading it is reading anything.
   */
  movements: Set<Hex>;
  /*
   * One ciphertext per key epoch, not one ciphertext. K-4.
   *
   * The same rule the real blob store keeps, and it is here rather than only
   * there so a test cannot pass against behaviour the file store does not have.
   * A rotation needs the old and the new to exist at once, or a crash between
   * the two writes ends the account.
   */
  sealedStates: Map<number, Sealed>;
  keyEpoch: number;
  updatedAt: string;
}

/**
 * The lifecycle, locally and without consensus.
 *
 * It enforces the rules rather than recording intentions. Before M-29 this
 * class accepted any state at any time, which meant `core/account.ts` could be
 * driving a sequence the chain would reject and every test would still pass —
 * the interface was shaped by whichever implementation was easiest to write.
 * Now the two refuse the same things:
 *
 *   - acting as someone who is not in the signer set
 *   - approving the same proposal twice
 *   - settling a governance round below the ACCOUNT's threshold
 *   - spending a proposal on a payload other than the one approved
 *
 * THE LAST TWO USED TO BE ABOUT A CHANGE AND A BALANCE — "executing a change
 * other than the one approved, in a different asset, or against a stale view of
 * the balance". `C292` removed the balance, `execute` and `requireCurrentView`
 * together, so neither side checks any of that now and neither pretends to.
 *
 * What it still does NOT model, and must not be read as modelling: consensus,
 * finality, reorgs, fees, or zero knowledge. It also cannot tell you whether a
 * circuit will *prove* — only whether the sequence is legal.
 */
export class SimulatedLedger implements Ledger {
  private accounts = new Map<string, SimAccount>();
  /*
   * **`txs` STOOD HERE, AND `publicView().settlements` READ IT. `C313`.**
   *
   * `settleRound` was its only writer and `C292` removed it, so from that round
   * onward the array was appended to by nothing and read by one method — and
   * that method is the evidence route behind *a public observer learns
   * nothing*. **An isolation claim answered by an empty array is a claim
   * nothing enforces** (rule 27, `C286`), and it is `C302`'s shape: the tests
   * that read it went into `_to_delete/S26-C292/` with the writer, so the
   * emptiness was not even wrong out loud.
   *
   * It is gone rather than left empty because the two are not the same thing to
   * whoever comes next. An empty array is a hole that a future writer fills
   * silently; an absent field is a compile error at the moment somebody tries
   * to publish a settlement, which is when the decision about what an observer
   * may see actually has to be made. **`C122` is the other half**: every field
   * this array carried — `asset`, `amount` as a real integer, and the memo —
   * went to `GET /api/public`, which has no sign-in on it.
   *
   * `core.test.ts`'s *the public observer view carries nothing denominated in
   * money* is what holds the ground it left.
   */

  constructor(
    /**
     * Must match the one `AccountService` uses, for the reason in decision 0004.
     *
     * REQUIRED, WITH NO DEFAULT — R3, and removing it changed nothing that runs:
     * `wiring/selection.ts` already passed it explicitly, and it is the only
     * non-test construction site. It goes because a default is a SECOND PLACE
     * THE ANSWER CAN COME FROM, one layer below `AccountService`'s. Closing one
     * of the two would have left the same defect reachable from here.
     */
    private commitments: CommitmentScheme,
  ) {}

  /**
   * **THE SCHEME THIS LEDGER WAS HANDED, SO IDENTITY CAN BE ASSERTED RATHER
   * THAN ASSUMED.** `T-278` `P2`.
   *
   * The comment above says the pair must match and says it **in a comment and
   * only in a comment**. `S46` closed the product path — `selection.ts:130`
   * reads `SIMULATED.commitments` off the object rather than naming the class a
   * second time, and `one-wiring-point.test.ts` pins that twice, once over the
   * source text and once over the OBJECT `wiring()` returns. **What neither
   * could reach was this field:** nothing could ask a ledger which scheme it
   * held, so a `createLedger` that built the right CLASS with the wrong SCHEME
   * passed everything, and every test constructing the pair by hand was
   * unchecked. `S46`'s own account says so and files it as this row.
   *
   * **A READER AND NOT A REFUSAL, AND THE CHOICE IS DELIBERATE.** The row
   * offers three closures — take the scheme from the same selector, expose it,
   * or refuse a stranger. The first would give this class a second place the
   * answer can come from, which is the exact defect `:1047-1055` removed the
   * default to avoid. The third cannot be written honestly: this class has no
   * way to know which scheme is *the* one without being told, which is the
   * first option wearing a guard's clothes. **Exposing it makes the pair
   * ASSERTABLE, and `one-wiring-point.test.ts` is where the assertion lives —
   * rule 27, and the enforcer is a test rather than this paragraph.**
   *
   * **WHAT IT DOES NOT BUY:** it is not on the `Ledger` interface, so nothing
   * type-level obliges `MidnightLedger` to answer the same question, and a
   * caller constructing the pair by hand is still only checked where somebody
   * writes the check. That is smaller than the row and is not nothing.
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
     * **`'simulated'`, AND THIS IS THE WHOLE OF `C140`.** The value above is
     * `toHex(randomBytes(32))` — sixty-four lower-case hex characters,
     * indistinguishable by shape from an address a chain assigned, on purpose,
     * so that the two paths differ in where the value comes from and in nothing
     * else. **That is precisely why it cannot be left to be inferred.**
     *
     * Saying so here does not stop anything: `companyForSession` decides what
     * to do about it, and development turns the refusal off deliberately. What
     * it stops is real data being sealed under a number this process invented
     * and then losing its key on the day a contract is deployed — `C127` on a
     * scheduled date.
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
       * **ZERO AND EMPTY, ALWAYS, AND THE FIELDS ARE HERE ANYWAY.** `T-220`,
       * `movements` is declared on `SimAccount` and initialised empty at
       * `open` and nothing writes it; retirement is not modelled in this class
       * at all. Reporting them is what makes `LedgerStatus` one shape both
       * implementations answer in — the same reason `assets` is `[]` above —
       * and the interface's own comments say which side is real. **A reader
       * that treats a 0 here as "no payments have completed" is reading a
       * simulator, and `docs/accepted-risks.md` §1's detector must not be
       * pointed at this class.**
       */
      movementCount: a.movements.size,
      retiredVaults: [],
    };
  }

  async propose(
    accountId: string,
    payloadHash: Hex,
    change: StateChange,
    by: SignerRef,
    vault: Hex,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    /*
     * NO "a proposal is already open" CHECK. M-128, and its absence is the
     * feature rather than an omission — this is the exact line that made an
     * admin unable to raise a vendor invoice while payroll collected signatures.
     */
    /*
     * **THE VAULT IS PASSED, AND `R5` IS THE DAY THE COMMENT THAT USED TO BE
     * HERE SAID IT WOULD BE.**
     *
     * It read *"no vault argument yet ... this call starts passing one on the
     * day `core/` learns what a vault is"*, and that is what has happened: the
     * caller names one, `noVault()` where the round concerns none. **Nothing
     * migrated**, exactly as that comment promised — every proposal this layer
     * raised before today concerned no vault, and `noVault()` is what they all
     * pass, so no stored round changes meaning.
     *
     * What DID change is the id: folding the vault in is a different value for
     * the same payload and salt, and it has to be, because that is what makes
     * an approval given for one vault meaningless at another. `SimulatedLedger`
     * is in-memory, so there is nothing to migrate there either.
     */
    /*
     * **THE CONTRACT REFUSES A GOVERNANCE ROUND THAT NAMES A VAULT, AND SO
     * DOES THIS LINE NOW.**
     *
     * **`S47` WROTE THIS ASSERT, MEASURED WHAT IT COST AND REMOVED IT AGAIN,
     * AND I AM OVERTURNING THAT RECORDED DECISION.** Said in those words
     * because rule 20 kept both positions here with neither marked correct and
     * a later round does not get to quietly pick one. `S47`'s AGAINST had two
     * limbs and both have expired: `SC10` §4 said such a change must not ride
     * `T-213`'s re-audit run, and **this is not that run** (`T-213` is open and
     * still `P0`; `66272aa` is `C375`'s arm); and it broke the two cases pinning
     * `C376`/`T-215`, which `S52` has since FIXED and re-pinned. **The `SC5` §3
     * re-audit this creates is owed and is named rather than assumed: `T-320`.**
     *
     * `contracts/src/ConfidentialAccount.compact:2319` asserts
     * `vault == noVault()` on the governance branch, and its own note says what
     * it stops: `payloadHash = runPayload(...)` plus a real vault through the
     * OPAQUE branch mints a BIT-IDENTICAL id to a run's — an `openProposals`
     * row, an `approvalCounts` row and **no `runWindow` row** — after which
     * `recordPayment` pays it and `cancel` fails open, a missing window reading
     * as no restriction. **On `SIMULATED` wiring this class IS the product's
     * enforcement (`src/wiring/selection.ts:144`), so until this line the
     * product had none.**
     *
     * **MEASURED, BOTH DIRECTIONS (rule 9).** With the line: `src/core` is
     * green. Without it and with the old bar restored in `requireApproved`,
     * `a-vault-s-own-threshold.test.ts` is red — the pin now raises its
     * vault-carrying round through `proposeRun`, which is the ONLY door the
     * contract lets carry one, so it survives this refusal instead of being
     * built on a state the chain forbids. That was the third thing `S47` could
     * not have known: its two red cases had become five.
     */
    if (vault !== this.commitments.noVault()) {
      throw new Error(
        'a governance round cannot name a vault: it would mint the same id a payroll run ' +
          'mints, with no payment window, which recordPayment can pay and cancel cannot stop.');
    }
    const id = this.commitments.proposalId(payloadHash, change.salt, vault);
    if (a.openProposals.has(id)) throw new Error('that proposal is already open');
    /*
     * THE PAYLOAD HASH IS KEPT, NOT JUST THE CHANGE, and dropping it was a real
     * bug that made every governance action impossible.
     *
     * A proposal authorised two different things depending on who spent it.
     * `execute` checked the CHANGE — the asset, amount and entries the signers
     * agreed to move. `addSigner`, `removeSigner` and `setThreshold` check the
     * PAYLOAD — the domain-separated statement of which signer, which removal,
     * which threshold. Since `C292` deleted `execute` only the payload half has
     * a reader; the change is stored here and opened by nothing. The first
     * version of this map stored only the change, so
     * the governance methods compared a change commitment against a payload
     * hash. Those can never be equal, so all three refused every legitimate
     * call with "that proposal is not for this signer".
     *
     * The contract does not have this bug: it derives the proposal's own id
     * from `proposalIdOf(payloadHash, vault, salt)` and compares THAT, so the payload is
     * bound by the id itself. The simulation cannot do the same without the
     * salt at spend time, so it keeps the payload and compares it directly —
     * the same rule, checked the way this layer can check it.
     */
    a.openProposals.set(id, {
      payloadHash,
      change: this.changeCommitmentOf(a, change),
      approvals: new Set(),
      vault,
    });
    return this.touch(a);
  }

  /**
   * **RAISES A PAYROLL RUN, AND THE DISTINCTION FROM `propose` IS KEPT RATHER
   * THAN CLAIMED.** The counterpart of the RUN branch at
   * `contracts/src/ConfidentialAccount.compact:2119-2156`.
   *
   * **THE THREE THINGS THAT MAKE IT A RUN AND NOT A GOVERNANCE ROUND WITH A
   * DIFFERENT NAME**, each mirroring a line of that branch:
   *   1. the payload is `runPayload(root, payees, opensAt, closesAt)` and not an
   *      application digest, so the id is one `recordPayment` can recompute;
   *   2. it writes `runWindows`, which `propose` above writes never;
   *   3. It REQUIRES a real vault; `propose` above refuses one.
   *
   * **WHAT THIS LAYER STILL CANNOT DO, WRITTEN DOWN UNDER RULE 27 RATHER THAN
   * LEFT TO BE DISCOVERED:** there is no `recordPayment` here and no block
   * time, so nothing consumes the window and nothing pays against the id. **A
   * green run through this class is evidence that the client builds the right
   * id, and is not evidence that a vault could spend it** — that is what
   * `contracts/test/` is for, and `C371` is the row this project paid to learn
   * the difference.
   */
  async proposeRun(
    accountId: string, run: RunProposal, change: StateChange, by: SignerRef,
  ): Promise<TxRef & { proposalId: Hex }> {
    const a = this.requireSigner(accountId, by);

    /*
     * **REFUSED HERE AS WELL AS ON CHAIN, AND THE DUPLICATION IS DELIBERATE** —
     * `MidnightLedger`'s own words at `src/midnight/ledger.ts:1129-1133`. The
     * contract's asserts give an attacker nothing; these give a person a
     * sentence, before a fee and before anybody signs. The first two mirror
     * `compact:2126` and `:2127`.
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
     * ANYWAY**, from `src/midnight/ledger.ts:1149-1154`. Not for symmetry: a
     * guard the Midnight ledger has and this one does not is this class
     * accepting a sequence the product's other ledger refuses, in the permissive
     * direction, which is `T-215`'s species. Block time is seconds since the
     * Unix epoch; a millisecond window opens in the year 56000.
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
     * the no-vault sentinel is one `recordPayment` can never be handed, because
     * a vault presents ITSELF and recomputes the id from its own address
     * (`compact:2586-2609`). Refused here rather than approved and then
     * unpayable, which is `C375`'s own failure shape one layer along.
     */
    if (run.vault === this.commitments.noVault()) {
      throw new Error(
        'a payroll run must name the vault that will pay it: the vault is folded into the ' +
          'proposal id and recordPayment recomputes the id from it, so a run raised at the ' +
          'no-vault sentinel is one no vault can ever present.',
      );
    }

    const payloadHash = this.commitments.runPayload(
      run.root, run.payees, run.opensAt, run.closesAt);
    const id = this.commitments.proposalId(payloadHash, change.salt, run.vault);
    if (a.openProposals.has(id)) throw new Error('that proposal is already open');

    a.openProposals.set(id, {
      payloadHash,
      change: this.changeCommitmentOf(a, change),
      approvals: new Set(),
      vault: run.vault,
    });
    /* `compact:2156` — the only write of a run's window, and it is here for the
     * same reason it is there: the two branches are told apart by this row. */
    a.runWindows.set(id, { opensAt: run.opensAt, closesAt: run.closesAt });
    return { ...this.touch(a), proposalId: id };
  }

  /**
   * **A RUN'S APPROVED WINDOW, OR `undefined` IF THAT ID IS NOT A RUN.**
   * `C375`, `S47`, added after that round's money-safety pass measured
   * that `runWindows` had NO READER anywhere in the repository.
   *
   * **A DISTINCTION NOTHING CAN OBSERVE IS NOT A DISTINCTION**, which is
   * rule 27 in one line: without this, deleting the window write in
   * `proposeRun` left the whole suite green, and the claim that this class
   * tells a run from a governance round was held up by the claim itself.
   *
   * **OFF THE `Ledger` INTERFACE, DELIBERATELY, LIKE `publicView`.** The
   * counterpart on chain is a public ledger field anybody can read
   * (`contracts/src/ConfidentialAccount.compact:354`) and
   * `contracts/test/simulator.ts:671` already exposes it the same way for the
   * same purpose. Putting it on the boundary would oblige `MidnightLedger` to
   * answer it, which is a chain read this round has not built and does not
   * need — and an interface method with an invented implementation is the rule
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
     * `leaf@proposal`, where the contract burns `H(domain, self, proposal, sk)`.
     * Ours names the signer and the contract's does not — that is the second
     * deliberate difference, and it is a privacy property rather than a rule:
     * both burn exactly once per signer per proposal, so both accept and reject
     * the same sequences.
     */
    const nullifier = `${by.leaf}@${proposalId}`;
    if (p.approvals.has(nullifier)) throw new Error('you have already approved this proposal');
    p.approvals.add(nullifier);
    return this.touch(a);
  }

  /*
   * `settleRound` STOOD HERE.
   *
   * It checked the approved change against the account's own balance, applied
   * it, and appended a transfer row — the balance book, end to end. The book is
   * gone and so is the circuit it drove.
   *
   * WHAT `R6` BOUGHT IS NOT DISCARDED WITH IT. The rule it established — an
   * operation with two halves is one transaction or it refuses — was learned
   * here at the cost of a window in which money moved and the record did not.
   * The vault path, when it is built, either satisfies it or refuses.
   */

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
     * row at `contracts/src/ConfidentialAccount.compact:1338`. A window
     * outliving its proposal would make `runWindows.has(id)` answer *yes, a
     * run* about an id that is no longer open — the stale half of `C375`'s own
     * distinction. Governance rounds have no row, so this deletes nothing for
     * them and needs no branch.
     */
    a.runWindows.delete(proposalId);
    return this.touch(a);
  }

  /**
   * M-69, mirroring the contract's two paths exactly — including the boundary
   * between them, which is `signerCount < threshold` and not something more
   * intuitive like "has the account been used yet".
   */
  async addSigner(
    accountId: string, leaf: Hex, proposalId: Hex | null, by: SignerRef,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    if (a.signerLeaves.has(leaf)) throw new Error('that signer is already in the set');

    if (a.signerLeaves.size < a.threshold) {
      // Bootstrap. Any existing signer may add another, because the account
      // cannot yet collect the approvals its own threshold requires.
      a.signerLeaves.add(leaf);
      return this.touch(a);
    }

    if (!proposalId) throw new Error('adding a signer needs an approved proposal');
    const approved = this.requireApproved(a, proposalId);
    // The approved proposal has to be for THIS leaf. Without this any approved
    // proposal would authorise adding anyone — the same hole in a different place.
    if (approved.payloadHash !== this.commitments.signerAddPayload(leaf)) {
      throw new Error('that proposal is not for this signer');
    }

    a.signerLeaves.add(leaf);
    a.openProposals.delete(proposalId);
    return this.touch(a);
  }

  async removeSigner(
    accountId: string, removedLeaf: Hex, proposalId: Hex, by: SignerRef,
  ): Promise<TxRef> {
    const a = this.requireSigner(accountId, by);
    const approved = this.requireApproved(a, proposalId);
    if (approved.payloadHash !== this.commitments.signerRemovePayload(removedLeaf)) {
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
     * DISAGREED.** `T-225` `P3`. `setVaultThreshold` below refuses a
     * non-integer at BOTH boundaries and `setThreshold` refused it at NEITHER,
     * and `S46` closed the same asymmetry one layer down at
     * `src/midnight/ledger.ts:1293` — leaving this the last of the pair. Six
     * spellings of one floor across two operations is how one of them stops
     * matching, which is what the row was filed for rather than for anything
     * being wrong today: the direction was already safe and loud, because
     * `BigInt(2.5)` throws a `RangeError` before any binding.
     */
    if (!Number.isInteger(newThreshold) || newThreshold < 1) {
      throw new Error('the threshold must be at least one');
    }
    /*
     * The M-37 guard, and the one that is easy to miss. `addSigner` treats
     * `signerCount < threshold` as "still being set up" and lets ONE signer seat
     * another. Raising the threshold above the number of seated signers would
     * hand that power back.
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
     * the NEW threshold when it settles. Under the round design this call burned
     * every approval on the account, including ones given to a payment that was
     * a signature from settling.
     */
    a.openProposals.delete(proposalId);
    return this.touch(a);
  }

  /**
   * **ONE VAULT'S OWN THRESHOLD.** The counterpart of
   * `setVaultThreshold` at `contracts/src/ConfidentialAccount.compact:2699`,
   * check for check.
   *
   * `requireApproved` and not a vault-aware read, deliberately and matching the
   * circuit: the round behind this names `noVault()`, so it is measured against
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
     * **THE CONTRACT'S OWN SENTENCE, AND ITS OWN REASON.** `:2777`: *"a vault
     * threshold of zero would authorise anything"* — `thresholdFor` would
     * answer 0, `approvals >= 0` holds before anybody has approved, and every
     * payment out of that vault would settle on the proposer's word alone. It
     * is the `C121` shape written into chain state. `< 1` rather than `=== 0`,
     * because a negative or fractional number is not a threshold either and
     * `Uint<64>` is what the contract's type refuses on its side.
     */
    if (!Number.isInteger(newThreshold) || newThreshold < 1) {
      throw new Error('a vault threshold of zero would authorise anything');
    }
    /*
     * **NO SIGNER-COUNT BOUND, COPIED RATHER THAN OVERLOOKED** (`:2693-2697`):
     * a vault has no bootstrap window to reopen, so an unmeetable vault bar is
     * recoverable rather than dangerous. **The application still refuses to
     * RAISE one** (`AccountService.proposeVaultThresholdChange`), and that
     * refusal belongs there: a rule only one implementation has is two.
     *
     * **AND NO `noVault()` REFUSAL EITHER, WHICH IS `C368` AND IS DELIBERATE.**
     * `S55`, rule 27. `compact:1372` says `thresholdFor(noVault())` cannot occur
     * *by construction*; `:2778` inserts whatever key it is handed, so the
     * construction is a CLIENT HABIT — `AccountService.setVaultThreshold`
     * refuses the sentinel on BOTH paths. **Not added here: the
     * chain has none, and `MidnightLedger` has none either, so the INTER-LEDGER
     * parity this file really applies does not compel it.**
     */
    a.vaultThresholds.set(vault, newThreshold);
    a.openProposals.delete(proposalId);
    return this.touch(a);
  }

  /*
   * `writeState` STOOD HERE AND `S52` DELETED IT. `T-226` `P3`. Sole
   * occurrence in the repository was its own definition.
   *
   * **ITS RULE IS THE PART WORTH KEEPING:** a state transition supersedes
   * every epoch, because the state itself moved — the old ciphertexts are for
   * a state that no longer exists, and keeping them would let a caller read a
   * stale balance by asking for the wrong epoch. There is no balance since
   * `C292`, which is why nothing called this.
   */


  async reseal(accountId: string, next: SealedStateAt): Promise<void> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error('account not found on this ledger');
    // Alongside, never over. See `SealedStateAt`: replacing is what makes a
    // crash mid-rotation unrecoverable.
    if (a.sealedStates.has(next.keyEpoch)) {
      throw new Error(
        `the state for "${accountId}" is already sealed at key epoch ${next.keyEpoch}. ` +
          'Re-sealing over an existing epoch would destroy the only copy under that key.',
      );
    }
    a.sealedStates.set(next.keyEpoch, next.sealed);
  }

  async fetch(accountId: string, keyEpoch: number): Promise<LedgerRecord | null> {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    const sealedState = a.sealedStates.get(keyEpoch);
    if (!sealedState) {
      throw new Error(
        `no sealed state for "${accountId}" at key epoch ${keyEpoch}. The account record and ` +
          'the state store disagree about which viewing key is current, which is what a ' +
          'half-finished rotation looks like. See K-4.',
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
       * **THERE IS NO `settlements` HERE, AND ITS ABSENCE IS THE CLAIM.**
       *
       *
       * This method is the evidence behind *a public observer learns nothing*,
       * so what it omits has to be omitted on purpose. Nothing settles at the
       * account: `C292` took the balance, `settleRound` and `execute` with it,
       * and the account is an authority over a vault rather than a holder of
       * money. **A `settlements: []` stood here for that whole period and read
       * as evidence** — an isolation property held by an empty data structure,
       * which names nothing that enforces it (rule 27, `C286`).
       *
       * **WHOEVER BUILDS VAULT PAYROLL DECIDES WHAT AN OBSERVER SEES OF IT, AND
       * THIS IS WHERE THAT DECISION LANDS.** It is not a matter of refilling an
       * array: a settlement row carried the asset and the amount as a real
       * integer to an endpoint with no sign-in on it, so the next
       * shape has to be argued rather than inherited. Until then this method
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
   * check comparing them was decorative. `C292` left `propose` as the only
   * caller, and nothing compares the result to anything.
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
     * **THE BAR IS THE ACCOUNT'S, AND NEVER A VAULT'S.** `C376`, `T-215`,
     * This is the counterpart of the contract's `requireApproved`
     * (`contracts/src/ConfidentialAccount.compact:1407`), which reads
     * `threshold` directly with NO map lookup — and every governance circuit
     * on chain lands there. Measured at source by this round: `requireApproved`
     * has six callers, `amendSigner` (`:1756`, `:1921`), `setThreshold`
     * (`:2014`), `setVaultThreshold` (`:2775`), `adopt` (`:2810`) and
     * `retireVault` (`:2869`); `requireApprovedForVault` (`:1384`) has exactly
     * ONE, `recordPayment` (`:2697`).
     *
     * **THIS READ A VAULT'S THRESHOLD UNTIL 4 Sep, AND THAT WAS THE WRONG ONE
     * OF THE CONTRACT'S TWO ENTRY POINTS.** The four callers below are all
     * governance — `addSigner`, `removeSigner`, `setThreshold`,
     * `setVaultThreshold` — so this method is the mirror of `requireApproved`
     * and of nothing else. The vault-aware rule belongs to the PAYMENT path,
     * where it is modelled correctly and separately by `thresholdFor` (above,
     * `:455`) reached through `approvalsOnChain`; the two must not be the same
     * function, because the contract deliberately made them two circuits and
     * measured what the split saved (`:1362-1382`).
     *
     * **WHAT THE OLD SHAPE COST, AND IT IS NOT HYPOTHETICAL ON THIS LEDGER.**
     * `src/wiring/selection.ts:144` is `const SELECTED: Wiring = SIMULATED`, so
     * this class is what the product runs on. With the lookup here, a
     * governance round naming a vault whose bar had been lowered was judged at
     * THAT lower bar — so `setThreshold` and `removeSigner`, which are the
     * recovery path, executed below the account's own threshold, and
     * `setVaultThreshold` could lower a vault further on the authority of the
     * bar it had already been lowered to. `setVaultThreshold` below says in its
     * own words that this cannot happen — *"a vault's own lowered bar can never
     * be the bar that lowers it further"* — and until this round that sentence
     * was FALSE, which is rule 14 and `C286`'s shape.
     *
     * **RULE 27 — WHAT ENFORCES IT.** Not a habit and not this comment.
     * `src/core/a-vault-s-own-threshold.test.ts`, the FOUR cases under *"a
     * governance round is judged by the ACCOUNT's threshold"*. **`S55` MADE THIS
     * PARAGRAPH FALSE AND IS THE ROUND CORRECTING IT:** three of them now carry
     * the vault on a RUN (`proposeRun`), because `T-237` made a governance round
     * naming a vault refusable here as the contract refuses it; the fourth seats
     * the SENTINEL and pins the bar on a genuine governance round. They
     * drive this class directly — the five product doors all pass `noVault()`
     * (`account.ts:1137`, `:1236`, `:1423`, `:1634`, `:2349`). **MEASURED: a
     * vault-aware ternary turns FOUR red; `Math.max(account, vault)` turns ONE.**
     *
     * **WHAT IS STILL NOT MIRRORED, SAID SO IT IS NOT READ AS CLOSED.** The
     * contract defends this THREE times, and `S52`'s money-safety pass
     * corrected this paragraph from *twice*: the account-threshold bar here;
     * `propose`'s `assert(vault == noVault())` on the governance branch
     * (`:2319`, `C363`); and every governance circuit RE-DERIVING the proposal
     * id with `noVault()` folded in (`:1758`, `:1926`, `:2016`, `:2773`,
     * `:2808`, `:2867`), so a round raised at a real vault mints an id no
     * governance circuit can match. `SimulatedLedger` carries neither of the
     * other two — its governance methods compare `approved.payloadHash` and
     * never re-derive the id — so **this layer now has ONE of the contract's
     * THREE defences where it had none.** The second is `T-237`; the third is
     * `T-289`, and it prices `T-237` low by one — **the boundary models FOUR of
     * those six sites (`amendSigner` twice, `setThreshold`, `setVaultThreshold`)
     * and has no method at all for `adopt` or `retireVault`. `S56`.**
     */
    const bar = a.threshold;
    if (p.approvals.size < bar) {
      throw new Error(`not enough approvals yet: ${p.approvals.size} of ${bar}`);
    }
    /*
     * BOTH, and the caller picks. Returning only one of them is what caused
     * M-130: `execute` wanted the change, the governance circuits want the
     * payload, and a helper that answered with the wrong one made the domain
     * separators dead code — every governance call refused, and no test noticed
     * until the suite was run rather than reasoned about. `execute` went with
     * the balance ledger, so the change half of this pair now has no
     * reader and only the payload half is compared to anything.
     */
    return { payloadHash: p.payloadHash, change: p.change };
  }

  /*
   * `requireCurrentView` STOOD HERE, mirroring the contract's circuit of the
   * same name. `C292` deleted both in the same turn — the rule it enforced was
   * "your view of this asset's balance is current", and there is no balance.
   *
   * THE ASSET CHECK IT CARRIED IS NOT REPLACED BY `changeCommitmentOf`, and an
   * earlier version of this sentence said it was. Nothing opens a change
   * commitment at settlement any more — `execute` was its only reader — so the
   * asset inside it is written and never compared. What actually refuses a
   * payment in the wrong token is the token inside `payoutDetails`, inside the
   * leaf, inside the approved root, inside the proposal's id. C286, rule 27:
   * the enforcer is named where the property is claimed, or it is not enforced.
   */

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
   * There is no single state commitment on chain — M-125 replaced it with a map
   * of per-asset commitments, and M-128 replaced the entry digest with a set —
   * so the honest answer was a digest OVER those. `C292` removed the map as
   * well, so it is a digest over nothing and is ONE CONSTANT. It still
   * addresses a stored blob; it can NO LONGER show an observer that something
   * changed. Nothing verifies against it, and nothing should, which is why it is built
   * from the scheme's own outputs rather than being a further commitment scheme
   * (decision 0004).
   */
  private viewDigest(_a: SimAccount): Hex {
    // Over nothing, because there is nothing per-asset on chain any more.
    // `C292`. Kept as a call rather than inlined so the one definition of
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
       * EVERY COMPARISON BELOW IS BIGINT TO BIGINT.
       *
       * These read `typeof witness.balance === 'number'` until today, and the
       * failure that change avoids is worth naming: a bigint balance would have
       * made that test false, so `prove` would have refused EVERY solvency
       * attestation with "statement is false" — for a true statement. A
       * refusal is the safe direction, and it would still have been a
       * fortnight of somebody wondering why the demo stopped working.
       *
       * `Number(…)` on the public inputs would have been the unsafe direction:
       * it silently rounds anything past 2^53, so an ETH floor and an ETH
       * balance differing by a few hundred wei would compare EQUAL and a false
       * statement would prove.
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
 * What must never happen is a third definition appearing somewhere. See
 * decision 0004 for what that cost last time.
 */
export interface CommitmentScheme {
  /**
   * **A SIGNER'S PUBLIC IDENTITY, FROM THEIR SIGNING SECRET.**
   *
   * The first argument of `signerLeaf`, and until `S34` every product writer
   * passed an ed25519 public key into it while the contract read something
   * else. `signerPublicKey` in `contracts/src/ConfidentialAccount.compact` is
   * `persistentHash([pad(32, "midnight-accounts:signer:pk:"), sk])` over the
   * SECRET, and `requireSigner()` builds the leaf it looks for in the tree from
   * that. `ed25519.getPublicKey(sk)` is a scalar multiplication and is
   * different, uncorrelated 32 bytes. Every seat this product has ever written
   * was therefore a seat no device could ever prove.
   *
   * **IT IS ON THE SCHEME FOR THE REASON `noVault` AND `allVaults` ARE, AND
   * THAT IS THE WHOLE ANSWER TO "REACH THE CIRCUIT OR RESTATE IT".** `core/`
   * cannot import the generated code — that dependency rule is what keeps the
   * standalone build working, and it is stated at the head of this interface.
   * So `core/` asks the scheme it was handed, and the Midnight scheme's
   * implementation is one line that calls `pureCircuits.signerPublicKey`.
   * **Nothing restates the hash in TypeScript**, which is what `M-104` cost and
   * what `C306` is the standing row for.
   *
   * The simulated scheme derives its own, deliberately unrelated — `S32`'s rule
   * that `SimulatedCommitments` must never agree with the contract, and the
   * same rule the two sentinels already follow.
   *
   * **THE ARGUMENT IS THE SECRET, AND THAT IS WHY THIS IS NOT ON THE LEDGER
   * BOUNDARY.** A scheme is a pure function table with no state and no network;
   * `SignerRef` excludes secrets on purpose and this does not change that.
   */
  signerPublicKey(signingSecret: Hex): Hex;
  /**
   * A signer's blinded leaf in the signer tree.
   *
   * `commit(publicKey, blinding)`, and nothing else — decision 0003's shape.
   *
   * M-99 bound it to a GENERATION, because the tree was append-only and
   * accepted any historic root, so the only way to invalidate one signer's leaf
   * was to invalidate everybody's and re-seat the survivors. M-106 replaced
   * that with a slot per signer in a plain tree: one slot can be cleared on its
   * own, so a leaf never has to change and nothing needs stamping on it.
   */
  signerLeaf(signerPublicKey: Hex, blinding: Hex, scope?: Hex): Hex;
  /**
   * WHICH ASSET A CHANGE COMMITMENT NAMES. M-125, and since `C292` that is the
   * only thing it does — there is no on-chain map for it to index.
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
   * from. The vault joined the preimage at `R5`; the DOMAIN TAG joined it at
   * `S32`, `C317`, because without it this derivation and `signerLeaf` were the
   * same function up to a permutation of their arguments. The contract's own
   * shape is `proposalIdOf` in `contracts/src/ConfidentialAccount.compact`.
   * Computed by the client so that a proposal has an identity before it is
   * submitted, which is what lets an approval be prepared without a round trip.
   */
  /**
   * **WHAT A PAYROLL RUN IS, BEFORE IT HAS AN IDENTITY.** `V-41`, and it moved
   * ONTO this interface in `S47` for `C375`.
   *
   * **THE SENTENCE THAT KEPT IT OFF IS QUOTED BELOW AND ITS PREMISE HAS
   * CHANGED, WHICH IS WHY THE MOVE IS NOT A RELAXATION OF THE RULE BUT AN
   * APPLICATION OF IT.** `src/midnight/commitments.ts:58-67` read: *"the
   * simulated one has no payroll runs to raise. Putting it there would force a
   * simulated implementation of a value nothing simulated ever produces."* That
   * was true and is now false: `SimulatedLedger.proposeRun` raises one, and
   * really computes this value to build the id it hands back. **The rule's own
   * test — a value stays OFF this interface when one side would have to INVENT
   * an implementation to satisfy a type — now points the other way**, exactly
   * as it did for the four governance payloads when `S44` moved them here.
   * Nothing is invented and no second definition of a rule is created.
   *
   * **THE TWO SPELLINGS STAY APART AND MUST.** `MidnightCommitments.runPayload`
   * is one line calling `pureCircuits.runPayload`, so the client never derives
   * the payload a second way — `recordPayment` recomputes it on every payment
   * (`contracts/src/ConfidentialAccount.compact:2606-2609`) and a second
   * derivation is a proposal id no payment can match, discovered after the
   * approvals were collected and the fees paid. `SimulatedCommitments` keeps
   * its own `sha256`, deliberately unequal, like `signerPublicKey` and the two
   * sentinels; `contracts/test/one-definition.test.ts` pins both halves.
   *
   * **SECONDS, NOT MILLISECONDS**, for the reason on `RunProposal`.
   */
  runPayload(root: Hex, payees: bigint, opensAt: bigint, closesAt: bigint): Hex;
  proposalId(payloadHash: Hex, salt: Hex, vault?: Hex): Hex;
  /**
   * The two reserved sentinels. V-32, V-33.
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
   * IT WAS ONE VALUE DOING TWO JOBS — the approved change and the settled
   * movement — on the argument that what the signers approved and what is
   * recorded as having happened are the same fact. THAT IS NO LONGER THE SHAPE.
   * `C292` deleted the circuit that settled, and what the contract records as a
   * movement is `paidMovementOf(leaf)` (that circuit in
   * `contracts/src/ConfidentialAccount.compact`, inserted by `recordPayment`,
   * its only writer), derived from the payee's leaf and not from
   * this. Decision 0004 still binds each of them separately: one derivation per
   * fact, in one place.
   */
  changeCommitment(assetKey: Hex, amount: bigint, batchDigest: Hex, salt: Hex): Hex;
  /**
   * **WHAT IS BEING APPROVED, IN THE FOUR GOVERNANCE ROUNDS.**
   *
   * These four were `sha256` functions at module scope in this file, imported
   * and called DIRECTLY by `AccountService` whatever ledger was wired beneath
   * it, while the executing circuits re-derive the same four with
   * `persistentHash` over a padded tag
   * (`contracts/src/ConfidentialAccount.compact:930`, `:950`, `:964`, `:1148`).
   * **They can never agree, and nothing found out until the end:** `propose`
   * takes the payload hash as an OPAQUE argument and asserts nothing about it,
   * so the round is raised, collects its approvals and burns its fees, and
   * `amendSigner`, `setThreshold` and `setVaultThreshold` refuse at `:1926`,
   * `:1758`, `:2016` and `:2708`, each recomputing the payload with its own
   * circuit and comparing the id. `C371` threw before anything was signed;
   * this threw after.
   *
   * **THEY ARE ON THIS INTERFACE, AND THE RULE THAT DECIDES IT IS WRITTEN AT
   * `src/midnight/commitments.ts:58-67`:** a value stays OFF the shared
   * interface when one side would have to invent an implementation of it to
   * satisfy a type. **THIS PARAGRAPH USED TO CONTINUE *`runPayload` is off it
   * because nothing simulated ever raises a payroll run*, AND `S47` MADE THAT
   * FALSE RATHER THAN REPEALING IT:** `SimulatedLedger.proposeRun` raises one,
   * so `runPayload` is above, by the same test that put these four here. **The
   * `RunCommitments` interface it named is gone with it** — one member, one
   * implementer, and nothing left to separate. **These four are the same case,
   * and it is a fact about this file rather than a judgement:**
   * `SimulatedLedger` seats a signer, removes one, and moves both the account's
   * and a vault's threshold, and recomputes all four payloads to check the
   * round it is handed (`addSigner`, `removeSigner`, `setThreshold`,
   * `setVaultThreshold` below). Both implementations really do produce these
   * values, so neither is invented and no second definition of a rule is
   * created by putting them here.
   *
   * **THE SIMULATED SCHEME KEEPS ITS OWN `sha256` SPELLING AND THE TWO STAY
   * APART** — the same arrangement as `signerPublicKey` and the two sentinels,
   * and the same one `what-a-signer-is.test.ts:253` already pins as deliberate.
   * `contracts/test/one-definition.test.ts` asserts both halves: that the
   * Midnight side EQUALS the circuit, and that the simulated side does not.
   *
   * **THREE OF THE FOUR NAMES DIFFER FROM THE CIRCUITS' AND THAT IS WHERE A
   * MIS-WIRE LANDS.** `signerRemovePayload` is the circuit's
   * `removeSignerPayload`; `signerThresholdPayload` is its
   * `setThresholdPayload`; `vaultThresholdPayload` is its
   * `setVaultThresholdPayload`. Only `signerAddPayload` matches. The names are
   * kept as they were rather than renamed to the circuits' — a rename is churn
   * across the register and the build log and would not have caught `C373`,
   * which was never a naming mistake — and what catches a swap is the mirrored
   * entry per circuit in `one-definition.test.ts`, which is mechanical.
   *
   * **THE THRESHOLDS ARE `number` HERE AND `Uint<64>` THERE.** The Midnight
   * implementation converts; the binding refuses a JavaScript `number` by name,
   * measured: *"type error: setThresholdPayload argument 1 ... expected value
   * of type Uint<0..18446744073709551616> but received 2"*.
   */
  signerAddPayload(leaf: Hex): Hex;
  signerRemovePayload(removedLeaf: Hex): Hex;
  signerThresholdPayload(newThreshold: number): Hex;
  vaultThresholdPayload(vault: Hex, newThreshold: number): Hex;
  describe(): string;
}

export const SimulatedCommitments: CommitmentScheme = {
  /**
   * **DELIBERATELY NOT THE CONTRACT'S DERIVATION, AND IT MUST NEVER BECOME
   * IT.** `S32`, and `C328` is why this method exists at all.
   *
   * The contract hashes `[tag, sk]` with `persistentHash`; this keys an HMAC
   * with the secret, which is the same construction its siblings below use and
   * is not `persistentHash` in any spelling. The two schemes never mix — a
   * commitment is only ever checked against the scheme that made it — so what
   * matters is that this one is internally consistent and that no value it
   * produces can be mistaken for one the chain would accept.
   *
   * **WHAT CHANGED FOR THE SIMULATED PATH TOO:** the public half is now derived
   * from the SECRET on both sides, so the shape of the rule is the same
   * everywhere and only the algorithm differs. Before `S34` this side had no
   * such method and the writers passed an ed25519 key, which agreed with
   * nothing except itself.
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
    /* `this`, NOT `SimulatedCommitments`. `T-224` `P3`, `S52`: the interface
     * puts the sentinels on the SCHEME so a scheme is one definition, and a
     * member reaching past the object it was called on made that benefit
     * undeliverable — a scheme that overrode a sentinel had the override
     * ignored by two of its own members. `C373`'s shape inside the object
     * that fix was made in. Measured: exactly two such sites, both closed. */
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
   * **THE VAULT IS FOLDED IN, AND UNTIL `R5` IT WAS ACCEPTED AND DROPPED.**
   *
   * The parameter was on the interface from V-32 so both schemes had the same
   * shape, and this implementation ignored it — harmless while every caller
   * passed nothing, and a silent defect the moment one passed something: two
   * different vaults would have produced the SAME id, so an approval collected
   * for one would count towards the other and a round could settle at the wrong
   * vault's threshold. The Midnight scheme has always folded it in
   * (`src/midnight/commitments.ts:178`).
   *
   * Defaulted to `noVault()` for the same reason that scheme defaults it: the
   * two must agree about what "no vault" means, and a caller with no vault
   * still needs a value in the slot.
   */
  /**
   * **DELIBERATELY NOT THE CONTRACT'S DERIVATION.** `S47`, and the same
   * arrangement as `signerPublicKey`, the two sentinels and the four governance
   * payloads: the contract's is `persistentHash` over a padded tag
   * (`contracts/src/ConfidentialAccount.compact:1100-1113`), this is `sha256`
   * over a domain string, and the two schemes never mix — a commitment is only
   * ever checked against the scheme that made it.
   *
   * **THE ARGUMENTS ARE STRINGIFIED IN FULL AND NOT NARROWED.** `${payees}` on
   * a bigint is its decimal digits with nothing to round, which is the same
   * reason `changeCommitment` spells its amount that way. A `Number()` here
   * would collapse two windows a second apart past 2^53 into one value, and two
   * runs with one id is the failure this whole derivation exists to prevent.
   */
  runPayload(root, payees, opensAt, closesAt) {
    return toHex(sha256(utf8(
      `midnight-accounts:run:${root}:${payees}:${opensAt}:${closesAt}`)));
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
   *
   * The bodies are the ones that stood at module scope in this file, moved
   * behind this object rather than rewritten: same domain strings, same hash,
   * same values, so nothing the simulation has already produced changes
   * meaning. What changed is that they are no longer EXPORTED. That direct
   * import was `C373` itself — `AccountService` reached past the scheme it was
   * handed and called the simulated spelling whatever ledger sat beneath it,
   * so a Midnight-backed service named its rounds with a hash the contract has
   * never computed.
   *
   * They are deliberately NOT the contract's, exactly like `signerPublicKey`
   * and the two sentinels above, and `one-definition.test.ts` pins that they
   * stay apart. The two schemes never mix: a commitment is only ever checked
   * against the scheme that made it, which is now true of these four as well.
   */
  signerAddPayload(leaf) {
    return simulatedSignerAddPayload(leaf);
  },
  signerRemovePayload(removedLeaf) {
    return simulatedSignerRemovePayload(removedLeaf);
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
