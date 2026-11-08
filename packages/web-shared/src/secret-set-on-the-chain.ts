/**
 * **WHEN THE VAULT'S SECRET WAS SET, AS THE CHAIN'S OWN HISTORY SHOWS IT.** Read in the vault worker from the vault's
 * and its account's history at the indexer the person's own wallet names: the step that first put the vault's current
 * commitment in its state, and the account's removal count before that step's block, lowered to the count the run that
 * set it was raised at, read from the setting block itself. Every signer who could hold the secret was
 * seated when that run was raised, or given it later. Nothing here is read from the company's records or its service.
 */
import type { ContractHistoryEntry } from '../../../src/midnight/contract-history.js';
import { removalsSoFar, type AccountLedgerForAStart } from '../../../src/midnight/vault-start.js';

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The account's state as read here: its removal count and every open proposal's hold, which can be listed. */
export type AccountHolds = Pick<AccountLedgerForAStart, 'proposalHolds'> & {
  readonly proposalHolds: Iterable<[Uint8Array, { readonly removals: bigint }]>;
};

/**
 * **THE ACCOUNT'S REMOVAL COUNT BEFORE THE BLOCK THAT SET THE VAULT'S SECRET `commitment`.** The setting step is the
 * vault's first that succeeded with `commitment` in its state; a secret is never set twice. The count is the one in the
 * account's last succeeded step in an earlier block, lowered to the count any proposal closed in the setting block was
 * raised at: the run that set the secret is one, and a signer removed between its raise and its setting was sealed it.
 * Every value taken can only lower the count. Refuses when either history does not reach that far, or the account's
 * shows no step in the setting block, so no answer rests on a history that has not caught up.
 */
export function removalsWhenTheSecretWasSet(
  read: {
    readonly vault: (state: Uint8Array) => { readonly nonceCommitment: Uint8Array };
    readonly account: (state: Uint8Array) => AccountHolds;
    /** The account's function for where it keeps its removal count; absent on a page that cannot read it. */
    readonly removalCountKey?: () => Uint8Array;
  },
  steps: { readonly vault: readonly ContractHistoryEntry[]; readonly account: readonly ContractHistoryEntry[] },
  commitment: string,
): number {
  const key = read.removalCountKey;
  if (typeof key !== 'function') throw new Error('this device was not given the account\'s function for where it keeps its removal count. Reload the page.');
  const wanted = commitment.toLowerCase();
  const set = steps.vault.find((s) => s.succeeded && hex(read.vault(s.state).nonceCommitment) === wanted);
  if (set === undefined) {
    throw new Error('the vault\'s history at the indexer your wallet names does not yet show its secret being set. Try again shortly.');
  }
  const before = steps.account.filter((s) => s.succeeded && s.block.height < set.block.height).at(-1);
  if (before === undefined) {
    throw new Error('the account\'s history at the indexer your wallet names does not reach back to when the vault\'s secret was set. Try again shortly.');
  }
  const was = read.account(before.state);
  const after = steps.account.filter((s) => s.succeeded && s.block.height === set.block.height).at(-1);
  if (after === undefined) {
    throw new Error('the account\'s history at the indexer your wallet names does not show the block the vault\'s secret was set in, so who was seated then was not read. Try again shortly.');
  }
  const still = new Set([...read.account(after.state).proposalHolds].map(([k]) => hex(k)));
  const closed = [...was.proposalHolds].filter(([k]) => !still.has(hex(k))).map(([, h]) => h.removals);
  return Number([removalsSoFar({ removalCountKey: key }, was), ...closed].reduce((a, b) => (b < a ? b : a)));
}
