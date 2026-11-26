import { ContractState } from '@midnightntwrk/ledger-v9';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { publicDataProviderFor } from '../../../../packages/web-shared/src/public-data.js';
import { accountAtOneBlockOver, accountPresenceAt } from './view-doors.js';
import { decodedState } from '../../../../src/midnight/decoded-state.js';
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
      const at = await accountAtOneBlockOver(await reader, account);
      if (at === null) return null;
      /* The read is the states as bytes with the era that wrote them; the circuits on the account are read decoded. */
      return {
        state: at.account.serialize(), parameters: at.parameters.serialize(),
        finished: secondStepIsOn(decodedState(at.account, ContractState)),
      };
    },
  };
}

/**
 * Whether every circuit the second step inserts is on the account's state,
 * read from the circuits' names alone. Whether their keys are this build's is
 * judged where they are signed for, so a key that cannot be read here never
 * leaves a finished creation waiting.
 */
export function secondStepIsOn(state: unknown): boolean {
  let listed: unknown;
  try {
    listed = (state as { operations?: () => unknown } | null)?.operations?.();
  } catch {
    /* A state that cannot list its circuits has not shown the second step; the next read asks again. */
    return false;
  }
  if (!Array.isArray(listed)) return false;
  const names = new Set(listed.map((n) => (n instanceof Uint8Array ? new TextDecoder().decode(n) : String(n))));
  return CREATION_STEPS.second.every((c) => names.has(c));
}
