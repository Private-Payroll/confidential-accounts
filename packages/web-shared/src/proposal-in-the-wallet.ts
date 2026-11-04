/*
 * APPROVING AND WITHDRAWING A PROPOSAL FROM THE PAGE, AND RAISING A RUN OR A ONE-OFF PAYMENT: the approve-proposal,
 * withdraw-proposal, raise-run and one-off-payment actions asked of the person's wallet, as every action on a company is
 * (`actOnACompanyInTheWallet`). What the page read of the proposal for
 * the wallet to show and check is handed on as the action carries it, a count or an amount as a whole number in decimal;
 * the wallet opens the proposal itself and refuses one that says otherwise.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import { actOnACompanyInTheWallet } from './keyring.js';
import { walletInThisPage } from './wallet-frame.js';
import type { Openable } from './wallet-sign-in.js';
import type { ActOutcome } from './wallet-act.js';

/** The two acts the page asks of the wallet on a proposal, by the names the wallet registers them under. */
export const PROPOSAL_ACT = { approve: 'approve-proposal', withdraw: 'withdraw-proposal' } as const;
export type ProposalAct = (typeof PROPOSAL_ACT)[keyof typeof PROPOSAL_ACT];

/** The wallet's name for each kind of proposal, by the kind the page lists it as. A change of policy is one of two, named by its asks. */
export const WALLET_KIND: Readonly<Record<string, string>> = {
  transfer: 'one-off', payroll: 'payroll', 'add-signer': 'add-signer', 'remove-signer': 'removal', 'set-threshold': 'threshold',
  'set-vault-threshold': 'vault-threshold', 'adopt-vault': 'adopt-vault', 'vault-secret': 'vault-secret', 'pay-key': 'pay-key',
};
/** The wallet's names for the two changes of policy. */
export const POLICY_KINDS: ReadonlySet<string> = new Set(['spending-policy', 'policy-bar']);
/** The field a change of policy says which change it is under: sent to the wallet as the kind, never among the fields. */
export const KIND_FIELD = 'kind';
/** The kinds the wallet never withdraws: it refuses them in its own words. */
export const NEVER_WITHDRAWN: ReadonlySet<string> = new Set(['pay-key', 'adopt-vault', 'vault-secret', 'change-policy']);

/** Why the wallet stopped an act on a proposal, as a page names it. */
export const PROPOSAL_WHY = {
  seat: 'seat', notAProposal: 'not-a-proposal', notApproved: 'not-approved', alreadyCounted: 'already-counted', carriedOut: 'carried-out',
  withdrawn: 'withdrawn', mayBeSent: 'may-be-sent', notAsShown: 'not-as-shown', oneOffHeld: 'one-off-held', notWithdrawn: 'not-withdrawn',
  closed: 'closed', notRaised: 'not-raised', outrun: 'outrun', stopped: 'stopped', other: 'other',
} as const;
export type ProposalWhy = (typeof PROPOSAL_WHY)[keyof typeof PROPOSAL_WHY];
const WHY = PROPOSAL_WHY;


/** The wallet's act that pays an approved run's leg from its vault: its own reasons for stopping are listed beside the proposal acts'. */
const PAY_RUN = 'pay-run';


/** Why paying a leg stopped, beyond the reasons it shares with the proposal acts: each is a code the wallet's pay-run act answers with. */
export const PAY_RUN_WHY = {
  notOpenYet: 'not-open-yet', windowClosed: 'window-closed', stopped: 'pay-stopped', stoppedUnseen: 'pay-stopped-unseen', notPaid: 'not-paid',
  notAsBuilt: 'payment-not-as-built', notPayable: 'not-payable',
} as const;
export type PayRunWhy = ProposalWhy | (typeof PAY_RUN_WHY)[keyof typeof PAY_RUN_WHY];

/** The wallet's refusals of either act that say this device cannot act for the company. */
const SEAT = ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened'];

const byPayReason = (groups: Readonly<Partial<Record<PayRunWhy, readonly string[]>>>): Readonly<Record<string, PayRunWhy>> =>
  Object.fromEntries(Object.entries(groups).flatMap(([why, codes]) => (codes ?? []).map((c) => [c, why as PayRunWhy])));

const byReason = (groups: Readonly<Partial<Record<ProposalWhy, readonly string[]>>>): Readonly<Record<string, ProposalWhy>> =>
  Object.fromEntries(Object.entries(groups).flatMap(([why, codes]) => (codes ?? []).map((c) => [c, why as ProposalWhy])));

/**
 * The wallet's refusal codes for each act, each to the page's reason for it, whichever of the act or the proposal's kind
 * the wallet refused under: a kind refuses under its own name, with the same code for the same reason. Only the codes
 * under `may-be-sent` say part of it went; every other one is a refusal that sent nothing.
 */
const REFUSED: Readonly<Record<ProposalAct, Readonly<Record<string, ProposalWhy>>>> & { readonly [PAY_RUN]: Readonly<Record<string, PayRunWhy>> } = {
  [PROPOSAL_ACT.approve]: byReason({
    [WHY.seat]: SEAT,
    [WHY.notAProposal]: [
      'not-a-proposal', 'not-a-run', 'not-a-threshold', 'not-a-removal', 'not-a-policy', 'not-a-bar', 'not-a-vault', 'not-a-pay-key',
      'not-a-one-off', 'not-a-payment', 'not-a-currency', 'not-a-known-currency', 'nothing', 'payee',
    ],
    [WHY.notAsShown]: ['not-as-shown', 'not-as-held'],
    [WHY.notApproved]: ['not-approved', 'refused', 'not-found', 'cannot-show', 'not-read'],
    [WHY.alreadyCounted]: ['already-counted', 'run-already-counted'],
    [WHY.carriedOut]: ['carried-out'],
    [WHY.closed]: ['closed', 'run-closed'],
    [WHY.withdrawn]: ['withdrawn'],
    [WHY.notRaised]: ['not-raised', 'run-not-raised'],
    [WHY.outrun]: ['outrun'],
    [WHY.mayBeSent]: [
      'may-be-sent', 'approval-may-be-sent', 'raise-may-be-sent', 'charge-may-be-sent', 'raise-not-seen', 'not-carried', 'not-charged',
      'charge-not-seen', 'not-paid', 'payment-not-seen', 'payment-not-recorded', 'payment-on-its-way',
    ],
  }),
  [PROPOSAL_ACT.withdraw]: byReason({
    [WHY.seat]: SEAT,
    [WHY.notAProposal]: ['not-a-proposal'],
    [WHY.notAsShown]: ['not-as-shown'],
    [WHY.oneOffHeld]: ['one-off-held'],
    [WHY.closed]: ['closed'],
    [WHY.notWithdrawn]: [
      'not-withdrawn', 'started', 'started-charged', 'started-may-be-paid', 'clock-ahead', 'sent-not-yet-seen', 'filed-by-another',
      'not-raised-here', 'raiser-not-read', 'chain-time-not-read', 'may-still-land', 'retirement-filed', 'never-adopt-vault',
      'never-pay-key', 'never-recovery', 'never-vault-secret',
    ],
    [WHY.mayBeSent]: ['may-be-sent'],
  }),
  [PAY_RUN]: byPayReason({
    [WHY.seat]: SEAT,
    [WHY.notAProposal]: ['not-a-run'],
    [WHY.notAsShown]: ['not-as-shown'],
    [WHY.notRaised]: ['not-raised'],
    [WHY.closed]: ['closed'],
    [WHY.withdrawn]: ['withdrawn'],
    [PAY_RUN_WHY.notOpenYet]: ['not-open-yet'],
    [PAY_RUN_WHY.windowClosed]: ['window-closed'],
    [PAY_RUN_WHY.notPayable]: ['not-payable'],
    [PAY_RUN_WHY.stopped]: ['stopped'],
    [PAY_RUN_WHY.stoppedUnseen]: ['stopped-unseen'],
    [PAY_RUN_WHY.notAsBuilt]: ['payment-not-as-built'],
    [PAY_RUN_WHY.notPaid]: ['not-paid', 'not-charged'],
    [WHY.mayBeSent]: ['may-be-sent', 'charge-not-seen', 'payment-not-seen', 'payment-not-recorded', 'payment-on-its-way'],
  }),
};

const KEY = /^act\.[a-z-]+\.why\.([a-z-]+)$/u;

/** The reason the wallet stopped an act for (the key of its words, `refused`), as a page names it: none is `stopped`, and a code the act does not name is `other`. */
export function proposalWhyOf(act: ProposalAct, refused: string | undefined): ProposalWhy {
  if (refused === undefined) return WHY.stopped;
  const code = KEY.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(REFUSED[act], code) ? REFUSED[act][code]! : WHY.other;
}

/** Whether the wallet says part of the act may already have gone, so that pressing the same button again is how to carry on. */
export const partlySent = (why: ProposalWhy): boolean => why === WHY.mayBeSent;


/** The reason a stop of the pay-run act came to, from the code the wallet gave: `stopped` where it gave none, `other` for one not listed. */
export function payRunWhyOf(refused: string | undefined): PayRunWhy {
  if (refused === undefined) return WHY.stopped;
  const code = KEY.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(REFUSED[PAY_RUN], code) ? REFUSED[PAY_RUN][code]! : WHY.other;
}

/** Whether a stop of the pay-run act may have paid some people or left a payment landing, so that paying again carries on and pays nobody twice. */
export const payRunPartlyPaid = (why: PayRunWhy): boolean =>
  why === WHY.mayBeSent || why === PAY_RUN_WHY.stopped || why === PAY_RUN_WHY.stoppedUnseen || why === PAY_RUN_WHY.notAsBuilt;

/** How an act on a proposal ended, as the page tells it. */
export const PROPOSAL_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused' } as const;

/* The wallet tells a count as a number; anything else is no count. */
const count = (v: string | number | undefined): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** What the wallet told the page when an act on a proposal ended: where the proposal stands, and its count and bar as the chain holds them. */
export function proposalOutcomeOf(ended: ActOutcome): { readonly state: string | null; readonly approvals: number | null; readonly needed: number | null } {
  const state = ended.outcome?.['state'];
  return { state: typeof state === 'string' ? state : null, approvals: count(ended.outcome?.['approvals']), needed: count(ended.outcome?.['needed']) };
}

/** What the page read of a proposal for the wallet to show and check, under the names the wallet reads them by. */
export type ProposalAsked = Readonly<Record<string, string | number | bigint>>;

/** One act on one proposal, as the page names it: the wallet's name for the act, the company, the proposal and the wallet's name for its kind. */
interface ProposalActAsk {
  readonly act: ProposalAct; readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
  readonly proposal: string; readonly kind: string; readonly asked?: ProposalAsked;
}

/**
 * **ASKS THE PERSON'S WALLET TO ACT ON ONE PROPOSAL**, over one window. What was read for the wallet goes first, so no
 * field of it can stand in for the act, the company, the proposal or its kind. Resolves with how the action ended.
 */
export function proposalActInTheWallet(
  ask: ProposalActAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  const carried = Object.fromEntries(Object.entries(ask.asked ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : v.toString()]));
  return actOnACompanyInTheWallet({
    ...carried, name: ask.act, record: ask.record, company: ask.company, account: ask.account, proposal: ask.proposal, kind: ask.kind,
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}


/** The wallet's name for the act that changes the approvals the company's account needs, and the reason it gives when its own check of every vault refuses the number. */
const CHANGE_THRESHOLD = 'change-threshold';
const CHANGE_THRESHOLD_REFUSED = `act.${CHANGE_THRESHOLD}.why.refused`;

/** How a change of the approvals needed ended when it is not an act on a proposal: the page saw the number was wrong before asking, or the wallet refused it. */
export const THRESHOLD_ENDED = { problem: 'problem', walletRefused: 'wallet-refused' } as const;

/** What the page can see is wrong with a number before it asks: not a whole number of at least one, more than the signers seated, the one in force already, or the counts it needs unread. */
export const THRESHOLD_PROBLEM = { notWhole: 'not-whole', tooHigh: 'too-high', same: 'same', unread: 'unread' } as const;
export type ThresholdProblem = (typeof THRESHOLD_PROBLEM)[keyof typeof THRESHOLD_PROBLEM];

/** What the page has read: the approvals the company asks for now and the signers its account seats; null while unread. */
export interface ThresholdKnown { readonly now: number | null; readonly seated: number | null }

/**
 * The refusals the wallet would make that the page can see for itself from the counts it has read, so a number the wallet would
 * refuse never opens its window. The wallet checks again, with every vault, and is the one that decides.
 */
export function thresholdProblem(wanted: number, known: ThresholdKnown): { readonly problem: ThresholdProblem; readonly most?: number } | null {
  if (!Number.isSafeInteger(wanted) || wanted < 1) return { problem: THRESHOLD_PROBLEM.notWhole };
  if (known.now === null || known.seated === null) return { problem: THRESHOLD_PROBLEM.unread };
  if (wanted > known.seated) return { problem: THRESHOLD_PROBLEM.tooHigh, most: known.seated };
  if (wanted === known.now) return { problem: THRESHOLD_PROBLEM.same };
  return null;
}

/** Whether the wallet stopped because its own check of every vault refused the number. */
export const refusedTheNumber = (ended: ActOutcome): boolean => ended.of === 'stopped' && ended.refused === CHANGE_THRESHOLD_REFUSED;

/**
 * **ASKS THE PERSON'S WALLET TO CHANGE THE APPROVALS THE COMPANY'S ACCOUNT NEEDS** to `threshold`, or with `vault` the approvals
 * that one vault's runs need, over one window. The wallet checks, from the chain and the company's records, that the chain would
 * carry it out and that every vault keeps enough signers who may approve its runs; then raises the change, and carries it out
 * once the chain counts its approvals.
 */
export function changeThresholdInTheWallet(
  ask: { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress; readonly threshold: number; readonly vault?: string },
  walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: CHANGE_THRESHOLD, record: ask.record, company: ask.company, account: ask.account, threshold: ask.threshold.toString(),
    ...(ask.vault === undefined ? {} : { vault: ask.vault }),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}


/** The forms a run's leg is paid in, as a run keys them, and the lists a run pays: what the page compares and the wallet is told. */
export const RUN_FORM = { shielded: 'shielded', unshielded: 'unshielded' } as const;
export const RUN_LIST = { employees: 'employees', vendors: 'vendors' } as const;
export type RunForm = (typeof RUN_FORM)[keyof typeof RUN_FORM];
export type RunList = (typeof RUN_LIST)[keyof typeof RUN_LIST];

/** The people paid, still owed and possibly still landing, as the wallet's pay-run act tells them (null where it did not). */
export function payRunCountsOf(ended: ActOutcome): { readonly paid: number | null; readonly owed: number | null; readonly unseen: number | null } {
  return { paid: count(ended.outcome?.['paid']), owed: count(ended.outcome?.['owed']), unseen: count(ended.outcome?.['unseen']) };
}

/** The leg of a run the page shows, as the pay-run act takes it: the wallet compares each of these with the run it opens, and pays nothing unless they agree. */
interface PayRunAsk {
  readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
  readonly proposal: string; readonly run: string; readonly period: string; readonly list: RunList;
  readonly vault: string; readonly token: string; readonly form: RunForm; readonly payees: number; readonly total: bigint;
}

/**
 * **ASKS THE PERSON'S WALLET TO PAY AN APPROVED RUN'S LEG** from its vault, over one window: the one leg the page shows, by its
 * proposal, run, month, list, vault, token, form, number of people and total. The wallet opens the proposal and its run and
 * pays nothing unless they are exactly what was asked, the network holds the proposal open at its approvals and its payment
 * window is open now; it then pays each person the network does not show paid.
 */
export function payRunInTheWallet(
  ask: PayRunAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: PAY_RUN, record: ask.record, company: ask.company, account: ask.account, proposal: ask.proposal, run: ask.run, period: ask.period,
    list: ask.list, vault: ask.vault, token: ask.token, form: ask.form === RUN_FORM.shielded ? 'private' : 'public', payees: ask.payees.toString(), total: ask.total.toString(),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}

const RAISE_RUN = 'raise-run';

/** What is wrong with a payment window the person typed, and what a reading of it is: a window given, or a problem. */
export const WINDOW_PROBLEM = { missing: 'missing', past: 'past', order: 'order' } as const;
export type WindowProblem = (typeof WINDOW_PROBLEM)[keyof typeof WINDOW_PROBLEM];
export const WINDOW_OF = { given: 'given', problem: 'problem' } as const;

/** Why the wallet stopped a run it was asked to raise, as a page names it. */
export const RAISE_RUN_WHY = {
  seat: 'seat', notARun: 'not-a-run', paymentTime: 'window', notAsShown: 'not-as-shown', notRaised: 'not-raised', mayBeSent: 'may-be-sent', stopped: 'stopped', other: 'other',
} as const;
export type RaiseRunWhy = (typeof RAISE_RUN_WHY)[keyof typeof RAISE_RUN_WHY];

const RAISE_RUN_REFUSED: Readonly<Record<string, RaiseRunWhy>> = {
  ...Object.fromEntries(SEAT.map((c) => [c, RAISE_RUN_WHY.seat])),
  'not-a-run': RAISE_RUN_WHY.notARun, 'no-window': RAISE_RUN_WHY.paymentTime, 'window-open': RAISE_RUN_WHY.paymentTime,
  'not-as-shown': RAISE_RUN_WHY.notAsShown, 'not-raised': RAISE_RUN_WHY.notRaised, 'raise-may-be-sent': RAISE_RUN_WHY.mayBeSent,
};

/** The page's word for why the wallet stopped a run it was asked to raise; a stop the wallet gave no reason for is `stopped`, one it gave an unknown reason for is `other`. */
export function raiseRunWhyOf(refused: string | undefined): RaiseRunWhy {
  if (refused === undefined) return RAISE_RUN_WHY.stopped;
  const code = KEY.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(RAISE_RUN_REFUSED, code) ? RAISE_RUN_REFUSED[code]! : RAISE_RUN_WHY.other;
}

/** What names a run for the wallet to draw: the month, whom it pays, the vault, the currency and the form, and the window it may be paid in. It names no people and no total: the wallet draws and shows those itself. */
interface RaiseRunAsk {
  readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
  readonly period: string; readonly list: RunList; readonly vault: string; readonly token: string; readonly form: RunForm;
  readonly opensAt: bigint; readonly closesAt: bigint;
}

/**
 * **ASKS THE PERSON'S WALLET TO DRAW AND RAISE A PAYROLL RUN** for one month, list, vault, currency and form, over one payment window.
 * The ask names no run, no people and no total: the wallet draws the run, shows its people and total, and raises it only when the
 * person confirms there.
 */
export function raiseRunInTheWallet(
  ask: RaiseRunAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: RAISE_RUN, record: ask.record, company: ask.company, account: ask.account, period: ask.period, list: ask.list, vault: ask.vault,
    token: ask.token, form: ask.form === RUN_FORM.shielded ? 'private' : 'public', opensAt: ask.opensAt.toString(), closesAt: ask.closesAt.toString(),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}

/**
 * What names a retry of some of a run's people for the wallet: the run, its month, whom it pays, the vault, currency and form of the
 * leg, the places of the people in the leg's leaves, how many they are and what they are paid in all (the wallet checks both against
 * the run's own record and refuses a retry that pays other people or another total), and the window the retry may be paid in.
 */
interface RetryRunAsk {
  readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
  readonly run: string; readonly period: string; readonly list: RunList; readonly vault: string; readonly token: string; readonly form: RunForm;
  readonly indices: readonly number[]; readonly total: bigint; readonly opensAt: bigint; readonly closesAt: bigint;
}

/**
 * **ASKS THE PERSON'S WALLET TO RAISE A RETRY** of the people of one leg of a run the chain shows unpaid, over a window the person gave.
 * The wallet opens the run, refuses a retry of a leg that can still pay them or of people already on another retry, shows the people
 * and the total, and raises only when the person confirms there.
 */
export function retryRunInTheWallet(
  ask: RetryRunAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: RAISE_RUN, record: ask.record, company: ask.company, account: ask.account, run: ask.run, period: ask.period, list: ask.list, vault: ask.vault,
    token: ask.token, form: ask.form === RUN_FORM.shielded ? 'private' : 'public', payees: ask.indices.length.toString(), total: ask.total.toString(),
    indices: ask.indices.join(','), opensAt: ask.opensAt.toString(), closesAt: ask.closesAt.toString(),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}

const ONE_OFF = 'one-off-payment';

interface OneOffAsk {
  readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress;
  readonly vault: string; readonly token: string; readonly amount: bigint; readonly payee: string; readonly reason: string;
  /** A name the person gives a payee typed as an address; a vendor's own name is the wallet's to read from the vendor list. */
  readonly payeeName?: string;
  /** The vendor entry the payee is, when the person chose one: the wallet checks the address against that entry's. */
  readonly vendor?: string;
}

/**
 * Raising a one-off payment asks the wallet to propose it from exactly what the person gave: the vault it leaves, the currency, the
 * amount as a whole number of the currency's smallest unit, the address (whose kind, private or public, decides how the wallet pays it),
 * the reason, and the vendor entry or the name when there is one. The wallet validates every field again, draws the payment's window
 * itself, and raises it; it carries the payment out as well when this seat's approval is all the vault needs.
 */
export function oneOffInTheWallet(
  ask: OneOffAsk, walletOrigin: string, opts: { readonly onStep?: (at: StepAt) => void } = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: ONE_OFF, record: ask.record, company: ask.company, account: ask.account, vault: ask.vault, token: ask.token, amount: ask.amount.toString(),
    payee: ask.payee, reason: ask.reason,
    ...(ask.payeeName === undefined ? {} : { payeeName: ask.payeeName }), ...(ask.vendor === undefined ? {} : { vendor: ask.vendor }),
  }, walletOrigin, { ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }) }, view);
}
