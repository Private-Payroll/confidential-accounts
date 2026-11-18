/**
 * **A CALL IS BUILT WITH MIDNIGHT.JS FROM THE STATES THE PAGE READ, FOR THE NETWORK THE ASK NAMES, AND A VAULT CIRCUIT
 * READS ONLY ITS OWN COMPANY'S ACCOUNT.** Midnight.js's builders are stood in by ones that record what they are handed;
 * the serialized states, the ledger, the runtime, the network record and the account's module are the real ones.
 */
import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as midnightTypes from '@midnight-ntwrk/midnight-js-types';
import { contractCallsOf, SPENDS_NO_COIN, type CallMakers } from './contract-call-built.js';
import { transactionSettingsFor } from '../../../src/midnight/providers.js';
import { accountModuleFor } from '../../../src/midnight/contract-modules.js';

const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'cd'.repeat(32);
const BLOCK = 'b7'.repeat(32);
const STATE = new runtime.ContractState().serialize();
const ACCOUNT_STATE = new runtime.ContractState().serialize();
const PARAMETERS = L.LedgerParameters.initialParameters().serialize();
const ZSWAP = new L.ZswapChainState().serialize();
const unproven = () => midnightTypes.LedgerTransaction.seal('v9', 'Unproven', L.Transaction.fromParts('undeployed'));

/** Midnight.js's builders, stood in: each records what it was handed and answers as Midnight.js does. */
const recording = () => {
  const handed: Array<{ options: Record<string, unknown>; crossContract: unknown; config?: unknown }> = [];
  const contracts = {
    createUnprovenCallTxFromInitialStates: async (_zk: unknown, options: Record<string, unknown>, _epk: unknown, crossContract?: unknown) => {
      handed.push({ options, crossContract });
      return { private: { unprovenTx: unproven(), nextZswapLocalState: 'Z', nextPrivateState: options.initialPrivateState } };
    },
    createUnprovenDeployTxFromVerifierKeys: async (_zk: unknown, _cpk: unknown, options: Record<string, unknown>, _epk: unknown, config: unknown) => {
      handed.push({ options, crossContract: undefined, config });
      return {
        public: { contractAddress: VAULT, initialContractState: midnightTypes.SerializedContractState.fromBytes('v9', STATE) },
        private: { unprovenTx: unproven(), newCoins: [] },
      };
    },
  } as unknown as CallMakers['contracts'];
  const calls = contractCallsOf({
    contracts, types: midnightTypes, ledger: L, ContractState: runtime.ContractState, settingsFor: transactionSettingsFor, accountModuleFor,
  });
  return { calls, handed };
};

const asked = { compiledContract: 'C', circuitId: 'deposit', contractAddress: VAULT, coinPublicKey: 'cpk', args: [1] };

describe('a call built with Midnight.js', () => {
  it('IS BUILT ON THE BYTES THE PAGE READ, AS MIDNIGHT.JS\'S OWN STATES, WITH THE SETTINGS OF THE NETWORK THE ASK NAMES', async () => {
    const { calls, handed } = recording();
    const built = await calls.buildCall('ZK', { ...asked, network: 'preprod', read: { contract: STATE, zswap: ZSWAP, parameters: PARAMETERS } }, 'epk');
    const { options, crossContract } = handed[0]!;
    /* RED WHEN: a state is handed over as the page's bytes, or as a decoded object, rather than as Midnight.js's serialized state. */
    expect(midnightTypes.SerializedContractState.isSerializedContractState(options.initialContractState)).toBe(true);
    expect((options.initialContractState as { serialize(): Uint8Array }).serialize()).toEqual(STATE);
    expect((options.initialZswapChainState as { serialize(): Uint8Array }).serialize()).toEqual(ZSWAP);
    expect((options.ledgerParameters as { serialize(): Uint8Array }).serialize()).toEqual(PARAMETERS);
    /* RED WHEN: the call is built for a network other than the one the ask names, or for none. */
    expect(options.config).toEqual(transactionSettingsFor('preprod'));
    expect([options.circuitId, options.contractAddress, options.args]).toEqual(['deposit', VAULT, [1]]);
    /* RED WHEN: a call that asks no other contract is handed a reader for one. */
    expect(crossContract).toBeUndefined();
    /* RED WHEN: what is proved is not Midnight.js's sealed handle, or the transaction read back is not that same one. */
    expect(midnightTypes.LedgerTransaction.isLedgerTransaction(built.private.unprovenTx)).toBe(true);
    expect((built.private.transaction as { serialize(): Uint8Array }).serialize()).toEqual(built.private.unprovenTx.serialize());
  });

  it('IS GIVEN AN EMPTY COMMITMENT TREE WHERE THE CALL MOVES NO COIN', async () => {
    const { calls, handed } = recording();
    await calls.buildCall('ZK', { ...asked, network: 'undeployed', read: { contract: STATE, zswap: SPENDS_NO_COIN, parameters: PARAMETERS } }, 'epk');
    /* RED WHEN: a call that moves no coin is built on some other tree. */
    expect((handed[0]!.options.initialZswapChainState as { serialize(): Uint8Array }).serialize()).toEqual(ZSWAP);
  });

  it('IS NOT BUILT WHEN IT NAMES NEITHER THE CHAIN\'S COMMITMENT TREE NOR THAT IT SPENDS NO COIN', async () => {
    const { calls, handed } = recording();
    const unnamed = { contract: STATE, parameters: PARAMETERS } as unknown as Parameters<typeof calls.buildCall>[1]['read'];
    /* RED WHEN: a call that left its tree out is built on an empty one, where a payment's coins cannot be found. */
    await expect(calls.buildCall('ZK', { ...asked, network: 'undeployed', read: unnamed }, 'epk')).rejects.toThrow(/neither the chain's commitment tree/);
    expect(handed).toHaveLength(0);
  });

  it('A VAULT CIRCUIT THAT ASKS THE ACCOUNT READS THAT ACCOUNT ALONE, AT THE VAULT\'S OWN BLOCK, WITH ITS ONE MODULE', async () => {
    const { calls, handed } = recording();
    await calls.buildCall('ZK', {
      ...asked, circuitId: 'payout', network: 'undeployed', read: { contract: STATE, zswap: ZSWAP, parameters: PARAMETERS },
      account: { address: ACCOUNT.toUpperCase(), state: ACCOUNT_STATE, blockHash: BLOCK },
    }, 'epk');
    const cross = handed[0]!.crossContract as {
      blockHash: string; moduleProvider: runtime.ContractModuleProvider;
      publicDataProvider: { queryZSwapAndContractState(a: string, at?: unknown): Promise<midnightTypes.PublicStatesRead | null> };
    };
    expect(cross.blockHash).toBe(BLOCK);
    const read = (await cross.publicDataProvider.queryZSwapAndContractState(ACCOUNT, { type: 'blockHash', blockHash: BLOCK }))!;
    /* RED WHEN: the account's state is not the one read at the vault's block. */
    expect(read.contractState.serialize()).toEqual(ACCOUNT_STATE);
    expect(read.ledgerParameters.serialize()).toEqual(PARAMETERS);
    /* RED WHEN: any other contract, or the account at any other block, is answered: the vault would call into what the page never read. */
    expect(await cross.publicDataProvider.queryZSwapAndContractState(VAULT, { type: 'blockHash', blockHash: BLOCK })).toBeNull();
    expect(await cross.publicDataProvider.queryZSwapAndContractState(ACCOUNT, { type: 'blockHash', blockHash: 'b8'.repeat(32) })).toBeNull();
    expect(await cross.publicDataProvider.queryZSwapAndContractState(ACCOUNT, { type: 'blockHeight', blockHeight: 1 })).toBeNull();
    expect(await cross.publicDataProvider.queryZSwapAndContractState(ACCOUNT)).toBeNull();
    /* RED WHEN: a module is offered for any contract but the company's account. */
    expect(cross.moduleProvider.resolve(ACCOUNT as never)).toBeTypeOf('function');
    expect(cross.moduleProvider.resolve(VAULT as never)).toBeUndefined();
  });

  it('A DEPLOY IS BUILT WITH THE NETWORK\'S SETTINGS, AND ITS STARTING STATE AND TRANSACTION ARE READ BACK DECODED', async () => {
    const { calls, handed } = recording();
    const built = await calls.buildDeploy('ZK', 'cpk', { compiledContract: 'C', args: [] }, 'epk', 'preprod');
    /* RED WHEN: a deploy is built for another network, or for none. */
    expect(handed[0]!.config).toEqual(transactionSettingsFor('preprod'));
    expect(built.public.contractAddress).toBe(VAULT);
    /* RED WHEN: the starting state is handed on as bytes, which the one state assembly cannot read a circuit off. */
    expect(built.public.initialContractState).toBeInstanceOf(runtime.ContractState);
    expect((built.private.transaction as { serialize(): Uint8Array }).serialize()).toEqual(built.private.unprovenTx.serialize());
  });
});
