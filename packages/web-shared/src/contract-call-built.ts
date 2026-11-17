/**
 * **ONE CALL TO A CONTRACT, BUILT WITH MIDNIGHT.JS FROM THE STATES THE PAGE READ.** A builder asks for a call with
 * one block's states, each the bytes the page read at the indexer the person's own wallet names, and the network
 * the ask names. Here, and only here, they become what Midnight.js builds with: its serialized states, the settings
 * of that network from the one network record, and, for a vault circuit that asks the company account, that one
 * account read at that same block with its one compiled module. Midnight.js hands the built transaction back as its
 * own sealed handle, which is what is proved; the ledger's reading of it is handed back beside it, only to be read.
 *
 * This file names Midnight.js's types and loads none of its code: the worker hands every module in.
 */
import type { ContractModuleProvider } from '@midnight-ntwrk/compact-runtime';
import type { MidnightConfig, PublicStatesRead, UnprovenTx } from '@midnight-ntwrk/midnight-js-types';

/**
 * Said of a call that spends no coin of the chain's, in place of the chain's commitment tree. Every call names one or
 * the other, so a call that spends a coin can never be built on an empty tree because its tree was left out.
 */
export const SPENDS_NO_COIN = 'spends no coin of the chain' as const;

/** One block's states a call is built on, each the bytes the page read. */
interface CallRead {
  readonly contract: Uint8Array;
  readonly zswap: Uint8Array | typeof SPENDS_NO_COIN;
  readonly parameters: Uint8Array;
}

/** The commitment tree a call is built on: the chain's, or an empty one only where the call says it spends no coin. */
const treeFor = (m: CallMakers, zswap: unknown): Uint8Array => {
  if (zswap === SPENDS_NO_COIN) return new m.ledger.ZswapChainState().serialize();
  if (zswap instanceof Uint8Array) return zswap;
  throw new Error('this call names neither the chain\'s commitment tree nor that it spends no coin, so it is not built.');
};

/** The company account a vault circuit asks, with its state at the block the vault's states were read at. */
interface AccountAtTheBlock {
  readonly address: string;
  readonly state: Uint8Array;
  readonly blockHash: string;
}

/** One call, as a builder asks for it. */
interface CallAsked {
  readonly compiledContract: unknown;
  readonly circuitId: string;
  readonly contractAddress: string;
  readonly coinPublicKey: unknown;
  readonly args?: readonly unknown[];
  /** The record a call to the company account reads, handed in as a value for this one call. */
  readonly initialPrivateState?: unknown;
  /** Each payee's encryption key beside the coin key a payment pays, so their wallet can read the payment. */
  readonly additionalCoinEncPublicKeyMappings?: ReadonlyMap<string, string>;
  /** The network the ask names; never a default. */
  readonly network: string;
  readonly read: CallRead;
  readonly account?: AccountAtTheBlock;
}

/** A call as Midnight.js built it: its sealed handle, which is proved, and the ledger's reading of it, which is only read. */
interface CallBuilt {
  readonly private: {
    readonly unprovenTx: UnprovenTx;
    readonly transaction: unknown;
    readonly nextZswapLocalState: unknown;
    readonly nextPrivateState?: unknown;
  };
}

/** What a deploy is built with: the contract, its constructor's arguments and, where it has one, its maintenance key. */
interface DeployAsked {
  readonly compiledContract: unknown;
  readonly args: readonly unknown[];
  readonly signingKey?: unknown;
}

/**
 * A deploy as Midnight.js built it: its sealed handle, which is proved, and the ledger's and the runtime's readings of
 * the transaction and of the contract's starting state, which are only read.
 */
interface DeployBuilt {
  readonly public: { readonly contractAddress: string; readonly initialContractState: unknown };
  readonly private: { readonly unprovenTx: UnprovenTx; readonly transaction: unknown; readonly newCoins: readonly unknown[] };
}

/** The calls and deploys a device builds. */
export interface ContractCalls {
  buildCall(zkConfig: unknown, asked: CallAsked, encryptionPublicKey: unknown): Promise<CallBuilt>;
  buildDeploy(zkConfig: unknown, coinPublicKey: unknown, asked: DeployAsked, encryptionPublicKey: unknown, network: string): Promise<DeployBuilt>;
}

type MidnightContracts = typeof import('@midnight-ntwrk/midnight-js-contracts');
type MidnightTypes = Pick<typeof import('@midnight-ntwrk/midnight-js-types'),
  'SerializedContractState' | 'SerializedLedgerParameters' | 'SerializedZswapChainState'>;
type CallOptions = Parameters<MidnightContracts['createLedger9UnprovenCallTxFromInitialStates']>[1];
type CrossContract = Parameters<MidnightContracts['createLedger9UnprovenCallTxFromInitialStates']>[3];
type DeployOptions = Parameters<MidnightContracts['createLedger9UnprovenDeployTxFromVerifierKeys']>[2];

/** What the calls are built with: Midnight.js's builders and serialized states, the ledger, and the two readers of this build. */
export interface CallMakers {
  readonly contracts: MidnightContracts;
  readonly types: MidnightTypes;
  readonly ledger: Pick<typeof import('@midnightntwrk/ledger-v9'), 'Transaction' | 'ZswapChainState'>;
  /** The contract runtime's state, which a deploy's starting state is read with. */
  readonly ContractState: typeof import('@midnight-ntwrk/compact-runtime').ContractState;
  /** The settings of a network, from the one network record. */
  readonly settingsFor: (network: string) => MidnightConfig;
  /** The company account's compiled module, for that one address and no other. */
  readonly accountModuleFor: (address: string) => ContractModuleProvider;
}

/**
 * **THE COMPANY ACCOUNT A VAULT CIRCUIT CALLS, READ AT THE VAULT'S OWN BLOCK.** Answers the account's state at that
 * block and nothing for any other contract or block. The account spends no coin, so its commitment tree is empty.
 */
const callingTheAccount = (m: CallMakers, account: AccountAtTheBlock, parameters: Uint8Array): CrossContract => {
  const address = account.address.toLowerCase();
  const served: PublicStatesRead = {
    /* The block's protocol version, which building a call does not read: each state's own era is what is checked. */
    protocolVersion: 0,
    contractState: m.types.SerializedContractState.fromBytes('v9', account.state),
    zswapChainState: m.types.SerializedZswapChainState.fromBytes('v9', new m.ledger.ZswapChainState().serialize()),
    ledgerParameters: m.types.SerializedLedgerParameters.fromBytes('v9', parameters),
  };
  const publicDataProvider = {
    queryZSwapAndContractState: async (asked: string, at?: { readonly type: string; readonly blockHash?: string }) =>
      (String(asked).toLowerCase() === address && at?.type === 'blockHash' && at.blockHash === account.blockHash ? served : null),
  };
  /* Midnight.js reads only `queryZSwapAndContractState` of the reader it is handed for a callee; nothing else is offered. */
  return { blockHash: account.blockHash, moduleProvider: m.accountModuleFor(address), publicDataProvider } as CrossContract;
};

/**
 * **THE CALLS AND DEPLOYS A DEVICE BUILDS, AS MIDNIGHT.JS BUILDS THEM.** The compiled contracts come from their
 * generated modules, which name no circuit types Midnight.js can check a call's arguments against, so the options
 * are handed to Midnight.js as its own option type here and nowhere else. Midnight.js still checks every state, the
 * network settings and the circuit when it builds.
 */
export const contractCallsOf = (m: CallMakers): ContractCalls => ({
  buildCall: async (zkConfig, { network, read, account, ...call }, encryptionPublicKey) => {
    const zswap = treeFor(m, read.zswap);
    const built = await m.contracts.createUnprovenCallTxFromInitialStates(
      zkConfig as Parameters<MidnightContracts['createLedger9UnprovenCallTxFromInitialStates']>[0],
      {
        ...call,
        initialContractState: m.types.SerializedContractState.fromBytes('v9', read.contract),
        initialZswapChainState: m.types.SerializedZswapChainState.fromBytes('v9', zswap),
        ledgerParameters: m.types.SerializedLedgerParameters.fromBytes('v9', read.parameters),
        config: m.settingsFor(network),
      } as CallOptions,
      encryptionPublicKey as string,
      account === undefined ? undefined : callingTheAccount(m, account, read.parameters));
    const transaction = built.private.unprovenTx.deserialize({ v9: m.ledger.Transaction });
    return { private: { ...built.private, transaction } };
  },
  buildDeploy: async (zkConfig, coinPublicKey, asked, encryptionPublicKey, network) => {
    const built = await m.contracts.createUnprovenDeployTxFromVerifierKeys(
      zkConfig as Parameters<MidnightContracts['createLedger9UnprovenDeployTxFromVerifierKeys']>[0],
      coinPublicKey as string, asked as DeployOptions, encryptionPublicKey as string, m.settingsFor(network));
    return {
      public: {
        contractAddress: built.public.contractAddress,
        initialContractState: built.public.initialContractState.deserialize({ v9: m.ContractState }),
      },
      private: {
        unprovenTx: built.private.unprovenTx,
        transaction: built.private.unprovenTx.deserialize({ v9: m.ledger.Transaction }),
        newCoins: built.private.newCoins,
      },
    };
  },
});
