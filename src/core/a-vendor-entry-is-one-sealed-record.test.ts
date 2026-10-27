/**
 * A vendor entry is its own kind of company record, sealed under the company's vendors key and never the payroll's,
 * with no salary and no classification: payment terms, dates, an address and where they stand. It is paid by the
 * one payable check every list uses, and the address it pays is fixed when it is added: a later version may change
 * it only with a new code signed by the same wallet that first handed one over.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { newSymmetricKey } from './crypto.js';
import { openRecord } from './sealed-records.js';
import { whyVendorNotPayable } from './person-record.js';
import {
  openVendor, sealVendor, VENDOR_PURPOSE, vendorAmountOnTheRun, vendorRecordRefusal, vendorVersionsRefusal, type VendorRecord,
} from './vendor-record.js';
import { whyThisIsNotACompanyRecord } from '../midnight/sealed-record-wire.js';
import { payeeFor } from '../testing/payees.js';
import { payeeOf } from '../midnight/payee-address.js';
import { theNetwork } from '../midnight/network.js';

const NETWORK = theNetwork();
const LABEL = `co_${'a7'.repeat(32)}`;
const KEY = newSymmetricKey();
const SLIP = 'cd'.repeat(32);
const TYPED = payeeFor('41'.repeat(32), NETWORK).bech32;
const ID = 'ven_00000000000000000041';
const codeOf = (n: number, address: string) => signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL as never, ID,
  { kind: 'payee', address, payslipKey: SLIP });

/** A vendor added by the private address typed, paid monthly, not yet claimed. */
const vendor = (over: Partial<VendorRecord> = {}): VendorRecord => ({
  id: ID, accountId: 'acc_x', name: 'Vendor 41', email: null, network: NETWORK, startDate: '2026-10-01',
  terms: { kind: 'monthly', asset: 'TEST' as never, amount: 90000n }, status: 'active', invitedAddress: TYPED,
  address: payeeOf(TYPED, NETWORK), wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null, ...over,
});
/** The same vendor once their wallet has handed over its code for the typed address. */
const claimed = (n = 41, address = TYPED, over: Partial<VendorRecord> = {}): VendorRecord => {
  const code = codeOf(n, address);
  return vendor({ payeeCode: code, handedOverBy: code.committeeKey.value, wrappingPublicKey: SLIP, address: payeeOf(address, NETWORK), ...over });
};

describe('A VENDOR ENTRY AS A COMPANY RECORD', () => {
  it('is sealed under the company\'s vendors key, carries nothing in the clear, and opens as it was sealed', () => {
    const rec = sealVendor(vendor(), 1, 0, KEY);
    expect(rec).toMatchObject({ company: 'acc_x', kind: 'vendor', id: ID, version: 1, keyEpoch: 0, wrapped: [] });
    expect(rec.facts).toBeUndefined();
    expect(whyThisIsNotACompanyRecord(rec, { company: 'acc_x', kind: 'vendor', id: ID })).toBeNull();
    /* RED WHEN: a vendor entry opens under the payroll's key, so anybody who reads salaries reads vendors. */
    expect(() => openRecord('payroll', 'acc_x', rec.sealed, KEY)).toThrow();
    expect(openRecord(VENDOR_PURPOSE, 'acc_x', rec.sealed, KEY)).toBeTruthy();
    expect(openVendor(rec, KEY)).toEqual(vendor());
  });

  it('refuses a record of another kind, and one that carries a salary or a classification', () => {
    const asPerson = { ...sealVendor(vendor(), 1, 0, KEY), kind: 'person' as const };
    expect(() => openVendor(asPerson, KEY)).toThrow(/not a vendor/u);
    /* RED WHEN: a vendor entry carrying an employee's salary or classification is read as a vendor. */
    expect(vendorRecordRefusal({ ...vendor(), baseAmount: 1n } as never)).toMatch(/no salary/u);
    expect(vendorRecordRefusal({ ...vendor(), classifications: [] } as never)).toMatch(/no salary/u);
    expect(vendorRecordRefusal(vendor({ terms: { kind: 'monthly', asset: 'TEST' as never, amount: 0n } }))).toMatch(/above nothing/u);
    expect(vendorRecordRefusal(vendor({ id: 'emp_00000000000000000041' }))).toMatch(/vendor entry's id/u);
    expect(vendorRecordRefusal(vendor({ endDate: '2026-09-30' }))).toMatch(/before their start date/u);
    expect(vendorRecordRefusal(vendor())).toBeNull();
  });
});

describe('THE ONE PAYABLE CHECK, OVER A VENDOR', () => {
  it('pays a vendor added by address at the typed address before they claim it, and within their dates only', () => {
    expect(whyVendorNotPayable(vendor(), LABEL, '2026-10')).toBeNull();
    expect(whyVendorNotPayable(vendor({ endDate: '2026-12-31' }), LABEL, '2027-01')).toMatch(/end date is 2026-12-31, before 2027-01/u);
    expect(whyVendorNotPayable(vendor(), LABEL, '2026-09')).toMatch(/after 2026-09/u);
    /* RED WHEN: a vendor with no code is paid at an address other than the one they were added by. */
    expect(whyVendorNotPayable(vendor({ address: payeeFor('42'.repeat(32), NETWORK) }), LABEL)).toMatch(/not the one they were added by/u);
    expect(whyVendorNotPayable(vendor({ invitedAddress: null, address: null }), LABEL)).toMatch(/added with no address/u);
    expect(whyVendorNotPayable(vendor({ status: 'pending' }), LABEL)).toMatch(/not active/u);
  });

  it('once they claim, pays them only at what their own wallet signed', () => {
    expect(whyVendorNotPayable(claimed(), LABEL)).toBeNull();
    expect(whyVendorNotPayable(claimed(41, TYPED, { wrappingPublicKey: 'ef'.repeat(32) }), LABEL)).toMatch(/payslip key/u);
    expect(whyVendorNotPayable(claimed(43, payeeFor('43'.repeat(32), NETWORK).bech32), LABEL)).toMatch(/another address than the one they were added by/u);
  });

  it('pays a monthly vendor their terms\' amount, and nothing on a run for a one-off vendor', () => {
    expect(vendorAmountOnTheRun(vendor(), '2026-11')).toBe(90000n);
    expect(() => vendorAmountOnTheRun(vendor({ terms: { kind: 'one-off' } }), '2026-11')).toThrow(/one-off/u);
  });
});

describe('A VENDOR\'S ADDRESS ACROSS THEIR VERSIONS', () => {
  it('stays the one they were added by, and may be claimed by their own wallet', () => {
    expect(vendorVersionsRefusal([vendor()])).toBeNull();
    expect(vendorVersionsRefusal([vendor(), claimed()])).toBeNull();
    expect(vendorVersionsRefusal([vendor({ status: 'pending', invitedAddress: null, address: null }), { ...claimed(), invitedAddress: null }])).toBeNull();
  });

  it('RED WHEN: a later version names another typed address than the first', () => {
    const other = payeeFor('44'.repeat(32), NETWORK).bech32;
    expect(vendorVersionsRefusal([vendor(), vendor({ invitedAddress: other, address: payeeOf(other, NETWORK) })]))
      .toMatch(/address it was first filed with/u);
  });

  it('RED WHEN: a version moves the address to another wallet\'s code after one wallet handed theirs over', () => {
    const byLink = { status: 'active' as const, invitedAddress: null };
    const first = claimed(45, payeeFor('45'.repeat(32), NETWORK).bech32, byLink);
    const moved = claimed(46, payeeFor('46'.repeat(32), NETWORK).bech32, byLink);
    expect(vendorVersionsRefusal([first, moved])).toMatch(/wallet that first handed/u);
  });

  it('RED WHEN: a version changes the address with no new code from their wallet', () => {
    const byLink = { invitedAddress: null };
    const first = claimed(47, payeeFor('47'.repeat(32), NETWORK).bech32, byLink);
    const moved = { ...first, address: payeeFor('48'.repeat(32), NETWORK) };
    expect(vendorVersionsRefusal([first, moved])).toMatch(/without a new code/u);
  });
});
