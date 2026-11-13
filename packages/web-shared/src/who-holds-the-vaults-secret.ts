/**
 * **WHETHER THE SECRET A VAULT TAKES DEPOSITS UNDER MUST CHANGE.** The one answer both the rotation after a removal and
 * the deposit gate rest on, and it rests on the chain alone: the account's removal count now, against its count before
 * the block that set the vault's secret (`removalsWhenTheSecretWasSet`). A removal counted since means a signer who left
 * may hold the secret, on every device alike, whatever any record says. A version of the vault's record can only add
 * work: one good for fewer removals than the chain has counted is filed again with the chain's count.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { secretBehindTheChain, type OpenedNonceSecrets } from '../../../src/midnight/company-nonce-secret.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

const lower = (x: string): Hex => String(x).toLowerCase() as Hex;

/** Why the vault's secret may not be used as it is: a removal since it was set, or its record behind the chain's count. */
type SecretMustChange = { readonly why: 'removed-since-it-was-set' } | { readonly why: 'behind-the-chain' };

/**
 * **WHY THE VAULT'S SECRET MUST CHANGE BEFORE IT IS USED AGAIN, OR NULL WHEN IT NEED NOT.** A new secret when the chain
 * has counted a removal since the secret was set (`set`, read only once the chain has counted any); otherwise a re-file
 * when the newest version is good for fewer removals than the chain has counted. Trusts the chain's counts only.
 */
export async function secretMustChange(input: {
  readonly opened: Pick<OpenedNonceSecrets, 'removals'>;
  readonly chainRemovals: number;
  readonly set: () => Promise<number>;
}): Promise<SecretMustChange | null> {
  if (await removedSinceSet(input.chainRemovals, input.set)) return { why: 'removed-since-it-was-set' };
  return secretBehindTheChain(input.opened, input.chainRemovals) ? { why: 'behind-the-chain' } : null;
}

/**
 * **WHETHER THE CHAIN HAS COUNTED A REMOVAL SINCE THE VAULT'S SECRET WAS SET**, so a signer who left may hold it and the
 * vault owes a new secret. The one compare the wallet's rotation and the page's showing of an owed change both make, on
 * the chain's counts alone. `set` is read only once the chain has counted any removal, since it asks the chain's history.
 */
export async function removedSinceSet(chainRemovals: number, set: () => Promise<number>): Promise<boolean> {
  return chainRemovals > 0 && chainRemovals > await set();
}

/** The account's removal count before each vault's secret was set, by indexer, vault and commitment: it never changes. */
const setPoints = new Map<string, number>();

/**
 * **THE ACCOUNT'S REMOVAL COUNT BEFORE THE CHAIN SET THE VAULT'S SECRET `commitment`**, asked of this device's worker
 * from the chain's history at the indexer the person's own wallet names, once per secret; a refusal is never kept, so
 * the next read asks again. Refuses on a page whose worker cannot read it, with no indexer named, or for a vault the
 * chain names no secret for.
 */
export async function whenTheSecretWasSetHere(
  doors: { readonly builder: Pick<VaultBuilderClient, 'secretSetAt'>; readonly account: string; readonly indexer: () => Promise<{ readonly indexerUri: string; readonly indexerWsUri: string } | null> },
  vault: Hex, commitment: Hex,
): Promise<number> {
  if (doors.builder.secretSetAt === undefined) throw new Error('this page cannot read when the vault\'s secret was set on the chain. Reload it to get the current version.');
  if (!/^[0-9a-f]{64}$/u.test(lower(commitment)) || /^0+$/u.test(commitment)) throw new Error('the chain names no secret for this vault, so nothing was done. Start the vault\'s secret first.');
  const indexer = await doors.indexer();
  if (indexer === null) throw new Error('your wallet names no indexer, so when the vault\'s secret was set was not read. Nothing was done.');
  const key = `${indexer.indexerUri}|${lower(vault)}|${lower(commitment)}`;
  const known = setPoints.get(key);
  if (known !== undefined) return known;
  const set = await doors.builder.secretSetAt({ vault, account: lower(doors.account), commitment: lower(commitment), indexer: { indexerUri: indexer.indexerUri, indexerWsUri: indexer.indexerWsUri } });
  setPoints.set(key, set);
  return set;
}
