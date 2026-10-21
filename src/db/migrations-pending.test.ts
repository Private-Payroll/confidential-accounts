/**
 * The check that keeps the service from starting on a database that is behind its migrations. The database is a
 * stand-in that answers the one read the check makes; nothing here connects to a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refuseWhileMigrationsPending, pendingMigrations, readMigrations, DATABASE_WAKE } from './migrate.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-'));
  for (const f of ['0001_first.sql', '0002_second.sql', '0003_third.sql']) writeFileSync(join(dir, f), `-- ${f}`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const databaseRecording = (versions: string[] | 'never-migrated' | Error): any => {
  const sql: any = async (strings: TemplateStringsArray) => {
    expect(strings.join('')).toContain('FROM schema_migrations');
    if (versions instanceof Error) throw versions;
    if (versions === 'never-migrated') throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    return versions.map(v => ({ version: v, name: `${v}_x.sql`, checksum: 'c' }));
  };
  return sql;
};

describe('the service does not start on a database that is behind its migrations', () => {
  /*
   * RED WHEN: a service starts on a database missing a migration, and the first record it files fails.
   */
  it('refuses and names every migration the database has not recorded', async () => {
    const said = await refuseWhileMigrationsPending(databaseRecording(['0001']), dir);
    expect(said).toContain('OUT OF DATE');
    expect(said).toContain('0002_second.sql');
    expect(said).toContain('0003_third.sql');
    expect(said).not.toContain('0001_first.sql');
    expect(said).toContain('Run the database setup first');
  });

  /*
   * RED WHEN: a database with every migration recorded is refused, and nobody can start the service.
   */
  it('proceeds when every migration is recorded', async () => {
    expect(await refuseWhileMigrationsPending(databaseRecording(['0001', '0002', '0003']), dir)).toBeNull();
  });

  /*
   * RED WHEN: a database that was never migrated is let through as if it were current.
   */
  it('refuses a database that was never migrated, naming all of them', async () => {
    const said = await refuseWhileMigrationsPending(databaseRecording('never-migrated'), dir);
    for (const f of ['0001_first.sql', '0002_second.sql', '0003_third.sql']) expect(said).toContain(f);
  });

  /** A wake that never waits, recording each pause it was asked for. */
  const wakeRecording = (tries = 3) => {
    const paused: number[] = [];
    return { paused, wake: { tries, pauseMs: 10_000, sleep: async (ms: number) => { paused.push(ms); } } };
  };

  /*
   * RED WHEN: a database that does not answer is treated as current and the service starts blind.
   * RED WHEN: a database that does not answer is asked once only, so a sleeping database stops every start.
   * RED WHEN: a database that does not answer sends the person to run the database setup again.
   */
  it('asks a database that does not answer three times, then says it did not answer and to start again', async () => {
    const { paused, wake } = wakeRecording();
    let asked = 0;
    const silent: any = async () => { asked += 1; throw new Error('connection refused'); };
    const said = await refuseWhileMigrationsPending(silent, dir, wake);
    expect(asked).toBe(3);
    expect(paused).toEqual([10_000, 10_000]);
    expect(said).toContain('THE DATABASE DID NOT ANSWER');
    expect(said).toContain('connection refused');
    expect(said).toContain('start again in a minute');
    expect(said).toContain('DATABASE_URL');
    expect(said).not.toContain('database setup');
  });

  /*
   * RED WHEN: a start as shipped asks a database that does not answer fewer than three times, or not ten seconds apart.
   */
  it('as shipped, asks three times, ten seconds apart', async () => {
    expect(DATABASE_WAKE).toMatchObject({ tries: 3, pauseMs: 10_000 });
    const paused: number[] = [];
    let asked = 0;
    const silent: any = async () => { asked += 1; throw new Error('connection refused'); };
    await refuseWhileMigrationsPending(silent, dir, { ...DATABASE_WAKE, sleep: async (ms: number) => { paused.push(ms); } });
    expect(asked).toBe(3);
    expect(paused).toEqual([10_000, 10_000]);
  });

  /*
   * RED WHEN: a database that wakes on the second ask still stops the start.
   */
  it('starts on a database that answers on the second ask and is current', async () => {
    const { wake } = wakeRecording();
    let asked = 0;
    const waking: any = async (strings: TemplateStringsArray) => {
      asked += 1;
      if (asked === 1) throw new Error('connect timeout');
      return databaseRecording(['0001', '0002', '0003'])(strings);
    };
    expect(await refuseWhileMigrationsPending(waking, dir, wake)).toBeNull();
    expect(asked).toBe(2);
  });

  /*
   * RED WHEN: a database that answered with its own error is asked again, or is reported as not answering.
   */
  it('does not ask again when the database answered with an error of its own, and sends the person to the setup', async () => {
    const { paused, wake } = wakeRecording();
    const refusing: any = async () => { throw Object.assign(new Error('permission denied for table schema_migrations'), { code: '42501' }); };
    const said = await refuseWhileMigrationsPending(refusing, dir, wake);
    expect(paused).toEqual([]);
    expect(said).toContain('COULD NOT BE CHECKED');
    expect(said).toContain('permission denied');
    expect(said).toContain('the database setup');
  });

  /*
   * RED WHEN: the check lists migrations by its own idea of the files, so it disagrees with what the runner applies.
   */
  it('lists the same files the runner would apply, in its order', async () => {
    const pending = await pendingMigrations(databaseRecording([]), dir);
    expect(pending.map(m => m.name)).toEqual(readMigrations(dir).map(m => m.name));
  });
});
