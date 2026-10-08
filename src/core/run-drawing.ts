/**
 * **HOW A PAYROLL RUN IS DRAWN: WHO IT PAYS, WHO IT LEAVES OUT, WHAT IT
 * REPEATS, AND THE PAYSLIP EACH PERSON IS SEALED.**
 *
 * One copy of every rule a run is drawn by, for the signer's device that
 * draws it and for the service's own draw that tests still make companies
 * with. Pure: it reads nothing and writes nothing, and every fact it needs -
 * the people, the runs the company already has, the rounds its proposals
 * record - is handed in.
 */
import { canonical, newSymmetricKey, seal, wrapKey, type Hex } from './crypto.js';
import { ledgerFormOf, subtotals, type AssetId, type AssetRegistry, type LedgerForm } from './assets.js';
import { NO_COMPANY, NO_LABEL, NO_LEAF, untilText } from './payslip-open.js';
import { canonicalPeriod } from './run-legs.js';
import { isLiveRound } from './retry-cover.js';
import { payrollPayee } from './movement.js';
import type { Employee, PayrollRun, RosterEmployee, RunRepeatRecord, RunSkip, RunSkips } from './types.js';
import type { PayrollRound } from './account.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { emptyRegister, decide } from '../midnight/run-skips.js';


export interface EmployeeSpec {
  name: string;
  /** What actually moves for this person. */
  asset: AssetId;
  /** In `asset`'s smallest unit. */
  amount: bigint;
}

/**
 * **WHAT AN ADMIN HAS TO SAY TO RUN PAYROLL WITHOUT SOMEBODY ON IT.**
 *
 * **NOT A BOOLEAN, AND THAT IS THE WHOLE OF IT.** A flag says *yes, whatever
 * that was*; it can be set by a screen that never showed a name, carried over
 * from a previous attempt, or defaulted true by a client somebody wrote in a
 * hurry — and in each case whoever happens to be pending at the moment the
 * button is pressed is dropped without anybody reading their name. **That is
 * the silent skip the old refusal existed to prevent, and it would be the way
 * this change reintroduced it.**
 *
 * So the acknowledgement carries the NAMES, the PERSON accepting it, and the
 * REASON — and the door compares the names against the ones it is actually
 * about.
 */
export interface SkipAcknowledgement {
  /**
   * **THE SAME SET as the people this run would leave out — neither a superset
   * nor a subset of it.**
   *
   * A run that skips somebody the admin did not name is the silent drop. A run
   * naming somebody who is NOT being skipped is the same failure seen from the
   * other side: the list the admin read is not the list the run would act on,
   * so their agreement is about a different payroll. Both are refused.
   *
   * **COMPARED AS A SET AND NOT AS A LIST**, said here because the first
   * wording of this sentence said *exactly these ids* and a reviewer was right
   * that a repeated id passes. It should: a duplicate is the same person named
   * twice, one `RunSkip` is still recorded, and nobody is dropped. Order is not
   * compared either, for the same reason.
   */
  employeeIds: string[];
  /**
   * **WHO IS ACCEPTING IT, AND IT IS NOT SOMETHING A CALLER GETS TO CHOOSE
   * WHERE THERE IS ANYBODY TO ASK.**
   *
   * Checked by `decide`, which refuses an unattributed decision. **What `decide`
   * cannot check is whether the name is the caller's own**, and this service
   * cannot either: it runs with no server in front of it. So the served routes
   * take this from the signed-in caller and do not read it off the request body — see
   * `src/server/index.ts`'s run-creation route, which says why at length. **A
   * string here is a claim; it stops being one at the door.**
   */
  by: string;
  /** Why, in their words. Checked by `decide`, which refuses a blank reason on a skip. */
  reason: string;
}

/**
 * **THE RUN'S RECORD OF WHO IT LEFT OUT, BUILT THROUGH `run-skips.ts` RATHER
 * THAN BESIDE IT.**
 *
 * The skip reader was written and tested against the compiled contract, and
 * wired it to nothing. **This is its second and closer caller and it does not
 * close that** — the index `runStatus` reads is a different one, over a
 * leg's payout leaves and under the proposal id that leg was raised with, and
 * joining the two is still owed.
 *
 * **EVERY RULE ABOUT A SKIP IS ASKED BY CALLING `decide`, AND NOT ONE OF THEM
 * IS RESTATED HERE.** An unattributed decision, a blank reason and an index
 * outside the run are refused by that function, in its own sentences, because a
 * rule written twice is this project's oldest failure and a refusal written
 * twice is one that can be deleted in one place and go on looking enforced.
 * **What that costs is that the values handed to it have to be capable of
 * failing its checks** — see the note on `reason` below, which is where the
 * first draft of this function quietly stopped being able to. **The
 * consequence is deliberate: this throws before a run exists**, so an
 * acknowledgement with nobody's name on it produces no payroll rather than a
 * payroll with an unsigned skip in it.
 */
export const recordSkips = (
  runId: string, people: RunSkip[], ack: SkipAcknowledgement, at: string,
): RunSkips => {
  let decisions = emptyRegister(runId, people.length);
  people.forEach((person, index) => {
    decisions = decide(decisions, {
      index,
      skip: true,
      by: ack.by,
      at,
      /*
       * **THE OPERATOR'S WORDS, VERBATIM AND ALONE.**
       *
       * **THE FIRST DRAFT COMPOSED THIS** — the operator's reason, then which
       * of the two pending states the person is in — and a test written to
       * watch `decide` refuse a blank reason went green instead. **The
       * composition is never blank, so `decide`'s check could not fail, and the
       * rule this function's own comment says it delegates was not being
       * asked.** A guard whose written reason does not match its behaviour is
       * the next round's false confidence, and this file already carries that
       * sentence about somebody else's code.
       *
       * So the two facts stay apart, which is what they are: **`reason` is what
       * a person said, and `RunSkips.people[index].waiting` is what the system
       * measured.** They travel together by construction — the index and the
       * list are one field, at one index — so a report has both without either
       * being able to defeat a check on the other.
       */
      reason: ack.reason,
    });
  });
  return { people, decisions };
};

/**
 * **WHAT AN ADMIN HAS TO SAY TO DRAW UP A RUN THAT REPEATS ANOTHER.**
 *
 * The shape the roster door uses for people left out of a run, applied to runs
 * repeated: refused by default, the refusal names what it found, and a person
 * proceeds only by naming that same set back, with a reason, under their own
 * name. The names are compared in both directions. A repeated run the admin did
 * not name is one they have not read about; a run they named that is not
 * repeated means the list they read has moved, and their agreement is about a
 * different payroll.
 *
 * **WHY A REPEAT IS REFUSED AT ALL.** Every run derives its own per-payee
 * payment secrets from its own id, so two runs over the same people are, to the
 * account, two unrelated sets of payments, and both can be paid. For a bonus or
 * a second invoice that is exactly right. For somebody whose first run failed
 * and who does not know whether it reached the chain, it is everybody paid
 * twice - and the way to try again is not a new run at all.
 */
export interface RepeatAcknowledgement {
  /** The same set as the runs this one repeats. Compared as a set. */
  runIds: string[];
  /**
   * **WHO THIS RUN PAYS A SECOND TIME FOR THE MONTH, AS A NUMBERED EXTRA**, by
   * roster entry. Each is paid as the next occurrence for that month, which the
   * account records apart from the first payment; everybody else on the run is
   * paid as the first, which the account refuses for anybody it has already
   * paid. Absent means nobody is paid an extra.
   */
  extra?: string[];
  /**
   * Who is accepting it. Where there is a signed-in caller the served routes
   * take this from the signed-in caller and never from the request body.
   */
  by: string;
  /** Why, in their words. A blank reason is refused. */
  reason: string;
  /**
   * How many of the chain's completed payments this company's records cannot
   * account for, as the person confirming it read them. Taken only at the
   * roster door; absent means none.
   */
  chainPayments?: number;
}

export interface RepeatedRun {
  run: PayrollRun;
  state: 'on chain' | 'raised, not confirmed by the chain' | 'withdrawn' | 'drawn up, not raised';
}

/** A period's month, or the period as written when it names none. */
export const canonicalOrAsWritten = (period: string): string => {
  try {
    return canonicalPeriod(period);
  } catch {
    return period;
  }
};

export const samePeriod = (a: string, b: string): boolean =>
  canonicalOrAsWritten(a) === canonicalOrAsWritten(b);

/**
 * **WHAT A RUN PAYS, AS ONE COMPARABLE VALUE.** Names, currencies and amounts,
 * in any order: a run is a repeat of another by what it pays, not by how its
 * list happens to be sorted.
 */
export const contentOf = (people: Array<{ name: string; asset: AssetId; amount: bigint }>): string =>
  JSON.stringify(people.map((p): [string, string, string] => [p.name, p.asset, String(p.amount)]).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1
      : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));

export const repeatRefusal = (period: string, found: RepeatedRun[]): string =>
  `this run pays the same people the same amounts for ${period} as `
  + `${found.map(f => `run ${f.run.id} (${f.state})`).join(', ')}. The chain refuses a second salary `
  + `payment to the same roster entry for ${period}, unless it is raised as a numbered extra, so `
  + 'whichever run pays first is paid and the other collects approvals and a fee for payments the chain '
  + 'will refuse. Somebody on the roster twice can still be paid twice. If an earlier run failed and it is '
  + 'not known whether it reached the chain, do not draw it up again. Raise that run again unchanged '
  + 'instead - it keeps its people\'s payment secrets, so nobody on it can be paid twice, and a '
  + 'round of it that may already be on chain is asked about rather than opened again - or raise a '
  + 'retry on it for the people it did not reach. '
  + `If this really is a second payment, confirm it by naming ${found.map(f => f.run.id).join(', ')} `
  + 'back with a reason, and name the people it pays again as a numbered extra.';

/**
 * **THE CONFIRMATION FOR A REPEATED RUN, CHECKED, OR THE REFUSAL.** Returns the
 * record to keep on the run, or nothing when the run repeats nothing.
 */
export const acknowledgedRepeats = (
  period: string, found: RepeatedRun[], ack: RepeatAcknowledgement | undefined, at: string,
): RunRepeatRecord | undefined => {
  if (!ack) {
    if (found.length) throw new Error(repeatRefusal(period, found));
    return undefined;
  }
  const named = new Set(ack.runIds);
  const unnamed = found.filter(f => !named.has(f.run.id));
  if (unnamed.length) {
    throw new Error(
      `this run also repeats ${unnamed.map(f => `run ${f.run.id} (${f.state})`).join(', ')}, which `
      + 'is not in what was confirmed. A repeat is confirmed by naming every run it repeats, so '
      + 'read the list again and confirm the whole of it.');
  }
  const repeating = new Set(found.map(f => f.run.id));
  const notRepeated = [...named].filter(id => !repeating.has(id));
  if (notRepeated.length) {
    throw new Error(
      `${notRepeated.join(', ')} ${notRepeated.length === 1 ? 'was' : 'were'} confirmed as repeated `
      + `and this run does not repeat ${notRepeated.length === 1 ? 'it' : 'them'}, so the list that was `
      + 'read is not the list this run would act on. Take the confirmation again against what this '
      + 'run actually repeats.');
  }
  if (found.length === 0) return undefined;
  if (!ack.by.trim()) throw new Error('a repeated payroll has to be attributable to somebody');
  if (!ack.reason.trim()) {
    throw new Error('say why this run repeats another; a blank reason is not a record');
  }
  return { of: [...repeating].sort(), reason: ack.reason, by: ack.by, at };
};

/**
 * Where a person on a run is paid, as their roster entry has it: null for
 * somebody with no entry, and a refusal when the entry beside them on the run
 * is somebody else's.
 */
export const paidToOf = (
  spec: EmployeeSpec, existing?: RosterEmployee,
): string | null => {
  if (!existing) return null;
  if (existing.name !== spec.name) {
    throw new Error(
      `the roster entry beside ${spec.name} on this run is ${existing.name}. `
      + 'Refusing rather than printing one payee\'s address on another\'s payslip.');
  }
  return existing.address?.bech32 ?? null;
};

/**
 * One receipt, sealed under a fresh key wrapped to the payee's public key.
 * `paid` absent writes the stand-in: the same fields at the same lengths, so a
 * slip whose leg has not been raised is not told apart from one whose has. A
 * leg raised at a company with no address, and a window not known, are
 * written at the same lengths as the values they stand in for, for the same
 * reason.
 *
 * **IT CARRIES THE PAYEE'S OWN NONCE AND BLINDING, AND NOTHING THAT LETS ITS
 * HOLDER RECORD OR MOVE A PAYMENT.** From those, the address the payee's own
 * wallet confirms, and the slip's token and amount, the payee's device builds
 * the payment's leaf with the contract's own circuits and looks for its record.
 * Recording a payment as made, or paying it, also needs the run's salt and
 * the payee's merkle path, and neither is ever written here.
 */
export function sealReceipt(
  runId: string, publicKey: Hex, company: string | null,
  paid: { nonce: Hex; blinding: Hex; until: bigint | null } | null,
  /** The company's label: which company the account the payment is read at belongs to. */
  label: string | null,
): NonNullable<PayrollRun['payslips'][number]['receipt']> {
  const key = newSymmetricKey();
  const sealed = seal(canonical({
    runId,
    nonce: paid ? paid.nonce.toLowerCase() : NO_LEAF,
    blinding: paid ? paid.blinding.toLowerCase() : NO_LEAF,
    company: company === null ? NO_COMPANY : company.toLowerCase(),
    label: label === null ? NO_LABEL : label,
    until: untilText(paid ? paid.until : null),
  }), key);
  return { wrapped: wrapKey(key, publicKey), sealed };
}

/**
 * **WHO A RUN DRAWN FROM THE ROSTER PAYS, AND WHO IT LEAVES OUT ON THE
 * RECORD.** `all` is the company's people; `employeeIds` the subset chosen,
 * when one is; `skipPending` the confirmation, by name and with a reason, of
 * everybody it would leave out; `isWaitingOnUs` whether a pending person's
 * handover waits on an admin rather than on them. Refused, naming them, when
 * anybody would be left out who is not in the confirmation, when the
 * confirmation names anybody who is not, and when nobody is left to pay.
 */
export function peopleDrawn(
  all: readonly RosterEmployee[], employeeIds: readonly string[] | undefined,
  skipPending: SkipAcknowledgement | undefined, isWaitingOnUs: (e: RosterEmployee) => boolean,
): { readonly roster: RosterEmployee[]; readonly leftOut?: RunSkip[] } {
  const asked = all.filter(e => !employeeIds || employeeIds.includes(e.id));
  /*
   * **AND WHOEVER THE SUBSET LEAVES OUT IS LEFT OUT ON THE RECORD.** Somebody
   * active on the roster whom the admin did not name is not paid by this run,
   * and a month from now the record has to say who was not paid and who
   * decided that, exactly as it does for somebody pending. So they join the
   * confirmation below, named, and the record, marked as not chosen.
   */
  const notChosen = employeeIds
    ? all.filter(e => e.status === 'active' && !employeeIds.includes(e.id))
    : [];

  // Pre-flight. Refusing by default is still the right call: silently
  // escrowing someone's salary data because they have not set up yet is worse
  // than a delay. What an admin gets now is a way to say they have read it.
  /*
   * TWO PENDING STATES, NAMED SEPARATELY: "outstanding" that covers two
   * different situations is how an operator stops looking. Somebody who has
   * handed nothing over is waiting on THEM; somebody whose drop box is full
   * is waiting on US.
   */
  const pending = asked.filter(e => e.status === 'pending');
  /*
   * **THE PEOPLE, NOT THE INDEX.** The index is minted in `createRun`,
   * because a register names the run it belongs to (`run-skips.ts`,
   * `emptyRegister`) and the run has no id until it is built. **A stand-in id
   * was considered and refused**: `registerFor` exists to refuse a register
   * raised for a different run, and an id this method invented is a value
   * that comparison could never be right about.
   */
  let leftOut: RunSkip[] | undefined;
  if (pending.length || notChosen.length) {
    const waitingOnUs = pending.filter(e => isWaitingOnUs(e));
    const waitingOnThem = pending.filter(e => !isWaitingOnUs(e));
    const parts: string[] = [];
    if (notChosen.length) {
      parts.push(
        `${notChosen.map(e => e.name).join(', ')} `
        + `${notChosen.length === 1 ? 'is' : 'are'} on the roster and not among the people chosen for this run`);
    }
    if (waitingOnThem.length) {
      parts.push(
        `${waitingOnThem.map(e => e.name).join(', ')} `
        + `${waitingOnThem.length === 1 ? 'has' : 'have'} not set up yet`);
    }
    if (waitingOnUs.length) {
      parts.push(
        `${waitingOnUs.map(e => e.name).join(', ')} `
        + `${waitingOnUs.length === 1 ? 'is' : 'are'} waiting to be admitted by an admin`);
    }
    const named = parts.join('; ');

    /*
     * **THE DEFAULT REFUSES. THAT IS THE PROPERTY, NOT THE ERGONOMICS.**
     *
     * Everything below this line — the acknowledgement, the name comparison,
     * the record — exists so that an admin can proceed DELIBERATELY. Nothing
     * exists so that a run can proceed by itself. A caller that passes
     * nothing is refused, which is every caller that existed before this
     * round and every caller that forgets.
     */
    if (!skipPending) {
      throw new Error(
        `payroll cannot run without leaving somebody out: ${named}. `
        + (pending.length && notChosen.length
          ? 'Admit the people waiting, or add the others to this run, and run again. '
          : pending.length ? 'Admit them and run again. ' : 'Add them to this run and run again. ')
        + 'Or confirm this run goes ahead without them. That needs their names, yours and a reason, '
        + 'so that a month from now the record says who this run did not pay and who decided that.');
    }

    /*
     * **THE ACKNOWLEDGEMENT IS ABOUT THESE PEOPLE OR IT IS ABOUT NOBODY.**
     *
     * Both directions are refused and they are different failures. A pending
     * person the admin did NOT name is somebody dropped without being read —
     * the exact thing the old wall was there to stop, arriving through the
     * way this change opens. A name the admin DID give who is not being
     * skipped means the list they were shown has moved since they read it:
     * somebody was admitted, withdrawn, or the run is over a different subset.
     * **In that case their agreement is about a different payroll, and
     * treating it as agreement to this one is putting words in their mouth.**
     */
    const acknowledged = new Set(skipPending.employeeIds);
    const unnamed = [...pending, ...notChosen].filter(e => !acknowledged.has(e.id));
    const wouldSkip = new Set([...pending, ...notChosen].map(e => e.id));
    const notSkipped = skipPending.employeeIds.filter(id => !wouldSkip.has(id));
    if (unnamed.length) {
      throw new Error(
        `this run would also leave out ${unnamed.map(e => e.name).join(', ')}, `
        + 'who is not in what was confirmed. Nobody a run is drawn over is left out of it '
        + 'without being named, so read the list again and confirm the whole of it, or '
        + 'admit them.');
    }
    if (notSkipped.length) {
      throw new Error(
        `${notSkipped.length === 1 ? 'one of the people' : 'some of the people'} confirmed as `
        + 'being left out is not being left out by this run, so the list that was read is not '
        + `the list this run would act on: ${named}. Take the confirmation again against `
        + 'what this run actually skips.');
    }

    /*
     * **WHICH HALF EACH PERSON IS IN, DECIDED ONCE, HERE.** The refusal
     * sentence above and the record below are two renderings of this one
     * partition. Asking `inbox` a second time to build the record would be a
     * second split that could disagree with the first — and the way it would
     * disagree is that somebody's report says an admin is holding them up
     * when nobody is.
     */
    leftOut = [
      ...pending.map((e): RunSkip => ({
        employeeId: e.id,
        name: e.name,
        waiting: waitingOnUs.some(u => u.id === e.id) ? 'us' : 'them',
      })),
      ...notChosen.map((e): RunSkip => ({ employeeId: e.id, name: e.name, waiting: 'not chosen' })),
    ];
  }

  const roster = asked.filter(e => e.status === 'active');
  if (roster.length === 0) {
    throw new Error(leftOut
      ? 'there is nobody left to pay: everybody this run was drawn over is still pending, so '
        + 'confirming that they are left out leaves the run empty. Admit somebody first.'
      : 'no active employees to pay');
  }
  /*
   * **EVERY PAYEE'S ADDRESS IS ONE A RUN CAN PAY, ASKED HERE AS WELL AS AT
   * THE MONEY.** `paymentFactsFor` is the line nothing reaches the chain
   * without. This one is earlier and is for the person: a run refused at the
   * moment it is drawn names the roster entry and costs nothing.
   *
   * **THE SAME FUNCTION, NOT A SECOND COPY OF THE SENTENCE.**
   */
  for (const e of roster) {
    if (e.address) payrollPayee(e.name, e.address);
  }
  return { roster, ...(leftOut ? { leftOut } : {}) };
}

/**
 * **A RUN FOR THIS PERIOD THAT HAS ALREADY BEEN RAISED REFUSES ANOTHER**, unless
 * the new one is a confirmed repeat.
 */
export function refuseAPeriodAlreadyRaised(period: string, runs: ReadonlyArray<{ readonly period: string; readonly status: string }>): void {
  if (!runs.some(r => samePeriod(r.period, period) && r.status !== 'draft')) return;
    /*
     * **AND IT NAMES WHAT TO DO INSTEAD, BECAUSE OF WHO READS IT.** This is
     * the refusal a person meets when they type the month again after a raise
     * they did not get an answer to, and the answer they need is that the run
     * they are trying to recreate is the one to raise again.
     */
    throw new Error(
      `a run for ${period} already exists. If that is the run you meant and its raise failed, `
      + 'raise that run again unchanged rather than drawing this payroll up a second time: it '
      + 'keeps its people\'s payment secrets, so raising it again cannot pay anybody twice. If '
      + 'some of the people on it were not reached, raise a retry on it for them.');
}

/**
 * **A DRAFT RUN FOR THIS PERIOD THAT A RAISE HAS ALREADY BEEN ATTEMPTED FOR.**
 * Refused at the roster door, which draws up one run per period, because
 * drawing it up again opens a second round over people the first may pay.
 */
export function refuseAPayrollThatMayBeOnChain(
  period: string, runs: ReadonlyArray<{ readonly id: string; readonly period: string }>, rounds: readonly PayrollRound[],
): void {
  const live = rounds.filter(isLiveRound);
  const raised = runs
    .filter(r => samePeriod(r.period, period) && live.some(x => x.runId === r.id));
  if (raised.length === 0) return;
  const seen = raised.some(r => live.some(x => x.runId === r.id && x.raisedAt));
  throw new Error(
    `a run for ${period} already exists and a round has been raised for it: `
    + `${raised.map(r => r.id).join(', ')}. `
    + (seen
      ? 'The chain has been seen to hold that round. '
      : 'The chain has not been seen to hold it, which is not the same as it not being there: a '
        + 'raise can fail after the network already has it. ')
    + 'A new run would open a second round for the same people. The chain refuses a second '
    + `salary payment to the same roster entry for ${period}, but only after that round has `
    + 'collected approvals and a fee. Raise that run again unchanged instead. The chain is asked '
    + 'first, so it cannot open a second round. If some people on it are not paid by the time '
    + 'its window closes, raise a retry on it for them.');
}

/**
 * **WHAT ONE PERSON IS PAID ON A RUN DRAWN FOR `period`**, worked out here and
 * nowhere else: every run drawn on a device takes each person's amount from
 * this. Today it is the person's base amount for any month. Pay for part of a
 * month, or a bonus as a pay item of its own, is worked out here too, from the
 * person and the month, so nothing that draws a run changes when it is.
 */
export const amountOnTheRun = (person: Pick<RosterEmployee, 'baseAmount'>, _period: string): bigint => person.baseAmount;

/**
 * **EVERY PERSON ON A RUN, AND THEIR PAYSLIP, AS THE RUN IS DRAWN.** One entry
 * per spec, in order, each sealed to the payslip key the person's roster entry
 * carries. `roster[i]` is the roster entry beside `specs[i]`; a spec with none
 * is paid only through `mint`, which names them and makes a payslip key for
 * them, handing its secret back once; a run drawn without `mint` refuses one.
 */
export function peopleOnTheRun(input: {
  readonly runId: string; readonly period: string; readonly specs: readonly EmployeeSpec[];
  readonly roster?: readonly RosterEmployee[]; readonly assets: AssetRegistry;
  readonly company: { readonly account: string | null; readonly label: CompanyLabel | null };
  readonly mint?: () => { readonly id: string; readonly publicKey: Hex; readonly secret: Hex };
}): { employees: Employee[]; payslips: PayrollRun['payslips']; secrets: Array<{ employeeId: string; name: string; wrappingSecret: Hex }> } {
  const { runId, period, specs, roster, assets, company, mint } = input;
  const employees: Employee[] = [];
  const secrets: Array<{ employeeId: string; name: string; wrappingSecret: Hex }> = [];
  const payslips: PayrollRun['payslips'] = [];
  specs.forEach((spec, i) => {
    if (typeof spec.amount !== 'bigint') {
      throw new Error(`amount for ${spec.name} must be a bigint in minor units`);
    }
    if (spec.amount <= 0n) throw new Error(`amount for ${spec.name} must be positive`);
    assets.require(spec.asset);

    // A person on the roster keeps the same identity and key across every run.
    // Only an ad hoc run mints a new one, and then the secret is returned once.
    const existing = roster?.[i];
    /*
     * JOINED THROUGH THE RECORD, NOT THROUGH THE INDEX. `roster?.[i]` was
     * read a second time further down for `paidTo`, and changing it to
     * `roster?.[0]` left 145 tests green — on a hundred-person run that
     * prints one person's address on every payslip, which is the single field
     * a payee is told to check. One read, one variable.
     */
    if (!existing && mint === undefined) {
      throw new Error(`${spec.name} is not on the company's roster, so this run cannot pay them: a run drawn here pays only the people the roster names.`);
    }
    const minted = existing ? null : mint!();
    const id = existing?.id ?? minted!.id;
    let publicKey: string;
    if (existing) {
      if (!existing.wrappingPublicKey) throw new Error(`${existing.name} has no key yet`);
      publicKey = existing.wrappingPublicKey;
    } else {
      /*
       * **THE ONE PLACE LEFT THAT MINTS A PAYSLIP KEY.**
       *
       * An ad hoc run pays somebody who is not on the roster, so there is no
       * handover, no wallet and nothing to derive from — `payslipKeypairFrom`
       * would have nothing to expand. So this stays random, the secret is
       * returned once, and `words` is absent to say so in the type.
       *
       * **IT IS NOT A GAP LEFT OPEN BY OVERSIGHT.** Closing it means an ad
       * hoc payee handing over a public key first, which is an onboarding
       * flow and not a derivation — reported rather than smuggled in. Until
       * then, an ad hoc payslip is exactly the hazard described above.
       */
      publicKey = minted!.publicKey;
      secrets.push({ employeeId: id, name: spec.name, wrappingSecret: minted!.secret });
    }

    /*
     * **WHERE THIS PERSON IS PAID, AS THEIR PAYSLIP SAYS, KEPT BESIDE THEM ON
     * THE RUN.** The payslip is sealed to the payee and nobody else can open
     * it, so this is the only copy the company can compare with the roster
     * when the run is raised: a raise pays the roster's address, and the
     * payslip is how the payee checks it.
     */
    const paidTo = paidToOf(spec, existing);
    /*
     * **THE FORM THIS PERSON IS PAID IN, SETTLED BY THEIR ADDRESS.** It
     * decides which leg they are on: one run pays one token in one form, so
     * a payroll with private and public payees is two legs side by side.
     * Somebody with no address yet is put in the token's private form where
     * it has one.
     */
    const form: LedgerForm = existing?.address?.kind
      ?? (ledgerFormOf(assets.require(spec.asset), 'shielded').of === 'token' ? 'shielded' : 'unshielded');
    employees.push({
      id, name: spec.name, wrappingPublicKey: publicKey,
      asset: spec.asset, amount: spec.amount, form,
      ...(paidTo ? { paidTo } : {}),
    });

    // Two layers: seal the slip under a fresh key, wrap that key to the employee.
    /*
     * THE PAYSLIP CARRIES THE ADDRESS OF RECORD.
     *
     * The employee cannot read the company's roster — they hold no viewing
     * key, and must not. So the only way they can ever check that the address
     * the company holds for them is the one they handed over is for it to
     * come back to them **sealed to their own key**, which is what a payslip
     * already is.
     *
     * **AND HERE IS WHAT IT DOES NOT DO, because the first version of this
     * comment claimed otherwise and was wrong.** The payslip is sealed to the
     * payee's wrapping key — **which arrives in the SAME handover, in the same
     * drop box, as the address.** So whoever supplied the address supplied the
     * key that opens the slip reporting it: an impostor reads their own
     * address back, and the real employee gets "that key cannot open this
     * payslip". It is a mirror in the honest case and useless in the attack it
     * was written for.
     *
     * It is kept because it is the right field in the right place — what a
     * payee was paid to belongs on their payslip — and because it becomes a
     * real check the moment the two halves stop travelling together. **It is
     * not a defence today and must not be counted as one.**
     */
    /*
     * **THE COMPANY THE PAYEE ASKS THEIR WALLET ABOUT, WRITTEN ON THE SLIP.**
     * A roster payee's key was worked out from one company's label, and
     * that is the label that opens this slip for as long as it exists,
     * whatever account the company has. An ad hoc payee's key was minted
     * above and no company produces it, so there is none to name.
     *
     * **IT IS SEALED INSIDE THE SLIP AS WELL AS WRITTEN BESIDE IT.** The copy
     * beside it is what the slip is filed and found by; the sealed one is
     * what the payee's page believes, so a copy changed in the store names
     * an address the page then refuses rather than one it shows.
     */
    const issuedBy = existing
      ? (existing.payslipKeyFrom ?? company.label)
      : null;
    const slipKey = newSymmetricKey();
    const slip = seal(canonical({
      employeeId: id, name: spec.name, asset: spec.asset, amount: spec.amount, period,
      paidTo,
      issuedBy: issuedBy === null ? null : issuedBy.toLowerCase(),
    }), slipKey);
    payslips.push({
      employeeId: id, wrapped: wrapKey(slipKey, publicKey), slip, issuedBy,
      /* The public key it is wrapped to, which is what its payee asks by. */
      sealedTo: publicKey.toLowerCase(),
      /* A stand-in until the payee's leg is raised; see `withReceipts`. */
      receipt: sealReceipt(runId, publicKey, company.account, null,
        company.label),
    });
  });
  return { employees, payslips, secrets };
}

/**
 * **A NUMBERED EXTRA: A REAL SECOND PAYMENT TO A PERSON FOR A MONTH, SAID SO
 * AND NUMBERED.** The account refuses a second payment carrying a nonce it has
 * recorded, and a nonce is derived from the person, the month, the kind of pay
 * and the occurrence. So a correction, a top-up or back pay for a month
 * already part-paid is paid as the next occurrence: 1, then 2. It is only ever
 * part of a confirmed repeat, whose reason is the extra's reason, and each
 * person it names must be on the run.
 *
 * **THE OCCURRENCE IS ONE PAST THE HIGHEST ANY RUN FOR THE MONTH GAVE THAT
 * PERSON**, drafts included: a run drawn over somebody used their first
 * payment whether or not it was paid, and giving two runs the same extra would
 * make the second one's payment the one the account refuses.
 */
export function withNumberedExtras(
  period: string, employees: readonly Employee[], repeated: RunRepeatRecord | undefined, named: readonly string[],
  earlierRuns: readonly PayrollRun[], nameOf: (id: string) => string | null,
): RunRepeatRecord | undefined {
  if (named.length === 0) return repeated;
  if (!repeated) {
    throw new Error(
      `a numbered extra is a second payment for ${period}, and this run repeats no run for that `
      + 'month. Draw it as a repeat that names the runs for the month and says why, and name the '
      + 'people it pays again. No screen takes that confirmation yet.');
  }
  const onRun = new Map(employees.map(e => [e.id, e]));
  const strangers = [...new Set(named)].filter(id => !onRun.has(id));
  if (strangers.length) {
    const who = strangers.map(id => nameOf(id) ?? id);
    throw new Error(
      `${who.join(', ')} ${strangers.length === 1 ? 'is' : 'are'} named for a numbered extra `
      + 'and not on this run. Only somebody this run pays can be paid an extra by it.');
  }
  const earlier = earlierRuns.filter(r => samePeriod(r.period, period));
  const extra: Record<string, number> = {};
  for (const id of [...new Set(named)].sort()) {
    const used = earlier
      .filter(r => r.employees.some(e => e.id === id))
      .map(r => r.repeats?.extra?.[id] ?? 0);
    extra[id] = (used.length ? Math.max(...used) : 0) + 1;
  }
  return { ...repeated, extra };
}

/**
 * **EVERY RUN FOR THIS PERIOD THAT PAYS THE SAME PEOPLE THE SAME AMOUNTS,
 * AND HOW FAR EACH ONE GOT.**
 *
 * The same people means the same names in the same currencies for the same
 * amounts, in any order. Every run is counted, drafts and withdrawn ones
 * included, because a draft can be raised at any moment and a withdrawn
 * round's run can be raised again; what differs is the sentence a person
 * reads about it.
 */
export function runsRepeatingIn(
  runs: readonly PayrollRun[], rounds: readonly PayrollRound[], period: string, content: string, excluding?: string,
): RepeatedRun[] {
  return runs
    .filter(r => samePeriod(r.period, period) && r.id !== excluding)
    .filter(r => contentOf(r.employees) === content)
    .map(r => {
      const mine = rounds.filter(x => x.runId === r.id);
      const live = mine.filter(isLiveRound);
      const state: RepeatedRun['state'] = live.some(x => x.raisedAt) ? 'on chain'
        : live.length ? 'raised, not confirmed by the chain'
        : mine.some(x => x.status === 'cancelled') ? 'withdrawn'
        : 'drawn up, not raised';
      return { run: r, state };
    });
}

/**
 * **THE RUN AS DRAWN**: its people and payslips, a subtotal per asset, no leg
 * raised yet, and the record of who it leaves out and what it repeats.
 */
export const assembledRun = (input: {
  readonly runId: string; readonly accountId: string; readonly period: string;
  readonly employees: Employee[]; readonly payslips: PayrollRun['payslips'];
  readonly skips?: RunSkips; readonly repeats?: RunRepeatRecord;
}): PayrollRun => ({
  id: input.runId,
  accountId: input.accountId,
  period: input.period,
  employees: input.employees,
  payslips: input.payslips,
  /*
   * A SUBTOTAL PER ASSET, never one total.
   *
   * Adding 5,000 GBP to 5,000 USDC and displaying 10,000 is not an
   * approximation, it is meaningless — and the sufficiency check that used
   * that figure would have passed or failed for reasons unrelated to
   * whether the account can pay anybody.
   */
  totals: subtotals(input.employees.map(e => ({ asset: e.asset, amount: e.amount }))),
  proposalIds: {},
  status: 'draft',
  ...(input.skips ? { skips: input.skips } : {}),
  ...(input.repeats ? { repeats: input.repeats } : {}),
});
