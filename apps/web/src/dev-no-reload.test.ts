import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type InlineConfig, type ViteDevServer } from 'vite';
import config from '../vite.config.js';

/*
 * A company is made over many minutes on this page, and the page keeps what it
 * has done so far only in memory. The development server must therefore never
 * make the browser reload the page when a file changes: not a file a worker
 * loads, not a script of the page, not a words file. A person who changes a file
 * while the page is open reloads it themselves.
 */
describe('the development server never reloads the page by itself', () => {
  /* RED WHEN: the development server is set to tell the browser about file changes, which reloads the page in the middle of making a company. */
  it('has the browser connection for file changes switched off', () => {
    expect((config as { server?: { hmr?: unknown } }).server?.hmr).toBe(false);
  });
});

const CHROMIUM = process.env.CHROMIUM_PATH ?? chromium.executablePath();

describe.skipIf(!existsSync(CHROMIUM))('A FILE CHANGING WHILE THE PAGE IS OPEN, IN A BROWSER [needs Chromium; `npx playwright install chromium` installs it, or CHROMIUM_PATH names one]', () => {
  let browser: Browser;
  let folder = '';
  const servers: ViteDevServer[] = [];

  const serve = async (server: InlineConfig['server']): Promise<string> => {
    const s = await createServer({ root: folder, configFile: false, cacheDir: `${folder}/.cache`, logLevel: 'silent', server: { port: 0, fs: { allow: [folder] }, ...server } });
    await s.listen();
    servers.push(s);
    return s.resolvedUrls!.local[0]!;
  };

  const surviving = async (url: string): Promise<boolean> => {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { kept?: number }).kept === 1);
    await page.evaluate(() => { (window as unknown as { marker?: string }).marker = 'same page'; });
    writeFileSync(`${folder}/part.js`, 'window.kept = 1; // changed\n');
    await page.waitForTimeout(3000);
    const marker = await page.evaluate(() => (window as unknown as { marker?: string }).marker).catch(() => undefined);
    await page.close();
    return marker === 'same page';
  };

  beforeAll(async () => {
    folder = mkdtempSync(`${tmpdir()}/web-dev-no-reload-`);
    writeFileSync(`${folder}/index.html`, '<!doctype html><html><body><script type="module" src="./part.js"></script></body></html>');
    writeFileSync(`${folder}/part.js`, 'window.kept = 1;\n');
    browser = await chromium.launch(process.env.CHROMIUM_PATH === undefined ? {} : { executablePath: process.env.CHROMIUM_PATH });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await s.close();
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
  });


  it('a server left to its defaults does reload the page when a script of it changes, so this check can see a reload', async () => {
    expect(await surviving(await serve({}))).toBe(false);
  }, 60_000);


  /* RED WHEN: saving a script of the page, with the application's server settings, reloads the page and loses what the person had done on it. */
  it('the application\'s server leaves the page as it is when a script of it changes', async () => {
    const { proxy: _proxy, fs: _fs, ...kept } = (config as { server: InlineConfig['server'] & object }).server;
    expect(await surviving(await serve(kept))).toBe(true);
  }, 60_000);
});
