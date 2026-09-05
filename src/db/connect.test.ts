/**
 * Reading `.env`, and never printing a password.
 *
 * Both halves are small enough to look obviously right and are load-bearing in
 * a way that fails silently:
 *
 *   - the parser decides WHICH DATABASE gets migrated, and
 *   - `redact` is the only thing between a Neon password and a report file
 *     that gets pasted into a chat window.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile, redact, describeDb, sameDatabase } from './connect.js';

const NEON =
  'postgres://neondb_owner:npg_A_REAL_LOOKING_SECRET@ep-cool-frost-a1b2c3.eu-central-1.aws.neon.tech/neondb?sslmode=require';  // not-a-secret: a made-up example, kept so the scanner is strict by default

const write = (body: string) => {
  const p = join(mkdtempSync(join(tmpdir(), 'env-')), '.env');
  writeFileSync(p, body);
  return p;
};

const touched: string[] = [];
const set = (k: string, v: string | undefined) => {
  touched.push(k);
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
};
afterEach(() => { for (const k of touched) delete process.env[k]; touched.length = 0; });

describe('reading .env', () => {
  it('reads a plain assignment, and strips quotes', () => {
    set('T_PLAIN', undefined); set('T_DQ', undefined); set('T_SQ', undefined);
    loadEnvFile(write('T_PLAIN=one\nT_DQ="two"\nT_SQ=\'three\'\n'));
    expect(process.env.T_PLAIN).toBe('one');
    expect(process.env.T_DQ).toBe('two');
    expect(process.env.T_SQ).toBe('three');
  });

  it('keeps everything after the FIRST equals sign', () => {
    // A connection string is full of `=`. Splitting on all of them truncates
    // it to `postgres://...?sslmode`, which fails to connect for a reason that
    // looks like a network problem.
    set('T_URL', undefined);
    loadEnvFile(write(`T_URL=${NEON}\n`));
    expect(process.env.T_URL).toBe(NEON);
  });

  it('skips comments and blank lines rather than making variables out of them', () => {
    set('T_REAL', undefined);
    loadEnvFile(write('# DATABASE_URL=postgres://commented/out\n\n   \nT_REAL=yes\n'));
    expect(process.env.T_REAL).toBe('yes');
    expect(process.env['# DATABASE_URL']).toBeUndefined();
  });

  it('THE ONE THAT DECIDES WHICH DATABASE: the real environment beats the file', () => {
    // `TEST_DATABASE_URL=... ./DB.command` has to do what it looks like. If the
    // file won, a one-off override would silently go to the database in .env.
    set('T_WHO', 'from-the-environment');
    loadEnvFile(write('T_WHO=from-the-file\n'));
    expect(process.env.T_WHO).toBe('from-the-environment');
  });

  it('does nothing at all when there is no .env', () => {
    expect(() => loadEnvFile(join(tmpdir(), 'definitely-not-here', '.env'))).not.toThrow();
  });
});

describe('never printing a password', () => {
  it('THE ONE THAT KEEPS A NEON PASSWORD OUT OF A REPORT: redact removes it', () => {
    /*
     * Every report this project writes gets read, pasted and kept. A connection
     * string in one is a credential in a text file, and the whole database is
     * behind it.
     */
    const out = redact(NEON);
    expect(out).not.toContain('npg_A_REAL_LOOKING_SECRET');
    // Still recognisable as the right database, or it is useless in a log.
    expect(out).toContain('ep-cool-frost-a1b2c3.eu-central-1.aws.neon.tech');
    expect(out).toContain('neondb');
  });

  it('describeDb is host and database only, with no user and no password', () => {
    const out = describeDb(NEON);
    expect(out).not.toContain('npg_A_REAL_LOOKING_SECRET');
    expect(out).not.toContain('neondb_owner');
    expect(out).toBe('ep-cool-frost-a1b2c3.eu-central-1.aws.neon.tech/neondb');
  });

  it('a string it cannot parse is not passed through in the hope that it is safe', () => {
    // The failure mode to avoid is "unparseable, so print it raw" — which is
    // exactly when it is most likely to be a malformed string with a password in it.
    const junk = 'postgres//user:hunter2@host/db';
    expect(redact(junk)).not.toContain('hunter2');
    expect(describeDb(junk)).not.toContain('hunter2');
  });
});

describe('the guard between the tests and live data', () => {
  /*
   * The suite TRUNCATEs. If this ever returns false for two strings that reach
   * the same database, running the tests deletes every live session.
   */
  const A = 'postgres://owner:pw@ep-cool-frost.neon.tech/neondb?sslmode=require';  // not-a-secret: a made-up example, kept so the scanner is strict by default

  it('the same string is the same database', () => {
    expect(sameDatabase(A, A)).toBe(true);
  });

  it('THE ONE STRING EQUALITY WOULD MISS: same database, different spelling', () => {
    for (const other of [
      'postgres://owner:pw@ep-cool-frost.neon.tech/neondb',              // no sslmode  // not-a-secret: a made-up example, kept so the scanner is strict by default
      'postgres://owner:pw@ep-cool-frost.neon.tech/neondb/',             // trailing slash  // not-a-secret: a made-up example, kept so the scanner is strict by default
      'postgres://someone_else:other@ep-cool-frost.neon.tech/neondb',    // different user  // not-a-secret: a made-up example, kept so the scanner is strict by default
      '  postgres://owner:pw@ep-cool-frost.neon.tech/neondb?sslmode=require  ', // whitespace  // not-a-secret: a made-up example, kept so the scanner is strict by default
      'postgres://owner:pw@EP-COOL-FROST.neon.tech/neondb',              // case  // not-a-secret: a made-up example, kept so the scanner is strict by default
      'postgres://owner:pw@ep-cool-frost.neon.tech/neondb?connect_timeout=10',  // not-a-secret: a made-up example, kept so the scanner is strict by default
    ]) {
      expect(sameDatabase(A, other), other).toBe(true);
    }
  });

  it('a real Neon branch is a different database and is allowed', () => {
    // Branches differ in the HOST, which is the whole point of using one.
    expect(sameDatabase(A, 'postgres://owner:pw@ep-shy-dawn.neon.tech/neondb?sslmode=require'))  // not-a-secret: a made-up example, kept so the scanner is strict by default
      .toBe(false);
    // And so is a different database name on the same host.
    expect(sameDatabase(A, 'postgres://owner:pw@ep-cool-frost.neon.tech/neondb_test'))  // not-a-secret: a made-up example, kept so the scanner is strict by default
      .toBe(false);
  });

  it('when it cannot tell, it says they are the same and stops the run', () => {
    expect(sameDatabase('not a url', 'also not a url')).toBe(true);
    expect(sameDatabase(A, 'nonsense')).toBe(true);
  });
});
