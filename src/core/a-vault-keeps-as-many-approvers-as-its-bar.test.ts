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
  approverRosterFrom, barOf, vaultsLeftShort, refuseLeavingAVaultShort, type ApproverRoster, type SeatRights,
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
