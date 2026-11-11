/**
 * A seat proposal the old service raised for somebody who joined by a link, raised again as a signer's device now
 * raises it (`seatSignerOnDevice`): its invitation names the proposal its own signed terms make, and the proposal is
 * filed under the salt those terms make, so every approving device takes it as the invitation the approvers agree to.
 * The record keeps its id; the invitation, with any terms `over` changes, and the filing where the record was signed,
 * are signed again by `signingSecret`, which must be the seat that signed them.
 */
import { parseCanonical, unseal, type Hex, type Sealed } from '../core/crypto.js';
import { invitationProposalSalt, seatByAddressChangeOf, signSeatInvitation, type SeatInvitationTerms, type SignedSeatInvitation } from '../core/invitation.js';
import { sealGovernanceProposal, signProposalFiling } from '../core/proposal-filing.js';
import { openRecord } from '../core/sealed-records.js';
import type { SealedProposal } from '../core/types.js';

const { identityOfAChange } = await import('vaults-web-shared/governed-call-builder.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

interface ProposalStore {
  getProposal(id: string): SealedProposal | null;
  putProposal(p: SealedProposal): void;
}

/** The proposal `id` in `store`, filed again bound to its invitation; returns its new identity on the chain and digest. */
export const seatRoundBound = (
  store: ProposalStore, accountId: string, id: string, viewingKey: Hex, signingSecret: Hex, over: Partial<SeatInvitationTerms> = {},
): { readonly chainId: string; readonly digest: string } => {
  const rec = store.getProposal(id);
  if (rec === null) throw new Error(`the test's store holds no proposal ${id}`);
  const envelope = openRecord<{ kind: string; summary: string; vault: Hex; proposedBy: string; sealedPayload: Sealed }>('proposals', accountId, rec.sealed, viewingKey);
  const { entries: _e, __change: change, ...body } = parseCanonical<{ invited: SignedSeatInvitation; entries?: unknown; __change: { asset: string; amount: string; batchDigest: Hex } }>(
    unseal(envelope.sealedPayload, viewingKey));
  const { proposal: _p, ...signed } = body.invited.terms;
  const terms = { ...signed, ...over };
  const salt = invitationProposalSalt({ terms, signedBy: body.invited.signedBy });
  const made = identityOfAChange({ accountPure: pureCircuits as never }, seatByAddressChangeOf(terms.invite!), salt);
  const invited = signSeatInvitation({ ...terms, proposal: made.chainId.toLowerCase() as Hex }, signingSecret);
  const sealed = sealGovernanceProposal({
    accountId, viewingKey, kind: 'add-signer', summary: envelope.summary, noVault: made.noVault as Hex,
    body: { ...body, invite: { address: terms.invite!.address, scope: terms.invite!.scope }, invited } as never,
    change: { asset: change.asset, amount: BigInt(change.amount), batchDigest: change.batchDigest, salt: salt as Hex }, proposedBy: envelope.proposedBy,
  });
  const unsigned = { id, digest: made.digest as Hex, chainId: made.chainId as Hex, keyEpoch: rec.keyEpoch ?? 0, createdAt: rec.createdAt, sealed };
  /* Filed as the record was: signed again by the filer only where the service's record carried a filer's signature. */
  store.putProposal({ ...rec, ...(rec.filedBy === undefined ? unsigned : signProposalFiling(accountId, unsigned, signingSecret)) } as SealedProposal);
  return { chainId: made.chainId, digest: made.digest };
};
