/*
 * THE COMPANY'S RECORDS EVERY PAYMENT ACTION READS, IN THE WALLET, with the pure circuits it computes with and which
 * of a run's leaves the account already records as paid.
 */
import type { SealedProposal, SealedRun } from '../../../../src/core/types.js';
import { assets as theAssets, type AssetRegistry } from '../../../../src/core/assets.js';
import { fromHex, toHex, type Hex } from '../../../../src/core/crypto.js';
import type { PaymentsAmong } from '../../../../src/core/ledger.js';
import { buildOneOffRun, type DetailsOfKind } from '../../../../src/midnight/payout-tree.js';
import { openOneOff } from '../../../../src/midnight/one-off-record.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { detailsOfKind } from '../../../../src/midnight/vault-details.js';
import { NETWORK } from 'midnight-identity/network';
import { withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { firstFiledThrough } from '../../../../packages/web-shared/src/roster-through-the-view.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { HttpCompanyRecordStore, readsJoinedIn } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { readPeopleHere } from '../../../../packages/web-shared/src/people-read-here.js';
import { readVendorsWithKeys } from '../../../../packages/web-shared/src/vendors-on-device.js';
import { signedClaimRefusal } from '../../../../packages/web-shared/src/signed-claim-refusal.js';
import { treeKeptHere, type TreeKept } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { proposalsInTheView, type CompanyReach } from './company-reach.js';
import { StepRefused } from './definition.js';
import { policiesInTheWallet } from './policy-doors-in-the-wallet.js';

/** The account's and the vault's pure circuits every payment action computes with, read from the compiled contracts this wallet ships. */
export interface PureCircuits {
  readonly account: CompanyRecordsHere['roundIdentity'] & {
    readonly retrySaltOf: (legRoot: Uint8Array, fresh: Uint8Array) => Uint8Array;
    readonly noVault: () => Uint8Array;
    readonly paidOnceOf: (nonce: Uint8Array) => Uint8Array;
    readonly paidMovementOf: (leaf: Uint8Array) => Uint8Array;
  };
  readonly details: DetailsOfKind;
}

let pureLoaded: Promise<PureCircuits> | null = null;
/** The pure circuits, loaded once for every payment action and loaded again only after a failed load. */
export const pureCircuits = (): Promise<PureCircuits> => {
  pureLoaded ??= (async () => {
    const [account, vault] = await Promise.all([
      import('../../../../contracts/managed/contract/index.js'),
      import('../../../../contracts/managed-vault/contract/index.js'),
    ]);
    return { account: account.pureCircuits, details: detailsOfKind(vault.pureCircuits) };
  })();
  pureLoaded.catch(() => { pureLoaded = null; });
  return pureLoaded;
};

/** What the records door is read with beyond the company: the currencies, the network payees' addresses are read on, and where this wallet keeps the heads it checked. */
export interface RecordsReach {
  readonly assets?: AssetRegistry;
  readonly network?: NetworkName;
  readonly treeKept?: () => TreeKept;
}

/** The company's records every payment action reads, with the one-off payments' records beside them. */
export type CompanyRecordsInTheWallet = CompanyRecordsHere & {
  readonly oneOffs: NonNullable<CompanyRecordsHere['oneOffs']>;
  readonly proposals: () => Promise<readonly SealedProposal[]>;
};

/**
 * **THE ONE RECORDS DOOR OF EVERY PAYMENT ACTION IN THE WALLET** (a one-off payment, a payroll run raised or
 * approved). The directory every filing is judged by; the company's people and vendors, read and judged as every
 * device reads them; its ceilings from the roster this wallet opens; its state; its proposals and runs as the service
 * holds them, each judged where it is used; where each proposal stands on the chain and what the account records as
 * paid, read through this wallet's own indexer with this seat; the heads of the company's records this wallet checked
 * itself; a vault's spending policy (sealed records this seat opens, checked against the chain); the one-off records
 * under the company key. Nothing a check or a payment decides on is taken from the service's word.
 */
export function companyRecordsFor(r: CompanyReach, reach: RecordsReach, pure: PureCircuits): CompanyRecordsInTheWallet {
  const registry = reach.assets ?? theAssets;
  const network = reach.network ?? NETWORK;
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const store = new HttpCompanyRecordStore(r.accountId, readsJoinedIn(r.stepView), null, judge);
  return {
    directory,
    people: () => readPeopleHere({
      company: withCompanyKeys({ id: r.accountId, label: r.label }, r.companyKeys), view: r.stepView.current(), directory, network,
      claimRefusal: signedClaimRefusal,
    }),
    vendors: () => readVendorsWithKeys({ id: r.accountId, label: r.label }, r.companyKeys, {
      view: r.stepView.current(), directory, network, claimRefusal: signedClaimRefusal,
    }),
    state: (id) => firstFiledThrough(r.stepView, r.accountId, 'state', id),
    runs: async () => await r.stepView.current().list('runs') as readonly SealedRun[],
    proposals: proposalsInTheView(r),
    roundsOnChain: (chainIds) => r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds, seat: r.seat.signingSecret }),
    checked: () => (reach.treeKept ?? treeKeptHere)().checked.read(r.accountId),
    payments: {
      paidOnceOf: (nonce) => pure.account.paidOnceOf(nonce),
      paidMovementOf: (leaf) => pure.account.paidMovementOf(leaf),
      read: async (entries) => {
        if (r.chain.payments === undefined) throw new Error('this wallet cannot read the account\'s record of payments.');
        const read = await r.chain.payments(r.account, r.label, entries);
        if ('key' in read) throw new StepRefused(read);
        return read;
      },
    },
    roundIdentity: pure.account,
    policy: async () => (await r.roster()).policy,
    registry,
    spendingPolicies: policiesInTheWallet(r),
    oneOffs: {
      at: (kind, id, version) => store.at(kind, id, version), keys: r.companyKeys, detailsOf: pure.details, registry,
      open: openOneOff, treeOf: buildOneOffRun,
    },
  };
}

/** Which of these leaves the account records as paid, read from the chain through this wallet's own indexer. */
export const paidAmongFor = (records: CompanyRecordsHere, pure: PureCircuits) => async (leaves: readonly Hex[]): Promise<PaymentsAmong> => {
  const entries = leaves.map((leaf) => toHex(pure.account.paidMovementOf(fromHex(leaf))).toLowerCase());
  const held = new Set((await records.payments.read(entries)).held.map((e) => e.toLowerCase()));
  return { known: true, paid: leaves.filter((_leaf, i) => held.has(entries[i]!)) as Hex[] };
};

