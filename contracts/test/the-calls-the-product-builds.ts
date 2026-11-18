/*
 * The contract calls and deploys a test builds, made the one way the product
 * makes them: Midnight.js's builders wrapped by `contractCallsOf`, with the
 * network's transaction settings and the account's module for a vault's call
 * into it. A test that needs the builder to hand back what the ledger never
 * would passes its own stand-in for one Midnight.js builder; everything else
 * is the real package.
 */
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as midnightContracts from '@midnight-ntwrk/midnight-js-contracts';
import * as types from '@midnight-ntwrk/midnight-js-types';
import { contractCallsOf, type ContractCalls } from '../../packages/web-shared/src/contract-call-built.js';
import { transactionSettingsFor } from '../../src/midnight/providers.js';
import { accountModuleFor } from '../../src/midnight/contract-modules.js';

type Midnight = typeof midnightContracts;

/** The product's call and deploy builders over the Midnight.js package given, whole. */
export const callsBuiltBy = (sdk: unknown): ContractCalls =>
  contractCallsOf({
    contracts: sdk as Midnight,
    types,
    ledger: L,
    ContractState: runtime.ContractState,
    settingsFor: transactionSettingsFor,
    accountModuleFor,
  });

/** The product's call and deploy builders over Midnight.js, with `over` standing in for any of its builders by name. */
export const callsTheProductBuilds = (over: Partial<Record<keyof Midnight, unknown>> = {}): ContractCalls =>
  callsBuiltBy({ ...midnightContracts, ...over });

/** The bytes a call is built over: the contract's state, the commitment tree, and the chain's parameters. */
export const readFrom = (contract: { serialize(): Uint8Array }, zswap?: { serialize(): Uint8Array }) => ({
  contract: contract.serialize(),
  zswap: (zswap ?? new L.ZswapChainState()).serialize(),
  parameters: L.LedgerParameters.initialParameters().serialize(),
});
