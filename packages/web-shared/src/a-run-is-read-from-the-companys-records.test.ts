/**
 * **A PAYROLL RUN IS READ FOR APPROVAL ON THIS DEVICE FROM THE COMPANY'S OWN
 * RECORDS**: the state its founding seat signed, the run opened with the
 * viewing key, and the people this device believes and would pay.
 */
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import { describe, expect, it } from 'vitest';
import { canonical, newSigningKeypair, newSymmetricKey, seal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { signRunFiling } from '../../../src/core/run-filing.js';
import { openRecord, sealRecord } from '../../../src/core/sealed-records.js';
import { newStateBlinding, sealState } from '../../../src/core/account.js';
import { signedFoundingState, CREATED_BEFORE_SIGNED_STATE, openStateRecord } from '../../../src/core/founding-state.js';
import { factsOfThePaid, proposalListOf, runLegOf } from '../../../src/core/run-legs.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { signCompanyFiling } from '../../../src/midnight/sealed-record-wire.js';
import type { PayrollRun, RosterEmployee, SealedProposal, SealedRun } from '../../../src/core/types.js';
import { payeeFor } from '../../../src/testing/payees.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../../../src/testing/assets.js';
import {
  anchoredOver, everyRunAndProposalEntered, heldEntering, heldServing, noRoundHeld, type FoundedWith,
} from '../../../src/testing/record-tree-double.js';
import {
  believedProposalIdsOnChainHere, payrollRoundsHere, roundClosesAtHere, runRebuiltHere, RunNotReadHere, standingOnChainHere, unheldPastItsWindow,
  type CompanyRecordsHere,
} from './run-rebuilt-here.js';
import { foundedOnChainHere } from './vault-page-doors.js';
import { signProposalFiling } from '../../../src/core/proposal-filing.js';
import { factsHere, RAISE_CHECKS } from './raise-checks-here.js';
import { RecordWithheld } from './http-sealed-pool-store.js';
import type { DirectoryHere } from './vault-page-doors.js';
import type { PeopleHere } from './people-on-device.js';
import { noOneOffsHere } from '../../../src/testing/no-one-offs.js';

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
/**
 * A payroll round raised from the founding seat's device: its window sealed beside the leg's root and payee count, its
 * digest and identity on chain made from them, its vault and its salt; `o` makes one of them disagree.
 */
const aRoundRaisedWith = (o: {
  readonly runId?: string; readonly sealedCloses?: string; readonly sealedPayees?: string; readonly chainVault?: string;
  readonly chainSalt?: string; readonly digest?: string; readonly noWindow?: boolean;
} = {}): SealedProposal => {
  const root = '0a'.repeat(32); const vault = 'c2'.repeat(32); const salt = '5a'.repeat(32);
  const made = { root, payees: 2n, opensAt: 1_800_000_000n, closesAt: 1_800_600_000n, required: 1n };
  const digest = Buffer.from(pureCircuits.runPayload(Buffer.from(root, 'hex'), made.payees, made.opensAt, made.closesAt, made.required)).toString('hex');
  const chainId = Buffer.from(pureCircuits.proposalIdOf(Buffer.from(digest, 'hex'), Buffer.from(o.chainVault ?? vault, 'hex'), Buffer.from(o.chainSalt ?? salt, 'hex'))).toString('hex');
  const window = { root, payees: o.sealedPayees ?? '2', opensAt: String(made.opensAt), closesAt: o.sealedCloses ?? String(made.closesAt) };
  return {
    ...signProposalFiling(CO, {
      id: 'prp_1', digest: (o.digest ?? digest) as Hex, chainId: chainId as Hex, keyEpoch: 0, createdAt: '2026-10-09T00:00:00.000Z',
      sealed: sealRecord('proposals', CO, {
        kind: 'payroll', vault,
        sealedPayload: seal(canonical({
          runId: o.runId ?? 'run_1', form: 'shielded', entries: [], ...(o.noWindow === true ? {} : { window }),
          __change: { asset: TEST_TOKEN, salt }, __required: made.required,
        }), KEY),
      }, KEY),
    }, founder.secret),
    accountId: CO, status: 'open', approvalCount: 0,
  } as unknown as SealedProposal;
};

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
/** Founded on the chain by Ada's seat, its first anchor holding the first state the founding signer's device made. */
const FOUNDED: FoundedWith = { seat: SEAT, signingSecret: founder.secret, records: [STATE], committee: [COMMITTEE] };
interface Founding { readonly founderRemoved?: boolean; readonly founded?: FoundedWith; readonly firstSeats?: readonly string[] }
const here = async (o: Founding = {}): Promise<DirectoryHere> => {
  const believed = {
    dir: { company: CO, version: 2, seats: [
      { seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin' as const, retired: null, opening: {} as never },
      { seat: LATER, person: 'ben', signingKey: later.publicKey, wrappingKey: 'ac'.repeat(32), committeeKey: { tag: 'schnorr', value: '7b'.repeat(32) }, role: 'admin' as const, retired: null, opening: {} as never },
    ] },
    /* What the person's own wallet read: who holds the account now. */
    holders: {
      committee: [COMMITTEE, { tag: 'schnorr', value: '7b'.repeat(32) }], seats: o.founderRemoved === true ? [LATER] : [SEAT, LATER], approvals: 1, adoptedVaults: [],
      account: 'ac'.repeat(32),
    } as never,
    another: new Set<string>(), at: () => null, leafOf: () => null,
  };
  return { ...believed, records: await heldEntering(CO, [], o.founded ?? FOUNDED, believed) };
};
const peopleOf = (o: Partial<PeopleHere> = {}): PeopleHere => ({
  people: [ALI, BEA].map((p) => ({ person: p, version: 1, handedOver: true })), notBelieved: [], notPayable: [], ...o,
});
const records = (o: Founding & { state?: unknown; people?: PeopleHere; runs?: SealedRun[]; proposals?: SealedProposal[] } = {}): CompanyRecordsHere => {
  /* Sealed once: every read of the company's runs is served the same bytes, as the store serves what it keeps. */
  const runs = o.runs ?? [runOf()];
  return everyRunAndProposalEntered({
    oneOffs: noOneOffsHere(),
    directory: async () => here(o),
    people: async () => o.people ?? peopleOf(),
    state: async (id) => (id === '0' ? ('state' in o ? o.state : STATE) as never : null),
    runs: async () => runs,
    proposals: async () => o.proposals ?? [],
    /* The person's own wallet reads a chain that holds no proposal, as it reads no round open. */
    roundsOnChain: noRoundHeld,
    roundIdentity: pureCircuits,
    /* A chain that has paid nobody and holds nothing open, as the person's own wallet reads it. */
    payments: {
      paidOnceOf: pureCircuits.paidOnceOf, paidMovementOf: pureCircuits.paidMovementOf,
      read: async () => ({ payKeyCommitment: null, held: [], openRounds: [], entries: 0 }),
    },
    policy: async () => ({ threshold: 1, limitsByRole: {} }) as never,
    registry: registryWithTestPrivateForms(),
  }, CO, [founder.secret, later.secret], o.founded ?? FOUNDED);
};
/** The records with the seats the company's first anchor names put as `firstSeats`, whatever its header's leaves. */
const firstAnchorNaming = (firstSeats: readonly string[], o: Parameters<typeof records>[0] = {}): CompanyRecordsHere => {
  const r = records(o);
  return { ...r, directory: async (asked) => { const d = await r.directory(asked); return { ...d, records: { ...d.records, firstSeats } }; } };
};

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

  it('THE FOUNDING SEAT IS THE FIRST ANCHOR\'S: A FOUNDER REMOVED SINCE STILL MAKES THE FIRST STATE BELIEVED', async () => {
    /* RED WHEN: the first state is believed only while its signer still holds the account, so removing the founding signer strands every approval. */
    const { made } = await runRebuiltHere(records({ founderRemoved: true, runs: [runOf({}, later)] }), CO, 'prp_1', KEY);
    expect(made.payKey).toBe(openStateRecord(STATE, KEY).blinding.payRecordKey);
  });

  it('A STATE SIGNED BY THE SEAT IN THE FOUNDING SIGNER\'S SLOT NOW, OR BY ANY SEAT BUT THE ONE THE FIRST ANCHOR NAMES, IS NOT READ', async () => {
    const { filedBy: _was, ...unsigned } = STATE;
    /* RED WHEN: the seat holding the account now, or a seat the first anchor does not name, makes a first state believed. */
    await expect(runRebuiltHere(records({ founderRemoved: true, runs: [runOf({}, later)], state: signCompanyFiling(unsigned, later.secret) }), CO, 'prp_1', KEY))
      .rejects.toThrow(/signed by a seat other than the founding signer's/);
    /* RED WHEN: a company whose first anchor Ben's seat made alone believes the state Ada signed as its founding state. */
    await expect(runRebuiltHere(records({ founded: { seat: LATER, signingSecret: later.secret, records: [STATE], committee: [{ tag: 'schnorr', value: '7b'.repeat(32) }] } }), CO, 'prp_1', KEY))
      .rejects.toThrow(/signed by a seat other than the founding signer's/);
    /* RED WHEN: a seat the first anchor names with no entry this device believes is taken as anybody's. */
    await expect(runRebuiltHere(firstAnchorNaming(['5e'.repeat(32)]), CO, 'prp_1', KEY))
      .rejects.toThrow(/the seat the company's first anchor names has no entry in its directory/);
  });

  it('NO FOUNDING SEAT IS SAID FROM A FIRST ANCHOR WITH TWO SEATS, OR ONE ANOTHER SEAT MADE, OR WHOSE LEAVES ARE NOT ITS ROOT, OR FROM NONE', async () => {
    /* RED WHEN: a first anchor made with two seats on the account names either as the founding seat - a second signer seated first could be it. */
    await expect(runRebuiltHere(firstAnchorNaming([SEAT, LATER]), CO, 'prp_1', KEY))
      .rejects.toThrow(/first anchor was made with 2 seats on its account/);
    /* RED WHEN: the seat the first anchor names is believed though another seat's key signed that first batch. */
    await expect(runRebuiltHere(firstAnchorNaming([LATER]), CO, 'prp_1', KEY))
      .rejects.toThrow(/first anchor was not made by the one seat its account held then/);
    /* RED WHEN: seats are read off a first header whose leaves do not make the root its call checked. */
    await expect(runRebuiltHere(firstAnchorNaming(null as never), CO, 'prp_1', KEY))
      .rejects.toThrow(/do not make the signer root its anchor call checked/);
    /* RED WHEN: a founding seat is said for a company nothing of which is anchored - from the wallet's deploy, or from whoever holds slot 0. */
    const r = records();
    const unanchored = {
      ...r, directory: async (asked?: RecordsAsked) => {
        const read = await r.directory(asked);
        return { ...read, records: await heldServing(CO, { runs: await r.runs() }, [founder.secret], undefined, read) };
      },
    };
    await expect(runRebuiltHere(unanchored, CO, 'prp_1', KEY)).rejects.toThrow(/founding records are not anchored on chain yet/);
  });

  it('THE SEATS OF THE FIRST ANCHOR ARE READ OFF ITS HEADER ONLY WHEN ITS LEAVES MAKE THE ROOT ITS CALL CHECKED', async () => {
    /* A service keeping nothing of its own: the founding batch is the test chain's, served beside it. */
    const nothingKept = async () => ({ entries: [], batches: [] });
    const foldedWith = async (founded: FoundedWith) => {
      const base = await here();
      /* The directory as anchored with that batch: Ada's seat, an admin, which may anchor. */
      return anchoredOver(nothingKept, CO, undefined, undefined, { ...founded, committee: [COMMITTEE] })({ ...base, at: () => ({ dir: base.dir, digests: [] }) }, { founding: true });
    };
    expect((await foldedWith(FOUNDED)).firstSeats).toEqual([SEAT]);
    /* RED WHEN: the seats a founding header names are taken though they are not the signer tree its anchor call checked. */
    expect((await foldedWith({ ...FOUNDED, leaves: [SEAT, LATER] })).firstSeats).toBeNull();
  });

  it('A ROUND THE CHAIN NEVER HELD CAN PAY UNTIL ITS OWN WINDOW CLOSES, AS ITS SEALED PROPOSAL HOLDS IT, AND A HELD ONE IS THE CHAIN\'S TO SAY', () => {
    const round = (o: Parameters<typeof aRoundRaisedWith>[0] = {}) => {
      const rec = aRoundRaisedWith(o);
      const inside = openRecord<{ vault?: unknown; sealedPayload: Sealed }>('proposals', CO, rec.sealed, KEY);
      return roundClosesAtHere(rec, inside, KEY, pureCircuits);
    };
    /* RED WHEN: the window a round was raised with is not read back from its own sealed proposal. */
    expect(round()).toBe(1_800_600_000n);
    /* RED WHEN: a window that is not the one its identity on chain was made with is believed - a service could keep a round live, or end it early. */
    expect(round({ sealedCloses: '1900600000' })).toBeUndefined();
    expect(round({ sealedPayees: '3' })).toBeUndefined();
    /* RED WHEN: a payload digest its identity on chain was not made from - another vault or salt - is believed. */
    expect(round({ chainVault: 'c3'.repeat(32) })).toBeUndefined();
    expect(round({ chainSalt: '5b'.repeat(32) })).toBeUndefined();
    /* RED WHEN: a filing naming another digest than the sealed window makes is believed. */
    expect(round({ digest: 'd2'.repeat(32) })).toBeUndefined();
    /* RED WHEN: a round sealed with no window is given one. */
    expect(round({ noWindow: true })).toBeUndefined();
    const legRound = { closesAt: 1_800_600_000n };
    /* RED WHEN: a round the chain never held is taken as withdrawn before its window closes - its proof may still be sent. */
    expect(unheldPastItsWindow(legRound, 1_800_599_999n)).toBe(false);
    /* RED WHEN: it is taken as live after its window closed, when no payment against it can land. */
    expect(unheldPastItsWindow(legRound, 1_800_600_000n)).toBe(true);
    /* RED WHEN: a round the chain holds is judged by its window here rather than by where the chain says it stands. */
    expect(unheldPastItsWindow({ ...legRound, raisedAt: '2026-10-10T00:00:00.000Z' }, 1_900_000_000n)).toBe(false);
    /* RED WHEN: a round with no window it can be held to is taken as past one. */
    expect(unheldPastItsWindow({}, 1_900_600_000n)).toBe(false);
  });

  it('A ROUND THE CHAIN NEVER HELD IS COUNTED LIVE FOR A RAISE UNTIL ITS WINDOW CLOSES, BY THIS DEVICE\'S CLOCK', async () => {
    const run = (await runRebuiltHere(records(), CO, 'prp_1', KEY)).run;
    /* The leg's own round, written down and filed by the founding seat; the chain has never held it. */
    const legRound = aRoundRaisedWith({ runId: run.id });
    /* RED WHEN: a round the chain never held is left out of the rounds still live before its window closes. */
    expect([...(await factsHere(records({ proposals: [legRound] }), CO, run, KEY, new Date(1_800_599_999_000))).live]).toEqual([run.id]);
    /* RED WHEN: it is still counted live once its window has closed, so its run's month can never be raised again. */
    expect([...(await factsHere(records({ proposals: [legRound] }), CO, run, KEY, new Date(1_800_600_000_000))).live]).toEqual([]);
  });

  it('A ROUND CLOSED PAST ITS WINDOW READS WITHDRAWN, AND A CLOSED PAYROLL ROUND READS CLOSED UNPAID WHATEVER ELSE ITS BLOCK HELD', async () => {
    const run = (await runRebuiltHere(records(), CO, 'prp_1', KEY)).run;
    const legRound = aRoundRaisedWith({ runId: run.id });
    const closedBy = (calls: readonly string[]) => ({
      roundsOnChain: async () => ({ [legRound.chainId]: { held: 'closed' as const, approvals: 1, raisedAt: 1_800_000_000_000, txRef: 'ab'.repeat(32), closedBy: calls } }),
    });
    /* RED WHEN: a round closed past its window by anyone's call reads carried out - its month would read raised for good. */
    expect((await standingOnChainHere(closedBy(['closeExpiredRun']), [legRound]))[0]!.status).toBe('cancelled');
    /* RED WHEN: a proposal closed in a block whose calls that succeeded carried a change out and withdrew none does not read carried out. */
    expect((await standingOnChainHere(closedBy(['amendSigner']), [legRound]))[0]!.status).toBe('executed');
    /* RED WHEN: a proposal closed in a block where a withdrawal succeeded reads carried out - it may be the one withdrawn. */
    expect((await standingOnChainHere(closedBy(['amendSigner', 'cancel']), [legRound]))[0]!.status).toBe('cancelled');
    /* RED WHEN: a proposal closed in a block where no call succeeded in full reads carried out - nothing says it was. */
    expect((await standingOnChainHere(closedBy([]), [legRound]))[0]!.status).toBe('cancelled');
    /* A block whose calls name no withdrawal: the history cannot say which closed it. */
    const [read] = await standingOnChainHere(closedBy(['approve', 'clearRun']), [legRound]);
    const at = { identity: pureCircuits, nowInSeconds: 1_800_000_000n };
    /* RED WHEN: a payroll round read as closed by some other call of its block is taken as carried out - paying closes no payroll round. */
    expect(payrollRoundsHere([read!], CO, KEY, at)[0]!.status).toBe('cancelled');
  });

  it('A COMPANY IS FOUNDED ON CHAIN ONLY WHEN ITS FIRST ANCHOR HOLDS ITS FIRST STATE AND ITS FIRST ROSTER, ENTERED BY ITS FOUNDING SEAT', async () => {
    const roster = signCompanyFiling({
      company: CO, kind: 'roster', id: 'signers', version: 1, keyEpoch: 0, sealed: { iv: '00', tag: '00', body: '00' }, wrapped: [],
    }, founder.secret);
    /* RED WHEN: a company whose first anchor holds no first roster is founded, so a signer may be added beside its founder. */
    expect(foundedOnChainHere(await here())).toMatch(/does not hold its first state and its first roster/);
    expect(foundedOnChainHere(await here({ founded: { ...FOUNDED, records: [roster] } }))).toMatch(/does not hold its first state and its first roster/);
    /* RED WHEN: the two records entered by another seat found the company. */
    expect(foundedOnChainHere(await here({ founded: { ...FOUNDED, records: [STATE, roster], enteredBy: later.secret } })))
      .toMatch(/does not hold its first state and its first roster/);
    /* RED WHEN: a later version of the roster in the first batch is taken as the first roster the company was founded with. */
    const later2 = signCompanyFiling({
      company: CO, kind: 'roster', id: 'signers', version: 2, keyEpoch: 0, sealed: { iv: '00', tag: '00', body: '00' }, wrapped: [],
    }, founder.secret);
    expect(foundedOnChainHere(await here({ founded: { ...FOUNDED, records: [STATE, later2] } }))).toMatch(/does not hold its first state and its first roster/);
    expect(foundedOnChainHere(await here({ founded: { ...FOUNDED, records: [STATE, roster] } }))).toBeNull();
  });

  it('A FOUNDING STATE IS BELIEVED ONLY AS THE COMPANY\'S FIRST ANCHOR HOLDS IT: NOT ANOTHER COPY, AND NOT ONE ANCHORED LATER', async () => {
    const other = signedFoundingState(CO, sealState({ entries: [] }, newStateBlinding(), KEY, 0), founder.secret);
    /* RED WHEN: a first state the founding seat signed is believed though its first anchor holds another one - two founding states, either served. */
    await expect(runRebuiltHere(records({ state: other }), CO, 'prp_1', KEY)).rejects.toThrow(/not the bytes the company's records anchor on chain/);
    /* RED WHEN: a first state anchored in a later batch, or never, is believed as a record the company was founded with. */
    const policy = signCompanyFiling({
      company: CO, kind: 'policy', id: 'pol_1', version: 1, keyEpoch: 0, sealed: { iv: '00', tag: '00', body: '00' }, wrapped: [],
    }, founder.secret);
    await expect(runRebuiltHere(records({ founded: { ...FOUNDED, records: [policy] } }), CO, 'prp_1', KEY))
      .rejects.toThrow(/the company's first anchor does not hold it/);
    /* RED WHEN: a first state anchored by the founding seat in its second batch is believed as one the company was founded with. */
    await expect(runRebuiltHere(records({ founded: { ...FOUNDED, records: [policy], thenAnchored: [STATE] } }), CO, 'prp_1', KEY))
      .rejects.toThrow(/the company's first anchor does not hold it/);
    /* RED WHEN: a first state whose entry in the first batch another seat signed is believed as the founding seat's. */
    await expect(runRebuiltHere(records({ founded: { ...FOUNDED, enteredBy: later.secret } }), CO, 'prp_1', KEY))
      .rejects.toThrow(/records name it under another seat than the one whose signature it carries/);
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
      expect(() => payable.check({ run, leg, made, filedBy: founder.publicKey, vault: 'c5'.repeat(32) }, facts), why).toThrow(says);
    }
  });

  it('THE CHECKS A RAISE AND AN APPROVAL RUN ARE NEVER WORKED OUT FROM A LIST OF RUNS OR PROPOSALS SHORT OF ONE THE RECORDS NAME', async () => {
    const run = (await runRebuiltHere(records(), CO, 'prp_1', KEY)).run;
    const full = records();
    /* The company's records name the run; the service then lists none. */
    const short = { ...full, runs: async () => [] };
    /* RED WHEN: the live rounds and the runs over them are worked out from a list short of a run the records name. */
    await expect(factsHere(short, CO, run, KEY)).rejects.toBeInstanceOf(RecordWithheld);
    /* RED WHEN: the run a proposal raised is looked for in a list short of one the records name, and said to be none. */
    await expect(runRebuiltHere(short, CO, 'prp_1', KEY)).rejects.toBeInstanceOf(RecordWithheld);
    /* The company's records name a proposal; the service then lists none. */
    const proposal = {
      ...signProposalFiling(CO, {
        id: 'prp_listedAAAAAA', digest: 'd1'.repeat(32) as Hex, chainId: 'e1'.repeat(32) as Hex, keyEpoch: 0, createdAt: '2026-10-09T00:00:00.000Z',
        sealed: { iv: '00', tag: '00', body: '00' } as never,
      }, founder.secret),
      accountId: CO, status: 'pending', approvalCount: 0,
    } as unknown as SealedProposal;
    const naming = records({ proposals: [proposal] });
    /* RED WHEN: the rounds still live are worked out from a list short of a proposal the records name - a live round unseen. */
    await expect(factsHere({ ...naming, proposals: async () => [] }, CO, run, KEY)).rejects.toBeInstanceOf(RecordWithheld);
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

describe('WHICH PROPOSAL ON CHAIN EACH OF THE COMPANY\'S PROPOSALS IS, AS THIS DEVICE BELIEVES IT', () => {
  /* A proposal filed and signed by `secret`, under the company's name `id`, whose identity on chain is `chain`. */
  const filed = (id: string, chain: string, secret: Hex, account = CO): SealedProposal => ({
    ...signProposalFiling(account, {
      id, digest: 'd1'.repeat(32) as Hex, chainId: chain as Hex, keyEpoch: 0, createdAt: '2026-10-09T00:00:00.000Z',
      sealed: { iv: '00', tag: '00', body: '00' } as never,
    }, secret),
    accountId: account, status: 'pending', approvalCount: 0,
  } as unknown as SealedProposal);
  const stranger = newSigningKeypair();

  it('NAMES ONLY A PROPOSAL A SEAT FILED, SIGNED OVER EXACTLY IT, AND ENTERED BY THAT SEAT', async () => {
    const ours = filed('prp_believedAAAA', 'e1'.repeat(32), founder.secret);
    const tampered = { ...filed('prp_tamperedAAAA', 'e2'.repeat(32), founder.secret), chainId: 'e3'.repeat(32) as Hex };
    const noSeat = filed('prp_noseatAAAAAA', 'e4'.repeat(32), stranger.secret);
    const unsigned = { ...filed('prp_unsignedAAAA', 'e5'.repeat(32), founder.secret), filedBy: undefined };
    const ids = await believedProposalIdsOnChainHere(records({ proposals: [ours, tampered, noSeat, unsigned as never] }), CO);
    /* RED WHEN: a proposal the service wrote itself, one changed after it was signed, or one no seat filed names a proposal on chain. */
    expect([...ids]).toEqual([['prp_believedAAAA', 'e1'.repeat(32)]]);
  });

  it('A PROPOSAL A SEAT FILED BUT NO ENTRY IN THE COMPANY\'S RECORDS NAMES, OR FILED FOR ANOTHER COMPANY, NAMES NOTHING', async () => {
    const ours = filed('prp_believedAAAA', 'e1'.repeat(32), founder.secret);
    const kept = records({ proposals: [ours] });
    const notEntered: CompanyRecordsHere = { ...kept, directory: async (asked) => {
      const read = await kept.directory(asked);
      return { ...read, records: await heldEntering(CO, [], undefined, read) };
    } };
    /* RED WHEN: a proposal is believed without its entry, so a retry the service made up is charged as one the chain may have cleared. */
    expect([...await believedProposalIdsOnChainHere(notEntered, CO)]).toEqual([]);
    /* RED WHEN: another company's proposal, signed for it or served as its, names a proposal of this company's on chain. */
    expect([...await believedProposalIdsOnChainHere(records({ proposals: [filed('prp_believedAAAA', 'e1'.repeat(32), founder.secret, 'acc_2')] }), CO)]).toEqual([]);
    expect([...await believedProposalIdsOnChainHere(records({ proposals: [{ ...ours, accountId: 'acc_2' }] }), CO)]).toEqual([]);
  });
});

describe('every way of reading a company\'s records says how it reads its one-off payments', () => {
  it('a records door with no one-off payments door does not typecheck', () => {
    const without = {} as Omit<CompanyRecordsHere, 'oneOffs'>;
    /* RED WHEN (typecheck): a door can be built that leaves one-off payments out, so a paid one-off is not counted against the vault. */
    // @ts-expect-error: `oneOffs` is required
    const doors: CompanyRecordsHere = without;
    expect(doors).toBe(without);
  });
});

