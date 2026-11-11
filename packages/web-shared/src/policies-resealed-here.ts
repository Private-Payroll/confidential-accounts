/**
 * **EVERY SPENDING POLICY IN FORCE, SEALED AGAIN TO EVERY READER WHO STAYS.** Once the signers change, a device whose seat
 * may file a spending policy files each policy in force again, unchanged, to every seat it believes now; how a version is
 * believed and opened is `spending-policy-here.ts`'s.
 */
import { epochInForce } from '../../../src/core/company-key.js';
import type { Hex } from '../../../src/core/crypto.js';
import { openSpendingPolicy, sealSpendingPolicy, SPENDING_POLICY_KIND, type SpendingPolicySecrets } from '../../../src/midnight/spending-policy-record.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { mayFileHere } from './may-file-here.js';
import { kindAsked, namedHere, readersOf } from './vault-page-doors.js';
import { believedSigners, keysHere, policiesOf, versionsHere, type SpendingPolicyDoors } from './spending-policy-here.js';

/** What sealing the policies in force to the signers seated since needs of this device: its own filing key, and the key epoch a bare key names. */
type PolicyResealDoors = SpendingPolicyDoors & { readonly keyEpoch: number; readonly filingKey: string };

/** What `sealPoliciesToNewSignersHere` did: the policies it sealed again, and each it could not, with why. */
export interface PoliciesResealed {
  readonly sealed: readonly string[];
  readonly refused: ReadonlyArray<{ readonly id: string; readonly why: string }>;
}

/**
 * **EVERY SPENDING POLICY IN FORCE, SEALED TO EVERY SIGNER WHO STAYS AND EVERY POLICY READER**, from a
 * device whose seat may file a spending policy. For each policy the chain holds,
 * when a seat this device believes now, or a reader the read grants in force
 * give `policy`, is missing from the version that opens the chain's commitment,
 * that same opening - same terms, same blinding - is filed again as the
 * record's next version, sealed to every seat this device believes now and
 * every such reader, and to no retired seat. The commitment, and so the vault's
 * period total, do not change, and no proposal is raised. A device that cannot
 * open the policy in force files nothing for it. No seat action runs it yet;
 * a policy that fails is said and stops no other.
 */
export async function sealPoliciesToNewSignersHere(doors: PolicyResealDoors): Promise<PoliciesResealed> {
  const policies = policiesOf(doors.records);
  const here = await doors.records.directory(kindAsked('company', SPENDING_POLICY_KIND));
  if ((await mayFileHere(async () => here, doors.filingKey, SPENDING_POLICY_KIND)) !== null) return { sealed: [], refused: [] };
  const signers = await believedSigners(doors);
  const staying = signers.map((x) => x.id.toLowerCase());
  const sealed: string[] = [];
  const refused: { id: string; why: string }[] = [];
  for (const id of namedHere(here, 'company', SPENDING_POLICY_KIND)) {
    try {
      const onChain = (await policies.onChain([id])).get(id.toLowerCase()) ?? null;
      if (onChain === null) continue;
      let inForce: { rec: SealedCompanyRecord; secrets: SpendingPolicySecrets } | null = null;
      const { judged, believed } = await versionsHere(doors, id);
      /* The believed versions first; then one judged and not believed, which no device reads until it is sealed again. */
      for (const rec of [...[...believed].sort((a, b) => b.version - a.version), ...[...judged].sort((a, b) => b.version - a.version)]) {
        let secrets: SpendingPolicySecrets;
        try {
          secrets = openSpendingPolicy(rec, policies.me).secrets;
        } catch {
          continue;
        }
        const made = await keysHere(doors, secrets.vault, secrets.asset, secrets.opening);
        if (made.policyKey.toLowerCase() !== id.toLowerCase() || String(made.commitment).toLowerCase() !== onChain.toLowerCase()) continue;
        inForce = { rec, secrets };
        break;
      }
      if (inForce === null) continue;
      const readers = readersOf(inForce.rec);
      if (believed.includes(inForce.rec) && staying.every((x) => readers.has(x))) continue;
      const newest = (await policies.versions(id)).reduce((n, r) => Math.max(n, r.version), 0);
      await policies.file(sealSpendingPolicy({
        company: doors.accountId, id: id as Hex, version: newest + 1, keyEpoch: epochInForce(doors.viewingKey, doors.keyEpoch),
        secrets: { vault: inForce.secrets.vault, asset: inForce.secrets.asset, opening: inForce.secrets.opening }, signers,
      }));
      sealed.push(id);
    } catch (e) {
      refused.push({ id, why: String((e as Error)?.message ?? e) });
    }
  }
  return { sealed, refused };
}
