import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* An action whose entry lists a read of its company, so a call can be made inside a step. */
vi.mock('midnight-identity/profile/act-channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('midnight-identity/profile/act-channel')>();
  const shape = { fields: { company: 'record' }, calls: [{ method: 'GET', path: '/api/accounts/:company' }] };
  return { ...actual, intentShapeOf: (name: string) => (name === 'name-a-vault' ? shape : actual.intentShapeOf(name)) };
});
import { ACT_CALL_SCHEMA, ACT_ENDED_SCHEMA, ACT_RELAY_SCHEMA, PROGRESS_SCHEMA, READY_PING } from 'midnight-identity/profile/channel';
import { appendWebConsole } from '../../../src/server/web-console-log.js';
import { installErrorSink, type SinkWindow } from './error-sink.js';
import { ACT_LOG_EVERY_MS, actInTheWallet } from './wallet-act.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/*
 * **WHAT A DEVELOPER READS IN THE CONSOLE REPORT WHILE AN ACTION RUNS IN THE WALLET.** The page writes each step it is
 * told of, each transaction it relays, a line each minute a step runs past one, and how the action ended, to its
 * console; the console report (`error-sink.ts`) carries them to the service, which writes them to its log. The wallet's
 * side is spoken here by the test, message by message, on a clock the test moves; the report is the real one, writing
 * to a file of the test's own.
 */

const WALLET = 'https://wallet.example';
const START = 1_755_000_000_000;
const NONCE = 'act-log-1';
/* Put where only the wallet and the service may see them: in the action's fields, and as the transaction itself. */
const SECRET_FIELD = 'hidden-ostrich-word';
const SECRET_TRANSACTION = 'UExBTlRFRC1TRUNSRVQtVFg=';

class APage implements Openable {
  clock = START;
  private handler: ((e: MessageEvent) => void) | null = null;
  private timers = new Map<number, { run: () => void; at: number }>();
  private next = 1;
  readonly wallet: WalletWindow = { postMessage: () => {}, close: () => {}, focus: () => {}, closed: false };

  open(): WalletWindow { return this.wallet; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void { this.handler = h; }
  removeEventListener(): void { this.handler = null; }
  setTimeout(run: () => void, ms: number): number { const id = this.next++; this.timers.set(id, { run, at: this.clock + ms }); return id; }
  clearTimeout(id: number): void { this.timers.delete(id); }
  now(): number { return this.clock; }
  pass(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.timers]) if (t.at <= this.clock) { this.timers.delete(id); t.run(); }
  }
  say(data: unknown): void { this.handler?.({ origin: WALLET, source: this.wallet, data } as unknown as MessageEvent); }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

let logPath = '';
const consoleWas = { warn: console.warn, error: console.error };

beforeEach(() => {
  logPath = join(mkdtempSync(join(tmpdir(), 'act-log-')), 'REPORT-WEB-CONSOLE.txt');
  vi.stubEnv('WEB_CONSOLE_LOG', logPath);
  vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
  console.warn = () => {};
  console.error = () => {};
  /* The report as a development page installs it, on this test's console, posting straight to the service's writer. */
  installErrorSink({
    addEventListener: () => {},
    fetch: async () => ({ ok: true, status: 204 }),
    console,
    location: { href: 'http://localhost:5173/setup' },
    setTimeout: (fn: () => void) => { fn(); return 0; },
  } as unknown as SinkWindow, (body) => appendWebConsole(body.page, body.entries));
});
afterEach(() => {
  console.warn = consoleWas.warn;
  console.error = consoleWas.error;
  vi.unstubAllEnvs();
});

describe('an action in the wallet writes where it got to in the console report', () => {
  it('a step that stalls shows as still running each minute, and the stop says the step and its reason', async () => {
    const page = new APage();
    const run = actInTheWallet(page, WALLET, {
      intent: { name: 'move-between-vaults', vault: 'c'.repeat(64), memo: SECRET_FIELD },
      relay: async () => true, nonce: NONCE, now: () => page.clock,
    });
    page.say({ schema: READY_PING });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 1, steps: 3 });
    page.say({ schema: ACT_RELAY_SCHEMA, nonce: NONCE, n: 1, step: 1, steps: 3, transaction: SECRET_TRANSACTION, what: 'creation' });
    await settle();
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 2, steps: 3 });
    /* Step 2 stalls: the wallet keeps saying it is on step 2 for two and a half minutes. */
    for (let s = 0; s < 5; s += 1) {
      page.pass(30_000);
      page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 2, steps: 3 });
    }
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'move-between-vaults', ended: 'stopped', step: 2, steps: 3, relayed: 1, unconfirmed: 0, why: 'step-failed' });
    await settle();
    expect(await run).toMatchObject({ of: 'stopped', step: 2, why: 'step-failed' });

    const report = readFileSync(logPath, 'utf8');
    /* RED WHEN: the page does not write a step the wallet says it has begun. */
    expect(report).toContain('console.warn   action move-between-vaults: step 2 of 3 started');
    /* RED WHEN: the step before is not written as finished, with what was relayed by then. */
    expect(report).toContain('action move-between-vaults: step 1 of 3 finished (relayed 1, unconfirmed 0)');
    /* RED WHEN: a transaction the page relays is not written by its number, its kind and what became of it. */
    expect(report).toContain('action move-between-vaults: step 1 of 3: transaction 1 (creation) relayed (relayed 1, unconfirmed 0)');
    /* RED WHEN: a step running past a minute is not written as still running, with its minutes, each minute. */
    expect(report).toContain('action move-between-vaults: still running step 2 of 3, 1 minute (');
    expect(report).toContain('action move-between-vaults: still running step 2 of 3, 2 minutes (');
    /* RED WHEN: the heartbeat lines the wallet sends while a step runs are written as the step starting again. */
    expect(report.split('step 2 of 3 started').length - 1).toBe(1);
    /* RED WHEN: the stop is not written with its step, its reason and its counts. */
    expect(report).toContain('action move-between-vaults: stopped at step 2 of 3: step-failed (relayed 1, unconfirmed 0)');
    /* RED WHEN: a line carries the action's fields or the transaction the page relayed. */
    expect(report).not.toContain(SECRET_FIELD);
    expect(report).not.toContain(SECRET_TRANSACTION);
    expect(report).not.toContain('c'.repeat(32));
  });

  it('calls and transactions inside a later step are written under that step, whatever step their message carries', async () => {
    const page = new APage();
    const run = actInTheWallet(page, WALLET, {
      intent: { name: 'name-a-vault', company: 'acc_1' }, nonce: NONCE, now: () => page.clock,
      relay: async () => true, call: async () => ({ status: 200, body: {} }),
    });
    page.say({ schema: READY_PING });
    for (let step = 1; step <= 4; step += 1) page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step, steps: 5 });
    /* Inside step 4: one call whose message carries step 1, one that carries step 4, and a transaction that carries step 1. */
    page.say({ schema: ACT_CALL_SCHEMA, nonce: NONCE, n: 1, step: 1, steps: 5, method: 'GET', path: '/api/accounts/acc_1' });
    page.say({ schema: ACT_CALL_SCHEMA, nonce: NONCE, n: 2, step: 4, steps: 5, method: 'GET', path: '/api/accounts/acc_1' });
    page.say({ schema: ACT_RELAY_SCHEMA, nonce: NONCE, n: 1, step: 1, steps: 5, transaction: SECRET_TRANSACTION, what: 'creation' });
    await settle();
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 5, steps: 5 });
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'name-a-vault', ended: 'done', step: 5, steps: 5, relayed: 1, unconfirmed: 0 });
    await settle();
    await run;
    const report = readFileSync(logPath, 'utf8');
    /* RED WHEN: a call or a transaction is written under the step its message carries rather than the step the wallet is on. */
    expect(report).toContain('action name-a-vault: step 4 of 5: call 1 GET /api/accounts/acc_1 answered 200');
    expect(report).toContain('action name-a-vault: step 4 of 5: call 2 GET /api/accounts/acc_1 answered 200');
    expect(report).toContain('action name-a-vault: step 4 of 5: transaction 1 (creation) relayed');
    /* RED WHEN: a call inside a later step writes a start or a finish for a step the wallet is not on. */
    for (let step = 1; step <= 5; step += 1) {
      expect(report.split(`step ${step} of 5 started`).length - 1, `step ${step} started`).toBe(1);
    }
    for (let step = 1; step <= 4; step += 1) {
      expect(report.split(`step ${step} of 5 finished`).length - 1, `step ${step} finished`).toBe(1);
    }
    expect(report).not.toContain('step 1 of 5:');
  });

  it('the minute line stops once the action has ended', async () => {
    const page = new APage();
    const run = actInTheWallet(page, WALLET, {
      intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) }, relay: async () => true, nonce: NONCE, now: () => page.clock,
    });
    page.say({ schema: READY_PING });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 1, steps: 1 });
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'move-between-vaults', ended: 'done', step: 1, steps: 1, relayed: 0, unconfirmed: 0 });
    await run;
    page.pass(3 * ACT_LOG_EVERY_MS);
    const report = readFileSync(logPath, 'utf8');
    expect(report).toContain('action move-between-vaults: done, 1 of 1 steps (relayed 0)');
    /* RED WHEN: the minute line keeps being written after the action has ended. */
    expect(report).not.toContain('still running');
  });

  it('an action whose wallet window fails writes the error it ended with', async () => {
    const page = new APage();
    const run = actInTheWallet(page, WALLET, {
      intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) }, relay: async () => true, nonce: NONCE, now: () => page.clock,
    });
    page.say({ schema: READY_PING });
    page.say({ schema: 'not-an-answer' });
    page.say({ nonce: NONCE, kind: 'nonsense' });
    await expect(run).rejects.toThrow();
    const report = readFileSync(logPath, 'utf8');
    /* RED WHEN: an action that ends by throwing writes nothing of why. */
    expect(report).toMatch(/action move-between-vaults: ended with an error: \S+/);
  });

  it('writes nothing outside a development build with the console report on', async () => {
    vi.stubEnv('VITE_DEV_ERROR_SINK', '');
    const page = new APage();
    const run = actInTheWallet(page, WALLET, {
      intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) }, relay: async () => true, nonce: NONCE, now: () => page.clock,
    });
    page.say({ schema: READY_PING });
    page.say({ schema: PROGRESS_SCHEMA, stage: 'proving', step: 1, steps: 1 });
    page.say({ schema: ACT_ENDED_SCHEMA, nonce: NONCE, intent: 'move-between-vaults', ended: 'done', step: 1, steps: 1, relayed: 0, unconfirmed: 0 });
    await run;
    /* RED WHEN: the page writes an action's lines to the console when the console report is not on. */
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });
});
