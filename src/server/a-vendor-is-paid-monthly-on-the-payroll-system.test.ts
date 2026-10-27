/**
 * **A VENDOR PAID MONTHLY IS PAID BY A PAYROLL RUN OVER THE VENDOR LIST, BESIDE THE EMPLOYEES' PAYROLL AND NEVER MIXED
 * WITH IT.** A run names the list it pays inside its seal; each month's checks of what is already raised read the run's
 * own list, so the payroll and a vendor run for one month never refuse each other. A vendor is paid their monthly
 * terms, in their terms' token, within their dates, checked at the draw, the raise, the approval and the payout
 * material; a vendor paid by one-off payments is never on a monthly run; a vendor added by address who has not claimed
 * their place is paid at that address with no payslip.
 *
 * Over real HTTP, with the people and vendors invited, accepted and admitted on devices as the product does it.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import { NIGHT, TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { openSealedRun, sealedRunOf } from '../core/run-legs.js';
import { signRunFiling } from '../core/run-filing.js';
import { peopleOnTheRun } from '../core/run-drawing.js';
import { assets } from '../core/assets.js';
import type { Employee, PayrollRun, SealedProposal } from '../core/types.js';
import { batchDigestOf, newProposalId, sealPayrollProposal } from '../core/proposal-filing.js';
import { sealVendor, type VendorRecord } from '../core/vendor-record.js';
import { payeeAt } from '../core/payee-keys.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { theNetwork } from '../midnight/network.js';
import { payeeFor } from '../testing/payees.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, type PeopleDevice, type PersonHere } from 'vaults-web-shared/people-on-device.js';
import { admitVendorHere, changeVendorHere, readVendorsHere, type VendorHere } from 'vaults-web-shared/vendors-on-device.js';
import { drawRunHere, type RunDrawDoors } from 'vaults-web-shared/run-drawn-here.js';
import { payableFactsOf, payeesHere, periodsPastDraftHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { factsHere } from 'vaults-web-shared/raise-checks-here.js';
import { runRoutes } from './run-routes.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, ADDRESS, CO, fromAda, KEY, LABEL, ORIGIN, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';

aCompanyOfTwoSeats((app, deps) => {
  app.use(runRoutes({ signedIn: deps.signedIn, member: deps.member, store, wiring: () => 'simulated', directoryOf: deps.directoryOf }));
});

const NETWORK = theNetwork();
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const SLIP = 'cd'.repeat(32);
const MONTHLY = { kind: 'monthly' as const, asset: TEST_SETTLEMENT_ASSET, amount: 90000n };
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK,
  entered: s.entered,
});
const recordsOf = (s: Seat) => ({
  people: () => readPeopleHere(peopleOn(s)), vendors: () => readVendorsHere(peopleOn(s)),
  runs: async () => store.listRuns(CO), proposals: async () => store.listProposals(CO), directory: acmeDirectory,
  roundIdentity: pureCircuits, roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id.toLowerCase(), { held: 'never' as const, approvals: 0 }])),
});
const drawingOn = (s: Seat): RunDrawDoors => ({
  api: async (path, init) => {
    const r = await sendAs(s.person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
    if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status, body: r.body });
    return r.body;
  },
  accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: s.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
  records: recordsOf(s) as never, by: s.person, entered: s.entered,
});
/** An employee invited, accepted with the code their own wallet signed, and admitted. */
const anEmployee = async (n: number): Promise<string> => {
  const code: JoinCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, `usr_${n}`, { kind: 'payee', address: addressOf(n), payslipKey: newWrappingKeypair().publicKey });
  const made = await inviteHere(ACME, ADA, 'employee', {
    name: `Payee ${n}`, email: `payee${n}@acme.co`, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500000n + BigInt(n),
    classification: 'full-time' as const, startDate: '2026-10-01',
  }, ORIGIN, fromAda);
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_${n}`));
  const read = await readPeopleHere(peopleOn(ADA));
  const here = [...read.people, ...read.notPayable.map((x) => x.here)].find((p: PersonHere) => p.person.id === made.person)!;
  await admitHere(peopleOn(ADA), here, accepted.fingerprint);
  return made.person!;
};
/** A vendor added by `address` (paid at once, no payslip key) or invited by link and admitted on their fingerprint. */
const aVendor = async (n: number, how: 'address' | 'link', terms: VendorRecord['terms'] = MONTHLY, endDate?: string): Promise<string> => {
  const made = await inviteHere(ACME, ADA, 'vendor', {
    name: `Vendor ${n}`, email: `vendor${n}@vendors.co`, startDate: '2026-10-01', terms, network: NETWORK,
    ...(how === 'address' ? { address: addressOf(n) } : {}), ...(endDate === undefined ? {} : { endDate }),
  }, ORIGIN, fromAda, { vendors: () => readVendorsHere(peopleOn(ADA)) });
  if (how === 'link') {
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, made.person!, { kind: 'payee', address: addressOf(n), payslipKey: SLIP });
    const { fingerprint } = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_v${n}`));
    const read = await readVendorsHere(peopleOn(ADA));
    const here = [...read.vendors, ...read.notPayable.map((x) => x.here)].find((v: VendorHere) => v.vendor.id === made.person)!;
    await admitVendorHere(peopleOn(ADA), here, fingerprint);
  }
  return made.person!;
};
/** A run raised, as a raise leaves it: filed again as proposed by Ada's seat and entered in the company's records. */
const raised = async (id: string): Promise<void> => {
  const refiled = signRunFiling(CO, { ...store.getRun(id)!, status: 'proposed' }, ADA.signingSecret as Hex);
  store.putRun(refiled);
  await ADA.entered.enter([{ store: 'run', run: refiled }]);
};
const onTheRun = (run: PayrollRun, id: string): Employee | undefined => run.employees.find((e) => e.id === id);
/** A payroll round for `runId`'s private leg, written down as a raise writes one, open and not yet seen on the chain. */
const aRoundFor = (runId: string): SealedProposal => ({
  id: newProposalId(), accountId: CO, status: 'open', createdAt: '2027-01-08T00:00:00.000Z', digest: 'd1'.repeat(32) as Hex,
  chainId: 'c1'.repeat(32) as Hex, approvalCount: 0, keyEpoch: 0,
  sealed: sealPayrollProposal({
    accountId: CO, viewingKey: KEY as Hex, vault: 'c5'.repeat(32) as Hex, summary: 'Payroll', proposedBy: ADA.seat,
    payload: { runId, form: 'shielded', entries: [], window: { root: '0b'.repeat(32) as Hex, payees: '1', opensAt: '0', closesAt: '1' } },
    change: { asset: TEST_SETTLEMENT_ASSET, amount: 0n, batchDigest: batchDigestOf([]), salt: '5d'.repeat(32) as Hex, vouched: { head: '1a'.repeat(32) as Hex, r: '5e'.repeat(32) as Hex } },
  }),
} as SealedProposal);

let employee: string;
let byAddress: string;
let byLink: string;
let oneOff: string;
let ended: string;
let january: PayrollRun;
let vendorsInJanuary: PayrollRun;

describe('A VENDOR PAID MONTHLY IS PAID BY A RUN OVER THE VENDOR LIST', () => {
  it('the payroll and a vendor run for one month are each drawn over their own list, each naming it inside its seal', async () => {
    employee = await anEmployee(71);
    byAddress = await aVendor(72, 'address');
    byLink = await aVendor(73, 'link');
    oneOff = await aVendor(74, 'address', { kind: 'one-off' });
    ended = await aVendor(75, 'address', MONTHLY, '2026-12-31');
    january = await drawRunHere(drawingOn(ADA), { period: '2027-01' });
    await raised(january.id);
    vendorsInJanuary = await drawRunHere(drawingOn(ADA), { period: '2027-01', list: 'vendors' });
    /* RED WHEN: a raised payroll for a month refuses the vendor run for that month. */
    expect(vendorsInJanuary.employees.map((e) => e.id).sort()).toEqual([byAddress, byLink].sort());
    /* RED WHEN: a vendor is paid on the employees' payroll, or an employee on a vendor run. */
    expect(january.employees.map((e) => e.id)).toEqual([employee]);
    /* RED WHEN: a vendor is paid other than their monthly terms, in their terms' token. */
    expect(onTheRun(vendorsInJanuary, byLink)).toMatchObject({ amount: 90000n, asset: TEST_SETTLEMENT_ASSET });
    /* RED WHEN: a run does not say inside its seal which list it pays, or says it where the service reads it. */
    expect(openSealedRun(store.getRun(vendorsInJanuary.id)!, KEY).list).toBe('vendors');
    expect(openSealedRun(store.getRun(january.id)!, KEY).list).toBe('employees');
    expect(Object.keys(store.getRun(vendorsInJanuary.id)!)).not.toContain('list');
  });

  it('a vendor paid by one-off payments is never on a monthly run, and is not recorded as left out of one', () => {
    /* RED WHEN: a vendor on one-off terms is drawn on a monthly run, or refuses it. */
    expect(onTheRun(vendorsInJanuary, oneOff)).toBeUndefined();
    expect((vendorsInJanuary.skips?.people ?? []).map((p) => p.employeeId)).not.toContain(oneOff);
  });

  it('a vendor whose dates leave out the month is set aside on the vendor run, with why', () => {
    /* RED WHEN: a vendor whose end date is before the month is paid for it. */
    expect(onTheRun(vendorsInJanuary, ended)).toBeUndefined();
    expect(vendorsInJanuary.skips?.people).toEqual([{ employeeId: ended, name: 'Vendor 75', waiting: 'outside their dates' }]);
    expect(vendorsInJanuary.skips!.decisions.decisions[0]!.reason).toMatch(/Vendor 75 is not paid for 2027-01: their end date is 2026-12-31, before 2027-01/u);
  });

  it('a vendor added by address who has not claimed their place is paid on the run with no payslip, and the others keep theirs', () => {
    /* RED WHEN: a vendor added by address cannot be paid monthly until their wallet claims their place. */
    expect(onTheRun(vendorsInJanuary, byAddress)).toMatchObject({ wrappingPublicKey: null, amount: 90000n, paidTo: addressOf(72) });
    /* RED WHEN: a payslip is made for somebody with no key to seal it to, or a payee with one gets none. */
    expect(vendorsInJanuary.employees.filter((e) => typeof e.slip === 'number').map((e) => e.id)).toEqual([byLink]);
    expect(onTheRun(vendorsInJanuary, byAddress)!.slip).toBeNull();
    expect(vendorsInJanuary.payslips).toHaveLength(1);
  });

  it('RED WHEN: an employee with no payslip key is drawn on a run: only a vendor added by address is paid without one', () => {
    const drawOver = (id: string) => peopleOnTheRun({
      runId: 'run_keyless', period: '2027-01', specs: [{ name: 'No Key', asset: TEST_SETTLEMENT_ASSET, amount: 1n }],
      roster: [{ id, name: 'No Key', status: 'active', address: null, wrappingPublicKey: null }], assets, company: { account: null, label: LABEL },
    });
    expect(() => drawOver('emp_00000000000000000071')).toThrow(/No Key has no key yet/u);
    expect(drawOver('ven_00000000000000000071')).toMatchObject({ employees: [{ wrappingPublicKey: null }], payslips: [] });
  });

  it('a second vendor run for a month whose vendor run is raised is refused, as a second payroll is', async () => {
    await raised(vendorsInJanuary.id);
    const before = store.listRuns(CO).length;
    /* RED WHEN: a vendor run for a month already raised is drawn again. */
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-01', list: 'vendors' })).rejects.toThrow(/a run for 2027-01 already exists/u);
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-01' })).rejects.toThrow(/a run for 2027-01 already exists/u);
    expect(store.listRuns(CO).length).toBe(before);
  });

  it('the months already raised are read per list, so a vendor run never holds back a change to an employee', async () => {
    const february = await drawRunHere(drawingOn(ADA), { period: '2027-02', list: 'vendors' });
    await raised(february.id);
    const records = recordsOf(ADA) as never;
    /* RED WHEN: a vendor run counts as a month raised for the employees, or not for the vendors. */
    expect(await periodsPastDraftHere(records, CO, KEY, new Date(), 'employees')).toEqual(['2027-01']);
    expect(await periodsPastDraftHere(records, CO, KEY, new Date(), 'vendors')).toEqual(['2027-01', '2027-02']);
    expect(await periodsPastDraftHere(records, CO, KEY)).toEqual(['2027-01']);
  });

  it('the raise and approval checks read the run\'s own list, and only the same list\'s runs as the month\'s others', async () => {
    const records = { ...recordsOf(ADA), policy: async () => ({ threshold: 1 }), payments: {} } as unknown as CompanyRecordsHere;
    const facts = await factsHere(records, CO, vendorsInJanuary, KEY);
    /* RED WHEN: a vendor run's raise or approval is checked against the employees. */
    expect(facts.people.list).toBe('vendors');
    expect(facts.people.people.map((p) => p.person.id)).toEqual(expect.arrayContaining([byAddress, byLink]));
    expect(facts.people.people.map((p) => p.person.id)).not.toContain(employee);
    expect((await factsHere(records, CO, january, KEY)).people.people.map((p) => p.person.id)).toEqual([employee]);
    /* RED WHEN: the payroll's live round for the month counts as another run of the month for a vendor run. */
    const live = await factsHere({ ...records, proposals: async () => [aRoundFor(january.id)] }, CO, vendorsInJanuary, KEY);
    expect([...live.live]).toEqual([january.id]);
    expect(live.others).toEqual([]);
  });

  it('RED WHEN: the raise, the approval or the payout pays a vendor other than their monthly terms, in another token, or outside their dates', async () => {
    const records = recordsOf(ADA) as unknown as CompanyRecordsHere;
    const vendors = await payeesHere(records, 'vendors');
    const leg = (over: Partial<Employee> = {}, id = byLink): Employee[] => [{ ...onTheRun(vendorsInJanuary, byLink)!, id, ...over }];
    const pay = (paid: Employee[], period = '2027-01') => payableFactsOf(vendors, paid, 'Leave them unpaid.', 'Not raised.', undefined, period);
    expect(pay(leg())).toHaveLength(1);
    expect(() => pay(leg({ amount: 90001n }))).toThrow(/at 90001, and their terms are 90000 a month/u);
    expect(() => pay(leg({ asset: NIGHT }))).toThrow(/in another token than their terms name/u);
    expect(() => pay(leg({ name: 'Vendor 75', paidTo: addressOf(75) }, ended))).toThrow(/is not payable for any day of it: their end date is 2026-12-31/u);
    expect(() => pay(leg({ name: 'Vendor 74', paidTo: addressOf(74) }, oneOff))).toThrow(/paid by one-off payments/u);
    /* RED WHEN: a vendor run is checked against the employees' list, where the vendor is nobody. */
    const employees = await payeesHere(records, 'employees');
    expect(() => payableFactsOf(employees, leg(), 'Leave them unpaid.', 'Not raised.', undefined, '2027-01'))
      .toThrow(/not on the roster/u);
    /* RED WHEN: a page that cannot read the vendors checks a vendor run against anything. */
    await expect(payeesHere({ people: records.people }, 'vendors')).rejects.toThrow(/cannot read the company's vendors/u);
  });

  it('RED WHEN: a vendor who has left, read at an address their own wallet never gave, holds up the vendor run', async () => {
    const gone = await aVendor(76, 'address');
    const first = (await readVendorsHere(peopleOn(ADA))).vendors.find((v) => v.vendor.id === gone)!.vendor;
    const rec = signCompanyFiling(sealVendor({ ...first, status: 'leaver', address: payeeAt(addressOf(77), NETWORK), madeAt: '2027-02-27T00:00:00Z' }, 2, 0, KEY), ADA.signingSecret as Hex);
    expect((await fromAda(`/api/accounts/${CO}/records/vendor/${gone}/2`, { method: 'PUT', body: JSON.stringify(toCompanyWire(rec)) })).status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    expect((await readVendorsHere(peopleOn(ADA))).notPayable.map((n) => n.here.vendor.id)).toContain(gone);
    const march = await drawRunHere(drawingOn(ADA), { period: '2027-03', list: 'vendors' });
    expect(march.employees.map((e) => e.id)).not.toContain(gone);
  });

  it('RED WHEN: a run is read as paying a list from outside its seal, or names a list the company does not keep', () => {
    const sealed = sealedRunOf({ ...january, list: undefined }, KEY, 0);
    expect(openSealedRun({ ...sealed, list: 'vendors' } as never, KEY).list).toBeUndefined();
    expect(() => openSealedRun(sealedRunOf({ ...january, list: 'contractors' as never }, KEY, 0) as never, KEY))
      .toThrow(/neither the employees nor the vendors/u);
  });

  it('RED WHEN: a vendor made a leaver part way through a month is left off that month\'s vendor run, or is made a leaver with no end date or one leaving out a month already raised', async () => {
    const ending = await aVendor(79, 'address');
    const vendorsPastDraft = () => periodsPastDraftHere(recordsOf(ADA) as never, CO, KEY, new Date(), 'vendors');
    const hereOfV = async (id: string) => { const r = await readVendorsHere(peopleOn(ADA)); return [...r.vendors, ...r.notPayable.map((n) => n.here)].find((v) => v.vendor.id === id)!; };
    await expect(changeVendorHere(peopleOn(ADA), await hereOfV(ending), { status: 'leaver' }, vendorsPastDraft)).rejects.toThrow(/has no end date/u);
    await expect(changeVendorHere(peopleOn(ADA), await hereOfV(ending), { status: 'leaver', endDate: '2027-01-15' }, vendorsPastDraft))
      .rejects.toThrow(/would leave out a month already raised/u);
    await changeVendorHere(peopleOn(ADA), await hereOfV(ending), { status: 'leaver', endDate: '2027-04-20' }, vendorsPastDraft);
    const april = await drawRunHere(drawingOn(ADA), { period: '2027-04', list: 'vendors' });
    expect(april.employees.map((e) => e.id)).toContain(ending);
    const may = await drawRunHere(drawingOn(ADA), { period: '2027-05', list: 'vendors' });
    expect(may.employees.map((e) => e.id)).not.toContain(ending);
    expect(may.skips!.decisions.decisions.map((d) => d.reason)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Vendor 79 is not paid for 2027-05: their end date is 2027-04-20, before 2027-05/u),
    ]));
  });

  it('RED WHEN: two vendor entries paid at one address are both drawn on a vendor run, or both paid at the raise, the approval or the payout', async () => {
    const once = await aVendor(80, 'address');
    /* A second entry at the same address, added by a device that read the vendors before the first was filed. */
    const twice = (await inviteHere(ACME, ADA, 'vendor', {
      name: 'Vendor 80 again', email: 'vendor80b@vendors.co', startDate: '2026-10-01', terms: MONTHLY, network: NETWORK, address: addressOf(80),
    }, ORIGIN, fromAda, { vendors: async () => ({ vendors: [], notPayable: [] }) })).person!;
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-06', list: 'vendors' }))
      .rejects.toThrow(/Vendor 80 and Vendor 80 again are two vendor entries paid at one address/u);
    const vendors = await payeesHere(recordsOf(ADA) as unknown as CompanyRecordsHere, 'vendors');
    const leg = [once, twice].map((id) => ({ id, name: id, wrappingPublicKey: null, asset: TEST_SETTLEMENT_ASSET, amount: 90000n, form: 'shielded' as const, paidTo: addressOf(80) }));
    expect(() => payableFactsOf(vendors, leg, 'Leave them unpaid.', 'Not raised.', undefined, '2027-06')).toThrow(/two vendor entries paid at one address/u);
  });
});
