/*
 * Every wallet action that reads a company reads the same at every size of the company: each one this harness runs is
 * run on a device that has checked the company before, step by step, then again after the company grows to twice its
 * people, vendors, vaults and open proposals. Every route each step calls and every holders, chain, builder and indexer
 * read it makes must count the same at both sizes. What the service's answers carry is held to what the service holds:
 * a list carries every record of its kind once, and a read carries what it asked and every version filed of a record
 * read whole, so it grows only by the records the larger company added; a read asks the same records of each kind at
 * both sizes, or one more for each one more the company holds where the action is granted it. No step writes a record,
 * an entry or a header again with no read of it since its own write of it, and no run files a roster version it does not
 * change. The tables of the pins this run measures are written from it by the pins writer. What each count file runs is
 * its entry in one list (`RUN_BY_COUNT_FILE`): every count file present has an entry and every entry a file, no count
 * file skips or keeps apart a test, and every row of every table of the pins and every grant of growth is of an action an
 * entry names. An action on the inventory no count file runs yet is named with why, so none is passed over unsaid.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY } from '../../../../packages/web-shared/src/company-view-inventory.js';
import { ADA } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { aCompanyOf, runIntentAs } from './company-harness.test-support.js';
import { ACTION_PINS, CARRIED_PINS, FILED_ACTION_PINS } from './action-count-pins.test-support.js';
import { countedAtBothSizes, filedRunsOn, readsAndWritesOf, runsOn, writesOverAnOldRead } from './action-counts.test-support.js';
import { UPKEEP_AFTER_AN_ADMISSION } from './actions-set-up-first.test-support.js';
import { RUN_BY_COUNT_FILE, runsOfThisCountFile } from './actions-each-count-file-runs.test-support.js';
import { ASKED_GROWS_WITH, ASKED_WITH_EVERY_PROPOSAL } from './asked-by-kind.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const RUNS = { timeout: 160_000 };

/* The actions on the inventory this harness does not run yet, and why: each one's count is still owed. */
const NOT_RUN: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ['private-deposit', 'this harness\'s vaults are filed as records only, so its chain holds no vault secret\'s commitment and the deposit stops at that check; its builder makes no deposit transaction for the wallet to read and pay for, and its chain takes no deposit and shows no note a vault holds'],
  ['pay-run', 'this harness\'s service mounts neither the public payout route nor the fee route, and a payout that route does not answer is read as one that may have been sent, so the wallet never sends it itself; its chain records no payment, so a run approved and open is not paid here'],
  ['add-signer-by-code', 'no product path makes a signer\'s join code, so there is none to add a signer from; it is counted once a signer can join by code'],
]));

const FILED_RUN = filedRunsOn(company);
/* The actions this file runs at both sizes, as its entry in the list of what each count file runs names them. */
const LISTED = runsOfThisCountFile(import.meta.url);
const EVERY_HERE = { ...runsOn(company), ...FILED_RUN };
const RUN = Object.fromEntries(LISTED.map((n) => [n, EVERY_HERE[n]!]));
const PINS = { ...ACTION_PINS, ...FILED_ACTION_PINS };

const ACTIONS_COUNTED = COMPANY_VIEW_INVENTORY.filter((p) => p.kind === 'wallet action' && p.reads === 'company').map((p) => p.name);

/* The count files of this folder, and every action the list of what each count file runs names. */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const COUNT_FILES = readdirSync(HERE).filter((f) => /^every-action-reads-once.*\.test\.ts$/u.test(f)).sort();
const RUN_ANYWHERE = new Set(Object.values(RUN_BY_COUNT_FILE).flat());
/* A test of a count file skipped, kept apart, left to be written, or run only on a condition. */
const NOT_ALWAYS_RUN = /\.(skip|only|todo|skipIf|runIf)\b/u;

/* Each table of the pins file and the actions it holds a row for. */
const PIN_ROWS: readonly (readonly [string, readonly string[]])[] = readFileSync(`${HERE}action-count-pins.test-support.ts`, 'utf8')
  .split(/^export const /mu).slice(1).map((t) => [t.slice(0, t.indexOf(':')), [...t.matchAll(/^ {2}'([^']+)': /gmu)].map((m) => m[1]!)] as const);

/* Every action a grant of what a read may grow with names. */
const GRANTED = new Set([...Object.values(ASKED_GROWS_WITH).flatMap((g) => Object.keys(g.for)), ...ASKED_WITH_EVERY_PROPOSAL.reads.map((r) => r.action)]);

describe('EVERY WALLET ACTION THAT READS A COMPANY READS THE SAME AT EVERY SIZE OF THE COMPANY', RUNS, () => {
  it('every action on the inventory that reads a company is run by a count file, or named with why it is not yet', () => {
    /* RED WHEN: an action that reads a company is run by no count file and not named as owed, so its reads are held by nothing. */
    expect(ACTIONS_COUNTED.filter((n) => !RUN_ANYWHERE.has(n) && !Object.hasOwn(NOT_RUN, n))).toEqual([]);
    /* RED WHEN: an action named as not run is not one on the inventory, or is run by a count file as well. */
    expect(Object.keys(NOT_RUN).filter((n) => !ACTIONS_COUNTED.includes(n) || RUN_ANYWHERE.has(n))).toEqual([]);
    /* RED WHEN: a run a count file lists is neither an action on the inventory nor the upkeep that follows an admission, counted as a run of its own. */
    expect([...RUN_ANYWHERE].filter((n) => !ACTIONS_COUNTED.includes(n) && n !== UPKEEP_AFTER_AN_ADMISSION)).toEqual([]);
  });

  it('every count file present has an entry of what it runs and every entry a file, every test of each runs always, and every row of the pins and every grant is of an action a count file runs', () => {
    /* RED WHEN: a count file of this folder has no entry in the list of what each count file runs, or an entry names no file present. */
    expect(Object.keys(RUN_BY_COUNT_FILE).sort()).toEqual(COUNT_FILES);
    /* RED WHEN: a count file skips a test, keeps one apart, leaves one to be written, or runs one only on a condition, so what it lists may not run. */
    expect(COUNT_FILES.filter((f) => NOT_ALWAYS_RUN.test(readFileSync(`${HERE}${f}`, 'utf8')))).toEqual([]);
    /* RED WHEN: a row of a table of the pins is of an action no count file runs, so it is held by nothing and goes stale. */
    expect(PIN_ROWS.flatMap(([table, rows]) => rows.filter((n) => !RUN_ANYWHERE.has(n)).map((n) => `${table}: ${n}`))).toEqual([]);
    /* RED WHEN: a read is granted growth for an action no count file runs, so the grant is used by nothing. */
    expect([...GRANTED].filter((n) => !RUN_ANYWHERE.has(n))).toEqual([]);
  });

  it('every action run at both sizes is pinned, and every pin of an action filed for is of one run here', () => {
    /* RED WHEN: an action this file runs twice has no pin, or reads are pinned for an action filed for that this file does not run. */
    expect(Object.keys(RUN).filter((n) => !Object.hasOwn(PINS, n))).toEqual([]);
    expect(Object.keys(FILED_ACTION_PINS).filter((n) => !Object.hasOwn(FILED_RUN, n))).toEqual([]);
    /* RED WHEN: this file's entry names an action it cannot run. */
    expect(LISTED.filter((n) => !Object.hasOwn(EVERY_HERE, n))).toEqual([]);
  });

  countedAtBothSizes(company, RUN, { people: 6, vendors: 4, vaults: 4, proposals: 2 }, { reads: PINS, carried: CARRIED_PINS }, [
    { name: 'FILED_ACTION_PINS', about: 'The actions that act on a record filed for them first, on the company at its first size.', of: 'reads', only: Object.keys(FILED_RUN) },
    { name: 'CARRIED_PINS', about: 'The records the service\'s answers to each step carried, on the company at its first size.', of: 'carried' },
  ]);

  it('a step that writes a record, an entry or a header again with no read of it since its own write of it is found, and one with the record\'s newest version read between is not, in a step\'s own log with its write sent again', async () => {
    const windowOf = (seconds: string) => ({ name: 'set-recovery-window', fields: { ...company.fields, seconds } }) as never;
    const real = await runIntentAs('set-recovery-window', windowOf('86400'), company, ADA.person, (steps) => steps);
    const read = new Set<string>();
    const write = real.log.find((c) => {
      if (c.step !== real.log.find((x) => x.method === 'PUT')?.step) return false;
      const { reads, writes } = readsAndWritesOf(c);
      reads.forEach((r) => read.add(r));
      return writes.some((w) => read.has(w));
    });
    /* RED WHEN: the window's step writes no record it read first, so there is no write to send again below. */
    expect(write, JSON.stringify(real.log.map((c) => `${c.step} ${c.method} ${c.path} ${c.body ?? ''}`.slice(0, 200)))).toBeDefined();
    expect(writesOverAnOldRead(real.log)).toEqual([]);
    /*
     * The step's own log with its write sent again at once after it, and once more with the record's newest version asked
     * between the two, as a filer numbers its next version from it: the step sends its write through its view, which no
     * test reaches, so the second write is put in its log after the first.
     */
    const [, kind, id] = /\/records\/([^/]+)\/([^/]+)\//u.exec(write!.path)!;
    const at = real.log.indexOf(write!);
    const newest = { ...write!, method: 'POST' as const, path: write!.path.replace(/\/records\/.*$/u, '/manifest/newest'), body: JSON.stringify({ records: [{ store: 'company', kind, id }] }) };
    const sentTwice = [...real.log.slice(0, at + 1), write!, ...real.log.slice(at + 1)];
    /* RED WHEN: a step that sends a record's write again, after its own write and with nothing read between, is not found. */
    expect(writesOverAnOldRead(sentTwice)).toEqual([`step ${write!.step}, call ${at + 2}: PUT ${write!.route} writes record ${kind} ${id} again with no read of it since its own write of it`]);
    /* RED WHEN: a write made after a read of the record's newest version is found as written from an old read. */
    expect(writesOverAnOldRead([...real.log.slice(0, at + 1), newest, write!, ...real.log.slice(at + 1)])).toEqual([]);
    /* RED WHEN: a write sent twice is not found when the step did not read the record before the first. */
    const unread = sentTwice.filter((c, i) => i > at || !readsAndWritesOf(c).reads.includes(`record ${kind} ${id}`));
    expect(writesOverAnOldRead(unread)).toEqual([`step ${write!.step}, call ${unread.indexOf(write!) + 2}: PUT ${write!.route} writes record ${kind} ${id} again with no read of it since its own write of it`]);
    /*
     * An entries post and a headers post of the run sent again at once after themselves: each is a write of the entries
     * it names, and the headers post of its header too, so sending one again with nothing read between is found.
     */
    for (const posted of ['/manifest/entries', '/manifest/tree/headers']) {
      const post = real.log.find((c) => c.method === 'POST' && c.path.split('?')[0]!.endsWith(posted));
      /* RED WHEN: the run makes no such post, so there is none to send again. */
      expect(post, posted).toBeDefined();
      const twice = [...real.log.slice(0, real.log.indexOf(post!) + 1), post!, ...real.log.slice(real.log.indexOf(post!) + 1)];
      /* RED WHEN: an entries or headers post sent again with nothing read between is not found. */
      expect(writesOverAnOldRead(twice).length, posted).toBe(readsAndWritesOf(post!).writes.length);
      expect(readsAndWritesOf(post!).writes.length, posted).toBeGreaterThan(0);
    }
  });

});
