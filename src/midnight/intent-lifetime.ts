/**
 * **HOW LONG A TRANSACTION THIS APPLICATION BUILDS MAY WAIT TO LAND, AND HOW
 * MUCH OF THAT IT MUST STILL HAVE LEFT WHEN IT IS SENT.**
 *
 * Every transaction here carries one intent, and the intent carries a time to
 * live that the builder stamps from its own clock: `INTENT_LIFETIME_MS` after
 * the moment it is built. The node refuses a transaction whose time to live has
 * passed, with `Invalid Transaction: Custom error: 228`
 * (`TransactionApplicationError::IntentTtlExpired`; the check is
 * `if intent.ttl < tblock` in `midnight-ledger/ledger/src/verify.rs`,
 * `ttl_check_weak`). Nothing about a built transaction changes as it waits, so a
 * creation built at the first press and sent at the second, hours later, is a
 * transaction that can never land.
 *
 * **A TRANSACTION IS NEVER SENT WITH LESS THAN `A_STEP_NEEDS_LEFT_MS` OF ITS
 * LIFE LEFT.** The margin is the time a send can spend in the service's
 * one-at-a-time lane and in the fee payer's wallet catching up with the chain
 * before the node sees it, with room for a clock that is a little behind the
 * node's. Three lines, each a little further out than the one inside it, so
 * that two clocks a minute or two apart never meet a refusal:
 *
 *   - the service refuses to record or send below `A_STEP_NEEDS_LEFT_MS`;
 *   - the device builds a step again below `A_STEP_IS_BUILT_AGAIN_BELOW_MS`,
 *     before it asks the service to send it;
 *   - the service lets a recorded step be replaced by one built again below
 *     `A_STEP_MAY_BE_REPLACED_BELOW_MS`.
 *
 * Building a step again needs no new press of the wallet: the founding
 * signer's signature covers the account's address, the update and the
 * counter, and not the intent's time to live
 * (`midnight-ledger/ledger/src/structure.rs`, `MaintenanceUpdateSigningEnvelope`).
 */
export const INTENT_LIFETIME_MS = 30 * 60_000;

/** The life a built transaction must still have to be sent at all: half of what it was built with. */
export const A_STEP_NEEDS_LEFT_MS = 15 * 60_000;

/** Below this much life left, the device builds a step again before sending it. */
export const A_STEP_IS_BUILT_AGAIN_BELOW_MS = A_STEP_NEEDS_LEFT_MS + 2 * 60_000;

/** Below this much life left, the service lets a recorded step be replaced by one built again. */
export const A_STEP_MAY_BE_REPLACED_BELOW_MS = A_STEP_IS_BUILT_AGAIN_BELOW_MS + 2 * 60_000;

/**
 * Whether a transaction built at `builtAt` (epoch ms, taken before it was built, so never later than its own stamp)
 * is to be built again at `now`. A transaction whose build time is not known is: building it again costs a little
 * time, and sending one that ran out costs the whole creation.
 */
export function aStepIsShortOfLife(builtAt: number | undefined, now: number): boolean {
  return builtAt === undefined || !Number.isFinite(builtAt) || now + A_STEP_IS_BUILT_AGAIN_BELOW_MS > builtAt + INTENT_LIFETIME_MS;
}
