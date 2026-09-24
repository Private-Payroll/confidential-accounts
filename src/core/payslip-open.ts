import { x25519 } from '@noble/curves/ed25519.js';
import {
  fromHex, toHex, unwrapKey, unseal, parseCanonical, type Hex, type Sealed,
} from './crypto.js';
import type { AssetId } from './assets.js';
import type { WiringName } from './provenance.js';

/**
 * **A PAYSLIP IS OPENED IN THE BROWSER OF THE PERSON IT IS ABOUT, AND NOWHERE
 * ELSE.**
 *
 * The service keeps each payslip as ciphertext: the slip sealed under a fresh
 * key, and that key wrapped to the payee's own public key. What it hands out
 * is exactly that, and this file is what turns it into a line a person can
 * read. It takes the payee's secret as an argument and sends it nowhere; there
 * is no network call in this file, and the page's own module graph stays free
 * of the wallet SDK because nothing here imports it.
 */

/** One payslip as the service holds it and hands it back: ciphertext, and the run's own facts beside it. */
export interface SealedPayslip {
  runId: string;
  period: string;
  status: 'draft' | 'proposed' | 'settled';
  settledAt: string | null;
  /**
   * Which ledger wrote the run. `'chain'` is the only value that means a chain
   * recorded it; `'simulated'` means it did not, and `null` means nothing
   * recorded which ledger it was, which is never read as a chain's.
   */
  wiring: WiringName | null;
  /**
   * **THE COMPANY ADDRESS THE PAYEE'S KEY WAS WORKED OUT FROM.** A payee's
   * payslip key is derived from the key their wallet gives for one company
   * address, so this is the address to name to the wallet to open this slip.
   * A company that later moves to a new address keeps every earlier slip
   * openable, because each one still names the address it was sealed under.
   * `null` for a slip sealed to a key that was not derived from any address.
   */
  issuedBy: string | null;
  wrapped: { ephemeral: Hex } & Sealed;
  slip: Sealed;
}

/** What is inside a payslip once its payee has opened it. */
export interface PayslipContents {
  employeeId: string;
  name: string;
  asset: AssetId;
  amount: bigint;
  period: string;
  paidTo?: unknown;
}

export interface OpenedPayslip extends Omit<SealedPayslip, 'wrapped' | 'slip'> {
  payslip: PayslipContents;
}

/** Thrown when a key does not open a slip. The same words whichever way it failed. */
export const NOT_YOUR_PAYSLIP = 'that key cannot open this payslip';

/**
 * Opens one payslip with the payee's own secret.
 *
 * A wrong key fails the authenticated decryption of the wrapped slip key, so a
 * slip sealed to somebody else cannot be read here and cannot be mistaken for
 * one that was.
 */
export function openPayslip(entry: SealedPayslip, wrappingSecret: Hex): OpenedPayslip {
  /* Something with no sealed parts is not a payslip that failed to open. */
  if (!entry || typeof entry !== 'object' || !entry.wrapped || !entry.slip) {
    throw new TypeError('what was sent is not a payslip: it carries no sealed slip.');
  }
  let payslip: PayslipContents;
  try {
    const slipKey = unwrapKey(entry.wrapped, wrappingSecret);
    payslip = parseCanonical<PayslipContents>(unseal(entry.slip, slipKey));
  } catch {
    throw new Error(NOT_YOUR_PAYSLIP);
  }
  const { wrapped: _w, slip: _s, ...facts } = entry;
  return { ...facts, payslip };
}

/** The public half of a payslip secret, so a page holding only the secret can ask for its slips. */
export const payslipPublicKeyOf = (wrappingSecret: Hex): Hex =>
  toHex(x25519.getPublicKey(fromHex(wrappingSecret)));

/**
 * **WHAT THE SERVICE BINDS A PROOF TO.** A request for somebody's payslips
 * names a public key, and the service answers only after the asker has shown
 * they hold the matching secret: it seals a one-use value to that key, and
 * only the holder of the secret can read it back.
 */
export const payslipProofSubject = (publicKey: Hex): string =>
  'payslips:' + publicKey.toLowerCase();

/** Reads back the one-use value the service sealed to this payee's public key. */
export const answerPayslipProof = (
  sealedToMe: { ephemeral: Hex } & Sealed, wrappingSecret: Hex,
): Hex => unwrapKey(sealedToMe, wrappingSecret);

/** A public key as the service accepts one: 32 bytes, lower-case hex. */
export const PAYSLIP_PUBLIC_KEY = /^[0-9a-f]{64}$/u;
