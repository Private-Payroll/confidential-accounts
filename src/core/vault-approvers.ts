/**
 * EVERY VAULT KEEPS AS MANY SIGNERS WHO MAY APPROVE ITS RUNS AS ITS RUNS NEED.
 *
 * What a signer may do lives in their own leaf and is private, so the chain
 * cannot count, for any vault, how many signers may approve its runs. A seat,
 * a removal, a change of rights or a change of a bar that left a vault fewer
 * such signers than its bar would leave that vault unable to pay until the
 * company changes someone's rights again. Governance itself is never stopped,
 * because a governance proposal needs a seat and no right, so the company can
 * always repair it; this check is what stops it being needed.
 *
 * It is written to run on a signer's device, before they approve a change, over
 * the rights every signer was given as the company's own records hold them. NO
 * APPROVAL CALLS IT YET, so today nothing refuses such a change. Once called, it
 * is a check each approving signer makes, not a rule the chain keeps: a company
 * whose signers at the threshold all skip it can still make such a change.
 */
import type { Hex } from './crypto.js';

/** What one seat may do, as far as approving runs goes. */
export type SeatRights =
  /** A seat with every right on every vault. */
  | { every: true }
  /** A seat given rights: whether it may approve runs, and on which vaults. */
  | { every?: false; mayApprove: boolean; everyVault: boolean; onVaults: Hex[] };

/** The company as its signers' devices hold it: who is seated with what, and every bar. */
export interface ApproverRoster {
  /** Each seated leaf and the rights it was given. */
  seats: ReadonlyMap<Hex, SeatRights>;
  /** The company's threshold, which every vault without its own uses. */
  threshold: number;
  /** Each vault's own threshold, where it has one. */
  vaultThresholds: ReadonlyMap<Hex, number>;
  /** Every vault a run can name: each adopted vault, and the marker for a company-wide run. */
  runVaults: readonly Hex[];
}

/** One governance change, as it would leave the company. */
export type GovernanceChange =
  | { kind: 'seat'; leaf: Hex; rights: SeatRights }
  | { kind: 'remove'; leaf: Hex }
  | { kind: 'reseat'; from: Hex; to: Hex; rights: SeatRights }
  | { kind: 'threshold'; threshold: number }
  | { kind: 'removeAndThreshold'; leaf: Hex; threshold: number }
  | { kind: 'vaultThreshold'; vault: Hex; threshold: number };

/** A vault a change would leave short: how many may approve its runs, and how many its runs need. */
export interface ShortVault {
  vault: Hex;
  approvers: number;
  needs: number;
}

const same = (a: Hex, b: Hex): boolean => a.replace(/^0x/, '').toLowerCase() === b.replace(/^0x/, '').toLowerCase();

/** Whether a seat may approve runs on one vault. */
export const mayApproveOn = (rights: SeatRights, vault: Hex): boolean =>
  rights.every === true || (rights.mayApprove && (rights.everyVault || rights.onVaults.some((v) => same(v, vault))));

/** How many seats may approve runs on one vault. */
export const approversOf = (roster: ApproverRoster, vault: Hex): number =>
  [...roster.seats.values()].filter((r) => mayApproveOn(r, vault)).length;

/** How many approvals a vault's runs need at least. */
export const barOf = (roster: ApproverRoster, vault: Hex): number => {
  for (const [v, n] of roster.vaultThresholds) if (same(v, vault)) return n;
  return roster.threshold;
};

/** The company as a change would leave it. */
export const afterChange = (roster: ApproverRoster, change: GovernanceChange): ApproverRoster => {
  const seats = new Map(roster.seats);
  const without = (leaf: Hex) => {
    for (const k of seats.keys()) if (same(k, leaf)) seats.delete(k);
  };
  let threshold = roster.threshold;
  const vaultThresholds = new Map(roster.vaultThresholds);
  switch (change.kind) {
    case 'seat': seats.set(change.leaf, change.rights); break;
    case 'remove': without(change.leaf); break;
    case 'reseat': without(change.from); seats.set(change.to, change.rights); break;
    case 'threshold': threshold = change.threshold; break;
    case 'removeAndThreshold': without(change.leaf); threshold = change.threshold; break;
    case 'vaultThreshold': {
      for (const k of vaultThresholds.keys()) if (same(k, change.vault)) vaultThresholds.delete(k);
      vaultThresholds.set(change.vault, change.threshold);
      break;
    }
  }
  return { seats, threshold, vaultThresholds, runVaults: roster.runVaults };
};

/**
 * The vaults a change would leave with fewer signers who may approve their runs
 * than their runs need, and where it makes that worse. A vault already short is
 * not held against a change that does not make it shorter, so the change that
 * repairs it is never refused.
 */
export const vaultsLeftShort = (roster: ApproverRoster, change: GovernanceChange): ShortVault[] => {
  const after = afterChange(roster, change);
  const short: ShortVault[] = [];
  for (const vault of roster.runVaults) {
    const approvers = approversOf(after, vault);
    const needs = barOf(after, vault);
    if (approvers >= needs) continue;
    const before = approversOf(roster, vault);
    const neededBefore = barOf(roster, vault);
    if (approvers < before || needs > neededBefore) short.push({ vault, approvers, needs });
  }
  return short;
};

/**
 * Refuses, before a signer approves it, a change that would leave a vault
 * unable to pay. `nameOf` turns a vault into the name the company knows it by.
 */
export const refuseLeavingAVaultShort = (
  roster: ApproverRoster,
  change: GovernanceChange,
  nameOf: (vault: Hex) => string,
): void => {
  const short = vaultsLeftShort(roster, change);
  if (short.length === 0) return;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const list = short.map((s) =>
    `${nameOf(s.vault)} (its runs need ${count(s.needs, 'approval', 'approvals')} and ` +
      `${count(s.approvers, 'signer', 'signers')} could give them)`,
  ).join('; ');
  throw new Error(
    `this change would leave ${short.length === 1 ? 'a vault' : 'vaults'} unable to pay: ${list}. ` +
      'Give another signer the right to approve runs there first, or ask for fewer approvals on that vault. ' +
      'Nothing was approved.');
};
