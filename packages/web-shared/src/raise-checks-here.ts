/**
 * **THE CHECKS EVERY ROUND OF A PAYROLL RUN MUST PASS, ON THE DEVICE THAT
 * RAISES IT AND ON EVERY DEVICE THAT APPROVES IT.**
 *
 * One list, run by both, on facts each device read itself: the people from
 * the company's records it believes, its directory, the company's own
 * ceilings, the company's other runs, and what the person's own wallet read
 * off the chain. None of it is an answer the company's service made. A
 * device that approves a round therefore refuses exactly what the device that
 * raised it would have refused, judged on what the approving device reads
 * now, and a check added to the list is run by both without either changing.
 *
 * A round is a leg of a run, or a retry of some of a leg's people. What the
 * chain itself refuses - a second payment for a person, month and kind of pay
 * - is still refused there; these refuse first, so no approval is collected
 * and no fee is spent on a round the chain or the company would refuse.
 */
import type { PayrollRound } from '../../../src/core/account.js';
import type { AssetRegistry } from '../../../src/core/assets.js';
import { assets as theAssets, type AssetId } from '../../../src/core/assets.js';
import type { Hex } from '../../../src/core/crypto.js';
import { evaluatePolicy } from '../../../src/core/company-policy.js';
import { confirmationCovers, unaccountedOnChain } from '../../../src/core/already-paid.js';
import { isLiveRound } from '../../../src/core/retry-cover.js';
import {
  earlierRoundOfLeg, refuseALegThatIsProposed, refuseARetryOfALegNeverOnChain, refuseARetryOverAnotherRetry,
  refuseARetryWhileItsLegCanPay, refusePayingOnePayeeTwice, refusePeopleDecidedNotToPay, refuseRaisingOverAnotherRun,
  unaccountedRefusalHere, type ProposalStandingRead,
} from '../../../src/core/run-raising.js';
import { registerFor, skippedIndices } from '../../../src/midnight/run-skips.js';
import { assetOfLeg, legEmployees, legName, openSealedRun } from '../../../src/core/run-legs.js';
import type { PaymentFacts } from '../../../src/midnight/payout-tree.js';
import type { Account, PayrollRun, Role, RunLeg, SealedProposal } from '../../../src/core/types.js';
import type { PeopleHere } from './people-on-device.js';
import type { DirectoryHere } from './vault-page-doors.js';
import type { RunMadeHere } from './what-this-device-made.js';
import { knownEntriesOf } from './payment-entries.js';
import { payableFactsOf, payrollRoundsHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { policyForARunHere, type PolicyForARun } from './spending-policy-here.js';

/** A round of a run, as this device made it: the run, the leg, and the payments it makes, with what they are checked against. */
export interface RoundToCheck {
  readonly run: PayrollRun;
  readonly leg: RunLeg;
  /**
   * The proposal as made here: every payment on the leg in the leg's order, the
   * positions a retry pays (every position, for a leg), what the company's
   * records account for on the chain, and what the person's own wallet read.
   */
  readonly made: RunMadeHere;
  /** The signing key the proposal's filing is signed with: this device's seat's for a raise, the filer's for an approval. */
  readonly filedBy: string;
  /** The vault the proposal is paid from: the one it is raised on, which its identity on the chain is made with. */
  readonly vault: string;
  /**
   * The proposal the proposal is written down as, when it is: the one being
   * approved or sent again. Absent while it is raised. A round is never
   * refused for being itself.
   */
  readonly proposal?: string;
}

/**
 * What a raise has already read for the proposal it is checking, so the checks
 * decide on that one read rather than reading it again: the company's
 * proposals, and the proposal's vault's spending policy read for exactly this
 * round's vault, currency, total and window.
 */
export interface ReadForTheRound {
  readonly proposals?: readonly SealedProposal[];
  readonly spendingPolicy?: PolicyForARun;
}

/** Everything the checks read, read on this device for one round. */
export interface FactsHere {
  readonly people: PeopleHere;
  readonly directory: DirectoryHere;
  readonly policy: Account['policy'];
  /** The company's other runs a live round was raised from, opened here, and the runs whose rounds are live. */
  readonly others: readonly PayrollRun[];
  readonly live: ReadonlySet<string>;
  readonly circuits: CompanyRecordsHere['payments'];
  readonly registry: AssetRegistry;
  /** Every payroll round of the company's, opened here, and where any of its proposals stands, by name. */
  readonly rounds: readonly PayrollRound[];
  readonly standingOf: (proposalId: string) => ProposalStandingRead | undefined;
  /** Now, by this device's clock, in seconds since the Unix epoch: what a window is judged against. */
  readonly nowInSeconds: bigint;
  /** Where the proposal stands under its vault's spending policy, read here (`policyForARunHere`). */
  readonly spendingPolicy: PolicyForARun;
}

/** One check: its name, and what it refuses, by throwing what it says. */
export interface RaiseCheck {
  readonly name: string;
  readonly check: (round: RoundToCheck, facts: FactsHere) => void;
}

/** Why a round was refused by one of the checks, in the check's own words. */
export class RoundRefusedHere extends Error {
  constructor(readonly check: string, why: string, options?: { cause?: unknown }) {
    super(why, options);
    this.name = 'RoundRefusedHere';
  }
}

/** The positions on the leg the proposal pays: those a retry names, or every one. */
const positionsOf = (made: RunMadeHere): readonly number[] => made.retry ?? made.facts.map((_, i) => i);

/** The same payment: to the same address, in the same form, of the same token and amount. */
const samePayment = (a: PaymentFacts, b: PaymentFacts): boolean => a.payee.kind === b.payee.kind && a.payee.bech32 === b.payee.bech32
  && a.token.toLowerCase() === b.token.toLowerCase() && a.amount === b.amount;

const addressOfIn = (people: PeopleHere) => (e: { id: string }): string | null =>
  people.people.find((p) => p.person.id === e.id)?.person.address?.bech32 ?? null;

/**
 * **A LEG IS PAID BY ONE ROUND.** A leg's round is refused while the run points
 * at another round for the leg that is not withdrawn, while a retry on the leg
 * can still pay some of its people, and while another round of the leg may
 * still be on the chain. A retry is judged by the two checks after these. Each
 * check reads and refuses on its own inputs, so none of them relies on another
 * having run before it.
 */
const legRaisedOnce: RaiseCheck = {
  name: 'leg-raised-once',
  check: ({ run, leg, made, proposal }, facts) => {
    if (made.retry !== undefined) return;
    refuseALegThatIsProposed(run, leg, facts.rounds, facts.registry, proposal);
  },
};

const noOtherRoundOfTheLeg: RaiseCheck = {
  name: 'no-other-round-of-the-leg',
  check: ({ run, leg, made, proposal }, facts) => {
    if (made.retry !== undefined) return;
    const other = earlierRoundOfLeg(run, leg, facts.rounds, facts.registry, proposal);
    if (other === undefined) return;
    throw new Error(`the ${legName(leg, facts.registry)} leg of run ${run.id} is written down as ${other}, which may be on `
      + 'the chain, and a leg is paid by one round. Send that one, or withdraw it - withdrawing asks the chain - and raise '
      + 'the leg again after');
  },
};

/**
 * **A RETRY IS OF A LEG WHOSE OWN ROUND HAS REACHED THE CHAIN AND CAN NO LONGER
 * PAY EVERYBODY ON IT**: seen on the chain, and stopped or past its window.
 */
const legNoLongerPays: RaiseCheck = {
  name: 'leg-no-longer-pays',
  check: ({ run, leg, made }, facts) => {
    if (made.retry === undefined) return;
    const pointed = run.proposalIds[leg];
    const legRound = pointed === undefined ? undefined : facts.standingOf(pointed);
    refuseARetryOfALegNeverOnChain(run, leg, legRound, facts.registry);
    if (legRound !== undefined) refuseARetryWhileItsLegCanPay(run, leg, legRound, facts.nowInSeconds, facts.registry);
  },
};

/** **NOBODY A RETRY PAYS IS ON ANOTHER RETRY OF THE LEG THAT CAN STILL PAY THEM.** */
const notOnAnotherRetry: RaiseCheck = {
  name: 'not-on-another-retry',
  check: ({ run, leg, made, proposal }, facts) => {
    if (made.retry === undefined) return;
    refuseARetryOverAnotherRetry({
      run, leg, indices: made.retry, legRounds: facts.rounds, again: undefined, nowInSeconds: facts.nowInSeconds,
      standingOf: (id) => facts.standingOf(id) ?? { status: 'unknown' }, registry: facts.registry,
      ...(proposal === undefined ? {} : { self: proposal }),
    });
  },
};

/**
 * **EVERYBODY THE PROPOSAL PAYS IS SOMEBODY THIS DEVICE BELIEVES AND WOULD PAY,
 * AT EXACTLY WHAT THE PROPOSAL PAYS THEM.** Only the people it pays: a retry is
 * judged on the people it names, so somebody who left after the leg was raised
 * does not stop a retry of the others.
 */
const payable: RaiseCheck = {
  name: 'payable',
  check: ({ run, leg, made }, facts) => {
    const onTheLeg = legEmployees(run, leg);
    const positions = positionsOf(made);
    const paid = positions.map((i) => onTheLeg[i]);
    if (paid.some((e) => e === undefined) || onTheLeg.length !== made.facts.length) {
      throw new Error(`this run names people who are not on the leg it pays, or the leg lists ${onTheLeg.length} people `
        + `and records ${made.facts.length} payments, so who each payment is for cannot be said`);
    }
    const now = payableFactsOf(facts.people, paid as NonNullable<(typeof paid)[number]>[], 'Leave them unpaid until their '
      + 'record is put right.', 'This device will not raise or approve a round it would not pay.', facts.registry);
    positions.forEach((i, at) => {
      if (!samePayment(now[at]!, made.facts[i]!)) {
        throw new Error(`this run pays ${paid[at]!.name} at another address, in another form or another amount than this device `
          + 'would pay them now from their record and the run. Draw the run again, or raise a retry once their record is put right');
      }
    });
  },
};

/**
 * **NOBODY THE PROPOSAL PAYS IS SOMEBODY THE RUN RECORDS A DECISION NOT TO PAY**,
 * read from the run's own record of decisions.
 */
const decidedNotToPay: RaiseCheck = {
  name: 'decided-not-to-pay',
  check: ({ run, leg, made }) => {
    if (run.skips === undefined) return;
    const register = registerFor(run.skips.decisions, run.id, run.skips.people.length);
    const notToPay = new Set(skippedIndices(register).map((i) => run.skips!.people[i]!.employeeId));
    refusePeopleDecidedNotToPay(run, leg, positionsOf(made), notToPay);
  },
};

/** **THE COMPANY'S OWN CEILING** for the role of the seat that files the proposal, over what the proposal pays. */
const ceiling: RaiseCheck = {
  name: 'ceiling',
  check: ({ leg, made, filedBy }, facts) => {
    /* A seat its directory gives no role has every right, as the directory reads it; the ceilings are an admin's. */
    const role = facts.directory.dir.seats.find((s) => s.signingKey.toLowerCase() === filedBy.toLowerCase())?.role as Role | null | undefined;
    const total = positionsOf(made).reduce((a, i) => a + made.facts[i]!.amount, 0n);
    const verdict = evaluatePolicy({ policy: facts.policy } as Account, assetOfLeg(leg) as AssetId, total, role ?? 'admin',
      { state: 'unknown', why: 'not-yet-proposed' }, facts.registry);
    if (verdict.blocked) throw new Error(verdict.reason ?? 'this company\'s own policy stops this run');
  },
};

/**
 * **A RUN FROM A VAULT UNDER A SPENDING POLICY IS ONE THE CHAIN WILL CHARGE.**
 * Read on this device for the proposal's own vault and currency: the vault has a
 * policy for the currency, the run's whole window lies in one of its periods,
 * its total fits a band and is no more than the vault may pay in a period, and
 * it is raised needing at least the approvals its band needs - more is the
 * raiser's own choice. A vault with no policy is paid as it always was.
 */
const spendingPolicy: RaiseCheck = {
  name: 'spending-policy',
  check: ({ made }, facts) => {
    const p = facts.spendingPolicy;
    if (p.state === 'none') return;
    if (p.state === 'unread') {
      throw new Error(`this device could not read the spending policy of the vault this run is paid from (${p.why}), so it `
        + 'cannot say the vault would pay it. Reload the page and try again');
    }
    if (p.state === 'not-for-this-currency') {
      throw new Error('the vault this run is paid from has a spending policy, but none for the currency this run pays in, so the '
        + 'chain would charge it to no period and the vault would not pay it. Set a policy for this currency first, or raise '
        + 'the run from another vault');
    }
    if (p.period === null) {
      throw new Error('this run\'s window does not lie inside one period of the spending policy of the vault it is paid from, so '
        + 'the chain would never charge it. Choose a window that opens and closes inside one period');
    }
    if (p.required === null) {
      throw new Error('this run\'s total is above every band of the spending policy of the vault it is paid from, so no number '
        + 'of approvals can pay it. Pay less in one run, or change the policy');
    }
    const total = positionsOf(made).reduce((a, i) => a + made.facts[i]!.amount, 0n);
    if (total > p.periodLimit) {
      throw new Error('this run alone is more than the vault it is paid from may pay in one period under its spending policy. '
        + 'Pay less in one run, or raise the limit for the period');
    }
    if (!/^[0-9]+$/u.test(String(made.required)) || BigInt(made.required) < p.required) {
      throw new Error(`this run is raised needing ${String(made.required)} approvals, and its band under the spending policy of `
        + `the vault it is paid from needs ${p.required}, so the chain would not charge it. Raise it again`);
    }
  },
};

/** **NO OTHER RUN FOR THE MONTH IS RAISED TO PAY THE SAME PEOPLE.** */
const overAnotherRun: RaiseCheck = {
  name: 'over-another-run',
  check: ({ run }, facts) => refuseRaisingOverAnotherRun(run, facts.others, facts.live, addressOfIn(facts.people)),
};

/** **NO TWO PEOPLE ON THE LEG ARE PAID AT ONE ADDRESS**, so no address is paid twice for the month, by a leg or a retry. */
const onePayeeTwice: RaiseCheck = {
  name: 'one-payee-twice',
  check: ({ run, leg }, facts) => refusePayingOnePayeeTwice(run, leg, addressOfIn(facts.people)),
};

/**
 * **THE CHAIN HOLDS NOTHING THE COMPANY'S RECORDS CANNOT ACCOUNT FOR**, as the
 * person's own wallet read it: every round it holds open is one the records
 * hold, and every entry its record of payments holds (each payment leaves two)
 * is one of a leaf or a person-month the records hold, unless the run was drawn
 * as a repeat confirming exactly those.
 */
const unaccounted: RaiseCheck = {
  name: 'unaccounted',
  check: ({ made }, facts) => {
    const r = made.raising;
    const wallet = made.wallet;
    if (r === undefined || wallet === undefined) {
      throw new Error('this device did not read what the company\'s records account for on the chain, or your wallet did not '
        + 'read the chain, so it cannot say whether the chain holds anything these records cannot account for. Reload the page '
        + 'and try again');
    }
    const asked = new Set(wallet.asked.map((e) => e.toLowerCase()));
    const held = new Set(wallet.held.map((e) => e.toLowerCase()));
    const known = knownEntriesOf(r, facts.circuits);
    if (known.some((e) => !asked.has(e))) {
      throw new Error('your wallet was not asked about every payment these records know about, so this device cannot say '
        + 'whether the chain holds payments they cannot account for. Reload the page and try again');
    }
    const paid = known.filter((e) => held.has(e)).length;
    const found = unaccountedOnChain({ openRounds: wallet.openRounds, payments: wallet.entries }, { rounds: [...r.knownRounds], paid });
    if (found.rounds.length === 0 && found.payments === 0) return;
    if (confirmationCovers(found, r.confirmed)) return;
    throw new Error(unaccountedRefusalHere(r.period, found));
  },
};

/**
 * **THE ONE LIST.** Every raise and every approval of a payroll round runs all
 * of it, in this order. A check added here is run on both.
 */
export const RAISE_CHECKS: readonly RaiseCheck[] = [
  legRaisedOnce, noOtherRoundOfTheLeg, legNoLongerPays, notOnAnotherRetry,
  payable, decidedNotToPay, ceiling, spendingPolicy, overAnotherRun, onePayeeTwice, unaccounted,
];

/** The proposal's vault's spending policy, read for the proposal's vault, currency, total and window. */
const policyOfTheRound = (
  records: CompanyRecordsHere, accountId: string, viewingKey: Hex, round: Pick<RoundToCheck, 'vault' | 'leg' | 'made'> | undefined,
): Promise<PolicyForARun> => {
  if (round === undefined) return Promise.resolve({ state: 'unread', why: 'this device was not told which round to read it for' });
  const { opensAt, closesAt } = round.made;
  if (!/^[0-9]+$/u.test(String(opensAt)) || !/^[0-9]+$/u.test(String(closesAt))) {
    return Promise.resolve({ state: 'unread', why: 'the run\'s window is not whole seconds since the Unix epoch' });
  }
  return policyForARunHere({ records, accountId, viewingKey }, {
    vault: round.vault, asset: assetOfLeg(round.leg) as AssetId,
    total: positionsOf(round.made).reduce((a, i) => a + round.made.facts[i]!.amount, 0n),
    opensAt: BigInt(opensAt), closesAt: BigInt(closesAt),
  });
};

/**
 * What the checks read for `run`, each read on this device from the company's
 * records and the person's own wallet, judged at `now` by this device's clock,
 * with the spending policy of `round`'s vault when a round is named.
 */
export async function factsHere(
  records: CompanyRecordsHere, accountId: string, run: PayrollRun, viewingKey: Hex, now: Date = new Date(),
  round?: Pick<RoundToCheck, 'vault' | 'leg' | 'made'>, read: ReadForTheRound = {},
): Promise<FactsHere> {
  const readProposals = records.proposals;
  if (readProposals === undefined) {
    throw new Error('this page cannot read the company\'s proposals, so it cannot check a payroll round. Reload the page to get '
      + 'the current version');
  }
  const [people, directory, policy, proposals, runs, spendingPolicy] = await Promise.all([
    records.people(), records.directory(), records.policy(), read.proposals ?? readProposals(), records.runs(),
    read.spendingPolicy ?? policyOfTheRound(records, accountId, viewingKey, round)]);
  const rounds = payrollRoundsHere(proposals, accountId, viewingKey);
  const live = new Set(rounds.filter(isLiveRound).map((r) => r.runId));
  const others = runs.filter((r) => r.accountId === accountId && r.id !== run.id && live.has(r.id)).map((r) => openSealedRun(r, viewingKey));
  return {
    people, directory, policy, others, live, circuits: records.payments, registry: records.registry ?? theAssets, rounds,
    standingOf: (id) => proposals.find((p) => p.id === id && p.accountId === accountId),
    nowInSeconds: BigInt(Math.floor(now.getTime() / 1000)), spendingPolicy,
  };
}

/**
 * **REFUSES A ROUND ANY CHECK ON THE LIST REFUSES**, with that check's own
 * words, on facts read here. The raising device runs it before anything is
 * written down; every approving device runs it before an approval is built.
 */
export async function refuseWhatNoRoundMay(
  records: CompanyRecordsHere, accountId: string, viewingKey: Hex, round: RoundToCheck, now?: Date, read?: ReadForTheRound,
): Promise<void> {
  const facts = await factsHere(records, accountId, round.run, viewingKey, now, round, read);
  for (const c of RAISE_CHECKS) {
    try {
      c.check(round, facts);
    } catch (e) {
      /* Said once, by whoever refused the proposal, what was not done. */
      const why = String((e as Error)?.message ?? e).replace(/\s*Nothing was built or sent\.\s*$/u, '').replace(/\.?\s*$/u, '');
      throw new RoundRefusedHere(c.name, why, { cause: e });
    }
  }
}
