/**
 * **A PAYROLL RUN DRAWN ON THIS SIGNER'S DEVICE, FROM THE COMPANY'S OWN
 * RECORDS, AND FILED SEALED AND SIGNED.**
 *
 * The people are the ones this device believes (`readPeopleHere`): a person
 * whose record was filed by a seat it does not believe is not drawn over, and
 * an active person who is not payable at what their own wallet signed refuses
 * the draw by name (`whyNotPayable`, the one check every reader shares). Who
 * the run pays and leaves out, what it repeats and every payslip are made by
 * the rules the service's own draw uses (`run-drawing.ts`), each payslip sealed
 * to the payslip key the person's signed code names. Nothing is minted for
 * anybody: a run drawn here pays only people on the roster.
 *
 * The run is sealed under the company's viewing key and signed with this
 * seat's filing key; the service keeps it only for a seat its directory
 * believes may file a run, and opens none of it.
 */
import { randomBytes, type Hex } from '../../../src/core/crypto.js';
import { assets as theAssets, type AssetRegistry } from '../../../src/core/assets.js';
import { isLiveRound } from '../../../src/core/retry-cover.js';
import type { PayrollRound } from '../../../src/core/account.js';
import type { PayrollRun, RosterEmployee, RunRepeatRecord, SealedProposal } from '../../../src/core/types.js';
import { canonicalPeriod, openSealedRun, sealedRunOf } from '../../../src/core/run-legs.js';
import {
  assembledRun, peopleDrawn, peopleOnTheRun, recordSkips, refuseAPayrollThatMayBeOnChain, refuseAPeriodAlreadyRaised,
  samePeriod, withNumberedExtras,
} from '../../../src/core/run-drawing.js';
import { signRunFiling } from '../../../src/core/run-filing.js';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import type { PeopleHere } from './people-on-device.js';
import { payrollRoundsHere, type CompanyRecordsHere } from './run-rebuilt-here.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** What drawing a run on this device needs. */
export interface RunDrawDoors {
  readonly api: Api;
  readonly accountId: string;
  readonly viewingKey: Hex;
  /** The key epoch the company seals under now. */
  readonly keyEpoch: number;
  /** This seat's filing key: the one its directory entry names. */
  readonly signingSecret: Hex;
  /** The company's account on the chain and its label, as its record names them: what each payslip names. */
  readonly company: { readonly account: string | null; readonly label: CompanyLabel | null };
  /** The company's records, read afresh: its people as this device believes them, its runs and its proposals. */
  readonly records: Pick<CompanyRecordsHere, 'people' | 'runs'> & { readonly proposals: () => Promise<readonly SealedProposal[]> };
  /** Who is confirming what the run leaves out or repeats: the signed-in person's name. */
  readonly by: string;
  readonly registry?: AssetRegistry;
  readonly now?: () => string;
}

/** What the person drawing the run asked for. */
interface RunAsked {
  readonly period: string;
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

/** The company's payroll rounds, as its proposals record them, opened here. */

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
    throw new RunNotDrawnHere(`this confirmation leaves out ${unnamed.join(', ')}. A repeat is confirmed by naming every run `
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
 * **WHO THE COMPANY'S PEOPLE ARE, AS THIS DEVICE BELIEVES THEM**, or a refusal
 * naming who would be paid at what their own wallet did not sign, or whose
 * record this device does not believe at all.
 */
const peopleToDrawOver = (here: PeopleHere, asked: RunAsked): { all: RosterEmployee[]; handedOver: Set<string> } => {
  const chosen = (id: string) => asked.employeeIds === undefined || asked.employeeIds.includes(id);
  const notPayable = here.notPayable.filter((p) => chosen(p.here.person.id));
  if (notPayable.length > 0) {
    throw new RunNotDrawnHere(`${notPayable.map((p) => `${p.here.person.name} cannot be paid: ${p.why}`).join('; ')}. A run pays `
      + 'each person only at the address and payslip key their own wallet signed. Ask them to give their code again, or mark '
      + 'them a leaver, and draw the run again.');
  }
  const unread = here.notBelieved.filter(chosen);
  if (unread.length > 0) {
    throw new RunNotDrawnHere(`${unread.length} of the company's people ${unread.length === 1 ? 'has a record' : 'have records'} `
      + 'filed by a seat this device does not believe, so this device cannot say whether they should be paid. Ask a signer of '
      + 'the company to file their record again, or reload the page.');
  }
  /* Somebody not payable and not chosen is still on the roster: leaving them out is named like leaving anybody out. */
  const everybody = [...here.people, ...here.notPayable.map((p) => p.here)];
  return {
    all: everybody.map((p) => p.person),
    handedOver: new Set(everybody.filter((p) => p.handedOver).map((p) => p.person.id)),
  };
};

/**
 * **DRAWS A RUN FOR `asked.period` ON THIS DEVICE, AND FILES IT.** Refused,
 * with nothing filed, when anybody it would leave out is not named in the
 * confirmation, when an active person is not payable at what their own wallet
 * signed, when a run for the month has already been raised and this is not a
 * confirmed repeat, and when nobody is left to pay. Returns the run as filed.
 */
export async function drawRunHere(doors: RunDrawDoors, asked: RunAsked): Promise<PayrollRun> {
  const period = drawn(() => canonicalPeriod(asked.period));
  const at = (doors.now ?? (() => new Date().toISOString()))();
  const assets = doors.registry ?? theAssets;
  const [here, sealedRuns, proposals] = await Promise.all([doors.records.people(), doors.records.runs(), doors.records.proposals()]);
  const { all, handedOver } = peopleToDrawOver(here, asked);
  const skip = asked.skipPending === undefined ? undefined
    : { employeeIds: [...asked.skipPending.employeeIds], reason: asked.skipPending.reason, by: doors.by };
  const { roster, leftOut } = drawn(() => peopleDrawn(all, asked.employeeIds, skip, (e) => handedOver.has(e.id)));
  const runs = sealedRuns.filter((r) => r.accountId === doors.accountId).map((r) => openSealedRun(r, doors.viewingKey));
  const rounds = payrollRoundsHere(proposals, doors.accountId, doors.viewingKey);
  const repeated = asked.repeats === undefined ? undefined
    : confirmedRepeatHere(period, runs, rounds, asked.repeats, doors.by, at);
  if (repeated === undefined) {
    drawn(() => refuseAPeriodAlreadyRaised(period, runs));
    drawn(() => refuseAPayrollThatMayBeOnChain(period, runs, rounds));
  }
  const runId = newRunId();
  const skips = leftOut && skip ? drawn(() => recordSkips(runId, leftOut, skip, at)) : undefined;
  const { employees, payslips } = drawn(() => peopleOnTheRun({
    runId, period, specs: roster.map((e) => ({ name: e.name, asset: e.asset, amount: e.baseAmount })), roster, assets,
    company: doors.company,
  }));
  const repeats = drawn(() => withNumberedExtras(period, employees, repeated, [...(asked.repeats?.extra ?? [])], runs,
    (id) => all.find((p) => p.id === id)?.name ?? null));
  const run = assembledRun({
    runId, accountId: doors.accountId, period, employees, payslips,
    ...(skips ? { skips } : {}), ...(repeats ? { repeats } : {}),
  });
  const filing = signRunFiling(doors.accountId, sealedRunOf(run, doors.viewingKey, doors.keyEpoch), doors.signingSecret);
  await doors.api(`/api/accounts/${encodeURIComponent(doors.accountId)}/runs`, { method: 'POST', body: JSON.stringify({ run: filing }) });
  return run;
}
