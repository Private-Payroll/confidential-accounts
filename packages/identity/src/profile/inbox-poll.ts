import { openAll } from './inbox.js';
import type { InboxHost, InboxKeypair, Opening } from './inbox.js';

/**
 * POLLING AN INBOX, AND STOPPING.
 *
 * ── THE DECISION, QUOTED, BECAUSE ALL THREE PARTS ARE LOAD-BEARING ────────
 *
 * *"A WEB PAGE CANNOT BE PUSHED TO, so an inbox is polled, and polling tells its
 * host when you look and how often even when it cannot read a word of what it
 * holds. That is the same shape as the indexer learning the fact of being asked,
 * and it is answered the same way. Decided: poll while the wallet is open, and a
 * refresh control for asking on purpose. The screen names what the host learns,
 * the way the balance card's footer names the indexer. Nothing polls when the
 * wallet is shut."*
 *
 * **THE SECRET LIVES ONLY IN THE UNLOCKED PHASE AND SO DOES THE POLLING.** Not a
 * service worker, not a timer that outlives the phase, not a background channel
 * of any kind. There is nothing in this module that can run without a caller
 * holding it, and the caller is `app/inbox-live.ts`, which is mounted by the one
 * branch of `app/app.tsx` that has an unlocked identity.
 *
 * ── AND THAT ARRANGEMENT IS NOT THE PROOF. THE GUARD IS ───────────────────
 *
 * THE RULE: *"Nothing polls without an unlocked wallet. Assert it, do
 * not merely arrange it."* An arrangement is a claim about every caller there
 * will ever be. **So `unlocked()` is asked on every tick and the poller stops
 * ITSELF the first time the answer is no**, whatever the caller did or failed to
 * do. It is asked twice per round trip, and the second one is the subtle half:
 *
 *   1. **BEFORE ASKING.** A tick that fires after the wallet locked must not
 *      reach the host — a request going out from a locked wallet tells the host
 *      somebody is at this browser when nobody is.
 *   2. **AFTER THE ANSWER COMES BACK.** A wallet can lock during the round trip.
 *      Delivering that answer would put a locked wallet's items into a store
 *      that outlives the phase they belong to, and would schedule the next tick
 *      from inside a phase that has ended. **The bytes are dropped and the
 *      poller stops.**
 *
 * ── ONE ASK AT A TIME, AND WHY IT IS `setTimeout` AND NOT `setInterval` ────
 *
 * An interval fires on a schedule whatever the last one is doing, so a host
 * that answers slowly gets a queue of overlapping asks from one wallet — which
 * is both a worse thing to do to a host and a louder signal to it than the
 * cadence the screen names. **The next tick is scheduled when the last one
 * finishes**, so the sentence on the card stays true: the interval is a floor.
 *
 * ── FOUR STATES, AND `failed` IS NOT EMPTY ────────────────────────────────
 *
 * THE RULE, one product away: *"Zero and I do not know are
 * different facts."* An inbox that could not be reached is not an empty inbox,
 * and an inbox with an item nobody can open is neither. All three are separate
 * arms here and all three are separate sentences on the card.
 */

export type InboxState =
  /** Nothing has been asked yet. Not the same as an empty inbox. */
  | { readonly of: 'never-asked' }
  /** An ask is in flight. */
  | { readonly of: 'asking' }
  /** The host answered. `openings` is one entry per item it returned, always. */
  | {
    readonly of: 'answered';
    readonly openings: readonly Opening[];
    readonly at: number;
  }
  /** The host could not be reached, or would not answer. **NOT an empty inbox.** */
  | { readonly of: 'failed'; readonly why: string; readonly at: number };

/** Injected so a test drives the clock rather than waiting on one. */
export interface Timers {
  after(ms: number, fn: () => void): unknown;
  cancel(handle: unknown): void;
}

export const REAL_TIMERS: Timers = Object.freeze({
  after: (ms: number, fn: () => void) => setTimeout(fn, ms),
  cancel: (handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
});

/**
 * SIXTY SECONDS, AND THE SCREEN SAYS SO.
 *
 * There is no measurement behind this number and there cannot be one until a
 * host exists — it is a choice, and the reason it is stated here rather than
 * left in a call site is that **the card's sentence names it to a person**, so
 * the two must not be able to drift apart. `inbox-card.tsx` reads this constant.
 */
export const POLL_EVERY_MS = 60_000;

export interface InboxPolling {
  /** Ask now, on purpose. The refresh control the agreement requires. */
  refresh(): void;
  /** Stop. Idempotent, and called from the unlocked phase's own teardown. */
  stop(): void;
  /** For a test, and for the assertion: has this poller stopped itself? */
  readonly stopped: () => boolean;
}

export interface InboxPollingOptions {
  readonly host: InboxHost;
  readonly keys: InboxKeypair;
  /**
   * **THE ASSERTION.** Asked on every tick, before the ask and after the
   * answer. See the header: an arrangement is not a proof.
   */
  readonly unlocked: () => boolean;
  readonly onState: (state: InboxState) => void;
  readonly everyMs?: number;
  readonly now?: () => number;
  readonly timers?: Timers;
}

export function startInboxPolling({
  host, keys, unlocked, onState,
  everyMs = POLL_EVERY_MS, now = Date.now, timers = REAL_TIMERS,
}: InboxPollingOptions): InboxPolling {
  let handle: unknown = null;
  let halted = false;
  /* The host's own bookmark. Opaque: echoed back, never read. */
  let after: string | undefined;
  /* An ask already in flight. A refresh during one does not open a second. */
  let inFlight = false;

  const stop = (): void => {
    halted = true;
    if (handle !== null) { timers.cancel(handle); handle = null; }
  };

  const schedule = (): void => {
    if (halted) return;
    handle = timers.after(everyMs, () => { handle = null; void ask(); });
  };

  const ask = async (): Promise<void> => {
    if (halted) return;
    /* GUARD ONE — nothing reaches the host from a wallet that is not open. */
    if (!unlocked()) { stop(); return; }
    if (inFlight) return;
    inFlight = true;
    onState({ of: 'asking' });
    try {
      const answer = await host.items({
        schema: 'midnight-identity/inbox-ask/v1',
        inbox: keys.publicKey,
        ...(after === undefined ? {} : { after }),
      });
      /* GUARD TWO — the wallet may have locked while the host was answering.
       * The bytes are dropped rather than delivered into a phase that ended. */
      if (halted || !unlocked()) { stop(); return; }
      after = answer?.cursor;
      onState({
        of: 'answered',
        openings: openAll(answer?.items ?? [], keys),
        at: now(),
      });
    } catch (e) {
      if (halted || !unlocked()) { stop(); return; }
      /* A HOST THAT DID NOT ANSWER IS NOT AN EMPTY INBOX. */
      onState({
        of: 'failed',
        why: e instanceof Error ? e.message : 'the inbox host did not answer.',
        at: now(),
      });
    } finally {
      inFlight = false;
    }
    schedule();
  };

  onState({ of: 'never-asked' });
  void ask();

  return Object.freeze({
    refresh: () => { if (!halted) void ask(); },
    stop,
    stopped: () => halted,
  });
}
