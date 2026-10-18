/**
 * **A VAULT'S NAME AND DESCRIPTION, READ AND FILED ON A SIGNER'S OWN DEVICE.**
 *
 * `vaultInfoHere` reads the newest version of a vault's name through the one
 * check every company record is read through (`HttpCompanyRecordStore` and
 * `judgeIn`): believed as the company's records hold it - an anchored version
 * by the bytes the anchor names, a version entered and not yet anchored by its
 * filer's signature and seat. A version the records name and the service
 * withholds, rolls back or changes is said as unread, never shown as a vault
 * with no name. A version entered and not yet anchored is known only from the
 * entries the service lists: withheld with its entry listed, it is said as
 * unread; withheld together with its entry, the newest version the anchor holds
 * is read.
 *
 * `fileVaultInfoHere` files the next version from a seat whose role may file
 * it (an admin, or the founding seat before roles are set), after the version
 * the caller last read; a version another admin filed meanwhile is refused
 * rather than written over. The record is sealed under the company's key for
 * vaults, so every signer reads it.
 *
 * Creating a vault files its first version right after the deploy
 * (`createCompanyVault`); an edit screen calls `fileVaultInfoHere` itself.
 * Nothing that moves money reads either.
 */
import { keyOf, sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import {
  companyWirePaths, fromCompanyWire, verifiedCompanyFiler, type CompanyRecordKind, type SealedCompanyRecord,
} from '../../../src/midnight/sealed-record-wire.js';
import {
  openVaultInfo, sealVaultInfo, VAULT_INFO_KIND, vaultInfoTidied, VaultInfoRefused, type VaultInfo,
} from '../../../src/midnight/vault-info-record.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import { mayFile } from '../../../src/midnight/seat-directory.js';
import { FilingNotBelieved, HttpCompanyRecordStore, pageWireSend, type FreshJudge } from './http-sealed-pool-store.js';
import { seatNotBelievedHere, type DirectoryRead } from './vault-page-doors.js';
import type { RecordsEntered } from './record-entered-here.js';

export { VaultInfoRefused };

/** The company's records, as this device reads and files them through the one check. */
export interface VaultInfoRecords {
  get(kind: CompanyRecordKind, id: string): Promise<SealedCompanyRecord | null>;
  put(rec: SealedCompanyRecord): Promise<void>;
  /**
   * The newest version as the service gives it, NOT checked: read only to find
   * a version this seat signed and filed whose entry was lost, so it is entered
   * again rather than filed twice. Nothing read through it is shown or believed.
   */
  served(kind: CompanyRecordKind, id: string): Promise<SealedCompanyRecord | null>;
}

/** What reading and filing a vault's name needs from this device. */
export interface VaultInfoDoors {
  readonly accountId: string;
  /** The company's keys this seat holds: a version is opened with the key of its epoch, filed under the key in force. */
  readonly companyKeys: KeysHeld;
  /** This seat's filing key: who this seat is in the directory, and what signs a version it files. */
  readonly signingSecret: Hex;
  readonly directory: DirectoryRead;
  readonly records: VaultInfoRecords;
  readonly entered: RecordsEntered;
}

/**
 * A vault's name as this device reads it: `named`, with the version read;
 * `none` when the company's records name no version of it; `unread` when a
 * version exists and this device could not believe or open it - `version`
 * is that version when it is known, which an admin files over.
 */
export type VaultInfoRead =
  | { readonly state: 'named'; readonly name: string; readonly description: string; readonly version: number }
  | { readonly state: 'none' }
  | { readonly state: 'unread'; readonly why: string; readonly version: number | null };

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

const VAULT = /^[0-9a-f]{64}$/u;
const said = (e: unknown): string => String((e as Error)?.message ?? e);

const vaultOf = (vault: string): Hex => {
  const v = String(vault).toLowerCase();
  if (!VAULT.test(v)) throw new VaultInfoRefused('A vault\'s name is read and filed under the vault\'s address, and this is not one.');
  return v as Hex;
};

/** Reads `vault`'s name and description through the one check. Never throws for a record it cannot believe: it says so. */
export async function vaultInfoHere(doors: Pick<VaultInfoDoors, 'companyKeys' | 'records'>, vault: string): Promise<VaultInfoRead> {
  const id = vaultOf(vault);
  let rec: SealedCompanyRecord | null;
  try {
    rec = await doors.records.get(VAULT_INFO_KIND, id);
  } catch (e) {
    return { state: 'unread', why: said(e), version: e instanceof FilingNotBelieved ? e.version : null };
  }
  if (rec === null) return { state: 'none' };
  try {
    return { state: 'named', ...openVaultInfo(rec, keyOf(doors.companyKeys, rec.keyEpoch)), version: rec.version };
  } catch (e) {
    return { state: 'unread', why: said(e), version: rec.version };
  }
}

/**
 * Why this device's own seat may not file a vault's name, or null when it may:
 * its seat is in the directory as this device believes it, and its role may
 * file the record (`MAY_FILE`: an admin, or the founding seat).
 */
async function whyThisSeatMayNotNameAVault(doors: Pick<VaultInfoDoors, 'signingSecret' | 'directory'>): Promise<string | null> {
  const here = await doors.directory();
  const me = signingPublicKeyOf(doors.signingSecret).toLowerCase();
  const mine = here.dir.seats.find((x) => x.signingKey.toLowerCase() === me);
  if (mine === undefined) return 'the company\'s directory, as this device reads it, holds no seat under your keys';
  const off = seatNotBelievedHere(here, mine);
  if (off !== null) return `your seat is not one this device believes: ${off}`;
  if (!mayFile(mine).includes(VAULT_INFO_KIND)) return 'your seat\'s role on this company may not name or describe a vault; an admin does';
  return null;
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
    const served = await doors.records.served(VAULT_INFO_KIND, vault).catch(() => null);
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
    const opened = openVaultInfo(rec, keyOf(keys, rec.keyEpoch));
    return opened.name === info.name && opened.description === info.description;
  } catch {
    return false;
  }
};

/**
 * The company's records as a page reads and files a vault's name: through the
 * one check (`judge`), signed with this seat's filing key.
 */
export const vaultInfoRecordsFor = (
  accountId: string, signingSecret: Hex, judge: FreshJudge, signedInAs: () => string | null,
): VaultInfoRecords => {
  const send = pageWireSend(signedInAs);
  const store = new HttpCompanyRecordStore(accountId, send, signingSecret, judge);
  return {
    get: (kind, id) => store.get(kind, id),
    put: (rec) => store.put(rec),
    served: async (kind, id) => {
      const r = await send(companyWirePaths.newest(accountId, kind, id), { method: 'GET' });
      const b = r.body as { filed?: unknown } | null;
      return r.status !== 200 || b?.filed === null || b?.filed === undefined
        ? null : fromCompanyWire(b.filed, { company: accountId, kind, id }).sealed;
    },
  };
};
