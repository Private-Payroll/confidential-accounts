/**
 * **A VAULT'S NAME AND DESCRIPTION, FILED FROM A SIGNER'S OWN DEVICE.**
 *
 * `fileVaultInfoHere` files the next version from a seat whose role may file
 * it (an admin, or the founding seat before roles are set), after the version
 * the caller last read; a version another admin filed meanwhile is refused
 * rather than written over. The record is sealed under the company's key for
 * vaults, so every signer reads it (`vaultInfoHere`, `vault-info-here.ts`).
 *
 * Creating a vault files its first version right after the deploy
 * (`createCompanyVault`); an edit screen calls `fileVaultInfoHere` itself.
 * Nothing that moves money reads either.
 */
import { sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { keysByPurpose } from './keys-by-purpose.js';
import { signingPublicKeyOf } from '../../../src/core/crypto.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { openVaultInfo, sealVaultInfo, VAULT_INFO_KIND, vaultInfoTidied, VaultInfoRefused, type VaultInfo } from '../../../src/midnight/vault-info-record.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { FilingNotBelieved } from './http-sealed-pool-store.js';
import { seatThatMayFileHere } from './may-file-here.js';
import { said, vaultOf, type VaultInfoDoors } from './vault-info-here.js';

export { VaultInfoRefused };

/** A vault's name was not filed. Nothing was filed, unless the sentence says otherwise. */
export class VaultInfoNotFiled extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(why, options);
    this.name = 'VaultInfoNotFiled';
  }
}

/** Another version of the vault's name was filed after the one this edit was made over. Nothing was filed. */
export class VaultInfoChanged extends Error {
  constructor(readonly newest: number) {
    super(`version ${newest} of this vault's name was filed by another admin after the version this change was made over, `
      + 'so nothing was filed. Read it again and make the change over what it says now.');
    this.name = 'VaultInfoChanged';
  }
}

/**
 * Why this device's own seat may not file a vault's name, or null when it may:
 * its seat is in the directory as this device believes it, and its role may
 * file the record (`MAY_FILE`: an admin, or the founding seat), as
 * `seatThatMayFileHere` judges every filing seat.
 */
async function whyThisSeatMayNotNameAVault(doors: Pick<VaultInfoDoors, 'signingSecret' | 'directory'>): Promise<string | null> {
  const seat = seatThatMayFileHere(await doors.directory(), signingPublicKeyOf(doors.signingSecret), VAULT_INFO_KIND,
    'your seat\'s role on this company may not name or describe a vault; an admin does');
  return typeof seat === 'string' ? seat : null;
}

/**
 * Files `vault`'s name and description as the version after `over` (null for
 * a vault with none yet). Refuses text the check refuses, a seat that may not
 * file it, and a version filed after `over`; when the newest version already
 * says exactly this and was filed by this seat, it is entered in the company's
 * records again instead of filed twice.
 */
export async function fileVaultInfoHere(
  doors: VaultInfoDoors, input: { readonly vault: string; readonly name: string; readonly description: string; readonly over: number | null },
): Promise<{ readonly state: 'filed' | 'entered-again'; readonly version: number }> {
  const vault = vaultOf(input.vault);
  const info = vaultInfoTidied(input);
  const may = await whyThisSeatMayNotNameAVault(doors);
  if (may !== null) throw new VaultInfoNotFiled(`This vault's name was not filed: ${may}. Nothing was filed.`);
  const sealing = sealingWith(doors.companyKeys, 0);
  let newest: SealedCompanyRecord | null;
  let newestVersion: number;
  try {
    newest = await doors.records.get(VAULT_INFO_KIND, vault);
    newestVersion = newest?.version ?? 0;
  } catch (e) {
    if (!(e instanceof FilingNotBelieved)) {
      throw new VaultInfoNotFiled(`This vault's name was not filed: the version it has now could not be read (${said(e)}), so `
        + 'the next version is not known. Nothing was filed.', { cause: e });
    }
    /* Not believed - perhaps this seat's own version, filed and never entered: that one is entered again. */
    const served = await doors.records.served(VAULT_INFO_KIND, vault).catch(() => {
      /* Not read: nothing is entered again, and the edit is filed over the version the records name, or refused. */
      return null;
    });
    newest = served !== null && served.version === e.version && served.keyEpoch === sealing.epoch ? served : null;
    newestVersion = e.version;
  }
  const mine = signingPublicKeyOf(doors.signingSecret).toLowerCase();
  if (newest !== null && verifiedCompanyFiler(newest)?.toLowerCase() === mine && sameInfo(newest, doors.companyKeys, info)) {
    await doors.entered.enter([companyRecordEntry(newest)]);
    return { state: 'entered-again', version: newest.version };
  }
  if ((input.over ?? 0) !== newestVersion) throw new VaultInfoChanged(newestVersion);
  const rec = sealVaultInfo({ company: doors.accountId, vault, version: newestVersion + 1, keyEpoch: sealing.epoch, key: sealing.key, info });
  try {
    await doors.records.put(rec);
  } catch (e) {
    if ((e as Error)?.name === 'VaultPoolVersionAlreadyFiled') throw new VaultInfoChanged(newestVersion + 1);
    throw e;
  }
  await doors.entered.enter([companyRecordEntry(rec)]);
  return { state: 'filed', version: rec.version };
}

const sameInfo = (rec: SealedCompanyRecord, keys: KeysHeld, info: VaultInfo): boolean => {
  try {
    const opened = openVaultInfo(rec, keysByPurpose(keys).at(rec.keyEpoch));
    return opened.name === info.name && opened.description === info.description;
  } catch {
    /* A version this device cannot open is not this edit: it is never entered again, only filed over or refused as changed. */
    return false;
  }
};
