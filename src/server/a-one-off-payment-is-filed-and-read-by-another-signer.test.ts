import { describe, it, expect } from 'vitest';
import { newSigningKeypair, newSymmetricKey, type Hex } from '../core/crypto.js';
import type { CompanyKeys } from '../core/company-key.js';
import { signCompanyFiling } from '../midnight/sealed-record-wire.js';
import { recordKeyOf } from '../midnight/record-manifest.js';
import { newOneOffId, newOneOffSeed, ONE_OFF_KIND, openOneOff, type OneOffGiven } from '../midnight/one-off-record.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import { HttpCompanyRecordStore, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { judgeIn } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { oneOffHere } from 'vaults-web-shared/one-off-here.js';
import { fileOneOffHere, OneOffNotFiled, type OneOffFilingDoors } from 'vaults-web-shared/one-off-raised-here.js';
import {
  aCompanyWhoseSignersChange, anchorDoorsOf, ADA, BO, CO, CY, directoryOf, KEY, sendAs,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { peopleRecords } from './a-company-of-two-seats.test-support.js';

/**
 * A one-off payment's record, filed from one signer's device through the
 * service's own routes, entered in the company's records and anchored, then
 * read back on another signer's device with the company's key it holds.
 * What the service is sent is read too: the sealed bytes and the random id,
 * and nothing about what is paid, to whom or why.
 */

aCompanyWhoseSignersChange();

const REGISTRY = registryWithTestPrivateForms();
type Who = typeof ADA;

/** Every body `who`'s device sends the service, kept as sent. */
const sentBy = new Map<string, string[]>();
const sendOf = (who: Who): WireSend => async (path, init) => {
  sentBy.set(who.person, [...(sentBy.get(who.person) ?? []), `${init.method} ${path} ${init.body ?? ''}`]);
  return sendAs(who.person)(path, init as never);
};
const doorsOf = (who: Who): OneOffFilingDoors & { readonly open: typeof openOneOff } => ({
  accountId: CO,
  open: openOneOff,
  directory: directoryOf(who),
  records: (() => {
    const store = new HttpCompanyRecordStore(CO, sendOf(who), who.signingSecret as Hex, async (asked) => judgeIn(await directoryOf(who)(asked)));
    return { at: (k, id, v) => store.at(k, id, v), put: (rec) => store.put(rec), served: async () => null };
  })(),
  keys: KEY,
  signingSecret: who.signingSecret as Hex,
  entered: who.entered,
  keyEpoch: 0,
  registry: REGISTRY,
});

const given = (): OneOffGiven => ({
  vault: 'fa'.repeat(32) as Hex, asset: TEST_TOKEN, amount: 31_415_926n, form: 'private',
  payee: { ref: null, name: 'Northwind Paper Ltd', address: payeeFor('a7'.repeat(32), 'undeployed').bech32, network: 'undeployed' },
  reason: 'Invoice 2026-118, office paper',
  proposal: { id: 'prp_ABCDEFGHIJKL', chainId: 'c4'.repeat(32) as Hex },
  run: { opensAt: 1_000n, closesAt: 2_000n, required: 0n },
  seed: newOneOffSeed(),
});

describe('A ONE-OFF PAYMENT\'S RECORD IS FILED ON ONE SIGNER\'S DEVICE AND READ ON ANOTHER\'S', () => {
  it('FILED BY CY, ENTERED AND ANCHORED, IT IS READ BY ADA AND BO AS FILED, AND THE SERVICE WAS SENT NOTHING READABLE ABOUT IT', async () => {
    const id = newOneOffId();
    const g = given();
    expect(await fileOneOffHere(doorsOf(CY), { id, given: g })).toEqual({ state: 'filed', id, version: 1 });
    expect((await peopleRecords.versions(CO, ONE_OFF_KIND, id)).length).toBe(1);

    /* RED WHEN: the record is filed and not entered in the company's records, so no device believes it once the anchor is read. */
    const entered = (await directoryOf(BO)({ records: [{ store: 'company', kind: ONE_OFF_KIND, id }] })).records.notYetAnchored
      .filter((e) => e.kind === ONE_OFF_KIND && e.id === id);
    expect(entered.length).toBe(1);
    expect((await anchorTheRecordsHere(anchorDoorsOf(CY))).anchored).toBeGreaterThan(0);
    const anchored = (await directoryOf(BO)({ records: [{ store: 'company', kind: ONE_OFF_KIND, id }] })).records.history
      .get(recordKeyOf({ store: 'company', kind: ONE_OFF_KIND, id }));
    expect(anchored?.map((v) => v.version)).toEqual([1]);

    for (const reader of [ADA, BO]) {
      const read = await oneOffHere(doorsOf(reader), id);
      /* RED WHEN: another signer's device cannot open the record with its own records key, or reads other facts than were filed. */
      expect(read.state, read.state === 'unread' ? read.why : '').toBe('read');
      if (read.state !== 'read') continue;
      expect({ ...read.oneOff, paidTo: undefined, token: undefined }).toEqual({ ...g, paidTo: undefined, token: undefined });
    }

    /* RED WHEN: any of what is paid, to whom, why, or the seed its secrets come from reaches the service readable. */
    const sent = (sentBy.get(CY.person) ?? []).join('\n');
    expect(sent).toContain(id);
    for (const plain of ['31415926', 'Northwind', g.payee.address, 'Invoice 2026-118', g.seed]) expect(sent.includes(plain), plain).toBe(false);
  }, 170_000);

  it('THE SAME SEAT FILING THE SAME ONE-OFF AGAIN ENTERS IT AGAIN, AND ANOTHER SEAT OR ANOTHER PAYMENT UNDER ITS ID IS REFUSED', async () => {
    const id = newOneOffId();
    const g = given();
    await fileOneOffHere(doorsOf(BO), { id, given: g });
    /* RED WHEN: a filing resumed after it was filed files a second record, or is refused, so a one-off interrupted between filing and entering is stuck. */
    expect(await fileOneOffHere(doorsOf(BO), { id, given: g })).toEqual({ state: 'entered-again', id, version: 1 });
    /* RED WHEN: another payment is filed over a one-off already filed, so what its signers approve could be changed under them. */
    await expect(fileOneOffHere(doorsOf(BO), { id, given: { ...g, amount: g.amount + 1n } })).rejects.toThrow(OneOffNotFiled);
    await expect(fileOneOffHere(doorsOf(ADA), { id, given: g })).rejects.toThrow(/another record is already filed under this id/u);
    expect((await peopleRecords.versions(CO, ONE_OFF_KIND, id)).length).toBe(1);
  }, 170_000);

  it('A RECORD THE DIRECTORY DOES NOT BELIEVE ITS FILER OF IS NOT READ, WHATEVER STORE SERVED IT', async () => {
    const id = newOneOffId();
    await fileOneOffHere(doorsOf(ADA), { id, given: given() });
    const held = (await peopleRecords.versions(CO, ONE_OFF_KIND, id))[0]!;
    /* The same record, re-signed by a key no seat's entry names, served by a store that judges nothing. */
    const unjudged = { ...doorsOf(BO), records: { at: async () => signCompanyFiling(held, newSigningKeypair().secret as Hex) } };
    /* RED WHEN: a one-off is believed on its store's word alone, so a store that judges nothing hands a device a record anyone filed. */
    expect(await oneOffHere(unjudged, id)).toMatchObject({ state: 'unread', why: expect.stringMatching(/does not believe the company's record/u) });
    /* RED WHEN: a record served under another name is read as this one. */
    expect(await oneOffHere({ ...doorsOf(BO), records: { at: async () => ({ ...held, id: newOneOffId() }) } }, id))
      .toMatchObject({ state: 'unread', why: expect.stringMatching(/another record/u) });
  }, 170_000);

  it('A SIGNER WHO WAS NOT IN THE DIRECTORY THE FILING DEVICE READ OPENS IT WITH THE COMPANY\'S KEY', async () => {
    const id = newOneOffId();
    /* Ada's device files reading a directory that does not hold Cy's seat. */
    const withoutCy: OneOffFilingDoors['directory'] = async (asked) => {
      const here = await directoryOf(ADA)(asked);
      return { ...here, dir: { ...here.dir, seats: here.dir.seats.filter((x) => x.seat !== CY.seat) } };
    };
    await fileOneOffHere({ ...doorsOf(ADA), directory: withoutCy }, { id, given: given() });
    /* RED WHEN: a one-off opens only for the seats the filing device read, so a signer seated after it cannot account for it. */
    expect((await oneOffHere(doorsOf(CY), id)).state).toBe('read');
  }, 170_000);

  it('A RECORD SEALED UNDER A KEY ITS EPOCH DOES NOT NAME IS REFUSED ON THE FILING DEVICE, AS EVERY OTHER DEVICE WOULD REFUSE IT', async () => {
    const id = newOneOffId();
    const later = newSymmetricKey();
    /* Keys whose sealing hands epoch 1's key labelled as epoch 0, where every other device opens epoch 0 with the key it holds for it. */
    const mislabelled: CompanyKeys = { epoch: 1, key: later, newest: 1, keyAt: (e) => (e === 0 ? KEY : later), sealing: () => ({ key: later, epoch: 0 }) };
    /* RED WHEN: the filing device checks what it sealed with the key it sealed it with, so a record no other device opens is filed. */
    await expect(fileOneOffHere({ ...doorsOf(ADA), keys: mislabelled }, { id, given: given() })).rejects.toThrow(OneOffNotFiled);
    expect((await peopleRecords.versions(CO, ONE_OFF_KIND, id)).length).toBe(0);
  }, 170_000);
});
