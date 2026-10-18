/**
 * **A VAULT'S NAME AND DESCRIPTION, AS EVERY SIGNER'S DEVICE READS AND FILES
 * THEM**: through the one check every company record is read through. The
 * service here is a store of filed versions that a test can make withhold,
 * roll back or change; the company's records are a double of what the anchor
 * holds - the directory, its change of the key, and the batch that anchored
 * each version (as `a-record-sealed-under-an-older-key-is-refused.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, type Hex } from '../../../src/core/crypto.js';
import type { CompanyKeys } from '../../../src/core/company-key.js';
import { companyRecordEntry, recordKeyOf, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import { emptyDirectory, type Directory, type DirectorySeat } from '../../../src/midnight/seat-directory.js';
import type { Role } from '../../../src/core/types.js';
import { signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { sealVaultInfo } from '../../../src/midnight/vault-info-record.js';
import { judgeIn, type DirectoryHere } from './vault-page-doors.js';
import { HttpCompanyRecordStore } from './http-sealed-pool-store.js';
import {
  fileVaultInfoHere, VaultInfoChanged, vaultInfoHere, VaultInfoNotFiled, VaultInfoRefused, type VaultInfoDoors, type VaultInfoRead,
} from './vault-info-here.js';

const ACC = 'acc_vault_info';
const VAULT = 'ab'.repeat(32) as Hex;
const KEY0 = '40'.repeat(32) as Hex;
const KEY1 = '41'.repeat(32) as Hex;
const ADA = newSigningKeypair();
const BO = newSigningKeypair();
const CY = newSigningKeypair();
const seat = (n: string, k: { publicKey: Hex }, role: Role | null): DirectorySeat =>
  ({ seat: n.repeat(32), person: n, signingKey: k.publicKey, wrappingKey: 'b1'.repeat(32) as Hex, role, retired: null });
const RECORD = { store: 'company' as const, kind: 'vault-info', id: VAULT };
const KEY = recordKeyOf(RECORD);

/** The company's keys a seat holds: epoch 0, and epoch 1 once the key has changed. */
const keysAt = (epoch: 0 | 1): CompanyKeys => ({
  epoch, newest: epoch, key: epoch === 0 ? KEY0 : KEY1, keyAt: (e) => (e === 0 ? KEY0 : KEY1),
  sealing: () => ({ key: epoch === 0 ? KEY0 : KEY1, epoch }),
});

/**
 * A company of Ada (an admin), Bo (an approver) and Cy (seated later, an admin). The service keeps every version
 * filed; `anchored` maps a version to the batch that anchored it, every other version entered waits to be anchored;
 * `rotatedIn` is the batch that anchored the change of the company's key, if it changed.
 */
const aCompany = (o: { rotatedIn?: number } = {}) => {
  const served: SealedCompanyRecord[] = [];
  const entered: ManifestEntryBody[] = [];
  const anchored = new Map<number, number>();
  let serve: (versions: SealedCompanyRecord[]) => SealedCompanyRecord | null = (v) => v[v.length - 1] ?? null;
  const dir: Directory = {
    ...emptyDirectory(ACC), version: 3, seats: [seat('a1', ADA, 'admin'), seat('b1', BO, 'approver'), seat('c1', CY, 'admin')],
    ...(o.rotatedIn === undefined ? {} : { rotations: [{ version: 3, epoch: 1, keyCheck: 'cc'.repeat(32) as Hex, after: 2 }] }),
  };
  const here = (): DirectoryHere => {
    const history = new Map<string, unknown[]>();
    const waiting: unknown[] = [];
    for (const e of entered) {
      const rec = served.find((r) => r.version === e.version)!;
      const filedBy = rec.filedBy!.publicKey.toLowerCase();
      const batch = anchored.get(e.version);
      if (batch === undefined) waiting.push({ ...e, filedBy: { publicKey: filedBy } });
      else history.set(KEY, [...(history.get(KEY) ?? []), { version: e.version, digest: e.digest, filedBy, batch, dirVersion: 3 }]);
    }
    return {
      dir, holders: { seats: dir.seats.map((x) => x.seat), approvals: 1, seatBar: 1 } as never, leafOf: () => null,
      another: new Set(), at: () => null,
      records: {
        head: '00'.repeat(32), reached: {} as never, stopped: null,
        asked: { records: new Set([KEY]), kinds: new Set() }, history, notYetAnchored: waiting as never,
        directory: new Map([1, 2, 3].map((v) => [v, { digest: v.toString(16).padStart(64, '0'), batch: v === 3 ? (o.rotatedIn ?? 0) : 0, held: {} as never }])),
      },
    } as unknown as DirectoryHere;
  };
  const send = async (path: string, init: { method: string; body?: string }) => {
    if (init.method === 'GET') {
      const rec = serve([...served]);
      return { status: 200, body: { kind: 'vault-info', id: VAULT, filed: rec === null ? null : toCompanyWire(rec) } };
    }
    const wire = JSON.parse(init.body!);
    const rec = JSON.parse(wire.body) as SealedCompanyRecord;
    if (rec.version !== served.length + 1) return { status: 409, body: { refused: 'version-already-filed' } };
    served.push(rec);
    return { status: 201, body: { filed: true, version: rec.version, digest: wire.digest } };
  };
  const doorsOf = (who: { secret: Hex }, keys: CompanyKeys = keysAt(o.rotatedIn === undefined ? 0 : 1), log: string[] = []): VaultInfoDoors => ({
    accountId: ACC, companyKeys: keys, signingSecret: who.secret,
    directory: async () => here(),
    records: ((store) => ({
      get: (k: never, i: string) => store.get(k, i), put: (r: SealedCompanyRecord) => store.put(r),
      served: async () => serve([...served]),
    }))(new HttpCompanyRecordStore(ACC, send as never, who.secret, async () => judgeIn(here()))),
    entered: { enter: async (filed) => { for (const f of filed as ManifestEntryBody[]) { log.push(`entered ${f.version}`); if (!entered.some((e) => e.version === f.version)) entered.push(f); } } },
  });
  /** Files a version as `who` straight to the service, sealed at `epoch`, and enters it. */
  const filedBy = (who: { secret: Hex }, name: string, epoch: 0 | 1, enter = true) => {
    const rec = signCompanyFiling(sealVaultInfo({ company: ACC, vault: VAULT, version: served.length + 1, keyEpoch: epoch, key: epoch === 0 ? KEY0 : KEY1, info: { name, description: '' } }), who.secret);
    served.push(rec);
    if (enter) entered.push(companyRecordEntry(rec));
    return rec;
  };
  return { served, entered, anchored, doorsOf, filedBy, serving: (f: typeof serve) => { serve = f; } };
};

describe('A VAULT\'S NAME AND DESCRIPTION, ON A SIGNER\'S DEVICE', () => {
  it('an admin\'s name for a vault is read by every signer, one seated after it was filed included', async () => {
    const co = aCompany();
    /* RED WHEN: a vault with no name filed reads as anything but none. */
    const unnamed: VaultInfoRead = await vaultInfoHere(co.doorsOf(ADA), VAULT);
    expect(unnamed).toEqual({ state: 'none' });
    expect(await fileVaultInfoHere(co.doorsOf(ADA), { vault: VAULT, name: ' Payroll UK ', description: 'London.', over: null })).toEqual({ state: 'filed', version: 1 });
    /* RED WHEN: another signer, or one seated after it was filed, cannot read it: it was sealed to the signers there were. */
    for (const who of [ADA, BO, CY]) {
      expect(await vaultInfoHere(co.doorsOf(who), VAULT)).toEqual({ state: 'named', name: 'Payroll UK', description: 'London.', version: 1 });
    }
  });

  it('an approver names no vault: refused on its own device before anything is sent, and a name such a seat filed is not believed', async () => {
    const co = aCompany();
    /* RED WHEN: a seat whose role may not file the record files it. */
    await expect(fileVaultInfoHere(co.doorsOf(BO), { vault: VAULT, name: 'Mine', description: '', over: null })).rejects.toThrow(VaultInfoNotFiled);
    expect(co.served).toEqual([]);
    co.filedBy(BO, 'Bo\'s name', 0);
    const read = await vaultInfoHere(co.doorsOf(ADA), VAULT);
    /* RED WHEN: a version an approver filed is believed; it reads as unread, with its version an admin files over. */
    expect(read).toMatchObject({ state: 'unread', version: 1 });
    expect(await fileVaultInfoHere(co.doorsOf(ADA), { vault: VAULT, name: 'Payroll', description: '', over: 1 })).toEqual({ state: 'filed', version: 2 });
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'Payroll', version: 2 });
  });

  it('a name the service withholds, rolls back or serves as other bytes reads as unread, never as no name', async () => {
    const co = aCompany();
    co.filedBy(ADA, 'First', 0);
    co.filedBy(ADA, 'Second', 0);
    co.anchored.set(1, 1).set(2, 2);
    co.serving(() => null);
    /* RED WHEN: a name the company's records hold and the service withholds reads as a vault with no name. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'unread' });
    co.serving((v) => v[0]!);
    /* RED WHEN: an older version served as the newest is believed. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'unread' });
    const other = signCompanyFiling(sealVaultInfo({ company: ACC, vault: VAULT, version: 2, keyEpoch: 0, key: KEY0, info: { name: 'Swapped', description: '' } }), ADA.secret);
    co.serving(() => other);
    /* RED WHEN: other bytes under the newest version's number are believed. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'unread' });
    co.serving((v) => v[v.length - 1]!);
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'Second' });
  });

  it('a version entered and not yet anchored is read on its filer\'s signature, said as unread when withheld with its entry listed, and not seen when its entry is withheld too', async () => {
    const co = aCompany();
    co.filedBy(ADA, 'Anchored', 0);
    co.anchored.set(1, 1);
    co.filedBy(ADA, 'Entered, not anchored', 0);
    /* RED WHEN: a version an admin filed and entered is not believed until it is anchored. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'Entered, not anchored', version: 2 });
    co.serving((v) => v[0]!);
    /* RED WHEN: the service withholds the newest version while its entry is listed, and the older one is shown as the name. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'unread' });
    co.entered.pop();
    /* What the code does when the entry is withheld too: the version the anchor holds is read. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'Anchored', version: 1 });
  });

  it('a name filed before the company\'s key changed is still read after it, and one filed under the old key after the change is not believed', async () => {
    const co = aCompany({ rotatedIn: 5 });
    co.filedBy(ADA, 'Before the change', 0);
    co.anchored.set(1, 2);
    /* RED WHEN: a version filed before the key changed is no longer read once it has. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'Before the change', version: 1 });
    co.filedBy(ADA, 'A stale device', 0);
    /* RED WHEN: a version sealed under the key from before the change, entered after it, is believed: a leaver could read it. */
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'unread', why: expect.stringMatching(/sealed under the company's key at epoch 0/u) });
    /* RED WHEN: a new version is filed under any key but the one in force. */
    await fileVaultInfoHere(co.doorsOf(ADA), { vault: VAULT, name: 'After', description: '', over: 2 });
    expect(co.served[2]!.keyEpoch).toBe(1);
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'After', version: 3 });
  });

  it('two admins naming one vault at once: one is filed, the other is told the name changed and files nothing', async () => {
    const co = aCompany();
    const [a, c] = await Promise.allSettled([
      fileVaultInfoHere(co.doorsOf(ADA), { vault: VAULT, name: 'Ada\'s', description: '', over: null }),
      fileVaultInfoHere(co.doorsOf(CY), { vault: VAULT, name: 'Cy\'s', description: '', over: null }),
    ]);
    /* RED WHEN: both are filed, or the second writes over the first. */
    expect([a.status, c.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(((a.status === 'rejected' ? a : c) as PromiseRejectedResult).reason).toBeInstanceOf(VaultInfoChanged);
    expect(co.served).toHaveLength(1);
    /* RED WHEN: an edit made over a version that is no longer the newest is filed over it. */
    await expect(fileVaultInfoHere(co.doorsOf(ADA), { vault: VAULT, name: 'Late', description: '', over: null })).rejects.toThrow(VaultInfoChanged);
    expect(co.served).toHaveLength(1);
  });

  it('a name filed and not entered is entered again on the next press, never filed twice', async () => {
    const co = aCompany();
    co.filedBy(ADA, 'Payroll', 0, false);
    const log: string[] = [];
    /* RED WHEN: the same name pressed again files a second version instead of entering the first. */
    expect(await fileVaultInfoHere(co.doorsOf(ADA, keysAt(0), log), { vault: VAULT, name: 'Payroll', description: '', over: null }))
      .toEqual({ state: 'entered-again', version: 1 });
    expect(co.served).toHaveLength(1);
    expect(log).toEqual(['entered 1']);
    expect(await vaultInfoHere(co.doorsOf(CY), VAULT)).toMatchObject({ state: 'named', name: 'Payroll' });
  });

  it('a name the check refuses is refused before anything is read or filed', async () => {
    const co = aCompany();
    /* RED WHEN: a refused name or a vault that is not an address reaches the service. */
    await expect(fileVaultInfoHere(co.doorsOf(ADA), { vault: VAULT, name: '', description: '', over: null })).rejects.toThrow(VaultInfoRefused);
    await expect(fileVaultInfoHere(co.doorsOf(ADA), { vault: 'not-a-vault', name: 'x', description: '', over: null })).rejects.toThrow(VaultInfoRefused);
    expect(co.served).toEqual([]);
  });
});
