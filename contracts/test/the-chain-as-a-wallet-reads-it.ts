/**
 * **WHAT A SIGNER'S OWN WALLET READS OFF A TEST CHAIN FOR A VAULT'S COMPANY,
 * AND THE COMPANY'S SEAT DIRECTORY OVER IT**: who holds the company's account
 * and which vaults it has adopted. The directory is read and judged over the
 * same chain: by the server when a seat files, and by a device for every read.
 */
import type { Identity } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { foundingInDeployState, holdersInAccountState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import type { Account } from '../../src/core/types.js';
import type { Hex } from '../../src/core/crypto.js';
import { directoryOf, filerSeatNow, type DirectoryChainRead, type DirectoryStore } from '../../src/server/seat-directory-route.js';
import type { MayFileUnder } from '../../src/server/vault-records-authority.js';
import type { FreshJudge } from 'vaults-web-shared/http-sealed-pool-store.js';
import {
  attestedIn, directoryFilingsFrom, directoryHere, directoryJudge, fileTheOwedDirectoryEntry, type DirectoryHereDeps, type OwedDirectoryEntry,
} from 'vaults-web-shared/vault-page-doors.js';
import { anchoredOver } from '../../src/testing/record-tree-double.js';
import { leavesOfTheContract } from '../../src/testing/directory-seats.js';
import { seatBlinding, type SeatOpening } from '../../src/core/seat-opening.js';
import { pureCircuits } from '../managed/contract/index.js';

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * **A SEAT'S DEVICE AS A SEATING DEVICE MAKES ONE**: `device` with its blinding
 * the hash of the person's wallet key for the company under `salt`, so its leaf
 * commits to that key, and the opening its directory entry carries.
 */
export const madeForTheWallet = <D extends { secretKey: Uint8Array; blinding: Uint8Array; scope: Uint8Array }>(
  device: D, identity: Identity, label: CompanyLabel, salt = '5a'.repeat(32),
): { readonly device: D; readonly opening: SeatOpening } => {
  const walletKey = committeeKeyFor(identity, label) as { tag: string; value: string };
  const blinding = seatBlinding(walletKey, salt);
  return {
    device: { ...device, blinding: Uint8Array.from(Buffer.from(blinding, 'hex')) },
    opening: { publicKey: hexOf(pureCircuits.signerPublicKey(device.secretKey)), scope: hexOf(device.scope), blinding, walletKey, salt },
  };
};

type StateOf = () => { serialize(): Uint8Array } | null;

/** The key the account keeps the approvals a policy change needs under, as its own compiled `policyBarKey` makes it. */
const BAR_KEY = Array.from(pureCircuits.policyBarKey(), (b) => b.toString(16).padStart(2, '0')).join('');
type Api = (path: string, init?: RequestInit) => Promise<any>;

/** The account's deploy as the wallet reads it: the state its deploy left, and the company's label it is read for. */
export interface DeployRead { readonly state: () => { serialize(): Uint8Array }; readonly label: () => CompanyLabel }

/** Who holds the account now and the seat its deploy seated, as the signer's own wallet answers. */
const holdersAsTheWalletReads = (accountState: StateOf, deploy: DeployRead) => {
  const state = accountState();
  if (state === null) throw new Error('the wallet read no company account');
  const founding = foundingInDeployState(deploy.state().serialize(), deploy.label());
  return { ...holdersInAccountState(state.serialize(), BAR_KEY), founding: founding.seat, foundingCommittee: founding.committee };
};

/** The server's own read of the company's account, for a seat filing in its directory. */
export const directoryChainOver = (accountState: StateOf): DirectoryChainRead => async (_id, seats) => {
  const state = accountState();
  if (state === null) return null;
  const read = holdersInAccountState(state.serialize(), BAR_KEY);
  return {
    seats: { committee: read.committee, threshold: read.threshold, seats: seats.filter((x) => read.seats.includes(x.toLowerCase())) },
    approvals: read.approvals, seatBar: read.seatBar,
  };
};

/** The server's check of the filing seat over its own directory against its own read of the chain, as `src/server/index.ts` makes it. */
export const mayFileUnderOver = (store: DirectoryStore, chain: DirectoryChainRead): MayFileUnder => async (companyId, person, filer) =>
  typeof filerSeatNow(await directoryOf(store, chain, companyId), person, filer) !== 'string';

type DeviceReads = {
  /** The company's viewing key, which this device opens every directory entry's proof with. */
  viewingKey: Hex;
  api: Api; accountId: string; label: CompanyLabel; account: string; accountState: StateOf; deployed: () => { serialize(): Uint8Array };
  roster: () => Promise<Pick<Account, 'signers'>>;
};

/** What a device reads to believe the company's directory: the directory read again, and the account read again off the chain. */
const directoryDepsOver = (deps: DeviceReads): DirectoryHereDeps => ({
  accountId: deps.accountId, label: deps.label, viewingKey: deps.viewingKey,
  filings: () => directoryFilingsFrom(deps.api, deps.accountId),
  holders: async () => ({
    ...holdersAsTheWalletReads(deps.accountState, { state: deps.deployed, label: () => deps.label }), account: deps.account.toLowerCase() as never,
  }),
  attested: async () => attestedIn(await deps.roster()),
  /* The company's records over the service's own manifest route; the account here has anchored nothing. */
  anchored: anchoredOver(deps.api, deps.accountId),
  /* What the device's vault worker makes of each entry's opening, with the account's own compiled `signerLeaf`. */
  leaves: leavesOfTheContract,
});

/** A device's judge of who filed a version: the directory read again, and the account read again off the chain. */
export const judgeOver = (deps: DeviceReads): FreshJudge => directoryJudge(directoryDepsOver(deps));

/** The company's directory as a device believes it, read afresh: where each reader of a vault's secret is read from. */
export const directoryBelievedOver = (deps: DeviceReads) => async () => {
  const here = await directoryHere(directoryDepsOver(deps));
  return { seats: here.dir.seats, leafOf: here.leafOf };
};

/** A seat's own entry, signed by its wallet for its filing key and filed from its device, as the page files one; a refusal is thrown. */
export const fileOwnEntry = async (deps: {
  api: Api; accountId: string; person: string; identity: Identity; label: CompanyLabel; account: string;
  companyKey: Uint8Array; signingKey: Hex; seat: string; opening: SeatOpening;
  /** The seat's filing key's secret and the company's viewing key: what the entry is signed with and its proof sealed under. */
  signingSecret: Hex; viewingKey: Hex;
  /** The seat the account was deployed with, as the person's own wallet reads it: an entry for any other seat needs its invitation. */
  founding: string;
}) => {
  let owed: OwedDirectoryEntry | null = {
    person: deps.person, company: deps.label, opening: deps.opening,
    signed: {
      committeeKey: committeeKeyFor(deps.identity, deps.label) as { tag: string; value: string },
      entry: signDirectoryEntry(deps.identity, deps.label, deps.account.toLowerCase() as never, deps.companyKey, deps.signingKey.toLowerCase(), deps.seat.toLowerCase()),
    },
  };
  const done = await fileTheOwedDirectoryEntry(deps.api, deps.accountId, { read: () => owed, settle: async () => { owed = null; } },
    async () => ({ signingSecret: deps.signingSecret, viewingKey: deps.viewingKey }), async () => deps.founding);
  if (typeof done === 'object') throw new Error('notYet' in done ? done.notYet : done.waitingForItsInvitation);
  return done;
};

/** The wallet's read for a step on any vault of the company whose account `accountState` reads, deployed as `deploy` reads. */
export const walletReadsOver = (accountState: StateOf, deploy: DeployRead) => async () => ({ holders: holdersAsTheWalletReads(accountState, deploy) });
