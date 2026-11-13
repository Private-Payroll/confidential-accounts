/**
 * The outcome shapes several actions share: what an upkeep, a waiting retirement and a change of the vault secrets tell the page.
 */

/** What a seat action's upkeep says it did: all done, or some left for the next action; and how many records it anchored. */
export const UPKEEP_OUTCOME = Object.freeze({ upkeep: 'code' as const, anchored: 'count' as const });

/** How many seats have signed the leaving seat's retirement, and how many it needs, while a removal waits on it. */
export const RETIREMENT_OUTCOME = Object.freeze({ retirementSigned: 'count' as const, retirementNeeded: 'count' as const });

/** What changing the vault secrets tells the page: how many vaults ended in each state, never which. */
export const VAULTS_CHANGED_OUTCOME = Object.freeze({
  vaultsRotated: 'count' as const, vaultsAwaiting: 'count' as const, vaultsOwed: 'count' as const, vaultsWaiting: 'count' as const,
  vaultsNotChanged: 'count' as const,
});
