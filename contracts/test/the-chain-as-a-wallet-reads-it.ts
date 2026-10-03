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
import { holdersInAccountState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import type { Account } from '../../src/core/types.js';
import type { Hex } from '../../src/core/crypto.js';
import { filerSeatOf } from '../../src/midnight/seat-directory.js';
import { directoryOf, type DirectoryChainRead, type DirectoryStore } from '../../src/server/seat-directory-route.js';
import type { MayFileUnder } from '../../src/server/vault-records-authority.js';
import type { FreshJudge } from 'vaults-web-shared/http-sealed-pool-store.js';
import { attestedIn, directoryFilingsFrom, directoryJudge, fileOwnDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';

type StateOf = () => { serialize(): Uint8Array } | null;
type Api = (path: string, init?: RequestInit) => Promise<any>;

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

/** The server's check S over its own directory, as `src/server/index.ts` makes it. */
export const mayFileUnderOver = (store: DirectoryStore): MayFileUnder => (companyId, person, filer, record) =>
  typeof filerSeatOf(directoryOf(store, companyId), person, filer, record) !== 'string';

/** A device's judge of who filed a version: the directory read again, and the account read again off the chain. */
export const judgeOver = (deps: {
  api: Api; accountId: string; label: CompanyLabel; accountState: StateOf; roster: () => Promise<Pick<Account, 'signers'>>;
}): FreshJudge => directoryJudge({
  accountId: deps.accountId, label: deps.label,
  filings: () => directoryFilingsFrom(deps.api, deps.accountId),
  holders: async () => {
    const state = deps.accountState();
    if (state === null) throw new Error('the wallet read no company account');
    return holdersInAccountState(state.serialize());
  },
  attested: async () => attestedIn(await deps.roster()),
});

/** A seat's own entry, signed by its wallet for its filing key and filed from its device, as the page files one. */
export const fileOwnEntry = async (deps: {
  api: Api; accountId: string; person: string; identity: Identity; label: CompanyLabel;
  companyKey: Uint8Array; signingKey: Hex; seat: string;
}) => fileOwnDirectoryEntry(deps.api, deps.accountId, deps.person, deps.label, {
  committeeKey: committeeKeyFor(deps.identity, deps.label),
  entry: signDirectoryEntry(deps.identity, deps.label, deps.companyKey, deps.signingKey.toLowerCase(), deps.seat.toLowerCase()),
});

/** The wallet's read for a step on any vault of the company whose account `accountState` reads. */
export const walletReadsOver = (accountState: StateOf) => async () => {
  const state = accountState();
  if (state === null) throw new Error('the wallet read no company account');
  return { holders: holdersInAccountState(state.serialize()) };
};
