import { sha256 } from '@noble/hashes/sha2.js';
import type { WorkerDeps } from '../../../../packages/web-shared/src/vault-worker-entry.js';
import { checkedAccountKeys } from '../../../../packages/web-shared/src/vault-worker-entry.js';
import { zkConfigOver, byCircuitName } from '../../../../packages/web-shared/src/zk-config.js';
import { detailsOfKind } from '../../../../src/midnight/vault-details.js';
import { ACCOUNT_CIRCUITS_THE_WALLET_PROVES, VAULT_CIRCUITS_THE_WALLET_DEPLOYS, VAULT_CIRCUITS_THE_WALLET_PROVES } from './account-circuits.js';
import { makePinnedKeyMaterialProvider, type PinnedKeyMaterial, type PinnedKeyMaterialOptions } from './key-material.js';
import { keptProvers, makeBrowserProvingService, type ProofEvent } from './proving.js';

/*
 * THE WALLET'S OWN VAULT BUILDER. A new vault's deploy, the reads of where its
 * start stands, and the two calls that carry the secret this wallet made
 * (setting it, and writing each signer's sealed copy) are built here with the
 * same builder the page's devices use, given this wallet's own keys and its
 * own prover: every key is one this wallet vendored and pinned, checked against
 * the vault and the account this build compiled, and every proof runs on this
 * device. Nothing here takes a key, a call or a proof from a page.
 */

export interface VaultBuilderOptions {
  /** Where the keys come from; the wallet's own origin and store unless a test says otherwise. */
  readonly keyMaterial?: Omit<PinnedKeyMaterialOptions, 'accountCircuits' | 'compiledVerifierKeys' | 'vaultCircuits' | 'vaultVerifiers' | 'compiledVaultVerifierKeys'>;
  readonly provers?: ReturnType<typeof keptProvers>;
  readonly onProof?: (event: ProofEvent) => void;
}

/** The verifier keys of one contract, served only from the pinned files and checked against what this build compiled. */
const verifiersFrom = (fetch: (circuit: string) => Promise<Uint8Array>, expected: Readonly<Record<string, string>>, whose: string) =>
  checkedAccountKeys(fetch, expected, sha256, whose);

/** A verifier-only key source for the builder's calls and deploys: the prover's keys are served by contract location, never here. */
const verifierSource = (key: (circuit: string) => Promise<Uint8Array>, whose: string) => ({
  artefact: async (kind: string, circuit: string) => {
    if (kind !== 'verifier') throw new Error(`this wallet serves no ${kind} for ${whose}'s "${circuit}" to its builder.`);
    return key(circuit);
  },
});

/** Loads the builder's dependencies once, on first use. */
export const vaultBuilderDeps = (options: VaultBuilderOptions = {}): (() => Promise<WorkerDeps>) => {
  let loaded: Promise<WorkerDeps> | null = null;
  return () => {
    loaded ??= (async () => {
      const [ledger, runtime, contracts, compactJs, vault, account, accountWitnesses] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnight-ntwrk/compact-runtime'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('../../../../contracts/managed-vault/contract/index.js'),
        import('../../../../contracts/managed/contract/index.js'),
        import('../../../../contracts/src/witnesses.js'),
      ]);
      const vaultVk = (vault as unknown as { expectedVk: Readonly<Record<string, string>> }).expectedVk;
      const accountVk = (account as unknown as { expectedVk: Readonly<Record<string, string>> }).expectedVk;
      const keyMaterial: PinnedKeyMaterial = makePinnedKeyMaterialProvider({
        ...options.keyMaterial,
        accountCircuits: ACCOUNT_CIRCUITS_THE_WALLET_PROVES,
        compiledVerifierKeys: accountVk,
        vaultCircuits: VAULT_CIRCUITS_THE_WALLET_PROVES,
        vaultVerifiers: VAULT_CIRCUITS_THE_WALLET_DEPLOYS,
        compiledVaultVerifierKeys: vaultVk,
      });
      const service = makeBrowserProvingService(keyMaterial, {
        ...(options.provers === undefined ? {} : { provers: options.provers }),
        ...(options.onProof === undefined ? {} : { onProof: options.onProof }),
      });
      const CompiledContract = (compactJs as unknown as { CompiledContract: any }).CompiledContract;
      const compiledWith = (witnesses: unknown) => CompiledContract.make('Vault', (vault as any).Contract).pipe(CompiledContract.withWitnesses(witnesses));
      return {
        ledger,
        vault,
        runtimeState: (runtime as any).ContractState,
        accountTree: {
          StateBoundedMerkleTree: (runtime as any).StateBoundedMerkleTree,
          CompactTypeBytes: (runtime as any).CompactTypeBytes,
          CompactTypeMerkleTreeDigest: (runtime as any).CompactTypeMerkleTreeDigest,
        },
        contracts: contracts as any,
        compiled: compiledWith({
          noteToSpend: () => { throw new Error('a vault transaction built in this wallet spends no note.'); },
          nonceSecret: () => { throw new Error('a vault transaction built in this wallet reads no nonce secret.'); },
        }),
        compiledWith,
        zkConfig: zkConfigOver(verifierSource((c) => keyMaterial.vaultVerifierKey(c), 'the vault') as never, byCircuitName),
        accountCompiled: CompiledContract.make('ConfidentialAccount', (account as any).Contract).pipe(
          CompiledContract.withWitnesses((accountWitnesses as any).witnesses)),
        accountZkConfig: zkConfigOver(verifierSource((c) => keyMaterial.accountVerifierKey(c), 'the company account') as never, byCircuitName),
        accountPure: (account as any).pureCircuits,
        accountKeys: verifiersFrom((c) => keyMaterial.accountVerifierKey(c), accountVk, 'the company account'),
        accountExpectedVk: accountVk,
        provingWarmed: async () => {},
        vaultKeys: verifiersFrom((c) => keyMaterial.vaultVerifierKey(c), vaultVk, 'the vault'),
        accountLedger: (account as any).ledger,
        vaultDetails: detailsOfKind((vault as any).pureCircuits),
        vaultPure: (vault as any).pureCircuits,
        prove: async (unproven: any) => service.prove(unproven) as Promise<{ serialize(): Uint8Array }>,
      } as unknown as WorkerDeps;
    })();
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
};
