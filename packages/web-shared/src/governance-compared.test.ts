/**
 * **TWO GOVERNANCE CHANGES ARE THE SAME CHANGE ONLY WHEN THEY ARE OF ONE KIND,
 * OVER THE SAME THING, AT THE SAME NUMBER** - the one comparison the device
 * and the worker both make. Every assertion names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import { sameGovernance } from './governance-compared.js';
import type { RoundChangeOnTheWire } from './governed-call-builder.js';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const EVERY: RoundChangeOnTheWire[] = [
  { kind: 'add-signer', address: A, scope: B },
  { kind: 'threshold', threshold: '2' },
  { kind: 'vault-threshold', vault: A, threshold: '2' },
  { kind: 'adopt-vault', vault: A },
  { kind: 'pay-key', commitment: A },
  { kind: 'spending-policy', vault: A, assetKey: B, commitment: C },
  { kind: 'policy-bar', bar: '2' },
  { kind: 'recover-anchor', resumesFrom: A, latest: '1800000000', lastRecovery: C },
] as RoundChangeOnTheWire[];

describe('THE SAME GOVERNANCE CHANGE', () => {
  it('EVERY KIND IS THE SAME AS ITSELF, WRITTEN IN EITHER CASE, AND AS NO CHANGE OF ANOTHER KIND', () => {
    for (const a of EVERY) {
      const upper = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === 'kind' ? v : String(v).toUpperCase()])) as RoundChangeOnTheWire;
      /* RED WHEN: a change is not the same as itself, or its identifiers are compared by case - the device then raises a second proposal. */
      expect(sameGovernance(a, a), a.kind).toBe(true);
      expect(sameGovernance(a, upper), a.kind).toBe(true);
      /* RED WHEN: changes of two kinds compare the same - an approval of one is built for the other. */
      for (const b of EVERY) if (b !== a) expect(sameGovernance(a, b), `${a.kind} ${b.kind}`).toBe(false);
    }
  });

  it('EACH THING A CHANGE IS OVER, AND EACH NUMBER IT SETS, MAKES IT ANOTHER CHANGE', () => {
    const other: Array<[RoundChangeOnTheWire, RoundChangeOnTheWire]> = [
      [{ kind: 'add-signer', address: A, scope: B }, { kind: 'add-signer', address: C, scope: B }],
      [{ kind: 'add-signer', address: A, scope: B }, { kind: 'add-signer', address: A, scope: C }],
      [{ kind: 'threshold', threshold: '2' }, { kind: 'threshold', threshold: '3' }],
      [{ kind: 'vault-threshold', vault: A, threshold: '2' }, { kind: 'vault-threshold', vault: B, threshold: '2' }],
      [{ kind: 'vault-threshold', vault: A, threshold: '2' }, { kind: 'vault-threshold', vault: A, threshold: '3' }],
      [{ kind: 'adopt-vault', vault: A }, { kind: 'adopt-vault', vault: B }],
      [{ kind: 'pay-key', commitment: A }, { kind: 'pay-key', commitment: B }],
      [{ kind: 'spending-policy', vault: A, assetKey: B, commitment: C }, { kind: 'spending-policy', vault: B, assetKey: B, commitment: C }],
      [{ kind: 'spending-policy', vault: A, assetKey: B, commitment: C }, { kind: 'spending-policy', vault: A, assetKey: A, commitment: C }],
      [{ kind: 'spending-policy', vault: A, assetKey: B, commitment: C }, { kind: 'spending-policy', vault: A, assetKey: B, commitment: A }],
      [{ kind: 'policy-bar', bar: '2' }, { kind: 'policy-bar', bar: '3' }],
      [{ kind: 'recover-anchor', resumesFrom: A, latest: '1800000000', lastRecovery: C }, { kind: 'recover-anchor', resumesFrom: B, latest: '1800000000', lastRecovery: C }],
      [{ kind: 'recover-anchor', resumesFrom: A, latest: '1800000000', lastRecovery: C }, { kind: 'recover-anchor', resumesFrom: A, latest: '1800000001', lastRecovery: C }],
      [{ kind: 'recover-anchor', resumesFrom: A, latest: '1800000000', lastRecovery: C }, { kind: 'recover-anchor', resumesFrom: A, latest: '1800000000', lastRecovery: B }],
    ] as Array<[RoundChangeOnTheWire, RoundChangeOnTheWire]>;
    /* RED WHEN: any one field is left out of the comparison - an approval is built for, or a proposal found for, another change. */
    for (const [a, b] of other) expect(sameGovernance(a, b), JSON.stringify(b)).toBe(false);
  });

  it('A NUMBER IS COMPARED AS A NUMBER, AND ONE THAT IS NOT A WHOLE NUMBER OF AT LEAST ONE IS THE SAME AS NOTHING', () => {
    /* RED WHEN: numbers are compared as text, so "02" is another bar than "2". */
    expect(sameGovernance({ kind: 'policy-bar', bar: '02' } as RoundChangeOnTheWire, { kind: 'policy-bar', bar: '2' } as RoundChangeOnTheWire)).toBe(true);
    expect(sameGovernance({ kind: 'threshold', threshold: '02' } as RoundChangeOnTheWire, { kind: 'threshold', threshold: '2' } as RoundChangeOnTheWire)).toBe(true);
    /* RED WHEN: a number no change carries - zero, a fraction, a sign, nothing - matches itself, or the comparison throws on it. */
    for (const bad of ['0', '1.5', '-1', '', ' 1']) {
      expect(sameGovernance({ kind: 'policy-bar', bar: bad } as RoundChangeOnTheWire, { kind: 'policy-bar', bar: bad } as RoundChangeOnTheWire), bad).toBe(false);
      expect(sameGovernance({ kind: 'threshold', threshold: bad } as RoundChangeOnTheWire, { kind: 'threshold', threshold: bad } as RoundChangeOnTheWire), bad).toBe(false);
      expect(sameGovernance({ kind: 'vault-threshold', vault: A, threshold: bad } as RoundChangeOnTheWire, { kind: 'vault-threshold', vault: A, threshold: bad } as RoundChangeOnTheWire), bad).toBe(false);
    }
  });

  it('A REMOVAL IS THE SAME CHANGE ONLY FOR THE SAME LEAF AT THE SAME NEW THRESHOLD, WHERE NONE AND 0 BOTH KEEP THE ONE IN FORCE', () => {
    const keeps = { kind: 'remove-signer', leaf: A } as RoundChangeOnTheWire;
    /* RED WHEN: a removal that keeps the threshold is not the same as one that names 0, which also keeps it. */
    expect(sameGovernance(keeps, { kind: 'remove-signer', leaf: A, threshold: '0' } as RoundChangeOnTheWire)).toBe(true);
    expect(sameGovernance({ kind: 'remove-signer', leaf: A, threshold: '02' } as RoundChangeOnTheWire, { kind: 'remove-signer', leaf: A, threshold: '2' } as RoundChangeOnTheWire)).toBe(true);
    /* RED WHEN: the new threshold is left out of the comparison - an approval is built for, or a proposal found for, another removal. */
    expect(sameGovernance(keeps, { kind: 'remove-signer', leaf: A, threshold: '2' } as RoundChangeOnTheWire)).toBe(false);
    expect(sameGovernance({ kind: 'remove-signer', leaf: A, threshold: '2' } as RoundChangeOnTheWire, { kind: 'remove-signer', leaf: A, threshold: '3' } as RoundChangeOnTheWire)).toBe(false);
    expect(sameGovernance(keeps, { kind: 'remove-signer', leaf: B } as RoundChangeOnTheWire)).toBe(false);
    /* RED WHEN: a threshold that is not a whole number counts as keeping the one in force. */
    expect(sameGovernance(keeps, { kind: 'remove-signer', leaf: A, threshold: 'x' } as RoundChangeOnTheWire)).toBe(false);
  });

  it('AN INVITATION IS THE SAME CHANGE ONLY AT THE SAME NEW THRESHOLD, WHERE NONE AND 0 BOTH KEEP THE ONE IN FORCE', () => {
    const keeps = { kind: 'add-signer', address: A, scope: B } as RoundChangeOnTheWire;
    /* RED WHEN: an invitation that keeps the threshold is not the same as one that names 0, which also keeps it. */
    expect(sameGovernance(keeps, { kind: 'add-signer', address: A, scope: B, threshold: '0' } as RoundChangeOnTheWire)).toBe(true);
    /* RED WHEN: the threshold an invitation sets is left out of the comparison - a seat is approved, or a proposal found, at another threshold. */
    expect(sameGovernance(keeps, { kind: 'add-signer', address: A, scope: B, threshold: '2' } as RoundChangeOnTheWire)).toBe(false);
    expect(sameGovernance({ kind: 'add-signer', address: A, scope: B, threshold: '2' } as RoundChangeOnTheWire,
      { kind: 'add-signer', address: A, scope: B, threshold: '3' } as RoundChangeOnTheWire)).toBe(false);
    expect(sameGovernance({ kind: 'add-signer', address: A, scope: B, threshold: '2' } as RoundChangeOnTheWire,
      { kind: 'add-signer', address: A, scope: B, threshold: '2' } as RoundChangeOnTheWire)).toBe(true);
  });
});
