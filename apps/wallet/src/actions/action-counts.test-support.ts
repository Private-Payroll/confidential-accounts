/*
 * How a wallet action's reads are counted and compared, for every file that counts them: the actions this harness runs,
 * what one run read as a list of reads by step, and the comparison of that list with a pinned one, each difference named
 * by its action, step and route or ask. A file for one size of the company makes the company, then calls
 * `actionsCountedOn` once to hold every action it runs to the reads pinned for the company's first size.
 */
import { describe, expect, it } from 'vitest';
import { ADA, CO, CY, store } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { addressOfWallet, runIntent, runUpkeep, type Company, type IntentCount } from './company-harness.test-support.js';

/** What one step read: each route by name and each read through a door by door and ask, with its count. */
export type Reads = Readonly<Record<string, number>>;
/** What each action read, step by step. */
export type PinnedReads = Readonly<Record<string, readonly Reads[]>>;

/** What one action's run read, step by step. */
export const readsOf = (c: IntentCount): Reads[] => c.steps.map((s) => ({
  ...Object.fromEntries(Object.entries(s.routes).map(([r, n]) => [`route ${r}`, n])), ...s.asks,
}));

/** Each read that differs between two lists of one action's reads, named by its action, step and route or ask. */
export const differences = (name: string, was: readonly Reads[], now: readonly Reads[], labels: readonly [string, string]): string[] => {
  if (was.length !== now.length) return [`${name}: ${was.length} steps ${labels[0]}, ${now.length} ${labels[1]}`];
  return was.flatMap((x, i) => [...new Set([...Object.keys(x), ...Object.keys(now[i]!)])].filter((k) => (x[k] ?? 0) !== (now[i]![k] ?? 0))
    .map((k) => `${name} step ${i + 1}: ${k} ${x[k] ?? 0} ${labels[0]}, ${now[i]![k] ?? 0} ${labels[1]}`));
};

/** The part of a difference that names the read, without its action and step. */
const readNamed = (difference: string): string => difference.replace(/^\S+ step \d+: /u, '');
/** The line of `stillGrows` that names a difference, if one does: each names a read, for every action and step that makes it, or an action, a colon and a read. */
export const grownAs = (stillGrows: Readonly<Record<string, string>>, difference: string): string | undefined => {
  const named = [readNamed(difference), `${difference.split(' step ')[0]}: ${readNamed(difference)}`];
  return Object.keys(stillGrows).find((k) => named.some((n) => n.startsWith(`${k} `)));
};

/** The company's open proposals, oldest first, as the service holds them. */
const openProposals = (): string[] => store.listProposals(CO).filter((p) => (p as { readonly status?: string }).status === 'open').map((p) => p.id);

/* Each action this harness runs, as run at one size; `at` tells two runs apart where one cannot be run twice on the same input. */
export const runsOn = (company: Company): Readonly<Record<string, (at: 0 | 1) => Promise<IntentCount>>> => {
  const ownedBy = (name: string, more: Record<string, string>) => runIntent(name, { name, fields: { ...company.fields, ...more } } as never, company, ADA.person);
  return Object.freeze({
  'give-vault-keys': () => runUpkeep(company, ADA.person),
  invite: (at: 0 | 1) => runIntent('invite', {
    name: 'invite', fields: { ...company.fields, kind: 'signer', personName: ['dee', 'eve'][at]!, role: 'approver', address: addressOfWallet(company.wallet(['dee', 'eve'][at]!)) },
  } as never, company, ADA.person),
  /* The change to one approval is raised when the company is made and is still open at every size, so every run finds it open. */
  'change-threshold': () => runIntent('change-threshold', { name: 'change-threshold', fields: { ...company.fields, threshold: '1' } } as never, company, ADA.person),
  /* Each of these is run by the founding seat, in this order, after the actions above: the first three file no proposal, the policy bar's raising files one. */
  'set-recovery-window': () => ownedBy('set-recovery-window', { seconds: '86400' }),
  'repair-company-key': () => ownedBy('repair-company-key', {}),
  'choose-company-service': () => ownedBy('choose-company-service', { service: 'ours' }),
  'rotate-vault-secrets': () => ownedBy('rotate-vault-secrets', {}),
  'set-policy-bar': () => ownedBy('set-policy-bar', { bar: '1' }),
  /* The proposal the policy bar's raising filed, withdrawn by the seat that raised it. */
  'withdraw-proposal': () => ownedBy('withdraw-proposal', { proposal: openProposals().at(-1)!, kind: 'policy-bar' }),
  /* The change to one approval, approved by the third seat: last, as it carries out the proposal the actions above find open. */
  'approve-proposal': () => runIntent('approve-proposal', {
    name: 'approve-proposal', fields: { ...company.fields, proposal: openProposals()[0]!, kind: 'threshold', threshold: '1' },
  } as never, company, CY.person),
  });
};

/** The actions that can be run again on the same company with the same reads, so their reads at two sizes of one company can be compared; each of the others changes what it acts on, once. */
export const REPEATABLE: readonly string[] = ['give-vault-keys', 'invite', 'change-threshold'];

/** The records an action files: the invitations and the proposals the service holds after a run, less before it. */
export const filedBy = async (run: () => Promise<IntentCount>): Promise<{ readonly count: IntentCount; readonly invites: number; readonly proposals: number }> => {
  const [invites, proposals] = [store.listInvites(CO).length, store.listProposals(CO).length];
  const count = await run();
  return { count, invites: store.listInvites(CO).length - invites, proposals: store.listProposals(CO).length - proposals };
};

/** What each action files at every size: an invitation files its one invitation and its one proposal, raising the policy bar files one proposal, and the others file no new one. */
export const FILED: Readonly<Record<string, { readonly invites: number; readonly proposals: number }>> = Object.freeze({
  'give-vault-keys': { invites: 0, proposals: 0 }, invite: { invites: 1, proposals: 1 }, 'change-threshold': { invites: 0, proposals: 0 },
  'set-recovery-window': { invites: 0, proposals: 0 }, 'repair-company-key': { invites: 0, proposals: 0 }, 'choose-company-service': { invites: 0, proposals: 0 },
  'rotate-vault-secrets': { invites: 0, proposals: 0 }, 'set-policy-bar': { invites: 0, proposals: 1 }, 'withdraw-proposal': { invites: 0, proposals: 0 }, 'approve-proposal': { invites: 0, proposals: 0 },
});

/**
 * Runs every action on `company` in the order the pins were measured in, each as a test of its own so a red names its action,
 * and holds each step's reads to `pins`, but the reads named in `stillGrows`, each with why; each of those must still be found
 * differing. The records each action files are counted from the service and must be exactly what it files. The reads are held
 * to what was measured, flat by the size of the company: a count is pinned, not budgeted, and a pin changes with the change that explains it.
 */
export function actionsCountedOn(company: Company, pins: PinnedReads, stillGrows: Readonly<Record<string, string>>, labels: readonly [string, string]): void {
  describe('EVERY WALLET ACTION READS THE SAME ON THIS COMPANY AS ON THE PINNED ONE (FLAT BY SIZE: A MEASURED COUNT, NOT A BUDGET), AND FILES EXACTLY WHAT IT CHANGES', { timeout: 160_000 }, () => {
    const changed: string[] = [];
    const runs = runsOn(company);

    it('every action counted here has reads pinned and a record of what it files, and every pinned action is counted', () => {
      /* RED WHEN: an action is counted here with no pinned reads to hold it to, or pinned reads are for an action not counted here. */
      expect(Object.keys(runs).sort()).toEqual(Object.keys(pins).sort());
      /* RED WHEN: what an action files is recorded for an action not counted here, or not recorded for one that is. */
      expect(Object.keys(FILED).sort()).toEqual(Object.keys(runs).sort());
    });

    for (const [name, run] of Object.entries(runs)) {
      it(`action ${name} is run on a device that has checked the company before, step by step, and counted`, async () => {
        const done = await filedBy(() => run(0));
        const differing = differences(name, pins[name]!, readsOf(done.count), labels);
        changed.push(...differing);
        /* RED WHEN: an action files more or fewer records than it changes: one invitation and one proposal for an invitation, none else. */
        expect({ invites: done.invites, proposals: done.proposals }).toEqual(FILED[name]);
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of any step of this action differs from the reads pinned for the company's first size, but those named as still growing. */
        expect(differing.filter((d) => grownAs(stillGrows, d) === undefined)).toEqual([]);
      });
    }

    it('every read named as still growing is still found differing', () => {
      /* RED WHEN: a read named as still growing no longer differs, and is still named here. */
      expect(Object.keys(stillGrows).filter((k) => !changed.some((d) => grownAs(stillGrows, d) === k))).toEqual([]);
    });
  });
}
