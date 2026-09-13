/**
 * THE LIVE PARAMETER READ, PINNED WITHOUT A NETWORK.
 *
 * Everything here is the decode and the labelling. The one thing a test cannot
 * reach is whether a real node still answers in this shape, and that is
 * measured against the node rather than asserted here: a live answer was read,
 * its first bytes are recorded below, and the payload it carried was corrupted
 * five ways to establish that a wrong offset produces no answer rather than a
 * wrong one.
 *
 * EACH ASSERTION NAMES THE CHANGE THAT TURNS IT RED, AND EACH OF THOSE CHANGES
 * WAS APPLIED TO A COPY OF THE MODULE OUTSIDE THIS REPOSITORY AND WATCHED
 * FAILING. A copy, never a link.
 */
import { describe, expect, it } from 'vitest';

import {
  describeParameters,
  fallbackParameters,
  readCompact,
  readLiveParameters,
  STATE_CALL_METHOD,
  tagOf,
  unwrapStateCallResult,
} from './live-ledger-parameters.js';

const bytes = (...v: number[]) => Uint8Array.from(v);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

/**
 * The first eight bytes of an answer a live node actually gave: the Ok
 * discriminant, a two-byte compact length of 791, and the head of the payload,
 * which names itself.
 */
const RECORDED_PREFIX = '005d0c6d69646e696768743a6c6564676572';

const LedgerParameters = {
  deserialize: (raw: Uint8Array) => ({ from: 'the chain', length: raw.length }),
  initialParameters: () => ({ from: 'the library' }),
};

describe('THE COMPACT LENGTH, WHICH IS WHERE A WRONG OFFSET WOULD START', () => {
  it('reads all three widths', () => {
    // TURNS RED IF: a mode's shift or width is wrong. Getting one wrong moves
    // every following byte, and the payload then decodes to nothing at all
    // rather than to something plausible.
    expect(readCompact(bytes(0b00000100), 0)).toEqual({ value: 1, width: 1 });
    expect(readCompact(hex('5d0c'), 0)).toEqual({ value: 791, width: 2 });
    expect(readCompact(hex('02090000'), 0)).toEqual({ value: 576, width: 4 });
  });

  it('refuses a length prefix that runs past the end of the answer', () => {
    // TURNS RED IF: the bounds checks are dropped. Reading past the end yields
    // a plausible number built partly from nothing.
    expect(() => readCompact(hex('5d'), 0)).toThrow(/ran past the end/);
    expect(() => readCompact(hex('020900'), 0)).toThrow(/ran past the end/);
    expect(() => readCompact(bytes(), 0)).toThrow(/ended before its length prefix/);
  });

  it('refuses the big-integer mode rather than guessing at it', () => {
    // TURNS RED IF: the fourth mode is given a guessed width. It has never been
    // seen here, and a guess would be a silent misread rather than a refusal.
    expect(() => readCompact(bytes(0b00000011), 0)).toThrow(/big integer/);
  });
});

describe('THE RESULT WRAPPER', () => {
  it('unwraps a real answer at the offset the recorded bytes say', () => {
    // TURNS RED IF: the header size stops being one byte plus the compact
    // width, which is the single arithmetic this whole read rests on.
    const answer = new Uint8Array(794);
    answer.set(hex(RECORDED_PREFIX), 0);
    const { payload, headerBytes } = unwrapStateCallResult(answer);
    expect(headerBytes).toBe(3);
    expect(payload.length).toBe(791);
  });

  it('refuses an error answer instead of decoding it as parameters', () => {
    // TURNS RED IF: the discriminant is not checked. The error arm's bytes are
    // not parameters and nothing downstream would know.
    expect(() => unwrapStateCallResult(hex('015d0c'))).toThrow(/error rather than parameters/);
  });

  it('refuses when fewer bytes followed than the length promised', () => {
    // TURNS RED IF: a short payload is accepted. A truncated answer decodes to
    // nothing, but it must be refused where the shortfall is visible and can be
    // named, not several layers later.
    expect(() => unwrapStateCallResult(hex('005d0c6d69'))).toThrow(/and 2 followed it/);
  });

  it('refuses an answer too short to be a result at all', () => {
    // TURNS RED IF: the minimum length check is dropped, so an empty answer
    // reads as an Ok carrying nothing.
    expect(() => unwrapStateCallResult(hex('00'))).toThrow(/too short/);
  });

  it('shows the payload naming itself, and hides bytes that are not text', () => {
    // TURNS RED IF: the tag stops being read, which is the only human-readable
    // evidence in the report that the right thing was decoded.
    expect(tagOf(hex('6d69646e696768743a6c6564676572'))).toBe('midnight:ledger');
    expect(tagOf(bytes(0x00, 0xff, 0x41))).toBe('..A');
  });
});

describe('THE READ ITSELF, AND WHAT IT REFUSES TO SUBSTITUTE', () => {
  const post = (answer: any) => async () => answer;

  it('asks for the parameters by the name the runtime publishes', async () => {
    /*
     * TURNS RED IF: the method name changes.
     *
     * It is the whole query. A wrong name comes back as an error from the node
     * rather than as anything that could be mistaken for parameters, but the
     * name is worth pinning because nothing else in this file names it.
     */
    let sent = '';
    await readLiveParameters('https://a.node', {
      post: async (_n, body) => { sent = body; return { result: '0x' + RECORDED_PREFIX }; },
      LedgerParameters,
    });
    expect(JSON.parse(sent).method).toBe('state_call');
    expect(JSON.parse(sent).params[0]).toBe(STATE_CALL_METHOD);
    expect(STATE_CALL_METHOD).toContain('get_ledger_parameters');
  });

  it('labels a decoded answer as live, with the evidence beside it', async () => {
    // TURNS RED IF: the reading stops carrying the payload size and the tag,
    // which are what let a reader tell a live number from a built-in one.
    const answer = Buffer.alloc(794);
    Buffer.from(RECORDED_PREFIX, 'hex').copy(answer);
    const r = await readLiveParameters('https://a.node', { post: post({ result: '0x' + answer.toString('hex') }), LedgerParameters });
    expect(r.source).toBe('live');
    expect(r.parameters).toEqual({ from: 'the chain', length: 791 });
    expect(r.payloadBytes).toBe(791);
    expect(r.tag).toContain('midnight:ledger');
  });

  it('NEVER substitutes the built-in constant when the node does not answer', async () => {
    /*
     * TURNS RED IF: a failure path falls back to the library's own parameters.
     *
     * This is the rule the whole file exists for. A function that quietly
     * substitutes the constant when the network is down is how unlabelled
     * starting values ended up in every number this project has published.
     */
    for (const answer of [
      { error: { code: -32000, message: 'unknown method' } },
      { result: '' },
      {},
      { result: '0x01ff' },
    ]) {
      const r = await readLiveParameters('https://a.node', { post: post(answer), LedgerParameters });
      expect(r.parameters).toBeNull();
      expect(r.source).toBe('live');
      expect(r.problem).toBeTruthy();
    }
  });

  it('names an answer with no result, rather than letting the decode discover it', async () => {
    /*
     * TURNS RED IF: the empty-result check is removed.
     *
     * IT WAS NOT ASSERTED UNTIL IT WAS MUTATED. Removing it still refuses,
     * because an empty string decodes to no bytes and the unwrap refuses that
     * too, so the only thing lost is the sentence a person reads. An unasserted
     * guard is a claim that a check is happening with nothing establishing that
     * it is, and this project has paid for that shape more than once.
     */
    const r = await readLiveParameters('https://a.node', { post: post({ result: '' }), LedgerParameters });
    expect(r.problem).toContain('answered without a result');
  });

  it('names an answer that is not whole hexadecimal, for the same reason', async () => {
    // TURNS RED IF: the odd-length check is removed. It refuses either way; what
    // is lost is a reader being told what was wrong with the answer.
    const r = await readLiveParameters('https://a.node', { post: post({ result: '0x005d0' }), LedgerParameters });
    expect(r.problem).toContain('odd number of hexadecimal digits');
  });

  it('does not throw when the node cannot be reached, and says what failed', async () => {
    // TURNS RED IF: the read is allowed to throw. A door has to be able to
    // report which check could not run, and an exception loses that.
    const r = await readLiveParameters('https://a.node', {
      post: async () => { throw new Error('connection refused'); },
      LedgerParameters,
    });
    expect(r.parameters).toBeNull();
    expect(r.problem).toContain('connection refused');
  });

  it('carries the fallback label in the same object as the fallback parameters', async () => {
    /*
     * TURNS RED IF: the label and the parameters can be held apart.
     *
     * A caller holding parameters without the label is a caller that will print
     * a built-in number as a reading, which is the one outcome this is all for.
     */
    const f = fallbackParameters(LedgerParameters, 'the node did not answer');
    expect(f.source).toBe('fallback');
    expect(f.parameters).toEqual({ from: 'the library' });
    expect(f.problem).toBe('the node did not answer');
    expect(describeParameters(f)).toContain('WERE NOT READ');
    expect(describeParameters(f)).toContain('the node did not answer');
  });
});
