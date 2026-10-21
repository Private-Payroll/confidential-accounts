import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendWebConsole } from '../../../src/server/web-console-log.js';

/*
 * AN ERROR RAISED ON THE PAGE REACHES THE DEVELOPER'S REPORT, WITHOUT ITS SECRETS.
 * The page here is a plain object, so the test reads exactly what the page posts
 * and what the service writes; the service's own route is checked where it is
 * started. The entry is read for the module it loads in development, behind the
 * development condition, and that module is then loaded the way the page loads it, so removing
 * the line empties the report.
 */
const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));
const SEED = '39aebaeb0a2f4c1d8e7b6a5940312233445566778899aabbccddeeff00112233';

/** The module the entry loads in development, and only when the build is a development one. */
const developmentImportOf = (source: string): string =>
  /^if \(import\.meta\.env\.DEV\) await import\('([^']+)'\);$/m.exec(source)?.[1] ?? '';

let logPath = '';
let listeners: Record<string, ((event: unknown) => void)[]> = {};
let posts: { url: string; body: string }[] = [];

const pageAt = (href: string): void => {
  listeners = {};
  posts = [];
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (type: string, handler: (event: unknown) => void) => { (listeners[type] ??= []).push(handler); },
    fetch: async (url: string, init: { body: string }) => {
      posts.push({ url, body: init.body });
      appendWebConsole(JSON.parse(init.body).page, JSON.parse(init.body).entries);
      return { ok: true, status: 204 };
    },
    console: { error: () => {}, warn: () => {} },
    location: { href },
    setTimeout: (fn: () => void) => { fn(); return 0; },
  };
};

beforeEach(() => {
  logPath = join(mkdtempSync(join(tmpdir(), 'web-console-')), 'report.txt');
  vi.stubEnv('WEB_CONSOLE_LOG', logPath);
  vi.stubEnv('VITE_DEV_ERROR_SINK', '1');
  vi.resetModules();
  pageAt('http://localhost:5173/');
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as { window?: unknown }).window;
});

const loadWhatTheEntryLoads = async (): Promise<string> => {
  const specifier = developmentImportOf(readFileSync(ENTRY, 'utf8'));
  await import(/* @vite-ignore */ specifier);
  return specifier;
};

describe('the web application in development', () => {
  /* RED WHEN: an error raised on the page does not reach the report, or reaches it with a key or seed in it. */
  it('writes an error raised on the page to the report, with the seed removed', async () => {
    expect(await loadWhatTheEntryLoads()).toMatch(/error-(report|sink)\.js$/);
    for (const handler of listeners['error'] ?? []) {
      handler({ error: new Error(`restore failed, wallet seed ${SEED}`), message: 'x' });
    }
    expect(posts.length).toBe(1);
    const report = readFileSync(logPath, 'utf8');
    expect(report).toContain('restore failed');
    expect(report).toContain('http://localhost:5173/');
    expect(report).not.toContain(SEED);
    expect(report).not.toContain(SEED.slice(0, 24));
  });

  /* RED WHEN: a production build installs the sink, or a page without the development setting reports. */
  it('reports nothing when it is not a development build', async () => {
    vi.stubEnv('DEV', false);
    await loadWhatTheEntryLoads();
    expect(Object.keys(listeners)).toEqual([]);
    expect(existsSync(logPath)).toBe(false);
  });
});
