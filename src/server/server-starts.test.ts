/**
 * **STARTING THE SERVER IS NOW SOMETHING THE SUITE DOES.**
 *
 * ── THE DEFECT THIS FILE EXISTS FOR ──────────────────────────────────────
 *
 * `npm run dev` runs `src/server/index.ts`, `DATABASE_URL` lives in `.env`, and
 * that file never opened `.env`. So the payroll app could not be started at all
 * on a correctly configured machine — it printed *DATABASE_URL is not set* and
 * exited — **while every test in this project passed**, because every test
 * imports the module and hands it an environment by hand. Nothing had ever
 * STARTED it.
 *
 * That is the second defect in two rounds that only appeared when somebody ran
 * the thing rather than testing it, so the answer is this file: it spawns the
 * real entry point as a real process, with a real `.env` beside it, and reads
 * what it prints.
 *
 * ── WHY IT SPAWNS RATHER THAN IMPORTS ────────────────────────────────────
 *
 * `loadEnvFile` reads `join(process.cwd(), '.env')`. Under vitest the working
 * directory is this repository, whose `.env` is the developer's own and holds a
 * live connection string. A test that imported the module would therefore both
 * read a file it must not read and prove nothing about the case that broke —
 * which is a PROCESS, started in a directory, finding a file. So each case gets
 * a temporary directory, a `.env` written into it, and an environment built
 * from scratch rather than inherited.
 *
 * ── WHAT IT ASSERTS ──────────────────────────────────────────────────────
 *
 * The boot banner, not a database connection. `postgres()` does not dial until
 * somebody queries, so a well-formed connection string pointing nowhere is
 * enough to prove the server got past the refusal and listened — and it keeps
 * this file free of any database at all, live or test.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deploymentRecordPath } from '../wiring/deployment.js';
import { theNetwork } from '../midnight/network.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const ENTRY = join(REPO, 'src', 'server', 'index.ts');

/**
 * A connection string that is well formed and reaches nothing.
 *
 * Deliberately a closed port on loopback. If anything in this file ever starts
 * actually connecting, it fails here rather than somewhere real.
 */
const NOWHERE = 'postgres://u:p@127.0.0.1:1/nowhere';  // not-a-secret: a port nothing listens on

/**
 * **THE NETWORK THIS PAIR IS COMPILED FOR, READ RATHER THAN SPELLED OUT.**
 * The record's filename carries it, and a literal here would be a second place
 * that says which chain this deployment is on.
 */
const NETWORK = theNetwork({});

/** A proof server address that is well formed and reaches nothing, like `NOWHERE`. */
const NO_PROVER = 'http://127.0.0.1:1';  // not-a-secret: a port nothing listens on

/**
 * **EVERY CASE THAT EXPECTS THE SERVER TO LISTEN NOW HAS TO GIVE IT A
 * DEPLOYMENT, AND THAT IS THE CHANGE THIS FILE RECORDS.**
 *
 * The product runs against a chain. It has four facts with no defaults, and a
 * process started without them refuses rather than serving - which is the case
 * at the foot of this file. So the cases ABOVE it, which are about `.env`
 * parsing and about sessions, have to supply those facts or they would all be
 * measuring the new refusal instead of the thing they were written for.
 *
 * **NOTHING HERE IS DIALLED.** The ledger's providers are built on first use,
 * so a deployment that cannot reach its indexer, node or proof server still
 * starts and says so when something is asked of it. Both addresses point at a
 * closed port on loopback for the same reason `NOWHERE` does: if anything in
 * this file ever starts actually connecting, it fails here rather than
 * somewhere real.
 */
function withADeployment(dir: string): void {
  mkdirSync(join(dir, '.midnight'), { recursive: true });
  writeFileSync(
    deploymentRecordPath(dir, NETWORK),
    JSON.stringify({ network: NETWORK, contractAddress: '0200aabb' }),
  );
}

/** The line the server prints once it is listening. */
const LISTENING = 'api        http://localhost:';

type Started = { out: string; code: number | null; listened: boolean };

/**
 * Starts the entry point in its own directory and returns what it printed.
 *
 * It stops at the first of: the listening banner, the process exiting, or the
 * deadline. A server that starts never exits on its own, so waiting for exit
 * would hang the suite — and killing it blind would make "it started" and "it
 * died silently" the same observation.
 */
async function start(
  envFile: string | null,
  overrides: Record<string, string | undefined>,
  deployment: 'configured' | 'none' = 'configured',
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'mn-start-'));
  if (envFile !== null) writeFileSync(join(dir, '.env'), envFile);
  if (deployment === 'configured') withADeployment(dir);

  /*
   * BUILT, NOT INHERITED. Whatever ran this may itself have a `DATABASE_URL`,
   * and a case about a name being absent is worthless if the name arrives from
   * the outside.
   */
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'development',
    PORT: '0',                                   // ephemeral: never seizes 8787
    DATA_PATH: join(dir, 'db.json'),
  };
  if (deployment === 'configured') env.MIDNIGHT_PROVER_URL = NO_PROVER;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }

  const child = spawn(TSX, [ENTRY], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

  return await new Promise<Started>(resolveStarted => {
    let out = '';
    let done = false;
    const finish = (code: number | null, listened: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolveStarted({ out, code, listened });
    };
    const read = (b: Buffer) => {
      out += b.toString();
      if (out.includes(LISTENING)) finish(null, true);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', code => finish(code, out.includes(LISTENING)));
    const timer = setTimeout(() => finish(null, out.includes(LISTENING)), 25_000);
  });
}

describe('starting the payroll server', () => {
  it('THE ONE THAT WOULD HAVE CAUGHT IT: DATABASE_URL only in .env, and the server starts', async () => {
    const r = await start(`DATABASE_URL=${NOWHERE}\n`, { DATABASE_URL: undefined });
    expect(r.out).not.toContain('DATABASE_URL is not set');
    expect(r.listened, r.out).toBe(true);
  });

  it('says so plainly when there is no .env and nothing in the environment', async () => {
    // The other half of the same claim. Without this, the case above could pass
    // for a reason that has nothing to do with reading a file.
    const r = await start(null, { DATABASE_URL: undefined });
    expect(r.out).toContain('DATABASE_URL is not set');
    expect(r.listened).toBe(false);
    expect(r.code).toBe(1);
  });

  it('THE ONE npm run dev DEPENDS ON: the command line beats the file, at a real boot', async () => {
    /*
     * `npm run dev` sets `ALLOW_SIMULATED_COMPANY_ADDRESS=1` and
     * `VITE_ALLOW_LOCALHOST_ORIGIN=1` on the command line, and those two are the
     * whole of this deployment's development posture. A `.env` that could
     * overwrite them would turn the app a person started into a different app
     * from the one they asked for — silently, since nothing downstream would
     * object. The parser is held to this in `connect.test.ts`; this is the same
     * claim about a process that actually booted.
     */
    const r = await start(
      `DATABASE_URL=${NOWHERE}\nALLOW_SIMULATED_COMPANY_ADDRESS=0\n`,
      { DATABASE_URL: undefined, ALLOW_SIMULATED_COMPANY_ADDRESS: '1' },
    );
    expect(r.listened, r.out).toBe(true);
    expect(r.out).toContain('ALLOW_SIMULATED_COMPANY_ADDRESS=1');
  });

  it('and the file is still read for a name the command line did not set', async () => {
    const r = await start(
      `DATABASE_URL=${NOWHERE}\nALLOW_SIMULATED_COMPANY_ADDRESS=1\n`,
      { DATABASE_URL: undefined, ALLOW_SIMULATED_COMPANY_ADDRESS: undefined },
    );
    expect(r.listened, r.out).toBe(true);
    expect(r.out).toContain('ALLOW_SIMULATED_COMPANY_ADDRESS=1');
  });

  it('THE ONE THAT KEEPS A TEST RUN OFF A LIVE DATABASE: both answers at once is refused', async () => {
    /*
     * `X2`, and it is the guard that makes reading `.env` safe.
     *
     * Before this round the server never read `.env`, so a test file could say
     * `ALLOW_MEMORY_SESSIONS=1` and be certain of getting memory. Now the file
     * is read, and a developer's `.env` holds the LIVE connection string — so
     * the same test file would have opened the real database and written
     * sessions into it, with nothing printed and nothing failing. The three
     * test files that import the server each say `DATABASE_URL=''` for exactly
     * this reason; a FOURTH one, written later by somebody who did not know,
     * gets this refusal instead of a live connection.
     */
    const r = await start(`DATABASE_URL=${NOWHERE}\n`, {
      DATABASE_URL: undefined, ALLOW_MEMORY_SESSIONS: '1',
    });
    expect(r.listened).toBe(false);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ALLOW_MEMORY_SESSIONS=1 and a DATABASE_URL');
  });

  /**
   * **THE CASE THIS FILE EXISTS FOR: A PROCESS STARTED WITH NO DEPLOYMENT.**
   *
   * The product runs against a chain and has no other mode. A deployment that
   * has not been told which contract it is talking to must not answer questions
   * about accounts, balances or rounds - and the three ways of getting that
   * wrong are all visible from outside the process, which is why this case
   * reads what it printed and what it exited with rather than importing
   * anything.
   *
   * **IT MUST NOT PRINT A STACK.** Somebody configuring a deployment is not
   * being asked to read this program's internals.
   *
   * **IT MUST NOT LISTEN.** A process that came up and refused every request
   * reads to whoever pointed a browser at it as a broken product, and to
   * whoever deployed it as a working one. Those are the two readings that cost
   * money.
   *
   * **AND IT MUST NOT FALL BACK.** There is nothing to fall back to: the
   * simulated set is a test double and no module the product runs reaches it.
   * The assertion on the word is the cheap end of the check that walks the tree
   * for the same thing.
   */
  it('THE CASE THIS FILE EXISTS FOR: no deployment, so it says what is missing and exits', async () => {
    const r = await start(`DATABASE_URL=${NOWHERE}\n`, { DATABASE_URL: undefined }, 'none');

    expect(r.listened, r.out).toBe(false);
    expect(r.code).toBe(1);

    /* What is wrong, and where it looked. */
    expect(r.out).toContain('cannot start');
    expect(r.out).toContain('nothing has been served');
    expect(r.out).toContain(`${NETWORK}-contract.json`);

    /* No stack, and no internals. */
    expect(r.out).not.toMatch(/\n\s+at /);
    expect(r.out).not.toContain('node_modules');

    /* And no quiet fallback to the rehearsal that used to be here. */
    expect(r.out.toLowerCase()).not.toContain('simulated');
  });

  /**
   * **THE POSITIVE CONTROL FOR THE CASE ABOVE, AND IT IS NOT DECORATION.**
   *
   * Without it, "refuses when there is no deployment" would also be true of a
   * server that refuses to start under every condition - which is what a
   * mis-wired guard looks like, and every other case in this file supplies a
   * deployment through a helper rather than by hand, so none of them would say
   * so. This one changes exactly one thing: the record and the prover.
   */
  it('and the same start with the deployment in place does listen', async () => {
    const r = await start(`DATABASE_URL=${NOWHERE}\n`, { DATABASE_URL: undefined }, 'configured');
    expect(r.listened, r.out).toBe(true);
    expect(r.out).not.toContain('cannot start');
  });

  /**
   * **A RECORD IS NOT ENOUGH, AND THE REFUSAL HAS TO MOVE ON RATHER THAN
   * REPEATING THE PROBLEM THAT WAS JUST FIXED.**
   *
   * The proof server is required with no default because a deployment that
   * guesses one comes up looking healthy and fails at the first round somebody
   * raises - after the money question has already been asked. This is the case
   * that catches a refusal wired to the first missing fact only.
   */
  it('a deployment record without a proof server is still refused, by name', async () => {
    const r = await start(
      `DATABASE_URL=${NOWHERE}\n`,
      { DATABASE_URL: undefined, MIDNIGHT_PROVER_URL: undefined },
      'configured',
    );
    expect(r.listened, r.out).toBe(false);
    expect(r.code).toBe(1);
    expect(r.out).toContain('proof server');
    expect(r.out,
      'the refusal is still talking about the deployment record, which is present')
      .not.toContain('nothing for the product to talk to');
  });
});
