import { x25519 } from '@noble/curves/ed25519.js';
import type { Identity } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import { seatBlinding } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';

/**
 * **THE FOUNDING SEAT OF A COMPANY THIS WALLET STARTS, MADE FROM ITS WORDS.**
 * The first seat this wallet makes in the company whose label it drew
 * (`seatKeysFor`, seat 0), its blinding from the company's committee key and
 * the seat's salt, and its leaf and public key as the account's own circuits
 * work them out. The same words make the same seat on every device, so a
 * founding seat never has to be kept anywhere to be had again.
 *
 * What it trusts: this wallet's words and the compiled contract's own
 * circuits. Nothing here comes from a page.
 */
export interface FoundingSeat {
  readonly signingSecret: Hex;
  readonly wrappingSecret: Hex;
  readonly salt: Hex;
  readonly blinding: Hex;
  readonly signingPublicKey: Hex;
  readonly wrappingPublicKey: Hex;
  /** The company's committee key, which holds the account from its first transaction; the seat's blinding is made from it. */
  readonly walletKey: { readonly tag: 'schnorr'; readonly value: Hex };
  /** The seat's leaf on the account, and the scope it is drawn over: every vault. */
  readonly leaf: Hex;
  readonly scope: Hex;
  /** The seat's public key as the account's circuits work it out. */
  readonly publicKey: Hex;
}

/** The seat a company's founding takes: seat 0. */
export const FOUNDING_SEAT = 0;

export async function foundingSeatOf(identity: Identity, label: CompanyLabel): Promise<FoundingSeat> {
  const keys = seatKeysFor(identity, label, FOUNDING_SEAT);
  const signingSecret = toHex(keys.signingSecret).toLowerCase() as Hex;
  const wrappingSecret = toHex(keys.wrappingSecret).toLowerCase() as Hex;
  const salt = toHex(keys.salt).toLowerCase() as Hex;
  const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(identity, label).value).toLowerCase() as Hex };
  const blinding = String(seatBlinding(walletKey, salt)).toLowerCase() as Hex;
  const { MidnightCommitments } = await import('../../../../src/midnight/commitments.js');
  const scope = MidnightCommitments.allVaults().toLowerCase() as Hex;
  return Object.freeze({
    signingSecret, wrappingSecret, salt, blinding, walletKey, scope,
    signingPublicKey: signingPublicKeyOf(signingSecret).toLowerCase() as Hex,
    wrappingPublicKey: toHex(x25519.getPublicKey(keys.wrappingSecret)).toLowerCase() as Hex,
    leaf: storedSignerLeaf({ signingSecret, blinding, scope }, MidnightCommitments).toLowerCase() as Hex,
    publicKey: MidnightCommitments.signerPublicKey(signingSecret).toLowerCase() as Hex,
  });
}
