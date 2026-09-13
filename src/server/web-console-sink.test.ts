/**
 * **THE TEST THAT WALKS THE SINK'S OWN REPORT.**
 *
 * ── THE ROW, AND WHY THIS FILE IS THE DELIVERABLE ────────────────────────
 *
 * `C145` closes on one sentence: *"nothing this project keeps on disk ever
 * contains a seed, proved by a test that greps its own logs."* The redaction is
 * not the deliverable — **this is**, because redaction that nothing greps is
 * redaction that can be removed by a refactor nobody notices.
 *
 * So this file does the whole journey: it starts the real service as a real
 * process, posts through the real route the things an error message actually
 * carries — a seed phrase, the SDK's own seed line, a key, a bearer token, a
 * password typed into the wrong field, an address — and then **opens the file
 * that came out and searches it**, both for the exact secrets it planted and
 * for anything merely SHAPED like one.
 *
 * ── WHY IT SPAWNS RATHER THAN IMPORTS ────────────────────────────────────
 *
 * Same reason as `server-starts.test.ts`, and one more. The route only exists
 * when `ALLOW_WEB_CONSOLE_SINK=1`, which is read at import time — so a test
 * that imported the module could never check the case where the route is
 * ABSENT, which is the case a deployment depends on. And `loadEnvFile` reads
 * the working directory's `.env`, which here holds a live connection string.
 * Each case therefore gets its own directory, its own `.env`, and an
 * environment built from scratch.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deploymentRecordPath } from '../wiring/deployment.js';
import { theNetwork } from '../midnight/network.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const ENTRY = join(REPO, 'src', 'server', 'index.ts');
const NOWHERE = 'postgres://u:p@127.0.0.1:1/nowhere';  // not-a-secret: a port nothing listens on

/* ------------------------------------------------------------------ planted */

/**
 * WHAT AN ERROR MESSAGE ACTUALLY CARRIES.
 *
 * Every one of these is a real shape from this project: the seed line is quoted
 * verbatim in `C145`, the address is the funded deploy wallet's from the same
 * run, and the rest are what a page hands to `console.error` when a request
 * fails with the body attached.
 */
const PLANTED = {
  seedHex: '39aebaeb0a2f4c1d8e7b6a5940312233445566778899aabbccddeeff00112233',
  phrase: 'abandon ability able about above absent absorb abstract absurd abuse '
    + 'access accident account accuse achieve acid',
  address: 'mn_addr_stagenet1ku4g25nwe6reyqqpqxk9lz7ryd0d7lz9wq2mm4ku8x0k',
  bearer: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJrYyJ9.Zm9vYmFyYmF6cXV1eGZvb2Jhcg',
  password: 'correct-horse-battery-staple',
  authKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

/** What the page would post, with each of the above buried in it somewhere. */
const HOSTILE = [
  { level: 'console.error', message: `INFO (18260): Your wallet seed is: ${PLANTED.seedHex}` },
  { level: 'error', message: `restore failed for: ${PLANTED.phrase}` },
  { level: 'rejection', message: `no funds at ${PLANTED.address}` },
  { level: 'fetch', message: `401 /api/me — Authorization: Bearer ${PLANTED.bearer}` },
  {
    level: 'console.error',
    message: `sign-in rejected {"email":"a@b.c","password":"${PLANTED.password}"}`,
  },
  {
    level: 'error',
    message: 'PUT /api/me/keys failed',
    stack: `Error: stale\n    at seal (/src/web/keyring.ts:434:9)\n    authKey=${PLANTED.authKey}`,
  },
];

/* ------------------------------------------------- an independent detector */

/**
 * **WRITTEN HERE AND NOT IMPORTED, DELIBERATELY.**
 *
 * A test that searched with the redactor's own patterns would pass by
 * construction: break the redactor and the search breaks the same way. These
 * are second, blunter statements of the same shapes, and they are allowed to
 * disagree with the redactor — if they ever do, one of the two is wrong and
 * that is worth a morning.
 */
const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['thirty-two hex characters or more', /[0-9a-fA-F]{32,}/],
  ['twelve or more lowercase words in a row', /(?:\b[a-z]{3,8} ){11,}[a-z]{3,8}\b/],
  ['a Midnight bech32 string', /mn_[a-z0-9_-]*1[a-z0-9]{16,}/i],
  ['a long unbroken token', /[A-Za-z0-9+_=-]{40,}/],
];

/* ------------------------------------------------------------- the process */

const children: ChildProcess[] = [];
afterAll(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

const freePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

type Running = { port: number; report: string; out: string };

/** Starts the service in its own directory and waits for the listening banner. */
const start = async (overrides: Record<string, string>): Promise<Running> => {
  const dir = mkdtempSync(join(tmpdir(), 'mn-sink-'));
  writeFileSync(join(dir, '.env'), `DATABASE_URL=${NOWHERE}\n`);
  /*
   * **THIS FILE STARTS THE REAL ENTRY POINT, SO IT NEEDS A REAL DEPLOYMENT.**
   *
   * It takes no test double and must not: its subject is what a started
   * PROCESS writes to a report on disk, and a process that refuses to start
   * writes nothing. The product runs against a chain and will not come up
   * without a contract address and a proof server, so the directory it is
   * started in carries both.
   *
   * **NOTHING IS DIALLED.** The ledger's providers are built on first use, and
   * the proof server address below is a closed port on loopback for the same
   * reason the connection string is: if anything here ever starts actually
   * connecting, it fails here rather than somewhere real.
   */
  const network = theNetwork({});
  mkdirSync(join(dir, '.midnight'), { recursive: true });
  writeFileSync(
    deploymentRecordPath(dir, network),
    JSON.stringify({ network, contractAddress: '0200aabb' }),
  );
  const port = await freePort();
  const report = join(dir, 'REPORT-WEB-CONSOLE.txt');

  const child = spawn(TSX, [ENTRY], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_PATH: join(dir, 'db.json'),
      WEB_CONSOLE_LOG: report,
      // not-a-secret: a port nothing listens on. Required with no default.
      MIDNIGHT_PROVER_URL: 'http://127.0.0.1:1',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const out = await new Promise<string>((resolve) => {
    let seen = '';
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(seen); } };
    const read = (b: Buffer) => {
      seen += b.toString();
      if (seen.includes(`api        http://localhost:${port}`)) finish();
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', finish);
    const timer = setTimeout(finish, 25_000);
  });

  return { port, report, out };
};

const post = (port: number, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/api/dev/web-console`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/* ------------------------------------------------------------------ the cases */

describe('the report the browser error sink writes', () => {
  it('THE ONE C145 ASKS FOR: it walks its own report and finds no seed, key or token',
    { timeout: 60_000 }, async () => {
      const run = await start({ ALLOW_WEB_CONSOLE_SINK: '1' });
      expect(run.out, run.out).toContain('ALLOW_WEB_CONSOLE_SINK=1');

      const res = await post(run.port, {
        page: `http://localhost:5173/?token=${PLANTED.bearer}`,
        entries: HOSTILE,
      });
      expect(res.status).toBe(204);
      expect(existsSync(run.report), 'the report was never written').toBe(true);

      const written = readFileSync(run.report, 'utf8');

      // 1. Nothing that was planted survived, by name.
      for (const [what, secret] of Object.entries(PLANTED)) {
        expect(written, `the report still contains the planted ${what}`).not.toContain(secret);
      }

      // 2. And nothing merely SHAPED like a secret is in it either — which is
      //    the half that catches a secret nobody thought to plant.
      for (const [what, shape] of SHAPES) {
        const hit = shape.exec(written);
        expect(hit?.[0], `the report contains ${what}: ${hit?.[0]}`).toBeUndefined();
      }
    });

  it('and it still says what the browser said, and which page said it',
    { timeout: 60_000 }, async () => {
      // The other half of the same claim. Without this, the case above passes
      // for a report that is empty, and an empty report is not a redacted one.
      const run = await start({ ALLOW_WEB_CONSOLE_SINK: '1' });
      await post(run.port, {
        page: 'http://localhost:5173/',
        entries: [
          { level: 'console.error', message: 'Warning: Each child in a list needs a key' },
          { level: 'error', message: 'TypeError: t is not a function', stack: 'at App (App.tsx:12:5)' },
        ],
      });
      const written = readFileSync(run.report, 'utf8');
      expect(written).toContain('http://localhost:5173/');
      expect(written).toContain('console.error');
      expect(written).toContain('Warning: Each child in a list needs a key');
      expect(written).toContain('TypeError: t is not a function');
      expect(written).toContain('App.tsx:12:5');
      // A timestamp, in the shape everything else in this project writes.
      expect(written).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

  it('THE ONE THAT KEEPS IT OUT OF A DEPLOYMENT: without the relaxation the route is not there',
    { timeout: 60_000 }, async () => {
      // 404 and not 403, deliberately: a refusal would confirm the route exists.
      const run = await start({});
      expect(run.out, run.out).not.toContain('ALLOW_WEB_CONSOLE_SINK=1');
      const res = await post(run.port, { page: 'http://localhost:5173/', entries: HOSTILE });
      expect(res.status).toBe(404);
      expect(existsSync(run.report), 'a report was written by a service that has no sink')
        .toBe(false);
    });

  it('a post with nothing in it writes nothing at all', { timeout: 60_000 }, async () => {
    const run = await start({ ALLOW_WEB_CONSOLE_SINK: '1' });
    const res = await post(run.port, { page: 'http://localhost:5173/', entries: [] });
    expect(res.status).toBe(204);
    expect(existsSync(run.report)).toBe(false);
  });
});
