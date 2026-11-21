/**
 * **AN APPROVAL OF A PROPOSAL, BUILT AND SENT FROM THIS DEVICE.**
 *
 * Before anything is built it checks that the service, the company's records
 * and the page all name the same proposal, that the chain has not already
 * counted this signer's approval or carried the proposal out, and that no
 * signer on their way out raised it. A change to the company is approved only
 * through the change's own steps, where this device first checks what it does.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import type { GovernanceOnTheWire } from './governed-call-builder.js';
import type { RetirementSignature } from '../../../src/core/types.js';
import { handedOver } from './hand-over.js';
import { filerHere, type GovernedCallDoors, onChainHere, opensFor, type RoundOnThePage, theRoundAsked, waitFor } from './governed-call-on-device.js';
import { refuseWhatALeaverFiledHere } from './seats-leaving-here.js';

/** What the contract says when a proposal is carried out with fewer approvals than the account asks for it now. */
const NOT_ENOUGH_APPROVALS = 'not enough approvals yet';

/**
 * Whether a refusal is the chain's: the proposal has fewer approvals than the account asks for it now. A vault's
 * spending policy, or a signer removed since the proposal was raised, can ask more than the proposal named.
 */
export const notEnoughApprovalsYet = (e: unknown): boolean => String((e as Error | null)?.message ?? '').includes(NOT_ENOUGH_APPROVALS);

/**
 * **ONE APPROVAL, FROM THIS DEVICE.** The approval is built and proved in the
 * worker with this signer's own key material, sent, and the chain asked until
 * it holds this seat's approval.
 *
 * **WHAT IS PROVED IS THE PROPOSAL THIS DEVICE OPENED, AND IT IS THE ONE THE
 * PERSON WAS SHOWN.** The proposal is opened here from the company's sealed
 * records; its identity must be the one the page showed, and so must what it
 * says, or nothing is built. A payroll run is made again from the company's
 * records where the approval is built.
 *
 * **A CHANGE TO THE COMPANY IS NOT APPROVED HERE.** A seat, the company's
 * threshold or a vault's own approvals needed is approved where the change is
 * made (`changeThresholdOnDevice`, `changeVaultThresholdOnDevice`,
 * `seatSignerOnDevice`), which checks first that it leaves no vault unable to
 * pay and, for a seat, who is seated. Opened here, it is refused before
 * anything is built.
 *
 * **A RUN ITS SEAT RAISED AFTER ITS OWN REMOVAL WAS RAISED IS NOT APPROVED
 * HERE** (`refuseWhatALeaverFiledHere`): its record is passed over once the
 * removal is approved, so no approval rests on it.
 *
 * **AN APPROVAL ALREADY COUNTED IS NOT OWED.** When the chain already holds this seat's approval of it (its own
 * approve, or its raise counted as its approval), it is refused as `ApprovalNotOwed('counted')`, with nothing built or
 * sent. One the chain has closed is owed none either: carried out, `ApprovalNotOwed('carried-out')`; withdrawn,
 * `NothingToApprove`. Every answer of the service is held to the proposal asked about (`theRoundAsked`).
 */
export async function approveOnDevice(
  doors: GovernedCallDoors, input: { round: RoundOnThePage; viewingKey: KeysHeld },
): Promise<RoundOnThePage> {
  const done = await approveHere(doors, input, false);
  if (done.counted) throw new ApprovalNotOwed('counted');
  return done.round;
}

/**
 * An approval as `approveOnDevice` builds it; a governance change only from `governOnDevice`, bound to the change it
 * checked. `counted` when the chain already held this seat's approval of it open, so nothing was built or sent; the
 * proposal then stands where the chain read it. Closed on the chain, it is refused before anything is built.
 */
export async function approveHere(
  doors: GovernedCallDoors,
  input: {
    round: RoundOnThePage; viewingKey: KeysHeld;
    /** For a governance change: what it changes and its salt, which the approval is refused unless it matches. */
    of?: { governance: GovernanceOnTheWire; proposalSalt: string };
    /** For a removal: this seat's signature over the retirement it carries, sent with the approval. */
    retirement?: RetirementSignature;
  },
  aChangeCheckedHere: boolean,
): Promise<{ readonly counted: boolean; readonly round: RoundOnThePage }> {
  const { service } = doors;
  const named = theRoundAsked(await service.standing(input.round.id), input.round.id);
  /* The proposal proved is the one the person was shown, or nothing is built. */
  if (String(named.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  const opened = await opensFor(doors)(input.round.id, input.viewingKey, false);
  if (String(opened.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company\'s record of this proposal does not match the proposal on this page. Nothing was built or '
      + 'sent. Reload the page and try again. If it happens again, do not approve it.');
  }
  if (input.round.summary !== undefined && opened.summary !== input.round.summary) {
    throw new Error('the company\'s record of this proposal says something different from what this page shows. Nothing '
      + 'was built or sent. Reload the page and try again. If it happens again, do not approve it.');
  }
  if (opened.governance !== undefined && !aChangeCheckedHere) {
    throw new Error('this proposal changes the company - who is seated, or how many approvals are needed - and such a change '
      + 'is approved where it is made, where this device first checks what it does. Nothing was built or sent.');
  }
  /* A change is checked for who filed it where it is made (`governOnDevice`); a run is checked here. */
  if (!aChangeCheckedHere) await refuseWhatALeaverFiledHere(doors, input.viewingKey, input.round.id, opened);
  doors.progress?.('reading-the-chain');
  /* Whether this seat's approval is already counted is the chain's answer, never the service's. */
  const before = await onChainHere(doors, named);
  if (before.approvedHere === undefined) {
    throw new Error('whether your approval of this proposal is already counted was not read from the chain, so nothing was built or '
      + 'sent. Reload the page and try again.');
  }
  /*
   * Closed on the chain, it is owed no approval: the chain keeps this seat's approval marker after it closes, so an
   * approval already counted is never read from a closed proposal, and nothing is built for one.
   */
  if (before.status === 'executed') throw new ApprovalNotOwed('carried-out');
  if (before.status !== 'open') throw new NothingToApprove();
  if (before.approvedHere) return { counted: true, round: before };
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    order: { circuit: 'approve', proposal: opened.chainId, ...(input.of === undefined ? {} : { of: input.of }) },
    material: doors.material, chain, opened,
  });
  doors.progress?.('sending');
  const answer = await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: 'approve' },
    viaService: () => service.approve(input.round.id, {
      tx, filer: filerHere(doors), ...(input.retirement === undefined ? {} : { retirement: input.retirement }),
    }),
    /* A removal's retirement signature is kept only by the service, so it is handed there before the approval goes. */
    before: async () => { if (input.retirement !== undefined) await retirementHanded(doors, input.round, input.retirement); },
    after: () => service.standing(input.round.id),
  });
  const sent = await onChainHere(doors, theRoundAsked(answer, input.round.id, opened.chainId));
  /* This seat's own approval, never a count another signer's approval can also raise, or the proposal closed. */
  const seen = (r: RoundOnThePage) => r.approvedHere === true || r.status !== 'open';
  const now = seen(sent) ? sent : await waitFor(doors, 'your approval', input.round.id, seen, sent);
  if (now.status === 'cancelled') throw new WithdrawnWhileSent();
  return { counted: false, round: now };
}

/**
 * Hands this seat's signature over a removal's retirement to the service on its own, through the route that takes one,
 * as a raise that counted this seat's approval leaves no approval to carry it.
 */
export const retirementHanded = async (doors: GovernedCallDoors, round: RoundOnThePage, signature: RetirementSignature): Promise<void> => {
  if (doors.service.retire === undefined) {
    throw new Error('the removal is raised, and this page cannot send your signature over its retirement, which the removal needs before '
      + 'it is carried out. Reload the page to get the current version, then make the removal again: it signs the retirement again.');
  }
  await doors.service.retire(round.id, { signature, filer: filerHere(doors) });
};

/** A proposal withdrawn while this device's approval of it was on its way: sent, and closed, so nothing is left to do. */
export class WithdrawnWhileSent extends Error {
  readonly nothingWasSent = false;
  constructor() {
    super('this proposal was withdrawn while this approval was being sent. Your approval was sent, and the proposal is closed, '
      + 'so there is nothing more to approve.');
    this.name = 'WithdrawnWhileSent';
  }
}

/** A device asked only to approve found no proposal raised on the chain to approve: nothing was sent. */
export class NothingToApprove extends Error {
  readonly nothingWasSent = true;
  constructor() {
    super('The company holds no proposal raised on the chain for this change that this device was asked to approve, so nothing '
      + 'was approved. Nothing was sent. Reload the page: it may have been withdrawn, or not raised yet.');
    this.name = 'NothingToApprove';
  }
}

/**
 * A device asked only to approve found nothing left for this seat to approve, and sent nothing: `counted`, the chain
 * already counts this seat's approval (a raise counts its raiser's); `carried-out`, the chain closed the proposal by
 * carrying it out, so for a seat offered by address the invitee has taken the seat and Finish adding is what is owed.
 */
export class ApprovalNotOwed extends Error {
  readonly nothingWasSent = true;
  constructor(readonly why: 'counted' | 'carried-out') {
    super(why === 'counted'
      ? 'The network already counts your approval of this proposal, so nothing was approved again. Nothing was sent.'
      : 'The network has already carried this proposal out, so there is nothing left to approve. Nothing was sent.');
    this.name = 'ApprovalNotOwed';
  }
}
