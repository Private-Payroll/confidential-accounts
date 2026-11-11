/*
 * Withdrawing somebody waiting for a seat, from a device whose seat may invite: the
 * withdrawal is signed here and sent once no open proposal could still seat them.
 */
import { openedWithAnyKey } from '../../../src/core/company-key.js';
import { openFromInbox } from '../../../src/core/sealed-records.js';
import { signWithdrawal } from '../../../src/core/invitation.js';
import type { PendingSignerPayload, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import { seatStillProposedFor } from '../../../src/core/proposal-filing.js';
import {
  answered, refuseASeatThatMayNotInvite, SeatMayNotInvite, type InvitationSend, type InvitingCompany, type InvitingSeat,
} from './invitation-on-device.js';

/** What this device reads to withdraw a seat request: the company's inbox and proposals, and the chain's seats now. */
interface WaitingReads {
  readonly sealed: SealedAccount;
  readonly proposals: readonly SealedProposal[];
  /** Every seat the company's account holds now, as this person's own wallet read it. */
  readonly onTheChain: readonly string[];
  /** The ids of every proposal the company's account holds open now, approved or not, as this device's own read of the chain gives them. */
  readonly openOnTheChain: readonly string[];
}

/**
 * **SOMEBODY WAITING FOR A SEAT, WITHDRAWN FROM THIS DEVICE**, so the same
 * person can accept a new invitation. The request is opened here with any
 * key of the company this device holds, so one sealed before the key changed
 * is withdrawn too, and refused - before anything is signed - while the chain
 * holds a proposal to seat it open (as this device's own read of the chain
 * says, never the service), since it may still seat them: that proposal is
 * withdrawn first. The withdrawal names the request, the invitation it
 * answered and its leaf, signed by this seat's filing key. This device also
 * refuses a seat that may not invite and a seat the chain does not hold; the
 * service decides the rest, and for a leaf the chain holds it lets go only a
 * request filed after its invitation closed, which leaves the invitation open
 * to the person it seated.
 */
export async function withdrawWaitingSignerHere(
  company: Pick<InvitingCompany, 'id' | 'viewingKey'>, seat: Pick<InvitingSeat, 'signingSecret' | 'held' | 'statement'>, signerId: string,
  reads: WaitingReads, send: InvitationSend,
): Promise<void> {
  refuseASeatThatMayNotInvite(seat);
  if (!reads.onTheChain.some((x) => x.toLowerCase() === seat.statement.seat.toLowerCase())) {
    throw new SeatMayNotInvite('Your seat is not one the company\'s account holds now, so it withdraws nobody.');
  }
  const box = reads.sealed.pendingSigners.find((p) => p.id === signerId);
  if (box === undefined) throw new Error('That person is no longer waiting for a seat. Reload the page. Nothing was signed or sent.');
  /* Any key this device holds reads which invitation a request answers: withdrawing one believes nothing in it. */
  const waiting = openedWithAnyKey(company.viewingKey, (key) => openFromInbox<PendingSignerPayload>(box.sealed, company.id, key));
  const invitation = waiting.invited?.terms.invitation;
  if (invitation === undefined) {
    throw new Error('This seat request names no invitation, so it cannot be withdrawn by its invitation. Nothing was signed or sent.');
  }
  if (seatStillProposedFor(reads.proposals, company.id, company.viewingKey, signerId, reads.openOnTheChain)) {
    throw new Error('A proposal to seat this person is still open, and could still seat them. Withdraw that proposal first. '
      + 'Nothing was signed or sent.');
  }
  /* The leaf travels with it, so the service can tell a request for a seat the chain already holds from one filed late, and lets only the late one go. */
  const withdrawal = signWithdrawal({ company: company.id, signerId, invitation, leaf: waiting.leafCommitment }, seat.signingSecret);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/signers/${encodeURIComponent(signerId)}/withdraw`, {
    method: 'POST', body: JSON.stringify({ withdrawal }),
  }), 200);
}
