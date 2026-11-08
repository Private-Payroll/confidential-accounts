/**
 * Whether an invitation open on the chain would raise the approvals a removal needs once its seat is taken, read from
 * the company's proposals and where the chain says each stands, every one opened on this device. Used by the removal's
 * check before each send.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { OpenedRound } from './governed-call-builder.js';
import type { LeavingReads } from './governed-call-on-device.js';
import { blockingProposalSaid, passedOverAs } from './blocking-proposal-said.js';
import { NotOpenedOnThisDevice, openTheRoundHere } from './round-opened-here.js';
import { standingOnChainHere } from './run-rebuilt-here.js';
import { kindAsked, listedHere } from './vault-page-doors.js';

/** This check runs again before the carrying out, after the same press may have sent its approval. */
const MAYBE_SENT = 'Anything this press already sent may have gone through and stands; nothing more is sent.';

/**
 * **A REMOVAL WAITS WHILE A SEAT THAT RAISES THE BAR IS OPEN.** An invitation that sets a threshold above the
 * approvals a change of who is seated needs now raises that bar when its invitee takes the seat, and the invitee's
 * own wallet cannot open the company's proposals to see a removal under way. A removal approved at the bar now would
 * then be short of it for good, its retirement signed below it, and the leaving seat kept seated until it is raised
 * again. So a removal is refused, at its raise, every approval and its carrying out, while any proposal to add a seat
 * whose signed invitation sets a threshold above the bar is open on the chain or not yet raised, naming it and what
 * resolves it. Read from the company's proposals, where they stand on the chain, and each one opened on this device
 * as an invitation. One that opens as another kind, or that its filer filed past their retirement, is passed over; any other
 * that does not open refuses, naming it and the seat that raised it (`blockingProposalSaid`). Null when there is none.
 */
export async function seatRaisingTheBarHere(doors: LeavingReads, viewingKey: KeysHeld): Promise<string | null> {
  if (doors.records === undefined || !doors.service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s proposals, so it cannot tell whether a seat being added '
      + 'raises the approvals this removal needs. Nothing was sent. Reload the page to get the current version.');
  }
  const bar = (await doors.records.directory()).holders.seatBar;
  const served = await doors.service.sealedProposals(doors.accountId);
  const named = await doors.records.directory(kindAsked('proposal'));
  const listed = await standingOnChainHere(doors.records, listedHere(named, 'proposal', served, 'proposal'));
  for (const p of listed) {
    if (p.accountId !== doors.accountId || p.status !== 'open') continue;
    let opened: OpenedRound;
    try {
      opened = await openTheRoundHere(doors.service, doors.accountId, p.id, viewingKey, false, doors.records, doors.leaves, false, 'add-signer');
    } catch (e) {
      if (passedOverAs(e, 'add-signer')) continue;
      const said = blockingProposalSaid(named, p.id, e);
      return `${said.charAt(0).toUpperCase()}${said.slice(1)}. Whether it raises the approvals this removal needs cannot be told. ${MAYBE_SENT}`;
    }
    const g = opened.governance;
    const written = g?.kind === 'add-signer' ? g.threshold ?? '0' : '0';
    if (!/^[0-9]+$/u.test(written)) {
      return `Proposal ${p.id} adds a signer whose seat sets the approvals the company needs to ${written}, which is not a whole number, `
        + `so the network never carries it out. ${MAYBE_SENT} Withdraw that invitation, then make this removal again.`;
    }
    /* Compared as a whole number of any size: an invitation may set up to the chain's own limit, past what a number counts exactly. */
    if (BigInt(written) > BigInt(bar)) {
      return `Proposal ${p.id} adds a signer whose seat sets the approvals the company needs to ${written} once it is taken, above the ${bar} `
        + `this removal is approved at, so the removal could never be carried out once that seat is taken. ${MAYBE_SENT} Let the `
        + 'person take that seat first, or withdraw that invitation, then make this removal again.';
    }
  }
  return null;
}
