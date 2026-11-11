/**
 * **A VAULT'S SPENDING POLICIES, AS THIS WALLET'S SEAT READS THEM.** The one door every wallet act reads a vault's
 * spending policies through: the versions the service holds, this seat's key, the contract's keys and the chain's
 * entries, and the readers of the read grants a policy is sealed to beside the seats.
 */
import type { Hex } from '../../../../src/core/crypto.js';
import { companyWirePaths, fromCompanyWire, type SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { SPENDING_POLICY_KIND } from '../../../../src/midnight/spending-policy-record.js';
import type { CompanyRecordsHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { chainReadThroughTheWallet } from '../../../../packages/web-shared/src/spending-policy-here.js';
import { deviceSignerFrom } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { grantsHere, grantsServedBy, policyReadersIn } from '../../../../packages/web-shared/src/purpose-wraps.js';
import type { CompanyReach } from './company-reach.js';
import { StepRefused } from './definition.js';

/** What of this wallet's reach the policies are read through: this seat's keys, the service, the worker's keys, the chain's entries and the directory. */
export type SpendingPoliciesReach = Pick<CompanyReach, 'leaf' | 'companyKey' | 'api' | 'accountId' | 'account' | 'label' | 'companyKeys' | 'roster'> & {
  readonly builder: Pick<CompanyReach['builder'], 'spendingPolicyKeys'>;
  readonly chain: Pick<CompanyReach['chain'], 'roles'>;
  readonly judges: Pick<CompanyReach['judges'], 'directoryHereFor'>;
};

/**
 * **A VAULT'S SPENDING POLICIES AS THIS SEAT READS THEM, AND NEVER FILES THEM**: every version of a policy's sealed
 * record as the service holds it, each judged where it is used; this seat's key to open them; the contract's keys made
 * in the worker; and what the chain holds under each key, read through this wallet's own indexer. Filing is refused:
 * no action that reads policies through this door, a payment or an approval of another seat's policy, writes one.
 */
export const spendingPoliciesFor = (r: SpendingPoliciesReach): NonNullable<CompanyRecordsHere['spendingPolicies']> => {
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  return {
    versions: async (id) => {
      const b = await r.api(companyWirePaths.versions(r.accountId, SPENDING_POLICY_KIND, id)) as { versions?: unknown } | null;
      return Array.isArray(b?.versions)
        ? b!.versions.map((m) => fromCompanyWire(m, { company: r.accountId, kind: SPENDING_POLICY_KIND, id }).sealed) as SealedCompanyRecord[] : [];
    },
    file: async () => { throw new Error('a payment, or an approval of another seat\'s policy, files no spending policy.'); },
    me: { signerId: me.signerId, wrappingSecret: me.wrappingSecret as Hex },
    keys: (input) => r.builder.spendingPolicyKeys(input),
    onChain: chainReadThroughTheWallet(async (asked) => {
      if (r.chain.roles === undefined) throw new Error('this wallet cannot read the account\'s entries.');
      const read = await r.chain.roles(r.account, r.label, asked);
      if ('key' in read) throw new StepRefused(read);
      return { roles: read };
    }),
    /* The read grants as this seat's device believes them, from the directory every act reads: the readers given `policy`. */
    grantReaders: async () => policyReadersIn(await grantsHere({
      accountId: r.accountId, versions: grantsServedBy(r.api, r.accountId),
      directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster),
      me: { signerId: me.signerId, wrappingSecret: me.wrappingSecret as Hex },
    })),
  };
};
