/**
 * A contract's state as the indexer serves it, decoded with this build's own runtime so the compiled contracts
 * can read it. The indexer serves bytes tagged with the ledger version that wrote them; a state written by a
 * ledger version this build has no decoder for is refused by the decode, never read as something else. No state
 * at the address answers null, which the caller reads as "nothing deployed here", never as an empty contract.
 */
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import {
  asContractAddress,
  type PublicDataProvider,
  type SerializedContractState,
} from '@midnight-ntwrk/midnight-js-types';
import { decodedState } from './decoded-state.js';

/** Which block to read at, as the indexer takes it; the newest when left out. */
export type ReadAt = Parameters<PublicDataProvider['queryContractState']>[1];

/** The served bytes of the contract's state at `address`, or null when nothing is deployed there. */
export const servedContractStateAt = async (
  publicData: Pick<PublicDataProvider, 'queryContractState'>,
  address: string,
  at?: ReadAt,
): Promise<SerializedContractState | null> => {
  const read = await publicData.queryContractState(asContractAddress(address), at);
  return read === null ? null : read.contractState;
};

/** The contract's state at `address`, decoded, or null when nothing is deployed there. */
export const contractStateAt = async (
  publicData: Pick<PublicDataProvider, 'queryContractState'>,
  address: string,
  at?: ReadAt,
): Promise<ContractState | null> => {
  const served = await servedContractStateAt(publicData, address, at);
  return served === null ? null : decodedState(served, ContractState);
};

/**
 * A contract state from any reader, or from a deploy a device sent, read again from its bytes as this build's
 * runtime reads it, so the compiled contracts can read its `data` whichever reader made it.
 */
export const asThisRuntimeReadsIt = (state: { serialize(): Uint8Array }): ContractState =>
  ContractState.deserialize(state.serialize());
