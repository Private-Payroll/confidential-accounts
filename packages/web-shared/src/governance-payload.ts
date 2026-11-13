/**
 * **THE PAYLOAD A GOVERNANCE PROPOSAL COMMITS TO, MADE BY THE ACCOUNT'S OWN FUNCTIONS**, and the values a change travels
 * as between the page and the proving worker, each checked before it is used: thirty-two bytes, a whole number, a
 * threshold of at least one. A device that was not handed one of the account's functions refuses by name, so nothing is
 * built from a payload this device made some other way.
 */
import { fromHex } from '../../../src/core/crypto.js';
import { HEX64 } from '../../../src/midnight/directory-change-shape.js';
import { policyOpeningFromWire, type PolicyOpeningOnTheWire } from '../../../src/midnight/spending-policy-record.js';
import type { GovernedCallDeps, RoundChangeOnTheWire } from './governed-call-builder.js';

const DIGITS = /^[0-9]+$/u;

export const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const bytesOf = (name: string, value: string): Uint8Array => {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new Error(`the ${name} this proposal was handed is not thirty-two bytes, so nothing was built.`);
  }
  return fromHex(value);
};
export const digitsOf = (name: string, value: string): bigint => {
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new Error(`the ${name} this proposal was handed is not a whole number, so nothing was built.`);
  }
  return BigInt(value);
};

/** A threshold, as the digits it travels as, refused unless it is a whole number of at least one. */
export const thresholdOf = (value: string): bigint => {
  const t = digitsOf('threshold', value);
  if (t < 1n) throw new Error('a company\'s threshold is at least one, and this one is not. Nothing was built.');
  return t;
};

/**
 * The threshold a removal sets, as the digits it travels as: a whole number, where 0 keeps the threshold in force. Whether
 * the signers left can meet it is the chain's to refuse.
 */
export const removalThresholdOf = (value: string): bigint => digitsOf('threshold', value);

/** The largest number the account stores as a threshold (`Uint<64>`). */
const MOST_A_THRESHOLD_CAN_BE = 2n ** 64n - 1n;

/**
 * What an invitation sets the threshold to once its seat is taken, as the digits it travels as: none or 0 keeps the
 * threshold in force. The account binds it into the invitation's payload, so the invitee carries out the same number
 * the signers approved. Refused above the largest number the account stores; whether the seats can meet it is the
 * chain's to refuse when the seat is taken.
 */
export const invitationThresholdOf = (value: string | undefined): bigint => {
  if (value === undefined) return 0n;
  const t = digitsOf('threshold', value);
  if (t > MOST_A_THRESHOLD_CAN_BE) throw new Error('the threshold this invitation sets is larger than the account can store, so nothing was built.');
  return t;
};

/** The approvals a change to a spending policy needs, refused unless it is a whole number of at least one. */
export const policyBarOf = (value: string): bigint => {
  const t = digitsOf('number of approvals a policy change needs', value);
  if (t < 1n) throw new Error('a change to a spending policy needs at least one approval, and this number is not. Nothing was built.');
  return t;
};

/**
 * The contract's own payload for taking `leaf` off the account and setting the threshold to `threshold` (0 keeps the one in
 * force), refused by name where this device was not given the function.
 */
export const removalPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, leaf: string, threshold: bigint): Uint8Array => {
  if (typeof deps.accountPure.removeAndSetThresholdPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for removing a signer, so nothing was built. Reload the page to use the current build.');
  }
  return deps.accountPure.removeAndSetThresholdPayload(bytesOf('signer\'s leaf', leaf), threshold);
};

/** The contract's own payload for adopting `vault`, refused by name where this device was not given the function. */
export const adoptionPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string): Uint8Array => {
  if (typeof deps.accountPure.adoptVaultPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for adopting a vault, so nothing was built.');
  }
  return deps.accountPure.adoptVaultPayload(bytesOf('vault', vault));
};

/** The contract's own payload for retiring `vault`, refused by name where this device was not given the function. */
const retirementPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string): Uint8Array => {
  if (typeof deps.accountPure.retireVaultPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for retiring a vault, so nothing was built. Reload the page to use the current build.');
  }
  return deps.accountPure.retireVaultPayload(bytesOf('vault', vault));
};

/** The contract's own payload for one vault's approvals needed, refused by name where this device was not given the function. */
export const vaultThresholdPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string, threshold: string): Uint8Array => {
  if (typeof deps.accountPure.setVaultThresholdPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for a vault\'s approvals needed, so nothing was built.');
  }
  return deps.accountPure.setVaultThresholdPayload(bytesOf('vault', vault), thresholdOf(threshold));
};

/** The contract's own payload for committing to the pay-record key, refused by name where this device was not given the function. */
export const payKeyPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, commitment: string): Uint8Array => {
  if (typeof deps.accountPure.payKeyPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for its pay-record key, so nothing was built.');
  }
  return deps.accountPure.payKeyPayload(bytesOf('pay-record key\'s commitment', commitment));
};

/** The contract's own payload for a vault's spending policy, refused by name where this device was not given the function. */
export const spendingPolicyPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, vault: string, assetKey: string, commitment: string): Uint8Array => {
  if (typeof deps.accountPure.setPolicyPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for a spending policy, so nothing was built.');
  }
  return deps.accountPure.setPolicyPayload(bytesOf('vault', vault), bytesOf('currency\'s key', assetKey), bytesOf('policy\'s commitment', commitment));
};

/** The contract's own payload for the approvals a policy change needs, refused by name where this device was not given the function. */
export const policyBarPayloadOf = (deps: Pick<GovernedCallDeps, 'accountPure'>, bar: string): Uint8Array => {
  if (typeof deps.accountPure.setPolicyBarPayload !== 'function') {
    throw new Error('this device was not given the account\'s function for the approvals a policy change needs, so nothing was built.');
  }
  return deps.accountPure.setPolicyBarPayload(policyBarOf(bar));
};

/** The currency's blinded key, made by the contract's own function from the currency and the account's blinding. */
export const assetKeyMadeHere = (deps: Pick<GovernedCallDeps, 'accountPure'>, asset: string, blinding: string): string => {
  if (typeof deps.accountPure.assetKeyOf !== 'function') {
    throw new Error('this device was not given the account\'s function for a currency\'s key, so nothing was built.');
  }
  return hexOf(deps.accountPure.assetKeyOf(bytesOf('currency', asset), bytesOf('account\'s asset blinding', blinding)));
};

/** The commitment a policy's opening makes, by the contract's own function. */
export const policyCommitmentMadeHere = (deps: Pick<GovernedCallDeps, 'accountPure'>, policy: PolicyOpeningOnTheWire): string => {
  if (typeof deps.accountPure.policyCommitmentOf !== 'function') {
    throw new Error('this device was not given the account\'s function for a policy\'s commitment, so nothing was built.');
  }
  return hexOf(deps.accountPure.policyCommitmentOf(policyOpeningFromWire(policy)));
};

/** The payload a governance round commits to, made by the contract's own function from the change named. */
export function governancePayloadOf(deps: Pick<GovernedCallDeps, 'accountPure'>, g: RoundChangeOnTheWire): Uint8Array {
  /* The super admins' changes are their own kind, signed by their wallets on each contract: never a proposal the account holds or counts. */
  if ((g as { readonly kind: string }).kind === 'super-admins') {
    throw new Error('a change of the super admins is never raised, approved or counted on the company\'s account as a signers\' proposal, so nothing was built.');
  }
  if (g.kind === 'add-signer') {
    return deps.accountPure.signerInvitePayload(
      bytesOf('invited address', g.address), bytesOf('seat\'s rights', g.scope), invitationThresholdOf(g.threshold));
  }
  if (g.kind === 'remove-signer') return removalPayloadOf(deps, g.leaf, removalThresholdOf(g.threshold ?? '0'));
  if (g.kind === 'threshold') return deps.accountPure.setThresholdPayload(thresholdOf(g.threshold));
  if (g.kind === 'vault-threshold') return vaultThresholdPayloadOf(deps, g.vault, g.threshold);
  if (g.kind === 'adopt-vault') return adoptionPayloadOf(deps, g.vault);
  if (g.kind === 'retire-vault') return retirementPayloadOf(deps, g.vault);
  if (g.kind === 'pay-key') return payKeyPayloadOf(deps, g.commitment);
  if (g.kind === 'spending-policy') return spendingPolicyPayloadOf(deps, g.vault, g.assetKey, g.commitment);
  if (g.kind === 'policy-bar') return policyBarPayloadOf(deps, g.bar);
  if (g.kind === 'recover-anchor') {
    if (typeof deps.accountPure.recoverAnchorPayload !== 'function') {
      throw new Error('this device was not given the account\'s function for a recovery of its record anchor. Reload the page to use the current build.');
    }
    return deps.accountPure.recoverAnchorPayload(
      bytesOf('head it resumes from', String(g.resumesFrom).toLowerCase()), digitsOf('recovery\'s last time', g.latest),
      bytesOf('latest recovery\'s head', String(g.lastRecovery).toLowerCase()));
  }
  throw new Error('this proposal is neither a seat nor a threshold, nor a vault adopted or retired, nor the pay-record key, nor a '
    + 'spending policy, so nothing was built.');
}
