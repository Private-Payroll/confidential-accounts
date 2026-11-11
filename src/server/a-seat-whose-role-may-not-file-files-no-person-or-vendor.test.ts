/**
 * **A SEAT WHOSE ROLE MAY NOT FILE A PERSON OR A VENDOR FILES NEITHER, AND NOTHING IS SENT.**
 * The role is read from the directory this device believes, as every reader reads it, and judged by the one role list
 * (`mayFile`) before a status, a change or an admission is sent. An approver is told which roles may file the
 * record; a seat of one of those roles still files it, and the service judges no role.
 *
 * Over real HTTP, with the company's directory and records as the service keeps them.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { newWrappingKeypair } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { theNetwork } from '../midnight/network.js';
import { payeeFor } from '../testing/payees.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere, type InvitingCompany, type InvitationSend } from 'vaults-web-shared/invitation-on-device.js';
import {
  admitHere, changePersonHere, PersonNotChanged, readPeopleHere, setStatusHere, type PeopleDevice, type PersonHere,
} from 'vaults-web-shared/people-on-device.js';
import { admitVendorHere, changeVendorHere, readVendorsHere, VendorNotChanged, type VendorHere } from 'vaults-web-shared/vendors-on-device.js';
import { signedClaimRefusal } from 'vaults-web-shared/signed-claim-refusal.js';
import { madeHere } from 'vaults-web-shared/people-on-device.js';
import { sealingWith } from '../core/company-key.js';
import { sealPerson } from '../core/person-record.js';
import type { RosterEmployee } from '../core/types.js';
import { companyRecordEntry, signedWithItsEntry } from '../midnight/record-manifest.js';
import { toCompanyWire } from '../midnight/sealed-record-wire.js';
import { aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, BO, fromAda, LABEL, ORIGIN, sendAs, type Seat } from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

const NETWORK = theNetwork();
const sent: string[] = [];
const counted = (send: InvitationSend): InvitationSend => async (path, init) => { sent.push(`${init?.method ?? 'GET'} ${path}`); return send(path, init); };
const deviceOf = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: counted(sendAs(s.person)), directory: acmeDirectory,
  network: NETWORK, claimRefusal: signedClaimRefusal, entered: s.entered,
});

const PERSON = { name: 'Payee 1', email: 'payee1@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500001n, classification: 'full-time' as const, startDate: '2026-10-01' };
const VENDOR = { name: 'Vendor 1', email: 'vendor1@vendors.co', startDate: '2026-10-01', terms: { kind: 'monthly' as const, asset: TEST_SETTLEMENT_ASSET, amount: 90000n }, network: NETWORK };
const personOf = async (id: string): Promise<PersonHere> => {
  const read = await readPeopleHere(deviceOf(ADA));
  return [...read.people, ...read.notPayable.map((x) => x.here)].find((p) => p.person.id === id)!;
};
const vendorOf = async (id: string): Promise<VendorHere> => (await readVendorsHere(deviceOf(ADA))).vendors.find((v) => v.vendor.id === id)!;

describe('A SEAT WHOSE ROLE MAY NOT FILE A PERSON OR A VENDOR FILES NEITHER', () => {
  it('an approver\'s person filing is refused on the device, naming the role that may file, and nothing is sent', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', PERSON, ORIGIN, fromAda);
    const here = await personOf(made.person!);
    sent.length = 0;
    const bo = deviceOf(BO);
    /* RED WHEN: an approver's status, change or admission of a person is sent, to be refused by every reader. */
    for (const go of [
      () => setStatusHere(bo, here, 'leaver'),
      () => changePersonHere(bo, here, { endDate: '2027-01-01' } as never, async () => []),
    ]) {
      /* RED WHEN: the refusal does not say what resolves it: which roles may file a person's record. */
      await expect(go()).rejects.toThrow(/role, approver, may not file person records\. A seat whose role may file them \(admin\) must make this change\. Nothing was filed\./u);
    }
    expect(sent).toEqual([]);
  });

  it('an approver\'s admission of a person is refused, and nothing is filed', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', { ...PERSON, name: 'Payee 3', email: 'payee3@acme.co' }, ORIGIN, fromAda);
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(33)), LABEL, 'usr_33', { kind: 'payee', address: payeeFor('21'.repeat(32), NETWORK).bech32, payslipKey: newWrappingKeypair().publicKey });
    const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_33'));
    const here = await personOf(made.person!);
    sent.length = 0;
    /* RED WHEN: an approver's admission of a person is filed, to be refused by every reader. */
    await expect(admitHere(deviceOf(BO), here, accepted.fingerprint)).rejects.toThrow(/role, approver, may not file person records\. A seat whose role may file them \(admin\) must make this change\./u);
    expect(sent.filter((s) => s.startsWith('POST') || s.startsWith('PUT'))).toEqual([]);
  });

  it('an approver\'s vendor filing is refused on the device, and nothing is sent', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', VENDOR, ORIGIN, fromAda, { vendors: () => readVendorsHere(deviceOf(ADA)) });
    const here = await vendorOf(made.person!);
    sent.length = 0;
    const bo = deviceOf(BO);
    /* RED WHEN: an approver's change or admission of a vendor is sent, to be refused by every reader. */
    await expect(changeVendorHere(bo, here, { status: 'leaver', endDate: '2027-01-01' }, async () => [])).rejects.toThrow(/role, approver, may not file vendor records\. A seat whose role may file them \(admin\) must make this change\./u);
    expect(sent).toEqual([]);
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(34)), LABEL, made.person!, { kind: 'payee', address: payeeFor('22'.repeat(32), NETWORK).bech32, payslipKey: newWrappingKeypair().publicKey });
    const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_34'));
    sent.length = 0;
    await expect(admitVendorHere(bo, here, accepted.fingerprint)).rejects.toThrow(VendorNotChanged);
    expect(sent.filter((x) => x.startsWith('POST') || x.startsWith('PUT'))).toEqual([]);
  });

  it('a person version an approver sends straight to the service is believed by no reader, and pays nobody by it', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', { ...PERSON, name: 'Payee 4', email: 'payee4@acme.co' }, ORIGIN, fromAda);
    const here = await personOf(made.person!);
    /* Bo's own device would refuse this; a page that skips the check sends it, and the service judges no role. */
    const sealing = sealingWith(ACME.viewingKey, ACME.keyEpoch);
    const boFiles: RosterEmployee = { ...here.person, title: 'Director', ...madeHere(BO.signingSecret) };
    const rec = signedWithItsEntry(sealPerson(boFiles, here.version + 1, sealing.epoch, sealing.key), BO.signingSecret);
    const r = await sendAs(BO.person)(`/api/people/${encodeURIComponent(here.person.id)}/details`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await BO.entered.enter([companyRecordEntry(rec)]);
    const read = await readPeopleHere(deviceOf(ADA));
    /* RED WHEN: a reader believes a person version filed by a seat whose role may not file people, so an approver sets who is paid. */
    expect(read.notBelieved).toContain(here.person.id);
    expect([...read.people, ...read.notPayable.map((x) => x.here)].some((p) => p.person.id === here.person.id)).toBe(false);
  });

  it('a seat whose role may file a person\'s record still files it', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', { ...PERSON, name: 'Payee 2', email: 'payee2@acme.co' }, ORIGIN, fromAda);
    const here = await personOf(made.person!);
    sent.length = 0;
    /* RED WHEN: an approver's person filing is sent. */
    await expect(setStatusHere(deviceOf(BO), here, 'leaver')).rejects.toThrow(PersonNotChanged);
    expect(sent).toEqual([]);
    /* RED WHEN: the check refuses a seat whose role does file a person's record. */
    const done = await setStatusHere(deviceOf(ADA), here, 'leaver');
    expect(done.status).toBe('leaver');
    expect(sent.some((s) => s.startsWith('POST'))).toBe(true);
  });
});
