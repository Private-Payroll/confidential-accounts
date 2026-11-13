/**
 * **WHAT A CHANGE TO THE COMPANY'S GOVERNANCE COSTS, BEFORE ANYONE RAISES IT.**
 *
 * One answer for every page that offers a change of who is seated, a vault's
 * threshold, a spending policy or the approvals a policy change needs: how many
 * approvals it needs, what sets that number, whether it is every seated signer,
 * how it moves the approvals a change of who is seated needs, and what it makes
 * public on the chain.
 *
 * Its facts are the approvals the account holds, as the person's wallet reads
 * them from the chain. It holds no rule of its own: each number comes from
 * `seatBarOf`, `thresholdCarryBar` and `withBandsInForce`, and the chain checks
 * the same rules again when the change is carried out. It refuses nothing; the
 * wallet and the chain do.
 */
import { seatBarOf, type AccountGovernance } from 'midnight-identity/profile/records-key';
import type { Hex } from './crypto.js';
import { thresholdCarryBar, withBandsInForce, type ApproverRoster, type SeatRights } from './vault-approvers.js';

/** The approvals the account holds on the chain, and how many signers it seats. */
export interface ChangeHolders extends AccountGovernance {
  readonly seated: number;
}

/**
 * The holders a cost is worked out from, taken from what the person's wallet read of the account: its four figures as
 * read, and the signers seated counted from the seats read. Every page that costs a change builds its holders here.
 */
export const changeHoldersOf = (read: AccountGovernance & { readonly seats: readonly unknown[] }): ChangeHolders => ({
  approvals: read.approvals, vaultThresholds: read.vaultThresholds, policyBar: read.policyBar, seatBar: read.seatBar, seated: read.seats.length,
});

/** A change a page may offer. A policy names only its bands' approvals: its limit and period never matter to what it costs. */
export type GovernanceChangeAsked =
  | { readonly kind: 'seating'; readonly seat: 'add' | 'remove' | 'reseat' }
  | { readonly kind: 'vault-threshold'; readonly vault: string; readonly threshold: number }
  | { readonly kind: 'spending-policy'; readonly vault: string; readonly bands: readonly { readonly approvals: number | string }[] }
  | { readonly kind: 'policy-bar'; readonly bar: number };

/**
 * What the change makes public on the chain, and nothing else: a policy's
 * bands, limit and period stay hidden, so they are never on this list.
 */
export type PublicFact =
  | { readonly fact: 'policy-bar'; readonly value: number }
  | { readonly fact: 'highest-band'; readonly vault: string; readonly value: number }
  | { readonly fact: 'vault-threshold'; readonly vault: string; readonly value: number }
  | { readonly fact: 'vault-has-a-policy'; readonly vault: string }
  | { readonly fact: 'a-seat-leaves' }
  | { readonly fact: 'a-seat-joins' }
  | { readonly fact: 'approval-count' };

export interface ChangeCost {
  /** The approvals the change needs before the chain carries it out. */
  readonly needed: number;
  /** What sets that number: the account's threshold, a vault whose threshold raised the bar, or the approvals a policy change needs. */
  readonly because: 'account' | { readonly vault: string } | 'policy-bar';
  /** The change needs every seated signer, or sets a number that does: one lost key then freezes what it guards. */
  readonly everySigner: boolean;
  /** The approvals a change of who is seated will need once this is carried out, when that is more than today. */
  readonly barRaisedTo?: number;
  /** The same, when it is fewer than today: only a change of the approvals a policy change needs lowers it. */
  readonly barLoweredTo?: number;
  readonly publicFacts: readonly PublicFact[];
}

/** A vault holding the bar names itself; otherwise a bar above the account's threshold was set for policy changes. */
const whatSets = (held: ChangeHolders, needed: number): ChangeCost['because'] => {
  if (needed <= held.approvals) return 'account';
  const vault = held.vaultThresholds.find((v) => v.threshold === needed);
  return vault === undefined ? 'policy-bar' : { vault: vault.vault };
};

/** A policy's highest band, counted exactly as the bands in force on a vault are. */
const highestBandOf = (held: ChangeHolders, vault: string, bands: readonly { readonly approvals: number | string }[]): number => {
  const none: ApproverRoster = { seats: new Map<Hex, SeatRights>(), threshold: held.approvals, vaultThresholds: new Map<Hex, number>(), runVaults: [] };
  const counted = withBandsInForce(none, bands.map((b) => ({ vault, band: Number(b.approvals) })));
  return counted.bands?.get(vault.toLowerCase() as Hex) ?? 0;
};

/** The stored bar the chain writes when a vault threshold or a policy's highest band is above it, or null when it writes none. */
const barWritten = (held: ChangeHolders, most: number): number | null => ((held.policyBar ?? 0) < most ? most : null);

/**
 * What `change` costs on the account `held` describes. Every number is read
 * from the chain's own rules as the wallet holds them, so a page shows the
 * approvals the chain will ask for, never a number of its own.
 */
export function whatAChangeCosts(held: ChangeHolders, change: GovernanceChangeAsked): ChangeCost {
  const seatBar = seatBarOf(held.approvals, held.policyBar);
  const facts: PublicFact[] = [];
  let needed = seatBar;
  let sets: number | null = null;
  let written: number | null = null;
  switch (change.kind) {
    case 'seating':
      if (change.seat !== 'add') facts.push({ fact: 'a-seat-leaves' });
      if (change.seat !== 'remove') facts.push({ fact: 'a-seat-joins' });
      break;
    case 'vault-threshold':
      needed = thresholdCarryBar({ kind: 'vaultThreshold', vault: change.vault as Hex, threshold: change.threshold }, held);
      sets = change.threshold;
      written = barWritten(held, change.threshold);
      facts.push({ fact: 'vault-threshold', vault: change.vault, value: change.threshold });
      if (written !== null) facts.push({ fact: 'policy-bar', value: written });
      break;
    case 'spending-policy': {
      sets = highestBandOf(held, change.vault, change.bands);
      written = barWritten(held, sets);
      facts.push({ fact: 'vault-has-a-policy', vault: change.vault });
      if (written !== null) facts.push({ fact: 'policy-bar', value: written }, { fact: 'highest-band', vault: change.vault, value: written });
      break;
    }
    case 'policy-bar':
      sets = change.bar;
      written = change.bar;
      facts.push({ fact: 'policy-bar', value: change.bar });
      break;
  }
  facts.push({ fact: 'approval-count' });
  const after = written === null ? seatBar : seatBarOf(held.approvals, written);
  return {
    needed,
    because: whatSets(held, needed),
    everySigner: needed === held.seated || sets === held.seated,
    ...(after > seatBar ? { barRaisedTo: after } : {}),
    ...(after < seatBar ? { barLoweredTo: after } : {}),
    publicFacts: facts,
  };
}
