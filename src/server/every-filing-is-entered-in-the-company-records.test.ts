/**
 * **EVERY FILING A DEVICE MAKES IS ENTERED IN THE COMPANY'S RECORDS, BY THE
 * SEAT THAT FILED IT, AS THE DIGEST OF WHAT IT SIGNED** - the one filing call -
 * once the service has kept it, and never before.
 *
 * Over real HTTP with the people, invitation, run and manifest routes as the
 * service mounts them. A filing whose entry is missing is never anchored, so it
 * is never believed as a record's newest version on any other device.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { newWrappingKeypair } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { theNetwork } from '../midnight/network.js';
import { companyRecordEntry, runEntry } from '../midnight/record-manifest.js';
import { payeeFor } from '../testing/payees.js';
import { FiledNotEntered } from 'vaults-web-shared/record-entered-here.js';
import { enteredHere } from '../testing/records-entered.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, setStatusHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { signedClaimRefusal } from 'vaults-web-shared/signed-claim-refusal.js';
import { drawRunHere } from 'vaults-web-shared/run-drawn-here.js';
import { runRoutes } from './run-routes.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, ADDRESS, apiAs, aRecordFiledBy, CO, fromAda, KEY, LABEL, newestPerson, ORIGIN, sendAs, store,
  type Seat,
} from './a-company-of-two-seats.test-support.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
/** The day a payee leaves when a test marks them a leaver: their first day, with no month raised yet to leave out. */
const LEFT = { leavingDate: '2026-10-01', pastDraft: async (): Promise<string[]> => [] };

aCompanyOfTwoSeats((app, deps) => {
  app.use(runRoutes({ signedIn: deps.signedIn, member: deps.member, store, wiring: () => 'simulated', directoryOf: deps.directoryOf }));
});

const NETWORK = theNetwork();
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory,
  network: NETWORK, claimRefusal: signedClaimRefusal, entered: s.entered,
});
/** What the company's manifest holds for one record, without who signed it. */
const enteredFor = (store_: string, id: string) =>
  store.manifestOf(CO).entries.filter((e) => e.store === store_ && e.id === id).map(({ filedBy, ...body }) => ({ ...body, by: filedBy.publicKey }));

describe('THE ONE FILING CALL', () => {
  it('a person invited, admitted and made a leaver on a device is entered at each version, as the version the service keeps', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', {
      name: 'Pat', email: 'pat@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500_001n, classification: 'full-time' as const, startDate: '2026-10-01',
    }, ORIGIN, fromAda);
    const id = made.person!;
    /* RED WHEN: a person invited from a device is not entered, or is entered as other bytes than the record the service kept. */
    expect(enteredFor('company', id)).toEqual([{ ...companyRecordEntry((await newestPerson(id))!), by: ADA.statement.signingKey }]);
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(61)), LABEL, 'usr_61', {
      kind: 'payee', address: payeeFor('3d'.repeat(32), NETWORK).bech32, payslipKey: newWrappingKeypair().publicKey,
    });
    const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_61'));
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === id)!;
    await admitHere(peopleOn(ADA), here, accepted.fingerprint);
    /* RED WHEN: an admission filed from a device is not entered. */
    expect(enteredFor('company', id).at(-1)).toEqual({ ...companyRecordEntry((await newestPerson(id))!), by: ADA.statement.signingKey });
    const admitted = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === id)!;
    await setStatusHere(peopleOn(ADA), admitted, 'leaver', LEFT);
    /* RED WHEN: a change of where a person stands is not entered. */
    expect(enteredFor('company', id).map((e) => e.version)).toEqual([1, 2, 3]);
    expect(enteredFor('company', id).at(-1)!.digest).toBe(companyRecordEntry((await newestPerson(id))!).digest);
  });

  it('a run drawn on a device is entered as version one, as the digest of the run its seat signed', async () => {
    /* Somebody active to pay: invited, accepted and admitted on devices. */
    const made = await inviteHere(ACME, ADA, 'employee', {
      name: 'Ro', email: 'ro@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500_002n, classification: 'full-time' as const, startDate: '2026-10-01',
    }, ORIGIN, fromAda);
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(62)), LABEL, 'usr_62', {
      kind: 'payee', address: payeeFor('3e'.repeat(32), NETWORK).bech32, payslipKey: newWrappingKeypair().publicKey,
    });
    const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs('usr_62'));
    await admitHere(peopleOn(ADA), (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === made.person)!, accepted.fingerprint);
    const run = await drawRunHere({
      api: apiAs('ada'), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: ADA.signingSecret as never,
      company: { account: ADDRESS, label: LABEL }, by: 'ada', entered: ADA.entered,
      records: {
        people: () => readPeopleHere(peopleOn(ADA)), runs: async () => store.listRuns(CO), proposals: async () => store.listProposals(CO), directory: acmeDirectory,
        roundIdentity: pureCircuits,
      },
    }, { period: '2026-12' });
    /* RED WHEN: a run drawn from a device is not entered, or is entered as the service keeps it rather than as its seat signed it. */
    expect(enteredFor('run', run.id)).toEqual([{ ...runEntry(CO, store.getRun(run.id)! as never, 1), by: ADA.statement.signingKey }]);
  });

  it('a filing whose entry the service refuses is said to be filed and not entered, and nothing of it is entered', async () => {
    const first = await aRecordFiledBy(ADA, 'emp_refused_e1');
    await ADA.entered.enter([await aRecordFiledBy(ADA, 'emp_refused_e1')]);
    const before = store.manifestOf(CO).entries.length;
    const said = await ADA.entered.enter([first]).then(() => null, (e: unknown) => e);
    /* RED WHEN: a refused entry is swallowed, or said as any other failure, so the page reads its filing as believed everywhere. */
    expect(said).toBeInstanceOf(FiledNotEntered);
    expect((said as Error).message).toMatch(/its entry in the company's records was not kept/u);
    expect(store.manifestOf(CO).entries).toHaveLength(before);
  });

  it('a filing the service refuses is never entered: neither a person invited nor a change of where a person stands', async () => {
    const made = await inviteHere(ACME, ADA, 'employee', {
      name: 'Sam', email: 'sam@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500_003n, classification: 'full-time' as const, startDate: '2026-10-01',
    }, ORIGIN, fromAda);
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === made.person)!;
    const watched = enteredHere();
    const refusing = async () => ({ status: 409, body: { error: 'the service kept another version of this record' } });
    await expect(inviteHere(ACME, { ...ADA, entered: watched }, 'employee', {
      name: 'Kim', email: 'kim@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500_004n, classification: 'full-time' as const, startDate: '2026-10-01',
    }, ORIGIN, refusing as never)).rejects.toThrow(/the service kept another version of this record/u);
    await expect(setStatusHere({ ...peopleOn(ADA), send: refusing as never, entered: watched }, here, 'leaver', LEFT)).rejects.toThrow();
    /* RED WHEN: a person's filing is entered before the service keeps it, so a record the service refused is anchored as the newest. */
    expect(watched.filed).toEqual([]);
  });
});
