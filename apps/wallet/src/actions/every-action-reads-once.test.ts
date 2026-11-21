/*
 * Every wallet action that reads a company reads the same at every size of the company: each one this harness runs is
 * run on a device that has checked the company before, step by step, then again after the company grows to twice its
 * people, vendors, vaults and open proposals. Every route each step calls, and every holders, chain, builder and indexer
 * read it makes, must count the same at both sizes, but a read named as still growing, with why. An action on the
 * inventory this harness does not run yet is named with why, so none is passed over unsaid.
 */
import { describe, expect, it } from 'vitest';
import { COMPANY_VIEW_INVENTORY } from '../../../../packages/web-shared/src/company-view-inventory.js';
import { ADA, BO } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { aCompanyOf, type IntentCount } from './company-harness.test-support.js';
import { ACTION_PINS } from './action-count-pins.test-support.js';
import { differences, grownAs, readsOf, REPEATABLE, runsOn } from './action-counts.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const RUNS = { timeout: 160_000 };

/* The actions on the inventory this harness does not run yet, and why: each one's count is still owed. */
const NOT_RUN: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...['create-vault', 'private-deposit', 'one-off-payment', 'pay-run'].map((name) => [name, 'it proves or sends money, which this harness\'s chain does not do; its proving is run on its own']),
  ...['raise-run'].map((name) => [name, 'this company raises no runs before an action runs: a run needs admitted payees, and its people are only invited']),
  ...['grant-read'].map((name) => [name, 'it needs the code a reader\'s own wallet signs, which this harness does not make']),
  ...[
    'set-spending-policy', 'remove-signer', 'recovery', 'admit-signer', 'admit-person', 'change-person', 'change-role', 'withdraw-waiting-signer',
    'reissue-invitation', 'add-signer-by-code', 'raise-waiting-signer',
  ].map((name) => [name, 'the harness has no company set up for it yet: what it acts on is not filed by the company this harness makes']),
  ['retire-vault', 'raising it reads the public money the vault holds off the chain, which this harness\'s chain does not answer; it is the unit of another round and stays not run here'],
]));

/* The reads that still grow with the company, by action, step and ask, with why; each must still be found growing. */
const STILL_GROWS: Readonly<Record<string, string>> = Object.freeze({
});

const EVERY_RUN = runsOn(company);
/* The actions this file runs at both sizes: the ones that read the same when run again; the others are counted on a company of their own. */
const RUN = Object.fromEntries(REPEATABLE.map((n) => [n, EVERY_RUN[n]!]));

const ACTIONS_COUNTED = COMPANY_VIEW_INVENTORY.filter((p) => p.kind === 'wallet action' && p.reads === 'company').map((p) => p.name);

describe('EVERY WALLET ACTION THAT READS A COMPANY READS THE SAME AT EVERY SIZE OF THE COMPANY', RUNS, () => {
  const atN = new Map<string, IntentCount>();
  /* The company is grown once, by the first action counted at twice its size. */
  let grown: Promise<void> | null = null;
  const grow = (): Promise<void> => (grown ??= company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 }));

  it('every action on the inventory that reads a company is run here, or named with why it is not yet', () => {
    /* RED WHEN: an action that reads a company is neither counted here nor named as owed, so its reads are held by nothing. */
    expect(ACTIONS_COUNTED.filter((n) => !Object.hasOwn(EVERY_RUN, n) && !Object.hasOwn(NOT_RUN, n))).toEqual([]);
    /* RED WHEN: an action named as not run is not one on the inventory, or is run here as well. */
    expect(Object.keys(NOT_RUN).filter((n) => !ACTIONS_COUNTED.includes(n) || Object.hasOwn(EVERY_RUN, n))).toEqual([]);
    expect(Object.keys(EVERY_RUN).filter((n) => !ACTIONS_COUNTED.includes(n))).toEqual([]);
  });

  const changed: string[] = [];

  for (const [name, run] of Object.entries(RUN)) {
    it(`action ${name} is counted, step by step, on the company at its first size`, async () => {
      const count = await run(0);
      atN.set(name, count);
      /* RED WHEN: an action runs no step that reaches the company, so its count holds nothing to grow. */
      expect(count.steps.every((s) => Object.keys(s.routes).length === 0)).toBe(false);
      expect(BO.person).not.toBe(ADA.person);
      /* RED WHEN: an action reads differently at the first size than the reads every other count file holds its company to. */
      expect(readsOf(count)).toEqual(ACTION_PINS[name]);
    });
  }

  it('every repeatable action is pinned, and every pin is of a repeatable action', () => {
    /* RED WHEN: reads are pinned for an action this file does not run twice, or an action it runs twice has no pin. */
    expect(REPEATABLE.every((n) => Object.hasOwn(ACTION_PINS, n))).toBe(true);
    expect(Object.keys(RUN).sort()).toEqual([...REPEATABLE].sort());
  });

  for (const [name, run] of Object.entries(RUN)) {
    it(`action ${name} reads the same at twice the company's records, step by step`, async () => {
      /* RED WHEN: the first size of this action was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(name), `action ${name} is counted at its first size before it is counted at twice it`).toBe(true);
      await grow();
      const differing = differences(name, readsOf(atN.get(name)!), readsOf(await run(1)), ['at the first size', 'at twice it']);
      changed.push(...differing);
      /* RED WHEN: any route, holders, chain, builder or indexer read of any step of this action grows with the company's people, vendors, vaults or proposals. */
      expect(differing.filter((d) => grownAs(STILL_GROWS, d) === undefined)).toEqual([]);
    });
  }

  it('every read named as still growing is still found growing', () => {
    /* RED WHEN: a read named as still growing no longer grows, and is still named here. */
    expect(Object.keys(STILL_GROWS).filter((k) => !changed.some((d) => grownAs(STILL_GROWS, d) === k))).toEqual([]);
  });
});
