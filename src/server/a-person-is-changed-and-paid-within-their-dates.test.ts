/**
 * **A PERSON'S DATES, SALARY AND CLASSIFICATION ARE CHANGED ON A SEAT'S DEVICE, AND EVERY RUN READS THEM.**
 * An employee is filed with the first line of their salary and classification histories, made by the inviting seat.
 * A change is the next signed version of their record, refused before anything is signed when it would change a
 * month a run has already been raised for. A run pays each person the salary line in force at its month's end, and
 * sets aside, with why, anybody whose dates leave out every day of its month; the raise, the approval and the payout
 * refuse a run that would pay such a person. A version naming another signer than its filer is not believed, and a
 * record filed before the histories were kept is read as one salary line.
 *
 * Over real HTTP, with the people invited, accepted and admitted on devices as the product does it.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { isUtcMoment } from '../core/invitation.js';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { openPerson, payLinesOf, sealPerson } from '../core/person-record.js';
import { amountOnTheRun } from '../core/run-drawing.js';
import { openSealedRun } from '../core/run-legs.js';
import { signRunFiling } from '../core/run-filing.js';
import type { RosterEmployee, SealedProposal } from '../core/types.js';
import { batchDigestOf, newProposalId, sealPayrollProposal } from '../core/proposal-filing.js';
import { theNetwork } from '../midnight/network.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { payeeFor } from '../testing/payees.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { changePersonHere, makeMyselfPayableHere, PersonNotChanged, readPeopleHere, admitHere, setStatusHere, type PeopleDevice, type PersonHere } from 'vaults-web-shared/people-on-device.js';
import { drawRunHere, type RunDrawDoors } from 'vaults-web-shared/run-drawn-here.js';
import { raiseLegHere, type LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import { legPaymentsHere } from 'vaults-web-shared/material-made-here.js';
import { payableFactsOf, periodsPastDraftHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { runRoutes } from './run-routes.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, ADDRESS, BO, CO, fromAda, KEY, LABEL, newestPerson, ORIGIN, personFiledBy, personVersions, sendAs, store,
  type Seat,
} from './a-company-of-two-seats.test-support.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
/** The day a payee leaves when a test marks them a leaver: their first day, with no month raised yet to leave out. */
const LEFT = { leavingDate: '2026-10-01', pastDraft: async (): Promise<string[]> => [] };

aCompanyOfTwoSeats((app, deps) => {
  app.use(runRoutes({ signedIn: deps.signedIn, member: deps.member, store, wiring: () => 'simulated', directoryOf: deps.directoryOf }));
});

const NETWORK = theNetwork();
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const hired = (n: number, startDate = '2026-10-01') => ({
  name: `Payee ${n}`, email: `payee${n}@acme.co`, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500000n + BigInt(n),
  classification: 'full-time' as const, startDate,
});
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK,
  entered: s.entered,
});
/** A payee invited, accepted with the code their own wallet signed, and admitted. */
const aPayee = async (n: number, startDate?: string): Promise<string> => {
  const code: JoinCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, `usr_${n}`, { kind: 'payee', address: addressOf(n), payslipKey: newWrappingKeypair().publicKey });
  const made = await inviteHere(ACME, ADA, 'employee', hired(n, startDate), ORIGIN, fromAda);
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_${n}`));
  await admitHere(peopleOn(ADA), await hereOf(made.person!), accepted.fingerprint);
  return made.person!;
};
const hereOf = async (id: string): Promise<PersonHere> => {
  const read = await readPeopleHere(peopleOn(ADA));
  return [...read.people, ...read.notPayable.map((x) => x.here)].find((p) => p.person.id === id)!;
};
const drawingOn = (s: Seat): RunDrawDoors => ({
  api: async (path, init) => {
    const r = await sendAs(s.person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
    if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status, body: r.body });
    return r.body;
  },
  accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: s.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
  records: {
    people: () => readPeopleHere(peopleOn(s)), runs: async () => store.listRuns(CO), proposals: async () => store.listProposals(CO), directory: acmeDirectory,
    roundIdentity: pureCircuits, roundsOnChain: async (ids) => Object.fromEntries(ids.map((id) => [id.toLowerCase(), { held: 'never', approvals: 0 }])),
  },
  by: s.person, entered: s.entered,
});
/** The months with a run past draft, or with a round live on the chain, as Ada's device reads the company's runs. */
const pastDraft = () => periodsPastDraftHere(drawingOn(ADA).records as never, CO, KEY);
/** A payroll round for `runId`'s private leg, written down as a raise writes one, open and not yet seen on the chain. */
const aRoundFor = (runId: string): SealedProposal => ({
  id: newProposalId(), accountId: CO, status: 'open', createdAt: '2026-10-08T00:00:00.000Z', digest: 'd1'.repeat(32) as Hex,
  chainId: 'c1'.repeat(32) as Hex, approvalCount: 0, keyEpoch: 0,
  sealed: sealPayrollProposal({
    accountId: CO, viewingKey: KEY as Hex, vault: 'c5'.repeat(32) as Hex, summary: 'Payroll', proposedBy: ADA.seat,
    payload: { runId, form: 'shielded', entries: [], window: { root: '0b'.repeat(32) as Hex, payees: '1', opensAt: '0', closesAt: '1' } },
    change: { asset: TEST_SETTLEMENT_ASSET, amount: 0n, batchDigest: batchDigestOf([]), salt: '5d'.repeat(32) as Hex, vouched: { head: '1a'.repeat(32) as Hex, r: '5e'.repeat(32) as Hex } },
  }),
} as SealedProposal);
/** A run raised, as a raise leaves it: filed again as proposed by Ada's seat and entered in the company's records. */
const raised = async (id: string): Promise<void> => {
  const refiled = signRunFiling(CO, { ...store.getRun(id)!, status: 'proposed' }, ADA.signingSecret as Hex);
  store.putRun(refiled);
  await ADA.entered.enter([{ store: 'run', run: refiled }]);
};
const amountOn = (run: { employees: { id: string; amount: bigint }[] }, id: string) => run.employees.find((e) => e.id === id)?.amount;

let first: string;
let leaving: string;

describe('A PERSON\'S RECORD CARRIES THEIR DATES, SALARY HISTORY AND CLASSIFICATION HISTORY', () => {
  it('an employee is filed with the first line of each history and their end date, made by the inviting seat at one UTC moment', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', { ...hired(60), endDate: '2027-12-31' }, ORIGIN, fromAda);
    const person = openPerson((await newestPerson(made.person!))!, KEY);
    /* RED WHEN: the salary at hire is held only as one figure, with nobody named as having set it. */
    expect(person.pay).toEqual([{ amount: 500060n, from: '2026-10-01', madeBy: ADA.statement.signingKey, madeAt: person.madeAt }]);
    /* RED WHEN: the classification chosen on the invitation does not reach the record. */
    expect(person.classifications).toEqual([{ classification: 'full-time', from: '2026-10-01', madeBy: ADA.statement.signingKey, madeAt: person.madeAt }]);
    /* RED WHEN: the end date offered does not reach the record every run reads. */
    expect(person.endDate).toBe('2027-12-31');
    expect(person.madeBy).toBe(ADA.statement.signingKey);
    expect(isUtcMoment(person.madeAt)).toBe(true);
    /* Withdrawn, so the runs after this one leave nobody waiting out. */
    await setStatusHere(peopleOn(ADA), await hereOf(made.person!), 'leaver', LEFT);
  });

  it('a salary line is filed as a signed change, and each month is paid the line in force at its last day', async () => {
    first = await aPayee(61);
    /* RED WHEN: the version an admission files does not name the seat that made it. */
    expect(openPerson((await newestPerson(first))!, KEY)).toMatchObject({ madeBy: ADA.statement.signingKey, admittedBy: 'ada' });
    const changed = await changePersonHere(peopleOn(ADA), await hereOf(first), { pay: { amount: 700000n, from: '2027-01-15' } }, pastDraft);
    expect(payLinesOf(changed).map((l) => [l.amount, l.from])).toEqual([[500061n, '2026-10-01'], [700000n, '2027-01-15']]);
    expect(changed.pay!.at(-1)).toMatchObject({ madeBy: ADA.statement.signingKey });
    const december = await drawRunHere(drawingOn(ADA), { period: '2026-12' });
    expect(amountOn(december, first)).toBe(500061n);
    /* RED WHEN: a run pays the hire amount after the salary changed. */
    const january = await drawRunHere(drawingOn(ADA), { period: '2027-01' });
    expect(amountOn(january, first)).toBe(700000n);
  });

  it('RED WHEN: a salary line, a classification line or a leaving date changes a month a run has been raised for', async () => {
    const run = await drawRunHere(drawingOn(ADA), { period: '2027-02' });
    await raised(run.id);
    expect(await pastDraft()).toEqual(['2027-02']);
    const versions = (await personVersions(first)).length;
    await expect(changePersonHere(peopleOn(ADA), await hereOf(first), { pay: { amount: 710000n, from: '2027-02-01' } }, pastDraft))
      .rejects.toThrow(/applies from 2027-03-01 or later/u);
    await expect(changePersonHere(peopleOn(ADA), await hereOf(first), { classification: { classification: 'part-time', from: '2027-02-28' } }, pastDraft))
      .rejects.toThrow(PersonNotChanged);
    await expect(changePersonHere(peopleOn(ADA), await hereOf(first), { leavingDate: '2027-01-31' }, pastDraft)).rejects.toThrow(/leave out a month already raised/u);
    expect((await personVersions(first)).length).toBe(versions);
    /* A leaving date inside the latest raised month leaves nothing out. */
    leaving = await aPayee(62);
    await expect(changePersonHere(peopleOn(ADA), await hereOf(leaving), { leavingDate: '2027-02-20' }, pastDraft)).resolves.toMatchObject({ leavingDate: '2027-02-20' });
    await expect(changePersonHere(peopleOn(ADA), await hereOf(first), { pay: { amount: 710000n, from: '2027-03-01' } }, pastDraft)).resolves.toBeTruthy();
  });

  it('RED WHEN: a line is dated into a month whose run is still a draft while a round of it is live on the chain', async () => {
    const run = await drawRunHere(drawingOn(ADA), { period: '2027-08' });
    const round = aRoundFor(run.id);
    store.putProposal(round);
    expect(await pastDraft()).toContain('2027-08');
    await expect(changePersonHere(peopleOn(ADA), await hereOf(first), { pay: { amount: 720000n, from: '2027-08-15' } }, pastDraft)).rejects.toThrow(/2027-09-01 or later/u);
  });

  it('RED WHEN: the route for a person\'s details changes where they stand', async () => {
    const here = await hereOf(first);
    const rec = signCompanyFiling(sealPerson({ ...here.person, status: 'leaver' }, here.version + 1, 0, KEY), ADA.signingSecret);
    const r = await fromAda(`/api/people/${first}/details`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(rec) }) });
    expect(r).toMatchObject({ status: 422, body: { refused: 'not-this-change' } });
  });

  it('RED WHEN: a version naming another signer as its maker than the seat that filed it is believed', async () => {
    const here = await hereOf(first);
    const named: RosterEmployee = { ...here.person, madeBy: BO.statement.signingKey as Hex };
    const rec = signCompanyFiling(sealPerson(named, here.version + 1, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/people/${first}/status`, rec)).status).toBe(201);
    expect((await readPeopleHere(peopleOn(ADA))).notBelieved).toContain(first);
    /* Filed again as Ada's, so the runs after this one are drawn over a person this device believes. */
    const again = signCompanyFiling(sealPerson({ ...here.person, madeBy: ADA.statement.signingKey as Hex }, here.version + 2, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/people/${first}/status`, again)).status).toBe(201);
    expect((await readPeopleHere(peopleOn(ADA))).notBelieved).not.toContain(first);
    /* RED WHEN: a version filed on a device carries the moment the version before it was made, not its own. */
    const dated = await hereOf(first);
    const old = signCompanyFiling(sealPerson({ ...dated.person, madeAt: '2026-01-01T00:00:00Z' }, dated.version + 1, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/people/${first}/status`, old)).status).toBe(201);
    await setStatusHere(peopleOn(ADA), await hereOf(first), 'active');
    expect(openPerson((await newestPerson(first))!, KEY).madeAt).not.toBe('2026-01-01T00:00:00Z');
  });
});

describe('A RUN PAYS ONLY PEOPLE WITHIN THEIR DATES', () => {
  it('RED WHEN: a record whose dates are not dates is set aside as outside them, and the run drawn without a word', async () => {
    /* A seat files a person whose first version starts on something that is not a date. */
    const like = (await hereOf(first)).person;
    const broken = 'emp_00000000000000000064';
    const rec = signCompanyFiling(sealPerson({ ...like, id: broken, name: 'Payee 64', startDate: '1 Oct 2026', pay: undefined, classifications: undefined }, 1, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/accounts/${CO}/self-payee`, rec)).status).toBe(201);
    const before = store.listRuns(CO).length;
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-04' })).rejects.toThrow(/Payee 64: their record's start date is not a calendar date/u);
    expect(store.listRuns(CO).length).toBe(before);
    /* Made a leaver, so the runs after this one are drawn over the others. */
    await setStatusHere(peopleOn(ADA), await hereOf(broken), 'leaver', LEFT);
  });

  it('RED WHEN: somebody makes themselves payable from a start date that is not a calendar date', async () => {
    await expect(makeMyselfPayableHere(peopleOn(ADA), {} as never, { name: 'Ada', title: 'Founder', asset: TEST_SETTLEMENT_ASSET, baseAmount: 1n, startDate: '2026-13-01' }))
      .rejects.toThrow(/a start date is a calendar date/u);
  });

  it('the draw sets aside, with why, a person who has left and one not yet started, and pays the rest', async () => {
    const later = await aPayee(63, '2027-05-01');
    const march = await drawRunHere(drawingOn(ADA), { period: '2027-03' });
    /* RED WHEN: a person who left before the month, or starts after it, is on its run. */
    expect(march.employees.map((e) => e.id)).not.toContain(leaving);
    expect(march.employees.map((e) => e.id)).not.toContain(later);
    expect(amountOn(march, first)).toBe(710000n);
    /* RED WHEN: a person set aside for their dates is not recorded as left out, or refuses the whole run. */
    expect(march.skips?.people).toEqual(expect.arrayContaining([
      { employeeId: leaving, name: 'Payee 62', waiting: 'outside their dates' },
      { employeeId: later, name: 'Payee 63', waiting: 'outside their dates' },
    ]));
    const reasons = march.skips!.decisions.decisions.map((d) => d.reason);
    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/Payee 62 is not paid for 2027-03: their leaving date is 2027-02-20, before 2027-03/u),
      expect.stringMatching(/Payee 63 is not paid for 2027-03: they start on 2027-05-01, after 2027-03/u),
    ]));
    expect(march.skips!.decisions.decisions.every((d) => d.by === 'ada')).toBe(true);
    /* Kept as drawn: the sealed run carries the same record of who it left out. */
    expect(openSealedRun(store.getRun(march.id)!, KEY).skips?.people).toEqual(march.skips?.people);
    /* RED WHEN: a leaver whose dates are not dates is drawn, or left out without a word. */
    expect(reasons).toEqual(expect.arrayContaining([expect.stringMatching(/Payee 64 is not paid for 2027-03: their record's start date is not a calendar date/u)]));
  });

  it('RED WHEN: the raise, the approval or the payout pays somebody on a run whose month their dates leave out', async () => {
    const people = await readPeopleHere(peopleOn(ADA));
    const them = people.people.find((p) => p.person.id === leaving)!.person;
    /* Payee 62 as a run drawn before they left would carry them. */
    const paid = [{ id: leaving, name: them.name, wrappingPublicKey: them.wrappingPublicKey!, asset: them.asset, amount: 500062n }];
    expect(() => payableFactsOf(people, paid, 'Leave them unpaid.', 'Not raised.', undefined, '2027-03'))
      .toThrow(/Payee 62 is on this run for 2027-03, and is not payable for any day of it: their leaving date is 2027-02-20, before 2027-03/u);
    expect(payableFactsOf(people, paid, 'Leave them unpaid.', 'Not raised.', undefined, '2027-02')).toHaveLength(1);
  });

  it('RED WHEN: the raise, the approval or the payout pays anybody another amount than the salary line in force for the month', async () => {
    const people = await readPeopleHere(peopleOn(ADA));
    const them = people.people.find((p) => p.person.id === leaving)!.person;
    const run = (amount: bigint) => [{ id: leaving, name: them.name, wrappingPublicKey: them.wrappingPublicKey!, asset: them.asset, amount }];
    /* A seat that may draw a run and not change pay files one paying ten times the line. */
    expect(() => payableFactsOf(people, run(5000620n), 'Leave them unpaid.', 'Not raised.', undefined, '2027-02'))
      .toThrow(/Payee 62 is on this run for 2027-02 at 5000620, and the salary their record holds for it is 500062/u);
    expect(payableFactsOf(people, run(500062n), 'Leave them unpaid.', 'Not raised.', undefined, '2027-02')).toHaveLength(1);
  });

  it('the raise and the payout material refuse a drawn run whose person has since left, or whose salary line has since changed, naming the person', async () => {
    const leaves = await aPayee(69);
    const paidMore = await aPayee(70);
    const april = await drawRunHere(drawingOn(ADA), { period: '2027-04' });
    expect(amountOn(april, leaves)).toBe(500069n);
    /* Both runs are still drafts, and no month is held raised here, so a leaving date before April, and a salary line from May, are filed after the draws. */
    await setStatusHere(peopleOn(ADA), await hereOf(leaves), 'leaver', { leavingDate: '2027-03-15', pastDraft: LEFT.pastDraft });
    const may = await drawRunHere(drawingOn(ADA), { period: '2027-05' });
    expect(amountOn(may, paidMore)).toBe(500070n);
    await changePersonHere(peopleOn(ADA), await hereOf(paidMore), { pay: { amount: 900000n, from: '2027-05-01' } }, LEFT.pastDraft);
    /* Only the people, the runs and the proposals are read before either door refuses; the rest of the records are not reached. */
    const records = drawingOn(ADA).records as unknown as CompanyRecordsHere;
    const raising = { records, accountId: CO, service: { file: async () => undefined } } as unknown as LegRaiseDoors;
    const raise = (runId: string) => raiseLegHere(raising, { runId, viewingKey: KEY as never, vault: 'c5'.repeat(32), opensAt: '1', closesAt: '2' });
    const material = (runId: string) => legPaymentsHere(records, CO, runId, KEY as never);
    /* RED WHEN: the raise or the payout material pays somebody on a run whose month their dates leave out. */
    await expect(raise(april.id)).rejects.toThrow(/Payee 69 is on this run for 2027-04, and is not payable for any day of it: their leaving date is 2027-03-15, before 2027-04/u);
    await expect(material(april.id)).rejects.toThrow(/Payee 69 is on this run for 2027-04, and is not payable for any day of it: their leaving date is 2027-03-15, before 2027-04/u);
    /* RED WHEN: the raise or the payout material pays a leg at another amount than the salary line in force for the run's month. */
    await expect(raise(may.id)).rejects.toThrow(/Payee 70 is on this run for 2027-05 at 500070, and the salary their record holds for it is 900000/u);
    await expect(material(may.id)).rejects.toThrow(/Payee 70 is on this run for 2027-05 at 500070, and the salary their record holds for it is 900000/u);
  });

  it('a person whose record carries no salary history is read as one salary line, and paid it', async () => {
    /* A seat files a person with no salary or classification history, as a record filed before they were kept. */
    const { pay: _p, classifications: _c, endDate: _e, leavingDate: _l, ...asItWas } = (await hereOf(first)).person;
    const plain = 'emp_00000000000000000066';
    const rec = signCompanyFiling(sealPerson({ ...asItWas, id: plain, name: 'Payee 66' } as RosterEmployee, 1, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/accounts/${CO}/self-payee`, rec)).status).toBe(201);
    const read = await readPeopleHere(peopleOn(ADA));
    /* RED WHEN: a record with none of the new fields is not believed, not payable, or paid anything but its one amount. */
    const old = read.people.find((p) => p.person.id === plain)!;
    expect(old.person.pay).toBeUndefined();
    expect(amountOnTheRun(old.person, '2027-06')).toBe(500061n);
    const june = await drawRunHere(drawingOn(ADA), { period: '2027-06' });
    expect(amountOn(june, plain)).toBe(500061n);
    expect(amountOn(june, first)).toBe(710000n);
  });
});

/* Last, since a person whose history was rewritten stays unbelieved and refuses every draw after it. */
describe('A LEAVER IS PAID FOR THE DAYS THEY WORKED, AND LEAVES ON A DAY', () => {
  it('RED WHEN: somebody made a leaver part way through a month is left off that month\'s run, or is paid for the months after', async () => {
    const leaver = await aPayee(66);
    await setStatusHere(peopleOn(ADA), await hereOf(leaver), 'leaver', { leavingDate: '2027-09-15', pastDraft });
    const run = await drawRunHere(drawingOn(ADA), { period: '2027-09' });
    expect(run.employees.map((e) => e.id)).toContain(leaver);
    /* RED WHEN: the raise, the approval or the payout refuses a leaver for the days before they left. */
    const people = await readPeopleHere(peopleOn(ADA));
    expect(payableFactsOf(people, run.employees.filter((e) => e.id === leaver), 'Leave them unpaid.', 'Not raised.', undefined, '2027-09')).toHaveLength(1);
    const october = await drawRunHere(drawingOn(ADA), { period: '2027-10' });
    expect(october.employees.map((e) => e.id)).not.toContain(leaver);
    expect(october.skips!.decisions.decisions.map((d) => d.reason)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Payee 66 is not paid for 2027-10: their leaving date is 2027-09-15, before 2027-10/u),
    ]));
  });

  it('RED WHEN: somebody is made a leaver with no day they leave, or on a day that leaves out a month already raised', async () => {
    const stays = await aPayee(67);
    await expect(setStatusHere(peopleOn(ADA), await hereOf(stays), 'leaver')).rejects.toThrow(/made a leaver on the day they leave/u);
    await expect(setStatusHere(peopleOn(ADA), await hereOf(stays), 'leaver', { pastDraft })).rejects.toThrow(/has no leaving date or end date/u);
    await expect(setStatusHere(peopleOn(ADA), await hereOf(stays), 'leaver', { leavingDate: '2027-07-31', pastDraft }))
      .rejects.toThrow(/would leave out a month already raised/u);
    /* RED WHEN: somebody waiting to be admitted, never paid, cannot be withdrawn without a leaving date. */
    const made = await inviteHere(ACME, ADA, 'employee', hired(68), ORIGIN, fromAda);
    await expect(setStatusHere(peopleOn(ADA), await hereOf(made.person!), 'leaver')).resolves.toMatchObject({ status: 'leaver' });
    /* RED WHEN: a leaver with no leaving date or end date, filed by any seat, is drawn, or paid at the raise, approval or payout. */
    const rec = signCompanyFiling(sealPerson({ ...(await hereOf(stays)).person, status: 'leaver', madeAt: '2027-07-01T00:00:00Z' }, (await hereOf(stays)).version + 1, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/people/${stays}/status`, rec)).status).toBe(201);
    const people = await readPeopleHere(peopleOn(ADA));
    const theirs = { id: stays, name: 'Payee 67', wrappingPublicKey: null, asset: TEST_SETTLEMENT_ASSET, amount: 500067n, form: 'shielded' as const };
    expect(() => payableFactsOf(people, [theirs], 'Leave them unpaid.', 'Not raised.', undefined, '2027-11')).toThrow(/made a leaver with no leaving date or end date/u);
  });
});


describe('A PERSON\'S HISTORY IS READ OVER ALL THEIR VERSIONS', () => {
  it('RED WHEN: a version that rewrites an earlier salary line is believed by any device', async () => {
    const extra = await aPayee(65);
    const changed = await changePersonHere(peopleOn(ADA), await hereOf(extra), { pay: { amount: 800000n, from: '2027-10-01' } }, pastDraft);
    const here = await hereOf(extra);
    /* Ada's seat files a version whose first line pays more from the start, made to look like the line it replaces. */
    const rewritten = { ...changed, pay: [{ ...changed.pay![0]!, amount: 900000n }, changed.pay![1]!] };
    const rec = signCompanyFiling(sealPerson(rewritten, here.version + 1, 0, KEY), ADA.signingSecret);
    expect((await personFiledBy(ADA, `/api/people/${extra}/status`, rec)).status).toBe(201);
    expect((await readPeopleHere(peopleOn(ADA))).notBelieved).toContain(extra);
  });
});
