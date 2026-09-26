import type { Hex } from '../core/crypto.js';

/**
 * **WHAT A CONTRACT HOLDS IN PUBLIC MONEY, READ OFF ITS STATE AS IT IS NOW.**
 *
 * A contract's public balance is `ContractState.balance`: the ledger's own
 * figure, per token, kept inside the contract's state and serialised with it.
 * So the state the indexer serves for a contract's latest action carries the
 * balance as that action left it, and a later deposit or payment shows as soon
 * as its state does.
 *
 * **WHY NOT THE INDEXER'S BALANCE QUERY.** The indexer client's
 * `queryUnshieldedBalances` asks, for a contract whose latest action is a
 * call, for the balances of the contract's DEPLOY rather than of the call. A
 * vault is deployed empty and funded by calls, so that answer is the vault as
 * it was the day it was made. No balance this product acts on or shows is
 * read from it.
 *
 * **ONE READER.** Every place that needs a vault's public balance reads it
 * through `publicHoldingsOf`, over the state of the contract's latest action: the vault
 * client does, and the company's service does for the page. A second spelling
 * of this walk is a second chance to disagree about money.
 *
 * **ZERO IS AN ANSWER AND ABSENCE IS NOT.** A balance map that was read and
 * does not name a token says the contract holds none of it. A state with no
 * balance map, or one with an entry this reader cannot read, is refused with
 * `PublicBalanceUnreadable`, because skipping an entry would understate a
 * treasury and a missing map is not an empty one.
 *
 * This module imports nothing that runs, so a page can hold it.
 */

/** One public token a contract holds, and how much of it in its smallest unit. */
export interface PublicHolding {
  /** The token's colour, 64 lower-case hex characters with no prefix. */
  readonly token: Hex;
  readonly amount: bigint;
}

/** The state was read and its public balance could not be. Never a zero. */
export class PublicBalanceUnreadable extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'PublicBalanceUnreadable';
  }
}

const COLOUR = /^[0-9a-f]{64}$/u;

/** A colour as the chain spells it, so a comparison cannot fail on case or a prefix. */
export const bareColour = (t: string): string =>
  (t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t).toLowerCase();

/**
 * **EVERY PUBLIC TOKEN THE STATE SAYS THE CONTRACT HOLDS**, sorted by colour,
 * one row per colour. The entries that are not public tokens - the fee token,
 * and any private colour a ledger version keeps here - are passed over by name,
 * not by failing to recognise them.
 */
export function publicHoldingsOf(state: unknown): PublicHolding[] {
  const balance = (state as { balance?: unknown } | null | undefined)?.balance;
  if (!(balance instanceof Map)) {
    throw new PublicBalanceUnreadable(
      'the contract\'s state was read and carries no balance this client can read, so what it holds in public '
      + 'money is not known. That does not mean it is empty');
  }
  const held = new Map<Hex, bigint>();
  for (const [key, amount] of balance as Map<unknown, unknown>) {
    const tag = (key as { tag?: unknown } | null)?.tag;
    if (tag === 'dust' || tag === 'shielded') continue;
    const raw = (key as { raw?: unknown } | null)?.raw;
    if (tag !== 'unshielded' || typeof raw !== 'string' || !COLOUR.test(bareColour(raw))
      || typeof amount !== 'bigint' || amount < 0n) {
      throw new PublicBalanceUnreadable(
        'one entry of the contract\'s balance is not a public token and an amount this client can read. '
        + 'Skipping it would understate what the contract holds, so nothing is answered');
    }
    const colour = bareColour(raw) as Hex;
    held.set(colour, (held.get(colour) ?? 0n) + amount);
  }
  return [...held]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([token, amount]) => ({ token, amount }));
}

/** How much of one public token the holdings name: zero when they do not name it. */
export function heldOf(holdings: readonly PublicHolding[], token: string): bigint {
  const want = bareColour(token);
  return holdings.filter((h) => h.token === want).reduce((a, h) => a + h.amount, 0n);
}
