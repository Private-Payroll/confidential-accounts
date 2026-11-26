import { x25519 } from '@noble/curves/ed25519.js';
import type { Identity } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import { seatBlinding } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf, type LeafScheme } from '../../../../src/core/signer-leaf.js';

/**
 * **ONE SEAT OF THIS WALLET IN ONE COMPANY, MADE FROM ITS WORDS.**
 * Seat `n` in the company under `label`: its keys (`seatKeysFor`), its blinding
 * from the company's committee key and the seat's salt, its leaf at `scope` and
 * at every vault, and its public keys, as the compiled account's circuits work
 * them out (`scheme`). Every seat this wallet founds, takes or checks is made
 * here, so the same words make the same seat everywhere.
 *
 * What it trusts: this wallet's words and the scheme it is given. Nothing here
 * comes from a page.
 */
export interface SeatAt {
  readonly n: number;
  readonly signingSecret: Hex;
  readonly wrappingSecret: Hex;
  readonly salt: Hex;
  readonly blinding: Hex;
  /** The company's committee key; the seat's blinding is made from it. */
  readonly walletKey: { readonly tag: 'schnorr'; readonly value: Hex };
  /** The scope the seat's leaf is drawn over, and the leaf there. */
  readonly scope: Hex;
  readonly leaf: Hex;
  /** The seat's leaf over every vault (the same as `leaf` when `scope` is every vault). */
  readonly leafAtAll: Hex;
  /** The seat's public key as the account's circuits work it out. */
  readonly publicKey: Hex;
  readonly signingPublicKey: Hex;
  readonly wrappingPublicKey: Hex;
}

const lower = (v: unknown): Hex => String(v).toLowerCase() as Hex;

export function seatAt(identity: Identity, label: CompanyLabel, n: number, scope: Hex, scheme: LeafScheme): SeatAt {
  const keys = seatKeysFor(identity, label, n);
  const signingSecret = lower(toHex(keys.signingSecret));
  const wrappingSecret = lower(toHex(keys.wrappingSecret));
  const salt = lower(toHex(keys.salt));
  const walletKey = { tag: 'schnorr' as const, value: lower(committeeKeyFor(identity, label).value) };
  const blinding = lower(seatBlinding(walletKey, salt));
  const at = lower(scope);
  const all = lower(scheme.allVaults());
  const leafAt = (s: Hex) => lower(storedSignerLeaf({ signingSecret, blinding, scope: s }, scheme));
  const leaf = leafAt(at);
  return Object.freeze({
    n, signingSecret, wrappingSecret, salt, blinding, walletKey, scope: at, leaf,
    leafAtAll: at === all ? leaf : leafAt(all),
    publicKey: lower(scheme.signerPublicKey(signingSecret)),
    signingPublicKey: lower(signingPublicKeyOf(signingSecret)),
    wrappingPublicKey: lower(toHex(x25519.getPublicKey(keys.wrappingSecret))),
  });
}
