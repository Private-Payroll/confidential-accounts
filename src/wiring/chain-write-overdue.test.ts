/**
 * **A WRITE THAT NEVER SETTLES STOPS HOLDING EVERY LATER WRITE SILENTLY.**
 *
 * Writes over one fee payer run one at a time, because the fee payer keeps whose
 * transaction it is paying for on itself. So a write that never settles would
 * hold every later write for ever, and nothing said so. The lane must go on
 * holding them - releasing it would record a fee against the wrong company - but
 * once the running write is overdue, each later write is refused by name, and
 * the ledger can say what it is waiting on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ChainLedger, chainLedger, WRITE_OVERDUE_AFTER_MS, SLOWEST_RECORDED_WRITE_MS,
  OPENING_ATTEMPTS, OPENING_WAITS_MS,
} from './chain.js';
import { withRetry } from '../midnight/retry.js';
import { ContractBook } from './account-contract.js';
import type { Deployment } from './deployment.js';
import type { WriteCapability } from './write-capability.js';

const DEPLOYMENT: Deployment = {
  network: 'stagenet',
  contractAddress: 'bcb61fef',
  indexerUrl: 'https://indexer.example/api/v4/graphql',
  indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws',
  nodeUrl: 'https://rpc.example',
  proverUrl: 'http://prover.invalid:1',
  sealedStateRoot: '/nowhere/.midnight/sealed',
  privateStateId: 'confidential-accounts-stagenet',
  zkConfigPath: '/nowhere/contracts/managed',
  vaultZkConfigPath: '/nowhere/contracts/managed-vault',
};

const namingSponsor = (named: string[]) => ({
  addFeeAndFinalise: async (tx: unknown) => tx,
  submit: async () => ({ ref: 'tx', at: '' }),
  release: async () => {},
  payingFor: (id: string) => { named.push(id); },
  capacity: async () => ({ dust: 0n, night: 0n }),
}) as unknown as WriteCapability['sponsor'];

const capabilityWith = (sponsor: WriteCapability['sponsor']): WriteCapability => ({
  maintenanceAuthority: { kind: 'unmaintainable' } as never,
  compiled: { it: 'is here' },
  customer: {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx: unknown) => tx,
    release: async () => {},
  } as WriteCapability['customer'],
  sponsor,
  storagePassword: async () => 'not-a-secret: a test literal',
});

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((res) => { open = res; });
  return { p, open };
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Turns a promise that would hang into a named failure. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, sleep(ms).then(() => { throw new Error(`HUNG: ${what}`); })]);

/** An inner ledger whose `open` for the named account never settles until told. */
const stalling = (stuckId: string, reached: string[]) => {
  const stuck = gate();
  const inner: any = {
    wiring: 'chain',
    open: async (id: string) => {
      reached.push(id);
      if (id === stuckId) await stuck.p;
      return { ref: id };
    },
  };
  return { inner, release: stuck.open };
};

const OVERDUE_MS = 40;
const fastClock = { now: () => Date.now(), overdueAfterMs: OVERDUE_MS };

afterEach(() => { vi.useRealTimers(); });

describe('a write that has run past its deadline', () => {
  /*
   * RED WHEN: `write` no longer refuses on arrival while the running write is
   * overdue - the later write queues behind a write that never settles and this
   * case reports HUNG.
   */
  it('refuses a later write at once, by name, and never starts or names it', async () => {
    const named: string[] = [];
    const reached: string[] = [];
    const { inner } = stalling('a', reached);
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor(named)), fastClock);

    void ledger.open('a', {} as never);
    await sleep(OVERDUE_MS + 30);

    await expect(within(ledger.open('b', {} as never), 200, 'a write behind an overdue one waited'))
      .rejects.toThrow(/^opening an account was not started, and nothing was spent on it/);
    expect(reached, 'the refused write reached the ledger').toEqual(['a']);
    expect(named, 'the refused write\'s company was named to the fee payer').toEqual(['a']);
  });

  /*
   * RED WHEN: the timer no longer turns away writes already queued when the
   * running one becomes overdue - a request that arrived early waits for ever.
   */
  it('turns away writes that were already queued when it became overdue', async () => {
    const reached: string[] = [];
    const { inner } = stalling('a', reached);
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor([])), fastClock);

    void ledger.open('a', {} as never);
    const b = ledger.open('b', {} as never);
    const c = ledger.open('c', {} as never);
    await expect(within(b, OVERDUE_MS + 300, 'a queued write was never turned away'))
      .rejects.toThrow(/was not started/);
    await expect(within(c, 50, 'the second queued write was never turned away'))
      .rejects.toThrow(/was not started/);
    expect(reached).toEqual(['a']);
  });

  /*
   * RED WHEN: the refusal stops saying what it is waiting behind, since when,
   * that nothing was spent, when to try again, that trying again repeats a write
   * of one's own that landed, or that stopping the server does not undo a write
   * already sent - or starts naming a company.
   */
  it('says what is holding it, since when, and what not to do', async () => {
    const { inner } = stalling('acc_first', []);
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor([])), fastClock);
    const before = Date.now();
    void ledger.open('acc_first', {} as never);
    await sleep(OVERDUE_MS + 30);

    const refusal = await ledger.addSigner('acc_second', '00' as never, null, {} as never).then(
      () => '', (e: Error) => e.message);
    expect(refusal).toMatch(/^adding a signer was not started, and nothing was spent on it/);
    expect(refusal).toMatch(/busy with an earlier write \(opening an account, running since /);
    const since = /running since (\S+), /.exec(refusal)?.[1] ?? '';
    expect(Date.parse(since), 'the start time is not the running write\'s').toBeGreaterThanOrEqual(before - 5);
    expect(Date.parse(since)).toBeLessThanOrEqual(before + 50);
    expect(refusal).toMatch(/Try this again once the health check no longer shows a write in flight/);
    expect(refusal).toMatch(/if the earlier write was yours, find out first whether it reached the chain/);
    expect(refusal).toMatch(/trying again does it a second time/);
    expect(refusal).toMatch(/Stopping the server does not undo a write that has already been sent/);
    expect(refusal).toMatch(/find out whether it landed before stopping it/);
    expect(refusal, 'the refusal names a company').not.toMatch(/acc_/);
  });

  /*
   * RED WHEN: becoming overdue releases the lane - a write arriving after the
   * deadline starts beside the one that has not settled, which is exactly the
   * fee mis-attribution the lane exists to prevent.
   */
  it('never lets anything run beside the overdue write, and lets the next go once it settles', async () => {
    const named: string[] = [];
    const reached: string[] = [];
    const { inner, release } = stalling('a', reached);
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor(named)), fastClock);

    const a = ledger.open('a', {} as never);
    const early = within(ledger.open('early', {} as never), 300, 'early').then(() => 'ran', () => 'refused');
    await sleep(OVERDUE_MS + 30);
    const late = within(ledger.open('late', {} as never), 100, 'late').then(() => 'ran', () => 'refused');
    expect(await early).toBe('refused');
    expect(await late).toBe('refused');
    expect(reached, 'a write ran beside a write that had not settled').toEqual(['a']);

    release();
    await expect(a).resolves.toEqual({ ref: 'a' });
    await expect(within(ledger.open('after', {} as never), 200, 'the lane stayed shut after it settled'))
      .resolves.toEqual({ ref: 'after' });
    /*
     * RED WHEN: a write turned away while it waited still runs when the lane
     * frees - its caller was told it did not happen.
     */
    expect(reached, 'a write that was refused ran anyway').toEqual(['a', 'after']);
    expect(named).toEqual(['a', 'after']);
  });

  /*
   * RED WHEN: a later write is refused behind a running write that is not yet
   * overdue - a slow write that settles in time must keep the queue as it was.
   */
  it('a write that settles before its deadline keeps the queue as it was', async () => {
    const reached: string[] = [];
    const { inner, release } = stalling('a', reached);
    const ledger = new ChainLedger(
      inner, DEPLOYMENT, capabilityWith(namingSponsor([])), { now: () => Date.now(), overdueAfterMs: 500 });

    const a = ledger.open('a', {} as never);
    const b = ledger.open('b', {} as never);
    await sleep(40);
    expect(reached).toEqual(['a']);
    const c = ledger.open('c', {} as never);
    const early = await Promise.race([
      c.then(() => 'settled', () => 'refused'), sleep(20).then(() => 'waiting'),
    ]);
    expect(early, 'a write behind a slow write that is not overdue was not left waiting').toBe('waiting');
    release();
    await expect(a).resolves.toEqual({ ref: 'a' });
    await expect(b).resolves.toEqual({ ref: 'b' });
    await expect(c).resolves.toEqual({ ref: 'c' });
    expect(reached).toEqual(['a', 'b', 'c']);
  });
});

describe('what the ledger says it is waiting on', () => {
  /*
   * RED WHEN: `writeInFlight` answers something while idle, stops naming the
   * kind of write, its start or its queue, or reports the company.
   */
  it('names the write, its start, its age and its queue, and never the company', async () => {
    let t = Date.parse('2026-09-10T08:00:00.000Z');
    const { inner, release } = stalling('acc_secret_company', []);
    const ledger = new ChainLedger(
      inner, DEPLOYMENT, capabilityWith(namingSponsor([])), { now: () => t, overdueAfterMs: 60_000 });

    expect(ledger.writeInFlight(), 'idle, and it says something is in flight').toBeNull();
    const a = ledger.open('acc_secret_company', {} as never);
    void ledger.open('acc_other_company', {} as never);
    await sleep(5);
    t += 12_500;

    const seen = ledger.writeInFlight();
    expect(seen).toEqual({
      what: 'opening an account', since: '2026-09-10T08:00:00.000Z', seconds: 12,
      overdue: false, waiting: 1,
    });
    expect(JSON.stringify(seen), 'the company is named').not.toMatch(/acc_/);

    /* RED WHEN: overdue is not judged by the clock the write started under. */
    t += 60_000;
    expect(ledger.writeInFlight()?.overdue).toBe(true);

    release();
    await a;
  });

  /* RED WHEN: a settled lane still reports the last write as running. */
  it('answers null again once everything has settled', async () => {
    const { inner, release } = stalling('a', []);
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor([])));
    const a = ledger.open('a', {} as never);
    await sleep(5);
    expect(ledger.writeInFlight()?.what).toBe('opening an account');
    release();
    await a;
    expect(ledger.writeInFlight()).toBeNull();
  });

  /* RED WHEN: a deployment that cannot write reports a lane. */
  it('a deployment that cannot write has nothing in flight', () => {
    const ledger = new ChainLedger({ wiring: 'chain' } as never, DEPLOYMENT);
    expect(ledger.writeInFlight()).toBeNull();
  });
});

describe('the deadline is arithmetic over what was measured, not a guess', () => {
  /*
   * RED WHEN: the retry underneath opening an account is given more attempts
   * or longer waits, and the deadline is not raised with it - a legitimate
   * retried write would then be called overdue.
   */
  it('restates the retry opening an account actually does', async () => {
    vi.useFakeTimers();
    const waits: number[] = [];
    let calls = 0;
    const done = withRetry('probe', async () => { calls++; throw new Error('fails every time'); }, {
      onRetry: ({ waitMs }) => { waits.push(waitMs); },
    }).catch(() => 'gave up');
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe('gave up');
    expect(calls).toBe(OPENING_ATTEMPTS);
    expect(waits.reduce((x, y) => x + y, 0)).toBe(OPENING_WAITS_MS);
  });

  /* RED WHEN: the deadline stops covering every attempt at the slowest recorded write. */
  it('is every attempt at the slowest recorded write plus every wait', () => {
    expect(SLOWEST_RECORDED_WRITE_MS).toBe(34_700);
    expect(WRITE_OVERDUE_AFTER_MS).toBe(OPENING_ATTEMPTS * SLOWEST_RECORDED_WRITE_MS + OPENING_WAITS_MS);
    expect(WRITE_OVERDUE_AFTER_MS).toBe(168_800);
  });

  /*
   * RED WHEN: the chain ledger starts passing its own retry settings to the
   * ledger underneath, so the retry defaults above are no longer what runs.
   */
  it('the chain ledger passes no retry of its own', () => {
    const book = new ContractBook(() => null, 'chain');
    const ledger = chainLedger(DEPLOYMENT, book, capabilityWith(namingSponsor([])));
    const deployment = (ledger as any).inner.deployment;
    expect(deployment, 'the deployment bag is missing, so this case reads nothing').toBeTruthy();
    expect(deployment.retry).toBeUndefined();
  });

  /* RED WHEN: a ledger built the ordinary way is judged by anything but the real deadline. */
  it('a ledger built the ordinary way uses the real deadline', () => {
    const ledger = new ChainLedger({ wiring: 'chain' } as never, DEPLOYMENT, capabilityWith(namingSponsor([])));
    expect((ledger as any).clock.overdueAfterMs).toBe(WRITE_OVERDUE_AFTER_MS);
  });
});
