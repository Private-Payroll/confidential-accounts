/**
 * **THE PROVING MATERIAL THIS BUILD WAS COMPILED WITH, AND HOW THE VAULT WORKER READS IT.** One checked source for
 * the vault's, the company account's and the network's circuits, each folder held to this build's own digests and
 * pins; the warm-up that fetches a deposit's circuits first and every other circuit after; and the check that holds
 * each verifying key to the digest its compiled module carries.
 */
import {
  contractPins,
  httpKeyMaterialSource,
  networkPins,
  type ArtefactSource,
  type CompiledManifest,
  type HttpKeyMaterialOptions,
  type NetworkKeyPins
} from './key-material.js';
import { publishedByMidnight } from '../../../src/midnight/proving-parameter-digests.js';
import { ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE, VAULT_CIRCUITS } from '../../../src/midnight/vault-contract.js';
import { accountCircuitsBeside, networkCircuitsBeside } from './circuits-served-beside.js';
import { readsGoFirst } from './reads-go-first.js';
import type { CheckedVerifierKeys } from './vault-worker-deps.js';

/** Where this application serves the vault's public proving material. */
export const VAULT_ARTEFACT_BASE = '/artefacts/vault';

/** The folder the network's own shielded circuits are served from and pinned under, the same name in both. */
const NETWORK_KEYS_FOLDER = 'zswap/9';

/** The network's own shielded circuits a device proves, as the network's folder names them. */
const NETWORK_SHIELDED_CIRCUITS = ['output', 'spend', 'sign'] as const;

/** What this copy of the app was compiled with, read from its own files and never from the service. */
export interface ThisBuild {
  readonly vault: { readonly expectedVk: Readonly<Record<string, string>>; readonly manifest: CompiledManifest };
  readonly account: { readonly expectedVk: Readonly<Record<string, string>>; readonly manifest: CompiledManifest };
  readonly network: NetworkKeyPins;
}

/**
 * **THE ONE SOURCE EVERY PROOF, DEPLOY AND KEY CHECK IN THIS WORKER READS ITS
 * MATERIAL FROM**, each folder checked against this build: the vault's and the
 * company account's against their compiled digests, the network's shielded
 * circuits against their pins, and the public parameters against Midnight's
 * published digests. `source` is what the prover and the deploys read; `vault`
 * and `account` are the same checked sources, for the verifying keys a creation
 * reads on its own.
 */
export const thisBuildsSources = (options: Omit<HttpKeyMaterialOptions, 'pins'>, build: ThisBuild) => {
  const vault = httpKeyMaterialSource(VAULT_ARTEFACT_BASE, {
    ...options,
    pins: contractPins('the vault', build.vault.expectedVk, build.vault.manifest, publishedByMidnight)
  });
  const account = httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/account`, {
    ...options,
    pins: contractPins('the company account', build.account.expectedVk, build.account.manifest)
  });
  const network = httpKeyMaterialSource(`${VAULT_ARTEFACT_BASE}/builtin/${NETWORK_KEYS_FOLDER}`, {
    ...options,
    pins: networkPins("the network's shielded transfers", build.network, NETWORK_KEYS_FOLDER)
  });
  return { source: networkCircuitsBeside(accountCircuitsBeside(vault, account), network), vault, account };
};

/**
 * The circuits a deposit proves on this device: the vault's private and public
 * deposit, and the network's shielded output that carries a private deposit's
 * coin into the vault. They are warmed first, with their proving and verifying
 * keys (about 11 MB together), so even a first deposit reads nothing from the
 * network; the other circuits' proving keys run to hundreds of MB and are
 * fetched when a proof first needs them.
 */
const CIRCUITS_A_DEPOSIT_PROVES = ['deposit', 'depositUnshielded', 'midnight/zswap/output'] as const;

/**
 * **THE PUBLIC PARAMETERS EVERY CIRCUIT THIS APP PROVES NEEDS, AND A DEPOSIT'S
 * KEYS, FETCHED AND CHECKED BEFORE ANY PROOF ASKS FOR THEM.** Works in two
 * stages. First a deposit's own circuits, whole: each one's circuit, its size
 * read off it, its proving and verifying keys, then the parameters for those
 * sizes. Only then every other circuit of the vault, of the company account and
 * of the network's shielded transfers, and the parameters for the sizes not yet
 * held. Reading a size means parsing the circuit on this worker's one thread,
 * over a minute for every circuit together, so a deposit asked for right after
 * sign-in finds its files held instead of queueing behind those parses. Each
 * stage asks for its sizes smallest first, each once. `source` is the prover's
 * own checked source, so a file the service sends that is not the published one
 * is refused by name and not kept. Every file is tried even when one fails; it
 * then refuses with the first failure.
 *
 * `sizeOf` is handed each circuit's file with the name it was fetched under, so it
 * reads the file with the prover that name says it is for.
 *
 * **A READ OF THE NETWORK GOES FIRST.** Before each file it waits while this
 * worker has a read under way (`readsGoFirst`), so the downloads started at
 * sign-in do not slow the read a person is waiting on.
 */
export const provingWarmed = async (
  source: ArtefactSource,
  sizeOf: (circuit: Uint8Array, location: string) => number | Promise<number>,
  readsFirst: () => Promise<void> = readsGoFirst
): Promise<void> => {
  const fetchedSizes = new Set<number>();
  const failures: unknown[] = [];
  const stage = async (circuits: readonly string[], keysToo: boolean): Promise<void> => {
    const sizes = new Set<number>();
    await Promise.all(
      circuits.flatMap((location) => [
        (async () => {
          try {
            await readsFirst();
            sizes.add(await sizeOf(await source.artefact('ir', location), location));
          } catch (e) {
            failures.push(e);
          }
        })(),
        ...(keysToo ? (['prover', 'verifier'] as const) : []).map(async (kind) => {
          try {
            await readsFirst();
            await source.artefact(kind, location);
          } catch (e) {
            failures.push(e);
          }
        })
      ])
    );
    for (const k of [...sizes].filter((k) => !fetchedSizes.has(k)).sort((a, b) => a - b)) {
      fetchedSizes.add(k);
      try {
        await readsFirst();
        await source.getParams(k);
      } catch (e) {
        failures.push(e);
      }
    }
  };
  await stage(CIRCUITS_A_DEPOSIT_PROVES, true);
  await stage(
    [
      ...VAULT_CIRCUITS,
      ...ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE,
      ...NETWORK_SHIELDED_CIRCUITS.map((c) => `midnight/zswap/${c}`)
    ].filter((location) => !(CIRCUITS_A_DEPOSIT_PROVES as readonly string[]).includes(location)),
    false
  );
  if (failures.length > 0) throw failures[0];
};

/**
 * **A CONTRACT'S VERIFYING KEYS, EACH CHECKED AGAINST THE DIGEST ITS COMPILED
 * MODULE CARRIES FOR IT**, from wherever they are fetched. A key that is not the
 * build's own is refused by name before anything is built or read with it.
 */
export const checkedAccountKeys = (
  fetchKey: (circuit: string) => Promise<Uint8Array>,
  expected: Readonly<Record<string, string>>,
  digest: (bytes: Uint8Array) => Uint8Array,
  whose = 'the company account'
): CheckedVerifierKeys => {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const one = async (c: string): Promise<Uint8Array> => {
    const want = expected[c];
    if (typeof want !== 'string') throw new Error(`${whose} has no circuit called ${c} in this build.`);
    const key = await fetchKey(c);
    if (hex(digest(key)) !== want.toLowerCase()) {
      throw new Error(
        `the verifying key served for ${whose}'s ${c} circuit is not this build's, so nothing was built.`
      );
    }
    return key;
  };
  return {
    getVerifierKey: one,
    getVerifierKeys: async (cs) => Promise.all(cs.map(async (c): Promise<[string, Uint8Array]> => [c, await one(c)]))
  };
};
