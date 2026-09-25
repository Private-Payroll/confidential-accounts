import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import {
  MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import type { MoneyKey } from '../keys/derivation.js';
import type { NetworkName } from './network.js';

/**
 * WHERE SOMEBODY IS PAID — ONE VALUE, NEVER TWO FIELDS.
 *
 * Paying somebody on Midnight needs two 32-byte keys, and they are different
 * keys doing different jobs:
 *
 *   the COIN public key        who may SPEND it.
 *   the ENCRYPTION public key  who may READ about it. This is what makes the
 *                              payment appear in the payee's own wallet.
 *
 * THE FAILURE THIS TYPE EXISTS TO DELETE, because it is silent and it is the
 * worst kind:
 *
 *   no encryption key    the transaction cannot be built. The platform
 *                        protecting us, and the right failure.
 *   the WRONG one        the payment settles perfectly — correct amount,
 *                        correct recipient, on chain, irreversible — into a
 *                        coin the payee's wallet will NEVER show them.
 *
 * That asymmetry only exists because the two keys are two values that can
 * disagree. **Here they cannot.** An address is one Bech32m string, both halves
 * come out of one decode of it, and neither can be set alone. A wrong address
 * is then a wrong RECIPIENT — loud, ordinary, and nothing like paying the right
 * person into a coin they cannot see.
 *
 * NONE OF THE CRYPTOGRAPHY OR ENCODING HERE IS OURS. `ShieldedAddress` and its
 * `shield-addr` codec are the platform's, and are what a wallet itself hands
 * out.
 */

/*
 * The brand is a module-private unique symbol, so a `PayeeAddress` cannot be
 * written as an object literal ANYWHERE else — including in a test, which is
 * the point. A shape somebody can forge in a test is a shape they will forge in
 * a hurry in production.
 */
declare const payeeBrand: unique symbol;

export interface PayeeAddress {
  readonly [payeeBrand]: true;
  /** The one canonical value: what is stored, shown, pasted and compared. */
  readonly bech32: string;
  /** The network this address is FOR. Part of the string; kept for messages. */
  readonly network: NetworkName;
  /** Who may spend. 32 bytes of lowercase hex. Derived, never supplied. */
  readonly coinPublicKey: string;
  /** Who may read about it. Same decode as `coinPublicKey`. */
  readonly encryptionPublicKey: string;
}

export type AddressFailure =
  | 'empty'
  | 'not-an-address'
  | 'wrong-kind'
  | 'wrong-network';

export class AddressError extends Error {
  readonly code: AddressFailure;
  constructor(code: AddressFailure, message: string) {
    super(message);
    this.name = 'AddressError';
    this.code = code;
  }
}

/** Each of an address's two keys is this many bytes. */
const KEY_BYTES = 32;

const build = (
  address: ShieldedAddress, bech32: string, network: NetworkName,
): PayeeAddress => Object.freeze({
  bech32,
  network,
  /* One decode, both halves, one expression. This is the whole invariant. */
  coinPublicKey: address.coinPublicKey.toHexString(),
  encryptionPublicKey: address.encryptionPublicKey.toHexString(),
}) as PayeeAddress;

/**
 * THE WAY AN ADDRESS ENTERS FROM OUTSIDE: parsed, checked, never trusted.
 *
 * This is the path for somebody who already has their own wallet and wants
 * their salary paid there instead — they nominate it, and it becomes the
 * address every employer pays.
 *
 * Four things are checked. Three are the platform's own checks rather than
 * ours: the Bech32m checksum, so a typo does not decode; the address KIND, so a
 * coin-public-key-only string is refused; and the NETWORK, so a testnet address
 * handed to a mainnet payroll throws by name. The fourth is the LENGTH, which
 * the platform's decode does not check and the ledger does (below).
 *
 * `network` is required and deliberately not defaulted. An address is only
 * meaningful on one network, and a default is how a testnet address reaches a
 * mainnet payroll.
 *
 * ONE EXCEPTION IN THE PLATFORM, measured rather than assumed: **a mainnet
 * address has no network segment at all** — `mn_shield-addr1...`, not
 * `mn_shield-addr_mainnet1...`. The library also exports a `mainnet` symbol,
 * and passing the string `'mainnet'` produces byte-identical output, so nothing
 * here needs a special case. Cross-network is still refused in both directions.
 */
export function payeeAddress(bech32: string, network: NetworkName): PayeeAddress {
  const raw = (bech32 ?? '').trim();
  if (!raw) {
    throw new AddressError('empty', 'an address is required, and this one is empty.');
  }

  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(raw);
  } catch (e) {
    /* Names the value rather than repeating the library's message alone: the
     * one thing the reader needs is WHICH value was rejected. */
    throw new AddressError(
      'not-an-address',
      `"${raw}" is not a Midnight address: ${(e as Error).message}. `
      + 'One looks like mn_shield-addr_<network>1... and carries its own checksum, '
      + 'so a single mistyped character fails here.');
  }

  let address: ShieldedAddress;
  try {
    address = parsed.decode(ShieldedAddress, network);
  } catch (e) {
    const message = (e as Error).message;
    /*
     * The library reports both "this is the wrong kind of thing" and "this is
     * for another network" from the same call, and they are different problems
     * for the person: one is a mistake about what to paste, the other is a
     * mistake about where. Distinguished on the library's own words, and
     * `wrong-network` is the narrower guess, so anything unrecognised falls to
     * `wrong-kind` rather than being reported as a network mismatch that may
     * not be one.
     */
    const looksLikeNetwork = /network|expected .* address, got/iu.test(message);
    throw new AddressError(
      looksLikeNetwork ? 'wrong-network' : 'wrong-kind',
      looksLikeNetwork
        ? `"${raw}" is not an address for ${network}: ${message}.`
        : `"${raw}" is not a payee address: ${message}. It must be a shield-addr — `
          + 'a coin public key on its own is not enough to pay somebody, because it does '
          + 'not say who may READ the payment.');
  }

  /*
   * **THE LENGTH, WHICH THE PLATFORM'S DECODE DOES NOT CHECK.** Its codec takes
   * the first thirty-two bytes as the coin key and everything after them as the
   * encryption key, and the encryption key's constructor checks no length, so
   * a string of the right kind and network carrying thirty-two bytes and any
   * tail at all, including none, decodes, and the ledger then refuses what is
   * built to it. So it is refused here, before anything is built: an address is
   * two keys of thirty-two bytes, and nothing else.
   */
  if (parsed.data.length !== KEY_BYTES * 2) {
    throw new AddressError(
      'wrong-kind',
      `"${raw}" carries ${parsed.data.length} bytes and a payee address carries `
      + `${KEY_BYTES * 2} — ${KEY_BYTES} for the key that may spend and ${KEY_BYTES} for `
      + 'the key that may read.');
  }

  return build(address, parsed.asString(), network);
}

/**
 * THE ADDRESS THIS PERSON WAS GIVEN AT SIGN-UP, from their own money key.
 *
 * It takes a `MoneyKey`, which is a branded type, so an authority key cannot be
 * passed here. That matters more than it looks: an authority key encodes into a
 * perfectly valid address, and a salary paid to it lands in a coin the person's
 * own wallet never scans — because a shielded wallet is started with exactly
 * one key at account 0 index 0 and there is no gap-limit scan anywhere in the
 * SDK. The brand makes that a compile error.
 *
 * **It re-parses its own output**, so the value returned came out of a decode
 * exactly like every other one, and there is deliberately no way to make a
 * `PayeeAddress` that skipped it.
 *
 * NO TEST HOLDS THAT LAST SENTENCE AND NONE CAN, which is worth saying rather
 * than leaving as an unearned claim. Replacing the re-parse with the private
 * constructor is behaviour-identical here — the platform's encoder does not
 * produce strings its own parser rejects, and the canonical form it returns is
 * the string that went in. The value of the re-parse is structural: it is the
 * single door, so a future change that makes the encoder and the parser
 * disagree fails here rather than shipping an address nobody can pay.
 */
export function addressFor(zswapKey: MoneyKey, network: NetworkName): PayeeAddress {
  const keys = ZswapSecretKeys.fromSeed(zswapKey);
  const address = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(keys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(keys.encryptionPublicKey));
  return payeeAddress(MidnightBech32m.encode(network, address).asString(), network);
}

/** Two addresses are the same payee when they are the same value. */
export const samePayee = (a: PayeeAddress, b: PayeeAddress): boolean => a.bech32 === b.bech32;

/**
 * What a person sees when asked to check an address before money moves.
 *
 * Both ends are shown, because a truncation that shows only the start is
 * confirmed by anything with the right prefix — and every address on one
 * network shares its prefix.
 */
export const shortPayee = (a: PayeeAddress): string => {
  /*
   * THE HEAD SKIPS THE PART EVERY ADDRESS SHARES. The rule, amended.
   *
   * The first version took the first eighteen characters — and
   * `mn_shield-addr_testnet1` is twenty-three, so on every network with a name
   * segment the head was pure prefix and the person confirming an address
   * before money moved was comparing eight characters, six of them checksum.
   * Measured: two hundred distinct testnet addresses shared one head.
   *
   * So the bech32 separator is found and the payload shown from both ends.
   * Mainnet has no NETWORK segment, but it still has a separator —
   * `mn_shield-addr1…` — so the same rule works there and the fallback below is
   * for a string that is not an address at all, which cannot reach here.
   */
  const at = a.bech32.lastIndexOf('1');
  const payload = at > 0 ? a.bech32.slice(at + 1) : a.bech32;
  const network = at > 0 ? a.bech32.slice(0, at + 1) : '';
  return `${network}${payload.slice(0, 8)}…${payload.slice(-8)}`;
};
