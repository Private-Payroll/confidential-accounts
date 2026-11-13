/**
 * **A PERSON WAITING FOR A SEAT, AS THE COMPANY'S INBOX HOLDS THEM.**
 *
 * The record the service keeps for a seat request, and what its sealed box holds once a holder of the company's
 * viewing key opens it. Written by someone who holds no key, so every field is checked by each signer's device
 * before it is believed.
 */
import type { Hex, Sealed } from './crypto.js';
import type { SignedSeatInvitation } from './invitation.js';
import type { Role } from './roles.js';
import type { SeatOpening } from './seat-opening.js';
import type { SeatAddress } from './seat-address.js';

/**
 * A signer who has accepted an invite and is waiting to be granted access.
 *
 * THIS RECORD IS WRITTEN BY SOMEBODY WHO HOLDS NO VIEWING KEY, and that is the
 * whole reason it exists rather than being a row in the sealed roster. The
 * invitee must see nothing until an existing signer grants them access, so they
 * cannot be handed the key that would let them write themselves into it.
 *
 * So it is a drop box. The public halves — including `leafCommitment` — are
 * sealed to the ACCOUNT'S INBOX public key, whose secret is derived from the
 * viewing key. Anyone may post; only a key holder may read.
 *
 * `leafCommitment` is NOT left in the clear here, and that is a departure from
 * the "public halves only" sketch in the handover, because the obvious design
 * gets it wrong. The leaf is a public value and alone it identifies nobody —
 * but `userId` below points at a `User` row holding a real name and email, so a
 * plaintext leaf beside it reconstructs exactly the leaf-to-person mapping the
 * on-chain blinding exists to prevent (decision 0003). One join is not
 * meaningfully harder than one column, and the rule is that the pairing must
 * not be readable — not that it must not share a row.
 */
export interface PendingSigner {
  id: string;
  /**
   * Outside the envelope, and the same exposure as `memberUserIds`: an opaque id
   * saying this user is waiting on this account. Needed with no key at all, to
   * refuse a second seat to someone who already holds one.
   */
  userId: string | null;
  createdAt: string;
  /** name, role, signingPublicKey, wrappingPublicKey, leafCommitment. */
  sealed: { ephemeral: Hex } & Sealed;
}

/** What a pending signer's drop box holds, once a key holder opens it. */
export interface PendingSignerPayload {
  name: string;
  role: Role;
  signingPublicKey: Hex;
  wrappingPublicKey: Hex;
  leafCommitment: Hex;
  /**
   * The invitee's proof that these keys are theirs, made with a secret that
   * reached them in their link and never reached this service. Every signer's
   * device checks it before giving this person access; see
   * `seat-invite-proof.ts`. Absent means refused there, not trusted.
   */
  seatProof?: { nonce: Hex; proof: Hex };
  /**
   * **THE SIGN-IN THIS SEAT REQUEST IS FOR**, sealed with it: the joiner's own,
   * from the device that accepted a link, or the one their own wallet signed
   * into the code a seat pasted. The device that seats them holds the sign-in
   * the company would make a member to it. Absent is refused there.
   */
  person?: string;
  /**
   * **THE JOINER'S OPENING OF THE LEAF ABOVE**: the wallet key and salt its
   * blinding is made from (`newSeatKeys`). It is not a second copy of the
   * wallet key: it is what the leaf commits to, so every approving device sees
   * the leaf is made for that wallet before it approves it
   * (`walletKeyProvedBy`). Sealed to the company's inbox with the rest, so only
   * a holder of the company's viewing key opens it. Absent is refused there.
   */
  opening?: SeatOpening;
  /**
   * **WHO THE SEAT IS FOR, AS THE SEAT THAT INVITED SIGNED IT**, copied from
   * the offer the joiner opened, or made by the seat that pasted their code.
   * Every approving device holds this request to it: its person, name, role and,
   * for a code, its leaf. Absent is refused there.
   */
  invited?: SignedSeatInvitation;
  /**
   * **THE ADDRESS THE JOINER TAKES THE SEAT WITH**: their wallet's coin public
   * key and an address salt, signed under the wallet key `opening` names, and
   * the address they make (`seatAddressSignedFor`, which checks the signature
   * and, where it is given the account's function, works the address out
   * again). A proposal to seat this request must name exactly this address, or
   * the chain would seat whoever holds the one it names. Absent is refused on
   * the link and code paths.
   */
  seatAddress?: SeatAddress;
}
