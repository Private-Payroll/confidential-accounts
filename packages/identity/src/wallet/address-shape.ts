import { bech32m } from '@scure/base';
import { NETWORKS, type NetworkName } from './network.js';

/**
 * **THE THREE CHECKS `payeeAddress()` MAKES, WITHOUT THE TEN MEGABYTES.**
 *
 * ── WHY THIS FILE EXISTS, AND IT IS A MEASUREMENT RATHER THAN A PREFERENCE ─
 *
 * The sealing of an employee's receiving address moves onto the
 * employee's OWN device: the browser seals to the company's inbox key and the
 * route takes a blob it cannot open. **A browser that seals an address it never
 * checked is a browser that seals a typo**, so the checks have to move with the
 * seal — and the page they have to move into is `src/web` in the hosting
 * repository, which **may not contain WebAssembly**, and
 * `src/web/no-wasm-in-the-page.test.ts` is what holds it.
 *
 * `wallet/address.ts` next door cannot go there. It imports
 * `@midnightntwrk/wallet-sdk-address-format`, and **that package's `dist` is one
 * file whose thirteenth line is `import { EncryptionSecretKey } from
 * '@midnightntwrk/ledger-v9'`** — measured, not assumed. One static import at
 * module scope pulls the whole ledger, and with it the wasm-bindgen glue that
 * left that page blank for a long time.
 *
 * ── WHAT WAS MEASURED, AND WHY IT MAKES THIS SAFE RATHER THAN CLEVER ──────
 *
 * The ledger import is **not used by the address path at all.** Read in
 * `node_modules/@midnightntwrk/wallet-sdk-address-format/dist/index.js`:
 *
 *     :51  MidnightBech32m.parse   = bech32m.decodeToBytes(s), then
 *                                   prefix must be 'mn', then validateSegment
 *                                   on the type and (unless mainnet) the network
 *     :44  validateSegment         = /^[A-Za-z1-9-]+$/
 *     :103 Bech32mCodec.decode     = type must equal 'shield-addr',
 *                                   network must equal the one asked for
 *     :122 ShieldedAddress codec   = first 32 bytes are the coin public key,
 *                                   the rest is the encryption public key
 *     :154 keyLength               = 32
 *
 * **Every one of those is plain JavaScript over `@scure/base`'s bech32m** —
 * the same `bech32m` this file imports, from the same version the package
 * itself resolves. Nothing on that path touches the ledger. So this is not a
 * second implementation of Midnight's encoding; it is the same library called
 * the same way, with the one unrelated import that cannot be tree-shaken left
 * behind.
 *
 * ── AND IT IS PINNED AGAINST THE REAL THING RATHER THAN AGAINST THIS COMMENT ─
 *
 * `address-shape.test.ts` runs this and `payeeAddress()` over the same inputs
 * and requires them to agree — **the same accept, the same refusal code, and
 * the same two key halves.** That test lives in this repository because this is
 * the side that may load the ledger. **If the platform ever changes its
 * encoding, the test goes red here rather than a wrong address going out in a
 * page there.**
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * It is **not** the authority for what lands on a roster. The payroll server
 * still rebuilds every address through the real `payeeAddress()` when it admits
 * one, from the string, exactly as it always has. This is the
 * check that happens EARLY — on the device of the person who can still do
 * something about it — and losing it would cost a good error message, never a
 * wrong payment.
 *
 * It also cannot say whether the two halves belong to one person. Nothing on
 * either side can; `wallet/address.ts` says so about itself. That is guaranteed
 * by the wallet computing both from one subwallet.
 */

/** The same four outcomes `wallet/address.ts` names, so a refusal keeps its name. */
export type AddressShapeFailure =
  | 'empty'
  | 'not-an-address'
  | 'wrong-kind'
  | 'wrong-network';

export class AddressShapeError extends Error {
  readonly code: AddressShapeFailure;
  constructor(code: AddressShapeFailure, message: string) {
    super(message);
    this.name = 'AddressShapeError';
    this.code = code;
  }
}

/** What comes out: the canonical string and the two halves, both derived. */
export interface CheckedShieldedAddress {
  /** The address as the platform writes it, re-encoded from what was decoded. */
  readonly bech32: string;
  readonly network: NetworkName;
  /** Who may spend. 32 bytes of lowercase hex. */
  readonly coinPublicKey: string;
  /** Who may read about it. Same decode as `coinPublicKey`. */
  readonly encryptionPublicKey: string;
}

/** `@midnightntwrk/wallet-sdk-address-format` dist:29. */
const PREFIX = 'mn';
/** The codec's own type name. dist:103, `ShieldedAddress.codec`. */
const SHIELD_ADDR = 'shield-addr';
/** `ShieldedCoinPublicKey.keyLength`. dist:154. */
const KEY_BYTES = 32;
/** `MidnightBech32m.validateSegment`. dist:44. */
const SEGMENT = /^[A-Za-z1-9-]+$/u;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * **A MAINNET ADDRESS HAS NO NETWORK SEGMENT AT ALL.** dist:52 — the third
 * segment defaults to the library's `mainnet` symbol when it is absent, and
 * `asString` puts nothing back. Measured and recorded in `address.ts` too;
 * repeated here because this file has to reproduce it rather than inherit it.
 */
const segmentFor = (network: NetworkName): string | null =>
  network === 'mainnet' ? null : network;

/**
 * **THE CHECK, IN THE ORDER THE PLATFORM MAKES IT**, so the failure a person is
 * shown is the failure they would have been shown by the real decoder.
 *
 * `network` is required and deliberately not defaulted, for the reason
 * `address.ts` gives: an address is meaningful on one network, and a default is
 * how a preview address reaches a stagenet payroll.
 */
export function checkShieldedAddress(
  bech32: string, network: NetworkName,
): CheckedShieldedAddress {
  const raw = (bech32 ?? '').trim();
  if (!raw) {
    throw new AddressShapeError('empty', 'an address is required, and this one is empty.');
  }
  if (!(NETWORKS as readonly string[]).includes(network)) {
    /* Not one of the four outcomes: it is this CALLER being wrong, not the
     * address, and reporting it as a bad address would send somebody looking
     * at the wrong value. */
    throw new Error(`"${network}" is not a Midnight network this wallet knows.`);
  }

  let decoded: { prefix: string; bytes: Uint8Array };
  try {
    decoded = bech32m.decodeToBytes(raw);
  } catch (e) {
    throw new AddressShapeError(
      'not-an-address',
      `"${raw}" is not a Midnight address: ${(e as Error).message}. `
      + 'One looks like mn_shield-addr_<network>1... and carries its own checksum, '
      + 'so a single mistyped character fails here.');
  }

  const [prefix, type, segment] = decoded.prefix.split('_');
  if (prefix !== PREFIX) {
    throw new AddressShapeError(
      'not-an-address',
      `"${raw}" is not a Midnight address: Expected prefix ${PREFIX}.`);
  }
  if (type === undefined || !SEGMENT.test(type)) {
    throw new AddressShapeError(
      'not-an-address',
      `"${raw}" is not a Midnight address: Segment type: ${String(type)} contains `
      + 'disallowed characters.');
  }
  if (segment !== undefined && !SEGMENT.test(segment)) {
    throw new AddressShapeError(
      'not-an-address',
      `"${raw}" is not a Midnight address: Segment network: ${segment} contains `
      + 'disallowed characters.');
  }

  /*
   * **THE KIND IS CHECKED BEFORE THE NETWORK, AND THAT ORDER IS THE
   * PLATFORM'S.** `Bech32mCodec.decode` compares the type first (dist:105) and
   * the network second (dist:108), and `address.ts` distinguishes the two
   * failures on the library's own words. Here the two are separate branches
   * rather than a regular expression over an error message, which is strictly
   * better and is the one place this file is not a mirror.
   */
  if (type !== SHIELD_ADDR) {
    throw new AddressShapeError(
      'wrong-kind',
      `"${raw}" is not a payee address: Expected type ${SHIELD_ADDR}, got ${type}. `
      + 'It must be a shield-addr — a coin public key on its own is not enough to pay '
      + 'somebody, because it does not say who may READ the payment.');
  }

  const wanted = segmentFor(network);
  const theirs = segment ?? null;
  if (theirs !== wanted) {
    throw new AddressShapeError(
      'wrong-network',
      `"${raw}" is not an address for ${network}: Expected ${network} address, got `
      + `${theirs ?? 'mainnet'} one.`);
  }

  /*
   * **THE LENGTH IS CHECKED HERE, AND THIS IS STRICTER THAN THE PLATFORM.** The
   * platform's codec takes the first 32 bytes as the coin key and *the rest* as
   * the encryption key. `ShieldedCoinPublicKey` refuses anything but 32 bytes
   * (dist:162), but `ShieldedEncryptionPublicKey`'s constructor checks no length
   * (dist:174 onwards), so the platform decodes a string of 32 bytes and
   * anything after them, including nothing. This refuses every length but 64.
   */
  if (decoded.bytes.length !== KEY_BYTES * 2) {
    throw new AddressShapeError(
      'wrong-kind',
      `"${raw}" carries ${decoded.bytes.length} bytes and a payee address carries `
      + `${KEY_BYTES * 2} — ${KEY_BYTES} for the key that may spend and ${KEY_BYTES} for `
      + 'the key that may read.');
  }

  return Object.freeze({
    /* Re-encoded from what was decoded, exactly as `MidnightBech32m.asString`
     * does it (dist:80), so the value that travels is the canonical one and not
     * whatever spelling arrived. */
    bech32: bech32m.encode(decoded.prefix, bech32m.toWords(decoded.bytes), false),
    network,
    coinPublicKey: hex(decoded.bytes.subarray(0, KEY_BYTES)),
    encryptionPublicKey: hex(decoded.bytes.subarray(KEY_BYTES)),
  });
}
