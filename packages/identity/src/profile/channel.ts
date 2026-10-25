import type { BalancedAnswer } from './balance.js';
import type { CommitteeSignatures } from './committee-sign.js';
import type { HoldersAnswer, RecordsKeyAnswer } from './records-key.js';
import type { CreationSignature } from './creation-sign.js';
import { PROGRESS_SCHEMA, parseAsk } from './request.js';
import type { Ask, RequestError } from './request.js';
import type { DisclosureResponse } from './disclosure.js';
import type { KeyringRelease, KeysRead, SealedKeyring, UnlockRelease } from './unlock.js';
import type { SealedAcceptance } from './inbox.js';
import type { JoinCode } from './join-code.js';
import type { AddressesAndBalances } from './addresses-and-balances.js';
import { countFrom1, readActCall, readActKeep, readActRelay } from './act-channel.js';
export { readOutcome } from './act-channel.js';

/**
 * HOW A REQUEST GETS IN, AND HOW THE ANSWER GETS OUT.
 *
 * ── WHY THIS IS NOT THE CONNECTOR, AND THE `.d.ts` READ FOR IT ────────────
 * `@midnightntwrk/dapp-connector-api@4.1.0-beta.1` is **injected**, in its own
 * words: *"Wallets inject their Initial API under the `window.midnight`
 * object"* (`dist/api.d.ts:1-7`), and the declaration is literally
 * `Window.midnight?: { [key: string]: InitialAPI }`
 * (`dist/globals.d.ts:2-8`). Its whole surface is money: balances, addresses,
 * history, balancing, `submitTransaction`, `signData`, `getProvingProvider`,
 * `getConfiguration` (`dist/api.d.ts:55-188`). **There is no identity in it and
 * there should not be.**
 *
 * **A HOSTED WALLET CANNOT INJECT ANYTHING INTO SOMEBODY ELSE'S PAGE.**
 * Injection is what an extension does, and an extension is ruled out. So
 * the connector is the right protocol INSIDE our own shell, where we are the
 * parent of an iframe (mini-apps), and is
 * unavailable for an application in another tab. This module is the other case.
 *
 * Two details from that same `.d.ts` are worth carrying, because they are the
 * shape of the mistakes this file must not make:
 *   · `signData` takes `keyType: 'unshielded'` — one literal, not a union
 *     (`dist/api.d.ts:277-290`). Even the connector has no identity key.
 *   · `Signature.scheme` is **optional**, and an absent value means
 *     `schnorr_bip340` *"by default"* (`dist/api.d.ts:296-305`). An optional
 *     field is a door; reading a default as a mechanism is a trap. Ours is
 *     required — `disclosure.ts` says so at the type.
 *
 * ── THE ONE THING THIS FILE EXISTS TO DO ──────────────────────────────────
 * **OBSERVE THE ORIGIN.** `MessageEvent.origin` is filled in by the browser and
 * no page can write it. That value, and nothing from the message body, is what
 * `parseAsk` is handed. §5.3.
 *
 * ── THE CHANNEL CARRIES A KIND AND DOES NOT READ ONE ──────────────────
 * The protocol makes the action a VALUE with a kind,
 * and this file learned nothing about kinds: it still filters on one schema and
 * still hands `parseAsk` the browser's origin and the untouched message. **Which
 * kind it is, is the parser's answer and not the channel's** — a channel that
 * branched on kind would be a second place to keep in step with the first. The
 * one kind it does act on, once parsed, is `act`: an action hands the page its
 * transactions, and the saved keys it sealed again, one at a time over this
 * channel and hears back what the page did with each, so the channel carries
 * more than one message for it.
 */

export const READY_PING = 'midnight-identity/wallet-ready/v1';

/**
 * **WHAT A WALLET SAYS WHILE IT WORKS, AND IT IS NEVER AN ANSWER.**
 *
 * A private deposit keeps a wallet busy for minutes: it reads the network to
 * find its coins, then proves in the browser. A page that hears nothing for
 * that long cannot tell a wallet at work from one that has gone, so the wallet
 * says which of two things it is doing, each time something actually happens:
 * a report from its read of the network, or a proof starting or ending.
 *
 * **ONLY ON AN EVENT, NEVER FROM A CLOCK.** A message sent on a timer keeps
 * arriving after the read or the proof it describes has died, and a page that
 * restarts its wait on each one would wait for ever on a dead wallet. The one
 * exception is an action (`act`), which says which step it is on, as `step` of
 * `steps`, and says it again on a clock while a step runs: an action keeps its
 * own deadline and stops there whatever its steps are doing, and the page stops
 * waiting at the deadline it wrote into the ask, so a dead step is waited for
 * no longer than the action was ever allowed to take.
 *
 * **ONLY TO A PAGE THAT SAID IT KNOWS THIS MESSAGE** - `hearsProgress` on the
 * ask. A page that does not know it takes anything else from the wallet as the
 * answer, so a slow payment would reach it as a failed one. And it carries no
 * figure: which of two stages, and nothing about coins, amounts or how far.
 */
export { PROGRESS_SCHEMA };
export const PROGRESS_STAGES = ['reading', 'proving'] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];
export interface WalletProgress {
  readonly schema: typeof PROGRESS_SCHEMA;
  readonly stage: ProgressStage;
  /** On an action only: the step running now, counted from 1, and how many steps the action has. */
  readonly step?: number;
  readonly steps?: number;
}

/**
 * **AN ACTION'S OWN MESSAGES, BESIDES PROGRESS.** While an action runs, the
 * wallet hands the page each transaction it built (`ACT_RELAY_SCHEMA`), one
 * message each, numbered from 1; the page answers each with
 * `ACT_RELAYED_SCHEMA`, saying whether it handed it to the service or refused
 * to. **That answer means "handed over", never "on the chain"**: a step that
 * needs to know what landed reads the chain itself. The action ends with one
 * `ACT_ENDED_SCHEMA` message, done or stopped, which is its one terminal answer.
 *
 * **AN ACTION THAT CHANGES THE PERSON'S SAVED KEYS HANDS THEM BACK SEALED**
 * (`ACT_KEEP_SCHEMA`), numbered from 1 apart from transactions, with the
 * service's version they are to be written over; the page answers each with
 * `ACT_KEPT_SCHEMA`, `kept` with the version the service now holds only once
 * the service has taken the write, or `refused`. They go in turn with the
 * transactions, so saved keys are kept before a transaction that needs them is
 * handed over.
 */
export const ACT_RELAY_SCHEMA = 'midnight-identity/act-relay/v1';
export const ACT_RELAYED_SCHEMA = 'midnight-identity/act-relayed/v1';
export const ACT_KEEP_SCHEMA = 'midnight-identity/act-keep/v1';
export const ACT_KEPT_SCHEMA = 'midnight-identity/act-kept/v1';
export const ACT_ENDED_SCHEMA = 'midnight-identity/act-ended/v1';
export const ACT_CALL_SCHEMA = 'midnight-identity/act-call/v1';
export const ACT_CALLED_SCHEMA = 'midnight-identity/act-called/v1';

/** The most steps one action may have, and the most transactions it may hand over; a wallet stops at either. */
export const MOST_ACT_STEPS = 64;
export const MOST_ACT_RELAYS = 256;

/** The largest transaction an action hands over, in base64 characters. */
export const MOST_ACT_TRANSACTION = 1_000_000;

/** The most service calls one action may ask the page to make: its reads are many, polling the records as the chain moves. */
export const MOST_ACT_CALLS = 4_096;

/** The longest body one call may carry, in characters: a filing with a transaction inside it. */
export const MOST_ACT_CALL_BODY = 4_000_000;

/** Where an action is: the step running, counted from 1, of how many. */
export interface StepAt {
  readonly step: number;
  readonly steps: number;
}

/**
 * One built transaction, handed to the page to send. `n` counts the transactions of this action from 1. `what`
 * names what it is for, from the action's own list (`act-intents.ts`), so the page knows where to send it; `also`
 * is a second transaction the service takes in the same request (an account's deploy and its signed second step).
 */
export interface ActRelay {
  readonly schema: typeof ACT_RELAY_SCHEMA;
  readonly nonce: string;
  readonly n: number;
  readonly step: number;
  readonly steps: number;
  readonly transaction: string;
  readonly what?: string;
  readonly also?: string;
}

/** What one relay is for, and the second transaction sent with it, if any. */
export interface RelayLabel {
  readonly what: string;
  readonly also?: string;
}

/** Saved keys an action sealed again, for the page to write over the version given. */
/**
 * One call to the service the wallet asks the page to make for an action:
 * numbered on their own from 1, a method, a path under `/api/`, and for a
 * write the JSON text it carries. The page makes it only when the action's own
 * route list names it, and answers with what the service said, which the wallet
 * takes as the page's word.
 */
export interface ActCall {
  readonly schema: typeof ACT_CALL_SCHEMA;
  readonly nonce: string;
  readonly n: number;
  readonly step: number;
  readonly steps: number;
  readonly method: 'GET' | 'PUT' | 'POST';
  readonly path: string;
  readonly body?: string;
}

/**
 * What became of a call: the service's status and body as the page reports
 * them; `refused` when the page would not make it; `unanswered` when the action
 * ended first; `gone` when the page could not be handed it.
 */
export type CalledOver = { readonly of: 'answered'; readonly status: number; readonly body: unknown } | 'refused' | 'unanswered' | 'gone';

export interface ActKeep {
  readonly schema: typeof ACT_KEEP_SCHEMA;
  readonly nonce: string;
  readonly n: number;
  readonly step: number;
  readonly steps: number;
  readonly sealed: SealedKeyring;
  readonly ifVersion: number;
}

/**
 * What became of saved keys a channel was asked to hand back: kept, with the service's version now; the page's
 * refusal; `unanswered` when the action ended before the page said; `gone` when they were never handed over.
 */
export type KeptOver = { readonly of: 'kept'; readonly version: number } | 'refused' | 'unanswered' | 'gone';

/** What the page did with one transaction: handed it to the service, or refused to. Never whether it landed. */
export type Relayed = 'relayed' | 'refused';

/**
 * What became of one transaction a channel was asked to hand over: the page's answer; `unanswered` when it was
 * handed to the page and the action ended before the page said; `gone` when it was never handed over.
 */
export type HandedOver = Relayed | 'unanswered' | 'gone';

/**
 * WHY AN ACTION STOPPED BEFORE ITS LAST STEP, IN A CLOSED LIST.
 *
 *   - `stopped` - the person pressed Stop.
 *   - `relay-refused` - the page said it would not send a transaction.
 *   - `no-relay-answer` - the page did not say what it did with one in time.
 *   - `out-of-time` - the action reached its own deadline.
 *   - `too-many` - the action would have had more steps or transactions than any action may.
 *   - `check-failed` - what this wallet checked after the passkey did not hold, so it built nothing.
 *   - `step-failed` - a step could not be built.
 *   - `keys-did-not-open` - the saved keys the page handed over did not open with this wallet's key for the person.
 *   - `older-keys` - the saved keys the page handed over are an older copy than ones this wallet has opened.
 *   - `keep-refused` - the page said the service did not keep the saved keys this wallet sealed again.
 *   - `no-keep-answer` - the page did not say in time whether they were kept.
 *   - `call-refused` - the page would not make a call to the service the action needed.
 *   - `no-call-answer` - the page did not say in time what the service answered to one.
 */
export const ACT_STOPS = [
  'stopped', 'relay-refused', 'no-relay-answer', 'out-of-time', 'too-many', 'check-failed', 'step-failed',
  'keys-did-not-open', 'older-keys', 'keep-refused', 'no-keep-answer', 'call-refused', 'no-call-answer',
] as const;
export type ActStop = (typeof ACT_STOPS)[number];

/**
 * **HOW AN ACTION ENDED: ITS ONE TERMINAL ANSWER.** `step` is the step it
 * ended at: on `done` the last; on `stopped` the first step that did not
 * finish, which is where it can be taken up again. `relayed` is how many
 * transactions the page said it handed over; `unconfirmed` is how many it was
 * handed and refused or did not answer: the page holds those and may still
 * send them, so whether they landed is read from the chain, never from these
 * counts. `outcome`, when the action's entry names one, carries only the
 * public facts it lists (a vault's address, a count, a short code), on either
 * ending, so the page can say where the action got to.
 */
export interface ActEnded {
  readonly schema: typeof ACT_ENDED_SCHEMA;
  readonly nonce: string;
  readonly intent: string;
  readonly ended: 'done' | 'stopped';
  readonly step: number;
  readonly steps: number;
  readonly relayed: number;
  readonly unconfirmed: number;
  readonly why?: ActStop;
  readonly outcome?: Readonly<Record<string, string | number>>;
  /**
   * When the action opened the person's saved keys: what they hold that is not secret, as the action left them
   * (`KeysRead`: the seats' public halves, the metadata, this wallet's public name, and no copy). Its one viewing key
   * at most is the action's own company's, given only when the ask handed that company's served keys in and the key
   * makes its inbox public key.
   */
  readonly keys?: KeysRead;
}

export type ChannelState =
  | { readonly of: 'waiting' }
  | { readonly of: 'request'; readonly request: Ask }
  | { readonly of: 'refused'; readonly error: RequestError | NoPageToAnswer };

interface Postable { postMessage(message: unknown, targetOrigin: string): void }

export interface ChannelWindow {
  readonly opener: Postable | null;
  /**
   * **THE PAGE THIS DOCUMENT IS FRAMED BY, OR THIS WINDOW ITSELF WHEN IT IS NOT.**
   * Optional so a view that only ever modelled a window opened by another page
   * keeps meaning exactly that: no `parent` is a top-level window.
   */
  readonly parent?: Postable | null;
  /** This window, so `parent === self` can say *not framed*. */
  readonly self?: unknown;
  /**
   * The origins of every page this document sits inside, nearest first, where
   * the browser reports them. Chromium and WebKit do; Firefox does not, and
   * there the asker's observed origin is the whole of the check.
   */
  readonly location?: { readonly ancestorOrigins?: { readonly length: number; readonly [i: number]: string } };
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

/**
 * **WHERE THIS WALLET DOCUMENT SITS, DECIDED ONCE.**
 *
 *   - `top` - a window of its own. The asker is the page that opened it
 *     (`opener`), and only when the browser saw that page at the one origin the
 *     wallet was built for; nothing else can be the asker.
 *   - `framed` - inside the ONE page it was built to sit inside. The asker is
 *     that frame's parent, at exactly that origin, and nothing else.
 *   - `refused` - inside a page it was not built for, or inside a page that is
 *     itself inside another. **Nothing is answered and nothing is shown.**
 */
export type Framing =
  | { readonly of: 'top' }
  | { readonly of: 'framed'; readonly embedder: string }
  | { readonly of: 'refused'; readonly why: string };

export const NOT_BUILT_TO_BE_FRAMED =
  'this wallet has been put inside another page and it was not built to be, so it shows nothing '
  + 'and answers nothing here. Open your wallet in its own tab.';

export const FRAMED_BY_A_STRANGER =
  'this wallet has been put inside a page it does not know, so it shows nothing and answers '
  + 'nothing here. Open your wallet in its own tab.';

export const NO_PAGE_TO_ANSWER =
  'This wallet was set up without the address of your company\'s page, so it answers no page '
  + 'and nothing was sent. Close this window and tell whoever runs your company\'s page; once the '
  + 'wallet is set up, open it again from that page. For whoever runs the wallet: build it with '
  + 'VITE_APP_ORIGIN set to that page\'s address.';

/**
 * The refusal a wallet in a window of its own shows when it was built with no
 * page origin: it will answer nobody. The person is told what they can do, and
 * whoever runs the wallet which build setting fixes it.
 */
export class NoPageToAnswer extends Error {
  readonly code = 'no-page-configured' as const;
  constructor() {
    super(NO_PAGE_TO_ANSWER);
    this.name = 'NoPageToAnswer';
  }
}

export function framingOf(view: ChannelWindow, embedder: string | null): Framing {
  const parent = view.parent ?? null;
  if (parent === null || parent === (view.self ?? view)) return { of: 'top' };
  if (embedder === null) return { of: 'refused', why: NOT_BUILT_TO_BE_FRAMED };
  /*
   * EVERY ANCESTOR, NOT ONLY THE NEAREST. The page allowed to hold this wallet
   * must itself be the top of the tab: the same page framed by a stranger is a
   * stranger's page with ours inside it, and the person cannot see the join.
   */
  const ancestors = view.location?.ancestorOrigins;
  if (ancestors !== undefined) {
    for (let i = 0; i < ancestors.length; i += 1) {
      if (ancestors[i] !== embedder) return { of: 'refused', why: FRAMED_BY_A_STRANGER };
    }
  }
  return { of: 'framed', embedder };
}

/**
 * WHAT MAY GO BACK.
 *
 * **The channel still does not know what any of these are.** It posts what it
 * is given to the origin it observed, and a channel that branched on the kind
 * of answer would be a second place to keep in step with the first -- which is
 * the sentence written about requests, from the other end.
 *
 * Some of these carry a secret (a released company key, or the keyring key that
 * opens the seat secrets) and the rest do not, which is why `send` below has
 * only ever had one target: the observed origin, never `'*'`.
 *
 * **AND THE THIRD IS THE ONE THAT IS NOT FOR THE PAGE IT IS POSTED TO.** A
 * `SealedAcceptance` crosses to the requester exactly like the other two and is
 * opened by whoever holds the company's inbox key, who need not be the page
 * that asked (`inbox.ts`). **That changes nothing here and it is worth saying
 * why**: the targeting rule is about who may RECEIVE the message, and it is
 * unchanged -- the observed origin, never `'*'`. What the seal adds is a second
 * question, who may READ it, and that is answered in `inbox.ts` rather than by
 * a channel that would then have two rules to keep in step.
 */
export type Answer =
  | DisclosureResponse | UnlockRelease | KeyringRelease | SealedAcceptance | BalancedAnswer | CommitteeSignatures
  | RecordsKeyAnswer | HoldersAnswer | CreationSignature | JoinCode | AddressesAndBalances | ActEnded;

/**
 * **WHY A PAYMENT THE PERSON APPROVED DID NOT HAPPEN, IN FOUR WORDS AND NO MORE.**
 *
 * A person who pressed Pay and saw it fail did not decline, and a page that
 * tells them they did sends them looking for a mistake they never made. So a
 * failure after approval is its own refusal, and it carries one of these.
 *
 * **A CLOSED LIST, NOT THE WALLET'S OWN SENTENCE.** The wallet's words about a
 * failure can name its coins, its amounts or its state, and the page asking is
 * not the person. What crosses is which of four things happened, and the page
 * says it in its own words. `not-enough` does tell the page one thing it did
 * not know before: that this wallet could not cover the amount it was asked for.
 *
 *   - `chain-unreadable` - the wallet could not read the chain to find its coins.
 *   - `not-enough` - the wallet does not hold enough of what the payment needs.
 *   - `not-as-approved` - what the wallet was about to add was not what the
 *     person approved, so it stopped before signing.
 *   - `did-not-finish` - anything else that stopped it after the press.
 */
export const PAYMENT_FAILURES = ['chain-unreadable', 'not-enough', 'not-as-approved', 'did-not-finish'] as const;
export type PaymentFailure = (typeof PAYMENT_FAILURES)[number];

/**
 * **WHY A REQUEST WAS REFUSED WITHOUT ANYBODY BEING ASKED.** `declined` is a
 * person saying no; `expired` is a deadline that had passed when it arrived;
 * `unreadable` is this wallet refusing what was sent before a person could
 * approve it - a request it could not read, or a transaction it will not pay
 * for. The person declined nothing, so it is never said as a decline; nothing
 * was approved, so it is never said as a failure.
 */
export type Refusal = 'declined' | 'expired' | 'unreadable';

/**
 * **ONE TERMINAL MESSAGE PER REQUEST, AND EVERY METHOD SAYS WHETHER IT SENT.**
 *
 * `answer` and `refuse` end the conversation. The first of them that reaches
 * the asker is the only one: every later call sends nothing and answers
 * `false`, so a caller that finishes second knows that what it holds was never
 * handed over. A page that has already been told *nothing was paid* must never
 * be handed a paid transaction afterwards, and one that was handed a paid
 * transaction must never be told it failed.
 */
export interface Channel {
  /** Send the answer back — to the OBSERVED origin, and nowhere else. */
  answer(answer: Answer): boolean;
  /** Tell the requester no, and which of three kinds of no, without saying anything else. */
  refuse(reason: Refusal): boolean;
  /** Tell the requester a payment the person approved did not happen, and which of four reasons stopped it. */
  refuse(reason: 'failed', why: PaymentFailure): boolean;
  /** Say what this wallet is doing now. Never ends anything; sent only to a page that asked to hear it. */
  progress(stage: ProgressStage): boolean;
  /** Whether the one terminal message has gone. */
  over(): boolean;
  stop(): void;
}

/**
 * **THE SAME CHANNEL, FOR AN ACTION THAT RUNS FOR MINUTES ON ONE WINDOW.**
 * Besides the one terminal answer, it says which step is running and hands the
 * page each built transaction, any saved keys it sealed again and each call to
 * the service it needs made, then waits for the page to say what it did with
 * each. Every one of these is sent only to the page that asked, only for an
 * `act` ask, and only until the action has ended.
 */
export interface ActingChannel extends Channel {
  /** Say which step is running; said again while it runs, so the page keeps waiting. */
  step(at: StepAt): boolean;
  /**
   * Hand one built transaction to the page. Resolves with what the page said it
   * did with it; `unanswered` if the action ended first; `gone` if the page could
   * not be handed it.
   */
  relay(at: StepAt, transaction: string, label?: RelayLabel): Promise<HandedOver>;
  /**
   * Hand the person's saved keys, sealed again, to the page to keep over the
   * service's version given. Resolves with the version the page says the
   * service now holds, or the page's refusal; `unanswered` if the action ended
   * first; `gone` if the page could not be handed them.
   */
  keep(at: StepAt, sealed: SealedKeyring, ifVersion: number): Promise<KeptOver>;
  /**
   * Ask the page to make one call to the service. Resolves with the status and
   * body the page reports, or the page's refusal; `unanswered` if the action
   * ended first; `gone` if the page could not be asked.
   */
  call(at: StepAt, method: ActCall['method'], path: string, body?: string): Promise<CalledOver>;
}

const REFUSED_SCHEMA = 'midnight-identity/disclosure-refused/v1';

/**
 * **WHO MAY ASK. THIS IS THE WHOLE ASKER CHECK, AND IT HAS TWO SHAPES.**
 *
 * **A window of its own answers only the page that opened it, and only at the
 * one origin it was built for** (`page`, the same origin a frame is checked
 * against). `opener` is filled in by the browser and no page can set it on a
 * window it did not open, but ANY page can open the wallet; without the origin
 * a stranger's page that opens it would be shown its ask and answered. With no
 * page origin configured, nobody is answered.
 *
 * **A framed wallet answers only its parent, and only at the one origin it was
 * built to sit inside.** In a frame `opener` is `null`, so the first shape
 * answers nobody - and replacing `opener` with `parent` alone would answer
 * ANY page that frames it. So both halves are required: the message came from
 * the window directly above this one, and the browser observed it coming from
 * the allowed origin. A frame nested in a stranger's page, or a stranger's page
 * framing this wallet directly, fails one or the other.
 *
 * **THIS IS NOT THE ONLY THING STANDING BEHIND A FRAME, AND IT MUST NOT BE.**
 * A `frame-ancestors` header for the same origin stops a stranger's page loading
 * the wallet at all - wherever the host serving it sends one, which is a
 * property of the deployment and not of this file; and the approval screen holds
 * a press until the frame is large enough, showing, and the request has been in
 * front of the person for a moment. Each alone leaves a way in.
 */
export function askerIsAllowed(
  view: ChannelWindow, framing: Framing, event: MessageEvent, page: string | null,
): boolean {
  /* `!= null` AND NOT `!== null`: a window with no opener reports `null`, and
   * some environments report `undefined`. Either is no opener - and an
   * `undefined` read as an opener would compare equal to a message whose
   * source is missing. */
  if (view.opener != null) {
    /*
     * ONLY FROM THE PAGE THAT OPENED THIS TAB, AND ONLY AT THE PAGE ORIGIN.
     * Anything else on this window - an extension, another frame, a
     * `postMessage` from a page that merely has a handle - is not the
     * conversation the person opened the wallet for; and the opener itself is
     * only the page the wallet was built for when the browser saw it there.
     */
    return event.source === (view.opener as unknown as MessageEventSource)
      && event.origin === page;
  }
  if (framing.of !== 'framed') return false;
  return event.source === (view.parent as unknown as MessageEventSource)
    && event.origin === framing.embedder;
}

/**
 * **EVERY ASK THIS WINDOW HAS ALREADY ANSWERED**, by the page that asked and the
 * nonce it chose. One terminal message per ask, not per channel: a screen that
 * is put away and shown again opens a second channel on the same window, and a
 * page that sends its ask again would otherwise be answered twice - a refusal
 * after a payment, or a payment after a refusal. Kept per window, for as long as
 * the window is open, and never written anywhere.
 */
const answeredHere = new WeakMap<ChannelWindow, Set<string>>();
const answeredIn = (view: ChannelWindow): Set<string> => {
  let answered = answeredHere.get(view);
  if (answered === undefined) { answered = new Set(); answeredHere.set(view, answered); }
  return answered;
};

/**
 * LISTEN FOR ONE REQUEST, ANSWER IT ONCE.
 *
 * **ONE REQUEST, AND THE SECOND IS IGNORED.** A page that can send a second
 * request while the first is on screen can change what the person is looking
 * at while they read it, so a second request on this channel is ignored. After
 * an `act` ask, the only thing still heard is the page saying what it did with
 * a transaction or saved keys this channel handed it, from the same window and
 * origin.
 */
export function listen(
  view: ChannelWindow,
  now: () => number,
  onState: (state: ChannelState) => void,
  /**
   * The one page origin this wallet answers, framed or in a window of its own,
   * from the build's configuration. `null` - the default - means no page: a
   * framed wallet answers nobody, and a wallet in a window of its own answers
   * nobody and shows `NoPageToAnswer`.
   */
  embedder: string | null = null,
): ActingChannel {
  let settled = false;
  let source: MessageEventSource | null = null;
  let origin: string | null = null;
  /* Set once, from the parsed request; a request that did not parse hears nothing but its refusal. */
  let hearsProgress = false;
  let ended = false;
  /* Set once, from the parsed request: only an `act` ask hands transactions over and hears what became of them. */
  let acting: string | null = null;
  let relays = 0;
  const waiting = new Map<number, (relayed: HandedOver) => void>();
  let keeps = 0;
  const waitingKeeps = new Map<number, (kept: KeptOver) => void>();
  let calls = 0;
  const waitingCalls = new Map<number, (called: CalledOver) => void>();
  /* Which ask this channel is answering: the observed origin and the ask's own nonce. */
  let ask: string | null = null;
  const framing = framingOf(view, embedder);

  const send = (message: unknown): boolean => {
    if (source === null || origin === null) return false;
    (source as unknown as { postMessage(m: unknown, t: string): void })
      .postMessage(message, origin);
    return true;
  };
  /* **THE ONE PLACE THE CONVERSATION ENDS.** Every terminal message passes here. */
  const end = (message: unknown): boolean => {
    if (ended) return false;
    if (ask !== null && answeredIn(view).has(ask)) { ended = true; return false; }
    if (!send(message)) return false;
    ended = true;
    if (ask !== null) answeredIn(view).add(ask);
    for (const [, resolve] of waiting) resolve('unanswered');
    waiting.clear();
    for (const [, resolve] of waitingKeeps) resolve('unanswered');
    waitingKeeps.clear();
    for (const [, resolve] of waitingCalls) resolve('unanswered');
    waitingCalls.clear();
    return true;
  };

  /*
   * WHAT THE PAGE SAID IT DID WITH A TRANSACTION OR WITH SAVED KEYS. Heard
   * only on an `act` ask, only from the window and origin that asked, only for
   * this ask's nonce and a transaction or saved keys still waiting for their
   * answer; anything else is ignored.
   */
  const heardAfterTheAsk = (event: MessageEvent): void => {
    if (acting === null || ended || event.source !== source || event.origin !== origin) return;
    const body = (event.data ?? null) as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || body['nonce'] !== acting) return;
    if (body['schema'] === ACT_KEPT_SCHEMA) {
      const k = body['n'];
      const kept = typeof k === 'number' ? waitingKeeps.get(k) : undefined;
      if (kept === undefined) return;
      waitingKeeps.delete(k as number);
      const version = body['version'];
      /* Kept only with the version the service now holds: a `kept` without one is not taken as kept. */
      kept(body['outcome'] === 'kept' && typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
        ? Object.freeze({ of: 'kept' as const, version })
        : 'refused');
      return;
    }
    if (body['schema'] === ACT_CALLED_SCHEMA) {
      const c = body['n'];
      const called = typeof c === 'number' ? waitingCalls.get(c) : undefined;
      if (called === undefined) return;
      waitingCalls.delete(c as number);
      const status = body['status'];
      called(body['outcome'] === 'answered' && typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599
        ? Object.freeze({ of: 'answered' as const, status, body: body['body'] ?? null })
        : 'refused');
      return;
    }
    if (body['schema'] !== ACT_RELAYED_SCHEMA) return;
    const n = body['n'];
    const resolve = typeof n === 'number' ? waiting.get(n) : undefined;
    if (resolve === undefined) return;
    waiting.delete(n as number);
    resolve(body['outcome'] === 'relayed' ? 'relayed' : 'refused');
  };

  const handler = (event: MessageEvent): void => {
    if (!askerIsAllowed(view, framing, event, embedder)) return;
    if (settled) { heardAfterTheAsk(event); return; }
    const body = (event.data ?? null) as { schema?: unknown } | null;
    if (body === null || typeof body !== 'object') return;
    if (body.schema !== 'midnight-identity/disclosure-request/v1') return;

    settled = true;
    source = event.source;
    /* THE ONE LINE THIS MODULE IS FOR. The browser's value, not the payload's. */
    origin = event.origin;
    const nonce = (body as { nonce?: unknown }).nonce;
    ask = typeof nonce === 'string' ? `${event.origin}\n${nonce}` : null;
    /* An ask this window has already answered is not shown again: its one answer has gone. */
    if (ask !== null && answeredIn(view).has(ask)) {
      ended = true;
      /* Said, so a screen that asks `over()` looks again; there is still no request to show. */
      onState({ of: 'waiting' });
      return;
    }
    let request: Ask;
    try {
      request = parseAsk(event.data, event.origin, now());
    } catch (e) {
      /*
       * **A REQUEST THIS WALLET WILL NOT SHOW IS STILL ANSWERED, AT ONCE.** The
       * asker is known - its window and the origin the browser observed are
       * held above - so it is told now rather than left waiting for a person
       * who will never be asked. A request that arrived too late is told it
       * expired, which the asker already has words for; anything else is
       * `unreadable`.
       */
      end({
        schema: REFUSED_SCHEMA,
        reason: (e as Partial<RequestError> | null)?.code === 'expired' ? 'expired' : 'unreadable',
      });
      onState({ of: 'refused', error: e as RequestError });
      return;
    }
    hearsProgress = request.hearsProgress === true;
    if (request.kind === 'act') acting = request.nonce;
    onState({ of: 'request', request });
  };

  view.addEventListener('message', handler);
  onState({ of: 'waiting' });
  if (view.opener != null && embedder === null) onState({ of: 'refused', error: new NoPageToAnswer() });

  /*
   * **THE READY PING IS ADDRESSED, NEVER BROADCAST.** The one page origin the
   * wallet answers is known from the build, so the ping is sent to it alone: a
   * page at any other origin, whether it opened the wallet or framed it, is
   * told nothing, not even that a wallet is listening. With no page origin
   * configured nobody is answered, so nobody is pinged.
   */
  if (view.opener != null) {
    if (embedder !== null) view.opener.postMessage({ schema: READY_PING }, embedder);
  } else if (framing.of === 'framed') {
    (view.parent as Postable).postMessage({ schema: READY_PING }, framing.embedder);
  }

  return Object.freeze({
    answer: (answer: Answer) => end(answer),
    refuse: (reason: Refusal | 'failed', why?: PaymentFailure) => end(reason === 'failed'
      ? {
        schema: REFUSED_SCHEMA, reason,
        /* Only a word from the list crosses, whatever the caller handed in. */
        why: (PAYMENT_FAILURES as readonly unknown[]).includes(why) ? why : 'did-not-finish',
      }
      : { schema: REFUSED_SCHEMA, reason }),
    progress: (stage: ProgressStage) => {
      if (ended || !hearsProgress) return false;
      /* Only a stage from the list crosses, whatever the caller handed in. */
      if (!(PROGRESS_STAGES as readonly unknown[]).includes(stage)) return false;
      return send({ schema: PROGRESS_SCHEMA, stage });
    },
    /* Over once this channel has ended, or once another channel on this window has answered the same ask. */
    over: () => ended || (ask !== null && answeredIn(view).has(ask)),
    stop: () => view.removeEventListener('message', handler),
    step: (at: StepAt) => {
      if (ended || acting === null || !countFrom1(at.steps, MOST_ACT_STEPS) || !countFrom1(at.step, at.steps)) return false;
      return send({ schema: PROGRESS_SCHEMA, stage: 'proving', step: at.step, steps: at.steps });
    },
    relay: (at: StepAt, transaction: string, label?: RelayLabel): Promise<HandedOver> => {
      if (ended || acting === null || relays >= MOST_ACT_RELAYS) return Promise.resolve('gone');
      const n = relays + 1;
      const message = {
        schema: ACT_RELAY_SCHEMA, nonce: acting, n, step: at.step, steps: at.steps, transaction,
        ...(label === undefined ? {} : { what: label.what, ...(label.also === undefined ? {} : { also: label.also }) }),
      };
      if (readActRelay(message, acting) === null) return Promise.resolve('gone');
      return new Promise<HandedOver>((resolve) => {
        waiting.set(n, resolve);
        relays = n;
        if (!send(message)) { waiting.delete(n); resolve('gone'); }
      });
    },
    keep: (at: StepAt, sealed: SealedKeyring, ifVersion: number): Promise<KeptOver> => {
      if (ended || acting === null || keeps >= MOST_ACT_RELAYS) return Promise.resolve('gone');
      const n = keeps + 1;
      const message = { schema: ACT_KEEP_SCHEMA, nonce: acting, n, step: at.step, steps: at.steps, sealed, ifVersion };
      if (readActKeep(message, acting) === null) return Promise.resolve('gone');
      return new Promise<KeptOver>((resolve) => {
        waitingKeeps.set(n, resolve);
        keeps = n;
        if (!send(message)) { waitingKeeps.delete(n); resolve('gone'); }
      });
    },
    call: (at: StepAt, method: ActCall['method'], path: string, body?: string): Promise<CalledOver> => {
      if (ended || acting === null || calls >= MOST_ACT_CALLS) return Promise.resolve('gone');
      const n = calls + 1;
      const message = { schema: ACT_CALL_SCHEMA, nonce: acting, n, step: at.step, steps: at.steps, method, path, ...(body === undefined ? {} : { body }) };
      if (readActCall(message, acting) === null) return Promise.resolve('gone');
      return new Promise<CalledOver>((resolve) => {
        waitingCalls.set(n, resolve);
        calls = n;
        if (!send(message)) { waitingCalls.delete(n); resolve('gone'); }
      });
    },
  });
}
