/**
 * What one payment from a vault carries, and the values the vault's circuit is handed for it: the run's terms,
 * the payee's path in the run's sum tree, and the secret the payment's new coins take their nonces from. A path
 * that is not the tree's full depth, a step that is not a node, a sum and a side, and a nonce secret that is
 * missing or not 32 bytes are each refused here, before anything is proved or paid.
 */
import type { Hex } from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';
import type { SignerRef } from '../core/ledger.js';
import type { Payee } from './payee-address.js';
import type { SumStep } from './payout-tree.js';
import type { NoteEvents } from './note-index.js';
import type { VaultPaid } from './vault-ledger.js';


/** One payment, exactly as `PayrollRun.payeeArgs` hands it over. */
export interface VaultPayment {
  proposal: Hex;
  root: Hex;
  payees: bigint;
  opensAt: bigint;
  closesAt: bigint;
  salt: Hex;
  /**
   * WHO IS PAID — ONE VALUE CARRYING BOTH KEYS. A-1, and it closes V-80.
   *
   * This used to be `recipient: Hex` (the coin key, which goes to the circuit)
   * beside `payslipKey: Hex` (the encryption key, which does not — it rides on
   * the transaction in `additionalCoinEncPublicKeyMappings` and is what makes
   * the payment visible in the payee's own wallet).
   *
   * **Two fields meant they could disagree, and the disagreement was silent:**
   * omit the encryption key and midnight-js refuses to build the transaction,
   * which is the platform protecting us; supply the WRONG one and the payment
   * settles perfectly into a coin the payee's wallet will never show them, with
   * nothing anywhere objecting.
   *
   * One value, one decode, and that pairing cannot be wrong. A wrong address is
   * now a wrong RECIPIENT — loud and ordinary. `V-78` is what remains: this
   * does not stop the wrong person's correct address.
   */
  /**
   * **AND IT CARRIES THE KIND, WHICH IS WHAT DECIDES THE CIRCUIT.**
   *
   * `Payee` is a union whose tag came out of the same decode as the 32 bytes
   * that go to the circuit. `payout` reads it and dispatches; **there is no
   * argument here, and no method to choose, by which a caller could name one
   * kind for a payee who is the other.** That matters more here than anywhere
   * else in this file: the two are both `{ bytes: Bytes<32> }` at the kernel,
   * so nothing downstream of raw bytes can tell them apart, and an unshielded
   * send to a Zswap coin public key removes the money permanently.
   */
  payee: Payee;
  token: Hex;
  amount: bigint;
  blinding: Hex;
  nonce: Hex;
  /**
   * The vault the approved run names: this vault for its own run, or the
   * company-wide name for a run any adopted vault may pay. The account
   * recomputes the proposal from it, so it is the run's value, never the payer's.
   */
  runVault: Hex;
  /** The approvals the run was raised with. Part of what the proposal commits to. */
  required: bigint;
  /** The asset the run's root commits to, exactly as the run was built with it. */
  asset: Hex;
  /**
   * The payee's path in the run's sum tree, leaf to root: one step per level,
   * each the node beside it, that node's sum and which side the payee is on.
   * The account rebuilds the root from it with this payment's amount and token.
   */
  path: readonly SumStep[];
}

/**
 * **ONE PAYMENT OUT OF AN APPROVED RUN, BEHIND ONE CALL, WHOEVER MAKES IT.**
 *
 * Everything the payment needs arrives as arguments: the approved run's own
 * values and this payee's leaf and path (`VaultPayment`), where the chain's
 * events are read, and, for private money, the vault's current nonce secret.
 * Nothing is read from the device that built the run. So a signer's own device
 * and a separate service that proves on the company's behalf call exactly this,
 * with the same run, and neither can pay what the other could not.
 *
 * Every payee of a run is one call and one transaction; a batch is these calls
 * in turn, each retried on its own.
 */
export interface PaysFromAVault {
  payout(
    vaultAddress: string,
    p: VaultPayment,
    by: SignerRef,
    events?: NoteEvents,
    nonceSecret?: Hex,
  ): Promise<VaultPaid>;
}

/** How many levels a payee's path has: the circuit takes exactly this many steps. */
const RUN_PATH_STEPS = 16;

/**
 * **THE RUN, IN THE SHAPE BOTH PAYMENT CIRCUITS TAKE IT.**
 *
 * One builder for both kinds, so the private and the public payment cannot
 * hand the account two different readings of one approved run. A path of the
 * wrong length, or a step that is not a node, a sum and a side, is refused here
 * by name before anything is proved: the account would refuse it too, but only
 * after a proof and a fee.
 */
export const runArgOf = (p: VaultPayment) => {
  const path = p.path as readonly unknown[];
  if (!Array.isArray(path) || path.length !== RUN_PATH_STEPS) {
    throw new Error(
      `a payee's path in the run's sum tree has ${RUN_PATH_STEPS} steps, and this payment's has `
      + `${Array.isArray(path) ? path.length : 'none'}. Nothing is proved or paid. Pay with the `
      + 'path the run itself gives for this payee.');
  }
  return {
    proposal: fromHex(p.proposal),
    runVault: fromHex(p.runVault),
    root: fromHex(p.root),
    payees: p.payees,
    opensAt: p.opensAt,
    closesAt: p.closesAt,
    required: p.required,
    salt: fromHex(p.salt),
    nonce: fromHex(p.nonce),
    asset: fromHex(p.asset),
    path: path.map((step, level) => {
      const s = step as Partial<SumStep> | null;
      if (s === null || typeof s !== 'object' || typeof s.sibling !== 'bigint'
        || typeof s.siblingSum !== 'bigint' || typeof s.goesLeft !== 'boolean') {
        throw new Error(
          `step ${level} of this payee's path is not a node, a sum and a side. Nothing is proved or `
          + 'paid. Pay with the path the run itself gives for this payee.');
      }
      return { sibling: s.sibling, siblingSum: s.siblingSum, goesLeft: s.goesLeft };
    }),
  };
};

/**
 * **THE VAULT'S CURRENT NONCE SECRET, CHECKED FOR SHAPE AND NOTHING MORE.**
 *
 * Every coin a private payment makes takes its nonce from this secret and the
 * spent note, so the payment cannot be proved without it, and the vault checks
 * it against the commitment it holds. It is supplied by whoever pays: the
 * company's nonce-secret record, opened by a signer, holds it. Absent, of the
 * wrong length, or all zeros, the payment stops here before a note is chosen or
 * anything written down.
 */
export const nonceSecretFor = (secret: Hex | undefined): Uint8Array => {
  if (secret === undefined) {
    throw new Error(
      'a private payment makes its coins under the vault\x27s current nonce secret, and none was '
      + 'given. Nothing is proved or paid. Open the company\x27s nonce secret for this vault and '
      + 'pay again with it.');
  }
  if (!/^[0-9a-f]{64}$/u.test(secret) || /^0+$/u.test(secret)) {
    throw new Error(
      'the nonce secret given for this payment is not a 32-byte secret. Nothing is proved or paid. '
      + 'Open the company\x27s nonce secret for this vault and pay again with it.');
  }
  return fromHex(secret);
};
