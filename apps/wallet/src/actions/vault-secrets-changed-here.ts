/**
 * **A COMPANY'S VAULT SECRETS CHANGED FROM THIS WALLET AFTER A SIGNER IS REMOVED.** Runs the one rotation
 * (`vaultSecretsRotatedHere`) for each vault the company's account has adopted on the chain and each it retired whose
 * secret is still kept (`retiredVaultsKeptHere`), or for the one vault asked,
 * on the doors a vault's secret is started on (`vaultDoorsFor`) and the company key's reads of who is leaving and who was
 * admitted. `raise` is a person's press: it makes a new secret, keeps it in this wallet and raises its run, carrying it
 * when the approvals are met; `finish` raises and approves nothing. What happened to each vault is counted for the page,
 * never named: the page is told how many vaults are on their new secret, wait for approvals, are owed a press, wait, or
 * could not be changed on this try (a proof or a send failed, or the action stopped part way).
 */
import type { Hex } from '../../../../src/core/crypto.js';
import type { RotationDoors } from '../../../../packages/web-shared/src/company-key-here.js';
import { vaultSecretsRotatedHere } from '../../../../packages/web-shared/src/vault-secret-rotated-here.js';
import type { CompanyReach } from './company-reach.js';
import type { StepContext } from './definition.js';
import { vaultDoorsFor, type VaultDoorsReach } from './vault-doors-here.js';
import { retiredVaultsKeptHere } from './retired-vaults-here.js';

/** What happened to each vault. */
export type VaultsChanged = Awaited<ReturnType<typeof vaultSecretsRotatedHere>>;

/** How many vaults ended in each state, as the page is told it. */
export interface VaultsChangedTold {
  readonly vaultsRotated: number;
  readonly vaultsAwaiting: number;
  readonly vaultsOwed: number;
  readonly vaultsWaiting: number;
  readonly vaultsNotChanged: number;
}

/** Counts each vault's state: a vault that owed nothing is not counted, and one whose change failed is never counted as waiting. */
export const toldOf = (changed: VaultsChanged): VaultsChangedTold => ({
  vaultsRotated: changed.filter((v) => v.state === 'rotated').length,
  vaultsAwaiting: changed.filter((v) => v.state === 'awaiting-approvals').length,
  vaultsOwed: changed.filter((v) => v.state === 'owed').length,
  vaultsWaiting: changed.filter((v) => v.state === 'waits' || v.state === 'not-this-seat').length,
  vaultsNotChanged: changed.filter((v) => v.state === 'not-rotated').length
});

/** True when a vault still owes its change: anything but a vault on its new secret or one that owed nothing. */
export const stillOwed = (changed: VaultsChanged): boolean =>
  changed.some((v) => v.state !== 'rotated' && v.state !== 'not-owed');

/**
 * Changes the secret of `o.vault`, or of every vault the account has adopted on the chain and every retired one whose
 * secret is still kept, as `may` allows. A retired vault, named or not, is changed only while it may hold private money
 * or its last secret change is half written, and is admitted as the company's for this change alone (`heldForItsSecret`):
 * the account approves a change of a retired vault's secret as of an adopted one's. `o.retired`, when the caller has
 * read them, are those retired vaults, so they are not read again. `o.leaf` is the seat a removal just took off: a
 * wallet holding that seat makes nothing (`removalWaitsHere`). What it could not do for a vault is that vault's state;
 * it throws only when the company's account, the retired vaults it was not handed, or this seat's doors cannot be read.
 */
export async function vaultSecretsChangedHere(
  ctx: StepContext,
  r: CompanyReach,
  reach: VaultDoorsReach,
  rotation: Pick<RotationDoors, 'leaving' | 'admitted'>,
  may: 'raise' | 'finish',
  o: { readonly leaf?: string; readonly vault?: Hex; readonly retired?: readonly Hex[] } = {}
): Promise<VaultsChanged> {
  const base = vaultDoorsFor(ctx, r, reach);
  const adopted = (await r.holders()).adoptedVaults.map((v) => v.toLowerCase() as Hex);
  const asked = o.vault === undefined ? undefined : (o.vault.toLowerCase() as Hex);
  /*
   * The retired vaults whose secret is kept, as the caller read them (`o.retired`), or read here only when one may be
   * changed: every vault asked, or one named that the account does not hold.
   */
  const retired =
    o.retired ?? (asked !== undefined && adopted.includes(asked) ? [] : await retiredVaultsKeptHere(r, base));
  const vaults = asked !== undefined ? [asked] : [...adopted, ...retired];
  if (vaults.length === 0) return [];
  const doors = {
    ...base,
    leaving: rotation.leaving,
    ...(rotation.admitted === undefined ? {} : { admitted: rotation.admitted }),
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)
  };
  return vaultSecretsRotatedHere(doors, vaults, may, {
    ...(o.leaf === undefined ? {} : { leaf: o.leaf }),
    ...(retired.length === 0 ? {} : { retired })
  });
}
