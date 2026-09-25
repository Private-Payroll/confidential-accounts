import type { BalancedAnswer } from './balance.js';
import type { CommitteeSignatures } from './committee-sign.js';
import { parseAsk } from './request.js';
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
  | DisclosureResponse | UnlockRelease | KeyringRelease | SealedAcceptance | BalancedAnswer | CommitteeSignatures;

export interface Channel {
  /** Send the answer back — to the OBSERVED origin, and nowhere else. */
  answer(answer: Answer): void;
  /** Tell the requester the person said no, without saying anything else. */
  refuse(reason: 'declined' | 'expired'): void;
  stop(): void;
}

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
  const framing = framingOf(view, embedder);

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
    try {
      onState({ of: 'request', request: parseAsk(event.data, event.origin, now()) });
    } catch (e) {
      onState({ of: 'refused', error: e as RequestError });
    }
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

  const send = (message: unknown): void => {
    if (source === null || origin === null) return;
    (source as unknown as { postMessage(m: unknown, t: string): void })
      .postMessage(message, origin);
  };

  return Object.freeze({
    answer: (answer: Answer) => send(answer),
    refuse: (reason: 'declined' | 'expired') => send({
      schema: 'midnight-identity/disclosure-refused/v1', reason,
    }),
    stop: () => view.removeEventListener('message', handler),
  });
}
