import { describe, expect, it, vi } from 'vitest';
import type { Port } from 'midnight-identity/profile/store';
import { recordingChannel } from '../testing/recording-channel.js';
import {
  ASK_RECORD_KEY, KEPT_LINES, readAskRecord, recordAsk, recordChannelState, recordedChannel,
} from './ask-record.js';

/*
 * **WHAT THE WALLET SHOWED AND SENT, KEPT, SO THE NEXT WAIT THAT NEVER ENDS
 * CAN BE TOLD APART** - and nothing about money in it.
 */

const aPort = (): Port & { raw(): string | null } => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); },
    raw: () => m.get(ASK_RECORD_KEY) ?? null,
  };
};

describe('THE WALLET\'S RECORD OF EACH REQUEST', () => {
  it('keeps what arrived, what was shown and what was sent, in order, and whether each message went', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const port = aPort();
    const answers: unknown[] = [];
    const channel = recordedChannel(recordingChannel(answers), port, () => 5);
    recordChannelState(port, { of: 'request', request: { kind: 'balance' } as never }, 1);
    recordAsk(port, 'shown', 'refused', 2);
    channel.refuse('unreadable');
    /* A second terminal message is refused by the channel, and the record says it did not go. */
    channel.refuse('declined');
    /* RED WHEN: the record keeps nothing, drops a message that went, or says a dropped one went. */
    expect(readAskRecord(port).map((l) => `${l.what} ${l.detail}`)).toEqual([
      'asked balance', 'shown refused', 'sent refused:unreadable', 'not-sent refused:declined',
    ]);
    const signIn = aPort();
    recordChannelState(signIn, { of: 'request', request: { kind: 'sign-in' } as never }, 1);
    /* RED WHEN: the record grows to every request the wallet answers - who it signed in to, and when - not only the payments a page waits on. */
    expect(signIn.raw()).toBeNull();
    const refusedOnArrival = aPort();
    recordChannelState(refusedOnArrival, { of: 'refused', error: { code: 'expired' } as never }, 1);
    expect(readAskRecord(refusedOnArrival).map((l) => l.detail)).toEqual(['refused-on-arrival:expired']);
  });

  it('carries a word and never a sentence: no amount, address or transaction can be written into it', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const port = aPort();
    recordAsk(port, 'shown', 'failed: 4999 of 5000 NIGHT from mn_shield-addr_test1q...', 1);
    recordAsk(port, 'shown', 'refused:mn_shield-addr_test1qxy', 2);
    recordAsk(port, 'shown', 'reading:4999', 3);
    recordAsk(port, 'sent', 'refused:failed:not-enough', 4);
    recordAsk(port, 'shown', 'refused:Payroll for Alice', 5);
    recordAsk(port, 'shown', `refused:${'a'.repeat(33)}`, 6);
    /* RED WHEN: a caller's sentence, which can name coins, amounts and addresses, keeps any digit or any fragment of one. */
    /* RED WHEN: a name or a sentence of letters only - a company's, a person's - or an over-long word is kept as written. */
    expect(readAskRecord(port).map((l) => l.detail)).toEqual(['failed:other', 'refused:other', 'reading:other', 'refused:failed:not-enough', 'refused:other']);
    expect(port.raw()).not.toMatch(/[0-9]{2}|NIGHT|addr|shield|test/u);
  });

  it('keeps the last lines only, and one line for a wallet saying the same stage many times', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const port = aPort();
    /* A different word for each line: its number spelled in letters, since a word carries no digit. */
    const spelled = (i: number): string => `s${String(i).replace(/[0-9]/gu, (d) => 'abcdefghij'[Number(d)]!)}`;
    for (let i = 0; i < KEPT_LINES + 30; i += 1) recordAsk(port, 'shown', spelled(i), i);
    /* RED WHEN: the record grows without end in the wallet's own storage. */
    expect(readAskRecord(port)).toHaveLength(KEPT_LINES);
    expect(readAskRecord(port)[0]!.detail).toBe(spelled(30));
    const quiet = aPort();
    const channel = recordedChannel(recordingChannel([]), quiet, (() => { let t = 0; return () => { t += 1; return t; }; })());
    for (let i = 0; i < 40; i += 1) channel.progress('reading');
    channel.progress('proving');
    /* RED WHEN: a long read fills the record with one line per report and pushes the rest of the story out. */
    expect(readAskRecord(quiet).map((l) => [l.detail, l.times ?? 1])).toEqual([['progress:reading', 40], ['progress:proving', 1]]);
    expect(readAskRecord(quiet)[0]!.at).toBe(40);
  });

  it('a record that cannot be read or written stops nothing', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const broken: Port = { getItem: () => '{not json', setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    /* RED WHEN: a full or damaged store throws into the screen that is answering a page. */
    expect(() => recordAsk(broken, 'sent', 'answer', 1)).not.toThrow();
    expect(readAskRecord(broken)).toEqual([]);
  });
});
