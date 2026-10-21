/**
 * The check that keeps the service from starting on a database that is behind its migrations. The database is a
 * stand-in that answers the one read the check makes; nothing here connects to a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refuseWhileMigrationsPending, pendingMigrations, readMigrations } from './migrate.js';

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

  /*
   * RED WHEN: a database that cannot be read is treated as current and the service starts blind.
   */
  it('refuses when the database cannot be read, and says to run the database setup', async () => {
    const said = await refuseWhileMigrationsPending(databaseRecording(new Error('connection refused')), dir);
    expect(said).toContain('COULD NOT BE CHECKED');
    expect(said).toContain('connection refused');
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
