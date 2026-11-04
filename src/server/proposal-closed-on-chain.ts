/**
 * How the chain closed a company's proposal, read by this service from the account's own history at its indexer:
 * carried out, withdrawn, or still open or never held. The account's states are read with the account's own
 * functions (`roundsOnChainIn`, the same reader a signer's device uses), so the service's record of a proposal closed
 * straight on the chain follows the chain, never a device's word.
 */
import { roundsOnChainIn, type RoundOnChain } from '../../packages/web-shared/src/governed-call-builder.js';
import type { ContractHistoryEntry } from '../midnight/contract-history.js';

/** How a proposal stands on the chain, as far as closing its record goes. */
export type ClosedOnChain = 'carried' | 'withdrawn' | 'open' | 'never' | 'unknown';

/** The account's functions and the reads of the chain the answer is worked out from. */
export interface ClosedOnChainDeps {
  readonly accountPure: unknown;
  readonly accountLedger: (data: unknown) => unknown;
  readonly runtimeState: unknown;
  readonly ledger: unknown;
  readonly history: (account: string) => Promise<readonly ContractHistoryEntry[]>;
}

/**
 * How the chain closed the proposal `chainId` on `account`: `carried` when the calls that closed it carried it
 * out, `withdrawn` when the only call that closed it was a withdrawal, `unknown` when they cannot be told apart or
 * the history could not be read, and `open` or `never` when the chain does not show it closed.
 */
export async function closedOnChain(deps: ClosedOnChainDeps, account: string, chainId: string): Promise<ClosedOnChain> {
  let read: RoundOnChain | undefined;
  try {
    const steps = await deps.history(account);
    read = roundsOnChainIn(deps as never, steps, [chainId], undefined, account).get(chainId.toLowerCase());
  } catch {
    return 'unknown';
  }
  if (read === undefined) return 'unknown';
  if (read.held === 'never') return 'never';
  if (read.held !== 'closed') return 'open';
  const by = read.closedBy ?? [];
  if (by.length === 0) return 'unknown';
  if (by.every((c) => c === 'cancel')) return 'withdrawn';
  return by.includes('cancel') ? 'unknown' : 'carried';
}
