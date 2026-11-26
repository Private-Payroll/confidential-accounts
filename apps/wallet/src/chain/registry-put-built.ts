import type * as Runtime from '@midnight-ntwrk/compact-runtime';
import type * as Registry from '../../../../contracts/managed-registry/contract/index.js';
import { SPENDS_NO_COIN, type ContractCalls } from '../../../../packages/web-shared/src/contract-call-built.js';
import { throwawayKeys, type VaultBuilderDeps } from '../../../../packages/web-shared/src/vault-builder.js';
import { REGISTRY_PUT } from '../../../../src/wiring/registry-call-checks.js';

/**
 * **ONE WRITE TO A PRIVATE REGISTRY, BUILT AND PROVED ON THIS DEVICE, AND WHAT THE REGISTRY HOLDS AT A PERSON'S TAGS.**
 * The write is the registry's one circuit, `put`, of one tag and one sealed value, built against the registry's state
 * and the chain's parameters at one block, as the wallet read them. It moves no coin; the keys the call builder asks
 * for are made from randomness nobody keeps. Nothing here reads a seed: the tag and the value arrive made.
 */

/** The registry as this build compiled it, for its write and its reads. */
export interface RegistryParts {
  readonly compiled: unknown;
  readonly zkConfig: unknown;
  readonly ledger: typeof Registry.ledger;
  readonly contractState: typeof Runtime.ContractState;
}

/** What the write is built with: the call builder, the network the ask names, the prover and the registry. */
export type RegistryBuildingDeps = Pick<VaultBuilderDeps, 'ledger' | 'random' | 'prove'> & {
  readonly contracts: Pick<ContractCalls, 'buildCall'>;
  readonly network: string;
  readonly registry: RegistryParts;
};

/** The registry's write of `value` at `tag`, proved: the transaction's bytes. */
export async function registryPutBuilt(
  d: RegistryBuildingDeps,
  ask: { readonly registry: string; readonly tag: Uint8Array; readonly value: Uint8Array; readonly state: Uint8Array; readonly parameters: Uint8Array },
): Promise<Uint8Array> {
  const keys = throwawayKeys(d);
  const built = await d.contracts.buildCall(d.registry.zkConfig, {
    compiledContract: d.registry.compiled,
    circuitId: REGISTRY_PUT,
    contractAddress: ask.registry,
    coinPublicKey: keys.coinPublicKey,
    network: d.network,
    read: { contract: ask.state, zswap: SPENDS_NO_COIN, parameters: ask.parameters },
    args: [ask.tag, ask.value],
  }, keys.encryptionPublicKey);
  return (await d.prove(built.private.unprovenTx, REGISTRY_PUT)).serialize();
}

/** What the registry, in `state`, holds at each of `tags`, in order: the value, or null for a tag it does not hold. */
export function registryValuesAt(registry: Pick<RegistryParts, 'ledger' | 'contractState'>, state: Uint8Array, tags: readonly Uint8Array[]): (Uint8Array | null)[] {
  const entries = registry.ledger(registry.contractState.deserialize(state).data).entries;
  return tags.map((t) => (entries.member(t) ? entries.lookup(t) : null));
}
