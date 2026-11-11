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
import { mayFile, type Role } from './roles.js';

/** Whether `n` could be a threshold at all: a whole number of at least one that is counted exactly. The chain further refuses one above the signers seated. */
export const wholeThreshold = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

/**
 * The threshold a change names, as a number, or 0 where `keeps` lets the change keep the one in force. Refuses anything
 * else, so no count is made at a number no account can hold.
 */
export const thresholdCounted = (written: string | undefined, keeps = false): number => {
  const n = Number(written ?? (keeps ? '0' : ''));
  if ((keeps && n === 0) || wholeThreshold(n)) return n;
  if (/^[0-9]+$/u.test(written ?? '') && n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`the approvals this change asks for, ${written}, are more than any account can hold. Nothing was sent.`);
  }
  throw new Error('the approvals this change asks for are not a whole number of at least one. Nothing was sent.');
};

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
  /** The open run those removals were counted from, as the company names it: a refusal names it as what to withdraw. */
  outrunBy?: string;
  /** For a removal with no signer removed since any open run was raised: a run open on the chain, named for the refusal. */
  openRun?: string;
}

/** One governance change, as it would leave the company. */
export type GovernanceChange =
  | { kind: 'seat'; leaf: Hex; rights: SeatRights }
  | { kind: 'remove'; leaf: Hex }
  | { kind: 'reseat'; from: Hex; to: Hex; rights: SeatRights }
  | { kind: 'threshold'; threshold: number }
  | { kind: 'removeAndThreshold'; leaf: Hex; threshold: number }
  | { kind: 'vaultThreshold'; vault: Hex; threshold: number }
  /**
   * A seat added by an invitation that sets the account's threshold once the seat is taken: the seat counted with the
   * rights it carries, under a key no seat on the chain can hold, since its leaf is the invitee's to make.
   */
  | { kind: 'seatAndThreshold'; rights: SeatRights; threshold: number }
  /** A vault adopted: its runs need its bar from the moment it is the company's. */
  | { kind: 'adopt'; vault: Hex }
  /** A spending policy set on a vault: its runs need at least the approvals its highest band asks for. */
  | { kind: 'policy'; vault: Hex; band: number };

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

/** The key the seat an invitation adds is counted under: not a leaf, so it is never one the chain holds. */
const SEAT_INVITED = 'seat-invited' as Hex;

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
  let bands = roster.bands;
  switch (change.kind) {
    case 'seat': seats.set(change.leaf, change.rights); break;
    case 'remove': without(change.leaf); removals += 1; break;
    case 'reseat': without(change.from); seats.set(change.to, change.rights); removals += 1; break;
    case 'threshold': threshold = change.threshold; break;
    case 'removeAndThreshold': without(change.leaf); threshold = change.threshold; removals += 1; break;
    case 'seatAndThreshold': seats.set(SEAT_INVITED, change.rights); threshold = change.threshold; break;
    case 'vaultThreshold': {
      for (const k of vaultThresholds.keys()) if (same(k, change.vault)) vaultThresholds.delete(k);
      vaultThresholds.set(change.vault, change.threshold);
      break;
    }
    case 'adopt':
      if (!runVaults.some((v) => same(v, change.vault))) runVaults = [...runVaults, change.vault];
      break;
    case 'policy': {
      const next = new Map(roster.bands ?? []);
      let most = change.band;
      for (const [v, n] of next) if (same(v, change.vault)) { most = Math.max(most, n); next.delete(v); }
      next.set(change.vault, most);
      bands = next;
      break;
    }
  }
  return {
    seats, threshold, vaultThresholds, runVaults,
    ...(bands === undefined ? {} : { bands }),
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

/** The vaults a change leaves short, said in the names the company knows them by. */
const leftShortSaid = (short: readonly ShortVault[], nameOf: (vault: Hex) => string, roster: ApproverRoster): string => {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const list = short.map((s) =>
    `${nameOf(s.vault)} (its runs need ${count(s.needs, 'approval', 'approvals')} and ` +
      `${count(s.approvers, 'signer', 'signers')} could give them)`,
  ).join('; ');
  const removals = roster.removals ?? 0;
  const outrun = removals > 0 && roster.outrunBy !== undefined
    ? ` That counts ${count(removals, 'approval', 'approvals')} more on every vault, for the ${count(removals, 'signer', 'signers')} `
      + `removed since run ${roster.outrunBy} was raised; once that run is withdrawn or raised again, they are no longer counted.`
    : '';
  const open = removals === 0 && roster.openRun !== undefined
    ? ` That counts one approval more on every vault, because run ${roster.openRun} is open on the chain and a run raised before `
      + 'a removal or a replacement needs one approval more for each signer removed or replaced, whether or not any of it is paid yet; once it is paid out or withdrawn, it is no longer counted.'
    : '';
  return `this change would leave ${short.length === 1 ? 'a vault' : 'vaults'} unable to pay: ${list}. ` +
    `Invite another approver or admin first, or ask for fewer approvals on that vault.${outrun}${open}`;
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
  throw new Error(`${leftShortSaid(short, nameOf, roster)} Nothing was approved.`);
};

/** One spending policy in force on a vault, for one currency: the most approvals any of its bands asks for. */
export interface BandInForce {
  readonly vault: string;
  readonly band: number;
}

/** The company with each vault's bar counting the highest band of every policy in force on it, in place of any bands it held. */
export const withBandsInForce = (roster: ApproverRoster, inForce: readonly BandInForce[]): ApproverRoster => {
  const bands = new Map<Hex, number>();
  for (const b of inForce) {
    const vault = b.vault.toLowerCase() as Hex;
    bands.set(vault, Math.max(bands.get(vault) ?? 0, b.band));
  }
  return { ...roster, bands };
};

/**
 * **WHY A SPENDING POLICY IS REFUSED BEFORE ANYTHING IS BUILT, OR NULL.** A run
 * in a band needs that band's approvals, so a policy whose highest band asks for
 * more signers than may approve its vault's runs leaves those runs unable to be
 * paid. The vault is counted with every policy in force on it as it stands, the
 * one the change replaces among them; a vault already short is refused only a
 * change that makes it shorter, and counting the replaced policy's band after the
 * change never makes it look shorter, since that band is already in its count.
 * `inForce` is what this device opened of the policies the chain holds; one it
 * could not open is left out, which can only refuse more for the vault changed,
 * and no other vault is changed.
 */
export const policyChangeRefusal = (
  roster: ApproverRoster, inForce: readonly BandInForce[], change: BandInForce, nameOf: (vault: Hex) => string = (v) => v,
): string | null => {
  if (!Number.isSafeInteger(change.band) || change.band < 0) return 'the approvals a band of that policy asks for are not a whole number.';
  const counted = withBandsInForce(roster, inForce);
  const short = vaultsLeftShort(counted, { kind: 'policy', vault: change.vault.toLowerCase() as Hex, band: change.band });
  return short.length === 0 ? null : leftShortSaid(short, nameOf, counted);
};

/** A change of the approvals the account, or one vault, needs. */
export type ThresholdChange = Extract<GovernanceChange, { kind: 'threshold' | 'vaultThreshold' }>;

/** The account as the person's own wallet reads it from the chain, as far as bounding a threshold change goes. */
export interface ThresholdBounds {
  /** The seats the account holds. */
  readonly seats: number;
  /** The account's threshold. */
  readonly approvals: number;
  /** The approvals a policy change needs, as the account stores them; null when none is stored. */
  readonly policyBar: number | null;
  /** Every vault the account has adopted. */
  readonly adoptedVaults: readonly string[];
  /** The value a company-wide run names in place of a vault. */
  readonly companyWide: string;
}

/**
 * **WHY A THRESHOLD CHANGE IS REFUSED BEFORE ANYTHING IS BUILT, OR NULL.** The
 * chain refuses a threshold that is not at least one or is above its seats, a
 * threshold for the value company-wide runs name, and a vault it has not adopted
 * raised past the seat bar - but only when the change is carried out, after every
 * signer has approved it. This says so first, on the page before the wallet
 * window and in the wallet before every send. Then the count of who may approve
 * each vault's runs: a change that leaves a vault short is refused.
 *
 * The bands of a vault's spending policy are left out of that count. For a change
 * of a threshold, leaving them out can only refuse more, never less: a vault
 * already short of its highest band is still refused a raise that would leave it
 * unable to pay any run at all.
 */
export const thresholdChangeRefusal = (
  roster: ApproverRoster, bounds: ThresholdBounds, change: ThresholdChange, nameOf: (vault: Hex) => string = (v) => v,
): string | null => {
  const wanted = change.threshold;
  if (!wholeThreshold(wanted)) return 'the approvals needed must be a whole number, at least one.';
  if (wanted > bounds.seats) {
    return `the company cannot need more approvals than the ${bounds.seats} signers its account seats, or nothing could ever be `
      + 'approved. Seat more signers first, or choose a smaller number.';
  }
  if (change.kind === 'vaultThreshold') {
    if (same(change.vault, bounds.companyWide as Hex)) {
      return 'company-wide runs always need the account\'s threshold; change the account\'s threshold instead.';
    }
    const adopted = bounds.adoptedVaults.some((v) => same(v as Hex, change.vault));
    if (!adopted && wanted > (bounds.policyBar ?? bounds.approvals)) {
      return 'that vault is not one the company\'s account holds, so it cannot need more approvals than a change of who is seated '
        + 'needs. Add the vault to the company first, or choose a smaller number.';
    }
  }
  const { bands: _bands, ...counted } = roster;
  const short = vaultsLeftShort(counted, change);
  return short.length === 0 ? null : leftShortSaid(short, nameOf, roster);
};

/** What a removal is checked against, all read from the chain: the leaves it seats, its threshold and its policy bar. */
export interface RemovalBounds {
  /** The leaves the account seats on the chain. */
  readonly seats: readonly string[];
  /** The account's threshold in force. */
  readonly approvals: number;
  /** The approvals a spending-policy change needs, where the account stores a bar of its own. */
  readonly policyBar: number | null;
}

/**
 * Why a removal of `leaf` that leaves the company at `newThreshold` (0 keeps the threshold in force) would be refused,
 * or null: the leaf is not seated on the chain; the new threshold is not a whole number; the signers left could not
 * meet the threshold the company is left at, or the approvals a policy change needs, which the chain refuses when the
 * removal is carried out; or a vault would be left with fewer signers who may approve its runs than they need, with
 * the signers removed since an open run was raised counted. The bands in `roster` are counted (`withBandsInForce`): a
 * removal takes approvers away, so leaving them out could let through a removal that leaves a vault short of its top
 * band, which the chain carries out whenever enough signers stay to meet the policy bar.
 */
export const removalRefusal = (
  roster: ApproverRoster, bounds: RemovalBounds, leaf: Hex, newThreshold: number, nameOf: (vault: Hex) => string = (v) => v,
): string | null => {
  const bound = removalThresholdRefusal(bounds, leaf, newThreshold);
  if (bound !== null) return bound;
  const change: GovernanceChange = newThreshold === 0 ? { kind: 'remove', leaf } : { kind: 'removeAndThreshold', leaf, threshold: newThreshold };
  const short = vaultsLeftShort(roster, change);
  return short.length === 0 ? null : leftShortSaid(short, nameOf, roster);
};

/**
 * Why the chain would refuse to carry a removal out, from the seats, the threshold and the policy bar it holds: the seat is
 * not one it holds, the threshold asked is not a whole number (0 keeps the one in force), or the signers left are fewer
 * than the approvals the account or a policy change would then need. Null when the chain would carry it.
 */
export const removalThresholdRefusal = (bounds: RemovalBounds, leaf: Hex, newThreshold: number): string | null => {
  if (!bounds.seats.some((s) => same(s as Hex, leaf))) {
    return 'that signer does not hold a seat on the company\'s account, so there is nobody to remove. Reload the page to see who is seated.';
  }
  if (!Number.isSafeInteger(newThreshold) || newThreshold < 0) {
    return 'the approvals needed once the signer is removed must be a whole number; 0 keeps the number in force.';
  }
  const left = bounds.seats.length - 1;
  const signers = `${left} ${left === 1 ? 'signer' : 'signers'}`;
  const threshold = newThreshold === 0 ? bounds.approvals : newThreshold;
  if (left < threshold) {
    return `once this signer is removed the company has ${signers} left, and the account needs ${threshold} approvals for anything, `
      + 'so nothing could ever be approved again. Choose fewer approvals for once they are gone, or seat another signer first.';
  }
  if (bounds.policyBar !== null && left < bounds.policyBar) {
    return `once this signer is removed the company has ${signers} left, and a policy change needs ${bounds.policyBar} approvals: `
      + 'seat another signer first, or lower the approvals policy changes need.';
  }
  return null;
};

/**
 * Why a removal would leave the company no seat that may file its list of signers, or null. Only such a seat - an
 * admin, or the founding seat, which holds no role - admits a new signer to that list and files the company's people,
 * vendors and policies, so with none left nobody could admit another admin to the company's records again and only the
 * super admins could repair it. Admin is a role in the company's records, not on the chain: the chain seats a signer
 * with no admin's say, and only the records would not admit them. It counts the seats the company's directory believes, not retired, that are among `admitted` - the
 * active signers of the roster this device believes that the chain holds now - leaving out the one removed: a seat
 * taken and not yet admitted admits nobody, and a seat with no believed entry carries no role.
 */
export const noAdminLeftRefusal = (
  seats: ReadonlyArray<{ readonly seat: string; readonly role: Role | null; readonly retired: unknown }>, admitted: readonly string[], leaf: string,
): string | null => {
  const counted = new Set(admitted.map((x) => x.toLowerCase()));
  const gone = leaf.toLowerCase();
  const stays = seats.some((x) => x.seat.toLowerCase() !== gone && x.retired === null && counted.has(x.seat.toLowerCase())
    && mayFile(x).includes('roster'));
  return stays ? null : 'once this signer is removed, nobody left is an admin in the company\'s records, and only an admin adds '
    + 'signers to those records and files people, vendors and policies. Invite another admin first, then remove this signer once '
    + 'that admin has taken their seat and been added';
};

/** A refusal as it is shown to the person: the check's own sentence, with its first letter a capital. */
export const refusalSaid = (says: string): string => `${says.charAt(0).toUpperCase()}${says.slice(1)}`;

/** A seat added that sets the threshold once taken. */
export type SeatThresholdChange = Extract<GovernanceChange, { kind: 'seatAndThreshold' }>;

/**
 * **WHY A SEAT ADDED WITH A NEW THRESHOLD IS REFUSED BEFORE ANYTHING IS BUILT, OR NULL.** The chain refuses, when the
 * invitee takes the seat, a threshold above the signers it then seats; this says so first, counting the seats on the
 * chain now (`seats`) and the one the invitation adds. Then the count of who may approve each vault's runs, with the
 * new seat counted with the rights its invitation's role gives on the vaults it names (`countedRightsOf`): a
 * threshold that leaves a vault short is refused.
 * Bands are not counted here, as for a threshold change: leaving them out can only refuse more.
 * **THE ONE CHECK OF AN INVITATION'S THRESHOLD, called by the page, the wallet and the device's governed call** with the roster each
 * builds from its own reads (`approversFrom`, packages/web-shared/src/approvers-read.ts); the sentence is `refusalSaid` of what it returns.
 */
export const seatThresholdRefusal = (
  roster: ApproverRoster, bounds: { readonly seats: number }, change: SeatThresholdChange, nameOf: (vault: Hex) => string = (v) => v,
): string | null => {
  const wanted = change.threshold;
  if (!wholeThreshold(wanted)) return 'the approvals needed once the seat is taken must be a whole number, at least one.';
  const seated = bounds.seats + 1;
  if (wanted > seated) {
    return `once this seat is taken the company has ${seated} ${seated === 1 ? 'signer' : 'signers'}, so it cannot need ${wanted} approvals, `
      + 'or nothing could ever be approved. Choose a smaller number, or seat more signers first.';
  }
  const { bands: _bands, ...counted } = roster;
  const short = vaultsLeftShort(counted, change);
  return short.length === 0 ? null : leftShortSaid(short, nameOf, roster);
};

/** The account's bars as the person's own wallet reads them from the chain. */
export interface BarsHeld {
  readonly approvals: number;
  readonly policyBar: number | null;
  readonly seatBar: number;
  readonly vaultThresholds: ReadonlyArray<{ readonly vault: string; readonly threshold: number }>;
}

/**
 * **THE APPROVALS A THRESHOLD CHANGE IS CARRIED OUT AT**, besides what the
 * proposal held when it was raised. The account's threshold changes at the
 * threshold. A vault's changes at the threshold too, unless it raises the vault
 * past the approvals a policy change needs or lowers it: then at the seat bar,
 * the higher of the threshold and that bar (`setVaultThreshold`).
 */
export const thresholdCarryBar = (change: ThresholdChange, held: BarsHeld): number => {
  if (change.kind === 'threshold') return held.approvals;
  const row = held.vaultThresholds.find((v) => same(v.vault as Hex, change.vault));
  const policyBar = held.policyBar ?? held.approvals;
  const vaultBar = row === undefined ? held.approvals : row.threshold;
  return change.threshold > policyBar || change.threshold < vaultBar ? Math.max(held.approvals, held.seatBar) : held.approvals;
};

/** Every right on every vault: a seat whose leaf commits to `allVaults()`. */
export const EVERY_RIGHT: SeatRights = Object.freeze({ every: true }) as SeatRights;

/**
 * **THE COMPANY AS A SIGNER'S DEVICE COUNTS IT**: each seated leaf with the
 * rights its directory entry was believed with, the bars the chain holds, and
 * every vault a run can name - each vault the account has adopted, and the
 * value a company-wide run names - with the bands, the vaults with a run open and
 * the signers removed since, where the caller read them.
 */
export const approverRosterFrom = (input: {
  readonly threshold: number;
  readonly vaultThresholds: ReadonlyArray<{ readonly vault: string; readonly threshold: number }>;
  readonly seated: ReadonlyArray<{ readonly leaf: string; readonly rights: SeatRights }>;
  readonly adoptedVaults: readonly string[];
  readonly companyWide: string;
  readonly bands?: ReadonlyMap<Hex, number>;
  readonly openRuns?: ReadonlySet<Hex>;
  readonly removals?: number;
  readonly outrunBy?: string;
  readonly openRun?: string;
}): ApproverRoster => ({
  seats: new Map(input.seated.map((s) => [s.leaf.toLowerCase() as Hex, s.rights])),
  threshold: input.threshold,
  vaultThresholds: new Map(input.vaultThresholds.map((v) => [v.vault.toLowerCase() as Hex, v.threshold])),
  runVaults: [...new Set([...input.adoptedVaults, input.companyWide].map((v) => v.toLowerCase()))] as Hex[],
  ...(input.bands === undefined ? {} : { bands: input.bands }),
  ...(input.openRuns === undefined ? {} : { openRuns: input.openRuns }),
  ...(input.removals === undefined ? {} : { removals: input.removals }),
  ...(input.outrunBy === undefined ? {} : { outrunBy: input.outrunBy }),
  ...(input.openRun === undefined ? {} : { openRun: input.openRun }),
});
