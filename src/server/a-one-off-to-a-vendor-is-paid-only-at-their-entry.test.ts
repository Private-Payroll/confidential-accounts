/**
 * **A ONE-OFF PAYMENT TO A VENDOR ENTRY PASSES THE RAISE, THE CHECKS BEFORE AN APPROVAL AND THE PAYMENT ONLY AT THAT VENDOR'S OWN ADDRESS, AND A DEVICE
 * READS ONLY THE ONE-OFFS IT NEEDS.** A one-off names the vendor entry it pays beside the address it pays; the raising
 * device, every device checking it before it approves and the paying device each read the entry from the company's records and refuse the
 * one-off unless it pays the entry's address, on its network, at its keys - whatever the vendor's standing. Every
 * one-off a device believes is still counted in what the company paid. Paying or approving one one-off reads that one
 * alone; reading them all again finds every one already opened on the device, judged again against the company's
 * records, and fetches none.
 *
 * Over real HTTP; the chain is the test's.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hex } from '../core/crypto.js';
import type { PayrollRun } from '../core/types.js';
import { theNetwork } from '../midnight/network.js';
import { payeeFor } from '../testing/payees.js';
import { TEST_TOKEN } from '../testing/assets.js';
import { vaultDetails } from '../testing/vault-details.js';
import { inviteHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import type { PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { changeVendorHere, readVendorsHere, type VendorsHere } from 'vaults-web-shared/vendors-on-device.js';
import { signedClaimRefusal } from 'vaults-web-shared/signed-claim-refusal.js';
import { openTheRoundHere } from 'vaults-web-shared/round-opened-here.js';
import { refuseWhatThisDeviceDidNotMake } from 'vaults-web-shared/what-this-device-made.js';
import { oneOffsHere, oneOffsKeptHere, oneOffVendorRefusal, refuseAOneOffToAnotherVendorHere, type OneOffsHere } from 'vaults-web-shared/one-off-here.js';
import { sealVendor } from '../core/vendor-record.js';
import { payeeAt } from '../core/payee-keys.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { oneOffToPayHere, raiseOneOffHere, type OneOffAsked } from 'vaults-web-shared/one-off-raised-here.js';
import { checkedAgainstTheRecordsAndTheWallet, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { ACME, acmeDirectory, fromAda, ORIGIN } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, anchorDoorsOf, CO, CY, deviceOf, KEY, ledgerViewNow, oneOffRaiseDoorsOf, oneOffRecordsOf, paidOnChain, sendAs, VAULT, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

aCompanyWhoseSignersChange();

const NETWORK = theNetwork();
const NOW = BigInt(Math.floor(Date.now() / 1000));
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK, claimRefusal: signedClaimRefusal,
  entered: s.entered,
});
/** `s`'s device's records with the company's vendors read on it, or with what `vendors` says instead. */
const withVendors = (s: Seat, vendors?: () => Promise<VendorsHere>): CompanyRecordsHere & { readonly oneOffs: OneOffsHere } =>
  ({ ...oneOffRecordsOf(s), vendors: vendors ?? (() => readVendorsHere(peopleOn(s))) });
const raisingOn = (s: Seat, vendors?: () => Promise<VendorsHere>) => ({ ...oneOffRaiseDoorsOf(s), records: withVendors(s, vendors) });
const asked = (vendor: string | null, address: string, o: Partial<OneOffAsked> = {}): OneOffAsked & { viewingKey: typeof KEY } => ({
  vault: VAULT, asset: TEST_TOKEN, amount: 4_200n, form: 'private',
  payee: { ref: vendor, name: 'Acme Printing', address, network: NETWORK }, reason: 'Invoice 2026-140, business cards',
  opensAt: NOW - 60n, closesAt: NOW + 86_400n, viewingKey: KEY, ...o,
});
/** The account's own check, on `who`'s device reading `records`, of what a proposal pays before an approval is built. */
const checkedOn = async (who: Seat, proposalId: string, records: CompanyRecordsHere = withVendors(who)) => {
  const opened = await openTheRoundHere(deviceOf(who).service, CO, proposalId, KEY, false, records);
  refuseWhatThisDeviceDidNotMake({
    runPayload: pureCircuits.runPayload, vaultDetails, retrySaltOf: pureCircuits.retrySaltOf, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
  }, opened, ledgerViewNow(), 'approve');
  return opened;
};
const PAYING = { runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, retrySaltOf: pureCircuits.retrySaltOf, paidAmong: async () => ({ known: true as const, paid: [] }) };
/** A vendor paid by one-off payments, added by Ada at the address `n` names: paid at it at once. */
const aVendor = async (n: number): Promise<string> => (await inviteHere(ACME, ADA, 'vendor', {
  name: `Vendor ${n}`, email: `vendor${n}@vendors.co`, startDate: '2026-10-01', terms: { kind: 'one-off' }, network: NETWORK, address: addressOf(n),
}, ORIGIN, fromAda, { vendors: () => readVendorsHere(peopleOn(ADA)) })).person!;
/** The company's vendors as `s`'s device reads them, with `id`'s entry paying `address` instead: what a lying device would raise from. */
const vendorsSayingOf = (s: Seat, id: string, address: string) => async (): Promise<VendorsHere> => {
  const read = await readVendorsHere(peopleOn(s));
  const other = (await readVendorsHere(peopleOn(s))).vendors.find((v) => v.vendor.address?.bech32 === address)?.vendor.address ?? null;
  return { ...read, vendors: read.vendors.map((v) => (v.vendor.id === id ? { ...v, vendor: { ...v.vendor, address: other } } : v)) };
};

let printer: string;
let other: string;

beforeEach(() => { paidOnChain.clear(); });

describe('A ONE-OFF TO A VENDOR ENTRY IS PAID ONLY AT THE ENTRY\'S OWN ADDRESS', () => {
  it('raised by Cy at the vendor\'s own address, it passes the checks Ada\'s device runs before approving and is offered to pay there, naming the entry', async () => {
    printer = await aVendor(91);
    other = await aVendor(92);
    const round = await raiseOneOffHere(raisingOn(CY), asked(printer, addressOf(91)));
    const opened = await checkedOn(ADA, round.id);
    expect((opened.made as { facts: { amount: bigint } }).facts.amount).toBe(4_200n);
    const pay = await oneOffToPayHere(withVendors(ADA), CO, KEY, round.id, PAYING);
    expect(pay.proposalId).toBe(round.id);
    /* RED WHEN: the vendor entry a one-off names is not kept in its record. */
    expect((await oneOffsHere(oneOffRecordsOf(ADA), CO)).believed.find((o) => o.oneOff.proposal.id === round.id)?.oneOff.payee.ref).toBe(printer);
  }, 170_000);

  it('RED WHEN: a one-off naming a vendor entry is raised at another address than the entry\'s, or naming an entry no device believes', async () => {
    await expect(raiseOneOffHere(raisingOn(CY), asked(printer, addressOf(92)))).rejects.toThrow(/pays another address than the vendor entry it names/u);
    await expect(raiseOneOffHere(raisingOn(CY), asked('ven_00000000000000000000', addressOf(91))))
      .rejects.toThrow(/the vendor entry it names is not one this device believes/u);
    /* RED WHEN: a page that cannot read the company's vendors raises a one-off naming one. */
    await expect(raiseOneOffHere(oneOffRaiseDoorsOf(CY), asked(printer, addressOf(91)))).rejects.toThrow(/cannot read the company's vendors/u);
  }, 170_000);

  it('RED WHEN: a one-off a device raised at another address than the vendor entry it names passes the checks another device runs before approving or paying it', async () => {
    /* Cy's device reads the printer's entry as paying the other vendor's address, and raises from that. */
    const round = await raiseOneOffHere(raisingOn(CY, vendorsSayingOf(CY, printer, addressOf(92))), asked(printer, addressOf(92)));
    await expect(checkedOn(ADA, round.id)).rejects.toThrow(/pays another address than the vendor entry it names/u);
    await expect(oneOffToPayHere(withVendors(ADA), CO, KEY, round.id, PAYING)).rejects.toThrow(/pays another address than the vendor entry it names/u);
    /* RED WHEN: a page that cannot read the vendors passes a one-off naming one through its checks before approving. */
    await expect(checkedOn(ADA, round.id, oneOffRecordsOf(ADA))).rejects.toThrow(/cannot read the company's vendors/u);
    /* RED WHEN: a one-off refused for its vendor entry is left out of what the company paid, so period totals and payroll's check undercount. */
    expect((await oneOffsHere(oneOffRecordsOf(ADA), CO)).believed.map((o) => o.oneOff.proposal.id)).toContain(round.id);
  }, 170_000);

  it('a vendor who has left is still paid a one-off at their entry\'s address: a one-off asks the address, never the standing', async () => {
    const read = await readVendorsHere(peopleOn(ADA));
    await changeVendorHere(peopleOn(ADA), read.vendors.find((v) => v.vendor.id === other)!, { status: 'leaver', endDate: '2026-12-31' }, async () => []);
    const round = await raiseOneOffHere(raisingOn(CY), asked(other, addressOf(92), { amount: 77n }));
    /* RED WHEN: a one-off to a vendor who has left is refused, so an invoice they are owed cannot be paid. */
    await expect(checkedOn(ADA, round.id)).resolves.toBeDefined();
  }, 170_000);

  it('RED WHEN: a seat files a vendor as having left at another address, and a one-off to the entry at that address is raised, or passes the checks run before approving, in the wallet\'s approve read or before paying', async () => {
    const acme = await aVendor(94);
    const elsewhere = addressOf(95);
    /* Cy's device reads Acme's entry as paying the other address, and raises a one-off to Acme there. */
    const round = await raiseOneOffHere(raisingOn(CY, async () => {
      const read = await readVendorsHere(peopleOn(CY));
      return { ...read, vendors: read.vendors.map((v) => (v.vendor.id === acme ? { ...v, vendor: { ...v.vendor, address: payeeAt(elsewhere, NETWORK) } } : v)) };
    }), asked(acme, elsewhere, { amount: 94n }));
    /* Ada's seat files Acme's second version: they have left, and their record pays the other address, at its own keys, with no code from Acme's wallet. */
    const first = (await readVendorsHere(peopleOn(ADA))).vendors.find((v) => v.vendor.id === acme)!.vendor;
    const rec = signCompanyFiling(sealVendor({ ...first, status: 'leaver', address: payeeAt(elsewhere, NETWORK), madeAt: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') }, 2, 0, KEY), ADA.signingSecret as Hex);
    expect((await sendAs(ADA.person)(`/api/accounts/${CO}/records/vendor/${acme}/2`, { method: 'PUT', body: JSON.stringify(toCompanyWire(rec)) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    await anchorTheRecordsHere(anchorDoorsOf(ADA));
    /* RED WHEN: a vendor who has left is read at an address their own wallet never gave, so a one-off to their entry pays it. */
    expect((await readVendorsHere(peopleOn(ADA))).notPayable.find((n) => n.here.vendor.id === acme)?.why).toMatch(/pays another address without a new code from their own wallet/u);
    await expect(raiseOneOffHere(raisingOn(CY), asked(acme, elsewhere, { amount: 95n }))).rejects.toThrow(/the vendor entry it names is not one this device believes and would pay/u);
    await expect(checkedOn(ADA, round.id)).rejects.toThrow(/the vendor entry it names is not one this device believes and would pay/u);
    const raised = (await oneOffsHere(oneOffRecordsOf(ADA), CO)).believed.find((o) => o.oneOff.proposal.id === round.id)!;
    /* The check the wallet's approve read makes, over the company's vendors as the wallet reads them. */
    await expect(refuseAOneOffToAnotherVendorHere(withVendors(ADA), raised.oneOff)).rejects.toThrow(/not one this device believes and would pay/u);
    await expect(oneOffToPayHere(withVendors(ADA), CO, KEY, round.id, PAYING)).rejects.toThrow(/not one this device believes and would pay/u);
  }, 170_000);

  it('RED WHEN: a one-off pays other keys than the vendor entry it names, though the address reads the same', async () => {
    const vendors = await readVendorsHere(peopleOn(ADA));
    const entry = vendors.vendors.find((v) => v.vendor.id === printer)!.vendor;
    const paidTo = { ...entry.address!, coinPublicKey: 'ee'.repeat(32) } as never;
    const payee = { ref: printer, name: null, address: addressOf(91), network: NETWORK };
    expect(oneOffVendorRefusal({ payee, paidTo: entry.address! }, vendors)).toBeNull();
    expect(oneOffVendorRefusal({ payee, paidTo }, vendors)).toMatch(/pays other keys than the vendor entry it names/u);
    expect(oneOffVendorRefusal({ payee: { ...payee, ref: null }, paidTo }, vendors)).toBeNull();
  });
});

describe('A DEVICE READS ONLY THE ONE-OFFS IT NEEDS', () => {
  /** `s`'s device's records, counting each one-off record fetched, with a place of its own to keep what it opens. */
  const counting = (s: Seat) => {
    const fetched: string[] = [];
    const base = withVendors(s);
    const kept = oneOffsKeptHere();
    const records = { ...base, oneOffs: { ...base.oneOffs, kept, at: (k: Parameters<OneOffsHere['at']>[0], id: string, v: number) => { fetched.push(id); return base.oneOffs.at(k, id, v); } } };
    return { records, fetched, kept };
  };

  it('paying one one-off, or checking it before approving, fetches that one alone, however many the company has made', async () => {
    const round = await raiseOneOffHere(raisingOn(CY), asked(printer, addressOf(91), { amount: 5n }));
    const { records, fetched } = counting(ADA);
    expect((await oneOffsHere(oneOffRecordsOf(ADA), CO)).believed.length).toBeGreaterThan(2);
    await oneOffToPayHere(records, CO, KEY, round.id, PAYING);
    /* RED WHEN: paying one one-off opens every one-off the company ever made. */
    expect(fetched.length).toBe(1);
    await checkedOn(ADA, round.id, records);
    /* RED WHEN: the checks run before approving it fetch it again, or any other. */
    expect(fetched.length).toBe(1);
  }, 170_000);

  it('a second read of every one-off, for a payroll raise\'s check of the chain, fetches none and opens none again, and a kept record the company\'s records do not hold is fetched afresh', async () => {
    const { records, fetched, kept } = counting(ADA);
    const all = (await oneOffsHere(records, CO)).believed;
    expect(fetched.length).toBe(all.length);
    const made = () => checkedAgainstTheRecordsAndTheWallet(records, CO, { period: '2026-10' } as PayrollRun, KEY, {
      kind: 'payroll', seeds: [], payKey: '00'.repeat(32), identity: { accountId: CO, runId: 'run_x', epoch: 0 }, facts: [], records: [], asset: TEST_TOKEN,
      opensAt: '0', closesAt: '1', required: '0',
    });
    const first = await made();
    /* RED WHEN: every payroll raise and approval fetches and opens every one-off the company ever made again. */
    expect(fetched.length).toBe(all.length);
    expect(first.raising?.oneOffs?.nonces.length).toBe(all.length);
    /* A record kept on the device is changed: it is not the one the company's records hold, so it is fetched again. */
    const [at, held] = [...kept.entries()][0]!;
    kept.set(at, { ...held, rec: { ...held.rec, sealed: { ...held.rec.sealed, body: `${held.rec.sealed.body.slice(0, -4)}AAAA` } } });
    const again = await made();
    /* RED WHEN: a kept one-off is believed without being judged again against the company's records. */
    expect(fetched.length).toBe(all.length + 1);
    expect(again.raising?.oneOffs?.nonces).toEqual(first.raising?.oneOffs?.nonces);
  }, 170_000);
});
