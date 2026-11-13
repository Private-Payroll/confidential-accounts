/**
 * A joiner's wallet, for the tests that seat a person who joined by a link or a code: the wallet key their seat's leaf
 * commits to, and the address that wallet takes the seat with, made from a coin key and salt of its own and signed
 * for the company and the leaf it is asked for, as the person's own wallet signs it.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import type { CommitmentScheme } from '../core/ledger.js';
import { signSeatAddress, type SeatAddress } from '../core/seat-address.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { anAddress } from './an-invitee.js';

export interface AJoinersWallet {
  /** The wallet key the seat's leaf commits to, the public half of `secret`. */
  readonly walletKey: { readonly tag: 'schnorr'; readonly value: string };
  /** The address the wallet takes the seat with, its coin key's secret and the salt that hides it. */
  readonly at: ReturnType<typeof anAddress>;
  /** What the account rebuilds the address from when the wallet takes the seat: its coin key and the salt. */
  readonly holds: { readonly coinPublicKey: string; readonly addressSalt: string };
  /** The wallet signs its own coin key and salt, and the address they make, for the seat `leaf` in the company `accountId`. */
  readonly seatAddress: (company: { readonly accountId: string }, leaf: Hex) => Promise<SeatAddress>;
}

/**
 * The wallet whose signing key for the company is `secret` (thirty-two bytes of hex; a person's committee signing key
 * for the company's label), holding the address worked out from `seed` (`anAddress`) under the account's functions
 * `commitments`.
 */
export function aJoinersWallet(
  secret: Hex, seed: number, commitments: CommitmentScheme = MidnightCommitments,
): AJoinersWallet {
  const at = anAddress(commitments, seed);
  const coinPublicKey = commitments.coinPublicKeyOf(at.coinSecretKey);
  return {
    walletKey: { tag: 'schnorr', value: toHex(schnorr.getPublicKey(fromHex(secret.toLowerCase() as Hex))).toLowerCase() },
    at,
    holds: { coinPublicKey, addressSalt: at.addressSalt },
    seatAddress: async (company, leaf) => signSeatAddress(secret, company.accountId, leaf, { coinPublicKey, salt: at.addressSalt },
      (c, salt) => commitments.inviteAddressOf(c, salt)),
  };
}

/** A fresh signing key for a joiner's wallet, for a test that has no person's identity to derive one from. */
export const aWalletSecret = (): Hex => toHex(schnorr.utils.randomSecretKey()).toLowerCase() as Hex;
