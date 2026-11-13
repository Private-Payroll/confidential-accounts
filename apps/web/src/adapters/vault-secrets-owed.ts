/**
 * WHICH OF THE COMPANY'S VAULTS OWE A NEW SECRET, READ BY THE SIGNERS PAGE ON LOAD, so a change left owed shows after a
 * reload and not only in the counts of the press that tried it. The facts come from the chain alone: the vaults the
 * person's own wallet says the company's account holds, each vault's secret as this device's vault worker reads it at
 * the indexer that wallet names, and the account's count of removals now and when the secret was set. A vault owes a
 * change when a signer was removed after its secret was set, the one compare the wallet's rotation makes too
 * (`removedSinceSet`). Asks the wallet nothing that opens a window, and takes no key: what needs the company's records
 * (copies not yet written, a record behind the chain) is left to the press. A read that fails names the vault as unread
 * and never counts it as owing nothing.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { SealedAccount } from '../../../../src/core/types.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { api, holdersFromTheWallet } from 'vaults-web-shared/keyring.js';
import { readHere } from 'vaults-web-shared/vault-read-here.js';
import { removalsOnTheChainHere } from 'vaults-web-shared/removals-on-the-chain.js';
import { removedSinceSet, whenTheSecretWasSetHere } from 'vaults-web-shared/who-holds-the-vaults-secret.js';
import type { VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';
import { companyRoute } from './handover-state.js';
import { keyringFor } from './keyring-person.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/** What the read found: the vaults owing a new secret and those the chain could not be read for, or that nothing could be read. */
export type VaultSecretsOwed =
  | { readonly of: typeof OWED_READ.read; readonly owed: readonly string[]; readonly unread: readonly string[] }
  | { readonly of: typeof OWED_READ.unread };

/** Whether the read of the vaults owing a new secret read anything, compared by the code. */
export const OWED_READ = { read: 'read', unread: 'unread' } as const;

type Indexer = { readonly indexerUri: string; readonly indexerWsUri: string } | null;
interface OwedDoors { readonly account: AccountAddress; readonly builder: VaultBuilderClient; readonly indexer: () => Promise<Indexer> }

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * Whether the chain shows a signer removed after `vault`'s secret was set. A vault whose secret is not set yet owes
 * nothing, since it takes no money until it is. Null when the chain shows no vault at the address yet; throws when the
 * vault or the account cannot be read at the indexer.
 */
async function owedOnTheChain(doors: OwedDoors, vault: Hex): Promise<boolean | null> {
  const read = await readHere(doors, vault);
  if (!read.onChain) return null;
  const commitment = (typeof read.nonceCommitment === 'string' ? read.nonceCommitment.toLowerCase() : '') as Hex;
  if (!HEX64.test(commitment) || /^0+$/u.test(commitment)) return false;
  const removals = await removalsOnTheChainHere(doors, vault);
  return removedSinceSet(removals, () => whenTheSecretWasSetHere(doors, vault, commitment));
}

/**
 * The company's vaults owing a new secret, and those that could not be read, in the order the wallet named them; `unread`
 * when the service could not be asked who is signed in or the wallet did not say which vaults the company holds; null
 * for a person not signed in or a company with no account on the chain yet, where no vault can owe anything.
 */
export async function vaultSecretsOwed(personId: string, companyId: string): Promise<VaultSecretsOwed | null> {
  let doors: OwedDoors;
  let vaults: readonly string[];
  try {
    if (!(await keyringFor(personId))) return null;
    const sealed = await api(companyRoute(companyId)) as SealedAccount;
    const company = (sealed.companyLabel ?? null) as CompanyLabel | null;
    const account = (sealed.contractAddress ?? null) as AccountAddress | null;
    if (company === null || account === null) return null;
    const held = await holdersFromTheWallet(ACCOUNT_ORIGIN, { company, account });
    vaults = held.holders.adoptedVaults;
    doors = { account, builder: await theVaultBuilder(), indexer: async () => held.indexer };
  } catch {
    /* Nothing was read, so nothing is said to be owed or not: the page says the read failed. */
    return { of: OWED_READ.unread };
  }
  const found = await Promise.all(vaults.map(async (v) => {
    const vault = v.toLowerCase() as Hex;
    try {
      return { vault, owed: await owedOnTheChain(doors, vault) };
    } catch {
      /* This vault's read failed: it is named unread, never counted as owing nothing. */
      return { vault, owed: null };
    }
  }));
  return {
    of: OWED_READ.read,
    owed: found.flatMap((f) => (f.owed === true ? [f.vault] : [])),
    unread: found.flatMap((f) => (f.owed === null ? [f.vault] : [])),
  };
}
