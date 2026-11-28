import type { Identity } from 'midnight-identity/keys/derivation';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../../src/core/crypto.js';
import { seatAt } from './seat-at.js';

/**
 * **THE FOUNDING SEAT OF A COMPANY THIS WALLET STARTS, MADE FROM ITS WORDS.**
 * Seat 0 of the company whose label this wallet drew, over every vault, made by
 * `seatAt` with the account's own circuits. The same words make the same seat
 * on every device, so a founding seat never has to be kept anywhere to be had
 * again.
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
  const { MidnightCommitments } = await import('../../../../src/midnight/commitments.js');
  const s = seatAt(identity, label, FOUNDING_SEAT, MidnightCommitments.allVaults(), MidnightCommitments);
  return Object.freeze({
    signingSecret: s.signingSecret,
    wrappingSecret: s.wrappingSecret,
    salt: s.salt,
    blinding: s.blinding,
    walletKey: s.walletKey,
    scope: s.scope,
    signingPublicKey: s.signingPublicKey,
    wrappingPublicKey: s.wrappingPublicKey,
    leaf: s.leaf,
    publicKey: s.publicKey
  });
}
