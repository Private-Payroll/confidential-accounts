/**
 * **HOW MANY SEATS SIGNED A MESSAGE, COUNTED ONE WALLET TO A VOTE.** What the company's directory counts a quorum's
 * change by, and what the read grants record counts its signers by: every signature in its shape, verifying under the
 * key it names over the message, each key once; then the seats the directory believes and has not retired, each wallet
 * counted once. Who may count (held on the chain now, or as anchored) is the caller's `counts`.
 */
import { verify } from '../core/crypto.js';
import { HEX128, HEX64 } from './directory-change-shape.js';
import type { DirectorySeat, SeatSignature } from './seat-directory.js';

/** Why signatures are not counted at all. */
export type SignaturesRefusal = 'not-a-change' | 'not-signed' | 'twice-by-one-seat';

/**
 * Whether every signature is in its shape, verifies under the key it names over `message`, and names a key once:
 * what anyone can check of signatures, the server included. Who the keys are is not asked here.
 */
export const signaturesRefusal = (message: string, signatures: readonly SeatSignature[]): SignaturesRefusal | null => {
  if (!Array.isArray(signatures)) return 'not-a-change';
  const seen = new Set<string>();
  for (const sig of signatures) {
    if (typeof sig?.publicKey !== 'string' || !HEX64.test(sig.publicKey) || typeof sig.signature !== 'string' || !HEX128.test(sig.signature)) return 'not-a-change';
    if (!verify(message, sig.signature, sig.publicKey)) return 'not-signed';
    if (seen.has(sig.publicKey)) return 'twice-by-one-seat';
    seen.add(sig.publicKey);
  }
  return null;
};

/** A member's device: how many distinct seats it believes, not retired, signed `message`, when every signature verifies. */
export const quorumOf = (
  seats: readonly DirectorySeat[], message: string, signatures: readonly SeatSignature[], counts: (seat: DirectorySeat) => boolean,
): number | SignaturesRefusal => {
  const bad = signaturesRefusal(message, signatures);
  if (bad !== null) return bad;
  /* One wallet is one vote: two entries under one committee key count once. */
  const wallets = new Set<string>();
  let n = 0;
  for (const sig of signatures) {
    const seat = seats.find((x) => x.signingKey === sig.publicKey);
    const wallet = seat === undefined ? '' : seat.committeeKey === undefined ? `filing:${seat.signingKey}`
      : `${seat.committeeKey.tag}:${seat.committeeKey.value.toLowerCase()}`;
    if (seat !== undefined && seat.retired === null && counts(seat) && !wallets.has(wallet)) { wallets.add(wallet); n += 1; }
  }
  return n;
};

/** Whether a read of who holds the account carries a seat bar the chain could hold: a whole number, at least one. */
export const barReadable = (held: { readonly seatBar?: number }): boolean => Number.isSafeInteger(held.seatBar) && (held.seatBar as number) >= 1;
