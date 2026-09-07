import { MAX_PIECES, RecoveryError, combinePieces, readPieceHeader } from './pieces.js';
import type { Secret } from '../keys/derivation.js';

/**
 * RECOVERY IS A RESUMABLE SESSION, NOT A FUNCTION CALL. §7.11, and
 * it is the one condition that has to be met NOW for the on-chain version to
 * arrive later without a rewrite.
 *
 * The chain's real gift is not storage — a password-protected blob on a public
 * permanent ledger is an unlimited offline attack — it is **a waiting period
 * the real owner can veto.** Recovery is announced, then delayed, and any
 * device they still hold can cancel it during the window. That is what turns a
 * stolen recovery into a failed one.
 *
 * **But a veto window only exists if recovery has a middle.** Ship it as one
 * call that gathers pieces and hands back the account, and adding *"except it
 * now takes 48 hours, can be cancelled, and is finished on a different
 * device"* is a rewrite of the flow and every screen around it. Built as a
 * session, v1 simply moves through the states immediately and the chain version
 * later makes one of them take longer.
 *
 * It costs a few extra states in something that was going to have states
 * anyway, and it buys resumability across devices — which people want
 * regardless, because they start on a laptop and finish where the pieces are.
 *
 * EVERYTHING HERE IS PURE. A session goes in, a new session comes out, and the
 * host stores it. There is no clock read and no storage reached; `now` is a
 * parameter, which is also what makes the waiting period testable without
 * waiting.
 */

export type RecoveryState =
  /** Collecting pieces. Fewer than the threshold are in. */
  | 'gathering'
  /** Enough pieces, and a waiting period is running. v1 never sits here. */
  | 'waiting'
  /** Enough pieces and nothing left to wait for. */
  | 'ready'
  /** Finished. Terminal. */
  | 'completed'
  /** Stopped, by the owner or by whoever started it. Terminal. */
  | 'cancelled';

export interface OfferedPiece {
  /** Who this piece came from — the `Placement.holder` it was stored under. */
  readonly holder: string;
  readonly bytes: Uint8Array;
}

export interface RecoverySession {
  readonly id: string;
  readonly state: RecoveryState;
  /** How many distinct holders are needed. */
  readonly threshold: number;
  /**
   * The pieces offered so far.
   *
   * **THESE ARE THE BYTES, AND THAT MATTERS.** A session is designed to be
   * serialised and carried between devices, so whoever stores one holds
   * threshold-many pieces at once — which is the whole secret.
   *
   * Two consequences, both load-bearing:
   *
   *   - **A completed session carries none of them.** `completeRecovery`
   *     returns one with this emptied, so a host that saves what it is handed
   *     does not keep a permanent copy of somebody's account.
   *   - **A session that has REACHED ITS THRESHOLD must not be written
   *     anywhere a host can read** without being sealed first, because
   *     threshold-many pieces are the whole secret. That is a `waiting` or
   *     `ready` session (`advance`, below) — and `waiting` is exactly the
   *     state designed to be carried between devices, so it is the one that
   *     matters. A GATHERING session holds FEWER than `threshold` pieces by
   *     the definition of the state, which for a 2-of-N set is one.
   *     `SECURITY.md` says so too, and says in the same breath that NOTHING
   *     HERE ENFORCES IT: no test would notice a host that wrote one out.
   *     (This comment used to justify itself by "the product's published
   *     claim is that we hold at most one piece". That claim was cut from
   *     `SECURITY.md` — it rested on a convention about holder ids that no
   *     test observes — so the justification is restated from the mechanism
   *     rather than left pointing at a sentence that no longer exists.)
   */
  readonly gathered: readonly OfferedPiece[];
  /** How many were used. Survives completion; the bytes do not. */
  readonly usedCount: number;
  readonly startedAt: number;
  /**
   * When the waiting period ends, or null when there is none.
   *
   * **v1 has none**, so this is null and a session goes straight from
   * `gathering` to `ready`. The field exists so that switching it on is a
   * configuration change rather than a redesign.
   */
  readonly readyAt: number | null;
  /**
   * How long the waiting period is, in milliseconds. **Zero in v1.**
   *
   * It is stored ON THE SESSION rather than re-read from configuration, so a
   * window cannot be shortened halfway through by changing a setting — which
   * would be the obvious way to defeat the veto that has not been built yet.
   */
  readonly waitMs: number;
  /** Why it was cancelled, if it was. Shown to whoever asks. */
  readonly cancelledBecause: string | null;
}

export interface StartOptions {
  readonly id: string;
  readonly threshold: number;
  readonly now: number;
  /**
   * How long to wait once enough pieces are in, before the account can actually
   * be handed over. **Zero in v1** — see §7.11.
   */
  readonly waitMs?: number;
}

const terminal = (state: RecoveryState): boolean =>
  state === 'completed' || state === 'cancelled';

function refuseIfOver(session: RecoverySession, doing: string): void {
  if (terminal(session.state)) {
    throw new RecoveryError(
      'not-enough-pieces',
      `this recovery is already ${session.state} and cannot be ${doing}. `
      + 'Start a new one.');
  }
}

export function startRecovery(options: StartOptions): RecoverySession {
  if (options.threshold < 2) {
    throw new RecoveryError(
      'threshold-of-one',
      'a recovery needs at least two pieces. One piece that opens everything is '
      + 'not a threshold, it is a copy.');
  }
  return Object.freeze({
    id: options.id,
    state: 'gathering' as const,
    threshold: options.threshold,
    gathered: Object.freeze([]),
    usedCount: 0,
    startedAt: options.now,
    readyAt: null,
    waitMs: Math.max(0, options.waitMs ?? 0),
    cancelledBecause: null,
  });
}

/**
 * Add a piece.
 *
 * TWO PIECES FROM ONE HOLDER COUNT ONCE. Somebody who can open a Google account
 * can fetch everything in it, so accepting both would let one compromised
 * account reach a threshold of two on its own — which is the same failure the
 * *no two pieces behind one holder* rule prevents at set-up, arriving through
 * the other door. A second offer from a holder already counted **replaces** it
 * rather than adding, so a re-fetch after a network failure is not an error.
 */
export function offerPiece(
  session: RecoverySession, piece: OfferedPiece, now: number,
): RecoverySession {
  refuseIfOver(session, 'added to');

  const holder = piece.holder.trim().toLowerCase();
  if (!holder) {
    throw new RecoveryError('holders-collide', 'a piece must say where it came from.');
  }

  /*
   * THE DOOR READS THE WHOLE HEADER, NOT ONE BYTE. A version that
   * merely peeked at the threshold byte accepted any blob whose first two
   * bytes looked right, so twenty bytes beginning `01 09` moved the number on
   * the screen to "2 of 9" with no error at all — in front of a
   * `combinePieces` whose refusals were all correct and all too late to be
   * read. `readPieceHeader` throws the same `not-a-piece` refusals the
   * rebuild would, at the moment the piece is offered.
   */
  const header = readPieceHeader(piece.bytes);

  const kept = session.gathered.filter((p) => p.holder.trim().toLowerCase() !== holder);

  /*
   * AND THE WHOLE HEADER MUST AGREE, NOT A THIRD OF IT.
   * The first fix compared only the threshold, so a piece that could
   * never combine — a different cut of the same account, or a different
   * account outright — still counted toward "enough pieces", reached the
   * finish button, and failed at the last press. That is the failure this file
   * exists to prevent, moved one step later instead of removed — and re-cutting
   * makes it ordinary: superseded sets are preserved by design, so old and
   * new cards sit in the same drawer for exactly the person recovering.
   *
   * The header can tell the cases apart, so the refusal says WHICH ONE this
   * is: a different account, a different cut of the same account, or (belt
   * and braces — one cut has one threshold) a disagreeing threshold.
   */
  if (kept.length > 0) {
    const already = kept.length === 1 ? 'the piece already in' : `the ${kept.length} pieces already in`;
    const agreed = readPieceHeader(kept[0]!.bytes);
    if (header.fingerprint !== agreed.fingerprint) {
      throw new RecoveryError(
        'pieces-from-different-sets',
        `this piece is from a DIFFERENT ACCOUNT — not the one ${already} rebuild. `
        + 'Check you are holding the right cards, or take the others out and gather '
        + 'that account’s set instead.');
    }
    if (header.setId !== agreed.setId) {
      throw new RecoveryError(
        'pieces-from-different-sets',
        `this piece is from a different cut of the same account — an older or newer `
        + `set than ${already}. Pieces only combine with the set they were cut with: `
        + 'use cards that were made together. Both sets still work on their own.');
    }
    if (header.threshold !== agreed.threshold) {
      throw new RecoveryError(
        'pieces-from-different-sets',
        `this piece says ${header.threshold} pieces are needed, and ${already} `
        + `${kept.length === 1 ? 'says' : 'say'} ${agreed.threshold} — they cannot be `
        + 'from the same set. Check this one against its card, or take the others out first.');
    }
  }

  const gathered = [...kept, piece];
  /*
   * The same cap `combinePieces` applies, applied at the door people actually
   * touch — so the refusal arrives when somebody adds the seventeenth piece
   * rather than when they press the button at the end.
   */
  if (gathered.length > MAX_PIECES) {
    throw new RecoveryError(
      'not-enough-pieces',
      `a recovery takes at most ${MAX_PIECES} pieces and this one already has `
      + `${session.gathered.length}. Remove one before adding another.`);
  }

  /*
   * THE THRESHOLD COMES OFF THE PIECES, NOT OUT OF SOMEBODY'S MEMORY. The rule
   * made every piece carry its own; this is the door in front of it, and it was
   * still asking the caller. A session started with the wrong number refused
   * with *"you have 2 of the 3 pieces you need"* while those same two pieces
   * rebuilt the account perfectly — and somebody told they are short a piece
   * they will never find concludes the account is gone. Every gathered piece
   * agrees with this one (checked above), so this is the set's number, not
   * the newest paste's.
   */
  return advance(
    { ...session, threshold: header.threshold, gathered: Object.freeze(gathered) }, now);
}

/** Take one back out — a piece that turned out to be the wrong one. */
export function withdrawPiece(
  session: RecoverySession, holder: string, now: number,
): RecoverySession {
  refuseIfOver(session, 'changed');
  const target = holder.trim().toLowerCase();
  const remaining = session.gathered.filter(
    (p) => p.holder.trim().toLowerCase() !== target);
  /*
   * RECOMPUTED FROM WHAT REMAINS. The number on the screen must
   * describe the pieces that are actually in, so taking one out re-reads the
   * rest rather than keeping a count the withdrawn piece set. With nothing
   * left there is nothing to read, and the session's current number stands
   * until the first piece of the next attempt is offered.
   */
  const threshold = remaining.length > 0
    ? readPieceHeader(remaining[0]!.bytes).threshold
    : session.threshold;
  return advance(
    { ...session, threshold, gathered: Object.freeze(remaining) }, now);
}

/**
 * Move a session to whatever state its contents and the clock now imply.
 *
 * Called after every change, and also on its own — because a session sitting in
 * `waiting` becomes `ready` by nothing happening at all, and something has to
 * ask.
 */
export function advance(session: RecoverySession, now: number): RecoverySession {
  if (terminal(session.state)) return session;

  const enough = session.gathered.length >= session.threshold;
  if (!enough) {
    /* Dropping back below the threshold cancels any waiting period, so a piece
     * removed and re-added does not inherit a clock that was already running. */
    return Object.freeze({
      ...session, state: 'gathering' as const, readyAt: null,
    });
  }

  const readyAt = session.readyAt ?? now + session.waitMs;
  return Object.freeze({
    ...session,
    readyAt,
    state: now >= readyAt ? ('ready' as const) : ('waiting' as const),
  });
}

/**
 * THE VETO. Any device the real owner still holds can stop a recovery while it
 * is waiting — which is the entire reason the waiting period exists.
 *
 * It is allowed while `gathering` too, because somebody who started a recovery
 * by mistake should be able to stop it without waiting for it to finish.
 */
export function cancelRecovery(
  session: RecoverySession, because: string,
): RecoverySession {
  if (session.state === 'completed') {
    throw new RecoveryError(
      'not-enough-pieces',
      'this recovery has already finished. Cancelling it now would change nothing — '
      + 'what is needed is to move the account to a new set of pieces.');
  }
  if (session.state === 'cancelled') return session;
  /*
   * A CANCELLED SESSION DROPS ITS PIECES TOO. The first version emptied
   * a COMPLETED session and left the cancelled one carrying everything — and
   * cancellation is the veto, the path taken when a recovery is believed to be
   * a theft. So the artefact left behind by a REFUSED takeover was the one
   * still holding enough pieces to rebuild the account that was nearly taken.
   * The good outcome forgot and the bad one remembered.
   */
  return Object.freeze({
    ...session,
    state: 'cancelled' as const,
    cancelledBecause: because,
    usedCount: session.gathered.length,
    gathered: Object.freeze([]),
  });
}

export interface Recovered {
  readonly secret: Secret;
  readonly session: RecoverySession;
}

/**
 * Finish, and hand back the secret.
 *
 * It refuses unless the session is `ready`, which is the whole point: a
 * recovery that is still gathering has not met the threshold, and one that is
 * still waiting is inside the window the owner can veto. **Neither of those is
 * a case for a "force" flag**, and there is deliberately not one.
 */
export async function completeRecovery(
  session: RecoverySession, now: number,
): Promise<Recovered> {
  /*
   * A FINISHED OR CANCELLED SESSION IS REFUSED HERE AND BY NAME. Without this,
   * `advance` returns the terminal session untouched, the check below sees a
   * state that is not `ready`, and the message says *"this recovery has 2 of
   * the 2 pieces it needs"* — which reads as though it should have worked and
   * sends whoever is looking at it to fix the wrong thing. Found by its own
   * test before it left the building.
   */
  refuseIfOver(session, 'completed');

  const current = advance(session, now);
  if (current.state !== 'ready') {
    throw new RecoveryError(
      'not-enough-pieces',
      current.state === 'waiting'
        ? 'this recovery is still inside its waiting period. It can be cancelled from '
          + 'any device the owner still has until then.'
        : `this recovery has ${current.gathered.length} of the ${current.threshold} `
          + `pieces it needs.`);
  }
  const secret = await combinePieces(current.gathered.map((p) => p.bytes));
  return {
    secret,
    /*
     * THE PIECES ARE DROPPED HERE. A completed session is the thing a
     * host stores, and it has no reason to hold enough pieces to rebuild the
     * account for ever afterwards.
     */
    session: Object.freeze({
      ...current,
      state: 'completed' as const,
      usedCount: current.gathered.length,
      gathered: Object.freeze([]),
    }),
  };
}

/** What a screen shows: how far along, and what is still missing. */
export const progress = (session: RecoverySession): {
  readonly have: number; readonly need: number; readonly state: RecoveryState;
} => ({
  /* A finished session has dropped its pieces, so the count is what it used. */
  have: session.gathered.length || session.usedCount,
  need: session.threshold,
  state: session.state,
});
