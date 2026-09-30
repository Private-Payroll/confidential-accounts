/**
 * A VAULT'S SPENDING POLICY, AS A SIGNER'S DEVICE HOLDS IT.
 *
 * A company can set, per vault and token, four bands - each a ceiling on a
 * run's total and the approvals a run of that size needs - and a limit on what
 * the vault may pay in one period. The chain holds only a commitment to the
 * policy, under a key it derives from the vault and the token's blinded key,
 * and a marker that the vault is under a policy. The opening stays with the
 * signers.
 *
 * Each run is charged to its period once, by `clearRun`, after it is approved
 * and once its window has opened. A vault under a policy pays only runs that
 * were charged; a vault with no policy is paid as before, at its approvals and
 * with no limit.
 *
 * Every derivation here is the contract's own circuit, called and never written
 * a second way: a device that derived a policy's commitment or a period's key
 * differently would hold an opening the chain does not accept.
 */
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import type { PolicyOpening } from '../../contracts/src/witnesses.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';

export type { PolicyOpening, PolicyBand } from '../../contracts/src/witnesses.js';

/** How many bands a policy has. The contract's `Vector<4, Band>`. */
export const POLICY_BANDS = 4;

/** Refuses a policy the contract could not open, with a sentence saying why. */
export const refuseAnUnusablePolicy = (policy: PolicyOpening): void => {
  if (policy.terms.bands.length !== POLICY_BANDS) {
    throw new Error(`a spending policy has exactly ${POLICY_BANDS} bands; this one has ${policy.terms.bands.length}`);
  }
  if (policy.terms.periodLength <= 0n) {
    throw new Error('a spending policy needs periods of at least one second, or no run could ever fit inside one');
  }
  if (policy.blinding.length !== 32) throw new Error("a spending policy's blinding is 32 bytes");
};

/** What the chain stores for a policy: its terms committed under its blinding. */
export const policyCommitmentOf = (policy: PolicyOpening): Hex => {
  refuseAnUnusablePolicy(policy);
  return toHex(pureCircuits.policyCommitmentOf(policy));
};

/** What signers approve to set `vault`'s policy for the token whose blinded key is `assetKey`. */
export const setPolicyPayloadOf = (vault: Hex, assetKey: Hex, commitment: Hex): Hex =>
  toHex(pureCircuits.setPolicyPayload(fromHex(vault), fromHex(assetKey), fromHex(commitment)));

/** Where the chain keeps `vault`'s policy for the token whose blinded key is `assetKey`. */
export const policyKeyOf = (vault: Hex, assetKey: Hex): Hex =>
  toHex(pureCircuits.policyKeyOf(fromHex(vault), fromHex(assetKey)));

/** Where the chain keeps the marker that `vault` is under a spending policy. */
export const policyOnKeyOf = (vault: Hex): Hex => toHex(pureCircuits.policyOnKeyOf(fromHex(vault)));

/** The key in the account's per-vault thresholds that holds the approvals a policy change needs. */
export const policyBarKey = (): Hex => toHex(pureCircuits.policyBarKey());

/**
 * The approvals a run of `total` needs under `policy`: the first band whose
 * ceiling it fits. Throws for a total above every band: such a run can be
 * raised, but `clearRun` refuses to charge it.
 */
export const requiredFor = (policy: PolicyOpening, total: bigint): bigint => {
  refuseAnUnusablePolicy(policy);
  return pureCircuits.bandApprovals(policy.terms.bands, total);
};

/** When period `period` of `policy` starts and ends, in seconds since the Unix epoch. */
export const periodWindowOf = (policy: PolicyOpening, period: bigint): { from: bigint; until: bigint } => {
  refuseAnUnusablePolicy(policy);
  const from = policy.terms.periodStart + period * policy.terms.periodLength;
  return { from, until: from + policy.terms.periodLength };
};

/**
 * The period a run's whole window lies in, or null when it opens before the
 * policy's first period or crosses from one period into the next. A run the
 * chain cannot charge is refused here rather than after a fee.
 */
export const periodOf = (policy: PolicyOpening, window: { opensAt: bigint; closesAt: bigint }): bigint | null => {
  refuseAnUnusablePolicy(policy);
  if (window.opensAt < policy.terms.periodStart) return null;
  const period = (window.opensAt - policy.terms.periodStart) / policy.terms.periodLength;
  return window.closesAt <= periodWindowOf(policy, period).until ? period : null;
};

/** Where the chain keeps what `vault` has been charged in `period` under this policy. */
export const periodKeyOf = (policyKey: Hex, commitment: Hex, period: bigint): Hex =>
  toHex(pureCircuits.periodKeyOf(fromHex(policyKey), fromHex(commitment), period));

/**
 * The commitment the chain holds for a period's running total. A device that
 * knows what it has charged compares this with the stored value before it
 * charges another run.
 */
export const periodTotalOf = (policy: PolicyOpening, period: bigint, total: bigint): Hex =>
  toHex(pureCircuits.periodTotalOf(total, pureCircuits.periodBlindingOf(policy.blinding, period)));
