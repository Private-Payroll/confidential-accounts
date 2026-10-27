/**
 * A person or vendor is paid at the keys their address names, and every check reads those keys from the address
 * itself: a record whose stored keys are not its address's is refused by the one payable check, across a vendor's
 * versions, and where a run's payments are worked out. Each list is judged by its own rule, chosen by what the record
 * is and never by a field it happens to carry, and the two lists never share an id.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { newSymmetricKey } from './crypto.js';
import { openPerson, sealPerson, whyNotPayable, whyVendorNotPayable } from './person-record.js';
import { openVendor, sealVendor, vendorVersionsRefusal, type VendorRecord } from './vendor-record.js';
import { factsOfThePaid } from './run-legs.js';
import { payeeKeysRefusal } from './payee-keys.js';
import { payeeFor } from '../testing/payees.js';
import { payeeOf } from '../midnight/payee-address.js';
import { theNetwork } from '../midnight/network.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import type { RosterEmployee } from './types.js';

const NETWORK = theNetwork();
const LABEL = `co_${'a7'.repeat(32)}`;
const KEY = newSymmetricKey();
const SLIP = 'cd'.repeat(32);
const TYPED = payeeFor('41'.repeat(32), NETWORK).bech32;
const OTHER = payeeFor('99'.repeat(32), NETWORK);
/** The typed address with somebody else's keys beside it: what a filer who swaps where the money goes would file. */
const swapped = () => ({ ...payeeOf(TYPED, NETWORK), coinPublicKey: OTHER.coinPublicKey, encryptionPublicKey: OTHER.encryptionPublicKey }) as never;

const vendor = (over: Partial<VendorRecord> = {}): VendorRecord => ({
  id: 'ven_00000000000000000041', accountId: 'acc_x', name: 'Vendor 41', email: null, network: NETWORK, startDate: '2026-10-01',
  terms: { kind: 'monthly', asset: TEST_TOKEN as never, amount: 90000n }, status: 'active', invitedAddress: TYPED,
  address: payeeOf(TYPED, NETWORK), wrappingPublicKey: null, handedOverBy: null, admittedBy: null, admittedAt: null, ...over,
});
const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(41)), LABEL as never, 'emp_00000000000000000041', { kind: 'payee', address: TYPED, payslipKey: SLIP });
const person = (over: Partial<RosterEmployee> = {}): RosterEmployee => ({
  id: 'emp_00000000000000000041', accountId: 'acc_x', name: 'Payee 41', email: 'p@x.co', title: 'T', asset: TEST_TOKEN as never, baseAmount: 500n,
  startDate: '2026-01-01', status: 'active', wrappingPublicKey: SLIP, handedOverBy: code.committeeKey.value, admittedBy: 'ada', admittedAt: null,
  selfRaised: false, address: payeeOf(TYPED, NETWORK), payeeCode: code, ...over,
});

describe('WHAT A RECORD PAYS IS WHAT ITS ADDRESS NAMES', () => {
  it('a record whose address and keys agree is payable, on both lists', () => {
    expect(payeeKeysRefusal(payeeOf(TYPED, NETWORK))).toBeNull();
    expect(whyNotPayable(person(), LABEL, '2026-10')).toBeNull();
    expect(whyVendorNotPayable(vendor(), LABEL, '2026-10')).toBeNull();
  });

  it('RED WHEN: a vendor version that keeps the typed address and swaps its keys is believed payable, on any version', () => {
    const forged = openVendor(sealVendor(vendor({ address: swapped() }), 2, 0, KEY), KEY);
    expect(whyVendorNotPayable(forged, LABEL, '2026-10')).toMatch(/not the keys of the address it names/u);
    expect(vendorVersionsRefusal([vendor(), forged])).toMatch(/not the keys of the address it names/u);
  });

  it('RED WHEN: an employee version that keeps their code\'s address and swaps its keys is believed payable', () => {
    expect(whyNotPayable(person({ address: swapped() }), LABEL, '2026-10')).toMatch(/not the keys of the address it names/u);
  });

  it('RED WHEN: a run\'s payment is worked out at keys the address does not name', () => {
    const paid = [{ id: 'emp_00000000000000000041', name: 'Payee 41', wrappingPublicKey: SLIP, asset: TEST_TOKEN, amount: 500n, form: 'shielded' as const }];
    expect(factsOfThePaid(paid as never, () => person(), registryWithTestPrivateForms())).toHaveLength(1);
    expect(() => factsOfThePaid(paid as never, () => person({ address: swapped() }), registryWithTestPrivateForms())).toThrow(/not the keys of the address it names/u);
  });

  it('RED WHEN: an address read on another network than the one it is for is believed', () => {
    expect(payeeKeysRefusal({ ...payeeOf(TYPED, NETWORK), network: NETWORK === 'mainnet' ? 'preview' : 'mainnet' })).toMatch(/not one money can be sent to/u);
  });
});

describe('EACH LIST IS JUDGED BY ITS OWN RULE, AND THE TWO NEVER SHARE AN ID', () => {
  it('RED WHEN: an employee carrying payment terms is paid at their typed address without their code', () => {
    const p = person({ payeeCode: null, handedOverBy: null, invitedAddress: TYPED, terms: { kind: 'one-off' } } as never);
    expect(whyNotPayable(p, LABEL, '2026-10')).toMatch(/no code their own wallet signed/u);
  });

  it('RED WHEN: a person record carrying a vendor\'s terms, or named as a vendor, is opened as a person', () => {
    expect(() => openPerson(sealPerson(person({ terms: { kind: 'one-off' } } as never), 2, 0, KEY), KEY)).toThrow(/carries a vendor's payment terms/u);
    expect(() => openPerson(sealPerson(person({ id: 'ven_11111111111111111111' }), 1, 0, KEY), KEY)).toThrow(/record is not an employee's/u);
    expect(openPerson(sealPerson(person(), 1, 0, KEY), KEY).id).toBe('emp_00000000000000000041');
  });

  it('RED WHEN: a vendor entry named as an employee is opened as a vendor', () => {
    expect(() => openVendor(sealVendor(vendor({ id: 'emp_00000000000000000041' }), 1, 0, KEY), KEY)).toThrow(/vendor entry's id/u);
  });
});
