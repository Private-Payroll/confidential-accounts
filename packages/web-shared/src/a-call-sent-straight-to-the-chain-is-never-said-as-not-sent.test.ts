/**
 * **A CALL SENT STRAIGHT TO THE CHAIN IS NEVER SAID AS NOT SENT**, whatever the company's service then answers about
 * its record; and one refused before the wallet sent it is always said as not sent.
 */
import { describe, it, expect } from 'vitest';
import { handedOver, SentStraightNotRecorded, type HandOver } from './hand-over.js';
import { nothingWasSentBy } from './governed-call-on-device.js';

const CALL = { kind: 'account-call', contract: 'ac'.repeat(32), circuit: 'approve' } as const;
const refusedByTheService = () => Object.assign(new Error('this service never saw this proposal raised. Nothing was closed. Nothing was sent.'), { nothingWasSent: true });

describe('A CALL SENT STRAIGHT TO THE CHAIN', () => {
  it('whose record the service then refuses or cannot read is said as sent, never as not sent', async () => {
    const sent: string[] = [];
    const over: HandOver = { path: 'chain', toChain: async (tx) => { sent.push(tx); } };
    const e = await handedOver(over, {
      tx: 'T', call: CALL, viaService: async () => 'relayed', after: async () => { throw refusedByTheService(); },
    }).then(() => null, (x: unknown) => x);
    expect(sent).toEqual(['T']);
    /* RED WHEN: a call on the chain is told to the person as not sent, so they send it again. */
    expect(e).toBeInstanceOf(SentStraightNotRecorded);
    expect(nothingWasSentBy(e)).toBe(false);
    expect((e as Error).message).toMatch(/sent straight to the chain/u);
  });

  it('refused by the wallet before it was sent is said as not sent, and the service is not asked', async () => {
    let asked = false;
    const over: HandOver = { path: 'chain', toChain: async () => { throw Object.assign(new Error('too little DUST'), { nothingWasSent: true }); } };
    const e = await handedOver(over, {
      tx: 'T', call: CALL, viaService: async () => 'relayed', after: async () => { asked = true; return 'read'; },
    }).then(() => null, (x: unknown) => x);
    /* RED WHEN: a call the wallet never sent is said as maybe sent, or its record is asked for. */
    expect(nothingWasSentBy(e)).toBe(true);
    expect(asked).toBe(false);
  });
});
