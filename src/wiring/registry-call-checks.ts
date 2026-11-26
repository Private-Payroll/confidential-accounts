/**
 * **THE ONE SHAPE A CALL TO A PRIVATE REGISTRY MUST HAVE BEFORE IT IS PAID FOR OR SENT**: one call to the registry's
 * `put`, at a registry the network lists, moving no coin, public money or DUST, and calling nothing else. Read by the
 * company's fee payer before it adds a fee and by the person's wallet before it sends the call itself. Also whether a
 * registry is held by no one, read by the door that deploys it and by the wallet before it reads a person's entries.
 */
import type { AuthorityRead } from '../midnight/contract-authority-read.js';
import { refusalForProven, refusalUnlessOnlyACallTo } from './proven-submission.js';

/** The registry's one write, as its contract names it. */
export const REGISTRY_PUT = 'put';

const bare = (a: string): string => a.trim().toLowerCase().replace(/^0x/u, '');

/** Whether `address` is one of the registries the network lists. */
export const isListedRegistry = (registries: readonly string[] | undefined, address: string): boolean =>
  (registries ?? []).some((r) => bare(r) === bare(address));

/** Why `tx` is not one `put` to the registry at `registry` moving nothing, or null when it is. */
export const registryPutRefusal = (tx: unknown, registry: string): string | null =>
  refusalForProven(tx, registry) ?? refusalUnlessOnlyACallTo(tx, REGISTRY_PUT);

/**
 * Null when the authority read back from the chain at a registry's address is no keys at threshold
 * exactly one; otherwise why that registry is not one no one can change. The read's shape (`authorityShapeOf`) is
 * `no-one` for no keys at any threshold from one, and for a threshold above the keys; threshold one is
 * asked for besides, so the registry holds exactly the authority the chain starts a contract with. A
 * read that could not be made is refused too: an authority nobody has seen is not one anybody can vouch for.
 */
export function registryAuthorityRefusal(read: AuthorityRead): string | null {
  if (read.state !== 'read') return `the registry's authority could not be read back (${read.why})`;
  const { committee, threshold, shape } = read.authority;
  if (shape !== 'no-one' || threshold !== 1) {
    return `the registry at ${read.address} is held by ${committee.length} key(s) at threshold ${threshold}, `
      + 'not by no keys at threshold one, so someone could change its rules. Do not record this address.';
  }
  return null;
}
