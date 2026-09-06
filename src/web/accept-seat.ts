/**
 * **ACCEPTING A SEAT, AS A FUNCTION A TEST CAN DRIVE.** `C329`, `C328`,
 *
 *
 * ── WHY THIS IS NOT STILL A CLOSURE INSIDE A SCREEN ──────────────────────
 *
 * It was. `src/web/App.tsx` has no test file, so the whole of `C329`'s
 * premise — **that the material is durable before the leaf is published** —
 * lived in the order of two lines nothing could execute, and the leaf that path
 * writes was the second of `C328`'s two wrong writers with no guard of any
 * kind. `S34`'s test-coverage pass measured both: restoring the old ed25519 writer
 * at that line left 187 tests green.
 *
 * A source pin is not the answer — `S34` deleted the last one, because a pin
 * cannot see semantics and its own round's auditor defeated it three ways with
 * the text intact. So the sequence moved out of the screen instead, whole, and
 * `src/web/accept-seat.test.ts` drives it. What is left in `App.tsx` is the
 * four doors and the call.
 *
 * ── THE ORDER IS THE POINT AND IT IS THE THING TESTED ────────────────────
 *
 *   1. make the key material
 *   2. compute the leaf FROM it, through `storedSignerLeaf` — the one
 *      definition every writer shares
 *   3. SEAL it, so it is durable
 *   4. publish the leaf
 *   5. promote the sealed material to the seat the server named
 *
 * Nothing that is not durable reaches a roster. If 3 refuses, no leaf has left
 * this machine. If 5 refuses, the material is already sealed and the seat can
 * be finished later by `finishPendingSeat`, which proves the seat carries this
 * device's own public key before it binds anything.
 */
import type { Hex } from '../core/crypto.js';
import { storedSignerLeaf, type LeafScheme } from '../core/signer-leaf.js';
import type { PendingSeat } from './keyring.js';

/** The keys a new seat is made of. Public halves leave; the rest never does. */
export interface NewSeatKeys {
  signingSecret: Hex;
  signingPublicKey: Hex;
  wrappingSecret: Hex;
  wrappingPublicKey: Hex;
  blinding: Hex;
}

/** What this function is allowed to do, and nothing else. */
export interface SeatDoors {
  /** Three secrets, generated where the randomness is. */
  newKeys(): NewSeatKeys;
  /** Makes the material durable. Step 3. */
  seal(seat: PendingSeat): Promise<void>;
  /**
   * Hands the SERVER the public halves and the leaf. Step 4.
   *
   * **THE BLINDING IS NOT A PARAMETER AND MUST NEVER BECOME ONE.** M-106,
   * decision 0003: it briefly travelled, and the server has had no field to put
   * it in since. The type is the promise.
   */
  publish(payload: {
    signingPublicKey: Hex; wrappingPublicKey: Hex; leafCommitment: Hex;
  }): Promise<{ id: string }>;
  /** Binds the sealed material to the seat the server named. Step 5. */
  promote(signingPublicKey: Hex, signerId: string): Promise<void>;
}

export interface AcceptedSeat {
  signerId: string;
  /** Shown once, so an invitee can carry it to their own device. */
  wrappingSecret: Hex;
}

export async function acceptSeatOnThisDevice(
  accountId: string,
  commitments: LeafScheme,
  doors: SeatDoors,
): Promise<AcceptedSeat> {
  const keys = doors.newKeys();
  /*
   * Read once from the scheme and used for both the leaf and the material that
   * has to reproduce it. The scope is the leaf's third argument, it
   * lives on the device because that is where the circuit's witness reads it,
   * and a writer that took it from somewhere else is a seat nobody can prove.
   */
  const scope = commitments.allVaults();
  const seat: PendingSeat = {
    accountId,
    signingPublicKey: keys.signingPublicKey,
    signingSecret: keys.signingSecret,
    wrappingSecret: keys.wrappingSecret,
    blinding: keys.blinding,
    scope,
  };

  /*
   * **THE LEAF, FROM THE SECRET AND NOT FROM THE CURVE.**
   *
   * This line passed `sk.publicKey` — the raw ed25519 key — while the
   * contract's `requireSigner()` looks in the tree for a leaf over
   * `signerPublicKey(sk)`, a domain-separated hash of the SECRET. Different,
   * uncorrelated 32 bytes, so the seat this path created was one its own device
   * could never prove. `storedSignerLeaf` is the one definition, shared with
   * `AccountService.create` and with the check that reads it back.
   */
  const leafCommitment = storedSignerLeaf(seat, commitments);

  /* Durable BEFORE published. The whole of `C329` is this order. */
  await doors.seal(seat);

  const signer = await doors.publish({
    signingPublicKey: keys.signingPublicKey,
    wrappingPublicKey: keys.wrappingPublicKey,
    leafCommitment,
  });

  await doors.promote(keys.signingPublicKey, signer.id);
  return { signerId: signer.id, wrappingSecret: keys.wrappingSecret };
}
