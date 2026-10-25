import { privateAmount, publicAmount, type PrivateAmount, type PublicAmount } from 'vaults-ui';
import { assets, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { fromHex, type Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  api, companyKeyReleasedFor, companyKeysForVaults, holdersFromTheWallet, payIntoAVaultFromTheWallet, privateDepositInTheWallet,
} from 'vaults-web-shared/keyring.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-sign-in.js';
import { browserDepositsInFlight, browserInFlightRecords, vaultServiceFor } from 'vaults-web-shared/vault-page-doors.js';
import { coinsKeptOnThisDevice } from 'vaults-web-shared/vault-coins-kept-here.js';
import { privateTokenFromTheWallet, publicTokenFromTheWallet } from 'vaults-web-shared/deposit-source.js';
import {
  checkWhatThisBrowserDeposited, DEPOSIT_TIME_TO_LIVE_MS, depositPubliclyIntoCompanyVault, DepositLandedNotYetRecorded,
  DepositNotSent, DepositNotYetSeen, DepositStartedElsewhere, DepositStillInFlight, PublicDepositNotYetSeen, sayWhatTheCheckFound, type settleDepositInFlight,
  type DepositDoors, type PublicDepositDoors, type VaultStage, type WhatThisBrowserDeposited,
} from 'vaults-web-shared/vault-operation.js';
import type { DeviceSigner } from 'vaults-web-shared/deposit-on-device.js';
import type { ProofInProgress } from 'vaults-web-shared/vault-worker-client.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { companyRoute } from './handover-state.js';
import { keyringFor } from './keyring-person.js';
import { proofsRunning } from './proofs-running.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { Fault, FAULT } from '../faults.js';
import { DEPOSIT_USUAL_SECONDS } from './usual-times.js';
import { theVaultBuilder } from './vault-builder.js';
import { seatAndRecordsHere, type SeatAndRecordsHere } from './vault-private-money.js';

/*
 * PUTTING MONEY INTO A VAULT FROM A SCREEN: THE ONE WAY.
 *
 * A screen picks a token row (private or public), types an amount or asks for
 * all of it, and presses once. This adapter checks the amount against what the
 * person's wallet said it holds and starts the one deposit that row names,
 * one per vault, kept in the tab so closing the panel or opening another page
 * never stops or loses it. A private deposit is asked of the person's wallet
 * by intent (`private-deposit`: the company, the vault, the token and the
 * amount, nothing more) and made there whole: the wallet reads the chain and
 * the company's records itself, builds and proves the deposit, pays it, signs
 * the records it files, and hands the one transaction to this page to relay,
 * all in one window. This page builds, signs and opens nothing for it. A
 * public deposit is built here: what it needs of the chain it reads at the
 * indexer the person's own wallet names, who holds the vault is asked of their
 * wallet once for its own reads, and it is paid in from the wallet in a window
 * they press Pay in. A private pick never becomes a public deposit: a token
 * with no private form is refused. Nothing it hands a screen is wording:
 * codes, amounts made here, and, for support only, the shared code's own
 * reasons.
 */

/** How money goes in: privately, as a private token, or publicly, as a public one. Decided by the row the person picked, and by nothing else. */
export const DEPOSIT_KIND = { private: 'private', public: 'public' } as const;
export type DepositKind = (typeof DEPOSIT_KIND)[keyof typeof DEPOSIT_KIND];

/** The ways money can be put in, in the order a screen lists them. Another way is another entry, with the kinds it can bring. */
export const DEPOSIT_METHODS = [
  { id: 'from-your-wallet', kinds: [DEPOSIT_KIND.private, DEPOSIT_KIND.public] },
] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number]['id'];

/** The steps of a deposit a screen shows, one phrase each. */
export const DEPOSIT_STEP = {
  checkingTheVault: 'checking-the-vault',
  provingTheDeposit: 'proving-the-deposit',
  payingInYourWallet: 'paying-in-your-wallet',
  sending: 'sending',
  waitingForTheChain: 'waiting-for-the-chain',
} as const;
export type DepositStep = (typeof DEPOSIT_STEP)[keyof typeof DEPOSIT_STEP];

/**
 * THE STEPS OF EACH KIND OF DEPOSIT, IN THE ORDER THEY RUN. A public deposit
 * has one for each stage the shared deposit reports. A private deposit has the
 * two its wallet action reports: its window, and the deposit the wallet then
 * makes, sends and records.
 */
const STEPS = {
  [DEPOSIT_KIND.private]: [DEPOSIT_STEP.payingInYourWallet, DEPOSIT_STEP.provingTheDeposit],
  [DEPOSIT_KIND.public]: [
    DEPOSIT_STEP.checkingTheVault, DEPOSIT_STEP.provingTheDeposit, DEPOSIT_STEP.payingInYourWallet,
    DEPOSIT_STEP.sending, DEPOSIT_STEP.waitingForTheChain,
  ],
} as const satisfies Readonly<Record<DepositKind, readonly DepositStep[]>>;

/** The shared public deposit's own words for its stages, each to the step a screen shows. */
const STEP_OF_STAGE: Partial<Record<VaultStage, DepositStep>> = {
  'checking the vault': DEPOSIT_STEP.checkingTheVault,
  'building the deposit': DEPOSIT_STEP.provingTheDeposit,
  'asking your wallet': DEPOSIT_STEP.payingInYourWallet,
  'sending the deposit': DEPOSIT_STEP.sending,
  'waiting for the chain': DEPOSIT_STEP.waitingForTheChain,
};

/* Every step of each kind has its usual time, or null, in the usual times. */
DEPOSIT_USUAL_SECONDS satisfies { readonly [K in DepositKind]: { readonly [S in (typeof STEPS)[K][number]]: number | null } };

/** Whether this tab holds the company key the person's wallet released for `companyId`: without it, checking the last deposit first opens the company's records in the wallet. */
export const companyKeyHeldHere = (companyId: string): boolean => companyKeyReleasedFor(companyId) !== null;

/**
 * The steps a deposit of `kind` runs through, in order. Whether this tab holds the company key (`_keyHeld`) changes
 * none: a private deposit's wallet opens the company's records itself, in its one window.
 */
export function depositSteps(kind: DepositKind, _keyHeld: boolean): readonly DepositStep[] {
  return STEPS[kind];
}

/** How long `step` of a deposit of `kind` usually takes, in seconds, or null where it was not measured or waits on the person. */
export function usualSecondsOf(kind: DepositKind, step: DepositStep): number | null {
  return (DEPOSIT_USUAL_SECONDS[kind] as Readonly<Partial<Record<DepositStep, number | null>>>)[step] ?? null;
}

/* ------------------------------------------------------------------ the amount */

/** Why a typed amount is not put in, each a phrase a screen says with its next step. */
export const AMOUNT_REFUSAL = {
  empty: 'empty',
  notANumber: 'not-a-number',
  negative: 'negative',
  zero: 'zero',
  tooManyDecimals: 'too-many-decimals',
  groupSeparator: 'group-separator',
  aboveHeld: 'above-held',
  heldNotKnown: 'held-not-known',
  tokenNotKnown: 'token-not-known',
  noPrivateForm: 'no-private-form',
  noPublicForm: 'no-public-form',
} as const;
export type AmountRefusal = (typeof AMOUNT_REFUSAL)[keyof typeof AMOUNT_REFUSAL];

/** All of what the wallet said is held, exactly: what a screen passes for its Max. */
export const MAX: unique symbol = Symbol();

/** The row a person picked: the token, and the way it goes in. */
export interface DepositPick {
  readonly code: AssetId;
  readonly kind: DepositKind;
}

/** A typed amount as a deposit takes it, in the token's smallest units, with the amount a screen shows; or why not. */
export type AmountToPutIn =
  | { readonly of: typeof PUT_IN.amount; readonly units: bigint; readonly amount: PrivateAmount | PublicAmount }
  | { readonly of: typeof PUT_IN.refused; readonly why: AmountRefusal };

/** What an answer of this adapter is, compared by a screen. */
export const PUT_IN = { amount: 'amount', refused: 'refused', started: 'started', alreadyRunning: 'already-running' } as const;

const refusedAmount = (why: AmountRefusal): AmountToPutIn => ({ of: PUT_IN.refused, why });
/** A plain decimal: digits, at most one point, digits. */
const PLAIN_DECIMAL = /^(\d*)(?:\.(\d*))?$/u;
/** Digits grouped by a comma, a space, an apostrophe, an underscore, or points used to group. */
const GROUPED = /\d[\s,'_  ]\d|\d\.\d*\./u;
const NEGATIVE = /^[-−]/u;
const A_DIGIT = /\d/u;
const TRAILING_ZEROS = /0+$/u;

/**
 * THE AMOUNT `entry` (typed, or `MAX`) OF THE PICKED TOKEN, IN ITS SMALLEST
 * UNITS, checked against `held`, what the person's wallet said they hold of
 * it. The decimals and symbol come from the asset registry. Refused: a token
 * the registry does not name, or without the form the row picked; a balance
 * the wallet did not say; an empty entry, one that is not a plain decimal, a
 * negative one, one grouped with separators, one with more decimals than the
 * token has (trailing zeros aside), nothing, or more than is held. `MAX` is
 * the held amount exactly.
 */
export function amountToPutIn(
  entry: string | typeof MAX, pick: DepositPick, held: bigint | null, registry: AssetRegistry = assets,
): AmountToPutIn {
  const asset = registry.find(pick.code);
  if (asset === null) return refusedAmount(AMOUNT_REFUSAL.tokenNotKnown);
  const isPrivate = pick.kind === DEPOSIT_KIND.private;
  if (!isPrivate && pick.kind !== DEPOSIT_KIND.public) return refusedAmount(AMOUNT_REFUSAL.tokenNotKnown);
  if (typeof (isPrivate ? asset.ledger.shielded : asset.ledger.unshielded) !== 'string') {
    return refusedAmount(isPrivate ? AMOUNT_REFUSAL.noPrivateForm : AMOUNT_REFUSAL.noPublicForm);
  }
  if (typeof held !== 'bigint') return refusedAmount(AMOUNT_REFUSAL.heldNotKnown);
  let units: bigint;
  if (entry === MAX) {
    units = held;
  } else {
    const typed = typeof entry === 'string' ? entry.trim() : '';
    if (typed === '') return refusedAmount(AMOUNT_REFUSAL.empty);
    if (NEGATIVE.test(typed)) return refusedAmount(A_DIGIT.test(typed) ? AMOUNT_REFUSAL.negative : AMOUNT_REFUSAL.notANumber);
    if (GROUPED.test(typed)) return refusedAmount(AMOUNT_REFUSAL.groupSeparator);
    const parts = PLAIN_DECIMAL.exec(typed);
    const whole = parts?.[1] ?? '';
    const fraction = (parts?.[2] ?? '').replace(TRAILING_ZEROS, '');
    if (parts === null || !A_DIGIT.test(typed)) return refusedAmount(AMOUNT_REFUSAL.notANumber);
    if (fraction.length > asset.decimals) return refusedAmount(AMOUNT_REFUSAL.tooManyDecimals);
    const scale = 10n ** BigInt(asset.decimals);
    units = BigInt(whole === '' ? 0 : whole) * scale + BigInt(fraction === '' ? 0 : fraction.padEnd(asset.decimals, '0'));
  }
  if (units <= 0n) return refusedAmount(AMOUNT_REFUSAL.zero);
  if (units > held) return refusedAmount(AMOUNT_REFUSAL.aboveHeld);
  return {
    of: PUT_IN.amount, units,
    amount: isPrivate ? privateAmount(units, asset.decimals, asset.symbol) : publicAmount(units, asset.decimals, asset.symbol),
  };
}

/* ------------------------------------------------------------------ the running deposit */

/** Where a deposit in this tab stands, compared by a screen. */
export const DEPOSITED = { running: 'running', done: 'done', failed: 'failed' } as const;

/** What the earlier deposit this browser kept on its way came to, when this deposit settled it first. */
type EarlierSettled = Awaited<ReturnType<typeof settleDepositInFlight>>['state'];

/**
 * A DEPOSIT INTO ONE VAULT FROM THIS TAB, as a screen shows it: running, at
 * its step `n` of `of` since `since`; done, with the transaction the chain
 * at the person's wallet's indexer shows made it (`chainTransaction`: for a
 * private deposit, the one this device judged to create its note; for a
 * public one, the one seen calling the vault's public deposit), never the
 * hash the service answered with. A private deposit whose note the chain
 * holds and whose transaction it cannot name yet has none, and is
 * `notYetSpendable`: in the vault, not yet payable out. Or failed. A failure says whether anything may have been
 * sent (`mayHaveBeenSent`): only then does the screen send the person to
 * check their last deposit before trying again. `refusal` is the code a
 * screen words; `reasons` are the shared code's own, for support.
 */
export type DepositNow =
  | {
    readonly of: typeof DEPOSITED.running; readonly kind: DepositKind; readonly amount: PrivateAmount | PublicAmount;
    readonly steps: readonly DepositStep[]; readonly step: DepositStep; readonly n: number; readonly since: number;
    readonly proofs: readonly ProofInProgress[];
  }
  | {
    readonly of: typeof DEPOSITED.done; readonly kind: DepositKind; readonly amount: PrivateAmount | PublicAmount;
    readonly chainTransaction: string | null; readonly notYetSpendable: boolean; readonly earlier: EarlierSettled | null;
  }
  | {
    readonly of: typeof DEPOSITED.failed; readonly kind: DepositKind; readonly amount: PrivateAmount | PublicAmount;
    readonly mayHaveBeenSent: boolean; readonly refusal: ActRefusal; readonly reasons: readonly string[];
    /** A public deposit that may have been sent: the time until which it can still arrive, and the same money must not be put in again. */
    readonly until?: number;
  };

/** The deposit in this tab for each vault, by the vault's address in lower case, and who is watching each. */
const DEPOSITS = new Map<string, DepositNow>();
const WATCHERS = new Map<string, Set<() => void>>();
const keyOf = (vault: string): string => vault.toLowerCase();

/** Tells each watcher of `vault` that its deposit changed; a watcher that throws never stops the deposit or the others. */
const tellWatchers = (vault: string): void => {
  for (const watcher of [...(WATCHERS.get(keyOf(vault)) ?? [])]) {
    try { watcher(); } catch { /* a screen's own failure stays the screen's */ }
  }
};

const setNow = (vault: string, now: DepositNow): void => {
  DEPOSITS.set(keyOf(vault), now);
  tellWatchers(vault);
};

/** The deposit this tab holds for `vault`, running or ended and not yet put away, or null. The same object until it changes. */
export function depositNow(vault: string): DepositNow | null {
  const now = DEPOSITS.get(keyOf(vault)) ?? null;
  return now?.of === DEPOSITED.running ? { ...now, proofs: proofsRunning() } : now;
}

/** Calls `watcher` whenever the deposit for `vault` changes; the answer stops it. */
export function watchDeposit(vault: string, watcher: () => void): () => void {
  const key = keyOf(vault);
  const set = WATCHERS.get(key) ?? new Set<() => void>();
  set.add(watcher);
  WATCHERS.set(key, set);
  return () => { set.delete(watcher); };
}

/** Puts away an ended deposit once its result was read; a running one is never put away. */
export function putAwayEndedDeposit(vault: string): void {
  const now = DEPOSITS.get(keyOf(vault));
  if (now === undefined || now.of === DEPOSITED.running) return;
  DEPOSITS.delete(keyOf(vault));
  tellWatchers(vault);
}

/** The errors after which money may have moved, or may still move: the person checks before trying again. */
const MAY_HAVE_BEEN_SENT = [DepositNotYetSeen, DepositLandedNotYetRecorded, PublicDepositNotYetSeen] as const;
/** The errors that say nothing was sent. */
const NOTHING_SENT = [DepositNotSent, DepositStillInFlight, DepositStartedElsewhere] as const;

/** An error's own message and those of what caused it, for support. */
function reasonsOf(e: unknown): string[] {
  const out: string[] = [];
  for (let at: unknown = e, depth = 0; at instanceof Error && depth < 4; at = at.cause, depth += 1) out.push(at.message);
  return out;
}

/** How a deposit that threw ended: anything may have been sent once its send began, unless the error says nothing was; a public one that may have been sent also says until when it can still arrive. */
function failedWith(e: unknown, began: { readonly sending: boolean; readonly sentAt: number | null }, kind: DepositKind): Pick<Extract<DepositNow, { of: 'failed' }>, 'mayHaveBeenSent' | 'refusal' | 'reasons' | 'until'> {
  const maybe = MAY_HAVE_BEEN_SENT.some((c) => e instanceof c)
    || (began.sending && !NOTHING_SENT.some((c) => e instanceof c));
  const until = !maybe || kind !== DEPOSIT_KIND.public ? null
    : e instanceof PublicDepositNotYetSeen ? e.until
    : began.sentAt === null ? null : began.sentAt + DEPOSIT_TIME_TO_LIVE_MS;
  return { mayHaveBeenSent: maybe, refusal: refusalOf(e), reasons: reasonsOf(e), ...(until === null ? {} : { until }) };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * WHO HOLDS THE COMPANY AND THE INDEXER ITS WALLET READS THROUGH, ASKED OF THE
 * PERSON'S WALLET ONCE FOR ONE DEPOSIT'S OWN READS OF THE VAULT AND THE INDEXER
 * and kept for that deposit only. An ask that fails is not kept, so the next
 * read asks again.
 */
function holdersOnce(company: CompanyLabel, account: AccountAddress) {
  let kept: ReturnType<typeof holdersFromTheWallet> | null = null;
  const read = (): ReturnType<typeof holdersFromTheWallet> => {
    if (kept !== null) return kept;
    const asking = holdersFromTheWallet(ACCOUNT_ORIGIN, { company, account });
    kept = asking;
    asking.catch(() => { if (kept === asking) kept = null; });
    return asking;
  };
  return {
    onChain: async () => ({ holders: (await read()).holders }),
    indexer: async () => (await read()).indexer,
  };
}

/**
 * What checking this browser's last private deposit is given, from this signer's seat here: records that file
 * nothing, the coins and the deposit kept in this browser, and no way to pay.
 */
function checkDoorsOf(companyId: string, here: SeatAndRecordsHere, me: DeviceSigner): DepositDoors {
  const holders = holdersOnce(here.company, here.account);
  const opener = { signerId: me.signerId, wrappingSecret: me.wrappingSecret };
  return {
    sleep, progress: () => {},
    service: vaultServiceFor(api, companyId, async () => here.opened),
    company: here.company, account: here.account,
    onChain: holders.onChain, indexer: holders.indexer,
    builder: here.builder,
    me,
    myRecordsKey: recordsKeypairFrom(fromHex(here.companyKey)).publicKey as Hex,
    signers: here.readers.signers,
    records: here.records,
    kept: coinsKeptOnThisDevice(browserInFlightRecords(), opener),
    inFlight: browserDepositsInFlight(opener),
    pay: async () => { throw new Fault(FAULT.depositCheckPays); },
  };
}

/** The wallet window that releases the company key, for a tab that holds none. */
const releaseTheCompanyKey = (companyId: string) => () => companyKeysForVaults(companyId, ACCOUNT_ORIGIN);

/**
 * What the wallet's private deposit tells this page when it ends, as its entry names it: the key of the transaction
 * that created the deposit, and the states it says the deposit got to. Compared, never shown.
 */
const PRIVATE_DEPOSIT = {
  created: 'created',
  recorded: 'recorded', notYetSpendable: 'not-yet-spendable', notYetSeen: 'not-yet-seen', landedNotRecorded: 'landed-not-recorded',
} as const;

/** How the wallet's private deposit ended, for this page: done, or failed and whether the deposit may have been sent. */
function endOfTheWalletsDeposit(ended: ActOutcome, amount: PrivateAmount | PublicAmount): Ended {
  const told = ended.outcome ?? {};
  /* A deposit the wallet recorded is done, even when the action stopped after it, in the upkeep it ends with: pressing again would put the money in twice. */
  const recorded = told['state'] === PRIVATE_DEPOSIT.recorded || told['state'] === PRIVATE_DEPOSIT.notYetSpendable;
  if (ended.of === 'done' || recorded) {
    const created = told[PRIVATE_DEPOSIT.created];
    return {
      of: DEPOSITED.done, kind: DEPOSIT_KIND.private, amount, chainTransaction: typeof created === 'string' ? created : null,
      notYetSpendable: told['state'] === PRIVATE_DEPOSIT.notYetSpendable, earlier: null,
    };
  }
  /*
   * Seen by the wallet on its way, or relayed or handed to this page and not confirmed sent once the deposit's own step
   * began (the wallet names the vault as that step starts): it may have been sent. A send the action made before that
   * step, such as the company's records anchored in its first step, is no deposit.
   */
  const seen = told['state'] === PRIVATE_DEPOSIT.notYetSeen || told['state'] === PRIVATE_DEPOSIT.landedNotRecorded;
  const began = typeof told['vault'] === 'string';
  return {
    of: DEPOSITED.failed, kind: DEPOSIT_KIND.private, amount,
    mayHaveBeenSent: seen || (began && (ended.relayed > 0 || ended.unconfirmed > 0)),
    refusal: ACT_REFUSAL.didNotFinish, reasons: [],
  };
}

type Ended = Extract<DepositNow, { of: 'done' | 'failed' }>;
type Run = (step: (to: DepositStep) => void, progress: (stage: VaultStage) => void) => Promise<Ended>;

/**
 * A private deposit of `units` of `code`, asked of the person's wallet by intent and made there whole: the wallet's
 * window is the first step, the deposit it makes, sends and records the second.
 */
function privately(personId: string, companyId: string, vault: string, code: AssetId, units: bigint, amount: PrivateAmount | PublicAmount, registry: AssetRegistry): Run {
  return async (step) => {
    const failed = (refusal: ActRefusal): Ended => ({ of: DEPOSITED.failed, kind: DEPOSIT_KIND.private, amount, mayHaveBeenSent: false, refusal, reasons: [] });
    if (!(await keyringFor(personId))) return failed(ACT_REFUSAL.notSignedIn);
    const sealed = await api(companyRoute(companyId)) as SealedAccount;
    const company = (sealed.companyLabel ?? null) as CompanyLabel | null;
    const account = (sealed.contractAddress ?? null) as AccountAddress | null;
    if (company === null || account === null) return failed(ACT_REFUSAL.didNotFinish);
    const money = privateTokenFromTheWallet(async () => { throw new Fault(FAULT.privateDepositPaidHere); }, registry)
      .money({ code, value: units });
    const ended = await privateDepositInTheWallet({
      record: companyId, company, account, vault: vault.toLowerCase(), token: money.token.toLowerCase(), units: money.value,
    }, ACCOUNT_ORIGIN, { onStep: (at) => step(at.step >= 2 ? DEPOSIT_STEP.provingTheDeposit : DEPOSIT_STEP.payingInYourWallet) });
    return endOfTheWalletsDeposit(ended, amount);
  };
}

/** A public deposit of `units` of `code`: the vault's public deposit, given only what a public deposit needs. */
function publicly(personId: string, companyId: string, vault: string, code: AssetId, units: bigint, amount: PrivateAmount | PublicAmount, registry: AssetRegistry): Run {
  return async (_step, progress) => {
    const failed = (refusal: ActRefusal): Ended => ({ of: DEPOSITED.failed, kind: DEPOSIT_KIND.public, amount, mayHaveBeenSent: false, refusal, reasons: [] });
    if (!(await keyringFor(personId))) return failed(ACT_REFUSAL.notSignedIn);
    const sealed = await api(companyRoute(companyId)) as SealedAccount;
    const company = (sealed.companyLabel ?? null) as CompanyLabel | null;
    const account = (sealed.contractAddress ?? null) as AccountAddress | null;
    if (company === null || account === null) return failed(ACT_REFUSAL.didNotFinish);
    const holders = holdersOnce(company, account);
    const pay: PublicDepositDoors['pay'] = (ask) => payIntoAVaultFromTheWallet(ACCOUNT_ORIGIN, ask);
    const doors: PublicDepositDoors = {
      sleep, progress,
      /* A public deposit never asks for the vault's keys, so no roster is read for it: an ask for them would find no readers and be refused. */
      service: vaultServiceFor(api, companyId, async () => ({ id: companyId, signers: [], notBelieved: [] })),
      builder: await theVaultBuilder(),
      company, account, onChain: holders.onChain, indexer: holders.indexer, pay,
    };
    const money = publicTokenFromTheWallet(pay, registry).money({ code, value: units });
    const done = await depositPubliclyIntoCompanyVault(doors, vault as Hex, money);
    return { of: DEPOSITED.done, kind: DEPOSIT_KIND.public, amount, chainTransaction: done.transactionHash, notYetSpendable: false, earlier: null };
  };
}

/** What a press of Put money in came to: started (with the deposit's end), refused before anything (the amount's reason), or one already running for this vault, so nothing was sent. */
export type PutMoneyIn =
  | { readonly of: typeof PUT_IN.started; readonly ended: Promise<DepositNow> }
  | { readonly of: typeof PUT_IN.refused; readonly why: AmountRefusal }
  | { readonly of: typeof PUT_IN.alreadyRunning };

/**
 * PUTS `entry` OF THE PICKED TOKEN INTO THE VAULT `vault` OF THE COMPANY
 * `companyId`, for the person `personId`, the way the picked row names and no
 * other. The amount is checked first (`amountToPutIn`); while a deposit into
 * this vault runs in this tab, a press sends nothing. The deposit is held here
 * from the press, before anything is awaited, and runs to its end whatever
 * the screen does; `depositNow` and `watchDeposit` follow it.
 */
export function putMoneyIn(
  personId: string, companyId: string, vault: string, pick: DepositPick, entry: string | typeof MAX, held: bigint | null,
  registry: AssetRegistry = assets,
): PutMoneyIn {
  if (DEPOSITS.get(keyOf(vault))?.of === DEPOSITED.running) return { of: PUT_IN.alreadyRunning };
  const checked = amountToPutIn(entry, pick, held, registry);
  if (checked.of === PUT_IN.refused) return checked;
  const { units, amount } = checked;
  const kind = pick.kind;
  const steps = depositSteps(kind, kind === DEPOSIT_KIND.public || companyKeyHeldHere(companyId));
  const began = { sending: false, sentAt: null as number | null };
  const step = (to: DepositStep): void => {
    const n = steps.indexOf(to) + 1;
    if (n === 0) return;
    setNow(vault, { of: DEPOSITED.running, kind, amount, steps, step: to, n, since: Date.now(), proofs: [] });
  };
  const progress = (stage: VaultStage): void => {
    if (stage === 'sending the deposit') { began.sending = true; began.sentAt = Date.now(); }
    const to = STEP_OF_STAGE[stage];
    if (to !== undefined && (DEPOSITS.get(keyOf(vault)) as { step?: DepositStep } | undefined)?.step !== to) step(to);
  };
  step(steps[0]!);
  const run = kind === DEPOSIT_KIND.private
    ? privately(personId, companyId, vault, pick.code, units, amount, registry)
    : publicly(personId, companyId, vault, pick.code, units, amount, registry);
  const ended = run(step, progress).catch((e: unknown): Ended => ({ of: DEPOSITED.failed, kind, amount, ...failedWith(e, began, kind) }))
    .then((end) => { setNow(vault, end); return end as DepositNow; });
  return { of: PUT_IN.started, ended };
}

/* ------------------------------------------------------------------ check my last deposit */

/** What a check of this browser's last deposit came to, compared by a screen. */
export const CHECKED = { checked: 'checked', refused: 'refused' } as const;

/** Why a check that judged a deposit shows no amount for it: its token is one the asset registry does not list. */
export const AMOUNT_UNSHOWN = { tokenNotListed: 'token-not-listed' } as const;
type AmountUnshown = (typeof AMOUNT_UNSHOWN)[keyof typeof AMOUNT_UNSHOWN];

/** The private amount of `value` of the private token `token`, as the registry names it, or null when it lists no such token. */
function privateAmountOf(token: string, value: bigint, registry: AssetRegistry): PrivateAmount | null {
  const asset = registry.all().find((a) => typeof a.ledger.shielded === 'string' && a.ledger.shielded.toLowerCase() === token.toLowerCase());
  return asset === undefined ? null : privateAmount(value, asset.decimals, asset.symbol);
}

/**
 * WHAT CHECKING THE LAST PRIVATE DEPOSIT INTO A VAULT FOUND: where
 * that deposit stands (`deposit`, the shared check's own states), until when
 * one still on its way can arrive, whether one recorded cannot be paid out
 * yet, and how many of the vault's amounts were named now or still cannot be;
 * what the deposit it judged was (`deposited`), or why no amount is shown for
 * it (`unshown`): the shared check says which deposit it judged and its token
 * and value as it read them.
 * `forSupport` is the shared code's sentence for what it found, for support.
 */
export type LastDepositChecked =
  | {
    readonly of: typeof CHECKED.checked; readonly deposit: WhatThisBrowserDeposited['deposit']['state'];
    readonly until: number | null; readonly notYetSpendable: boolean; readonly named: number; readonly unnamed: number;
    /** Amounts the chain can name and that this check, which files nothing, left for a signer's wallet to name. */
    readonly toName: number;
    readonly forSupport: string;
    readonly deposited: PrivateAmount | null;
    readonly unshown: AmountUnshown | null;
  }
  | { readonly of: typeof CHECKED.refused; readonly why: ActRefusal; readonly reasons: readonly string[] };

/**
 * CHECKS THE LAST PRIVATE DEPOSIT INTO `vault`, for the person `personId`: a
 * deposit this browser kept on its way from before the wallet made deposits,
 * said once and then let go; otherwise the newest deposit the vault's deposit
 * journal names, judged against the chain and the vault's record; and how many
 * amounts in the record the chain can name. The check files and signs nothing:
 * a deposit in the vault and not yet in its record, and an amount not yet
 * named, are said as owed. Deposits only: no payment is read or settled, and
 * nothing is built or sent.
 * In a tab that holds no released company key, the person's wallet is first
 * asked to release it, in a window of its own.
 * A public deposit leaves nothing in this browser to check.
 */
export async function checkMyLastDeposit(personId: string, companyId: string, vault: string, registry: AssetRegistry = assets): Promise<LastDepositChecked> {
  try {
    const here = await seatAndRecordsHere(personId, companyId, releaseTheCompanyKey(companyId));
    if (typeof here === 'string') return { of: CHECKED.refused, why: here, reasons: [] };
    const found = await checkWhatThisBrowserDeposited(checkDoorsOf(companyId, here, here.mine), vault as Hex, { files: false });
    const d = found.deposit;
    const judged = found.checked ?? null;
    const deposited = judged === null ? null : privateAmountOf(judged.token, judged.value, registry);
    return {
      of: CHECKED.checked, deposit: d.state, until: d.state === 'still-on-its-way' ? d.until : null,
      notYetSpendable: d.state === 'recorded' && d.notYetSpendable !== undefined,
      named: found.named, unnamed: found.unnamed, toName: found.toName ?? 0, forSupport: sayWhatTheCheckFound(found),
      deposited, unshown: judged !== null && deposited === null ? AMOUNT_UNSHOWN.tokenNotListed : null,
    };
  } catch (e) {
    return { of: CHECKED.refused, why: refusalOf(e), reasons: reasonsOf(e) };
  }
}
