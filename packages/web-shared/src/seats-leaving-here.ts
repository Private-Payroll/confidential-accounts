/**
 * **WHICH SIGNERS ARE ON THEIR WAY OUT, AND WHAT THEY MAY NO LONGER RAISE.**
 *
 * A signer is leaving when their removal is raised or approved on the chain, or
 * their seat is retired in the company's directory while the chain still holds
 * it; each comes with the boundary of what they had filed. A proposal or run
 * such a signer raised after their removal was raised is not approved, carried
 * out, charged or paid, and the approvals a change of who is seated needs are
 * not raised while a removal is under way. The strict reads refuse when who is
 * leaving cannot be read in full, rather than guess.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import { boundaryKeyOfEntry, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import type { OpenedRound, RoundOnChain } from './governed-call-builder.js';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import { proposalsListedHere, standingOnChainHere } from './run-rebuilt-here.js';
import { believedFilerHere, openTheRoundHere, type RecordsForTheRound } from './round-opened-here.js';
import { blockingProposalSaid, passedOverAs } from './blocking-proposal-said.js';
import {
  kindAsked,
  listedHere,
  pastTheRaisedBoundary,
  refusedForItsKey,
  type LeavingBoundaries
} from './vault-page-doors.js';
import type { GovernanceDoors, GovernedThroughTheRecords } from './company-change-on-device.js';
import type { GovernedCallDoors, GovernedCallService } from './governed-call-on-device.js';

/**
 * **WHY A CHANGE THAT RAISES THE BAR ON CHANGING WHO IS SEATED WAITS FOR A
 * REMOVAL UNDER WAY, OR NULL**: a seat retired in the directory that the chain
 * still holds, or a removal the chain holds approved (`removalsApprovedHere`).
 * Raised now, the bar would take back the approvals that removal already has,
 * and could rise past the signers who stay, so it could never be carried out.
 * A removal raised and not yet approved holds no rise up: one that rises under
 * it is refused at its next approval and raised again (`removalRefusalHere`).
 */
const removalUnderWayHere = async (
  doors: GovernanceDoors,
  viewingKey: KeysHeld,
  own?: string
): Promise<string | null> => {
  const here = await doors.records!.directory();
  if (here.dir.seats.some((x) => x.retired !== null && x.seat !== own && here.holders.seats.includes(x.seat))) {
    return "a signer's seat is retired in the company's directory and the chain still holds it";
  }
  return (await removalsApprovedHere(doors, viewingKey)).some((r) => r.leaf !== own)
    ? 'a removal of a signer is approved and not yet carried out'
    : null;
};

/**
 * **NO BAR ON CHANGING WHO IS SEATED RISES WHILE A REMOVAL IS UNDER WAY.** A
 * new account threshold, approvals for policy changes or vault threshold above
 * the seat bar the person's own wallet reads now raises that bar, and so does a
 * spending policy whose highest band is above it, since the account raises the
 * bar to a policy's highest band when the policy is carried out (`setPolicy`).
 * Each is refused, saying what resolves it, until the removal is carried out
 * or withdrawn. A spending policy whose highest band this device was not given
 * is refused the same way while a removal is under way, never taken as no rise.
 * A removal that sets a new threshold above that bar is held to the same rule,
 * counting every removal under way but its own: its own seat retired and its own
 * approval are what carrying it out needs. A signer added with a new threshold
 * above that bar is held to the same rule. Every other change (a signer added
 * keeping the threshold, a removal keeping the threshold, a vault adopted, a new
 * pay key) raises no bar and waits for nothing here.
 */
export async function refuseABarRaisedDuringARemoval(
  doors: GovernanceDoors,
  viewingKey: KeysHeld,
  change: GovernedThroughTheRecords,
  highestBand?: number
): Promise<void> {
  const asked =
    change.kind === 'threshold' || change.kind === 'vault-threshold'
      ? Number(change.threshold)
      : change.kind === 'policy-bar'
        ? Number(change.bar)
        : change.kind === 'spending-policy'
          ? (highestBand ?? Number.POSITIVE_INFINITY)
          : (change.kind === 'remove-signer' || change.kind === 'add-signer') && Number(change.threshold ?? '0') > 0
            ? Number(change.threshold)
            : null;
  if (asked === null || doors.records === undefined) return;
  if (asked <= (await doors.records.directory()).holders.seatBar) return;
  const why = await removalUnderWayHere(
    doors,
    viewingKey,
    change.kind === 'remove-signer' ? change.leaf.toLowerCase() : undefined
  );
  if (why !== null) {
    throw new Error(
      `This change would raise the approvals a change of who is seated needs while ${why}, which could leave that ` +
        'removal unable ever to be carried out. Nothing was sent. Carry out or withdraw the removal first, then make this change.'
    );
  }
}

/**
 * What reading who is leaving needs: the service's proposals, the company's records and who the chain seats. Only the
 * records' directory and the chain's standing of each proposal are read.
 */
export type LeavingReads = Pick<GovernedCallDoors, 'service' | 'accountId' | 'leaves'> & {
  readonly records?: RecordsForTheRound;
};

/** Why who is leaving could not be read in full, so nothing that must exclude them goes ahead. */
export class LeavingNotRead extends Error {
  /** Set when a proposal that does not open holds the read up, so reading again does not clear it. */
  readonly blocking: boolean;
  constructor(why: string, blocking = false) {
    super(`who is under a removal could not be read in full: ${why}`);
    this.name = 'LeavingNotRead';
    this.blocking = blocking;
  }
}

/**
 * The company's open removals, or with `open` false every removal and where it stands on the chain, each opened on
 * this device from its records: the leaf each takes off. With `strict`,
 * a proposal this device cannot open, or records, proposals or the chain's standing it cannot read, refuse with
 * `LeavingNotRead` instead of being passed over, so an answer that leaves a removal out is never given; one refused
 * after its sealed record named another kind than a removal is no removal, and is passed over either way. Each is
 * opened only far enough to read its kind unless it is a removal, so a run that fails its own checks holds up nothing.
 */
export const removalsOpenHere = async (
  doors: LeavingReads,
  viewingKey: KeysHeld,
  open = true,
  strict = false
): Promise<{ id: string; leaf: string; opened: OpenedRound; status: string }[]> => {
  if (doors.records === undefined || !doors.service.sealedProposals) {
    if (strict) throw new LeavingNotRead('this page reads no proposals or records of the company');
    return [];
  }
  if (strict && doors.records.roundsOnChain === undefined)
    throw new LeavingNotRead("this page cannot read where the company's proposals stand on the chain");
  const served = await doors.service.sealedProposals(doors.accountId);
  const named = await doors.records.directory(kindAsked('proposal'));
  const listed = await standingOnChainHere(doors.records, listedHere(named, 'proposal', served, 'proposal'));
  const out: { id: string; leaf: string; opened: OpenedRound; status: string }[] = [];
  for (const p of listed) {
    if (p.accountId !== doors.accountId || (open && p.status !== 'open')) continue;
    try {
      const opened = await openTheRoundHere(
        doors.service,
        doors.accountId,
        p.id,
        viewingKey,
        false,
        doors.records,
        doors.leaves,
        false,
        'remove-signer'
      );
      if (opened.governance?.kind === 'remove-signer')
        out.push({ id: p.id, leaf: opened.governance.leaf.toLowerCase(), opened, status: p.status });
    } catch (e) {
      /*
       * One this device cannot open names no removal it acts on, unless every removal must be known; one its sealed
       * record names another kind than a removal is none, however it was refused after; so is one whose only refusal
       * is that the seat that filed it has left the company and filed it past what its retirement kept, since no
       * device acts on it and the chain no longer seats its filer.
       */
      if (passedOverAs(e, 'remove-signer')) continue;
      if (strict) throw new LeavingNotRead(blockingProposalSaid(named, p.id, e), true);
    }
  }
  return out;
};

type RemovalOnChain = { id: string; leaf: string; opened: OpenedRound; round: RoundOnChain };

/**
 * **THE COMPANY'S REMOVALS THE CHAIN HOLDS AS RAISED**, of those open on this
 * device (`removalsOpenHere`), each with where it stands as read from the
 * account's history at the person's own wallet's indexer: one filed with the
 * service and never raised on the chain sets no boundary and holds no change
 * up. None where this device cannot read the chain's standing; with `strict`,
 * that refuses with `LeavingNotRead` (`removalsOpenHere`).
 */
const removalsRaisedHere = async (
  doors: LeavingReads,
  viewingKey: KeysHeld,
  strict = false
): Promise<RemovalOnChain[]> => {
  const open = await removalsOpenHere(doors, viewingKey, true, strict);
  if (open.length === 0) return [];
  const read = await doors.records?.roundsOnChain?.(open.map((r) => r.opened.chainId.toLowerCase()));
  return open.flatMap((r) => {
    const round = read?.[r.opened.chainId.toLowerCase()];
    return round !== undefined && (round.held === 'open' || round.held === 'cleared') && round.raisedAt !== undefined
      ? [{ ...r, round }]
      : [];
  });
};

/**
 * **THE COMPANY'S REMOVALS THE CHAIN HOLDS AS APPROVED**: raised
 * (`removalsRaisedHere`), raised since the chain's last removal (not
 * `outrun`), and approved as many times as the account demands to carry it
 * out - the higher of the approvals a change of who is seated needs now, as
 * the person's own wallet reads the chain (`holders.seatBar`), and the
 * approvals the chain recorded the removal as needing when it was raised
 * (`RoundOnChain.needed`). The count is the chain's, over every seat, the
 * leaving one's included. From here a seat is leaving: before it, a removal
 * raised stops nothing. Approved does not mean the carrying out will pass:
 * the account also keeps enough signers seated, and a refused carrying out is
 * read again. A seat bar this device could not read counts every raised
 * removal as approved, never as one leaving nobody; with `strict`, it refuses
 * with `LeavingNotRead`.
 */
const removalsApprovedHere = async (
  doors: LeavingReads,
  viewingKey: KeysHeld,
  strict = false
): Promise<RemovalOnChain[]> => {
  const raised = await removalsRaisedHere(doors, viewingKey, strict);
  if (raised.length === 0) return raised;
  const bar = (await doors.records!.directory()).holders?.seatBar;
  if (!Number.isSafeInteger(bar) || (bar as number) < 1) {
    if (strict)
      throw new LeavingNotRead(
        "your wallet's read of the company's account did not say how many approvals a change of who is seated needs"
      );
    return raised;
  }
  return raised.filter(
    (r) => r.round.outrun !== true && r.round.approvals >= Math.max(bar as number, r.round.needed ?? 0)
  );
};

/**
 * **THE SEATS AN APPROVED REMOVAL IS ABOUT, BY FILING KEY, EACH WITH THE
 * BOUNDARY THE RAISE SIGNED** - the retirement terms its proposal carries,
 * final from the raise; none where it carries none - and any seat retired
 * whose removal the chain has not carried out yet, with the boundary its
 * retirement keeps, as this device reads the company's records and the chain
 * now. What no device anchors or believes a version past
 * (`AnchorDoors.leaving`): what the leaving seat filed after the raise and
 * before the approval is anchored and believed until then, and passed over
 * once the removal is approved. With `raised`, the seats a removal is only
 * raised for are named too, but not those of an outrun removal
 * (`seatsUnderARaisedRemovalHere`). It reads the
 * company's records through `doors.records`, which must not be given this
 * answer back, or each read would ask for itself. With `strict`, anything it
 * cannot read refuses with `LeavingNotRead` rather than leave a seat out.
 */
export async function leavingBoundariesHere(
  doors: LeavingReads,
  viewingKey: KeysHeld,
  strict = false,
  raised = false
): Promise<LeavingBoundaries> {
  const out = new Map<string, Readonly<Record<string, number>>>();
  if (doors.records === undefined) {
    if (strict) throw new LeavingNotRead("this page cannot read the company's records");
    return out;
  }
  const here = await doors.records.directory();
  const named = raised
    ? (await removalsRaisedHere(doors, viewingKey, strict)).filter((r) => r.round.outrun !== true)
    : await removalsApprovedHere(doors, viewingKey, strict);
  for (const r of named) {
    const seat = here.dir.seats.find((x) => x.seat === r.leaf);
    if (seat !== undefined) out.set(seat.signingKey.toLowerCase(), r.opened.retirement?.filedUpTo ?? {});
  }
  for (const x of here.dir.seats) {
    if (x.retired !== null && here.holders.seats.includes(x.seat)) out.set(x.signingKey.toLowerCase(), x.retired);
  }
  return out;
}

/**
 * **THE FILING KEYS OF THE SEATS AN APPROVED REMOVAL IS ABOUT**, and of any
 * seat retired whose removal the chain has not carried out yet
 * (`leavingBoundariesHere`): what a leaving seat's own device stops filing
 * under, and what changes the company's key without that seat. With `strict`,
 * as `leavingBoundariesHere`.
 */
export async function seatsLeavingHere(
  doors: LeavingReads,
  viewingKey: KeysHeld,
  strict = false
): Promise<ReadonlySet<string>> {
  return new Set((await leavingBoundariesHere(doors, viewingKey, strict)).keys());
}

/**
 * **THE FILING KEYS OF THE SEATS A REMOVAL IS RAISED FOR**, approved or not
 * and not outrun (the account will never carry an outrun one out), and of any
 * seat retired that the chain still holds: whose spending policy a
 * policy change is not approved or carried out under, and whose proposals and
 * runs filed after the raise a staying device does not approve or carry out
 * (`refuseWhatALeaverFiledHere`, from `leavingBoundariesHere` with `raised`),
 * so nothing the chain acts on rests on a record that is passed over once the
 * removal is approved. With `strict`, as `leavingBoundariesHere`.
 */
export async function seatsUnderARaisedRemovalHere(
  doors: LeavingReads,
  viewingKey: KeysHeld,
  strict = false
): Promise<ReadonlySet<string>> {
  return new Set((await leavingBoundariesHere(doors, viewingKey, strict, true)).keys());
}

/**
 * **A PROPOSAL OR RUN A SEAT FILED AFTER ITS OWN REMOVAL WAS RAISED IS NOT
 * APPROVED OR CARRIED OUT FROM A STAYING DEVICE.** Its record is past the
 * boundary that removal's raise signed (`pastTheRaisedBoundary`): anchored and
 * believed while the removal waits for its approvals, and passed over once it
 * is approved, so nothing the chain does may rest on it. One the seat filed
 * before its removal was raised is within that boundary, and goes ahead as
 * any other; so does everything once the removal is outrun, since the account
 * will never carry that removal out. The filer is the seat whose signed filing
 * this device believed when it opened the proposal (`OpenedRound.filedBy`),
 * never a second read of the service. Each refusal says what resolves it, and
 * nothing is sent:
 *   - no believed record names who raised it;
 *   - who is under a raised removal could not be read in full (`LeavingNotRead`);
 *   - its record is past the boundary its filer's raised removal signed.
 * The one exception is a removal of a signer (`exemptFromWhoFiled`); a run is never exempt.
 */
export const refuseWhatALeaverFiledHere = async (
  doors: LeavingReads,
  viewingKey: KeysHeld,
  proposalId: string,
  opened: OpenedRound
): Promise<void> => {
  const filer = typeof opened.filedBy === 'string' ? opened.filedBy.toLowerCase() : null;
  if (filer === null) {
    throw new Error(
      "This device holds no signed filing of this proposal in the company's records, so who raised it cannot be " +
        'said, and a proposal raised by a signer on their way out is not approved or carried out. Nothing was sent. Reload the ' +
        'page and open it again; if it happens again, whoever raised it raises it again from their own device.'
    );
  }
  if (exemptFromWhoFiled(opened)) return;
  let boundaries: LeavingBoundaries;
  try {
    boundaries = await leavingBoundariesHere(doors, viewingKey, true, true);
  } catch (e) {
    if (!(e instanceof LeavingNotRead)) throw e;
    throw new Error(
      `This is not approved or carried out while ${e.message}. Nothing was sent.${e.blocking ? '' : ' Read the chain again, then try again.'}`
    );
  }
  if (
    !pastTheRaisedBoundary(
      boundaries,
      filer,
      boundaryKeyOfEntry({
        store: 'proposal',
        kind: 'proposal',
        id: proposalId,
        version: 1,
        digest: ''
      } as ManifestEntryBody),
      1
    )
  )
    return;
  throw new Error(
    'This was raised by a signer whose removal is raised, after it was raised, and what they file now is passed over ' +
      'once their removal is approved. Nothing was sent. Do not approve or carry it out; once the removal is carried out, a ' +
      'signer who stays raises it again, or once it is withdrawn, approve it then.'
  );
};

/**
 * Whether a proposal goes ahead whoever filed it: every removal of a signer, so a seat that raises the removal of every
 * other signer first can still be removed by one of them. Every other proposal, and every run, is judged by when its
 * filer filed it (`refuseWhatALeaverFiledHere`).
 */
const exemptFromWhoFiled = (opened: OpenedRound): boolean => opened.governance?.kind === 'remove-signer';

/**
 * **A RUN ITS SEAT RAISED AFTER ITS OWN REMOVAL WAS RAISED IS NOT CHARGED OR
 * PAID FROM A STAYING DEVICE** (`refuseWhatALeaverFiledHere`), however its
 * approvals were given: carrying a run out is charging it to its period
 * (`chargeTheRunHere`) and paying each person (`payAnApprovedLeg`), and each
 * asks this first, before anything is built or sent. Who raised it is read
 * from the run's proposal as the company's records believe it
 * (`proposalsListedHere`, `believedFilerHere`). A page given no proposals,
 * a run the records do not list, or one whose filing this device does not
 * believe is refused, saying what resolves it.
 */
export async function refuseARunALeaverRaisedHere(
  records: RecordsForTheRound,
  accountId: string,
  viewingKey: KeysHeld,
  proposalId: string
): Promise<void> {
  const proposals = records.proposals;
  if (proposals === undefined) {
    throw new Error(
      "This page cannot read the company's proposals, so it cannot say who raised this run, and a run raised by a " +
        'signer on their way out is not charged or paid. Nothing was sent. Reload the page to get the current version.'
    );
  }
  const listed = await proposalsListedHere({ ...records, proposals });
  const rec = listed.find((p) => p.id === proposalId && p.accountId === accountId);
  if (rec === undefined) {
    refusedForItsKey(listed, proposalId, 'proposal');
    throw new Error(
      "The company's records hold no proposal by that name, so who raised this run cannot be said, and it is not " +
        'charged or paid. Nothing was sent. Reload the page to see where it stands.'
    );
  }
  const filedBy = await believedFilerHere(records, accountId, rec);
  /* Only the company's proposals are read through this service: which removals are raised. */
  const service = { sealedProposals: async () => proposals() } as unknown as GovernedCallService;
  const opened = { filedBy: filedBy ?? undefined } as OpenedRound;
  await refuseWhatALeaverFiledHere({ service, accountId, records }, viewingKey, proposalId, opened);
}

/**
 * Why this device's own seat files nothing more, or null: a removal of its seat is approved, so what it would file now
 * falls past the boundary the retirement keeps, and a signer who stays files it again under their own seat. While the
 * removal is only raised, this seat files as before.
 */
export async function ownRemovalApprovedHere(doors: GovernanceDoors, viewingKey: KeysHeld): Promise<string | null> {
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  return (await seatsLeavingHere(doors, viewingKey)).has(mine)
    ? "a removal of this signer's seat is approved, so this device files nothing more for the company: a signer who stays files it instead"
    : null;
}
