/**
 * **A CONTRACT'S STATE AS THE INDEXER SERVES IT, DECODED BY THE CALLER'S OWN RUNTIME.** The reader serves the bytes
 * with the ledger era that wrote them and hands out nothing decoded. This build reads the ledger 9 era, so the decoder
 * is given for that era alone, and a state of any other era is refused by the decode, never read as something else.
 *
 * Every read of a served state decodes here, each side with the `ContractState` it already runs: the contract
 * runtime's where the compiled contracts read the state (`contract-state-at.ts`), the ledger's in the wallet, which
 * reads every state with the ledger it signs with. Only types are imported, so the wallet, the vault worker, the
 * service and the scripts can all load it.
 */
import type { SerializedContractState, StateDecoder } from '@midnight-ntwrk/midnight-js-types';

export const decodedState = <T>(served: SerializedContractState, decoder: StateDecoder<T>): T =>
  served.deserialize({ v9: decoder });
