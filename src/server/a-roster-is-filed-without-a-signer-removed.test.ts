/**
 * **A ROSTER IS FILED WITHOUT A SIGNER WHO WAS REMOVED.** Cy is removed: the retirement is anchored, the chain drops Cy's
 * seat and Bo's device changes the company's key. The roster Ada's device filed still names Cy as seated and every device
 * still believes it, so the vault-key index the service keeps counts three signers against the chain's two and the
 * vault-key route answers no readers: no vault could be created. Bo's device files the roster again without Cy, the index
 * filed with it counts the two seats that stay, and the checks a vault's creation and a secret run make pass.
 */
import { describe, it, expect } from 'vitest';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { fileTheRosterFollowedHere, rosterHere } from 'vaults-web-shared/roster-here.js';
import { directoryHere, readersIn } from 'vaults-web-shared/vault-page-doors.js';
import { companyKeyHere, rotateTheCompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { rosterVaultKeys } from '../core/vault-keys.js';
import { readerRefusalOf, rosterRefusalOf } from '../midnight/secret-readers.js';
import { acmeDirectoryDeps } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, BO, CO, companyKeyDoorsOf, CY, deviceOf, KEY, LABEL, rosterDoorsOf, seatsOnTheChain, store, walletOf,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

/* The readers the vault-key route answers (company-vaults.ts): the index's readers only when its count is the chain's seats. */
const routeReaders = (): readonly string[] => {
  const index = store.getVaultKeyIndex(CO);
  return index !== null && index.signerCount === seatsOnTheChain().length ? [...index.readers] : [];
};
const rosterVersion = (): number => (store.newestRoster(CO) as { version: number }).version;

describe('A ROSTER IS FILED WITHOUT A SIGNER WHO WAS REMOVED', () => {
  it('BO\'S DEVICE FILES THE ROSTER WITHOUT CY ONCE CY\'S REMOVAL IS CARRIED OUT, SO THE VAULT-KEY ROUTE ANSWERS ADA AND BO AND A VAULT\'S READERS ARE CHECKED; CY\'S DEVICE FILES NOTHING', async () => {
    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    expect(await removeSignerOnDevice(deviceOf(BO), remove)).toMatchObject({ state: 'done' });
    expect(seatsOnTheChain()).toEqual([ADA.seat, BO.seat]);
    const keyDoors = (s: typeof BO) => ({ ...companyKeyDoorsOf(s), accountId: CO, material: { signingSecret: s.signingSecret }, records: deviceOf(s).records! });
    expect(await rotateTheCompanyKeyHere({ ...keyDoors(BO), leaving: async () => new Set<string>() }, { leaf: CY.seat })).toMatchObject({ state: 'rotated', epoch: 1 });
    const bo = await companyKeyHere(keyDoors(BO));
    const boDoors = { ...rosterDoorsOf(BO), viewingKey: bo };
    const before = rosterVersion();

    /* RED WHEN: the roster filed before the removal still stands, so the route answers no readers and no vault can be created. */
    expect(routeReaders()).toEqual([]);

    /* RED WHEN: the device of the signer who left files a roster, which every device would refuse. */
    expect(await fileTheRosterFollowedHere(rosterDoorsOf(CY))).toBeNull();
    expect(rosterVersion()).toBe(before);

    /* RED WHEN: a staying device files nothing once the removal is carried out, because the roster it reads is believed. */
    expect(await fileTheRosterFollowedHere(boDoors)).toBe(before + 1);
    const read = await rosterHere(boDoors);
    expect(read.opened.signers.filter((s) => s.status === 'active').map((s) => s.name).sort()).toEqual(['ada', 'bo']);
    /* RED WHEN: the index filed with the roster counts a seat the chain no longer holds, or leaves a seat that stays out. */
    expect(routeReaders()).toEqual([walletOf(ADA).recordsKey.recordsKey, walletOf(BO).recordsKey.recordsKey].map((k) => k.toLowerCase()).sort());

    /* RED WHEN: the roster is filed again on every read, though it already seats only those who stay. */
    expect(await fileTheRosterFollowedHere(boDoors)).toBeNull();
    expect(rosterVersion()).toBe(before + 1);

    /* The checks a vault's creation (`rosterRefusalOf`, as `readersFrom` makes it) and a secret run (`readerRefusalOf`) make, on Bo's device. */
    const here = await directoryHere({ ...acmeDirectoryDeps([ADA, BO]), viewingKey: bo });
    const readers = (await readersIn(async () => here).signers()).map((r) => r.wrappingPublicKey.toLowerCase());
    const roster = rosterVaultKeys(read.opened);
    const seats = { seats: seatsOnTheChain() };
    const directory = { seats: here.dir.seats, leafOf: here.leafOf };
    /* RED WHEN: a vault cannot be created after a removal, because the roster names more signers than the chain seats. */
    expect(rosterRefusalOf({ company: LABEL, account: ADDRESS, roster, seats, directory })).toBeNull();
    const VAULT = 'fa'.repeat(32);
    /* RED WHEN: a secret run sealed to the seats that stay is refused after a removal. */
    expect(readerRefusalOf({
      company: LABEL, account: ADDRESS, vault: VAULT, readers, roster,
      seats: { ...seats, vault: { vault: VAULT, account: ADDRESS } }, directory: { ...directory, readers },
    })).toBeNull();
    expect(readers.sort()).toEqual(routeReaders());
  }, 170_000);
});
