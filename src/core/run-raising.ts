/**
 * **THE RULES A PAYROLL RUN'S LEG IS RAISED UNDER, IN ONE PLACE.**
 *
 * A leg is raised on a signer's device, from the company's records that device
 * opened itself, and the service only files what the device signed. These are
 * the checks that decide whether a leg may be raised at all and whether the
 * material built for it is that leg's: pure functions over a run, the rounds
 * the company has written down and what the chain holds, so the device and the
 * service's own code apply exactly one copy of each.
 */
import type { AssetRegistry } from './assets.js';
import { assets as defaultAssets } from './assets.js';
import { canonical as canonicalJson, type Hex } from './crypto.js';
import type { Employee, PayrollRun, RunLeg } from './types.js';
import { alreadyPaying, kindOfRun, paidTwiceOnOneRun, type Payee, type RunPaying } from './already-paid.js';
import { isLiveRound, untoldRetryRounds } from './retry-cover.js';
import { assetOfLeg, legEmployees, legName, legOfRound, payRecordsOf, runIdForLeg } from './run-legs.js';
import { contentOf, samePeriod, sealReceipt } from './run-drawing.js';
import type { PaymentFacts } from '../midnight/payout-tree.js';
import {
  payRecordNonceOf, runSecrets, type PayoutSeed, type PayRecord, type RunIdentity,
} from '../midnight/run-keys.js';

/** A round of the company's, as far as raising a leg is concerned: its name, where it stands, and what it pays. */
export interface RoundOfARun {
  readonly id: string;
  readonly runId: string;
  readonly asset: string;
  readonly form?: 'shielded' | 'unshielded';
  readonly status: string;
  readonly retry?: readonly number[];
}

/** Where a person is paid now, or `null` when they have no address. */
export type AddressOf = (e: Employee) => string | null;

const canonical = (s: string): string => s.toLowerCase();

/**
 * **A LEG IS RAISED ONCE.** Refused while the proposal the run points at for it
 * is anything but withdrawn, and, once withdrawn, while a retry on it is still
 * live: raising the leg again would raise all of its people while that retry
 * can still pay some of them.
 */
export function refuseALegThatIsProposed(
  run: PayrollRun, leg: RunLeg, rounds: readonly RoundOfARun[], registry: AssetRegistry = defaultAssets,
): void {
  const pointed = run.proposalIds[leg];
  if (!pointed) return;
  const standing = rounds.find((r) => r.id === pointed)?.status;
  if (standing !== 'cancelled') {
    throw new Error(
      `the ${legName(leg, registry)} leg of this run is already proposed, as ${pointed}, which is ${standing ?? 'not in the company\'s records'}. A leg is raised `
      + 'again only once that proposal is withdrawn - withdrawing asks the chain - and then as a new proposal.');
  }
  const retries = rounds.filter((r) =>
    r.runId === run.id && legOfRound(r as never) === leg && r.retry !== undefined && isLiveRound(r));
  if (retries.length > 0) {
    throw new Error(
      `the ${legName(leg, registry)} leg of run ${run.id} was withdrawn, and a retry on it is still live `
      + `(${retries.map((r) => r.id).join(', ')}). Raising the leg again would raise all of its people while `
      + 'that retry can still pay some of them. Withdraw the retry first - withdrawing asks the chain - '
      + 'and raise the leg again after.');
  }
}

/** The one round of this leg that may still be on the chain, if there is one; more than one is refused. */
export function earlierRoundOfLeg(
  run: PayrollRun, leg: RunLeg, rounds: readonly RoundOfARun[], registry: AssetRegistry = defaultAssets,
): string | undefined {
  const live = rounds.filter((r) =>
    r.runId === run.id && legOfRound(r as never) === leg && r.retry === undefined && isLiveRound(r));
  if (live.length > 1) {
    throw new Error(
      `the ${legName(leg, registry)} leg of run ${run.id} is written down as ${live.length} rounds that may be on `
      + `chain (${live.map((r) => r.id).join(', ')}), and a leg is raised as one. Cancel all but `
      + 'one of them (cancelling asks the chain first) before raising this leg again.');
  }
  return live[0]?.id;
}

const paying = (run: PayrollRun, addressOf: AddressOf, at: 'now' | 'recorded'): RunPaying => ({
  id: run.id, month: run.period, kind: kindOfRun(run),
  people: run.employees.map((e): Payee => ({
    id: e.id, name: e.name, address: (at === 'recorded' ? e.paidTo : undefined) ?? addressOf(e),
  })),
});

/**
 * **NO SECOND RUN FOR A MONTH OVER THE SAME PEOPLE.** `others` are the
 * company's other runs; only those raised as a round that may be on the chain
 * (`liveRunIds`) count, and a run this one names as repeated, or that names
 * this one, does not.
 */
export function refuseRaisingOverAnotherRun(
  run: PayrollRun, others: readonly PayrollRun[], liveRunIds: ReadonlySet<string>, addressOf: AddressOf,
): void {
  const content = contentOf(run.employees);
  const candidates = others
    .filter((r) => samePeriod(r.period, run.period) && r.id !== run.id && liveRunIds.has(r.id))
    .filter((r) => !(run.repeats?.of ?? []).includes(r.id) && !(r.repeats?.of ?? []).includes(run.id));
  const payingNow = new Set(alreadyPaying(
    paying(run, addressOf, 'now'), candidates.map((r) => paying(r, addressOf, 'recorded')), samePeriod,
  ).map((c) => c.run.id));
  const clashes = candidates.filter((r) => contentOf(r.employees) === content || payingNow.has(r.id));
  if (clashes.length === 0) return;
  const ids = clashes.map((r) => r.id).join(', ');
  throw new Error(
    `${clashes.length === 1 ? `run ${ids} has` : `runs ${ids} have`} already been raised for `
    + `${run.period} to pay some of the same people. The chain refuses a second salary payment to `
    + 'the same roster entry for the same month, unless it is raised as a numbered extra, so '
    + 'whichever run pays first is paid and the other collects approvals and a fee for payments the '
    + 'chain will refuse; somebody on the roster twice can still be paid twice. Pay them from '
    + 'the run already raised: raise it again '
    + 'if its raise failed, or raise a retry on it for anybody it has not reached. A run that '
    + `means to pay them a second time has to be drawn up with a confirmation naming run ${ids}. `
    + 'No screen takes that confirmation yet.');
}

/** Two of the leg's people paid at one address would pay that address twice for the month. */
export function refusePayingOnePayeeTwice(run: PayrollRun, leg: RunLeg, addressOf: AddressOf): void {
  const inLeg = new Set(legEmployees(run, leg).map((e) => e.id));
  const twice = paidTwiceOnOneRun(paying(run, addressOf, 'now').people)
    .filter(([a, b]) => inLeg.has(a.id) || inLeg.has(b.id));
  if (twice.length === 0) return;
  const [a, b] = twice[0]!;
  throw new Error(
    `${a.name} and ${b.name} are both on this run and are paid at the same address, so this run `
    + `would pay that address twice for ${run.period}. Nothing was raised and no fee was spent. `
    + 'If one of the two entries is a duplicate, mark it as a leaver on the roster and draw the run '
    + 'again.');
}

/** What a leg's material is, as far as these checks read it. */
export interface LegMaterial {
  readonly run: { readonly root: Hex; readonly payees: bigint };
  readonly leaves: readonly Hex[];
  readonly facts: readonly PaymentFacts[];
  readonly identity: RunIdentity;
}

/**
 * **THE MATERIAL IS THIS LEG'S, OF THIS RUN, OF THIS COMPANY.** Its payee count
 * is the leg's people and its leaves'; its root is the root over its own
 * leaves; it was built for this leg's run identity and this company.
 */
export function refuseMaterialThatIsNotThisLeg(
  run: PayrollRun, leg: RunLeg, paid: readonly Employee[], material: LegMaterial,
  rootOf: (leaves: Hex[], facts: readonly PaymentFacts[], asset: string) => Hex, registry: AssetRegistry = defaultAssets,
): void {
  if (material.run.payees !== BigInt(paid.length)) {
    throw new Error(
      `this run pays ${paid.length} people in the ${legName(leg, registry)} leg and the run material names `
      + `${material.run.payees}. The payee count is bound into the payload the signers `
      + 'approve, so a run cannot be declared finished early or made never to finish. A '
      + 'count that disagrees with the roster would do one of the two.');
  }
  if (material.run.payees !== BigInt(material.leaves.length)) {
    throw new Error(
      `this run material names ${material.run.payees} payees and carries `
      + `${material.leaves.length} payout leaves. They are two views of one tree and a run `
      + 'whose leaves do not account for its own payees cannot be reported on.');
  }
  if (rootOf([...material.leaves], material.facts, assetOfLeg(leg)) !== material.run.root) {
    throw new Error(
      'this run material\'s payout root is not the root over its own leaves, so the run the '
      + 'signers would approve is not the run these payees are in. Every payment against it '
      + 'would be refused as a payee who is not in the approved run, on payday, after the '
      + 'signatures were collected and the fee was spent.');
  }
  const legRunId = runIdForLeg(run, leg);
  if (material.identity.runId !== legRunId) {
    throw new Error(
      `this material was built for run ${material.identity.runId} and is being raised for `
      + `${legRunId}. A run's payee secrets are derived from its identifier, so material `
      + 'from another run describes other people.');
  }
  if (material.identity.accountId !== run.accountId) {
    throw new Error(
      `this material was built for account ${material.identity.accountId} and this run `
      + `belongs to ${run.accountId}.`);
  }
}

type Paying = Pick<PaymentFacts, 'payee' | 'token' | 'amount'>;
const samePayment = (a: Paying | undefined, b: Paying | undefined): boolean =>
  a !== undefined && b !== undefined && a.amount === b.amount
  && canonicalJson(a.token) === canonicalJson(b.token) && canonicalJson(a.payee) === canonicalJson(b.payee);

/**
 * **EACH POSITION PAYS THE PERSON AT THAT POSITION.** A payment is that
 * person's when it pays their amount and is the payment the roster builds now
 * (`roster`) or the one the leg recorded when it was first raised (`recorded`).
 */
export function refuseFactsOutOfOrder(
  people: readonly Employee[], facts: readonly PaymentFacts[],
  roster: readonly PaymentFacts[] | null, recorded: readonly PaymentFacts[] | undefined,
): void {
  people.forEach((e, i) => {
    const fact = facts[i];
    if (fact !== undefined && fact.amount === e.amount
      && (samePayment(fact, roster?.[i]) || samePayment(fact, recorded?.[i]))) return;
    throw new Error(
      `position ${i + 1} is not ${e.name}'s as the run has them now or as the leg first `
      + 'recorded them. Each person is told about the payment at their own position, so these '
      + 'would tell somebody about another person\'s. Prepare this leg\'s payments again from '
      + 'the run and send them. Nothing was changed.');
  });
}

/**
 * **EACH PAYMENT SAYS WHO IT PAYS AND FOR WHICH MONTH, AND IT MUST SAY IT OF
 * THIS RUN.** Each nonce is the one its pay record derives under the company's
 * key, and each leaf is the leaf of that payment.
 */
export function refuseRecordsMadeElsewise(
  run: PayrollRun, leg: RunLeg, records: readonly PayRecord[], payKey: Hex,
  payments: readonly { readonly nonce: Hex }[], leaves: readonly Hex[], leafOf: (p: never) => Hex,
  registry: AssetRegistry = defaultAssets,
): void {
  const madeElsewise = records.some((r, i) => {
    const p = payments[i];
    return p === undefined
      || canonical(p.nonce) !== canonical(payRecordNonceOf(payKey, r))
      || canonical(leafOf(p as never)) !== canonical(leaves[i] ?? '');
  });
  if (madeElsewise) {
    throw new Error(
      `the payments prepared for the ${legName(leg, registry)} leg are not this run's payments to its people for `
      + `${run.period}, so the chain could not tell them from another month's or from a second `
      + 'payment nobody confirmed. Prepare this leg\'s payments again from the run and send them. '
      + 'Nothing was changed.');
  }
}

/** A leg raised before and still possibly on the chain is raised again only as that same round. */
export function refuseRaisingAgainDifferently(
  run: PayrollRun, leg: RunLeg, again: string | undefined,
  asked: { readonly opensAt: bigint; readonly closesAt: bigint; readonly vault: Hex }, registry: AssetRegistry = defaultAssets,
): void {
  const earlier = run.payout?.[leg];
  if (again === undefined || earlier === undefined) return;
  if (asked.opensAt === earlier.opensAt && asked.closesAt === earlier.closesAt && asked.vault === earlier.vault) return;
  throw new Error(
    `the ${legName(leg, registry)} leg of run ${run.id} was raised before, may be on chain, and was raised with `
    + `the window ${earlier.opensAt} to ${earlier.closesAt} at vault `
    + `${earlier.vault}. Raising it again is raising that same round, so it takes `
    + 'that window and that vault; a different one would be a second round over the same '
    + 'people. To raise it with a different window or vault, withdraw that round first - '
    + 'withdrawing asks the chain, and a round the chain holds can be withdrawn only until its '
    + 'window opens - and raise it after.');
}

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * **A RUN IS RAISED ONLY WITH A ROOT, A VAULT AND A WINDOW A VAULT CAN PAY.**
 * A root or a vault of the wrong width, the account's own "no vault", or a
 * window that has already closed builds a round that is approved and can never
 * be paid; a window that opens after it closes can never be paid in either.
 */
export function refuseARunNoVaultCanPay(
  run: { readonly root: string; readonly vault: string; readonly opensAt: bigint; readonly closesAt: bigint },
  noVault: string, nowInSeconds: bigint,
): void {
  if (!HEX64.test(run.root)) {
    throw new Error(
      `a run's payout root is 32 bytes as 64 lower-case hex characters; this one is `
      + `${run.root.length} character(s). A root of the wrong width builds a proposal `
      + 'id no merkle path can ever satisfy, and nothing finds out until a vault tries to pay.');
  }
  if (!HEX64.test(run.vault)) {
    throw new Error(
      `a vault address is 32 bytes as 64 lower-case hex characters; this one is `
      + `${run.vault.length} character(s). The vault is folded into the run's identity, `
      + 'so one of the wrong width builds a round no vault can ever present.');
  }
  if (run.vault === canonical(noVault)) {
    throw new Error(
      'a payroll run must name the vault that will pay it. Refused here rather than raised, '
      + 'approved and then presented at a vault that cannot recompute its id.');
  }
  if (run.opensAt >= run.closesAt) {
    throw new Error(
      `this run's window opens at ${run.opensAt} and closes at ${run.closesAt}, so no payment could ever fall `
      + 'inside it. Raise it with a window that opens before it closes.');
  }
  if (run.closesAt <= nowInSeconds) {
    throw new Error(
      `this run's window closed at ${run.closesAt} and it is now ${nowInSeconds}, so no `
      + 'payment could ever fall inside it — and a run whose window has opened can no longer '
      + 'be withdrawn, so raising it would leave a round that can be neither paid nor '
      + 'cancelled. Raise it with a window that ends in the future.');
  }
}

const unaccountedParts = (found: { rounds: readonly string[]; payments: number }): string => [
  ...(found.rounds.length
    ? [`${found.rounds.length} open ${found.rounds.length === 1 ? 'round' : 'rounds'} (${found.rounds.join(', ')})`]
    : []),
  ...(found.payments ? [`${found.payments} unexplained payment ${found.payments === 1 ? 'entry' : 'entries'} (every payment leaves two)`] : []),
].join(' and ');

/**
 * **WHY A RAISE FROM A DEVICE IS REFUSED WHILE THE CHAIN HOLDS WHAT THE RECORDS
 * CANNOT ACCOUNT FOR.** A run drawn on a device names, when it repeats a month,
 * only the runs the company's records hold, so it cannot be confirmed over
 * rounds or payments the records do not: the records that account for them have
 * to be restored before any run is raised from a device.
 */
export const unaccountedRefusalHere = (
  period: string, found: { rounds: readonly string[]; payments: number; cannotSay: boolean },
): string =>
  `The chain holds ${unaccountedParts(found)} that this company's records cannot account for`
  + (found.cannotSay ? ', and it could not say which payments these records know about, so none is counted as known' : '')
  + `. They may be ${period}'s pay for the people on this run, and the chain refuses a second salary payment to the same `
  + 'person for the same month. A run drawn on a device names only the runs the company\'s records hold, so it cannot be '
  + 'confirmed as repeating these. Whoever keeps the company\'s records has to restore the copy that holds them before a '
  + 'run is raised.';

/** Why a raise is refused while the chain holds what these records cannot account for. */
export const unaccountedRefusal = (
  period: string, found: { rounds: readonly string[]; payments: number; cannotSay: boolean }, partlyRaised = false,
): string => {
  return `the chain holds ${unaccountedParts(found)} that this company's records cannot account for`
    + (found.cannotSay
      ? ', and it could not say which payments these records know about, so none is counted as known'
      : '')
    + `. They may be ${period}'s pay for the people on this run. The chain refuses a second salary `
    + 'payment to the same roster entry for the same month, but these records cannot say whose those '
    + 'are. Nothing was raised '
    + 'and no fee was spent. Whoever keeps this company\'s records has to restore the copy that holds '
    + 'them before this run is raised. If they are known to be for something else, '
    + (partlyRaised
      ? 'the people on this run who have no round yet have to be drawn up on a run of their own from the '
        + 'roster, and nobody else, with a confirmation that names every run already raised for '
      : 'the run has to be drawn up again from the roster with a confirmation that names every run '
        + 'already raised for ')
    + `${period}`
    + (found.rounds.length ? `, names ${found.rounds.join(', ')}` : '')
    + (found.payments ? `, and counts ${found.payments} payment ${found.payments === 1 ? 'entry' : 'entries'}` : '')
    + '. No screen takes that confirmation yet.';
};

/** The leg being raised now, for the receipts: what the payslip of each of its people is to name. */
export interface LegBeingRaised {
  readonly leg: RunLeg;
  readonly leaves: readonly Hex[];
  readonly closesAt: bigint;
  readonly company: string | null;
  readonly identity: RunIdentity;
  readonly records: readonly PayRecord[];
}

/**
 * **EACH PAYSLIP'S RECEIPT: THE PAYEE'S OWN NONCE AND BLINDING FOR EVERY LEG
 * RAISED, AND UNTIL WHEN THEY MAY BE PAID.** Worked out from the company's
 * payout seeds and pay-record key, for the legs the run has raised and the one
 * being raised now; a person on no raised leg gets a receipt naming no payment.
 */
export function receiptsOf(
  run: PayrollRun, seeds: readonly PayoutSeed[], payKey: Hex, raising: LegBeingRaised | undefined,
  now: { readonly company: string | null; readonly label: string | null },
): PayrollRun['payslips'] {
  const paidAt = new Map<string, { nonce: Hex; blinding: Hex; company: string | null; until: bigint }>();
  const legs = new Set<RunLeg>([
    ...(raising ? [raising.leg] : []), ...(Object.keys(run.payout ?? {}) as RunLeg[])]);
  for (const leg of legs) {
    const recorded = run.payout?.[leg];
    const mine = raising?.leg === leg;
    const leaves = mine ? raising.leaves : recorded?.leaves;
    const company = mine ? raising.company : recorded?.company;
    const closesAt = mine ? raising.closesAt : recorded?.closesAt;
    const identity: RunIdentity | undefined = mine
      ? raising.identity
      : recorded && { accountId: run.accountId, runId: recorded.runId, epoch: recorded.epoch };
    if (!leaves || leaves.length === 0 || company === undefined || closesAt === undefined
      || identity === undefined) continue;
    const records = mine ? raising.records : (recorded?.records ?? payRecordsOf(run, legEmployees(run, leg)));
    if (records.length !== leaves.length) continue;
    const secrets = runSecrets([...seeds], identity, { key: payKey, records: [...records] });
    const retries = (recorded?.retries ?? []).filter((r) => r.proposalId !== undefined);
    legEmployees(run, leg).forEach((e, i) => {
      const at = secrets[i];
      if (leaves[i] === undefined || at === undefined) return;
      const until = retries
        .filter((r) => r.originalIndices.includes(i))
        .reduce((latest, r) => (r.closesAt > latest ? r.closesAt : latest), closesAt);
      paidAt.set(e.id, { nonce: at.nonce, blinding: at.blinding, company, until });
    });
  }
  return run.payslips.map((p) => {
    const publicKey = p.sealedTo ?? run.employees.find((e) => e.id === p.employeeId)?.wrappingPublicKey;
    if (!publicKey) return p;
    const paid = paidAt.get(p.employeeId);
    return {
      ...p,
      receipt: paid === undefined
        ? sealReceipt(run.id, publicKey, now.company, null, now.label)
        : sealReceipt(run.id, publicKey, paid.company,
          { nonce: paid.nonce, blinding: paid.blinding, until: paid.until }, now.label),
    };
  });
}

/* ── A RETRY OF SOME OF A LEG'S PEOPLE ─────────────────────────────────────── */

/**
 * **A RETRY NAMES AT LEAST ONE PERSON ON THE LEG, EACH ONCE**, by their
 * position in the leg as it was raised.
 */
export function refuseARetryOfNobody(
  run: PayrollRun, leg: RunLeg, leaves: number, indices: readonly number[], registry: AssetRegistry = defaultAssets,
): void {
  if (indices.length === 0) throw new Error('a retry pays at least one person, and this one names nobody');
  const seen = new Set<number>();
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= leaves) {
      throw new Error(
        `the ${legName(leg, registry)} leg of run ${run.id} pays ${leaves} people; there is no `
        + `person ${i} on it to retry`);
    }
    if (seen.has(i)) throw new Error(`person ${i} is named twice on this retry`);
    seen.add(i);
  }
}

/** What a retry's material is, as far as these checks read it. */
export interface RetryMaterialRead {
  readonly run: { readonly root: Hex; readonly payees: bigint };
  readonly leaves: readonly Hex[];
  readonly identity: RunIdentity;
}

/**
 * **A RETRY IS RAISED OVER A TREE OF ITS OWN, OF ONLY THE PEOPLE IT NAMES, EACH
 * AT THE LEAF THE LEG GAVE THEM.** Built under the identity and the seed
 * generation the leg was raised under; its leaves the leg's own for exactly
 * the people named, in their order; its count theirs; its root the root over
 * those leaves alone. The leaf is the payment, so a retry over other leaves
 * would pay those people again, and one over the leg's whole tree would let an
 * approval of it pay anybody on the leg.
 */
export function refuseRetryMaterialThatIsNotItsPeople(
  run: PayrollRun, leg: RunLeg, indices: readonly number[], material: RetryMaterialRead,
  rootOf: (leaves: Hex[], facts: readonly PaymentFacts[], asset: string) => Hex,
): void {
  const recorded = run.payout?.[leg];
  if (recorded === undefined) throw new Error(`the leg of run ${run.id} this retry names has not been raised`);
  if (material.identity.accountId !== run.accountId
      || material.identity.runId !== recorded.runId
      || material.identity.epoch !== recorded.epoch) {
    throw new Error(
      `this retry was built under run ${material.identity.runId} at seed generation `
      + `${material.identity.epoch} for account ${material.identity.accountId}, and the leg it `
      + `retries was raised under ${recorded.runId} at generation ${recorded.epoch} for account `
      + `${run.accountId}. Nothing was raised. Prepare the retry again from run ${run.id} and `
      + 'send it.');
  }
  if (material.leaves.length !== indices.length
      || material.leaves.some((leaf, at) => leaf !== recorded.leaves[indices[at]!])) {
    throw new Error(
      'this retry\'s leaves are not the leaves the leg already holds for the people it names. '
      + 'The leaf is the payment - the same leaf is refused a second time and a different one is '
      + 'not - so a retry over different leaves would pay those people again.');
  }
  if (material.run.payees !== BigInt(indices.length)) {
    throw new Error(
      `a retry is raised over a tree of only the people it names, ${indices.length} here, and `
      + `this retry's material binds ${material.run.payees}. The count is part of what the signers approve.`);
  }
  if (rootOf([...material.leaves], indices.map((i) => recorded.facts[i]!), assetOfLeg(leg)) !== material.run.root) {
    throw new Error(
      'this retry\'s payout root is not the root over the leaves of the people it names, so what the signers '
      + 'would approve is not the proposal these people are in. Every payment against it would be '
      + 'refused, after the signatures were collected and the fee was spent.');
  }
}

/** A proposal of the company's, as a retry's checks read where it stands. */
export interface ProposalStandingRead { readonly status: string; readonly raisedAt?: string; readonly txRef?: string }

/**
 * **A RETRY NAMES ONLY PEOPLE THE RUN MEANT TO PAY AND NOTHING ELSE CAN STILL
 * PAY.** Refused, never narrowed, when it names somebody a decision on record
 * says not to pay; while the leg's own round can still pay everybody on it;
 * when somebody it names is on another retry that can still pay them, or that
 * was written down or sent and not yet seen. `standingOf` reads a proposal of
 * the company's by its name; `legRounds` are the rounds written down for this
 * run's leg; `again` is a retry of exactly these people being raised again as
 * itself. Whether the chain has paid them is asked where the chain is read.
 */
/**
 * **NOBODY A ROUND PAYS IS SOMEBODY THE RUN RECORDS A DECISION NOT TO PAY.**
 * `indices` are positions on the leg; `notToPay` the roster entries the run's
 * own record of decisions says not to pay.
 */
export function refusePeopleDecidedNotToPay(
  run: PayrollRun, leg: RunLeg, indices: readonly number[], notToPay: ReadonlySet<string>,
): void {
  const onTheLeg = legEmployees(run, leg);
  const marked = indices.filter((i) => onTheLeg[i] !== undefined && notToPay.has(onTheLeg[i]!.id));
  if (marked.length === 0) return;
  const people = `#${[...marked].sort((a, b) => a - b).map((i) => i + 1).join(', #')}`;
  throw new Error(
    `${people} ${marked.length === 1 ? 'is' : 'are'} marked on run ${run.id} as not to be paid, by a decision on record. A retry `
    + 'pays only people the run meant to pay, so none was raised. Nothing was written down.');
}

export function refuseARetryOverPeopleCovered(input: {
  readonly run: PayrollRun; readonly leg: RunLeg; readonly legRound: ProposalStandingRead;
  readonly indices: readonly number[];
  readonly standingOf: (proposalId: string) => ProposalStandingRead;
  readonly legRounds: ReadonlyArray<RoundOfARun & { readonly raisedAt?: string }>;
  readonly again: string | undefined; readonly nowInSeconds: bigint;
  readonly notToPay: ReadonlySet<string>;
  readonly registry?: AssetRegistry;
}): void {
  const { run, leg, indices, nowInSeconds } = input;
  const registry = input.registry ?? defaultAssets;
  const recorded = run.payout![leg]!;
  const people = (xs: readonly number[]) => `#${[...xs].sort((a, b) => a - b).map((i) => i + 1).join(', #')}`;
  const isAre = (xs: readonly number[]) => (xs.length === 1 ? 'is' : 'are');
  const when = (s: bigint) => `${new Date(Number(s) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const named = new Set(indices);
  const stopped = (p: ProposalStandingRead) => p.status === 'cancelled' || p.status === 'blocked';

  refusePeopleDecidedNotToPay(run, leg, indices, input.notToPay);
  if (!stopped(input.legRound) && nowInSeconds < recorded.closesAt) {
    throw new Error(
      `the ${legName(leg, registry)} leg of run ${run.id} can still pay everybody on it until ${when(recorded.closesAt)}, when its `
      + 'window closes. A retry now would be a second round over the same people. Retry whoever it has not paid '
      + 'once its window has closed. Nothing was written down.');
  }
  for (const r of recorded.retries ?? []) {
    if (r.proposalId === undefined || nowInSeconds >= r.closesAt) continue;
    const round = input.standingOf(r.proposalId);
    if (stopped(round)) continue;
    const shared = r.originalIndices.filter((i) => named.has(i));
    if (shared.length === 0) continue;
    const until = when(r.closesAt);
    throw new Error(
      `${people(shared)} ${isAre(shared)} already on retry ${r.proposalId} of the ${legName(leg, registry)} leg of run ${run.id}, `
      + (round.raisedAt
        ? `which can still pay them until ${until}. Retry them once its window has closed.`
        : round.txRef
          ? `which was sent from a device and is not yet seen on chain. Send it again by retrying exactly `
            + `${people(r.originalIndices)} with its window and vault, or retry them once its window closes at ${until}.`
          : `which is written down and has not been sent. Send it by retrying exactly ${people(r.originalIndices)} `
            + `with its window and vault, or retry them once its window closes at ${until}.`)
      + ' Nothing was written down.');
  }
  const legRounds = input.legRounds.filter((r) => r.runId === run.id && legOfRound(r as never) === leg);
  for (const { round: r, people: onIt, closesAt } of untoldRetryRounds(recorded.retries ?? [], legRounds as never, nowInSeconds, input.again)) {
    const shared = onIt.filter((i) => named.has(i));
    if (shared.length === 0) continue;
    throw new Error(
      `${people(shared)} ${isAre(shared)} on retry ${(r as { id: string }).id} of the ${legName(leg, registry)} leg of run ${run.id}, whose raise did not `
      + 'answer and which may be on chain. Retry exactly '
      + `${people(onIt)} again with its window and vault to send it as itself`
      + (closesAt !== undefined ? `, or retry them once its window closes at ${when(closesAt)}.` : '.')
      + ' Nothing was written down.');
  }
}
