import { describe, expect, it } from 'vitest';
import { PROGRESS_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import {
  ANSWER_TIMEOUT_MS, OUT_OF_TIME_SAYS, RAN_OUT_SAYS, UNREADABLE_SAYS, WENT_QUIET_SAYS, WalletClosed, askWallet, openWalletDialog,
} from './wallet-sign-in.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/*
 * **THE PAGE KNOWS THE WALLET'S WORD FOR BEING AT WORK BEFORE ANY WALLET SAYS
 * IT**, and waits for a silence rather than a total: a wallet reporting real
 * events keeps the wait open, a wallet that goes quiet ends it, and the ask's
 * own deadline ends it whatever is said.
 */

const WALLET = 'https://wallet.example';
const START = 1_755_000_000_000;

/** A page whose clock and timers the test moves by hand, and a wallet window the test speaks for. */
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

  /** The one wait now armed: when it fires, as a delay from now. */
  get armedFor(): number[] { return [...this.timers.values()].map((t) => t.at - this.clock); }
  /** Moves the clock and runs what came due. */
  pass(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.timers]) if (t.at <= this.clock) { this.timers.delete(id); t.run(); }
  }
  say(data: unknown): void { this.handler?.({ origin: WALLET, source: this.wallet, data } as unknown as MessageEvent); }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const outcome = (p: Promise<unknown>) => {
  const seen: { value?: unknown; error?: unknown; done: boolean } = { done: false };
  p.then((value) => { seen.value = value; seen.done = true; }, (error: unknown) => { seen.error = error; seen.done = true; });
  return seen;
};

describe('A WALLET AT WORK IS NEVER THE ANSWER', () => {
  it('a progress message keeps the ask open, and only the answer after it resolves it', async () => {
    const page = new APage();
    const asked = outcome(askWallet(page, WALLET, { ask: 1, expiresAt: START + 30 * 60_000 }));
    page.say({ schema: READY_PING });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'reading' });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', transaction: 'AAAA' });
    /* A stage this page does not know yet is still a wallet at work. */
    page.say({ schema: PROGRESS_SCHEMA, stage: 'something-new' });
    await settle();
    /* RED WHEN: the progress branch is taken out, so the first progress message is handed on as the answer. */
    expect(asked.done).toBe(false);
    page.say({ schema: 'midnight-identity/balanced/v1', transaction: 'Zg==' });
    await settle();
    expect(asked.value).toEqual({ schema: 'midnight-identity/balanced/v1', transaction: 'Zg==' });
  });

  it('a progress message before the ask was sent is not a wallet at work on it', () => {
    const page = new APage();
    void askWallet(page, WALLET, { ask: 1 }).catch(() => {});
    page.say({ schema: PROGRESS_SCHEMA, stage: 'reading' });
    /* RED WHEN: a progress message replaces the twenty seconds a wallet has to say it is listening with the five-minute wait. */
    expect(page.armedFor).toEqual([20_000]);
  });
});

describe('THE WAIT IS A SILENCE, NOT A TOTAL, AND IT ENDS AT THE ASK\'S OWN DEADLINE', () => {
  it('every progress message starts the silence again; a wallet that goes quiet is told apart by where it stopped', async () => {
    const page = new APage();
    const asked = outcome(askWallet(page, WALLET, { ask: 1, expiresAt: START + 30 * 60_000 }));
    page.say({ schema: READY_PING });
    expect(page.armedFor).toEqual([ANSWER_TIMEOUT_MS]);
    for (let i = 0; i < 4; i += 1) {
      page.pass(ANSWER_TIMEOUT_MS - 1_000);
      page.say({ schema: PROGRESS_SCHEMA, stage: i < 2 ? 'reading' : 'proving' });
      /* RED WHEN: the wait is a total again - progress does not restart it, and a slow wallet at work is cut off. */
      expect(page.armedFor, `after progress ${i}`).toEqual([ANSWER_TIMEOUT_MS]);
    }
    await settle();
    expect(asked.done).toBe(false);
    page.pass(ANSWER_TIMEOUT_MS);
    await settle();
    /* RED WHEN: a wallet that stopped while proving is reported as one that never answered at all. */
    expect(asked.error).toBeInstanceOf(WalletClosed);
    expect((asked.error as WalletClosed).refusal).toEqual({ of: 'silent' });
    expect((asked.error as WalletClosed).message).toBe(WENT_QUIET_SAYS.proving);
  });

  it('a wallet at work for ever is still stopped at the deadline this page wrote into its ask', async () => {
    const page = new APage();
    const asked = outcome(askWallet(page, WALLET, { ask: 1, expiresAt: START + 12 * 60_000 }));
    page.say({ schema: READY_PING });
    for (let i = 0; i < 5; i += 1) {
      page.pass(2 * 60_000);
      page.say({ schema: PROGRESS_SCHEMA, stage: 'proving' });
    }
    /* Ten minutes in, two left: the wait is armed for the deadline, not for five more minutes of silence. */
    /* RED WHEN: the deadline is not read from the ask, and progress keeps the wait open past it. */
    expect(page.armedFor).toEqual([2 * 60_000]);
    page.pass(2 * 60_000);
    await settle();
    expect((asked.error as WalletClosed).refusal).toEqual({ of: 'expired' });
    expect((asked.error as WalletClosed).message).toBe(OUT_OF_TIME_SAYS);
  });

  it('an ask whose deadline has already gone ends as soon as the wallet says it is listening', async () => {
    const page = new APage();
    const asked = outcome(askWallet(page, WALLET, { ask: 1, expiresAt: START - 1 }));
    page.say({ schema: READY_PING });
    page.pass(0);
    await settle();
    /* RED WHEN: a deadline in the past is treated as no deadline. */
    expect((asked.error as WalletClosed).refusal).toEqual({ of: 'expired' });
    /* RED WHEN: a wallet that never said it was at work is said to have been "still working". */
    expect((asked.error as WalletClosed).message).toBe(RAN_OUT_SAYS);
  });
});

describe('A WALLET THAT REFUSED WHAT IT WAS SENT IS NEITHER A DECLINE NOR A FAILURE', () => {
  it('reads `unreadable` in its own words', async () => {
    const page = new APage();
    const asked = outcome(askWallet(page, WALLET, { ask: 1 }));
    page.say({ schema: READY_PING });
    page.say({ schema: 'midnight-identity/disclosure-refused/v1', reason: 'unreadable' });
    await settle();
    /* RED WHEN: the page does not know the word, and tells the person they did not approve something they were never asked. */
    expect((asked.error as WalletClosed).refusal).toEqual({ of: 'unreadable' });
    expect((asked.error as WalletClosed).message).toBe(UNREADABLE_SAYS);
    expect(UNREADABLE_SAYS).not.toMatch(/you did not approve|declined/u);
  });
});

describe('THE DIALOG SAYS WHAT THE WALLET LAST SAID IT WAS DOING', () => {
  it('each stage as it is reported, and nothing once the ask has ended', async () => {
    const page = new APage();
    const dialog = openWalletDialog(page, WALLET);
    const seen: (string | null)[] = [];
    const unwatch = dialog.onStage!((stage) => seen.push(stage));
    const asked = outcome(askWallet(page, WALLET, { ask: 1 }, dialog));
    expect(dialog.stage).toBeNull();
    page.say({ schema: READY_PING });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'reading' });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'reading' });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving' });
    /* RED WHEN: the stage is not passed to the dialog, so a waiting screen can only ever say "waiting". */
    expect(dialog.stage).toBe('proving');
    page.say({ schema: 'midnight-identity/balanced/v1' });
    await settle();
    expect(asked.done).toBe(true);
    /* RED WHEN: a finished ask leaves a stage on the dialog for the next one to inherit. */
    expect(seen).toEqual(['reading', 'proving', null]);
    unwatch();
  });
});
