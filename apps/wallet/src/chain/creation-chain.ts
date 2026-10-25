import { operationsFromContractState } from 'midnight-identity/profile/contract-keys';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { publicDataProviderFor } from '../../../../packages/web-shared/src/public-data.js';
import { accountPresenceAt } from '../../../../packages/web-shared/src/vault-on-chain-here.js';
import { INDEXER_HTTP_URL, INDEXER_WS_URL } from '../config.js';

/**
 * **WHERE A NEW COMPANY'S ACCOUNT STANDS, AS THIS WALLET READS THE CHAIN.**
 * Read from the wallet's own indexer (`config.ts`), never from the page or the
 * service: whether the account is on the chain and the newest block's time,
 * and the account's state with the chain's parameters as one block saw them,
 * which a call to the account is built against.
 */
export interface AccountSeen {
  /** The account's state, serialized, and the chain's parameters, serialized, as of one block. */
  readonly state: Uint8Array;
  readonly parameters: Uint8Array;
  /** Whether every circuit of the creation's second step is on the account: the account is finished. */
  readonly finished: boolean;
}

export interface CreationChain {
  /** Whether the chain holds a contract at `account`, and the newest block's time in milliseconds. */
  presence(account: string): Promise<{ readonly held: boolean; readonly blockTime: number }>;
  /** The account as one block saw it, or null when the chain holds none there. */
  account(account: string): Promise<AccountSeen | null>;
}

/** The chain as this wallet's own indexer answers it. */
export function liveCreationChain(indexer = { indexerUri: INDEXER_HTTP_URL, indexerWsUri: INDEXER_WS_URL }): CreationChain {
  let reader: ReturnType<typeof publicDataProviderFor> | null = null;
  return {
    presence: async (account) => {
      const seen = await accountPresenceAt(indexer.indexerUri, account);
      return { held: seen.held, blockTime: seen.blockTime };
    },
    account: async (account) => {
      reader ??= publicDataProviderFor(indexer);
      const r = await reader;
      const block = await r.queryBlock();
      if (block === null) return null;
      const read = await r.queryZSwapAndContractState(account, { type: 'blockHash', blockHash: block.hash } as never);
      if (read === null || read === undefined) return null;
      const [, state, parameters] = read as unknown as [unknown, { serialize(): Uint8Array }, { serialize(): Uint8Array }];
      return { state: state.serialize(), parameters: parameters.serialize(), finished: secondStepIsOn(state, account) };
    },
  };
}

/** Whether every circuit the second step inserts is on the account's state. */
export function secondStepIsOn(state: unknown, account: string): boolean {
  const read = operationsFromContractState(state, account);
  if (read.state !== 'read') return false;
  const names = new Set(read.operations.map((o) => o.name));
  return CREATION_STEPS.second.every((c) => names.has(c));
}
