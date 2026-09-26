/**
 * **THE COMPANY'S RECORDS AS A SIGNER'S DEVICE READS THEM, FOR TESTS.**
 *
 * `sealedProposalFor` seals a proposal with the product's own sealing, so a page
 * that reads it runs its own opening unchanged. `opensAs` stands in for that
 * opening where a test's builder does not check what was read: each proposal
 * named opens with its identity and nothing else. Where what was read is the
 * subject, the real opening is used over real records.
 */
import { canonical, seal, type Hex } from '../core/crypto.js';
import { sealRecord } from '../core/sealed-records.js';
import type { SealedProposal } from '../core/types.js';
import type { OpenedRound } from '../web/governed-call-builder.js';

export interface ARecord {
  readonly id: string;
  readonly chainId: string;
  readonly kind?: string;
  readonly summary?: string;
  readonly vault?: string;
  readonly digest?: string;
  readonly salt: string;
  readonly asset?: string;
  readonly amount?: bigint;
  readonly batchDigest?: string;
  /** What else the sealed payload carries; `__change: undefined` seals none, as some kinds are written. */
  readonly payload?: Record<string, unknown>;
}

/** One proposal, sealed as the company stores it, for the company named. */
export function sealedProposalFor(accountId: string, viewingKey: Hex, r: ARecord): SealedProposal {
  const change = { asset: r.asset ?? 'GBP', amount: r.amount ?? 0n, batchDigest: r.batchDigest ?? '77'.repeat(32), salt: r.salt };
  const payload = { entries: [], __change: change, ...(r.payload ?? {}) };
  if (payload.__change === undefined) delete (payload as { __change?: unknown }).__change;
  const sealedPayload = seal(canonical(payload), viewingKey);
  return {
    id: r.id, accountId, status: 'open', createdAt: '2026-09-26T00:00:00.000Z',
    digest: (r.digest ?? '00'.repeat(32)) as Hex, chainId: r.chainId as Hex, approvalCount: 0, keyEpoch: 0,
    sealed: sealRecord('proposals', accountId, {
      kind: r.kind ?? 'payroll', summary: r.summary ?? 'a round', vault: r.vault ?? '99'.repeat(32), sealedPayload,
      proposedBy: 'sgn_1', approvals: [],
    }, viewingKey),
  } as SealedProposal;
}

/** The device's opening, stood in for: each proposal named opens with the identity given. */
export const opensAs = (chainIds: Readonly<Record<string, string>>) => async (proposalId: string): Promise<OpenedRound> => {
  const chainId = chainIds[proposalId];
  if (chainId === undefined) throw new Error(`no record of ${proposalId} to open`);
  return { chainId, digest: '', vault: '', salt: '', summary: '' };
};
