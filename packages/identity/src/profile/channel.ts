import { parseAsk } from './request.js';
import type { Ask, RequestError } from './request.js';
import type { DisclosureResponse } from './disclosure.js';
import type { UnlockRelease } from './unlock.js';
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

export interface ChannelWindow {
  readonly opener: { postMessage(message: unknown, targetOrigin: string): void } | null;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
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
export type Answer = DisclosureResponse | UnlockRelease | SealedAcceptance;

export interface Channel {
  /** Send the answer back — to the OBSERVED origin, and nowhere else. */
  answer(answer: Answer): void;
  /** Tell the requester the person said no, without saying anything else. */
  refuse(reason: 'declined' | 'expired'): void;
  stop(): void;
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
): Channel {
  let settled = false;
  let source: MessageEventSource | null = null;
  let origin: string | null = null;

  const handler = (event: MessageEvent): void => {
    if (settled) return;
    /*
     * ONLY FROM THE PAGE THAT OPENED THIS TAB. Anything else on this window —
     * an extension, another frame, a `postMessage` from a page that merely has
     * a handle — is not the conversation the person opened the wallet for.
     */
    if (view.opener === null || event.source !== (view.opener as unknown as MessageEventSource)) {
      return;
    }
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
  view.opener?.postMessage({ schema: READY_PING }, '*');

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
