import { nanoid } from 'nanoid';
import {
  newSigningKeypair, newWrappingKeypair, newSymmetricKey, newProposalSalt, newBlinding,
  seal, unseal, wrapKey, unwrapKey, verify, commit, canonical, parseCanonical,
  type Hex, type Sealed,
} from './crypto.js';
import type {
  Account, SealedAccount, PendingSigner, PendingSignerPayload,
  Signer, Policy, Proposal, SealedProposal, ProposalKind, Role,
  ShieldedState, StateBlinding, ShieldedEntry, Invite,
  ApprovalOutcome, ApprovalUnknown,
} from './types.js';
import type { AssetId } from './assets.js';
import { assets as defaultAssets, NO_ASSET, sumChangeAmount } from './assets.js';
import {
  sealRecord, openRecord, inboxPublicKey, sealToInbox, openFromInbox,
} from './sealed-records.js';
import type {
  Ledger, CommitmentScheme, StateView,
  StateChange, SignerRef, LedgerStatus, SealedStateAt, RunProposal,
} from './ledger.js';
import {
  /* the four governance payloads STOOD HERE. `C373`, `S44`: `CommitmentScheme` methods now. */
  thresholdFor,
} from './ledger.js';
import { storedSignerLeaf } from './signer-leaf.js';
import type { DataStore } from './store.js';
import { inviteKeyOf } from './store.js';

/**
 * The epoch a brand new account is sealed under. K-4.
 *
 * Named rather than written as `0` in two places, because the account record
 * and the state blob have to agree about it or the account is unreadable from
 * the moment it is created.
 */
export const GENESIS_KEY_EPOCH = 0;

export interface SignerSpec { name: string; role: Role; userId?: string | null; }

/** Returned once, at creation, and never persisted server side. */
export interface SignerSecrets {
  signerId: string;
  name: string;
  signingSecret: Hex;
  wrappingSecret: Hex;
  /**
   * Returned once, stored in the client's vault, never persisted server side.
   * Without it the signer cannot reproduce their leaf and cannot prove
   * membership on the contract, even holding a valid signing key.
   */
  blinding: Hex;
  /**
   * **THE LEAF'S THIRD ARGUMENT, TRAVELLING WITH THE MATERIAL THAT MADE IT.**
   *
   *
   * It went with the secrets and not onto the roster because that is where the
   * circuit reads it: `signerScope()` is a witness over the DEVICE's
   * `AccountPrivateState.scope`. Every seat is `allVaults()` today and no
   * circuit branches on it (`contracts/test/vault-scoping.test.ts` is what keeps
   * that true), so this value is the same for everybody — but it is written
   * down and carried rather than defaulted at each writer, because the first
   * seat made under a different one is a seat whose own device could not
   * reproduce its leaf, which is the lockout `C325`'s check exists to report.
   */
  scope: Hex;
}

export interface CreatedAccount {
  account: Account;
  viewingKey: Hex;
  secrets: SignerSecrets[];
}

/**
 * `threshold` here is OUR COPY of the number the account was opened with on the
 * ledger. It is rendered; it is not the bar.
 */
export const defaultPolicy = (threshold: number): Policy => ({
  threshold,
  limitsByRole: {},
});

/**
 * **TWO ANSWERS FROM TWO PLACES, AND THE TYPE KEEPS THEM APART.**
 *
 * `blocked` is OURS: this service declining to relay a proposal because the
 * company set a ceiling and asked us to apply it. Nobody's money moves and
 * nobody is misled, provided the product says whose rule it is.
 *
 * `approval` is THE CHAIN'S, passed in rather than computed. There is no
 * `satisfied: boolean` and no `requiredApprovals: number` on this type any
 * more, and their absence is the point of the round: a boolean is a place to
 * put an answer this process is not entitled to give, and `requiredApprovals`
 * was that answer's justification, taken from our own copy of the threshold.
 * The number of approvals required lives inside `approval` when the ledger told
 * us, and nowhere at all when it did not.
 */
export interface PolicyVerdict {
  blocked: boolean;
  reason?: string;
  approval: ApprovalOutcome;
}

/**
 * **THE LEDGER'S ANSWER ABOUT ONE ROUND, OR THE FACT THAT WE HAVE NONE.**
 *
 *
 * Deliberately a separate value from `LedgerStatus` itself, so that a caller
 * has to reduce a status to an answer ONCE and then pass that answer around.
 * `evaluatePolicy` cannot read the status a second time because it is never
 * given one — which is how the round's "capture the status once per decision"
 * is enforced by the types rather than by everyone remembering.
 */
export type ChainApprovals =
  | {
      state: 'read';
      approvals: number;
      threshold: number;
      /**
       * **THE VAULT THAT THRESHOLD IS THE THRESHOLD OF WAS CARRIED HERE, AND IT
       * IS GONE WITH THE CHECK IT EXISTED FOR.**
       *
       * It was here so `evaluatePolicy` could refuse a pair that did not agree.
       * **That comparison could never fail:** `approvalsOnChain` returned its
       * own `vault` argument verbatim, and the one call site that reaches the
       * `read` arm passed ONE expression to both functions, so the test was
       * `proposal.vault !== proposal.vault`.
       *
       * **AND IT COULD NOT BE MADE REAL AT THIS LAYER, WHICH IS WHY THE MEMBER
       * GOES RATHER THAN GETTING A SECOND SOURCE.** The other side would have
       * to come from `status`, and the chain does not publish a vault beside a
       * round: `openProposals` is id → change, and the vault is committed
       * INSIDE the id (`contracts/src/ConfidentialAccount.compact:2706-2708`).
       * A `vault` field on `LedgerStatus.openProposals` would be this layer
       * inventing a fact the chain does not have — which `approvalsOnChain`
       * below says in its own words, and which was true while this member sat
       * here contradicting it.
       *
       * **RULE 27 — WHAT ACTUALLY ENFORCES THE PAIRING, SINCE SOMETHING MUST.**
       * The door that writes the record, by construction: `chainId` and `vault`
       * are set from ONE argument in one statement each — `propose` at `:2273`
       * and `:2330`, the run door at `:2462` and `:2482`, and the four
       * governance doors hard-code `noVault()` on both. The invariant is stated
       * where it is created, `chainId == proposalId(digest, salt, vault)`, and
       * the run door post-checks it against the id the ledger returned. **A
       * check at the reading end could not have been better than the record it
       * was reading, and pretending otherwise is what rule 14 is for.**
       */
    }
  | { state: 'unknown'; why: ApprovalUnknown };

/**
 * Reduces ONE captured `LedgerStatus` to what it says about ONE proposal.
 *
 * Takes the status as a value rather than the ledger, so it cannot fetch and
 * therefore cannot race. **`null` is not "no approvals".** An account the
 * ledger has never heard of and an account with an empty round are different
 * facts, and the first is our ignorance.
 */
export function approvalsOnChain(
  status: LedgerStatus | null, chainId: Hex, vault: Hex,
): ChainApprovals {
  if (!status) return { state: 'unknown', why: 'no-status' };
  const open = status.openProposals.find(o => o.id === chainId);
  if (!open) return { state: 'unknown', why: 'not-open' };
  /*
   * BOTH NUMBERS COME OFF THE SAME OBJECT, and that is the whole change.
   * `open.approvals` is the chain's count of burnt nullifiers and
   * `status.threshold` is the bar the contract will actually apply when the
   * proposal is spent.
   * Neither is read from `account.policy`. Today `status` comes from
   * `SimulatedLedger`, so this is a read of the simulator — but the SOURCE has
   * moved, and when the real ledger lands this call site does not change.
   */
  /*
   * **THE BAR IS THIS PROPOSAL'S VAULT'S, NOT THE ACCOUNT'S.**
   * `thresholdFor` is one definition, in `core/ledger.ts`, mirroring the
   * circuit at `contracts/src/ConfidentialAccount.compact:1358` — the vault's
   * own number if the chain holds one for it, the account's otherwise.
   *
   * **THE VAULT COMES FROM THE CALLER AND CANNOT COME FROM `status`.** The
   * chain's `openProposals` is id → change and holds no vault beside a round:
   * the vault is committed INSIDE the id, and `recordPayment` is handed one and
   * recomputes the id to prove it (`:2706-2708`). A `vault` field on
   * `LedgerStatus.openProposals` would be this layer inventing a fact the chain
   * does not publish. The caller has it because the caller is the party that
   * computed the id from it.
   *
   * **BOTH NUMBERS STILL COME OFF THE SAME OBJECT**, which is `R4`'s rule
   * unchanged: `open.approvals` and the map `thresholdFor` reads are one
   * captured status, so the count and the bar cannot be arithmetic about two
   * different chain states.
   */
  return {
    state: 'read',
    approvals: open.approvals,
    threshold: thresholdFor(status, vault),
  };
}

/**
 * **WHY WE HAVE NO USABLE ACCOUNT RULE FROM THE LEDGER.**
 *
 * Three reasons and not one, because a guard that refuses has to say which
 * silence it hit — they are three different things to go and look at. An
 * account the boundary has never heard of, a boundary that threw, and a
 * boundary that answered without the numbers in it.
 */
export type SeatingUnknown = 'no-status' | 'unreadable' | 'incomplete';

/**
 * **THE RULE THE CONTRACT ACTUALLY APPLIES TO THIS ACCOUNT, OR THE FACT THAT WE
 * DO NOT HAVE IT.** Deliberately the same shape as
 * `ChainApprovals` above, for the same reason: a caller has to reduce a status
 * to an answer ONCE and then pass that answer around.
 *
 * `threshold` is the bar the contract holds and `signerCount` is how many seats
 * it holds. Both are public on chain by design (decision 0003), so carrying
 * them here is not a leak. Neither is ever `account.policy.threshold` or a
 * count of our own roster: those are COPIES, and a copy that has drifted BELOW
 * the contract's value turns a guard whose whole job is to be conservative into
 * permission to strand the account.
 */
export type ChainSeating =
  | { state: 'read'; threshold: number; signerCount: number }
  | { state: 'unknown'; why: SeatingUnknown };

/**
 * Reduces ONE captured `LedgerStatus` to the account's rule, or to our
 * ignorance of it.
 *
 * Takes the status as a VALUE rather than the ledger, so it cannot fetch and
 * therefore cannot race. That is `approvalsOnChain`'s argument unchanged, and
 * it matters more here: the three guards below each take one decision, and a
 * bar read at one moment against a seat count read at another is arithmetic
 * over two different chain states.
 *
 * **THE `incomplete` ARM IS NOT DEFENSIVE PROGRAMMING.** `LedgerStatus.threshold`
 * is typed `number`, so inside this repository it cannot be missing. This
 * boundary is about to be implemented against a real indexer
 * (`src/midnight/ledger.ts`), where both fields are built out of a decoded
 * chain response and CAN arrive `undefined`. `undefined` in the comparisons
 * below is not an error — it is `false`, which is the PERMISSIVE answer at
 * every one of the three sites. A number a guard cannot use has to become a
 * refusal here, once, rather than a silent pass three times.
 */
export function seatingOnChain(status: LedgerStatus | null): ChainSeating {
  if (!status) return { state: 'unknown', why: 'no-status' };
  const counted = (n: number) => Number.isInteger(n) && n >= 0;
  if (!counted(status.threshold) || status.threshold < 1 || !counted(status.signerCount)) {
    return { state: 'unknown', why: 'incomplete' };
  }
  return { state: 'read', threshold: status.threshold, signerCount: status.signerCount };
}

/**
 * **WHAT OUR STORED COPY SAYS, WHERE IT DISAGREES WITH THE CHAIN.**
 *
 * The guards below no longer read our copy, so drift can no longer change one
 * of their outcomes. It is still worth saying out loud when one of them
 * refuses: a refusal naming only the contract's number invites the reader to
 * check it against a screen rendering ours, find they differ, and conclude the
 * guard is wrong. The clause says which number was used and which is stale.
 *
 * Returns a clause for a message, or the empty string when the two agree.
 *
 * **IT DOES NOT THROW AND IT DOES NOT REPAIR.** Not throwing, because
 * `Policy.threshold` already documents which side wins — the chain is right and
 * ours is stale — so refusing an operation the contract would accept would be
 * inventing a rule out of our own staleness. Not repairing, because writing the
 * chain's value into the sealed policy from inside a guard is exactly the shape
 * `CLAUDE.md` says to be suspicious of: a method that writes `policy.threshold`
 * with no round behind it. Healing the copy is a round of its own.
 */
export function seatingDrift(account: Account, seating: ChainSeating): string {
  if (seating.state !== 'read') return '';
  const ourBar = account.policy.threshold;
  const ourSeats = account.signers.filter(s => s.status === 'active').length;
  const parts: string[] = [];
  if (ourBar !== seating.threshold) parts.push(`our stored copy of the threshold says ${ourBar}`);
  if (ourSeats !== seating.signerCount) {
    parts.push(`our roster holds ${ourSeats} active signer${ourSeats === 1 ? '' : 's'}`);
  }
  return parts.length
    ? ` (${parts.join(', and ')} — stale: the ledger's numbers decided this and ours did not)`
    : '';
}

/**
 * **IN A GUARD, NOT KNOWING MEANS REFUSING. THAT IS THE OPPOSITE DIRECTION FROM
 * `R4` AND IT IS NOT A CONTRADICTION.**
 *
 * `R4` established that a status we cannot read is a distinct outcome from a
 * threshold that is not met, and on the approval path not knowing means not
 * proceeding — the round stays open and somebody looks again. **Here the
 * conservative direction is the other one.** These guards stand in front of an
 * operation that REMOVES the account's ability to approve; permitting one
 * because the chain could not be reached is failing in exactly the direction
 * that strands the account, and it fails SILENTLY — nothing goes wrong when the
 * signer is removed, it goes wrong the next time anybody tries to approve
 * anything, possibly a month later, when the removal looks like history rather
 * than cause.
 *
 * The message is deliberately not phrased like the threshold refusal it sits
 * beside. One says the account WOULD be stranded; this one says we could not
 * find out. They are told apart by the reader and by a test.
 */
export function requireSeating(
  seating: ChainSeating,
  refusing: string,
): { threshold: number; signerCount: number } {
  if (seating.state === 'read') return seating;
  throw new Error(
    `refusing to ${refusing}: this service cannot read the account's threshold and seat ` +
      `count from the ledger (${seating.why}), and this guard exists to stop the account ` +
      'being left below a threshold it could never approve its way back above. Proceeding ' +
      'on a number we could not check is the one direction that strands an account for ' +
      'good, so nothing has been changed. Try again when the ledger answers.',
  );
}

/**
 * **HOW MANY SIGNERS COULD STILL APPROVE AFTERWARDS, TAKING THE SMALLER OF THE
 * TWO ACCOUNTS OF IT.**
 *
 * The BAR is the chain's and is never ours. The survivor COUNT is a different
 * question and it is not one the chain can answer alone: who is leaving is a
 * row in our roster, and the contract cannot be asked about a removal that has
 * not happened yet. So both are computed and the SMALLER is used — if our
 * roster claims more active signers than the ledger holds seats for, the extra
 * ones cannot approve anything and must not be counted as if they could.
 *
 * `seatsDropped` is how many seats the operation removes ON CHAIN, which is not
 * how many rows it drops from our roster. A removal drops one leaf. **A
 * rotation drops none** — it changes the locks and leaves the signer tree
 * exactly as it was, because there is no revocation circuit (see `rotate`), so
 * a rotation excluding two people still leaves both of them able to act. Their
 * seats therefore cannot be counted as freed, and cannot rescue a roster that
 * has fallen below the bar.
 */
export function survivorsAfter(
  seating: { threshold: number; signerCount: number },
  ourSurvivors: number,
  seatsDropped: number,
): number {
  return Math.min(ourSurvivors, Math.max(0, seating.signerCount - seatsDropped));
}

/**
 * **WHAT THIS SERVICE MAY STILL DECIDE, WHICH IS ONE THING.** `R4`, `C121`,
 *
 *
 * It decides whether to RELAY a proposal, against ceilings the company set and
 * asked us to apply. It no longer decides whether a round is approved: that
 * answer arrives in `chain`, having been read off `LedgerStatus`, and this
 * function's only job with it is to compare two of the ledger's own numbers to
 * each other and label the result.
 *
 * **The threshold is not read from `account.policy` anywhere below.** If you
 * are adding a rule here, that is the line to keep: this process may render the
 * number and may not produce it.
 *
 * It is still written as a general evaluator rather than a signature counter
 * because agents-as-principals and delegated authority are the same mechanism
 * with different inputs, and retrofitting that later is expensive.
 *
 * `asset` is not optional and there is no default.
 *
 * A ceiling is a number in one currency and nothing else. Evaluating a payment
 * against a limit set for a different asset is not a slightly wrong answer, it
 * is an answer about a different question — a 5,000 GBP ceiling applied to an
 * ETH amount blocks 0.000000000000005001 ether and waves through anything
 * smaller than five picoether, which is every real payment. So every rule below
 * is looked up per asset, and an asset nobody set a rule for has no rule.
 */
export function evaluatePolicy(
  account: Account,
  asset: AssetId,
  amount: bigint,
  proposerRole: Role,
  chain: ChainApprovals,
): PolicyVerdict {
  const p = account.policy;
  const limit = p.limitsByRole[proposerRole]?.[asset];

  /*
   * **A PAIRING GUARD STOOD HERE AND IT COULD NOT FIRE.** `C286`, `T-216`,
   * It threw when `chain.vault !== vault`, and both sides were the same
   * expression — `approvalsOnChain` echoed its own argument back, and the one
   * call site that reaches the `read` arm passed `proposal.vault` to both. The
   * paragraph that stood with it claimed *"a reduction taken against a
   * different one is refused below rather than quietly deciding the round …
   * That refusal is worth having because the failure it catches is invisible
   * without it"*, and nothing was behind it.
   *
   * **GUARD AND CLAIM REMOVED TOGETHER, WHICH IS `T-216`'s OWN *done when*.**
   * Where the pairing is actually enforced is written on `ChainApprovals`
   * above: at the door that writes the record, not at the end that reads it.
   * **The interaction matters and is why this is not merely tidying:** had the
   * guard ever been made real it would have thrown at this line — AFTER
   * `ledger.approve` has landed — and produced `C377` every time it fired.
   */

  if (limit?.perTransaction != null && amount > limit.perTransaction) {
    return {
      blocked: true,
      /*
       * IT SAYS WHOSE RULE IT IS.
       *
       * The contract has no ceiling and never sees this number. A refusal
       * phrased as though the chain had refused is a promise this product is
       * not keeping — the company can ask us to stop relaying and cannot make
       * that stick against anybody else.
       */
      reason:
        `this company's own policy, applied by this service and not by the chain: ` +
        `${amount} exceeds the per-transaction ${asset} limit for role "${proposerRole}" ` +
        `(${limit.perTransaction}). The proposal was not relayed to the ledger.`,
      /*
       * A blocked proposal is never submitted, so there is no round on chain to
       * ask about. That is not "nobody has approved it": it does not exist.
       */
      approval: { state: 'unknown', why: 'not-yet-proposed' },
    };
  }

  /*
   * **THE ESCALATION FIGURE IS GONE FROM THE TYPE AS WELL AS FROM HERE.** `R5`,
   * `R4` deleted the evaluation and kept the field; this round
   * deleted the field, and the argument is in `Policy`'s own comment in
   * `core/types.ts` and at length in `docs/build-log.md`.
   *
   * The short of it: the one meaning on offer was *"above this amount use the
   * account's threshold rather than the vault's lower one"*, and NOTHING ON
   * CHAIN WOULD ENFORCE IT. `thresholdFor` is amount-blind. Applying it here
   * would make this service tell a company that a large payment needs more
   * approvals than the contract will actually require — `M-102`'s defect, and
   * the direction this repository calls the dangerous one, because it claims
   * safety that does not exist rather than merely failing to add any.
   */

  /*
   * **THE DISCRIMINANT IS A STRING AND NOT A BOOLEAN, AND THAT IS NOT A STYLE
   * CHOICE.**
   *
   * It was `known: true | false` and `tsconfig.json` narrowed it correctly.
   * `tsconfig.scripts.json` compiles with `strict: false`, which turns off
   * `strictNullChecks`, and WITHOUT `strictNullChecks` TypeScript does not
   * narrow a discriminated union on a boolean literal — so `chain.why` was an
   * error in one tree and fine in the other. This file is reached by both
   * configs, through `src/midnight/*`. A string discriminant narrows under
   * either.
   */
  if (chain.state === 'unknown') return { blocked: false, approval: { state: 'unknown', why: chain.why } };

  return {
    blocked: false,
    approval: {
      state: chain.approvals >= chain.threshold ? 'satisfied' : 'short',
      approvals: chain.approvals,
      threshold: chain.threshold,
    },
  };
}

/* ---------------- sealing the account ---------------- */

/** What the roster envelope holds. There is no other copy of any of it. */
interface RosterSecrets { name: string; signers: Signer[]; }
/** What the policy envelope holds. */
interface PolicySecrets { policy: Policy; recovery: Account['recovery']; }

/**
 * Turns an account into what the database is allowed to hold.
 *
 * Exported, and used by the BROWSER as well as the server, because the server
 * can no longer open one of these. `openAccount` is the other half and they are
 * a pair: everything readable on the stored record is derived here, in one
 * place, from the one copy inside the envelope. `threshold` and `signerCount`
 * are written from the roster and policy rather than passed in, so there is no
 * second copy for them to disagree with.
 *
 * Pending signers arrive as their own argument and are passed through
 * untouched. They are not in the roster and must not be: the only two things
 * that write them are `acceptSignerInvite`, which appends without a key, and
 * `grantAccess`, which folds one into the sealed roster and drops it here.
 */
export function sealAccount(
  account: Account,
  viewingKey: Hex,
  pendingSigners: PendingSigner[],
  keyEpoch = 0,
): SealedAccount {
  // `openAccount` composes pending signers into `signers` so callers see one
  // list. Filtering them back out is what makes the round trip lossless.
  const roster = account.signers.filter(s => s.status !== 'pending');
  return {
    id: account.id,
    createdAt: account.createdAt,
    keyEpoch,
    threshold: account.policy.threshold,
    signerCount: roster.length,
    memberUserIds: roster.filter(s => s.userId).map(s => s.userId!),
    pendingSigners,
    wrappedKeys: account.wrappedKeys,
    inboxPublicKey: inboxPublicKey(viewingKey, account.id),
    sealedRoster: sealRecord<RosterSecrets>(
      'roster', account.id, { name: account.name, signers: roster }, viewingKey),
    sealedPolicy: sealRecord<PolicySecrets>(
      'policy', account.id, { policy: account.policy, recovery: account.recovery }, viewingKey),
    /*
     * **CARRIED, NOT RECOMPUTED, AND CARRIED HERE BECAUSE THIS IS WHERE IT
     * WOULD BE LOST.**
     *
     * `save()` rebuilds the stored record from an opened `Account` on every
     * write, so a readable field this function does not copy is written once at
     * creation and gone by the next roster edit. The key that opens this
     * company's keyring is derived from this string: dropping it is dropping
     * the data, not a column. `openAccount` is the other half of the round
     * trip and `wallet-unlock.test.ts` watches it survive one.
     */
    contractAddress: account.contractAddress ?? null,
    /*
     * **AND SO DOES ITS PROVENANCE, FOR THE IDENTICAL REASON.** `PI2b`,
     * A source dropped on write-back reads as *we do not know*, which
     * fails closed — and a company that silently stops being unlockable is the
     * same lost afternoon as one that never was.
     */
    addressSource: account.addressSource ?? null,
  };
}

/**
 * Opens a stored account. Needs the viewing key, and nothing about the account
 * beyond its id and ciphertext.
 *
 * Pending signers are opened from the account inbox and appear in `signers` with
 * `status: 'pending'`, which is where they were before M-96. Callers that only
 * wanted to know who is on an account cannot tell the difference; the difference
 * is that we can no longer read any of it.
 */
export function openAccount(rec: SealedAccount, viewingKey: Hex): Account {
  const { name, signers } = openRecord<RosterSecrets>('roster', rec.id, rec.sealedRoster, viewingKey);
  const { policy: stored, recovery } = openRecord<PolicySecrets>('policy', rec.id, rec.sealedPolicy, viewingKey);
  /*
   * **THE POLICY IS REBUILT FIELD BY FIELD, NOT PASSED THROUGH.**
   *
   * `openRecord` is a cast over decrypted JSON: it validates nothing, so a
   * record sealed before this round still carries the deleted auto-approve
   * figure inside the envelope at runtime, invisible to the type. `sealAccount`
   * seals `account.policy` wholesale, so a pass-through would re-seal that key
   * on every write and a field this project deleted for being dangerous would
   * live in customer envelopes for ever, unread by anything and unreachable by
   * grep. Naming the three surviving fields drops it on the first write-back.
   *
   * **THE COST, SAID OUT LOUD: a field ADDED to `Policy` and not added here is
   * silently dropped by the next `save()`** — the same shape as the
   * `contractAddress` loss `PI2a` was written for. That is the trade, and it is
   * taken because a stale field that grants authority is worse than a new field
   * that goes missing loudly the first time anybody sets one.
   *
   * The alternative was to discard the stored data outright, which standing
   * permission allows and which nobody has to do now that this is here.
   */
  /*
   * **A FIELD IS DROPPED ON READ RATHER THAN MIGRATED.** `R5`, `C178`, and the
   * same handling `R4` gave its neighbour.
   *
   * An envelope sealed before today may still carry the deleted escalation
   * figure. It is not read here, so it is not in the object, so the next
   * write-back does not contain it — the value disappears the first time
   * anything saves the account, with no migration step and nothing to run. A
   * company that had set one gets no behaviour from it, which is exactly what
   * they were already getting.
   */
  const policy: Policy = {
    threshold: stored.threshold,
    limitsByRole: stored.limitsByRole ?? {},
  };
  const pending: Signer[] = rec.pendingSigners.map(p => {
    const q = openFromInbox<PendingSignerPayload>(p.sealed, rec.id, viewingKey);
    return {
      id: p.id, userId: p.userId, name: q.name, role: q.role, status: 'pending',
      signingPublicKey: q.signingPublicKey, wrappingPublicKey: q.wrappingPublicKey,
      leafCommitment: q.leafCommitment,
    };
  });
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    name,
    signers: [...signers, ...pending],
    policy,
    recovery,
    wrappedKeys: rec.wrappedKeys,
    /* Public, never sealed, and carried so `sealAccount` can write it back. */
    contractAddress: rec.contractAddress ?? null,
    addressSource: rec.addressSource ?? null,
  };
}

/**
 * **MOVES A DROP BOX TO A NEW INBOX KEY, BOTH ENVELOPES.**
 *
 * Written as its own function rather than inline because it is two nested
 * `openFromInbox` calls and one nested `sealToInbox`, and the shape of that
 * nesting is the thing a future reader has to get right.
 */
function resealDropBox(
  sealed: { ephemeral: Hex } & Sealed,
  accountId: string,
  viewingKey: Hex,
  nextInbox: Hex,
): { ephemeral: Hex } & Sealed {
  const box = openFromInbox<{
    byUserId?: string | null; handover?: ({ ephemeral: Hex } & Sealed);
  }>(sealed, accountId, viewingKey);
  /* A box written before `X11` has no inner envelope. It moves as it is, so a
   * handover made under the old shape is not stranded by an upgrade. */
  if (!box.handover) return sealToInbox(box, nextInbox);
  const inner = openFromInbox<unknown>(box.handover, accountId, viewingKey);
  return sealToInbox(
    { byUserId: box.byUserId ?? null, handover: sealToInbox(inner, nextInbox) },
    nextInbox);
}

export class AccountService {
  constructor(
    private store: DataStore,
    private ledger: Ledger,
    /**
     * Must match the ledger. A leaf computed under the simulated scheme is
     * meaningless to the Compact contract and vice versa.
     *
     * REQUIRED, WITH NO DEFAULT — R3. It defaulted to `SimulatedCommitments`
     * until then, which meant a caller that constructed a real ledger and said
     * nothing about the scheme got the simulated one, and nothing anywhere said
     * so until a proof was attempted on chain. A required argument makes that
     * pair a compile error instead. The scheme now comes from the same
     * `wiring()` call as the ledger, and from nowhere else.
     */
    private commitments: CommitmentScheme,
    /**
     * Injected rather than imported, for the reason the commitment scheme is:
     * the registry becomes a Postgres table, and a service that reaches
     * for a module-level singleton cannot be handed the real one.
     */
    private assets = defaultAssets,
  ) {}

  /* ---------------- creation ---------------- */

  async create(
    name: string,
    signerSpecs: SignerSpec[],
    threshold: number,
    recoveryThreshold?: number,
  ): Promise<CreatedAccount> {
    if (threshold < 1 || threshold > signerSpecs.length) {
      throw new Error(`threshold ${threshold} is not valid for ${signerSpecs.length} signers`);
    }

    const viewingKey = newSymmetricKey();
    const signers: Signer[] = [];
    const secrets: SignerSecrets[] = [];
    /* Kept separately because `Signer.leafCommitment` is nullable for signers
     * created before M-13, and the ledger cannot accept a null: a signer with no
     * leaf has no place in the tree and cannot act. These are all fresh. */
    const leaves: Hex[] = [];

    /*
     * Read once, from the scheme, and carried to every seat made below and into
     * every secrets record that leaves here. Reading it per signer
     * would be the same value from the same place N times; reading it from
     * anywhere but the scheme would be a second spelling of a sentinel the
     * chain compares against, which is decision 0004's whole subject.
     */
    const scope = this.commitments.allVaults();

    for (const spec of signerSpecs) {
      const sk = newSigningKeypair();
      const wk = newWrappingKeypair();
      const blinding = newBlinding();
      const id = 'sgn_' + nanoid(10);
      /*
       * **THE PUBLIC HALF IS THE SCHEME'S, NOT THE CURVE'S.**
       *
       * This line passed `sk.publicKey` — the raw ed25519 key — while the
       * contract's `requireSigner()` looks in the tree for a leaf built over
       * `signerPublicKey(sk)`, a domain-separated hash of the SECRET. Different,
       * uncorrelated 32 bytes, so every seat this product had written was one
       * its own device could never prove. It never bit because only the
       * simulated scheme is wired and it agreed with itself.
       *
       * `sk.publicKey` is still the signer's ed25519 identity and is still on
       * the roster: it is what an approval SIGNATURE is checked against
       * (`signApproval`). It is simply not what the tree holds. Two public
       * halves, two jobs, and this is the one the chain reads.
       */
      const leaf = storedSignerLeaf(
        { signingSecret: sk.secret, blinding, scope }, this.commitments);
      leaves.push(leaf);
      signers.push({
        id, name: spec.name, role: spec.role, status: 'active', userId: spec.userId ?? null,
        signingPublicKey: sk.publicKey, wrappingPublicKey: wk.publicKey,
        // Only the leaf is kept. The blinding factor leaves in `secrets`, goes
        // to that signer's device, and is never written down here. M-106 put
        // this back the way decision 0003 wants it.
        leafCommitment: leaf,
      });
      secrets.push({
        signerId: id, name: spec.name,
        signingSecret: sk.secret, wrappingSecret: wk.secret, blinding, scope,
      });
    }

    const wrappedKeys = signers.map(s => ({
      signerId: s.id, ...wrapKey(viewingKey, s.wrappingPublicKey),
    }));

    const account: Account = {
      id: 'acc_' + nanoid(12),
      name,
      signers,
      policy: defaultPolicy(threshold),
      wrappedKeys,
      recovery: {
        signerIds: signers.map(s => s.id),
        threshold: recoveryThreshold ?? Math.min(threshold, signers.length),
      },
      createdAt: new Date().toISOString(),
    };

    /*
     * Opening the account, not publishing a state. On Midnight this is the
     * deploy: the constructor computes the first commitment from the same
     * witnesses every later call uses, which is why the opening goes across the
     * boundary and the commitment does not.
     *
     * AN ACCOUNT HOLDS NOTHING, EVER — `C292`. There is no balance to commit
     * to and no map to open an entry in. Only the entry log is committed here.
     */
    const initialState: ShieldedState = { entries: [] };
    const blinding: StateBlinding = {
      // Generated once, here, and never regenerated — not even by a rotation.
      // See `StateBlinding.assetBlinding`: every change commitment already
      // approved names an asset through it, so changing it would make an
      // approval in flight unspendable.
      assetBlinding: newBlinding(),
      /*
       * The account's first payout seed. V-63.
       *
       * Generated here so that a run raised on the very first day is already
       * rebuildable by every signer rather than by whoever happened to raise
       * it. `rotate` appends later generations; nothing ever removes one, so an
       * approved run stays payable across a signer leaving.
       */
      payoutSeeds: [{ epoch: GENESIS_KEY_EPOCH, seed: newBlinding() }],
    };
    await this.ledger.open(account.id, {
      signerLeaves: leaves,
      threshold,
      assetBlinding: blinding.assetBlinding,
      sealedState: this.sealState(initialState, blinding, viewingKey, GENESIS_KEY_EPOCH),
    });

    /*
     * THE ADDRESS IS ASKED FOR ONCE, HERE, AND WRITTEN DOWN.
     *
     * It is the company's identity to a wallet: the key that opens this
     * company's records is derived from it, on any client, for as long as the
     * company exists. So it is read from the ledger that assigned it — never
     * minted on this side — and copied onto the durable record immediately,
     * because the simulated ledger holds its whole world in memory and would
     * answer differently after a restart.
     *
     * Null is a real answer. A ledger with no contract for this account has no
     * address, and `companyForSession` refuses by name rather than substituting
     * something.
     */
    const assigned = await this.ledger.address(account.id);
    /*
     * **WRITTEN IN THE SAME BREATH AS THE ADDRESS, BECAUSE IT ARRIVES IN THE
     * SAME VALUE.**
     *
     * `Ledger.address` answers with the address AND where it came from, so
     * there is no version of this line that records one and not the other.
     * `PI2a` wrote the address alone and the guard downstream could not tell a
     * chain's address from thirty-two bytes this process invented.
     */
    const onChain = {
      ...account,
      contractAddress: assigned?.value ?? null,
      addressSource: assigned?.source ?? null,
    };

    this.store.putAccount(sealAccount(onChain, viewingKey, []));
    return { account: onChain, viewingKey, secrets };
  }

  /**
   * Is this user allowed to act on this account at all? Multi-tenancy hinges on it.
   *
   * **This has to answer with no viewing key**, and that is what forced the shape
   * of `SealedAccount`. The server decides whether a session may touch an account
   * before any key is supplied — the key arrives in the body of the request this
   * gate is protecting. Sealing `signers[]` removed the only thing it used to
   * read, which is exactly why M-96 was reverted the first time.
   *
   * It answers from `memberUserIds`: opaque ids, no names, no roles, no
   * `leafCommitment`. It returns a boolean rather than the `Signer` it used to,
   * because a `Signer` carries a name and a role and neither is ours to hand out
   * any more. Callers that want the role open the account with the key.
   */
  membership(accountId: string, userId: string): boolean {
    const rec = this.store.getAccount(accountId);
    return !!rec && rec.memberUserIds.includes(userId);
  }

  requireMember(accountId: string, userId: string): void {
    // Same error whether the account does not exist or the user is not on it.
    // Otherwise this endpoint enumerates account ids.
    if (!this.membership(accountId, userId)) throw new Error('account not found');
  }

  /* ---------------- onboarding ---------------- */

  /**
   * Creates an invite. Deliberately carries no secret and grants nothing. The
   * invitee generates their own keys and returns only public halves, and even
   * then they see nothing until an existing signer grants access.
   */
  /**
   * Returns the invite with its RAW token, which the caller must send and must
   * not store — what is written to the database is the hash. A-7.
   *
   * A signer's token is allowed to come back to whoever raised it, unlike an
   * employee's, because `grantAccess` is its second gate: accepting makes you a
   * pending signer who can read nothing until an approved proposal admits you.
   */
  inviteSigner(accountId: string, name: string, email: string, role: Role): Invite {
    this.require(accountId);
    const raw = 'inv_' + nanoid(18);
    const invite: Invite = {
      token: inviteKeyOf(raw),
      accountId, kind: 'signer', name, email, role,
      createdAt: new Date().toISOString(),
    };
    this.store.putInvite(invite);
    /* The raw token goes back to the caller; the hash is what was stored. */
    return { ...invite, token: raw };
  }

  /**
   * The invitee's device has generated a keypair and sends the public halves.
   * They join as a pending signer: on the account, visible to others, able to
   * read nothing.
   */
  acceptSignerInvite(
    token: string,
    /** The signed in user claiming the invite. This is what binds the seat to a tenant. */
    userId: string | null,
    signingPublicKey: Hex,
    wrappingPublicKey: Hex,
    /**
     * Computed on the invitee's device. We receive the commitment, never the
     * blinding factor that made it.
     *
     * There is deliberately no `blinding` parameter beside it, and there must
     * not be one. M-99's removal design re-seated every surviving signer, and a
     * survivor's new leaf cannot be computed without their blinding, so the
     * invitee briefly had to hand theirs over. M-106 re-seats nobody. Decision
     * 0003 says a blinding lives on one device and nowhere else, and this
     * signature is the boundary where that is either true or it is not.
     */
    leafCommitment: Hex,
  ): Signer {
    const invite = this.store.getInvite(token);
    if (!invite) throw new Error('invite not found');
    if (invite.kind !== 'signer') throw new Error('that is not a signer invite');
    if (invite.acceptedAt) throw new Error('invite already used');

    const rec = this.require(invite.accountId);
    // One seat per user. Two seats would mean two votes towards the threshold
    // from one person, which quietly defeats M of N. Pending seats count: the
    // check has to cover somebody who has accepted but not yet been granted.
    if (userId && (rec.memberUserIds.includes(userId)
      || rec.pendingSigners.some(p => p.userId === userId))) {
      throw new Error('you are already on this account');
    }

    /*
     * **NOTHING IS REFUSED HERE FOR A REUSED SUBWALLET.**
     *
     * This read `if (userId) refuseReusedSubwallet(this.store, userId,
     * invite.accountId)`. The rule it enforced — one subwallet, one employer —
     * was decided against on 22 Aug: reuse is a person's choice, it could only
     * ever be seen for people holding a SEAT and never for an employee, and an
     * inconsistent warning teaches everybody that silence means it is fine.
     * The wallet is where it lives now, because the wallet knows which of its
     * own slots it has used and with which sites.
     *
     * The seat check above is untouched and is a different rule: two seats
     * would mean two votes towards the threshold from one person.
     */

    /*
     * M-96, and the reason this method blocked the first attempt at sealing.
     *
     * THE INVITEE HAS NO VIEWING KEY and must not have one — they are entitled
     * to see nothing until an existing signer grants them access. So they cannot
     * be written into the sealed roster by the person creating them, because
     * sealing needs the key.
     *
     * They go into the account's INBOX instead: everything private about them,
     * including `leafCommitment`, sealed to a public key whose secret only a
     * viewing-key holder can derive. `grantAccess` folds it into the roster.
     *
     * Note what is NOT left in the clear. Putting the leaf outside would have
     * been simpler and it would have kept the exact mapping the on-chain
     * blinding exists to destroy, one join from `users.name`. See `PendingSigner`.
     */
    const payload: PendingSignerPayload = {
      name: invite.name ?? '(unnamed)',
      role: invite.role ?? 'approver',
      signingPublicKey,
      wrappingPublicKey,
      leafCommitment,
    };
    const pending: PendingSigner = {
      id: 'sgn_' + nanoid(10),
      userId: userId ?? null,
      createdAt: new Date().toISOString(),
      sealed: sealToInbox(payload, rec.inboxPublicKey),
    };
    this.store.putAccount({ ...rec, pendingSigners: [...rec.pendingSigners, pending] });

    invite.acceptedAt = new Date().toISOString();
    invite.subjectId = pending.id;
    /*
     * The invite's copy of the name and email is dropped here, not kept.
     *
     * It existed because there was no sealed record to point at until the person
     * did. Now there is — the drop box — so keeping it would leave a second,
     * readable copy of a signer's name and email in the invites table for the
     * life of the account. That is the S-9 shape exactly: sealing one table and
     * leaving the duplicate in another.
     */
    invite.name = undefined;
    invite.email = undefined;
    this.store.putInvite(invite);

    return {
      id: pending.id, userId: pending.userId, status: 'pending',
      name: payload.name, role: payload.role,
      signingPublicKey, wrappingPublicKey, leafCommitment,
    };
  }

  /**
   * Grants a pending signer access by re-wrapping the viewing key to them.
   *
   * This is the step that cannot be done by the server, and the reason the
   * viewing key arrives as an argument: it comes from a client that already
   * holds it. Nobody who lacks the key can hand it out, which is the whole
   * point and also why there is a real waiting state in the product.
   */
  async grantAccess(
    accountId: string,
    viewingKey: Hex,
    signerId: string,
    /** Whose device makes the on-chain call. Defaults to any active signer. */
    by?: string,
  ): Promise<Account> {
    const { rec, account } = this.load(accountId, viewingKey);
    const signer = account.signers.find(s => s.id === signerId);
    if (!signer) throw new Error('signer not found');
    if (signer.status === 'active') throw new Error('that signer already has access');
    if (!signer.leafCommitment) {
      throw new Error(
        'that signer has no leaf commitment, so there is nothing to put in the on-chain tree. ' +
          'Their device computes it when they accept the invite.',
      );
    }

    // Prove the caller actually holds the key before wrapping anything with it.
    const existing = account.wrappedKeys[0];
    if (!existing) throw new Error('account has no wrapped keys');

    /*
     * The leaf goes in the tree, and this is not a detail.
     *
     * This method used to set `status = 'active'` and stop. The viewing key was
     * re-wrapped, so the signer could READ the account — and every circuit
     * begins with `requireSigner()`, which proves a Merkle path into `signers`,
     * so they could not ACT on it. The product showed an active signer whose
     * every approval failed inside a proof.
     *
     * It goes BEFORE the local record for the same reason approvals do: the
     * chain is what decides, and a UI showing an active signer the tree does not
     * contain is the bug this is fixing.
     *
     * Whether this needs an approved proposal first is the contract's call, not
     * ours — see `Ledger.addSigner`. Past the bootstrap window it will refuse
     * until a round has been proposed and approved for this exact leaf, which is
     * `proposeSigner` below.
     */
    /*
     * WHICH approved proposal authorises this.
     *
     * Past the bootstrap window the contract requires one, and with several
     * proposals open at once it has to be told which. Null while bootstrapping,
     * where the contract does not look: the account cannot yet reach its own
     * threshold, so requiring a round would deadlock it at creation.
     *
     * **AND SINCE `S35d` THERE IS NO BOOTSTRAP WINDOW, SO THIS IS ALWAYS FALSE
     * ON THE MIDNIGHT PATH.** `C340` + `C343`: the constructor takes no
     * threshold and founds every account at one seat and one approval, and the
     * only other writers of those two quantities each assert
     * `!(signerLeaves.size() < …)` — so `signerCount < threshold` cannot be
     * true. `docs/company-accounts.md` section 10a carries the four-writer
     * proof.
     *
     * **IT IS KEPT AS A MIRROR AND NOT REPLACED WITH `false`, DELIBERATELY.**
     * This line does not DECIDE anything; it reads the chain and predicts what
     * the contract will do. Writing `false` here would hard-code our belief
     * about the contract into the client, which is the drift this whole method
     * is arranged to avoid — and `SimulatedLedger` still models a threshold the
     * real constructor no longer takes, so the two ledgers do not agree on this
     * and this expression is what keeps each honest against its own chain.
     */
    const status = await this.ledger.status(accountId);
    const bootstrapping = !!status && status.signerCount < status.threshold;
    const authorising = bootstrapping
      ? null
      : this.approvedFor(accountId, viewingKey, this.commitments.signerAddPayload(signer.leafCommitment)).chainId;

    await this.ledger.addSigner(
      accountId,
      signer.leafCommitment,
      authorising,
      by ? this.refFor(account, by) : this.anyActiveSigner(account),
    );

    account.wrappedKeys.push({ signerId, ...wrapKey(viewingKey, signer.wrappingPublicKey) });
    /*
     * The pending signer is folded into the SEALED ROSTER here, and dropped from
     * the inbox. This is the step the invitee could not perform for themselves —
     * it needs the viewing key, and the caller has just proved they hold one by
     * unwrapping with it.
     *
     * Dropping the inbox copy matters as much as writing the roster one: leaving
     * it would keep a second copy of the same signer, and the two would be free
     * to disagree the moment anything edits one of them.
     */
    signer.status = 'active';
    this.save(rec, account, viewingKey, rec.pendingSigners.filter(p => p.id !== signerId));
    return account;
  }

  /**
   * Opens the approval round that authorises adding a signer.
   *
   * Adding a signer to a live account is not one operation, it is a round —
   * because after M-37 a single existing signer adding signers freely would make
   * the threshold decorative. One stolen key could manufacture as many approvers
   * as it liked and then approve anything M times alone.
   *
   * The proposal commits to `signerAddPayload(leaf)` rather than to the leaf, so
   * a proposal approved to pay salaries cannot double as authorisation to add a
   * signer. The thing being approved has to be part of what is approved.
   *
   * Note this uses the ledger's `propose` directly rather than
   * `AccountService.propose`: there is no payment here, so there is no change to
   * the balance and no entries to append. The change is all zeros, which is
   * exactly what it is.
   */
  async proposeSigner(
    accountId: string,
    viewingKey: Hex,
    signerId: string,
    proposedBy: string,
  ): Promise<Proposal> {
    const account = this.open(accountId, viewingKey);
    const signer = account.signers.find(s => s.id === signerId);
    if (!signer?.leafCommitment) throw new Error('signer not found, or has no leaf commitment');

    const digest = this.commitments.signerAddPayload(signer.leafCommitment);
    // The change is built BEFORE the record, because its salt is what the
    // chain's id for this proposal is derived from.
    const change: StateChange = {
      asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt(),
    };
    const proposal: Proposal = {
      id: 'prp_' + nanoid(12),
      /*
       * `noVault()`, NAMED. Seating a signer concerns no vault, so the
       * round is measured against the account's own threshold — which is what
       * `thresholdFor(noVault())` answers by construction, because `noVault()`
       * is a hash of a domain string no vault address can equal
       * (`contracts/src/ConfidentialAccount.compact:1014`).
       */
      chainId: this.commitments.proposalId(digest, change.salt, this.commitments.noVault()),
      vault: this.commitments.noVault(),
      accountId,
      kind: 'add-signer',
      summary: `Add ${signer.name} as a signer`,
      /*
       * Sealed under the ACCOUNT's viewing key, not a throwaway one.
       *
       * There is nothing confidential in it — the leaf is already a blinded
       * commitment, and the chain shows that the account is adding someone
       * regardless. But every approval path opens this blob to read the amount,
       * so a payload nobody can decrypt makes the proposal unapprovable. It
       * failed exactly that way the first time, with `aes-gcm: invalid tag`.
       */
      sealedPayload: seal(canonical({ signerId, entries: [] }), viewingKey),
      digest,
      proposedBy,
      /* Kept because removing the proposer deletes their row, and
       * `recordStanding` would then have no role to judge the round by. Undefined
       * where the proposer is not seated, which is what this door already tolerates. */
      proposerRole: account.signers.find(sg => sg.id === proposedBy)?.role,
      approvals: [],
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    /*
     * A governance proposal moves no money, so its change is zero and its asset
     * is the reserved "none". See `NO_ASSET`: it derives a valid asset key that
     * named no entry in `assetBalances`, because no governance circuit wrote to
     * that map. `C292` removed the map, so the key now names nothing at all —
     * the reserved value is kept because `changeCommitmentOf` still takes an
     * asset key on every proposal and a real asset code in that slot would be a
     * governance round claiming to move money.
     */
    await this.raise(proposal, viewingKey, () => this.ledger.propose(
      accountId, digest, change,
      this.refFor(account, proposedBy), this.commitments.noVault()));
    return proposal;
  }

  /**
   * Opens the round that authorises changing the threshold.
   *
   * A round, and not a setting, because the threshold is the rule every other
   * operation on the account is measured against. Changing it with less
   * agreement than a payment needs would make every other guarantee decorative.
   */
  async proposeThresholdChange(
    accountId: string,
    viewingKey: Hex,
    newThreshold: number,
    proposedBy: string,
  ): Promise<Proposal> {
    const account = this.open(accountId, viewingKey);

    /*
     * Refused here as well as on chain, so a doomed round cannot collect
     * approvals before being rejected with the fee paid.
     *
     * THE TWO CHEAP CHECKS COME FIRST, BEFORE THE BOUNDARY IS READ. Nothing
     * about `0` or `2.5` needs the chain's opinion, and a round trip to refuse
     * a number that is not a threshold at all would make an unreachable ledger
     * the reason a typo was rejected.
     */
    if (!Number.isInteger(newThreshold) || newThreshold < 1) {
      throw new Error('the threshold must be a whole number, at least one');
    }

    /*
     * **THE SEATED COUNT IS THE LEDGER'S, AND SO IS THE THRESHOLD BELOW IT.**
     * It was `account.signers.filter(active).length` and
     * `account.policy.threshold` — both OUR copies of numbers the contract
     * owns.
     *
     * This is the mirror image of the two removal guards: they refuse to put
     * the threshold above the seats by taking seats away, and this one refuses
     * to do it by raising the threshold. The stranded account is identical
     * either way, and so is the mechanism — a local number, drifted, inside a
     * guard that is supposed to be the conservative one.
     */
    const seating = await this.chainSeating(accountId);
    const onChain = requireSeating(
      seating,
      `open a round to change this account's threshold to ${newThreshold}`,
    );
    const seated = onChain.signerCount;

    if (newThreshold > seated) {
      throw new Error(
        `the threshold cannot exceed the ${seated} signers the ledger holds seats for on ` +
          'this account. Above it, the contract treats the account as still being set up ' +
          'and one signer could seat their own. Add the signers first, then raise the ' +
          'threshold. M-37.' + seatingDrift(account, seating),
      );
    }
    if (newThreshold === onChain.threshold) {
      throw new Error(
        `the threshold is already ${newThreshold} on the ledger` + seatingDrift(account, seating),
      );
    }

    const digest = this.commitments.signerThresholdPayload(newThreshold);
    const change: StateChange = {
      asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt(),
    };
    const proposal: Proposal = {
      id: 'prp_' + nanoid(12),
      /* `noVault()`: the ACCOUNT's threshold is not any vault's. */
      chainId: this.commitments.proposalId(digest, change.salt, this.commitments.noVault()),
      vault: this.commitments.noVault(),
      accountId,
      kind: 'set-threshold',
      summary: `Change the approval threshold to ${newThreshold} of ${seated}`,
      // Sealed under the account key for the same reason the other governance
      // payloads are: every approval path opens this blob, so one nobody can
      // decrypt makes the proposal unapprovable.
      sealedPayload: seal(canonical({ newThreshold, entries: [] }), viewingKey),
      digest,
      proposedBy,
      /* Kept because removing the proposer deletes their row, and
       * `recordStanding` would then have no role to judge the round by. Undefined
       * where the proposer is not seated, which is what this door already tolerates. */
      proposerRole: account.signers.find(sg => sg.id === proposedBy)?.role,
      approvals: [],
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    /*
     * A governance proposal moves no money, so its change is zero and its asset
     * is the reserved "none". See `NO_ASSET`: it derives a valid asset key that
     * named no entry in `assetBalances`, because no governance circuit wrote to
     * that map. `C292` removed the map, so the key now names nothing at all —
     * the reserved value is kept because `changeCommitmentOf` still takes an
     * asset key on every proposal and a real asset code in that slot would be a
     * governance round claiming to move money.
     */
    await this.raise(proposal, viewingKey, () => this.ledger.propose(
      accountId, digest, change,
      this.refFor(account, proposedBy), this.commitments.noVault()));
    return proposal;
  }

  /**
   * Changes the threshold once the round has reached it.
   *
   * ON CHAIN FIRST, then our own copy — the same order as every other
   * governance operation here, and for the same reason. If the chain refuses,
   * nothing local has changed and the two still agree. Writing our copy first
   * is exactly the failure this method was deleted for: a product that says
   * three while the chain settles at two.
   */
  async setThreshold(
    accountId: string,
    viewingKey: Hex,
    newThreshold: number,
    by?: string,
  ): Promise<Account> {
    const { rec, account } = this.load(accountId, viewingKey);

    await this.ledger.setThreshold(
      accountId,
      newThreshold,
      this.approvedFor(accountId, viewingKey, this.commitments.signerThresholdPayload(newThreshold)).chainId,
      by ? this.refFor(account, by) : this.anyActiveSigner(account),
    );

    this.save(
      rec,
      { ...account, policy: { ...account.policy, threshold: newThreshold } },
      viewingKey,
      rec.pendingSigners,
    );
    return this.open(accountId, viewingKey);
  }

  /* ---------------- one vault's own threshold ---------------- */

  /**
   * **OPENS THE ROUND THAT GIVES ONE VAULT ITS OWN THRESHOLD.**
   *
   * `proposeThresholdChange`'s shape, applied to one vault instead of the
   * account, with one refusal added and one deliberately not added.
   *
   * **ZERO IS REFUSED HERE, BEFORE ANYTHING IS SIGNED**, which is the whole of
   * the first trap. The contract refuses it too (`:2712`, *"a vault threshold
   * of zero would authorise anything"*) and a product that let the round be
   * raised, approved by every signer, and then rejected by the chain would have
   * told nobody anything until the fee was paid. **The refusal a person needs
   * is the one they get before they sign.**
   *
   * **AND SO IS A THRESHOLD NOBODY CAN MEET**, which is the second half of the
   * same trap and is OURS rather than the contract's. `:2693-2697` says the
   * circuit deliberately does not bound this by the signer count, because a
   * vault has no bootstrap window to reopen — and the consequence it names is
   * that such a vault becomes unspendable until a governed round lowers the
   * number again. **That is recoverable and it is still not a state this
   * application will help a company reach.** The seats are the LEDGER's, read
   * once through `requireSeating`, for `X19`'s reason: our own roster is a copy
   * and a copy that has drifted HIGH would wave through exactly the round this
   * refuses.
   *
   * The refusal is labelled as ours where it is ours. The chain would accept
   * this round; we decline to raise it, which §4.3 item 3 of
   * `docs/scope-the-real-chain.md` permits and requires us to say.
   *
   * **NOTHING LOCAL IS WRITTEN BY EITHER METHOD.** There is no stored copy of a
   * vault's threshold anywhere in this service — see `Policy.threshold` — so
   * there is no second place for it to drift and no row-per-vault to write. The
   * number lives on chain and is read back through `LedgerStatus`.
   */
  async proposeVaultThresholdChange(
    accountId: string,
    viewingKey: Hex,
    vault: Hex,
    newThreshold: number,
    proposedBy: string,
  ): Promise<Proposal> {
    const account = this.open(accountId, viewingKey);

    /*
     * THE CHEAP CHECKS FIRST, BEFORE THE BOUNDARY IS READ, exactly as the
     * account's own threshold round does it: nothing about `0` or `2.5` needs
     * the chain's opinion, and a round trip to refuse a number that is not a
     * threshold at all would make an unreachable ledger the reason a typo was
     * rejected.
     */
    if (!Number.isInteger(newThreshold) || newThreshold < 1) {
      /*
       * THE LINE NUMBER IN THIS MESSAGE IS SHOWN TO A CUSTOMER, so it is the
       * one citation of the fourteen `V-83` counted that could not wait.
       *
       * IT HAS NOW BEEN WRONG THREE TIMES. It read `:2121`, was corrected to
       * `:2185`, and `C292`'s 240-line deletion moved the assert again. **Fixed
       * in the executable string by `S27`, not only in this comment:**
       * the assert is at `contracts/src/ConfidentialAccount.compact:2712` —
       * `assert(!(newThreshold == 0), "a vault threshold of zero would
       * authorise anything")` — verified against the source in the round that
       * wrote this line, and the file WAS 2,052 lines long then, so `:2185`
       * did not merely point at the wrong assert, it pointed past the end of
       * the file. **`S35d` moved it again — to `:2712` — which is the fourth
       * time, and the fourth time is the argument rather than the fix.**
       *
       * A stale citation in a comment wastes a reader's minute; a stale one in
       * a refusal a customer is shown sends them to the wrong place in a file
       * they are being invited to check us against.
       *
       * **AND THE PATTERN IS THE POINT, NOT THIS INSTANCE.** A `file:line`
       * inside a customer-facing string survives exactly until the next
       * deletion above it, and nothing here checks one. Every such citation is
       * a promise to a reader that something is at a place, made by a string
       * that cannot know whether it still is.
       */
      throw new Error(
        'a vault threshold of zero would authorise anything, so it must be a whole number, ' +
          'at least one. The contract refuses it as well ' +
          '(ConfidentialAccount.compact:2712); this refusal is here so nobody signs first.',
      );
    }
    if (vault === this.commitments.noVault()) {
      /*
       * `noVault()` is the reserved name for "no vault at all", so it can never
       * be a key in the contract's `thresholds` map and a row written against
       * it would be a row nothing ever reads. Refused rather than accepted and
       * ignored: a setting that silently does nothing is `C178` again.
       */
      throw new Error(
        'that is the reserved name for a proposal that concerns no vault, not a vault. ' +
          "The account's own threshold is changed with proposeThresholdChange.",
      );
    }

    const seating = await this.chainSeating(accountId);
    const onChain = requireSeating(
      seating,
      `open a round to set a vault's threshold to ${newThreshold}`,
    );
    if (newThreshold > onChain.signerCount) {
      throw new Error(
        `this company's own policy, applied by this service and not by the chain: a ` +
          `threshold of ${newThreshold} is more than the ${onChain.signerCount} signers the ` +
          'ledger holds seats for, so no payment out of that vault could ever be approved ' +
          'and its money would stay there until a governed round lowered the number again. ' +
          'The contract would accept this; we decline to raise it. Add the signers first.' +
          seatingDrift(account, seating),
      );
    }

    const digest = this.commitments.vaultThresholdPayload(vault, newThreshold);
    const change: StateChange = {
      asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt(),
    };
    const proposal: Proposal = {
      id: 'prp_' + nanoid(12),
      /*
       * **`noVault()`, AND NOT THE VAULT THIS ROUND IS ABOUT.** `R5`, and it is
       * the one place the distinction bites. The contract computes the same id
       * the same way — `proposalIdOf(setVaultThresholdPayload(vault,
       * newThreshold), noVault(), proposalSalt())`, `:2706-2708` — because the
       * round is GOVERNANCE and must be measured against the account's
       * threshold. Naming the vault here would let a vault whose threshold is
       * already 1 authorise its own further changes with one signature.
       *
       * The vault is in the PAYLOAD, which is what binds the round to it.
       */
      chainId: this.commitments.proposalId(digest, change.salt, this.commitments.noVault()),
      vault: this.commitments.noVault(),
      accountId,
      kind: 'set-vault-threshold',
      summary: `Set this vault's approval threshold to ${newThreshold} of ${onChain.signerCount}`,
      // Sealed under the account key for the reason every governance payload is:
      // every approval path opens this blob, so one nobody can decrypt makes the
      // proposal unapprovable.
      sealedPayload: seal(canonical({ vault, newThreshold, entries: [] }), viewingKey),
      digest,
      proposedBy,
      /* Kept because removing the proposer deletes their row, and
       * `recordStanding` would then have no role to judge the round by. Undefined
       * where the proposer is not seated, which is what this door already tolerates. */
      proposerRole: account.signers.find(sg => sg.id === proposedBy)?.role,
      approvals: [],
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    await this.raise(proposal, viewingKey, () => this.ledger.propose(
      accountId, digest, change,
      this.refFor(account, proposedBy), this.commitments.noVault()));
    return proposal;
  }

  /**
   * **APPLIES IT, ONCE THE ROUND HAS REACHED THE ACCOUNT'S THRESHOLD.**
   *
   * ON CHAIN AND NOWHERE ELSE. `setThreshold` writes our copy afterwards
   * because `Policy.threshold` exists to be rendered; there is no copy of a
   * vault's threshold to write, deliberately, so this method has no second half
   * and cannot have one that drifts.
   *
   * The zero refusal is repeated at the boundary rather than trusted from the
   * propose path, because the two are reachable independently: a round raised
   * before this check existed, or by another client, still arrives here.
   *
   * **AND SO IS THE SENTINEL REFUSAL, SINCE `S56`. `T-265` `P1`.** The sentence
   * above was true and the code under it only kept half of its own promise: the
   * zero was repeated here and `noVault()` was not, so the reserved name was
   * refused on the raise path (`:1359-1370`) and accepted on this one. The
   * route is `POST /api/accounts/:id/vault-threshold`
   * (`src/server/index.ts:887-899`), whose `vault` is
   * `z.string().regex(/^[0-9a-f]{64}$/)` — and `noVault()` is 64 lowercase hex
   * characters, so the shape check passes it. Below here the only numeric guard
   * is `< 1` (`src/core/ledger.ts:1670`, `src/midnight/ledger.ts:1349`) and
   * nothing anywhere compares the vault against the sentinel.
   *
   * **AND WHAT IT WOULD HAVE WRITTEN IS NOT AN INERT ROW. `C394`.**
   * An earlier draft of this comment said `noVault()` can never be a key in the
   * contract's `thresholds` map. **That sentence is false and this repository
   * already knows it is false** — `ConfidentialAccount.compact:2764-2779` is the
   * map's only writer, `:2778` is `thresholds.insert(disclose(vault), …)`, and
   * nothing in that circuit excludes the sentinel. It is the same false sentence
   * that `T-268` records at `ConfidentialAccount.compact:1372-1376` and cannot
   * correct without a recompile; **`S56` copied it into a second file and its
   * money-safety pass caught it.**
   *
   * **THE ROW WOULD BE READ.** `thresholdFor` (`:1358-1360`) consults the map,
   * `requireApprovedForVault` (`:1396`) calls it, and `recordPayment` reaches
   * that with a caller-chosen vault — so a seated `thresholds[noVault()]` lowers
   * the bar on the only write of `movements`. Governance is untouched:
   * `requireApproved` (`:1407-1411`) reads `threshold` and never goes through
   * `thresholdFor`. **So this refusal is worth more than a tidiness check, and
   * it is still only the CLIENT's half — the contract's half is `T-268`'s.**
   * **It is the same rule and the same words as the raise path**, deliberately,
   * so a reader meeting either meets one rule rather than two that can drift.
   */
  async setVaultThreshold(
    accountId: string,
    viewingKey: Hex,
    vault: Hex,
    newThreshold: number,
    by?: string,
  ): Promise<void> {
    const account = this.open(accountId, viewingKey);
    if (vault === this.commitments.noVault()) {
      throw new Error(
        'that is the reserved name for a proposal that concerns no vault, not a vault. ' +
          "The account's own threshold is changed with proposeThresholdChange.",
      );
    }
    await this.ledger.setVaultThreshold(
      accountId,
      vault,
      newThreshold,
      this.approvedFor(accountId, viewingKey, this.commitments.vaultThresholdPayload(vault, newThreshold)).chainId,
      by ? this.refFor(account, by) : this.anyActiveSigner(account),
    );
  }

  /*
   * THE VERSION THAT USED TO BE HERE WAS A LIE, AND THE REASON IS WORTH KEEPING.
   *
   *
   * It wrote `policy.threshold` into the sealed account. The contract declares
   *
   *     export sealed ledger threshold: Uint<64>;
   *
   * and `sealed` means writable once, in the constructor. There is no circuit
   * that can move it. So raising a 2-of-3 account to 3-of-3 changed our copy and
   * nothing else — and the product would then tell a customer that three
   * approvals were required while the chain went on settling at two.
   *
   * **That is the dangerous direction.** An off-chain rule that is merely
   * bypassable is a known limitation, stated in `docs/accounts-and-identity.md`.
   * This one claimed MORE safety than existed: a signer calling the contract
   * directly, or any client reading the real threshold, would execute with fewer
   * approvals than the account's owner believed were needed.
   *
   * Found because a mutation survived — removing the ledger's own strand-check
   * did not fail a test that had raised the threshold to 3 first, because the
   * ledger was still enforcing 2.
   *
   * It was removed rather than fixed, and the honest version is the pair of
   * methods above: the ledger field is no longer `sealed`, there is a
   * `setThreshold` circuit gated on an approved round, and our copy is only
   * written after the chain has accepted the change.
   *
   * **Do not reintroduce a local-only setter.** The shape to be suspicious of
   * is any method that writes `policy.threshold` without a round behind it.
   */

  /**
   * A signer recovers the viewing key from their own wrapping secret.
   *
   * Needs no viewing key, and could not: this is how one is obtained. That is
   * also why `wrappedKeys` stays outside the envelope — sealing it would be a
   * lock with its own key inside the box.
   */
  recoverViewingKey(accountId: string, signerId: string, wrappingSecret: Hex): Hex {
    const rec = this.require(accountId);
    const wrapped = rec.wrappedKeys.find(w => w.signerId === signerId);
    if (!wrapped) throw new Error('no wrapped key for that signer');
    return unwrapKey(wrapped, wrappingSecret);
  }

  /* ---------------- removing a signer ---------------- */

  /**
   * Who is leaving, and nothing else.
   *
   * This used to compute a whole new signer set: the next generation, every
   * survivor's re-derived leaf, and a refusal for anybody whose blinding factor
   * the roster did not hold. All of that existed because a removal invalidated
   * every leaf at once and had to re-seat the people who stayed.
   *
   * A removal now clears one slot in the tree. Nobody else's leaf changes, so
   * there is nothing to recompute, nothing to get wrong, and no reason for this
   * account to hold anybody's blinding factor.
   */
  private departing(account: Account, signerId: string, seating: ChainSeating) {
    const going = account.signers.find(s => s.id === signerId);
    if (!going) throw new Error('signer not found');
    if (!going.leafCommitment) {
      throw new Error('that signer has no leaf commitment, so they are not in the on-chain tree');
    }
    /*
     * **THE BAR IS THE CONTRACT'S.** This read
     * `account.policy.threshold`, which is OUR copy of a number the contract
     * owns, and the dangerous direction is drift BELOW the chain's value: our
     * copy saying 2 where the contract says 3 lets this guard wave through a
     * removal leaving two signers where three are needed, after which every
     * proposal is unapprovable and the money in the account is unspendable by
     * anybody, permanently.
     *
     * The status arrives as a value because the caller took the decision and
     * captured it once; see `chainSeating`.
     */
    const bar = requireSeating(seating, `remove ${going.name} as a signer`);
    const staying = account.signers.filter(s => s.id !== signerId && s.status === 'active');
    const survivors = survivorsAfter(bar, staying.length, 1);
    if (survivors < bar.threshold) {
      throw new Error(
        `removing ${going.name} would leave ${survivors} signers against a threshold of ` +
          `${bar.threshold}, and the account could never approve anything again.` +
          seatingDrift(account, seating),
      );
    }
    return { going, leaf: going.leafCommitment, staying };
  }

  /**
   * Opens the round that authorises removing a signer.
   *
   * A removal is a round for the same reason adding one is: a single
   * key that could drop other signers unilaterally could reduce an account to
   * itself and then approve anything alone.
   */
  async proposeRemoval(
    accountId: string,
    viewingKey: Hex,
    signerId: string,
    proposedBy: string,
  ): Promise<Proposal> {
    const account = this.open(accountId, viewingKey);
    const plan = this.departing(account, signerId, await this.chainSeating(accountId));
    const digest = this.commitments.signerRemovePayload(plan.leaf);
    const change: StateChange = {
      asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: newProposalSalt(),
    };

    const proposal: Proposal = {
      id: 'prp_' + nanoid(12),
      /* `noVault()`: a removal concerns no vault. */
      chainId: this.commitments.proposalId(digest, change.salt, this.commitments.noVault()),
      vault: this.commitments.noVault(),
      accountId,
      kind: 'remove-signer',
      summary: `Remove ${plan.going.name} as a signer`,
      // Sealed under the account key for the same reason `proposeSigner`'s is:
      // every approval path opens this blob, so one nobody can decrypt makes
      // the proposal unapprovable.
      sealedPayload: seal(canonical({ signerId, entries: [] }), viewingKey),
      digest,
      proposedBy,
      /* Kept because removing the proposer deletes their row, and
       * `recordStanding` would then have no role to judge the round by. Undefined
       * where the proposer is not seated, which is what this door already tolerates. */
      proposerRole: account.signers.find(sg => sg.id === proposedBy)?.role,
      approvals: [],
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    /*
     * A governance proposal moves no money, so its change is zero and its asset
     * is the reserved "none". See `NO_ASSET`: it derives a valid asset key that
     * named no entry in `assetBalances`, because no governance circuit wrote to
     * that map. `C292` removed the map, so the key now names nothing at all —
     * the reserved value is kept because `changeCommitmentOf` still takes an
     * asset key on every proposal and a real asset code in that slot would be a
     * governance round claiming to move money.
     */
    await this.raise(proposal, viewingKey, () => this.ledger.propose(
      accountId, digest, change,
      this.refFor(account, proposedBy), this.commitments.noVault()));
    return proposal;
  }

  /**
   * Removes a signer once the round has reached its threshold, then changes
   * the locks. M-106, then K-4, in that order and not the other.
   *
   * **Revoke first, rotate second.** Rotating first would leave a window in
   * which the departing signer can still act on chain AND still read, because
   * they hold the old viewing key until the new records are written. Doing it
   * this way, the moment they lose the ability to act is the moment before they
   * lose the ability to read.
   *
   * Returns the new viewing key. Every remaining signer can derive it from
   * their own wrapping secret; the person removed cannot, because no wrapped
   * copy is issued to them.
   */
  async removeSigner(
    accountId: string,
    viewingKey: Hex,
    signerId: string,
    by?: string,
  ): Promise<{ account: Account; viewingKey: Hex; keyEpoch: number }> {
    const { rec, account } = this.load(accountId, viewingKey);
    /*
     * **READ AGAIN HERE, AND THAT IS NOT A SECOND READ OF ONE DECISION.**
     * `proposeRemoval` asked whether a round MAY BE OPENED, possibly
     * days ago and possibly with a different signer set on chain. This asks
     * whether the removal MAY BE PERFORMED, now. Two decisions, one capture
     * each, which is `R4`'s rule rather than an exception to it.
     */
    const plan = this.departing(account, signerId, await this.chainSeating(accountId));

    /*
     * On chain first. If this is refused — not enough approvals, wrong
     * proposal, too few signers left — nothing local has changed and the
     * account is exactly as it was.
     */
    await this.ledger.removeSigner(
      accountId,
      plan.leaf,
      this.approvedFor(accountId, viewingKey, this.commitments.signerRemovePayload(plan.leaf)).chainId,
      this.refFor(account, by ?? plan.staying[0].id),
    );

    /*
     * The roster now has to match the tree, and since M-106 that means dropping
     * one row rather than rewriting every one of them. Nobody who stayed had
     * their leaf changed, so nobody who stayed can be got wrong here.
     */
    this.save(
      rec,
      {
        ...account,
        signers: account.signers.filter(s => s.id !== signerId),
        wrappedKeys: account.wrappedKeys.filter(w => w.signerId !== signerId),
      },
      viewingKey,
      rec.pendingSigners.filter(p => p.id !== signerId),
    );

    // And now the locks, which is what stops them READING anything further.
    const rotated = await this.rotate(accountId, viewingKey);
    return {
      account: this.open(accountId, rotated.viewingKey),
      viewingKey: rotated.viewingKey,
      keyEpoch: rotated.keyEpoch,
    };
  }

  /* ---------------- rotation (K-4) ---------------- */

  /**
   * Changes the locks. A new viewing key, everything re-sealed under it, and
   * re-wrapped to whoever is left.
   *
   * WHAT THIS DOES AND DOES NOT DO, because the difference is the product's
   * most important claim and it is easy to overstate.
   *
   * It does: make every record an account owns unreadable to anyone holding the
   * old key, from this moment on. Nobody can be un-taught a secret, so this is
   * the only meaning "revoke access" can have.
   *
   * It does NOT: take away a departing signer's authority on chain. Every
   * circuit begins with `requireSigner()`, which proves a Merkle path into an
   * append-only tree with no revocation circuit. **A signer excluded here can
   * still APPROVE — measured against the compiled circuits in
   * `contracts/test/signer-governance.test.ts`, twelve times and every one an
   * `.approve(...)`.** That is M-99, it needs a contract change, and **no
   * "remove signer" screen should exist until it lands.**
   *
   * **THE SENTENCE SAID *propose, approve, and spend* AND ONE INSTRUMENT WAS
   * CREDITED FOR ALL THREE.** `T-221` `P2`, `S52`, `C286`'s shape. Measured by
   * this round at source: `sim.as(FB)` appears twelve times in that file and
   * every one approves; there is no `sim.as(FB).propose(...)` anywhere in the
   * repository; and `spend` names an operation THIS CONTRACT DOES NOT HAVE —
   * `C292` deleted the account's spend circuit, and the compact says so itself
   * at `:1367-1368`. **`propose` is still true and is true BY CONSTRUCTION
   * rather than by measurement** — `requireSigner()` is `propose`'s first line
   * exactly as it is `approve`'s — and it is written as construction here
   * rather than folded back into a *not assumed*. **`not assumed` is what made
   * this rule 14 rather than loose prose, and the screen it governs is why the
   * narrowing matters rather than being tidy.** When it does, the order is revoke on chain first,
   * then rotate: the other way round leaves a window where the leaver can both
   * read and act.
   *
   * It also does not reach the past. The state as it stood at rotation is still
   * sealed under the old key at the old epoch, and is deliberately kept — the
   * blob store never deletes, because a deleted opening is an attestation that
   * can never be verified again (M-73/74). A leaver can therefore still read
   * what they could already read. They cannot read anything that happens next,
   * which is the whole of what revocation can mean.
   *
   * THE ORDERING IS THE RISK, and it is the M-74 rule:
   *
   *   1. re-seal the shielded state and write it at epoch n+1 **alongside** n
   *   2. compute the complete new record set — nothing written yet
   *   3. one atomic store write, which flips `keyEpoch` and re-issues the
   *      wrapped keys in the same breath
   *
   * A crash after 1 leaves the account fully readable at epoch n, with an
   * orphan blob nobody points at. A crash after 3 leaves it fully readable at
   * n+1. **There is no interleaved state**, which is the only property that
   * matters: every other ordering has a window in which the records and the
   * state disagree about which key is current, and both halves of that are
   * unrecoverable.
   */
  async rotate(
    accountId: string,
    viewingKey: Hex,
    /**
     * Signers who do not receive the new key. Their seat is dropped from the
     * roster and no wrapped copy is issued.
     *
     * Read the note above before building anything on this: it stops them
     * reading, not acting.
     */
    exclude: string[] = [],
  ): Promise<{ viewingKey: Hex; keyEpoch: number }> {
    const rec = this.require(accountId);
    // Opening it is what proves the caller holds the current key. A rotation
    // driven by someone who does not would seal the account to nobody.
    const account = openAccount(rec, viewingKey);
    const nextEpoch = rec.keyEpoch + 1;
    const nextKey = newSymmetricKey();

    const staying = account.signers.filter(s => !exclude.includes(s.id));
    const stayingActive = staying.filter(s => s.status === 'active');
    const unknown = exclude.filter(id => !account.signers.some(s => s.id === id));
    if (unknown.length) {
      throw new Error(`not a signer on this account: ${unknown.join(', ')}`);
    }
    /*
     * Refusing to strand the account is not politeness. Below the threshold it
     * can never approve anything again — including a proposal to add somebody
     * back — so the account is finished, with its money in it.
     *
     * **AND THE THRESHOLD IT IS MEASURED AGAINST IS THE CONTRACT'S.** `X19`,
     * It was `account.policy.threshold`. A guard whose entire job is to
     * be conservative, deciding from a copy that can silently drift below the
     * number the contract will actually apply, is the one shape that turns this
     * check into permission to strand the account — and the damage is invisible
     * at the moment it is done.
     *
     * The seat count cannot rescue it, and `survivorsAfter` says why in full:
     * this rotation frees no seat on chain, so the excluded signers stay in the
     * tree and the smaller of the two counts is the roster's.
     */
    /*
     * **THE GUARD RUNS WHEN THERE IS SOMETHING TO GUARD, AND A ROTATION THAT
     * DROPS NOBODY IS NOT IT.** `X19`, and this exemption is load-bearing
     * rather than an optimisation.
     *
     * `removeSigner` calls this with an empty `exclude`, AFTER the chain has
     * accepted the removal, and that call is what takes the departing signer's
     * ability to READ. Guarding it would mean an unreachable indexer could
     * refuse the second half of a removal whose first half has already settled
     * — the signer gone from the tree and the roster, still holding a viewing
     * key that opens everything. **Refusing there protects nothing:** dropping
     * nobody changes no survivor count and no rule, so the only refusal it
     * could produce is about a condition this operation did not cause and
     * cannot make worse. The conservative direction and the safe direction
     * point the same way only where the operation removes somebody.
     */
    if (exclude.length) {
      const seating = await this.chainSeating(accountId);
      const rule = requireSeating(
        seating,
        `change the locks on this account without ${exclude.length} of its signers`,
      );
      const stillSeated = survivorsAfter(rule, stayingActive.length, 0);
      if (stillSeated < rule.threshold) {
        throw new Error(
          `removing those signers would leave ${stillSeated} active of a threshold of ` +
            `${rule.threshold}, so the account could never approve anything again. ` +
            'Lower the threshold first.' + seatingDrift(account, seating),
        );
      }
    }

    /* 1. the state, at the new epoch, ALONGSIDE the old. */
    const current = await this.readSealed(accountId, viewingKey, rec.keyEpoch);
    /*
     * `current.blinding` IS CARRIED THROUGH UNCHANGED, and that is not laziness.
     *
     * A rotation re-encrypts what the account already holds; it does not move
     * anything. The entry log and — above all — the ASSET BLINDING are the same
     * values, so every commitment on chain still describes the account exactly
     * and there is nothing to submit. Generating a new asset blinding here
     * would change the asset key inside every change commitment already
     * approved, so a run one signature from settling could never be presented
     * at a vault. See `StateBlinding.assetBlinding`.
     *
     * ONE THING IS ADDED RATHER THAN CARRIED: a new payout seed. V-63.
     *
     * APPENDED, never replacing. The point of rotating it is that a removed
     * signer must learn nothing about payrolls raised after they left; the
     * point of keeping the old ones is that a run already approved must stay
     * payable. Replacing the list would make removing a signer strand every
     * open run — a new way to lose access to money, introduced by the fix for
     * one — and it would do it silently, at the moment an account is already
     * dealing with somebody leaving.
     *
     * A leaver keeps what they had already read, exactly as they do for the
     * state itself; see the note above this method.
     */
    const nextBlinding: StateBlinding = {
      ...current.blinding,
      // `?? []` guards data, not types: the sealed state is JSON out of a store,
      // and a record written before this field existed would otherwise fail
      // here with a message about spreading undefined.
      payoutSeeds: [...(current.blinding.payoutSeeds ?? []),
                    { epoch: nextEpoch, seed: newBlinding() }],
    };
    await this.ledger.reseal(
      accountId,
      this.sealState(current.state, nextBlinding, nextKey, nextEpoch),
    );

    /* 2. the complete new set, computed and not yet written. */
    const rotated: Account = {
      ...account,
      signers: staying,
      wrappedKeys: stayingActive.map(s => ({
        signerId: s.id, ...wrapKey(nextKey, s.wrappingPublicKey),
      })),
    };

    /*
     * The inbox moves with the key, so anything sitting in a drop box has to be
     * opened and re-posted in the same pass. Missing this would leave a pending
     * signer's details sealed to an inbox whose secret no longer exists —
     * unopenable by anyone, and only discovered when somebody tried to grant
     * them access.
     */
    const nextInbox = inboxPublicKey(nextKey, accountId);
    const pendingSigners: PendingSigner[] = rec.pendingSigners
      .filter(p => !exclude.includes(p.id))
      .map(p => ({
        ...p,
        sealed: sealToInbox(
          openFromInbox<PendingSignerPayload>(p.sealed, accountId, viewingKey), nextInbox),
      }));

    const employees = this.store.listEmployees(accountId).map(e => ({
      ...e,
      keyEpoch: nextEpoch,
      /*
       * AN EMPLOYEE'S DROP BOX MOVES WITH THE KEY, EXACTLY AS A PENDING
       * SIGNER'S DOES. Found by audit 17 Aug; this line was missing and the
       * whole record was copied through with `...e`.
       *
       * What it cost: a handover left unadmitted across a rotation became
       * unopenable by ANY key — the old one opens the box and not the roster
       * entry, which has been re-sealed at the new epoch; the new one opens the
       * roster entry and not the box. The invite refuses a second handover as
       * "already used", so the person could never be admitted, and because a
       * run refuses to build while anybody is pending, **the whole company's
       * payroll froze** behind one new hire. Rotation is what happens when a
       * signer leaves and onboarding never stops, so the two overlap by
       * default rather than by bad luck.
       *
       * The identical property for a pending signer is asserted twelve lines
       * above and was green throughout.
       */
      /*
       * **AND SINCE `X11` §7 THERE ARE TWO ENVELOPES, SO BOTH MOVE.**
       *
       * The invitee seals their own address to the inbox key on their own
       * device and this service seals `byUserId` around it. **The inbox key is
       * derived from the viewing key**, so a rotation that re-sealed only the
       * outer one would leave the inner sealed to a secret that no longer
       * exists — exactly the freeze this line was added to prevent, one layer
       * further in, and invisible until somebody tried to admit.
       *
       * **THE COST, SAID RATHER THAN LEFT TO BE FOUND:** re-sealing means
       * opening, so the receiving address exists in this process for the length
       * of this expression. `C160` is not reopened by that — it is about the
       * address arriving in a REQUEST BODY, and rotation carries no address at
       * all — but it is the second of exactly two moments where we hold the
       * plaintext, the other being `admit`. **Both are moments where an admin
       * has handed us the account's viewing key anyway**, which is the trade
       * `scope-server-trust.md` already records; neither is an acceptance.
       *
       * The inner value is moved as an OPAQUE one. Nothing here checks its
       * shape: `openHandover` does that at `admit`, and a rotation that refused
       * a handover it could not understand would strand the person it belongs
       * to for a reason that has nothing to do with rotating a key.
       */
      inbox: e.inbox ? resealDropBox(e.inbox, accountId, viewingKey, nextInbox) : null,
      sealed: sealRecord('payroll', accountId,
        openRecord('payroll', accountId, e.sealed, viewingKey), nextKey),
    }));

    const runs = this.store.listRuns(accountId).map(r => ({
      ...r,
      keyEpoch: nextEpoch,
      // `payslips` are NOT touched. Each is sealed to one employee's own key and
      // deliberately not readable with the account's, so the account viewing key
      // could not re-seal them and must not appear able to.
      sealed: sealRecord('payroll', accountId,
        openRecord('payroll', accountId, r.sealed, viewingKey), nextKey),
    }));

    const proposals = this.store.listProposals(accountId).map(p => {
      const opened = this.openProposal(p, viewingKey);
      /*
       * `sealedPayload` is sealed under the RAW viewing key, inside a record
       * that is itself sealed under a subkey. Re-sealing only the outer
       * envelope leaves an inner blob nobody can open, and it would not surface
       * here — it would surface at the next approval, as `aes-gcm: invalid tag`
       * on a round with a fee already paid.
       *
       * Re-sealed as bytes rather than parsed and re-serialised, so a change in
       * canonical form can never alter a payload the chain has committed to.
       */
      const rewrapped: Proposal = {
        ...opened,
        sealedPayload: seal(unseal(opened.sealedPayload, viewingKey), nextKey),
      };
      const { id, accountId: aid, status, createdAt, executedAt, digest, txRef, chainId, ...secrets } = rewrapped;
      return {
        id, accountId: aid, status, createdAt, executedAt, digest, txRef, chainId,
        approvalCount: rewrapped.approvals.length,
        keyEpoch: nextEpoch,
        sealed: sealRecord('proposals', aid, secrets, nextKey),
      };
    });

    /* 3. one write. */
    this.store.commitRotation({
      account: sealAccount(rotated, nextKey, pendingSigners, nextEpoch),
      employees,
      runs,
      proposals,
    });

    return { viewingKey: nextKey, keyEpoch: nextEpoch };
  }

  /* ---------------- shielded state ---------------- */

  /*
   * `viewOf` STOOD HERE AND `S52` DELETED IT. `T-226` `P3`. Definition plus one
   * prose mention at `src/core/ledger.ts:216`, and no caller anywhere.
   *
   * **WHAT IT DID AND WHY IT IS NOT COMING BACK IN THAT SHAPE:** it turned a
   * state into the three values the contract hashed — the balance separately,
   * everything else as one digest — and that split was the CONTRACT's and not
   * ours. `C292` removed the balance, so the split has one side left.
   */


  /** The digest of a batch of entries, as the change commits to it. */
  private batchDigestOf(entries: ShieldedEntry[]): Hex {
    return commit(canonical(entries), '');
  }

  /**
   * The one asset a batch of entries moves, or a refusal.
   *
   * ONE ASSET PER ROUND. `execute` moved one balance, so a proposal
   * mixing assets was a proposal the chain could never settle, and refusing it
   * here — at the moment it is written — was the difference between a clear
   * error and a round that collects approvals and is then rejected with the fee
   * paid.
   *
   * **`C292` REMOVED THE CIRCUIT THAT WOULD REJECT IT, AND THIS REFUSAL IS NOW
   * THE ONLY ONE.** A proposal's change commitment still names one asset key,
   * and nothing on chain opens it, so a mixed proposal would be accepted by the
   * contract and would simply mean nothing. Rule 27: what enforces one asset
   * per round today is this method and nothing else.
   *
   * A mixed payroll run is several proposals against the same run, one per
   * settlement asset — which is what `PayrollService` builds.
   */
  private oneAssetOf(entries: ShieldedEntry[], fallback: AssetId): AssetId {
    const named = [...new Set(entries.map(e => e.asset))];
    if (named.length === 0) return fallback;
    if (named.length > 1) {
      throw new Error(
        `this proposal moves ${named.length} assets (${named.join(', ')}), and a round settles ` +
          'exactly one. Split it into one proposal per asset — they can reference the same run.',
      );
    }
    return named[0];
  }

  /**
   * The sealed blob now carries the opening as well as the state.
   *
   * It had to. The next call had to prove what the *current* state was —
   * `stateBalance`, `stateEntriesDigest` and `stateSalt` were witnesses to the
   * circuit — and the salt is unrecoverable from the state alone. Before M-29
   * the blob held a nonce that nothing ever read again, because the commitment
   * was computed here and handed to the ledger; then it was computed by the
   * ledger, and this is what let the next one be computed at all.
   *
   * `C292` DELETED ALL THREE WITNESSES AND THE CIRCUIT THAT READ THEM. What the
   * blob still carries is the entry log and the blindings, `assetBlinding`
   * among them, which every proposal needs and which cannot be recomputed from
   * anything else. Nothing proves a current state to anybody.
   */
  private sealState(
    state: ShieldedState,
    blinding: StateBlinding,
    viewingKey: Hex,
    keyEpoch: number,
  ): SealedStateAt {
    /*
     * `canonical`, not `JSON.stringify`.
     *
     * Every amount in here is a bigint — the balances were and the entries
     * still are — and `JSON.stringify` throws on one, which is the loud failure
     * bigint was chosen for, but only if the write
     * path is the one that knows how to encode it. `canonical` writes
     * `{"$n":"…"}` and `parseCanonical` in `readSealed` reads it back. The two
     * are a pair and neither is correct alone.
     */
    return { keyEpoch, sealed: seal(canonical({ state, blinding }), viewingKey) };
  }

  /**
   * The shielded state, opened.
   *
   * `keyEpoch` is not a convenience: the same state sealed under two viewing
   * keys is filed under the same address and has different bytes, so the epoch
   * is the only thing that says which ciphertext to ask for. That was true when
   * the address was a state commitment and it is more true now `C292` has made
   * it one constant for every account. It comes from the account
   * record, which is the one place that decides which key is current. K-4.
   */
  private async readSealed(
    accountId: string,
    viewingKey: Hex,
    keyEpoch: number,
  ): Promise<{ state: ShieldedState; blinding: StateBlinding }> {
    const rec = await this.ledger.fetch(accountId, keyEpoch);
    if (!rec) throw new Error('no state for that account');
    try {
      // `parseCanonical`, matching `sealState`'s `canonical`. A plain
      // `JSON.parse` hands back `{"$n":"500000"}` where a balance belongs — an
      // object in arithmetic, which is `NaN` or a concatenation, not an error.
      const parsed = parseCanonical<{ state: ShieldedState; blinding: StateBlinding }>(
        unseal(rec.sealedState, viewingKey),
      );
      return { state: parsed.state, blinding: parsed.blinding };
    } catch {
      throw new Error('viewing key cannot open this account');
    }
  }

  async readState(accountId: string, viewingKey: Hex): Promise<ShieldedState> {
    return (await this.readSealed(accountId, viewingKey, this.require(accountId).keyEpoch)).state;
  }

  /**
   * What the chain publicly says about this account's round.
   *
   * Exposed because the caller has to be able to see it. On Midnight a proposal
   * is on-chain state, so "is a round already open" is not something the server
   * can answer from its own records — and answering it from our records is how
   * a UI comes to offer a button the chain will reject.
   */
  async ledgerStatus(accountId: string): Promise<LedgerStatus | null> {
    return this.ledger.status(accountId);
  }

  /**
   * **ONE READ OF THE BOUNDARY, REDUCED TO A VALUE, PER DECISION.**
   *
   * The three guards that stop an account being stranded all ask the same two
   * questions — what is the bar, and how many seats are there — and all three
   * used to answer them out of our own record. They ask here instead.
   *
   * **A THROWN READ IS CAUGHT, WHERE `R4`'s APPROVAL PATH LETS ONE PROPAGATE.**
   * An escaping transport error already refuses, in the sense that the
   * operation does not happen; what it cannot do is say WHY in the terms that
   * matter. The whole point of `X19` is that a guard's refusal has to be
   * distinguishable — "the account would be stranded" and "we could not find
   * out" are different facts with different next steps — and an exception from
   * a socket says neither, while inviting the caller that retries around
   * transport failures to swallow the guard along with it.
   */
  private async chainSeating(accountId: string): Promise<ChainSeating> {
    try {
      return seatingOnChain(await this.ledger.status(accountId));
    } catch {
      return { state: 'unknown', why: 'unreadable' };
    }
  }

  /**
   * The public half of a signer's identity, as the ledger wants it.
   *
   * A null leaf is refused rather than coerced. `leafCommitment` is nullable for
   * signers created before M-13, and such a signer is not in the on-chain tree —
   * every circuit begins with `requireSigner()`, which proves a Merkle path to a
   * leaf, so they cannot act. Failing here says that plainly; passing an empty
   * string would fail inside the proof with "not a signer", which is the right
   * outcome for the wrong reason and much harder to read.
   */
  private refFor(account: Account, signerId: string): SignerRef {
    const s = account.signers.find(x => x.id === signerId);
    if (!s) throw new Error('not a signer on this account');
    if (!s.leafCommitment) {
      throw new Error(
        `signer "${s.name}" has no leaf commitment and is not in the on-chain signer set, ` +
          'so they cannot act on this account. They predate M-13 and must be re-added.',
      );
    }
    return { signerId: s.id, leaf: s.leafCommitment };
  }

  /**
   * Who calls the circuit when the product does not name anybody.
   *
   * On Midnight every circuit begins with `requireSigner()`, so there is no such
   * thing as an unattributed write — somebody's device signs it. Defaulting to
   * the first active signer keeps the simulation honest about that rather than
   * pretending a write can come from nowhere.
   */
  private anyActiveSigner(account: Account): SignerRef {
    const s = account.signers.find(x => x.status === 'active' && x.leafCommitment);
    if (!s) throw new Error('the account has no active signer able to act on chain');
    return this.refFor(account, s.id);
  }

  /*
   * ---------------- value in ----------------
   *
   * THERE IS NO VALUE-IN PATH AT THE ACCOUNT, AND THAT IS THE DECISION.
   *
   * `deposit` stood here. It was the only thing that ever funded an account
   * balance, and it funded a book the account did not need: this service's
   * account is an AUTHORITY, not a purse. It decides by M of N what a vault may
   * pay, and it records which payments were made. Money is held by the vault,
   * and it arrives there through the vault's own deposit path, which this round
   * does not touch.
   *
   * `deposit`, `execute`, `Ledger.credit`, `Ledger.settleRound`, the contract's
   * `execute` circuit and its `assetBalances` and `settled` fields were all
   * removed together, because each of them existed only for the others.
   */

  /* ---------------- proposals ---------------- */

  async propose(args: {
    accountId: string; viewingKey: Hex; kind: ProposalKind;
    summary: string; payload: Record<string, unknown>;
    /**
     * Which asset this round moves, and how much of it.
     *
     * Both are derived from the entries where there are any — passing them
     * separately as well would be the same figure written twice, which is this
     * project's oldest failure. They are arguments only so that a proposal with
     * no entries still names an asset.
     */
    asset?: AssetId; amount?: bigint;
    /**
     * **REFUSED FOR ANY VALUE BUT `noVault()`, AND THE CAPABILITY IT USED TO
     * DOCUMENT HAS NEVER WORKED ON CHAIN.**
     *
     * It read that scoping a governance round to a vault was *expressible and
     * testable* before the vault path lands. **It was expressible and it was
     * never true**: `contracts/src/ConfidentialAccount.compact:2319` asserts
     * `vault == noVault()` on the branch this door raises, all six governance
     * consumers recompute with `noVault()`, and the only circuit that reads a
     * vault's own threshold is `recordPayment`, which needs a run payload — so
     * such a round is raised, collects real approvals, and can be consumed by
     * nothing. Its tests were green because they ran on `SimulatedLedger`,
     * which had no such assert until this round put one there.
     *
     * **REFUSED HERE AND NOT ONLY THERE, WHICH IS WHAT THE CONTRACT'S OWN NOTE
     * ASKS FOR** — *"...after a fee unless the boundary refuses it first"*
     * (`compact:2313-2316`). Rule 19 and rule 28. */
    vault?: Hex;
    proposedBy: string;
  }): Promise<Proposal> {
    const account = this.open(args.accountId, args.viewingKey);
    const proposer = account.signers.find(s => s.id === args.proposedBy);
    if (!proposer) throw new Error('proposer is not a signer on this account');

    /*
     * M-70/M-71. The CHANGE is computed here, once, and travels with the
     * proposal.
     *
     * The chain commits to it at propose time under `change.salt`. It used to
     * recompute that commitment at execute time, which is why the salt had to
     * be the proposer's; `C292` removed that reader, and the salt is still the
     * proposer's because the PROPOSAL'S OWN ID is derived from it and every
     * governance circuit and `recordPayment` recompute the id to prove they
     * were handed the round the signers approved. Sealed rather than stored in
     * the clear because the amount is exactly what this product exists to hide.
     *
     * Note what is NOT read here any more: the current state. A change does not
     * depend on it, which is the whole of M-71 — it is what lets a deposit into
     * the vault land mid-round without invalidating anything.
     */
    const entries = (args.payload.entries ?? []) as ShieldedEntry[];
    const asset = this.oneAssetOf(entries, args.asset ?? NO_ASSET);
    if (asset !== NO_ASSET) this.assets.require(asset);
    const change: StateChange = {
      asset,
      /* `T-205`: the sum is refused where the change is BUILT. */
      amount: sumChangeAmount(entries.map(e => e.amount), "this proposal's change"),
      batchDigest: this.batchDigestOf(entries),
      salt: newProposalSalt(),
    };

    const sealedPayload = seal(
      canonical({ ...args.payload, __change: change }),
      args.viewingKey,
    );
    const digest = commit(canonical({
      accountId: args.accountId, kind: args.kind, sealedPayload, proposedBy: args.proposedBy,
    }), '');
    /*
     * WHAT THE CHAIN CALLS THIS PROPOSAL.
     *
     * `commit(digest, change.salt)`, computed here rather than read back from
     * the chain, so the proposal has an identity before it is submitted — which
     * is what lets a signer's device prepare an approval without a round trip.
     * The salt is the change's, because the contract derives the same id from
     * the same salt inside `propose`.
     */
    /*
     * **AND THE VAULT IS IN IT.** `proposalIdOf(payload, vault, salt)` —
     * `contracts/src/ConfidentialAccount.compact:874` — so the vault is part of
     * what the round IS rather than a label on it. Two rounds identical but for
     * their vault are two different ids, and an approval collected against one
     * matches nothing at the other.
     */
    const vault = governanceVault(args.vault, this.commitments.noVault());
    const chainId = this.commitments.proposalId(digest, change.salt, vault);

    /*
     * **NO CHAIN READ HERE, AND THAT IS THE DELIBERATE HANDLING OF THE
     * ASYNCHRONY RATHER THAN A GAP.**
     *
     * `this.ledger.propose` is thirty lines below. At this instant the round
     * does not exist on chain, so a `status()` call could only ever answer "not
     * among the open proposals" — a round trip to be told something guaranteed
     * by the line that follows it. We state the fact we already hold instead,
     * and `not-yet-proposed` says which of the three kinds of not-knowing this
     * is, so nothing downstream mistakes it for a ledger that failed to answer.
     *
     * The only field this call site reads is `blocked`: this is the ceiling
     * decision, taken before any signer sees the proposal. `verdict.approval`
     * is not read here and must not be — a proposal's approval position is
     * established in `approve`, from a status captured there.
     */
    const verdict = evaluatePolicy(
      account, asset, change.amount, proposer.role,
      { state: 'unknown', why: 'not-yet-proposed' },
    );

    const proposal: Proposal = {
      id: 'prp_' + nanoid(12),
      chainId,
      vault,
      accountId: args.accountId,
      kind: args.kind,
      summary: args.summary,
      sealedPayload,
      digest,
      proposedBy: args.proposedBy,
      /* `T-286`, `S58`: the role the ceiling above was evaluated against, kept
       * where removing the proposer cannot take it away. `src/core/types.ts`. */
      proposerRole: proposer.role,
      approvals: [],
      status: verdict.blocked ? 'blocked' : 'open',
      blockedReason: verdict.reason,
      createdAt: new Date().toISOString(),
    };

    /*
     * A proposal the policy engine blocked never reaches the ledger. It is a
     * local record of an attempt, and there is no reason to spend a fee and a
     * round on chain for something this service has already refused.
     *
     * **THE REASON THAT STOOD HERE WAS A RULE THE CONTRACT HAS NOT HAD SINCE
     * M-128.** `T-223` `P3`. It read *"the contract allows exactly one
     * open proposal, so a blocked one sitting on chain would have to be
     * cancelled before anything legitimate could be proposed"* — and `:2711`
     * in this same file, `src/core/ledger.ts:1151` and
     * `contracts/src/ConfidentialAccount.compact:2321-2330` all say M-128
     * removed it, the last of them calling its absence *the feature*. Several
     * proposals sit open at once now, so nothing wedges. **The ACTION was
     * right for a different reason and is unchanged; only the reason moved.**
     * `C366`/`C372`'s family: true once, never re-read.
     *
     * `digest` is what goes across, not the payload. The chain commits to it
     * and learns nothing else — which is also what binds the approvals to *this*
     * proposal rather than to the account in general.
     */
    if (!verdict.blocked) {
      await this.raise(proposal, args.viewingKey, () => this.ledger.propose(
        args.accountId,
        proposal.digest,
        change,
        this.refFor(account, args.proposedBy),
        vault,
      ));
    } else {
      this.putProposal(proposal, args.viewingKey);
    }
    return proposal;
  }

  /**
   * **RAISES A PAYROLL RUN, AND IT IS A SEPARATE DOOR BECAUSE IT IS A SEPARATE
   * ACT.**
   *
   * **WHY `propose` ABOVE COULD NOT BE MADE TO DO THIS.** Its payload hash is
   * an APPLICATION digest — `commit(canonical({accountId, kind, sealedPayload,
   * proposedBy}), '')`, thirty lines up — and `recordPayment` recomputes
   * `proposalIdOf(runPayload(root, payees, opensAt, closesAt), forVault, salt)`
   * and matches only a `runPayload`
   * (`contracts/src/ConfidentialAccount.compact:2606-2609`). The two can never
   * be equal, whatever `kind` says. **So a run raised through that door is
   * approved, paid for, and unpayable by any vault for ever**, and carries no
   * `runWindow` row so nothing can close it either. That is `C375`, and the
   * fix is a door, not a flag.
   *
   * **EVERYTHING ELSE IS DELIBERATELY IDENTICAL TO `propose`, AND THE
   * DUPLICATION IS THE POINT RATHER THAN AN OVERSIGHT.** The same sealed
   * payload, the same `StateChange`, the same policy verdict, the same
   * `Proposal` record through the same `putProposal`. A run that produced a
   * different record shape would be a round the approve, cancel and listing
   * paths cannot see — the durable half of `T-228`'s failure made permanent
   * instead of a window.
   *
   * **WHAT IS NOT IDENTICAL, AND EACH IS FORCED:**
   *   · `digest` is the RUN PAYLOAD rather than the application digest, so the
   *     invariant every other reader relies on — `chainId ==
   *     proposalId(digest, salt, vault)` — is true on both doors.
   *   · `chainId` is the id the LEDGER RETURNS, not one computed here. The
   *     ledger is the side that talks to the chain and post-checks that the
   *     chain holds it (`src/midnight/ledger.ts:841-847`).
   *   · `vault` is required and real. A run at `noVault()` is one no vault can
   *     present, and both ledgers refuse it.
   *   · **A BLOCKED RUN IS NOT RAISED AND IS NOT RECORDED AS OPEN**, exactly as
   *     above.
   *
   * **AND THE ID IS CHECKED RATHER THAN TRUSTED — BUT THE CHECK IS WEAKER THAN
   * IT LOOKS AND THIS SAYS SO.** `S47`, corrected by its own
   * money-safety pass before it was written down. Rule 14.
   *
   * It recomputes `proposalId(digest, salt, vault)` from the SERVICE's own
   * scheme and compares it to what the ledger returned, so it fires when the
   * two were handed DIFFERENT schemes. **Under the product's own wiring they
   * are handed the same object** — `src/wiring/selection.ts` passes one
   * `commitments` value to both — so in `src/` this comparison can never fail
   * and it is a guard against a mis-wiring rather than against `C371` itself.
   * `C371` was a client that computed a value the CHAIN disagreed with, and
   * only the chain can refuse that: `MidnightLedger.proposeRun` post-checks
   * that the chain holds the id (`src/midnight/ledger.ts:841-847`), and
   * `contracts/test/the-payroll-run-meets-the-chain.test.ts` is where the
   * question is actually put.
   */
  async proposeRun(args: {
    accountId: string; viewingKey: Hex;
    summary: string; payload: Record<string, unknown>;
    asset?: AssetId;
    /** The run, as the chain is asked to open one. Every part is required. */
    run: RunProposal;
    proposedBy: string;
  }): Promise<Proposal> {
    const account = this.open(args.accountId, args.viewingKey);
    const proposer = account.signers.find(s => s.id === args.proposedBy);
    if (!proposer) throw new Error('proposer is not a signer on this account');

    const entries = (args.payload.entries ?? []) as ShieldedEntry[];
    const asset = this.oneAssetOf(entries, args.asset ?? NO_ASSET);
    if (asset !== NO_ASSET) this.assets.require(asset);
    const change: StateChange = {
      asset,
      /* `T-205`: the sum is refused where the change is BUILT. */
      amount: sumChangeAmount(entries.map(e => e.amount), "this run's change"),
      batchDigest: this.batchDigestOf(entries),
      salt: newProposalSalt(),
    };

    const sealedPayload = seal(
      canonical({ ...args.payload, __change: change }),
      args.viewingKey,
    );
    /*
     * **THE PAYLOAD THE CHAIN COMMITS TO IS THE RUN'S, AND THE SEALED PAYLOAD
     * IS NOT IN IT.** The four parts below are all the chain is given, and none
     * of them names a payee: `root` is a merkle root over blinded leaves,
     * `payees` is a count. What the company can read stays in `sealedPayload`,
     * which the chain never sees and which no longer contributes to the id.
     */
    const digest = this.commitments.runPayload(
      args.run.root, args.run.payees, args.run.opensAt, args.run.closesAt);

    /*
     * **THE ROOT IS 32 BYTES, CHECKED HERE, AND `C369` IS WHY.** `S47`, found
     * by this round's money-safety pass against this method.
     *
     * `MidnightCommitments.runPayload` hands the root to `fromHex` and the
     * binding refuses anything SHORT. **A FRONT-PADDED root is silent** — it is
     * 32 bytes and it is the wrong 32 — and the simulated scheme interpolates
     * the hex string and accepts any width at all, which is what the product
     * actually runs. Either way the run is well-formed, approved, and carries a
     * root no payout tree produced, so every merkle path a vault presents
     * fails at `recordPayment` after the signatures are in. `C369`'s species,
     * at a door `C369` did not exist to cover.
     *
     * Sixty-four lower-case hex characters, which is what `toHex` emits and
     * what `rootBytesOf` produces at the other end.
     */
    if (!/^[0-9a-f]{64}$/.test(args.run.root)) {
      throw new Error(
        `a run's payout root is 32 bytes as 64 lower-case hex characters; this one is ` +
          `${args.run.root.length} character(s). A root of the wrong width builds a proposal ` +
          'id no merkle path can ever satisfy, and nothing finds out until a vault tries to pay.',
      );
    }
    if (args.run.vault === this.commitments.noVault()) {
      throw new Error(
        'a payroll run must name the vault that will pay it. Refused here rather than raised, ' +
          'approved and then presented at a vault that cannot recompute its id.',
      );
    }

    const verdict = evaluatePolicy(
      account, asset, change.amount, proposer.role,
      { state: 'unknown', why: 'not-yet-proposed' },
    );

    const chainId = this.commitments.proposalId(digest, change.salt, args.run.vault);
    const proposal: Proposal = {
      id: 'prp_' + nanoid(12),
      chainId,
      vault: args.run.vault,
      accountId: args.accountId,
      kind: 'payroll',
      summary: args.summary,
      sealedPayload,
      digest,
      proposedBy: args.proposedBy,
      /* `T-286`, `S58`: as in `raiseGovernance` above — one field, one meaning,
       * written at both doors so the reconcile never has to guess. */
      proposerRole: proposer.role,
      approvals: [],
      status: verdict.blocked ? 'blocked' : 'open',
      blockedReason: verdict.reason,
      createdAt: new Date().toISOString(),
    };
    /* **A SIXTH DOOR WITH `C378`'s SHAPE** — the row names five and `S47` added
     * this one after it. The id check runs INSIDE `raise`. */
    if (!verdict.blocked) {
      await this.raise(proposal, args.viewingKey, async () => {
        const raised = await this.ledger.proposeRun(
          args.accountId, args.run, change, this.refFor(account, args.proposedBy));
        if (raised.proposalId !== chainId) {
          throw new Error(
            'the ledger raised this run under an id this service cannot derive, so no approval '
            + `collected here would match it. the ledger's id: ${raised.proposalId}; this `
            + `service's: ${chainId}. The two are computed from the same four values under `
            + 'different commitment schemes, so the two layers were handed different ones.');
        }
        return raised;
      });
    } else {
      this.putProposal(proposal, args.viewingKey);
    }
    return proposal;
  }

  /**
   * **THE SIGNATURE ARRIVES. IT IS NOT MADE HERE.**
   *
   * This took the signer's `signingSecret` and called `sign` on it, in this
   * process. So approving meant posting your signing key to us, and two things
   * followed. We held, in memory, a key we have promised never to hold — and,
   * worse, **whoever holds one signer's secret can produce every signature that
   * secret will ever produce.** A threshold of three is a threshold of one for
   * anybody handed the secret once: us, a log, a crash dump, a proxy. **A
   * threshold one party can reach alone is not a threshold**, and M-of-N
   * approval is the product.
   *
   * The contract never had this hole. A signer there proves knowledge of a
   * secret that never leaves their device and there is no signature scheme in
   * it at all. The hole was entirely in the application built beside it, and
   * this argument being a `signature` is the whole of the fix: there is no
   * longer a value this method could sign with, and `sign` is not imported.
   *
   * **AND SINCE `R4` THE THRESHOLD DECISION IS NOT OURS EITHER.**
   *
   * This paragraph used to say the opposite, and it was the honest half of a
   * half-closed defect: `evaluatePolicy` ran in this process against a policy
   * this process held, so a service that could not forge an approval could
   * still ignore the rule. It no longer counts. `approvals` and `threshold` are
   * both read off `LedgerStatus` below, reduced once, and compared to each
   * other; `account.policy.threshold` is not consulted on this path at all.
   *
   * **SAID PLAINLY BECAUSE IT WOULD OTHERWISE OVERSTATE ITSELF: the ledger here
   * is `SimulatedLedger`, so today this is a read of a simulator running in
   * this same process.** It is not yet an assurance. What has changed is the
   * SOURCE — the answer arrives through the `Ledger` boundary instead of being
   * computed from a local object — so the day `MidnightLedger` is wired the
   * answer comes from the chain with no edit here, rather than a later round
   * having to find every place that trusted a local number.
   *
   * The viewing key is still needed, and for one remaining reason: the amount
   * lives inside the sealed payload and OUR OWN per-role ceiling is evaluated
   * against it. That ceiling is a rule the company set over a number the
   * company owns, which is the whole of what is left of `C121`'s second half.
   */
  async approve(proposalId: string, signerId: string, signature: Hex, viewingKey: Hex): Promise<Proposal> {
    const proposal = this.requireProposal(proposalId, viewingKey);
    if (proposal.status === 'executed') throw new Error('already executed');
    /* Ours, and it says so. `R4` — the chain has no ceiling and refused nothing. */
    if (proposal.status === 'blocked') {
      throw new Error(`this company's own policy stopped this proposal here: ${proposal.blockedReason}`);
    }

    const account = this.open(proposal.accountId, viewingKey);
    const signer = account.signers.find(s => s.id === signerId);
    if (!signer) throw new Error('not a signer on this account');
    if (signer.role === 'viewer') throw new Error('viewers cannot approve');
    if (signer.status !== 'active') throw new Error('that signer has not been granted access yet');
    /*
     * **THE RECONCILE, AND ITS TRIGGER IS THE LINE BELOW.** `C377`, `T-214`,
     *
     *
     * This signer's approval is already on the record and the round still reads
     * `open`. That is the state `C377` leaves behind: the burn landed, the
     * write below it landed, and the SECOND write — the one that needed a chain
     * read — did not. Nothing else in this service can move a proposal to
     * `approved`, and the signer who would normally trigger a re-read is this
     * one, who is about to be refused.
     *
     * **SO THE REFUSAL IS WHERE THE RECOVERY GOES.** They are holding an error
     * from a call that half-succeeded, so they are the party guaranteed to come
     * back, and they are the only party left. `T-281` is in this round as the
     * example of what a recovery path with no caller is worth; this one has
     * exactly one caller and it is the line after it.
     *
     * **IT ONLY EXISTS BECAUSE OF THE REORDER BELOW.** Until the approval was
     * durable, this retry died at `ledger.approve` on a burnt nullifier
     * (`src/core/ledger.ts:1498`) and never reached a re-read at all — which is
     * why `SC10` recorded *no signer left whose approval would trigger a
     * re-read*, correctly, of the code as it then was.
     *
     * **GATED, AND THE GATE IS ASSERTED.** Not on every call: a reconcile that
     * ran unconditionally would put a second chain read into every ordinary
     * approval. `the-threshold-is-the-chain-s.test.ts`'s third case is the
     * negative control that holds the gate down.
     *
     * **AND IT DOES NOT SWALLOW A THROW.** If the chain is still unreachable
     * this rejects, and the signer is told that rather than told they have
     * already approved — which is the truthful order of the two facts.
     */
    if (proposal.status === 'open' && proposal.approvals.some(a => a.signerId === signerId)) {
      /*
       * **ONE CLASS OF FAILURE IS CAUGHT HERE AND EXACTLY ONE.** `T-286`,
       * A reconcile exists to retry something transient — a chain read
       * that did not answer. `ProposerRoleGone` is not transient: the seat is
       * deleted and no later call brings it back, so re-throwing it on every
       * call is a permanent refusal of a door that has nothing to recover.
       * **The caller is let past to the honest `already approved` below.**
       *
       * **IT SWALLOWS NOTHING ELSE.** An unreachable chain still rejects here,
       * and the signer is told that rather than told they have already
       * approved — which is the truthful order of the two facts, and the
       * property `the-threshold-is-the-chain-s.test.ts` holds down.
       */
      try {
        await this.recordStanding(proposal, account, viewingKey);
      } catch (e) {
        if (!(e instanceof ProposerRoleGone)) throw e;
      }
    }
    if (!proposal.raisedAt) await this.chainHolds(proposal, viewingKey);
    if (proposal.approvals.some(a => a.signerId === signerId)) throw new Error('already approved');

    /*
     * THREE FAILURES ARE CAUGHT HERE AND ONLY THE FIRST IS OBVIOUS.
     *
     * A key this account does not know is the easy one. The second is a known
     * key over some OTHER digest. THE THIRD IS THE ONE THIS LINE GOT WRONG
     * UNTIL `S45`: a signature over THIS digest, made for a DIFFERENT ROUND.
     * A digest is a pure function of a round's CONTENT, so a cancelled run
     * re-raised and the same run at another vault rebuild
     * it byte for byte. `approvalMessage` binds `chainId` beside it, and
     * `chainId` is where the salt and the vault are. It does NOT bind the
     * account, and `T-307` is that residual. `approval-signature.test.ts`.
     */
    if (!verify(approvalMessage(proposal), signature, signer.signingPublicKey)) {
      throw this.refuseApproval(proposal, signerId, signature, viewingKey);
    }

    /*
     * The ledger call comes BEFORE the local record.
     *
     * The chain is the thing that decides whether this approval counts — it
     * holds the nullifier set, and it is the only party that can tell us this
     * signer has already approved *this round* rather than this proposal. If it
     * refuses, nothing local should say it happened. Writing the local record
     * first and the chain second is how a UI comes to show two approvals where
     * the chain holds one.
     */
    await this.ledger.approve(proposal.accountId, proposal.chainId, this.refFor(account, signerId));

    proposal.approvals.push({ signerId, signature, at: new Date().toISOString() });

    /*
     * **THE DURABLE WRITE, THE INSTANT THE IRREVERSIBLE ONE RETURNS.** `C377`,
     * It used to be the LAST statement of this method, with a
     * second network call and four throw sites standing between it and the
     * burn above — so a rejection in that window left the approval **spent on
     * chain and absent from the record**, and the retry was refused for ever on
     * the nullifier the chain already held.
     *
     * `R6`'s rule is stated at `src/core/ledger.ts:1511` — *"an operation
     * with two halves is one transaction or it refuses"* — and the two halves
     * here are **this signature counts** and **this round now stands at N of
     * M**. There is no transaction spanning a chain and a disk, so the halves
     * are ordered by what each costs to lose: the approval cannot be recovered
     * by anybody, and the standing can be re-read from the chain by the one
     * signer who is about to come back for it.
     *
     * **NOTHING HERE NEEDS THE CHAIN READ.** Measured field by field: every
     * value `putProposal` seals — the id, the account, the digest, the chain
     * id, the key epoch, the approval count and the signatures themselves — is
     * known the moment `ledger.approve` returns. Only `approvalRound` and
     * `status` are functions of the read, and those are the second write's.
     */
    this.putProposal(proposal, viewingKey);

    /*
     * **AND THE STANDING, WHICH IS THE HALF THAT NEEDS THE CHAIN.** A throw
     * from here costs the round's recorded position and costs nothing else; the
     * reconcile above recovers it on this signer's next call. ONE definition,
     * used by both the first pass and the recovery, so the two can never come
     * to disagree about what the standing is — `M-104`'s shape, avoided.
     */
    await this.recordStanding(proposal, account, viewingKey);
    return proposal;
  }

  /**
   * **WHAT THE CHAIN SAYS THIS ROUND NOW STANDS AT, WRITTEN DOWN.** `C377`,
   * Extracted whole out of `approve`, unchanged in what it
   * does, so that the recovery path and the ordinary path are the same code.
   *
   * **ONE READ, AFTER THE LEDGER ACCEPTED THE APPROVAL, AND ONE ONLY.**
   * It is after `this.ledger.approve` because a status captured before it would
   * be missing the approval that call just made, and the round would appear one
   * short for ever. It is a single `await` whose result is reduced once by
   * `approvalsOnChain`, because two reads inside one verdict is a race that
   * leaves no trace: the count could come from one moment and the threshold
   * from another, and the pair would be arithmetic about two different chain
   * states. The reduction happens here and a VALUE is passed on;
   * `evaluatePolicy` is given no ledger and so cannot read again.
   *
   * `proposal.approvals.length` is NOT passed. It is still pushed to by
   * `approve`, because we hold the signatures, but it stopped being the number
   * that decides anything — which is the whole round.
   *
   * **REDUCED AGAINST THIS PROPOSAL'S OWN VAULT.** The bar is
   * `thresholdFor(proposal.vault)` — the vault's own number where the chain
   * holds one, the account's where it does not — and `proposal.vault` is the
   * value this round's id was computed from, so it cannot be a different
   * vault's than the one the contract will apply. **That is the PAYMENT rule
   * and it is right here; the GOVERNANCE rule is the account's threshold and
   * lives at `src/core/ledger.ts`'s `requireApproved`. The two
   * are separate on chain and separate here.**
   *
   * **RECORDED WHATEVER IT SAYS, INCLUDING WHEN IT SAYS NOTHING.** `status`
   * alone cannot carry the difference between *the chain says two of three* and
   * *the chain did not answer* — both leave it `open`. Writing the outcome down
   * is what keeps those two apart for a screen and for anybody reading the
   * record afterwards.
   *
   * **AND WHAT IT STILL DOES NOT DO, UNDER RULE 27.** It cannot be reached by
   * anything but `approve`. If the last approver never comes back, the round
   * stays `open` with two approvals the chain can see and this record cannot —
   * a smaller residual than `C377` described, and not nothing. What would close
   * it is a caller on a read or a job, and the only honest way to add one is
   * with the screen or job that calls it.
   */
  private async recordStanding(
    proposal: Proposal, account: Account, viewingKey: Hex,
  ): Promise<void> {
    const status = await this.ledger.status(proposal.accountId);
    const chain = approvalsOnChain(status, proposal.chainId, proposal.vault);

    const { asset, amount } = this.changeOf(proposal, viewingKey);
    /*
     * **THE ROLE, AND IT IS NOT A NON-NULL ASSERTION ANY MORE.** `C377`,
     * This line was
     * `account.signers.find(s => s.id === proposal.proposedBy)!` and the `!`
     * was reachable by a sequence with no failure in it: A raises a round, A is
     * removed by a properly governed round, B approves. `removeSigner` DELETES
     * the row (`signers.filter(...)`) rather than marking it, and nothing
     * closes a removed proposer's still-open rounds — so the lookup returned
     * `undefined` and `.role` threw a `TypeError`.
     *
     * **AND THE REORDER ABOVE MADE THAT PERMANENT RATHER THAN COSTLY.** By the
     * time this runs the approval is durable, so the reconcile in `approve`
     * re-enters here on B's every later call and throws the same `TypeError`
     * again: B never reaches the honest `already approved` and the round can
     * never reach `'approved'`, which is the only status this file writes.
     *
     * **THE ROUND'S OWN RECORD FIRST, THE LIVE ROSTER SECOND.** The stored
     * role is the one the ceiling was evaluated against when the round was
     * raised, which is the right question; the lookup is the fallback for
     * rounds written before `S58`, which carry no stored role.
     */
    const proposerRole = proposal.proposerRole
      ?? account.signers.find(s => s.id === proposal.proposedBy)?.role;
    /*
     * **AND WHEN NEITHER ANSWERS IT REFUSES BY NAME AND NAMES THE DOOR.**
     * Rule 19. A pre-`S58` round whose proposer has since been removed has no
     * role anywhere, and there is nothing this method can substitute: a
     * default would be inventing the authority the ceiling exists to check.
     * **`approve` treats this as the non-transient failure it is** and lets the
     * caller past to the honest answer rather than re-throwing for ever.
     */
    if (!proposerRole) throw new ProposerRoleGone(proposal.proposedBy);
    const verdict = evaluatePolicy(account, asset, amount, proposerRole, chain);

    proposal.approvalRound = verdict.approval;
    if (verdict.approval.state === 'satisfied') proposal.status = 'approved';

    this.putProposal(proposal, viewingKey);
  }

  /*
   * `applyTo` STOOD HERE AND `S52` DELETED IT. `T-226` `P3`. The only other
   * `applyTo` in the repository is an unrelated module-local function in
   * `scripts/db-setup.ts`.
   *
   * **ITS REASON FOR EXISTING WAS ONE DEFINITION** — `propose` computed the
   * outcome the signers approved with it and `execute` produced the state that
   * outcome described with it, and two derivations would have let the two
   * disagree. `C292` deleted `execute`, so it had one caller and then none.
   */


  /**
   * The asset and the amount, out of the sealed payload. Never stored in the
   * clear, and never one without the other.
   *
   * `amountOf` until today, returning a bare number — which is the shape the
   * policy engine then evaluated against a ceiling belonging to some other
   * asset. Returning the pair is what makes that impossible to write.
   */
  changeOf(p: Proposal, viewingKey: Hex): { asset: AssetId; amount: bigint } {
    const payload = this.openPayload(p, viewingKey);
    const entries: ShieldedEntry[] = (payload.entries as ShieldedEntry[]) ?? [];
    return {
      asset: this.oneAssetOf(entries, NO_ASSET),
      /* `T-205`: read back on every approve, so a stored change that could not
       * settle is refused before an approval is added to it. */
      amount: sumChangeAmount(entries.map(e => e.amount), "this proposal's change"),
    };
  }

  /**
   * THE only way a sealed payload is opened, and it exists because there were
   * two.
   *
   * A payload is written with `canonical`, which encodes bigints as
   * `{"$n":"…"}`, so a plain `JSON.parse` returns objects where amounts belong.
   * `execute` and the policy check each had their own parse; one of them being
   * fixed and the other not is the M-104 shape, and here it would surface as a
   * round that settles for `NaN`.
   */
  private openPayload(p: Proposal, viewingKey: Hex): Record<string, unknown> {
    return parseCanonical<Record<string, unknown>>(unseal(p.sealedPayload, viewingKey));
  }

  /*
   * THE ROUND HAS NO LAST STEP AT THE ACCOUNT ANY MORE.
   *
   * `execute` stood here. It read the account's balance, checked the round
   * against it, and asked the ledger to move it — every line of it was the
   * balance book, which is why it went with the book rather than being pointed
   * somewhere else. Its circuit is gone from the contract too.
   *
   * WHAT REPLACES IT DOES NOT EXIST YET, and inventing it is not this round's
   * to do. An approved run will be presented at a VAULT, which pays and calls
   * `recordPayment` on this account; `PayrollService.settle` refuses in those
   * words until that path is built. A proposal therefore reaches `approved` and
   * stops there.
   */

  /**
   * Withdraws a proposal that will not reach its threshold.
   *
   * New with M-29, and not cosmetic at the time: the contract then allowed
   * exactly one open proposal, so without a way to cancel, one bad proposal
   * wedged the account permanently. `SimulatedLedger` had no such constraint,
   * which is why nothing ever noticed the gap.
   *
   * M-128 removed the one-proposal rule, so an abandoned proposal now wedges
   * nothing. This is kept for the reason the contract's own `cancel` is: a
   * stale item should not sit in a queue looking actionable, and its row in the
   * public map should go.
   */
  async cancel(proposalId: string, viewingKey: Hex, by?: string): Promise<Proposal> {
    const proposal = this.requireProposal(proposalId, viewingKey);
    if (proposal.status === 'executed') throw new Error('already executed');
    if (proposal.status === 'cancelled') throw new Error('already cancelled');

    const account = this.open(proposal.accountId, viewingKey);
    const held = proposal.status === 'blocked' ? 'absent' : await this.chainHolds(proposal, viewingKey);
    if (held === 'unknown') throw new Error(CANNOT_ASK_THE_CHAIN);
    if (held === 'present') await this.ledger.cancel(proposal.accountId, proposal.chainId,
      this.refFor(account, by ?? proposal.proposedBy));

    proposal.status = 'cancelled';
    /*
     * The local record must not keep claiming approvals for a round that is
     * dead — nothing may be re-derived from them, and a re-proposal takes a
     * fresh salt and is a different id.
     *
     * **THE JUSTIFICATION THAT STOOD HERE WAS FALSE AND LOAD-BEARING IN ONE
     * DIRECTION.** `T-223` `P3`. It read *"rotating the round burns
     * every approval already given"*, contradicted by
     * `src/core/ledger.ts:639-642`: *"It no longer rotates a round or burns
     * anybody else's approvals — there is no round, and every other proposal
     * on the account is untouched."* Nullifiers already spent on THIS proposal
     * stay spent; nobody else's are touched. **The line below is harmless and
     * stays; the sentence was not, because a round reading it could add
     * ceremony around `cancel` that nothing requires.**
     */
    proposal.approvals = [];
    this.putProposal(proposal, viewingKey);
    return proposal;
  }

  /* ---------------- helpers ---------------- */

  /**
   * The account as we hold it: ciphertext, plus the handful of fields that are
   * public on chain or opaque by construction.
   *
   * This is what an existence check should use, and it is all `payroll` and
   * `plugins` ever wanted from it. Anything that needs a name, a signer or a
   * limit calls `open` and supplies a key.
   */
  require(accountId: string): SealedAccount {
    const a = this.store.getAccount(accountId);
    if (!a) throw new Error('account not found');
    return a;
  }

  /** The account, opened. Everything private about it comes from here or nowhere. */
  open(accountId: string, viewingKey: Hex): Account {
    return openAccount(this.require(accountId), viewingKey);
  }

  /**
   * Which viewing key is current for this account. K-4.
   *
   * Every sealed record an account owns is stamped with this, and the stamp has
   * to be the account's rather than a literal `0` at the call site — otherwise
   * an employee hired after a rotation is filed at epoch 0 while sealed under
   * the epoch-1 key, and the NEXT rotation re-seals it from the wrong key and
   * destroys it. One reader, so there is one answer.
   */
  keyEpochOf(accountId: string): number {
    return this.require(accountId).keyEpoch;
  }

  /**
   * Both halves at once, for the callers that are about to write one back.
   *
   * `save` needs the stored record — for the pending signers and the key epoch,
   * neither of which survives a round trip through the open `Account` — so
   * fetching it twice, or reconstructing it, is how those get lost.
   */
  private load(accountId: string, viewingKey: Hex): { rec: SealedAccount; account: Account } {
    const rec = this.require(accountId);
    return { rec, account: openAccount(rec, viewingKey) };
  }

  /** The one place an account is written back. */
  private save(
    rec: SealedAccount,
    account: Account,
    viewingKey: Hex,
    pendingSigners: PendingSigner[] = rec.pendingSigners,
  ): void {
    this.store.putAccount(sealAccount(account, viewingKey, pendingSigners, rec.keyEpoch));
  }

  /* ---------------- sealing proposals ---------------- */

  /*
   * Proposals seal under `proposals`, not `policy`.
   *
   * They were under `policy` until M-96, which quietly undid the separation the
   * subkeys exist for: `k_policy` is the subkey you would delegate to an
   * accounting plug-in that needs the spending rules, and it was also opening
   * every proposal — summaries naming people and amounts, and the per-signer
   * approval list that is the deanonymised form of the chain's nullifiers.
   */
  private putProposal(proposal: Proposal, viewingKey: Hex): void {
    const approvalCount = proposal.approvals.length;
    const { id, accountId, status, createdAt, executedAt, digest, txRef, chainId, ...secrets } = proposal;
    this.store.putProposal({
      id, accountId, status, createdAt, executedAt, digest, txRef, chainId, approvalCount,
      keyEpoch: this.keyEpochOf(accountId),
      sealed: sealRecord('proposals', accountId, secrets, viewingKey),
    });
  }

  private openProposal(r: SealedProposal, viewingKey: Hex): Proposal {
    const { sealed, keyEpoch, approvalCount, ...open } = r;
    return { ...open, ...openRecord<Omit<Proposal,
      'id' | 'accountId' | 'status' | 'createdAt' | 'executedAt' | 'digest' | 'txRef' | 'chainId'>>(
        'proposals', r.accountId, sealed, viewingKey) };
  }

  /**
   * The approved proposal that authorises a specific governance action.
   *
   * With several proposals open at once the contract has to be told WHICH one a
   * removal or a threshold change is spending, and the honest source for that is
   * our own record of the round that was raised for it — matched on `digest`,
   * which is the domain-separated payload the chain committed to. Matching on
   * anything looser would let an approved addition authorise a removal, which is
   * the hole the domain separators exist to close.
   */
  private approvedFor(accountId: string, viewingKey: Hex, digest: Hex): Proposal {
    const found = this.listProposals(accountId, viewingKey)
      .filter(p => p.digest === digest)
      .filter(p => p.status === 'approved' || p.status === 'open');
    if (found.length === 0) {
      throw new Error(
        'there is no open proposal on this account for that change. Propose it and gather ' +
          'approvals first — governance is an approval round like any spend.',
      );
    }
    /*
     * **APPROVED BEFORE OPEN, CONFIRMED BEFORE UNCONFIRMED, THEN NEWEST.**
     * `S55`, found by this round's money-safety pass against `C378`'s fix.
     * The line here said *newest first: a re-proposal after a failed attempt is
     * the live one*, and that was true BECAUSE A FAILED ATTEMPT LEFT NO RECORD.
     * `C378` inverts the premise — a round the chain never held is now a durable
     * `open` record with a later `createdAt` — and a governance digest is a pure
     * function of the change, so it collides with the genuinely APPROVED round
     * for the same change and would win. **Rule 37's shape: a change made a
     * sentence somewhere else false, and that sentence would never have been
     * re-read.**
     *
     * **AND IT POINTS FOUR CALLERS, NOT ONE. `T-332`.** This paragraph
     * named `removeSigner` alone; the build log named it with `setThreshold`;
     * the mutation corpus named it alone again. **The callers are
     * `grantAccess`, `setThreshold`, `setVaultThreshold` and `removeSigner`,
     * and every one of them is order-dependent** — each takes the `chainId` of
     * whatever this sort puts first, and each digest has exactly one builder
     * taking only the change, so a collision is reachable on all four.
     *
     * **THE THREE DESCRIPTIONS AGREED ON THE WRONG SUBSET FOR A READABLE
     * REASON, AND IT IS THE OPPOSITE OF THE ONE A READER WOULD GUESS:**
     * `setThreshold` and `removeSigner` are the two with NO product route
     * today, so they were named as *the recovery path*, and the two that a
     * screen can actually reach — `grantAccess` (`src/server/index.ts`, and the
     * standalone client) and `setVaultThreshold` — went unnamed. **The
     * reachable callers were the ones left out of the description of the
     * hazard.** `grantAccess` is the only one with two entry points.
     */
    return found.sort((a, b) =>
      (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1)
      || (a.raisedAt ? 0 : 1) - (b.raisedAt ? 0 : 1)
      || b.createdAt.localeCompare(a.createdAt))[0];
  }

  requireProposal(id: string, viewingKey: Hex): Proposal {
    const p = this.store.getProposal(id);
    if (!p) throw new Error('proposal not found');
    return this.openProposal(p, viewingKey);
  }

  /** Proposals for an account, opened. Sorting and filtering happen here, not in the store. */
  listProposals(accountId: string, viewingKey: Hex): Proposal[] {
    return this.store.listProposals(accountId).map(p => this.openProposal(p, viewingKey));
  }

  /**
   * **WRITES THE REFUSAL DOWN, THEN HANDS BACK THE ERROR TO THROW.** `C398`,
   * Called from exactly one place — the `verify` in `approve`
   * — and it returns rather than throws so that call site stays three lines
   * and nothing in this file moves.
   *
   * ── WHY A RECORD AND NOT A CLOSED ROUTE ──────────────────────────────────
   *
   * `S45` made a replayed signature FAIL. `C398` is that the failure leaves no
   * trace: the bytes are read in exactly one place (the `verify` above), every
   * other read of `.approvals` takes `signerId` or `.length`, and a refused
   * attempt reaches no durable record at all. **The refusal log
   * (`src/server/refusal-log.ts`) already carries the 400** — method, path,
   * `Error`, and the sentence — **and that is not the same thing**: it is a
   * convenience file that swallows its own write errors by design, it lives
   * outside the sealed record, and its line is byte-identical for a replay, a
   * typo and a stale client. It says a request was refused. It cannot say
   * WHICH ROUND the bytes belonged to.
   *
   * **AND THE OTHER ANSWER — MAKE THE ROUTE UNAVAILABLE — WAS MEASURED AND
   * REFUSED, NOT PREFERRED.** `POST /api/proposals/:id/approve` takes
   * `signerId` from the request body (`src/server/index.ts:809-813`) behind
   * `ownsProposal`, which checks account MEMBERSHIP and not identity. Binding
   * that `signerId` to the session's own seat looks obvious and is not
   * available: **`POST /api/accounts` seats the creator at index 0 and gives
   * every other seat `userId: null` (`src/server/index.ts:766`)**, a seat with
   * no `userId` is not in `memberUserIds` (`account.ts:504`) and so can never call this
   * route itself, and `create` hands the creator every seat's `signingSecret`
   * (`:714`, returned at `:799`). **So the body-supplied `signerId` is the only way a freshly
   * created 2-of-3 account reaches its own threshold**, and the binding would
   * refuse the ordinary case rather than an abuse.
   *
   * **THE DISTINCTION THE ROW MUST NOT BE READ WITHOUT.** An outsider cannot
   * reach this at all: they need a session, membership, and the account's
   * viewing key. A MEMBER can submit another seat's bytes — but after `S45`
   * those bytes are round-specific, so what a member can relay is a genuine
   * consent that signer gave to THIS round. **The route lets a member choose
   * the moment; it does not let anyone manufacture the consent.**
   *
   * ── WHAT IT COSTS, PRICED BEFORE IT WAS BUILT ────────────────────────────
   *
   * **No new store and no new secret.** The entry is `{signerId, at,
   * replayOf?}` and holds no signature bytes; `putProposal` seals everything it
   * does not name, so it sits under the account viewing key beside the
   * approvals themselves. **The comparison below opens this account's other
   * proposals** — which is what `approvedFor` already does — **and it happens
   * ONLY on the failure path**, so an ordinary approval pays nothing for it.
   * A refused attempt costs one durable write, the same order as an accepted
   * one, and `recent` is capped at `REFUSED_APPROVALS_KEPT` so a member who
   * posts rubbish grows a bounded list. **IT SAID *grows a counter and not a
   * file* UNTIL `S58`, AND THE COUNTER DOES NOT GROW EITHER** — the increment
   * has always sat past the cap's return, so `count` freezes with the list.
   * `T-335`(3), and it is the same false sentence `S58` corrected in
   * `src/core/types.ts`, left standing here until this round's auditor found
   * it.
   *
   * **AND IT FAILS CLOSED.** No path through here accepts a signature that did
   * not verify: the refusal is the return value on every branch. Below the cap
   * the record is written before the error is returned, and if that write
   * throws, the write's error propagates instead — the approval is still
   * refused. **PAST THE CAP THERE IS NO WRITE AT ALL**, which `S58` made true
   * and this paragraph asserted the opposite of; what is returned there names
   * the replay and says the attempt was not recorded.
   */
  /**
   * **THE DURABLE RECORD FIRST, THEN THE IRREVERSIBLE CALL.** `C378`, `T-228`,
   * Every propose door in this class goes through here.
   *
   * ── WHY THIS IS NOT `S52`'s REORDER, ARGUED RATHER THAN COPIED ───────────
   *
   * `C377` was *the burn, then several things that can throw, then the only
   * durable write*, and `S52` fixed it in `approve` by moving the write up
   * against the burn and adding a reconcile. **Neither half of that transfers,
   * and the round that copies it has fixed nothing.**
   *
   * **THE REORDER IS A NO-OP HERE.** Measured, all five doors: the durable
   * write is already the statement immediately after the chain call, with
   * nothing between them to move. The whole `Proposal` — id, chainId, vault,
   * digest, sealed payload, status — is computed BEFORE the call and no field
   * of it is a function of the answer.
   *
   * **AND `S52`'s RECONCILE HAS NO TRIGGER HERE.** Its argument was that *the
   * signer holding the error is the party guaranteed to come back*: their
   * nullifier is burnt, so no other call of theirs can succeed until the record
   * catches up. **A proposer who lost the write may not come back at all** — a
   * proposal is a thing you raise, not a thing you are owed — and if they do,
   * `newProposalSalt()` mints 32 fresh bytes, so the retry is a DIFFERENT id
   * and nothing refuses it: two rounds over one change, two fees, approvals
   * split across two ids so neither may reach threshold, and the first orphaned.
   * That is `C378`'s own measured consequence and a reconcile does not touch it.
   *
   * ── SO THE HALVES ARE ORDERED BY WHAT EACH COSTS TO LOSE, WHICH IS `S52`'s
   * OWN PRINCIPLE ARRIVING AT THE OPPOSITE ORDER ──────────────────────────
   *
   * The chain round can be raised again, for a fee. **The record cannot be
   * rebuilt by anybody**: the salt is fresh randomness held only in this call
   * frame and the payload is sealed under a key that arrived as an argument.
   * So the record goes first, and what can be lost is the CONFIRMATION — which
   * the chain can be asked for, by anyone, at any time. `confirmRaised` below.
   *
   * **THE INVERSION IS THE POINT: EVERY FAILURE NOW LEAVES SOMETHING VISIBLE.**
   * The first write throws — nothing on chain, no fee, and `C36`'s rollback
   * means nothing changed. The chain call throws — a record the product can
   * list and cancel, with `raisedAt` unset saying the chain has not confirmed
   * it. The second write throws — the same, and the round is live. **There is
   * no longer a state in which a paid-for round exists and this product has no
   * record of it at all.**
   *
   * ── DOES IT INHERIT `T-287`'s RESIDUAL? NO, AND IT IS THE INVERSE ────────
   *
   * `T-287` case one is *the FIRST durable write throws, so the approval is
   * burnt and absent, and the reconcile's own gate needs the write that
   * failed*. Here a first-write failure spends nothing and leaves nothing to
   * recover, and the recovery gate is `raisedAt`, which is what the SUCCESSFUL
   * path sets — not what the failed one would have. `T-287` case two, the last
   * approver who never comes back, has no analogue: nothing is pending.
   *
   * **ITS OWN RESIDUAL, NAMED (rule 27):** a record whose confirmation was lost
   * and which nobody ever approves or cancels stays unconfirmed for ever. It
   * costs a row and a person's second look, not money, and what would close it
   * is the same ungated read path `T-287` wants. **AND THE OUTER WINDOW IN
   * `PayrollService.proposeRun` IS NOT CLOSED BY THIS** — `putRun` still writes
   * after `accounts.proposeRun` returns, so a lost run write still re-raises on
   * a fresh salt. Its guard has to read something the chain can confirm, and
   * the run material that would let it does not exist (`T-238`, not this
   * round's). `BACKLOG.md` `T-322`.
   */
  private async raise(
    proposal: Proposal, viewingKey: Hex, call: () => Promise<{ ref: string; at: string }>,
  ): Promise<void> {
    this.putProposal(proposal, viewingKey);
    const tx = await call();
    proposal.txRef = tx.ref;
    proposal.raisedAt = tx.at;
    this.putProposal(proposal, viewingKey);
  }

  /**
   * **ASKS THE CHAIN WHETHER A ROUND THIS SERVICE WROTE DOWN IS ACTUALLY
   * THERE.** The recovery half of `raise`, and the reason the
   * write may safely go first.
   *
   * **IT HAS TWO CALLERS AND BOTH ARE GUARANTEED, WHICH IS THE TEST `T-281`
   * SET AND `S52` APPLIED.** Anybody who intends to USE an unconfirmed round
   * calls `approve` or `cancel` on it, and those are the only two things that
   * can be done with one — so unlike the proposer's retry, this trigger cannot
   * fail to arrive for any round that matters.
   *
   * **GATED ON `raisedAt` BEING ABSENT**, so an ordinary approval pays nothing:
   * a confirmed round never reaches here. **AND IT DOES NOT SWALLOW A THROW** —
   * an unreachable chain rejects, and the caller is told that rather than told
   * their round is not on chain, which is `R4`'s distinction and the one
   * `recordStanding` already makes.
   *
   * What it cannot see: a round that WAS raised and has since been closed, so
   * it is no longer in `openProposals`. That state is unreachable from here —
   * `approve` and `cancel` both refuse an executed or cancelled record first.
   */
  private async chainHolds(
    proposal: Proposal, viewingKey: Hex,
  ): Promise<'present' | 'absent' | 'unknown'> {
    if (proposal.raisedAt) return 'present';
    const status = await this.ledger.status(proposal.accountId);
    /*
     * **`null` IS *COULD NOT ASK*, NOT *NOT THERE*, AND CONFLATING THEM WAS A
     * `P1` THIS ROUND'S AUDITOR CAUGHT BEFORE IT SHIPPED.**
     * `SimulatedLedger.status` answers `null` for an account it does not hold —
     * which after a restart is EVERY account, and `SIMULATED` is the shipped
     * wiring — and `MidnightLedger.status` answers `null` when the address is
     * unknown or the indexer returns nothing. Read as absence, that let `cancel`
     * close a record locally, clear its approvals, and leave the chain holding
     * an approved round nobody could see had been withdrawn.
     */
    if (status === null) return 'unknown';
    if (!status.openProposals.some(p => p.id === proposal.chainId)) return 'absent';
    /*
     * **RE-READ BEFORE WRITING, BECAUSE THE CHAIN READ ABOVE IS AN `await`.**
     * `T-297`'s shape: `putProposal` is a whole-record overwrite with no version
     * check, so writing the object this method was handed would put back
     * whatever it held before the read — including an `approvals` array another
     * request has since added a chain-burnt approval to.
     */
    const fresh = this.requireProposal(proposal.id, viewingKey);
    fresh.raisedAt = new Date().toISOString();
    this.putProposal(fresh, viewingKey);
    proposal.raisedAt = fresh.raisedAt;
    return 'present';
  }

  private refuseApproval(
    proposal: Proposal, signerId: string, signature: Hex, viewingKey: Hex,
  ): Error {
    const mismatch = 'signature does not match the registered signing key for this proposal';

    /*
     * **RE-READ FIRST, AND EVERYTHING BELOW READS THE RE-READ.** `T-297`'s
     * shape, `T-335`(4). `approve` took `proposal` at its first line and then
     * `await`ed twice — the `C377` reconcile and `chainHolds` — so by the time
     * this runs a concurrent, VALID approval may have added a chain-burnt
     * signature to `approvals`. `putProposal` is a whole-record overwrite with
     * no version check, so writing the object this method was handed would put
     * that approval back to what it was: `C377`'s harm, caused by a request
     * carrying no valid signature at all.
     *
     * **THE CAP GUARD BELOW USED TO READ THE ARGUMENT INSTEAD**, which is the
     * same stale value one line above the fix that named the shape. It reads
     * `before` now, and `before` comes from here.
     */
    const fresh = this.requireProposal(proposal.id, viewingKey);
    const before = fresh.refusedApprovals ?? { count: 0, recent: [] };

    /*
     * **THE COMPARISON THAT IS THE PROOF — AND IT RUNS BEFORE THE CAP. THE
     * ORDER IS THE SECURITY-RELEVANT PART OF THIS METHOD AND MUST NOT BE
     * SWAPPED BACK.** `C398`, `T-335`(2).
     *
     * ed25519 is deterministic, so one signature standing on two rounds of one
     * account is not evidence of a replay, it IS one. Matched against every
     * OTHER round of this account, not against this one — a signature already
     * on this round is the `already approved` case above and never reaches
     * here.
     *
     * **WHY THE ORDER IS THE SECURITY-RELEVANT ONE.** The cap used to return
     * before this line, which put the detector behind a switch held by the
     * party it detects: **a member who wanted a replay to go unrecorded spent
     * twenty invalid signatures against the round first, and from the
     * twenty-first attempt onward every replay got the bare `mismatch`
     * sentence with no `replayOf` — silent for exactly the round `C398` was
     * built for.** A false negative inside the detector, and nothing said so.
     *
     * **AND NOTHING ABOUT THE CAP REQUIRED IT.** The cap is a WRITE bound
     * (below); this is a READ of proposals already open on this account and
     * costs no durable write, so it can run on every attempt while the write
     * stays bounded. What it costs instead is CPU on an `authed`, membership-
     * gated route with no meter — stated rather than assumed. **AND THE COST IS
     * NOT CONSTANT: `listProposals` opens every proposal this account has ever
     * had, and nothing deletes one, so it grows for the life of the account.**
     * Before this round an attempt past the cap cost nothing at all. Metering
     * this route is `T-323`'s, and until it lands `T-335` cannot close on its
     * fifth limb — said here rather than pointed back at `T-335`, which is a
     * circle. Found by this round's money-safety pass, `F5`.
     */
    const replayOf = this.listProposals(proposal.accountId, viewingKey)
      .filter(p => p.id !== proposal.id)
      .find(p => p.approvals.some(a => a.signature === signature))?.chainId;

    /* The verdict, once. Both returns below carry it — that is the point of the order. */
    const replay = replayOf
      ? '. This signature is the one already recorded against round ' + replayOf
        + ' on this account, so it is a replay'
      : '';

    /*
     * **THE CAP IS A WRITE BOUND AND NOT ONLY A SIZE BOUND.** This route
     * is `authed` and `ownsProposal` — membership, no rate limiter — and an
     * INVALID signature costs nothing to make, so without this line one member
     * could make the deployment re-serialise and rewrite the whole store once
     * per request (`store.ts` `putProposal` -> `FileStore.flush`, `C36`'s own
     * blast radius). An ACCEPTED approval is self-limiting because it burns a
     * nullifier; a refused one is not. **So a round RECORDS its first
     * `REFUSED_APPROVALS_KEPT` attempts and no more.**
     *
     * **AND WHEN IT STOPS RECORDING IT SAYS SO, WHICH IS THE OTHER HALF OF
     * `T-335`.** A full list read by someone who was not told it is full reads
     * as a complete one. The detector above has already run and its verdict is
     * in the sentence returned either way; what stops at the cap is the
     * DURABLE entry, and the sentence names that. Every attempt past the cap
     * still reaches `logs/REPORT-REFUSALS.txt`, whose unboundedness is stated
     * and accepted (`src/server/refusal-log.ts`) and is `T-323`'s.
     *
     * **`count` IS CAPPED WITH THE LIST, AND THE TYPE NOW SAYS SO.** The
     * increment below is past this return, so `count` freezes at
     * `REFUSED_APPROVALS_KEPT`. It has always meant *recorded*, never *made*;
     * `src/core/types.ts` said the opposite until `S58` and
     * `docs/corrections.md` carries that.
     */
    if (before.recent.length >= REFUSED_APPROVALS_KEPT) {
      return new Error(
        mismatch + replay
        + '. This round has already recorded ' + REFUSED_APPROVALS_KEPT
        + ' refused attempts, which is the most it keeps, so this attempt was NOT added to '
        + 'that record. It is in the refusal log.',
      );
    }

    fresh.refusedApprovals = {
      count: before.count + 1,
      recent: [...before.recent, { signerId, at: new Date().toISOString(), replayOf }]
        .slice(-REFUSED_APPROVALS_KEPT),
    };
    this.putProposal(fresh, viewingKey);
    proposal.refusedApprovals = fresh.refusedApprovals;

    return new Error(
      mismatch + replay + (replayOf ? ' and the attempt has been recorded here.' : ''),
    );
  }
}

/**
 * **THE ROUND'S PROPOSER IS NOT ON THIS ACCOUNT ANY MORE, SO ITS POLICY
 * STANDING CANNOT BE RECOMPUTED.**
 *
 * **A NAMED CLASS RATHER THAN A SENTENCE, BECAUSE ONE CALLER HAS TO TELL IT
 * APART FROM EVERY OTHER FAILURE.** `approve`'s reconcile retries what is
 * transient. This is not: the seat was deleted by a governed round and no
 * later call brings it back. Matching on a message would make the reconcile's
 * behaviour depend on wording, which is how a catch comes to swallow the
 * chain-unreachable case it must never swallow.
 *
 * **REACHABLE ONLY ON A ROUND RAISED BEFORE THE ROLE WAS RECORDED**, which
 * from `S58` is every round: all SIX propose doors write `proposerRole`.
 * **THIS PARAGRAPH SAID *from this round* WHILE ONLY TWO DOORS WROTE IT, AND
 * THIS ROUND'S OWN money-safety pass CAUGHT IT.** `F1`. `propose` and
 * `proposeRun` were covered; `proposeSigner`, `proposeThresholdChange`,
 * `proposeVaultThresholdChange` and `proposeRemoval` were not — the four
 * GOVERNANCE doors, which is where a proposer being removed is most ordinary.
 * They record it now.
 *
 * Records written before `S58` carry no role, are sealed, and are not
 * backfilled — a migration that guessed one would be writing exactly the value
 * this refusal exists to avoid inventing.
 *
 * **RULE 19 — IT NAMES THE DOOR.** There is no field to set and no retry that
 * helps: the round keeps its approvals and its signatures, and what it cannot
 * do is move to `'approved'`, because that status is a function of a ceiling
 * evaluated against an authority nobody can now establish. `BACKLOG.md`
 *
 */
export class ProposerRoleGone extends Error {
  constructor(readonly proposedBy: string) {
    super(
      'the signer who raised this round is no longer on this account, and this round was '
      + 'raised before the role was recorded on it, so the ceiling it was judged against '
      + 'cannot be established. The approvals already given are unaffected and remain on the '
      + "record; what cannot be recomputed is the round's policy standing. Raise the round "
      + 'again through the same door to get one that carries its own role.',
    );
    this.name = 'ProposerRoleGone';
  }
}

/**
 * **WHAT A SIGNER'S APPROVAL SIGNATURE IS ACTUALLY OVER.** `C382`, `C397`,
 * One definition, because a producer and a verifier that each spell it
 * out are two places that must agree — `M-104`'s shape on the approve path.
 *
 * **IT WAS `proposal.digest` ALONE UNTIL THIS ROUND, AND THAT IS THE DEFECT.**
 * A digest is a pure function of what a round SAYS: `runPayload(root, payees,
 * opensAt, closesAt)` for a run (`:2410-2411`), and the four governance
 * payloads before it. **Nothing in it says WHICH round it is or WHO WILL PAY.**
 * Two consequences, filed as two rows because the injuries are different:
 *
 *   - **`C382`** — a cancelled run re-raised rebuilds the same digest, because
 *     payee nonces are seed-derived (`B13`), so a signature a signer took back
 *     by cancelling verifies against the new round.
 *   - **`C397`** — the same people, amounts and window at ANOTHER VAULT rebuild
 *     the same digest too, so an approval given to pay from one vault
 *     authorises payment from another.
 *
 * **`chainId` IS WHERE BOTH MISSING FACTS ALREADY LIVE, AND THEY WERE ALREADY
 * ON THIS RECORD.** It is `proposalIdOf(payloadHash, vault, salt)` — the
 * contract's own derivation (`contracts/src/ConfidentialAccount.compact:874-881`),
 * recomputed by `recordPayment` at `:2671-2675` and by every governance
 * circuit. The salt is 32 fresh random bytes per propose call
 * (`newProposalSalt`, `src/core/crypto.ts:160-171`), so a re-raise is a
 * different id; the vault is folded in beside it, so another vault is a
 * different id. **The chain was never fooled — `compact:2416-2418` says so in
 * `cancel`'s own words. The gap was entirely in what the human signed.**
 *
 * **SO THIS IS A CLIENT CHANGE AND NOT A CONTRACT ONE.** The contract holds no
 * signature scheme at all: an on-chain approval is a nullifier over a witness
 * secret (`compact:916-920`) and `Ledger.approve` takes no signature
 * (`src/core/ledger.ts:721`). This value never reaches any chain.
 *
 * **WHAT IT STILL DOES NOT BIND, SAID HERE RATHER THAN LEFT TO BE FOUND —
 * RULE 27.** No payload and no id binds the ACCOUNT. `chainId` is
 * `proposalIdOf(...)` and takes no account address, and the simulated
 * governance payloads are global constants per argument
 * (`src/core/ledger.ts:924-925` is `sha256('midnight-accounts:set-threshold:' +
 * n)`). The contract closed this same hazard deliberately on its own side —
 * `approvalNullifier` folds `kernel.self()` (`compact:903-914`) — and this
 * value does not. **What stops it today is that the reference client mints a
 * fresh signing key per seat (`src/web/App.tsx:2321`), which is a habit of one
 * client and not a rule of the system. `T-307`.**
 *
 * **THE VERSION TAG IS NOT DECORATION.** A signature made under the old
 * spelling must not verify under this one, and a domain tag is how that is
 * stated rather than assumed. Nothing is stranded by it: an approval signature
 * is verified exactly once, at submit (`:2588`), and is never re-verified from
 * storage — so there is no corpus to migrate.
 */
export function approvalMessage(proposal: { digest: Hex; chainId: Hex }): string {
  return `midnight-accounts:approval:v2:${proposal.digest}:${proposal.chainId}`;
}

/**
 * **HOW MANY REFUSED APPROVAL ATTEMPTS ONE ROUND RECORDS.** `C398`, `S55`,
 * It bounds the list AND the counter: `refuseApproval` returns
 * at this number without writing, so `count` freezes here with `recent`. **It
 * said `count` is not capped until `S58` and that was false at source** — the
 * increment has always sat past the guard.
 *
 * **WHAT A MEMBER WHO POSTS RUBBISH AT A ROUND COSTS IS THEREFORE BOUNDED IN
 * BOTH FIELDS**, and the refusal past this number says so in its own sentence
 * rather than letting a full list read as a complete one.
 *
 * **DECLARED HERE RATHER THAN BESIDE THE TYPE IT BOUNDS**, which is not where
 * it belongs and is where `C366` puts it: `src/core/types.ts` carries the
 * shape, and importing a VALUE from it would need a second import statement at
 * the top of this file, moving every one of the forty-odd `file:line`
 * citations into it. This file's own citations end above the class.
 */
export const REFUSED_APPROVALS_KEPT = 20;

/**
 * **WHAT `cancel` SAYS WHEN THE LEDGER WOULD NOT ANSWER.** `C378`, `S55`,
 * rule 19 — it names the DOOR, not a field to set.
 *
 * A round whose chain confirmation was never recorded cannot be withdrawn on a
 * guess. Cancelling locally would clear the approvals (`cancel`, below the
 * ledger call) while the chain went on holding the round, open and approved, so
 * a signer who withdrew would have no record that they had.
 */
const CANNOT_ASK_THE_CHAIN =
  'this round has no record of being accepted on chain and the ledger did not answer, so '
  + 'cancelling it here could clear approvals the chain still holds. Read the account\'s '
  + 'ledger status (GET /api/accounts/:id/ledger) and try again once it answers.';

/**
 * **THE VAULT A GOVERNANCE ROUND MAY NAME, WHICH IS EXACTLY ONE VALUE.**
 *
 *
 * `AccountService.propose` raises through `Ledger.propose`, which is the
 * contract's OPAQUE branch, and that branch asserts `vault == noVault()`
 * (`contracts/src/ConfidentialAccount.compact:2319`). So there is no vault to
 * choose: absence and the sentinel are the same round, and any other value is a
 * round no circuit in the account can ever consume.
 *
 * **THIS IS THE CLIENT MIRROR `C367` HAS BEEN ASKING FOR SINCE 2 Sep**, and the
 * shape is `proposeRun`'s: refuse before a fee and before anybody signs, rather
 * than let the chain refuse after both. **The vault-carrying door is
 * `AccountService.proposeRun`, which requires a REAL vault and refuses the
 * sentinel** — the mirror image of this one door along, because a run's id is
 * recomputed by the vault that presents it.
 *
 * **A FUNCTION RATHER THAN TWO LINES AT THE CALL SITE, FOR ONE REASON:
 * `C366`.** The call site stays one line, so nothing in this file moves.
 */
export function governanceVault(named: Hex | undefined, noVault: Hex): Hex {
  if (named !== undefined && named !== noVault) {
    throw new Error(
      'a governance round cannot name a vault. The contract asserts vault == '
      + 'noVault() on this branch (ConfidentialAccount.compact:2319), every governance circuit '
      + "recomputes the id with noVault(), and the only circuit that reads a vault's own "
      + 'threshold is recordPayment, which needs a run payload — so a round raised this way '
      + 'collects approvals and is spendable by nothing. Raise it through proposeRun, which is '
      + 'the door that names a vault.',
    );
  }
  return noVault;
}
