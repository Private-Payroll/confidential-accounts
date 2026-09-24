import { describe, expect, it } from 'vitest';
import { readerOver, type PayslipAsk } from './payslip-worker-client.js';
import { answerPayslipAsk, startPayslipWorker, type PayslipReaderDeps } from './payslip-worker-entry.js';

/**
 * **THE PAGE AND ITS PAYSLIP READER, TALKING THE WAY THEY DO IN A BROWSER, WITH
 * THE WORKER'S MESSAGE CHANNEL STOOD IN FOR BY TWO LISTS OF LISTENERS.**
 *
 * The read itself is held against the compiled contract in
 * `contracts/test/a-retried-payment-reads-paid.test.ts`; this is about what
 * crosses between the two threads and what the page makes of each answer.
 */
const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
const ACME = 'ab'.repeat(32);
const PAID = '01'.repeat(32);
const UNPAID = '02'.repeat(32);

/** A page and a worker joined by a channel, with the worker answering through `answer`. */
const joined = (answer: (ask: PayslipAsk) => unknown) => {
  const toPage: Array<(e: { data: unknown }) => void> = [];
  const sent: unknown[] = [];
  const worker = {
    postMessage: (m: unknown) => {
      sent.push(m);
      queueMicrotask(() => { for (const l of toPage) l({ data: answer(m as PayslipAsk) }); });
    },
    addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => { toPage.push(l); },
  };
  return { reader: readerOver(worker), sent };
};

describe('the page asks its own reader, and nothing else', () => {
  it('WHAT CROSSES TO THE WORKER IS THE INDEXER, THE COMPANY AND THE VALUES, AND THE ANSWER LINES UP WITH THEM', async () => {
    const { reader, sent } = joined(ask => ({ id: ask.id, recorded: ask.movements.map(m => m === PAID) }));
    expect(await reader.recorded(INDEXER, ACME, [UNPAID, PAID])).toEqual([false, true]);
    expect(sent).toEqual([{ id: 1, indexer: INDEXER, company: ACME, movements: [UNPAID, PAID] }]);
  });

  it('AN ANSWER THAT IS NOT A LIST OF YES AND NO, OR IS THE WRONG LENGTH, READS AS "COULD NOT READ"', async () => {
    const bad: unknown[] = [
      null, 'nope', [true, 'yes'], [true], [true, false, true],
    ];
    for (const recorded of bad) {
      const { reader } = joined(ask => ({ id: ask.id, recorded }));
      /* RED WHEN a malformed answer is read as a list of payments nobody made. */
      expect(await reader.recorded(INDEXER, ACME, [UNPAID, PAID]), JSON.stringify(recorded)).toBeNull();
    }
  });

  it('AN ANSWER TO ANOTHER QUESTION IS NOT TAKEN AS THIS ONE\'S', async () => {
    let first = true;
    const { reader } = joined(ask => {
      if (first) { first = false; return { id: ask.id + 7, recorded: [true] }; }
      return { id: ask.id, recorded: [false] };
    });
    const answer = reader.recorded(INDEXER, ACME, [PAID]);
    const second = reader.recorded(INDEXER, ACME, [PAID]);
    /* RED WHEN answers are not matched by id: the first question takes a stray "yes". */
    expect(await second).toEqual([false]);
    const pending = await Promise.race([answer, new Promise(r => setTimeout(() => r('waiting'), 20))]);
    expect(pending).toBe('waiting');
  });
});

describe('the worker answers every question, and a failure is never "not recorded"', () => {
  it('A WORKER STARTED ON A SCOPE SAYS IT IS READY, AND ANSWERS A FAILED READ WITH "COULD NOT READ"', async () => {
    const posted: unknown[] = [];
    let listener: ((e: { data: unknown }) => void) | null = null;
    const scope = {
      postMessage: (m: unknown) => posted.push(m),
      addEventListener: (_t: string, l: (e: { data: unknown }) => void) => { listener = l; },
    };
    const failing: PayslipReaderDeps = {
      sourceFor: async () => { throw new Error('the indexer did not answer'); },
      readLedger: async () => () => ({}),
    };
    startPayslipWorker(scope, failing);
    expect(posted).toEqual([{ kind: 'payslip-reader-ready' }]);
    listener!({ data: { id: 4, indexer: INDEXER, company: ACME, movements: [PAID] } });
    await new Promise(r => setTimeout(r, 0));
    /* RED WHEN a read that failed goes unanswered, or is answered as nothing recorded. */
    expect(posted[1]).toEqual({ id: 4, recorded: null });
    /* Something that is not a question is not answered. */
    listener!({ data: 'hello' });
    await new Promise(r => setTimeout(r, 0));
    expect(posted).toHaveLength(2);
  });

  it('THE WORKER HANDS THE INDEXER THE WALLET NAMED TO THE READER, AND ONLY THE COMPANY\'S ADDRESS TO THE INDEXER', async () => {
    const seen: { indexer?: unknown; asked: string[] } = { asked: [] };
    const deps: PayslipReaderDeps = {
      sourceFor: async (indexer) => {
        seen.indexer = indexer;
        return { queryContractState: async (address: string) => { seen.asked.push(address); return { data: 'state' }; } };
      },
      readLedger: async () => (data: unknown) => (data === 'state'
        ? { movements: { member: (v: Uint8Array) => v[0] === 1 } } : null),
    };
    const answer = await answerPayslipAsk(deps, { id: 9, indexer: INDEXER, company: ACME.toUpperCase(), movements: [PAID, UNPAID] });
    expect(answer).toEqual({ id: 9, recorded: [true, false] });
    expect(seen.indexer).toEqual(INDEXER);
    /* RED WHEN a value looked for reaches the indexer. */
    expect(seen.asked).toEqual([ACME]);
  });
});
