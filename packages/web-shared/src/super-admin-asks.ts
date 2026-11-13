/**
 * **WHAT THE PAGE ASKS THE VAULT WORKER FOR IN A CHANGE OF THE SUPER ADMINS**: who holds each contract and which
 * vaults the account lists, read at the indexer the person's own wallet names, and the ledger's part (an update's
 * bytes, a signature's check). The ledger and the contracts' readers load only in the worker
 * (`super-admins-answered.ts`); what crosses is plain: addresses, keys, base64 bytes and the reads' own answers.
 */
import type { AccountRead, AuthorityRead, CommitteeReads } from './committee-reads.js';
import type { SuperAdminLedger } from './super-admin-ledger.js';
import { fromBase64, toBase64 } from './base64-bytes.js';

type Indexer = { readonly indexerUri: string; readonly indexerWsUri: string };
type Key = { readonly tag: string; readonly value: string };
type Asked<A extends string, T> = { id: number; network: string; ask: A } & T;
type Answered<A extends string, T> = { id: number; ok: true; ask: A } & T;

export type SuperAdminAsk =
  | Asked<'account-committee', { account: string; indexer: Indexer }>
  | Asked<'contract-authority', { address: string; indexer: Indexer }>
  | Asked<'super-admin-update', { vault: string; counter: string; to: { committee: Key[]; threshold: number } }>
  | Asked<'super-admin-signed', { key: Key; data: string; signature: Key }>
  | Asked<'super-admin-joined', { key: Key; data: string; signature: string }>;

export type SuperAdminAnswer =
  | Answered<'account-committee', { read: AccountRead | null }>
  | Answered<'contract-authority', { read: AuthorityRead | null }>
  | Answered<'super-admin-update', { bytes: string }>
  | Answered<'super-admin-signed', { good: boolean }>
  | Answered<'super-admin-joined', { good: boolean }>;

type Without<T> = T extends unknown ? Omit<T, 'id' | 'network'> : never;
type SuperAdminRequest = Without<SuperAdminAsk>;

/** The reads and the ledger's part as the page reaches them: each one ask of the vault worker. */
export interface SuperAdminWorker {
  /** The chain's reads at `indexer`, the indexer the person's own wallet names. */
  readonly reads: (indexer: Indexer) => CommitteeReads;
  readonly ledger: SuperAdminLedger;
}

const plain = (k: Key): Key => ({ tag: k.tag, value: k.value });

/** The worker's reads and ledger, over `asked`: the vault worker client's own way of asking. */
export function superAdminWorkerOver(asked: (request: SuperAdminRequest) => Promise<SuperAdminAnswer>): SuperAdminWorker {
  const answer = async <A extends SuperAdminAsk['ask']>(request: SuperAdminRequest & { ask: A }): Promise<Extract<SuperAdminAnswer, { ask: A }>> => {
    const a = await asked(request);
    if (a.ask !== request.ask) throw new Error('the vault worker answered a different question.');
    return a as Extract<SuperAdminAnswer, { ask: A }>;
  };
  return {
    reads: (indexer) => ({
      accountAt: async (account) => (await answer({ ask: 'account-committee', account, indexer })).read,
      authorityAt: async (address) => (await answer({ ask: 'contract-authority', address, indexer })).read,
    }),
    ledger: {
      updateBytes: async (u) => fromBase64((await answer({
        ask: 'super-admin-update', vault: u.vault, counter: u.counter.toString(), to: { committee: u.to.committee.map(plain), threshold: u.to.threshold },
      })).bytes),
      signedBy: async (key, data, signature) => (await answer({ ask: 'super-admin-signed', key: plain(key), data: toBase64(data), signature: plain(signature) })).good,
      joinedBy: async (bytes, key, signature) => (await answer({ ask: 'super-admin-joined', key: plain(key), data: toBase64(bytes), signature })).good,
    },
  };
}
