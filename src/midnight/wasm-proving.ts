/**
 * Proving in this process, with no proof server.
 *
 * The proof preimage is the private input (the balance, the amount, the signer's secret key), so it never leaves the
 * device that builds it. Two provers are needed and each key location goes to exactly one: a contract's own circuits
 * are compiled to the newer circuit format and prove with `@midnightntwrk/zkir-v3`; the network's own circuits (the
 * shielded transfer and fee keys, at `midnight/...`) prove with `@midnightntwrk/zkir-v2`. A key location that is
 * neither is refused before any proving starts.
 *
 * The same code runs in a browser: the WASM loads by `fetch` there (the packages' own export maps choose), and the
 * artefacts arrive through a `KeyMaterialSource` rather than off disk.
 */
import type { ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import type { ProvingProvider } from '@midnightntwrk/ledger-v9';
import { parseContractKeyLocation } from '@midnight-ntwrk/compact-js/effect/ContractKeyLocation';

/** The three artefacts the prover needs for one circuit. */
export interface ProvingKeyMaterial {
  proverKey: Uint8Array;
  verifierKey: Uint8Array;
  ir: Uint8Array;
}

/**
 * Where the artefacts come from: the disk for a script, `fetch` in a browser.
 *
 * Nothing here is secret. Prover keys, verifier keys, circuits and public parameters are all public, which is why
 * serving them costs nothing in privacy and why the private input never has to leave the device.
 */
export interface KeyMaterialSource {
  lookupKey(keyLocation: string): Promise<ProvingKeyMaterial | undefined>;
  /** The public parameters covering 2^k rows, for a circuit of that size. */
  getParams(k: number): Promise<Uint8Array>;
}

/** What a key location names: a contract's circuit, or one of the network's own circuits. */
export type KeyLocation =
  | { readonly kind: 'contract'; readonly circuit: string; readonly verifierKeyHash: string | null }
  | { readonly kind: 'network'; readonly path: string };

const BARE_CIRCUIT = /^[A-Za-z0-9_]+$/u;
const NETWORK_PREFIX = 'midnight/';

/**
 * Reads a key location. A contract call is asked for as `contract:<address>/<circuit>?vk=<hash>` (parsed by
 * compact-js's own codec); the network's own circuits as `midnight/<path>`. A bare circuit name is read too, because
 * this build fetches its own files by circuit name, but nothing is proved for one (`proverKindOf`). Answers `null`
 * for anything else, so a caller refuses it rather than guessing which prover or which file it means.
 */
export const keyLocationOf = (keyLocation: string): KeyLocation | null => {
  const located = parseContractKeyLocation(keyLocation);
  if (located !== undefined) {
    return { kind: 'contract', circuit: located.circuitId, verifierKeyHash: located.verifierKeyHash };
  }
  if (BARE_CIRCUIT.test(keyLocation)) return { kind: 'contract', circuit: keyLocation, verifierKeyHash: null };
  if (keyLocation.startsWith(NETWORK_PREFIX) && keyLocation.length > NETWORK_PREFIX.length) {
    return { kind: 'network', path: keyLocation.slice(NETWORK_PREFIX.length) };
  }
  return null;
};

/** One prover package: both `@midnightntwrk/zkir-v3` and `@midnightntwrk/zkir-v2` have this shape. */
export interface ZkirEngine {
  provingProvider(km: KeyMaterialSource): Pick<ProvingProvider, 'check' | 'prove'>;
  /** Reads a circuit of this package's format, for the size of public parameters it needs. */
  Zkir: { deserialize(ir: Uint8Array): { getK(): number } };
}

/** Which prover package proves each kind of key location, loaded only when a circuit of that kind is first proved. */
export type ZkirEngines = Readonly<Record<KeyLocation['kind'], () => Promise<ZkirEngine>>>;

/**
 * Contract circuits prove with zkir-v3, the network's own with zkir-v2. Imported on first use, so loading this module
 * does not instantiate a WASM binary, and a device that proves only contract circuits never loads the other.
 */
export const ZKIR_ENGINES: ZkirEngines = {
  contract: () => import('@midnightntwrk/zkir-v3'),
  network: () => import('@midnightntwrk/zkir-v2'),
};

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The source as a prover asks for it, with every failure naming the key location or size it was for: an error
 * crossing back out of the WASM otherwise arrives saying nothing about what it was loading.
 */
const namingFailures = (source: KeyMaterialSource): KeyMaterialSource => ({
  async lookupKey(keyLocation: string) {
    try {
      return await source.lookupKey(keyLocation);
    } catch (e) {
      throw new Error(`could not load proving material for "${keyLocation}": ${said(e)}`);
    }
  },
  async getParams(k: number) {
    try {
      return await source.getParams(k);
    } catch (e) {
      /* The source says what it tried and why each failed; nothing is added that fits only one source. */
      throw new Error(`could not load the SRS for k=${k}: ${said(e)}`);
    }
  },
});

/**
 * Which prover a key location is proved with. Throws for a key location that names neither kind of circuit, and for
 * a contract's circuit named without the verifying key hash it is proved against: Midnight.js names every contract
 * circuit it proves with that hash, and the build check holds the keys to it.
 */
export const proverKindOf = (keyLocation: string): KeyLocation['kind'] => {
  const located = keyLocationOf(keyLocation);
  if (located === null) {
    throw new Error(`"${keyLocation}" names neither a contract's circuit nor one of the network's own, so no prover was asked `
      + 'and no proof was made.');
  }
  if (located.kind === 'contract' && located.verifierKeyHash === null) {
    throw new Error(`"${keyLocation}" names a contract's circuit without the verifying key it is proved against, so no `
      + 'prover was asked and no proof was made.');
  }
  return located.kind;
};

/**
 * The prover package for a key location: zkir-v3 for a contract's circuit, zkir-v2 for one of the network's own.
 * Refuses a key location `proverKindOf` refuses, before anything is loaded.
 */
export function zkirEngineFor(keyLocation: string, engines: ZkirEngines = ZKIR_ENGINES): Promise<ZkirEngine> {
  try {
    return engines[proverKindOf(keyLocation)]();
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * The one prover choice: a proving provider that sends each circuit to the prover its key location names, and
 * refuses a key location `proverKindOf` refuses before anything is proved or fetched. `lookupKey` answers from the source itself,
 * because the ledger asks the provider for keys as well as proofs.
 */
export function provingProviderFor(source: KeyMaterialSource, engines: ZkirEngines = ZKIR_ENGINES): ProvingProvider {
  const km = namingFailures(source);
  const started = new Map<KeyLocation['kind'], Promise<Pick<ProvingProvider, 'check' | 'prove'>>>();
  const proverFor = async (keyLocation: string): Promise<Pick<ProvingProvider, 'check' | 'prove'>> => {
    const kind = proverKindOf(keyLocation);
    let prover = started.get(kind);
    if (prover === undefined) {
      prover = zkirEngineFor(keyLocation, engines).then((engine) => engine.provingProvider(km));
      started.set(kind, prover);
      /* A prover that failed to load is not kept, so the next circuit tries again; this proof's failure is its own. */
      prover.catch(() => { started.delete(kind); });
    }
    return prover;
  };
  return {
    check: async (preimage, keyLocation) => (await proverFor(keyLocation)).check(preimage, keyLocation),
    prove: async (preimage, keyLocation, binding) => (await proverFor(keyLocation)).prove(preimage, keyLocation, binding),
    lookupKey: async (keyLocation) => {
      proverKindOf(keyLocation);
      return km.lookupKey(keyLocation);
    },
  };
}

/** A proof provider that proves in this process, with the prover choice above. */
export async function wasmProofProvider(source: KeyMaterialSource): Promise<ProofProvider> {
  const { createLedger9ProofProvider } = await import('@midnight-ntwrk/midnight-js-types');
  return createLedger9ProofProvider(provingProviderFor(source));
}

/**
 * The circuit id inside a key location, for a source that names its files by
 * circuit.
 *
 * A key location is not a circuit id. The prover asks for keys by a structured
 * reference:
 *
 *     contract:90a19bf2…d484/credit?vk=5ac4195f…4f84
 *     └── the deployed address ──┘ └circuit┘ └ verifier key hash ┘
 *
 * and a builtin of the network's by its path (`midnight/zswap/spend`). Only the
 * circuit names a file; the address and the hash say which deployment and which
 * compiled version the key must be, and a source that checks what it hands over
 * reads them for that.
 */
export const circuitOf = (keyLocation: string): string => {
  const afterPath = keyLocation.includes('/')
    ? keyLocation.slice(keyLocation.lastIndexOf('/') + 1)
    : keyLocation;
  const query = afterPath.indexOf('?');
  return query === -1 ? afterPath : afterPath.slice(0, query);
};

/**
 * A source backed by the compiled artefacts on disk.
 *
 * Node only — it imports `node:fs`. The browser gets a `fetch` implementation
 * of the same interface, which is the whole reason the interface exists.
 */
export async function fileKeyMaterialSource(
  artefactsDir: string,
  paramsDir: string,
): Promise<KeyMaterialSource> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  return {
    async lookupKey(keyLocation: string) {
      /*
       * The compiler writes three files per circuit under different
       * subdirectories, and the prover wants all three together.
       */
      const circuit = circuitOf(keyLocation);
      const [proverKey, verifierKey, ir] = await Promise.all([
        readFile(join(artefactsDir, 'keys', `${circuit}.prover`)),
        readFile(join(artefactsDir, 'keys', `${circuit}.verifier`)),
        readFile(join(artefactsDir, 'zkir', `${circuit}.bzkir`)),
      ]);
      return {
        proverKey: new Uint8Array(proverKey),
        verifierKey: new Uint8Array(verifierKey),
        ir: new Uint8Array(ir),
      };
    },

    async getParams(k: number) {
      /*
       * `bls_midnight_2p{k}` FIRST, THEN `bls_filecoin_2p{k}`.
       *
       * `bls_midnight_2p{k}` is what Midnight publishes. The older
       * `bls_filecoin_2p{k}` name is tried second because a machine filled
       * from the older download script holds only that one, and this source
       * reads the operator's own disk, never a service.
       *
       * For scale: k=13 is 1.5 MB, k=14 is 3.1 MB, k=15 is 6.3 MB, and each
       * size up doubles it.
       *
       * A size missing under both names is refused naming the folder and both
       * names looked for, so the reason says what to put where.
       */
      for (const name of [`bls_midnight_2p${k}`, `bls_filecoin_2p${k}`]) {
        try {
          return new Uint8Array(await readFile(join(paramsDir, name)));
        } catch { /* try the other spelling */ }
      }
      throw new Error(
        `no parameter file for k=${k} in ${paramsDir} ` +
          `(looked for bls_midnight_2p${k} and bls_filecoin_2p${k})`,
      );
    },
  };
}
