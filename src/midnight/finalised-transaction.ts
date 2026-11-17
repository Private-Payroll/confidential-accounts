/**
 * A finalised transaction read back from its bytes with the ledger's own decoder, whatever carried it: the wallet
 * SDK's sealed handle, or a ledger transaction. The fee ceiling and the transaction's hash are read from what this
 * answers. Bytes the ledger cannot read as a finalised transaction answer null, which every caller refuses rather
 * than reading as zero.
 */
import { Transaction, type FinalizedTransaction } from '@midnightntwrk/ledger-v9';
import type { Serializable } from './providers.js';

/**
 * The finalised ledger transaction `tx` is or carries, or null when it is neither. A ledger transaction is read as it
 * is; a sealed handle, which hides its transaction, is read from its bytes.
 */
export const finalisedTransactionOf = (tx: unknown): FinalizedTransaction | null => {
  if (tx instanceof Transaction) return tx as FinalizedTransaction;
  const serialize = (tx as Partial<Serializable> | null | undefined)?.serialize;
  if (typeof serialize !== 'function') return null;
  try {
    return Transaction.deserialize('signature', 'proof', 'binding', serialize.call(tx));
  } catch {
    return null; // not a finalised transaction: the caller refuses null
  }
};
