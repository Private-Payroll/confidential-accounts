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

/**
 * What `sealPoliciesToNewSignersHere` did: the policies it sealed again; each it could not, with why; each it left
 * alone because nothing was owed or this device cannot tell, with why; each owed a new seal that this seat may not
 * file; and whether this seat files none, because this device does not believe it may file a policy (its role, no seat
 * under these keys, or a seat it does not believe).
 */
export interface PoliciesResealed {
  readonly sealed: readonly string[];
  readonly refused: ReadonlyArray<{ readonly id: string; readonly why: string }>;
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly why: string }>;
  readonly owed: readonly string[];
  readonly notThisSeat: boolean;
}

/** Why a policy in force is not sealed again from a device that cannot open the version the chain commits to. */
export const POLICY_NOT_OPENED_HERE = 'no version of it this device can open makes the commitment the chain holds, so it is '
  + 'not sealed again from here; a signer who may set spending policies and can open it seals it again from their own device';

/**
 * **EVERY SPENDING POLICY IN FORCE, SEALED TO EVERY SIGNER WHO STAYS AND EVERY POLICY READER**, from a
 * device whose seat may file a spending policy; a device whose seat may not files
 * nothing and names in `owed` each policy a seat that may still has to seal. For each policy the chain holds,
 * when a seat this device believes now, or a reader the read grants in force
 * give `policy`, is missing from the version that opens the chain's commitment,
 * that same opening - same terms, same blinding - is filed again as the
 * record's next version, sealed to every seat this device believes now and
 * every such reader, and to no retired seat. The commitment, and so the vault's
 * period total, do not change, and no proposal is raised. A device that cannot
 * open the policy in force files nothing for it and says so in `refused`. It runs
 * at the end of the seat actions in the wallet that run the upkeep; a policy that
 * fails is said and stops no other.
 *
 * The next version is the highest served plus one, as a policy raise picks it:
 * when both file at once, the service keeps the first and refuses the second,
 * and the one refused is said here or refused to its raiser, never lost. A
 * re-seal filed after a raise does not displace it: the version in force is the
 * one making the chain's commitment, never simply the newest.
 */
export async function sealPoliciesToNewSignersHere(doors: PolicyResealDoors): Promise<PoliciesResealed> {
  const policies = policiesOf(doors.records);
  const here = await doors.records.directory(kindAsked('company', SPENDING_POLICY_KIND));
  const mayFile = (await mayFileHere(async () => here, doors.filingKey, SPENDING_POLICY_KIND)) === null;
  const signers = await believedSigners(doors);
  const staying = signers.map((x) => x.id.toLowerCase());
  const sealed: string[] = [];
  const refused: { id: string; why: string }[] = [];
  const skipped: { id: string; why: string }[] = [];
  const owed: string[] = [];
  for (const id of namedHere(here, 'company', SPENDING_POLICY_KIND)) {
    try {
      const onChain = (await policies.onChain([id])).get(id.toLowerCase()) ?? null;
      if (onChain === null) { skipped.push({ id, why: 'the chain holds no commitment for it, so no version of it is in force' }); continue; }
      let inForce: { rec: SealedCompanyRecord; secrets: SpendingPolicySecrets } | null = null;
      const { judged, believed } = await versionsHere(doors, id);
      /* The believed versions first; then one judged and not believed, which no device reads until it is sealed again. */
      for (const rec of [...[...believed].sort((a, b) => b.version - a.version), ...[...judged].sort((a, b) => b.version - a.version)]) {
        let secrets: SpendingPolicySecrets;
        try {
          secrets = openSpendingPolicy(rec, policies.me).secrets;
        } catch {
          /* A version not sealed to this seat is not the one to seal again; another may be, and none opening is said below. */
          continue;
        }
        const made = await keysHere(doors, secrets.vault, secrets.asset, secrets.opening);
        if (made.policyKey.toLowerCase() !== id.toLowerCase() || String(made.commitment).toLowerCase() !== onChain.toLowerCase()) continue;
        inForce = { rec, secrets };
        break;
      }
      if (inForce === null) {
        if (mayFile) refused.push({ id, why: POLICY_NOT_OPENED_HERE });
        else skipped.push({ id, why: 'this device cannot open the version in force, and its seat files no policy' });
        continue;
      }
      const readers = readersOf(inForce.rec);
      if (believed.includes(inForce.rec) && staying.every((x) => readers.has(x))) { skipped.push({ id, why: 'every signer and policy reader already opens it' }); continue; }
      if (!mayFile) { owed.push(id); continue; }
      const newest = (await policies.versions(id)).reduce((n, r) => Math.max(n, r.version), 0);
      await policies.file(sealSpendingPolicy({
        company: doors.accountId, id: id as Hex, version: newest + 1, keyEpoch: epochInForce(doors.viewingKey, doors.keyEpoch),
        secrets: { vault: inForce.secrets.vault, asset: inForce.secrets.asset, opening: inForce.secrets.opening }, signers,
      }));
      sealed.push(id);
    } catch (e) {
      (mayFile ? refused : skipped).push({ id, why: String((e as Error)?.message ?? e) });
    }
  }
  return { sealed, refused, skipped, owed, notThisSeat: !mayFile };
}
