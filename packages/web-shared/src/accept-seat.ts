/**
 * **ACCEPTING A SEAT, ON THE JOINER'S OWN DEVICE: THE ONE SEAT PATH EVERY WAY
 * OF JOINING USES**, a link's acceptance and a code alike.
 *
 * The order is the point, and it is what the tests drive:
 *
 *   1. make the key material, the blinding the hash of the person's own wallet
 *      key under a fresh salt (`newSeatBlinding`)
 *   2. compute the leaf FROM it, through `storedSignerLeaf` - the one
 *      definition every writer shares - and the seat's opening beside it
 *   3. SEAL it, so it is durable
 *   4. publish the leaf, its public keys and its opening
 *   5. promote the sealed material to the seat the service named
 *
 * Nothing that is not durable reaches a roster. If 3 refuses, no leaf has left
 * this machine. If 5 refuses, the material is already sealed and the seat can
 * be finished later by `finishPendingSeat`, which proves the seat carries this
 * device's own public key before it binds anything.
 */
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../src/core/crypto.js';
import { storedSignerLeaf, type LeafScheme } from '../../../src/core/signer-leaf.js';
import { newSeatBlinding, type SeatOpening, type WalletKey } from '../../../src/core/seat-opening.js';
import type { PendingSeat } from './keyring.js';
import { proveSeatKeys, type SeatInvitation, type SeatProof } from '../../../src/core/seat-invite-proof.js';

/** The keys a new seat is made of. Public halves leave; the rest never does. */
export interface NewSeatKeys {
  signingSecret: Hex;
  signingPublicKey: Hex;
  wrappingSecret: Hex;
  wrappingPublicKey: Hex;
  /** The hash of the wallet key the seat is made for under `salt` (`seatBlinding`). */
  blinding: Hex;
  /** Thirty-two fresh random bytes, made for this leaf alone. */
  salt: Hex;
}

/**
 * Two secrets and their public halves, made on this device, with a blinding
 * that commits the seat's leaf to `walletKey`, the person's own wallet key for
 * the company, under a salt made for this leaf alone.
 */
export function newSeatKeys(walletKey: WalletKey): NewSeatKeys {
  const sk = newSigningKeypair();
  const wk = newWrappingKeypair();
  const { salt, blinding } = newSeatBlinding(walletKey);
  return {
    signingSecret: sk.secret, signingPublicKey: sk.publicKey,
    wrappingSecret: wk.secret, wrappingPublicKey: wk.publicKey,
    blinding, salt,
  };
}

/** What this function is allowed to do, and nothing else. */
export interface SeatDoors {
  /** The seat's secrets for `walletKey`, generated where the randomness is. */
  newKeys(walletKey: WalletKey): NewSeatKeys;
  /** Makes the material durable. Step 3. */
  seal(seat: PendingSeat): Promise<void>;
  /**
   * Hands over the public halves, the leaf and the leaf's opening. Step 4.
   *
   * **THE OPENING GOES ONLY WHERE A MEMBER OPENS IT**: sealed to the company's
   * inbox in a seat request, or in the code the person's own wallet signed,
   * which already names their wallet key beside the leaf. It is what lets
   * every device that approves the seat see the leaf is made for this person's
   * wallet. The secrets are never a field.
   */
  publish(payload: {
    signingPublicKey: Hex; wrappingPublicKey: Hex; leafCommitment: Hex;
    /** The leaf's opening: the wallet key and salt its blinding is made from, with the public key and scope it is made over. */
    opening: SeatOpening;
    /** The nonce and the proof. The invitation's secret is not a field either. */
    seatProof?: SeatProof;
  }): Promise<{ id: string | null }>;
  /** Binds the sealed material to the seat the server named. Step 5. */
  promote(signingPublicKey: Hex, signerId: string): Promise<void>;
}

export interface AcceptedSeat {
  /**
   * The seat request the keys went out as; null when they went out in a code,
   * whose seat request somebody already in the company files when they paste
   * it. The material is sealed either way, and `finishPendingSeat` binds it to
   * its seat once that seat carries this device's own key.
   */
  signerId: string | null;
  /** Shown once, so an invitee can carry it to their own device. */
  wrappingSecret: Hex;
}

export async function acceptSeatOnThisDevice(
  accountId: string,
  commitments: LeafScheme,
  doors: SeatDoors,
  /** The person's own wallet key for the company, as their wallet gave it: the key the seat's leaf commits to. */
  walletKey: WalletKey,
  /**
   * What the invitee's link carried. With it, the keys go out with the proof
   * every signer's device asks for before it gives this person access; without
   * it they go out with none, and are refused there.
   */
  invitation?: SeatInvitation,
): Promise<AcceptedSeat> {
  if (invitation && invitation.accountId !== accountId) {
    throw new Error('this invitation is for a different company from the one being joined. Nothing was sent.');
  }
  const keys = doors.newKeys(walletKey);
  /*
   * Read once from the scheme and used for both the leaf and the material that
   * has to reproduce it. The scope is the leaf's third argument, it
   * lives on the device because that is where the circuit's witness reads it,
   * and a writer that took it from somewhere else is a seat nobody can prove.
   */
  const scope = commitments.allVaults();
  /* The seat's opening, kept with its secrets: what shows the company's members that the leaf was made for this wallet key. */
  const opening: SeatOpening = {
    publicKey: String(commitments.signerPublicKey(keys.signingSecret)).toLowerCase(),
    scope: String(scope).toLowerCase(), blinding: String(keys.blinding).toLowerCase(),
    walletKey: { tag: walletKey.tag, value: walletKey.value.toLowerCase() }, salt: String(keys.salt).toLowerCase(),
  };
  const seat: PendingSeat = {
    accountId,
    signingPublicKey: keys.signingPublicKey,
    signingSecret: keys.signingSecret,
    wrappingSecret: keys.wrappingSecret,
    blinding: keys.blinding,
    scope,
    opening,
  };

  /*
   * **THE LEAF, FROM THE SECRET AND NOT FROM THE CURVE.**
   *
   * The contract's `requireSigner()` looks in the tree for a leaf over
   * `signerPublicKey(sk)`, a domain-separated hash of the SECRET, never over
   * the raw ed25519 public key: a leaf made over that would be a seat its own
   * device could never prove. `storedSignerLeaf` is the one definition, shared
   * with `AccountService.create` and with the check that reads it back.
   */
  const leafCommitment = storedSignerLeaf(seat, commitments);

  /* Durable BEFORE published: a leaf that left this device with its material lost is a seat nobody can prove. */
  await doors.seal(seat);

  const published = {
    signingPublicKey: keys.signingPublicKey,
    wrappingPublicKey: keys.wrappingPublicKey,
    leafCommitment,
  };
  const signer = await doors.publish(invitation
    ? { ...published, opening, seatProof: proveSeatKeys(invitation, published) }
    : { ...published, opening });

  if (signer.id !== null) await doors.promote(keys.signingPublicKey, signer.id);
  return { signerId: signer.id, wrappingSecret: keys.wrappingSecret };
}
