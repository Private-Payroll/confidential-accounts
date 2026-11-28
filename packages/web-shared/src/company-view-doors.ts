/**
 * **WHAT THE COMPANY'S VIEW READS OUTSIDE THE COMPANY'S SERVICE**, counted like the service's reads: who holds the
 * company on the chain (through the person's own wallet or the indexer it names), the anchors the account's history
 * shows, the reads of the company on the chain this device makes itself, the heads the builder works out, the device's
 * own stores, and how the directory is believed over the view. The page and the wallet each hand their own in; the
 * view reads each at most once until a write changes it, the check before a write reads who holds the company once
 * more, fresh, and a send is watched on the anchors read fresh.
 */
import type { AccountRoleEntry } from 'midnight-identity/profile/records-key';
import type { CompanyView } from './company-view.js';
import type { AnchorsOnChain } from './governed-call-builder.js';
import type { RecordSource } from './records-source.js';
import type { TreeKept } from './tree-kept-here.js';
import type { DirectoryBelieved } from './vault-page-doors.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

/** The reads of the company on the chain a device may answer from its own doors (`ViewDoors.chain`). */
export type OwnChainReads = Pick<
  RecordSource,
  'callState' | 'vaultChain' | 'payoutState' | 'authority' | 'committeeChange' | 'vaultKeys'
>;

/** The doors a view is given. `H` is how this device reads who holds the company. */
export interface ViewDoors<H> {
  /** Who holds the company on the chain now: its seats, the approvals it needs, the vaults it has adopted. */
  readonly holders: () => Promise<H>;
  /** Every head the account's history shows, and who holds the account now. */
  readonly onChain: () => Promise<AnchorsOnChain>;
  /** The builder's reads: the head each step leaves, and, where the opener gives it, the company's vaults on the chain. */
  readonly builder: Pick<VaultBuilderClient, 'anchorHeads'> & Partial<Pick<VaultBuilderClient, 'vaultsOnChain'>>;
  /**
   * The device's own stores - the heads it checked, the headers it signed or checked last, the directory changes it
   * keeps - shared by every read and anchor through the view; absent, the view keeps them in memory while it lives.
   */
  readonly kept?: () => Partial<TreeKept>;
  /** The company's directory with its records, believed over the view it is handed; absent, the view believes none. */
  readonly directory?: (view: CompanyView<H>) => Promise<DirectoryBelieved>;
  /** The account's roles asked, as the chain holds them now; absent, the view reads no roles. */
  readonly roles?: (asked: readonly string[]) => Promise<RolesRead>;
  /**
   * The reads of the company on the chain this device makes itself, answered by its own doors and never by the
   * service: the account's call state, a vault and its payouts, who holds the account, a committee change owed and the
   * vaults' keys. Absent, the view asks its source for them.
   */
  readonly chain?: OwnChainReads;
  /**
   * This device's filing key in the company, once its seat is known: an entry of its own that a header it files again
   * carries is taken as its own write (`Baseline.acknowledged`). Absent, or null, no carried entry is.
   */
  readonly filer?: () => string | null;
  /** How the check waits for the chain's indexer to show this side's own send (`company-view-probe.ts`); a test passes its own. */
  readonly pause?: (ms: number) => Promise<void>;
}

/** The account's roles as the chain holds them, for the roles asked. */
export interface RolesRead {
  readonly roles?: readonly AccountRoleEntry[];
}

/** How many times a view went through each of its doors and asked each of the source's asks. */
export interface ViewCounts {
  readonly [ask: string]: number;
}

/** A tally kept by one view. */
export class Tally {
  private readonly n = new Map<string, number>();
  add(ask: string, by = 1): void {
    this.n.set(ask, (this.n.get(ask) ?? 0) + by);
  }
  get counts(): ViewCounts {
    return Object.freeze(Object.fromEntries(this.n));
  }
}

/**
 * Runs `read` once, and gives every later caller the same answer. A failure is given to every caller waiting on it,
 * and is not kept: the next caller reads again.
 */
export const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
  let held: Promise<T> | null = null;
  return () => {
    if (held !== null) return held;
    const answer = read();
    held = answer;
    answer.catch(() => {
      if (held === answer) held = null;
    });
    return answer;
  };
};

/** The doors, each counted in `tally` under its name; `holders` is read at most once, and the view keeps `onChain`. */
export const countedDoors = <H>(
  doors: ViewDoors<H>,
  tally: Tally
): ViewDoors<H> & {
  readonly freshHolders: () => Promise<H>;
  readonly roles: (asked: readonly string[]) => Promise<RolesRead>;
} => {
  const freshHolders = (): Promise<H> => {
    tally.add('holders');
    return doors.holders();
  };
  return Object.freeze({
    holders: once(freshHolders),
    freshHolders,
    onChain: () => {
      tally.add('onChain');
      return doors.onChain();
    },
    builder: {
      anchorHeads: (ask: Parameters<VaultBuilderClient['anchorHeads']>[0]) => {
        tally.add('anchorHeads');
        return doors.builder.anchorHeads(ask);
      },
      ...(doors.builder.vaultsOnChain === undefined
        ? {}
        : {
            vaultsOnChain: (ask: Parameters<VaultBuilderClient['vaultsOnChain']>[0]) =>
              doors.builder.vaultsOnChain!(ask)
          })
    },
    roles: (asked: readonly string[]): Promise<RolesRead> => {
      if (doors.roles === undefined)
        return Promise.reject(new Error('this read of the company was given no way to read its roles on the chain.'));
      tally.add('roles');
      return doors.roles(asked);
    }
  });
};
