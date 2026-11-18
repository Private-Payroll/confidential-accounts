/**
 * **THE PROVER PASSES ON WHAT ITS SOURCE SAID, AND ADDS NO ADVICE THAT FITS ONLY
 * ONE SOURCE.** The same prover reads its files off the disk in a script and
 * over the network in a browser, so advice that fits one (copy the files onto
 * this disk) is wrong for the other (a browser never reads a disk), and would sit
 * under the reasons that actually matter.
 */
import { describe, it, expect } from 'vitest';
import { provingProviderFor, type KeyMaterialSource } from './wasm-proving.js';

describe('A PARAMETER FILE THAT DID NOT ARRIVE', () => {
  it('READS AS THE SOURCE SAID IT, WITH THE SIZE, AND WITH NOTHING ADDED', async () => {
    /* RED WHEN: the prover appends its own advice to the source's reasons - it then tells a browser's user to copy
     * files onto a disk the browser never reads. */
    const why = 'the public parameters are not available (k=15). bls_midnight_2p15: 404 for /p/bls_midnight_2p15';
    let handed: KeyMaterialSource | null = null;
    const prover = provingProviderFor({
      lookupKey: async () => undefined,
      getParams: async () => { throw new Error(why); },
    }, {
      contract: async () => ({
        provingProvider: (km) => { handed = km; return { check: async () => [], prove: async () => new Uint8Array() }; },
        Zkir: { deserialize: () => ({ getK: () => 15 }) },
      }),
      network: async () => { throw new Error('a contract circuit never loads the network prover'); },
    });
    await prover.check(new Uint8Array(), `contract:${'ab'.repeat(32)}/payout?vk=${'cd'.repeat(32)}`);
    const said = await handed!.getParams(15).then(() => '', (e: Error) => e.message);
    expect(said).toBe(`could not load the SRS for k=15: ${why}`);
  });
});
