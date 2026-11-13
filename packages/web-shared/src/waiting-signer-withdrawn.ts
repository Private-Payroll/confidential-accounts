/*
 * Withdrawing somebody waiting for a seat, from a device whose seat may invite: the
 * withdrawal is signed here and sent once no proposal could still seat them. Which
 * proposals could is read from the chain by the person's own wallet, and from the
 * company's proposals only once its anchored records show none was left out.
 */
import { openedWithAnyKey } from '../../../src/core/company-key.js';
import { openFromInbox } from '../../../src/core/sealed-records.js';
import { signWithdrawal } from '../../../src/core/invitation.js';
import type { PendingSignerPayload, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import { raiseMayStillLandAt, seatStillProposedFor } from '../../../src/core/proposal-filing.js';
import { seatProposalsFor } from '../../../src/core/add-signer-filing.js';
import type { KeysHeld } from '../../../src/core/company-key.js';
import { kindAsked, listedHere } from './vault-page-doors.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { raisesStillHolding, sittingSigningKeysIn } from './filed-raise-still-holds.js';
import {
  answered, refuseASeatThatMayNotInvite, SeatMayNotInvite, type InvitationSend, type InvitingSeat,
} from './invitation-on-device.js';

/** What this device reads to withdraw a seat request: the company's inbox and proposals, and the chain's seats now. */
export interface WaitingReads {
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
 * refuses a seat that may not invite and a seat the chain does not hold, and a
 * request that carries neither as its name nor as its invitation's the name
 * `named` the person was shown, so a page cannot show one person and have
 * another withdrawn; the service decides the rest, and for a leaf the chain holds it lets go only a
 * request filed after its invitation closed, which leaves the invitation open
 * to the person it seated.
 */
export async function withdrawWaitingSignerHere(
  company: { readonly id: string; readonly companyKeys: KeysHeld }, seat: Pick<InvitingSeat, 'signingSecret' | 'held' | 'statement'>, signerId: string,
  reads: WaitingReads, send: InvitationSend, named: string,
): Promise<void> {
  refuseASeatThatMayNotInvite(seat);
  if (!reads.onTheChain.some((x) => x.toLowerCase() === seat.statement.seat.toLowerCase())) {
    throw new SeatMayNotInvite('Your seat is not one the company\'s account holds now, so it withdraws nobody.');
  }
  const box = reads.sealed.pendingSigners.find((p) => p.id === signerId);
  if (box === undefined) throw new Error('That person is no longer waiting for a seat. Reload the page. Nothing was signed or sent.');
  /* Any key this device holds reads which invitation a request answers: withdrawing one believes nothing in it. */
  const waiting = openedWithAnyKey(company.companyKeys, (key) => openFromInbox<PendingSignerPayload>(box.sealed, company.id, key));
  const invitation = waiting.invited?.terms.invitation;
  if (![waiting.name, waiting.invited?.terms.name].some((x) => x !== undefined && x.trim() === named.trim())) {
    throw new Error(`This request is not the person you were shown: it is ${waiting.name}'s. Reload the page and check who you withdraw. `
      + 'Nothing was signed or sent.');
  }
  if (invitation === undefined) {
    throw new Error('This seat request names no invitation, so it cannot be withdrawn by its invitation. Nothing was signed or sent.');
  }
  if (seatStillProposedFor(reads.proposals, company.id, company.companyKeys, signerId, reads.openOnTheChain)) {
    throw new Error('A proposal to seat this person is still open, and could still seat them. Withdraw that proposal first. '
      + 'Nothing was signed or sent.');
  }
  /* The leaf travels with it, so the service can tell a request for a seat the chain already holds from one filed late, and lets only the late one go. */
  const withdrawal = signWithdrawal({ company: company.id, signerId, invitation, leaf: waiting.leafCommitment }, seat.signingSecret);
  answered(await send(`/api/accounts/${encodeURIComponent(company.id)}/signers/${encodeURIComponent(signerId)}/withdraw`, {
    method: 'POST', body: JSON.stringify({ withdrawal }),
  }), 200);
}

/**
 * Where this device reads what a withdrawal needs: the company's anchored records, its proposals, the chain and its
 * time. A device that cannot read the proposals or the chain's standing of them withdraws nobody (`withdrawalReadsHere`).
 */
export interface WithdrawalReads {
  readonly directory: CompanyRecordsHere['directory'];
  readonly proposals?: CompanyRecordsHere['proposals'];
  readonly roundsOnChain?: CompanyRecordsHere['roundsOnChain'];
  /** The time of the newest block, in milliseconds, at the indexer this device reads the chain from. */
  readonly chainTime?: () => Promise<number>;
}

/** Why nobody is withdrawn when the chain's time cannot be read while a proposal to seat them waits to be raised. */
export const WITHDRAWAL_TIME_NOT_READ = 'the network\'s time could not be read to tell whether a proposal to seat this person, written down '
  + 'but not yet on the network, may still reach it. Nothing was signed or sent. Try again in a minute.';

/** Why nobody is withdrawn when the chain's read leaves out a proposal to seat them: an unread one may be open. */
export const WITHDRAWAL_ROUND_NOT_READ = 'where a proposal to seat this person stands on the network was not read, so it may still seat them. '
  + 'Nothing was signed or sent. Try again in a minute.';

/**
 * **WHAT A WITHDRAWAL OF `signerId` IS JUDGED ON, READ HERE**: the company's proposals, refused when its anchored records
 * name one the service left out (`listedHere`); the seats the chain holds; and the ids of every proposal to seat that
 * request the chain could still carry out. That is one the chain holds open, approved or not, or one written down and
 * not on the chain yet whose raise may still land by the chain's time, up to its raise-by time however far ahead it is
 * dated, filed by a seat that sits now (`raisesStillHolding`): either could still seat the person. A proposal the chain
 * closed, or one whose raise can no longer land, seats nobody. Throws when the chain, a proposal's standing on it or its time cannot be read, so nobody is
 * withdrawn on a guess.
 */
export async function withdrawalReadsHere(
  reads: WithdrawalReads, sealed: SealedAccount, accountId: string, viewingKey: KeysHeld, signerId: string,
): Promise<WaitingReads> {
  if (reads.proposals === undefined || reads.roundsOnChain === undefined) {
    throw new Error('this device cannot read the company\'s proposals and the chain\'s standing of them, so nobody was withdrawn. Reload the page.');
  }
  const here = await reads.directory(kindAsked('proposal'));
  const listed = listedHere(here, 'proposal', await reads.proposals(), 'proposal');
  const proposals = [...listed, ...listed.setAside];
  const onTheChain = here.holders.seats.map((x) => x.toLowerCase());
  const proposed = seatProposalsFor(proposals, accountId, viewingKey, signerId);
  if (proposed.length === 0) return { sealed, proposals, onTheChain, openOnTheChain: [] };
  const rounds = await reads.roundsOnChain(proposed.map((x) => x.chainId));
  if (proposed.some((x) => rounds[x.chainId] === undefined)) throw new Error(WITHDRAWAL_ROUND_NOT_READ);
  const heldOf = (id: string) => rounds[id]?.held;
  const open = proposed.filter((x) => heldOf(x.chainId) === 'open' || heldOf(x.chainId) === 'cleared');
  const sitting = sittingSigningKeysIn(here, new Set(onTheChain));
  const filed = proposed.filter((x) => heldOf(x.chainId) === 'never' && x.filedBy !== undefined && sitting.has(x.filedBy));
  /* Up to its raise-by time whatever its date: the device that wrote it down still raises it until then, even from a clock running ahead. */
  const holding = await raisesStillHolding(filed, reads.chainTime, raiseMayStillLandAt);
  if (holding === 'time-not-read') throw new Error(WITHDRAWAL_TIME_NOT_READ);
  return { sealed, proposals, onTheChain, openOnTheChain: [...open, ...holding].map((x) => x.chainId) };
}
