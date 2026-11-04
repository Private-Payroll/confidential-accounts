/**
 * NO CHANGE A SIGNER APPROVES LEAVES A VAULT UNABLE TO PAY.
 *
 * What a signer may do is private in their leaf, so the chain cannot count how
 * many signers may approve a vault's runs. Each signer's device counts it from
 * the company's records before approving a seat, a removal, a change of rights
 * or a change of a bar, and refuses one that would leave a vault fewer such
 * signers than its runs need.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';

import {
  approverRosterFrom, barOf, policyChangeRefusal, withBandsInForce, vaultsLeftShort, refuseLeavingAVaultShort, thresholdCarryBar, thresholdChangeRefusal, removalRefusal,
  seatRightsOf, seatThresholdRefusal, type ApproverRoster, type RemovalBounds, type SeatRights, type ThresholdBounds,
} from './vault-approvers.js';

const PAYROLL = 'aa'.repeat(32);
const TREASURY = 'bb'.repeat(32);
const COMPANY = 'cc'.repeat(32);
const EVERY: SeatRights = { every: true };
const approverOn = (...vaults: string[]): SeatRights => ({ mayApprove: true, everyVault: false, onVaults: vaults });
const raiserOnly: SeatRights = { mayApprove: false, everyVault: true, onVaults: [] };

const roster = (seats: [string, SeatRights][], threshold = 2, vaultThresholds: [string, number][] = []): ApproverRoster => ({
  seats: new Map(seats), threshold, vaultThresholds: new Map(vaultThresholds), runVaults: [PAYROLL, TREASURY, COMPANY],
});
const names = (v: string) => ({ [PAYROLL]: 'Payroll', [TREASURY]: 'Treasury', [COMPANY]: 'company-wide runs' })[v] ?? v;

describe('a change that would leave a vault short is refused on the device', () => {
  it('A REMOVAL THAT TAKES A VAULT BELOW ITS BAR', () => {
    const r = roster([['a', EVERY], ['b', approverOn(PAYROLL)], ['c', approverOn(TREASURY)]]);
    /* RED WHEN a removed seat is still counted. */
    expect(vaultsLeftShort(r, { kind: 'remove', leaf: 'b' }).map((s) => s.vault)).toEqual([PAYROLL]);
    expect(() => refuseLeavingAVaultShort(r, { kind: 'remove', leaf: 'b' }, names))
      .toThrow(/this change would leave a vault unable to pay: Payroll \(its runs need 2 approvals and 1 signer could give them\)/);
    /* RED WHEN one approval is written as "1 approvals". */
    expect(() => refuseLeavingAVaultShort(
      roster([['a', EVERY], ['b', approverOn(PAYROLL)]], 1, [[PAYROLL, 1]]), { kind: 'reseat', from: 'a', to: 'a2', rights: raiserOnly }, names))
      .toThrow(/Treasury \(its runs need 1 approval and 0 signers could give them\)/);
  });

  it('A CHANGE OF RIGHTS THAT TAKES AWAY THE APPROVE RIGHT', () => {
    const r = roster([['a', EVERY], ['b', EVERY]]);
    /* RED WHEN a seat's rights are read as every right whatever it was given. */
    expect(vaultsLeftShort(r, { kind: 'reseat', from: 'b', to: 'b2', rights: raiserOnly }).map((s) => s.vault))
      .toEqual([PAYROLL, TREASURY, COMPANY]);
    /* RED WHEN the vault set is ignored: approving on Treasury alone leaves Payroll short. */
    expect(vaultsLeftShort(r, { kind: 'reseat', from: 'b', to: 'b2', rights: approverOn(TREASURY) }).map((s) => s.vault))
      .toEqual([PAYROLL, COMPANY]);
  });

  it('A BAR RAISED ABOVE THE SIGNERS WHO MAY APPROVE THERE', () => {
    const r = roster([['a', EVERY], ['b', EVERY], ['c', approverOn(TREASURY)]]);
    /* RED WHEN a vault's own threshold is not read. */
    expect(vaultsLeftShort(r, { kind: 'vaultThreshold', vault: PAYROLL, threshold: 3 }).map((s) => s.vault))
      .toEqual([PAYROLL]);
    /* RED WHEN the company's threshold is not what a vault without its own uses. */
    expect(vaultsLeftShort(r, { kind: 'threshold', threshold: 3 }).map((s) => s.vault)).toEqual([PAYROLL, COMPANY]);
  });

  it('a change that leaves every vault able to pay is not refused', () => {
    const r = roster([['a', EVERY], ['b', EVERY], ['c', approverOn(PAYROLL)]]);
    expect(vaultsLeftShort(r, { kind: 'remove', leaf: 'c' })).toEqual([]);
    expect(() => refuseLeavingAVaultShort(r, { kind: 'seat', leaf: 'd', rights: raiserOnly }, names)).not.toThrow();
  });

  it('a removal that sets the threshold is judged at the new threshold, without the removed seat', () => {
    const r = roster([['a', EVERY], ['b', EVERY], ['c', EVERY]], 3);
    /* RED WHEN the combined change stops removing the seat: three would still approve at three. */
    expect(vaultsLeftShort(r, { kind: 'removeAndThreshold', leaf: 'c', threshold: 3 }).map((s) => s.vault))
      .toEqual([PAYROLL, TREASURY, COMPANY]);
    expect(vaultsLeftShort(r, { kind: 'removeAndThreshold', leaf: 'c', threshold: 2 })).toEqual([]);
  });

  it('reads a leaf or a vault written in either case as the same one', () => {
    const r = roster([['a', EVERY], ['BB'.repeat(32), EVERY]], 2, [[PAYROLL.toUpperCase(), 1]]);
    /* RED WHEN leaves are compared exactly: the removal then removes nobody. */
    expect(vaultsLeftShort(r, { kind: 'remove', leaf: 'bb'.repeat(32) }).map((s) => s.vault)).toEqual([TREASURY, COMPANY]);
    /* RED WHEN a vault's old threshold, under another spelling, survives the change beside the new one. */
    expect(vaultsLeftShort(r, { kind: 'vaultThreshold', vault: PAYROLL, threshold: 3 }).map((s) => s.vault)).toEqual([PAYROLL]);
  });

  it('A VAULT ALREADY SHORT DOES NOT BLOCK THE CHANGE THAT REPAIRS IT', () => {
    const r = roster([['a', EVERY], ['b', raiserOnly]]);
    /* Payroll needs 2 and has 1. Giving b the approve right on Payroll repairs it, and Treasury stays as short as it was. */
    /* RED WHEN a vault short before and after is held against any change. */
    expect(vaultsLeftShort(r, { kind: 'reseat', from: 'b', to: 'b2', rights: approverOn(PAYROLL) })).toEqual([]);
    /* But a change that makes a short vault shorter still is refused. */
    expect(vaultsLeftShort(r, { kind: 'remove', leaf: 'a' }).map((s) => s.vault)).toEqual([PAYROLL, TREASURY, COMPANY]);
  });
});

describe('A VAULT\'S BAR IS THE MOST ITS RUNS CAN ASK FOR', () => {
  it('A BAND OF A SPENDING POLICY THAT ASKS FOR MORE THAN THE THRESHOLD IS THE BAR', () => {
    const r: ApproverRoster = { ...roster([['a', EVERY], ['b', EVERY], ['c', EVERY]]), bands: new Map([[PAYROLL, 3]]) };
    /* RED WHEN: a vault's bands are not counted, so a removal leaves its large payments unapprovable. */
    expect(barOf(r, PAYROLL)).toBe(3);
    expect(vaultsLeftShort(r, { kind: 'remove', leaf: 'c' }).map((s) => s.vault)).toEqual([PAYROLL]);
    /* A band that asks for less than the threshold does not lower it. */
    expect(barOf({ ...r, bands: new Map([[PAYROLL, 1]]) }, PAYROLL)).toBe(2);
  });

  it('A VAULT WITH A RUN OPEN NEEDS ONE MORE FOR EVERY SIGNER REMOVED SINCE, AND A REMOVAL COUNTS ITSELF', () => {
    const open: ApproverRoster = { ...roster([['a', EVERY], ['b', EVERY], ['c', EVERY]]), openRuns: new Set([PAYROLL]) };
    /* RED WHEN: a removal while a run is open is judged at the bar the run was raised under. */
    expect(vaultsLeftShort(open, { kind: 'remove', leaf: 'c' }).map((s) => s.vault)).toEqual([PAYROLL]);
    expect(barOf({ ...open, removals: 1 }, PAYROLL)).toBe(3);
    /* RED WHEN: the removals are counted against a vault with no run open. */
    expect(barOf({ ...open, removals: 1 }, TREASURY)).toBe(2);
  });

  it('A VAULT ADOPTED IS HELD TO ITS BAR FROM THE START', () => {
    const NEW = 'dd'.repeat(32);
    const r: ApproverRoster = { ...roster([['a', EVERY], ['b', raiserOnly]]), vaultThresholds: new Map([[NEW, 2]]) };
    /* RED WHEN: a vault adopted short passes because it was not short before - it was not the company's before. */
    expect(vaultsLeftShort(r, { kind: 'adopt', vault: NEW })).toEqual([{ vault: NEW, approvers: 1, needs: 2 }]);
    expect(() => refuseLeavingAVaultShort(r, { kind: 'adopt', vault: NEW }, () => 'Reserve')).toThrow(/Reserve \(its runs need 2 approvals/);
    /* And one adopted with enough signers is not refused, nor is adopting a vault again. */
    expect(vaultsLeftShort({ ...r, vaultThresholds: new Map([[NEW, 1]]) }, { kind: 'adopt', vault: NEW })).toEqual([]);
  });

  it('THE COMPANY IS COUNTED FROM WHAT THE DEVICE READ, A SEAT WITH NO RIGHTS RECORDED HOLDING EVERY RIGHT', () => {
    const r = approverRosterFrom({
      threshold: 2, vaultThresholds: [{ vault: PAYROLL.toUpperCase(), threshold: 3 }],
      seated: [{ leaf: 'A1' }, { leaf: 'b2', rights: raiserOnly }], adoptedVaults: [PAYROLL.toUpperCase()], companyWide: COMPANY,
      bands: new Map([[TREASURY, 4]]),
    });
    /* RED WHEN: a seat with no rights recorded is counted as unable to approve, or leaves and vaults keep their case. */
    expect([...r.seats.entries()]).toEqual([['a1', { every: true }], ['b2', raiserOnly]]);
    expect(r.runVaults).toEqual([PAYROLL, COMPANY]);
    expect(r.vaultThresholds.get(PAYROLL)).toBe(3);
    /* RED WHEN: the bands read are dropped on the way into the count. */
    expect(barOf(r, TREASURY)).toBe(4);
  });
});

describe('a change of the approvals needed is refused on the device when the chain would refuse it or a vault could no longer pay', () => {
  const four = roster([['a', EVERY], ['b', EVERY], ['c', approverOn(PAYROLL)], ['d', raiserOnly]]);
  const bounds: ThresholdBounds = { seats: 4, approvals: 2, policyBar: null, adoptedVaults: [PAYROLL, TREASURY], companyWide: COMPANY };

  it('a threshold that is not a whole number of at least one, or more than the seats the account holds, is refused', () => {
    /* RED WHEN: a threshold of nought, or part of an approval, is raised, and the chain refuses it only when it is carried out. */
    for (const n of [0, -1, 1.5, Number.NaN]) expect(thresholdChangeRefusal(four, bounds, { kind: 'threshold', threshold: n })).toMatch(/whole number, at least one/u);
    /* RED WHEN: a threshold above the seats the chain holds is raised, though no seat could ever carry it out. */
    expect(thresholdChangeRefusal(four, bounds, { kind: 'threshold', threshold: 5 })).toMatch(/more approvals than the 4 signers/u);
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 5 })).toMatch(/more approvals than the 4 signers/u);
    expect(thresholdChangeRefusal(four, bounds, { kind: 'threshold', threshold: 1 })).toBeNull();
  });

  it('the value company-wide runs name is not a vault, and a vault the account has not adopted is not raised past the seat bar', () => {
    /* RED WHEN: a threshold is raised for company-wide runs as if they were a vault, which the chain refuses at carry-out. */
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: COMPANY as never, threshold: 2 })).toMatch(/company-wide runs always need the account's threshold/u);
    const NEW = 'dd'.repeat(32);
    /* RED WHEN: a vault the account does not hold is raised past the approvals a change of who is seated needs. */
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: NEW as never, threshold: 3 })).toMatch(/not one the company's account holds/u);
    expect(thresholdChangeRefusal(four, { ...bounds, policyBar: 3 }, { kind: 'vaultThreshold', vault: NEW as never, threshold: 3 })).toBeNull();
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: NEW as never, threshold: 2 })).toBeNull();
  });

  it('a raise that would leave a vault fewer signers who may approve its runs than they need is refused, naming the vault', () => {
    /* Payroll has three signers who may approve; Treasury and company-wide runs two. */
    /* RED WHEN: a company threshold of three is raised though only two signers may approve Treasury's runs. */
    expect(thresholdChangeRefusal(four, bounds, { kind: 'threshold', threshold: 3 }, names)).toMatch(/^this change would leave vaults unable to pay: Treasury .*company-wide runs/u);
    /* RED WHEN: Payroll's own threshold of three is refused though three signers may approve it. */
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 3 }, names)).toBeNull();
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: TREASURY as never, threshold: 3 }, names)).toMatch(/Treasury \(its runs need 3 approvals and 2 signers could give them\)/u);
    /* A lowering never leaves a vault shorter. */
    expect(thresholdChangeRefusal(four, bounds, { kind: 'threshold', threshold: 1 }, names)).toBeNull();
  });

  it('signers removed since the open proposals were raised are counted against every vault', () => {
    const outrun: ApproverRoster = { ...four, openRuns: new Set([PAYROLL, TREASURY, COMPANY]), removals: 1 };
    /* RED WHEN: a run raised before a removal is counted at the vault's bar alone, and a raise leaves it unable ever to be paid. */
    expect(thresholdChangeRefusal(outrun, bounds, { kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 3 }, names)).toMatch(/Payroll \(its runs need 4 approvals and 3 signers/u);
    expect(thresholdChangeRefusal(four, bounds, { kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 3 }, names)).toBeNull();
    /* RED WHEN: the removals read are dropped on the way into the count. */
    expect(approverRosterFrom({ threshold: 2, vaultThresholds: [], seated: [], adoptedVaults: [], companyWide: COMPANY, removals: 2 }).removals).toBe(2);
  });

  it('a threshold change is judged without the policy bands, which can only refuse more, never less; a removal is not, and counts them', () => {
    /* Every roster of up to three signers, every threshold, band and change up to four: wherever the count with bands refuses, the one without does too. */
    const rights: SeatRights[] = [EVERY, approverOn(PAYROLL), raiserOnly];
    let compared = 0;
    for (const a of rights) for (const b of rights) for (const c of rights) for (const t of [1, 2, 3]) for (const v of [0, 1, 2, 3]) for (const band of [0, 1, 2, 3, 4]) {
      const base = roster([['a', a], ['b', b], ['c', c]], t, v === 0 ? [] : [[PAYROLL, v]]);
      const banded: ApproverRoster = { ...base, bands: new Map(band === 0 ? [] : [[PAYROLL, band]]) };
      for (const change of [{ kind: 'threshold' as const, threshold: 1 }, { kind: 'threshold' as const, threshold: 3 },
        { kind: 'vaultThreshold' as const, vault: PAYROLL as never, threshold: 2 }, { kind: 'vaultThreshold' as const, vault: PAYROLL as never, threshold: 3 }]) {
        compared += 1;
        if (vaultsLeftShort(banded, change).length === 0) continue;
        /* RED WHEN: a change the count with bands would refuse is let through because the bands are left out. */
        expect(thresholdChangeRefusal(banded, { ...bounds, seats: 3 }, change)).not.toBeNull();
      }
    }
    expect(compared).toBe(27 * 3 * 4 * 5 * 4);
    /* And the bands are not read: a vault already short of its band is still refused a raise that leaves it unable to pay any run. */
    const short: ApproverRoster = { ...roster([['a', EVERY], ['b', EVERY]], 1), bands: new Map([[PAYROLL, 3]]) };
    /* RED WHEN: the bands are counted, and a raise to three on a vault two signers approve passes because its band already needed three. */
    expect(thresholdChangeRefusal(short, { ...bounds, seats: 3 }, { kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 3 }, names)).toMatch(/Payroll/u);
  });

  it('the approvals a threshold change is carried out at are the ones the chain asks for when it is carried out', () => {
    const held = { approvals: 2, policyBar: 3, seatBar: 3, vaultThresholds: [{ vault: PAYROLL, threshold: 2 }] };
    /* RED WHEN: the account's threshold change is held to anything but the account's threshold. */
    expect(thresholdCarryBar({ kind: 'threshold', threshold: 4 }, held)).toBe(2);
    /* RED WHEN: a vault raised within the seat bar is held to the seat bar, or one raised past it, or lowered, is not. */
    expect(thresholdCarryBar({ kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 3 }, held)).toBe(2);
    expect(thresholdCarryBar({ kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 4 }, held)).toBe(3);
    expect(thresholdCarryBar({ kind: 'vaultThreshold', vault: PAYROLL as never, threshold: 1 }, held)).toBe(3);
    /* A vault with no threshold of its own starts from the account's: lowered below it, the seat bar; raised within the bar, the threshold. */
    const rowless = { approvals: 2, policyBar: 4, seatBar: 4, vaultThresholds: [] };
    expect(thresholdCarryBar({ kind: 'vaultThreshold', vault: TREASURY as never, threshold: 1 }, rowless)).toBe(4);
    expect(thresholdCarryBar({ kind: 'vaultThreshold', vault: TREASURY as never, threshold: 3 }, rowless)).toBe(2);
    /* With no policy bar stored, a raise past the threshold is a raise past the bar. */
    expect(thresholdCarryBar({ kind: 'vaultThreshold', vault: TREASURY as never, threshold: 3 }, { approvals: 2, policyBar: null, seatBar: 2, vaultThresholds: [] })).toBe(2);
  });
});

describe('a removal, with or without a new threshold, is refused on the device when the chain would refuse it or a vault could no longer pay', () => {
  const four = roster([['a', EVERY], ['b', EVERY], ['c', approverOn(PAYROLL)], ['d', raiserOnly]]);
  const bounds: RemovalBounds = { seats: ['a', 'b', 'c', 'd'], approvals: 2, policyBar: null };

  it('a leaf the account does not seat, or a new threshold that is not a whole number, is refused', () => {
    /* RED WHEN: a removal of a leaf the chain does not hold is raised, which the chain refuses only when it is carried out. */
    expect(removalRefusal(four, bounds, 'e' as never, 0)).toMatch(/does not hold a seat on the company's account/u);
    /* RED WHEN: part of an approval, or a negative number, is taken as a threshold. */
    for (const n of [-1, 1.5, Number.NaN]) expect(removalRefusal(four, bounds, 'd' as never, n)).toMatch(/whole number/u);
    /* RED WHEN: a removal of a seat that may not approve is refused though nothing it leaves is short. */
    expect(removalRefusal(four, bounds, 'd' as never, 0)).toBeNull();
    /* RED WHEN: leaves are compared by case. */
    expect(removalRefusal(roster([['AA', EVERY], ['bb', EVERY], ['cc', EVERY]]), { ...bounds, seats: ['aa', 'bb', 'cc'] }, 'Aa' as never, 0, names)).toBeNull();
  });

  it('a removal that leaves fewer signers than the threshold in force, the new threshold, or the policy bar is refused', () => {
    const two = roster([['a', EVERY], ['b', EVERY]]);
    /* RED WHEN: the threshold in force is not counted against the signers left, which the chain refuses at carry-out. */
    expect(removalRefusal(two, { seats: ['a', 'b'], approvals: 2, policyBar: null }, 'b' as never, 0)).toMatch(/1 signer left.* needs 2 approvals/u);
    /* RED WHEN: a new threshold above the signers left is raised. */
    expect(removalRefusal(four, bounds, 'd' as never, 4)).toMatch(/3 signers left.* needs 4 approvals/u);
    /* RED WHEN: the approvals a policy change needs are not counted against the signers left. */
    expect(removalRefusal(four, { ...bounds, policyBar: 4 }, 'd' as never, 0)).toMatch(/3 signers left.* policy change needs 4/u);
    /* RED WHEN: a lowered threshold that lets the removal through is not counted. */
    expect(removalRefusal(two, { seats: ['a', 'b'], approvals: 2, policyBar: null }, 'b' as never, 1)).toBeNull();
  });

  it('a removal that would leave a vault fewer signers who may approve its runs than they need is refused, naming the vault', () => {
    /* RED WHEN: a removed seat is still counted, or the new threshold is not the one the vaults are judged at. */
    expect(removalRefusal(four, bounds, 'b' as never, 0, names)).toMatch(/^this change would leave vaults unable to pay: Treasury/u);
    expect(removalRefusal(four, bounds, 'c' as never, 0, names)).toBeNull();
    expect(removalRefusal(four, bounds, 'd' as never, 3, names)).toMatch(/Treasury .*company-wide runs/u);
    /* RED WHEN: signers removed since an open run was raised are not counted against every vault. */
    const outrun: ApproverRoster = { ...four, openRuns: new Set([PAYROLL, TREASURY, COMPANY]), removals: 0 };
    expect(removalRefusal(outrun, bounds, 'd' as never, 0, names)).toMatch(/Treasury .*company-wide runs/u);
    /* RED WHEN: a run open on the chain with no signer removed since is not counted one approval more after this removal. */
    const open: ApproverRoster = { ...four, openRuns: new Set([PAYROLL, TREASURY, COMPANY]), removals: 0, openRun: 'prp_run' };
    expect(removalRefusal(open, bounds, 'd' as never, 0, names)).toMatch(/Treasury .*company-wide runs.* because run prp_run is open/u);
    /* RED WHEN: a removal is judged without the bands in force, and leaves a vault fewer approvers than its top band needs. */
    expect(removalRefusal({ ...four, bands: new Map([[PAYROLL as never, 3]]) }, bounds, 'c' as never, 0, names)).toMatch(/^this change would leave a vault unable to pay: Payroll \(its runs need 3 approvals and 2 signers/u);
  });

  it('a removal that leaves a vault fewer approvers than the top band of its policy needs is refused, though the chain would carry it out', () => {
    const V = PAYROLL;
    /* Five seats, four of whom may approve the vault's runs; its policy's top band needs four, so the policy bar stands at four. */
    const five = roster([['1', approverOn(V)], ['2', approverOn(V)], ['3', approverOn(V)], ['4', approverOn(V)], ['5', approverOn(TREASURY)]], 2);
    const banded = withBandsInForce({ ...five, runVaults: [V, TREASURY] }, [{ vault: V, band: 4 }]);
    const fiveBounds = { seats: ['1', '2', '3', '4', '5'], approvals: 2, policyBar: 4 };
    /* RED WHEN: one of the vault's four approvers is removed, four seats are left for a bar of four, and no run in the top band could be paid again. */
    expect(removalRefusal(banded, fiveBounds, '1' as never, 0, names)).toMatch(/Payroll \(its runs need 4 approvals and 3 signers could give them\)/u);
    /* A top band of three: the three who stay can give it. */
    expect(removalRefusal(withBandsInForce({ ...five, runVaults: [V, TREASURY] }, [{ vault: V, band: 3 }]), fiveBounds, '1' as never, 0, names)).toBeNull();
  });
});

describe('a seat added with a new threshold is checked on the device before anything is built', () => {
  const ALL = 'dd'.repeat(32);
  const one = roster([['a', EVERY]], 1);
  it('the threshold is a whole number no higher than the signers seated once the seat is taken', () => {
    /* RED WHEN: the seat the invitation adds is not counted, so a company of one cannot invite a second signer at two approvals. */
    expect(seatThresholdRefusal(one, { seats: 1 }, { kind: 'seatAndThreshold', rights: seatRightsOf(ALL, ALL), threshold: 2 }, names)).toBeNull();
    /* RED WHEN: a threshold above the signers seated once the seat is taken is raised, which the chain refuses only when the seat is taken. */
    expect(seatThresholdRefusal(one, { seats: 1 }, { kind: 'seatAndThreshold', rights: seatRightsOf(ALL, ALL), threshold: 3 }, names))
      .toMatch(/once this seat is taken the company has 2 signers, so it cannot need 3 approvals/u);
    /* RED WHEN: a threshold that is not a whole number of at least one is let through. */
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(seatThresholdRefusal(one, { seats: 1 }, { kind: 'seatAndThreshold', rights: EVERY, threshold: bad }), String(bad)).toMatch(/whole number/u);
    }
  });

  it('a seat with rights of its own is counted on no vault, and a threshold that leaves a vault short is refused, naming it and saying so', () => {
    /* RED WHEN: a seat invited with a scope other than every vault's is counted as approving where its scope is read as a vault: the scope is a rights record's commitment, never a vault. */
    expect(seatRightsOf(PAYROLL, ALL)).toEqual({ every: false, mayApprove: false, everyVault: false, onVaults: [] });
    expect(seatRightsOf(ALL.toUpperCase(), ALL)).toEqual(EVERY);
    const said = seatThresholdRefusal(one, { seats: 1 }, { kind: 'seatAndThreshold', rights: seatRightsOf(PAYROLL, ALL), threshold: 2 }, names);
    expect(said).toMatch(/^this change would leave vaults unable to pay: Payroll .*Treasury .*company-wide runs/u);
    /* RED WHEN: the refusal does not say the new seat was counted on no vault, so the person cannot tell why a seat they added counts for nothing. */
    expect(said).toMatch(/The new seat is counted on no vault/u);
    /* RED WHEN: a vault with a threshold of its own is judged at the company's new one. */
    const own = roster([['a', EVERY]], 1, [[TREASURY, 1]]);
    expect(seatThresholdRefusal({ ...own, runVaults: [PAYROLL, TREASURY] }, { seats: 1 },
      { kind: 'seatAndThreshold', rights: seatRightsOf(PAYROLL, ALL), threshold: 2 }, names)).toMatch(/^this change would leave a vault unable to pay: Payroll \(/u);
    /* A seat with every vault's rights meets it, and is not said to be counted on none. */
    expect(seatThresholdRefusal({ ...own, runVaults: [PAYROLL, TREASURY] }, { seats: 1 }, { kind: 'seatAndThreshold', rights: EVERY, threshold: 2 }, names)).toBeNull();
    /* Bands are not counted, as for a threshold change: a band alone never refuses it. */
    expect(seatThresholdRefusal({ ...one, bands: new Map([[PAYROLL as never, 5]]) }, { seats: 1 },
      { kind: 'seatAndThreshold', rights: EVERY, threshold: 2 }, names)).toBeNull();
  });
});

describe('a spending policy is refused on the device when a vault could no longer pay at its bands', () => {
  /* Two signers who may approve Payroll's runs, one who may approve only Treasury's, at a threshold of one. */
  const two = roster([['a', approverOn(PAYROLL)], ['b', approverOn(PAYROLL)], ['c', approverOn(TREASURY)]], 1);

  it('a policy whose highest band asks for more signers than may approve its vault\'s runs is refused, naming the vault', () => {
    /* RED WHEN: a band is not counted against its vault's approvers, and a policy no run in its top band could ever be paid under is approved. */
    expect(policyChangeRefusal(two, [], { vault: PAYROLL, band: 3 }, names))
      .toMatch(/^this change would leave a vault unable to pay: Payroll \(its runs need 3 approvals and 2 signers could give them\)/u);
    /* A band the vault's approvers can give is not refused. */
    expect(policyChangeRefusal(two, [], { vault: PAYROLL, band: 2 }, names)).toBeNull();
    /* RED WHEN: a band is counted on another vault than the one its policy is set on. */
    expect(policyChangeRefusal(two, [], { vault: TREASURY, band: 2 }, names)).toMatch(/Treasury \(its runs need 2 approvals and 1 signer/u);
  });

  it('every policy in force on the vault is counted as it stands, the one the change replaces among them', () => {
    /* The vault is already short at a band of three in another currency: a policy asking no more does not make it shorter. */
    const euros = [{ vault: PAYROLL, band: 3 }];
    /* RED WHEN: a vault already short at another currency's band blocks a change that does not make it shorter, so it can never be repaired. */
    expect(policyChangeRefusal(two, euros, { vault: PAYROLL, band: 3 }, names)).toBeNull();
    /* RED WHEN: a change that asks for more than any band in force on a short vault is let through. */
    expect(policyChangeRefusal(two, euros, { vault: PAYROLL, band: 4 }, names)).toMatch(/its runs need 4 approvals/u);
    /* The policy in force asks for three; the change lowers it to one, which leaves the vault no shorter. */
    /* RED WHEN: a vault short at the band in force is refused the change that lowers it, so it can never be repaired. */
    expect(policyChangeRefusal(two, [{ vault: PAYROLL, band: 3 }], { vault: PAYROLL, band: 1 }, names)).toBeNull();
  });

  it('signers removed since an open run was raised are counted against the vault with its band', () => {
    const outrun = { ...two, removals: 1, openRuns: new Set([PAYROLL as never]), outrunBy: 'prp_run' };
    /* RED WHEN: a band is judged without the removals an open run already needs, and the run can never be paid. */
    expect(policyChangeRefusal(outrun, [], { vault: PAYROLL, band: 2 }, names))
      .toMatch(/its runs need 3 approvals and 2 signers .*removed since run prp_run was raised/u);
  });

  it('a band that is not a whole number is refused', () => {
    /* RED WHEN: a band the device could not read is counted as asking for nothing. */
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(policyChangeRefusal(two, [], { vault: PAYROLL, band: bad }, names), String(bad)).toMatch(/whole number/u);
    }
  });
});
