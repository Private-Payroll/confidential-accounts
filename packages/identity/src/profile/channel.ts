import type { BalancedAnswer } from './balance.js';
import type { CommitteeSignatures } from './committee-sign.js';
import type { HoldersAnswer, RecordsKeyAnswer } from './records-key.js';
import type { CreationSignature } from './creation-sign.js';
import { PROGRESS_SCHEMA, parseAsk } from './request.js';
import type { Ask, RequestError } from './request.js';
import type { DisclosureResponse } from './disclosure.js';
import type { KeyringRelease, UnlockRelease } from './unlock.js';
import type { SealedAcceptance } from './inbox.js';

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
 * branched on kind would be a second place to keep in step with the first.
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
 * restarts its wait on each one would wait for ever on a dead wallet.
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
}

export type ChannelState =
  | { readonly of: 'waiting' }
  | { readonly of: 'request'; readonly request: Ask }
  | { readonly of: 'refused'; readonly error: RequestError };

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
 *   - `top` - a window of its own. A page that opened it is `opener`; nothing
 *     else can be the asker.
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
 * WHAT MAY GO BACK. ONE CHANGE ADDS A MEMBER AND NOTHING ELSE. ANOTHER ADDS A THIRD.
 *
 * **The channel still does not know what any of these are.** It posts what it
 * is given to the origin it observed, and a channel that branched on the kind
 * of answer would be a second place to keep in step with the first -- which is
 * the sentence written about requests, from the other end.
 *
 * One of these carries a secret and the other does not, which is precisely why
 * `send` below has only ever had one target: the observed origin, never `'*'`.
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
  | RecordsKeyAnswer | HoldersAnswer | CreationSignature;

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

const REFUSED_SCHEMA = 'midnight-identity/disclosure-refused/v1';

/**
 * **WHO MAY ASK. THIS IS THE WHOLE ASKER CHECK, AND IT HAS TWO SHAPES.**
 *
 * **A window of its own answers only the page that opened it** - `opener`, which
 * the browser fills in and no page can set on a window it did not open.
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
export function askerIsAllowed(view: ChannelWindow, framing: Framing, event: MessageEvent): boolean {
  /* `!= null` AND NOT `!== null`: a window with no opener reports `null`, and
   * some environments report `undefined`. Either is no opener - and an
   * `undefined` read as an opener would compare equal to a message whose
   * source is missing. */
  if (view.opener != null) {
    /*
     * ONLY FROM THE PAGE THAT OPENED THIS TAB. Anything else on this window —
     * an extension, another frame, a `postMessage` from a page that merely has
     * a handle — is not the conversation the person opened the wallet for.
     */
    return event.source === (view.opener as unknown as MessageEventSource);
  }
  if (framing.of !== 'framed') return false;
  return event.source === (view.parent as unknown as MessageEventSource)
    && event.origin === framing.embedder;
}

/**
 * LISTEN FOR ONE REQUEST, ANSWER IT ONCE.
 *
 * **ONE REQUEST, AND THE SECOND IS IGNORED.** Trouble is where the side
 * holding the value refused nothing while the other side refused a second
 * conversation, and a relay ground a number in seventy-one tries through the
 * gap. The side holding a person's details refuses a second request here, for
 * the same reason: a page that can send a second request while the first is on
 * screen can change what the person is looking at while they are reading it.
 */
export function listen(
  view: ChannelWindow,
  now: () => number,
  onState: (state: ChannelState) => void,
  /**
   * The one page allowed to frame this wallet, from the build's configuration.
   * `null` - the default - means no page may, and a framed wallet answers nobody.
   */
  embedder: string | null = null,
): Channel {
  let settled = false;
  let source: MessageEventSource | null = null;
  let origin: string | null = null;
  /* Set once, from the parsed request; a request that did not parse hears nothing but its refusal. */
  let hearsProgress = false;
  let ended = false;
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
    if (!send(message)) return false;
    ended = true;
    return true;
  };

  const handler = (event: MessageEvent): void => {
    if (settled) return;
    if (!askerIsAllowed(view, framing, event)) return;
    const body = (event.data ?? null) as { schema?: unknown } | null;
    if (body === null || typeof body !== 'object') return;
    if (body.schema !== 'midnight-identity/disclosure-request/v1') return;

    settled = true;
    source = event.source;
    /* THE ONE LINE THIS MODULE IS FOR. The browser's value, not the payload's. */
    origin = event.origin;
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
    onState({ of: 'request', request });
  };

  view.addEventListener('message', handler);
  onState({ of: 'waiting' });

  /*
   * THE READY PING GOES TO `'*'` AND CARRIES NOTHING, WHICH IS WHY THAT IS SAFE.
   *
   * The wallet cannot target the requester's origin, because it does not know
   * it yet — knowing it is the thing this whole module exists to arrange. So
   * the ping is one constant string with no data of any kind: a page that
   * receives it learns that a wallet tab it opened is listening, which it
   * already knew because it opened it.
   */
  if (view.opener != null) {
    view.opener.postMessage({ schema: READY_PING }, '*');
  } else if (framing.of === 'framed') {
    /*
     * **IN A FRAME THE PING IS ADDRESSED, NOT BROADCAST.** The origin allowed to
     * hold this wallet is already known from the build, so there is nothing to
     * learn by sending to `'*'` - and a page that framed it without being that
     * origin is told nothing, not even that a wallet is listening.
     */
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
    over: () => ended,
    stop: () => view.removeEventListener('message', handler),
  });
}
