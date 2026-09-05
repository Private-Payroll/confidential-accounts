/**
 * Proving in this process, with no proof server. M-77, decision 0007.
 *
 * Decision 0007 says proving never leaves the customer's control, because the
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
   * Our largest circuit is k=15, measured from the compiled IR — small. The
   * proof server downloads these itself, which is why there is no copy on disk
   * until something extracts one.
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
        throw new Error(
          `could not load the SRS for k=${k}: ${String((e as any)?.message ?? e)}\n` +
            '  These are public parameters the proof server normally downloads for itself.\n' +
            '  Run EXTRACT-PARAMS.command once to copy them out of the proof server image.',
        );
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
   * Worth noticing that TypeScript could not catch this. Both packages export a
   * type of the same name, the call site had an `as any` on it, and structural
   * typing would have accepted the narrower object anyway if the extra method
   * were optional. It had to be run.
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

  /**
   * The circuit id inside a key location.
   *
   * `keyLocation` is NOT a circuit id, which is what the first version assumed.
   * The SDK asks for keys by a structured reference:
   *
   *     contract:90a19bf2…d484/credit?vk=5ac4195f…4f84
   *     └── the deployed address ──┘ └circuit┘ └ verifier key hash ┘
   *
   * Treating that as a filename produced a genuinely absurd path and an ENOENT
   * naming it in full, which at least made the shape obvious the moment it ran.
   *
   * The two extra parts are not noise: the address scopes the key to a
   * deployment and the `vk` hash identifies exactly which compiled version it
   * belongs to. That is precisely what a browser needs in order to cache keys
   * safely — a key fetched for one contract version must never be reused for
   * another, and this string is what makes that checkable.
   */
  const circuitOf = (keyLocation: string): string => {
    const afterPath = keyLocation.includes('/')
      ? keyLocation.slice(keyLocation.lastIndexOf('/') + 1)
      : keyLocation;
    const query = afterPath.indexOf('?');
    return query === -1 ? afterPath : afterPath.slice(0, query);
  };

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
       * `bls_midnight_2p{k}`, NOT `bls_filecoin_2p{k}`.
       *
       * The proof server's own fetch script downloads `bls_filecoin_*` from S3,
       * and that is what the first version of this looked for. What is actually
       * in the running container's cache is `bls_midnight_*` — the Foundation
       * renamed them, and the download script is behind. Both names are tried
       * because a machine populated from S3 will have the other one.
       *
       * Sizes, from the container: k=13 is 1.5 MB, k=14 is 3.1 MB, k=15 is
       * 6.3 MB. That last one is the number that matters for a browser, and it
       * is four times my earlier estimate — still fine, but measured now
       * rather than guessed.
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
