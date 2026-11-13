/*
 * WHO IS LEAVING THE COMPANY, AS THE WALLET'S OWN ACTS READ IT. A seat is leaving once a removal of it is approved on
 * the chain at the seat bar, or its retirement is anchored; a removal only raised stops nobody. The proposals are read
 * from the service and opened here, and where each stands is read from the chain through this wallet's indexer. Two
 * doors come from the one read: what stops this seat entering anything more, and the boundary each leaving seat keeps
 * for the anchor.
 */
import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import {
  governedCallServiceFor, leavingBoundariesHere, LeavingNotRead, type LeavingReads,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { FiledNotEntered } from '../../../../packages/web-shared/src/record-entered-here.js';
import { RosterNotBelieved } from '../../../../packages/web-shared/src/roster-here.js';
import type { LeavingBoundaries } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { CompanyReach } from './company-reach.js';
import { ActionStopped } from './run.js';

type Api = CompanyReach['api'];
type KeysHeld = Parameters<typeof leavingBoundariesHere>[1];

/**
 * The company's roster as the directory's attestations are read with it, or none while this device does not believe the
 * roster it was given: who is leaving is read from the seats, their retirements and the chain, which the roster does not
 * change, and a roster filed and not yet entered must not stop its own entry by stopping this read.
 */
const rosterOrNoneFor = (r: CompanyReach) => async (): Promise<{ readonly signers: Awaited<ReturnType<CompanyReach['roster']>>['signers'] }> => {
  try {
    return await r.roster();
  } catch (e) {
    if (e instanceof RosterNotBelieved) return { signers: [] };
    throw e;
  }
};

/**
 * The reads who is leaving is worked out from: the company's proposals, its directory, and the chain's rounds. A
 * removal's filer is judged here without asking whether its own wallet attested its records key: this read wraps
 * nothing to that key and uses only the removal's seat and boundary, while whether the removal holds is the chain's
 * count of approvals at the seat bar. So a roster this device does not believe, which attests nobody, never hides an
 * approved removal; every other check on the filing still holds.
 */
export const leavingReadsOf = (r: CompanyReach, api: Api = r.api): LeavingReads => {
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, rosterOrNoneFor(r));
  return {
    service: governedCallServiceFor(api),
    accountId: r.accountId,
    records: {
      directory: async (asked) => ({ ...await directory(asked), another: new Set<string>() }),
      roundsOnChain: async (chainIds: readonly string[]) => r.builder.roundsOnChain({
        account: r.account, indexer: r.chain.indexer, chainIds, seat: r.seat.signingSecret,
      }),
    },
    leaves: r.judges.leavesFor(r.account),
  };
};

/** Who is leaving as read, and why a proposal was passed over in reading it, or null when none was. */
export interface LeavingRead {
  readonly boundaries: LeavingBoundaries;
  readonly passedOver: string | null;
}

/**
 * **EACH LEAVING SEAT'S FILING KEY AND THE BOUNDARY ITS LEAVING KEEPS**, read strictly: an unread chain, an unread
 * list of proposals or an unread seat bar throws `LeavingNotRead`, never answers nobody leaving. A proposal that
 * does not open on this wallet is passed over once the seat bar is read, because it cannot be known to remove anyone
 * and only its raiser or the super admins can clear it, and `passedOver` says which and why; a removal raised and not
 * yet approved is still never counted.
 */
export async function leavingBoundariesRead(reads: LeavingReads, companyKeys: KeysHeld): Promise<LeavingRead> {
  try {
    return { boundaries: await leavingBoundariesHere(reads, companyKeys, true), passedOver: null };
  } catch (e) {
    if (!(e instanceof LeavingNotRead) || !e.blocking) throw e;
    const bar = reads.records === undefined ? undefined : (await reads.records.directory()).holders?.seatBar;
    if (!Number.isSafeInteger(bar) || (bar as number) < 1) throw new LeavingNotRead('the seat bar of the company was not read');
    return { boundaries: await leavingBoundariesHere(reads, companyKeys, false), passedOver: e.message };
  }
}

/** What a seat whose own removal is approved is told when it would enter one more record. */
export const LEAVING_SEAT_STOPPED = 'a removal of this signer\'s seat is approved, so this wallet enters nothing more for the '
  + 'company: a signer who stays files it instead';

const READ_AGAIN = 'Read the chain again and do this again: once this wallet has read who is leaving the company, '
  + 'what is filed again is entered, unless your own seat is among those leaving.';

const stopsRead = new WeakMap<CompanyReach, Promise<string | null>>();

/**
 * **WHY THIS SEAT ENTERS NOTHING MORE, OR NULL**, read once for each reach of the company, so one act reads it once
 * and a renewed reach reads it afresh. A read that fails, for any reason but the act being stopped, is not kept, and is
 * refused as `FiledNotEntered` with what clears it: reading the chain again. Nothing is entered while who is leaving is
 * unread.
 */
export const stopsFor = (r: CompanyReach) => async (): Promise<string | null> => {
  let read = stopsRead.get(r);
  if (read === undefined) {
    read = (async () => {
      const mine = signingPublicKeyOf(r.seat.signingSecret as Hex).toLowerCase();
      return (await leavingBoundariesRead(leavingReadsOf(r), r.companyKeys)).boundaries.has(mine) ? LEAVING_SEAT_STOPPED : null;
    })();
    stopsRead.set(r, read);
    read.catch(() => { stopsRead.delete(r); });
  }
  try {
    return await read;
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    throw new FiledNotEntered(e instanceof LeavingNotRead ? e.message : `who is leaving the company could not be read: ${String((e as Error)?.message ?? e)}`,
      { cause: e, again: READ_AGAIN });
  }
};

/**
 * **THE ANCHOR'S DOOR TO WHO IS LEAVING.** When who is leaving cannot be read it answers nobody, which binds only a
 * retirement already anchored, and calls `unread` so the act says it was left partial; when a proposal this wallet
 * cannot open was passed over, it answers the seats it did read and calls `unread` with why. The anchor is never held
 * up by a proposal this wallet cannot read, and never reads as complete over one.
 */
export const leavingForTheAnchor = (
  r: CompanyReach, api: Api, companyKeys: KeysHeld, unread?: (why: string) => void,
) => async (): Promise<LeavingBoundaries> => {
  try {
    const read = await leavingBoundariesRead(leavingReadsOf(r, api), companyKeys);
    if (read.passedOver !== null) unread?.(read.passedOver);
    return read.boundaries;
  } catch (e) {
    if (!(e instanceof LeavingNotRead)) throw e;
    unread?.(e.message);
    return new Map();
  }
};
