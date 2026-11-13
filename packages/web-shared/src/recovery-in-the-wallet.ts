/*
 * RAISING, APPROVING AND CARRYING OUT A RECOVERY OF THE COMPANY'S RECORDS FROM THE PAGE: the wallet's recovery action and its approve-proposal
 * action under the recovery kind, asked of the person's wallet as every action on a company is (`actOnACompanyInTheWallet`). The page names
 * the company, the last time the recovery may be carried out and the parts of its file; the wallet runs the recovery on the chain and its
 * own account alone and tells back where it stands. The wallet's names, the codes a page tells its stops by and the conversions between a
 * count and its digits are here, so a screen is handed codes and never writes the wallet's words.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import { actOnACompanyInTheWallet } from './keyring.js';
import { PROPOSAL_ACT, proposalActInTheWallet } from './proposal-in-the-wallet.js';
import { walletInThisPage } from './wallet-frame.js';
import { RECOVERY_WINDOW_RANGE, windowWhenNoneInForce } from '../../../src/midnight/recovery-window-record.js';
import type { Openable } from './wallet-sign-in.js';
import type { ActOutcome } from './wallet-act.js';

/** The wallet's name for the recovery action, its two steps, and the name it gives the recovery as a kind of proposal to approve. */
const RECOVERY_WALLET = { act: 'recovery', kind: 'recovery', raise: 'raise', carry: 'carry' } as const;

/** The three presses on a recovery. */
export const RECOVERY_ACT = { raise: 'raise', approve: 'approve', carry: 'carry' } as const;
export type RecoveryAct = (typeof RECOVERY_ACT)[keyof typeof RECOVERY_ACT];

/** Where the wallet says the recovery got to. */
export const RECOVERY_STATE = { waiting: 'waiting-for-approvals', carriedOut: 'carried-out' } as const;
export type RecoveryState = (typeof RECOVERY_STATE)[keyof typeof RECOVERY_STATE];

/** Why the wallet stopped a press, as a page names it; the wallet's own words are told in its window and never handed on. */
export const RECOVERY_WHY = {
  seat: 'seat', noAccount: 'no-account', noDust: 'no-dust', notARecovery: 'not-a-recovery', notRaised: 'not-raised', closed: 'closed', outrun: 'outrun',
  stillOpen: 'still-open', mayBeSent: 'may-be-sent', notDone: 'not-done', noWallet: 'no-wallet', stopped: 'stopped', other: 'other',
  windowUnread: 'window-unread',
} as const;
export type RecoveryWhy = (typeof RECOVERY_WHY)[keyof typeof RECOVERY_WHY];

const WHY_OF: Readonly<Record<string, RecoveryWhy>> = {
  'not-a-company': RECOVERY_WHY.seat, 'no-saved-keys': RECOVERY_WHY.seat, 'no-seat': RECOVERY_WHY.seat, 'seat-not-held': RECOVERY_WHY.seat,
  'no-account': RECOVERY_WHY.noAccount, 'no-dust': RECOVERY_WHY.noDust, 'not-a-recovery': RECOVERY_WHY.notARecovery,
  'not-raised': RECOVERY_WHY.notRaised, closed: RECOVERY_WHY.closed, outrun: RECOVERY_WHY.outrun, 'still-open': RECOVERY_WHY.stillOpen,
  'may-be-sent': RECOVERY_WHY.mayBeSent, 'not-raised-here': RECOVERY_WHY.notDone, 'not-approved': RECOVERY_WHY.notDone, 'not-carried': RECOVERY_WHY.notDone,
  'no-own-wallet': RECOVERY_WHY.noWallet, 'window-unread': RECOVERY_WHY.windowUnread,
};
const KEY = /^act\.(?:recovery|approve-proposal)\.why\.([a-z-]+)$/u;

/** The reason a stop came to, from the key of the words the wallet refused with: none is `stopped`, and a code not listed is `other`. */
export function recoveryWhyOf(refused: string | undefined): RecoveryWhy {
  if (refused === undefined) return RECOVERY_WHY.stopped;
  const code = KEY.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(WHY_OF, code) ? WHY_OF[code]! : RECOVERY_WHY.other;
}

/**
 * The times a person may choose for the last moment a recovery may be carried out, as seconds from the press. Every one is after now by
 * construction, and the longest is a day short of the week the wallet's raise allows, so a slow press cannot take a choice past it.
 */
export const RECOVERY_WITHIN = [
  { id: 'hour', seconds: 60 * 60 }, { id: 'day', seconds: 24 * 60 * 60 }, { id: 'three-days', seconds: 3 * 24 * 60 * 60 }, { id: 'six-days', seconds: 6 * 24 * 60 * 60 },
  { id: 'two-weeks', seconds: 14 * 24 * 60 * 60 }, { id: 'longest', seconds: RECOVERY_WINDOW_RANGE.longest },
] as const;

/**
 * The waits a recovery may be raised with: those no longer than the company's recovery window in force, or, with none
 * in force, than the window a device holds then (`windowWhenNoneInForce`). The wallet holds the window it kept, and refuses past it.
 */
export const recoveryWithinUpTo = (window: number | null): readonly (typeof RECOVERY_WITHIN)[number][] =>
  RECOVERY_WITHIN.filter((w) => w.seconds <= (window ?? windowWhenNoneInForce()));
export type RecoveryWithin = (typeof RECOVERY_WITHIN)[number]['id'];

/** Why a file did not open as a recovery of this company. */
export const FILE_REFUSED = { unreadable: 'unreadable', notARecovery: 'not-a-recovery', notThisCompany: 'not-this-company', companyUnread: 'company-unread' } as const;
export type FileRefusal = (typeof FILE_REFUSED)[keyof typeof FILE_REFUSED];

/** How opening a file ended, and how reading the chain for a recovery ended. */
export const FILE_OPENED = { opened: 'opened', refused: 'refused' } as const;
export const STANDING_READ = { read: 'read', unread: 'unread' } as const;

/** Where the chain holds a recovery, as the account's history shows it. */
export const HELD_ON_CHAIN = { open: 'open', cleared: 'cleared', closed: 'closed', never: 'never' } as const;
export type HeldOnChain = (typeof HELD_ON_CHAIN)[keyof typeof HELD_ON_CHAIN];

const HEX64 = /^[0-9a-f]{64}$/u;
const DIGITS = /^(?:0|[1-9][0-9]{0,15})$/u;
const FILE_NAME = 'recovery-{id}.json';

/** A whole number of seconds or batches as the digits the wallet's ask carries, and back: a count is never an amount. */
export const digitsOf = (n: number): string => n.toString();
const wholeOf = (digits: string): number => Number(digits);

/** The parts of a recovery's file, which the wallet makes the file again from. */
export interface RecoveryParts {
  readonly company: string; readonly account: string; readonly chainId: string; readonly salt: string; readonly latest: string;
  readonly lastRecovery: string; readonly resumesFrom: { readonly seq: number; readonly head: string; readonly root: string };
}

/** Whether these are the parts of a recovery: the identity, salt, latest recovery, head and root each thirty-two bytes, the time and the batch whole numbers. */
export const isRecoveryParts = (p: RecoveryParts): boolean =>
  [p.chainId, p.salt, p.lastRecovery, p.resumesFrom.head, p.resumesFrom.root, p.account].every((s) => HEX64.test(s)) && DIGITS.test(p.latest)
  && Number.isSafeInteger(p.resumesFrom.seq) && p.resumesFrom.seq >= 0;

/** The last moment the recovery may be carried out, as an ISO time. */
export const recoveryUntil = (p: RecoveryParts): string => new Date(wholeOf(p.latest) * 1000).toISOString();

/** Whether the last moment to carry the recovery out has passed at `nowMs`. */
export const recoveryTimePassed = (p: RecoveryParts, nowMs: number): boolean => Math.floor(nowMs / 1000) >= wholeOf(p.latest);

/** The name a recovery's file is saved under. */
export const recoveryFileName = (p: RecoveryParts): string => FILE_NAME.replace('{id}', p.chainId.slice(0, 8));

/** The last moment a recovery chosen `seconds` from `nowMs` may be carried out, as whole seconds since the epoch. */
export const recoveryLatestAt = (nowMs: number, seconds: number): number => Math.floor(nowMs / 1000) + seconds;

/** The parts the wallet told of a recovery's file, as parts of this company's, or null where it told none or told what is not a file's parts. */
export function recoveryPartsToldBy(record: string, account: string, told: Readonly<Record<string, string | number>> | undefined): RecoveryParts | null {
  if (told === undefined) return null;
  const text = (k: string): string => (typeof told[k] === 'string' ? told[k] : '');
  const seq = told['seq'];
  if (typeof seq !== 'number') return null;
  const parts: RecoveryParts = {
    company: record, account, chainId: text('proposal'), salt: text('salt'), latest: text('latest'), lastRecovery: text('lastRecovery'),
    resumesFrom: { seq, head: text('resumesFrom'), root: text('root') },
  };
  return isRecoveryParts(parts) ? parts : null;
}

/** The kinds of file the page offers to open a recovery from. */
export const RECOVERY_FILE_ACCEPT = '.json,application/json';

const count = (v: string | number | undefined): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** What the wallet told of where a recovery stands: its state, and the approvals the chain counts and the account needs; each null where it did not say. */
export function recoveryOutcomeOf(ended: ActOutcome): { readonly state: RecoveryState | null; readonly approvals: number | null; readonly needed: number | null } {
  const state = ended.outcome?.['state'];
  return {
    state: state === RECOVERY_STATE.waiting || state === RECOVERY_STATE.carriedOut ? state : null,
    approvals: count(ended.outcome?.['approvals']), needed: count(ended.outcome?.['needed']),
  };
}

/** The parts of a recovery as the wallet takes them in an ask. */
const askedOf = (p: RecoveryParts): Record<string, string> => ({
  proposal: p.chainId, salt: p.salt, latest: p.latest, lastRecovery: p.lastRecovery, resumesFrom: p.resumesFrom.head, root: p.resumesFrom.root,
  seq: digitsOf(p.resumesFrom.seq),
});

/** The company a recovery is for, as the page names it. */
interface Company { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress }
interface Opts { readonly onStep?: (at: StepAt) => void }
const withSteps = (opts: Opts): Opts => (opts.onStep === undefined ? {} : { onStep: opts.onStep });

/**
 * **ASKS THE PERSON'S WALLET TO RAISE A RECOVERY** to be carried out before `latest` (whole seconds since the epoch), over one window. The
 * wallet raises it from the last batch of the records it checked, and carries it out in the same window when the chain already counts the
 * approvals the account needs. Resolves with how the action ended; the parts of the file are in its `outcome`.
 */
export function raiseRecoveryInTheWallet(
  ask: Company & { readonly latest: number }, walletOrigin: string, opts: Opts = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: RECOVERY_WALLET.act, record: ask.record, company: ask.company, account: ask.account, step: RECOVERY_WALLET.raise, latest: digitsOf(ask.latest),
  }, walletOrigin, withSteps(opts), view);
}

/** **ASKS THE PERSON'S WALLET TO APPROVE A RECOVERY**, by the parts of its file, as the one approval action does a proposal of the recovery kind. */
export function approveRecoveryInTheWallet(
  ask: Company & { readonly parts: RecoveryParts }, walletOrigin: string, opts: Opts = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return proposalActInTheWallet(
    { act: PROPOSAL_ACT.approve, record: ask.record, company: ask.company, account: ask.account, proposal: ask.parts.chainId, kind: RECOVERY_WALLET.kind, asked: askedOf(ask.parts) },
    walletOrigin, withSteps(opts), view,
  );
}

/** **ASKS THE PERSON'S WALLET TO CARRY A RECOVERY OUT**, by the parts of its file; short of the approvals the account needs it sends nothing. */
export function carryOutRecoveryInTheWallet(
  ask: Company & { readonly parts: RecoveryParts }, walletOrigin: string, opts: Opts = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: RECOVERY_WALLET.act, record: ask.record, company: ask.company, account: ask.account, step: RECOVERY_WALLET.carry, ...askedOf(ask.parts),
  }, walletOrigin, withSteps(opts), view);
}

/**
 * The format and change kind a proposal file of a recovery carries, as the company's other tools write and read it. They are written
 * here, not taken from the code that makes the file on a device with the seat's keys, because that code uses a seat secret and the page
 * holds none: the page only writes the parts of the file down and reads them back, and the wallet makes the file again from them.
 */
/** What setting the recovery window tells the page: in force, or still gathering signatures. */
export const WINDOW_STATE = { inForce: 'in-force', waiting: 'waiting-for-signers' } as const;

/** Sets the company's recovery window to `seconds`, or adds this seat's signature to a change to that length, in the wallet. */
export function setRecoveryWindowInTheWallet(
  ask: Company & { readonly seconds: number }, walletOrigin: string, opts: Opts = {}, view: Openable = walletInThisPage(window),
): Promise<ActOutcome> {
  return actOnACompanyInTheWallet({
    name: 'set-recovery-window', record: ask.record, company: ask.company, account: ask.account, seconds: digitsOf(ask.seconds),
  }, walletOrigin, withSteps(opts), view);
}

/** What setting the window told the page: its state, how many have signed it and how many it needs. */
export function windowOutcomeOf(ended: ActOutcome): { readonly state: string | null; readonly signed: number | null; readonly needed: number | null } {
  const state = ended.outcome?.['state'];
  return { state: typeof state === 'string' ? state : null, signed: count(ended.outcome?.['signed']), needed: count(ended.outcome?.['needed']) };
}

const FILE_FORMAT = 'confidential-accounts/proposal-file/v1';
const CHANGE_KIND = 'recover-anchor';

/** The text of a recovery's file, as a signer saves and sends it: the parts, and `summary` for a person reading it. */
export function recoveryFileTextOf(p: RecoveryParts, summary: string): string {
  const file = {
    format: FILE_FORMAT, company: p.company, account: p.account.toLowerCase(),
    change: { kind: CHANGE_KIND, resumesFrom: p.resumesFrom.head.toLowerCase(), latest: p.latest, lastRecovery: p.lastRecovery.toLowerCase() },
    salt: p.salt.toLowerCase(), chainId: p.chainId.toLowerCase(), summary,
    resumesFrom: { seq: p.resumesFrom.seq, head: p.resumesFrom.head.toLowerCase(), root: p.resumesFrom.root.toLowerCase() },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * The parts of the recovery a file's text holds, or why it holds none: `unreadable` where it is not a proposal file or is missing or
 * mistaking a part a recovery has, `not-a-recovery` where it is a file of another kind of change. Nothing in it is believed: the wallet
 * checks every part against the chain before anything is signed.
 */
export function recoveryPartsInFile(text: string): { readonly parts: RecoveryParts; readonly why?: undefined } | { readonly parts?: undefined; readonly why: FileRefusal } {
  const unreadable = { why: FILE_REFUSED.unreadable } as const;
  let f: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unreadable;
    f = parsed as Record<string, unknown>;
  } catch {
    return unreadable;
  }
  if (f['format'] !== FILE_FORMAT) return unreadable;
  const change = f['change'] as Record<string, unknown> | null | undefined;
  if (typeof change !== 'object' || change === null || change['kind'] !== CHANGE_KIND) return { why: FILE_REFUSED.notARecovery };
  const from = f['resumesFrom'] as Record<string, unknown> | null | undefined;
  if (typeof from !== 'object' || from === null || f['joined'] !== undefined || f['signatures'] !== undefined) return unreadable;
  const [company, account, salt, chainId, summary] = [f['company'], f['account'], f['salt'], f['chainId'], f['summary']];
  const [head, root, seq, latest, lastRecovery] = [from['head'], from['root'], from['seq'], change['latest'], change['lastRecovery']];
  if (typeof company !== 'string' || company === '' || typeof summary !== 'string' || change['resumesFrom'] !== head) return unreadable;
  if (typeof account !== 'string' || typeof salt !== 'string' || typeof chainId !== 'string' || typeof head !== 'string' || typeof root !== 'string') return unreadable;
  if (typeof latest !== 'string' || typeof lastRecovery !== 'string' || typeof seq !== 'number') return unreadable;
  const parts: RecoveryParts = { company, account, chainId, salt, latest, lastRecovery, resumesFrom: { seq, head, root } };
  return isRecoveryParts(parts) && /^[1-9][0-9]*$/u.test(latest) ? { parts } : unreadable;
}

/** Gives the person a file to keep: `text` under `name`, as the browser saves a download. */
export function saveFileText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
