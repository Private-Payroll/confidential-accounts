/**
 * **WHERE A PAYEE IS PAID, READ FROM THEIR ADDRESS AND NOTHING ELSE.** A record keeps a payee's address beside the keys
 * decoded from it, and the money goes to those keys; every check compares the address. This is the one reading of an
 * address into the keys it names (`payeeAt`) and the one check that a record's stored keys are its address's
 * (`payeeKeysRefusal`), so what every device compares is what the vault pays.
 *
 * Pure: the server and the page both import it.
 */
import { checkShieldedAddress, checkUnshieldedAddress } from 'midnight-identity/wallet/address-shape';
import type { Payee } from '../midnight/payee-address.js';
import type { NetworkName } from '../midnight/network.js';

/**
 * **AN ADDRESS READ AS WHERE A PAYEE IS PAID ON `network`**: a private one with its coin and encryption keys, or a
 * public one with its user address. Throws, with why, for anything money cannot be sent to on that network. The one
 * reading of an address for people and vendors alike, whether it was typed or named in a payee's code.
 */
export const payeeAt = (address: string, network: NetworkName): Payee => {
  const raw = address.trim();
  if (raw.startsWith('mn_shield-addr')) {
    const c = checkShieldedAddress(raw, network);
    return { kind: 'shielded', bech32: c.bech32, network: c.network, coinPublicKey: c.coinPublicKey, encryptionPublicKey: c.encryptionPublicKey } as unknown as Payee;
  }
  const c = checkUnshieldedAddress(raw, network);
  return { kind: 'unshielded', bech32: c.bech32, network: c.network, userAddress: c.userAddress } as unknown as Payee;
};

/**
 * Why a record's address does not pay the keys it names, or null when it does (or there is no address yet): the
 * stored kind, keys and network must be exactly what reading its address on that network gives. A version that keeps
 * an address and swaps the keys beside it would send the money elsewhere with every comparison of the address green.
 */
export const payeeKeysRefusal = (payee: unknown): string | null => {
  if (payee === null || payee === undefined) return null;
  const p = payee as Record<string, unknown>;
  if (typeof p.bech32 !== 'string' || typeof p.network !== 'string') return 'the address their record pays does not say which address and network it is';
  let read: Payee;
  try {
    read = payeeAt(p.bech32, p.network as NetworkName);
  } catch (e) {
    return `the address their record pays is not one money can be sent to on the network it names (${(e as Error).message})`;
  }
  const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const keys = read.kind === 'shielded' ? ['coinPublicKey', 'encryptionPublicKey'] as const : ['userAddress'] as const;
  if (p.kind !== read.kind || keys.some((k) => !same(p[k], (read as unknown as Record<string, unknown>)[k]))) {
    return 'the keys their record pays are not the keys of the address it names';
  }
  return null;
};
