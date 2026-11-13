/**
 * One sealed company record filed by this seat and entered in the company's records, with the act's own refusals: a
 * version another signer filed at the same moment (`filed-meanwhile`), one not filed (`not-filed`), and one filed and
 * not entered (`not-entered`). Used by every act that files a policy record from the wallet.
 */
import type { Hex } from '../../../../src/core/crypto.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import type { SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { VaultPoolVersionAlreadyFiled } from '../../../../src/midnight/vault-pool.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { enteredFor, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type Words } from './definition.js';
import { ActionStopped } from './run.js';

const said = (e: unknown): string => String((e as Error)?.message ?? e);

export async function companyRecordFiledHere(
  r: CompanyReach, rec: SealedCompanyRecord, why: (key: string, values?: Readonly<Record<string, string | number>>) => Words,
): Promise<void> {
  const store = new HttpCompanyRecordStore(r.accountId, r.send, r.seat.signingSecret as Hex, r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster));
  try {
    await store.put(rec);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    if (e instanceof VaultPoolVersionAlreadyFiled) throw new StepRefused(why('filed-meanwhile'), codeOfError(e));
    throw new StepRefused(why('not-filed', { says: said(e) }), codeOfError(e));
  }
  try {
    await enteredFor(r).enter([companyRecordEntry(rec)]);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    throw new StepRefused(why('not-entered', { says: said(e) }), codeOfError(e));
  }
}
