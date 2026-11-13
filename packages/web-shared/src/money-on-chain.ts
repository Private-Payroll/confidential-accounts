/**
 * **WHAT A VAULT HOLDS ON THE CHAIN, SIDE BY SIDE**, read off one chain read of it: the one reading the retire refuses
 * on and the page keeps a retired vault listed on. Kept apart from the chain's readers (`vault-on-chain-here.ts`, which
 * re-exports it), so a page that only judges a read does not load the code that reads.
 */
import type { VaultOnChainOnTheWire } from './vault-worker-client.js';

/** One side of what a vault holds on the chain: nothing, something, or not read. */
export const ON_CHAIN = { none: 'none', holds: 'holds', unread: 'unread' } as const;
type OnChainSide = (typeof ON_CHAIN)[keyof typeof ON_CHAIN];

/** What a vault's chain read shows it holding, side by side: its notes, and its public balances. */
export interface MoneyOnChain { readonly notes: OnChainSide; readonly public: OnChainSide }

/** A public amount above nothing: anything but a run of zeros counts as held, so an amount written another way is never read as empty. */
const heldAmount = (amount: string): boolean => !/^0+$/u.test(amount);

/**
 * **WHETHER A VAULT'S CHAIN READ SHOWS MONEY**, the one reading of it: a vault the chain does not show, or a side the
 * read did not give, is unread, never empty. The retire refuses on it and the page keeps a retired vault listed on it.
 */
export function moneyOnChainOf(read: VaultOnChainOnTheWire): MoneyOnChain {
  if (!read.onChain) return { notes: ON_CHAIN.unread, public: ON_CHAIN.unread };
  return {
    notes: read.notes === undefined ? ON_CHAIN.unread : read.notes.length === 0 ? ON_CHAIN.none : ON_CHAIN.holds,
    public: read.publicBalances === undefined ? ON_CHAIN.unread
      : read.publicBalances.some((b) => heldAmount(b.amount)) ? ON_CHAIN.holds : ON_CHAIN.none,
  };
}
