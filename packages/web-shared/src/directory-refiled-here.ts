/**
 * **WHAT A DIRECTORY REPLAYED AGAINST THE COMPANY'S RECORDS LEAVES TO SAY AND TO FILE AGAIN**: the check that the
 * directory served holds every version the records anchor, byte for byte; the quorum changes the replay did not apply;
 * the changes filed again that it refused; and how changes kept to be filed again would be filed, in order. Each is
 * worked out from a replay `directoryWithItsRecordsHere` (vault-page-doors.ts) made, and reads nothing itself.
 */
import { directoryEntry } from '../../../src/midnight/record-manifest.js';
import {
  directoryReplayed, seatsChangedBy,
  type AccountHeld, type DirectoryFiling, type DirectoryRefusalCode, type DirectoryReplayKept, type DirectoryReplayed, type QuorumChange,
} from '../../../src/midnight/seat-directory.js';
import type { DirectoryHere, DirectoryHereDeps, HeldAsAnchored } from './vault-page-doors.js';

type HoldersHere = Awaited<ReturnType<DirectoryHereDeps['holders']>>;
type AnchoredHere = Awaited<ReturnType<DirectoryHereDeps['anchored']>>;
type KeptChange = { readonly signedAt: number; readonly change: QuorumChange };

/**
 * **THE DIRECTORY SERVED IS AT LEAST THE ONE ANCHORED, BYTE FOR BYTE.** A
 * service serving it older than a version the anchor holds, or other bytes at
 * one, would have a seat believed or not on a directory nobody filed.
 */
export function servedAtLeastAnchored(filings: readonly DirectoryFiling[], records: Pick<AnchoredHere, 'directory'>, directoryServed: AnchoredHere['directoryServed']): void {
  const found = [...records.directory].find(([v, d]) => filings[v - 1] === undefined || directoryEntry(filings[v - 1]!).digest !== d.digest);
  const back = found === undefined ? directoryServed
    : { version: found[0], without: filings[found[0] - 1] === undefined };
  if (back !== undefined) {
    throw new Error(`the company's directory was served ${back.without ? 'without' : 'with other bytes at'} `
      + `version ${back.version}, which the company's records anchor on chain, so no seat in it is believed. Reload the page; if it `
      + 'happens again, the service is withholding the company\'s directory');
  }
}

/**
 * A quorum's change not applied, by the version it was signed for: filed again only as this replay would believe it.
 * A change of key is left out, since it is never filed again.
 */
export function notAppliedIn(filings: readonly DirectoryFiling[], replayed: DirectoryReplayed): DirectoryHere['notApplied'] {
  const notApplied = new Map<number, QuorumChange>();
  for (const f of filings) {
    const at = f.signedAt ?? f.version;
    if (f.change.kind === 'retire' && !replayed.replay.applied.has(at) && !notApplied.has(at)) notApplied.set(at, f.change);
  }
  return [...notApplied].sort(([a], [b]) => a - b).map(([signedAt, change]) => ({ signedAt, change }));
}

/** Each change filed again that the replay refused on its own merits; one passed over is said as passed over. */
export const refiledRefusedIn = (filings: readonly DirectoryFiling[], replayed: DirectoryReplayed): DirectoryHere['refiledRefused'] => filings.flatMap((f) => {
  const why = replayed.refused.get(f.version);
  return f.signedAt === undefined || why === undefined || replayed.replay.passed.has(f.version) ? [] : [{ version: f.version, signedAt: f.signedAt, why }];
});

/**
 * How changes kept to be filed again would be filed, in order, each replayed on from the directory as judged against the
 * records after the last filing served: filed, refused (by the version each was signed for), or waiting for a seat's
 * own entry that was passed over to be filed again.
 */
export function refilerOf(
  deps: DirectoryHereDeps, filings: readonly DirectoryFiling[], passedOver: readonly DirectoryFiling[],
  { holders, judge, now, held, replayed }: { holders: HoldersHere; judge: Parameters<typeof directoryReplayed>[4]; now: AccountHeld; held: HeldAsAnchored | undefined; replayed: DirectoryReplayed },
): DirectoryHere['refiled'] {
  /* A change resting on a seat whose own entry was passed over: it names that seat, or that seat's key signed it. */
  const passedClaims = passedOver.flatMap((f) => (f.change.kind === 'claim' ? [f.change.entry.statement] : []));
  const restsOnAnEntry = (c: KeptChange) => passedClaims.some((st) => seatsChangedBy(c.change).includes(st.seat)
    || (Array.isArray(c.change.signatures)
      && c.change.signatures.some((x) => x?.publicKey?.toLowerCase() === st.signingKey.toLowerCase())));
  /* The replay judged against the records, as it stood after the last filing served: what each change filed again goes on from. */
  const afterServed: DirectoryReplayKept = {
    upTo: filings.length, dir: replayed.dir, refused: replayed.refused,
    applied: replayed.replay.applied, passed: replayed.replay.passed, changed: replayed.replay.changed,
  };
  return (changes: readonly KeptChange[]) => {
    const filed: DirectoryFiling[] = [];
    let before = afterServed;
    const refused = new Map<number, DirectoryRefusalCode>();
    const waiting = new Set<number>();
    /* The seats a change waiting for a seat's own entry holds back. */
    const heldBack = new Set<string>();
    for (const c of changes) {
      /*
       * One that waits for a seat's own entry to be filed again holds back every later change to its own seat, so one
       * seat's changes are filed again in their first order once it is: filed past it, the waiting one would undo a later
       * change to its seat. A change to another seat is never held back by it.
       */
      const seats = seatsChangedBy(c.change);
      if (seats.some((x) => heldBack.has(x))) { waiting.add(c.signedAt); continue; }
      const f: DirectoryFiling = { company: deps.accountId, version: filings.length + filed.length + 1, change: c.change, signedAt: c.signedAt };
      const tried = directoryReplayed(deps.accountId, [...filings, ...filed, f], deps.label, holders.account, judge, now, held, { from: before, keepAt: f.version });
      const why = tried.refused.get(f.version);
      if (why === undefined) { filed.push(f); before = tried.kept!; continue; }
      if ((why === 'no-such-seat' || why === 'below-quorum') && restsOnAnEntry(c)) {
        for (const x of seats) heldBack.add(x);
        waiting.add(c.signedAt);
        continue;
      }
      refused.set(c.signedAt, why);
    }
    return { filed, refused, waiting };
  };
}
