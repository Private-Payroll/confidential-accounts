/**
 * **A VAULT'S NAME AND DESCRIPTION, READ ON A SIGNER'S OWN DEVICE.**
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
 * Filing a version is `fileVaultInfoHere` (`vault-info-filed-here.ts`), kept
 * apart so that a page that only reads a vault's name does not load the
 * filing seat's check. The record is sealed under the company's key for
 * vaults, so every signer reads it. Nothing that moves money reads it.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import { keysByPurpose } from './keys-by-purpose.js';
import type { Hex } from '../../../src/core/crypto.js';
import { companyWirePaths, fromCompanyWire, type CompanyRecordKind, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { openVaultInfo, VAULT_INFO_KIND, VaultInfoRefused } from '../../../src/midnight/vault-info-record.js';
import { FilingNotBelieved, HttpCompanyRecordStore, pageWireSend, type FreshJudge, type WireSend } from './http-sealed-pool-store.js';
import type { DirectoryRead } from './vault-page-doors.js';
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


const VAULT = /^[0-9a-f]{64}$/u;
/** A refusal in the words it was thrown with: the error's message, or what was thrown when it carries none. */
export const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The same words without their closing full stop, for quoting inside a sentence that goes on after them. */
export const saidWithoutStop = (e: unknown): string => said(e).replace(/\.\s*$/u, '');

/** An address or identity on the chain in lower case, the one case it is compared in. */
export const lowerHex = (h: string): Hex => String(h).toLowerCase() as Hex;

export const vaultOf = (vault: string): Hex => {
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
    return { state: 'named', ...openVaultInfo(rec, keysByPurpose(doors.companyKeys).at(rec.keyEpoch)), version: rec.version };
  } catch (e) {
    return { state: 'unread', why: said(e), version: rec.version };
  }
}


/**
 * The company's records as a device reads and files a vault's name: through
 * the one check (`judge`), signed with this seat's filing key, sent through
 * `send` (this page's own requests unless the caller gives another way). Given
 * no filing key (null), as on a page that holds no seat secret, it only reads.
 */
export const vaultInfoRecordsFor = (
  accountId: string, signingSecret: Hex | null, judge: FreshJudge, signedInAs: () => string | null,
  send: WireSend = pageWireSend(signedInAs),
): VaultInfoRecords => {
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
