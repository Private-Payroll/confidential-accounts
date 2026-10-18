/**
 * **A VAULT'S NAME AND DESCRIPTION, AS THE COMPANY KEEPS THEM**: one sealed
 * company record per vault, opened with a key every seat of the company holds,
 * and refused when what is inside says it is another vault's or another
 * version's.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, unseal, type Hex } from '../core/crypto.js';
import { companyRecordEntry, manifestEntryRefusal, signManifestEntry } from './record-manifest.js';
import { purposeKey } from '../core/sealed-records.js';
import { signCompanyFiling, toCompanyWire, whyThisIsNotACompanyRecord } from './sealed-record-wire.js';
import {
  openVaultInfo, sealVaultInfo, VAULT_DESCRIPTION_MOST, VAULT_INFO_KIND, VAULT_NAME_MOST, vaultInfoTidied, VaultInfoRefused,
} from './vault-info-record.js';

const COMPANY = 'acc_info';
const VAULT = 'ab'.repeat(32) as Hex;
const OTHER = 'cd'.repeat(32) as Hex;
const KEY = '44'.repeat(32) as Hex;
const sealed = (over: { vault?: Hex; version?: number; name?: string; description?: string } = {}) => sealVaultInfo({
  company: COMPANY, vault: over.vault ?? VAULT, version: over.version ?? 1, keyEpoch: 0, key: KEY,
  info: { name: over.name ?? 'Payroll UK', description: over.description ?? 'Pays the London team.' },
});

describe('A VAULT\'S NAME AND DESCRIPTION', () => {
  it('open only with the company\'s key, as the record they were filed as', () => {
    const rec = sealed();
    /* RED WHEN: what is sealed does not come back as it was given. */
    expect(openVaultInfo(rec, KEY)).toEqual({ name: 'Payroll UK', description: 'Pays the London team.' });
    /* RED WHEN: the record opens with a key the company does not hold. */
    expect(() => openVaultInfo(rec, '55'.repeat(32) as Hex)).toThrow(VaultInfoRefused);
    /* RED WHEN: a name sealed for one vault is believed filed under another vault, or as another version. */
    expect(() => openVaultInfo({ ...rec, id: OTHER }, KEY)).toThrow(/another vault or another version/u);
    expect(() => openVaultInfo({ ...rec, version: 2 }, KEY)).toThrow(/another vault or another version/u);
  });

  it('are sealed under the company\'s key for vaults, so every seat reads them and no reader is listed', () => {
    const rec = sealed();
    /* RED WHEN: the record carries a wrap per reader, so a signer seated later could not read it. */
    expect(rec.wrapped).toEqual([]);
    expect(rec.kind).toBe(VAULT_INFO_KIND);
    expect(rec.id).toBe(VAULT);
    /* RED WHEN: the record is not the shape the company's records take for its kind. */
    expect(whyThisIsNotACompanyRecord(JSON.parse(JSON.stringify(rec)), { company: COMPANY, kind: VAULT_INFO_KIND, id: VAULT })).toBeNull();
    /* RED WHEN: the key is not the company's key for vaults, the one key every seat derives from the company's key. */
    expect(unseal(rec.sealed, purposeKey(KEY, COMPANY, 'vaults'))).toContain('"name":"Payroll UK"');
  });

  it('are accepted as an entry in the company\'s records, signed by the seat that filed them, as every company record is', () => {
    const filer = newSigningKeypair();
    const entry = signManifestEntry(COMPANY, companyRecordEntry(signCompanyFiling(sealed(), filer.secret)), filer.secret);
    /* RED WHEN: the company's records refuse an entry of the kind, so no version of a vault's name could ever be believed. */
    expect(manifestEntryRefusal(COMPANY, entry)).toBeNull();
    expect(entry).toMatchObject({ store: 'company', kind: VAULT_INFO_KIND, id: VAULT, version: 1 });
  });

  it('show the service nothing of the name, and not its length', () => {
    const short = toCompanyWire(sealed({ name: 'A' })).body;
    const long = toCompanyWire(sealed({ name: 'A much longer vault name', description: 'Several words more.' })).body;
    /* RED WHEN: the name or description reaches the service in plain text. */
    expect(long).not.toContain('longer');
    /* RED WHEN: the sealed body is as long as what it holds, so the service learns how long a name is. */
    expect(short.length).toBe(long.length);
    const four = '\u{1F600}';
    const most = toCompanyWire(sealed({ name: four.repeat(VAULT_NAME_MOST), description: four.repeat(VAULT_DESCRIPTION_MOST) })).body;
    /* RED WHEN: the longest name and description allowed, every character four bytes, seal to another size than one letter. */
    expect(most.length).toBe(short.length);
  });

  it('a name that is empty, too long or carries control characters is refused before anything is sealed', () => {
    /* RED WHEN: a name is trimmed or composed differently on two devices. */
    expect(vaultInfoTidied({ name: '  Café ', description: '' })).toEqual({ name: 'Café', description: '' });
    expect(vaultInfoTidied({ name: 'x'.repeat(VAULT_NAME_MOST), description: 'y\n'.repeat(VAULT_DESCRIPTION_MOST / 2) }).name).toHaveLength(64);
    /* RED WHEN: a name is empty, over 64 characters, or carries a control character; a description over 1,000. */
    for (const bad of [{ name: '   ', description: '' }, { name: 'x'.repeat(VAULT_NAME_MOST + 1), description: '' },
      { name: 'a\u0007b', description: '' }, { name: 'ok', description: 'y'.repeat(VAULT_DESCRIPTION_MOST + 1) },
      { name: 'ok', description: 'a\u0000b' }, { name: 'line\nbreak', description: '' }, { name: 7, description: '' }]) {
      expect(() => vaultInfoTidied(bad as never), JSON.stringify(bad)).toThrow(VaultInfoRefused);
    }
    /* RED WHEN: the record can be sealed with what the check would refuse. */
    expect(() => sealed({ name: '' })).toThrow(VaultInfoRefused);
  });
});
