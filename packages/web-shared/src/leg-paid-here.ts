/**
 * **AN APPROVED LEG PAID FROM THE COMPANY'S VAULT, ON A SIGNER'S DEVICE.**
 *
 * What the vault is handed for the leg - or for one retry raised on it - is
 * made here from the company's records (`privatePaymentsHere`), and everyone
 * the account already records paid is left out. A leg paid in private money is
 * planned ONCE by the run planner (`planRun`) over the vault's record and the
 * people still owed, and its steps are run in their order by one loop that
 * switches on each step's kind: a merge through `mergeNotesInCompanyVault`, a
 * person's payment through `payPrivatelyFromCompanyVault`, each spending
 * exactly the notes the step names. Nothing here chooses a note.
 *
 * Every step is written down before it is sent and built on what this device
 * read at the indexer the person's own wallet names; that is the two step
 * functions', and this file adds nothing between them and the chain. When the
 * vault's notes move under a step before it is sent - another step landed
 * first - nothing was sent, and the leg is planned again from the record as it
 * now stands, paying only the people still owed.
 *
 * A leg paid in public money spends no note, so it is not planned: each person
 * still owed is paid through `payPubliclyFromCompanyVault`.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { planRun, type PlanStep } from '../../../src/midnight/payment-plan.js';
import { SealedNotePool } from '../../../src/midnight/vault-pool.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import {
  mergeNotesInCompanyVault, NotesMovedUnderAStep, payPrivatelyFromCompanyVault, payPubliclyFromCompanyVault, wireOf,
  type PayoutDoors,
} from './vault-operation.js';
import type { NoteOnTheWire } from './vault-builder.js';
import { legToPayHere, type PaymentsHereDeps } from './payments-made-here.js';
import { chargeTheRunHere, type ChargeDoors } from './run-charged-here.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import type { LegNamed } from './material-made-here.js';

/** What paying a leg is done with: the doors every step out of the vault takes, and the account's record of a payment. */
export interface LegDoors extends PayoutDoors {
  /**
   * The service's route a proven charge of the run to its vault's period is
   * relayed by. A run from a vault under a spending policy is not paid without it.
   */
  readonly charge?: ChargeDoors['charge'];
  /** Where this device keeps a charge it relayed until the chain shows it; a run from a policy vault is not paid without it. */
  readonly chargesInFlight?: ChargeDoors['chargesInFlight'];
  /**
   * Whether the company's account records this payment as made, asked again
   * after a public payment is sent: `true` once it does, `false` while it does
   * not, `null` when this deployment cannot say.
   */
  readonly paidYet: (payment: PrivatePaymentOnTheWire) => Promise<boolean | null>;
}

/** The approved leg, as this device opens it from the company's records: a leg, or one retry raised on it. */
export interface LegHere {
  readonly records: CompanyRecordsHere;
  readonly accountId: string;
  readonly runId: string;
  readonly viewingKey: Hex;
  readonly deps: PaymentsHereDeps;
  readonly which?: LegNamed;
  /** The proposal a retry on the leg was raised as; absent for the leg itself. */
  readonly retry?: string;
}

/** One step the leg sent, in the order sent. */
export type LegStepSent =
  /** The run charged to its vault's period, before anything was paid; `spentBefore` is what the period had been charged. */
  | { readonly kind: 'charge'; readonly spentBefore: bigint }
  | { readonly kind: 'merge'; readonly spent: readonly Hex[]; readonly kept: NoteOnTheWire; readonly transactionHash: string }
  /**
   * A person's payment. `seenAs` is the step's own: `by-what-it-left` when the
   * send named no transaction and the payment was found only by what it left,
   * which cannot say whose payment it was.
   */
  | {
    readonly kind: 'payment'; readonly index: number; readonly transactionHash: string;
    readonly seenAs: 'its-own-transaction' | 'by-what-it-left';
  }
  | { readonly kind: 'public-payment'; readonly index: number; readonly txRef: string };

/**
 * What paying the leg did: who it paid now, seen by their payment's own
 * transaction; whose payment was sent and found only by what it left, so only
 * the account's record, read again, says whether they are paid; who the account
 * already recorded paid; and every step it sent.
 */
export interface LegPaid {
  readonly paid: readonly number[];
  readonly sentNotNamed: readonly number[];
  readonly alreadyPaid: readonly number[];
  readonly steps: readonly LegStepSent[];
}

/** The leg cannot be paid from what the vault's record holds, and nothing more was sent. */
export class LegNotPayable extends Error {
  constructor(why: string) {
    super(`${why} Nothing more was sent.`);
    this.name = 'LegNotPayable';
  }
}

/** How many times a leg is planned again after the vault's notes moved under one of its steps, before it stops. */
const PLANS_AT_MOST = 3;

/** Why a plan with a batch step is not paid: no raise groups payees into batches yet. */
const A_BATCH_IS_NOT_PAID_YET = 'This leg\'s plan has a batch step, and paying a batch is not built yet.';

/**
 * **ONE STEP OF THE PLAN, SENT, BY ITS KIND.** A batch is a step the planner
 * makes only for a leg raised as batches, and no raise groups payees into
 * batches yet; it is refused by name rather than sent some other way.
 */
async function sendStep(
  doors: LegDoors, order: PrivatePaymentOrderOnTheWire, owed: readonly PrivatePaymentOnTheWire[],
  step: PlanStep, notes: readonly NoteOnTheWire[],
): Promise<{ readonly sent: LegStepSent; readonly kept: NoteOnTheWire | null }> {
  switch (step.kind) {
    case 'merge': {
      const r = await mergeNotesInCompanyVault(doors, { vault: order.vault, notes });
      return { sent: { kind: 'merge', spent: r.spent, kept: r.kept, transactionHash: r.transactionHash }, kept: r.kept };
    }
    case 'payment': {
      const payment = owed[step.unit]!;
      const r = await payPrivatelyFromCompanyVault(doors, { order, payment, notes });
      return { sent: { kind: 'payment', index: payment.index, transactionHash: r.transactionHash, seenAs: r.seenAs }, kept: r.change };
    }
    case 'batch':
      throw new LegNotPayable(A_BATCH_IS_NOT_PAID_YET);
  }
}

/**
 * **PAY AN APPROVED LEG, OR A RETRY RAISED ON IT, FROM THE COMPANY'S VAULT.**
 * Everyone the account records paid is skipped; the rest are paid one step at
 * a time, as the plan says. A leg with nobody left to pay sends nothing. From
 * a vault under a spending policy the run is charged to its period on this
 * device (`chargeTheRunHere`) once the leg is known to be payable and before
 * its first step is sent: after the planner has planned it from the vault's
 * record, or, in public money, before the first person is paid. A leg the
 * planner refuses is refused before any charge or fee. The run is charged at
 * most once here, not again when the leg is planned again, and not at all
 * when the chain already holds it as charged or its vault has no policy.
 */
export async function payAnApprovedLeg(doors: LegDoors, leg: LegHere): Promise<LegPaid> {
  const steps: LegStepSent[] = [];
  const paid: number[] = [];
  const sentNotNamed: number[] = [];
  let alreadyPaid: number[] | null = null;
  let chargeSettled = false;
  /* The run charged to its vault's period, when the vault is under a policy: once, just before the leg's first step. */
  const chargedFirst = async (toPay: Awaited<ReturnType<typeof legToPayHere>>): Promise<void> => {
    if (chargeSettled) return;
    const charged = await chargeTheRunHere(
      { ...doors, records: leg.records, accountId: leg.accountId, viewingKey: leg.viewingKey }, toPay);
    chargeSettled = true;
    if (charged.state === 'charged') steps.push({ kind: 'charge', spentBefore: charged.spentBefore });
  };
  for (let plans = 1; ; plans += 1) {
    const toPay = await legToPayHere(leg.records, leg.accountId, leg.runId, leg.viewingKey, leg.deps, leg.which, leg.retry);
    const { order } = toPay;
    alreadyPaid ??= order.payments.filter((p) => p.paid === true).map((p) => p.index);
    /* Nobody this loop has already sent a payment to is planned again, whatever the account's read says yet. */
    const sentTo = new Set([...paid, ...sentNotNamed]);
    const owed = order.payments.filter((p) => p.paid !== true && !sentTo.has(p.index));
    if (owed.length === 0) return { paid, sentNotNamed, alreadyPaid, steps };

    /* ---- public money spends no note: nothing to plan, so the run is charged before the first person is paid ---- */
    if (order.form === 'unshielded') {
      await chargedFirst(toPay);
      for (const payment of owed) {
        const r = await payPubliclyFromCompanyVault({ ...doors, paidYet: () => doors.paidYet(payment) }, { order, payment });
        paid.push(payment.index);
        steps.push({ kind: 'public-payment', index: payment.index, txRef: r.txRef });
      }
      return { paid, sentNotNamed, alreadyPaid, steps };
    }

    /* ---- private money: planned once, over the vault's record and the people still owed ---- */
    const pool = await new SealedNotePool(doors.records('pool'),
      { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers).load(order.vault);
    const first = owed[0]!;
    const plan = planRun({
      token: first.token,
      notes: pool.notes.map((n) => ({ id: n.nonce, token: n.token, value: n.value, spendable: n.createdIn !== undefined })),
      units: owed.map((p) => ({ kind: 'payment' as const, payees: [{ id: String(p.index), amount: BigInt(p.amount), nonce: p.nonce }] })),
    });
    if (plan.ok === false) throw new LegNotPayable(plan.message);
    if (plan.steps.some((st) => st.kind === 'batch')) throw new LegNotPayable(A_BATCH_IS_NOT_PAID_YET);
    /* ---- the leg is payable as planned: the run charged to its period before the plan's first step is sent ---- */
    await chargedFirst(toPay);
    const held = new Map(pool.notes.map((n) => [n.nonce, wireOf(n)]));
    const made = new Map<number, NoteOnTheWire>();
    try {
      for (const [i, step] of plan.steps.entries()) {
        const notes = step.notes.map((ref) => {
          const note = ref.kind === 'held' ? held.get(ref.id as Hex) : made.get(ref.step);
          if (note === undefined) throw new LegNotPayable('A step of this leg\'s plan spends a coin no earlier step kept.');
          return note;
        });
        const { sent, kept } = await sendStep(doors, order, owed, step, notes);
        steps.push(sent);
        if (sent.kind === 'payment') (sent.seenAs === 'its-own-transaction' ? paid : sentNotNamed).push(sent.index);
        if (kept !== null) made.set(i, kept);
      }
      return { paid, sentNotNamed, alreadyPaid, steps };
    } catch (e) {
      /*
       * The notes moved before a step was sent, or another step spent a note one sent spends and landed first, so it
       * never can: plan again from the record as it is now, for the people still owed.
       */
      if (!(e instanceof NotesMovedUnderAStep) || plans === PLANS_AT_MOST) throw e;
    }
  }
}
