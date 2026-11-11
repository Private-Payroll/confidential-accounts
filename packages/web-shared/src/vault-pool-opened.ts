import type { Hex } from '../../../src/core/crypto.js';
import {
  type NonceSecretReader, keepsEveryEpochOf, openNonceSecrets, recordsKeypairFrom, refileNonceSecret,
} from '../../../src/midnight/company-nonce-secret.js';
import type { PoolDoors, VaultChainView } from './vault-doors.js';
import { SealedNotePool, type SealedPool } from '../../../src/midnight/vault-pool.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { VaultStartOwed } from './vault-start-stops.js';
import { fileTheChainsSecretAsTheNewest, startVaultNonceSecretOnThisDevice } from './deposit-on-device.js';
import { theVaultReadForItsStart } from './vault-read-here.js';

/**
 * **THE CHAIN WINS** (`fileTheChainsSecretAsTheNewest`), over the vault's state
 * as one block showed it: the records' newest nonce secret is made the one the
 * vault's own commitment names. What follows still checks the secret it
 * builds from against that commitment, so a vault no filed version names is
 * refused there.
 */
export async function theChainWins(
  doors: PoolDoors & { readonly builder: Pick<VaultBuilderClient, 'secretIsTheVaults'> }, vault: Hex, state: string,
): Promise<'the-newest' | 'filed-again' | 'none-names-it'> {
  return fileTheChainsSecretAsTheNewest({
    vault, me: doors.me, records: doors.records,
    secretIsTheVaults: (secret) => doors.builder.secretIsTheVaults({ vault, state, secret }),
  });
}

/**
 * **THE SECRET A RUN IS READ WITH**: the secret it sets, the readers it is sealed to, the commitment it replaces (absent
 * for a first secret) and the secrets this device holds for the vault, among which the chain names the one a
 * replacement carries (`earlier`). A secret read back from the company's records is one, for a first secret.
 */
export interface RunSecret {
  readonly secret: Hex;
  readonly readers: readonly Hex[];
  readonly previous?: Hex;
  readonly earlier?: readonly Hex[];
}

/** The vault's nonce secret as this device holds it: made in this press, or read back from the company's records. */
export interface SecretReadBack {
  /** The secret deposits are made under now. */
  readonly secret: Hex;
  /** Every records key the version is wrapped to. */
  readonly readers: readonly Hex[];
  readonly epoch: number;
  /** The version filed, as this device made it or read it. */
  readonly filed: SealedPool;
  /** Made on this device in this press, so nothing but this device vouches for it; false when read back. */
  readonly madeHere: boolean;
}

export const openedHere = (doors: Pick<PoolDoors, 'me'>, vault: Hex, filed: SealedPool, madeHere: boolean): SecretReadBack => {
  const opened = openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey));
  return { secret: opened.secrets[opened.secrets.length - 1]! as Hex, readers: [...opened.readers] as Hex[], epoch: opened.epoch, filed, madeHere };
};

/**
 * **THE VAULT'S NONCE SECRET, READ BACK FROM THE COMPANY'S RECORDS ROUTE AND
 * OPENED HERE WITH THIS SIGNER'S OWN RECORDS KEY.** Whoever keeps the records
 * can file a secret of their own wrapped to every signer, so a caller uses what
 * this returns only once the chain vouches for it: the vault's own commitment,
 * or an open run of its signers made from it.
 */
export async function readTheSecretBack(doors: Pick<PoolDoors, 'me' | 'records' | 'secretKeptHere'>, vault: Hex): Promise<SecretReadBack> {
  const back = await doors.records('nonce-secret').get(vault);
  if (back === null) {
    throw new Error('the company\'s records hold no nonce secret for this vault, so nothing is built from one. File it '
      + 'first: creating the vault again does.');
  }
  const read = openedHere(doors, vault, back, false);
  const kept = await doors.secretKeptHere?.held(vault) ?? null;
  return kept !== null && openedHere(doors, vault, kept, true).secret.toLowerCase() === read.secret.toLowerCase()
    ? { ...read, madeHere: true } : read;
}

/**
 * **THE VAULT'S NOTE POOL AND NONCE SECRET, FILED THROUGH THE COMPANY'S RECORDS
 * ROUTE**. Only for a vault pinned to the company's account, as this device
 * reads it, that the chain has never paid into. Each half is skipped when it is already filed, so it can be run again.
 * A secret made here is handed back as made here, opened from the record this
 * device made; one already filed is read back and handed back as that.
 * `beforeFiling` is handed the keys a new nonce secret would be wrapped to,
 * before anything is wrapped, and stops the filing by throwing; there is no
 * filing without it. `removals` reads the account's count of removals, before
 * the readers are checked, and a new secret's record carries it; without it the
 * record carries 0, which is behind once any signer has been removed.
 * `readersNow` is who the company's directory believes now (`readersNow`, from
 * `readersIn`), never the service's word: a new secret is wrapped to those keys
 * and no others, and to this device alone without it; a kept record is filed
 * again over another only while every reader it is wrapped to is one it names.
 */
/*
 * **WHAT THE CHAIN SHOWS OF A VAULT'S SECRET, BEFORE ANY IS MADE OR FILED.** A vault's nonce commitment is zero until
 * its first secret is set; once it is not, a fresh secret could never be the vault's, and the only one worth filing is
 * one the chain shows (`secretIsTheVaults`). A read that carries no commitment says nothing either way.
 */
const theChainHoldsASecret = (view: VaultChainView): boolean =>
  typeof view.nonceCommitment === 'string' && /[1-9a-f]/iu.test(view.nonceCommitment);

const CHAIN_HOLDS_ANOTHER_SECRET = 'the chain already holds a secret for this vault, and neither the company\'s records '
  + 'nor this wallet hold one the chain shows, so no fresh secret was made: it could never be the vault\'s. Nothing was '
  + 'filed. Finish setting it up on the device whose wallet made it, where that secret is kept.';

/** Whether the chain shows this secret; a secret that does not open, or a read that fails, is not the chain's. */
const theChainsOrNot = async (shows: (secret: Hex, state: string) => Promise<boolean>, secret: Hex | null, state: string): Promise<boolean> =>
  secret !== null && await shows(secret, state).catch(() => { /* a read that fails is not the chain's: no secret is taken from it */ return false; });

/** The newest secret a sealed record of this vault's secret opens to here, or none when it does not open. */
const newestSecretIn = (doors: Pick<PoolDoors, 'me'>, vault: Hex, rec: SealedPool | null): Hex | null => {
  if (rec === null) return null;
  try {
    return openedHere(doors, vault, rec, false).secret;
  } catch {
    /* A record that does not open here names no secret: it is then neither filed again nor compared. */
    return null;
  }
};

/**
 * Whether a kept record is behind the one filed: fewer secrets, or an earlier secret that differs
 * (`keepsEveryEpochOf`). Filing it again would drop a secret change the records already hold, so it is never filed
 * over that one; only the newest secret may differ. A filed record that does not open here is weighed as before: the
 * kept one, which the chain shows, is filed over it.
 */
const behindTheFiled = (doors: Pick<PoolDoors, 'me'>, vault: Hex, kept: SealedPool, filed: SealedPool): boolean => {
  const opener = recordsKeypairFrom(doors.me.companyKey);
  const k = openNonceSecrets(kept, vault, opener);
  let f: ReturnType<typeof openNonceSecrets>;
  try {
    f = openNonceSecrets(filed, vault, opener);
  } catch {
    /* A filed record this device cannot open names no secret change to keep: the chain's, kept here, is filed. */
    return false;
  }
  return !keepsEveryEpochOf(k, f);
};

/** Whether every reader of a kept record is still one the directory believes now: never filed again to one who left. */
const everyReaderStays = async (readers: readonly Hex[], readersNow?: () => Promise<readonly Hex[]>): Promise<boolean> => {
  if (readersNow === undefined) return true;
  const now = (await readersNow()).map((k) => k.toLowerCase());
  return readers.every((k) => now.includes(k.toLowerCase()));
};

/** Who a new secret is sealed to beside this device: the keys the directory believes now, lower-cased; none without them. */
const readersToSealTo = async (readersNow?: () => Promise<readonly Hex[]>): Promise<readonly Hex[]> =>
  (readersNow === undefined ? [] : await readersNow()).map((k) => k.toLowerCase() as Hex);

/**
 * A kept record as it is filed after the newest the records list: as it is when it was made as that next version (the
 * wallet's record of a vault's next secret), otherwise sealed again as the version after the newer of the two.
 */
const keptAsNext = async (store: ReturnType<PoolDoors['records']>, vault: Hex, rec: SealedPool, by: Uint8Array): Promise<SealedPool> => {
  const all = await store.versions(vault);
  const next = (all.length === 0 ? 0 : all[all.length - 1]!.version) + 1;
  const own = openNonceSecrets(rec, vault, recordsKeypairFrom(by)).version;
  return own === next ? rec : refileNonceSecret(rec, vault, recordsKeypairFrom(by), Math.max(next, own + 1));
};

export async function openCompanyVaultPool(
  doors: PoolDoors, vault: Hex, beforeFiling: (readers: readonly Hex[]) => Promise<void>,
  chainsSecret?: (secret: Hex, state: string) => Promise<boolean>,
  removals?: () => Promise<number>,
  readersNow?: () => Promise<readonly Hex[]>,
): Promise<SecretReadBack> {
  doors.progress?.('opening the pool');
  const { view, refusal } = await theVaultReadForItsStart(doors, vault);

  if (!view.onChain || refusal !== null) {
    throw new Error(refusal ?? view.why ?? 'the chain does not show this vault yet, so its pool is not opened.');
  }
  const everCreated = new Set(view.everCreated ?? []);
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);




  const store = doors.records('nonce-secret');
  const filedNow = await store.get(vault);
  const secretOwed = filedNow === null;
  const kept = await doors.secretKeptHere?.held(vault) ?? null;
  const chainHolds = theChainHoldsASecret(view);
  const keptIsTheChains = kept !== null && chainHolds && chainsSecret !== undefined && view.state !== undefined
    && await theChainsOrNot(chainsSecret, newestSecretIn(doors, vault, kept), view.state);
  if (chainHolds && !keptIsTheChains && secretOwed) {
    throw new VaultStartOwed(vault, CHAIN_HOLDS_ANOTHER_SECRET);
  }
  const keptHere = keptIsTheChains || (secretOwed && !chainHolds) ? kept : null;
  const counted = secretOwed && keptHere === null && removals !== undefined ? await removals() : 0;
  const readers = secretOwed && keptHere === null ? await readersToSealTo(readersNow) : [];
  if (secretOwed && keptHere === null) await beforeFiling(readers);
  if (await doors.records('pool').get(vault) === null) {
    if ((view.notes ?? []).length > 0 || everCreated.size > 0) {
      throw new Error('the chain has already put money in this vault and it has no pool, so a new empty pool '
        + 'would record nothing of it. Nothing is filed; rebuild the pool from the company\'s records instead.');
    }
    await pool.create(vault, { notes: [] });
  }
  if (keptHere !== null) {
    const opened = openedHere(doors, vault, keptHere, true);
    if (filedNow === null) {
      await store.put(vault, keptHere);
    } else if (newestSecretIn(doors, vault, filedNow)?.toLowerCase() !== opened.secret.toLowerCase()
      && !behindTheFiled(doors, vault, keptHere, filedNow) && await everyReaderStays(opened.readers, readersNow)) {
      await store.put(vault, await keptAsNext(store, vault, keptHere, doors.me.companyKey));
    }
    return opened;
  }
  if (secretOwed) {
    const others: NonceSecretReader[] = readers
      .filter((k) => k.toLowerCase() !== doors.myRecordsKey.toLowerCase())
      .map((publicKey) => ({ publicKey }));
    const made = await startVaultNonceSecretOnThisDevice(vault, doors.me, others, doors.records, everCreated, counted);
    return openedHere(doors, vault, made, true);
  }
  doors.progress?.('reading the secret back');
  return readTheSecretBack(doors, vault);
}
