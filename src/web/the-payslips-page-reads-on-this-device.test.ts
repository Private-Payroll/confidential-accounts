import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { MyPayslips } from './my-payslips.js';
import { HELD_ADDRESS_SLOTS, heldAddressDigest } from 'midnight-identity/profile/unlock';
import { payeeFor } from '../testing/payees.js';
import { ledgerTokenOf } from '../core/assets.js';

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
    w.emit('message', { id: ask.id, recorded: ask.payments.map((p: { nonce: string }) => held.includes(p.nonce)) }));
};

/** Where Dana is paid, and her wallet's digest of it under the page's nonce, among filler. */
const DANA = payeeFor('0d'.repeat(32), 'undeployed').bech32;
const SCOPE = { nonce: 'the-page-nonce', origin: 'https://payroll.example', company: 'ab'.repeat(32) };
const HELD = {
  scope: SCOPE,
  digests: [heldAddressDigest(SCOPE, DANA)!,
    ...Array.from({ length: HELD_ADDRESS_SLOTS - 1 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))].sort(),
};
const confirmedAll = () => true;

/** A slip whose receipt carries `nonce`; the stand-in worker reads a payment by its nonce. */
const slip = (runId: string, nonce: string, until = NOW + 3_600): OpenedPayslip => ({
  runId, period: runId, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: ACME,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset: 'TESTUSD', amount: 1n, period: runId, paidTo: DANA },
  receipt: { runId, nonce, blinding: '09'.repeat(32), company: ACME, until },
});
const paymentFor = (nonce: string) => ({
  paidTo: DANA, token: ledgerTokenOf('TESTUSD', 'shielded'), amount: '1', nonce, blinding: '09'.repeat(32),
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
    const opened = await page.openAndRead([ACME], async () => ({ key, indexer: INDEXER, held: HELD }),
      service([slip('run_a', PAID), slip('run_b', UNPAID)]));
    /*
     * RED WHEN the page drops the indexer the wallet named, or reads with
     * anything but its own worker: nothing is then asked of the worker, and
     * every row reads "Cannot tell".
     */
    expect(FakeWorker.made).toHaveLength(1);
    /* Newest period first, as the page lists them. */
    expect(FakeWorker.made[0]!.sent).toEqual([
      { id: 1, indexer: INDEXER, company: ACME, payments: [paymentFor(UNPAID), paymentFor(PAID)] }]);
    expect(opened.words.get('run_a')).toEqual({ paid: 'Recorded as paid', onChain: 'Yes' });
    expect(opened.words.get('run_b')).toEqual({ paid: 'Not yet', onChain: 'Not yet' });
  });

  it('A WALLET THAT NAMES NO INDEXER STARTS NO READER, AND EVERY ROW SAYS IT CANNOT TELL', async () => {
    FakeWorker.behave = answering([PAID]);
    const { page } = await fresh();
    const opened = await page.openAndRead([ACME], async () => ({ key: new Uint8Array(32), indexer: null, held: HELD }),
      service([slip('run_a', PAID)]));
    expect(FakeWorker.made).toHaveLength(0);
    expect(opened.words.get('run_a')).toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
  });

  it('A WALLET THAT SAYS NOTHING ABOUT THE ADDRESSES IT HOLDS - AN OLDER WALLET - STARTS NO READER, AND EVERY ROW SAYS IT CANNOT TELL', async () => {
    FakeWorker.behave = answering([PAID, UNPAID]);
    const { page } = await fresh();
    for (const release of [
      async () => ({ key: new Uint8Array(32), indexer: INDEXER }),
      async () => ({ key: new Uint8Array(32), indexer: INDEXER, held: null }),
      /* A list that does not hold Dana's address under this nonce. */
      async () => ({ key: new Uint8Array(32), indexer: INDEXER, held: { ...HELD, scope: { ...SCOPE, nonce: 'another-nonce' } } }),
    ]) {
      const opened = await page.openAndRead([ACME], release, service([slip('run_a', PAID), slip('run_b', UNPAID)]));
      /* RED WHEN an address the wallet did not confirm is asked about: run_b would read "Not yet". */
      expect(opened.words.get('run_a')).toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
      expect(opened.words.get('run_b')).toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
    }
    expect(FakeWorker.made).toHaveLength(0);
  });

  it('THE PAGE\'S OWN CLOCK DECIDES WHEN A PAYMENT STOPS BEING "NOT YET"', async () => {
    const { payslips } = await fresh();
    const reader = { recorded: async (_i: unknown, _c: string, m: unknown[]) => m.map(() => false) };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((NOW - 1) * 1000);
    expect((await payslips.paymentsOnTheChain([slip('run_a', UNPAID, NOW)], reader, INDEXER, confirmedAll)).get('run_a')).toBe('not-yet');
    /* RED WHEN the page's default clock is not this device's clock in seconds. */
    vi.setSystemTime(NOW * 1000);
    expect((await payslips.paymentsOnTheChain([slip('run_a', UNPAID, NOW)], reader, INDEXER, confirmedAll)).get('run_a')).toBe('cannot-tell');
  });
});

/** The same slip, with a receipt that names `company` as the contract its payment is recorded at. */
const namingContract = (runId: string, nonce: string, company: string): OpenedPayslip => {
  const s = slip(runId, nonce);
  return { ...s, receipt: { ...s.receipt!, company } };
};
/** A contract nobody opened: one the service deployed for itself, say. */
const ROGUE = 'ee'.repeat(32);
/** Where the same company is now, after it moved. */
const MOVED = 'cd'.repeat(32);

describe('the page reads only a contract it opened for that company', () => {
  it('A RECEIPT NAMING A CONTRACT THE PAGE DID NOT OPEN READS "CANNOT TELL", WHATEVER THAT CONTRACT RECORDS', async () => {
    /* The rogue contract does record this payment: a service that deployed it recorded the leaf there. */
    FakeWorker.behave = answering([PAID]);
    const { page } = await fresh();
    const opened = await page.openAndRead([ACME], async () => ({ key: new Uint8Array(32), indexer: INDEXER, held: HELD }),
      service([namingContract('run_rogue', PAID, ROGUE), slip('run_a', PAID)]));
    /* RED WHEN the contract a receipt names is read without being one the page opened: "Recorded as paid". */
    expect(opened.words.get('run_rogue')).toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
    /* One the page did open reads as the chain says. */
    expect(opened.words.get('run_a')).toEqual({ paid: 'Recorded as paid', onChain: 'Yes' });
    /* RED WHEN the rogue contract is asked about at all. */
    expect(FakeWorker.made[0]!.sent).toEqual([
      { id: 1, indexer: INDEXER, company: ACME, payments: [paymentFor(PAID)] }]);
  });

  it('LEFT TO ITS DEFAULT, THE READ STILL NEVER ASKS ABOUT A CONTRACT NO SLIP WAS OPENED AT', async () => {
    const { payslips } = await fresh();
    const asked: string[] = [];
    const reader = {
      recorded: async (_i: unknown, company: string, m: unknown[]) => { asked.push(company); return m.map(() => true); },
    };
    const chain = await payslips.paymentsOnTheChain(
      [namingContract('run_rogue', PAID, ROGUE), slip('run_a', PAID)], reader, INDEXER, confirmedAll);
    /* RED WHEN the default takes in the contracts receipts name rather than the addresses slips were opened at. */
    expect(chain.get('run_rogue')).toBe('cannot-tell');
    expect(chain.get('run_a')).toBe('paid');
    expect(asked).toEqual([ACME]);
  });

  it('A COMPANY THAT MOVED READS ITS NEW CONTRACT, BECAUSE THE PAGE OPENED THAT ADDRESS TOO', async () => {
    FakeWorker.behave = answering([PAID]);
    const { page } = await fresh();
    const release = async () => ({ key: new Uint8Array(32), indexer: INDEXER, held: HELD });
    /* The slip was sealed under the old address; its leg was raised after the move. */
    const theSlip = namingContract('run_after_move', PAID, MOVED);
    const byAddress = async (_k: unknown, address: string) =>
      ({ opened: address === ACME ? [theSlip] : [], sealed: [], unopened: 0, refused: 0 });
    const opened = await page.openAndRead([ACME, MOVED], release, byAddress);
    /* RED WHEN a moved company's payslips read "cannot tell" for a payment it really recorded. */
    expect(opened.words.get('run_after_move')).toEqual({ paid: 'Recorded as paid', onChain: 'Yes' });
  });

  it('AN ADDRESS THE WALLET WOULD NOT OPEN IS NOT ONE THE PAGE OPENED', async () => {
    FakeWorker.behave = answering([PAID]);
    const { page } = await fresh();
    const release = async (address: string) => {
      if (address === MOVED) throw new Error('the person declined');
      return { key: new Uint8Array(32), indexer: INDEXER, held: HELD };
    };
    const theSlip = namingContract('run_after_move', PAID, MOVED);
    const byAddress = async (_k: unknown, address: string) =>
      ({ opened: address === ACME ? [theSlip] : [], sealed: [], unopened: 0, refused: 0 });
    const opened = await page.openAndRead([ACME, MOVED], release, byAddress);
    /* RED WHEN an address is counted as opened before its key was given and its slips fetched. */
    expect(opened.words.get('run_after_move')).toEqual({ paid: 'Cannot tell', onChain: 'Not known' });
  });
});

describe('a reader that does not start or does not answer is "cannot tell", and does not stay broken', () => {
  it('A WORKER THAT NEVER SAYS IT IS READY ANSWERS NOTHING, AND THE NEXT READ STARTS ANOTHER', async () => {
    vi.useFakeTimers();
    const { client } = await fresh();
    const reader = client.payslipReader();
    const first = reader.recorded(INDEXER, ACME, [paymentFor(PAID)]);
    await vi.advanceTimersByTimeAsync(30_000);
    /* RED WHEN a worker that never started holds the page for ever. */
    expect(await first).toBeNull();
    FakeWorker.behave = answering([PAID]);
    const second = reader.recorded(INDEXER, ACME, [paymentFor(PAID)]);
    await vi.advanceTimersByTimeAsync(0);
    /* RED WHEN a failed start is kept, so no read ever works again. */
    expect(await second).toEqual([true]);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('A WORKER THAT STOPS WHILE STARTING ANSWERS NOTHING AT ONCE', async () => {
    vi.useFakeTimers();
    FakeWorker.behave = (w) => { queueMicrotask(() => w.emit('error')); };
    const { client } = await fresh();
    const read = client.payslipReader().recorded(INDEXER, ACME, [paymentFor(PAID)]);
    await vi.advanceTimersByTimeAsync(0);
    /* RED WHEN a worker that failed to start is waited on for the whole start time. */
    expect(await Promise.race([read, Promise.resolve('still waiting')])).toBeNull();
  });

  it('A WORKER THAT STARTS AND NEVER ANSWERS IS GIVEN UP ON', async () => {
    vi.useFakeTimers();
    FakeWorker.behave = ready;
    const { client } = await fresh();
    const read = client.payslipReader().recorded(INDEXER, ACME, [paymentFor(PAID)]);
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
