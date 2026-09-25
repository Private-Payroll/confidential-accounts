import { sha256 } from '@noble/hashes/sha2.js';
import { checkShieldedAddress } from '../wallet/address-shape.js';
import { NETWORKS } from '../wallet/network.js';

/**
 * **WHETHER A WALLET HOLDS AN ADDRESS, TOLD WITHOUT NAMING ONE.**
 *
 * A page that opened a payslip knows the shielded address the payment went to,
 * but only after the wallet has released the key the slip is sealed under - so
 * the ask that releases the key cannot name it. Instead the release carries,
 * for every shielded address of every account the wallet offers, a digest of
 * that address under the ask it answers: the ask's nonce, the origin the wallet
 * observed, and the company the key is for. Once the slips are open the page
 * computes the same digest over each slip's address, under its own origin, its
 * own nonce and the company it asked about, and looks for it in the list. A
 * match says this wallet holds that address; no match says nothing.
 *
 * **ONE FUNCTION, CALLED BY BOTH SIDES.** The wallet builds the list with
 * `heldAddressList` and the page checks with `listHolds`; both reach
 * `heldAddressDigest`, and nothing else computes one. A second copy on either
 * side would be a list that matches nothing, which reads as "cannot tell" for
 * every slip and is never noticed.
 *
 * **OVER THE ADDRESS'S BYTES, NOT ITS TEXT.** An address is decoded by
 * `checkShieldedAddress`, the platform's own decode without its ledger import,
 * pinned against `payeeAddress()` by `address-shape.test.ts`, and the digest is
 * taken over its network and its two thirty-two-byte keys. Two spellings of one
 * address are one digest, and a string that is not a shielded address is no
 * digest at all.
 *
 * **WHAT THE LIST TELLS A PAGE.** For an address the page already has, whether
 * this wallet holds it; for anything else, nothing. The list is always
 * `HELD_ADDRESS_SLOTS` long and sorted, so neither its length nor the order of
 * the accounts is told. The origin and the company are in every digest, so two
 * sites, or one site asking about two companies, get digests that cannot be
 * compared even if they send the same nonce. The wallet does not enforce that
 * a nonce is fresh: one site that repeats a nonce for one company gets the same
 * digests each time, and can tell two answers came from one wallet - which that
 * site already knows from the key it is given.
 */

/**
 * How long every list is, whatever the wallet holds. A wallet offering more
 * receiving addresses than this cannot release a key at all (`heldAddressList`
 * throws), so raise this before the wallet's accounts grow past it.
 */
export const HELD_ADDRESS_SLOTS = 16;

const DOMAIN = new TextEncoder().encode('midnight-identity/held-address/v1');
const KEY_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/u;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../gu) ?? [], (pair) => parseInt(pair, 16));

/**
 * The ask a list answers: what binds every digest in it to one question from
 * one site about one company. The wallet takes all three off the parsed ask;
 * the page takes all three from itself.
 */
export interface HeldScope {
  readonly nonce: string;
  readonly origin: string;
  readonly company: string;
}

/** A shielded address as bytes: its network, then who may spend, then who may read. `null` if it is not one. */
const addressBytes = (address: string): { network: string; keys: Uint8Array } | null => {
  for (const network of NETWORKS) {
    try {
      const checked = checkShieldedAddress(address, network);
      return {
        network: checked.network,
        keys: Uint8Array.from([...fromHex(checked.coinPublicKey), ...fromHex(checked.encryptionPublicKey)]),
      };
    } catch {
      /* not an address of this network; the next is asked */
    }
  }
  return null;
};

const lengthPrefixed = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

/**
 * THE DIGEST. Sixty-four lower-case hex characters, or `null` when the address
 * is not a shielded address on any network. The company is folded to lower
 * case, the one spelling a company address has.
 */
export function heldAddressDigest(scope: HeldScope, address: string): string | null {
  const decoded = addressBytes(address);
  if (decoded === null || decoded.keys.length !== KEY_BYTES * 2) return null;
  const text = (t: string) => lengthPrefixed(new TextEncoder().encode(t));
  const parts = [
    DOMAIN,
    text(scope.nonce),
    text(scope.origin),
    text(scope.company.toLowerCase()),
    text(decoded.network),
    decoded.keys,
  ];
  const input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { input.set(p, at); at += p.length; }
  return hex(sha256(input));
}

/**
 * THE WALLET'S SIDE. Every address it holds, as a digest under this ask, with
 * random filler to `HELD_ADDRESS_SLOTS`, sorted. An address that is not a
 * shielded address is left out rather than refused: the list still says
 * everything true it can.
 */
export function heldAddressList(
  scope: HeldScope, addresses: readonly string[],
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string[] {
  const digests = [...new Set(addresses
    .map((a) => heldAddressDigest(scope, a))
    .filter((d): d is string => d !== null))];
  if (digests.length > HELD_ADDRESS_SLOTS) {
    throw new Error(`a wallet answers for at most ${HELD_ADDRESS_SLOTS} addresses, and this one holds ${digests.length}.`);
  }
  const filler = Array.from({ length: HELD_ADDRESS_SLOTS - digests.length }, () => hex(random(KEY_BYTES)));
  return [...digests, ...filler].sort();
}

/** A list as the page reads one back: exactly `HELD_ADDRESS_SLOTS` digests, or `null`. */
export function readHeldAddressList(said: unknown): readonly string[] | null {
  if (!Array.isArray(said) || said.length !== HELD_ADDRESS_SLOTS) return null;
  if (!said.every((d) => typeof d === 'string' && HEX64.test(d))) return null;
  return Object.freeze([...said] as string[]);
}

/**
 * THE PAGE'S SIDE. Whether the list says the wallet holds `address`. `false`
 * covers every way of not knowing: an address that does not decode, and one
 * the list does not hold.
 */
export function listHolds(list: readonly string[], scope: HeldScope, address: string): boolean {
  const digest = heldAddressDigest(scope, address);
  return digest !== null && list.includes(digest);
}
