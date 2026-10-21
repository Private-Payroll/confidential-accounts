/**
 * **EVERY FILING THIS DEVICE MAKES, ENTERED IN THE COMPANY'S MANIFEST: THE ONE
 * CALL THAT PUTS A RECORD IN THE NEXT BATCH.**
 *
 * A company's records are believed only as the anchor on chain holds them
 * (`record-tree.ts`), and the anchor holds only what the manifest names. So
 * the moment a store has a filing from this device, the filer enters it: the
 * record, its version and the digest of what it signed, signed again by the
 * same seat. Whichever seat's device anchors next covers it.
 *
 * Entered only after the store has the filing, never before: an entry for a
 * filing no store holds would make every device stop at the header that
 * anchors it. A filing whose entry is not kept stays NOT YET ANCHORED - never believed
 * as the newest version - and the filer is told so.
 *
 * Every entry this page signs is also kept on this page (`enteredOnThisPage`)
 * until the anchor holds it, so that whenever this device anchors it enters
 * again any the manifest it is served does not name: an entry the service
 * dropped, or never kept, is not left out of every batch for as long as the
 * service likes. A page loaded afresh keeps nothing from before.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { RunToFile } from '../../../src/core/run-filing.js';
import {
  ENTRIES_AT_ONCE, entryIdOf, manifestPaths, recordKeyOf, runEntry, signManifestEntry, SUPERSEDED, type ManifestEntry, type ManifestEntryBody,
} from '../../../src/midnight/record-manifest.js';
import type { HeadersPage, ProofsAsk, ProofsGiven, RecordName, TreeHeader } from '../../../src/midnight/record-tree.js';

type Api = (path: string, init?: RequestInit & { read?: boolean }) => Promise<any>;

/**
 * The company's manifest, as the service takes entries and says the newest
 * version entered of a record: what a filer numbers its next entry from, and
 * nothing a device believes - a version the service misstates is refused when
 * the entry is entered.
 */
export interface ManifestService {
  newest(accountId: string, records: readonly RecordName[]): Promise<readonly number[]>;
  enter(accountId: string, entries: readonly ManifestEntry[]): Promise<void>;
}

/** The service's manifest routes, over this page's own sign-in. */
export const manifestServiceFor = (api: Api): ManifestService => ({
  newest: async (accountId, records) => {
    if (records.length === 0) return [];
    const m = await api(manifestPaths.newest(accountId), { method: 'POST', body: JSON.stringify({ records }), read: true });
    if (m === null || typeof m !== 'object' || !Array.isArray(m.versions) || m.versions.length !== records.length
      || m.versions.some((v: unknown) => !Number.isSafeInteger(v) || (v as number) < 0)) {
      throw new Error('the service did not answer with the newest version entered of each record asked');
    }
    return m.versions as number[];
  },
  enter: async (accountId, entries) => {
    await api(manifestPaths.entries(accountId), { method: 'POST', body: JSON.stringify({ entries }) });
  },
});

/**
 * **THE COMPANY'S RECORD TREE, AS THE SERVICE SERVES IT**: a page of headers
 * after a batch, one header kept, and one read's proofs against one root in one
 * request. Nothing it answers is believed until this device has checked it.
 */
export interface TreeService {
  headersAfter(accountId: string, seq: number, limit: number): Promise<HeadersPage>;
  /** `entries`: the entries its changes name, kept with it by this device, for a service that no longer holds them. */
  fileHeader(accountId: string, header: TreeHeader, entries?: readonly ManifestEntry[]): Promise<void>;
  /** Null when the service keeps no header that makes the root asked. */
  proofs(accountId: string, ask: ProofsAsk): Promise<ProofsGiven | null>;
  /** Every entry newer than its record's leaf at `root`, as the service says; null when it keeps no header making that root. */
  pending(accountId: string, root: Hex): Promise<readonly unknown[] | null>;
}

/** The service's tree routes, over this page's own sign-in. */
export const treeServiceFor = (api: Api): TreeService => ({
  headersAfter: async (accountId, seq, limit) => {
    const p = await api(`${manifestPaths.treeHeaders(accountId)}?after=${seq}&limit=${limit}`);
    if (p === null || typeof p !== 'object' || !Array.isArray(p.headers) || !Array.isArray(p.entries) || !Array.isArray(p.leaves)) {
      throw new Error('the service did not answer with a page of the company\'s record headers');
    }
    return { headers: p.headers, entries: p.entries, leaves: p.leaves };
  },
  fileHeader: async (accountId, header, entries) => {
    await api(manifestPaths.treeHeaders(accountId), { method: 'POST', body: JSON.stringify(entries === undefined ? { header } : { header, entries }) });
  },
  proofs: async (accountId, ask) => {
    const p = await api(manifestPaths.treeProofs(accountId), { method: 'POST', body: JSON.stringify(ask), read: true });
    if (p?.refused === 'root-not-kept') return null;
    if (p === null || typeof p !== 'object' || !Array.isArray(p.records) || !Array.isArray(p.kinds) || !Array.isArray(p.older)
      || !Array.isArray(p.proof?.siblings)) throw new Error('the service did not answer with the proofs asked for');
    return { records: p.records, kinds: p.kinds, older: p.older, proof: { siblings: p.proof.siblings } };
  },
  pending: async (accountId, root) => {
    const p = await api(`${manifestPaths.treePending(accountId)}?root=${root}`);
    if (p?.refused === 'root-not-kept') return null;
    if (p === null || typeof p !== 'object' || !Array.isArray(p.entries)) throw new Error('the service did not answer with the entries not yet anchored');
    return p.entries;
  },
});

/** A filing to enter: an entry, or a run, whose version is the count of its entries so far. */
export type Filed = ManifestEntryBody | { readonly store: 'run'; readonly run: RunToFile };

/**
 * Thrown when a filing was kept by its store and its entry was not. `again` is
 * what puts it in the company's records, when that is not filing it again.
 */
export class FiledNotEntered extends Error {
  constructor(readonly why: string, options?: { cause?: unknown; again?: string }) {
    super(`this was filed, and its entry in the company's records was not kept (${why}), so no other device believes it as `
      + `the newest version yet. ${options?.again ?? 'Reload the page and do it again: what is filed again is entered.'}`,
    options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FiledNotEntered';
  }
}

/** The one call, bound to a company and the seat filing for it. */
export interface RecordsEntered {
  enter(filed: readonly Filed[]): Promise<void>;
}

/* Per company, every entry this page signed, by its id, until the anchor holds it. */
const kept = new Map<string, Map<Hex, ManifestEntry>>();

/** Every entry this page signed for `accountId` and has not let go of, in the order it signed them. */
export const enteredOnThisPage = (accountId: string): readonly ManifestEntry[] => [...(kept.get(accountId)?.values() ?? [])];

/** Lets go of every entry this page signed for `accountId` that `held` says the company's records now hold. */
export const letGoOfEntered = (accountId: string, held: (e: ManifestEntry) => boolean): void => {
  const mine = kept.get(accountId);
  if (mine === undefined) return;
  for (const [id, e] of mine) if (held(e)) mine.delete(id);
};

/** A store's own refusal of an entry, or the service's, in the words the filer is told. */
const why = (e: unknown): string => (e as Error)?.message ?? String(e);

/**
 * **THE ONE CALL EVERY FILER MAKES** once its store has the filing. A run is
 * kept whole and changed in place, so its version is read from the manifest:
 * the one after the newest entry the run has.
 */
export const recordsEnteredFor = (
  manifest: ManifestService, accountId: string, signingSecret: Hex,
  /**
   * Why this seat files nothing more, or null: a removal of its own seat is approved (`ownRemovalApprovedHere`), so what
   * it would enter now falls past the boundary its retirement keeps. Absent, nothing stops it.
   */
  stops?: () => Promise<string | null>,
): RecordsEntered => ({
  enter: async (filed) => {
    if (filed.length === 0) return;
    const stopped = stops === undefined ? null : await stops();
    if (stopped !== null) {
      throw new FiledNotEntered(stopped, { again: 'A signer who stays files it again under their own seat.' });
    }
    let bodies: ManifestEntryBody[];
    try {
      const runs = filed.filter((f): f is { store: 'run'; run: RunToFile } => 'run' in f);
      const names = [...new Map(runs.map((f) => [f.run.id, { store: 'run' as const, kind: 'run', id: f.run.id }])).values()];
      const versions = await manifest.newest(accountId, names);
      const newest = new Map(names.map((r, i) => [recordKeyOf(r), versions[i]!] as const));
      bodies = filed.map((f) => {
        if (!('run' in f)) return f;
        const key = recordKeyOf({ store: 'run', kind: 'run', id: f.run.id });
        const version = (newest.get(key) ?? 0) + 1;
        newest.set(key, version);
        return runEntry(accountId, f.run, version);
      });
      const signed = bodies.map((b) => signManifestEntry(accountId, b, signingSecret));
      /* Kept before it is sent: the store already has the filing, so an entry the service then drops is entered again. */
      const mine = kept.get(accountId) ?? kept.set(accountId, new Map()).get(accountId)!;
      for (const e of signed) mine.set(entryIdOf(e), e);
      for (let i = 0; i < signed.length; i += ENTRIES_AT_ONCE) await manifest.enter(accountId, signed.slice(i, i + ENTRIES_AT_ONCE));
    } catch (e) {
      /* A later version of the record entered first: this one was superseded, and filing it again can never enter it. */
      throw new FiledNotEntered(why(e), why(e).includes(SUPERSEDED)
        ? { cause: e, again: 'It was superseded and will never be anchored: read the record again for the version that stands.' }
        : { cause: e });
    }
  },
});

/** The one filing call over this page's own sign-in, for a company and the seat filing for it. */
export const recordsEnteredOver = (api: Api, accountId: string, signingSecret: Hex, stops?: () => Promise<string | null>): RecordsEntered =>
  recordsEnteredFor(manifestServiceFor(api), accountId, signingSecret, stops);
