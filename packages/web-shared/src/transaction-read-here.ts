/**
 * **WHAT A TRANSACTION SAYS OF ITSELF, READ FROM ITS OWN BYTES**: its identifiers, its time to live, and the
 * public deposits and coins it carries for a contract, with nothing taken from whoever handed it over.
 */
import type { CallAsBuilt } from '../../../src/midnight/note-index.js';
import {
  PUBLIC_DEPOSIT_ENTRY,
  type PublicDepositCallRefusal,
  publicTakesOfTranscript,
  readPublicDepositCall
} from './public-deposit-call.js';
import { hex, type VaultBuilderDeps } from './vault-builder.js';

/** What a transaction says of itself, read from its own bytes, with nothing taken from whoever handed them over. */
export interface TransactionRead {
  /** Every identifier the chain can be asked about it by. Binding it and merging a fee into it leave each one as it was. */
  readonly identifiers: readonly string[];
  /** The earliest time to live across its intents (milliseconds since the epoch): after it the transaction can no longer land. Null when an intent carries none this can read. */
  readonly timeToLive: number | null;
  /** Every contract call it makes. A deploy is not a call and is not listed. */
  readonly calls: readonly CallAsBuilt[];
  /**
   * Every private coin it creates for a contract, in either part: as an output, which the contract then holds, or
   * marked `madeAndSpent` when it is made and spent inside the transaction, so the contract never holds it. A coin it
   * creates for a person (the wallet's own change) is not listed. Null when an offer cannot be read, so an unread offer
   * is never taken for one that creates nothing.
   */
  readonly coinsForContracts?: readonly CoinForAContract[] | null;
  /**
   * Every public token each call takes in, as its proven transcripts state it. Null when a call's transcript cannot be
   * read, so an unread call is never taken for one that takes nothing.
   */
  readonly publicTakes?: readonly PublicTake[] | null;
  /** Every call it makes to a vault's public deposit, each with what it puts in or why it is no such call (`readPublicDepositCall`). */
  readonly publicDeposits?: readonly PublicDepositInTransaction[];
}

/** One call to a vault's public deposit in a transaction: the vault (as `CallAsBuilt` names it) and the ledger colour (lower-case hex) and amount (base units, decimal) it puts in, or why it is no such call. */
type PublicDepositInTransaction =
  | { readonly vault: string; readonly colour: string; readonly amount: string }
  | { readonly vault: string; readonly refused: PublicDepositCallRefusal };

/** A private coin a transaction creates for a contract: the contract (lower-case hex without a prefix) and the coin's commitment as the ledger records it (lower-case hex); `madeAndSpent` when it is spent in the same transaction. */
interface CoinForAContract {
  readonly contract: string;
  readonly commitment: string;
  readonly madeAndSpent?: true;
}

/** A public token one call takes in: the contract and circuit taking it (as `CallAsBuilt` names them), the ledger colour (lower-case hex) and the amount (base units, decimal). */
interface PublicTake {
  readonly address: string;
  readonly entryPoint: string;
  readonly colour: string;
  readonly amount: string;
}

const bareHex = (v: unknown): string => String(v).toLowerCase().replace(/^0x/u, '');

/** The coins an offer creates for a contract, or null when the offer cannot be read. */
const coinsForContractsIn = (offer: unknown): CoinForAContract[] | null => {
  if (offer === undefined || offer === null) return [];
  const o = offer as { outputs?: unknown; transients?: unknown };
  const found: CoinForAContract[] = [];
  for (const [list, madeAndSpent] of [
    [o.outputs, false],
    [o.transients, true]
  ] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return null;
    for (const coin of list as Array<{ contractAddress?: unknown; commitment?: unknown } | null>) {
      if (coin === null || typeof coin !== 'object') return null;
      if (coin.contractAddress === undefined || coin.contractAddress === null) continue;
      if (typeof coin.commitment !== 'string' && !(coin.commitment instanceof Uint8Array)) return null;
      found.push({
        contract: bareHex(coin.contractAddress),
        commitment: coin.commitment instanceof Uint8Array ? hex(coin.commitment) : bareHex(coin.commitment),
        ...(madeAndSpent ? { madeAndSpent: true as const } : {})
      });
    }
  }
  return found;
};

/** The public tokens one call's transcripts take in, or null when a transcript cannot be read. */
const publicTakesOf = (
  address: string,
  entryPoint: string,
  action: { guaranteedTranscript?: unknown; fallibleTranscript?: unknown }
): PublicTake[] | null => {
  const takes: PublicTake[] = [];
  for (const transcript of [action.guaranteedTranscript, action.fallibleTranscript]) {
    if (transcript === undefined || transcript === null) continue;
    const read = publicTakesOfTranscript(transcript);
    if (typeof read === 'string') return null;
    for (const take of read) takes.push({ address, entryPoint, colour: take.colour, amount: take.value.toString() });
  }
  return takes;
};

/**
 * **A TRANSACTION, READ FROM ITS BYTES**: as finished and bound, or proved and not yet bound. Null when it is neither,
 * so bytes this cannot read are never taken for a transaction that has run out or that names nothing. Every intent's
 * time to live is checked by the chain, so the earliest is the one that ends when the transaction can land.
 */
export function readTransaction(deps: Pick<VaultBuilderDeps, 'ledger'>, bytes: Uint8Array): TransactionRead | null {
  let tx: { intents?: unknown; identifiers?: () => unknown };
  try {
    tx = deps.ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes);
  } catch {
    try {
      tx = deps.ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
    } catch {
      return null;
    }
  }
  let identifiers: string[];
  try {
    const listed = typeof tx?.identifiers === 'function' ? tx.identifiers() : [];
    identifiers = Array.isArray(listed) ? listed.map(String) : [];
  } catch {
    return null;
  }
  const intents = tx?.intents instanceof Map ? ([...tx.intents.entries()] as Array<[unknown, any]>) : [];
  let timeToLive: number | null = intents.length === 0 ? null : Number.POSITIVE_INFINITY;
  const calls: CallAsBuilt[] = [];
  let publicTakes: PublicTake[] | null = [];
  const publicDeposits: PublicDepositInTransaction[] = [];
  for (const [segment, intent] of intents) {
    const ttl: unknown = intent?.ttl;
    if (!(ttl instanceof Date) || !Number.isFinite(ttl.getTime())) timeToLive = null;
    else if (timeToLive !== null) timeToLive = Math.min(timeToLive, ttl.getTime());
    for (const action of Array.isArray(intent?.actions) ? intent.actions : []) {
      if (action?.entryPoint === undefined || action?.address === undefined) continue;
      const parts: number[] = [];
      if (action.guaranteedTranscript !== undefined && action.guaranteedTranscript !== null) parts.push(0);
      if (action.fallibleTranscript !== undefined && action.fallibleTranscript !== null) parts.push(Number(segment));
      const address = String(action.address).toLowerCase().replace(/^0x/u, '');
      const entryPoint =
        action.entryPoint instanceof Uint8Array
          ? new TextDecoder().decode(action.entryPoint)
          : String(action.entryPoint);
      calls.push({ address, entryPoint, segments: parts });
      const takes = publicTakesOf(address, entryPoint, action);
      publicTakes = publicTakes === null || takes === null ? null : [...publicTakes, ...takes];
      if (entryPoint === PUBLIC_DEPOSIT_ENTRY) {
        const deposit = readPublicDepositCall(action, address);
        publicDeposits.push(
          'refused' in deposit
            ? { vault: address, refused: deposit.refused }
            : { vault: address, colour: deposit.colour, amount: deposit.amount.toString() }
        );
      }
    }
  }
  const offers = tx as { guaranteedOffer?: unknown; fallibleOffer?: unknown };
  let coinsForContracts: CoinForAContract[] | null = coinsForContractsIn(offers.guaranteedOffer);
  if (offers.fallibleOffer !== undefined && offers.fallibleOffer !== null) {
    if (!(offers.fallibleOffer instanceof Map)) coinsForContracts = null;
    else {
      for (const offer of offers.fallibleOffer.values()) {
        const more = coinsForContractsIn(offer);
        coinsForContracts = coinsForContracts === null || more === null ? null : [...coinsForContracts, ...more];
      }
    }
  }
  return { identifiers, timeToLive, calls, coinsForContracts, publicTakes, publicDeposits };
}

/**
 * **THE NEWEST TIME TO LIVE OF TRANSACTIONS KEPT** (milliseconds since the epoch): the moment after which the last of
 * them can no longer land, each one's own being its earliest intent's (`readTransaction`). Null when there are none or
 * any one cannot be read, so a transaction this cannot read is never taken for one that has run out.
 */
export function newestTimeToLive(
  deps: Pick<VaultBuilderDeps, 'ledger'>,
  transactions: readonly Uint8Array[]
): number | null {
  let newest: number | null = null;
  for (const bytes of transactions) {
    const ttl = readTransaction(deps, bytes)?.timeToLive ?? null;
    if (ttl === null) return null;
    newest = newest === null ? ttl : Math.max(newest, ttl);
  }
  return newest;
}
