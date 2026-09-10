import { describe, expect, it } from 'vitest';
import {
  FRAMED_BY_A_STRANGER, NOT_BUILT_TO_BE_FRAMED, READY_PING, framingOf, listen,
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
