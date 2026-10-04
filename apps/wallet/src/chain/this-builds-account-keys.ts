import { first, missing, second } from 'virtual:this-builds-account-keys';
import type { ThisBuildsAccountKeys } from 'midnight-identity/profile/creation-sign';

/**
 * **THE COMPANY ACCOUNT'S KEYS THIS WALLET WAS BUILT WITH**, as digests by
 * circuit, in the order each step of a creation takes them; or why there are
 * none. Made when the wallet was built (`apps/wallet/this-builds-account-keys.ts`).
 */
export type BuiltAccountKeys = { readonly of: 'built'; readonly keys: ThisBuildsAccountKeys } | { readonly of: 'missing'; readonly why: string };

const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

export function builtAccountKeys(): BuiltAccountKeys {
  if (missing !== null || first.length === 0 || second.length === 0) {
    return { of: 'missing', why: missing ?? 'this wallet was built without the company account\'s compiled keys' };
  }
  return {
    of: 'built',
    keys: {
      first: new Map(first.map(([c, h]) => [c, bytes(h)] as [string, Uint8Array])),
      second: new Map(second.map(([c, h]) => [c, bytes(h)] as [string, Uint8Array])),
    },
  };
}
