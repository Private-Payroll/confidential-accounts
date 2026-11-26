import { ContractState } from '@midnightntwrk/ledger-v9';
import { operationsFromContractState, releasedVersionOf } from 'midnight-identity/profile/contract-keys';
import { RELEASED_VERSIONS, type ReleasedContract, type ReleasedVersion } from 'midnight-identity/wallet/released-versions';

/** What a read of one contract's verifier keys came to, and nothing about whether the company is real. */
export type PublishedBuild =
  | { readonly of: 'published'; readonly version: number }
  | { readonly of: 'not-published' }
  | { readonly of: 'unchecked' };

/** Reads one address's contract state as hex, or null when the chain holds nothing there. */
export type StateReader = (address: string) => Promise<string | null>;

/** The bytes a hex string spells. */
export const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

/** The contract state a hex string holds, or null when it is not one. */
export function contractStateOfHex(hex: string): ContractState | null {
  try {
    return ContractState.deserialize(bytesOf(hex));
  } catch {
    // Bytes that are not a contract state cannot be judged, so the caller treats them as unchecked.
    return null;
  }
}

/**
 * The published version a contract's keys are, judged by the one matcher: every circuit, in every key slot, against
 * each released version. A state whose keys cannot be read is `unchecked`, never either verdict.
 */
export function publishedBuildOfState(
  state: unknown, address: string, contract: ReleasedContract, versions: readonly ReleasedVersion[] = RELEASED_VERSIONS,
): PublishedBuild {
  const read = operationsFromContractState(state, address);
  if (read.state !== 'read') return { of: 'unchecked' };
  const answer = releasedVersionOf(read, contract, versions);
  return answer.released ? { of: 'published', version: answer.version } : { of: 'not-published' };
}

/** The same judgment for the contract at an address, reading its state through `read`. */
export async function publishedBuildAt(
  read: StateReader, address: string, contract: ReleasedContract, versions: readonly ReleasedVersion[] = RELEASED_VERSIONS,
): Promise<PublishedBuild> {
  let hex: string | null;
  try {
    hex = await read(address);
  } catch {
    // A read that did not come back says nothing about the keys, so the answer is "unchecked".
    return { of: 'unchecked' };
  }
  if (hex === null) return { of: 'unchecked' };
  const state = contractStateOfHex(hex);
  if (state === null) return { of: 'unchecked' };
  return publishedBuildOfState(state, address, contract, versions);
}
