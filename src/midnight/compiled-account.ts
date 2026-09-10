/**
 * THE COMPILED ACCOUNT CONTRACT, ASSEMBLED IN ONE PLACE.
 *
 * A write is a proof, and a proof is against this. It is the contract's
 * generated code, the witnesses that answer for a device's private state, and
 * the proving and verifier keys on disk, joined into the one object the deploy
 * and call paths both take.
 *
 * -- WHY IT IS A FILE AND NOT THREE LINES AT EACH CALL SITE -----------------
 *
 * Because it was three lines at each call site, twice, and a third caller
 * needed it. The three steps are ordered and one of them is a mistake that has
 * already cost a round: handing the SDK a `new Contract(...)` INSTANCE instead
 * of a compiled contract fails several layers down in a message that names none
 * of this.
 *
 * -- WHY EVERY IMPORT IS DYNAMIC --------------------------------------------
 *
 * The contract's generated code reaches a WebAssembly runtime. A browser page
 * that loads that runtime does not start, and the module graph is what decides
 * whether it is loaded - not whether the function is called. So nothing here is
 * imported at the top, which means this module can be loaded, and its types
 * checked, by a process that will never prove anything.
 *
 * -- WHAT IT DOES NOT DO ----------------------------------------------------
 *
 * **IT DOES NOT COMPILE ANYTHING AND IT DOES NOT CHECK THAT THE ARTEFACTS ARE
 * FRESH.** The keys on disk are produced by a compile a person runs, and
 * whether they match the sources is a question a gate already asks elsewhere.
 * Answering it a second time here would be a second answer to keep in step.
 */

/** Where the compiled artefacts live. `contracts/managed`. */
export type ArtifactsPath = string;

/**
 * Build the compiled account contract.
 *
 * The order is the SDK's and is not interchangeable: make from the generated
 * constructor, then attach the witnesses, then attach the assets on disk.
 */
export async function compiledAccountContract(artifacts: ArtifactsPath): Promise<unknown> {
  const [CompiledContract, generated, witnessModule] = await Promise.all([
    import('@midnight-ntwrk/compact-js/effect/CompiledContract'),
    import('../../contracts/managed/contract/index.js'),
    import('../../contracts/src/witnesses.js'),
  ]);
  return (CompiledContract as any).make('ConfidentialAccount', (generated as any).Contract).pipe(
    (CompiledContract as any).withWitnesses((witnessModule as any).witnesses),
    (CompiledContract as any).withCompiledFileAssets(artifacts),
  );
}
