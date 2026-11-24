/**
 * **EVERY SPENDING POLICY IN FORCE, SEALED AGAIN TO EVERY READER WHO STAYS.** Once the signers change, a device whose seat
 * may file a spending policy files each policy in force again, unchanged, to every seat it believes now; how a version is
 * believed and which is in force is `spending-policy-read-here.ts`'s (`policiesInForceHere`).
 */
import { epochInForce } from '../../../src/core/company-key.js';
import type { Hex } from '../../../src/core/crypto.js';
import { sealSpendingPolicy, SPENDING_POLICY_KIND } from '../../../src/midnight/spending-policy-record.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { mayFileHere } from './may-file-here.js';
import { kindAsked, namedHere, readersOf } from './vault-page-doors.js';
import { believedSigners, policiesInForceHere, policiesOf, type SpendingPoliciesHere, type SpendingPolicyDoors } from './spending-policy-read-here.js';

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
 * The version in force of every policy is found together (`policiesInForceHere`, among the believed versions and then
 * those judged and not believed): what is read to find it is the same however many policies the company holds. Every
 * policy sealed again is filed after the others are read, as one checked batch where the filing door files many at once
 * (`filedAgain`).
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
  const resealed: { readonly id: string; readonly rec: SealedCompanyRecord }[] = [];
  for (const policy of await policiesInForceHere(doors, namedHere(here, 'company', SPENDING_POLICY_KIND), { judged: true })) {
    const { id } = policy;
    try {
      if (policy.state === 'refused') throw policy.why;
      if (policy.state === 'not-held') { skipped.push({ id, why: 'the chain holds no commitment for it, so no version of it is in force' }); continue; }
      if (policy.state === 'opened-by-none') {
        if (mayFile) refused.push({ id, why: POLICY_NOT_OPENED_HERE });
        else skipped.push({ id, why: 'this device cannot open the version in force, and its seat files no policy' });
        continue;
      }
      const inForce = policy.version;
      const readers = readersOf(inForce.rec);
      if (policy.versions.believed.includes(inForce.rec) && staying.every((x) => readers.has(x))) { skipped.push({ id, why: 'every signer and policy reader already opens it' }); continue; }
      if (!mayFile) { owed.push(id); continue; }
      const newest = (await policies.versions(id)).reduce((n, r) => Math.max(n, r.version), 0);
      resealed.push({ id, rec: sealSpendingPolicy({
        company: doors.accountId, id: id as Hex, version: newest + 1, keyEpoch: epochInForce(doors.viewingKey, doors.keyEpoch),
        secrets: { vault: inForce.secrets.vault, asset: inForce.secrets.asset, opening: inForce.secrets.opening }, signers,
      }) });
    } catch (e) {
      (mayFile ? refused : skipped).push({ id, why: String((e as Error)?.message ?? e) });
    }
  }
  for (const [i, outcome] of (await filedAgain(policies, resealed.map((x) => x.rec))).entries()) {
    const { id } = resealed[i]!;
    if (outcome.status === 'fulfilled') sealed.push(id);
    else refused.push({ id, why: String((outcome.reason as Error)?.message ?? outcome.reason) });
  }
  return { sealed, refused, skipped, owed, notThisSeat: !mayFile };
}

/*
 * Each policy's next version filed: as one checked batch where the filing door files many at once, so one upkeep sends
 * every policy sealed again in one write, after one check, and enters them with one entry write; otherwise one at a
 * time. Each is answered on its own, in order: one refused, or filed first by another seat, is said and left for the
 * next seat action, and stops no other filed before it.
 */
const filedAgain = async (policies: SpendingPoliciesHere, recs: readonly SealedCompanyRecord[]): Promise<readonly PromiseSettledResult<void>[]> => {
  if (recs.length === 0) return [];
  if (policies.fileEach !== undefined) {
    try {
      return await policies.fileEach(recs);
    } catch (e) {
      return recs.map(() => ({ status: 'rejected', reason: e }));
    }
  }
  const outcomes: PromiseSettledResult<void>[] = [];
  for (const rec of recs) {
    try {
      outcomes.push({ status: 'fulfilled', value: await policies.file(rec) });
    } catch (e) {
      outcomes.push({ status: 'rejected', reason: e });
    }
  }
  return outcomes;
};
