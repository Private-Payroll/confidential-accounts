/**
 * **WHAT THE VAULT WORKER BUILDS WITH, LOADED THE FIRST TIME AN ASK NEEDS IT.** The ledger, the contract runtime,
 * both compiled contracts and the prover are WebAssembly or large modules, so they load once, on the first ask,
 * and every proving file they read is checked against this build before it is used.
 */
import type { VaultBuilderDeps } from './vault-builder.js';
import type { GovernedCallDeps } from './governed-call-builder.js';
import { detailsOfKind } from '../../../src/midnight/vault-details.js';
import { IndexedDbArtefactCache } from './key-material.js';
import { zkConfigOver, byCircuitName, runtimeVersionOf } from './zk-config.js';
import { keyLocationOf, ZKIR_ENGINES } from '../../../src/midnight/wasm-proving.js';
import type { indexerTransactionsByIdentifier } from '../../../src/midnight/note-index.js';
import { proofProviderOnWorkers, provedTransaction } from './vault-proof-workers.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { checkedAccountKeys, provingWarmed, thisBuildsSources } from './this-builds-proving-material.js';
import { toldOfEachCall, toldThePage } from './proving-told-to-the-page.js';
import { contractCallsOf } from './contract-call-built.js';

/**
 * What this worker builds with: the vault's builder, and the account's circuits
 * beside it, with the account's compiled ledger reader, which a vault's start
 * reads the account's rounds with.
 */
/** A contract's verifying keys, each checked against this build's own digest for it before it is used. */
export interface CheckedVerifierKeys {
  getVerifierKey(c: string): Promise<Uint8Array>;
  getVerifierKeys(cs: readonly string[]): Promise<Array<[string, Uint8Array]>>;
}

export type WorkerDeps = Omit<VaultBuilderDeps, 'network'> & { vault: any; accountLedger: (data: unknown) => unknown }
  & Omit<GovernedCallDeps, 'random' | 'network'> & {
    /**
     * Every one of the company account's verifying keys, fetched from this
     * application's own origin and each checked against the digest the account's
     * compiled module carries for it before it is used. Answers as the SDK's key
     * provider asks, which compiler built them included: a new account's deploy
     * is built with these keys, and Midnight.js reads that to tell which ledger
     * the deploy is for.
     */
    accountKeys: CheckedVerifierKeys & { getArtifactRuntimeVersion(): Promise<string> };
    /**
     * The compiled account's own digest of each of its circuits' verifying keys:
     * what a vault's account is held against before money goes in or out. Absent,
     * every such read refuses.
     */
    accountExpectedVk?: Readonly<Record<string, string>>;
    /** Every vault circuit's verifying key, checked the same way against the compiled vault's own digests. */
    vaultKeys: CheckedVerifierKeys;
    /** Fetches and checks the public parameters every circuit this app proves needs, and a deposit's keys, ahead of any proof. */
    provingWarmed: () => Promise<void>;
    /** Where a vault is read from, at the indexer the wallet names; absent, the indexer itself. A test hands its own. */
    chainSourceAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => import('./vault-on-chain-here.js').VaultChainSource;
    /** Where an account's history is read from, at the indexer the wallet names; absent, the indexer itself. A test hands its own. */
    historyAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => import('../../../src/midnight/contract-history.js').ContractHistory;
    /** Where transactions are looked up by identifier: the indexer the wallet names, unless a test stands one in. */
    transactionsAt?: (indexer: { indexerUri: string; indexerWsUri: string }) => ReturnType<typeof indexerTransactionsByIdentifier>;
  };

/**
 * The size of public parameters a circuit file needs, read with the prover package its name says it is for: a
 * contract's circuit with the contract prover, one of the network's own with the network's.
 */
const sizeOfCircuit = async (circuit: Uint8Array, location: string): Promise<number> => {
  const kind = keyLocationOf(location)?.kind;
  if (kind === undefined) throw new Error(`"${location}" names no circuit this app proves, so its size was not read.`);
  return (await ZKIR_ENGINES[kind]()).Zkir.deserialize(circuit).getK();
};

/** Everything heavy, loaded the first time it is needed and kept. */
export const loadDeps = (scope: any) => {
  let loaded: Promise<WorkerDeps> | null = null;
  return (): Promise<WorkerDeps> => {
    loaded ??= (async () => {
      const [
        ledger, runtime, contracts, compactJs, vault, proving, account, accountWitnesses, vaultManifest, accountManifest, networkKeys,
        types, providers, modules,
      ] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnight-ntwrk/compact-runtime'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('../../../contracts/managed-vault/contract/index.js'),
        import('../../../src/midnight/wasm-proving.js'),
        import('../../../contracts/managed/contract/index.js'),
        import('../../../contracts/src/witnesses.js'),
        import('../../../contracts/managed-vault/compiler/contract-manifest.json'),
        import('../../../contracts/managed/compiler/contract-manifest.json'),
        import('../../../apps/wallet/public/keys/manifest.json'),
        import('@midnight-ntwrk/midnight-js-types'),
        import('../../../src/midnight/providers.js'),
        import('../../../src/midnight/contract-modules.js'),
      ]);
      const options = {
        /* A store that will not keep a file costs a download; it is said in this thread's console. */
        cache: new IndexedDbArtefactCache(scope.indexedDB, undefined, (why: string) => scope.console?.warn?.(why)),
        fetchImpl: scope.fetch.bind(scope),
      };
      const vaultCompiled = (vaultManifest as any).default ?? vaultManifest;
      const accountCompiled = (accountManifest as any).default ?? accountManifest;
      const built = thisBuildsSources(options, {
        vault: { expectedVk: (vault as any).expectedVk, manifest: vaultCompiled },
        account: { expectedVk: (account as any).expectedVk, manifest: accountCompiled },
        network: (networkKeys as any).default ?? networkKeys,
      });
      /* Every fetch of proving material is told to the page as it starts and ends, so a long download is not taken for a worker gone quiet. */
      const busy = () => toldThePage(scope, { kind: 'vault-worker-busy' });
      const source = toldOfEachCall(built.source, busy);
      const vaultFolder = toldOfEachCall(built.vault, busy);
      const accountFolder = toldOfEachCall(built.account, busy);
      /* Each proof on a thread of its own where this thread can start one (`vault-proof-workers.ts`); on this thread where it cannot. */
      const prover = await proofProviderOnWorkers(source, scope, () => proving.wasmProofProvider(source));
      const CompiledContract = (compactJs as any).CompiledContract;
      const zkConfig = zkConfigOver(source, byCircuitName, runtimeVersionOf(vaultCompiled, 'the vault'));
      const accountRuntime = runtimeVersionOf(accountCompiled, 'the company account');
      const compiled = CompiledContract.make('Vault', (vault as any).Contract).pipe(
        CompiledContract.withWitnesses({
          /* No transaction built here spends a note, so nothing may ask for one. */
          noteToSpend: () => { throw new Error('a vault transaction built on this device spends no note.'); },
          nonceSecret: () => { throw new Error('a vault transaction built on this device reads no nonce secret.'); },
        }),
      );
      return {
        ledger,
        vault,
        runtimeState: (runtime as any).ContractState,
        /* The signer-tree pieces a batch's holders are read off, and checked against the root they name, with. */
        accountTree: {
          StateBoundedMerkleTree: (runtime as any).StateBoundedMerkleTree,
          CompactTypeBytes: (runtime as any).CompactTypeBytes,
          CompactTypeMerkleTreeDigest: (runtime as any).CompactTypeMerkleTreeDigest,
        },
        contracts: contractCallsOf({
          contracts, types, ledger, ContractState: runtime.ContractState, settingsFor: providers.transactionSettingsFor,
          accountModuleFor: modules.accountModuleFor,
        }),
        compiled,
        /* A payment out is the one transaction built here that spends a note, and it hands in the one it chose. */
        compiledWith: (witnesses: unknown) => CompiledContract.make('Vault', (vault as any).Contract).pipe(
          CompiledContract.withWitnesses(witnesses)),
        zkConfig,
        /*
         * **THE COMPANY ACCOUNT, WITH ITS OWN WITNESSES.** A raise and an approval
         * are built with the record handed to each call as a value; this object
         * is given no store to read a record from.
         */
        accountCompiled: CompiledContract.make('ConfidentialAccount', (account as any).Contract).pipe(
          CompiledContract.withWitnesses((accountWitnesses as any).witnesses)),
        accountZkConfig: zkConfigOver(source, byCircuitName, accountRuntime),
        accountPure: (account as any).pureCircuits,
        accountKeys: {
          ...checkedAccountKeys((c) => accountFolder.artefact('verifier', c), (account as any).expectedVk, sha256),
          getArtifactRuntimeVersion: async () => accountRuntime,
        },
        accountExpectedVk: (account as any).expectedVk,
        provingWarmed: () => provingWarmed(source, sizeOfCircuit),
        vaultKeys: checkedAccountKeys(
          (c) => vaultFolder.artefact('verifier', c), (vault as any).expectedVk, sha256, 'the vault'),
        accountLedger: (account as any).ledger,
        /* The vault's two details circuits, paired once: what a payee's leaf is made with when a run is rebuilt here. */
        vaultDetails: detailsOfKind((vault as any).pureCircuits),
        vaultPure: (vault as any).pureCircuits,
        prove: async (unproven: unknown) => provedTransaction(prover, unproven),
      };
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
};
