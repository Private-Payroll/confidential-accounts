/**
 * **WHAT A PAYROLL PROPOSAL PAYS, READ ON THIS DEVICE FROM THE COMPANY'S OWN
 * RECORDS, SO THAT THE RUN CAN BE MADE AGAIN HERE BEFORE IT IS APPROVED.**
 *
 * Read here, each from the record that holds it:
 *   - the company's state, believed only as the record its founding seat
 *     signed: the payout seeds and the pay-record key every payee's secrets
 *     come from. The founding seat is the one the account's deploy seated, as
 *     the person's own wallet read it from the chain - never whoever holds a
 *     slot now - and the key it signs with is the one its own wallet signed into
 *     the company's directory. The founding signer removed later, or another
 *     seat put where they sat, changes nothing about which signature is
 *     believed;
 *   - the run, opened with the viewing key, and the leg or the retry the
 *     proposal raised;
 *   - the people, as this device believes and would pay them: a person no seat
 *     it believes filed, or whose address or payslip key is not what their own
 *     code names, is not someone this device pays.
 *
 * What is returned is handed to where the approval is built, which makes every
 * leaf, the root and the payload again and proves nothing unless they are the
 * proposal's (`refuseWhatThisDeviceDidNotMake`).
 */
import type { AssetRegistry } from '../../../src/core/assets.js';
import type { Hex, Sealed } from '../../../src/core/crypto.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { payrollRoundOf } from '../../../src/core/retry-cover.js';
import type { PayrollRound } from '../../../src/core/account.js';
import type { Employee, PayrollRun, RosterEmployee, SealedProposal, SealedRun, StateBlinding } from '../../../src/core/types.js';
import type { PaymentFacts } from '../../../src/midnight/payout-tree.js';
import {
  assetOfLeg, factsOfThePaid, legEmployees, legsOfRun, openSealedRun, payRecordsOf, runIdForLeg,
} from '../../../src/core/run-legs.js';
import {
  CREATED_BEFORE_SIGNED_STATE, FOUNDING_KEY_EPOCH, foundingStateRefusal, openStateRecord, stateRecordId,
} from '../../../src/core/founding-state.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { foundingSeatHere, judgeIn, type DirectoryHere } from './vault-page-doors.js';
import { runFilingRefusal } from '../../../src/core/run-filing.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { payRecordNonceOf } from '../../../src/midnight/run-keys.js';
import type { RaisingHere } from './what-this-device-made.js';
import type { PeopleHere } from './people-on-device.js';
import type { RunMadeHere } from './what-this-device-made.js';

/** The company's records this device reads a run from. */
export interface CompanyRecordsHere {
  /**
   * The company's seat directory, as this device believes it now, with who
   * holds the account and the seat its deploy seated as the person's own wallet
   * read them.
   */
  readonly directory: () => Promise<DirectoryHere>;
  /** The company's people, opened and judged on this device (`readPeopleHere`). */
  readonly people: () => Promise<PeopleHere>;
  /** The company's state record at one key epoch, as filed, or null when none is. */
  readonly state: (id: string) => Promise<SealedCompanyRecord | null>;
  /** The company's runs, sealed as they are stored. */
  readonly runs: () => Promise<readonly SealedRun[]>;
  /** The company's proposals, sealed as they are stored. Read where a raise or a retry is made here. */
  readonly proposals?: () => Promise<readonly SealedProposal[]>;
  readonly registry?: AssetRegistry;
}

/** Why this device could not read a run from the company's records. Nothing is built without it. */
export class RunNotReadHere extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why} Nothing was built or sent.`, options);
    this.name = 'RunNotReadHere';
  }
}

const IF_AGAIN = 'If it happens again, do not approve it.';

/**
 * The payout seeds and pay-record key from the state the founding seat signed.
 * The founding seat is the deploy's, as the person's own wallet read it
 * (`holders.founding`), and its signing key is the one its own wallet signed
 * into the directory under the committee key the deploy held the account by
 * (`holders.foundingCommittee`): an entry the directory keeps whether the seat
 * is held now or not, so the first state stays believed through any later
 * change of seats, and no entry under another key speaks for that seat.
 */
export async function signedStateHere(
  records: CompanyRecordsHere, accountId: string, viewingKey: Hex,
): Promise<{ readonly seeds: NonNullable<StateBlinding['payoutSeeds']>; readonly payKey: string; readonly assetBlinding: string }> {
  const rec = await records.state(stateRecordId(FOUNDING_KEY_EPOCH));
  if (rec === null) throw new RunNotReadHere(CREATED_BEFORE_SIGNED_STATE.replace(/ Nothing was approved or sent\./u, ''));
  const seat = foundingSeatHere(await records.directory());
  const refused = typeof seat === 'string' ? seat : foundingStateRefusal(rec, accountId, seat.signingKey);
  if (refused !== null) {
    throw new RunNotReadHere(`This device does not believe the company state it was given (${refused}), so it cannot check `
      + `what this proposal pays. Reload the page and try again. ${IF_AGAIN}`);
  }
  let blinding;
  try {
    ({ blinding } = openStateRecord(rec, viewingKey));
  } catch (e) {
    throw new RunNotReadHere(`This device cannot open the company's state with the key it holds, so it cannot check what `
      + `this proposal pays. Reload the page and try again. ${IF_AGAIN}`, { cause: e });
  }
  const payKey = String(blinding.payRecordKey ?? '');
  if (!/^[0-9a-f]{64}$/u.test(payKey)) {
    throw new RunNotReadHere('The company\'s state carries no pay-record key, so no run of it can be checked here.');
  }
  return { seeds: blinding.payoutSeeds ?? [], payKey, assetBlinding: blinding.assetBlinding };
}

/** A run of the company opened here with the viewing key, or refused by name. */
const openedHere = (sealed: SealedRun, viewingKey: Hex, what: string): PayrollRun => {
  try {
    return openSealedRun(sealed, viewingKey);
  } catch (e) {
    throw new RunNotReadHere(`This device cannot open ${what}. Reload the page and try again. ${IF_AGAIN}`, { cause: e });
  }
};

/**
 * **ONE OF THE COMPANY'S RUNS, OPENED HERE BY ITS ID.** Refused when the
 * company holds no run by that id, or the run it holds is another company's.
 */
/**
 * **A RUN IS READ ONLY AS A SEAT THIS DEVICE BELIEVES FILED IT.** Its filing
 * signature must cover exactly the run as it is kept, for this company, and be
 * made with the signing key the company's directory holds for a seat whose role
 * may file a run. A run nobody signed, or a seat signed and the service then
 * changed, is not read.
 */
async function refuseARunNoSeatFiled(records: CompanyRecordsHere, accountId: string, sealed: SealedRun): Promise<void> {
  const why = runFilingRefusal(accountId, sealed)
    ?? judgeIn(await records.directory())(sealed.filedBy!.publicKey.toLowerCase() as Hex, 'run', companyRecordKey('run', sealed.id), 1);
  if (why !== null) {
    throw new RunNotReadHere(`This device does not believe the company's record of this payroll run (${why}). Do not act on it. `
      + IF_AGAIN);
  }
}

export async function openedRunHere(records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex): Promise<PayrollRun> {
  return (await keptRunHere(records, accountId, runId, viewingKey)).run;
}

/** The run as the company keeps it, sealed, and as this device opened it, once a believed seat is shown to have filed it. */
export async function keptRunHere(
  records: CompanyRecordsHere, accountId: string, runId: string, viewingKey: Hex,
): Promise<{ readonly sealed: SealedRun; readonly run: PayrollRun }> {
  const sealed = (await records.runs()).find((r) => r.id === runId);
  if (sealed === undefined || sealed.accountId !== accountId) {
    throw new RunNotReadHere(`This company's records hold no payroll run by that name. Reload the page to see its runs.`);
  }
  await refuseARunNoSeatFiled(records, accountId, sealed);
  const run = openedHere(sealed, viewingKey, 'this payroll run');
  if (run.id !== runId || run.accountId !== accountId) {
    throw new RunNotReadHere(`The payroll run this company's records hold under that name was built for another run or another company. ${IF_AGAIN}`);
  }
  return { sealed, run };
}

/**
 * **WHAT EACH OF `paid` IS PAID, FROM THE PEOPLE THIS DEVICE BELIEVES AND WOULD
 * PAY**: each person's address and form from their own believed record. A
 * person this device does not believe, or would not pay at the address it
 * holds, is refused by name with `whatToDo`; a run paying anybody not on the
 * roster, or not active, is refused with `whyNot`.
 */
export async function payableFactsHere(
  records: CompanyRecordsHere, paid: readonly Employee[], whatToDo: string, whyNot: string,
): Promise<PaymentFacts[]> {
  const people = await records.people();
  const payable = new Map<string, RosterEmployee>(people.people.map((p) => [p.person.id, p.person]));
  const refusedHere = new Set([...people.notBelieved, ...people.notPayable.map((n) => n.here.person.id)]);
  const notHere = paid.find((e) => refusedHere.has(e.id));
  if (notHere !== undefined) {
    throw new RunNotReadHere(`${notHere.name} is on this run, and this device does not believe their record or would not `
      + `pay them at the address it holds. ${whatToDo}`);
  }
  try {
    return factsOfThePaid(paid, (id) => payable.get(id), records.registry);
  } catch (e) {
    throw new RunNotReadHere(`${(e as Error).message.replace(/\.?\s*$/u, '.')} ${whyNot}`, { cause: e });
  }
}

/**
 * **THE RUN A PAYROLL PROPOSAL RAISED, AS THIS DEVICE READS IT.** `proposalId`
 * is the company's own name for the proposal. Refused, by name, when no run of
 * the company raised it, when the company's state is not one this device
 * believes, or when anybody the run pays is not someone this device would pay.
 */
export async function runRebuiltHere(
  records: CompanyRecordsHere, accountId: string, proposalId: string, viewingKey: Hex,
): Promise<RunMadeHere> {
  const sealed = (await records.runs()).find((r) => r.accountId === accountId && (r.proposalIds ?? []).includes(proposalId));
  if (sealed === undefined) {
    throw new RunNotReadHere('No payroll run of this company raised this proposal, so this device has nothing to check it '
      + `against. ${IF_AGAIN}`);
  }
  await refuseARunNoSeatFiled(records, accountId, sealed);
  const run = openedHere(sealed, viewingKey, 'the payroll run this proposal raised');
  let leg = legsOfRun(run).find((l) => run.proposalIds[l] === proposalId);
  let retry: { readonly originalIndices: readonly number[]; readonly opensAt: bigint; readonly closesAt: bigint; readonly required?: bigint } | undefined;
  if (leg === undefined) {
    for (const l of legsOfRun(run)) {
      const found = run.payout?.[l]?.retries?.find((r) => r.proposalId === proposalId);
      if (found !== undefined) { leg = l; retry = found; break; }
    }
  }
  const payout = leg === undefined ? undefined : run.payout?.[leg];
  if (leg === undefined || payout === undefined) {
    throw new RunNotReadHere(`The payroll run this proposal names does not say which of its payments it raised. ${IF_AGAIN}`);
  }
  if (payout.runId !== runIdForLeg(run, leg) || run.accountId !== accountId) {
    throw new RunNotReadHere(`The payroll run this proposal names was built for another run or another company. ${IF_AGAIN}`);
  }
  const state = await signedStateHere(records, accountId, viewingKey);
  const paid = legEmployees(run, leg);
  const facts = await payableFactsHere(records, paid, 'Leave this proposal unapproved until their record is put right.',
    'This device will not approve a run it would not pay.');
  const window = retry ?? payout;
  return {
    kind: 'payroll',
    seeds: state.seeds,
    payKey: state.payKey,
    identity: { accountId, runId: payout.runId, epoch: payout.epoch },
    facts,
    records: payRecordsOf(run, paid),
    asset: assetOfLeg(leg),
    opensAt: String(window.opensAt),
    closesAt: String(window.closesAt),
    required: String(window.required ?? 0n),
    ...(retry === undefined ? {} : { retry: [...retry.originalIndices] }),
  };
}

/**
 * **WHAT THE COMPANY'S RECORDS ACCOUNT FOR ON THE CHAIN**, for a raise of
 * `run`: every proposal they hold, by its identity on the chain; every leaf and
 * payment nonce of every leg of every run they hold, the nonces under the
 * company's pay-record key; and what `run`, if it was drawn as a repeat,
 * confirmed it repeats. Read from the records this device opened, never from
 * an answer the service made.
 */
export async function whatTheRecordsAccountFor(
  records: CompanyRecordsHere, accountId: string, run: PayrollRun, viewingKey: Hex,
): Promise<RaisingHere> {
  if (records.proposals === undefined) {
    throw new RunNotReadHere('This page cannot read the company\'s proposals, so it cannot raise a run. Reload the page to get '
      + 'the current version.');
  }
  const [proposals, runs, state] = await Promise.all([
    records.proposals(), records.runs(), signedStateHere(records, accountId, viewingKey)]);
  const opened = runs.filter((r) => r.accountId === accountId).map((r) => openedHere(r, viewingKey, 'one of the company\'s payroll runs'));
  const legs = opened.flatMap((r) => Object.values(r.payout ?? {}));
  return {
    period: run.period,
    knownRounds: proposals.filter((p: SealedProposal) => p.accountId === accountId).map((p) => p.chainId.toLowerCase()),
    knownLeaves: legs.flatMap((l) => l.leaves.map((x) => x.toLowerCase())),
    knownNonces: legs.flatMap((l) => (l.records ?? []).map((rec) => payRecordNonceOf(state.payKey as Hex, rec).toLowerCase())),
    ...(run.repeats === undefined ? {} : {
      confirmed: { of: [...run.repeats.of], ...(run.repeats.chainPayments === undefined ? {} : { chainPayments: run.repeats.chainPayments }) },
    }),
  };
}

/** The company's payroll rounds, each opened from its sealed record with the viewing key. */
export const payrollRoundsHere = (proposals: readonly SealedProposal[], accountId: string, viewingKey: Hex): PayrollRound[] =>
  proposals.flatMap((rec) => {
    if (rec.accountId !== accountId) return [];
    const inside = openRecord<{ kind: string; raisedAt?: string; sealedPayload: Sealed }>('proposals', rec.accountId, rec.sealed, viewingKey);
    const raisedAt = rec.raisedAt ?? inside.raisedAt;
    const round = payrollRoundOf({
      id: rec.id, kind: inside.kind, status: rec.status, chainId: rec.chainId, sealedPayload: inside.sealedPayload,
      ...(raisedAt === undefined ? {} : { raisedAt }),
    }, viewingKey);
    return round === null ? [] : [round];
  });
