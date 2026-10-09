/**
 * **AN APPROVED LEG IS PAID BY ONE LOOP OVER THE PLAN'S STEPS, BY KIND.**
 *
 * **WHAT IS A STAND-IN, SAID HERE:** what the device makes for the leg
 * (`legToPayHere`), the charge of the run to its vault's period
 * (`chargeTheRunHere`) and the three step functions are substituted as
 * modules, each recording what it was handed; the vault's record is a real
 * sealed pool in memory, and the plan is the run planner's own. Each step
 * function's own work - written down first, read on this device, sent and
 * recorded - is `vault-operation.test.ts`'s, and a leg paid end to end is
 * `a-private-payment-from-the-page.test.ts`'s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../../src/midnight/vault-pool.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { newWrappingKeypair } from '../../../src/core/crypto.js';

const calls: string[] = [];
let order: PrivatePaymentOrderOnTheWire;
let paidOnTheAccount = new Set<number>();
let moveOnce: string | null = null;
/* What the record holds after the notes move: a stand-in for a step another device sent first. */
let movedTo: Array<{ nonce: string; value: bigint }> | null = null;
/* How many more times the notes move under a step; a leg that never stopped planning would stop at the last. */
let movesEveryTime = 0;
let unnamed = new Set<number>();
/* The account's read of who is paid lags behind: a payment sent is not shown on it yet. */
let accountLags = false;
let poolOf: ((notes: Array<{ nonce: string; value: bigint }>) => Promise<void>) | null = null;
vi.mock('./payments-made-here.js', () => ({
  legToPayHere: async () => ({
    order: { ...order, required: '2', payments: order.payments.map((p) => ({ ...p, paid: paidOnTheAccount.has(p.index) })) },
    proposalId: 'prp_theLegAAAAAA',
  }),
}));
/* Where the run stands under its vault's policy, as the charge answers it; every charge asked is kept, with what it was handed. */
let charging: 'no-policy' | 'already-charged' | 'charged' | 'refused' = 'no-policy';
const charges: Array<{ proposalId: string; required: string | undefined; vault: string }> = [];
vi.mock('./run-charged-here.js', () => ({
  chargeTheRunHere: async (_d: unknown, run: { order: { vault: string; required?: string }; proposalId: string }) => {
    charges.push({ proposalId: run.proposalId, required: run.order.required, vault: run.order.vault });
    calls.push(`charge ${charging}`);
    if (charging === 'refused') throw new Error('this run would take the vault past its limit for the period. Nothing was sent.');
    return charging === 'charged' ? { state: 'charged', spentBefore: 700n } : { state: charging };
  },
}));
vi.mock('./vault-operation.js', async (real) => {
  const actual = await real<typeof import('./vault-operation.js')>();
  const coin = (nonce: string, value: bigint) => ({ nonce, token: TOKEN, value: value.toString() });
  return {
    ...actual,
    mergeNotesInCompanyVault: async (_d: unknown, i: { notes: Array<{ nonce: string; value: string }> }) => {
      calls.push(`merge ${i.notes.map((n) => `${n.nonce.slice(0, 2)}:${n.value}`).join('+')}`);
      const value = i.notes.reduce((t, n) => t + BigInt(n.value), 0n);
      return { txRef: 'm', transactionHash: 'dc'.repeat(32), spent: i.notes.map((n) => n.nonce), kept: coin('e7'.repeat(32), value), seenAs: 'its-own-transaction' };
    },
    payPrivatelyFromCompanyVault: async (_d: unknown, i: { payment: PrivatePaymentOnTheWire; notes: Array<{ nonce: string; value: string }> }) => {
      if (movesEveryTime-- > 0 || (moveOnce !== null && i.notes.some((n) => n.nonce === moveOnce))) {
        moveOnce = null;
        calls.push(`moved under ${i.payment.index}`);
        if (movedTo !== null) await poolOf!(movedTo);
        throw new actual.NotesMovedUnderAStep('the chain no longer holds a note this vault\'s record would spend for this payment');
      }
      calls.push(`pay ${i.payment.index} ${i.payment.amount} from ${i.notes.map((n) => `${n.nonce.slice(0, 2)}:${n.value}`).join('+')}`);
      if (!accountLags) paidOnTheAccount.add(i.payment.index);
      const left = i.notes.reduce((t, n) => t + BigInt(n.value), 0n) - BigInt(i.payment.amount);
      const named = !unnamed.has(i.payment.index);
      return { txRef: 'o', transactionHash: named ? 'dd'.repeat(32) : '', spent: i.notes[0]!.nonce, change: left === 0n ? null : coin(`c${i.payment.index}`.padEnd(64, '0'), left), seenAs: named ? 'its-own-transaction' : 'by-what-it-left' };
    },
    payPubliclyFromCompanyVault: async (d: { paidYet: () => Promise<boolean | null> }, i: { payment: PrivatePaymentOnTheWire }) => {
      calls.push(`pay publicly ${i.payment.index} ${i.payment.amount} asking ${String(await d.paidYet())}`);
      paidOnTheAccount.add(i.payment.index);
      return { txRef: `u${i.payment.index}` };
    },
  };
});
/* The run planner, the real one; a test may hand the plan it answers, and every input it was asked with is kept. */
let planned: Array<{ units: Array<{ kind: string }> }> = [];
let planAnswer: unknown = null;
vi.mock('../../../src/midnight/payment-plan.js', async (real) => {
  const actual = await real<typeof import('../../../src/midnight/payment-plan.js')>();
  return { ...actual, planRun: (i: Parameters<typeof actual.planRun>[0]) => { planned.push(i as never); return planAnswer ?? actual.planRun(i); } };
});
const { payAnApprovedLeg, LegNotPayable } = await import('./leg-paid-here.js');
type Leg = import('./leg-paid-here.js').LegHere;
type Doors = import('./leg-paid-here.js').LegDoors;
type Paid = import('./leg-paid-here.js').LegPaid;
type StepSent = import('./leg-paid-here.js').LegStepSent;

const TOKEN = 'ab'.repeat(32);
const VAULT = 'a1'.repeat(32);
const wrapping = newWrappingKeypair();
const signers = async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }];
const aPayment = (index: number, amount: number, kind: 'shielded' | 'unshielded' = 'shielded'): PrivatePaymentOnTheWire => ({
  index, kind, payee: `addr_${index}`, token: TOKEN as never, amount: String(amount), blinding: '0b'.repeat(32) as never,
  nonce: `${index}`.padStart(2, '0').repeat(32) as never, leaf: '0d'.repeat(32) as never, path: [], paid: false,
});
const anOrder = (payments: PrivatePaymentOnTheWire[], form: 'shielded' | 'unshielded' = 'shielded'): PrivatePaymentOrderOnTheWire => ({
  asset: TOKEN, form, symbol: 'T', vault: VAULT as never, proposal: '0f'.repeat(32) as never, salt: '5a'.repeat(32) as never,
  root: '9a'.repeat(32) as never, payees: String(payments.length), opensAt: '0', closesAt: '9', payments,
});
const aVault = async (notes: Array<{ nonce: string; value: bigint }>) => {
  const kept = new Map<WireRecord, MemorySealedPoolStore>();
  const records = (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  const pool = () => new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, signers);
  const asNotes = (ns: Array<{ nonce: string; value: bigint }>) => ns.map((n) => ({ nonce: n.nonce, token: TOKEN, value: n.value, createdIn: '0e'.repeat(32) })) as never;
  await pool().create(VAULT, { notes: asNotes(notes) });
  poolOf = async (ns) => { const now = await pool().load(VAULT); await pool().save(VAULT, { notes: asNotes(ns) }, now.readAt); };
  /* The account's answer about a public payment, recorded with which payment it was asked about. */
  const paidYet = async (p: PrivatePaymentOnTheWire) => { calls.push(`asked about ${p.index}`); return true; };
  return { me: { signerId: 'ada', wrappingSecret: wrapping.secret }, signers, records, paidYet } as unknown as Doors;
};
const leg: Leg = { records: {} as never, accountId: 'acc_1', runId: 'run_1', viewingKey: '00'.repeat(32) as never, deps: {} as never };

beforeEach(() => {
  calls.length = 0; paidOnTheAccount = new Set(); moveOnce = null; planned = []; planAnswer = null;
  movedTo = null; movesEveryTime = 0; unnamed = new Set(); accountLags = false;
  charging = 'no-policy'; charges.length = 0;
});

describe('PAYING AN APPROVED LEG', () => {
  it('PLANS THE LEG ONCE AND RUNS ITS STEPS IN ORDER: THE MERGE A PAYMENT NEEDS FIRST, THEN EACH PERSON, EACH SPENDING EXACTLY THE NOTES ITS STEP NAMES', async () => {
    order = anOrder([aPayment(0, 250), aPayment(1, 50)]);
    /* Three notes of 120, 100 and 90: no two cover 250, so the planner merges them first. */
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 120n }, { nonce: 'a2'.repeat(32), value: 100n }, { nonce: 'a3'.repeat(32), value: 90n }]);
    const done: Paid = await payAnApprovedLeg(doors, leg);
    /* RED WHEN: a payment is sent before the merge it needs, chooses its notes instead of the step's, or the merged coin
     * and a payment's change are not carried to the step that spends them. */
    expect(calls).toEqual(['charge no-policy', 'merge a1:120+a2:100+a3:90', 'pay 0 250 from e7:310', 'pay 1 50 from c0:60']);
    expect(done).toMatchObject({ paid: [0, 1], alreadyPaid: [] });
    expect(done.steps.map((s) => s.kind)).toEqual(['merge', 'payment', 'payment']);
    /* RED WHEN: the leg is planned more than once without its notes moving, or the planner is asked for batches. */
    expect(planned).toHaveLength(1);
    expect(planned[0]!.units.map((u) => u.kind)).toEqual(['payment', 'payment']);
  });

  it('A BATCH STEP IS REFUSED BY NAME AS NOT BUILT YET, AND NOTHING IS SENT FOR IT', async () => {
    order = anOrder([aPayment(0, 30)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    planAnswer = { ok: true, units: [], left: [], steps: [{ kind: 'batch', unit: 0, notes: [{ kind: 'held', id: 'a1'.repeat(32) }], pays: 30n, change: 70n, after: [] }] };
    charging = 'charged';
    /* RED WHEN: a batch step is sent some other way - as a payment, say - rather than refused. */
    await expect(payAnApprovedLeg(doors, leg)).rejects.toThrow(/paying a batch is not built yet/);
    /* RED WHEN: a plan that cannot be paid as planned is charged first - a fee, and the run counted in its period. */
    expect(calls).toEqual([]);
  });

  it('SKIPS EVERYONE THE ACCOUNT ALREADY RECORDS PAID, AND PAYING AGAIN SENDS NOTHING', async () => {
    order = anOrder([aPayment(0, 30), aPayment(1, 40)]);
    paidOnTheAccount = new Set([0]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    /* RED WHEN: a person the account records paid is planned or sent again. */
    expect(await payAnApprovedLeg(doors, leg)).toMatchObject({ paid: [1], alreadyPaid: [0] });
    expect(calls).toEqual(['charge no-policy', 'pay 1 40 from a1:100']);
    calls.length = 0;
    expect(await payAnApprovedLeg(doors, leg)).toEqual({ paid: [], sentNotNamed: [], alreadyPaid: [0, 1], steps: [] });
    /* RED WHEN: a leg with nobody left to pay is charged - a fee for a run nothing more is paid from. */
    expect(calls).toEqual([]);
  });

  it('WHEN THE NOTES MOVE UNDER A STEP BEFORE IT IS SENT, THE LEG IS PLANNED AGAIN FROM THE RECORD AS IT IS NOW, AND PAYS ONLY WHO IS STILL OWED', async () => {
    order = anOrder([aPayment(0, 30), aPayment(1, 40)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    /* Person 0 is paid from a1, leaving c0 of 70; another step then spends c0, and the record holds b9 of 90 instead. */
    moveOnce = `c0`.padEnd(64, '0');
    movedTo = [{ nonce: 'b9'.repeat(32), value: 90n }];
    /* The account's read lags: it does not show person 0 paid yet. */
    accountLags = true;
    const done = await payAnApprovedLeg(doors, leg);
    /* RED WHEN: a step that found its notes moved stops the leg, the replan pays person 0 again, or it plans over the
     * pool as it stood before the notes moved. */
    expect(calls).toEqual(['charge no-policy', 'pay 0 30 from a1:100', 'moved under 1', 'pay 1 40 from b9:90']);
    expect(done.paid).toEqual([0, 1]);
    expect(planned).toHaveLength(2);
  });

  it('A LEG WHOSE NOTES KEEP MOVING IS PLANNED AT MOST THREE TIMES, AND THEN SAYS SO', async () => {
    order = anOrder([aPayment(0, 30)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    movesEveryTime = 10;
    /* RED WHEN: the leg plans again without end, or gives up before trying again. */
    await expect(payAnApprovedLeg(doors, leg)).rejects.toThrow(/no longer holds a note/);
    expect(planned).toHaveLength(3);
  }, 5_000);

  it('A PAYMENT FOUND ONLY BY WHAT IT LEFT IS NOT REPORTED PAID, AND IS NOT SENT AGAIN', async () => {
    order = anOrder([aPayment(0, 30), aPayment(1, 40)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    unnamed = new Set([0]);
    const done = await payAnApprovedLeg(doors, leg);
    /* RED WHEN: a payment its own step cannot name is counted as the person paid. */
    expect(done).toMatchObject({ paid: [1], sentNotNamed: [0] });
    expect(done.steps[0]).toMatchObject({ kind: 'payment', index: 0, seenAs: 'by-what-it-left' });
  });

  it('A LEG THE VAULT CANNOT PAY IS REFUSED BY THE PLANNER\'S OWN WORDS BEFORE ANY STEP IS SENT', async () => {
    order = anOrder([aPayment(0, 500)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    /* RED WHEN: a leg the notes cannot cover sends a step anyway. */
    await expect(payAnApprovedLeg(doors, leg)).rejects.toThrow(LegNotPayable);
    await expect(payAnApprovedLeg(doors, leg)).rejects.toThrow(/Deposit 400 more/);
    expect(calls).toEqual([]);
  });

  it('FROM A VAULT UNDER A POLICY, A LEG THE VAULT CANNOT PAY IS REFUSED BY THE PLANNER BEFORE THE RUN IS CHARGED: NO CHARGE IS BUILT OR SENT', async () => {
    charging = 'charged';
    order = anOrder([aPayment(0, 500)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    await expect(payAnApprovedLeg(doors, leg)).rejects.toThrow(/Deposit 400 more/);
    /* RED WHEN: the run is charged before the leg is planned - a fee, and its total counted in the period, for a leg
     * that is then refused and pays nobody. */
    expect(charges).toEqual([]);
    expect(calls).toEqual([]);
    /* The same leg, once the vault holds enough, is charged after it is planned and before its first step. */
    const funded = await aVault([{ nonce: 'a1'.repeat(32), value: 600n }]);
    const done = await payAnApprovedLeg(funded, leg);
    expect(calls).toEqual(['charge charged', 'pay 0 500 from a1:600']);
    expect(done.steps.map((x) => x.kind)).toEqual(['charge', 'payment']);
  });

  it('A LEG PAID IN PUBLIC MONEY IS NOT PLANNED: EACH PERSON STILL OWED IS PAID PUBLICLY, ASKED OF THEIR OWN PAYMENT', async () => {
    order = anOrder([aPayment(0, 30, 'unshielded'), aPayment(1, 40, 'unshielded'), aPayment(2, 50, 'unshielded')], 'unshielded');
    paidOnTheAccount = new Set([1]);
    const doors = await aVault([]);
    const done = await payAnApprovedLeg(doors, leg);
    /* RED WHEN: a public leg is planned over notes, or pays a person the account records paid. */
    /* RED WHEN: each payment is not asked about by itself. */
    expect(calls).toEqual(['charge no-policy', 'asked about 0', 'pay publicly 0 30 asking true', 'asked about 2', 'pay publicly 2 50 asking true']);
    const sent: StepSent[] = [{ kind: 'public-payment', index: 0, txRef: 'u0' }, { kind: 'public-payment', index: 2, txRef: 'u2' }];
    expect(done.steps).toEqual(sent);
  });
  it('FROM A VAULT UNDER A POLICY THE RUN IS CHARGED TO ITS PERIOD BEFORE ANYTHING IS PAID, ONCE, AND NOT AGAIN WHEN THE LEG IS PLANNED AGAIN', async () => {
    charging = 'charged';
    order = anOrder([aPayment(0, 30), aPayment(1, 40)]);
    const doors = await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]);
    moveOnce = `c0`.padEnd(64, '0');
    movedTo = [{ nonce: 'b9'.repeat(32), value: 90n }];
    accountLags = true;
    const done = await payAnApprovedLeg(doors, leg);
    /* RED WHEN: the charge is not the first thing paying does, or a leg planned again is charged again. */
    expect(calls).toEqual(['charge charged', 'pay 0 30 from a1:100', 'moved under 1', 'pay 1 40 from b9:90']);
    /* RED WHEN: the run is charged as another proposal, or with other approvals, than the leg as this device opened it. */
    expect(charges).toEqual([{ proposalId: 'prp_theLegAAAAAA', required: '2', vault: VAULT }]);
    /* RED WHEN: what the charge did is not reported with what the leg sent. */
    expect(done.steps[0]).toEqual({ kind: 'charge', spentBefore: 700n });
    expect(done.steps.map((x) => x.kind)).toEqual(['charge', 'payment', 'payment']);
  });

  it('A RUN THE CHAIN ALREADY HOLDS AS CHARGED, OR FROM A VAULT WITH NO POLICY, IS PAID WITH NO CHARGE SENT', async () => {
    for (const state of ['already-charged', 'no-policy'] as const) {
      charging = state; calls.length = 0;
      order = anOrder([aPayment(0, 30)]);
      paidOnTheAccount = new Set();
      const done = await payAnApprovedLeg(await aVault([{ nonce: 'a1'.repeat(32), value: 100n }]), leg);
      /* RED WHEN: a charge is reported, or the payment is not made, for a run that needs none. */
      expect(done.steps.map((x) => x.kind), state).toEqual(['payment']);
      expect(calls, state).toEqual([`charge ${state}`, 'pay 0 30 from a1:100']);
    }
  });

  it('A CHARGE REFUSED STOPS THE LEG BEFORE ANY PAYMENT IS SENT', async () => {
    charging = 'refused';
    order = anOrder([aPayment(0, 30, 'unshielded')], 'unshielded');
    /* RED WHEN: a payment goes out from a policy vault after its charge was refused - the chain refuses it after a fee. */
    await expect(payAnApprovedLeg(await aVault([]), leg)).rejects.toThrow(/past its limit for the period/u);
    expect(calls).toEqual(['charge refused']);
  });
});
