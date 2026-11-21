/**
 * **THE ANCHORING AND THE FILING AGAIN A SEAT ACTION DOES ON ITS WAY IN AND AT
 * ITS END.** After a seat action it anchors at once what the action left
 * waiting, anchors unasked a company's records that have waited a day with
 * nothing of the directory waiting, and files again a directory entry or a
 * quorum's change the service no longer gives, so no change the seat made is
 * lost to a device that stopped half way.
 */
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { WITNESSED_AS } from '../../../src/midnight/record-manifest.js';
import { mayFile, type QuorumChange, type SignedChange } from '../../../src/midnight/seat-directory.js';
import { directoryNotYetAnchored, type DirectoryBelieved } from './vault-page-doors.js';
import type { KeptDirectoryChange } from './tree-kept-here.js';
import { anchorTheRecordsHere, AnchorNotMade, type Anchored, type AnchorDoors } from './records-anchored-here.js';
import { freshViewAfter, heldHere, throughTheView } from './anchored-through-the-view.js';

/** How long a company's records may wait, with nothing of the directory waiting, before the anchor at a seat action's end anchors them unasked. */
export const ANCHORED_AT_LEAST_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * What the anchor at a seat action's end did: anchored now (none when nothing
 * was waiting), left for later and why, or not anchored and why - in words
 * that say what resolves it. Never thrown: the action it ends is never undone
 * by it, and a filing left waiting is anchored by the next.
 */
type OnTheWayIn =
  | (Anchored & FiledAgainOnTheWayIn)
  | { readonly waits: 'anchored-within-a-day' | 'this-seat-does-not-anchor' }
  | ({ readonly notAnchored: string } & FiledAgainOnTheWayIn);

/** What the anchor filed again before it anchored at once: this seat's own entry, or signed changes passed over. */
interface FiledAgainOnTheWayIn { readonly filedAgain?: 'own-entry' | 'directory-changes' }

/**
 * **THIS SEAT'S OWN DIRECTORY ENTRY, PASSED OVER BY THE COMPANY'S RECORDS, FILED
 * AGAIN AS A NEW VERSION**: its entry was filed and never entered while a later
 * version was anchored, so no device applies it and this seat is not believed.
 * Its wallet's statement does not name a version, so the same entry is filed as
 * the directory's next version and is anchored like any other. Only an entry
 * whose statement names this seat's own signing key, and only while the
 * directory this device believes holds no seat for that key. True when filed.
 */
async function ownEntryFiledAgain(given: AnchorDoors, here: DirectoryBelieved): Promise<boolean> {
  const doors = throughTheView(given);
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  if (doors.fileDirectory === undefined || here.dir.seats.some((x) => x.signingKey === mine)) return false;
  const own = (here.passedOver ?? []).filter((f) => f.change.kind === 'claim' && f.change.entry.statement.signingKey.toLowerCase() === mine);
  if (own.length === 0) return false;
  const filings = await doors.directoryFilings();
  await doors.fileDirectory({ company: doors.accountId, version: filings.length + 1, change: own[own.length - 1]!.change });
  return true;
}

/**
 * **A SIGNED CHANGE TO THE COMPANY'S DIRECTORY, FILED FROM THIS DEVICE AND
 * ANCHORED AT ONCE** - a quorum's retirement, or one seat's change of
 * the company's key - carrying its signatures over `signedFor`, the version it
 * was signed for. A quorum's change is kept in this device's database before it is
 * filed, and let go of only once a version carrying it is anchored, so a
 * change the service drops, passes over or stops serving is filed again from
 * here by a later anchor (`quorumChangesFiledAgain`) without being signed
 * again. A change of key is never kept: one lost or passed over is made again
 * on the key the directory holds. Refused, with nothing filed or kept, when the directory already holds
 * that version: the signatures bind it, so the change is signed again as the
 * directory stands. The anchor is said, not thrown: a change filed and not yet
 * anchored is anchored by the next anchor, and a quorum's is kept until it is.
 */
export async function directoryChangeFiledHere(
  given: AnchorDoors, change: SignedChange, signedFor: number,
): Promise<{ readonly version: number; readonly anchor: Anchored | { readonly notAnchored: string } }> {
  const doors = throughTheView(given);
  if (doors.fileDirectory === undefined) {
    throw new AnchorNotMade('this page cannot file a change to the company\'s directory. Nothing was filed. Reload the page to get the '
      + 'current version');
  }
  const filings = await doors.directoryFilings();
  if (filings.length + 1 !== signedFor) {
    throw new AnchorNotMade(`the change was signed for version ${signedFor} of the company's directory, and the directory holds `
      + `${filings.length} version${filings.length === 1 ? '' : 's'} now, so its signatures do not fit the next one. Nothing was filed. `
      + 'Have it signed again as the directory stands now');
  }
  /* A quorum's change is kept before it is filed, so a filing that fails, or that the service later drops, is filed again from here. */
  if (change.kind !== 'rotate') await doors.changes?.keep(doors.accountId, { signedAt: signedFor, change });
  await doors.fileDirectory({ company: doors.accountId, version: signedFor, change });
  try {
    return { version: signedFor, anchor: await anchorTheRecordsHere(given) };
  } catch (e) {
    if (!(e instanceof AnchorNotMade)) throw e;
    return { version: signedFor, anchor: { notAnchored: e.message } };
  }
}

/**
 * **EVERY QUORUM'S CHANGE TO THE DIRECTORY NOT APPLIED, FILED AGAIN UNDER
 * ITS OWN SIGNATURES**, by a device whose seat may anchor: each change the company's
 * records passed over - or that rests on a seat one passed over - and each this
 * device kept from filing it again before, oldest version signed for first, as
 * the directory's next versions, each only when the replay would believe it
 * there (`refiledRefusalOf`). Each is kept in this device's database before it
 * is filed, and let go of once a version carrying it is anchored, so a change
 * the service passes over again or stops serving is filed again by a later
 * anchor. What the replay refuses is said by `passedOverSaid`. How many it filed.
 */
async function quorumChangesFiledAgain(given: AnchorDoors, here: DirectoryBelieved): Promise<number> {
  const doors = throughTheView(given);
  if (doors.fileDirectory === undefined || here.refiled === undefined) return 0;
  /* Only a quorum's change is filed again: a change of key a store hands back is never a candidate. */
  const all = (await doors.changes?.all(doors.accountId) ?? [])
    .filter((k): k is { readonly signedAt: number; readonly change: QuorumChange } => k.change.kind === 'retire');
  for (const k of all) if (here.anchoredAgain?.has(k.signedAt) === true) await doors.changes!.letGo(doors.accountId, k.signedAt);
  const kept = all.filter((k) => here.anchoredAgain?.has(k.signedAt) !== true);
  /* One kept before its first filing reached the service: its version is still the next, so it is filed as that version. */
  const next = kept.find((k) => k.signedAt === here.dir.version + 1);
  if (next !== undefined) {
    try { await doors.fileDirectory({ company: doors.accountId, version: next.signedAt, change: next.change }); } catch (e) { goesOnFresh(given, e); return 0; }
    return 1;
  }
  const waiting = new Map<number, { readonly signedAt: number; readonly change: QuorumChange }>((here.notApplied ?? []).map((n) => [n.signedAt, n]));
  /* A change this device kept is a candidate too - one the service no longer serves included; the replay refuses one already applied. */
  for (const k of kept) if (!waiting.has(k.signedAt)) waiting.set(k.signedAt, k);
  const { filed } = here.refiled([...waiting.values()].sort((a, b) => a.signedAt - b.signedAt));
  let n = 0;
  for (const f of filed) {
    await doors.changes?.keep(doors.accountId, { signedAt: f.signedAt!, change: f.change as KeptDirectoryChange['change'] });
    /* One the service refuses, or another filing raced, stays kept for a later anchor; this one is not held back by it. */
    try { await doors.fileDirectory(f); } catch (e) { goesOnFresh(given, e); break; }
    n += 1;
  }
  return n;
}

/** A filing again refused is kept for a later anchor, and the step goes on from a fresh view: the refusal ended the one it read. */
const goesOnFresh = (doors: AnchorDoors, e: unknown): void => {
  freshViewAfter(doors, `a change filed again was refused (${(e as Error)?.message ?? String(e)})`);
};

/** Anchors what was just filed again, saying what it filed; a refusal is said, never thrown. */
async function anchoredAtOnce(doors: AnchorDoors, filedAgain: NonNullable<FiledAgainOnTheWayIn['filedAgain']>): Promise<OnTheWayIn> {
  try {
    return { ...(await anchorTheRecordsHere(doors)), filedAgain };
  } catch (e) {
    return { notAnchored: (e as Error)?.message ?? String(e), filedAgain };
  }
}

/* One such anchor at a time per company on this device: a second asked for while one runs waits on it. */
const onTheWayIn = new Map<string, Promise<OnTheWayIn>>();

/**
 * **THE ANCHOR A SEAT ACTION ASKS FOR, AFTER WHAT IT OWES IS FILED AGAIN.** A
 * seat whose role may anchor files again its own entry or a quorum's change the
 * company's records passed over, then anchors every filing not yet anchored when
 * the account's last anchor call landed a day ago or more - or never - and at
 * once whenever a directory version is applied and not yet anchored, since a rise
 * of the account's threshold waits for it (`directoryNotYetAnchored`). When it
 * landed is the time the author of its block set, as the account's history at
 * the indexer the person's own wallet names holds it, never a time a seat
 * wrote; a time ahead of this device's clock holds nothing off. A directory version
 * no entry names yet is witnessed then, as every anchor witnesses it, so a
 * change of seats waits no longer than a filing. Nothing waiting sends nothing.
 * Within the day it waits: a seat action that must anchor its own filings
 * anchors them itself (`anchorTheRecordsHere`) when this waits.
 */
export function anchoredOnTheWayIn(doors: AnchorDoors): Promise<OnTheWayIn> {
  const running = onTheWayIn.get(doors.accountId);
  if (running !== undefined) return running;
  const now = doors.now ?? (() => new Date());
  const attempt = (async (): Promise<OnTheWayIn> => {
    try {
      const here = await throughTheView(doors).directory();
      /* A change filed is anchored at once by the device that filed it, so a later change of who holds the account cannot leave it unanchored under a threshold it was not signed at. */
      if (await ownEntryFiledAgain(doors, here)) return await anchoredAtOnce(doors, 'own-entry');
      const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
      const seat = here.dir.seats.find((x) => x.signingKey === mine);
      if (seat === undefined || seat.retired !== null || !mayFile(seat).includes(WITNESSED_AS)) {
        return { waits: 'this-seat-does-not-anchor' };
      }
      /*
       * Filing changes again holds nothing back: this goes on to anchor when one is due, with the directory read
       * again, so a service that passes a change over again and again cannot put the company's anchor off with it.
       */
      if (await quorumChangesFiledAgain(doors, here) > 0) return await anchoredAtOnce(doors, 'directory-changes');
      const { landed, records } = await heldHere({ ...doors, directory: async () => here }, {});
      /* When the account's last anchor call landed: the time its block's author set, as the account's history holds it. */
      const last = landed.length === 0 ? Number.NaN : landed[landed.length - 1]!.at;
      const since = now().getTime() - last;
      if (records.stopped === null && Number.isFinite(since) && since >= 0 && since < ANCHORED_AT_LEAST_EVERY_MS
        && directoryNotYetAnchored({ dir: here.dir, records, refusedAt: here.refusedAt }).length === 0) {
        return { waits: 'anchored-within-a-day' };
      }
      return await anchorTheRecordsHere(doors);
    } catch (e) {
      return { notAnchored: (e as Error)?.message ?? String(e) };
    }
  })().finally(() => { onTheWayIn.delete(doors.accountId); });
  onTheWayIn.set(doors.accountId, attempt);
  return attempt;
}
