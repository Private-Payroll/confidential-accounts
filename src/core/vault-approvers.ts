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
 * It runs on a signer's device, before they raise, approve or carry out a
 * change, over the rights every signer was given as the company's own records
 * hold them. It is a check each signer's device makes, not a rule the chain
 * keeps: a company whose signers at the threshold all skip it can still make
 * such a change.
 *
 * What a vault's runs need is the higher of its bar and the approvals the
 * highest band of its spending policy asks for; and a run already open when a
 * signer is removed or replaced needs one approval more for each, since the
 * departed signer's approval may be among those it was given.
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
  /** For a vault whose spending policy has bands: the most approvals any of its bands asks for. */
  bands?: ReadonlyMap<Hex, number>;
  /** The vaults with a run open now, each of which needs one approval more for every signer removed while it is. */
  openRuns?: ReadonlySet<Hex>;
  /** Signers removed or replaced since the runs open now were raised. Absent is none. */
  removals?: number;
}

/** One governance change, as it would leave the company. */
export type GovernanceChange =
  | { kind: 'seat'; leaf: Hex; rights: SeatRights }
  | { kind: 'remove'; leaf: Hex }
  | { kind: 'reseat'; from: Hex; to: Hex; rights: SeatRights }
  | { kind: 'threshold'; threshold: number }
  | { kind: 'removeAndThreshold'; leaf: Hex; threshold: number }
  | { kind: 'vaultThreshold'; vault: Hex; threshold: number }
  /** A vault adopted: its runs need its bar from the moment it is the company's. */
  | { kind: 'adopt'; vault: Hex };

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

/** How many approvals a vault's own bar asks for: its threshold where it has one, the company's where it does not. */
const thresholdOf = (roster: ApproverRoster, vault: Hex): number => {
  for (const [v, n] of roster.vaultThresholds) if (same(v, vault)) return n;
  return roster.threshold;
};

/**
 * How many approvals a vault's runs need at least: its bar, or the highest band
 * of its spending policy where that asks for more, and one more for each signer
 * removed while one of its runs is open.
 */
export const barOf = (roster: ApproverRoster, vault: Hex): number => {
  let band = 0;
  for (const [v, n] of roster.bands ?? []) if (same(v, vault)) band = Math.max(band, n);
  const open = [...(roster.openRuns ?? [])].some((v) => same(v, vault));
  return Math.max(thresholdOf(roster, vault), band) + (open ? roster.removals ?? 0 : 0);
};

/** The company as a change would leave it. */
export const afterChange = (roster: ApproverRoster, change: GovernanceChange): ApproverRoster => {
  const seats = new Map(roster.seats);
  const without = (leaf: Hex) => {
    for (const k of seats.keys()) if (same(k, leaf)) seats.delete(k);
  };
  let threshold = roster.threshold;
  const vaultThresholds = new Map(roster.vaultThresholds);
  let runVaults = roster.runVaults;
  let removals = roster.removals ?? 0;
  switch (change.kind) {
    case 'seat': seats.set(change.leaf, change.rights); break;
    case 'remove': without(change.leaf); removals += 1; break;
    case 'reseat': without(change.from); seats.set(change.to, change.rights); removals += 1; break;
    case 'threshold': threshold = change.threshold; break;
    case 'removeAndThreshold': without(change.leaf); threshold = change.threshold; removals += 1; break;
    case 'vaultThreshold': {
      for (const k of vaultThresholds.keys()) if (same(k, change.vault)) vaultThresholds.delete(k);
      vaultThresholds.set(change.vault, change.threshold);
      break;
    }
    case 'adopt':
      if (!runVaults.some((v) => same(v, change.vault))) runVaults = [...runVaults, change.vault];
      break;
  }
  return {
    seats, threshold, vaultThresholds, runVaults,
    ...(roster.bands === undefined ? {} : { bands: roster.bands }),
    ...(roster.openRuns === undefined ? {} : { openRuns: roster.openRuns }),
    removals,
  };
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
  for (const vault of after.runVaults) {
    const approvers = approversOf(after, vault);
    const needs = barOf(after, vault);
    if (approvers >= needs) continue;
    /* A vault the change makes the company's is held to its bar from the start. */
    const adopted = !roster.runVaults.some((v) => same(v, vault));
    const before = approversOf(roster, vault);
    const neededBefore = barOf(roster, vault);
    if (adopted || approvers < before || needs > neededBefore) short.push({ vault, approvers, needs });
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

/** A seat with no rights recorded holds every right: every seat is made today under the scope of all vaults. */
export const EVERY_RIGHT: SeatRights = Object.freeze({ every: true }) as SeatRights;

/**
 * **THE COMPANY AS A SIGNER'S DEVICE COUNTS IT**: each seated leaf with the
 * rights the company's roster records for it, the bars the chain holds, and
 * every vault a run can name - each vault the account has adopted, and the
 * value a company-wide run names.
 */
export const approverRosterFrom = (input: {
  readonly threshold: number;
  readonly vaultThresholds: ReadonlyArray<{ readonly vault: string; readonly threshold: number }>;
  readonly seated: ReadonlyArray<{ readonly leaf: string; readonly rights?: SeatRights }>;
  readonly adoptedVaults: readonly string[];
  readonly companyWide: string;
  readonly bands?: ReadonlyMap<Hex, number>;
  readonly openRuns?: ReadonlySet<Hex>;
}): ApproverRoster => ({
  seats: new Map(input.seated.map((s) => [s.leaf.toLowerCase() as Hex, s.rights ?? EVERY_RIGHT])),
  threshold: input.threshold,
  vaultThresholds: new Map(input.vaultThresholds.map((v) => [v.vault.toLowerCase() as Hex, v.threshold])),
  runVaults: [...new Set([...input.adoptedVaults, input.companyWide].map((v) => v.toLowerCase()))] as Hex[],
  ...(input.bands === undefined ? {} : { bands: input.bands }),
  ...(input.openRuns === undefined ? {} : { openRuns: input.openRuns }),
});
