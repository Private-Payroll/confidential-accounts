/**
 * **THE ONE LIST OF RAISE CHECKS, ON A ROUND MADE HERE AND THE FACTS READ HERE.**
 * Each check is judged here on the proposal alone; that the raiser and every
 * approver run the whole list is pinned where they do it
 * (`src/server/a-leg-is-raised-on-the-device.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { factsOfThePaid, runLegOf } from '../../../src/core/run-legs.js';
import { recordSkips } from '../../../src/core/run-drawing.js';
import { paidMovementOfLeaf, paidOnceOfNonce } from '../../../src/midnight/payout-tree.js';
import { payRecordNonceOf, type PayRecord } from '../../../src/midnight/run-keys.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { PayrollRun, RosterEmployee } from '../../../src/core/types.js';
import { payeeFor } from '../../../src/testing/payees.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../../../src/testing/assets.js';
import { RAISE_CHECKS, type FactsHere, type RoundToCheck } from './raise-checks-here.js';
import { refuseARetryOfALegNeverOnChain, refuseARetryWhileItsLegCanPay } from '../../../src/core/run-raising.js';
import type { RunMadeHere } from './what-this-device-made.js';
import type { PeopleHere } from './people-on-device.js';

const CO = 'acc_1';
const LEG = runLegOf(TEST_TOKEN, 'shielded');
const REGISTRY = registryWithTestPrivateForms();
const person = (id: string, at: string): RosterEmployee => ({
  id, accountId: CO, name: `Person ${id}`, status: 'active', address: payeeFor(at.repeat(32), 'undeployed'),
} as unknown as RosterEmployee);
const ALI = person('p1', 'a1');
const BEA = person('p2', 'a2');
const CAL = person('p3', 'a3');
const employeesOf = (people: readonly RosterEmployee[]) =>
  people.map((p, i) => ({ id: p.id, name: p.name, wrappingPublicKey: null, asset: TEST_TOKEN, amount: BigInt(100 + i), form: 'shielded' }));
const runOf = (people: readonly RosterEmployee[]): PayrollRun => ({
  id: 'run_aaaaaaaaaaa1', accountId: CO, period: '2026-09', status: 'proposed', employees: employeesOf(people), payslips: [],
  totals: {}, proposalIds: { [LEG]: 'prp_1' },
} as unknown as PayrollRun);
/** A round of `run` as made here: the leg's recorded payments, and for a retry the positions it pays. */
const roundOf = (run: PayrollRun, recordedFrom: readonly RosterEmployee[], retry?: number[]): RoundToCheck => ({
  run, leg: LEG, filedBy: 'f1'.repeat(32), vault: 'c5'.repeat(32),
  made: {
    kind: 'payroll', seeds: [], payKey: '00'.repeat(32), identity: { accountId: CO, runId: `run_aaaaaaaaaaa1:${LEG}`, epoch: 0 },
    facts: factsOfThePaid(run.employees, (id) => recordedFrom.find((p) => p.id === id), REGISTRY), records: [],
    asset: TEST_TOKEN, opensAt: '1', closesAt: '2', required: '0', ...(retry === undefined ? {} : { retry }),
  } as RunMadeHere,
});
const factsOf = (people: readonly RosterEmployee[]): FactsHere => ({
  people: { people: people.map((p) => ({ person: p, version: 1, handedOver: true })), notBelieved: [], notPayable: [] } as unknown as PeopleHere,
  directory: { dir: { company: CO, version: 1, seats: [] }, holders: {} as never, another: new Set() },
  policy: { threshold: 1, limitsByRole: {} } as never,
  others: [], live: new Set(), registry: REGISTRY, rounds: [], standingOf: () => undefined, nowInSeconds: 0n,
  spendingPolicy: { state: 'none' },
  circuits: { paidOnceOf: pureCircuits.paidOnceOf, paidMovementOf: pureCircuits.paidMovementOf, read: async () => { throw new Error('not read here'); } },
});
const check = (name: string) => RAISE_CHECKS.find((c) => c.name === name)!.check;

describe('THE ONE LIST OF RAISE CHECKS', () => {
  it('HOLDS EVERY CHECK A RAISE AND AN APPROVAL RUN, EACH ONCE', () => {
    /* RED WHEN: a check is dropped from the list, so the raiser or an approver no longer runs it. */
    expect(RAISE_CHECKS.map((c) => c.name)).toEqual([
      'leg-raised-once', 'no-other-round-of-the-leg', 'leg-no-longer-pays', 'not-on-another-retry',
      'payable', 'decided-not-to-pay', 'ceiling', 'spending-policy', 'over-another-run', 'one-payee-twice', 'unaccounted',
    ]);
  });

  it('A ROUND FROM A VAULT UNDER A SPENDING POLICY IS ONE THE CHAIN WILL CHARGE: IN ONE PERIOD, IN A BAND, WITHIN THE LIMIT, AT ITS BAND\'S APPROVALS', () => {
    const run = runOf([ALI, BEA, CAL]);
    const policyCheck = check('spending-policy');
    const under = (spendingPolicy: FactsHere['spendingPolicy']): FactsHere => ({ ...factsOf([ALI, BEA, CAL]), spendingPolicy });
    const set = (over: Partial<Extract<FactsHere['spendingPolicy'], { state: 'set' }>> = {}): FactsHere['spendingPolicy'] =>
      ({ state: 'set', version: 1, period: 0n, required: 2n, periodLimit: 1000n, ...over });
    const raisedNeeding = (required: string, retry?: number[]): RoundToCheck => {
      const r = roundOf(run, [ALI, BEA, CAL], retry);
      return { ...r, made: { ...r.made, required } };
    };
    /* RED WHEN: a vault with no policy is held to anything - it is paid as it always was, at whatever the raiser chose. */
    expect(() => policyCheck(raisedNeeding('0'), under({ state: 'none' }))).not.toThrow();
    /* RED WHEN: a round is raised or approved on a policy this device could not read - it would be raised on a guess. */
    expect(() => policyCheck(raisedNeeding('2'), under({ state: 'unread', why: 'the wallet did not answer' })))
      .toThrow(/could not read the spending policy of the vault this run is paid from \(the wallet did not answer\)/u);
    /* RED WHEN: a round from a vault with a policy for another currency only is raised - the chain charges it to nothing and never pays it. */
    expect(() => policyCheck(raisedNeeding('2'), under({ state: 'not-for-this-currency' }))).toThrow(/none for the currency this run pays in/u);
    /* RED WHEN: a round whose window crosses from one period into the next is raised - the chain would never charge it (fees spent for nothing). */
    expect(() => policyCheck(raisedNeeding('2'), under(set({ period: null })))).toThrow(/does not lie inside one period/u);
    /* RED WHEN: a round above every band is raised - no number of approvals can pay it. */
    expect(() => policyCheck(raisedNeeding('2'), under(set({ required: null })))).toThrow(/above every band/u);
    /* RED WHEN: a round alone over the limit per period is raised; a retry of fewer people within it is not refused. */
    expect(() => policyCheck(raisedNeeding('2'), under(set({ periodLimit: 302n })))).toThrow(/more than the vault it is paid from may pay in one period/u);
    expect(() => policyCheck(raisedNeeding('2'), under(set({ periodLimit: 303n })))).not.toThrow();
    expect(() => policyCheck(raisedNeeding('2', [2]), under(set({ periodLimit: 102n })))).not.toThrow();
    expect(() => policyCheck(raisedNeeding('2', [2]), under(set({ periodLimit: 101n })))).toThrow(/may pay in one period/u);
    /* RED WHEN: a round is raised needing fewer approvals than its band - the chain would refuse to charge it after every approval and fee. */
    expect(() => policyCheck(raisedNeeding('1'), under(set()))).toThrow(/raised needing 1 approvals, and its band .* needs 2/u);
    expect(() => policyCheck(raisedNeeding('0'), under(set()))).toThrow(/raised needing 0 approvals/u);
    expect(() => policyCheck(raisedNeeding('two'), under(set()))).toThrow(/raised needing two approvals/u);
    /* RED WHEN: a proposal raised needing more than its band is refused - that is the raiser's own choice (the founder's rule on extra approvals). */
    expect(() => policyCheck(raisedNeeding('2'), under(set()))).not.toThrow();
    expect(() => policyCheck(raisedNeeding('3'), under(set()))).not.toThrow();
  });

  it('EACH RETRY CHECK GUARDS ITS OWN INPUTS: RUN ALONE, OR BEFORE THE OTHERS, ON A LEG NEVER RAISED, IT REFUSES BY NAME', () => {
    const run = runOf([ALI, BEA, CAL]);
    for (const name of ['leg-no-longer-pays', 'not-on-another-retry']) {
      /* RED WHEN: a retry check reads the leg's record without asking whether it is there, and works only because another check ran first. */
      expect(() => check(name)(roundOf(run, [ALI, BEA, CAL], [1]), factsOf([ALI, BEA, CAL])), name)
        .toThrow(/leg of run run_aaaaaaaaaaa1 has not been raised, so there is nobody on it to retry/u);
    }
    /* And with the list run backwards, the first check to refuse a retry of a leg never raised says the same. */
    const backwards = [...RAISE_CHECKS].reverse();
    const refused = backwards.map((c) => { try { c.check(roundOf(run, [ALI, BEA, CAL], [1]), factsOf([ALI, BEA, CAL])); return null; } catch (e) { return [c.name, (e as Error).message] as const; } })
      .filter((x) => x !== null && /not-on-another-retry|leg-no-longer-pays/u.test(x[0]));
    expect(refused.map((x) => x![1].includes('has not been raised'))).toEqual([true, true]);
  });

  it('EVERY REFUSAL OF A RETRY READS THE LEG\'S RECORD ONLY ONCE IT HAS ASKED WHETHER IT IS THERE, EVEN WITH THE LEG\'S ROUND IN HAND', () => {
    const run = runOf([ALI, BEA, CAL]);
    const legRound = { status: 'open', raisedAt: '2026-09-01T00:00:00.000Z' } as never;
    /* RED WHEN: either refusal reads a leg the run never raised as though it had, rather than refusing by name. */
    expect(() => refuseARetryOfALegNeverOnChain(run, LEG, legRound, REGISTRY)).toThrow(/has not been raised, so there is nobody on it to retry/u);
    expect(() => refuseARetryWhileItsLegCanPay(run, LEG, legRound, 0n, REGISTRY)).toThrow(/has not been raised, so there is nobody on it to retry/u);
  });

  it('TWO PEOPLE AT ONE ADDRESS ON THE LEG ARE REFUSED ON A RETRY AS ON A RAISE, WHOEVER THE RETRY NAMES', () => {
    const twin = { ...BEA, address: ALI.address } as RosterEmployee;
    const run = runOf([ALI, twin, CAL]);
    for (const retry of [undefined, [1], [2]]) {
      /* RED WHEN: the check runs only on a leg's raise, or only over the people a retry names: the address is still paid twice for the month. */
      expect(() => check('one-payee-twice')(roundOf(run, [ALI, twin, CAL], retry), factsOf([ALI, twin, CAL])), JSON.stringify(retry))
        .toThrow(/are both on this run and are paid at the same address/u);
    }
    expect(() => check('one-payee-twice')(roundOf(runOf([ALI, BEA, CAL]), [ALI, BEA, CAL], [1]), factsOf([ALI, BEA, CAL]))).not.toThrow();
  });

  it('A ROUND PAYS ONLY PEOPLE THIS DEVICE WOULD PAY, AT EXACTLY WHAT THE LEG RECORDS IT PAYS THEM, AND A RETRY IS JUDGED ON WHOM IT NAMES', () => {
    const run = runOf([ALI, BEA, CAL]);
    const moved = { ...BEA, address: payeeFor('b9'.repeat(32), 'undeployed') } as RosterEmployee;
    /* RED WHEN: a person whose record now names another address than the leg records paying them at is paid at the old one. */
    expect(() => check('payable')(roundOf(run, [ALI, moved, CAL]), factsOf([ALI, BEA, CAL]))).toThrow(/this run pays Person p2 at another address, in another form or another amount/u);
    expect(() => check('payable')(roundOf(run, [ALI, moved, CAL], [1]), factsOf([ALI, BEA, CAL]))).toThrow(/this run pays Person p2 at another address, in another form or another amount/u);
    /* RED WHEN: a leg that records paying somebody another amount, or another token, than the run names is paid as recorded. */
    for (const changed of [{ amount: 1n }, { token: 'ee'.repeat(32) }]) {
      const round = roundOf(run, [ALI, BEA, CAL], [1]);
      const off = { ...round, made: { ...round.made, facts: round.made.facts.map((f, i) => (i === 1 ? { ...f, ...changed } : f)) } } as RoundToCheck;
      expect(() => check('payable')(off, factsOf([ALI, BEA, CAL])), Object.keys(changed).join()).toThrow(/this run pays Person p2 at another address/u);
    }
    /* RED WHEN: a retry is judged on people it does not pay. */
    expect(() => check('payable')(roundOf(run, [ALI, moved, CAL], [2]), factsOf([ALI, BEA, CAL]))).not.toThrow();
    const leaver = { ...ALI, status: 'leaver' } as RosterEmployee;
    expect(() => check('payable')(roundOf(run, [ALI, BEA, CAL], [1, 2]), factsOf([leaver, BEA, CAL]))).not.toThrow();
    expect(() => check('payable')(roundOf(run, [ALI, BEA, CAL], [0]), factsOf([leaver, BEA, CAL]))).toThrow(/leaver, not active/u);
    /* RED WHEN: a round naming somebody not on the leg is taken as paying nobody in particular. */
    expect(() => check('payable')(roundOf(run, [ALI, BEA, CAL], [3]), factsOf([ALI, BEA, CAL]))).toThrow(/names people who are not on the leg/u);
  });

  it('A ROUND WHOSE LEG LISTS OTHER PEOPLE THAN IT RECORDS PAYMENTS FOR IS REFUSED, WHOEVER IT NAMES', () => {
    const run = runOf([ALI, BEA, CAL]);
    const round = roundOf(run, [ALI, BEA, CAL], [0]);
    const longer = { ...round, made: { ...round.made, facts: [...round.made.facts, round.made.facts[0]!] } } as RoundToCheck;
    /* RED WHEN: a leg whose recorded payments do not line up with its people is judged position by position as if they did. */
    expect(() => check('payable')(longer, factsOf([ALI, BEA, CAL]))).toThrow(/lists 3 people and records 4 payments/u);
  });

  it('NOBODY THE RUN RECORDS A DECISION NOT TO PAY IS PAID BY A ROUND OF IT, ON A RAISE OR AN APPROVAL ALIKE', () => {
    const run = { ...runOf([ALI, BEA, CAL]), skips: recordSkips('run_aaaaaaaaaaa1', [{ employeeId: BEA.id, name: BEA.name, waiting: 'us' }] as never, { by: 'ada', reason: 'not admitted' } as never, '2026-10-01T00:00:00.000Z') } as PayrollRun;
    /* RED WHEN: a round naming somebody the run's own record says not to pay is passed, so an approver pays what the raiser was refused. */
    expect(() => check('decided-not-to-pay')(roundOf(run, [ALI, BEA, CAL], [1]), factsOf([ALI, BEA, CAL]))).toThrow(/#2 is marked on run run_aaaaaaaaaaa1 as not to be paid/u);
    expect(() => check('decided-not-to-pay')(roundOf(run, [ALI, BEA, CAL], [0, 2]), factsOf([ALI, BEA, CAL]))).not.toThrow();
    expect(() => check('decided-not-to-pay')(roundOf(runOf([ALI, BEA, CAL]), [ALI, BEA, CAL], [1]), factsOf([ALI, BEA, CAL]))).not.toThrow();
  });

  it('WHAT THE CHAIN HOLDS BEYOND THE RECORDS IS PASSED ONLY AS FAR AS A REPEAT CONFIRMED IT, AND ONLY OVER ENTRIES THE WALLET WAS ASKED', () => {
    const run = runOf([ALI]);
    const ROUND_A = 'a0'.repeat(32);
    const ROUND_B = 'b0'.repeat(32);
    const LEAF = 'c0'.repeat(32) as Hex;
    const withChain = (o: { open: string[]; entries: number; confirmed?: { of: string[]; chainPayments?: number }; asked?: string[]; held?: string[] }): RoundToCheck => {
      const round = roundOf(run, [ALI]);
      const known = [paidMovementOfLeaf(LEAF).toLowerCase()];
      return { ...round, made: { ...round.made,
        raising: { period: '2026-09', knownRounds: [], knownLeaves: [LEAF], knownNonces: [], ...(o.confirmed === undefined ? {} : { confirmed: o.confirmed }) },
        wallet: { payKeyCommitment: null, asked: o.asked ?? known, held: o.held ?? [], openRounds: o.open, entries: o.entries },
      } } as RoundToCheck;
    };
    const unaccounted = check('unaccounted');
    const facts = factsOf([ALI]);
    /* RED WHEN: a repeat that confirmed one round is taken as confirming every round the chain holds. */
    expect(() => unaccounted(withChain({ open: [ROUND_A, ROUND_B], entries: 0, confirmed: { of: [ROUND_A] } }), facts)).toThrow(/open round/u);
    expect(() => unaccounted(withChain({ open: [ROUND_A], entries: 0, confirmed: { of: [ROUND_A] } }), facts)).not.toThrow();
    /* RED WHEN: a repeat that confirmed fewer payments than the chain now holds beyond the records is taken as confirming them. */
    expect(() => unaccounted(withChain({ open: [], entries: 4, confirmed: { of: [], chainPayments: 2 } }), facts)).toThrow(/unexplained payment entries/u);
    expect(() => unaccounted(withChain({ open: [], entries: 2, confirmed: { of: [], chainPayments: 2 } }), facts)).not.toThrow();
    /* A payment the records know about is not one the chain holds beyond them. */
    expect(() => unaccounted(withChain({ open: [], entries: 1, held: [paidMovementOfLeaf(LEAF).toLowerCase()] }), facts)).not.toThrow();
    /* RED WHEN: the wallet's answer is taken though it was not asked about every payment the records know of. */
    expect(() => unaccounted(withChain({ open: [], entries: 0, asked: [] }), facts)).toThrow(/was not asked about every payment these records know about/u);
  });

  it('THE CEILING IS THE ONE FOR THE ROLE OF THE SEAT THAT FILED THE PROPOSAL, OVER WHAT THE PROPOSAL PAYS', () => {
    const run = runOf([ALI, BEA, CAL]);
    const seat = (role: string | null) => ({ seat: 's', person: 'p', signingKey: 'F1'.repeat(32), wrappingKey: 'ab'.repeat(32), committeeKey: { tag: 't', value: 'v' }, role, retired: null });
    const ceilingFor = (role: string | null, per: Record<string, bigint>) => ({
      ...factsOf([ALI, BEA, CAL]),
      directory: { dir: { company: CO, version: 1, seats: [seat(role)] }, holders: {} as never, another: new Set<string>() } as never,
      policy: { threshold: 1, limitsByRole: Object.fromEntries(Object.entries(per).map(([r, n]) => [r, { [TEST_TOKEN]: { perTransaction: n } }])) } as never,
    });
    /* The leg pays 100 + 101 + 102 = 303; a retry of the third person, 102. */
    /* RED WHEN: the ceiling is judged for another role than the filing seat's, or over the leg when the proposal is a retry. */
    expect(() => check('ceiling')(roundOf(run, [ALI, BEA, CAL]), ceilingFor('approver', { approver: 302n, admin: 10_000n }))).toThrow(/for role "approver"/u);
    expect(() => check('ceiling')(roundOf(run, [ALI, BEA, CAL]), ceilingFor('approver', { approver: 303n }))).not.toThrow();
    expect(() => check('ceiling')(roundOf(run, [ALI, BEA, CAL], [2]), ceilingFor('approver', { approver: 102n }))).not.toThrow();
    expect(() => check('ceiling')(roundOf(run, [ALI, BEA, CAL], [2]), ceilingFor('approver', { approver: 101n }))).toThrow(/102 exceeds/u);
    /* A seat its directory gives no role has every right; the ceilings are an admin's. */
    expect(() => check('ceiling')(roundOf(run, [ALI, BEA, CAL]), ceilingFor(null, { admin: 302n }))).toThrow(/for role "admin"/u);
  });
});

describe('WHAT THE PERSON\'S OWN WALLET IS ASKED, FOR A COMPANY WITH A LONG HISTORY', () => {
  it('IS ASKED IN PARTS OF AT MOST THE MOST ONE ASK TAKES, EVERY ENTRY ONCE, AND PARTS THAT FIND THE CHAIN DIFFERENTLY ARE REFUSED', async () => {
    const { withWhatTheWalletRead, RunNotReadHere } = await import('./run-rebuilt-here.js');
    const { MOST_ENTRIES_ASKED } = await import('midnight-identity/profile/request');
    const leaves = Array.from({ length: MOST_ENTRIES_ASKED + 5 }, (_, i) => i.toString(16).padStart(64, '0'));
    const made = { ...roundOf(runOf([ALI]), [ALI]).made, raising: { period: '2026-09', knownRounds: [], knownLeaves: leaves, knownNonces: [] } };
    const parts: number[] = [];
    let moved = false;
    const records = (over: () => number, open: () => string[] = () => [], committed: () => string | null = () => null) => ({
      payments: {
        paidOnceOf: pureCircuits.paidOnceOf, paidMovementOf: pureCircuits.paidMovementOf,
        read: async (entries: readonly string[]) => {
          /* As the wallet does: an ask naming one entry twice is refused. */
          if (new Set(entries).size !== entries.length) throw new Error('an entry was asked twice');
          parts.push(entries.length);
          return { payKeyCommitment: committed(), held: [entries[0]!], openRounds: open(), entries: over() };
        },
      },
    }) as never;
    const read = await withWhatTheWalletRead(records(() => 9), made);
    /* RED WHEN: an ask is made over more entries than one ask takes, an entry is asked twice or left out, or a part's answer is dropped. */
    expect(parts).toEqual([MOST_ENTRIES_ASKED, leaves.length - MOST_ENTRIES_ASKED]);
    expect(new Set(read.wallet!.asked).size).toBe(leaves.length);
    expect(read.wallet!.held).toHaveLength(2);
    expect(read.wallet!.entries).toBe(9);
    /* RED WHEN: two parts that read the chain at different moments are taken as one reading. */
    parts.length = 0;
    await expect(withWhatTheWalletRead(records(() => (moved = !moved) ? 9 : 11), made)).rejects.toThrow(RunNotReadHere);
    await expect(withWhatTheWalletRead(records(() => (moved = !moved) ? 9 : 11), made)).rejects.toThrow(/changed while your wallet was reading it/u);
    /* RED WHEN: parts that found other rounds open, or another pay-record key commitment, are taken as one reading. */
    await expect(withWhatTheWalletRead(records(() => 9, () => ((moved = !moved) ? ['a0'.repeat(32)] : [])), made)).rejects.toThrow(/changed while your wallet was reading it/u);
    await expect(withWhatTheWalletRead(records(() => 9, () => [], () => ((moved = !moved) ? 'cc'.repeat(32) : null)), made)).rejects.toThrow(/changed while your wallet was reading it/u);
    /* RED WHEN: an entry the run itself and the records both name is asked twice, which the wallet refuses. */
    const record: PayRecord = { person: 'p1', month: '2026-09', kind: 'salary', occurrence: 0 } as PayRecord;
    const payKey = '5a'.repeat(32) as Hex;
    const nonce = payRecordNonceOf(payKey, record);
    const both = { ...made, payKey, records: [record], raising: { ...made.raising, knownLeaves: [], knownNonces: [nonce] } };
    const once = await withWhatTheWalletRead(records(() => 2), both);
    expect(once.wallet!.asked).toEqual([paidOnceOfNonce(nonce).toLowerCase()]);
  });
});
