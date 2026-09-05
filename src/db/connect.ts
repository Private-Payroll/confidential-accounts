/**
 * Reading `.env`, and opening a connection.
 *
 * Deliberately no dotenv dependency: this parses the handful of lines we
 * actually use, and a `.command` file that fails because a dependency was not
 * installed is a round trip nobody needed.
 *
 * **`.env` is gitignored and `DATABASE_URL` contains a password.** Nothing here
 * prints it, and nothing should. `redact()` below is what goes in a log.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fills `process.env` from a `.env` file. Real environment always wins. */
export function loadEnvFile(path = join(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Something already set on the command line beats the file, so
    // `TEST_DATABASE_URL=... ./DB.command` does what it looks like.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * A connection string with the password removed, safe to print.
 *
 * Every report this project writes ends up pasted somewhere, and a Neon URL
 * carries a password that grants everything. It is easier to make the safe
 * thing the only convenient thing than to remember each time.
 */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

/** Host and database only — enough to tell two Neon branches apart in a log. */
export function describeDb(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/**
 * Are these two connection strings the same database?
 *
 * **This is the guard between the test suite and live data.** The tests
 * TRUNCATE tables; pointed at the real database they delete every session and
 * every rate-limit bucket.
 *
 * Compared after PARSING, not as raw strings. The same database reached by two
 * spellings — a trailing slash, a different `sslmode`, a different user, a
 * stray space — is still the same database, and string equality waves every one
 * of those through. That is precisely how somebody truncates production while
 * looking at a guard that passed.
 *
 * Unparseable input is treated as "the same" rather than "different": if we
 * cannot tell, the answer that stops the run is the safe one.
 */
export function sameDatabase(a: string, b: string): boolean {
  const norm = (u: string) => {
    const p = new URL(u.trim());
    return `${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, '')}`;
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return true;
  }
}
