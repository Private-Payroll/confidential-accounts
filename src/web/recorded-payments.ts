/**
 * **WHICH OF A PAYEE'S OWN PAYMENTS A COMPANY'S ACCOUNT RECORDS AS MADE, READ
 * FROM THE CONTRACT ON THIS DEVICE.**
 *
 * Runs on the payslip reader's worker thread and nowhere else: it reaches the
 * indexer reader and the contract's own decoder, which are WebAssembly, and
 * `public-data.ts` says why nothing the page loads may import either.
 *
 * What is asked of the indexer is the company's contract state, by its
 * address, and nothing else. The values looked for in it were built on this
 * device and are tested here, so no request names a payment or a person. The
 * indexer does see that this device asked about that company's contract.
 */
import type { Hex } from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';

/** What this reads the contract's state through. `public-data.ts` builds one. */
export interface ContractStateSource {
  queryContractState(address: string): Promise<unknown>;
}

/** The contract's own decoder for its public state. */
export type ReadLedger = (data: unknown) => unknown;

const HEX32 = /^[0-9a-f]{64}$/u;

/**
 * For each value asked about, whether the account's public set of completed
 * payments holds it, in the order asked. `null` whenever that could not be
 * read: no state for that address, a state that does not decode, or a set that
 * is not there. A read that failed is never an answer of "not recorded".
 */
export async function recordedAt(
  source: ContractStateSource, readLedger: ReadLedger, company: string, movements: readonly Hex[],
): Promise<boolean[] | null> {
  const address = company.toLowerCase();
  if (!HEX32.test(address) || movements.some(m => !HEX32.test(m.toLowerCase()))) return null;
  try {
    const state = await source.queryContractState(address) as { data?: unknown } | null | undefined;
    if (state === null || state === undefined || state.data === undefined) return null;
    const set = (readLedger(state.data) as { movements?: { member?: unknown } } | null)?.movements;
    if (set === null || set === undefined || typeof set.member !== 'function') return null;
    const member = set.member.bind(set) as (value: Uint8Array) => unknown;
    return movements.map(m => member(fromHex(m.toLowerCase())) === true);
  } catch {
    return null;
  }
}
