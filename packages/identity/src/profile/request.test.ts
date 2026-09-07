// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { REGISTRY } from './attributes.js';
import { RequestError, asked, parseAsk, parseRequest } from './request.js';
import { READY_PING, listen } from './channel.js';
import type { ChannelState, ChannelWindow } from './channel.js';

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To pay you, we need to know who you are.',
  wants: [
    { attribute: 'given-name', required: true },
    { attribute: 'email', required: false, reason: 'For your payslip.' },
  ],
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  ...over,
});

describe('§5.3 — THE ORIGIN IS OBSERVED, NEVER CLAIMED', () => {
  it('the parsed request carries the origin the PARSER was handed', () => {
    const request = parseRequest(wire(), ORIGIN, NOW);
    expect(request.requester.origin).toBe(ORIGIN);
  });

  it('A REQUEST THAT NAMES ITS OWN ORIGIN IS REFUSED BY NAME, NOT IGNORED', () => {
    /* Ignoring it would leave an honest sender believing it was honoured, and
     * would leave a dishonest one free to try again. */
    for (const payload of [
      wire({ requester: { name: 'A', rdns: 'a', origin: 'https://someone-else.example' } }),
      wire({ origin: 'https://someone-else.example' }),
    ]) {
      try {
        parseRequest(payload, ORIGIN, NOW);
        throw new Error('should have refused');
      } catch (e) {
        expect(e).toBeInstanceOf(RequestError);
        expect((e as RequestError).code).toBe('claims-its-own-origin');
      }
    }
  });

  it('even an origin that AGREES with the observed one is refused', () => {
    /* The field is not checked, it is absent. A field that is sometimes read
     * is a field that can be made to be read. */
    expect(() => parseRequest(
      wire({ requester: { name: 'A', rdns: 'a', origin: ORIGIN } }), ORIGIN, NOW))
      .toThrow(RequestError);
  });

  it('an origin nobody could authenticate is refused before anything is shown', () => {
    for (const bad of ['', 'http://payroll-a.example', 'null']) {
      expect(() => parseRequest(wire(), bad, NOW)).toThrow(RequestError);
    }
  });
});

describe('the request is parsed, never guessed', () => {
  it('a different schema is refused with both names in the sentence', () => {
    try {
      parseRequest(wire({ schema: 'something/else' }), ORIGIN, NOW);
      throw new Error('should have refused');
    } catch (e) {
      expect((e as RequestError).code).toBe('wrong-schema');
      expect((e as Error).message).toContain('something/else');
    }
  });

  it('a want that does not say whether it is required is refused, never defaulted', () => {
    /* Required and optional are shown differently and the difference is not
     * the wallet's to guess. */
    expect(() => parseRequest(
      wire({ wants: [{ attribute: 'given-name' }] }), ORIGIN, NOW)).toThrow(RequestError);
  });

  it('an expired request is refused', () => {
    expect(() => parseRequest(wire(), ORIGIN, NOW + 60_001)).toThrow(RequestError);
  });

  it('a request asking for nothing is refused', () => {
    expect(() => parseRequest(wire({ wants: [] }), ORIGIN, NOW)).toThrow(RequestError);
  });

  it('the same attribute twice is refused', () => {
    expect(() => parseRequest(wire({
      wants: [
        { attribute: 'email', required: true },
        { attribute: 'email', required: false },
      ],
    }), ORIGIN, NOW)).toThrow(RequestError);
  });
});

describe('§3.4 — the requester cannot define an attribute', () => {
  it('an unknown name is SHOWN as unknown and never becomes an attribute', () => {
    const request = parseRequest(wire({
      wants: [
        { attribute: 'given-name', required: true },
        { attribute: 'national-insurance-number', required: true },
      ],
    }), ORIGIN, NOW);
    const rows = asked(request, REGISTRY);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.known)).toEqual([true, false]);
    expect(REGISTRY.knows('national-insurance-number')).toBe(false);
  });

  /**
   * **THIS CHANGED FROM `not read` TO `refused`, AND THE REASON IS THE
   * REASON THE ORIGIN IS REFUSED.**
   *
   * When this was written the only extra field a requester could put on a want
   * was a RULE, and a rule genuinely could not do anything: the registry is
   * ours, so the worst case was a requester believing it had been honoured.
   * **A VALUE is not like that.** The first derived attribute is a receiving
   * address, and a want carrying one would be a payer naming where a payee is
   * paid. Dropping the field silently is what leaves an honest requester
   * believing it counted and a dishonest one free to try — the same family, and
   * the same sentence `origin` is already refused in.
   *
   * So the shape is refused rather than the names being enumerated: a list of
   * forbidden keys is a list somebody extends after the fact, and the field
   * after `address` would not be on it. The rule this test used to pin —
   * **that our definition is untouched** — is asserted below and is stronger
   * for the request never having been served at all.
   */
  it('A REQUEST THAT NAMES AN ADDRESS IS NOT SERVED THAT ADDRESS', () => {
    /* The one that costs money: a payer proposing the payee's own address. */
    expect(() => parseRequest(wire({
      wants: [{
        attribute: 'receiving-address',
        required: true,
        address: 'mn_shield-addr_undeployed1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      }],
    }), ORIGIN, NOW)).toThrow(/never what the answer is/u);

    /* And on the request itself, where no kind of ask may name one. */
    expect(() => parseRequest(wire({
      wants: [{ attribute: 'receiving-address', required: true }],
      address: 'mn_shield-addr_undeployed1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    }), ORIGIN, NOW)).toThrow(/telling somebody where their own money goes/u);

    /* A sign-in and an unlock have no `wants` to hide one in, and the refusal
     * is read before the kind is, so it covers all three. */
    expect(() => parseAsk(wire({
      kind: 'sign-in', address: 'mn_shield-addr_undeployed1qqqq',
    }), ORIGIN, NOW)).toThrow(RequestError);

    /* THE CODES ARE THEIR OWN, because a refusal that named the wrong place
     * would tell a requester something untrue about its own message. */
    try {
      parseRequest(wire({
        wants: [{ attribute: 'given-name', required: true, address: 'anything' }],
      }), ORIGIN, NOW);
      expect.unreachable('a want carrying an address is refused');
    } catch (e) {
      expect((e as RequestError).code).toBe('a-want-proposes-a-value');
    }
    try {
      parseRequest(wire({
        wants: [{ attribute: 'given-name', required: true }], address: 'anything',
      }), ORIGIN, NOW);
      expect.unreachable('a request carrying an address is refused');
    } catch (e) {
      expect((e as RequestError).code).toBe('proposes-an-address');
    }
  });

  it('a rule sent alongside a name is refused, and our definition is untouched', () => {
    expect(() => parseRequest(wire({
      wants: [{
        attribute: 'given-name', required: true, validate: { of: 'text', maxLength: 2 },
        selfAssertable: false, sensitivity: 'sensitive',
      }],
    }), ORIGIN, NOW)).toThrow(/is asked for with a 'validate' beside it/u);
    /* §3.4 — the registry is ours, and nothing that arrived over a wire has
     * touched it. Stronger than before: the request was never served at all. */
    expect(REGISTRY.definitionOf('given-name')!.validate).toEqual({
      of: 'text', minLength: 1, maxLength: 100,
    });
  });

  it('AND THE THREE FIELDS A WANT MAY CARRY STILL PASS', () => {
    const request = parseRequest(wire({
      wants: [{ attribute: 'given-name', required: true, reason: 'for your payslip' }],
    }), ORIGIN, NOW);
    expect(Object.keys(request.wants[0]!).sort())
      .toEqual(['attribute', 'reason', 'required']);
  });
});

describe('the channel observes the origin and answers only there', () => {
  const channelFor = (opener: { postMessage: ReturnType<typeof vi.fn> }) => {
    const handlers: ((event: MessageEvent) => void)[] = [];
    const states: ChannelState[] = [];
    const view: ChannelWindow = {
      opener: opener as unknown as ChannelWindow['opener'],
      addEventListener: (_t, h) => { handlers.push(h); },
      removeEventListener: () => { /* not exercised here */ },
    };
    const channel = listen(view, () => NOW, (s) => states.push(s));
    const deliver = (event: Partial<MessageEvent>): void => {
      for (const h of handlers) h(event as MessageEvent);
    };
    return { channel, states, deliver };
  };

  it('pings the opener with a constant and no data at all', () => {
    const opener = { postMessage: vi.fn() };
    channelFor(opener);
    expect(opener.postMessage).toHaveBeenCalledWith({ schema: READY_PING }, '*');
    expect(Object.keys(opener.postMessage.mock.calls[0]![0] as object)).toEqual(['schema']);
  });

  it('takes the origin off the EVENT and hands it to the parser', () => {
    const opener = { postMessage: vi.fn() };
    const { states, deliver } = channelFor(opener);
    deliver({ source: opener as never, origin: ORIGIN, data: wire() });
    const last = states[states.length - 1]!;
    expect(last.of).toBe('request');
    expect(last.of === 'request' && last.request.requester.origin).toBe(ORIGIN);
  });

  it('ignores a message from anything that is not the page that opened this tab', () => {
    const opener = { postMessage: vi.fn() };
    const { states, deliver } = channelFor(opener);
    deliver({ source: { postMessage: vi.fn() } as never, origin: ORIGIN, data: wire() });
    expect(states.map((s) => s.of)).toEqual(['waiting']);
  });

  it('ANSWERS ONLY THE ORIGIN IT OBSERVED', () => {
    const opener = { postMessage: vi.fn() };
    const { channel, deliver } = channelFor(opener);
    deliver({ source: opener as never, origin: ORIGIN, data: wire() });
    channel.answer({ payload: { origin: ORIGIN } } as never);
    const last = opener.postMessage.mock.calls[opener.postMessage.mock.calls.length - 1]!;
    expect(last[1]).toBe(ORIGIN);
  });

  it('ONE REQUEST — a second, while the first is on screen, is ignored', () => {
    const opener = { postMessage: vi.fn() };
    const { states, deliver } = channelFor(opener);
    deliver({ source: opener as never, origin: ORIGIN, data: wire() });
    deliver({
      source: opener as never,
      origin: ORIGIN,
      data: wire({ purpose: 'Actually we want everything.' }),
    });
    const requests = states.filter((s) => s.of === 'request');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.of === 'request' && requests[0]!.request.purpose)
      .toBe('To pay you, we need to know who you are.');
  });

  it('a refusal says only that it was refused', () => {
    const opener = { postMessage: vi.fn() };
    const { channel, deliver } = channelFor(opener);
    deliver({ source: opener as never, origin: ORIGIN, data: wire() });
    channel.refuse('declined');
    const last = opener.postMessage.mock.calls[opener.postMessage.mock.calls.length - 1]!;
    expect(last[0]).toEqual({
      schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined',
    });
    expect(last[1]).toBe(ORIGIN);
  });

  it('AND A REFUSED REQUEST IS ANSWERED AT THE OBSERVED ORIGIN, NOT THE CLAIMED ONE', () => {
    /*
     * The survivor this closes. Every other test here sends a payload with no
     * origin in it, so *the browser's origin* and *the payload's origin* were
     * the same string and a channel reading the wrong one looked identical.
     * This is the only case where they differ.
     */
    const opener = { postMessage: vi.fn() };
    const { channel, deliver } = channelFor(opener);
    deliver({
      source: opener as never,
      origin: ORIGIN,
      data: wire({ requester: { name: 'A', rdns: 'a', origin: 'https://elsewhere.example' } }),
    });
    channel.refuse('declined');
    const last = opener.postMessage.mock.calls[opener.postMessage.mock.calls.length - 1]!;
    expect(last[1]).toBe(ORIGIN);
    expect(last[1]).not.toBe('https://elsewhere.example');
  });

  it('a bad request becomes a `refused` state carrying the named reason', () => {
    const opener = { postMessage: vi.fn() };
    const { states, deliver } = channelFor(opener);
    deliver({
      source: opener as never,
      origin: ORIGIN,
      data: wire({ requester: { name: 'A', rdns: 'a', origin: 'https://elsewhere.example' } }),
    });
    const last = states[states.length - 1]!;
    expect(last.of).toBe('refused');
    expect(last.of === 'refused' && last.error.code).toBe('claims-its-own-origin');
  });
});
