/**
 * **A SEAT OR A THRESHOLD CHANGE, AS THE SERVICE HANDS IT TO A SIGNER'S DEVICE
 * TO RAISE.** The proposal written down, and - while the chain does not hold it
 * yet - what the device builds it from: the change itself, the account's half
 * and the identity it was written down under. Numbers travel as decimal digits,
 * as every other order on this wire does.
 */
import type { AccountService, GovernanceChange, GovernanceRaiseOrder } from '../core/account.js';
import type { Hex } from '../core/crypto.js';
import type { Proposal } from '../core/types.js';

const changeOnTheWire = (g: GovernanceChange) => (g.kind === 'add-signer'
  ? { kind: 'add-signer' as const, leaf: g.leaf }
  : { kind: 'threshold' as const, threshold: String(g.threshold) });

export const governanceOrderOnTheWire = (o: GovernanceRaiseOrder) => ({
  proposalId: o.proposalId,
  chainId: o.chainId,
  order: {
    circuit: 'propose' as const,
    governance: changeOnTheWire(o.governance),
    half: o.half,
    proposal: o.chainId,
  },
});

/**
 * The proposal; what it changes and the salt its identity was made with, so a
 * device approving it can remake the identity and refuse a proposal for
 * anything else; and what a device needs to raise it when the chain does not
 * hold it yet. An executed proposal carries neither: there is nothing left to
 * raise or approve.
 */
export const roundForADevice = async (
  accounts: Pick<AccountService, 'governanceOrderOf' | 'governanceAsked'>, proposal: Proposal, viewingKey: Hex,
) => {
  if (proposal.status === 'executed') return { proposal, asked: null, order: null };
  const asked = accounts.governanceAsked(proposal.id, viewingKey);
  return {
    proposal,
    asked: { governance: changeOnTheWire(asked.governance), proposalSalt: asked.proposalSalt },
    order: proposal.raisedAt || proposal.txRef
      ? null : governanceOrderOnTheWire(await accounts.governanceOrderOf(proposal.id, viewingKey)),
  };
};
