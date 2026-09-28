/**
 * **A SERVER TEST SEES ONLY WHAT ITS OWN FILE NAMED, AND ONLY ITS OWN SERVER
 * ANSWERS IT.**
 *
 * `server-under-test.ts` carries the argument. This file holds it two ways:
 *
 * - **§1, live.** Before settling, it puts a stray origin in the environment - as
 *   the shell or a module imported earlier would - and a second one in a `.env`
 *   in the directory the suite is running in - as the working tree's own would.
 *   It then settles on settings that name NO origin and starts the real entry
 *   point. A wallet sign-in must be refused for want of an origin: a server that
 *   issues a challenge at all has read one of the two stray values.
 * - **§2, by reading every test file.** A test server that listens on a port
 *   alone can be answered by another process on macOS, and a test that imports
 *   the entry point itself skips everything §1 holds. Both are refused by name.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOPBACK, importTheServer, useOnlyTheseSettings } from './server-under-test.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/* ------------------------------------------------------------ §1 stray settings */

const FROM_THE_ENVIRONMENT = 'https://stray-in-the-environment.example';
const FROM_A_DOTENV = 'https://stray-in-a-dotenv.example';

const started = process.cwd();
const running = mkdtempSync(join(tmpdir(), 'stray-dotenv-'));
writeFileSync(join(running, '.env'), `APP_ORIGIN=${FROM_A_DOTENV}\n`);
process.env.APP_ORIGIN = FROM_THE_ENVIRONMENT;
process.env.NODE_ENV = 'production';
process.chdir(running);

useOnlyTheseSettings({
  ALLOW_MEMORY_SESSIONS: '1',
  DATABASE_URL: '',
  SERVE: '0',
  DATA_PATH: join(mkdtempSync(join(tmpdir(), 'mn-server-under-test-')), 'db.json'),
});

/* The ledger is a double, as in every file that drives the routes in process. */
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await importTheServer();
const afterImport = process.cwd();
process.chdir(started);

let server: Server;
let base: string;
beforeAll(async () => {
  server = await new Promise<Server>((resolveListening) => {
    const s = app.listen(0, LOOPBACK, () => resolveListening(s));
  });
  const a = server.address() as AddressInfo;
  base = `http://${LOOPBACK}:${a.port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('§1 - the server under test sees only the settings its file named', () => {
  it('A WALLET SIGN-IN IS REFUSED FOR WANT OF AN ORIGIN, THOUGH A STRAY ONE SAT IN THE ENVIRONMENT AND ANOTHER IN A .env', async () => {
    const r = await fetch(`${base}/api/auth/wallet/challenge`, { method: 'POST' });
    const body = await r.json() as { error?: string };
    /* RED WHEN: useOnlyTheseSettings keeps a name it was not given (the stray origin in the environment
     * reaches the server), or importTheServer imports from the directory the suite runs in (the
     * stray .env fills the name in). Either way the challenge is answered 200. */
    expect(r.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toMatch(/APP_ORIGIN must be the origin this deployment is served from, and it is not set\./u);
    expect(JSON.stringify(body)).not.toContain('stray');
  });

  it('AND A SHELL THAT SAYS production DOES NOT CHANGE WHAT THE ROUTES DO', () => {
    /* RED WHEN: useOnlyTheseSettings takes NODE_ENV from the environment it was started in, which the
     * web framework under the routes reads when the app is made. */
    expect(app.get('env')).toBe('test');
  });

  it('AND THE WORKING DIRECTORY IS PUT BACK AFTER THE IMPORT', () => {
    /* RED WHEN: importTheServer leaves the process in the empty directory it imported from. Both
     * sides resolved, because a temporary directory is reached through a link on macOS. */
    expect(realpathSync(afterImport)).toBe(realpathSync(running));
  });

  it('AN IMPORT BEFORE THE SETTINGS ARE SETTLED IS REFUSED, BY NAME', async () => {
    vi.resetModules();
    const fresh = await import('./server-under-test.js');
    /* RED WHEN: importTheServer stops refusing to run before useOnlyTheseSettings. */
    await expect(fresh.importTheServer()).rejects.toThrow(/imported before its settings were/u);
  });

  it('THE ADDRESS THE TEST DIALS IS ONE NO OTHER LISTENER CAN TAKE WHILE THE TEST HOLDS IT', async () => {
    const { address, port } = server.address() as AddressInfo;
    expect(address).toBe(LOOPBACK);
    const second = createServer();
    const outcome = await new Promise<string>((done) => {
      second.once('error', (e: NodeJS.ErrnoException) => done(String(e.code)));
      second.listen(port, LOOPBACK, () => { second.close(); done('listening'); });
    });
    /* RED WHEN: this file's server stops listening on LOOPBACK (the first assertion), or, on macOS
     * only, listens on every address, where a second listener can then take 127.0.0.1 and every
     * request the test makes. On Linux every-address is exclusive, so there the second assertion
     * stays green either way and the first one, with the walk in §2, carries it. */
    expect(outcome).toBe('EADDRINUSE');
  });

  const VERIFIER = join(REPO, 'contracts', 'managed-vault', 'keys', 'deposit.verifier');
  it('AND WHAT THE CHECKOUT HAS BUILT IS SERVED AS IT WOULD BE WITHOUT THIS HELPER: A COMPILED VERIFIER KEY, BYTE FOR BYTE', async () => {
    const r = await fetch(`${base}/artefacts/vault/keys/deposit.verifier`);
    const served = Buffer.from(await r.arrayBuffer());
    /* RED WHEN, in a checkout that has built the vault's keys: importTheServer imports from a
     * directory without links to the compiled contracts, so the routes that serve them look in an
     * empty folder for the life of the test and answer 404. A checkout without them answers 404
     * with or without this helper, and that is what is asked of it. */
    if (existsSync(VERIFIER)) {
      expect(r.status).toBe(200);
      expect(served.equals(readFileSync(VERIFIER))).toBe(true);
    } else {
      expect(r.status).toBe(404);
    }
  });
});

/* ------------------------------------------------------------ §2 walked */

/*
 * Every test file the suite's globs can collect, and every helper under a
 * `testing` folder, since a helper that serves or imports on a test's behalf
 * is where the next one would hide.
 */
const TREES = [
  'src', 'scripts', join('contracts', 'test'), join('packages', 'identity', 'src'), join('packages', 'web-shared', 'src'),
  join('apps', 'wallet'),
];
const SKIP = new Set(['node_modules', 'dist', 'public', 'managed', 'managed-vault']);
const scanned = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.test\.tsx?$/u.test(name) || (p.includes(`${sep}testing${sep}`) && /\.tsx?$/u.test(name))) out.push(p);
    }
  };
  for (const t of TREES) {
    const root = join(REPO, t);
    if (existsSync(root)) walk(root);
  }
  return out;
};

/*
 * A call to `listen`, spelled as a method or looked up by name - not one quoted
 * inside a string - and the text that follows it up to the callback. Whatever
 * the arguments are, that text must name the loopback address.
 */
const LISTEN = /(?<!['"`][\w.]*)(?:\.listen|\[['"]listen['"]\])\(/gu;
const argumentsOf = (text: string, from: number): string => {
  const rest = text.slice(from, from + 200);
  const end = rest.search(/=>|\bfunction\b|;/u);
  return end === -1 ? rest : rest.slice(0, end);
};
const HELPER = join(REPO, 'src', 'testing', 'server-under-test.ts');
const ENTRY = join(REPO, 'src', 'server', 'index.ts');
/* Every way a module names another: `from`, a bare import, a dynamic import, and the runner's own. */
const SPECIFIERS = [
  /\bfrom\s+['"]([^'"]+)['"]/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/gu,
  /\bimportActual(?:<[^>]*>)?\(\s*['"`]([^'"`$]+)['"`]/gu,
];
const isTheEntry = (file: string, spec: string): boolean => {
  if (!spec.startsWith('.')) return false;
  const target = resolve(dirname(file), spec);
  return [target, target.replace(/\.js$/u, '.ts'), `${target}.ts`, join(target, 'index.ts')].includes(ENTRY);
};

describe('§2 - every test file and test helper, read', () => {
  const files = scanned();

  it('EVERY TEST THAT SERVES OVER HTTP LISTENS ON THE ADDRESS IT DIALS, NEVER ON A PORT ALONE', () => {
    const offenders: string[] = [];
    const serving = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(LISTEN)) {
        serving.add(f);
        const args = argumentsOf(text, (m.index ?? 0) + m[0].length);
        if (!args.includes(`'${LOOPBACK}'`) && !/\bLOOPBACK\b/u.test(args)) {
          offenders.push(`${relative(REPO, f)}:${text.slice(0, m.index).split('\n').length} serves with (${args.trim()}`);
        }
      }
    }
    /* RED WHEN: a test file or test helper serves with a port alone, with no arguments, or with any
     * other call whose arguments do not name the loopback address. */
    expect(offenders, 'a test server listening on every address can be answered by another process').toEqual([]);
    /* RED WHEN: the walk stops finding the servers it is about - every file that starts the entry
     * point in process serves it, so each must be among the files seen serving. */
    const startsTheEntry = files.filter((f) => f !== HELPER && /\bimportTheServer\(\)/u.test(readFileSync(f, 'utf8')));
    expect(startsTheEntry.length).toBeGreaterThan(0);
    for (const f of startsTheEntry) expect([...serving], relative(REPO, f)).toContain(f);
  });

  it('NO TEST IMPORTS THE ENTRY POINT ITSELF: IT GOES THROUGH importTheServer, WHICH SETTLES FIRST', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f === HELPER) continue;
      const text = readFileSync(f, 'utf8');
      for (const re of SPECIFIERS) {
        for (const m of text.matchAll(re)) {
          if (isTheEntry(f, m[1])) offenders.push(`${relative(REPO, f)}: ${m[1]}`);
        }
      }
    }
    /* RED WHEN: a test file imports the entry point directly - by `from`, for its side effects,
     * dynamically, through the runner, with or without an extension, or by its folder - so its
     * settings are whatever the environment and the working tree's .env held when it did. */
    expect(offenders).toEqual([]);
  });
});
