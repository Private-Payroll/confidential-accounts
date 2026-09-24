import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { MyPayslips } from './my-payslips.js';

/**
 * **THE PAYSLIPS PAGE, FROM THE WALLET'S ANSWER TO THE WORDS IN EACH ROW, WITH
 * ITS OWN READER.**
 *
 * The wallet and the service are stand-ins; the reader is the page's real
 * one, started the way the page starts it, over a `Worker` stood in for by a
 * class that records what it was sent and answers as it is told. Each case
 * loads the modules afresh, because the page keeps the reader it started.
 */
const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
const ACME = 'ab'.repeat(32);
const PAID = '01'.repeat(32);
const UNPAID = '02'.repeat(32);
const NOW = 1_800_000_000;

type Listener = (e: { data: unknown }) => void;
/** How a stand-in worker behaves once made. */
type Behaviour = (w: FakeWorker) => void;
class FakeWorker {
  static made: FakeWorker[] = [];
  static behave: Behaviour = () => {};
  readonly sent: unknown[] = [];
  private readonly on: Record<string, Listener[]> = { message: [], error: [] };
  onAsk: ((ask: any) => void) | null = null;
  constructor(readonly url: unknown, readonly options: unknown) {
    FakeWorker.made.push(this);
    FakeWorker.behave(this);
  }
  addEventListener(type: string, l: Listener) { (this.on[type] ??= []).push(l); }
  removeEventListener(type: string, l: Listener) { this.on[type] = (this.on[type] ?? []).filter(x => x !== l); }
  postMessage(m: unknown) { this.sent.push(m); this.onAsk?.(m); }
  emit(type: string, data?: unknown) { for (const l of [...(this.on[type] ?? [])]) l({ data }); }
}

const ready: Behaviour = (w) => { queueMicrotask(() => w.emit('message', { kind: 'payslip-reader-ready' })); };
/** Ready, and answers each ask from the set of values the contract holds. */
const answering = (held: string[]): Behaviour => (w) => {
  ready(w);
  w.onAsk = (ask) => queueMicrotask(() =>
    w.emit('message', { id: ask.id, recorded: ask.movements.map((m: string) => held.includes(m)) }));
};

const slip = (runId: string, movement: string, until = NOW + 3_600): OpenedPayslip => ({
  runId, period: runId, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: ACME,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset: 'TESTUSD', amount: 1n, period: runId },
  receipt: { runId, leaf: '09'.repeat(32), movement, company: ACME, until },
});
const service = (slips: OpenedPayslip[]) => async (): Promise<MyPayslips> =>
  ({ opened: slips, sealed: [], unopened: 0, refused: 0 });

const fresh = async () => {
  vi.resetModules();
  FakeWorker.made = [];
  vi.stubGlobal('Worker', FakeWorker);
  return {
    page: await import('./YourPay.js'),
    client: await import('./payslip-worker-client.js'),
    payslips: await import('./my-payslips.js'),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.behave = () => {};
});

describe('the page reads whether each slip was paid through the indexer its wallet named', () => {
  it('THE WALLET\'S INDEXER REACHES THE PAGE\'S OWN READER, AND THE ROWS SAY WHAT IT READ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    FakeWorker.behave = answering([PAID]);
    const { page } = await fresh();
    const key = new Uint8Array(32).fill(7);
    const opened = await page.openAndRead([ACME], async () => ({ key, indexer: INDEXER }),
      service([slip('run_a', PAID), slip('run_b', UNPAID)]));
    /*
     * RED WHEN the page drops the indexer the wallet named, or reads with
     * anything but its own worker: nothing is then asked of the worker, and
     * every row reads "Cannot tell".
     */
    expect(FakeWorker.made).toHaveLength(1);
    /* Newest period first, as the page lists them. */
    expect(FakeWorker.made[0]!.sent).toEqual([{ id: 1, indexer: INDEXER, company: ACME, movements: [UNPAID, PAID] }]);
    expect(opened.words.get('run_a')).toEqual({ paid: 'Recorded as paid', onChain: 'Yes' });
    expect(opened.words.get('run_b')).toEqual({ paid: 'Not yet', onChain: 'Not yet' });
  });

  it('A WALLET THAT NAMES NO INDEXER STARTS NO READER, AND EVERY ROW SAYS IT CANNOT TELL', async () => {
    FakeWorker.behave = answering([PAID]);
    const { page } = await fresh();
    const opened = await page.openAndRead([ACME], async () => ({ key: new Uint8Array(32), indexer: null }),
      service([slip('run_a', PAID)]));
    expect(FakeWorker.made).toHaveLength(0);
    expect(opened.words.get('run_a')).toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
  });

  it('THE PAGE\'S OWN CLOCK DECIDES WHEN A PAYMENT STOPS BEING "NOT YET"', async () => {
    const { payslips } = await fresh();
    const reader = { recorded: async (_i: unknown, _c: string, m: string[]) => m.map(() => false) };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((NOW - 1) * 1000);
    expect((await payslips.paymentsOnTheChain([slip('run_a', UNPAID, NOW)], reader, INDEXER)).get('run_a')).toBe('not-yet');
    /* RED WHEN the page's default clock is not this device's clock in seconds. */
    vi.setSystemTime(NOW * 1000);
    expect((await payslips.paymentsOnTheChain([slip('run_a', UNPAID, NOW)], reader, INDEXER)).get('run_a')).toBe('cannot-tell');
  });
});

describe('a reader that does not start or does not answer is "cannot tell", and does not stay broken', () => {
  it('A WORKER THAT NEVER SAYS IT IS READY ANSWERS NOTHING, AND THE NEXT READ STARTS ANOTHER', async () => {
    vi.useFakeTimers();
    const { client } = await fresh();
    const reader = client.payslipReader();
    const first = reader.recorded(INDEXER, ACME, [PAID]);
    await vi.advanceTimersByTimeAsync(30_000);
    /* RED WHEN a worker that never started holds the page for ever. */
    expect(await first).toBeNull();
    FakeWorker.behave = answering([PAID]);
    const second = reader.recorded(INDEXER, ACME, [PAID]);
    await vi.advanceTimersByTimeAsync(0);
    /* RED WHEN a failed start is kept, so no read ever works again. */
    expect(await second).toEqual([true]);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('A WORKER THAT STOPS WHILE STARTING ANSWERS NOTHING AT ONCE', async () => {
    vi.useFakeTimers();
    FakeWorker.behave = (w) => { queueMicrotask(() => w.emit('error')); };
    const { client } = await fresh();
    const read = client.payslipReader().recorded(INDEXER, ACME, [PAID]);
    await vi.advanceTimersByTimeAsync(0);
    /* RED WHEN a worker that failed to start is waited on for the whole start time. */
    expect(await Promise.race([read, Promise.resolve('still waiting')])).toBeNull();
  });

  it('A WORKER THAT STARTS AND NEVER ANSWERS IS GIVEN UP ON', async () => {
    vi.useFakeTimers();
    FakeWorker.behave = ready;
    const { client } = await fresh();
    const read = client.payslipReader().recorded(INDEXER, ACME, [PAID]);
    await vi.advanceTimersByTimeAsync(client.READ_WAIT_MS - 1);
    expect(await Promise.race([read, Promise.resolve('still waiting')])).toBe('still waiting');
    await vi.advanceTimersByTimeAsync(1);
    /* RED WHEN a read that never comes back leaves the page with no payslips on it. */
    expect(await read).toBeNull();
  });
});

describe('the worker starts itself on its own thread', () => {
  it('LOADED WHERE THERE IS A THREAD AND NO WINDOW, IT SAYS IT IS READY', async () => {
    vi.resetModules();
    const posted: unknown[] = [];
    vi.stubGlobal('self', { postMessage: (m: unknown) => posted.push(m), addEventListener: () => {} });
    await import('./payslip-worker-entry.js');
    /* RED WHEN the worker does not start itself: the page's every read then waits and gives up. */
    expect(posted).toEqual([{ kind: 'payslip-reader-ready' }]);
  });
});
