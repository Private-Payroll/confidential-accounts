import { describe, expect, it } from 'vitest';
import {
  FRAMED_BY_A_STRANGER, NOT_BUILT_TO_BE_FRAMED, PAYMENT_FAILURES, PROGRESS_SCHEMA, PROGRESS_STAGES, READY_PING,
  framingOf, listen,
} from './channel.js';
import type { ChannelState, ChannelWindow } from './channel.js';

/**
 * **WHO A WALLET ANSWERS, IN A WINDOW OF ITS OWN AND INSIDE A PAGE.**
 *
 * In a window of its own the asker is `opener`, which the browser fills in. In
 * a frame `opener` is `null` - so a check written only for the window answers
 * nobody, and the obvious repair, answering `parent`, answers ANY page that
 * frames the wallet. The cases below hold both halves of the framed check at
 * once: the message has to come from the window directly above, AND the browser
 * has to have observed it coming from the one origin the wallet was built for.
 */

const NOW = 1_755_000_000_000;
const EMBEDDER = 'https://app.payroll-a.example';
const STRANGER = 'https://evil.example';

const signIn = (): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'sign-in',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'So we know it is you.',
  nonce: 'n1',
  expiresAt: NOW + 60_000,
});

interface Posted { readonly message: unknown; readonly target: string }

/** A window that records what was posted to it. */
const postable = () => {
  const posted: Posted[] = [];
  return { posted, postMessage: (message: unknown, target: string) => { posted.push({ message, target }); } };
};

/** A wallet document: framed by `parent` when one is given, otherwise opened by `opener`. */
function walletView(opts: {
  opener?: ReturnType<typeof postable> | null;
  parent?: ReturnType<typeof postable> | null;
  ancestors?: string[];
}) {
  let handler: ((e: MessageEvent) => void) | null = null;
  const view: ChannelWindow & { deliver(e: Partial<MessageEvent>): void } = {
    opener: opts.opener ?? null,
    parent: undefined,
    self: undefined,
    location: opts.ancestors ? { ancestorOrigins: opts.ancestors } : undefined,
    addEventListener: (_t, h) => { handler = h; },
    removeEventListener: () => { handler = null; },
    deliver: (e) => handler?.(e as MessageEvent),
  };
  (view as { self: unknown }).self = view;
  (view as { parent: unknown }).parent = opts.parent === undefined ? view : opts.parent;
  return view;
}

const run = (view: ChannelWindow, embedder: string | null) => {
  const states: ChannelState[] = [];
  listen(view, () => NOW, (s) => states.push(s), embedder);
  return states;
};

describe('§1 - A WINDOW OF ITS OWN IS UNCHANGED BY FRAMING', () => {
  it('answers the page that opened it and nobody else, with or without an embedder configured', () => {
    for (const embedder of [null, EMBEDDER]) {
      const opener = postable();
      const view = walletView({ opener });
      const states = run(view, embedder);
      view.deliver({ source: postable() as never, origin: EMBEDDER, data: signIn() });
      expect(states.map((s) => s.of), `a stranger, embedder ${embedder}`).toEqual(['waiting']);
      view.deliver({ source: opener as never, origin: EMBEDDER, data: signIn() });
      expect(states.map((s) => s.of)).toEqual(['waiting', 'request']);
      /* the ping is the unchanged broadcast to the opener */
      expect(opener.posted).toEqual([{ message: { schema: READY_PING }, target: '*' }]);
    }
  });
});

describe('§2 - A FRAMED WALLET ANSWERS ITS PARENT, AT THE ONE ORIGIN IT WAS BUILT FOR', () => {
  it('ANSWERS the parent when the browser observed the allowed origin', () => {
    const parent = postable();
    const view = walletView({ parent, ancestors: [EMBEDDER] });
    const states = run(view, EMBEDDER);
    view.deliver({ source: parent as never, origin: EMBEDDER, data: signIn() });
    expect(states.map((s) => s.of)).toEqual(['waiting', 'request']);
  });

  it('REFUSES the parent at any other origin - `parent` alone would answer every page that frames it', () => {
    const parent = postable();
    const view = walletView({ parent });
    const states = run(view, EMBEDDER);
    view.deliver({ source: parent as never, origin: STRANGER, data: signIn() });
    expect(states.map((s) => s.of)).toEqual(['waiting']);
  });

  it('REFUSES the allowed origin from any window but the parent - an origin is not a window', () => {
    const parent = postable();
    const view = walletView({ parent });
    const states = run(view, EMBEDDER);
    view.deliver({ source: postable() as never, origin: EMBEDDER, data: signIn() });
    expect(states.map((s) => s.of)).toEqual(['waiting']);
  });

  it('ANSWERS NOBODY when no embedder was configured - a standalone wallet is framed by no page', () => {
    const parent = postable();
    const view = walletView({ parent });
    const states = run(view, null);
    view.deliver({ source: parent as never, origin: EMBEDDER, data: signIn() });
    expect(states.map((s) => s.of)).toEqual(['waiting']);
    expect(parent.posted).toEqual([]);
  });

  it('ADDRESSES the ready ping to the allowed origin, never to `*`', () => {
    const parent = postable();
    const view = walletView({ parent });
    run(view, EMBEDDER);
    expect(parent.posted).toEqual([{ message: { schema: READY_PING }, target: EMBEDDER }]);
  });
});

describe('§3 - WHERE THE BROWSER NAMES THE ANCESTORS, EVERY ONE OF THEM MUST BE THE ALLOWED PAGE', () => {
  it('is TOP-LEVEL when the window is its own parent', () => {
    const view = walletView({});
    expect(framingOf(view, EMBEDDER)).toEqual({ of: 'top' });
  });

  it('is FRAMED by the allowed page when that page is the top of the tab', () => {
    const view = walletView({ parent: postable(), ancestors: [EMBEDDER] });
    expect(framingOf(view, EMBEDDER)).toEqual({ of: 'framed', embedder: EMBEDDER });
  });

  it('is REFUSED inside a stranger, and inside the allowed page when a stranger frames THAT', () => {
    expect(framingOf(walletView({ parent: postable(), ancestors: [STRANGER] }), EMBEDDER))
      .toEqual({ of: 'refused', why: FRAMED_BY_A_STRANGER });
    expect(framingOf(walletView({ parent: postable(), ancestors: [EMBEDDER, STRANGER] }), EMBEDDER))
      .toEqual({ of: 'refused', why: FRAMED_BY_A_STRANGER });
  });

  it('is REFUSED in any frame when no embedder was configured', () => {
    expect(framingOf(walletView({ parent: postable(), ancestors: [EMBEDDER] }), null))
      .toEqual({ of: 'refused', why: NOT_BUILT_TO_BE_FRAMED });
  });

  it('and a refused framing answers nobody, even the parent at the allowed origin', () => {
    const parent = postable();
    const view = walletView({ parent, ancestors: [EMBEDDER, STRANGER] });
    const states = run(view, EMBEDDER);
    view.deliver({ source: parent as never, origin: EMBEDDER, data: signIn() });
    expect(states.map((s) => s.of)).toEqual(['waiting']);
    expect(parent.posted).toEqual([]);
  });
});

describe('§4 - AN `undefined` OPENER IS NO OPENER', () => {
  it('a message with no source is not mistaken for one from an opener that is not there', () => {
    let handler: ((e: MessageEvent) => void) | null = null;
    const view = {
      opener: undefined as unknown as null,
      addEventListener: (_t: 'message', h: (e: MessageEvent) => void) => { handler = h; },
      removeEventListener: () => {},
    } as ChannelWindow;
    const states = run(view, EMBEDDER);
    handler!({ source: undefined, origin: EMBEDDER, data: signIn() } as unknown as MessageEvent);
    expect(states.map((s) => s.of)).toEqual(['waiting']);
  });
});

describe('A PAYMENT THAT FAILED AFTER THE PRESS IS NOT A DECLINE', () => {
  const REFUSED = 'midnight-identity/disclosure-refused/v1';
  const opened = () => {
    const opener = postable();
    const view = walletView({ opener });
    const channel = listen(view, () => NOW, () => {}, null);
    view.deliver({ source: opener as never, origin: EMBEDDER, data: signIn() });
    opener.posted.length = 0;
    return { opener, channel };
  };

  it('says failed, and which of the four things stopped it, to the origin that asked', () => {
    for (const why of PAYMENT_FAILURES) {
      const { opener, channel } = opened();
      channel.refuse('failed', why);
      /* RED WHEN: a failure goes back as a decline, loses its reason, or goes anywhere but the asker's origin. */
      expect(opener.posted, why).toEqual([{ message: { schema: REFUSED, reason: 'failed', why }, target: EMBEDDER }]);
    }
    /* RED WHEN: the list grows or shrinks without the page's reader being told. */
    expect([...PAYMENT_FAILURES]).toEqual(['chain-unreadable', 'not-enough', 'not-as-approved', 'did-not-finish']);
  });

  it('carries no word that is not on the list, and a decline still carries nothing but the decline', () => {
    const { opener, channel } = opened();
    (channel.refuse as (r: string, w?: unknown) => void)('failed', 'Insufficient funds: 4999 of 5000 NIGHT');
    /* RED WHEN: a caller's own sentence, which can name coins and amounts, crosses to the page. */
    expect(opener.posted).toEqual([{ message: { schema: REFUSED, reason: 'failed', why: 'did-not-finish' }, target: EMBEDDER }]);
    const other = opened();
    other.channel.refuse('declined');
    /* RED WHEN: a decline starts carrying a reason field. */
    expect(other.opener.posted).toStrictEqual([{ message: { schema: REFUSED, reason: 'declined' }, target: EMBEDDER }]);
  });
});

describe('ONE TERMINAL MESSAGE PER REQUEST, AND EVERY END STATE ANSWERS', () => {
  const REFUSED = 'midnight-identity/disclosure-refused/v1';
  const asked = (data: Record<string, unknown>) => {
    const opener = postable();
    const view = walletView({ opener });
    const states: ChannelState[] = [];
    const channel = listen(view, () => NOW, (st) => states.push(st), null);
    view.deliver({ source: opener as never, origin: EMBEDDER, data });
    return { opener, channel, states, sent: () => opener.posted.slice(1) };
  };

  it('sends the first terminal message and no other, and says which calls sent', () => {
    const first = asked(signIn());
    /* RED WHEN: the send-side once is taken out of the channel - a second answer, or a refusal after an answer, crosses. */
    expect(first.channel.answer({ schema: 'x' } as never)).toBe(true);
    expect(first.channel.refuse('declined')).toBe(false);
    expect(first.channel.refuse('failed', 'not-enough')).toBe(false);
    expect(first.channel.answer({ schema: 'y' } as never)).toBe(false);
    expect(first.sent()).toEqual([{ message: { schema: 'x' }, target: EMBEDDER }]);
    expect(first.channel.over()).toBe(true);
    const second = asked(signIn());
    expect(second.channel.over()).toBe(false);
    /* RED WHEN: a failure that went first is followed by a paid transaction - the page would send what it was told had failed. */
    expect(second.channel.refuse('failed', 'did-not-finish')).toBe(true);
    expect(second.channel.answer({ schema: 'late' } as never)).toBe(false);
    expect(second.sent()).toEqual([{ message: { schema: REFUSED, reason: 'failed', why: 'did-not-finish' }, target: EMBEDDER }]);
  });

  it('ONE TERMINAL MESSAGE PER ASK, NOT PER CHANNEL: A SCREEN SHOWN AGAIN ON THE SAME WINDOW ANSWERS NOTHING TWICE', () => {
    const opener = postable();
    const view = walletView({ opener });
    const sent = () => opener.posted.filter((p) => (p.message as { schema?: string }).schema !== READY_PING);
    /* Two screens on one window, each with its own channel, both handed the same ask before either answers. */
    const firstStates: ChannelState[] = [];
    const first = listen(view, () => NOW, (st) => firstStates.push(st), null);
    view.deliver({ source: opener as never, origin: EMBEDDER, data: signIn() });
    const secondStates: ChannelState[] = [];
    const second = listen(view, () => NOW, (st) => secondStates.push(st), null);
    view.deliver({ source: opener as never, origin: EMBEDDER, data: signIn() });
    expect(first.answer({ schema: 'paid' } as never)).toBe(true);
    /* RED WHEN: a screen on the second channel, asking whether it may still press, is told the ask is open after the first answered it. */
    expect(second.over()).toBe(true);
    /* RED WHEN: the second channel's refusal crosses after the first channel's answer - a page told "nothing was paid" after it was handed a payment. */
    expect(second.refuse('declined')).toBe(false);
    expect(second.over()).toBe(true);
    /* A third screen on the same window, after the ask has been answered, is not shown it again. */
    const thirdStates: ChannelState[] = [];
    const third = listen(view, () => NOW, (st) => thirdStates.push(st), null);
    view.deliver({ source: opener as never, origin: EMBEDDER, data: signIn() });
    /* RED WHEN: an ask already answered is put in front of the person again, as if it were still waiting. */
    expect(thirdStates.map((st) => st.of)).toEqual(['waiting', 'waiting']);
    expect(third.over()).toBe(true);
    expect(third.answer({ schema: 'again' } as never)).toBe(false);
    expect(sent()).toEqual([{ message: { schema: 'paid' }, target: EMBEDDER }]);
    /* RED WHEN: another ask from the same page, with its own nonce, is refused because an earlier one was answered. */
    const fourth = listen(view, () => NOW, () => {}, null);
    view.deliver({ source: opener as never, origin: EMBEDDER, data: { ...signIn(), nonce: 'n2' } });
    expect(fourth.answer({ schema: 'next' } as never)).toBe(true);
    first.stop(); second.stop(); third.stop(); fourth.stop();
  });

  it('sends nothing, and counts nothing as sent, before a request has arrived', () => {
    const opener = postable();
    const channel = listen(walletView({ opener }), () => NOW, () => {}, null);
    /* RED WHEN: a terminal message with nowhere to go is taken as the one terminal message, and the real one is then dropped. */
    expect(channel.refuse('declined')).toBe(false);
    expect(channel.over()).toBe(false);
    expect(opener.posted).toEqual([{ message: { schema: READY_PING }, target: '*' }]);
  });

  it('answers a request it refuses on arrival at once: `unreadable`, or `expired` for one that came too late', () => {
    const bad = asked({ ...signIn(), requester: { name: 'A', rdns: 'a', origin: 'https://elsewhere.example' } });
    expect(bad.states.map((st) => st.of)).toEqual(['waiting', 'refused']);
    /* RED WHEN: a request the wallet will not show leaves the page waiting for a press that cannot come. */
    expect(bad.sent()).toEqual([{ message: { schema: REFUSED, reason: 'unreadable' }, target: EMBEDDER }]);
    /* RED WHEN: the screen's own decline after that is sent as a second terminal message. */
    expect(bad.channel.refuse('declined')).toBe(false);
    expect(bad.sent()).toHaveLength(1);
    const late = asked({ ...signIn(), expiresAt: NOW });
    /* RED WHEN: a request that arrived after its deadline is told it was unreadable rather than expired, which the page already has words for. */
    expect(late.sent()).toEqual([{ message: { schema: REFUSED, reason: 'expired' }, target: EMBEDDER }]);
  });

  it('says what the wallet is doing only to a page that said it knows that message, only a stage from the list, and never after the end', () => {
    const quiet = asked(signIn());
    /* RED WHEN: a page that never said it knows the progress message is sent one, and takes it for the answer. */
    expect(quiet.channel.progress('reading')).toBe(false);
    expect(quiet.sent()).toEqual([]);
    const other = asked({ ...signIn(), progress: 'midnight-identity/wallet-progress/v2' });
    /* RED WHEN: any value of `progress` is taken as knowing this message, not exactly this one. */
    expect(other.channel.progress('reading')).toBe(false);
    const hears = asked({ ...signIn(), progress: PROGRESS_SCHEMA });
    for (const stage of PROGRESS_STAGES) expect(hears.channel.progress(stage), stage).toBe(true);
    /* RED WHEN: a stage the page does not know, or a caller's own words, crosses. */
    expect((hears.channel.progress as (s: string) => boolean)('proving 2 of 3 coins: 4999 NIGHT')).toBe(false);
    expect(hears.channel.over()).toBe(false);
    hears.channel.refuse('declined');
    /* RED WHEN: a wallet goes on saying it is at work after it has ended the conversation. */
    expect(hears.channel.progress('proving')).toBe(false);
    expect(hears.sent()).toEqual([
      { message: { schema: PROGRESS_SCHEMA, stage: 'reading' }, target: EMBEDDER },
      { message: { schema: PROGRESS_SCHEMA, stage: 'proving' }, target: EMBEDDER },
      { message: { schema: REFUSED, reason: 'declined' }, target: EMBEDDER },
    ]);
    /* RED WHEN: the list of stages grows or shrinks without the page's reader being told. */
    expect([...PROGRESS_STAGES]).toEqual(['reading', 'proving']);
  });
});
