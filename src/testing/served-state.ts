/**
 * What a test's stand-in indexer and private-state store answer, in the shapes the SDK's providers use: a
 * contract state served as bytes the caller decodes (either decoding to the state the test holds, or the real
 * bytes a ledger wrote), a private-state store opened per contract, and the transaction settings a provider
 * bundle carries.
 */
import * as L from '@midnightntwrk/ledger-v9';
import {
  SerializedContractState, SerializedLedgerParameters, SerializedZswapChainState,
} from '@midnight-ntwrk/midnight-js-types';

/** The transaction settings a test's provider bundle carries, as `midnightProviders` builds them. */
export const TEST_SETTINGS = { networkId: 'undeployed', ttlSeconds: 1800 } as const;

/** A contract address in the form the SDK accepts: 32 bytes of hex, distinct per `n`. */
export const testAddress = (n: number): string => n.toString(16).padStart(64, '0');

/** `state` as the indexer serves it: decoding it answers `state`; no state is served as null. */
export const served = (state: unknown) => (state === null || state === undefined ? null : {
  protocolVersion: 0,
  contractState: {
    era: 'v9',
    deserialize: () => state,
    serialize: (): Uint8Array => {
      const own = (state as { serialize?: () => Uint8Array }).serialize;
      return typeof own === 'function' ? own.call(state) : new Uint8Array();
    },
  },
  ledgerParameters: { era: 'v9', serialize: () => new Uint8Array() },
});

/**
 * A contract's state as the indexer serves it for one block, from the bytes the ledger wrote: the state, an empty
 * commitment tree and the chain's initial parameters, each decoded by the SDK itself.
 */
export const servedBytes = (contract: Uint8Array) => ({
  protocolVersion: V9_HEAD,
  contractState: SerializedContractState.fromBytes('v9', contract),
  zswapChainState: SerializedZswapChainState.fromBytes('v9', new L.ZswapChainState().serialize()),
  ledgerParameters: SerializedLedgerParameters.fromBytes('v9', L.LedgerParameters.initialParameters().serialize()),
});

/**
 * A private-state store the SDK opens per contract, over a test's flat store. Each opening is reported to
 * `opened` with the address, so a test can see which contract a read or write was made under.
 */
export const perContract = <S extends object>(store: S, opened: (address: string) => void = () => {}) => ({
  ...store,
  forContract: (address: string) => { opened(address); return store; },
});

/** The protocol version a ledger 9 network reports (node 2.1.101), which the SDK reads to pick the ledger. */
export const V9_HEAD = 2_001_101;

/** A provider bundle with nothing in it but its settings and a network head on ledger 9. */
export const onLedger9 = () => ({
  config: TEST_SETTINGS,
  publicDataProvider: { queryLatestProtocolVersion: async () => V9_HEAD },
});
