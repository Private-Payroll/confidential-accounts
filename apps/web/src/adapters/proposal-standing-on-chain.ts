/**
 * Where a proposal stands, read from where the chain holds it and never from a status the company's service lists: open,
 * approved once the chain counts what it was raised needing, or closed as the calls that closed it say. What a screen
 * offers on a proposal, Pay, Approve or Withdraw, is decided on this standing.
 */
import type { ProposalStatus } from '../../../../src/core/types.js';
import type { RoundOnChain } from 'vaults-web-shared/governed-call-builder.js';
import type { ClosedAs } from 'vaults-web-shared/run-rebuilt-here.js';
import type { ProposalRow } from './company-records.js';
/** Where a proposal the chain holds stands while it is held: open, or approved once its approvals are in. */
export const PROPOSAL_STANDING = { open: 'open', approved: 'approved' } as const;

/** How the chain's calls that closed a proposal read (`closedAs`, `statusOfAClose`), loaded with the chain read. */
export interface ClosingRead {
  readonly closedAs: (closedBy: readonly string[]) => ClosedAs;
  readonly statusOfAClose: (closedBy: readonly string[]) => ProposalStatus;
}

/**
 * Where a proposal stands, from where the chain holds it alone, so that Pay and Withdraw are offered on the chain's
 * word and never on a status the service listed: `executed` or `cancelled` by the call that closed it (any call that
 * closes it unpaid, or none read, is `cancelled`), and while held, `approved` once the chain holds it cleared or counts
 * the approvals its hold says it was raised needing, `open` otherwise or when it was never raised. With no chain read
 * for it, the listed status is kept, except that it is never read as approved.
 */
export function statusOnChain(listed: ProposalStatus, onChain: RoundOnChain | undefined, closing: ClosingRead): ProposalStatus {
  if (onChain === undefined) return listed === PROPOSAL_STANDING.approved ? PROPOSAL_STANDING.open : listed;
  if (onChain.held === 'closed') return closing.statusOfAClose(onChain.closedBy ?? []);
  if (onChain.held === 'cleared') return PROPOSAL_STANDING.approved;
  return onChain.held === 'open' && onChain.needed !== undefined && onChain.approvals >= onChain.needed ? PROPOSAL_STANDING.approved : PROPOSAL_STANDING.open;
}

/**
 * The status a proposal is shown with: a proposal the chain shows closed reads as the calls that closed it say
 * (`closedAs`), so one closed unpaid reads as withdrawn only when every call that closed it was a withdrawal.
 */
export function shownStatus(status: ProposalStatus, onChain: RoundOnChain | undefined, closing: ClosingRead): ProposalRow['status'] {
  return onChain?.held === 'closed' ? closing.closedAs(onChain.closedBy ?? []) : status;
}

/** A proposal as the chain holds it and as this device believes its filing: where it stands, its count, its bar, and who filed it. */
export interface ProposalStanding {
  readonly status: ProposalStatus;
  /** How the status is shown: `status`, or why a proposal closed unpaid was closed when nobody withdrew it. */
  readonly shown: ProposalRow['status'];
  readonly approvals: number;
  readonly needed: number | null;
  readonly raisedAt: string;
  /** The signing key of the seat whose signed filing this device believes, or null for a filing that carries no signature. */
  readonly filer: string | null;
  /** Whether the chain has held it raised: false while it has never seen it, when there is nothing on the chain to approve. */
  readonly raised: boolean;
  /** Open, and a signer was removed or replaced since it was raised, so the chain will never carry out the change it asks. */
  readonly outrun: boolean;
}
