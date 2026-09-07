import { combine, split } from 'shamir-secret-sharing';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SECRET_BYTES } from '../keys/derivation.js';
import type { Secret } from '../keys/derivation.js';

/**
 * CUTTING A SECRET INTO PIECES, AND PUTTING IT BACK. §1 and §7.
 *
 * THE SPLITTING ITSELF IS SOMEBODY ELSE'S CODE AND IT IS AUDITED — §7.6.
 * `shamir-secret-sharing` (Privy, audited by Cure53, zero dependencies) does
 * the arithmetic. Threshold splitting is easy to get subtly wrong and the
 * failure is silent until the day it is needed, which is the worst possible
 * combination and the reason none of it is written here.
 *
 * WHAT IS SPLIT IS THE 32-BYTE SECRET, NOT THE 64-BYTE SEED — §7.4. Words and
 * secret are the same number in two formats and you can move between them
 * freely; the seed is a one-way stretch of it. Cut the seed and the wallet
 * still works but **nobody who has recovered can ever be shown their words
 * again**, and that only becomes visible after somebody recovers, which is
 * exactly when it can no longer be changed.
 *
 * THE RULES THIS FILE ENFORCES, all from §1:
 *
 *   a threshold of one is refused        that is not a threshold, it is copies
 *   N-of-N is refused for a DEFAULT      two-of-two recovers nothing; allowed
 *                                        only when somebody chooses it knowing
 *   no two pieces behind one holder      twelve pieces in one Google account is
 *                                        one piece with a big number on it
 *   the set is PROVEN before it is       a recovery path nobody has run does
 *   claimed                              not exist
 */

/** The most pieces the library will cut. The scheme's own limit is 255. */
export const MAX_PIECES = 16;

/**
 * EVERY PIECE CARRIES A HEADER, AND THIS IS THE MOST IMPORTANT THING IN THE
 * FILE.
 *
 * Shamir has no integrity check and no knowledge of its own threshold. Hand
 * `combine` two pieces of a three-of-five set, or three pieces drawn from two
 * DIFFERENT sets of the same person's, and it returns thirty-two perfectly
 * well-formed bytes that are not the secret. Nothing downstream can tell:
 * `identityFromSecret` accepts any thirty-two bytes, and the person is shown
 * twenty-four valid words for an account nobody has ever paid into — while the
 * real one becomes unreachable, because the pieces have been spent on the wrong
 * answer and everything on screen says it worked.
 *
 * The two ordinary doors are not exotic. **The threshold is a number somebody
 * remembers**, and **an old set left in the same folder as the current one** is
 * what anybody who has ever re-cut their pieces has.
 *
 * So a piece is not a bare share. It is:
 *
 *   [version:1][threshold:1][fingerprint:8][share:33]
 *
 * The threshold travels WITH the pieces rather than being supplied, and the
 * fingerprint is a one-way function of the secret — so the rebuilt answer is
 * checked against something, which the earlier version of this file said was
 * impossible. It is not impossible. It was missing.
 */
const PIECE_VERSION = 1;
const FINGERPRINT_BYTES = 8;
/**
 * A RANDOM ID PER CUT, so "these are from different sets" means what it says.
 *
 * The fingerprint identifies the SECRET, and re-cutting the same secret — the
 * ordinary reason anybody has two sets, and exactly the case this file
 * describes — produces two sets with the same fingerprint. Without this, that
 * mixture reached the last line of defence instead of the first, and the gate
 * credited with catching it did no work in the one scenario it was written for.
 */
const SET_ID_BYTES = 4;
const PIECE_HEADER = 2 + FINGERPRINT_BYTES + SET_ID_BYTES;

/**
 * Eight bytes that identify a secret without revealing it.
 *
 * One-way, domain-separated, and short on purpose: it is a check against a
 * wrong reconstruction, not a credential. Recovering the 32-byte secret from it
 * is 2^256 work; two different secrets colliding is 1 in 2^64.
 */
export function fingerprintOf(secret: Secret): Uint8Array {
  return hkdf(
    sha256, secret, undefined,
    new TextEncoder().encode(`midnight-identity/piece-fingerprint/v${PIECE_VERSION}`),
    FINGERPRINT_BYTES);
}

export type RecoveryFailure =
  | 'secret-wrong-length'
  | 'threshold-of-one'
  | 'threshold-above-count'
  | 'too-few-pieces'
  | 'too-many-pieces'
  | 'holders-collide'
  | 'not-enough-pieces'
  | 'pieces-do-not-fit'
  | 'pieces-from-different-sets'
  | 'wrong-number-of-pieces'
  | 'not-a-piece'
  | 'wrong-secret';

export class RecoveryError extends Error {
  readonly code: RecoveryFailure;
  constructor(code: RecoveryFailure, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

/**
 * WHERE A PIECE IS GOING — a **home**, and separately a **lock**. §7.10.
 *
 * A home is where the bytes sit: their own Google account, a device, paper. A
 * lock is what has to be present to open them: another Midnight wallet, or
 * nothing at all when the home is the protection. Keeping them apart is what
 * makes "another wallet" and "a password" free rather than a rewrite.
 */
export interface Placement {
  /** Shown to the person. "Your Google account", "Printed", "My other laptop". */
  readonly label: string;
  /**
   * WHO ULTIMATELY CONTROLS THIS PLACE — a Google account id, `paper`,
   * `device:laptop-1`. **Two placements answering the same string are one
   * place**, whatever their labels say, and that is what the collision rule is
   * checked against.
   */
  readonly holder: string;
  /** True when this is the machine the set is being created on. §7.3. */
  readonly isThisDevice?: boolean;
}

export interface Piece {
  readonly placement: Placement;
  /** The bytes to store. Meaningless on its own — that is the whole point. */
  readonly bytes: Uint8Array;
}

export interface PieceSet {
  readonly threshold: number;
  /** Which secret these are for. Hex. Carried on every piece as well. */
  readonly fingerprint: string;
  /** Which CUT these are from — random per split, so a re-cut set is a new one. */
  readonly setId: string;
  readonly pieces: readonly Piece[];
}

/**
 * Cut a secret into pieces.
 *
 * `threshold` is how many are needed to put it back. Every rule that can be
 * checked here is checked here rather than at the screen, because a screen is
 * one caller and this is the only door.
 */
export async function splitSecret(
  secret: Secret, placements: readonly Placement[], threshold: number,
): Promise<PieceSet> {
  if (secret?.length !== SECRET_BYTES) {
    throw new RecoveryError(
      'secret-wrong-length',
      `a secret is ${SECRET_BYTES} bytes; got ${secret?.length ?? 'nothing'}. `
      + 'This is the entropy, not the 64-byte seed.');
  }
  checkPlan(placements, threshold);

  const shares = await split(secret, placements.length, threshold);
  const fingerprint = fingerprintOf(secret);
  const setId = crypto.getRandomValues(new Uint8Array(SET_ID_BYTES));

  const set = Object.freeze({
    threshold,
    fingerprint: toHex(fingerprint),
    setId: toHex(setId),
    pieces: Object.freeze(placements.map((placement, i) => Object.freeze({
      placement,
      bytes: wrap(shares[i] as Uint8Array, threshold, fingerprint, setId),
    }))),
  });

  /*
   * THE SET IS PROVED BEFORE IT IS RETURNED, not by whoever remembers to ask.
   * It is the same reason `checkPlan` is called here: a screen is one
   * caller and this is the only door. `proveRecoverable` was listed under the
   * rules this file enforces and was called by nothing, which is a known shape
   * for the third time.
   */
  /*
   * PROVED HERE, AT THE ONLY DOOR, and the value of it is that it fails
   * at the SPLIT rather than at the recovery — the day the scheme, or our use
   * of it, stops being correct.
   *
   * An earlier version of this comment claimed no test could catch the removal
   * of this line, since the library is correct and the proof always passes.
   * That was wrong: replacing the
   * splitting library at the module boundary produces a set that does not
   * rebuild, and the test does exactly that.
   */
  await proveRecoverable(secret, set);
  return set;
}

function wrap(
  share: Uint8Array, threshold: number, fingerprint: Uint8Array, setId: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(PIECE_HEADER + share.length);
  out[0] = PIECE_VERSION;
  out[1] = threshold;
  out.set(fingerprint, 2);
  out.set(setId, 2 + FINGERPRINT_BYTES);
  out.set(share, PIECE_HEADER);
  return out;
}

interface Unwrapped {
  readonly threshold: number;
  readonly fingerprint: string;
  readonly setId: string;
  readonly share: Uint8Array;
}

function unwrap(piece: Uint8Array): Unwrapped {
  if (!piece || piece.length <= PIECE_HEADER) {
    throw new RecoveryError(
      'not-a-piece',
      `a recovery piece is more than ${PIECE_HEADER} bytes; this one is ${piece?.length ?? 0}.`);
  }
  if (piece[0] !== PIECE_VERSION) {
    throw new RecoveryError(
      'not-a-piece',
      `this piece is format ${piece[0]} and this library reads format ${PIECE_VERSION}.`);
  }
  const threshold = piece[1] as number;
  if (threshold < 2 || threshold > MAX_PIECES) {
    throw new RecoveryError(
      'not-a-piece',
      `this piece says ${threshold} pieces are needed, which is not a threshold this `
      + 'library ever writes.');
  }
  return {
    threshold,
    fingerprint: toHex(piece.slice(2, 2 + FINGERPRINT_BYTES)),
    setId: toHex(piece.slice(2 + FINGERPRINT_BYTES, PIECE_HEADER)),
    share: piece.slice(PIECE_HEADER),
  };
}

/** What a piece's header says about the set it belongs to. Nothing secret:
 * the header is cleartext by design. */
export interface PieceHeader {
  /** How many pieces of this set put the account back. */
  readonly threshold: number;
  /** Which secret, as hex — `fingerprintOf` the secret it was cut from. */
  readonly fingerprint: string;
  /** Which CUT, as hex — random per split, so a re-cut set is a new one. */
  readonly setId: string;
}

/**
 * Read a piece's header — THE SAME READ `combinePieces` DOES, exported so a
 * door in front of it cannot invent a looser one: the session used to
 * accept any blob whose first two bytes looked right and take its threshold
 * byte at face value, so twenty bytes beginning `01 09` moved the number on
 * the screen with no error. A piece this library cannot read is refused HERE,
 * in this library's words, not accepted for one byte of it.
 */
export function readPieceHeader(piece: Uint8Array): PieceHeader {
  const { threshold, fingerprint, setId } = unwrap(piece);
  return { threshold, fingerprint, setId };
}

/**
 * The rules, on their own, so a screen can ask *"is this allowed?"* before
 * anybody has generated anything — and so they are testable without cutting a
 * real secret.
 */
export function checkPlan(placements: readonly Placement[], threshold: number): void {
  if (placements.length < 2) {
    throw new RecoveryError(
      'too-few-pieces',
      'a recovery set needs at least two pieces. One piece that opens everything '
      + 'is not a threshold, it is a copy.');
  }
  if (placements.length > MAX_PIECES) {
    throw new RecoveryError(
      'too-many-pieces',
      `at most ${MAX_PIECES} pieces. More places to keep track of is not more safety.`);
  }
  if (threshold < 2) {
    throw new RecoveryError(
      'threshold-of-one',
      'a threshold of one is refused. That is not a threshold, it is copies — '
      + 'whoever holds any single piece holds the whole account.');
  }
  if (threshold > placements.length) {
    throw new RecoveryError(
      'threshold-above-count',
      `${threshold} pieces cannot be required out of ${placements.length}. `
      + 'That set can never be recovered.');
  }

  /*
   * NO TWO PIECES BEHIND THE SAME HOLDER. Twelve pieces in one Google account
   * is one piece with a big number on it, and it is invisible to the person
   * because the labels look different.
   */
  const seen = new Map<string, string>();
  for (const placement of placements) {
    const holder = placement.holder.trim().toLowerCase();
    if (!holder) {
      throw new RecoveryError(
        'holders-collide', `"${placement.label}" does not say who controls it.`);
    }
    const already = seen.get(holder);
    if (already !== undefined) {
      throw new RecoveryError(
        'holders-collide',
        `"${placement.label}" and "${already}" are both behind ${placement.holder}. `
        + 'Two pieces in one place are one piece — whoever opens it opens both.');
    }
    seen.set(holder, placement.label);
  }
}

/** What a set is fine to be, and what somebody has to be told about it first. */
export interface Warning {
  readonly kind: 'no-margin' | 'host-holds-a-necessary-piece';
  readonly says: string;
}

/**
 * WHETHER A SET IS N-OF-N, which is allowed but must be said out loud. §1.
 *
 * Two-of-two recovers nothing the moment either piece is lost, and people pick
 * it because it sounds like more security rather than less margin. It is not
 * refused — it is somebody's own choice about their own money — but no default
 * offers it and the screen warns at the moment the numbers are chosen.
 */
export const hasNoMargin = (count: number, threshold: number): boolean => threshold === count;

/**
 * THE WARNINGS A SET CARRIES. A known shape closed: `hasNoMargin` existed and
 * **nothing outside its own test called it**, so §1's "N-of-N warned about
 * loudly" was a sentence rather than a behaviour.
 *
 * `hostHolder` is who the HOST is, when a host supplies one of the homes — the
 * payroll product may, §7.9. §7.2's second rule is that whatever a host holds
 * must never be NECESSARY, and a piece is necessary exactly when the set is
 * N-of-N. That is the case this returns rather than assumes.
 */
export function warningsFor(
  placements: readonly Placement[], threshold: number, hostHolder?: string,
): readonly Warning[] {
  const out: Warning[] = [];
  if (hasNoMargin(placements.length, threshold)) {
    out.push({
      kind: 'no-margin',
      says: `All ${threshold} pieces will be needed. Lose any one of them — a `
        + 'wiped device, a lost print, an account you cannot get back into — and '
        + 'this account is gone. Most people want at least one to spare.',
    });
  }
  if (hostHolder) {
    const holder = hostHolder.trim().toLowerCase();
    const hostHas = placements.some((p) => p.holder.trim().toLowerCase() === holder);
    if (hostHas && hasNoMargin(placements.length, threshold)) {
      out.push({
        kind: 'host-holds-a-necessary-piece',
        says: 'One of these pieces is held for you, and every piece is needed — so '
          + 'getting this account back would depend on us. That is exactly what this '
          + 'design exists to avoid. Add one more place you control.',
      });
    }
  }
  return Object.freeze(out);
}

/**
 * THE DEFAULT SET, for somebody who does not want to think about it.
 *
 * Two-of-three, and **it never counts the device it is created on** — §7.3. A
 * default of "your cloud account, a printed copy, and this device" reads as
 * two-of-three and behaves as two-of-two, because the device going is the most
 * likely reason somebody is recovering at all. When it goes, its piece goes
 * with it.
 */
export function suggestDefault(available: readonly Placement[]): {
  readonly placements: readonly Placement[]; readonly threshold: number;
} {
  const loadBearing = available.filter((p) => !p.isThisDevice);
  if (loadBearing.length < 3) {
    throw new RecoveryError(
      'too-few-pieces',
      'a suggested set needs three places that are not this device. '
      + 'The machine somebody is standing on is the one most likely to be the reason '
      + 'they are recovering, so it is never one of the load-bearing pieces.');
  }
  return { placements: Object.freeze(loadBearing.slice(0, 3)), threshold: 2 };
}

/**
 * Put the secret back from enough pieces.
 *
 * IT CHECKS THAT THE ANSWER IS RIGHT. The first version of this comment said
 * the opposite — *"it cannot, because there is nothing here to check it
 * against"* — and that sentence was the defect, not a description of one: it is
 * why somebody could be handed twenty-four valid words for an account nobody
 * had ever paid into. There is something to check against, it rides on every
 * piece, and the check is below.
 */
export async function combinePieces(pieces: readonly Uint8Array[]): Promise<Secret> {
  if (pieces.length < 2) {
    throw new RecoveryError(
      'not-enough-pieces',
      `putting a secret back needs at least two pieces; ${pieces.length} were offered.`);
  }

  /*
   * THE CAP APPLIES HERE TOO, and not only at the split.
   *
   * A piece's header is cleartext, so extra structurally-valid pieces can be
   * forged and offered under invented holder names — and the subset search
   * below is C(n,k), which is bounded only by this. Measured: sixteen pieces is
   * about a fifth of a second and twenty is six seconds, which is a way to make
   * somebody's recovery screen hang while they are already frightened.
   */
  if (pieces.length > MAX_PIECES) {
    throw new RecoveryError(
      'too-many-pieces',
      `at most ${MAX_PIECES} pieces can be offered at once; ${pieces.length} were. `
      + 'A set this library cut never has more.');
  }

  const unwrapped = pieces.map(unwrap);

  /*
   * ALL FROM ONE SET. Anybody who has re-cut their pieces — after adding a
   * device, after losing a holder — has an older set sitting in the same
   * folder under the same name. Mixed, with the right count, Shamir returns
   * thirty-two well-formed bytes that are not anybody's secret.
   */
  const fingerprint = unwrapped[0]!.fingerprint;
  const setId = unwrapped[0]!.setId;
  if (unwrapped.some((p) => p.fingerprint !== fingerprint || p.setId !== setId)) {
    throw new RecoveryError(
      'pieces-from-different-sets',
      'these pieces are not all from the same set. Mixing an old set with a current '
      + 'one produces an answer rather than an error, so it is refused here — and '
      + 'that includes two sets cut from the SAME account, which is the ordinary way '
      + 'somebody ends up with both.');
  }

  /*
   * THE THRESHOLD IS THE PIECES' OWN, NOT A NUMBER SOMEBODY REMEMBERED. Too few
   * and Shamir interpolates a wrong secret in silence; too many is harmless but
   * says the caller has lost track, so exactly the threshold is used.
   */
  const threshold = unwrapped[0]!.threshold;
  if (unwrapped.some((p) => p.threshold !== threshold)) {
    throw new RecoveryError(
      'pieces-from-different-sets', 'these pieces disagree about how many are needed.');
  }
  if (unwrapped.length < threshold) {
    throw new RecoveryError(
      'not-enough-pieces',
      `this set needs ${threshold} pieces and ${unwrapped.length} were offered.`);
  }

  /*
   * EVERY COMBINATION IS TRIED, NOT THE FIRST `threshold` OFFERED.
   *
   * With one damaged piece among four, taking the first two refuses and a
   * different two would have worked — so whether somebody gets their account
   * back depended on the ORDER they happened to fetch things in, and the
   * message told them a piece had been altered rather than to try again. On
   * the day somebody is recovering, that difference is the whole product.
   *
   * The cost is bounded by `MAX_PIECES`: the worst case is eight-of-sixteen,
   * 12,870 combinations, about a fifth of a second.
   *
   * AND THE ANSWER IS CHECKED. The first version of this file said it could not
   * be — *"there is nothing here to check it against"* — and that sentence was
   * the defect: it is why somebody could be handed twenty-four valid words for
   * an account that had never existed.
   */
  for (const subset of combinations(unwrapped.map((p) => p.share), threshold)) {
    let candidate: Uint8Array;
    try {
      candidate = await combine(subset);
    } catch {
      continue;
    }
    if (candidate.length === SECRET_BYTES && toHex(fingerprintOf(candidate)) === fingerprint) {
      return candidate;
    }
  }

  throw new RecoveryError(
    'wrong-secret',
    `no ${threshold} of these ${unwrapped.length} pieces rebuild the account they say `
    + 'they belong to. Nothing has been opened. At least one of them has been altered '
    + 'where it was stored, or is from an older set.');
}

/**
 * WE PROVE IT WORKS BEFORE SAYING IT DOES. §1, and it is not optional.
 *
 * A recovery path nobody has run does not exist. So before a set is called
 * done, the secret is actually rebuilt from a real subset of the pieces and
 * compared with the original — **every** minimum-sized subset, not one, because
 * a scheme that gets one combination right and another wrong is exactly the
 * silent failure §7.6 is about.
 *
 * The number of subsets is bounded by `MAX_PIECES` being sixteen: the worst
 * case is eight-of-sixteen, which is 12,870 combinations, and each is
 * microseconds.
 */
export async function proveRecoverable(secret: Secret, set: PieceSet): Promise<void> {
  const expected = toHex(secret);
  const bytes = set.pieces.map((p) => p.bytes);
  for (const subset of combinations(bytes, set.threshold)) {
    const rebuilt = await combinePieces(subset);
    if (toHex(rebuilt) !== expected) {
      throw new RecoveryError(
        'wrong-secret',
        'this set of pieces does not rebuild the account. It has not been saved, '
        + 'because a recovery that has never been run is not a recovery.');
    }
  }
}

function* combinations<T>(items: readonly T[], take: number): Generator<T[]> {
  const chosen: T[] = [];
  function* walk(from: number): Generator<T[]> {
    if (chosen.length === take) {
      yield [...chosen];
      return;
    }
    for (let i = from; i < items.length; i += 1) {
      chosen.push(items[i] as T);
      yield* walk(i + 1);
      chosen.pop();
    }
  }
  yield* walk(0);
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
