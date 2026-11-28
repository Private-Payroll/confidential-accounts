import { bech32m } from '@scure/base';
import { NETWORK } from 'midnight-identity/network';

/**
 * **AN ADDRESS ON THE NETWORK THIS BUILD IS COMPILED FOR, FOR A TEST THAT NEEDS ONE.**
 * The network is a segment of the string and of its checksum, so a test that
 * types an address out as text names one network and fails on a build for another.
 * These build the string from bytes and the compiled network instead. The bytes
 * are made here with `new Uint8Array`, so they are accepted in a node test and
 * in a browser-like one alike, where a `Buffer` is refused.
 */
const encode = (type: 'shield-addr' | 'addr', bytes: Uint8Array): string =>
  bech32m.encode(`mn_${type}${NETWORK === 'mainnet' ? '' : `_${NETWORK}`}`, bech32m.toWords(bytes), false);

/** A private address whose two keys are filled with `fill` and with `fill` xor 0x5a. */
export const privateAddressHere = (fill: number): string =>
  encode(
    'shield-addr',
    Uint8Array.from({ length: 64 }, (_, i) => (i < 32 ? fill : fill ^ 0x5a) & 0xff)
  );

/** A public address whose 32 bytes are all `fill`. */
export const publicAddressHere = (fill: number): string =>
  encode(
    'addr',
    Uint8Array.from({ length: 32 }, () => fill & 0xff)
  );

/** A public address on a network other than the compiled one, whose bytes are all `fill`. */
export const publicAddressElsewhere = (fill: number): string =>
  bech32m.encode(
    `mn_addr_${NETWORK === 'preview' ? 'preprod' : 'preview'}`,
    bech32m.toWords(Uint8Array.from({ length: 32 }, () => fill & 0xff)),
    false
  );
