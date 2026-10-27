/**
 * **A PAYROLL RUN DRAWN ON THIS SIGNER'S DEVICE, OVER ONE OF THE COMPANY'S
 * LISTS, FROM ITS OWN RECORDS, AND FILED SEALED AND SIGNED.**
 *
 * A run pays one list: the employees (`readPeopleHere`), or the vendors paid by
 * monthly terms (`readVendorsHere`), and names it inside its seal. The payees are
 * the ones this device believes: one whose record was filed by a seat it does
 * not believe is not drawn over, and an active one who is not payable at what
 * their own wallet signed, or a vendor at the address they were added by,
 * refuses the draw by name (`whyNotPayable`, `whyVendorNotPayable`). One whose
 * dates leave out every day of the month is set aside with that reason
 * (`outsideTheirDates`) and nobody is asked to confirm it; an employee is paid
 * the salary line in force at the month's end (`amountOnTheRun`), a vendor their
 * monthly terms (`vendorAmountOnTheRun`). Who the run pays and leaves out, what
 * it repeats and every payslip are made by the rules the service's own draw uses
 * (`run-drawing.ts`), each payslip sealed to the payslip key the payee's signed
 * code names; a vendor added by address who has not claimed their place is paid
 * with no payslip. Nothing is minted for anybody: a run drawn here pays only
 * people on its list.
 *
 * The run is sealed under the company's key in force and signed with this
 * seat's filing key; the service keeps it only for a seat its directory
 * believes may file a run, and opens none of it.
 */
import { keyOf, sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { randomBytes, type Hex } from '../../../src/core/crypto.js';
import { assets as theAssets, type AssetRegistry } from '../../../src/core/assets.js';
import { isLiveRound } from '../../../src/core/retry-cover.js';
import type { PayrollRound } from '../../../src/core/account.js';
import type { PayrollRun, RunList, RunRepeatRecord, RunSkip, SealedProposal } from '../../../src/core/types.js';
import { datesOfTheRecordRefusal, earliestStopOf, outsideTheirDates } from '../../../src/core/payable-days.js';
import { canonicalPeriod, openSealedRun, runsOfList, sealedRunOf } from '../../../src/core/run-legs.js';
import {
  amountOnTheRun, assembledRun, peopleDrawn, peopleOnTheRun, recordSkipsEach, refuseAPayrollThatMayBeOnChain,
  refuseAPeriodAlreadyRaised, samePeriod, withNumberedExtras,
} from '../../../src/core/run-drawing.js';
import { vendorAmountOnTheRun, type VendorRecord } from '../../../src/core/vendor-record.js';
import { signRunFiling } from '../../../src/core/run-filing.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  payeesHere, payrollRoundsHere, proposalsListedHere, runsListedHere, twoEntriesAtOneAddress, type CompanyRecordsHere, type ListPayee, type PayeesHere,
} from './run-rebuilt-here.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** What drawing a run on this device needs. */
export interface RunDrawDoors {
  readonly api: Api;
  readonly accountId: string;
  readonly viewingKey: KeysHeld;
  /** The key epoch a bare key seals under; the company's keys seal at the epoch in force. */
  readonly keyEpoch: number;
  /** This seat's filing key: the one its directory entry names. */
  readonly signingSecret: Hex;
  /** The company's account on the chain and its label, as its record names them: what each payslip names. */
  readonly company: { readonly account: string | null; readonly label: CompanyLabel | null };
  /** The company's records, read afresh: its people and its vendors as this device believes them, its runs and its proposals. */
  readonly records: Pick<CompanyRecordsHere, 'people' | 'vendors' | 'runs' | 'directory' | 'roundsOnChain' | 'roundIdentity'> & { readonly proposals: () => Promise<readonly SealedProposal[]> };
  /** Who is confirming what the run leaves out or repeats: the signed-in person's name. */
  readonly by: string;
  readonly registry?: AssetRegistry;
  readonly now?: () => string;
  /** The one filing call, bound to this company and this seat: the run drawn here is entered in the company's records. */
  readonly entered: RecordsEntered;
}

/** What the person drawing the run asked for. */
interface RunAsked {
  readonly period: string;
  /** The list the run pays: the employees (when absent), or the vendors paid monthly. */
  readonly list?: RunList;
  /** The people chosen, when not everybody is. */
  readonly employeeIds?: readonly string[];
  /** Everybody the run would leave out, named, and why. */
  readonly skipPending?: { readonly employeeIds: readonly string[]; readonly reason: string };
  /** Every run for the month already raised, named, and why this one pays again; who it pays as a numbered extra. */
  readonly repeats?: { readonly runIds: readonly string[]; readonly reason: string; readonly extra?: readonly string[] };
}

/** Why a run was not drawn on this device. Nothing was filed. */
export class RunNotDrawnHere extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'RunNotDrawnHere';
  }
}

const RUN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
/** A new run's name: `run_` and twelve characters this device drew at random. */
const newRunId = (random: (n: number) => Uint8Array = randomBytes): string =>
  `run_${Array.from(random(12), (b) => RUN_ALPHABET[b & 63]).join('')}`;

/**
 * **A REPEAT, CONFIRMED BY NAMING EVERY RUN FOR THE MONTH THAT HAS BEEN RAISED**
 * - one not drafted only, or one whose round may be live - and nothing else,
 * with who confirmed it and why. The rounds and payments the chain holds that
 * the records cannot account for are not named here: a device names only the
 * runs the records hold. A leg is raised from a device only while the chain
 * holds nothing beyond them, and the raise says so when it does.
 */
const confirmedRepeatHere = (
  period: string, runs: readonly PayrollRun[], rounds: readonly PayrollRound[],
  ack: NonNullable<RunAsked['repeats']>, by: string, at: string,
): RunRepeatRecord | undefined => {
  const live = rounds.filter(isLiveRound);
  const expected = new Set(runs
    .filter((r) => samePeriod(r.period, period) && (r.status !== 'draft' || live.some((x) => x.runId === r.id)))
    .map((r) => r.id));
  const named = new Set(ack.runIds);
  const unnamed = [...expected].filter((id) => !named.has(id));
  if (unnamed.length) {
    const describe = (id: string): string => {
      const r = runs.find((x) => x.id === id)!;
      return `the ${r.status === 'draft' ? 'draft' : 'raised'} run for ${r.period} (${r.employees.length} ${r.employees.length === 1 ? 'person' : 'people'})`;
    };
    throw new RunNotDrawnHere(`this confirmation leaves out ${unnamed.map(describe).join(', ')}. A repeat is confirmed by naming every run `
      + `for ${period} that has been raised. Name all of them and confirm again.`);
  }
  const extra = [...named].filter((id) => !expected.has(id));
  if (extra.length) {
    throw new RunNotDrawnHere(`${extra.join(', ')} ${extra.length === 1 ? 'was' : 'were'} confirmed as repeated and this run `
      + `does not repeat ${extra.length === 1 ? 'it' : 'them'}, so the list that was read is not the list this run would act `
      + 'on. Take the confirmation again against what this run actually repeats.');
  }
  if (expected.size === 0) return undefined;
  if (!by.trim()) throw new RunNotDrawnHere('a repeated payroll has to be attributable to somebody.');
  if (!ack.reason.trim()) throw new RunNotDrawnHere('say why this run repeats another; a blank reason is not a record.');
  return { of: [...expected].sort(), reason: ack.reason, by, at };
};

/** Refusals of the shared rules come back as this device's refusal, with nothing filed. */
const drawn = <T>(make: () => T): T => {
  try {
    return make();
  } catch (e) {
    if (e instanceof RunNotDrawnHere) throw e;
    throw new RunNotDrawnHere(`${(e as Error)?.message ?? String(e)}.`.replace(/\.\.$/u, '.'));
  }
};

/**
 * **WHO THE LIST'S PEOPLE ARE FOR `period`, AS THIS DEVICE BELIEVES THEM**, or a refusal
 * naming who would be paid at what their own wallet did not sign, or whose
 * record this device does not believe at all, or whose dates are not calendar
 * dates in order. Anybody whose dates leave out every day of the period is set
 * aside in `datedOut`, with why, before either refusal or any choice of who the
 * run pays is read. A leaver is paid for the days their dates give, as anybody
 * active is; one with no leaving or end date is set aside with why, and one who
 * never had an address was never paid and is not named.
 */
const peopleToDrawOver = (
  here: PayeesHere & { readonly refused?: readonly { readonly id: string; readonly why: string }[] }, asked: RunAsked, period: string,
): { all: ListPayee[]; handedOver: Set<string>; datedOut: { person: RunSkip; reason: string }[] } => {
  const chosen = (id: string) => asked.employeeIds === undefined || asked.employeeIds.includes(id);
  const broken = [...here.people, ...here.notPayable.map((p) => p.here)]
    .filter((p) => p.person.status !== 'leaver' && chosen(p.person.id))
    .map((p) => ({ name: p.person.name, why: datesOfTheRecordRefusal(p.person) }))
    .filter((p) => p.why !== null);
  if (broken.length > 0) {
    throw new RunNotDrawnHere(`${broken.map((p) => `${p.name}: ${p.why}`).join('; ')}. A run is drawn only over records whose dates `
      + 'are calendar dates, in order, so whether they are paid for the month cannot be said. Put their record right, or mark '
      + 'them a leaver, and draw the run again.');
  }
  const datedOut: { person: RunSkip; reason: string }[] = [];
  const setAside = (p: PayeesHere['people'][number], why: string): false => {
    datedOut.push({ person: { employeeId: p.person.id, name: p.person.name, waiting: 'outside their dates' }, reason: `${p.person.name} is not paid for ${period}: ${why}` });
    return false;
  };
  const inTheirDates = (p: PayeesHere['people'][number]): boolean => {
    if (p.person.status === 'leaver') {
      /* A leaver who never had an address was never paid: an invitation withdrawn, drawn over by no run and named by none. */
      if (!p.person.address) return false;
      if (earliestStopOf(p.person) === null) return setAside(p, 'they were made a leaver with no leaving date or end date, so the days they worked are not known');
    }
    const why = outsideTheirDates(p.person, period);
    return why === null ? true : setAside(p, why);
  };
  const people = here.people.filter(inTheirDates);
  const notPayableInDates = here.notPayable.filter((p) => inTheirDates(p.here));
  const notPayable = notPayableInDates.filter((p) => chosen(p.here.person.id));
  if (notPayable.length > 0) {
    throw new RunNotDrawnHere(`${notPayable.map((p) => `${p.here.person.name} cannot be paid: ${p.why}`).join('; ')}. A run pays `
      + 'each person only at the address and payslip key their own wallet signed. Ask them to give their code again, or mark '
      + 'them a leaver, and draw the run again.');
  }
  const unread = here.notBelieved.filter(chosen);
  const unreadable = (here.refused ?? []).filter((r) => chosen(r.id));
  if (unreadable.length > 0) {
    throw new RunNotDrawnHere(`${unreadable.length} of the company's people ${unreadable.length === 1 ? 'has a record' : 'have records'} `
      + `this device cannot read as a person's record (${unreadable.map((r) => r.why).join('; ')}), so it cannot say whether they should be paid. `
      + 'Ask a signer of the company to file their record again, or reload the page.');
  }
  if (unread.length > 0) {
    throw new RunNotDrawnHere(`${unread.length} of the company's people ${unread.length === 1 ? 'has a record' : 'have records'} `
      + 'filed by a seat this device does not believe, so this device cannot say whether they should be paid. Ask a signer of '
      + 'the company to file their record again, or reload the page.');
  }
  /* Somebody not payable and not chosen is still on the roster: leaving them out is named like leaving anybody out. */
  const everybody = [...people, ...notPayableInDates.map((p) => p.here)];
  /* A leaver within their dates is paid for the days before they left, as anybody active is. */
  return {
    all: everybody.map((p) => (p.person.status === 'leaver' ? { ...p.person, status: 'active' as const } : p.person)),
    handedOver: new Set(everybody.filter((p) => p.handedOver).map((p) => p.person.id)),
    datedOut,
  };
};

/**
 * **A VENDOR LIST AS A MONTHLY RUN DRAWS OVER IT**: the vendors paid by monthly terms. A vendor paid by one-off payments
 * is never on a monthly run, so they are neither drawn nor recorded as left out.
 */
const paidMonthly = (here: PayeesHere): PayeesHere => {
  const monthly = (p: { readonly person: ListPayee }) => !('terms' in p.person) || p.person.terms.kind === 'monthly';
  return { ...here, people: here.people.filter(monthly), notPayable: here.notPayable.filter((n) => monthly(n.here)) };
};

/** What one payee is paid on a run for `period`: an employee their salary line in force, a vendor their monthly terms. */
const specOf = (p: ListPayee, period: string) => ('terms' in p
  ? { name: p.name, asset: p.terms.kind === 'monthly' ? p.terms.asset : '', amount: vendorAmountOnTheRun(p, period) }
  : { name: p.name, asset: p.asset, amount: amountOnTheRun(p, period) });

/**
 * **DRAWS A RUN FOR `asked.period` OVER ONE LIST ON THIS DEVICE, AND FILES IT.** Refused,
 * with nothing filed, when anybody it would leave out is not named in the
 * confirmation, when an active person is not payable at what their own wallet
 * signed, when a run for the month on the same list has already been raised and
 * this is not a confirmed repeat, and when nobody is left to pay. Only runs on
 * the same list count: the payroll and a vendor run for one month never refuse
 * each other. Somebody outside their
 * dates is left out and recorded so, signed by `doors.by`. Returns the run as filed.
 */
export async function drawRunHere(doors: RunDrawDoors, asked: RunAsked): Promise<PayrollRun> {
  const period = drawn(() => canonicalPeriod(asked.period));
  const at = (doors.now ?? (() => new Date().toISOString()))();
  const assets = doors.registry ?? theAssets;
  const list: RunList = asked.list ?? 'employees';
  const [read, sealedRuns, proposals] = await Promise.all([
    payeesHere(doors.records, list).catch((e: unknown) => { throw new RunNotDrawnHere(String((e as Error)?.message ?? e).replace(/\s*Nothing was built or sent\.\s*$/u, '')); }),
    runsListedHere(doors.records), proposalsListedHere(doors.records)]);
  const here = list === 'vendors' ? paidMonthly(read) : read;
  const { all, handedOver, datedOut } = peopleToDrawOver(here, asked, period);
  const skip = asked.skipPending === undefined ? undefined
    : { employeeIds: [...asked.skipPending.employeeIds], reason: asked.skipPending.reason, by: doors.by };
  const { roster, leftOut } = drawn(() => peopleDrawn(all, asked.employeeIds, skip, (e) => handedOver.has(e.id)));
  if (list === 'vendors') {
    const twice = twoEntriesAtOneAddress(roster as VendorRecord[]);
    if (twice !== null) throw new RunNotDrawnHere(`${twice}. Mark one of them a leaver, and draw the run again.`);
  }
  const runs = runsOfList(sealedRuns.filter((r) => r.accountId === doors.accountId).map((r) => openSealedRun(r, keyOf(doors.viewingKey, r.keyEpoch))), list);
  const rounds = payrollRoundsHere(proposals, doors.accountId, doors.viewingKey, {
    identity: doors.records.roundIdentity, nowInSeconds: BigInt(Math.floor(Date.parse(at) / 1000)),
  });
  const repeated = asked.repeats === undefined ? undefined
    : confirmedRepeatHere(period, runs, rounds, asked.repeats, doors.by, at);
  if (repeated === undefined) {
    drawn(() => refuseAPeriodAlreadyRaised(period, runs));
    drawn(() => refuseAPayrollThatMayBeOnChain(period, runs, rounds));
  }
  const runId = newRunId();
  const left = [
    ...(leftOut && skip ? leftOut.map((person) => ({ person, by: skip.by, reason: skip.reason })) : []),
    ...datedOut.map((d) => ({ ...d, by: doors.by })),
  ];
  const skips = left.length > 0 ? drawn(() => recordSkipsEach(runId, left, at)) : undefined;
  const { employees, payslips } = drawn(() => peopleOnTheRun({
    runId, period, specs: roster.map((e) => specOf(e, period)), roster, assets,
    company: doors.company,
  }));
  const repeats = drawn(() => withNumberedExtras(period, employees, repeated, [...(asked.repeats?.extra ?? [])], runs,
    (id) => all.find((p) => p.id === id)?.name ?? null));
  const run = assembledRun({
    runId, accountId: doors.accountId, period, employees, payslips,
    ...(skips ? { skips } : {}), ...(repeats ? { repeats } : {}), list,
  });
  const sealing = sealingWith(doors.viewingKey, doors.keyEpoch);
  const filing = signRunFiling(doors.accountId, sealedRunOf(run, sealing.key, sealing.epoch), doors.signingSecret);
  await doors.api(`/api/accounts/${encodeURIComponent(doors.accountId)}/runs`, { method: 'POST', body: JSON.stringify({ run: filing }) });
  await doors.entered.enter([{ store: 'run', run: filing }]);
  return run;
}
