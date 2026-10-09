/**
 * **THE KINDS OF RECORD A COMPANY KEEPS ARE ONE LIST, AND THE DATABASE IS HELD
 * TO IT.**
 *
 * The store refuses a kind its table's check does not list, and the code
 * refuses a kind `COMPANY_RECORD_KINDS` does not list. A database cannot import
 * the list, so the check is written out in the migrations; this file reads the
 * migrations in the order the runner applies them (`readMigrations`) and holds
 * the check the last of them leaves on the table to the list. A kind added to
 * the list with no migration, or a migration that leaves a kind out, is red
 * here before any filing of it is refused by a database.
 */
import { describe, it, expect } from 'vitest';
import { readMigrations, type Migration } from './migrate.js';
import { COMPANY_RECORD_KINDS } from '../midnight/sealed-record-wire.js';

const TABLE = 'company_sealed_records';

/** The kinds one migration's check lists for the table, or null when the migration sets no such check. */
const kindsSetBy = (m: Migration): string[] | null => {
  let found: string[] | null = null;
  /* A line commented out is not run, so it sets nothing. */
  const sql = m.sql.replace(/--[^\n]*/gu, '');
  const created = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${TABLE}\\s*\\(([\\s\\S]*?)\\n\\);`, 'iu').exec(sql);
  const added = new RegExp(`ALTER TABLE\\s+${TABLE}\\s+ADD CONSTRAINT\\s+${TABLE}_kind_check\\s+CHECK\\s*\\(\\s*kind\\s+IN\\s*\\(([^)]*)\\)`, 'iu').exec(sql);
  const inCreate = created === null ? null : /\bkind\b[^\n]*CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/iu.exec(created[1]!);
  for (const listed of [inCreate?.[1], added?.[1]]) {
    if (listed !== undefined) found = [...listed.matchAll(/'([^']*)'/gu)].map((x) => x[1]!);
  }
  return found;
};

/** The check on the table's kind as the last migration that sets one leaves it, with that migration's name. */
const kindsTheDatabaseAllows = (): { readonly by: string; readonly kinds: readonly string[] } => {
  let last: { by: string; kinds: string[] } | null = null;
  for (const m of readMigrations()) {
    const kinds = kindsSetBy(m);
    if (kinds !== null) last = { by: m.name, kinds };
  }
  if (last === null) throw new Error(`no migration sets a check on ${TABLE}'s kind`);
  return last;
};

describe('the kinds of record a company keeps', () => {
  it('ARE EXACTLY THE ONES THE DATABASE ALLOWS, as the last migration to set the check leaves it', () => {
    const allowed = kindsTheDatabaseAllows();
    expect([...allowed.kinds].sort(), `RED WHEN: COMPANY_RECORD_KINDS gains or loses a kind and no migration follows (last: ${allowed.by})`)
      .toEqual([...COMPANY_RECORD_KINDS].sort());
  });

  it('are each listed once, in the code and in the check', () => {
    expect(new Set(COMPANY_RECORD_KINDS).size, 'RED WHEN: a kind is written twice in COMPANY_RECORD_KINDS').toBe(COMPANY_RECORD_KINDS.length);
    const { kinds } = kindsTheDatabaseAllows();
    expect(new Set(kinds).size, 'RED WHEN: a kind is written twice in the check').toBe(kinds.length);
  });

  it('a migration that sets the check again first drops the one before it, by the name the table\'s own check is given', () => {
    /*
     * 0004 writes its check inline, so the database names it as it names every
     * unnamed column check: the table, the column, "check". A migration that adds
     * the check again without dropping that one leaves both in force, and the
     * older list refuses every new kind. Whether a running database really holds
     * that name is read only against a database.
     */
    const NAME = `${TABLE}_kind_check`;
    const uncommented = (m: Migration) => m.sql.replace(/--[^\n]*/gu, '');
    let added = 0;
    for (const m of readMigrations()) {
      const sql = uncommented(m);
      const adds = sql.search(new RegExp(`ADD CONSTRAINT\\s+${NAME}\\b`, 'iu'));
      if (adds < 0) continue;
      added += 1;
      const drops = sql.search(new RegExp(`DROP CONSTRAINT(?: IF EXISTS)?\\s+${NAME}\\b`, 'iu'));
      expect(drops, `RED WHEN: ${m.name} adds the kind check without first dropping ${NAME}`).toBeGreaterThanOrEqual(0);
      expect(drops < adds, `RED WHEN: ${m.name} drops the kind check after adding it`).toBe(true);
    }
    expect(added, 'RED WHEN: no migration sets the kind check again, so a kind added after 0004 is refused').toBeGreaterThan(0);
  });

  it('a migration that drops the check puts it back in the same migration', () => {
    for (const m of readMigrations()) {
      if (!new RegExp(`DROP CONSTRAINT(?: IF EXISTS)?\\s+${TABLE}_kind_check`, 'iu').test(m.sql.replace(/--[^\n]*/gu, ''))) continue;
      expect(kindsSetBy(m), `RED WHEN: ${m.name} drops the kind check and does not add it again`).not.toBeNull();
    }
  });
});
