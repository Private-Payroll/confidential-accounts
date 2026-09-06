/**
 * The real commitment scheme: the contract's own circuits, called from
 * TypeScript.
 *
 * `assetKeyOf`, `changeCommitmentOf` and `signerLeaf`
 * are pure circuits, so the compiler generates plain functions for them and they
 * run with no proof server, no node and no proving keys. That means the client
 * can compute a value the chain will accept without talking to anything.
 *
 * This file exists so that there is exactly one definition of each scheme, and
 * it lives in the contract. `core/` cannot call these, because importing
 * generated Midnight code into the isomorphic layer breaks the standalone
 * build, so `core/` has its own simulated scheme for the simulated ledger. The
 * rule is that a commitment is only ever checked against the scheme that made
 * it, and `AccountService` takes the scheme as a constructor argument so the
 * two cannot drift apart by accident.
 *
 * Decision 0004 is the record of what happened the last time this was spread
 * across three files.
 */
import type { CommitmentScheme } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import { fromHex, toHex } from '../core/crypto.js';
import { assetIdBytes, MAX_CHANGE_AMOUNT } from '../core/assets.js';
import type { AssetId } from '../core/assets.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';

/**
 * The largest amount the contract can hold.
 *
 * `Uint<128>`, and the width is a decision rather than a default. Amounts are
 * integers in the asset's smallest unit, so one ether is 10^18 — and a
 * `Uint<64>` stops at 18,446,744,073,709,551,615, which is about EIGHTEEN
 * ether. An account could not hold twenty. 128 bits carries 3.4 x 10^20 ether,
 * which is more than exists, and the same width covers every fiat balance any
 * company will ever have.
 *
 * Checked here rather than trusted, because the failure without it is silent on
 * this side and a proof failure on the other: `BigInt` has no width, so an
 * over-wide amount reaches the circuit and fails there, naming nothing useful.
 */
/**
 * **ONE DEFINITION, AND IT IS `src/core/assets.ts`'s.** It moved
 * there because `core/` builds the change and may not import `src/midnight/`
 * (`src/wiring/selection.ts:84-93`), so the value had to be readable from the
 * side that makes it. This name is kept because this file's error messages read
 * better with it and removing an export from a tier-1 money-path file is a
 * drive-by; it is an alias, not a second declaration.
 */
export const MAX_AMOUNT = MAX_CHANGE_AMOUNT;

const checkAmount = (v: bigint, what: string): bigint => {
  if (typeof v !== 'bigint') {
    throw new Error(`${what} must be a bigint in the asset's smallest unit, got ${typeof v}`);
  }
  if (v < 0n) throw new Error(`${what} must not be negative, got ${v}`);
  if (v > MAX_AMOUNT) {
    throw new Error(
      `${what} of ${v} does not fit in the contract's Uint<128>. The largest amount this ` +
        `contract can hold is ${MAX_AMOUNT}.`,
    );
  }
  return v;
};

/*
 * **`RunCommitments` STOOD HERE, AND `S47` DELETED IT RATHER THAN LEAVING IT
 * EMPTY.**
 *
 * It held one member, `runPayload`, above this sentence:
 *
 *   *"`runPayload` is not on `CommitmentScheme` and should not be: that
 *   interface is the contract between the two ledgers, and the simulated one
 *   has no payroll runs to raise. Putting it there would force a simulated
 *   implementation of a value nothing simulated ever produces — a second
 *   definition of a rule, which is this project's most expensive recurring
 *   mistake, invented to satisfy a type."*
 *
 * **THE RULE IS RIGHT AND IS NOT REPEALED. ITS PREMISE IS WHAT CHANGED.** The
 * simulated ledger now DOES raise payroll runs — `SimulatedLedger.proposeRun`,
 * `src/core/ledger.ts` — because until it could, nothing typed to the `Ledger`
 * boundary could raise one at all, and every payroll round the product raised
 * went through the governance door carrying a payload hash `recordPayment` can
 * never reproduce. That is `C375`. So `runPayload` is on `CommitmentScheme`,
 * both sides genuinely produce it, and nothing is invented to satisfy a type —
 * which is the rule applied, not relaxed. `S44` moved the four governance
 * payloads across the same way and for the same reason.
 *
 * **AND THE INTERFACE IS DELETED RATHER THAN KEPT AS AN ALIAS.** An empty
 * `RunCommitments` beside a `CommitmentScheme` that carries its member is a
 * second name for one thing, and `M-104` is the row for what this project pays
 * when one rule has two spellings.
 */

export const MidnightCommitments: CommitmentScheme = {
  /*
   * Note the absence of `as any` on these calls.
   *
   * They used to carry one, and it cost a real defect: M-99 gave `signerLeaf` a
   * third parameter, and a second call site in `midnight/ledger.ts` went on
   * passing two with the compiler unable to say so. A cast here
   * disables the only gate that catches an arity drifting away from the
   * contract — which is M-42's lesson, recorded and then repeated. M-125 adds a
   * parameter to `changeCommitmentOf` and splits `stateCommitmentOf` in two, so
   * the gate is doing work again today.
   */
  /**
   * **A SIGNER'S PUBLIC IDENTITY, WHICH IS THE CONTRACT'S OWN CIRCUIT AND NOT A
   * COPY OF IT.**
   *
   * One line, and the line is a call. That is the entire answer to whether the
   * product path can reach `pureCircuits` where its writers run: it does not
   * reach for them — it asks the scheme it was handed, and the scheme lives
   * here, in the one module that wraps the generated circuits. A restatement of
   * `persistentHash([pad(32, "midnight-accounts:signer:pk:"), sk])` in
   * TypeScript would be a second implementation of the rule that decides who
   * may approve a payment, which is `M-104`'s shape and `C306`'s standing
   * warning about a test that then compares it to itself.
   *
   * `contracts/test/one-definition.test.ts` asserts this against the circuit.
   */
  signerPublicKey(signingSecret: Hex): Hex {
    return toHex(pureCircuits.signerPublicKey(fromHex(signingSecret)));
  },

  /**
   * A signer's leaf.
   *
   * `scope` is the third argument since V-33 and every caller passes
   * `ALL_VAULTS` today — nothing branches on it. It is in the LEAF because a
   * leaf's shape cannot change later without re-seating every signer on the
   * account, so the field is reserved now while that costs nothing.
   *
   * Defaulted rather than required, deliberately: a default keeps every
   * existing call site correct AND keeps the value out of reach of a caller
   * who has no business choosing it. When per-vault scopes are real, the
   * seating path passes one explicitly and everything else keeps inheriting.
   */
  signerLeaf(signerPublicKey: Hex, blinding: Hex, scope?: Hex): Hex {
    const s = scope === undefined ? pureCircuits.allVaults() : fromHex(scope);
    return toHex(pureCircuits.signerLeaf(fromHex(signerPublicKey), fromHex(blinding), s));
  },

  /**
   * WHICH ASSET A CHANGE COMMITMENT NAMES. M-125, and since `C292` the only
   * thing it does — there is no on-chain map for it to index.
   *
   * The blinding is the ACCOUNT's, not a signer's, and every signer derives the
   * same key from it — which is the whole requirement. See `assetBlinding` in
   * contracts/src/witnesses.ts for why it is shared where a signer's blinding is
   * not.
   */
  assetKey(asset: AssetId, assetBlinding: Hex): Hex {
    return toHex(pureCircuits.assetKeyOf(assetIdBytes(asset), fromHex(assetBlinding)));
  },

  /*
   * `balanceCommitment` STOOD HERE, wrapping the contract's own
   * `balanceCommitmentOf`. Both are gone with the balance.
   */

  /**
   * What the chain calls a proposal.
   *
   * A pure circuit for the same reason the commitments are: the client has to
   * produce a value the chain will accept without asking anything, and here
   * that matters more than usual — a signer's device needs this id to APPROVE,
   * so computing it in TypeScript would put the identity of every proposal in a
   * second place and let the two disagree about which round somebody signed.
   */
  /**
   * A proposal's on-chain identity.
   *
   * `vault` is committed INSIDE the id since V-32, so an approval raised for
   * one vault is not a rejected id at another — it is a different id entirely,
   * matching nothing. That is what lets a vault ask the account whether a
   * payment was approved without the account needing to know who is asking,
   * which matters because a contract cannot see its caller.
   *
   * Defaults to `noVault()`: governance and the account's own internal ledger
   * concern no vault, and every caller today is one of those.
   */
  /**
   * The two reserved sentinels, from the contract rather than written out here.
   *
   * Both are hashes of domain strings, so nothing can produce them by accident
   * — the same reasoning as `vacantSlot`. They are exposed through this module
   * because it exists to be the ONE place a value the chain will accept is
   * computed, and a caller reaching for `pureCircuits` directly is how M-107
   * happened. **AN INTENT, NOT AN ACHIEVED EQUIVALENCE: FOUR callers reach past
   * it — `ledger.ts:1434`, `:1448`, `:1672`, `payout-tree.ts:162`. `T-291`.** */
  noVault(): Hex {
    return toHex(pureCircuits.noVault());
  },

  allVaults(): Hex {
    return toHex(pureCircuits.allVaults());
  },

  /**
   * WHAT THE SIGNERS APPROVE WHEN THEY APPROVE A PAYROLL RUN. V-41, V-67.
   *
   * The root fixes who is paid what, the count fixes the run's size, and the
   * window fixes WHEN — outside it no payment may happen and nothing else ends
   * the run.
   *
   * Here rather than at a call site for the reason this whole module exists:
   * the account recomputes this payload on every payment, and a second
   * derivation of it would produce a proposal id that no payment can ever
   * match — discovered after the approvals were collected and the fees paid.
   * `one-definition.test.ts` is what keeps that true.
   *
   * Times are seconds since the Unix epoch, matching the block-time predicates
   * the contract asserts with. Milliseconds here would build a run whose window
   * opens in the year 56000.
   */
  runPayload(root: Hex, payees: bigint, opensAt: bigint, closesAt: bigint): Hex {
    return toHex(pureCircuits.runPayload(fromHex(root), payees, opensAt, closesAt));
  },

  proposalId(payloadHash: Hex, salt: Hex, vault?: Hex): Hex {
    const v = vault === undefined ? pureCircuits.noVault() : fromHex(vault);
    return toHex(pureCircuits.proposalIdOf(fromHex(payloadHash), v, fromHex(salt)));
  },

  /** What the signers approved, and what is recorded as having happened. */
  changeCommitment(assetKey: Hex, amount: bigint, batchDigest: Hex, salt: Hex): Hex {
    return toHex(pureCircuits.changeCommitmentOf(
      fromHex(assetKey), checkAmount(amount, 'amount'), fromHex(batchDigest), fromHex(salt)));
  },

  /**
   * **WHAT IS BEING APPROVED IN A GOVERNANCE ROUND, WHICH IS THE CONTRACT'S OWN
   * CIRCUIT AND NOT A COPY OF IT.**
   *
   * Four lines, and each line is a call — the shape `runPayload` above already
   * had, and `signerPublicKey` before it. Until `S44` the client
   * NAMED these four with `sha256` over a colon-joined string
   * (`src/core/ledger.ts:739`, `:758`, `:771`, `:789`) and `AccountService`
   * imported them directly, so on the Midnight wiring the round was raised
   * under a payload the contract has never computed. `propose` asserts nothing
   * about the payload hash, so nothing refused until `amendSigner`,
   * `setThreshold` or `setVaultThreshold` recomputed it — after the approvals
   * were collected and the fees were spent.
   *
   * **THEY ARE ON `CommitmentScheme`**, and the rule that decides it is the one
   * quoted in the note above: a value stays off the shared interface only when
   * one side would have to INVENT an implementation to satisfy a type.
   * **THIS PARAGRAPH USED TO ADD *nothing simulated raises a payroll run, so
   * `runPayload` stays here*, AND `S47` MADE IT FALSE** — the simulated ledger
   * raises runs now, so `runPayload` went across by this same test. **Governance
   * was the first case of it** —
   * `SimulatedLedger` seats signers, removes them and moves both thresholds,
   * and already recomputes all four payloads to check a round — so both sides
   * genuinely produce these values and neither implementation is invented.
   * `src/core/ledger.ts`'s `CommitmentScheme` carries the long form.
   *
   * **THE NAMES: THREE OF THE FOUR DIFFER FROM THE CIRCUITS'.**
   * `signerRemovePayload` → `removeSignerPayload`, `signerThresholdPayload` →
   * `setThresholdPayload`, `vaultThresholdPayload` →
   * `setVaultThresholdPayload`; only `signerAddPayload` matches. A swap here is
   * silent — every one of them returns 32 bytes for the arguments it is given —
   * so `contracts/test/one-definition.test.ts` mirrors each of the four
   * against its circuit, which is what makes a swap fail rather than settle.
   *
   * **AND WHAT THIS MAKES LOAD-BEARING, SAID BEFORE SOMEBODY MEETS IT.** A
   * governance proposal's stored `digest` is now scheme-dependent, so a round
   * raised under one wiring cannot be executed under another: `approvedFor`
   * (`src/core/account.ts:2665`) recomputes the payload with the CURRENT
   * scheme and matches nothing, and the message a person sees is *"there is no
   * open proposal on this account for that change"* while the proposal is on
   * their screen. **No migration is owed today** — `src/wiring/selection.ts`
   * holds one wiring, `SIMULATED`, the simulated bodies are byte-for-byte the
   * ones that stood at module scope, and every stored digest keeps its meaning.
   * The day a `midnight` entry is added, open governance rounds must be
   * re-raised. That is strictly smaller than what `selection.ts:20-26` already
   * says a wiring switch costs, and it is written here so it is not
   * rediscovered as a defect.
   *
   * **`adoptVaultPayload` AND `retireVaultPayload` ARE DELIBERATELY ABSENT.**
   * They are `export circuit`s too, but the product raises no adopt or retire
   * round today — `grep` of `src/core/account.ts` returns nothing — and a
   * mirror for a caller that does not exist is a definition invented to fill a
   * table. **The day either round is built it needs exactly this treatment**,
   * and `one-definition.test.ts` still says so beside each of them.
   */
  signerAddPayload(leaf: Hex): Hex {
    return toHex(pureCircuits.signerAddPayload(fromHex(leaf)));
  },

  signerRemovePayload(removedLeaf: Hex): Hex {
    return toHex(pureCircuits.removeSignerPayload(fromHex(removedLeaf)));
  },

  /*
   * `BigInt` on the way in, and it is a CONVERSION rather than a second
   * derivation: `Uint<64>` is a bigint at the binding, and the generated check
   * refuses a JavaScript `number` by name — measured, *"type error:
   * setThresholdPayload argument 1 at ConfidentialAccount.compact line 964
   * char 1; expected value of type Uint<0..18446744073709551616> but received
   * 2"*.
   *
   * **WHAT REFUSES WHAT, MEASURED RATHER THAN ASSUMED, BECAUSE THE FIRST
   * VERSION OF THIS COMMENT CREDITED ONE GUARD FOR ALL OF IT AND THAT IS
   * `C286`'s SHAPE.** `S44`'s money-safety pass. Three different things
   * refuse three different arguments and none of them is this line:
   *   - **fractional or `NaN`** — `BigInt()` itself, before the binding is
   *     reached: *"The number 2.5 cannot be converted to a BigInt because it is
   *     not an integer"*, a `RangeError` from the runtime;
   *   - **negative, or `>= 2^64`** — the generated argument check above;
   *   - **zero** — NEITHER. `setThresholdPayload(0n)` is accepted here and
   *     returns a payload. What refuses a threshold of zero is
   *     `setThreshold`'s own `assert(newThreshold > 0)`
   *     (`ConfidentialAccount.compact:2022`), and on the product path
   *     `src/core/account.ts:1169` and `:1328` refuse it before this function
   *     is called at all.
   * Nothing is restated here on purpose; what is written down is which guard
   * actually holds each case, so a later round does not credit this one.
   */
  signerThresholdPayload(newThreshold: number): Hex {
    return toHex(pureCircuits.setThresholdPayload(BigInt(newThreshold)));
  },

  vaultThresholdPayload(vault: Hex, newThreshold: number): Hex {
    return toHex(
      pureCircuits.setVaultThresholdPayload(fromHex(vault), BigInt(newThreshold)));
  },

  /*
   * `entriesCommitmentOf` and `appendEntries` USED TO BE HERE, and M-128
   * deleted both. The entry log was a running digest that had to be proven
   * before it could be appended to, so two settlements conflicted even when
   * they moved different money. The chain holds an append-only set of movement
   * commitments now, and a set needs nothing carried between transactions.
   *
   * `stateCommitmentOf` USED TO BE HERE, and M-125 split it in two.
   *
   * It committed to a balance and an entry digest together, which was the right
   * shape while an account had exactly one balance. With a balance per asset,
   * one combined commitment would mean moving dollars rewrote the commitment
   * covering the euro balance too — so every asset's entry in the map would
   * change on every transaction, publishing that they belong to one account and
   * making a stale view of ANY asset block a spend of ANY other.
   *
   * `generationAfter` also used to be here, and M-106 deleted the rule it
   * mirrored. It was the single most expensive near-miss in this project: the
   * first version reused `appendEntries`, whose domain tag differs, and would
   * have locked every surviving signer out of an account with money in it
   *. The safest shared rule is the one that does not exist.
   */

  describe() {
    return 'Midnight commitments (persistentCommit, provable in circuit)';
  },
};
