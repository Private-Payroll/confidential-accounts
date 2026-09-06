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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'mn-start-'));
  if (envFile !== null) writeFileSync(join(dir, '.env'), envFile);

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
});
