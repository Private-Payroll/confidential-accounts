/**
 * WHAT A WALLET'S FACADE IS READ BY ON A LIVE NETWORK, KEPT APART FROM THE RUN SO EACH RULE CAN BE CHECKED WITHOUT A CHAIN.
 *
 * A part's reading is judged only from the progress the wallet SDK reports for it; a deposit's shape is built
 * from the ledger's own constructors, exactly one contract-owned shielded coin and nothing spent; and each
 * verdict says what the run showed and nothing it did not see.
 */
import type * as Ledger from '@midnightntwrk/ledger-v9';

/** What the wallet SDK reports of one part's reading. Read loosely: a part may not have reported yet. */
export interface PartProgress {
  readonly isConnected?: boolean;
  readonly appliedIndex?: bigint | number;
  readonly highestIndex?: bigint | number;
  readonly isStrictlyComplete?: () => boolean;
}

export type PartReading = 'read' | 'reading' | 'not connected' | 'no answer';

/** `read` only when the part is connected and says it has read every event; anything less is never called read. */
export const partReading = (p: PartProgress | undefined): PartReading => {
  if (p === undefined) return 'no answer';
  if (p.isConnected !== true) return 'not connected';
  return typeof p.isStrictlyComplete === 'function' && p.isStrictlyComplete() ? 'read' : 'reading';
};

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** One line of a part's progress, as a run prints it every few seconds. */
export const progressLine = (part: string, p: PartProgress | undefined, sinceMs: number): string =>
  `${part}: ${partReading(p)}, event ${String(p?.appliedIndex ?? '-')} of ${String(p?.highestIndex ?? '-')}, ${seconds(sinceMs)}`;

/** The ledger constructors the deposit's shape is built from; the ledger package itself on a network. */
export interface LedgerForTheShape {
  readonly createShieldedCoinInfo: typeof Ledger.createShieldedCoinInfo;
  readonly sampleContractAddress: typeof Ledger.sampleContractAddress;
  readonly ZswapOutput: Pick<typeof Ledger.ZswapOutput, 'newContractOwned'>;
  readonly ZswapOffer: Pick<typeof Ledger.ZswapOffer, 'fromOutput'>;
  readonly Transaction: Pick<typeof Ledger.Transaction, 'fromParts'>;
}

/**
 * A transaction shaped as a private deposit is before the wallet pays it: one shielded coin of `token` owned by a
 * contract, created in the guaranteed part, and nothing spent. Balancing it is what a deposit asks of the wallet.
 * The contract is a sample address: balancing reads the wallet's own coins and never the contract.
 */
export function depositShaped(ledger: LedgerForTheShape, networkId: string, token: string, value: bigint): unknown {
  if (value <= 0n) throw new Error('a deposit carries a positive amount; this one carries none.');
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error(`"${token}" is not a token colour (64 hex characters).`);
  const coin = ledger.createShieldedCoinInfo(token, value);
  const output = ledger.ZswapOutput.newContractOwned(coin, 0, ledger.sampleContractAddress());
  return ledger.Transaction.fromParts(networkId, ledger.ZswapOffer.fromOutput(output, token, value));
}

export type PartName = 'shielded' | 'unshielded' | 'dust';

export interface PartSeen {
  readonly reading: PartReading;
  /** Milliseconds from the start until the part said it had read everything; `null` when it never did. */
  readonly readInMs: number | null;
  /** The last failure the part reported, in its own words; `null` when it reported none. */
  readonly failed: string | null;
}

/** What a balancing added, counted over every transaction its recipe holds. */
export interface BalancingCounts {
  readonly transactions: number;
  /** Private offers: the guaranteed one and every fallible one. */
  readonly offers: number;
  readonly coinsSpent: number;
  readonly coinsMade: number;
  readonly dustSpends: number;
  /** Entries that are not a ledger transaction (a sealed wallet handle, say), so nothing of them was counted. */
  readonly unread: number;
}

interface OfferLike { readonly inputs?: readonly unknown[]; readonly outputs?: readonly unknown[] }
interface TransactionLike {
  readonly guaranteedOffer?: OfferLike | null;
  readonly fallibleOffer?: ReadonlyMap<unknown, OfferLike> | null;
  readonly intents?: ReadonlyMap<unknown, { readonly dustActions?: { readonly spends?: readonly unknown[] } | null }> | null;
}

/** The counts of a recipe's transactions, read off the ledger's own fields; a field a transaction lacks counts nothing. */
export function balancingCounts(transactions: readonly unknown[]): BalancingCounts {
  let offers = 0; let coinsSpent = 0; let coinsMade = 0; let dustSpends = 0; let unread = 0;
  for (const tx of transactions as readonly (TransactionLike | null)[]) {
    if (tx === null || typeof tx !== 'object' || !('intents' in tx || 'guaranteedOffer' in tx)) { unread += 1; continue; }
    const all = [tx.guaranteedOffer, ...(tx.fallibleOffer instanceof Map ? tx.fallibleOffer.values() : [])]
      .filter((o): o is OfferLike => o !== null && o !== undefined);
    offers += all.length;
    for (const o of all) { coinsSpent += o.inputs?.length ?? 0; coinsMade += o.outputs?.length ?? 0; }
    for (const i of tx.intents instanceof Map ? tx.intents.values() : []) dustSpends += i?.dustActions?.spends?.length ?? 0;
  }
  return { transactions: transactions.length, offers, coinsSpent, coinsMade, dustSpends, unread };
}

const countsSaid = (c: BalancingCounts): string => `${c.transactions} transaction(s), ${c.offers} private offer(s): `
  + `${c.coinsSpent} of the wallet's private coins spent, ${c.coinsMade} coins made, ${c.dustSpends} DUST spends`;

/** A balancing, and whether giving its coins back worked: `gaveBack` is null when it did, or the failure's words. */
export type BalancingSeen =
  | { readonly balanced: true; readonly counts: BalancingCounts; readonly gaveBack: string | null }
  | { readonly balanced: false; readonly said: string };

/** What a balancing needs of the wallet's facade: adopt a transaction, balance it, give its coins back. */
export interface FacadeToBalance<H, R> {
  adoptTransaction(bytes: Uint8Array, kind: 'Unproven'): H;
  balanceUnprovenTransaction(handle: H, options: { ttl: Date; tokenKindsToBalance: ('shielded' | 'dust')[] }): Promise<R>;
  revert(recipe: R): Promise<unknown>;
}

/**
 * A transaction balanced with the given kinds of the wallet's money and its coins given back at once, nothing proved,
 * signed or sent: what was added, counted, and whether the giving back worked, or the wallet's refusal.
 */
export async function balancedAndGivenBack<H, R>(
  facade: FacadeToBalance<H, R>, shape: { serialize(): Uint8Array }, kinds: readonly ('shielded' | 'dust')[],
  transactionsOf: (recipe: R) => readonly unknown[], said: (e: unknown) => string,
): Promise<BalancingSeen> {
  let recipe: R;
  try {
    const handle = facade.adoptTransaction(shape.serialize(), 'Unproven');
    recipe = await facade.balanceUnprovenTransaction(handle, { ttl: new Date(Date.now() + 20 * 60_000), tokenKindsToBalance: [...kinds] });
  } catch (e) {
    return { balanced: false, said: said(e) };
  }
  let counts: BalancingCounts;
  try { counts = balancingCounts(transactionsOf(recipe)); } catch { counts = balancingCounts([null]); }
  try {
    await facade.revert(recipe);
    return { balanced: true, counts, gaveBack: null };
  } catch (e) {
    return { balanced: true, counts, gaveBack: said(e) };
  }
}

/**
 * A line with the network's project token taken out, wherever it sits (a node address in a disconnect line, an SDK
 * error, a saved report). An empty token changes nothing.
 */
export const withoutTheToken = (text: string, token: string): string =>
  (token === '' ? text : text.split(token).join('<project token>'));

export interface Seen {
  readonly first: Readonly<Record<PartName, PartSeen>>;
  readonly onLedger9: boolean;
  readonly restartedInMs: number | null;
  readonly asTheWalletPaysToday: BalancingSeen;
  readonly withItsOwnDust: BalancingSeen;
}

const partVerdict = (name: string, p: PartSeen): string => (p.reading === 'read' && p.readInMs !== null
  ? `SEEN WORKING  the ${name} part read the chain in ${seconds(p.readInMs)}.`
  : `SEEN FAILING  the ${name} part did not finish reading (${p.reading})${p.failed === null ? '' : `: ${p.failed}`}.`);

const balancingVerdict = (what: string, b: BalancingSeen, paysWithDust: boolean): string => {
  if ('said' in b) return `SEEN FAILING  ${what}: ${b.said}`;
  if (b.gaveBack !== null) return `SEEN FAILING  ${what}: balanced (${countsSaid(b.counts)}), but giving the coins back failed: ${b.gaveBack}`;
  if (b.counts.unread > 0 || b.counts.transactions === 0) {
    return `NOT SEEN      ${what}: balanced and every coin given back, but what the balancing added could not be read, `
      + 'so what it spent was not shown.';
  }
  if (paysWithDust && b.counts.dustSpends === 0) {
    return `NOT SEEN      ${what}: balanced (${countsSaid(b.counts)}) and every coin given back, but no DUST was spent, `
      + 'so the wallet paying its own fee was not shown.';
  }
  return `SEEN WORKING  ${what}: balanced (${countsSaid(b.counts)}); every coin given back.`;
};

/** The run's findings, one line each, in the order a run reports them. */
export function verdicts(s: Seen): string[] {
  return [
    partVerdict('private (shielded)', s.first.shielded),
    partVerdict('public (unshielded)', s.first.unshielded),
    partVerdict('DUST', s.first.dust),
    s.onLedger9
      ? 'SEEN WORKING  the wallet learned the chain is on ledger 9 and acts for it.'
      : 'SEEN FAILING  the wallet never learned the chain is on ledger 9, so it would pay nothing.',
    s.restartedInMs === null
      ? 'NOT SEEN      the private part was not restarted from its saved state.'
      : `SEEN          the private part, restarted from its saved state, read the chain again in ${seconds(s.restartedInMs)}.`,
    balancingVerdict('a deposit balanced as the wallet pays one today (the fee left to the fee payer)', s.asTheWalletPaysToday, false),
    balancingVerdict('a deposit balanced with the wallet\'s own DUST paying the fee', s.withItsOwnDust, true),
  ];
}
