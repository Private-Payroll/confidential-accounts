/**
 * **THE PROOF THAT A WAITING SIGNER'S KEY CAME FROM THE PERSON WHO WAS INVITED.**
 *
 * A person accepting a signer invitation sends their public keys and their
 * leaf into the company's inbox, which is sealed to a public key anybody may
 * seal to. That is what lets somebody with no access write into it at all - and
 * it is also what lets anybody who can write to the store replace what they
 * sent with keys of their own. Opening the inbox tells a signer what is in it,
 * not who put it there.
 *
 * ── WHAT THE KEY IS AUTHENTICATED BY ────────────────────────────────────────
 *
 * A secret made for this one invitation on the inviting signer's device:
 *
 *     invitationSecret = HMAC(viewing key, company, nonce, name, role)
 *
 * The nonce is fresh for every invitation. The secret travels to the invitee
 * in the FRAGMENT of their link, beside the token, and a fragment is never sent
 * to a server. On accepting, the invitee's device uses it to authenticate
 * exactly what it sends:
 *
 *     proof = HMAC(invitationSecret, company, signing key, wrapping key, leaf)
 *
 * and sends the nonce and the proof - never the secret. Every signer's device
 * holds the viewing key, so each one works the secret out again from the nonce,
 * the name and the role, and refuses a waiting signer whose proof does not
 * match before it raises, approves or carries out anything.
 *
 * ── WHAT THAT RESTS ON, AND WHAT IT DOES NOT COVER ──────────────────────────
 *
 *  - It rests on the viewing key. Somebody who can write to the store and does
 *    not hold that key cannot work out any invitation's secret, so cannot make
 *    a proof for a key of their own. The service is handed the viewing key
 *    when a signer asks it to prepare a governed call, so a service that KEPT
 *    it could make a passing proof; the same is already true of every record
 *    sealed under that key, and this does not change it.
 *  - The name and the role are part of the secret, so a waiting signer whose
 *    role was changed in the inbox is refused too.
 *  - Whoever holds the link holds the invitation. That was already true of the
 *    token, and the secret beside it does not make it worse.
 *  - A secret is worked out under the viewing key that was current when the
 *    invitation was made. If the company changes its viewing key before the
 *    seat is granted, the waiting signer is refused and has to be invited again.
 *    That fails closed, deliberately: a person removed from the company still
 *    holds the old key.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonical, fromHex, randomBytes, toHex, utf8, type Hex } from './crypto.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** What an invitee's device sends beside its keys. The secret is not in it. */
export interface SeatProof {
  nonce: Hex;
  proof: Hex;
}

/** The public parts an invitee sends, which the proof covers. */
export interface SeatKeys {
  signingPublicKey: Hex;
  wrappingPublicKey: Hex;
  leafCommitment: Hex;
}

/** What the invitee's link carries in its fragment, beside the token. */
export interface SeatInvitation {
  accountId: string;
  nonce: Hex;
  secret: Hex;
}

/** The invitation's secret, from the viewing key. Only a holder of that key can work it out. */
export function invitationSecret(
  viewingKey: Hex, accountId: string, nonce: Hex, name: string, role: string,
): Hex {
  return toHex(hmac(sha256, fromHex(viewingKey), utf8(canonical({
    purpose: 'signer-invitation', accountId, nonce, name, role,
  }))));
}

/** A new invitation's nonce and secret, made on the inviting signer's device. */
export function newSeatInvitation(
  viewingKey: Hex, accountId: string, name: string, role: string,
): SeatInvitation {
  const nonce = toHex(randomBytes(32));
  return { accountId, nonce, secret: invitationSecret(viewingKey, accountId, nonce, name, role) };
}

const proofOver = (secret: Hex, accountId: string, keys: SeatKeys): Hex =>
  toHex(hmac(sha256, fromHex(secret), utf8(canonical({
    purpose: 'signer-invitation-keys', accountId,
    signingPublicKey: keys.signingPublicKey.toLowerCase(),
    wrappingPublicKey: keys.wrappingPublicKey.toLowerCase(),
    leafCommitment: keys.leafCommitment.toLowerCase(),
  }))));

/** Made on the invitee's device, over exactly the keys it sends. */
export function proveSeatKeys(invitation: SeatInvitation, keys: SeatKeys): SeatProof {
  return { nonce: invitation.nonce, proof: proofOver(invitation.secret, invitation.accountId, keys) };
}

/** A waiting signer whose keys do not carry the invitee's proof. */
export class SeatKeyNotFromTheInvitee extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'SeatKeyNotFromTheInvitee';
  }
}

const sameHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/**
 * **CHECKED ON EVERY SIGNER'S DEVICE BEFORE A SEAT IS RAISED, APPROVED OR
 * CARRIED OUT.** Throws `SeatKeyNotFromTheInvitee`, naming what is wrong.
 */
export function refuseASeatKeyNotFromTheInvitee(
  viewingKey: Hex,
  accountId: string,
  waiting: SeatKeys & { name: string; role: string; seatProof?: unknown },
): void {
  const given = waiting.seatProof as Partial<SeatProof> | undefined;
  const refused = 'This person\'s keys could not be confirmed as coming from the person you invited. They may have '
    + 'been swapped, or the company\'s keys changed after the invitation was sent. Access was not granted and nothing '
    + 'was sent. Do not give this person access: they need a new invitation, and this page cannot yet withdraw the '
    + 'old one.';
  if (!given || typeof given.nonce !== 'string' || typeof given.proof !== 'string'
    || !HEX64.test(given.nonce) || !HEX64.test(given.proof.toLowerCase())) {
    throw new SeatKeyNotFromTheInvitee(refused);
  }
  const secret = invitationSecret(viewingKey, accountId, given.nonce, waiting.name, waiting.role);
  if (!sameHex(proofOver(secret, accountId, waiting), given.proof.toLowerCase())) {
    throw new SeatKeyNotFromTheInvitee(refused);
  }
}

/* ── THE LINK ───────────────────────────────────────────────────────────── */

const FRAGMENT = /^([^.]+)\.([^.]+)\.([0-9a-f]{64})\.([0-9a-f]{64})$/;

/**
 * The fragment of a signer's link, before it is escaped for the link: the
 * token, the company, the nonce and the secret, joined by dots. Neither a token
 * nor a company's id contains one.
 */
export const seatInvitationFragment = (token: string, invitation: SeatInvitation): string =>
  [token, invitation.accountId, invitation.nonce, invitation.secret].join('.');

/** Reads a signer's fragment back, already unescaped, or null when it is not one. */
export function seatInvitationFromFragment(
  fragment: string,
): { token: string; invitation: SeatInvitation } | null {
  const m = FRAGMENT.exec(fragment.trim());
  if (!m) return null;
  return { token: m[1]!, invitation: { accountId: m[2]!, nonce: m[3]!, secret: m[4]! } };
}
