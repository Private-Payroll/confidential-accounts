import { describe, it, expect } from 'vitest';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { identityFromSecret } from 'midnight-identity';
import { unwrapKey, type Hex } from '../core/crypto.js';
import type { KeysHeld } from '../core/company-key.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { newOneOffId, newOneOffSeed, ONE_OFF_KIND, openOneOff, type OneOffGiven } from '../midnight/one-off-record.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { leafOfTheContract } from '../testing/directory-seats.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import { newSeatKeys, type NewSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { acceptAsSignerHere, inviteSignerHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { removeSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { companyKeyHere, rotateTheCompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { admitSignerHere } from 'vaults-web-shared/roster-here.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { HttpCompanyRecordStore } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryHere, judgeIn, type DirectoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { oneOffHere } from 'vaults-web-shared/one-off-here.js';
import { fileOneOffHere, type OneOffFilingDoors } from 'vaults-web-shared/one-off-raised-here.js';
import { ACME, acmeDirectoryDeps, ORIGIN, fromAda, peopleRecords } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, anchorDoorsOf, BO, chains, CO, committeeKeyOfLeaf, companyKeyDoorsOf, CY, deviceOf, KEY, LABEL,
  rosterDoorsOf, sendAs, store,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

/**
 * A one-off payment's record is sealed under the company's key at the epoch in force when it is filed. The key then
 * changes - a signer is removed and the key rotates - and a signer admitted after the change holds only the newer key,
 * with every older one opened through it. That signer opens the one-off filed before the change through the rotation,
 * and the one filed after it with the newer key; the removed signer, holding the key from before, opens neither the
 * newer one nor anything sealed after the change.
 */

aCompanyWhoseSignersChange();

const REGISTRY = registryWithTestPrivateForms();
const DEES_KEY = committeeKeyFor(identityFromSecret(new Uint8Array(32).fill(4)), LABEL) as { tag: string; value: string };
const companyDirectory = (asked?: RecordsAsked): Promise<DirectoryHere> => directoryHere(acmeDirectoryDeps(), asked);

/** A device's doors for reading a one-off: the company's directory, the service's store as `person` reads it, and the keys it holds. */
const readingAs = (person: string, keys: KeysHeld) => {
  const records = new HttpCompanyRecordStore(CO, (path, init) => sendAs(person)(path, init as never), null, async (asked) => judgeIn(await companyDirectory(asked)));
  return { accountId: CO, directory: companyDirectory, records: { at: (k: never, id: string, v: number) => records.at(k, id, v) }, keys, registry: REGISTRY, open: openOneOff };
};
const filingAs = (who: typeof ADA, keys: KeysHeld): OneOffFilingDoors => {
  const records = new HttpCompanyRecordStore(CO, (path, init) => sendAs(who.person)(path, init as never), who.signingSecret as Hex,
    async (asked) => judgeIn(await companyDirectory(asked)));
  return {
    accountId: CO, directory: companyDirectory, records: { at: (k, id, v) => records.at(k, id, v), put: (rec) => records.put(rec), served: async () => null },
    keys, signingSecret: who.signingSecret as Hex, entered: who.entered, keyEpoch: 0, registry: REGISTRY,
  };
};
const given = (amount: bigint): OneOffGiven => ({
  vault: 'fa'.repeat(32) as Hex, asset: TEST_TOKEN, amount, form: 'private',
  payee: { ref: null, name: null, address: payeeFor('b3'.repeat(32), 'undeployed').bech32, network: 'undeployed' },
  reason: 'Invoice 2026-130', proposal: { id: 'prp_ROTATIONABCD', chainId: 'c6'.repeat(32) as Hex },
  run: { opensAt: 1_000n, closesAt: 2_000n, required: 0n }, seed: newOneOffSeed(),
});

describe('A ONE-OFF SEALED BEFORE THE COMPANY\'S KEY CHANGES OPENS FOR A SIGNER SEATED AFTER IT', () => {
  it('DEE, ADMITTED AFTER CY IS REMOVED AND THE KEY ROTATES, OPENS THE ONE-OFF SEALED AT EPOCH 0 THROUGH THE ROTATION AND THE ONE SEALED AT EPOCH 1, AND CY OPENS NEITHER LATER ONE', async () => {
    /* Before the change: Ada's device files a one-off sealed at epoch 0, and it is anchored. */
    const before = newOneOffId();
    expect(await fileOneOffHere(filingAs(ADA, KEY), { id: before, given: given(41n) })).toMatchObject({ state: 'filed', version: 1 });
    await anchorTheRecordsHere(anchorDoorsOf(ADA));
    expect((await peopleRecords.versions(CO, ONE_OFF_KIND, before)).map((r) => r.keyEpoch)).toEqual([0]);

    /* Dee accepts a seat and the chain seats her leaf; Cy is removed, and Bo's device changes the key. */
    const made = await inviteSignerHere(ACME, ADA, { name: 'dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const keys: NewSeatKeys[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: (w) => { const k = newSeatKeys(w); keys.push(k); return k; }, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => DEES_KEY);
    const leaf = leafOfTheContract(kept[0]!.opening!)!;
    committeeKeyOfLeaf.set(leaf, DEES_KEY);
    const held = chains.get(CO)!;
    chains.set(CO, { ...held, seats: { ...held.seats, committee: [...held.seats.committee, DEES_KEY as never], seats: [...held.seats.seats, leaf] } });
    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    expect(await removeSignerOnDevice(deviceOf(BO), remove)).toMatchObject({ state: 'done' });
    expect(await rotateTheCompanyKeyHere({
      ...companyKeyDoorsOf(BO), accountId: CO, material: { signingSecret: BO.signingSecret },
      records: { directory: companyDirectory }, leaving: async () => new Set(),
    }, { leaf: CY.seat })).toMatchObject({ state: 'rotated', epoch: 1 });
    const ada = await companyKeyHere({ ...companyKeyDoorsOf(ADA), accountId: CO, material: { signingSecret: ADA.signingSecret }, records: deviceOf(ADA).records! });
    expect(ada.epoch).toBe(1);
    /* After the change, before Dee is admitted: Ada's device files a one-off sealed at epoch 1, and it is anchored. */
    const after = newOneOffId();
    expect(await fileOneOffHere(filingAs(ADA, ada), { id: after, given: given(42n) })).toMatchObject({ state: 'filed', version: 1 });
    await anchorTheRecordsHere(anchorDoorsOf(ADA));
    expect((await peopleRecords.versions(CO, ONE_OFF_KIND, after)).map((r) => r.keyEpoch)).toEqual([1]);
    /* Dee is admitted, and handed the key in force. */
    await admitSignerHere({ ...rosterDoorsOf(ADA), viewingKey: ada }, { signerId: accepted.signerId!, readOut: accepted.fingerprint });
    const handed = unwrapKey(store.getAccount(CO)!.wrappedKeys.find((w) => w.signerId === accepted.signerId)! as never, keys[0]!.wrappingSecret) as Hex;

    /* Dee's device holds only the key she was handed, and every older one through it. */
    const dee = await companyKeyHere({
      accountId: CO, material: { signingSecret: keys[0]!.signingSecret }, records: { directory: companyDirectory },
      filings: async () => store.directoryFilingsOf(CO), served: async () => handed, released: () => null, askTheWallet: async () => null,
    });
    expect([dee.epoch, dee.key]).toEqual([1, handed]);
    expect(handed).not.toBe(KEY);
    /* RED WHEN: a one-off sealed before the change does not open for a signer holding only the newer key, so they cannot account for it. */
    expect(await oneOffHere(readingAs('dee', dee), before)).toMatchObject({ state: 'read', oneOff: { amount: 41n } });
    /* RED WHEN: a one-off is opened with any key but its own epoch's, so one sealed after the change does not open with the key in force. */
    expect(await oneOffHere(readingAs('dee', dee), after)).toMatchObject({ state: 'read', oneOff: { amount: 42n } });
    /* RED WHEN: the removed signer, holding only the key from before the change, opens what is sealed after it. */
    expect(await oneOffHere(readingAs('cy', KEY), after)).toMatchObject({ state: 'unread', why: expect.stringMatching(/does not open with the company's key/u) });
  }, 170_000);
});
