/**
 * **WHERE A PROPOSAL STANDS, READ OFF THE CHAIN AND KEPT IN PLAIN TEXT BESIDE
 * ITS SEALED RECORD.**
 *
 * A proposal's record has two halves. What it pays or changes, who raised it
 * and why are sealed on the device that raised it, and this service cannot
 * open them. Its identity on the chain, its payload digest, its status and how
 * many approvals the chain counts for it are public on the chain anyway, so
 * they are kept outside the envelope: that is what lets this service relay a
 * proven call for a proposal and say where it stands without any key.
 *
 * **THE CHAIN DECIDES; THIS ONLY WRITES DOWN WHAT IT READ.** The count is the
 * chain's count of approvals for this identity, and it never goes down. When a
 * proposal is approved depends on the bar of the vault it names, and the vault
 * is sealed: so whether the count meets the bar is worked out on a signer's
 * device, which opens the record, and never here.
 *
 * Pure. Nothing here reads a store, a ledger or a key.
 */
import type { LedgerStatus } from './ledger.js';
import type { SealedProposal, ProposalStatus } from './types.js';

/** What a send is told when the proposal is not one to send. */
export const notSentBecauseItIs = (status: string): string =>
  `this proposal is ${status}, so it is not sent to the chain. Nothing was sent.`;
export const THE_CHAIN_ALREADY_HOLDS_IT = 'the chain already holds this proposal, so it is not sent again. Nothing was sent.';
/** What a withdrawal says while the proposal's raise is on its way to the chain. */
export const RAISE_ON_ITS_WAY =
  'this proposal is being sent to the chain right now, so it is not withdrawn: if that send lands, a record '
  + 'closed here would sit beside an open proposal on chain that nothing here can withdraw. Nothing was '
  + 'withdrawn. Try again once the send has answered.';
/**
 * **WHAT A WITHDRAWAL SAYS WHEN THE LEDGER WOULD NOT ANSWER.** A proposal whose
 * arrival on the chain was never seen cannot be withdrawn on a guess: closing it
 * here while the chain still held it open would leave a signer with no record
 * that it was ever withdrawn.
 */
export const CANNOT_ASK_THE_CHAIN =
  'this proposal has no record of being accepted on chain and the ledger did not answer, so '
  + 'cancelling it here could clear approvals the chain still holds. Read the account\'s '
  + 'ledger status (GET /api/accounts/:id/ledger) and try again once it answers.';

/** Whether the chain holds a proposal open: `unknown` when the ledger did not answer. */
export type ChainHold = 'present' | 'absent' | 'unknown';

/**
 * **WHETHER THE CHAIN HOLDS THIS PROPOSAL OPEN NOW**, from one captured read.
 * A proposal already seen on the chain is present without asking. A ledger that
 * did not answer is `unknown`, never `absent`: an account the ledger has not
 * heard of and a proposal it does not hold are different facts.
 */
export const chainHoldsIt = (rec: Pick<SealedProposal, 'chainId' | 'raisedAt'>, status: LedgerStatus | null): ChainHold => {
  if (rec.raisedAt) return 'present';
  if (status === null) return 'unknown';
  return status.openProposals.some((p) => p.id.toLowerCase() === rec.chainId.toLowerCase()) ? 'present' : 'absent';
};

/**
 * **THE RECORD WITH WHAT ONE READ OF THE CHAIN SAYS OF IT**, or the record
 * unchanged. A proposal the chain holds open is marked seen, once, at `now`;
 * its count is the chain's when that is higher than the one written down, and
 * is never lowered. A proposal that is no longer open here is not touched: a
 * withdrawal, or a change carried out, is written by the step that made it.
 */
export const withTheChainsCount = (rec: SealedProposal, status: LedgerStatus | null, now: string): SealedProposal => {
  if (status === null || rec.status !== 'open') return rec;
  const open = status.openProposals.find((p) => p.id.toLowerCase() === rec.chainId.toLowerCase());
  if (open === undefined) return rec;
  const count = Math.max(rec.approvalCount, open.approvals);
  if (rec.raisedAt && count === rec.approvalCount) return rec;
  return { ...rec, raisedAt: rec.raisedAt ?? now, approvalCount: count };
};

/** A proposal as this service answers for it: only what is kept outside the envelope. */
export interface ProposalStanding {
  readonly id: string;
  readonly accountId: string;
  readonly chainId: string;
  readonly digest: string;
  readonly status: ProposalStatus;
  /** How many approvals the chain counts for this proposal, as last read. Never says whose. */
  readonly approvalCount: number;
  readonly createdAt: string;
  readonly txRef?: string;
  /** When the chain was first seen to hold it. Absent is not confirmed, never not raised. */
  readonly raisedAt?: string;
  readonly executedAt?: string;
}

/** The plain half of a proposal's record, and nothing from inside its envelope. */
export const standingOf = (rec: SealedProposal): ProposalStanding => ({
  id: rec.id, accountId: rec.accountId, chainId: rec.chainId, digest: rec.digest, status: rec.status,
  approvalCount: rec.approvalCount, createdAt: rec.createdAt,
  ...(rec.txRef === undefined ? {} : { txRef: rec.txRef }),
  ...(rec.raisedAt === undefined ? {} : { raisedAt: rec.raisedAt }),
  ...(rec.executedAt === undefined ? {} : { executedAt: rec.executedAt }),
});
