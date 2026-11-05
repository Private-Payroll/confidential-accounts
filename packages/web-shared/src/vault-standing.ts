/**
 * WHERE A VAULT STANDS, AND WHICH STANDING THE SERVICE FUNDS.
 *
 * The service names a vault's standing in one of a fixed set of words and a
 * screen says each in its own. Money may go into a vault in exactly one
 * standing, the one where the committee holds it; every other standing is one
 * the service refuses. The service and the page both ask this one question, so
 * a standing added later is refused on both until it is named here as funded.
 */

/** Every standing a vault can be reported in. */
export const VAULT = {
  held: 'held-by-committee', startOwed: 'start-owed', notOnChain: 'not-on-chain-yet', notFundable: 'not-fundable',
  accountNotHandedOver: 'account-not-handed-over', accountNotFundable: 'account-not-fundable', heldByOtherKeys: 'held-by-other-keys', unknown: 'unknown',
} as const;
export type VaultStanding = (typeof VAULT)[keyof typeof VAULT];

/** Whether money may go into a vault in this standing: only when the committee holds it. */
export const vaultStandingIsFunded = (standing: string): boolean => standing === VAULT.held;
