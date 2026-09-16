/**
 * **THE WORKER A COMPANY VAULT'S TRANSACTIONS ARE BUILT AND PROVED IN.**
 *
 * The ledger, the contract runtime and the prover are WebAssembly and are not
 * allowed on the page; this thread is where they load, and only once something
 * asks. The page talks to it through `vault-worker-client.ts`, one request and
 * one answer at a time, each carrying the id it answers.
 *
 * Nothing this worker is asked for leaves it except the answer to the page: it
 * fetches the vault's public proving material from this application's own
 * origin and sends nothing anywhere.
 */
import { buildCommitteeHandover, buildDeposit, buildVaultDeploy, type VaultBuilderDeps } from './vault-builder.js';
import { httpKeyMaterialSource, IndexedDbArtefactCache, type ArtefactSource } from './key-material.js';
import { zkConfigOver, byCircuitName } from './zk-config.js';
import type { VaultAsk, VaultAnswer } from './vault-worker-client.js';

/** Where this application serves the vault's public proving material. */
export const VAULT_ARTEFACT_BASE = '/artefacts/vault';

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * **A DEPOSIT ALSO PROVES THE NETWORK'S OWN SHIELDED-OUTPUT CIRCUIT**, which the
 * prover asks for as `midnight/zswap/output`. Those three are served beside the
 * vault's own, and every other name goes to the vault's.
 */
export const networkCircuitsBeside = (vault: ArtefactSource, network: ArtefactSource): ArtefactSource => {
  const which = (keyLocation: string) => (keyLocation.startsWith('midnight/zswap/') ? network : vault);
  return {
    lookupKey: (keyLocation) => which(keyLocation).lookupKey(keyLocation),
    getParams: (k) => vault.getParams(k),
    artefact: (kind, keyLocation) => which(keyLocation).artefact(kind, keyLocation),
  };
};

/** Everything heavy, loaded the first time it is needed and kept. */
const loadDeps = (scope: any) => {
  let loaded: Promise<Omit<VaultBuilderDeps, 'network'> & { vault: any }> | null = null;
  return (): Promise<Omit<VaultBuilderDeps, 'network'> & { vault: any }> => {
    loaded ??= (async () => {
      const [ledger, runtime, contracts, compactJs, vault, proving] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnight-ntwrk/compact-runtime'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('../../contracts/managed-vault/contract/index.js'),
        import('../midnight/wasm-proving.js'),
      ]);
      const options = {
        cache: new IndexedDbArtefactCache(scope.indexedDB),
        fetchImpl: scope.fetch.bind(scope),
      };
      const source = networkCircuitsBeside(
        httpKeyMaterialSource(VAULT_ARTEFACT_BASE, options),
        httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/builtin/zswap/9`, options));
      const prover = await proving.wasmProofProvider(source);
      const CompiledContract = (compactJs as any).CompiledContract;
      const compiled = CompiledContract.make('Vault', (vault as any).Contract).pipe(
        CompiledContract.withWitnesses({
          /* No transaction built here spends a note, so nothing may ask for one. */
          noteToSpend: () => { throw new Error('a vault transaction built on this device spends no note.'); },
        }),
      );
      return {
        ledger,
        vault,
        runtimeState: (runtime as any).ContractState,
        contracts: contracts as any,
        compiled,
        zkConfig: zkConfigOver(source, byCircuitName),
        prove: async (unproven: any, circuit?: string) =>
          (await (prover as any).proveTx(unproven, circuit === undefined ? undefined : { circuitId: circuit })) as { serialize(): Uint8Array },
      };
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
};

/** One answer for one ask. Exported so it can be driven without a Worker. */
export const answerVaultAsk = async (
  deps: () => Promise<Omit<VaultBuilderDeps, 'network'> & { vault: any }>,
  ask: VaultAsk,
): Promise<VaultAnswer> => {
  const d = await deps();
  const withNetwork = { ...d, network: ask.network } as VaultBuilderDeps;
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(ask.network as never);
  switch (ask.ask) {
    case 'deploy': {
      const built = await buildVaultDeploy(withNetwork, { account: ask.account });
      return { id: ask.id, ok: true, ask: 'deploy', vault: built.vault, temporaryKey: built.temporaryKey, tx: toBase64(built.proven) };
    }
    case 'handover': {
      const built = await buildCommitteeHandover(withNetwork, {
        vault: ask.vault, counter: BigInt(ask.counter), temporaryKey: ask.temporaryKey, to: ask.to,
      });
      return { id: ask.id, ok: true, ask: 'handover', tx: toBase64(built.proven) };
    }
    case 'deposit': {
      const built = await buildDeposit(withNetwork, {
        vault: ask.vault,
        coin: { nonce: ask.coin.nonce, token: ask.coin.token, value: BigInt(ask.coin.value) },
        state: fromBase64(ask.state),
      });
      return { id: ask.id, ok: true, ask: 'deposit', tx: toBase64(built.proven) };
    }
    case 'commitments': {
      /* The two commitments a coin has: as an output the ledger records, and as the note the vault holds. */
      const [{ compiledOutputCommitment }, { commitmentForNote }] = await Promise.all([
        import('../midnight/rebuild-from-records.js'),
        import('../midnight/vault-recovery.js'),
      ]);
      const handed = ask.coin as unknown as Record<'nonce' | 'token', never> & { readonly value: string };
      const coin = { nonce: handed.nonce, token: handed.token, value: BigInt(handed.value) };
      const output = (await compiledOutputCommitment())(coin, ask.vault as never);
      const held = commitmentForNote(d.vault.pureCircuits, ask.vault as never, coin);
      return { id: ask.id, ok: true, ask: 'commitments', output, held };
    }
    default:
      return { id: (ask as { id: number }).id, ok: false, error: 'this worker was asked for something it does not build.' };
  }
};

export const startVaultWorker = (scope: any): void => {
  const deps = loadDeps(scope);
  scope.addEventListener('message', (event: MessageEvent) => {
    const ask = event.data as VaultAsk;
    if (typeof ask !== 'object' || ask === null || typeof ask.id !== 'number') return;
    void answerVaultAsk(deps, ask).then(
      (answer) => scope.postMessage(answer),
      (e: unknown) => scope.postMessage({ id: ask.id, ok: false, error: String((e as { message?: unknown })?.message ?? e) }),
    );
  });
  scope.postMessage({ kind: 'vault-worker-ready' });
};

declare const self: any;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.window === 'undefined') {
  startVaultWorker(self);
}
