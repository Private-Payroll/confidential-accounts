/**
 * **A VENDOR IS ADDED, ADMITTED AND CHANGED ON A SEAT'S DEVICE, ON A LIST OF THEIR OWN.**
 * A vendor's invitation is filed with their first vendor entry, sealed under the company's vendors key and judged on
 * every device like any record; they are never read with the people on the payroll. Added by link, they are admitted
 * on the fingerprint they read out; added by a shielded address, they are paid at it at once and admitted on their
 * fingerprint; added by an unshielded address, on their wallet's signed claim of it, which every device checks. Their
 * address never moves except with a new code from the wallet that first handed one over.
 *
 * Over real HTTP, with the vendor's wallet played by the test.
 */
import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import { CLAIMED_HANDOVER_SCHEMA, type AddressClaimFor } from 'midnight-identity/profile/address-claim';
import { signUnshieldedClaim } from 'midnight-identity/profile/address-claim-signed';
import { NIGHT, TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { acceptanceProofOf, invitationIdOf, tokenOfLink } from '../core/invitation.js';
import { sealToInbox } from '../core/sealed-records.js';
import { openVendor, sealVendor, type VendorRecord } from '../core/vendor-record.js';
import { theNetwork } from '../midnight/network.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { payeeFor } from '../testing/payees.js';
import { payeeOf } from '../midnight/payee-address.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere, type InvitingCompany, type VendorByAddressDoors } from 'vaults-web-shared/invitation-on-device.js';
import { readPeopleHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import {
  admitVendorHere, changeVendorHere, readVendorsHere, VendorNotChanged, type VendorChange, type VendorHere, type VendorsHere,
} from 'vaults-web-shared/vendors-on-device.js';
import { aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, BO, CO, fromAda, KEY, LABEL, ORIGIN, peopleRecords, sendAs } from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

const NETWORK = theNetwork();
const device: PeopleDevice = {
  company: ACME as InvitingCompany, signingSecret: ADA.signingSecret, signedInAs: 'ada', send: fromAda, directory: acmeDirectory, network: NETWORK,
  entered: ADA.entered,
};
const walletOf = (n: number) => identityFromSecret(new Uint8Array(32).fill(n));
const shieldedOf = (n: number): string => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const unshieldedOf = (n: number): string => addressOfVerifyingKey(
  L.signatureVerifyingKey({ tag: 'schnorr', value: Buffer.from(walletOf(n).moneyAt(0).night).toString('hex') }).value, NETWORK as never);
const SLIP = 'cd'.repeat(32);
const MONTHLY = { kind: 'monthly' as const, asset: TEST_SETTLEMENT_ASSET, amount: 90000n };
const vendorSpec = (n: number, address?: string, terms: VendorRecord['terms'] = MONTHLY) => ({
  name: `Vendor ${n}`, email: `vendor${n}@vendors.co`, startDate: '2026-10-01', terms, network: NETWORK, ...(address === undefined ? {} : { address }),
});
/** The company's vendors as Ada's device reads them, which adding a vendor by address checks the address against. */
const HELD: VendorByAddressDoors = { vendors: () => readVendorsHere(device) };
const hereOf = async (id: string): Promise<VendorHere> => {
  const read = await readVendorsHere(device);
  return [...read.vendors, ...read.notPayable.map((x) => x.here)].find((v) => v.vendor.id === id)!;
};
const codeFor = (n: number, person: string, address: string): JoinCode => signJoinCode(walletOf(n), LABEL, person, { kind: 'payee', address, payslipKey: SLIP });
/** A version of the vendor `here` that Ada's seat files itself, sealed and entered as a device would. */
const filedAsAda = async (here: VendorHere, next: VendorRecord, signingSecret = ADA.signingSecret) => {
  const rec = signCompanyFiling(sealVendor(next, here.version + 1, 0, KEY), signingSecret);
  const r = await fromAda(`/api/accounts/${CO}/records/vendor/${next.id}/${here.version + 1}`, { method: 'PUT', body: JSON.stringify(toCompanyWire(rec)) });
  expect(r.status).toBe(201);
  await ADA.entered.enter([companyRecordEntry(rec)]);
};

describe('A VENDOR ENTRY IS FILED WITH ITS INVITATION, ON A LIST OF ITS OWN', () => {
  it('a vendor invited by link is filed pending with their terms, believed on every device, and never read as a person', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(1), ORIGIN, fromAda, HELD);
    const here = await hereOf(made.person!);
    /* RED WHEN: a vendor's invitation is filed without their vendor entry, so no device can read them. */
    expect(here).toMatchObject({ version: 1, vendor: { id: made.person, status: 'pending', terms: MONTHLY, address: null, madeBy: ADA.statement.signingKey } });
    /* RED WHEN: a vendor is read on the payroll's list. */
    const people = await readPeopleHere(device);
    expect([...people.people.map((p) => p.person.id), ...people.notBelieved]).not.toContain(made.person);
    /* RED WHEN: a vendor entry is kept under the payroll's kind, so the service would list it with the people. */
    expect(await peopleRecords.get(CO, 'person', made.person!)).toBeNull();
    expect((await peopleRecords.get(CO, 'vendor', made.person!))?.facts).toBeUndefined();
  });

  it('a vendor admitted on the fingerprint they read out is paid where their own wallet said, and sealed their payslips to', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(2), ORIGIN, fromAda, HELD);
    const code = codeFor(2, made.person!, shieldedOf(2));
    const { fingerprint } = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_v2'));
    /* RED WHEN: a vendor is admitted without the fingerprint they read out. */
    await expect(admitVendorHere(device, await hereOf(made.person!), 'aaaa-bbbb')).rejects.toThrow(/fingerprint this person read out/u);
    const admitted = await admitVendorHere(device, await hereOf(made.person!), fingerprint);
    expect(admitted).toMatchObject({ status: 'active', wrappingPublicKey: SLIP, handedOverBy: code.committeeKey.value, admittedBy: 'ada' });
    expect(admitted.address!.bech32).toBe(shieldedOf(2));
    const read: VendorsHere = await readVendorsHere(device, '2026-11');
    expect(read.vendors.some((v) => v.vendor.id === made.person && v.version === 2)).toBe(true);
    /* RED WHEN: what a vendor handed over is still waiting once they are admitted. */
    expect((await fromAda(`/api/accounts/${CO}/vendors/${made.person}/handover`, { method: 'GET' })).body).toEqual({ inbox: null });
    /* RED WHEN: a vendor is admitted twice. */
    await expect(admitVendorHere(device, await hereOf(made.person!), fingerprint)).rejects.toThrow(/already been admitted/u);
  });

  it('a vendor added by a shielded address is paid at it at once, and admitted on their fingerprint of a code for exactly it', async () => {
    const typed = shieldedOf(3);
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(3, typed), ORIGIN, fromAda, HELD);
    const read = await readVendorsHere(device, '2026-11');
    /* RED WHEN: a vendor added by address cannot be paid until their wallet joins. */
    expect(read.vendors.find((v) => v.vendor.id === made.person)?.vendor).toMatchObject({ status: 'active', invitedAddress: typed, address: { bech32: typed } });
    const code = codeFor(3, made.person!, typed);
    const { fingerprint } = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_v3'));
    const admitted = await admitVendorHere(device, await hereOf(made.person!), fingerprint);
    expect(admitted).toMatchObject({ wrappingPublicKey: SLIP, invitedAddress: typed });
    expect((await readVendorsHere(device)).vendors.some((v) => v.vendor.id === made.person)).toBe(true);
  });

  it('RED WHEN: a vendor added by an address that money cannot reach in their terms\' token is added', async () => {
    await expect(inviteHere(ACME, ADA, 'vendor', vendorSpec(4, 'mn_shield-addr_nonsense'), ORIGIN, fromAda, HELD)).rejects.toThrow(/not one money can be sent to/u);
    await expect(inviteHere(ACME, ADA, 'vendor', vendorSpec(4, unshieldedOf(4), MONTHLY), ORIGIN, fromAda, HELD)).rejects.toThrow(/could not reach the address typed/u);
  });

  it('a vendor added by an unshielded address is admitted on their wallet\'s signed claim of it, which every device checks', async () => {
    const typed = unshieldedOf(5);
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(5, typed, { kind: 'one-off' }), ORIGIN, fromAda, HELD);
    const person = made.person!;
    const forOf = (address: string): AddressClaimFor => ({ company: LABEL, person, payslipKey: SLIP, address, network: NETWORK });
    const opened = await openInvitationHere(made.link, sendAs(null));
    const token = tokenOfLink(made.link)!;
    const handover = sealToInbox({ schema: CLAIMED_HANDOVER_SCHEMA, code: codeFor(5, person, typed), claim: signUnshieldedClaim(walletOf(5), 0, forOf(typed)) },
      opened.signed.offer.inboxPublicKey);
    expect((await sendAs('usr_v5')(`/api/invites/${invitationIdOf(token)}/accept-payee`, {
      method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), handover, kind: 'vendor' }),
    })).status).toBe(201);
    const admitted = await admitVendorHere(device, await hereOf(person), '');
    expect(admitted.addressClaim).toMatchObject({ kind: 'unshielded', address: typed });
    expect((await readVendorsHere(device)).vendors.some((v) => v.vendor.id === person)).toBe(true);
    /* RED WHEN: a version whose claim of the typed address another wallet signed is believed payable on any device. */
    const forged = { ...signUnshieldedClaim(walletOf(6), 0, forOf(unshieldedOf(6))), address: typed };
    await filedAsAda(await hereOf(person), { ...admitted, addressClaim: forged });
    expect((await readVendorsHere(device)).notPayable.find((x) => x.here.vendor.id === person)?.why).toMatch(/claim of the address they were added by is refused/u);
  });
});

describe('ONE VENDOR, ONE ENTRY', () => {
  it('RED WHEN: a vendor is added by an address an active vendor entry is already paid at, or by a page that cannot read the vendors', async () => {
    const typed = shieldedOf(21);
    await inviteHere(ACME, ADA, 'vendor', vendorSpec(21, typed), ORIGIN, fromAda, HELD);
    await expect(inviteHere(ACME, ADA, 'vendor', vendorSpec(22, typed), ORIGIN, fromAda, HELD))
      .rejects.toThrow(/Vendor 21 is already a vendor of this company paid at this address/u);
    await expect(inviteHere(ACME, ADA, 'vendor', vendorSpec(23, shieldedOf(23)), ORIGIN, fromAda)).rejects.toThrow(/cannot read the company's vendors/u);
    /* A vendor invited by link has no address yet, so nothing is read for them. */
    await expect(inviteHere(ACME, ADA, 'vendor', vendorSpec(24), ORIGIN, fromAda)).resolves.toBeDefined();
  });
});

describe('A VENDOR\'S ADDRESS MOVES ONLY WITH THEIR OWN WALLET', () => {
  it('RED WHEN: a version that pays another wallet\'s address, under that wallet\'s own code, is believed payable', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(7), ORIGIN, fromAda, HELD);
    const code = codeFor(7, made.person!, shieldedOf(7));
    const { fingerprint } = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_v7'));
    const admitted = await admitVendorHere(device, await hereOf(made.person!), fingerprint);
    /* Ada's seat files a version that pays another wallet's address, under that wallet's own code. */
    const other = codeFor(8, made.person!, shieldedOf(8));
    await filedAsAda(await hereOf(made.person!), {
      ...admitted, payeeCode: other, handedOverBy: other.committeeKey.value, address: payeeOf(shieldedOf(8), NETWORK),
    });
    expect((await readVendorsHere(device)).notPayable.find((x) => x.here.vendor.id === made.person)?.why).toMatch(/another wallet than the wallet that first handed/u);
  });

  it('RED WHEN: a version that names another typed address than the first is believed payable', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(9, shieldedOf(9)), ORIGIN, fromAda, HELD);
    const here = await hereOf(made.person!);
    await filedAsAda(here, { ...here.vendor, invitedAddress: shieldedOf(10), address: payeeOf(shieldedOf(10), NETWORK) });
    expect((await readVendorsHere(device)).notPayable.find((x) => x.here.vendor.id === made.person)?.why).toMatch(/address it was first filed with/u);
  });

  it('RED WHEN: a vendor version no seat signed, or naming another maker than its filer, is believed', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(11, shieldedOf(11)), ORIGIN, fromAda, HELD);
    const here = await hereOf(made.person!);
    /* The service keeps a version signed by a key that is no seat's, naming no maker. */
    const { madeBy: _m, madeAt: _a, ...unnamed } = here.vendor;
    await peopleRecords.put(signCompanyFiling(sealVendor({ ...unnamed, name: 'Somebody Else' }, 2, 0, KEY), newSigningKeypair().secret));
    expect((await readVendorsHere(device)).notBelieved).toContain(made.person);
    const other = await inviteHere(ACME, ADA, 'vendor', vendorSpec(12, shieldedOf(12)), ORIGIN, fromAda, HELD);
    const there = await hereOf(other.person!);
    await filedAsAda(there, { ...there.vendor, madeBy: BO.statement.signingKey as Hex });
    expect((await readVendorsHere(device)).notBelieved).toContain(other.person);
    /* RED WHEN: a vendor version that names no maker and no moment is believed. */
    const third = await inviteHere(ACME, ADA, 'vendor', vendorSpec(14, shieldedOf(14)), ORIGIN, fromAda, HELD);
    const plain = await hereOf(third.person!);
    const { madeBy: _b, madeAt: _t, ...noMaker } = plain.vendor;
    const rec = signCompanyFiling(sealVendor(noMaker, plain.version + 1, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/accounts/${CO}/records/vendor/${third.person}/${plain.version + 1}`, { method: 'PUT', body: JSON.stringify(toCompanyWire(rec)) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    expect((await readVendorsHere(device)).notBelieved).toContain(third.person);
  });
});

describe('A VENDOR IS CHANGED ON A SEAT\'S DEVICE', () => {
  it('their terms, end date and standing are changed as signed versions; an end date never leaves out a month already raised', async () => {
    const made = await inviteHere(ACME, ADA, 'vendor', vendorSpec(13, shieldedOf(13)), ORIGIN, fromAda, HELD);
    const raisedFeb = async () => ['2027-02'];
    const change: VendorChange = { terms: { ...MONTHLY, amount: 95000n }, endDate: '2027-06-30' };
    const changed = await changeVendorHere(device, await hereOf(made.person!), change, raisedFeb);
    expect(changed).toMatchObject({ terms: { amount: 95000n }, endDate: '2027-06-30', madeBy: ADA.statement.signingKey });
    expect(openVendor((await peopleRecords.get(CO, 'vendor', made.person!))!, KEY).endDate).toBe('2027-06-30');
    /* RED WHEN: an end date leaves out a month a run has already been raised for. */
    await expect(changeVendorHere(device, await hereOf(made.person!), { endDate: '2027-01-31' }, raisedFeb)).rejects.toThrow(/leave out a month already raised/u);
    await expect(changeVendorHere(device, await hereOf(made.person!), { terms: { kind: 'monthly', asset: NIGHT, amount: 0n } }, raisedFeb)).rejects.toThrow(VendorNotChanged);
    /* A vendor paid within their dates only. */
    expect((await readVendorsHere(device, '2027-07')).notPayable.find((x) => x.here.vendor.id === made.person)?.why).toMatch(/end date is 2027-06-30, before 2027-07/u);
    await expect(changeVendorHere(device, await hereOf(made.person!), { status: 'leaver' }, raisedFeb)).resolves.toMatchObject({ status: 'leaver' });
  });
});
