import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendWebConsole } from '../../../src/server/web-console-log.js';
import { installErrorSink, type SinkWindow } from './error-sink.js';
import { boundedRead, ReadRanOutOfTime, SERVICE_READ_BOUND_MS, serviceRead } from './read-bound.js';

/*
 * **WHAT A DEVELOPER READS IN THE CONSOLE REPORT ABOUT THE PAGE'S OWN READS.** Every read the page bounds is written,
 * once, where the bound is: what it read, its status and how long it took, or that it ran out of time and after how
 * long. The console report (`error-sink.ts`) carries the lines to the service, which writes them to its log; the report
 * here is the real one, writing to a file of the test's own.
 */

const HIDDEN_BODY_WORD = 'hidden-ostrich-word';
let logPath = '';
const consoleWas = { warn: console.warn, error: console.error };

beforeEach(() => {
  vi.useFakeTimers({ now: 1_755_000_000_000 });
  logPath = join(mkdtempSync(join(tmpdir(), 'read-log-')), 'REPORT-WEB-CONSOLE.txt');
  vi.stubEnv('WEB_CONSOLE_LOG', logPath);
  vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
  console.warn = () => {};
  console.error = () => {};
  installErrorSink({
    addEventListener: () => {},
    fetch: async () => ({ ok: true, status: 204 }),
    console,
    location: { href: 'http://localhost:5173/' },
    setTimeout: (fn: () => void) => { fn(); return 0; },
  } as unknown as SinkWindow, (body) => appendWebConsole(body.page, body.entries));
});
afterEach(() => {
  console.warn = consoleWas.warn;
  console.error = consoleWas.error;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const report = (): string => readFileSync(logPath, 'utf8');
const hangs = (signal: AbortSignal): Promise<never> =>
  new Promise((_, refuse) => { signal.addEventListener('abort', () => refuse(new DOMException('The read was stopped.', 'AbortError'))); });

describe('a read the page makes writes what it got in the console report', () => {
  it('a read that answers is written with what it read, its status and how long it took, and nothing of its body', async () => {
    const read = serviceRead('The service (/api/accounts/acc_7Qx/records)', async () => {
      await new Promise((done) => { setTimeout(done, 312); });
      return { status: 200, body: { note: HIDDEN_BODY_WORD } };
    });
    await vi.advanceTimersByTimeAsync(312);
    await read;
    /* RED WHEN: a read that answered is not written with what it read, its status and its time. */
    expect(report()).toContain('console.warn   read The service (/api/accounts/acc_7Qx/records): answered 200 in 312 ms');
    /* RED WHEN: a line carries what the read answered. */
    expect(report()).not.toContain(HIDDEN_BODY_WORD);
  });

  it('a read that does not answer is written as running out of time, which read and after how long', async () => {
    const read = boundedRead('The service (/api/me)', hangs);
    const seen = read.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS);
    expect(await seen).toBeInstanceOf(ReadRanOutOfTime);
    /* RED WHEN: a read the bound gave up on is not written, or not with its name and its time. */
    expect(report()).toContain('console.warn   read The service (/api/me): did not answer within 20 seconds, so the page stopped waiting for it');
  });

  it('a read bounded elsewhere that runs out of time is written the same way', () => {
    void new ReadRanOutOfTime('The network (vault-state)');
    /* RED WHEN: a read that runs out of time outside this file's bound writes nothing. */
    expect(report()).toContain('read The network (vault-state): did not answer within 20 seconds, so the page stopped waiting for it');
  });

  it('a read that fails is written with its time and its error', async () => {
    const read = boundedRead('The network indexer', async () => { throw new TypeError('Failed to fetch'); }).catch(() => undefined);
    await read;
    /* RED WHEN: a read that failed is not written with what failed and why. */
    expect(report()).toContain('read The network indexer: failed after 0 ms: TypeError: Failed to fetch');
  });

  it('writes nothing outside a development build with the console report on', async () => {
    vi.stubEnv('VITE_DEV_ERROR_SINK', '');
    await serviceRead('The service (/api/me)', async () => ({ status: 200 }));
    void new ReadRanOutOfTime('The service (/api/me)');
    /* RED WHEN: the page writes its reads to the console when the console report is not on. */
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });
});
