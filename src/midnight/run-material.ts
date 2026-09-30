/**
 * WHAT A PAYROLL RUN IS RAISED AGAINST, BUILT FROM THE COMPANY'S OWN RECORDS.
 *
 * A run reaches the chain as six values — the root of a sum tree over blinded
 * payee leaves and their amounts, how many leaves there are, the two ends of the
 * window it may be paid in, the approvals its total needs, and the vault that
 * will pay it. Until this file the product held none of
 * them: the tree builder had no caller anywhere outside tests, so every propose
 * door refused, and it was right to.
 *
 * ── WHAT IS DERIVED AND WHAT IS SUPPLIED, WHICH IS THE WHOLE OF THIS FILE ──
 *
 * **THE ROOT AND THE LEAF COUNT ARE DERIVED AND MUST NEVER BE SUPPLIED.** There
 * is exactly one correct root for a payroll and it is a function of who is being
 * paid, in what, how much, and in what order. Any root somebody typed would be
 * wrong by construction and wrong SILENTLY: the run would be raised, approved
 * and paid for, and every merkle path a vault presented would be refused as
 * *"that payee is not in the approved run"*, on payday, after the money was
 * already committed. So they come out of one call to the tree builder and
 * nothing here can override them.
 *
 * **THE WINDOW AND THE VAULT ARE FACTS ABOUT THE WORLD AND ARE SUPPLIED.**
 * Neither is derivable from anything this product holds. When a run may be paid
 * is a decision somebody makes; which vault will pay it is a thing the company
 * knows and this software does not. They arrive the way a payee's address
 * arrives — from outside — and are refused rather than defaulted when absent.
 *
 * **AND THE VAULT IS NOT CHECKED BY ANYTHING, WHICH IS SAID HERE RATHER THAN
 * LEFT TO BE DISCOVERED.** No layer anywhere establishes that the thirty-two
 * bytes handed in name a vault that exists, that is deployed, or that answers to
 * this company. The account contract deliberately does not consult its own vault
 * registry when a payment is recorded, and the registry is not on the ledger
 * boundary at all, so there is nothing to compare against. A well-formed wrong
 * vault produces a run that is approved, paid for, and presentable by nobody —
 * the vault is folded into the proposal's identity, so a run raised for one
 * vault is not a rejected id at another, it is a different id entirely. What
 * bounds it today is that a person types it and a person reads it back.
 *
 * ── NOTHING RANDOM, AND THE EPOCH IS PART OF THE ANSWER ─────────────────────
 *
 * Every per-payee secret is derived from the account's payout seed, so a run
 * built here can be rebuilt on any signer's machine a month later. That only
 * holds while the rebuild uses the SAME GENERATION of the seed: a seed is
 * appended, never replaced, when a signer is removed, and deriving from a later
 * generation produces different leaves and a different root for the same
 * payroll. **So the generation is chosen once, here, and travels with the run.**
 * This file is the only place that asks which generation is current; everything
 * downstream is handed the number and looks it up by name.
 */
import {
  buildRun, buildRetryRun, rootOfPayments, paidMovementOfLeaf, payoutLeafOf,
  type PaymentFacts, type DetailsOfKind, type PayoutLeafInput,
} from './payout-tree.js';
import {
  currentPayoutSeed, type PayoutSeed, type RunIdentity, type PayRecord, type PayRecords,
} from './run-keys.js';
import { vaultDetailsOf } from './vault-details.js';
import type { RunProposal } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import type { AssetId } from '../core/assets.js';

declare const material: unique symbol;

/**
 * A RUN'S MATERIAL.
 *
 * **THE BRAND SAYS THIS WAS BUILT AND NOT TYPED OUT. IT DOES NOT SAY THE FIELDS
 * STILL AGREE, AND THE DIFFERENCE IS WORTH BEING EXACT ABOUT.** Hand-assembling
 * the shape is a compile error, because the brand cannot be written. **Spreading
 * one of these and replacing a field is not** — a spread carries the brand
 * across — so a caller can still produce a value whose root does not describe
 * its own leaves, and it would raise a run nothing refuses until a vault tried
 * to pay it.
 *
 * **SO THE AGREEMENT IS CARRIED AS A VALUE RATHER THAN CLAIMED BY THE TYPE.**
 * `rootOf` is the payout tree's own root function, and the propose door calls it
 * on the leaves it was actually handed and compares the answer to the root it
 * was actually handed. A spread that swaps either one is then refused before
 * anybody signs, because the check is over the values in front of it rather than
 * over their provenance. The layer that door lives in may not reach the runtime
 * that hashes a tree, which is why the function travels with the material — the
 * same rule the payment view follows for the contract's own derivations.
 */
export interface RunMaterial {
  readonly [material]: true;
  /** The five values the chain is asked to open a run with. */
  readonly run: RunProposal;
  /**
   * The run's payout leaves, in tree order.
   *
   * They are not on chain — the tree travels as a root — and they are not
   * secret to the company, but they are not public either: anyone holding them
   * can test the account's public payment set and read off which of these people
   * have been paid. They belong with the run, sealed.
   */
  readonly leaves: Hex[];
  /**
   * **WHO IS BEING PAID, WHAT IN, AND HOW MUCH — KEPT WITH THE LEAVES THEY
   * PRODUCED.**
   *
   * A leaf is not enough to pay somebody: the vault is handed the recipient, the
   * token and the amount, and re-derives the leaf from them. Those come off the
   * roster when the run is built and **must not be read off the roster again
   * when it is paid** — a roster is a live thing. Somebody is marked a leaver, a
   * salary is corrected, an address is re-registered, and the rebuild derives
   * different leaves for an approval that has already been given.
   */
  readonly facts: PaymentFacts[];
  /**
   * **WHAT EACH PAYMENT IS FOR** - the person, the month, the kind of pay and
   * the occurrence - in the same order as the facts. Each payee's nonce is
   * derived from it, and the account refuses a second payment carrying one it
   * has recorded. The door that raises the run does not take this list's word:
   * it derives each nonce from the run's own people, month and kind and checks
   * `payments` against it.
   */
  readonly records: PayRecord[];
  /**
   * **EACH LEAF'S TWO HALVES**: the payment's details and its nonce, in tree
   * order. Travelling with the material so the door that raises it can check
   * each nonce is the one its record derives and each leaf is made from it -
   * a record that SAYS one month over a leaf that pays another would otherwise
   * pass. Never written down: the nonce is a secret like the seeds.
   */
  readonly payments: PayoutLeafInput[];
  /** The contract's own `payoutLeaf`, travelling with the material for the reason `rootOf` does. */
  readonly leafOf: (payment: PayoutLeafInput) => Hex;
  /** Everything needed to derive these leaves again, on another machine. */
  readonly identity: RunIdentity;
  /**
   * The payout tree's own root function, travelling with the material so that a
   * layer which cannot import it can still check that these leaves are the ones
   * this root commits to. Never a second implementation of it. The payments'
   * facts give each leaf's amount, and the leg's asset is the one the root
   * commits to beside the tree.
   */
  readonly rootOf: (leaves: Hex[], facts: readonly PaymentFacts[], asset: AssetId) => Hex;
  /**
   * The contract's own `paidMovementOf`, travelling with the material for the
   * reason `rootOf` does: the layer that seals each payee's receipt may not
   * reach the runtime that computes it.
   */
  readonly movementOf: (leaf: Hex) => Hex;
}

/**
 * Builds one run's material.
 *
 * @param accountId  whose payroll this is
 * @param runId      what distinguishes this run from every other one on the
 *   account. **It must be unique per set of leaves, not per payroll**: two runs
 *   sharing an id derive the same per-payee secrets, so the payee at a position
 *   in one run would be handed the nonce and blinding of whoever sits at that
 *   position in the other. A payroll that settles in two currencies is two runs
 *   by this measure, because it is two approvals over two trees.
 * @param seeds      the account's payout seeds, every generation of them
 * @param facts      who is being paid, in what, how much — in the order the tree
 *   is to be built, which is part of the run
 * @param window     when the run may be paid, in SECONDS since the Unix epoch,
 *   because that is what block time is compared against
 * @param vault      the vault that will pay it
 * @param detailsOf  the vault's own pair of details circuits. Defaulted to the
 *   compiled vault this build was made against, and injectable so a test can
 *   drive a different one — never reimplemented.
 * @param pay        the account's pay-record key and what each payment is for,
 *   in the same order as the facts
 */
export const runMaterialFor = async (args: {
  accountId: string;
  runId: string;
  seeds: PayoutSeed[];
  facts: PaymentFacts[];
  pay: PayRecords;
  /** The leg's asset, which the run's root commits to and a spending policy is looked up by. */
  asset: AssetId;
  opensAt: bigint;
  closesAt: bigint;
  vault: Hex;
  detailsOf?: DetailsOfKind;
  /**
   * Which seed generation to build under, for a leg being raised again exactly
   * as it was raised before. Absent means the current one, which is every new
   * leg; see the note on the generation below.
   */
  epoch?: number;
}): Promise<RunMaterial> => {
  /*
   * Refused here as well as inside the tree builder. That one gives an attacker
   * nothing; this one is reached first and names the payroll rather than the
   * tree, which is what somebody looking at a screen can act on.
   */
  if (args.facts.length === 0) {
    throw new Error(
      'this payroll pays nobody, so there is no run to raise. A run is a merkle tree over '
      + 'one leaf per person, and a tree with no leaves has a root that commits to nothing.');
  }
  if (!args.runId.trim()) {
    throw new Error(
      'a run needs an identifier of its own before its material can be built: every payee\'s '
      + 'secrets are derived from it, and two runs sharing one derive the same secrets for '
      + 'different people.');
  }

  /*
   * **THE ONE PLACE THE GENERATION IS CHOSEN.** It is read back by name
   * everywhere else, and the number is stored with the run, so removing a signer
   * cannot change what an already-approved run derives.
   */
  const identity: RunIdentity = {
    accountId: args.accountId,
    runId: args.runId,
    epoch: args.epoch ?? currentPayoutSeed(args.seeds).epoch,
  };

  const built = buildRun(
    args.seeds, identity, args.facts, args.detailsOf ?? await vaultDetailsOf(), args.pay, args.asset);

  /*
   * **ALL THREE OFF THE SAME TREE, IN ONE EXPRESSION.** This is what the brand
   * on the return type is protecting; see its note above.
   */
  return {
    run: {
      root: built.tree.root,
      payees: built.tree.payees,
      opensAt: args.opensAt,
      closesAt: args.closesAt,
      vault: args.vault,
    },
    leaves: built.tree.leaves,
    facts: args.facts,
    records: built.records,
    payments: built.payments,
    leafOf: payoutLeafOf,
    identity,
    rootOf: (leaves: Hex[], facts: readonly PaymentFacts[], asset: AssetId) => rootOfPayments(leaves, facts, asset),
    movementOf: paidMovementOfLeaf,
  } as RunMaterial;
};

declare const retryMaterial: unique symbol;

/**
 * **ANOTHER ATTEMPT AT SOME OF A LEG'S PEOPLE, BUILT FROM WHAT THE LEG WAS
 * RAISED UNDER AND FROM NOTHING ELSE.**
 *
 * A different brand from `RunMaterial`, so a retry cannot be handed to the door
 * that raises a whole leg and a leg cannot be handed to the door that raises a
 * retry. The agreement between its root and its leaves travels as a value, for
 * the reason `RunMaterial` gives.
 */
export interface RetryMaterial {
  readonly [retryMaterial]: true;
  /**
   * What the chain is asked to open this attempt with: the leg's own root and
   * payee count, because an attempt is raised over the leg's own tree, and this
   * attempt's window.
   */
  readonly run: RunProposal;
  /** The leaves of the people this attempt pays, in the order they were named. Each is the leg's own leaf. */
  readonly leaves: Hex[];
  /** Which of the leg's people each position is, as positions in the leg's recorded leaves. */
  readonly originalIndices: number[];
  /**
   * The identity these leaves were derived under. Whatever the caller handed
   * in; the door that raises a retry refuses any but the leg's own.
   */
  readonly identity: RunIdentity;
  readonly rootOf: (leaves: Hex[], facts: readonly PaymentFacts[], asset: AssetId) => Hex;
  /** The contract's own `paidMovementOf`; `RunMaterial.movementOf` says why it is carried. */
  readonly movementOf: (leaf: Hex) => Hex;
}

/**
 * Builds a retry for some of one leg's people.
 *
 * **IT TAKES NO RUN IDENTIFIER OF ITS OWN.** Every per-payee secret comes out
 * of the identity and the seed generation handed in with the leg's record, and
 * the product's routes read that record rather than composing one. What refuses
 * an identity that is not the leg's is the door that raises the retry - because
 * a different one derives different nonces, different leaves, and payments the
 * account has never seen and would not refuse.
 *
 * **THE FACTS ARE THE RECORD'S AND NEVER THE ROSTER'S.** A salary corrected or a
 * person marked a leaver since the leg was approved would derive a different
 * leaf for that person, which is a different payment rather than the same one
 * made again.
 *
 * @param rebuild   what the leg was raised under: its identity, its payment
 *   facts, and every generation of the account's payout seed
 * @param indices   which of the leg's people this attempt pays, as positions in
 *   the leg's own recorded order
 * @param opensAt   when this attempt may be paid, in SECONDS since the Unix epoch
 * @param closesAt
 * @param vault     the vault that will pay this attempt
 */
export const retryMaterialFor = async (args: {
  rebuild: {
    identity: RunIdentity;
    facts: PaymentFacts[];
    seeds: PayoutSeed[];
    pay: PayRecords;
    /** The leg's asset, which its root commits to. */
    asset: AssetId;
  };
  indices: number[];
  opensAt: bigint;
  closesAt: bigint;
  vault: Hex;
  detailsOf?: DetailsOfKind;
}): Promise<RetryMaterial> => {
  const whole = buildRun(
    args.rebuild.seeds, args.rebuild.identity, args.rebuild.facts,
    args.detailsOf ?? await vaultDetailsOf(), args.rebuild.pay, args.rebuild.asset);
  const retry = buildRetryRun(whole, args.indices);
  return {
    run: {
      root: retry.tree.root,
      payees: retry.tree.payees,
      opensAt: args.opensAt,
      closesAt: args.closesAt,
      vault: args.vault,
    },
    leaves: retry.originalIndices.map((i) => retry.tree.leaves[i]!),
    originalIndices: retry.originalIndices,
    identity: retry.identity,
    rootOf: (leaves: Hex[], facts: readonly PaymentFacts[], asset: AssetId) => rootOfPayments(leaves, facts, asset),
    movementOf: paidMovementOfLeaf,
  } as RetryMaterial;
};
