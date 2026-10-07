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
import { attestedIn, directoryFilingsFrom, directoryJudge, fileTheOwedDirectoryEntry, type OwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';

type StateOf = () => { serialize(): Uint8Array } | null;
type Api = (path: string, init?: RequestInit) => Promise<any>;

/** The account's deploy as the wallet reads it: the state its deploy left, and the company's label it is read for. */
export interface DeployRead { readonly state: () => { serialize(): Uint8Array }; readonly label: () => CompanyLabel }

/** Who holds the account now and the seat its deploy seated, as the signer's own wallet answers. */
const holdersAsTheWalletReads = (accountState: StateOf, deploy: DeployRead) => {
  const state = accountState();
  if (state === null) throw new Error('the wallet read no company account');
  const founding = foundingInDeployState(deploy.state().serialize(), deploy.label());
  return { ...holdersInAccountState(state.serialize()), founding: founding.seat, foundingCommittee: founding.committee };
};

/** The server's own read of the company's account, for a seat filing in its directory. */
export const directoryChainOver = (accountState: StateOf): DirectoryChainRead => async (_id, seats) => {
  const state = accountState();
  if (state === null) return null;
  const read = holdersInAccountState(state.serialize());
  return {
    seats: { committee: read.committee, threshold: read.threshold, seats: seats.filter((x) => read.seats.includes(x.toLowerCase())) },
    approvals: read.approvals,
  };
};

/** The server's check S over its own directory against its own read of the chain, as `src/server/index.ts` makes it. */
export const mayFileUnderOver = (store: DirectoryStore, chain: DirectoryChainRead): MayFileUnder => async (companyId, person, filer, record) =>
  typeof filerSeatNow(await directoryOf(store, chain, companyId), person, filer, record) !== 'string';

/** A device's judge of who filed a version: the directory read again, and the account read again off the chain. */
export const judgeOver = (deps: {
  api: Api; accountId: string; label: CompanyLabel; account: string; accountState: StateOf; deployed: () => { serialize(): Uint8Array };
  roster: () => Promise<Pick<Account, 'signers'>>;
}): FreshJudge => directoryJudge({
  accountId: deps.accountId, label: deps.label,
  filings: () => directoryFilingsFrom(deps.api, deps.accountId),
  holders: async () => ({
    ...holdersAsTheWalletReads(deps.accountState, { state: deps.deployed, label: () => deps.label }), account: deps.account.toLowerCase() as never,
  }),
  attested: async () => attestedIn(await deps.roster()),
});

/** A seat's own entry, signed by its wallet for its filing key and filed from its device, as the page files one; a refusal is thrown. */
export const fileOwnEntry = async (deps: {
  api: Api; accountId: string; person: string; identity: Identity; label: CompanyLabel; account: string;
  companyKey: Uint8Array; signingKey: Hex; seat: string;
}) => {
  let owed: OwedDirectoryEntry | null = {
    person: deps.person, company: deps.label,
    signed: {
      committeeKey: committeeKeyFor(deps.identity, deps.label) as { tag: string; value: string },
      entry: signDirectoryEntry(deps.identity, deps.label, deps.account.toLowerCase() as never, deps.companyKey, deps.signingKey.toLowerCase(), deps.seat.toLowerCase()),
    },
  };
  const done = await fileTheOwedDirectoryEntry(deps.api, deps.accountId, { read: () => owed, settle: async () => { owed = null; } });
  if (typeof done === 'object') throw new Error(done.notYet);
  return done;
};

/** The wallet's read for a step on any vault of the company whose account `accountState` reads, deployed as `deploy` reads. */
export const walletReadsOver = (accountState: StateOf, deploy: DeployRead) => async () => ({ holders: holdersAsTheWalletReads(accountState, deploy) });
