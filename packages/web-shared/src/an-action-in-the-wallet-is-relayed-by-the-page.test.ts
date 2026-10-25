import { describe, expect, it } from 'vitest';
import {
  ACT_ENDED_SCHEMA, ACT_RELAYED_SCHEMA, ACT_RELAY_SCHEMA, PROGRESS_SCHEMA, READY_PING,
} from 'midnight-identity/profile/channel';
import { ANSWER_TIMEOUT_MS, askWallet } from './wallet-sign-in.js';
import { actInTheWallet } from './wallet-act.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/*
 * **THE PAGE'S HALF OF AN ACTION THE WALLET RUNS WHOLE.** The page sends one ask naming the action, relays each
 * transaction the wallet hands it, tells the wallet what it did with each, and ends with the action done or stopped
 * at a step. The wallet's side is spoken here by the test, message by message, on a clock the test moves.
 */

const WALLET = 'https://wallet.example';
const START = 1_755_000_000_000;
const NONCE = 'act-1';

class APage implements Openable {
  clock = START;
  private handler: ((e: MessageEvent) => void) | null = null;
  private timers = new Map<number, { run: () => void; at: number }>();
  private next = 1;
  readonly posted: unknown[] = [];
  readonly wallet: WalletWindow = {
    postMessage: (m: unknown) => { this.posted.push(m); },
    close: () => {},
    focus: () => {},
    closed: false,
  };

  open(): WalletWindow { return this.wallet; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void { this.handler = h; }
  removeEventListener(): void { this.handler = null; }
  setTimeout(run: () => void, ms: number): number { const id = this.next++; this.timers.set(id, { run, at: this.clock + ms }); return id; }
  clearTimeout(id: number): void { this.timers.delete(id); }
  now(): number { return this.clock; }
  get armedFor(): number[] { return [...this.timers.values()].map((t) => t.at - this.clock); }
  pass(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.timers]) if (t.at <= this.clock) { this.timers.delete(id); t.run(); }
  }
  say(data: unknown): void { this.handler?.({ origin: WALLET, source: this.wallet, data } as unknown as MessageEvent); }
  /** What this page posted to the wallet with this schema. */
  sent(schema: string): Record<string, unknown>[] {
    return this.posted.filter((m) => (m as { schema?: unknown }).schema === schema) as Record<string, unknown>[];
  }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const outcome = <T,>(p: Promise<T>) => {
  const seen: { value?: T; error?: unknown; done: boolean } = { done: false };
  p.then((value) => { seen.value = value; seen.done = true; }, (error: unknown) => { seen.error = error; seen.done = true; });
  return seen;
};
const relayOf = (n: number, step: number, steps = 3) =>
  ({ schema: ACT_RELAY_SCHEMA, nonce: NONCE, n, step, steps, transaction: `dHg${n}` });
const endOf = (over: Record<string, unknown>) =>
  ({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'move-between-vaults', relayed: 0, unconfirmed: 0, ...over });

const start = (page: APage, relay: (tx: string, at: { what?: string; also?: string }) => Promise<boolean>, minutes = 25) => outcome(actInTheWallet(page, WALLET, {
  intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) }, relay, minutes, nonce: NONCE, now: () => page.clock,
}));

describe('the page relays each transaction an action hands it, and is told how the action ended', () => {
  it('three transactions are relayed in order, each answered, and the action ends done', async () => {
    const page = new APage();
    const handed: string[] = [];
    const run = start(page, async (tx) => { handed.push(tx); return true; });
    page.say({ schema: READY_PING });
    const ask = page.posted[0] as Record<string, unknown>;
    /* RED WHEN: the ask is not an action, says nothing of progress, or carries anything but the action and its fields. */
    expect(ask).toMatchObject({ kind: 'act', nonce: NONCE, progress: PROGRESS_SCHEMA, intent: { name: 'move-between-vaults' } });
    expect(ask['expiresAt']).toBe(START + 25 * 60_000);
    for (let n = 1; n <= 3; n += 1) {
      page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: n, steps: 3 });
      page.say(relayOf(n, n));
      await settle();
    }
    /* RED WHEN: a transaction the wallet hands over is taken as the answer, or is not relayed. */
    expect(run.done).toBe(false);
    expect(handed).toEqual(['dHg1', 'dHg2', 'dHg3']);
    /* RED WHEN: the page does not tell the wallet what it did with each transaction, by its number. */
    expect(page.sent(ACT_RELAYED_SCHEMA)).toEqual([1, 2, 3].map((n) => ({ schema: ACT_RELAYED_SCHEMA, nonce: NONCE, n, outcome: 'relayed' })));
    page.say(endOf({ ended: 'done', step: 3, steps: 3, relayed: 3 }));
    await settle();
    expect(run.value).toEqual({ of: 'done', steps: 3, relayed: 3 });
  });

  it('what the wallet says a transaction is for, and the second transaction sent with it, reach the page\'s relay as given', async () => {
    const page = new APage();
    const handed: Array<{ tx: string; what?: string; also?: string }> = [];
    start(page, async (tx, at) => { handed.push({ tx, ...(at.what === undefined ? {} : { what: at.what }), ...(at.also === undefined ? {} : { also: at.also }) }); return true; });
    page.say({ schema: READY_PING });
    page.say({ ...relayOf(1, 1), what: 'creation', also: 'aW5zZXJ0' });
    page.say({ ...relayOf(2, 2), what: 'pay-key-seal' });
    /* A label that is not a name, and a second transaction with no label, are not relays at all: never handed on. */
    page.say({ ...relayOf(3, 3), what: 'Creation!' });
    page.say({ ...relayOf(3, 3), also: 'aW5zZXJ0' });
    await settle();
    /* RED WHEN: the page is not told where a transaction goes, loses the transaction sent with it, or is handed a malformed label. */
    expect(handed).toEqual([{ tx: 'dHg1', what: 'creation', also: 'aW5zZXJ0' }, { tx: 'dHg2', what: 'pay-key-seal' }]);
  });

  it('a transaction the page will not send is answered refused, and the action is stopped at that step', async () => {
    const page = new APage();
    const run = start(page, async (tx) => tx !== 'dHg2');
    page.say({ schema: READY_PING });
    page.say(relayOf(1, 1));
    page.say(relayOf(2, 2));
    await settle();
    /* RED WHEN: a refused relay is told to the wallet as relayed, so it builds the next step on a transaction that never went. */
    expect(page.sent(ACT_RELAYED_SCHEMA).map((m) => m['outcome'])).toEqual(['relayed', 'refused']);
    page.say(endOf({ ended: 'stopped', step: 2, steps: 3, relayed: 1, unconfirmed: 1, why: 'relay-refused' }));
    await settle();
    /* RED WHEN: a stopped action is thrown away as a failure, so the page cannot offer to take it up at the step it stopped. */
    /* RED WHEN: a transaction this page was handed and did not send is left out of what it holds. */
    expect(run.value).toEqual({ of: 'stopped', step: 2, steps: 3, relayed: 1, unconfirmed: 1, why: 'relay-refused' });
  });

  it('a transaction out of turn is refused and never sent', async () => {
    const page = new APage();
    const handed: string[] = [];
    void start(page, async (tx) => { handed.push(tx); return true; });
    page.say({ schema: READY_PING });
    page.say(relayOf(2, 1));
    page.say({ ...relayOf(1, 1), nonce: 'another-ask' });
    await settle();
    /* RED WHEN: transactions are relayed in whatever order the wallet's window sends them, or for another ask. */
    expect(handed).toEqual([]);
    expect(page.sent(ACT_RELAYED_SCHEMA)).toEqual([{ schema: ACT_RELAYED_SCHEMA, nonce: NONCE, n: 2, outcome: 'refused' }]);
  });

  it('a long action keeps the page waiting while its steps are said, and only its own deadline ends the wait', async () => {
    const page = new APage();
    const run = start(page, async () => true, 20);
    page.say({ schema: READY_PING });
    for (let minute = 0; minute < 16; minute += 4) {
      page.pass(4 * 60_000);
      page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 1, steps: 3 });
      /* RED WHEN: the step messages that are an action's heartbeat do not restart the page's wait. */
      expect(page.armedFor[0], `minute ${minute + 4}`).toBe(Math.min(ANSWER_TIMEOUT_MS, START + 20 * 60_000 - page.clock));
    }
    await settle();
    /* RED WHEN: a page gives up on a wallet that has kept saying its step for longer than one wait. */
    expect(run.done).toBe(false);
    /* RED WHEN: the step messages keep the page waiting past the deadline it wrote into the ask. */
    expect(page.armedFor).toEqual([4 * 60_000]);
    page.pass(4 * 60_000);
    await settle();
    /* RED WHEN: an action cut off by its deadline is reported as never having started, losing the step it was on. */
    expect(run.value).toEqual({ of: 'stopped', step: 1, steps: 3, relayed: 0, unconfirmed: 0, why: 'out-of-time' });
  });

  it('a transaction handed over is never taken as the answer by an ask that is not an action', async () => {
    const page = new APage();
    const asked = outcome(askWallet(page, WALLET, { ask: 1 }));
    page.say({ schema: READY_PING });
    page.say(relayOf(1, 1));
    await settle();
    /* RED WHEN: a relay message reaches the plain ask's answer branch. */
    expect(asked.done).toBe(false);
  });
});
