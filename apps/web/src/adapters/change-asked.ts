/**
 * THE CHANGES `whatAChangeCosts` PRICES, by the core's own name for each kind, and the three changes of who is seated
 * it tells apart. Passed to it and never shown. Kept apart from the shared code so the first download can name them
 * without loading the code that prices them.
 */
export const CHANGE_ASKED = {
  seating: 'seating', vaultThreshold: 'vault-threshold', spendingPolicy: 'spending-policy', policyBar: 'policy-bar',
} as const;

/** A change of who is seated: a signer added, removed, or put in a seat again. */
export const SEAT_CHANGE = { add: 'add', remove: 'remove', reseat: 'reseat' } as const;
