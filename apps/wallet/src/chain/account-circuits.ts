import {
  ACCOUNT_CIRCUITS_A_DEVICE_ANCHORS, ACCOUNT_CIRCUITS_A_DEVICE_CHARGES, ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS, VAULT_CIRCUITS,
} from '../../../../src/midnight/vault-contract.js';

/**
 * THE COMPANY ACCOUNT'S CIRCUITS THIS WALLET PROVES ITSELF: every circuit a
 * signer's device governs the account with (raise, approve and withdraw a
 * proposal, seat a signer, change a threshold, adopt a vault, seal the
 * pay-record key, set a spending policy and its bar), the two that anchor
 * the company's records, and the charge of a payment to its vault's period
 * under a spending policy. Taken from the account's own lists, never retyped,
 * so the calls the wallet builds to the account and the keys it holds for
 * them are always the same set. It also holds the keys of the account
 * circuits its vault circuits call, below, and serves them only as those calls.
 *
 * Kept apart from the builders so the script that copies these keys into the
 * wallet can read the sets without loading a builder.
 */
export const ACCOUNT_CIRCUITS_THE_WALLET_PROVES: readonly string[] = Object.freeze([
  ...ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS, ...ACCOUNT_CIRCUITS_A_DEVICE_ANCHORS, ...ACCOUNT_CIRCUITS_A_DEVICE_CHARGES,
]);

/**
 * THE VAULT'S CIRCUITS THIS WALLET PROVES ITSELF: setting a new vault's first
 * secret and writing each signer's sealed copy of it, the two calls that carry
 * the secret the wallet made, a private deposit, which the wallet builds,
 * pays and records whole, and a one-off payment out of the vault, private or
 * public. Every other vault call a company makes is built elsewhere, so the
 * wallet holds no proving key for it.
 */
export const VAULT_CIRCUITS_THE_WALLET_PROVES: readonly string[] = Object.freeze(['setNonceSecret', 'writeSecretCopy', 'deposit', 'payout', 'payoutUnshielded']);

/**
 * THE COMPANY ACCOUNT'S CIRCUITS EACH VAULT CIRCUIT THIS WALLET PROVES CALLS,
 * inside the same transaction. Setting a vault's secret asks the account to
 * approve the change, and that call is a proof of its own, made with the
 * account's key for it; a payment out, private or public, asks the account to
 * record it against the approved run; writing a sealed copy and a private
 * deposit call nothing. A call missing here is a proof the wallet cannot make, so the whole
 * transaction stops at it; one listed here that the circuit does not make is a
 * proving key held for nothing.
 */
export const ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  setNonceSecret: Object.freeze(['approveVaultChange']),
  writeSecretCopy: Object.freeze([]),
  deposit: Object.freeze([]),
  payout: Object.freeze(['recordPaymentFromVault']),
  payoutUnshielded: Object.freeze(['recordPaymentFromVault']),
});

/** The account circuits a vault circuit this wallet proves calls: the wallet proves each, only as that call. */
export const ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL: readonly string[] = Object.freeze([
  ...new Set(VAULT_CIRCUITS_THE_WALLET_PROVES.flatMap((c) => ACCOUNT_CIRCUITS_EACH_VAULT_CIRCUIT_CALLS[c] ?? [])),
]);

/**
 * EVERY COMPANY ACCOUNT CIRCUIT THIS WALLET HOLDS A PROVING KEY FOR: the ones it
 * proves itself, and the ones a vault circuit it proves calls. What the wallet
 * copies into its own keys and pins.
 */
export const ACCOUNT_CIRCUITS_THE_WALLET_HOLDS_KEYS_FOR: readonly string[] = Object.freeze([
  ...ACCOUNT_CIRCUITS_THE_WALLET_PROVES, ...ACCOUNT_CIRCUITS_THE_WALLETS_VAULT_CIRCUITS_CALL,
]);

/**
 * THE VAULT'S CIRCUITS WHOSE VERIFIER KEYS THIS WALLET HOLDS: every one, as the
 * vault's own list names them, because a vault's deploy installs them all.
 */
export const VAULT_CIRCUITS_THE_WALLET_DEPLOYS: readonly string[] = Object.freeze([...VAULT_CIRCUITS]);
