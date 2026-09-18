/**
 * **THE REPORT A REFUSAL LEAVES BEHIND.**
 *
 * ── THE ROW, AND WHAT THIS FILE IS FOR ───────────────────────────────────
 *
 * `wrap` answered every thrown error with `400` and kept nothing, so a walk on
 * 24 Aug produced ten `400 GET …/state` and three `400 POST /api/accounts` and
 * **two unrelated failures were the same event in every artefact this project
 * keeps.** This file holds the other end of that: the service refuses over real
 * HTTP, and the reason is on disk afterwards with the KIND of failure beside
 * it.
 *
 * ── AND IT GREPS ITS OWN REPORT, LIKE `C145`'s DOES ──────────────────────
 *
 * The redaction is not the deliverable — **a test that opens the file and
 * searches it is**, because redaction nothing greps is redaction a refactor can
 * remove without anything going red. The deliberate defect here takes
 * `redactSecrets` out of `renderRefusal`, and the case below has to die.
 *
 * ── WHY IT IMPORTS THE APP RATHER THAN SPAWNING ONE ──────────────────────
 *
 * Unlike the web console sink, nothing here is gated on an environment name
 * read at import time — every refusal is logged, on every deployment, which is
 * the whole point of the row. So the case a deployment depends on is the same
 * case this drives, and `two-companies.test.ts`'s shape is enough. The path is
 * overridden per run so a test that greps this report greps one it made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { appendRefusal, renderRefusal, refusalLogPath } from './refusal-log.js';

const DIR = mkdtempSync(join(tmpdir(), 'mn-refusals-'));
const REPORT = join(DIR, 'REPORT-REFUSALS.txt');

process.env.REFUSAL_LOG = REPORT;
process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
/* Empty, not deleted: since `X2` the server reads `.env`, `.env` holds a live
 * connection string, and a deleted name is one `loadEnvFile` puts back. */
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(DIR, 'db.json');

/**
 * **THIS FILE DRIVES THE ROUTES OVER A TEST DOUBLE, NOT OVER A DEPLOYMENT, AND
 * THAT IS SAID HERE SO NOBODY READS THESE CASES AS EVIDENCE ABOUT A CHAIN.**
 *
 * This file is about what a refused request writes to the refusal log. Its cases die in validation above the ledger - but the entry point still resolved a ledger from whatever was on the machine, so what this file ran against was a property of the disk and not of the suite.
 *
 * **THAT IS THE DEFECT THIS BLOCK CLOSES, AND IT IS NOT ABOUT THIS FILE'S OWN
 * CASES.** The entry point resolves a deployment from the working directory and
 * the environment. On a machine with a deployment record and a proof server it
 * therefore built a ledger pointed at a REAL contract, with a sealed-state
 * store rooted in the working tree; in a clone with neither it built one that
 * refuses everything. **Two different subjects, one green result, and nothing
 * saying which ran.** The next case added here would have reached whichever one
 * the machine happened to have.
 *
 * So this file says which one it drives, and hands it over before the entry
 * point is imported. The services, the routes, the sign-in state handling and the
 * checks are the real ones - the LEDGER is a double, named here out loud.
 * Nothing outside a test may do this: the walk beside the selector refuses
 * `handInWiring` in every non-test module.
 *
 * **WHAT THESE CASES PROVE AND WHAT THEY DO NOT.** They prove what they proved
 * before the product selected a chain, and nothing more. **They are not
 * evidence that this server works against a chain.** `server-starts.test.ts` is
 * the file that exercises the real chain wiring, and it is deliberately the one
 * file here that takes no double.
 *
 * The three come from one object because they may never be chosen apart: a leaf
 * computed under one commitment scheme is meaningless to a ledger running under
 * another.
 */
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

/* ------------------------------------------------------------------ planted */

/**
 * WHAT A REFUSAL'S MESSAGE ACTUALLY CARRIES. Every one of these is a real shape
 * from this project, and the phrase is the `C148` shape — one capital letter in
 * it — because this file is the reason that row had to close in this round.
 */
const PLANTED = {
  seedHex: '39aebaeb0a2f4c1d8e7b6a5940312233445566778899aabbccddeeff00112233',
  phrase: 'abandon ability able about above Absent absorb abstract absurd abuse '
    + 'access accident account accuse achieve acid',
  viewingKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  address: 'mn_addr_stagenet1ku4g25nwe6reyqqpqxk9lz7ryd0d7lz9wq2mm4ku8x0k',
};

/**
 * **WRITTEN HERE AND NOT IMPORTED**, for the reason `web-console-sink.test.ts`
 * gives: a search using the redactor's own patterns passes by construction.
 * These are blunter second statements of the same shapes and are allowed to
 * disagree — if they ever do, one of the two is wrong and that is worth a
 * morning. The word rule is case-insensitive HERE TOO, which is `C148`.
 */
const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['thirty-two hex characters or more', /[0-9a-fA-F]{32,}/],
  ['twelve or more short words in a row, in any case', /(?:\b[a-z]{3,8} ){11,}[a-z]{3,8}\b/i],
  ['a Midnight bech32 string', /mn_[a-z0-9_-]*1[a-z0-9]{16,}/i],
];

const read = () => readFileSync(REPORT, 'utf8');

/* ------------------------------------------------------------------- cases */

describe('what the service writes down when it refuses', () => {
  it('THE ONE C157 ASKS FOR: a real refusal, on disk, with its reason and its kind',
    async () => {
      // Unauthenticated and wrapped, so this is `wrap` and nothing else.
      const res = await fetch(`${base}/api/invites/not-a-real-token/offer`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invite not found');

      expect(existsSync(REPORT), 'nothing was written').toBe(true);
      const written = read();
      expect(written).toContain('400 GET');
      expect(written).toContain('/api/invites/not-a-real-token/offer');
      // THE HALF THE ROW IS ABOUT: which failure it was, not merely that one was.
      expect(written).toContain('Error: invite not found');
      expect(written).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

  it('C157: the sentence on disk is the sentence the person was given', async () => {
    // One reason in three places — the screen, this file, and the browser sink
    // — or the artefacts disagree and reading them is guesswork again.
    const res = await fetch(`${base}/api/invites/another-bad-token/offer`);
    const { error } = await res.json() as { error: string };
    expect(read()).toContain(`Error: ${error}`);
  });

  it('C157: it walks its own report and finds no seed, key or token', () => {
    /*
     * A refusal about a key is exactly the kind of message that quotes one, and
     * the path carries a query string, which is where `viewingKey` travels.
     * Both go through the redactor. A defect removes it from the reason.
     */
    appendRefusal(
      'GET', `/api/accounts/a1/state?viewingKey=${PLANTED.viewingKey}`, 400, 'Error',
      `this key does not open a record sealed at that epoch: ${PLANTED.seedHex}`);
    appendRefusal(
      'POST', '/api/auth/wallet', 400, 'WalletSignInError',
      `restore failed for: ${PLANTED.phrase} at ${PLANTED.address}`);

    const written = read();
    for (const [what, secret] of Object.entries(PLANTED)) {
      expect(written, `the report still contains the planted ${what}`).not.toContain(secret);
    }
    for (const [what, shape] of SHAPES) {
      const hit = shape.exec(written);
      expect(hit?.[0], `the report contains ${what}: ${hit?.[0]}`).toBeUndefined();
    }
  });

  it('and it still says which route refused and why, so it is not merely empty', () => {
    // Without this the case above passes for a file with nothing in it, and an
    // empty report is not a redacted one.
    const written = read();
    expect(written).toContain('/api/accounts/a1/state');
    expect(written).toContain('WalletSignInError');
    expect(written).toContain('this key does not open a record sealed at that epoch');
    expect(written).toContain('<redacted');
  });

  it('the format says the status, the method and the kind on one line', () => {
    const line = renderRefusal(
      'post', '/api/accounts', 400, 'ZodError', 'threshold must be a number',
      new Date('2026-08-24T09:00:00.000Z'));
    expect(line).toContain('2026-08-24T09:00:00.000Z  400 POST');
    expect(line).toContain('/api/accounts');
    expect(line).toContain('ZodError: threshold must be a number');
  });

  it('it never throws, whatever the disk is doing', () => {
    const kept = process.env.REFUSAL_LOG;
    // A path whose parent is a file, so the folder cannot be made.
    process.env.REFUSAL_LOG = join(REPORT, 'no', 'REPORT-REFUSALS.txt');
    expect(() => appendRefusal('GET', '/api/health', 400, 'Error', 'nope')).not.toThrow();
    process.env.REFUSAL_LOG = kept;
    expect(refusalLogPath()).toBe(REPORT);
  });
});
