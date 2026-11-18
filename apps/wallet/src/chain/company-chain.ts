import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { publicDataProviderFor } from '../../../../packages/web-shared/src/public-data.js';
import { accountAtOneBlockOver, accountCallChainOf } from '../../../../packages/web-shared/src/one-block-read.js';
import { deployFromIndexerAt, fromIndexerAt, holdersOnChain } from './company-label-on-chain.js';
import { INDEXER_HTTP_URL, INDEXER_WS_URL } from '../config.js';
import type { CompanyChain } from '../actions/company-reach.js';

/**
 * WHAT AN ACTION ON A COMPANY READS OF THE CHAIN, AT THIS WALLET'S OWN INDEXER
 * and nowhere else: who holds the account now (the label it carries checked
 * against the one asked), the account's state with the chain's parameters
 * at one block, which a call is built and proved on, and the entries of the
 * account's record of payments and of its roles that a payment out of a vault
 * is checked against.
 */
export function liveCompanyChain(indexer = { indexerUri: INDEXER_HTTP_URL, indexerWsUri: INDEXER_WS_URL }): CompanyChain {
  let reader: ReturnType<typeof publicDataProviderFor> | null = null;
  return Object.freeze({
    indexer,
    holders: async (account: AccountAddress, label: CompanyLabel) => {
      const read = await holdersOnChain(account, label, fromIndexerAt(indexer.indexerUri), deployFromIndexerAt(indexer.indexerUri));
      if (read.of === 'read') return { ...read.holders, account } as AccountHoldersRead;
      return { key: `act.company.why.${read.of}` };
    },
    payments: async (account: AccountAddress, label: CompanyLabel, entries: readonly string[]) => {
      const read = await holdersOnChain(account, label, fromIndexerAt(indexer.indexerUri), deployFromIndexerAt(indexer.indexerUri), entries);
      if (read.of === 'read' && read.payments !== undefined) return read.payments;
      return { key: `act.company.why.${read.of === 'read' ? 'unreadable' : read.of}` };
    },
    roles: async (account: AccountAddress, label: CompanyLabel, keys: readonly string[]) => {
      const read = await holdersOnChain(account, label, fromIndexerAt(indexer.indexerUri), deployFromIndexerAt(indexer.indexerUri), undefined, keys);
      if (read.of === 'read' && read.roles !== undefined) return read.roles;
      return { key: `act.company.why.${read.of === 'read' ? 'unreadable' : read.of}` };
    },
    callState: async (account: AccountAddress) => {
      reader ??= publicDataProviderFor(indexer);
      return accountCallChainOf(await accountAtOneBlockOver(await reader, account));
    },
  });
}
