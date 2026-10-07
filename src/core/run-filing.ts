/**
 * **A PAYROLL RUN AS A SIGNER'S DEVICE FILES IT: SEALED THERE, AND SIGNED BY
 * THE SEAT THAT FILED IT.**
 *
 * A run's numbers are sealed under the company's viewing key and its payslips
 * each to their payee, on the device that draws it; the service keeps what it
 * is given and opens none of it. The seat's signature covers the run whole as
 * it is kept - what finds it, its sealed numbers and every payslip - for this
 * company, so a run cannot be filed for another company, and no part of one can
 * be changed after it is signed, without the signature failing.
 *
 * Pure: the page and the service both import it.
 */
import { canonical, sign, signingPublicKeyOf, verify, type Hex } from './crypto.js';
import { canonicalPeriod } from './run-legs.js';
import type { SealedRun } from './types.js';

const DOMAIN = 'confidential-accounts/run-filing/v1';

/** A run as it is kept, before it is signed. */
export type RunToFile = Omit<SealedRun, 'wiring' | 'filedBy'>;

/** A run as it is filed: kept, and signed by the seat that filed it. */
export type SignedRunFiling = RunToFile & { readonly filedBy: { readonly publicKey: Hex; readonly signature: Hex } };

/** The run as it is kept, without who wrote it or who signed it: what the signature covers. */
const keptPart = (r: RunToFile & { readonly wiring?: unknown; readonly filedBy?: unknown }): RunToFile => {
  const { wiring: _wiring, filedBy: _filedBy, ...kept } = r;
  return kept;
};

/** The bytes a seat signs for a run it files for `company`. */
export const runFilingMessage = (company: string, r: RunToFile): string =>
  canonical({ domain: DOMAIN, company, run: keptPart(r) });

/** A run, signed by the seat whose signing secret this is. */
export const signRunFiling = (company: string, r: RunToFile, signingSecret: Hex): SignedRunFiling => ({
  ...keptPart(r),
  filedBy: { publicKey: signingPublicKeyOf(signingSecret), signature: sign(runFilingMessage(company, keptPart(r)), signingSecret) },
});

const RUN_ID = /^run_[A-Za-z0-9_-]{12}$/u;

/**
 * Why `f` is not a run a seat of `company` filed whole, or null when it is:
 * a run of this company under a run's name, for a month written as a month, at
 * a key epoch, with sealed numbers and payslips, and signed over exactly that.
 */
export const runFilingRefusal = (company: string, f: unknown): string | null => {
  if (typeof f !== 'object' || f === null) return 'it is not a run';
  const r = f as Partial<SignedRunFiling>;
  if (typeof r.id !== 'string' || !RUN_ID.test(r.id)) return 'it does not carry a run\'s name';
  if (r.accountId !== company) return 'it is a run of another company';
  if (typeof r.period !== 'string') return 'it does not say which month it pays';
  try {
    if (canonicalPeriod(r.period) !== r.period) return 'its month is not written as a month';
  } catch {
    return 'its month is not written as a month';
  }
  if (r.status !== 'draft' && r.status !== 'proposed' && r.status !== 'settled') return 'it does not say where it stands';
  if (!Number.isInteger(r.keyEpoch) || (r.keyEpoch as number) < 0) return 'it does not say which key it is sealed under';
  const s = r.sealed as { iv?: unknown; tag?: unknown; body?: unknown } | undefined;
  if (typeof s !== 'object' || s === null || typeof s.iv !== 'string' || typeof s.tag !== 'string' || typeof s.body !== 'string') {
    return 'it carries no sealed numbers';
  }
  if (!Array.isArray(r.payslips)) return 'it carries no payslips';
  if (r.proposalIds !== undefined && (!Array.isArray(r.proposalIds) || r.proposalIds.some((p) => typeof p !== 'string'))) {
    return 'its proposals are not a list of names';
  }
  const by = r.filedBy as Partial<SignedRunFiling['filedBy']> | undefined;
  if (typeof by?.publicKey !== 'string' || typeof by.signature !== 'string') return 'it is not signed';
  let ok = false;
  try { ok = verify(runFilingMessage(company, keptPart(r as RunToFile)), by.signature, by.publicKey); } catch { ok = false; }
  return ok ? null : 'its signature does not cover exactly this run for this company';
};
