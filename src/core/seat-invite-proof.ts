/**
 * **THE PROOF THAT A WAITING SIGNER'S KEY CAME FROM THE PERSON WHO WAS INVITED.**
 *
 * A person accepting a signer invitation sends their public keys and their
 * leaf into the company's inbox, which is sealed to a public key anybody may
 * seal to. That is what lets somebody with no access write into it at all, and
 * it is also what lets anybody who can write to the store replace what they
 * sent with keys of their own. Opening the inbox tells a signer what is in it,
 * not who put it there.
 *
 * ── WHAT THE KEY IS AUTHENTICATED BY ────────────────────────────────────────
 *
 * A secret made for this one invitation on the inviting signer's device:
 *
 *     invitationSecret = HMAC(company key, company, nonce, name, role, invitation id)
 *
 * The nonce is fresh for every invitation. The secret travels to the invitee
 * inside the invitation's offer, sealed under a key made from the link's token;
 * the token sits after the `#` of the link, which a browser never sends to a
 * server, and the service is given only values hashed from it. On accepting,
 * the invitee's device uses the secret to authenticate exactly what it sends,
 * for whom and under which invitation:
 *
 *     proof = HMAC(invitationSecret, company, person, invitation id,
 *                  signing key, wrapping key, leaf)
 *
 * and sends the nonce and the proof, never the secret. Every signer's device
 * holds the company key, so each one works the secret out again from the nonce,
 * the name, the role and the invitation id its signed invitation carries, reads
 * the person from the request itself, and refuses a waiting signer whose proof does not match
 * before it raises, approves or carries out anything.
 *
 * ── WHAT THAT RESTS ON, AND WHAT IT DOES NOT COVER ──────────────────────────
 *
 *  - It rests on the company key. Somebody who can write to the store and does
 *    not hold that key cannot work out any invitation's secret, so cannot make
 *    a proof for a key of their own. No device hands the service that key, so
 *    the service cannot make one either. Anybody who holds the key can, which
 *    is why a request is also held to the invitation a seat signed for it.
 *  - The name and the role are part of the secret, so a waiting signer whose
 *    role was changed in the inbox is refused too.
 *  - The invitation id is part of the secret, and the person and the invitation
 *    id are part of the proof, so neither a secret nor a proof made for one
 *    invitation, nor a proof made for one sign-in, seats anybody under another.
 *  - Whoever holds the link holds the invitation. That was already true of the
 *    token, and the secret behind it does not make it worse.
 *  - A secret is worked out under the company key that was current when the
 *    invitation was made, and the request is sealed to the inbox of that same
 *    key. So the proof is checked under the key whose inbox opened the request.
 *    After the company changes its key, a request sealed to the old inbox is
 *    believed only when the change named it as waiting; any other is refused
 *    and the person is invited again. A person removed from the company still
 *    holds the old key, so a proof made with it alone seats nobody.
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

/** What the invitation's offer carries for the invitee, sealed under the link's token. */
export interface SeatInvitation {
  accountId: string;
  nonce: Hex;
  secret: Hex;
}

/** The invitation's secret, from the company key and the invitation's id. Only a holder of that key can work it out. */
export function invitationSecret(
  viewingKey: Hex, accountId: string, nonce: Hex, name: string, role: string, invitationId: Hex,
): Hex {
  return toHex(hmac(sha256, fromHex(viewingKey), utf8(canonical({
    purpose: 'signer-invitation', accountId, nonce, name, role, invitation: invitationId.toLowerCase(),
  }))));
}

/** A new invitation's nonce and secret, made on the inviting signer's device once the invitation's id is known. */
export function newSeatInvitation(
  viewingKey: Hex, accountId: string, name: string, role: string, invitationId: Hex,
): SeatInvitation {
  const nonce = toHex(randomBytes(32));
  return { accountId, nonce, secret: invitationSecret(viewingKey, accountId, nonce, name, role, invitationId) };
}

/** Who the keys are for and under which invitation: the sign-in the request is sealed for, and the invitation's id. */
export interface SeatProofFor {
  readonly person: string;
  readonly invitationId: Hex;
}

const proofOver = (secret: Hex, accountId: string, keys: SeatKeys, bound: SeatProofFor): Hex =>
  toHex(hmac(sha256, fromHex(secret), utf8(canonical({
    purpose: 'signer-invitation-keys', accountId,
    person: bound.person,
    invitation: bound.invitationId.toLowerCase(),
    signingPublicKey: keys.signingPublicKey.toLowerCase(),
    wrappingPublicKey: keys.wrappingPublicKey.toLowerCase(),
    leafCommitment: keys.leafCommitment.toLowerCase(),
  }))));

/** Made on the invitee's device, over exactly the keys it sends, the sign-in they are for and the invitation they answer. */
export function proveSeatKeys(invitation: SeatInvitation, keys: SeatKeys, bound: SeatProofFor): SeatProof {
  return { nonce: invitation.nonce, proof: proofOver(invitation.secret, invitation.accountId, keys, bound) };
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

const fieldOf = (x: unknown, name: string): unknown => (typeof x === 'object' && x !== null ? Reflect.get(x, name) : undefined);

/**
 * The sign-in and the invitation id a waiting request names: its own `person`, and the invitation id in the terms the
 * inviting seat signed. Null when either is missing, so a request that names neither is refused, never trusted.
 */
const boundIn = (waiting: { readonly person?: unknown; readonly invited?: unknown }): SeatProofFor | null => {
  const person = waiting.person;
  const invitationId = fieldOf(fieldOf(waiting.invited, 'terms'), 'invitation');
  if (typeof person !== 'string' || person === '' || typeof invitationId !== 'string' || !HEX64.test(invitationId.toLowerCase())) return null;
  return { person, invitationId: invitationId.toLowerCase() as Hex };
};

/**
 * **CHECKED ON EVERY SIGNER'S DEVICE BEFORE A SEAT IS RAISED, APPROVED OR
 * CARRIED OUT.** `viewingKey` is the company key whose inbox the request opened
 * under: the invitation's secret was made under that same key. The proof must
 * cover the request's own keys, the sign-in it names and the invitation id its
 * signed invitation carries. Throws `SeatKeyNotFromTheInvitee` otherwise.
 */
export function refuseASeatKeyNotFromTheInvitee(
  viewingKey: Hex,
  accountId: string,
  waiting: SeatKeys & { name: string; role: string; seatProof?: unknown; person?: unknown; invited?: unknown },
): void {
  const given = waiting.seatProof as Partial<SeatProof> | undefined;
  const refused = 'This person\'s keys could not be confirmed as coming from the person you invited. They may have '
    + 'been swapped, or the company\'s keys changed after the invitation was sent. Access was not granted and nothing '
    + 'was sent. Do not give this person access: withdraw this request and invite them again.';
  const bound = boundIn(waiting);
  if (!given || typeof given.nonce !== 'string' || typeof given.proof !== 'string'
    || !HEX64.test(given.nonce) || !HEX64.test(given.proof.toLowerCase()) || bound === null) {
    throw new SeatKeyNotFromTheInvitee(refused);
  }
  const secret = invitationSecret(viewingKey, accountId, given.nonce, waiting.name, waiting.role, bound.invitationId);
  if (!sameHex(proofOver(secret, accountId, waiting, bound), given.proof.toLowerCase())) {
    throw new SeatKeyNotFromTheInvitee(refused);
  }
}
