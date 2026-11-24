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
import { HttpCompanyRecordStore, readsJoinedIn } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { filedTogetherThrough, spendingPoliciesFor, type SpendingPoliciesReach } from '../../../../packages/web-shared/src/spending-policies-reach.js';
import { enteredFor, type CompanyReach } from './company-reach.js';
import { StepRefused } from './definition.js';

/**
 * Files one version of a policy's sealed record through the step's view, signed with this wallet's seat and judged as
 * every company record it files is, and enters it.
 */
const policyFiledBy = (r: CompanyReach) => async (rec: SealedCompanyRecord): Promise<void> => {
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const secret = r.seat.signingSecret as Hex;
  await new HttpCompanyRecordStore(r.accountId, readsJoinedIn(r.stepView), secret, judge).put(rec);
  await enteredFor(r).enter([companyRecordEntry(rec)]);
};

/**
 * Many versions of policies' sealed records filed as one checked batch through the step's view, each signed with this
 * wallet's seat, and those filed entered with one entry write (`filedTogetherThrough`).
 */
const policiesFiledTogetherBy = (r: CompanyReach): NonNullable<SpendingPoliciesReach['fileEach']> => (recs) => filedTogetherThrough(
  r.accountId, r.stepView, r.seat.signingSecret as Hex, r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster), enteredFor(r),
)(recs);

/**
 * The company's spending policies as this wallet's seat reads them; with `files`, a version this seat files is signed
 * by it and entered, alone or with others as one checked batch. A chain read this wallet cannot make refuses the step with the wallet's own words.
 */
export const policiesInTheWallet = (r: CompanyReach, o: { readonly files?: true } = {}): NonNullable<CompanyRecordsHere['spendingPolicies']> =>
  spendingPoliciesFor({
    accountId: r.accountId, leaf: r.leaf, companyKey: r.companyKey, records: r.records,
    keys: (input) => r.builder.spendingPolicyKeys(input),
    keysOfEach: (pairs) => r.builder.spendingPolicyKeysOfEach(pairs),
    roles: async (asked) => {
      if (r.chain.roles === undefined) throw new Error('this wallet cannot read the account\'s entries.');
      const read = await r.chain.roles(r.account, r.label, asked);
      if ('key' in read) throw new StepRefused(read);
      return { roles: read };
    },
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster),
    ...(o.files === true ? { file: policyFiledBy(r), fileEach: policiesFiledTogetherBy(r) } : {}),
  });
