/**
 * **THE COMPANY'S OWN CEILINGS ON WHAT ONE ROLE MAY RAISE**, applied where a
 * round is raised: on the signer's device that raises it, and by the service's
 * own code for the rounds it still writes down.
 */
import type { AssetId, AssetRegistry } from './assets.js';
import { assets as defaultAssets, symbolOf } from './assets.js';
import type { Account, Role } from './types.js';
import type { ChainApprovals, PolicyVerdict } from './account.js';

/**
 * **WHAT THIS SERVICE MAY STILL DECIDE, WHICH IS ONE THING.**
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
  /** The registry the limit's token is named from in a refusal. */
  registry: AssetRegistry = defaultAssets,
): PolicyVerdict {
  const p = account.policy;
  const limit = p.limitsByRole[proposerRole]?.[asset];

  /*
   * **A PAIRING GUARD STOOD HERE AND IT COULD NOT FIRE.**
   * It threw when `chain.vault !== vault`, and both sides were the same
   * expression — `approvalsOnChain` echoed its own argument back, and the one
   * call site that reaches the `read` arm passed `proposal.vault` to both. The
   * paragraph that stood with it claimed that a reduction taken against a
   * different vault was refused below, and that the refusal was worth having
   * because the failure it catches is invisible without it; nothing was
   * behind it.
   *
   * **GUARD AND CLAIM REMOVED TOGETHER.** Where the pairing is actually
   * enforced is written on `ChainApprovals` above: at the door that writes the
   * record, not at the end that reads it. **The interaction matters and is why
   * this is not merely tidying:** had the guard ever been made real it would
   * have thrown at this line — AFTER `ledger.approve` has landed — so every
   * time it fired it would have reported a failure against an approval the
   * chain had already accepted.
   */

  if (limit?.perTransaction != null && amount > limit.perTransaction) {
    return {
      blocked: true,
      /*
       * IT SAYS WHOSE RULE IT IS.
       *
       * The contract has no ceiling and never sees this number. A refusal
       * phrased as though the chain had refused is a promise this product is
       * not keeping: the device raising a run and every device approving it
       * check the ceiling, and a signer who builds a call some other way is
       * stopped by nothing on the chain. Nor does it say who applied it, since
       * more than one place does.
       */
      reason:
        `this company's own policy, which the chain does not apply: ` +
        `${amount} exceeds the per-transaction ${symbolOf(asset, registry)} limit for role "${proposerRole}" ` +
        `(${limit.perTransaction}). The proposal was not sent to the chain.`,
      /*
       * A blocked proposal is never submitted, so there is no round on chain to
       * ask about. That is not "nobody has approved it": it does not exist.
       */
      approval: { state: 'unknown', why: 'not-yet-proposed' },
    };
  }

  /*
   * **THE ESCALATION FIGURE IS GONE FROM THE TYPE AS WELL AS FROM HERE.** An
   * earlier change deleted the evaluation and kept the field; the field is now
   * gone too, and the argument is in `Policy`'s own comment in `core/types.ts`,
   * with the short form immediately below.
   *
   * The short of it: the one meaning on offer was *"above this amount use the
   * account's threshold rather than the vault's lower one"*, and NOTHING ON
   * CHAIN WOULD ENFORCE IT. `thresholdFor` is amount-blind. Applying it here
   * would make this service tell a company that a large payment needs more
   * approvals than the contract will actually require — and that is the
   * dangerous direction, because it claims safety that does not exist rather
   * than merely failing to add any.
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
