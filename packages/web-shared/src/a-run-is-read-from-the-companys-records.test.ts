/**
 * **A PAYROLL RUN IS READ FOR APPROVAL ON THIS DEVICE FROM THE COMPANY'S OWN
 * RECORDS**: the state its founding seat signed, the run opened with the
 * viewing key, and the people this device believes and would pay.
 */
import { describe, expect, it } from 'vitest';
import { newSigningKeypair, newSymmetricKey, type Hex } from '../../../src/core/crypto.js';
import { signRunFiling } from '../../../src/core/run-filing.js';
import { sealRecord } from '../../../src/core/sealed-records.js';
import { newStateBlinding, sealState } from '../../../src/core/account.js';
import { signedFoundingState, CREATED_BEFORE_SIGNED_STATE, openStateRecord } from '../../../src/core/founding-state.js';
import { factsOfThePaid, proposalListOf, runLegOf } from '../../../src/core/run-legs.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { signCompanyFiling } from '../../../src/midnight/sealed-record-wire.js';
import type { PayrollRun, RosterEmployee, SealedRun } from '../../../src/core/types.js';
import { payeeFor } from '../../../src/testing/payees.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../../../src/testing/assets.js';
import { runRebuiltHere, RunNotReadHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { factsHere, RAISE_CHECKS } from './raise-checks-here.js';
import type { DirectoryHere } from './vault-page-doors.js';
import type { PeopleHere } from './people-on-device.js';

const CO = 'acc_1';
const KEY = newSymmetricKey();
const SEAT = '4e'.repeat(32);
const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };
const founder = newSigningKeypair();
const LEG = runLegOf(TEST_TOKEN, 'shielded');
const STATE = signedFoundingState(CO, sealState({ entries: [] }, newStateBlinding(), KEY, 0), founder.secret);

const person = (id: string, n: string): RosterEmployee => ({
  id, accountId: CO, name: `Person ${id}`, status: 'active', address: payeeFor(n.repeat(32), 'undeployed'),
} as unknown as RosterEmployee);
const ALI = person('p1', 'a1');
const BEA = person('p2', 'a2');

const EMPLOYEES = [ALI, BEA].map((p, i) => ({ id: p.id, name: p.name, wrappingPublicKey: null, asset: TEST_TOKEN, amount: BigInt(100 + i), form: 'shielded' }));
/* What the leg records it pays, as the device that raised it worked it out from the people it believed. */
const RECORDED = factsOfThePaid(EMPLOYEES as never, (id) => [ALI, BEA].find((p) => p.id === id), registryWithTestPrivateForms());
const runOf = (over: Partial<PayrollRun> = {}, filedWith?: { secret: Hex }): SealedRun => {
  const run = {
    id: 'run_aaaaaaaaaaa1', accountId: CO, period: '2026-09', status: 'proposed',
    employees: EMPLOYEES,
    totals: {}, proposalIds: { [LEG]: 'prp_1' }, skips: undefined, repeats: undefined,
    payout: { [LEG]: {
      root: '00'.repeat(32), payees: 2n, opensAt: 1_800_000_000n, closesAt: 1_800_600_000n, vault: '99'.repeat(32), required: 1n,
      leaves: [], facts: RECORDED, runId: `run_aaaaaaaaaaa1:${LEG}`, epoch: 0,
      retries: [{ originalIndices: [1], root: '00'.repeat(32), payees: 2n, opensAt: 1_900_000_000n, closesAt: 1_900_600_000n, vault: '99'.repeat(32), proposalId: 'prp_2', proposedBy: 's', at: 'now' }],
    } },
    ...over,
  } as unknown as PayrollRun;
  const { employees, totals, proposalIds, payout, skips, repeats } = run;
  /* Filed by the founding seat, as a run is filed from a seat's device. */
  return signRunFiling(CO, {
    id: run.id, accountId: run.accountId, period: run.period, status: run.status, payslips: [], keyEpoch: 0,
    proposalIds: proposalListOf({ proposalIds, payout }), sealed: sealRecord('payroll', CO, { employees, totals, proposalIds, payout, skips, repeats }, KEY),
  } as never, (filedWith ?? founder).secret) as unknown as SealedRun;
};

/* A seat put in the founding signer's slot after the founding signer was removed: it holds the account now, and signs with its own key. */
const LATER = '4f'.repeat(32);
const later = newSigningKeypair();
const here = (o: { founderRemoved?: boolean; founding?: string; foundingCommittee?: typeof COMMITTEE } = {}): DirectoryHere => ({
  dir: { company: CO, version: 2, seats: [
    { seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin', retired: null },
    { seat: LATER, person: 'ben', signingKey: later.publicKey, wrappingKey: 'ac'.repeat(32), committeeKey: { tag: 'schnorr', value: '7b'.repeat(32) }, role: 'admin', retired: null },
  ] },
  /* What the person's own wallet read: who holds the account now, and the seat its deploy seated. */
  holders: {
    committee: [COMMITTEE, { tag: 'schnorr', value: '7b'.repeat(32) }], seats: o.founderRemoved === true ? [LATER] : [SEAT, LATER], approvals: 1, adoptedVaults: [],
    founding: o.founding ?? SEAT, foundingCommittee: [o.foundingCommittee ?? COMMITTEE], account: 'ac'.repeat(32),
  } as never,
  another: new Set(),
});
const peopleOf = (o: Partial<PeopleHere> = {}): PeopleHere => ({
  people: [ALI, BEA].map((p) => ({ person: p, version: 1, handedOver: true })), notBelieved: [], notPayable: [], ...o,
});
const records = (o: { state?: unknown; founderRemoved?: boolean; founding?: string; foundingCommittee?: typeof COMMITTEE; people?: PeopleHere; runs?: SealedRun[] } = {}): CompanyRecordsHere => ({
  directory: async () => here(o),
  people: async () => o.people ?? peopleOf(),
  state: async (id) => (id === '0' ? ('state' in o ? o.state : STATE) as never : null),
  runs: async () => o.runs ?? [runOf()],
  proposals: async () => [],
  /* A chain that has paid nobody and holds nothing open, as the person's own wallet reads it. */
  payments: {
    paidOnceOf: pureCircuits.paidOnceOf, paidMovementOf: pureCircuits.paidMovementOf,
    read: async () => ({ payKeyCommitment: null, held: [], openRounds: [], entries: 0 }),
  },
  policy: async () => ({ threshold: 1, limitsByRole: {} }) as never,
  registry: registryWithTestPrivateForms(),
});

describe('A RUN READ HERE FOR APPROVAL', () => {
  it('IS THE LEG THE PROPOSAL RAISED, PAID TO THE PEOPLE THIS DEVICE BELIEVES, FROM THE STATE THE FOUNDING SEAT SIGNED', async () => {
    const { made } = await runRebuiltHere(records(), CO, 'prp_1', KEY);
    const blinding = openStateRecord(STATE, KEY).blinding;
    /* RED WHEN: the seeds or the pay-record key come from anywhere but the signed state. */
    expect([made.seeds, made.payKey]).toEqual([blinding.payoutSeeds, blinding.payRecordKey]);
    /* RED WHEN: the people paid, their amounts or their addresses are not what the leg records it pays. */
    expect(made.facts.map((f) => [f.amount, f.payee])).toEqual([[100n, ALI.address], [101n, BEA.address]]);
    /* RED WHEN: a person-month is written other than the run's month, in its one spelling, or as an extra it is not. */
    expect(made.records).toEqual([
      { person: 'p1', month: '2026-09', kind: 'salary', occurrence: 0 }, { person: 'p2', month: '2026-09', kind: 'salary', occurrence: 0 },
    ]);
    expect([made.identity, made.asset, made.opensAt, made.closesAt, made.required, made.retry])
      .toEqual([{ accountId: CO, runId: `run_aaaaaaaaaaa1:${LEG}`, epoch: 0 }, TEST_TOKEN, '1800000000', '1800600000', '1', undefined]);
  });

  it('A RETRY IS READ AS THE LEG IT RETRIES, WITH ITS OWN WINDOW AND THE PEOPLE IT PAYS', async () => {
    const { made } = await runRebuiltHere(records(), CO, 'prp_2', KEY);
    /* RED WHEN: a retry is read with the leg's window, or without the positions it pays. */
    expect([made.opensAt, made.closesAt, made.required, made.retry, made.facts.length]).toEqual(['1900000000', '1900600000', '0', [1], 2]);
  });

  it('A COMPANY WITH NO SIGNED STATE IS REFUSED WITH THE ONE SENTENCE THAT SAYS TO CREATE IT AGAIN', async () => {
    /* RED WHEN: a company made before its state was a signed record is read from anything else. */
    await expect(runRebuiltHere(records({ state: null }), CO, 'prp_1', KEY)).rejects.toThrow(RunNotReadHere);
    await expect(runRebuiltHere(records({ state: null }), CO, 'prp_1', KEY))
      .rejects.toThrow(CREATED_BEFORE_SIGNED_STATE.slice(0, 80));
  });

  it('THE FOUNDING SEAT IS THE DEPLOY\'S: A FOUNDER REMOVED SINCE STILL MAKES THE FIRST STATE BELIEVED', async () => {
    /* RED WHEN: the first state is believed only while its signer still holds the account, so removing the founding signer strands every approval. */
    const { made } = await runRebuiltHere(records({ founderRemoved: true, runs: [runOf({}, later)] }), CO, 'prp_1', KEY);
    expect(made.payKey).toBe(openStateRecord(STATE, KEY).blinding.payRecordKey);
  });

  it('A STATE SIGNED BY THE SEAT IN THE FOUNDING SIGNER\'S SLOT NOW, OR BY ANY SEAT BUT THE DEPLOY\'S, IS NOT READ', async () => {
    const { filedBy: _was, ...unsigned } = STATE;
    /* RED WHEN: the seat holding the account now, or a seat the wallet did not read as the deploy's, makes a first state believed. */
    await expect(runRebuiltHere(records({ founderRemoved: true, runs: [runOf({}, later)], state: signCompanyFiling(unsigned, later.secret) }), CO, 'prp_1', KEY))
      .rejects.toThrow(/signed by a seat other than the founding signer's/);
    await expect(runRebuiltHere(records({ founding: LATER, foundingCommittee: { tag: 'schnorr', value: '7b'.repeat(32) } }), CO, 'prp_1', KEY))
      .rejects.toThrow(/signed by a seat other than the founding signer's/);
    /* RED WHEN: an entry for the founding seat signed by any committee key but the one the deploy held the account by speaks for it. */
    await expect(runRebuiltHere(records({ foundingCommittee: { tag: 'schnorr', value: '7c'.repeat(32) } }), CO, 'prp_1', KEY))
      .rejects.toThrow(/not signed by the committee key the company's account was deployed with/);
    /* RED WHEN: a deploy seat with no entry this device believes is taken as anybody's. */
    await expect(runRebuiltHere(records({ founding: '5e'.repeat(32) }), CO, 'prp_1', KEY))
      .rejects.toThrow(/the seat the company's account was deployed with has no entry in its directory/);
  });

  it('A STATE NO SEAT THIS DEVICE BELIEVES SIGNED, OR NOT THE FIRST STATE, IS NOT READ', async () => {
    const { filedBy: _was, ...unsigned } = STATE;
    const cases: Array<[string, Parameters<typeof records>[0]]> = [
      ['signed by a key with no seat', { state: signCompanyFiling(unsigned, newSigningKeypair().secret) }],
      ['a later version', { state: signCompanyFiling({ ...unsigned, version: 2 }, founder.secret) }],
      ['bytes changed after signing', { state: { ...STATE, sealed: { ...STATE.sealed, body: `${STATE.sealed.body}00` } } }],
    ];
    for (const [why, o] of cases) {
      /* RED WHEN: that state gives the seeds a run is rebuilt from. */
      await expect(runRebuiltHere(records(o), CO, 'prp_1', KEY), why).rejects.toThrow(/does not believe the company state/);
    }
  });

  it('A RUN PAYING ANYBODY THIS DEVICE DOES NOT BELIEVE OR WOULD NOT PAY IS REFUSED BY THE RAISE CHECKS AN APPROVER RUNS', async () => {
    const payable = RAISE_CHECKS.find((c) => c.name === 'payable')!;
    const { run, leg, made } = await runRebuiltHere(records(), CO, 'prp_1', KEY);
    const cases: Array<[string, PeopleHere, RegExp]> = [
      ['a record no believed seat filed', peopleOf({ notBelieved: ['p2'] }), /Person p2 is on this run, and this device does not believe/],
      ['an address not their code\'s', peopleOf({ notPayable: [{ here: { person: BEA, version: 1, handedOver: true }, why: 'x' }] }), /Person p2 is on this run/],
      ['nobody on record', peopleOf({ people: [{ person: ALI, version: 1, handedOver: true }] }), /Person p2 is not on the roster/],
      ['a leaver', peopleOf({ people: [ALI, { ...BEA, status: 'leaver' as const }].map((p) => ({ person: p, version: 1, handedOver: true })) }), /leaver, not active/],
    ];
    for (const [why, people, says] of cases) {
      /* RED WHEN: a run paying that person passes the checks an approving device runs. */
      const facts = await factsHere(records({ people }), CO, run, KEY);
      expect(() => payable.check({ run, leg, made, filedBy: founder.publicKey }, facts), why).toThrow(says);
    }
  });

  it('A RUN NO SEAT THIS DEVICE BELIEVES FILED, OR ONE CHANGED AFTER IT WAS FILED, IS NOT READ', async () => {
    /* RED WHEN: a run is read without its filing signature being checked against a seat the directory holds. */
    await expect(runRebuiltHere(records({ runs: [runOf({}, newSigningKeypair())] }), CO, 'prp_1', KEY))
      .rejects.toThrow(/does not believe the company's record of this payroll run/);
    /* RED WHEN: a run the service changed after the seat signed it is read. */
    await expect(runRebuiltHere(records({ runs: [{ ...runOf(), period: '2026-11' }] }), CO, 'prp_1', KEY))
      .rejects.toThrow(/its signature does not cover exactly this run/);
  });

  it('A PROPOSAL NO RUN OF THIS COMPANY RAISED, OR A RUN BUILT FOR ANOTHER, IS NOT READ', async () => {
    /* RED WHEN: a proposal is checked against a run that did not raise it. */
    await expect(runRebuiltHere(records(), CO, 'prp_9', KEY)).rejects.toThrow(/No payroll run of this company raised this proposal/);
    await expect(runRebuiltHere(records(), 'acc_2', 'prp_1', KEY)).rejects.toThrow(/No payroll run of this company raised this proposal/);
    /* RED WHEN: a run whose leg names another run's identity gives the secrets it is rebuilt with. */
    const other = runOf();
    const swapped = runOf({ payout: { [LEG]: { opensAt: 1n, closesAt: 2n, runId: 'run_9:x', epoch: 0, vault: '99'.repeat(32) } } as never });
    await expect(runRebuiltHere(records({ runs: [swapped] }), CO, 'prp_1', KEY)).rejects.toThrow(/built for another run or another company/);
    /* RED WHEN: a run this key does not open is read. */
    await expect(runRebuiltHere(records({ runs: [other] }), CO, 'prp_1', newSymmetricKey() as Hex)).rejects.toThrow(/cannot open the payroll run/);
  });
});
