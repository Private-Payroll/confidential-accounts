import { NETWORK } from 'midnight-identity/network';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { checkShieldedAddress, checkUnshieldedAddress } from 'midnight-identity/wallet/address-shape';
import { assets, parseAmount, type Asset, type AssetRegistry } from '../../../../src/core/assets.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import {
  changeThresholdInTheWallet, KIND_FIELD, oneOffInTheWallet, partlySent, PAY_RUN_WHY, payRunInTheWallet, payRunPartlyPaid, payRunWhyOf, PROPOSAL_ACT,
  payRunCountsOf, PROPOSAL_ACTED, PROPOSAL_WHY, proposalActInTheWallet, proposalOutcomeOf, proposalWhyOf, RAISE_RUN_WHY, raiseRunInTheWallet, raiseRunWhyOf, refusedTheNumber, retryRunInTheWallet, RUN_FORM, RUN_LIST, THRESHOLD_ENDED, WINDOW_OF, WINDOW_PROBLEM, THRESHOLD_PROBLEM, thresholdProblem,
  type PayRunWhy, type WindowProblem, type ProposalAct, type RaiseRunWhy, type ProposalWhy, type RunForm, type RunList, type ThresholdKnown, type ThresholdProblem,
} from 'vaults-web-shared/proposal-in-the-wallet.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import { canApprove, canPay, canWithdraw, oneOffLegOf, walletKindOf, type ProposalAsks, type ProposalRow, type RunLeg } from './company-records.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';

/*
 * THE PROPOSALS ADAPTER'S WALLET ACTS, APPROVE, WITHDRAW, CHANGE THE APPROVALS NEEDED, PAY A RUN'S LEG, RAISE A RUN OR ITS RETRY AND
 * RAISE A ONE-OFF PAYMENT: which rows are offered each, what the wallet is asked, and what its stops come to. The wallet's names for the acts, the kinds and its refusals are the shared code's
 * (`proposal-in-the-wallet.ts`); a screen is handed codes, never words.
 */
export { canApprove, canPay, canWithdraw, PAY_RUN_WHY, PROPOSAL_ACT, PROPOSAL_ACTED, PROPOSAL_WHY as WHY, RAISE_RUN_WHY, RUN_FORM, RUN_LIST, type PayRunWhy, type ProposalWhy, type RaiseRunWhy, type RunForm, type RunList, type WindowProblem, WINDOW_OF, WINDOW_PROBLEM };

/** An act the wallet was never asked, or whose answer could not be read: the one ending every act shares, whatever else the act returns. */
export type ActRefused = { readonly of: typeof PROPOSAL_ACTED.refused; readonly why: ActRefusal };

export type ProposalActed =
  | { readonly of: typeof PROPOSAL_ACTED.done; readonly state: string | null; readonly approvals: number | null; readonly needed: number | null }
  | { readonly of: typeof PROPOSAL_ACTED.stopped; readonly act: ProposalAct; readonly why: ProposalWhy; readonly partial: boolean; readonly handedOver: boolean }
  | ActRefused;

const refused = (why: ActRefusal): ActRefused => ({ of: PROPOSAL_ACTED.refused, why });

/**
 * How an act ended: done, with where the chain holds the proposal after it; or stopped, with the wallet's reason, whether
 * the wallet says part of it may have gone (`partial`), and whether it handed any transaction over to be sent.
 */
function actedOf(act: ProposalAct, ended: ActOutcome): ProposalActed {
  if (ended.of === PROPOSAL_ACTED.done) return { of: PROPOSAL_ACTED.done, ...proposalOutcomeOf(ended) };
  const why = proposalWhyOf(act, ended.refused);
  return { of: PROPOSAL_ACTED.stopped, act, why, partial: partlySent(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}


async function namedBefore(personId: string, companyId: string): Promise<{ record: string; company: CompanyLabel; account: AccountAddress } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}


/** What the row carries for the wallet to show, without the name of the kind, which is sent on its own. */
const approvalFields = (row: ProposalRow): ProposalAsks => Object.fromEntries(Object.entries(row.asks ?? {}).filter(([k]) => k !== KIND_FIELD));

async function ask(
  act: ProposalAct, personId: string, companyId: string, row: ProposalRow, onStep?: (step: number, steps: number) => void,
): Promise<ProposalActed> {
  try {
    const kind = walletKindOf(row);
    if (kind === undefined) return refused(ACT_REFUSAL.didNotFinish);
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await proposalActInTheWallet({ act, ...named, proposal: row.id, kind, ...(act === PROPOSAL_ACT.approve ? { asked: approvalFields(row) } : {}) },
      ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(act, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** Ask the person's wallet to approve this proposal, by its id and kind. Nothing is asked of a row the list does not offer Approve on. */
export function approveProposal(
  personId: string, companyId: string, row: ProposalRow, onStep?: (step: number, steps: number) => void,
): Promise<ProposalActed> {
  return canApprove(row) ? ask(PROPOSAL_ACT.approve, personId, companyId, row, onStep) : Promise.resolve(refused(ACT_REFUSAL.didNotFinish));
}


/** Ask the person's wallet to withdraw this proposal, by its id and kind. The wallet decides who may; the list only offers it to those it expects. */
export function withdrawProposal(
  personId: string, companyId: string, row: ProposalRow, onStep?: (step: number, steps: number) => void,
): Promise<ProposalActed> {
  return ask(PROPOSAL_ACT.withdraw, personId, companyId, row, onStep);
}


export const THRESHOLD_ACTED = { ...PROPOSAL_ACTED, ...THRESHOLD_ENDED } as const;
export { THRESHOLD_PROBLEM, type ThresholdProblem };

export type ThresholdActed =
  | ProposalActed
  | { readonly of: typeof THRESHOLD_ACTED.problem; readonly problem: ThresholdProblem; readonly most?: number }
  | { readonly of: typeof THRESHOLD_ACTED.walletRefused };

/**
 * Ask the person's wallet to change the approvals the company's account needs to `wanted`, or with `vault` the approvals that
 * vault's runs need (`known.now` is then that vault's number). A number the page can see the
 * wallet would refuse is told back without opening the wallet. A raise stops for the reasons an approval does: those are
 * the ones the shared code lists for the wallet's reasons under this act's name.
 */
export async function changeThreshold(
  personId: string, companyId: string, wanted: number, known: ThresholdKnown, onStep?: (step: number, steps: number) => void, vault?: string,
): Promise<ThresholdActed> {
  const wrong = thresholdProblem(wanted, known);
  if (wrong !== null) return { of: THRESHOLD_ACTED.problem, ...wrong };
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await changeThresholdInTheWallet({ ...named, threshold: wanted, ...(vault === undefined ? {} : { vault }) }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return refusedTheNumber(ended) ? { of: THRESHOLD_ACTED.walletRefused } : actedOf(PROPOSAL_ACT.approve, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** The leg of a run the page shows, as the wallet's pay-run act is asked to pay it. `form` is the leg's own (`shielded` pays privately). */
interface PayRunLeg {
  readonly proposal: string; readonly run: string; readonly period: string; readonly list: RunList; readonly vault: string;
  readonly token: string; readonly form: RunForm | null; readonly payees: number; readonly total: bigint;
}

/** Where a pay-run came to, with the people paid, still owed and possibly still landing where the wallet told them (null where it did not). */
export type PayRunActed =
  | { readonly of: typeof PROPOSAL_ACTED.done; readonly state: string | null; readonly paid: number | null; readonly owed: number | null; readonly unseen: number | null }
  | {
    readonly of: typeof PROPOSAL_ACTED.stopped; readonly why: PayRunWhy; readonly partial: boolean; readonly handedOver: boolean;
    readonly paid: number | null; readonly owed: number | null; readonly unseen: number | null;
  }
  | ActRefused;


/**
 * Ask the person's wallet to pay one leg of an approved run, once. The page refuses before any wallet window what it can see the
 * wallet would refuse (no people, no total above nothing, no month, a leg keyed before a run paid one form). What it asks is
 * what the run shows; the wallet compares the people and the total with its own count of the run and pays nothing if they differ.
 */
export async function payRun(
  personId: string, companyId: string, leg: PayRunLeg, onStep?: (step: number, steps: number) => void,
): Promise<PayRunActed> {
  if (leg.form === null || leg.proposal === '' || leg.run === '' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/u.test(leg.period)
    || !Number.isSafeInteger(leg.payees) || leg.payees < 1 || leg.total < 1n) return refused(ACT_REFUSAL.didNotFinish);
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await payRunInTheWallet({
      ...named, proposal: leg.proposal, run: leg.run, period: leg.period, list: leg.list, vault: leg.vault, token: leg.token, form: leg.form, payees: leg.payees, total: leg.total,
    }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    if (ended.of === PROPOSAL_ACTED.done) return { of: PROPOSAL_ACTED.done, state: proposalOutcomeOf(ended).state, ...payRunCountsOf(ended) };
    const why = payRunWhyOf(ended.refused);
    return { of: PROPOSAL_ACTED.stopped, why, partial: payRunPartlyPaid(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0, ...payRunCountsOf(ended) };
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** What names a run for the wallet to draw: the page passes no people and no total. */
interface RunToRaise {
  readonly period: string; readonly list: RunList; readonly vault: string; readonly token: string; readonly form: RunForm;
  /** When payments open and close, in seconds since the epoch, as the person gave them. */
  readonly opensAt: bigint; readonly closesAt: bigint;
}


/**
 * The payment window the person typed, each end as a local date and time, in the wallet's units (seconds since the epoch). There is no
 * default: an end not filled in is `missing`, an opening at or before `nowMs` is `past`, and a closing at or before the opening is `order`.
 */
export function paymentWindow(
  opens: string, closes: string, nowMs: number,
): { readonly of: typeof WINDOW_OF.given; readonly opensAt: bigint; readonly closesAt: bigint } | { readonly of: typeof WINDOW_OF.problem; readonly problem: WindowProblem } {
  const from = opens === '' ? NaN : new Date(opens).getTime();
  const to = closes === '' ? NaN : new Date(closes).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return { of: WINDOW_OF.problem, problem: WINDOW_PROBLEM.missing };
  const opensAt = BigInt(Math.floor(from / 1000));
  const closesAt = BigInt(Math.floor(to / 1000));
  if (opensAt <= BigInt(Math.floor(nowMs / 1000))) return { of: WINDOW_OF.problem, problem: WINDOW_PROBLEM.past };
  if (closesAt <= opensAt) return { of: WINDOW_OF.problem, problem: WINDOW_PROBLEM.order };
  return { of: WINDOW_OF.given, opensAt, closesAt };
}

export type RaiseRunActed =
  | { readonly of: typeof PROPOSAL_ACTED.done; readonly state: string | null; readonly approvals: number | null; readonly needed: number | null }
  | { readonly of: typeof PROPOSAL_ACTED.stopped; readonly why: RaiseRunWhy; readonly handedOver: boolean }
  | ActRefused;

/** The currencies a run can be paid in, as the company's pay can be. */
export const runCurrencies = (): readonly Pick<Asset, 'code' | 'symbol' | 'name'>[] => assets.enabled().map((a) => ({ code: a.code, symbol: a.symbol, name: a.name }));

/**
 * Asks the wallet to draw and raise a run for the month, list, vault, currency and form named, over the payment window the person gave,
 * passed on exactly. It asks the wallet nothing for a window that is missing, opens at or before `nowMs`, or closes at or before it opens.
 * The wallet draws the run and shows its people and total; the page names none of them. What comes back is the wallet's own answer: its
 * state and the approvals counted and needed where it gave them, or the reason it stopped.
 */
export async function raiseRun(
  personId: string, companyId: string, run: RunToRaise, onStep?: (step: number, steps: number) => void, nowMs: number = Date.now(),
): Promise<RaiseRunActed> {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/u.test(run.period) || run.vault === '' || run.token === ''
    || run.opensAt <= BigInt(Math.floor(nowMs / 1000)) || run.closesAt <= run.opensAt) return refused(ACT_REFUSAL.didNotFinish);
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await raiseRunInTheWallet({
      ...named, period: run.period, list: run.list, vault: run.vault, token: run.token, form: run.form, opensAt: run.opensAt, closesAt: run.closesAt,
    }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    if (ended.of === PROPOSAL_ACTED.done) return { of: PROPOSAL_ACTED.done, ...proposalOutcomeOf(ended) };
    return { of: PROPOSAL_ACTED.stopped, why: raiseRunWhyOf(ended.refused), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** A retry of the people of one leg of a run the chain shows unpaid, over a window the person gave; the places are those of the leg's leaves. */
interface RetryToRaise {
  readonly run: string; readonly period: string; readonly list: RunList; readonly vault: string; readonly token: string; readonly form: RunForm;
  readonly indices: readonly number[]; readonly total: bigint; readonly opensAt: bigint; readonly closesAt: bigint;
}

/**
 * Asks the wallet to raise a retry of some of a run's people. The wallet checks the run, the people, the total, the vault and whether the
 * leg can still pay them, and raises on the person's Confirm. Refused here, before the wallet is asked, when it names nobody, a place twice,
 * a total below one, or a window that is not in the future and in order.
 */
export async function retryRun(
  personId: string, companyId: string, retry: RetryToRaise, onStep?: (step: number, steps: number) => void, nowMs: number = Date.now(),
): Promise<RaiseRunActed> {
  const places = new Set(retry.indices);
  if (retry.run === '' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/u.test(retry.period) || retry.vault === '' || retry.token === '' || retry.indices.length === 0
    || places.size !== retry.indices.length || retry.indices.some((i) => !Number.isSafeInteger(i) || i < 0) || retry.total < 1n
    || retry.opensAt <= BigInt(Math.floor(nowMs / 1000)) || retry.closesAt <= retry.opensAt) return refused(ACT_REFUSAL.didNotFinish);
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await retryRunInTheWallet({
      ...named, run: retry.run, period: retry.period, list: retry.list, vault: retry.vault, token: retry.token, form: retry.form,
      indices: [...retry.indices].sort((a, b) => a - b), total: retry.total, opensAt: retry.opensAt, closesAt: retry.closesAt,
    }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    if (ended.of === PROPOSAL_ACTED.done) return { of: PROPOSAL_ACTED.done, ...proposalOutcomeOf(ended) };
    return { of: PROPOSAL_ACTED.stopped, why: raiseRunWhyOf(ended.refused), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
  } catch (e) {
    return refused(refusalOf(e));
  }
}


/** The fields of the one-off payment form a refusal is about. */
export const ONE_OFF_FIELD = { amount: 0, payee: 1, reason: 2, name: 3, vault: 4 } as const;
export type OneOffField = (typeof ONE_OFF_FIELD)[keyof typeof ONE_OFF_FIELD];

/** What is wrong with a one-off payment as typed, found on the page before the wallet is opened. */
export const ONE_OFF_PROBLEM = {
  noAsset: 0, noAmount: 1, badAmount: 2, zeroAmount: 3, tooManyDecimals: 4, noAddress: 5, badAddress: 6, noReason: 7, reasonTooLong: 8, nameTooLong: 9, noVault: 10,
} as const;
export type OneOffProblem = (typeof ONE_OFF_PROBLEM)[keyof typeof ONE_OFF_PROBLEM];

/** The longest reason and payee name the wallet files, and the largest amount a payment can carry (a 128-bit whole number). */
export const ONE_OFF_REASON_MOST = 500;
export const ONE_OFF_NAME_MOST = 128;
const AMOUNT_MOST = 1n << 128n;

/** What the person typed for a one-off payment, every field as text, plus the vendor entry when the payee was chosen from the vendor list. */
export interface OneOffDraft {
  readonly vault: string; readonly token: string; readonly amount: string; readonly payee: string; readonly payeeName: string; readonly reason: string;
  readonly vendor: string | null;
}

const characters = (s: string): number => [...s].length;
const AMOUNT_TEXT = /^(\d+)(?:\.(\d*))?$/u;

/** The kind of an address as typed, `null` when it is neither a private nor a public address of this network. */
function formOfAddress(entry: string, network: NetworkName): typeof RUN_FORM.shielded | typeof RUN_FORM.unshielded | null {
  const text = entry.trim();
  try { checkShieldedAddress(text, network); return RUN_FORM.shielded; } catch { /* not a private address: try a public one */ }
  try { checkUnshieldedAddress(text, network); return RUN_FORM.unshielded; } catch { return null; }
}

/** Whether a typed address pays privately (`shielded`) or publicly (`unshielded`); `null` when it is not an address of this network. */
export const oneOffForm = (payee: string, network: NetworkName = NETWORK as NetworkName): RunForm | null => formOfAddress(payee, network);

type Wrong = { readonly field: OneOffField; readonly problem: OneOffProblem };
type Typed = { readonly units: bigint; readonly asset: Asset } | Wrong;
const isWrong = (t: Typed): t is Wrong => (t as Partial<Wrong>).problem !== undefined;

function amountTyped(draft: OneOffDraft, registry: AssetRegistry): Typed {
  const asset = draft.token === '' ? null : registry.find(draft.token);
  if (asset === null) return { field: ONE_OFF_FIELD.amount, problem: ONE_OFF_PROBLEM.noAsset };
  const text = draft.amount.trim();
  if (text === '') return { field: ONE_OFF_FIELD.amount, problem: ONE_OFF_PROBLEM.noAmount };
  const m = AMOUNT_TEXT.exec(text);
  if (m === null) return { field: ONE_OFF_FIELD.amount, problem: ONE_OFF_PROBLEM.badAmount };
  if ((m[2] ?? '').replace(/0+$/u, '').length > asset.decimals) return { field: ONE_OFF_FIELD.amount, problem: ONE_OFF_PROBLEM.tooManyDecimals };
  const units = parseAmount(text.replace(/\.$/u, ''), asset);
  if (units <= 0n) return { field: ONE_OFF_FIELD.amount, problem: ONE_OFF_PROBLEM.zeroAmount };
  return units >= AMOUNT_MOST ? { field: ONE_OFF_FIELD.amount, problem: ONE_OFF_PROBLEM.badAmount } : { units, asset };
}

/**
 * What stops a one-off payment before the wallet is asked, in the order the form is read, or `null` when the page has nothing against
 * it. The wallet checks the same things again and refuses what it finds; this only spares the person a window that would refuse.
 * The amount is whatever was typed in the currency's own units; the page never makes one up.
 */
export function oneOffProblem(
  draft: OneOffDraft, registry: AssetRegistry = assets, network: NetworkName = NETWORK as NetworkName,
): { readonly field: OneOffField; readonly problem: OneOffProblem } | null {
  if (draft.vault === '') return { field: ONE_OFF_FIELD.vault, problem: ONE_OFF_PROBLEM.noVault };
  const amount = amountTyped(draft, registry);
  if (isWrong(amount)) return amount;
  if (draft.payee.trim() === '') return { field: ONE_OFF_FIELD.payee, problem: ONE_OFF_PROBLEM.noAddress };
  if (formOfAddress(draft.payee, network) === null) return { field: ONE_OFF_FIELD.payee, problem: ONE_OFF_PROBLEM.badAddress };
  const name = draft.payeeName.trim();
  if (characters(name) > ONE_OFF_NAME_MOST) return { field: ONE_OFF_FIELD.name, problem: ONE_OFF_PROBLEM.nameTooLong };
  const reason = draft.reason.trim();
  if (reason === '') return { field: ONE_OFF_FIELD.reason, problem: ONE_OFF_PROBLEM.noReason };
  if (characters(reason) > ONE_OFF_REASON_MOST) return { field: ONE_OFF_FIELD.reason, problem: ONE_OFF_PROBLEM.reasonTooLong };
  return null;
}

/**
 * Raises a one-off payment through the wallet: once, with exactly what the person typed (the amount as whole units of the currency, the
 * address trimmed, the name only when one was typed, the vendor only when the payee was chosen from the vendor list). A payment the page
 * finds wrong is refused as not finished and the wallet is not opened (the form says what is wrong, in words, before it gets here). Whether the wallet then only raises it or also approves, charges
 * and pays it is the wallet's to decide from what the chain holds; the answer says which.
 */
export async function raiseOneOff(
  personId: string, companyId: string, draft: OneOffDraft, onStep?: (step: number, steps: number) => void,
  registry: AssetRegistry = assets, network: NetworkName = NETWORK as NetworkName,
): Promise<ProposalActed> {
  if (draft.vault === '' || oneOffProblem(draft, registry, network) !== null) return refused(ACT_REFUSAL.didNotFinish);
  const typed = amountTyped(draft, registry) as { readonly units: bigint };
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const name = draft.payeeName.trim();
    const ended = await oneOffInTheWallet({
      ...named, vault: draft.vault, token: draft.token, amount: typed.units, payee: draft.payee.trim(), reason: draft.reason.trim(),
      ...(name === '' ? {} : { payeeName: name }),
      ...(draft.vendor === null ? {} : { vendor: draft.vendor }),
    }, ACCOUNT_ORIGIN, onStep === undefined ? {} : { onStep: (at) => onStep(at.step, at.steps) });
    return actedOf(PROPOSAL_ACT.approve, ended);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/**
 * The payment being typed as the public-facts block reads it, or `null` while the amount or the address is not yet one the page can
 * place, so nothing is said about what it makes public until it can be said truly.
 */
export function oneOffLeg(draft: OneOffDraft, registry: AssetRegistry = assets, network: NetworkName = NETWORK as NetworkName): RunLeg | null {
  const typed = amountTyped(draft, registry);
  if (isWrong(typed) || formOfAddress(draft.payee, network) === null) return null;
  return oneOffLegOf({ vault: draft.vault, token: draft.token, units: typed.units, address: draft.payee.trim(), name: draft.payeeName.trim() }, registry);
}
