/**
 * **THE CHECK BEFORE A VIEW WRITES OR SENDS: DID ANOTHER SIGNER CHANGE THE COMPANY SINCE IT WAS READ?** A view reads
 * once and keeps what it read, so a change another signer makes meanwhile would go unseen: a record sealed to a seat
 * just removed, a payment into a vault no longer adopted, a run drawn from a person since changed. Before every batch
 * of writes, and before every send that goes straight to the chain, the view reads three things again and compares
 * each with what it read: the newest version of the company's directory, who holds the company on the chain (its
 * seats, approvals and adopted vaults), and the newest version entered of the read grants and of every record the view
 * served. Anything moved: the step stops before anything is written or sent, and says so.
 *
 * Another seat filing an ordinary record moves none of them unless the view served that record. The view's own writes
 * move the baseline by exactly what the service took for them (`acknowledged`), so a change by someone else landing at
 * the same moment is never taken as the view's own.
 */
import { recordKeyOf, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import type { RecordName } from '../../../src/midnight/record-tree.js';
import type { DirectoryFiling } from '../../../src/midnight/seat-directory.js';
import { GRANTS_RECORD } from '../../../src/midnight/grants-record.js';
import { inParts } from './company-view-batch.js';
import { LANDED_EVERY_MS, LANDED_WITHIN_MS } from './watched-on-the-chain.js';
import type { RecordSource, RecordWrite } from './records-source.js';

/** What the person is told when the check finds the company changed: the step sent nothing, and is run again. */
export const ANOTHER_SIGNER_CHANGED = 'Another signer changed the company while this ran, so nothing was written or sent. Run it again.';

/** Why a view the check found changed was ended: a step that sees its view ended for this stops, whatever caught the refusal. */
export const ENDED_BY_ANOTHER_SIGNER = 'another signer changed the company';

/**
 * What the check compares of who holds the company: its seats, the approvals it needs, the vaults it has adopted, its
 * maintenance committee and that committee's threshold, each vault's own threshold and the bar a spending policy needs.
 */
export interface HoldersStanding {
  readonly seats: readonly string[];
  readonly approvals: number;
  readonly adoptedVaults: readonly string[];
  readonly threshold: number;
  readonly committee: readonly { readonly tag: string; readonly value: string }[];
  readonly vaultThresholds: readonly { readonly vault: string; readonly threshold: number }[];
  readonly policyBar: number | null;
}

const asSet = (items: readonly string[]): readonly string[] => [...new Set(items.map((x) => x.toLowerCase()))].sort();

/**
 * Who holds the company, written so two reads compare equal exactly when nothing `HoldersStanding` names moved: the one
 * rule every view checks by, whoever reads the holders for it. The order a read lists seats, vaults or committee keys
 * in, and the case of their hex, move nothing.
 */
export const holdersStandingOf = (held: HoldersStanding): string => JSON.stringify([
  asSet(held.seats), held.approvals, asSet(held.adoptedVaults), held.threshold, asSet(held.committee.map((c) => `${c.tag}:${c.value}`)),
  asSet(held.vaultThresholds.map((v) => `${v.vault}:${v.threshold}`)), held.policyBar,
]);

/** How a send moves who holds the company: the holders it leaves, from the holders read just before it. */
export type HoldersMove = <H extends HoldersStanding>(before: H) => H;

/** A send into a vault the company's account does not adopt now; nothing was sent into it. */
export class VaultNotAdopted extends Error {
  constructor(readonly vault: string) {
    super(`the company's account no longer adopts the vault ${vault}, so nothing was sent into it.`);
    this.name = 'VaultNotAdopted';
  }
}

/** Whether `holders` adopt `vault`. */
export const adopts = (holders: Pick<HoldersStanding, 'adoptedVaults'>, vault: string): boolean =>
  holders.adoptedVaults.some((v) => v.toLowerCase() === vault.toLowerCase());

/** The company changed since the view read it; nothing of the step was written or sent. `moved` names what moved. */
export class CompanyChangedMeanwhile extends Error {
  constructor(readonly moved: readonly string[]) {
    super(ANOTHER_SIGNER_CHANGED);
  }
}

/** The company's read grants, which every check asks about whether or not the view served them. */
export const GRANTS_NAME: RecordName = Object.freeze({ store: 'company', kind: GRANTS_RECORD.kind, id: GRANTS_RECORD.id });

/** The newest version of the directory: its newest filing's version, or 0 for none. */
export const directoryVersionOf = (filings: readonly DirectoryFiling[]): number => filings.reduce((n, f) => Math.max(n, f.version), 0);

/**
 * What the view read, as the check compares it. The view takes the directory's version, who holds the company and the
 * read grants' newest version before it answers its first read (`company-view.ts`), so every check has all three.
 */
export class Baseline {
  directory: number | null = null;
  holders: string | null = null;
  /** Who held the company before this side's own send moved it, until a fresh read shows the move. */
  lagging: string | null = null;
  private readonly records = new Map<string, { readonly name: RecordName; version: number }>();

  /**
   * The same reading, for a view opened again after its own side's send: what was read before the send is still what
   * the next check compares against, so a change by another signer meanwhile is never taken in as the new reading.
   */
  copy(): Baseline {
    const next = new Baseline();
    next.directory = this.directory;
    next.holders = this.holders;
    next.lagging = this.lagging;
    for (const [key, r] of this.records) next.records.set(key, { name: r.name, version: r.version });
    return next;
  }

  /**
   * Moves who holds the company by this side's own send, declared by the step that sent it: `to` is what the next check
   * compares with, and the reading before it is kept while the chain's indexer may not show the send yet.
   */
  moveHolders(to: string): void {
    if (this.holders === to) return;
    this.lagging = this.holders;
    this.holders = to;
  }

  /** The newest version entered of `name`, as the view served it. A record served twice keeps the first it served. */
  served(name: RecordName, version: number): void {
    const key = recordKeyOf(name);
    if (!this.records.has(key)) this.records.set(key, { name, version });
  }

  /**
   * A record a step before this one read at `version`, as what that step made is filed by this one: the next check
   * compares with the lower of that version and what this view served of it, so a change since either read stops the
   * write, and a read before can only make the check stricter, never pass a change this view's own read would stop.
   */
  readBefore(name: RecordName, version: number): void {
    const key = recordKeyOf(name);
    const there = this.records.get(key);
    this.records.set(key, { name, version: there === undefined ? version : Math.min(there.version, version) });
  }

  /** Every record whose newest version the check asks for: the read grants first, then every record served. */
  names(): readonly RecordName[] {
    const grants = recordKeyOf(GRANTS_NAME);
    return [GRANTS_NAME, ...[...this.records].filter(([k]) => k !== grants).map(([, r]) => r.name)];
  }

  versionOf(name: RecordName): number | undefined { return this.records.get(recordKeyOf(name))?.version; }

  /**
   * Moves the baseline by one of the view's own writes, and only by a step it alone can account for: a directory
   * filing at exactly the next version; an entry of a record the view served, entered alone or, when this seat filed it
   * (`filer`, its filing key), carried by a header this device files again, at exactly the next version of it, the
   * versions of one write taken in ascending order; and an entry of the directory at any version up to the one the view
   * read, since a version passed over is never entered and the directory's own version is checked from its filings. No
   * other write moves it, a proven call or another seat's entry a header carries among them. Any other version that
   * jumps is not taken as the view's own, so the next check stops on it.
   */
  acknowledged(w: RecordWrite, filer: string | null = null): void {
    if (w.to === 'directory' && this.directory !== null && w.filing.version === this.directory + 1) this.directory = w.filing.version;
    if (w.to !== 'entries' && w.to !== 'header') return;
    const own = (e: ManifestEntry): boolean => w.to === 'entries' || (filer !== null && e.filedBy.publicKey.toLowerCase() === filer.toLowerCase());
    for (const e of [...(w.entries ?? [])].filter(own).sort((a, b) => a.version - b.version)) {
      const there = this.records.get(recordKeyOf(e));
      if (there === undefined || e.version <= there.version) continue;
      const read = e.store === 'directory' && this.directory !== null && e.version <= this.directory;
      if (e.version === there.version + 1 || read) there.version = e.version;
    }
  }
}

/** What the check reads afresh: the source, and who holds the company now as the view's door reads it. */
interface ProbeReads<H extends HoldersStanding> {
  readonly source: RecordSource;
  readonly holdersNow: () => Promise<H>;
  /** How the check waits between reads of who holds the company; a test passes its own. */
  readonly pause?: (ms: number) => Promise<void>;
}

const paused = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Who holds the company now. While a fresh read still shows it as it was before this side's own send moved it, the
 * chain's indexer has not shown that send yet: it is read again, as often and as long as a call sent is waited for on
 * the chain (`watched-on-the-chain.ts`), until it shows the move. Still not shown after that, the read stands, and the
 * check stops on it; shown, the reading before the send is no longer taken for the indexer's lag.
 */
async function holdersCaughtUp<H extends HoldersStanding>(reads: ProbeReads<H>, base: Baseline, first: H): Promise<{ readonly holders: H; readonly waited: boolean }> {
  let now = first;
  let waited = 0;
  for (; base.lagging !== null && holdersStandingOf(now) === base.lagging && waited < LANDED_WITHIN_MS; waited += LANDED_EVERY_MS) {
    await (reads.pause ?? paused)(LANDED_EVERY_MS);
    now = await reads.holdersNow();
  }
  if (holdersStandingOf(now) === base.holders) base.lagging = null;
  return { holders: now, waited: waited > 0 };
}

/** The directory's filings and the newest version of each record named, read now. */
const readNow = <H extends HoldersStanding>(reads: ProbeReads<H>, names: readonly RecordName[]) =>
  Promise.all([reads.source.filings(), inParts(names, (part) => reads.source.newest(part))]);

/**
 * Reads the three things again, in three requests and one more for each `READ_AT_ONCE` records past the first part,
 * and refuses with `CompanyChangedMeanwhile` when any of them moved since `base` was taken (who holds the company
 * waited for while the indexer does not show this side's own send yet, `holdersCaughtUp`, and the directory and the
 * records read again after any such wait, so a change made while it waited is seen); otherwise answers who holds the
 * company as it read it.
 */
export async function probe<H extends HoldersStanding>(reads: ProbeReads<H>, base: Baseline): Promise<H> {
  if (base.directory === null || base.holders === null) throw new Error('the company was not read before this check, so nothing is written or sent');
  const names = base.names();
  const [first, read] = await Promise.all([readNow(reads, names), reads.holdersNow()]);
  const { holders, waited } = await holdersCaughtUp(reads, base, read);
  const [filings, newest] = waited ? await readNow(reads, names) : first;
  const moved: string[] = [];
  if (base.directory !== directoryVersionOf(filings)) moved.push('the company\'s directory');
  if (base.holders !== holdersStandingOf(holders)) moved.push('who holds the company on the chain');
  names.forEach((name, i) => {
    const was = base.versionOf(name);
    if (was !== undefined && was !== newest[i]) moved.push(`${name.kind} ${name.id}`);
  });
  if (moved.length > 0) throw new CompanyChangedMeanwhile(moved);
  return holders;
}
