/**
 * WHAT THE DOOR THAT DEPLOYS THE PRIVATE REGISTRY BUILDS, AND WHAT IT ACCEPTS AS PROOF THAT NO ONE
 * CAN CHANGE IT.
 *
 * The registry holds every person's way back to their companies, so no one, us included, may ever
 * replace its rules. It is deployed held by no keys at threshold exactly one: the authority the chain
 * itself starts a contract with, which no maintenance update can satisfy. Threshold nothing would let
 * anyone change it; any key would let that key's holder change it. The door deploys and spends a fee,
 * so its decisions are here, in plain values, where each can be watched refusing without a chain.
 */
import REGISTRY_INFO from '../contracts/managed-registry/compiler/contract-info.json' with { type: 'json' };

/** The registry's holders: no keys, at threshold exactly one; the one value the assembly builds no keys from. */
export { NO_OWNER } from '../src/midnight/held-from-the-start.js';

/** The circuits the registry is deployed with, each with its verifying key: every proving circuit the compiled registry has. */
export const REGISTRY_CIRCUITS: readonly string[] = Object.freeze(
  REGISTRY_INFO.circuits.filter((c) => c.proof).map((c) => c.name)
);

/** Whether the registry read back is held by no keys at threshold exactly one: the one check, shared with the wallet's restore. */
export { registryAuthorityRefusal } from '../src/wiring/registry-call-checks.js';

/** What has to be on this machine before the registry can be deployed. */
export interface RegistryDeployPreconditions {
  /** A wallet holding NIGHT and generating DUST, whose seed this machine has: it pays the deploy's fee. */
  readonly fundedSeed: boolean;
  /** The registry's proving and verifier keys, built from this code by this compiler in the default key format. */
  readonly keys: boolean;
  /** A proof server this machine can reach. */
  readonly proofServer: boolean;
}

const WHAT_IS_MISSING: Record<keyof RegistryDeployPreconditions, string> = {
  fundedSeed: "no funded wallet seed for this network on this machine; the deploy's fee is paid from it",
  keys: "the registry's proving and verifier keys are missing, or were not built from this code in the default format; `npm run compact` builds them",
  proofServer: 'no proof server answers on this machine; start it, then run this again'
};

/** Null when everything is in place; otherwise every missing piece, each with what resolves it. Nothing is spent either way. */
export function registryDeployMissing(present: RegistryDeployPreconditions): string | null {
  const missing = (Object.keys(WHAT_IS_MISSING) as (keyof RegistryDeployPreconditions)[]).filter((k) => !present[k]);
  return missing.length === 0
    ? null
    : `nothing was deployed:\n${missing.map((k) => `  - ${WHAT_IS_MISSING[k]}`).join('\n')}`;
}

/**
 * What the door says when anything fails once the deploy has been sent: the registry may already be
 * on the chain at this address, its fee spent, so the address is named and a second deploy is
 * warned against until the address has been looked up.
 */
export function afterSendingRefusal(address: string, why: string): string {
  return (
    `${why}\n  The deploy was sent and may have landed: the registry may already be at ${address}. ` +
    'DO NOT DEPLOY AGAIN until that address has been looked up on the chain; a second run deploys a second registry.'
  );
}
