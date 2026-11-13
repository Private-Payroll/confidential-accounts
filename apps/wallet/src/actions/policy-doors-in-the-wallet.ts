/**
 * **A VAULT'S SPENDING POLICIES, AS THIS WALLET'S SEAT READS AND FILES THEM.** The shared door every reader of a policy
 * goes through (`spendingPoliciesFor`), given this wallet's seat, its service, its worker's keys, the chain's entries
 * read through this wallet's own indexer, and the company's directory. Only an act that sets a policy is given the
 * filing door, which signs each version with the seat this wallet holds and enters it in the company's records; a
 * payment or an approval of another seat's policy files none.
 */
import type { Hex } from '../../../../src/core/crypto.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import type { SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { spendingPoliciesFor } from '../../../../packages/web-shared/src/spending-policies-reach.js';
import { enteredFor, type CompanyReach } from './company-reach.js';
import { StepRefused } from './definition.js';

/** Files one version of a policy's sealed record signed with this wallet's seat, judged as every company record it files is, and enters it. */
const policyFiledBy = (r: CompanyReach) => async (rec: SealedCompanyRecord): Promise<void> => {
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const secret = r.seat.signingSecret as Hex;
  await new HttpCompanyRecordStore(r.accountId, r.send, secret, judge).put(rec);
  await enteredFor(r).enter([companyRecordEntry(rec)]);
};

/**
 * The company's spending policies as this wallet's seat reads them; with `files`, a version this seat files is signed
 * by it and entered. A chain read this wallet cannot make refuses the step with the wallet's own words.
 */
export const policiesInTheWallet = (r: CompanyReach, o: { readonly files?: true } = {}): NonNullable<CompanyRecordsHere['spendingPolicies']> =>
  spendingPoliciesFor({
    accountId: r.accountId, leaf: r.leaf, companyKey: r.companyKey, api: (path) => r.api(path),
    keys: (input) => r.builder.spendingPolicyKeys(input),
    roles: async (asked) => {
      if (r.chain.roles === undefined) throw new Error('this wallet cannot read the account\'s entries.');
      const read = await r.chain.roles(r.account, r.label, asked);
      if ('key' in read) throw new StepRefused(read);
      return { roles: read };
    },
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster),
    ...(o.files === true ? { file: policyFiledBy(r) } : {}),
  });
