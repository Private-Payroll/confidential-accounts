/**
 * THE WINDOW A SECRET RUN IS RAISED WITH. Plain numbers only: the page's own
 * raise reads it, so it loads no contract and nothing of the Midnight SDK.
 */
import { RAISE_WINDOW_SECONDS } from '../core/proposal-filing.js';

/** How long a secret run raised now stays open for its approvals, in seconds. */
export const SECRET_RUN_OPEN_FOR = 14n * 24n * 3_600n;
/** How far before now a secret run's window opens, so a block a little behind this device's clock is inside it. */
export const SECRET_RUN_OPENS_BEFORE = 600n;

/**
 * The window a secret run raised at `now` (seconds) is given: open from just before now, for `SECRET_RUN_OPEN_FOR` when
 * it sets a vault's first secret, and only for the day a raise is given to land in (`RAISE_WINDOW_SECONDS`) when it
 * replaces one, so a replacement nobody carries runs out soon and is raised again.
 */
export const secretRunWindowFrom = (now: bigint, replacing = false): { opensAt: bigint; closesAt: bigint } =>
  ({ opensAt: now - SECRET_RUN_OPENS_BEFORE, closesAt: now + (replacing ? BigInt(RAISE_WINDOW_SECONDS) : SECRET_RUN_OPEN_FOR) });
