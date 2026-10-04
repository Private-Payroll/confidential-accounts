import { requireBuildableAuthority } from './authority-replacement.js';
import type { TaggedKey } from './partial-contract.js';

/**
 * **A CONTRACT'S STATE AT DEPLOY, HELD BY THE KEYS GIVEN FROM ITS FIRST
 * TRANSACTION.** One assembly for a company's account and for every vault, run
 * by the signer's device to build the deploy and by this service to read it:
 * the service builds the same state from what it recorded and compares the
 * deploy with it byte for byte, so the two can never disagree about what a
 * contract born held is.
 *
 * The constructor is run by the SDK exactly as a deploy runs it, with this
 * build's verifier keys. The SDK can only build a state held by one key it
 * makes up, so the state is assembled again here: the constructor's own data,
 * exactly the circuits named, and the holders given, at counter 0. The key the
 * SDK made up is in nothing assembled and is dropped with the rest of what the
 * SDK handed back.
 *
 * Refused before anything is assembled: holders this product will not build
 * (`requireBuildableAuthority`: a threshold of nothing, one above the keys, no
 * keys, a key twice, or more keys than the ledger's limit on an authority), a
 * constructor that made coins, and a circuit the build has no key for.
 *
 * **THIS FILE LOADS NO WEBASSEMBLY.** The ledger, the contract runtime and the
 * SDK are handed in.
 */
export interface HeldStateDeps {
  /** `@midnightntwrk/ledger-v9`. */
  readonly ledger: any;
  /** `@midnight-ntwrk/compact-runtime`'s `ContractState`. */
  readonly runtimeState: any;
  /** `createUnprovenDeployTxFromVerifierKeys`, from the SDK. */
  readonly contracts: { createUnprovenDeployTxFromVerifierKeys(...args: any[]): Promise<any> };
  readonly random?: (n: number) => Uint8Array;
}

export interface Holders {
  readonly committee: readonly TaggedKey[];
  readonly threshold: number;
}

export async function heldStateFromTheStart(
  deps: HeldStateDeps,
  input: {
    readonly compiled: unknown;
    /** Hands out this build's verifying key for each circuit. */
    readonly zkConfig: unknown;
    readonly args: readonly unknown[];
    readonly circuits: readonly string[];
    readonly holders: Holders;
  },
): Promise<any> {
  const L = deps.ledger;
  const holders = requireBuildableAuthority(input.holders.committee, input.holders.threshold, { emptyCommitteeIsDeliberate: false });
  /* Coin keys the constructor's runtime asks for, made from randomness this function drops. A constructor that
   * made a coin is refused below, so nothing is ever sent to them. */
  const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
  const keys = L.ZswapSecretKeys.fromSeed(seed);
  seed.fill(0);
  const built = await deps.contracts.createUnprovenDeployTxFromVerifierKeys(
    input.zkConfig, keys.coinPublicKey, { compiledContract: input.compiled, args: [...input.args] }, keys.encryptionPublicKey);
  try { keys.clear?.(); } catch { /* nothing to clear */ }
  const unproven = built.private.unprovenTx;
  if ((built.private.newCoins?.length ?? 0) > 0 || unproven.guaranteedOffer || unproven.fallibleOffer) {
    throw new Error('the contract\'s constructor made coins, and a deploy built here carries none. Nothing was built.');
  }
  const full = built.public.initialContractState;
  const state = new deps.runtimeState();
  state.data = full.data;
  for (const name of input.circuits) {
    const op = full.operation(name);
    if (!op || !op.verifierKey) {
      throw new Error(`circuit "${name}" has no verifying key in this build, so the contract cannot be deployed. Nothing was built.`);
    }
    state.setOperation(name, op);
  }
  const onLedger = L.ContractState.deserialize(state.serialize());
  onLedger.maintenanceAuthority = new L.ContractMaintenanceAuthority(holders.committee, holders.threshold, 0n);
  return onLedger;
}
