/*
 * How a wallet action's reads are counted and compared, for every file that counts them: the actions this harness runs,
 * what one run read as a list of reads by step, and the comparison of that list with a pinned one, each difference named
 * by its action, step and route or ask. A file for one size of the company makes the company, then calls
 * `actionsCountedOn` once, with its own address, to hold every action its entry in the list of what each count file runs
 * names to the reads pinned for the company's first size. Each count notes the actions it ran, so the end of the file
 * refuses one listed and not run.
 */
import { describe, expect, it } from 'vitest';
import { ADA, CO, CY, store } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { addressOfWallet, runIntent, runUpkeep, type Company, type CompanySize, type IntentCount, type Logged, type PayeeWaiting } from './company-harness.test-support.js';
import { askedByKind, askedName, listsItsKind, unversioned } from './records-carried.test-support.js';
import { noteRan, runsOfThisCountFile } from './actions-each-count-file-runs.test-support.js';
import { askedAsPinned, askedDiffering, askedIn, askedOtherThan, bodyOf, heldBy, NAMES_ITS_RECORDS, pinnedAsked, type CompanyHeld } from './asked-by-kind.test-support.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** The records each step's answers carried, step by step. */
export const carriedOf = (c: IntentCount): number[] => c.steps.map((s) => s.carried);
/** The records each step's answers carried, by the route that answered them. */
export const carriedByRouteOf = (c: IntentCount): Reads[] => c.steps.map((s) => {
  const by: Record<string, number> = {};
  for (const l of c.log) if (l.step === s.step) by[`carried by ${l.route}`] = (by[`carried by ${l.route}`] ?? 0) + l.carried;
  return by;
});

/*
 * What one call reads and what it writes, each named by the record, vault record, list, entry or header it reaches. A read
 * of the newest versions or of proofs reads each record it names, as a next version is numbered from it; the list of the
 * records waiting to be anchored, the list of people and the list of headers read each record they carried. An entries
 * post writes the entry of each record it names, and a headers post writes its header and the entry of each record it
 * gives with it.
 */
const ACCOUNT_RECORD = /^\/api\/accounts\/[^/]+\/records\/([^/]+)\/([^/]+)/u;
const VAULT_RECORD = /^\/api\/vaults\/([^/]+)\/records\/([^/]+)/u;
const VERSIONED_LIST = /^\/api\/accounts\/[^/]+\/(directory|vault-keys)(?:\/[^/]*)?$/u;
const LISTS_ITS_RECORDS = /^\/api\/accounts\/[^/]+\/(manifest\/tree\/pending|manifest\/tree\/headers|people)$/u;
const ENTRIES = /^\/api\/accounts\/[^/]+\/manifest\/entries$/u;
const HEADERS = /^\/api\/accounts\/[^/]+\/manifest\/tree\/headers$/u;
/* The entry of each record a post of entries names, by the record's name. */
const entriesIn = (body: Record<string, unknown>): string[] =>
  (Array.isArray(body['entries']) ? body['entries'] as Record<string, unknown>[] : []).map((e) => `entry ${askedName(e)}`);
/** What one call reads and what it writes, each by name. */
export const readsAndWritesOf = (c: Pick<Logged, 'method' | 'path' | 'body'> & Partial<Pick<Logged, 'records'>>): { readonly reads: readonly string[]; readonly writes: readonly string[] } => {
  const path = c.path.split('?')[0]!;
  if (c.method === 'POST' && NAMES_ITS_RECORDS.test(path)) return { reads: askedIn(c.body).map(askedName), writes: [] };
  if (c.method === 'GET' && LISTS_ITS_RECORDS.test(path)) return { reads: (c.records ?? []).map(unversioned), writes: [] };
  if (c.method === 'POST' && ENTRIES.test(path)) return { reads: [], writes: entriesIn(bodyOf(c.body)) };
  if (c.method === 'POST' && HEADERS.test(path)) {
    const body = bodyOf(c.body);
    const header = body['header'] as { readonly seq?: unknown } | undefined;
    return { reads: [], writes: [`header ${String(header?.seq)}`, ...entriesIn(body)] };
  }
  const [account, vault, list] = [ACCOUNT_RECORD.exec(path), VAULT_RECORD.exec(path), VERSIONED_LIST.exec(path)];
  const named = account !== null ? `record ${account[1]} ${account[2]}` : vault !== null ? `vault ${vault[1]} ${vault[2]}` : list !== null ? list[1]! : null;
  if (named === null) return { reads: [], writes: [] };
  if (c.method === 'GET') return { reads: [named], writes: [] };
  return c.method === 'PUT' ? { reads: [], writes: [named] } : { reads: [], writes: [] };
};

/**
 * Each write a step made of a record, entry or header it had written before in the same step with no read of it between:
 * a write sent again, whether or not the step read it first. A read of a record reads its entry too, as an entry is made
 * from the version read. Named by step, call and what it wrote.
 */
export const writesOverAnOldRead = (log: readonly Logged[]): string[] => {
  const found: string[] = [];
  const written = new Set<string>();
  let step = 0;
  for (const [i, c] of log.entries()) {
    if (c.step !== step) { written.clear(); step = c.step; }
    const { reads, writes } = readsAndWritesOf(c);
    for (const r of reads) { written.delete(r); written.delete(`entry ${r}`); }
    for (const w of writes) {
      if (written.has(w)) found.push(`step ${c.step}, call ${i + 1}: ${c.method} ${c.route} writes ${w} again with no read of it since its own write of it`);
      written.add(w);
    }
  }
  return found;
};

/** Each call whose answer broke the rule what it carries is held to, named by step, call and how. */
export const carriedNotAsHeldIn = (log: readonly Logged[]): string[] =>
  log.flatMap((c, i) => (c.notAsHeld === null ? [] : [`step ${c.step}, call ${i + 1}: ${c.route} ${c.notAsHeld}`]));

/**
 * Each record a list carried in a step of the first run that the same step's list does not carry in the second, by step,
 * route and record: a list carries every record of its kind, so a record listed once is listed again while it is held.
 */
export const listedThenNot = (was: IntentCount, now: IntentCount): string[] => {
  const listed = (c: IntentCount): Map<string, Set<string>> => {
    const by = new Map<string, Set<string>>();
    for (const l of c.log.filter((x) => listsItsKind(x.method, x.path))) {
      const at = `step ${l.step}: ${l.route}`;
      by.set(at, new Set([...(by.get(at) ?? []), ...l.records.map(unversioned)]));
    }
    return by;
  };
  const after = listed(now);
  return [...listed(was)].flatMap(([at, names]) => [...names].filter((n) => !(after.get(at)?.has(n) ?? false)).map((n) => `${at} no longer carries ${n}`));
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

/** A payee waiting to be admitted, admitted by the founding seat's wallet through the action that admits them. */
const admitted = (company: Company, p: PayeeWaiting): Promise<IntentCount> => runIntent('admit-person', {
  name: 'admit-person', fields: { ...company.fields, kind: 'employee', person: p.id, personName: p.name, fingerprint: p.fingerprint },
} as never, company, ADA.person);

/*
 * Each action that acts on a record the company does not hold until it is filed for it, as run at one size: each run files
 * its own record first, through the functions the product files it with, so each size acts on a record of its own.
 */
export const filedRunsOn = (company: Company): Readonly<Record<string, (at: 0 | 1) => Promise<IntentCount>>> => Object.freeze({
  /*
   * A person admitted before, so the company holds a person record changed since its first version at both sizes, as a
   * company that has admitted anyone does: an admission reads the versions of every such record in one call.
   */
  'admit-person': async () => {
    await admitted(company, await company.payeeWaiting());
    return admitted(company, await company.payeeWaiting());
  },
  'change-person': async () => {
    const p = await company.payeeWaiting();
    await admitted(company, p);
    return runIntent('change-person', {
      name: 'change-person', fields: { ...company.fields, kind: 'employee', person: p.id, personName: p.name, endDate: '2027-06-30' },
    } as never, company, ADA.person);
  },
});

/** The actions that can be run again on the same company with the same reads, so their reads at two sizes of one company can be compared; each of the others changes what it acts on, once. */
export const REPEATABLE: readonly string[] = ['give-vault-keys', 'invite', 'change-threshold'];

/** What one run files: the invitations, the proposals and the versions of the roster the service holds after it, less before it. */
export interface Filed { readonly invites: number; readonly proposals: number; readonly roster: number }

/** The records a run files, counted from the service before and after it. */
export const filedBy = async (run: () => Promise<IntentCount>): Promise<Filed & { readonly count: IntentCount }> => {
  const held = (): Filed => ({ invites: store.listInvites(CO).length, proposals: store.listProposals(CO).length, roster: store.rosterVersions(CO).length });
  const was = held();
  const count = await run();
  const now = held();
  return { count, invites: now.invites - was.invites, proposals: now.proposals - was.proposals, roster: now.roster - was.roster };
};

/*
 * What each action files at every size: an invitation files its one invitation and its one proposal, raising the policy
 * bar files one proposal, and the others file no new one; none files a version of the roster, as none changes who holds
 * which keys. The 'give-vault-keys' row is the upkeep a seat's wallet runs at the start and end of an act (`runUpkeep`),
 * not the action that gives a seat its vault keys.
 */
export const FILED: Readonly<Record<string, Filed>> = Object.freeze({
  'give-vault-keys': { invites: 0, proposals: 0, roster: 0 }, invite: { invites: 1, proposals: 1, roster: 0 }, 'change-threshold': { invites: 0, proposals: 0, roster: 0 },
  'set-recovery-window': { invites: 0, proposals: 0, roster: 0 }, 'repair-company-key': { invites: 0, proposals: 0, roster: 0 },
  'choose-company-service': { invites: 0, proposals: 0, roster: 0 }, 'rotate-vault-secrets': { invites: 0, proposals: 0, roster: 0 },
  'set-policy-bar': { invites: 0, proposals: 1, roster: 0 }, 'withdraw-proposal': { invites: 0, proposals: 0, roster: 0 },
  'approve-proposal': { invites: 0, proposals: 0, roster: 0 },
});

/*
 * The versions of the roster each run counted at both sizes files, at the first size and at twice it, what the run sets
 * up first included; a run not named here files none at either size. A signer admitted first files two: the admission,
 * and the fold of the new seat's own vault keys. A new vault's first press offers the founding seat's vault keys and its
 * own directory entry when the roster does not hold them yet, and files one; a press that finds them held files none. The
 * creation is counted after the founding seat has given its keys, so it files none at either size; a retirement, which
 * starts a vault first, files one at the first size only.
 */
export const ROSTER_FILED_AT_EACH_SIZE: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  'upkeep-after-an-admission': [2, 2], 'admit-signer': [2, 2], 'remove-signer': [2, 2], 'change-role': [2, 2],
  'create-vault': [0, 0], 'retire-vault': [1, 0],
});

/**
 * Runs every action on `company` in the order the pins were measured in, each as a test of its own so a red names its action,
 * and holds each step's reads to `pins.reads` exactly. The records each action files are counted from the service and must be
 * exactly what it files; no step may write a record again from an answer it read before its own earlier write of it; and
 * every answer carries what the service holds, each record once. With `pins.asked`, every read that names its records asks
 * the records of each kind the pinned run asked, or one more for each one more the company holds where the action is
 * granted it (`askedDiffering`). With `writes`, the file measures the pins file's table of that name, and beside it the
 * table of what each action asked by kind (named with `_ASKED`), and holds each to what its run measured.
 */
export function actionsCountedOn(
  url: string, company: Company, pins: { readonly reads: PinnedReads; readonly asked?: PinnedReads }, labels: readonly [string, string],
  writes?: { readonly name: string; readonly about: string },
): void {
  const named = runsOfThisCountFile(url);
  describe('EVERY WALLET ACTION READS THE SAME ON THIS COMPANY AS ON THE PINNED ONE (FLAT BY SIZE: A MEASURED COUNT, NOT A BUDGET), AND FILES EXACTLY WHAT IT CHANGES', { timeout: 160_000 }, () => {
    const measured: Record<string, Reads[]> = {};
    const asked: Record<string, Reads[]> = {};
    const every = runsOn(company);
    const runs = Object.fromEntries(named.map((n) => [n, every[n]!]));
    if (named.some((n) => !Object.hasOwn(every, n))) throw new Error(`no action counted on one company is named ${named.filter((n) => !Object.hasOwn(every, n)).join(', ')}`);

    it('every action counted here has reads pinned and a record of what it files, and every pinned action is counted', () => {
      /* RED WHEN: an action is counted here with no pinned reads to hold it to, or pinned reads are for an action not counted here. */
      expect(Object.keys(runs).sort()).toEqual(Object.keys(pins.reads).sort());
      /* RED WHEN: what an action files is recorded for an action not counted here, or not recorded for one that is. */
      expect(Object.keys(FILED).sort()).toEqual(Object.keys(runs).sort());
    });

    for (const [name, run] of Object.entries(runs)) {
      it(`action ${name} is run on a device that has checked the company before, step by step, and counted`, async () => {
        const done = await filedBy(() => run(0));
        const held = await heldBy(company);
        measured[name] = readsOf(done.count);
        asked[name] = [askedAsPinned(done.count, held)];
        /* RED WHEN: an action files more or fewer records than it changes: one invitation and one proposal for an invitation, no roster version, none else. */
        expect({ invites: done.invites, proposals: done.proposals, roster: done.roster }).toEqual(FILED[name]);
        /* RED WHEN: any route, wallet ask or chain, builder or indexer read of any step of this action differs from the reads pinned for it. */
        expect(differences(name, pins.reads[name]!, readsOf(done.count), labels)).toEqual([]);
        if (pins.asked !== undefined) {
          const was = pinnedAsked(pins.asked[name]?.[0] ?? {});
          /*
           * RED WHEN: a read that names its records asks more or fewer of a kind on this company than on the pinned one,
           * other than a read granted to the action asking one more for each one more the company holds.
           */
          expect(askedDiffering(name, was.asked, askedByKind(done.count), [was.held, held], labels)).toEqual([]);
        }
        noteRan(name);
        /* RED WHEN: a step writes a record again from an answer it read before its own earlier write of that record. */
        expect(writesOverAnOldRead(done.count.log)).toEqual([]);
        /* RED WHEN: an answer carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
        expect(carriedNotAsHeldIn(done.count.log)).toEqual([]);
      });
    }

    if (writes !== undefined) {
      it(`the pins of ${writes.name} and ${writes.name}_ASKED are the ones the pins writer writes from what this run measured`, () => {
        const everyOne = Object.keys(runs).every((n) => Object.hasOwn(measured, n));
        const tables: PinTable[] = [
          { ...writes, reads: { ...measured } },
          { name: `${writes.name}_ASKED`, about: `What each read that names its records asked, by kind, with what the company held as the action ended: ${writes.about}`, reads: { ...asked } },
        ];
        /* RED WHEN: a pin is not what this run measured, or the pins file was changed by hand away from what its writer writes. */
        for (const t of tables) expect(tableHeld(t, everyOne), t.name).toBe(tableSource(t));
      });
    }

  });
}

/**
 * One table the run at both sizes writes: its name, what it pins, whether reads or records carried, and the actions it
 * holds (every one run, without `only`); a run that counts only some of them holds and writes only their rows.
 */
export interface TableMeasured { readonly name: string; readonly about: string; readonly of: 'reads' | 'carried'; readonly only?: readonly string[] }

/** The table of the records carried at twice the company's first size, beside a table of them at its first size. */
const atTwice = (t: TableMeasured): TableMeasured => {
  const about = t.about.replace(/at its first size\.$/u, 'at twice its first size.');
  if (about === t.about) throw new Error(`the table ${t.name} does not say it is of the company at its first size`);
  return { ...t, name: `${t.name}_AT_TWICE`, about };
};

/**
 * Counts each action of `runs` on `company`, step by step, at its first size, then again after the company grows to `grown`,
 * as tests of the file that calls it, each named by its action. At the first size each action's reads and records carried
 * are held to `pins`; at twice the size every call count must be the same, every list must carry again what it carried,
 * and every read that names its records must ask the same records of each kind, or one more for each one more the company
 * holds where the action is granted it (`ASKED_GROWS_WITH`, `ASKED_WITH_EVERY_PROPOSAL`). At both sizes every answer carries what the service holds, no step
 * writes a record from an old read, and each run files the roster versions `ROSTER_FILED_AT_EACH_SIZE` holds it to. Then
 * each of `tables` is held to what this run measured, as the pins writer writes it, and beside each table of records
 * carried, the same table at twice the size (named with `_AT_TWICE`).
 */
export function countedAtBothSizes(
  company: Company, runs: Readonly<Record<string, (at: 0 | 1) => Promise<IntentCount>>>, grown: CompanySize,
  pins: { readonly reads: PinnedReads; readonly carried: Readonly<Record<string, readonly number[]>> }, tables: readonly TableMeasured[],
): void {
  const atN = new Map<string, IntentCount>();
  const measured = { reads: {} as Record<string, Reads[]>, carried: {} as Record<string, number[]>, carriedAtTwice: {} as Record<string, number[]> };
  /* The company is grown once, by the first action counted at twice its size. */
  let growing: Promise<void> | null = null;
  const grow = (): Promise<void> => (growing ??= company.growTo(grown));
  const heldAtN = new Map<string, CompanyHeld>();

  for (const [name, run] of Object.entries(runs)) {
    it(`action ${name} is counted, step by step, on the company at its first size`, async () => {
      const { count, roster } = await filedBy(() => run(0));
      heldAtN.set(name, await heldBy(company));
      atN.set(name, count);
      measured.reads[name] = readsOf(count);
      measured.carried[name] = carriedOf(count);
      /*
       * RED WHEN: an action runs no step that reaches the company, by a route of the service or a read of the chain, the
       * builder or the indexer, so its count holds nothing to grow. An action that calls no route is counted by those reads.
       */
      expect(count.steps.every((s) => Object.keys(s.routes).length === 0 && Object.keys(s.asks).length === 0)).toBe(false);
      /* RED WHEN: an action reads differently at the first size than the reads pinned for it. */
      expect(readsOf(count)).toEqual(pins.reads[name]);
      /* RED WHEN: the service's answers to a step carry more or fewer records than were pinned for it. */
      expect(carriedOf(count)).toEqual(pins.carried[name]);
      /* RED WHEN: a step writes a record again from an answer it read before its own earlier write of that record. */
      expect(writesOverAnOldRead(count.log)).toEqual([]);
      /* RED WHEN: an answer carries a record twice, a list carries other than every record of its kind the service holds, or a read carries other than what it asked or other than every version filed of a record read whole. */
      expect(carriedNotAsHeldIn(count.log)).toEqual([]);
      /* RED WHEN: a run files more or fewer versions of the roster at the first size than it changes. */
      expect(roster, `roster versions ${name} filed at the first size`).toBe(ROSTER_FILED_AT_EACH_SIZE[name]?.[0] ?? 0);
    });
  }

  for (const [name, run] of Object.entries(runs)) {
    it(`action ${name} reads the same at twice the company's records, step by step`, async () => {
      /* RED WHEN: the first size of this action was not counted before it, so there is nothing to hold its growth to. */
      expect(atN.has(name), `action ${name} is counted at its first size before it is counted at twice it`).toBe(true);
      await grow();
      const { count: at2N, roster } = await filedBy(() => run(1));
      const held = [heldAtN.get(name)!, await heldBy(company)] as const;
      measured.carriedAtTwice[name] = carriedOf(at2N);
      /* RED WHEN: any route, holders, chain, builder or indexer read of any step of this action is made a different number of times at twice the company's people, vendors, vaults or proposals. */
      expect(differences(name, readsOf(atN.get(name)!), readsOf(at2N), ['at the first size', 'at twice it'])).toEqual([]);
      /* RED WHEN: at twice the records, an answer carries a record twice, a list carries other than every record of its kind, or a read carries other than what it asked or other than every version filed of a record read whole. */
      expect(carriedNotAsHeldIn(at2N.log)).toEqual([]);
      /*
       * RED WHEN: a read that names its records asks more or fewer of a kind at twice the company than at its first
       * size, other than a read granted to the action asking one more for each one more the company holds.
       */
      expect(askedOtherThan(name, atN.get(name)!, at2N, held)).toEqual([]);
      /* RED WHEN: a list carried a record at the first size that the same step's list does not carry at twice it. */
      expect(listedThenNot(atN.get(name)!, at2N)).toEqual([]);
      /* RED WHEN: at twice the records, a step writes a record again from an answer it read before its own earlier write of it. */
      expect(writesOverAnOldRead(at2N.log)).toEqual([]);
      /* RED WHEN: a run files more or fewer versions of the roster at twice the company than it changes: a press that changes nothing files none. */
      expect(roster, `roster versions ${name} filed at twice the size`).toBe(ROSTER_FILED_AT_EACH_SIZE[name]?.[1] ?? 0);
      noteRan(name);
    });
  }

  it('the tables of the pins this run measures are the ones the pins writer writes from it', () => {
    const of = <T>(all: Readonly<Record<string, T>>, t: TableMeasured): Record<string, T> =>
      Object.fromEntries(Object.entries(all).filter(([n]) => t.only?.includes(n) ?? true));
    const rendered = (t: TableMeasured, carried: Readonly<Record<string, number[]>>): PinTable => (t.of === 'reads'
      ? { name: t.name, about: t.about, reads: of(measured.reads, t) } : { name: t.name, about: t.about, carried: of(carried, t) });
    /*
     * RED WHEN: a pin of an action run here is not what this run measured, or the pins file was changed by hand away from
     * what its writer writes; a table of records carried is held at the first size and, as its table at twice, at twice it.
     */
    for (const [t, carried] of tables.flatMap((x) => (x.of === 'reads' ? [[x, measured.carried] as const]
      : [[x, measured.carried] as const, [atTwice(x), measured.carriedAtTwice] as const]))) {
      const everyActionCounted = (t.only ?? Object.keys(runs)).every((n) => Object.hasOwn(carried, n));
      expect(tableHeld(rendered(t, carried), everyActionCounted, t.only), t.name).toBe(tableSource(rendered(t, carried)));
    }
  });
}

/*
 * Writes the pinned counts of the wallet's actions from what the count files measured. The pins file is this writer's
 * output: each count file renders every table it measures, from its own run, through `tableSource`, and holds that table
 * of the file to the render, so a pin that is not what a run measured fails, and a pin is changed only by running the
 * count file that measures it with WRITE_PINS=1, which rewrites that table, or the rows of the actions it counted, from the run.
 */

/** One table of the pins file: its name, what it pins, and either the reads or the records carried, step by step. */
export type PinTable =
  | { readonly name: string; readonly about: string; readonly reads: PinnedReads }
  | { readonly name: string; readonly about: string; readonly carried: Readonly<Record<string, readonly number[]>> };

const PINS_FILE = fileURLToPath(new URL('./action-count-pins.test-support.ts', import.meta.url));

const HEADER = `/*
 * What each wallet action reads, step by step, on the company the count harness makes: every route by name and every read
 * through a door by door and ask, and the records the service's answers to each step carried. Measured on one device that
 * has checked the company before, running the actions in the order the count files run them. A file that counts an action
 * at another size of the company holds its reads to these. Each table is written by the pins writer in the count harness
 * from a run of the count file that measures it, with WRITE_PINS=1; not changed by hand.
 */
`;
const READS = 'Readonly<Record<string, readonly Readonly<Record<string, number>>[]>>';
const CARRIED = 'Readonly<Record<string, readonly number[]>>';

const stepSource = (step: Readonly<Record<string, number>>): string =>
  `{${Object.keys(step).sort().map((k) => `'${k}': ${step[k]}`).join(', ')}}`;
/** The text of one table of the pins file, as the writer writes it. */
export const tableSource = (t: PinTable): string => {
  const rows = 'reads' in t
    ? Object.entries(t.reads).map(([name, steps]) => `  '${name}': [\n${steps.map((s) => `    ${stepSource(s)},\n`).join('')}  ],\n`)
    : Object.entries(t.carried).map(([name, steps]) => `  '${name}': [${steps.join(', ')}],\n`);
  return `/* ${t.about} */\nexport const ${t.name}: ${'reads' in t ? READS : CARRIED} = {\n${rows.join('')}};\n`;
};

/* The text of the table named `name` in the pins file's text, from its comment to its close, or null. */
const tableIn = (file: string, name: string): string | null =>
  new RegExp(`/\\* [^\\n]*\\*/\\nexport const ${name}: [^\\n]*\\n(?:[^\\n]*\\n)*?\\};\\n`, 'u').exec(file)?.[0] ?? null;

/* The rows of a table's text, each by its action's name, in the order the text holds them. */
const rowsIn = (table: string): Map<string, string> =>
  new Map([...table.matchAll(/^ {2}'([^']+)': \[(?:[^\n]*\],\n|\n(?:[^\n]*\n)*? {2}\],\n)/gmu)].map((m) => [m[1]!, m[0]]));
/* A table's text from its opening lines and the rows given, in their order. */
const withRows = (table: string, rows: Iterable<string>): string => `${table.slice(0, table.indexOf('{\n') + 2)}${[...rows].join('')}};\n`;

/**
 * The table named `measured.name` as the pins file holds it, or, when the run counted only some of the table's actions,
 * the rows of the actions it counted, in the order it counted them. With WRITE_PINS=1 the file's table is first written
 * from `measured`: rewritten whole where it stands, or added at the end, when every action of the table was counted; and
 * when only some were, each of their rows rewritten where it stands, or added after the others, and a row of an action
 * not in `holds`, the actions the table holds, dropped. The caller holds what this returns to a second render of its run.
 */
export const tableHeld = (measured: PinTable, everyActionCounted: boolean, holds?: readonly string[]): string | null => {
  const file = readFileSync(PINS_FILE, 'utf8');
  const was = tableIn(file, measured.name);
  const made = tableSource(measured);
  if (process.env['WRITE_PINS'] === '1') {
    const headed = file.replace(/^\/\*[\s\S]*?\*\/\n/u, HEADER);
    const rows = [...new Map([...rowsIn(was ?? ''), ...rowsIn(made)])].filter(([n]) => holds?.includes(n) ?? true).map(([, r]) => r);
    const merged = was === null || everyActionCounted ? made : withRows(made, rows);
    writeFileSync(PINS_FILE, was === null ? `${headed.trimEnd()}\n\n${merged}` : headed.replace(was, merged));
  }
  const held = tableIn(readFileSync(PINS_FILE, 'utf8'), measured.name);
  if (held === null || everyActionCounted) return held;
  const rows = rowsIn(held);
  return withRows(held, [...rowsIn(made).keys()].map((n) => rows.get(n) ?? `  '${n}': not pinned\n`));
};
