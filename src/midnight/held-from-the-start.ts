import { requireBuildableAuthority } from './authority-replacement.js';
import type { TaggedKey } from './partial-contract.js';
import type { ContractCalls } from '../../packages/web-shared/src/contract-call-built.js';

/**
 * **A CONTRACT'S STATE AT DEPLOY, HELD BY THE KEYS GIVEN FROM ITS FIRST
 * TRANSACTION.** One assembly for a company's account, for every vault and for
 * the private registry, run by the signer's device or a deploy door to build
 * the deploy and by this service to read it:
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
 * constructor that made coins, and a circuit the build has no key for. No keys
 * is built only for the one `NO_OWNER` value, which is no keys at threshold
 * exactly one: the authority the chain itself starts a contract with, which no
 * maintenance update can ever satisfy, so no one can change the contract's
 * rules. A threshold of nothing would let anyone change them.
 *
 * **THIS FILE LOADS NO WEBASSEMBLY.** The ledger, the contract runtime and the
 * SDK are handed in.
 */
export interface HeldStateDeps {
  /** `@midnightntwrk/ledger-v9`. */
  readonly ledger: any;
  /** `@midnight-ntwrk/compact-runtime`'s `ContractState`. */
  readonly runtimeState: any;
  /** The deploy builder (`contractCallsOf`): Midnight.js's deploy, with the ledger's and the runtime's readings of it. */
  readonly contracts: Pick<ContractCalls, 'buildDeploy'>;
  /** The network the deploy is built for, by name. */
  readonly network: string;
  readonly random?: (n: number) => Uint8Array;
}

export interface Holders {
  readonly committee: readonly TaggedKey[];
  readonly threshold: number;
}

declare const noOwnerBrand: unique symbol;

/** No one: no keys at threshold one. Only the one `NO_OWNER` value below is it; no other file can build one. */
export interface NoOwner {
  readonly committee: readonly [];
  readonly threshold: 1;
  readonly [noOwnerBrand]: true;
}

/**
 * The holders of a contract no one may ever maintain. The assembly accepts no keys from this one
 * frozen value alone, compared by identity, so any other holders with no keys are refused when the
 * deploy is built, whatever their type says.
 */
export const NO_OWNER: NoOwner = Object.freeze({ committee: Object.freeze([]) as readonly [], threshold: 1 }) as NoOwner;

/** The keys and threshold to build: no keys only from `NO_OWNER` itself, and every other holders by the product's rule. */
const buildableHolders = (given: Holders | NoOwner): { committee: TaggedKey[]; threshold: number } => {
  const deliberate = given === NO_OWNER;
  if (deliberate && (NO_OWNER.committee.length !== 0 || NO_OWNER.threshold !== 1)) {
    throw new Error('a contract no one maintains is held by no keys at threshold exactly one, and this is not that. Nothing was built.');
  }
  return requireBuildableAuthority(given.committee, given.threshold, { emptyCommitteeIsDeliberate: deliberate });
};

export async function heldStateFromTheStart(
  deps: HeldStateDeps,
  input: {
    readonly compiled: unknown;
    /** Hands out this build's verifying key for each circuit. */
    readonly zkConfig: unknown;
    readonly args: readonly unknown[];
    readonly circuits: readonly string[];
    readonly holders: Holders | NoOwner;
  },
): Promise<any> {
  const L = deps.ledger;
  const holders = buildableHolders(input.holders);
  /* Coin keys the constructor's runtime asks for, made from randomness this function drops. A constructor that
   * made a coin is refused below, so nothing is ever sent to them. */
  const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
  const keys = L.ZswapSecretKeys.fromSeed(seed);
  seed.fill(0);
  const built = await deps.contracts.buildDeploy(
    input.zkConfig, keys.coinPublicKey, { compiledContract: input.compiled, args: [...input.args] }, keys.encryptionPublicKey, deps.network);
  try { keys.clear?.(); } catch { /* nothing to clear */ }
  const unproven = built.private.transaction as { guaranteedOffer?: unknown; fallibleOffer?: unknown };
  if ((built.private.newCoins?.length ?? 0) > 0 || unproven.guaranteedOffer || unproven.fallibleOffer) {
    throw new Error('the contract\'s constructor made coins, and a deploy built here carries none. Nothing was built.');
  }
  const full = built.public.initialContractState as {
    data: unknown; operation(name: string): { verifierKey?: unknown } | undefined;
  };
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
