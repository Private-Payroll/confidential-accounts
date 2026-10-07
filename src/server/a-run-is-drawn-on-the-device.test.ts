/**
 * **A PAYROLL RUN IS DRAWN ON A SIGNER'S DEVICE AND KEPT AS IT WAS SIGNED.**
 * The device draws it over the people it believes, refuses an active person
 * who is not payable at what their own wallet signed, seals each payslip to the
 * payslip key the person's wallet signed, mints nothing for anybody, and signs
 * the run with its seat's filing key. The service keeps it only for a seat its
 * directory believes may file a run, whole, and opens none of it.
 *
 * Over real HTTP, with the people invited, accepted and admitted on devices as
 * the product does it. The chain's read is the test's.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { canonical, newWrappingKeypair, parseCanonical, unseal, unwrapKey, type Hex } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { sealPerson } from '../core/person-record.js';
import { openSealedRun, sealedRunOf } from '../core/run-legs.js';
import { signRunFiling } from '../core/run-filing.js';
import { theNetwork } from '../midnight/network.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { payeeFor } from '../testing/payees.js';
import { acceptAsPayeeHere, invitePayeeHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { drawRunHere, RunNotDrawnHere, type RunDrawDoors } from 'vaults-web-shared/run-drawn-here.js';
import { runRoutes } from './run-routes.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, ADDRESS, aVersionNoSeatSigned, BO, CO, fromAda, KEY, LABEL, newestPerson, ORIGIN, OTHER, personVersions,
  sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats((app, deps) => {
  app.use(runRoutes({ signedIn: deps.signedIn, member: deps.member, store, directoryOf: deps.directoryOf, wiring: () => 'simulated' }));
});

const NETWORK = theNetwork();
const MONTH = '2026-11';
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const pay = (n: number) => ({ name: `Payee ${n}`, email: `payee${n}@acme.co`, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500000n + BigInt(n), startDate: '2026-10-01' });
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK,
});
/** A payee invited, accepted with the code their own wallet signed (their payslip key one this test holds the secret of), and maybe admitted. */
const aPayee = async (n: number, admit = true) => {
  const slip = newWrappingKeypair();
  const code: JoinCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, `usr_${n}`, { kind: 'payee', address: addressOf(n), payslipKey: slip.publicKey });
  const made = await invitePayeeHere(ACME, ADA, pay(n), ORIGIN, fromAda);
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_${n}`));
  if (admit) {
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === made.person)!;
    await admitHere(peopleOn(ADA), here, accepted.fingerprint);
  }
  return { id: made.person!, slip, address: addressOf(n), fingerprint: accepted.fingerprint };
};
/** One seat's device, drawing a run. */
const drawingOn = (s: Seat): RunDrawDoors => ({
  api: async (path, init) => {
    const r = await sendAs(s.person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
    if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status, body: r.body });
    return r.body;
  },
  accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: s.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
  records: { people: () => readPeopleHere(peopleOn(s)), runs: async () => store.listRuns(CO), proposals: async () => store.listProposals(CO) },
  by: s.person,
});
const runsKept = () => store.listRuns(CO).length;

describe('A RUN IS DRAWN ON A SIGNER\'S DEVICE', () => {
  it('OVER THE PEOPLE IT BELIEVES, EACH PAYSLIP SEALED TO THE KEY THEIR WALLET SIGNED, KEPT AS ADA\'S SEAT SIGNED IT, AND NOTHING MINTED', async () => {
    const one = await aPayee(51);
    const two = await aPayee(52);
    const before = runsKept();
    const run = await drawRunHere(drawingOn(ADA), { period: '2026-11' });
    const kept = store.getRun(run.id)!;
    /* RED WHEN: the run is kept without the signature of the seat that drew it, or under another key than Ada's. */
    expect(kept.filedBy?.publicKey).toBe(ADA.statement.signingKey);
    expect(runsKept()).toBe(before + 1);
    /* RED WHEN: the run opened is not the run drawn: the people, their amounts, the month. */
    const opened = openSealedRun(kept, KEY);
    expect(opened.period).toBe(MONTH);
    expect(opened.employees.map((e) => [e.id, e.amount]).sort()).toEqual([[one.id, 500051n], [two.id, 500052n]].sort());
    /* RED WHEN: a payslip is sealed to any key but the one the payee's own wallet signed, or names another address. */
    const slip = kept.payslips.find((p) => p.employeeId === one.id)!;
    const body = parseCanonical<{ paidTo: string; period: string }>(unseal(slip.slip, unwrapKey(slip.wrapped, one.slip.secret)));
    expect([body.paidTo, body.period]).toEqual([one.address, MONTH]);
    expect(slip.sealedTo).toBe(one.slip.publicKey.toLowerCase());
    /* RED WHEN: what the service keeps carries anybody's address or salary in the clear. */
    expect(canonical(kept)).not.toContain(one.address);
    expect(canonical(kept)).not.toContain('500051');
  });

  it('REFUSES, BY NAME, AN ACTIVE PERSON WHOSE RECORD PAYS AN ADDRESS THEIR OWN WALLET DID NOT SIGN, AND FILES NOTHING', async () => {
    const three = await aPayee(53);
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === three.id)!;
    /* Ada's seat files a version of the person that pays another address. */
    const moved = { ...here.person, address: payeeFor('ee'.repeat(32), NETWORK) };
    const filed = signCompanyFiling(sealPerson(moved, here.version + 1, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${three.id}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(filed) }) })).status).toBe(201);
    const before = runsKept();
    /* RED WHEN: a run is drawn over somebody at an address their own wallet did not sign. */
    await expect(drawRunHere(drawingOn(ADA), { period: '2026-12' })).rejects.toThrow(/Payee 53 cannot be paid: the address their record pays is not the one their code names/u);
    expect(runsKept()).toBe(before);
    /* Leaving them out of the run does not need them to be payable. */
    const others = (await readPeopleHere(peopleOn(ADA))).people.filter((p) => p.person.status === 'active').map((p) => p.person.id);
    const run = await drawRunHere(drawingOn(ADA), { period: '2026-12', employeeIds: others, skipPending: { employeeIds: [], reason: 'n/a' } })
      .catch((e: unknown) => e);
    expect(run).toBeInstanceOf(RunNotDrawnHere);
    /* RED WHEN: a person left out is not named in the confirmation, and the draw goes ahead anyway. */
    expect(String((run as Error).message)).toMatch(/would also leave out/u);
    const named = await drawRunHere(drawingOn(ADA), {
      period: '2026-12', employeeIds: others, skipPending: { employeeIds: [three.id], reason: 'their address is being checked' },
    });
    expect(named.employees.some((e) => e.id === three.id)).toBe(false);
    expect(named.skips?.people.map((p) => p.employeeId)).toEqual([three.id]);
    expect(named.skips?.decisions).toBeDefined();
    /* Ada's seat marks them a leaver, so the runs after this one are drawn over the others. */
    const leaver = signCompanyFiling(sealPerson({ ...moved, status: 'leaver' }, here.version + 2, 0, KEY), ADA.signingSecret);
    expect((await fromAda(`/api/people/${three.id}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(leaver) }) })).status).toBe(201);
  });

  it('REFUSES A DRAW OVER A PERSON WHOSE RECORD NO SEAT IT BELIEVES FILED, AND FILES NOTHING', async () => {
    const six = await aPayee(56);
    /* The service writes a version of the person no seat signed. */
    await aVersionNoSeatSigned(six.id, 'leaver');
    const before = runsKept();
    try {
      /* RED WHEN: a run is drawn while somebody's record cannot be believed, so whether they should be paid is not known. */
      await expect(drawRunHere(drawingOn(ADA), { period: '2026-12' })).rejects.toThrow(/1 of the company's people has a record filed by a seat this device does not believe/u);
      expect(runsKept()).toBe(before);
    } finally {
      const here = (await readPeopleHere({ ...peopleOn(ADA) })).notBelieved.includes(six.id);
      expect(here).toBe(true);
      const opened = (await import('../core/person-record.js')).openPerson((await personVersions(six.id)).at(-2)!, KEY);
      const refiled = signCompanyFiling(sealPerson(opened, (await newestPerson(six.id))!.version + 1, 0, KEY), ADA.signingSecret);
      expect((await fromAda(`/api/people/${six.id}/status`, { method: 'POST', body: JSON.stringify({ person: toCompanyWire(refiled) }) })).status).toBe(201);
    }
  });

  it('LEAVES A PERSON WAITING OUT ONLY WHEN THEY ARE NAMED, AND RECORDS WHO DECIDED', async () => {
    const waiting = await aPayee(54, false);
    const four = await aPayee(55);
    const active = (await readPeopleHere(peopleOn(ADA))).people.filter((p) => p.person.status === 'active' && p.person.id !== four.id).map((p) => p.person.id);
    /* RED WHEN: a run leaves somebody waiting out without their name in a confirmation. */
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-01', employeeIds: [...active, four.id, waiting.id] }))
      .rejects.toThrow(/payroll cannot run without leaving somebody out: Payee 54 is waiting to be admitted by an admin/u);
    const run = await drawRunHere(drawingOn(ADA), {
      period: '2027-01', employeeIds: [...active, four.id, waiting.id], skipPending: { employeeIds: [waiting.id], reason: 'not admitted yet' },
    });
    expect(run.skips?.people).toEqual([{ employeeId: waiting.id, name: 'Payee 54', waiting: 'us' }]);
    /* They are admitted, so the runs after this one leave nobody out. */
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === waiting.id)!;
    await admitHere(peopleOn(ADA), here, waiting.fingerprint);
  });

  it('REFUSES A SECOND RUN FOR A MONTH ALREADY RAISED, UNLESS IT NAMES WHAT IT REPEATS', async () => {
    const first = await drawRunHere(drawingOn(ADA), { period: '2027-02' });
    /* The month's first run is raised: kept as proposed, as a raise leaves it. */
    store.putRun({ ...store.getRun(first.id)!, status: 'proposed' });
    const before = runsKept();
    /* RED WHEN: a second run is drawn for a month whose run has been raised. */
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-02' })).rejects.toThrow(/a run for 2027-02 already exists/u);
    /* RED WHEN: a repeat that does not name every raised run of the month is taken. */
    await expect(drawRunHere(drawingOn(ADA), { period: '2027-02', repeats: { runIds: [], reason: 'back pay' } })).rejects.toThrow(/leaves out/u);
    expect(runsKept()).toBe(before);
    const again = await drawRunHere(drawingOn(ADA), { period: '2027-02', repeats: { runIds: [first.id], reason: 'back pay' } });
    expect(again.repeats).toMatchObject({ of: [first.id], reason: 'back pay', by: 'ada' });
  });
});

describe('THE SERVICE KEEPS A RUN ONLY AS A SEAT THAT MAY FILE ONE SIGNED IT, WHOLE', () => {
  const aDrawnRun = async () => {
    const run = await drawRunHere({ ...drawingOn(ADA), api: async () => ({}) }, { period: '2027-03' });
    return sealedRunOf(run, KEY, 0);
  };
  const keep = (person: string, body: unknown) => sendAs(person)(`/api/accounts/${CO}/runs`, { method: 'POST', body: JSON.stringify(body) });

  it('REFUSES EVERY RUN THAT IS NOT THAT, AND KEEPS NOTHING', async () => {
    const sealed = await aDrawnRun();
    const before = runsKept();
    const cases: Array<[string, string, unknown, number, string]> = [
      /* RED WHEN: the old body - the month and the viewing key, for the service to draw the run itself - is taken. */
      ['the service asked to draw it', 'ada', { period: '2027-03', viewingKey: KEY }, 400, ''],
      /* RED WHEN: a run nobody signed is kept. */
      ['unsigned', 'ada', { run: sealed }, 422, 'not-a-run'],
      /* RED WHEN: a payslip changed after the run was signed is kept. */
      ['a payslip changed after signing', 'ada', { run: { ...signRunFiling(CO, sealed, ADA.signingSecret as Hex), payslips: [] } }, 422, 'not-a-run'],
      /* RED WHEN: a run signed for one company is kept as another's. */
      ['signed for another company', 'ada', { run: signRunFiling(OTHER, { ...sealed, accountId: OTHER }, ADA.signingSecret as Hex) }, 422, 'not-a-run'],
      /* RED WHEN: a run that names another company is kept here because it was signed for this one. */
      ['another company\'s run, signed for this one', 'ada', { run: signRunFiling(CO, { ...sealed, accountId: OTHER }, ADA.signingSecret as Hex) }, 422, 'not-a-run'],
      /* RED WHEN: a seat whose role may not file a run has one kept. */
      ['signed by an approver\'s seat', 'bo', { run: signRunFiling(CO, sealed, BO.signingSecret as Hex) }, 403, 'role-may-not-file'],
      /* RED WHEN: a run signed with Ada's key is kept for somebody else signed in. */
      ['Ada\'s run, sent by Bo', 'bo', { run: signRunFiling(CO, sealed, ADA.signingSecret as Hex) }, 403, 'no-entry'],
      /* RED WHEN: a month typed another way is kept, so two runs for one month would not be seen as one. */
      ['a month not written as a month', 'ada', { run: signRunFiling(CO, { ...sealed, period: '2027-3' }, ADA.signingSecret as Hex) }, 422, 'not-a-run'],
      /* RED WHEN: a run sealed under a key the company no longer uses is kept. */
      ['sealed at another key epoch', 'ada', { run: signRunFiling(CO, { ...sealed, keyEpoch: 7 }, ADA.signingSecret as Hex) }, 409, 'not-the-current-key'],
      /* RED WHEN: a run is kept already raised, with proposals nothing here wrote down. */
      ['already raised', 'ada', { run: signRunFiling(CO, { ...sealed, status: 'proposed', proposalIds: ['prp_aaaaaaaaaaaa'] }, ADA.signingSecret as Hex) }, 422, 'not-a-drawn-run'],
    ];
    for (const [what, person, body, status, refused] of cases) {
      const r = await keep(person, body);
      expect(r.status, what).toBe(status);
      if (refused !== '') expect((r.body as { refused?: string }).refused, what).toBe(refused);
    }
    expect(runsKept()).toBe(before);
    /* The run as Ada's seat signed it is kept once, and not twice. */
    const signed = signRunFiling(CO, sealed, ADA.signingSecret as Hex);
    expect((await keep('ada', { run: signed })).status).toBe(201);
    /* RED WHEN: a second run under a kept run's name replaces it. */
    expect((await keep('ada', { run: signed })).status).toBe(409);
    /* RED WHEN: somebody who is not a member of the company has a run kept. */
    expect((await keep('eve', { run: signed })).status).toBe(404);
    expect(runsKept()).toBe(before + 1);
  });
});
