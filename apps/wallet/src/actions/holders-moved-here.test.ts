/*
 * How each call this wallet sends moves who holds the company, as the account's circuits move it: a seat taken or
 * emptied with the threshold it names (0 keeping the one in force), a threshold set, a vault's threshold set and the
 * approvals a policy change needs raised to it, that bar set or raised by a policy, a vault adopted or retired; and the one
 * table of the kinds whose carrying out moves them, naming each carry's chain call and the write it is asked by first.
 */
import { describe, expect, it } from 'vitest';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import {
  adopted,
  CARRIED_BY,
  carriedCall,
  carryWrites,
  movesWhoHoldsByCircuit,
  policyBarSet,
  policySet,
  removed,
  retired,
  seated,
  thresholdSet,
  vaultThresholdSet
} from './holders-moved-here.js';

const V1 = 'ab'.repeat(32);
const V2 = 'cd'.repeat(32);
const HELD = {
  seats: ['a1', 'a2'],
  approvals: 2,
  adoptedVaults: [V1],
  threshold: 1,
  committee: [],
  vaultThresholds: [{ vault: V1, threshold: 2 }],
  policyBar: 2
} as unknown as AccountHoldersRead;

describe('A CALL THAT MOVES WHO HOLDS THE COMPANY MOVES IT AS THE ACCOUNT DOES', () => {
  it('seats a leaf, or empties one, at the threshold the call names, and keeps the one in force for 0', () => {
    /* RED WHEN: a seat taken or emptied leaves other seats, or a threshold the call does not set. */
    expect(seated('A3', 3)(HELD)).toMatchObject({ seats: ['a1', 'a2', 'a3'], approvals: 3 });
    expect(seated('a3', 0)(HELD)).toMatchObject({ seats: ['a1', 'a2', 'a3'], approvals: 2 });
    expect(removed('A2', 1)(HELD)).toMatchObject({ seats: ['a1'], approvals: 1 });
    expect(removed('a2', 0)(HELD)).toMatchObject({ seats: ['a1'], approvals: 2 });
  });

  it("sets the threshold, a vault's row and the bar, raising the bar to a vault's threshold or a policy's highest band only", () => {
    /* RED WHEN: a threshold, a vault's row or the approvals a policy change needs move other than as the account moves them. */
    expect(thresholdSet(1)(HELD)).toMatchObject({ approvals: 1, policyBar: 2 });
    expect(vaultThresholdSet(V1.toUpperCase(), 3)(HELD)).toMatchObject({
      vaultThresholds: [{ vault: V1, threshold: 3 }],
      policyBar: 3
    });
    expect(vaultThresholdSet(V2, 1)(HELD)).toMatchObject({
      vaultThresholds: [
        { vault: V1, threshold: 2 },
        { vault: V2, threshold: 1 }
      ],
      policyBar: 2
    });
    expect(vaultThresholdSet(V2, 1)({ ...HELD, policyBar: null })).toMatchObject({ policyBar: 1 });
    expect(policyBarSet(1)(HELD)).toMatchObject({ policyBar: 1 });
    expect(policySet(3)(HELD)).toMatchObject({ policyBar: 3 });
    expect(policySet(1)(HELD)).toMatchObject({ policyBar: 2 });
  });

  it('adopts a vault and lets one go, and names the carry of one proposal by its own write and its chain call', () => {
    /* RED WHEN: an adoption leaves the vaults as they were. */
    expect(adopted(V2.toUpperCase())(HELD).adoptedVaults).toEqual([V1, V2]);
    /* RED WHEN: a carry is named by another circuit or contract than the one its kind is carried out by, or another proposal's write. */
    expect(carriedCall({ kind: 'threshold', move: thresholdSet(1) }, 'Fe'.repeat(32))).toEqual({
      circuit: 'setThreshold',
      contract: 'fe'.repeat(32)
    });
    expect(carriedCall({ kind: 'retire-vault', move: retired(V1), vault: V1.toUpperCase() }, 'c0')).toEqual({
      circuit: 'retire',
      contract: V1
    });
    expect(() => carriedCall({ kind: 'retire-vault', move: retired(V1) }, 'c0')).toThrow(/names no vault/u);
    expect(carryWrites('prp_1', { kind: 'removal', move: removed('a2', 0) })).toEqual([{ proposal: 'prp_1' }]);
    expect(carryWrites('prp_1', { kind: 'adopt-vault', move: adopted(V2) })).toEqual([]);
    /* RED WHEN: a call some kind is carried out by is not known to move who holds the company, or one that does not is. */
    for (const by of Object.values(CARRIED_BY)) expect(movesWhoHoldsByCircuit(by.circuit), by.circuit).toBe(true);
    expect(movesWhoHoldsByCircuit('approve')).toBe(false);
    /* RED WHEN: a retirement leaves the vault among those the account adopts. */
    expect(retired(V1.toUpperCase())(HELD).adoptedVaults).toEqual([]);
  });
});
