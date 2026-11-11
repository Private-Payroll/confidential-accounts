/**
 * **THE COMPANY'S RUNS AND PROPOSALS, OPENED FOR A SCREEN.** Each record is opened on this device with the key this
 * device holds for its purpose, of the epoch it was sealed at (`keysByPurpose`): a run under the payroll purpose, a
 * proposal's envelope (its kind, summary and plain fields) under the proposals purpose. What a proposal pays is sealed
 * inside the envelope under the company key and is not opened here. A record that does not open throws (`openRecord`).
 */
import type { CompanyKeys } from '../../../../src/core/company-key.js';
import { openRecord } from '../../../../src/core/sealed-records.js';
import type { PayrollRun, Proposal, SealedProposal, SealedRun } from '../../../../src/core/types.js';
import { keysByPurpose } from 'vaults-web-shared/keys-by-purpose.js';
import { SERVICE } from './company-records.js';

/**
 * A run as this device reads it: the service's plain fields and its sealed ones, opened, the marker the record carries
 * kept. What a run seals (its people, totals, proposals, payout, skips, repeats and list) is read from the seal alone: the
 * same field served beside it is dropped, never used where the seal holds none.
 */
export function openRun(rec: SealedRun, viewingKey: CompanyKeys): PayrollRun {
  const {
    sealed, keyEpoch, proposalIds: _flat, employees: _e, totals: _t, payout: _p, skips: _s, repeats: _r, list: _l, ...operational
  } = rec as SealedRun & Partial<Pick<PayrollRun, 'employees' | 'totals' | 'payout' | 'skips' | 'repeats' | 'list'>>;
  return { ...operational, ...openRecord<Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds'>>(SERVICE.runsRecord, rec.accountId, sealed, keysByPurpose(viewingKey).at(keyEpoch)) } as PayrollRun;
}

/** A proposal as this device reads it, the plain fields put back last so the envelope cannot override them. */
export function openProposal(rec: SealedProposal, viewingKey: CompanyKeys): Proposal {
  const { sealed, keyEpoch, approvalCount: _count, wiring: _wiring, ...open } = rec;
  return { ...openRecord<Omit<Proposal, 'id' | 'accountId' | 'status' | 'createdAt' | 'executedAt' | 'digest' | 'txRef' | 'chainId'>>(SERVICE.proposalsRecord, rec.accountId, sealed, keysByPurpose(viewingKey).at(keyEpoch)), ...open } as Proposal;
}
