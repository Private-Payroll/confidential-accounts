import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import config, { REFUSED_NAMES, SERVED_FROM, WASM_PACKAGES, WORKERS } from '../vite.config.js';

/*
 * THE DEVELOPMENT SERVER SERVES THE KIT'S FONT AND EACH WORKER, AND OPENS
 * NOTHING WIDER. The kit's stylesheet names the Inter package, installed at
 * the top of the repository; a server that may not serve it shows a fallback
 * font. A worker's entry is asked for by its path, so the server must be
 * allowed its folder, or creating a vault never starts. The three packages
 * that carry WebAssembly are fetched from the modules folder by the worker, so
 * the server must be allowed exactly those three folders, where they really
 * are, and no other package beside them.
 */
const APP = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const FONT = `${REPO}/node_modules/@fontsource-variable/inter`;
/** A folder for the server's prepared dependencies, made when a suite starts and removed when it ends, even when a test in it fails. It is inside the modules folder so that a prepared dependency can find the packages it names. */
const preparedFolder = (name: string): string => {
  mkdirSync(`${REPO}/node_modules`, { recursive: true });
  return mkdtempSync(`${REPO}/node_modules/.${name}`);
};
/** Where a package of the modules folder really is, whether the modules folder is the repository's own or a link to a shared one. */
const folderOf = (name: string): string => realpathSync(`${REPO}/node_modules/${name}`);
const ENTRIES = Object.keys(WORKERS).map((e) => fileURLToPath(new URL(e, new URL('../', import.meta.url))));

describe('the development server: what it may serve', () => {
  /* RED WHEN: the server may not serve the font package, a worker's folder or the folder of a package that carries WebAssembly, may serve the repository, its packages or its modules folder, or the list it serves from is not the one the config uses. */
  it('may serve this application, each worker\'s folder, the font package and the folders of the three WebAssembly packages, and nothing else', () => {
    const allow = (config as { server?: { fs?: { allow?: string[] } } }).server?.fs?.allow;
    expect(allow).toBe(SERVED_FROM);
    const served = SERVED_FROM.map((p) => p.replace(/\/$/, ''));
    expect(served).toEqual([APP, ...new Set(ENTRIES.map((e) => dirname(e))), FONT, ...WASM_PACKAGES.map(folderOf)]);
    expect(WASM_PACKAGES.length).toBe(3);
    expect(ENTRIES.length).toBe(2);
    for (const wider of [REPO, `${REPO}/node_modules`, `${REPO}/node_modules/@fontsource-variable`, `${REPO}/packages`, `${REPO}/src`, `${REPO}/contracts`]) expect(served).not.toContain(wider);
  });

  /* RED WHEN: the kit's stylesheet names a font package other than the one the server may serve, or that package is not there. */
  it('serves the font the kit\'s stylesheet names', () => {
    expect(readFileSync(`${REPO}/packages/ui/src/styles.css`, 'utf8')).toContain('@import "@fontsource-variable/inter";');
    expect(existsSync(`${FONT}/index.css`)).toBe(true);
  });

  /* RED WHEN: the config's refused list drops one of the places the repository keeps a secret or something private to a machine. */
  it('refuses the places that hold a secret, as a file and as a folder', () => {
    const deny = (config as { server?: { fs?: { deny?: string[] } } }).server?.fs?.deny ?? [];
    for (const name of ['.env', '*.seed', '.keys-backup', '.midnight', 'logs', 'SAFE', '.data', '.wallet-state', '.pre-reset-*', 'midnight-level-db', 'db', '.git']) {
      expect(REFUSED_NAMES).toContain(name);
      expect(deny).toContain(`**/${name}`);
      expect(deny).toContain(`**/${name}/**`);
    }
  });
});

describe('the development server, running', () => {
  let server: ViteDevServer;
  let base = '';
  let folder = '';
  let cache = '';
  const get = async (path: string): Promise<{ status: number; type: string; body: string }> => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
  };

  beforeAll(async () => {
    cache = preparedFolder('web-dev-server-');
    folder = mkdtempSync(`${tmpdir()}/web-dev-server-files-`);
    for (const dir of ['', '.midnight/', 'logs/', 'SAFE/', '.data/', '.wallet-state/', '.keys-backup/', '.pre-reset-2026-01-01/', 'midnight-level-db/', 'db/']) {
      if (dir !== '') mkdirSync(`${folder}/${dir}`, { recursive: true });
      writeFileSync(`${folder}/${dir}a-private-file`, 'private');
    }
    for (const file of ['.env', '.env.local', 'words.seed', 'cert.pem']) writeFileSync(`${folder}/${file}`, 'private');
    writeFileSync(`${folder}/a-public-file`, 'public');
    /* The test folder is allowed beside the config's list, so that what the refused list holds back is shown inside a folder the server may serve. */
    server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), cacheDir: cache, logLevel: 'silent', server: { port: 0, fs: { allow: [folder] } } });
    await server.listen();
    base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (cache !== '') rmSync(cache, { recursive: true, force: true });
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
  });

  /* RED WHEN: the server refuses a worker's entry, or any file the worker loads once it runs (found by following every import and every module's own imports, as the browser does). */
  it('serves each worker\'s entry and everything the worker loads', async () => {
    const queue = ENTRIES.map((e) => `/@fs${e}?worker_file&type=module`);
    const seen = new Map<string, number>();
    const refused: string[] = [];
    const imported = /(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g;
    while (queue.length > 0) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      const got = await get(url);
      seen.set(url, got.status);
      if (got.status !== 200) { refused.push(`${got.status} ${url}`); continue; }
      if (!/javascript/.test(got.type)) continue;
      for (const m of got.body.matchAll(imported)) {
        const spec = m[1]!;
        if (spec.startsWith('/')) queue.push(spec);
        else if (spec.startsWith('.')) queue.push(new URL(spec, `http://x${url.split('?')[0]}`).pathname);
      }
    }
    expect(refused).toEqual([]);
    for (const e of ENTRIES) expect(seen.get(`/@fs${e}?worker_file&type=module`)).toBe(200);
    expect(seen.size).toBeGreaterThan(50);
  }, 120_000);

  /* RED WHEN: the server serves an environment file, a seed, a key backup, a certificate, or anything in the wallet's state, the data folders, the logs, the chain's database or the safe, inside a folder it may serve; or it stops serving an ordinary file there. */
  it('refuses what holds a secret, even inside a folder it may serve', async () => {
    expect((await get(`/@fs${folder}/a-public-file`)).status).toBe(200);
    const secret = ['.env', '.env.local', 'words.seed', 'cert.pem', '.midnight/a-private-file', 'logs/a-private-file', 'SAFE/a-private-file', '.data/a-private-file', '.wallet-state/a-private-file', '.keys-backup/a-private-file', '.pre-reset-2026-01-01/a-private-file', 'midnight-level-db/a-private-file', 'db/a-private-file'];
    const answers = await Promise.all(secret.map(async (f) => `${(await get(`/@fs${folder}/${f}`)).status} ${f}`));
    expect(answers).toEqual(secret.map((f) => `403 ${f}`));
  });

  /* RED WHEN: the server refuses the WebAssembly file of one of the three packages that carry it, at the address the worker asks for it, or serves anything but WebAssembly there; or it serves a file of a package beside them. */
  it('serves each WebAssembly package\'s .wasm file as WebAssembly, and a package beside them not at all', async () => {
    const answers: string[] = [];
    for (const name of WASM_PACKAGES) {
      const folder = folderOf(name);
      const wasm = readdirSync(folder).filter((f) => f.endsWith('.wasm'));
      expect(wasm).toHaveLength(1);
      const r = await fetch(`${base}/@fs${folder}/${wasm[0]}`);
      const head = [...new Uint8Array(await r.arrayBuffer()).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
      answers.push(`${r.status} ${name} ${head}`);
    }
    expect(answers).toEqual(WASM_PACKAGES.map((name) => `200 ${name} 0061736d`));
    const beside = ['@midnight-ntwrk/compact-runtime/package.json', '@midnight-ntwrk/compact-js/package.json', '@midnightntwrk/wallet-sdk/package.json', 'vite/package.json'].filter((f) => existsSync(`${REPO}/node_modules/${f}`));
    expect(beside.length).toBeGreaterThanOrEqual(3);
    const refused = await Promise.all(beside.map(async (f) => `${(await fetch(`${base}/@fs${realpathSync(`${REPO}/node_modules/${f}`)}`)).status} ${f}`));
    expect(refused).toEqual(beside.map((f) => `403 ${f}`));
  });

  /* RED WHEN: the server serves a file from the repository's top folder, its server source or its contracts by their path (a file no served module imports). */
  it('refuses a file of the repository that no served module imports', async () => {
    for (const f of ['package.json', 'src/server/index.ts', 'src/server/session-cookie.ts', 'contracts/src/Vault.compact']) expect((await get(`/@fs${REPO}/${f}`)).status).toBe(403);
  });
});

/*
 * THE WORKERS START IN A BROWSER. A file the server serves is not a worker
 * that runs: the ledger, the on-chain runtime and the circuit checker are
 * WebAssembly, and each ships a loader that starts it as the loader is read.
 * The server's preparation of dependencies once broke those loaders, and every
 * file was still served with a 200. So this loads each worker in Chromium, as
 * the page does, and asks it something.
 */
const CHROMIUM = process.env.CHROMIUM_PATH ?? chromium.executablePath();

describe.skipIf(!existsSync(CHROMIUM))('THE WORKERS THE PAGE STARTS, IN A BROWSER [needs Chromium; `npx playwright install chromium` installs it, or CHROMIUM_PATH names one]', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let base = '';
  let cache = '';
  const entryUrl = (entry: string): string => `/@fs${entry}?worker_file&type=module`;

  beforeAll(async () => {
    cache = preparedFolder('web-dev-server-browser-');
    server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), cacheDir: cache, logLevel: 'silent', server: { port: 0 } });
    await server.listen();
    base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    browser = await chromium.launch(process.env.CHROMIUM_PATH === undefined ? {} : { executablePath: process.env.CHROMIUM_PATH });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (cache !== '') rmSync(cache, { recursive: true, force: true });
  });

  /* RED WHEN: the page at its address raises an error when it opens (an uncaught error, or a message of error that is not the service being away). */
  it('opens the page with no error', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.location().url.includes('/api/')) errors.push(m.text()); });
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  /* RED WHEN: the vault worker stops with an error before it answers, or answers an ask by saying its ledger, on-chain runtime or prover did not load. */
  it('starts the vault worker, which loads the ledger and answers', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`, { waitUntil: 'load' });
    const heard = await page.evaluate((url) => new Promise<string[]>((done) => {
      const said: string[] = [];
      const w = new Worker(url, { type: 'module' });
      w.onerror = (e) => { said.push(`error ${e.message}`); done(said); };
      w.onmessage = (e) => {
        const data = e.data as { kind?: string; id?: number; ok?: boolean; error?: string };
        if (data.kind === 'vault-worker-ready') w.postMessage({ id: 1, ask: 'nothing', network: 'undeployed' });
        else if (data.id === 1) { said.push(`answer ${data.ok} ${data.error ?? ''}`); done(said); }
      };
      setTimeout(() => { said.push('no answer'); done(said); }, 60_000);
    }), entryUrl(ENTRIES[0]!));
    await page.close();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^answer false /);
    expect(heard[0]).not.toMatch(/wbindgen|initiali[sz]ation|undefined|stopped|error/i);
  }, 90_000);

  /* RED WHEN: the proof worker stops with an error before it is ready, or its circuit checker (WebAssembly) does not start, so that a check of a bad proof request stops the worker instead of failing as a request. */
  it('starts the proof worker, whose circuit checker answers', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/`, { waitUntil: 'load' });
    const heard = await page.evaluate((url) => new Promise<string[]>((done) => {
      const said: string[] = [];
      const w = new Worker(url, { type: 'module' });
      w.onerror = (e) => { said.push(`error ${e.message}`); done(said); };
      w.onmessage = (e) => {
        const data = e.data as { op?: string; error?: string };
        if (data.op === 'ready') w.postMessage({ op: 'check', preimage: new Uint8Array(8) });
        else if (data.op === 'failure' || data.op === 'result') { said.push(`${data.op} ${data.error ?? ''}`); done(said); }
      };
      setTimeout(() => { said.push('no answer'); done(said); }, 60_000);
    }), entryUrl(ENTRIES[1]!));
    await page.close();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^(failure|result)/);
    expect(heard[0]).not.toMatch(/wbindgen|initiali[sz]ation|undefined|error /i);
  }, 90_000);

  /* RED WHEN: the config prepares a package that carries WebAssembly, or leaves one of the workers' out of the list. */
  it('leaves every package that carries WebAssembly as shipped', () => {
    const left = (config as { optimizeDeps?: { exclude?: string[] } }).optimizeDeps?.exclude ?? [];
    expect([...left].sort()).toEqual([...WASM_PACKAGES].sort());
    for (const name of WASM_PACKAGES) expect(readdirOf(`${REPO}/node_modules/${name}`).some((f) => f.endsWith('.wasm'))).toBe(true);
  });
});

const readdirOf = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
