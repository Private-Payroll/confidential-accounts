/**
 * A VAULT'S SPENDING POLICY ON THE DEVICE: every value the contract's own.
 *
 * The approvals a total needs, where the chain keeps a policy and a period's
 * total, and which period a run's window lies in, as the device works them out
 * before it asks the chain to charge a run. Every assertion names the change
 * that turns it red.
 */
import { describe, expect, it } from 'vitest';

import { pureCircuits } from '../../contracts/managed/contract/index.js';
import {
  policyCommitmentOf, setPolicyPayloadOf, policyKeyOf, policyOnKeyOf, policyBarKey, requiredFor,
  periodWindowOf, periodOf, periodKeyOf, periodTotalOf, refuseAnUnusablePolicy, type PolicyOpening,
} from './spending-policy.js';
import { fromHex, toHex, type Hex } from '../core/crypto.js';

const POLICY: PolicyOpening = {
  terms: {
    bands: [
      { ceiling: 1_000n, approvals: 2n }, { ceiling: 5_000n, approvals: 3n },
      { ceiling: 10_000n, approvals: 4n }, { ceiling: 100_000n, approvals: 5n },
    ],
    periodLimit: 20_000n, periodStart: 1_000_000n, periodLength: 100n,
  },
  blinding: new Uint8Array(32).fill(0x42),
};
const VAULT = 'a1'.repeat(32) as Hex;
const KEY = 'b2'.repeat(32) as Hex;

describe("a policy's values are the contract's", () => {
  it('the commitment, the round and the keys are the contract circuits, never written a second way', () => {
    /* RED WHEN any of these is derived here rather than read off the contract. */
    expect(policyCommitmentOf(POLICY)).toBe(toHex(pureCircuits.policyCommitmentOf(POLICY)));
    expect(setPolicyPayloadOf(VAULT, KEY, 'c3'.repeat(32) as Hex))
      .toBe(toHex(pureCircuits.setPolicyPayload(fromHex(VAULT), fromHex(KEY), fromHex('c3'.repeat(32)))));
    expect(policyKeyOf(VAULT, KEY)).toBe(toHex(pureCircuits.policyKeyOf(fromHex(VAULT), fromHex(KEY))));
    expect(policyOnKeyOf(VAULT)).toBe(toHex(pureCircuits.policyOnKeyOf(fromHex(VAULT))));
    expect(policyBarKey()).toBe(toHex(pureCircuits.policyBarKey()));
    const pk = policyKeyOf(VAULT, KEY);
    expect(periodKeyOf(pk, policyCommitmentOf(POLICY), 3n))
      .toBe(toHex(pureCircuits.periodKeyOf(fromHex(pk), fromHex(policyCommitmentOf(POLICY)), 3n)));
    expect(periodTotalOf(POLICY, 3n, 700n))
      .toBe(toHex(pureCircuits.periodTotalOf(700n, pureCircuits.periodBlindingOf(POLICY.blinding, 3n))));
  });

  it('a total needs the approvals of the first band it fits, and one above every band is refused', () => {
    /* RED WHEN the band is not the first whose ceiling the total fits. */
    expect([1n, 1_000n, 1_001n, 5_000n, 9_999n, 100_000n].map((t) => requiredFor(POLICY, t)))
      .toEqual([2n, 2n, 3n, 3n, 4n, 5n]);
    /* RED WHEN a total above every band is given a band. */
    expect(() => requiredFor(POLICY, 100_001n)).toThrow(/above every band/);
  });

  it("a run's period is the one its whole window lies in, and a window that crosses one has none", () => {
    /* RED WHEN a period's bounds move. */
    expect(periodWindowOf(POLICY, 2n)).toEqual({ from: 1_000_200n, until: 1_000_300n });
    expect(periodOf(POLICY, { opensAt: 1_000_200n, closesAt: 1_000_300n })).toBe(2n);
    expect(periodOf(POLICY, { opensAt: 1_000_250n, closesAt: 1_000_260n })).toBe(2n);
    /* RED WHEN a window that crosses into the next period, or opens before the first, is given one. */
    expect(periodOf(POLICY, { opensAt: 1_000_250n, closesAt: 1_000_301n })).toBeNull();
    expect(periodOf(POLICY, { opensAt: 999_999n, closesAt: 1_000_050n })).toBeNull();
  });

  it('refuses a policy the contract could not open', () => {
    /* RED WHEN a policy of another shape reaches the contract. */
    expect(() => refuseAnUnusablePolicy({ ...POLICY, terms: { ...POLICY.terms, bands: POLICY.terms.bands.slice(0, 3) } }))
      .toThrow(/exactly 4 bands/);
    expect(() => refuseAnUnusablePolicy({ ...POLICY, terms: { ...POLICY.terms, periodLength: 0n } }))
      .toThrow(/at least one second/);
    expect(() => refuseAnUnusablePolicy({ ...POLICY, blinding: new Uint8Array(31) })).toThrow(/this device's copy of the spending policy is damaged/);
  });
});
