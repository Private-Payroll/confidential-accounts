/**
 * **A VAULT'S SPENDING POLICIES, AS ONE SEAT READS THEM.** The one door the person's wallet and the page read a vault's
 * spending policies through: the versions the service holds, the seat's key to open them, the contract's keys and the
 * chain's entries as the person's own wallet reads them, and the readers of the read grants a policy is sealed to
 * beside the seats. It files a policy only through a filing door its caller hands it: the wallet hands one only to the
 * acts that set a policy, which sign with the seat it holds; every other caller files nothing.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { companyWirePaths, fromCompanyWire, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { SPENDING_POLICY_KIND } from '../../../src/midnight/spending-policy-record.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { chainReadThroughTheWallet, type SpendingPoliciesHere } from './spending-policy-here.js';
import { deviceSignerFrom, type DirectoryRead } from './vault-page-doors.js';
import { grantsHere, grantsServedBy, policyReadersIn } from './purpose-wraps.js';

/** What the policies are read through: the seat and the company's key that opens them, the service, the worker's keys, the chain's entries, the directory, and a filing door where one is given. */
export interface SpendingPoliciesReach {
  readonly accountId: string;
  readonly leaf: string;
  readonly companyKey: Hex;
  readonly api: (path: string) => Promise<unknown>;
  readonly keys: SpendingPoliciesHere['keys'];
  /** What the company's account holds under each key asked, as the person's own wallet reads it from the chain. */
  readonly roles: Parameters<typeof chainReadThroughTheWallet>[0];
  readonly directory: DirectoryRead;
  readonly file?: SpendingPoliciesHere['file'];
}

/**
 * **A VAULT'S SPENDING POLICIES AS THIS SEAT READS THEM**: every version of a policy's sealed record as the service
 * holds it, each judged where it is used; this seat's key to open them; the contract's keys made in the worker; and what
 * the chain holds under each key, read through the person's own wallet. Filing is refused unless a filing door is
 * given: a payment, an approval of another seat's policy and a page's reading write none.
 */
export const spendingPoliciesFor = (r: SpendingPoliciesReach): NonNullable<CompanyRecordsHere['spendingPolicies']> => {
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  return {
    versions: async (id) => {
      const b = await r.api(companyWirePaths.versions(r.accountId, SPENDING_POLICY_KIND, id)) as { versions?: unknown } | null;
      return Array.isArray(b?.versions)
        ? b!.versions.map((m) => fromCompanyWire(m, { company: r.accountId, kind: SPENDING_POLICY_KIND, id }).sealed) as SealedCompanyRecord[] : [];
    },
    file: r.file ?? (async () => { throw new Error('a payment, or an approval of another seat\'s policy, files no spending policy.'); }),
    me: { signerId: me.signerId, wrappingSecret: me.wrappingSecret as Hex },
    keys: (input) => r.keys(input),
    onChain: chainReadThroughTheWallet(r.roles),
    /* The read grants as this seat's device believes them, from the directory every reader reads: the readers given `policy`. */
    grantReaders: async () => policyReadersIn(await grantsHere({
      accountId: r.accountId, versions: grantsServedBy(r.api, r.accountId),
      directory: r.directory,
      me: { signerId: me.signerId, wrappingSecret: me.wrappingSecret as Hex },
    })),
  };
};
