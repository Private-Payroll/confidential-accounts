/**
 * **THE VERIFYING KEYS A CALL IS BUILT WITH, OVER THE CACHE THE PROVER
 * ALREADY USES.**
 *
 * -- WHY THIS IS AN ADAPTER AND NOT A FETCHER ------------------------------
 *
 * Two different parts of building and proving a call ask for the same
 * artefacts, through two different interfaces:
 *
 *   BUILDING   asks for a circuit's VERIFYING KEY, by circuit name, while it
 *              assembles the transaction.
 *   PROVING    asks for the proving key, the verifying key and the circuit
 *              together, by the key location the preimage carries.
 *
 * `key-material.ts` already answers the second: it fetches over HTTP, reports
 * honest progress against a real byte count, and keeps what it fetched across
 * sessions. **The first must not become a second thing that downloads.** The
 * proving key for one circuit is eighteen megabytes; fetching it twice is a
 * first approval that takes twice as long for no reason anybody can see, on a
 * connection the person is already waiting on.
 *
 * So nothing here fetches. Every byte comes back through the one source it is
 * handed, which is the one the prover uses, filed under the one set of cache
 * keys.
 *
 * -- AND IT ASKS FOR ONE ARTEFACT, NOT THREE -------------------------------
 *
 * Building a call reads verifying keys and nothing else. An adapter that
 * answered a verifying-key request by asking for all three would pull eighteen
 * megabytes of proving key to hand back a few hundred kilobytes, before the
 * person has approved anything. That is why the source exposes the kinds
 * separately and why each method here asks for exactly the one it was asked
 * for.
 *
 * -- THE ONE THING A CALLER MUST DECIDE, AND IT IS NOT DEFAULTED -----------
 *
 * Artefacts are cached under a key location, which carries the deployed
 * contract address and a hash of the deployed verifying key, so a key fetched
 * for one version of a contract can never be served for another. **The
 * interface used while a call is BUILT carries no such thing: it names the
 * circuit and nothing else.** There is therefore no way for this adapter to
 * know, on its own, which deployment a request is about.
 *
 * That is a decision with a cost either way, so it is a required argument
 * rather than a default. `byCircuitName` below is the honest cheap answer and
 * says at every call site what it gives up.
 *
 * -- THE BRANDS ARE COMPILE-TIME AND THE CASTS SAY SO ----------------------
 *
 * The key types are `Uint8Array` with a phantom property, and the package's own
 * constructors for them are identity functions. Calling them would mean
 * importing that package at run time, which pulls the wallet SDK's ledger
 * module - ten megabytes of WebAssembly - into whatever loads this. The casts
 * below are that same identity, without the import.
 */
import type { ProverKey, VerifierKey, ZKConfig, ZKConfigProvider, ZKIR } from '@midnight-ntwrk/midnight-js-types';

import type { ArtefactKind, ArtefactSource } from './key-material.js';

/**
 * How a circuit name becomes the location its artefacts are filed under.
 *
 * A function rather than a string, because the answer depends on what the
 * caller knows about the deployment it is building against.
 */
export type LocationForCircuit = (circuitId: string) => string;

/**
 * **FILE THEM UNDER THE CIRCUIT NAME ALONE, AND HERE IS WHAT THAT COSTS.**
 *
 * The artefacts served for a circuit belong to whichever compilation of the
 * contract the application is serving, and this application serves one. So the
 * name is enough to fetch the right bytes today.
 *
 * What it gives up is the check, and the cost is worth stating exactly rather
 * than as "less safe". A location carries the deployed address and a hash of
 * the deployed verifying key, so a cached entry under one can never be served
 * for another deployment. **An entry under a bare circuit name has nothing in
 * it that changes when the contract is recompiled or redeployed, and the cache
 * behind it is durable and is never invalidated.** So a browser that has been
 * here before a redeploy keeps answering with the old verifying key for as long
 * as its site data survives.
 *
 * **WHAT THAT COSTS, AND IT IS NOT A LOST FEE.** The client compares the
 * deployed verifying keys against the compiled ones before it builds anything,
 * so a stale key is refused locally, before a proof and before a fee. It is
 * refused on EVERY governed call, on that browser, until somebody clears the
 * site's stored data - which is a repair no customer will find. The bytes a
 * PROOF is built from are filed under the full location and are unaffected.
 *
 * Named at the call site so that whoever wires this has said it out loud, and
 * a caller that can name the deployment should pass its own mapping instead.
 */
export const byCircuitName: LocationForCircuit = (circuitId) => circuitId;

/**
 * Builds the provider a call is assembled with, over an existing source.
 *
 * Returns a plain object rather than extending the package's class, so that
 * nothing here imports that package at run time. The shape is the whole of what
 * it is asked for.
 */
export const zkConfigOver = (
  source: ArtefactSource,
  locationFor: LocationForCircuit,
): ZKConfigProvider<string> => {
  /**
   * One request per artefact in flight, however many callers want it.
   *
   * The cache turns a second request into a read, but only once the first has
   * FINISHED. Assembling a transaction asks for every circuit's verifying key
   * at once, so without this the same key can be in the air twice and the
   * second copy is a download that the cache was supposed to have prevented.
   */
  const inFlight = new Map<string, Promise<Uint8Array>>();

  const atLocation = (kind: ArtefactKind, keyLocation: string): Promise<Uint8Array> => {
    const key = `${kind}:${keyLocation}`;
    const already = inFlight.get(key);
    if (already !== undefined) return already;

    const started = source.artefact(kind, keyLocation).finally(() => { inFlight.delete(key); });
    inFlight.set(key, started);
    return started;
  };

  /** For the three that are asked by CIRCUIT rather than by location. */
  const bytes = (kind: ArtefactKind, circuitId: string): Promise<Uint8Array> =>
    atLocation(kind, locationFor(circuitId));

  const provider: ZKConfigProvider<string> = {
    getProverKey: async (circuitId) => (await bytes('prover', circuitId)) as unknown as ProverKey,
    getVerifierKey: async (circuitId) => (await bytes('verifier', circuitId)) as unknown as VerifierKey,
    getZKIR: async (circuitId) => (await bytes('ir', circuitId)) as unknown as ZKIR,

    /*
     * Concurrent, because these are the small ones and they are asked for as a
     * set while a transaction is assembled. The proving key is not among them.
     */
    getVerifierKeys: async (circuitIds) =>
      Promise.all(circuitIds.map(async (id): Promise<[string, VerifierKey]> =>
        [id, await provider.getVerifierKey(id)])),

    get: async (circuitId): Promise<ZKConfig<string>> => {
      const [proverKey, verifierKey, zkir] = await Promise.all([
        provider.getProverKey(circuitId),
        provider.getVerifierKey(circuitId),
        provider.getZKIR(circuitId),
      ]);
      return { circuitId, proverKey, verifierKey, zkir };
    },

    /*
     * **ITS THREE METHODS TAKE A KEY LOCATION ALREADY, NOT A CIRCUIT NAME**,
     * because what asks for them is a wallet resolving the locations carried in
     * a transaction it was handed. So they go straight to the source, and must
     * NOT go through `locationFor` - a second application of it would turn a
     * location into something that names no artefact, and with the cheap
     * identity mapping in place that mistake is invisible until the day
     * somebody supplies a real one.
     */
    asKeyMaterialProvider: () => ({
      getZKIR: (circuitKeyLocation) => atLocation('ir', circuitKeyLocation),
      getProverKey: (circuitKeyLocation) => atLocation('prover', circuitKeyLocation),
      getVerifierKey: (circuitKeyLocation) => atLocation('verifier', circuitKeyLocation),
    }),
  };

  return provider;
};
