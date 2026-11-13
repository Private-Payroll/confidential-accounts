/**
 * **WHETHER TWO GOVERNANCE CHANGES ARE THE SAME CHANGE.**
 *
 * The one comparison, made by the device that looks for the proposal the
 * company already holds for a change and by the worker that builds a call over
 * an opened proposal. Two changes are the same when they are of one kind, over
 * the same seat, vault, key, commitment or head, at the same number. A number that is
 * not a whole number of at least one is never the same as anything, except a
 * removal's or an invitation's new threshold, where none and 0 both keep the
 * threshold in force.
 *
 * It imports nothing at run time, so the page can compare changes without
 * reaching the code that builds a call.
 */
import type { RoundChangeOnTheWire } from './governed-call-builder.js';

const same = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase();
const atLeastOne = (value: unknown): bigint | null =>
  typeof value === 'string' && /^[0-9]+$/u.test(value) && BigInt(value) >= 1n ? BigInt(value) : null;
const sameNumber = (a: unknown, b: unknown): boolean => {
  const x = atLeastOne(a);
  return x !== null && x === atLeastOne(b);
};

/** A removal's or an invitation's new threshold: none and 0 both keep the one in force; anything else must be a whole number to be the same. */
const removalThreshold = (value: unknown): bigint | null =>
  value === undefined ? 0n : typeof value === 'string' && /^[0-9]+$/u.test(value) ? BigInt(value) : null;
const sameRemovalThreshold = (a: unknown, b: unknown): boolean => {
  const x = removalThreshold(a);
  return x !== null && x === removalThreshold(b);
};

export const sameGovernance = (a: RoundChangeOnTheWire, b: RoundChangeOnTheWire): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'add-signer': {
      const o = b as typeof a;
      return same(a.address, o.address) && same(a.scope, o.scope) && sameRemovalThreshold(a.threshold, o.threshold);
    }
    case 'remove-signer': return same(a.leaf, (b as typeof a).leaf) && sameRemovalThreshold(a.threshold, (b as typeof a).threshold);
    case 'vault-threshold': return same(a.vault, (b as typeof a).vault) && sameNumber(a.threshold, (b as typeof a).threshold);
    case 'adopt-vault':
    case 'retire-vault': return same(a.vault, (b as typeof a).vault);
    case 'pay-key': return same(a.commitment, (b as typeof a).commitment);
    case 'spending-policy': {
      const o = b as typeof a;
      return same(a.vault, o.vault) && same(a.assetKey, o.assetKey) && same(a.commitment, o.commitment);
    }
    case 'policy-bar': return sameNumber(a.bar, (b as typeof a).bar);
    case 'threshold': return sameNumber(a.threshold, (b as typeof a).threshold);
    case 'recover-anchor': {
      const o = b as typeof a;
      return same(a.resumesFrom, o.resumesFrom) && sameNumber(a.latest, o.latest) && same(a.lastRecovery, o.lastRecovery);
    }
  }
};
