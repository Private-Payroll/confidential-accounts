/**
 * Proving in this process, with no proof server.
 *
 * Proving never leaves the customer's control, because the
 * proof preimage IS the private input — the balance, the amount, the signer's
 * secret key. That rules out a hosted proving pool and raises the obvious
 * question: can the customer's own machine do it, and can that machine be a
 * browser tab?
 *
 * `@midnight-ntwrk/zkir-v2` says yes. It ships the prover as WASM with a
 * browser entry point declared separately from the Node one, and exports
 * `provingProvider(km)` returning exactly the `ProvingProvider` shape that
 * `createProofProvider` consumes. So this file is small on purpose: the SDK
 * already has the seam, and all that was missing is a `KeyMaterialProvider`.
 *
 * THE SAME CODE IS THE WEB APP'S. Only two things change in a browser: the
 * WASM loads by `fetch` rather than `readFileSync` (the package's own export
 * map handles that), and the artefacts arrive over HTTP rather than off disk —
 * which is what `KeyMaterialSource` below abstracts.
 */
import type { ProofProvider } from '@midnight-ntwrk/midnight-js-types';

/** The three artefacts the prover needs for one circuit. */
export interface ProvingKeyMaterial {
  proverKey: Uint8Array;
  verifierKey: Uint8Array;
  ir: Uint8Array;
}

/**
 * Where the artefacts come from.
 *
 * On a script this is the filesystem; in a browser it is `fetch` against a CDN.
 * Nothing here is secret — prover keys, verifier keys, IR and the SRS are all
 * public — which is exactly why serving them costs nothing in privacy terms and
 * why the private input never has to leave the device.
 */
export interface KeyMaterialSource {
  lookupKey(keyLocation: string): Promise<ProvingKeyMaterial | undefined>;
  /**
   * The structured reference string covering 2^k rows.
   *
   * The sizes a build needs are read from its compiled circuits
   * (`parametersNeeded` on the service); the file for k holds about 2^k rows
   * of public parameters, and none is on disk until something fetches it.
   */
  getParams(k: number): Promise<Uint8Array>;
}

/**
 * Builds a `ProofProvider` that proves in this process.
 *
 * Deliberately takes the source as an argument rather than reading files
 * itself: that is the one thing that differs between a script and a browser,
 * and keeping it out here means the browser build reuses this untouched.
 */
export async function wasmProofProvider(source: KeyMaterialSource): Promise<ProofProvider> {
  /*
   * Imported dynamically so that merely importing this module does not
   * instantiate a 2.1 MB WASM binary. Callers that never prove — the test
   * suite, the type checker — should not pay for it.
   */
  const zkir: any = await import('@midnight-ntwrk/zkir-v2');
  const { createProofProvider } = await import('@midnight-ntwrk/midnight-js-types');

  /*
   * The WASM reaches back into this object for every artefact it needs, so it
   * must present exactly the shape zkir expects and must not throw across the
   * boundary in a way WASM cannot describe. Errors are re-thrown with the
   * circuit named, because the alternative is a WASM trap that says nothing.
   */
  const km = {
    async lookupKey(keyLocation: string) {
      try {
        return await source.lookupKey(keyLocation);
      } catch (e) {
        throw new Error(`could not load proving material for "${keyLocation}": ${String((e as any)?.message ?? e)}`);
      }
    },
    async getParams(k: number) {
      try {
        return await source.getParams(k);
      } catch (e) {
        /* The source says what it tried and why each failed; nothing is added that fits only one source. */
        throw new Error(`could not load the SRS for k=${k}: ${String((e as any)?.message ?? e)}`);
      }
    },
  };

  /*
   * TWO DIFFERENT TYPES CALLED `ProvingProvider`, and they are not the same.
   *
   *   @midnight-ntwrk/zkir-v2   { check, prove }
   *   @midnightntwrk/ledger-v9  { check, prove, lookupKey }
   *
   * `zkir.provingProvider(km)` returns the first. `createProofProvider` wants
   * the second, and the difference is one method — so passing the zkir one
   * through fails at the first circuit call with:
   *
   *     expected proving provider property 'lookupKey' to be a function
   *
   * which names the missing method and nothing about why. The fix is to compose
   * rather than to pass through: zkir does the proving, and `lookupKey` comes
   * straight from the key material provider, which is where it was all along.
   *
   * TypeScript does not catch the difference: both packages export a type of
   * that name, the call is made through `as any`, and structural typing would
   * accept the narrower object were the extra method optional, so only a
   * circuit call that runs shows it.
   */
  const proving = zkir.provingProvider(km);

  return createProofProvider({
    check: (preimage: Uint8Array, keyLocation: string) => proving.check(preimage, keyLocation),
    prove: (preimage: Uint8Array, keyLocation: string, binding?: bigint) =>
      proving.prove(preimage, keyLocation, binding),
    lookupKey: (keyLocation: string) => km.lookupKey(keyLocation),
  } as any);
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
        readFile(join(artefactsDir, 'zkir', `${circuit}.bzkir`)).catch(() =>
          readFile(join(artefactsDir, 'zkir', `${circuit}.zkir`)),
        ),
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
