import type { AccountBuilding } from '../chain/account-builder-client.js';
import { liveRegistryReads, registryEntriesFound, type RegistryFinder } from '../chain/private-registry-on-chain.js';
import { pinCompany, pinnedFor } from './company-pin.js';
import type { CompanyChain } from './company-reach.js';
import type { StepContext } from './definition.js';

/**
 * **A PIN PUT BACK FROM THE PERSON'S OWN REGISTRY ENTRY**, when a reach finds no pin for the page's label. The entries
 * are found and judged on the chain (`registryEntriesFound`); this keeps the one account judged for that label, as
 * `restored`, through the pin's one writer. It never pins a label whose entries name two accounts, nor anything while a
 * registry the network lists could not be read (a second account could sit in it), and it leaves a label already
 * pinned as it is. It reads nothing from our service.
 */

/** What putting a pin back did. */
export type PinRestored =
  | { readonly of: 'pinned'; readonly account: string }
  | { readonly of: 'already-pinned' }
  | { readonly of: 'clash' }
  | { readonly of: 'unread' }
  | { readonly of: 'none' }
  | { readonly of: 'not-open' };

/** Pins `label` to the one account the person's entries name for it and the chain bears out, if there is one. */
export async function pinRestoredFor(
  ctx: Pick<StepContext, 'held' | 'keyring'>,
  label: string,
  find: RegistryFinder
): Promise<PinRestored> {
  const before = pinnedFor(ctx, label);
  if (before.of === 'not-open') return { of: 'not-open' };
  if (before.of === 'pinned') return { of: 'already-pinned' };
  let found: Awaited<ReturnType<RegistryFinder>>;
  try {
    found = await find(ctx.held.identity);
  } catch {
    /* A find that could not finish saw only part of the entries: nothing is pinned from it, and it is answered as unread. */
    return { of: 'unread' };
  }
  if (found.of !== 'read') return { of: 'none' };
  if (found.clashes.some((c) => c.label === label)) return { of: 'clash' };
  if (found.passedOver.some((p) => p.why === 'unread')) return { of: 'unread' };
  const company = found.companies.find((c) => c.label === label);
  if (company === undefined) return { of: 'none' };
  const written = await pinCompany(ctx, label, company.account, 'restored');
  if (written.of === 'pinned') return { of: 'pinned', account: written.held.account };
  return written.of === 'another' ? { of: 'already-pinned' } : { of: 'not-open' };
}

/**
 * The find a reach's head puts a pin back with: over the chain's own registry doors (its network and builder) and its
 * indexer. Null for a chain with no registry doors, which restores nothing.
 */
export function restoreFinderOf(chain: Pick<CompanyChain, 'indexer' | 'registryEntry'>): RegistryFinder | null {
  const doors = chain.registryEntry;
  if (doors === undefined) return null;
  const build: AccountBuilding = (ask) => doors.build()(ask);
  return (identity) =>
    registryEntriesFound(identity, doors.network, liveRegistryReads(doors.network, chain.indexer.indexerUri, build));
}
