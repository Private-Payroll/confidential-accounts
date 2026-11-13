/**
 * What a change to who is seated, a vault's threshold, a spending policy or
 * the approvals a policy change needs costs, as a page shows it before the
 * change is raised: the approvals, what sets them, and what becomes public.
 */
import { describe, it, expect } from 'vitest';
import { changeHoldersOf, whatAChangeCosts, type ChangeHolders } from './change-costs.js';

const VAULT = 'fa'.repeat(32);
const OTHER = 'fb'.repeat(32);
const held = (o: Partial<ChangeHolders>): ChangeHolders => {
  const approvals = o.approvals ?? 2;
  const policyBar = o.policyBar ?? null;
  return { approvals, policyBar, seatBar: Math.max(approvals, policyBar ?? 0), vaultThresholds: [], seated: 3, ...o };
};
const bands = (...approvals: number[]) => approvals.map((a) => ({ approvals: String(a) }));

describe('WHAT A CHANGE OF WHO IS SEATED COSTS', () => {
  it('a removal when the account needs every seated signer says so', () => {
    const cost = whatAChangeCosts(held({ approvals: 3, seated: 3 }), { kind: 'seating', seat: 'remove' });
    /* RED WHEN: a removal needs the account's threshold minus the leaving signer. */
    expect(cost.needed).toBe(3);
    /* RED WHEN: the removal is counted against one signer fewer than are seated today. */
    expect(cost.everySigner).toBe(true);
    expect(cost.because).toBe('account');
  });

  it('a removal under a bar a vault raised names that vault', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, policyBar: 3, seated: 4, vaultThresholds: [{ vault: OTHER, threshold: 2 }, { vault: VAULT, threshold: 3 }] }),
      { kind: 'seating', seat: 'remove' });
    /* RED WHEN: a removal needs only the account's threshold, under a bar above it. */
    expect(cost.needed).toBe(3);
    /* RED WHEN: the vault holding the bar is not named. */
    expect(cost.because).toEqual({ vault: VAULT });
    expect(cost.everySigner).toBe(false);
  });

  it('a removal under a bar set for policy changes names that bar', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, policyBar: 3, seated: 4, vaultThresholds: [{ vault: VAULT, threshold: 2 }] }),
      { kind: 'seating', seat: 'remove' });
    expect(cost.needed).toBe(3);
    /* RED WHEN: a bar no vault holds is put down to the account's threshold. */
    expect(cost.because).toBe('policy-bar');
  });

  it('a re-seat is public as one seat leaving and one joining, and nothing else but its approvals', () => {
    /* RED WHEN: a re-seat is shown as only a seat joining. */
    expect(whatAChangeCosts(held({}), { kind: 'seating', seat: 'reseat' }).publicFacts)
      .toEqual([{ fact: 'a-seat-leaves' }, { fact: 'a-seat-joins' }, { fact: 'approval-count' }]);
  });
});

describe('WHAT A SPENDING POLICY COSTS', () => {
  it('a band above the bar raises it, and a band of every signer is warned of', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, seated: 3 }), { kind: 'spending-policy', vault: VAULT, bands: bands(1, 3, 2, 2) });
    expect(cost.needed).toBe(2);
    /* RED WHEN: the bar is raised to the policy's first band rather than its highest. */
    expect(cost.barRaisedTo).toBe(3);
    /* RED WHEN: a policy whose highest band needs every signer is not warned of. */
    expect(cost.everySigner).toBe(true);
    /* RED WHEN: the raised bar or the highest band it shows is not listed as public. */
    expect(cost.publicFacts).toEqual([
      { fact: 'vault-has-a-policy', vault: VAULT },
      { fact: 'policy-bar', value: 3 },
      { fact: 'highest-band', vault: VAULT, value: 3 },
      { fact: 'approval-count' },
    ]);
  });

  it('a policy whose bands stay under the bar raises nothing and shows no band', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, policyBar: 3, seated: 4 }), { kind: 'spending-policy', vault: VAULT, bands: bands(1, 2, 2, 3) });
    /* RED WHEN: a policy change needs only the account's threshold under a higher bar. */
    expect(cost.needed).toBe(3);
    expect(cost.because).toBe('policy-bar');
    expect(cost.barRaisedTo).toBeUndefined();
    /* RED WHEN: a band the chain never writes is listed as public. */
    expect(cost.publicFacts).toEqual([{ fact: 'vault-has-a-policy', vault: VAULT }, { fact: 'approval-count' }]);
  });
});

describe('WHAT A CHANGE OF THE APPROVALS A POLICY CHANGE NEEDS COSTS', () => {
  it('a bar set lower is said as lowered, at the approvals of the bar it replaces', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, policyBar: 4, seated: 4 }), { kind: 'policy-bar', bar: 2 });
    expect(cost.needed).toBe(4);
    /* RED WHEN: lowering the bar is not shown as lowering it. */
    expect(cost.barLoweredTo).toBe(2);
    expect(cost.barRaisedTo).toBeUndefined();
    expect(cost.everySigner).toBe(true);
  });
});

describe('WHAT A VAULT THRESHOLD COSTS', () => {
  it('a vault above the bar raises it, and its threshold and the bar become public', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, seated: 4, vaultThresholds: [{ vault: VAULT, threshold: 2 }] }),
      { kind: 'vault-threshold', vault: VAULT, threshold: 3 });
    expect(cost.needed).toBe(2);
    /* RED WHEN: a vault threshold above the bar does not raise it. */
    expect(cost.barRaisedTo).toBe(3);
    expect(cost.everySigner).toBe(false);
    expect(cost.publicFacts).toEqual([
      { fact: 'vault-threshold', vault: VAULT, value: 3 }, { fact: 'policy-bar', value: 3 }, { fact: 'approval-count' },
    ]);
  });

  it('lowering a vault under a raised bar needs that bar and names the vault holding it', () => {
    const cost = whatAChangeCosts(held({ approvals: 2, policyBar: 3, seated: 4, vaultThresholds: [{ vault: OTHER, threshold: 3 }, { vault: VAULT, threshold: 3 }] }),
      { kind: 'vault-threshold', vault: VAULT, threshold: 2 });
    /* RED WHEN: lowering a vault needs only the account's threshold. */
    expect(cost.needed).toBe(3);
    expect(cost.because).toEqual({ vault: OTHER });
  });
});

describe('WHAT THE WALLET READ OF WHO HOLDS THE ACCOUNT, AS A CHANGE IS COSTED FROM IT', () => {
  const read = { approvals: 2, vaultThresholds: [{ vault: VAULT, threshold: 3 }], policyBar: 3 as number | null, seatBar: 3, seats: ['a', 'b', 'c', 'd'] };

  /* RED WHEN: any of the account's approvals, a vault's threshold, the policy bar or the seat bar is dropped or changed on its way to the cost, or the signers seated are counted from anything but the seats read. */
  it('carries the four figures as read and counts the seats', () => {
    expect(changeHoldersOf(read)).toEqual({ approvals: 2, vaultThresholds: [{ vault: VAULT, threshold: 3 }], policyBar: 3, seatBar: 3, seated: 4 });
  });

  /* RED WHEN: an account with no stored policy bar or no seats is given a bar or a seat count the wallet did not read. */
  it('keeps no policy bar as none, and no seats as none seated', () => {
    expect(changeHoldersOf({ ...read, policyBar: null, vaultThresholds: [], seats: [] }))
      .toEqual({ approvals: 2, vaultThresholds: [], policyBar: null, seatBar: 3, seated: 0 });
  });

  /* RED WHEN: the holders handed on carry the seats themselves, so a page holds more of the account than a cost needs. */
  it('hands on nothing but the figures a cost reads', () => {
    expect(Object.keys(changeHoldersOf(read)).sort()).toEqual(['approvals', 'policyBar', 'seatBar', 'seated', 'vaultThresholds']);
  });
});
