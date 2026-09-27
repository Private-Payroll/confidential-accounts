/**
 * **THE PROVER PASSES ON WHAT ITS SOURCE SAID, AND ADDS NO ADVICE THAT FITS ONLY
 * ONE SOURCE.** The same prover reads its files off the disk in a script and
 * over the network in a browser. When the public parameters did not arrive in a
 * browser, the person was told to run a step that copies files onto a disk -
 * which a browser never reads - under the reasons that actually mattered.
 */
import { describe, it, expect, vi } from 'vitest';

let handed: { getParams(k: number): Promise<Uint8Array> } | null = null;
vi.mock('@midnight-ntwrk/zkir-v2', () => ({
  provingProvider: (km: typeof handed) => { handed = km; return { check: async () => [], prove: async () => new Uint8Array() }; },
}));

describe('A PARAMETER FILE THAT DID NOT ARRIVE', () => {
  it('READS AS THE SOURCE SAID IT, WITH THE SIZE, AND WITH NOTHING ADDED', async () => {
    /* RED WHEN: the prover appends its own advice to the source's reasons - it then tells a browser's user to copy
     * files onto a disk the browser never reads. */
    const { wasmProofProvider } = await import('./wasm-proving.js');
    const why = 'the public parameters are not available (k=15). bls_midnight_2p15: 404 for /p/bls_midnight_2p15';
    await wasmProofProvider({
      lookupKey: async () => undefined,
      getParams: async () => { throw new Error(why); },
    } as never);
    const said = await handed!.getParams(15).then(() => '', (e: Error) => e.message);
    expect(said).toBe(`could not load the SRS for k=15: ${why}`);
  });
});
