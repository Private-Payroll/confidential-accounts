/**
 * **THE ADDRESS A PERSON WHO JOINED BY A LINK OR A CODE TAKES THEIR SEAT WITH, SIGNED BY THEIR OWN WALLET.**
 *
 * The chain seats whoever proves the coin secret behind the address a proposal to add a seat names, so on the link
 * and code paths that address must be the joiner's, never one the raising seat chose. The joiner's wallet signs its
 * own coin public key and an address salt, with this company and the leaf it asks to be seated with, under the wallet
 * key its seat's opening names; the address is worked out here from that coin key and salt (`inviteAddressOf`), never
 * taken from anybody. Every device that reads it checks the signature against that opening, which it already holds to
 * the leaf, and works the address out again from the coin key, so a proposal naming any other address is refused.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, type Hex } from './crypto.js';
import type { WalletKey } from './seat-opening.js';

const SIGNED_TAG = 'confidential-accounts/seat-address/v2';
const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;

/** The account's own function making an address from a coin public key and a salt, as the chain makes it. */
export type InviteAddressOf = (coinPublicKey: Hex, salt: Hex) => Hex;

/**
 * The address a joiner takes their seat with: the coin public key it is made from, the salt that hides it, the address
 * those make, and their wallet's signature over all of them.
 */
export interface SeatAddress {
  readonly coinPublicKey: Hex;
  readonly address: Hex;
  readonly salt: Hex;
  readonly signature: Hex;
}

/** What the wallet signs: the company, the leaf asked for, the coin key, the address and its salt, all lower case. */
const seatAddressBytes = (accountId: string, leaf: string, coinPublicKey: string, address: string, salt: string): Uint8Array =>
  sha256(new TextEncoder().encode(JSON.stringify([
    SIGNED_TAG, accountId, leaf.toLowerCase(), coinPublicKey.toLowerCase(), address.toLowerCase(), salt.toLowerCase(),
  ])));

/**
 * The joiner's address for the seat `leaf` in the company `accountId`, made here from the wallet's own coin public key
 * and a salt (`inviteAddressOf`) and signed with the wallet's signing key for that company (`walletSecret`, the secret
 * half of the wallet key its seat's opening names). It takes no address: one handed to it could be anybody's.
 */
export const signSeatAddress = (
  walletSecret: Hex, accountId: string, leaf: string, own: { readonly coinPublicKey: string; readonly salt: string },
  inviteAddressOf: InviteAddressOf,
): SeatAddress => {
  const coinPublicKey = own.coinPublicKey.toLowerCase() as Hex;
  const salt = own.salt.toLowerCase() as Hex;
  const address = String(inviteAddressOf(coinPublicKey, salt)).toLowerCase() as Hex;
  const secret = fromHex(walletSecret.toLowerCase() as Hex);
  try {
    const signature = toHex(schnorr.sign(seatAddressBytes(accountId, leaf, coinPublicKey, address, salt), secret)).toLowerCase() as Hex;
    return Object.freeze({ coinPublicKey, address, salt, signature });
  } finally {
    secret.fill(0);
  }
};

/**
 * The address the wallet `walletKey` signed for the seat `leaf` in the company `accountId`, made from the coin key it
 * signed with it, or, when `signed` is not that, the reason: 'none' when there is no signed address, 'not-made' when
 * the coin key and salt do not make the address (`inviteAddressOf`), 'not-signed' when the signature does not hold.
 * A reading with no `inviteAddressOf` (null) holds the address to the signature alone; every device that raises,
 * confirms or approves the seat passes the account's own function and works the address out again.
 */
export const seatAddressSignedFor = (
  signed: { readonly coinPublicKey?: string; readonly address: string; readonly salt: string; readonly signature: string } | undefined,
  walletKey: WalletKey | undefined, accountId: string, leaf: string, inviteAddressOf: InviteAddressOf | null,
): SeatAddress | 'none' | 'not-made' | 'not-signed' => {
  if (signed === undefined) return 'none';
  if (walletKey === undefined || walletKey.tag !== 'schnorr') return 'not-signed';
  const [coin, address, salt, signature, key] = [signed.coinPublicKey, signed.address, signed.salt, signed.signature, walletKey.value]
    .map((x) => (typeof x === 'string' ? x.toLowerCase() : ''));
  if (!HEX64.test(coin!) || !HEX64.test(address!) || !HEX64.test(salt!)) return 'not-made';
  if (!HEX128.test(signature!) || !HEX64.test(key!)) return 'not-signed';
  if (inviteAddressOf !== null) {
    let made: string;
    try {
      made = String(inviteAddressOf(coin as Hex, salt as Hex)).toLowerCase();
    } catch {
      /* A coin key or salt the account's function cannot take makes no address: refused as not made from it. */
      return 'not-made';
    }
    if (made !== address) return 'not-made';
  }
  try {
    return schnorr.verify(fromHex(signature as Hex), seatAddressBytes(accountId, leaf, coin!, address!, salt!), fromHex(key as Hex))
      ? Object.freeze({ coinPublicKey: coin as Hex, address: address as Hex, salt: salt as Hex, signature: signature as Hex }) : 'not-signed';
  } catch {
    /* A key or signature the curve cannot read verifies nothing: refused as unsigned. */
    return 'not-signed';
  }
};

/**
 * Why an approving device refuses a seat whose request carries no address the person's own wallet signed for it, made
 * from the coin key it signed with it, and what clears it.
 */
export const NO_SIGNED_ADDRESS = 'The request of the person waiting does not carry an address their own wallet signed for this seat, '
  + 'made from that wallet\'s coin key, so nobody can be seated from it. Do not approve it: withdraw it. No wallet signs that address '
  + 'yet; that comes with joining by a link or a code in the wallet. Invite the person by their private address instead.';
