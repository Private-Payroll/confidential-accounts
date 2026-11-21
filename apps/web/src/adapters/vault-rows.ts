import type { PageView } from './filing-judge.js';
import { VAULT, type VaultRow, type VaultStanding } from './company-rows.js';
import { vaultListOf } from './company-vaults-read.js';
import { wasRead } from './reads.js';
import { sealedIn } from './filing-judge.js';
import { keyringFor } from './keyring-person.js';

/*
 * THE COMPANY'S VAULTS AND WHERE EACH STANDS: the vaults its account has
 * adopted, as the person's own wallet reads them off the chain, each with when
 * the service says it was made and where its set-up stands
 * (`vaultsAsTheChainHoldsThem`). Read on its own, for what only needs to know
 * which vaults there are: the setup steps, and creating a vault. Nothing is
 * opened.
 */

/**
 * A VAULT HANDED TO THE COMPANY'S SUPER ADMINS: the chain shows the committee
 * holding it. Whether money can go in is another matter, said by its
 * standing. A vault held by keys that are not the committee now, not yet on
 * the chain, not finished, or of a standing not known, is not one.
 */
const HANDED_OVER: ReadonlySet<VaultStanding> = new Set([VAULT.held, VAULT.notFundable, VAULT.accountNotHandedOver, VAULT.accountNotFundable]);

/** Whether `vault` was handed over when it was created. */
export const wasHandedOver = (vault: Pick<VaultRow, 'standing'>): boolean => HANDED_OVER.has(vault.standing);

/** The company `companyId`'s vaults, for the person `personId`, read through the view this page has open of it, or null when they could not be read. */
export async function readVaultRows(personId: string, view: PageView): Promise<readonly VaultRow[] | null> {
  try {
    if (!(await keyringFor(personId))) return null;
    const list = await vaultListOf(view, await sealedIn(view));
    return wasRead(list) ? list.value : null;
  } catch {
    return null;
  }
}
