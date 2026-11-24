/*
 * What each count file of the wallet's actions runs: the one list each count file takes its runs from, held at the end
 * of the file to what ran, and by the inventory case to the inventory and to the count files present.
 */
import { afterAll, expect } from 'vitest';
import { grantsLeftUnused } from './asked-by-kind.test-support.js';

/* The actions the counts at the company's first size and at more seats, batches and people run, in the order they run. */
const ON_ONE_COMPANY = [
  'give-vault-keys', 'invite', 'change-threshold', 'set-recovery-window', 'repair-company-key', 'choose-company-service',
  'rotate-vault-secrets', 'set-policy-bar', 'withdraw-proposal', 'approve-proposal',
] as const;

/** The actions each count file runs, by the file's name: the upkeep after an admission is counted as a run of its own. */
export const RUN_BY_COUNT_FILE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'every-action-reads-once.test.ts': ['give-vault-keys', 'invite', 'change-threshold', 'admit-person', 'change-person'],
  'every-action-reads-once-at-the-first-size.test.ts': ON_ONE_COMPANY,
  'every-action-reads-once-on-more-seats.test.ts': ON_ONE_COMPANY,
  'every-action-reads-once-over-more-batches.test.ts': ON_ONE_COMPANY,
  'every-action-reads-once-past-256.test.ts': ON_ONE_COMPANY,
  'every-action-reads-once-as-runs-and-payments-grow.test.ts': ['give-vault-keys', 'invite', 'change-threshold', 'admit-person', 'change-person', 'upkeep-after-an-admission'],
  'every-action-reads-once-set-up-first-as-money-grows.test.ts': ['withdraw-waiting-signer', 'admit-signer', 'raise-waiting-signer'],
  'every-action-reads-once-of-a-removal-as-money-grows.test.ts': ['remove-signer'],
  'every-action-reads-once-of-a-change-of-role-as-money-grows.test.ts': ['change-role'],
  'every-action-reads-once-of-a-spending-policy-as-money-grows.test.ts': ['set-spending-policy'],
  'every-action-reads-once-of-a-run-as-money-grows.test.ts': ['raise-run'],
  'every-action-reads-once-set-up-first.test.ts': ['withdraw-waiting-signer', 'admit-signer', 'raise-waiting-signer'],
  'every-action-reads-once-of-a-change-of-role.test.ts': ['change-role'],
  'every-action-reads-once-of-a-removal.test.ts': ['remove-signer'],
  'every-action-reads-once-of-a-spending-policy.test.ts': ['set-spending-policy'],
  'every-action-reads-once-of-a-run.test.ts': ['raise-run'],
  'every-action-reads-once-of-the-upkeep-after-an-admission.test.ts': ['upkeep-after-an-admission'],
  'every-action-reads-once-of-a-reissued-invitation.test.ts': ['reissue-invitation'],
  'every-action-reads-once-of-a-recovery.test.ts': ['recovery'],
  'every-action-reads-once-of-a-new-vault.test.ts': ['create-vault'],
  'every-action-reads-once-of-a-retired-vault.test.ts': ['retire-vault'],
  'every-action-reads-once-of-a-one-off-payment.test.ts': ['one-off-payment'],
  'every-action-reads-once-of-a-read-granted.test.ts': ['grant-read'],
  'every-action-reads-once-of-the-upkeep-after-the-company-grows.test.ts': ['upkeep-after-an-admission', 'give-vault-keys'],
  'every-action-reads-once-of-the-upkeep-as-vaults-or-people-grow.test.ts': ['upkeep-after-an-admission'],
});

/* The actions that ran in this file, each noted once its count finished. */
const ran = new Set<string>();
/** Notes that `name` ran, counted, in this file. */
export const noteRan = (name: string): void => { ran.add(name); };

/**
 * The actions the count file at `url` runs, from its entry, refused when it has none; and, once the file's tests have run,
 * a refusal of each listed action that did not run, and of each grant of what a read may grow with that a count of this
 * file could use and none did. Call it where the file's tests are declared, once.
 */
export const runsOfThisCountFile = (url: string): readonly string[] => {
  const file = new URL(url).pathname.split('/').at(-1)!;
  const runs = RUN_BY_COUNT_FILE[file];
  if (runs === undefined) throw new Error(`the count file ${file} has no entry in the list of what each count file runs`);
  afterAll(() => {
    /*
     * RED WHEN: an action this file lists as run did not run, counted (skipped, left out, or stopped before its count
     * finished); or a read is granted growth by what the company grew by here, for an action this file ran, and no read
     * of it grew so.
     */
    expect({ listedAndNotRun: runs.filter((n) => !ran.has(n)), grantedAndNotUsed: grantsLeftUnused() }, file).toEqual({ listedAndNotRun: [], grantedAndNotUsed: [] });
  });
  return runs;
};
