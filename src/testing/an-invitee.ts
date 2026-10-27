/**
 * An invited signer, for the tests that seat one on the in-memory ledger: the
 * wallet address they are invited at, the public half of the seat their device
 * makes, and the invitation the signers approve. Every test that seats a signer
 * through the service does it here, so a seat is always taken the one way the
 * account allows - by the invitee, on an approved invitation, from the address
 * it names.
 */
import { createHash } from 'node:crypto';
import type { Hex } from '../core/crypto.js';
import type { CommitmentScheme, InvitedSeat, TxRef } from '../core/ledger.js';
import type { SignerInvite } from '../core/account.js';

export interface Invitee {
  /** The coin secret key of the address they are invited at, and the salt that hides it. */
  readonly coinSecretKey: Hex;
  readonly addressSalt: Hex;
  /** The commitment to that address the inviter raises the invitation with. */
  readonly address: Hex;
  /** The public half of their seat, its blinding and its rights. */
  readonly signerPublicKey: Hex;
  readonly blinding: Hex;
  readonly scope: Hex;
  /** The leaf their seat will be, which their device hands over when they accept. */
  readonly leaf: Hex;
  /** What the inviter raises the invitation with. */
  readonly invite: SignerInvite;
}

const bytes = (label: string, seed: number): Hex =>
  createHash('sha256').update(`${label}:${seed}`).digest('hex') as Hex;

/** The wallet address an invitee is invited at, worked out from `seed`: its coin secret key, the salt, and the commitment the inviter makes. */
export function anAddress(commitments: CommitmentScheme, seed: number): Pick<Invitee, 'coinSecretKey' | 'addressSalt' | 'address'> {
  const coinSecretKey = bytes('a test invitee coin secret key', seed);
  const addressSalt = bytes('a test invitee address salt', seed);
  return { coinSecretKey, addressSalt, address: commitments.inviteAddressOf(commitments.coinPublicKeyOf(coinSecretKey), addressSalt) };
}

/** An invitee whose keys are worked out from `seed`, with every right on every vault unless `scope` says otherwise. */
export function anInvitee(commitments: CommitmentScheme, seed: number, scope: Hex = commitments.allVaults()): Invitee {
  const { coinSecretKey, addressSalt, address } = anAddress(commitments, seed);
  const signerPublicKey = bytes('a test invitee seat key', seed);
  const blinding = bytes('a test invitee blinding', seed);
  return {
    coinSecretKey, addressSalt, address, signerPublicKey, blinding, scope,
    leaf: commitments.signerLeaf(signerPublicKey, blinding, scope),
    invite: { address, scope },
  };
}

/** A ledger an invited person's wallet takes a seat on. */
export interface TakesAnInvitedSeat {
  seatInvited(accountId: string, seat: InvitedSeat): Promise<TxRef>;
}

/** The invitee takes the seat the approved invitation `proposalId` names. */
export function theInviteeTakesTheSeat(
  ledger: TakesAnInvitedSeat, accountId: string,
  invitee: Pick<Invitee, 'coinSecretKey' | 'addressSalt' | 'signerPublicKey' | 'blinding' | 'scope'>, proposalId: Hex,
): Promise<TxRef> {
  const seat: InvitedSeat = {
    proposalId, coinSecretKey: invitee.coinSecretKey, addressSalt: invitee.addressSalt,
    signerPublicKey: invitee.signerPublicKey, blinding: invitee.blinding, scope: invitee.scope,
  };
  return ledger.seatInvited(accountId, seat);
}
