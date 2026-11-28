/**
 * What the wallet works out to write and find a person's entries in the private registry, for one fixed person. The
 * registry contract works nothing out: the keys, the tags and the sealed entry's layout all live in the wallet, so a
 * wallet that worked any of them out another way would find none of the entries a person already wrote. A sealed
 * entry carries a random nonce, so its bytes are not frozen; what it is bound to, its layout and its body are.
 */
import { gcm } from '@noble/ciphers/aes.js';

import { identityFromSecret } from '../../packages/identity/src/keys/derivation.js';
import { companyLabelOf } from '../../packages/identity/src/profile/company-label.js';
import {
  entrySealingKey,
  openEntry,
  registryKey,
  sealEntry,
  tagAt,
  type RegistryEntry
} from '../../packages/identity/src/profile/private-registry.js';
import { NETWORKS, type NetworkName } from '../../packages/identity/src/wallet/network.js';
import type { RegistryWalletFacts } from './frozen-facts.js';

const SECRET = new Uint8Array(32).fill(7);
const TAG_PLACES = [0, 1, 19];
const SEALED_ON: NetworkName = 'preprod';
const SEALED_AT = 19;
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const ENTRY: RegistryEntry = {
  label: companyLabelOf(new Uint8Array(32).fill(0xc1)),
  account: 'a1'.repeat(32),
  n: 3,
  scope: 'b2'.repeat(32),
  rights: {
    mayRaise: true,
    mayApprove: false,
    mayHold: true,
    everyVault: false,
    vaults: ['d4'.repeat(32), 'e5'.repeat(32)]
  }
};

/**
 * The body a sealed entry opens to under a layout and a binding, or `does not open`: the nonce first, then the sealed
 * body with the seal's check at its end.
 */
function opened(key: Uint8Array, sealed: Uint8Array, layout: RegistryWalletFacts['layout'], boundTo: string): string {
  if (sealed.length !== layout.nonce + layout.body + layout.check) return 'does not open';
  try {
    return hexOf(
      gcm(key, sealed.slice(0, layout.nonce), Buffer.from(boundTo, 'hex')).decrypt(sealed.slice(layout.nonce))
    );
  } catch {
    return 'does not open';
  }
}

/** The binding a seal at one tag on one network carries, as the wallet builds it. */
const bindingOf = (network: NetworkName, tag: string): string =>
  hexOf(Buffer.concat([Buffer.from(`midnight-identity/private-registry/v1/${network}/`), Buffer.from(tag, 'hex')]));

/**
 * The wallet's registry facts for the fixed person. Given the recorded ones, a fresh seal by the wallet is opened by
 * the recorded layout and binding, and the wallet must open it back to its words; otherwise the layout and
 * binding the wallet seals with are written down, refused if they do not open its own seal.
 */
export function registryFactsInTheWallet(
  recorded?: RegistryWalletFacts
): RegistryWalletFacts & { readonly opensToItsWords: boolean } {
  const person = identityFromSecret(SECRET);
  const networks = Object.fromEntries(
    NETWORKS.map((net) => [
      net,
      {
        registryKey: hexOf(registryKey(person, net)),
        entrySealingKey: hexOf(entrySealingKey(person, net)),
        tags: Object.fromEntries(TAG_PLACES.map((i) => [String(i), tagAt(person, net, i)]))
      }
    ])
  );
  const sealed = sealEntry(person, SEALED_ON, SEALED_AT, ENTRY);
  const layout = recorded?.layout ?? { nonce: 12, body: sealed.length - 12 - 16, check: 16 };
  const boundTo = recorded?.entry.boundTo ?? bindingOf(SEALED_ON, tagAt(person, SEALED_ON, SEALED_AT));
  const body = opened(entrySealingKey(person, SEALED_ON), sealed, layout, boundTo);
  if (recorded === undefined && body === 'does not open')
    throw new Error("the wallet's own seal does not open by the layout and binding written for it");
  return {
    secret: `0x${hexOf(SECRET)}`,
    networks,
    layout,
    entry: { network: SEALED_ON, at: SEALED_AT, words: JSON.parse(JSON.stringify(ENTRY)), boundTo, body },
    opensToItsWords: JSON.stringify(openEntry(person, SEALED_ON, SEALED_AT, sealed)) === JSON.stringify(ENTRY)
  };
}
