import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { publicDataProviderFor } from '../../../../packages/web-shared/src/public-data.js';
import { deployFromIndexerAt, fromIndexerAt, holdersOnChain } from './company-label-on-chain.js';
import { INDEXER_HTTP_URL, INDEXER_WS_URL } from '../config.js';
import type { CompanyChain } from '../actions/company-reach.js';

/**
 * WHAT AN ACTION ON A COMPANY READS OF THE CHAIN, AT THIS WALLET'S OWN INDEXER
 * and nowhere else: who holds the account now (the label it carries checked
 * against the one asked), and the account's state with the chain's parameters
 * at one block, which a call is built and proved on.
 */
export function liveCompanyChain(indexer = { indexerUri: INDEXER_HTTP_URL, indexerWsUri: INDEXER_WS_URL }): CompanyChain {
  let reader: ReturnType<typeof publicDataProviderFor> | null = null;
  const b64 = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return Object.freeze({
    indexer,
    holders: async (account: AccountAddress, label: CompanyLabel) => {
      const read = await holdersOnChain(account, label, fromIndexerAt(indexer.indexerUri), deployFromIndexerAt(indexer.indexerUri));
      if (read.of === 'read') return { ...read.holders, account } as AccountHoldersRead;
      return { key: `act.company.why.${read.of}` };
    },
    callState: async (account: AccountAddress) => {
      reader ??= publicDataProviderFor(indexer);
      const r = await reader;
      const block = await r.queryBlock();
      if (block === null) return null;
      const read = await r.queryZSwapAndContractState(account, { type: 'blockHash', blockHash: block.hash } as never);
      if (read === null || read === undefined) return null;
      const [, state, parameters] = read as unknown as [unknown, { serialize(): Uint8Array }, { serialize(): Uint8Array }];
      return { blockHash: String(block.hash), accountState: b64(state.serialize()), parameters: b64(parameters.serialize()) };
    },
  });
}
