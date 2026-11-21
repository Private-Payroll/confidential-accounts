/*
 * A VAULT'S SPENDING POLICY AS A SIGNER'S DEVICE READS IT: the policy records the company's store serves, each version
 * believed only as filed by a seat this device believes and sealed only to seats it believes, the contract's own keys
 * for a policy, and where a vault's policy and a run under it stand. Reading imports nothing that raises or approves a change.
 */
import { type KeysHeld } from '../../../src/core/company-key.js';
import { assetIdHex, type AssetId } from '../../../src/core/assets.js';
import { type Hex } from '../../../src/core/crypto.js';
import {
  periodOf, policyOpeningFor, PolicyNotOpenedHere,
  SPENDING_POLICY_KIND, type PolicyOpeningOnTheWire,
} from '../../../src/midnight/spending-policy-record.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { isReaderId } from '../../../src/midnight/grants-record.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import { companyRecordKey, notOnTheChainNow } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import type { PolicyOpening } from '../../../contracts/src/witnesses.js';
import type { SpendingPolicyKeys } from './governed-call-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { judgeIn, readersIn, readersOf, sealedToARetiredSeat, type DirectoryHere } from './vault-page-doors.js';
import { signedStateHere, type CompanyRecordsHere } from './run-rebuilt-here.js';

/**
 * **A VAULT'S SPENDING POLICIES, AS THIS DEVICE READS AND FILES THEM.** Every
 * version the company's store serves under one policy's key, each believed
 * only as `versionsHere` judges it against the directory this
 * device believes; filing a new version, signed by this device's seat; this
 * signer's own seat and wrapping secret, which open it; the contract's own keys
 * for a policy, made in the worker; and what the company's account holds under
 * given keys, read by the person's own wallet (`chainReadThroughTheWallet`) -
 * never an answer the company's service made. Who a version is sealed to is
 * the seats this device believes (`readersIn`) and the readers the read grants
 * in force give `policy` (`grantReaders`, `policyReadersIn`).
 */
export interface SpendingPoliciesHere {
  readonly versions: (id: string) => Promise<readonly SealedCompanyRecord[]>;
  readonly file: (rec: SealedCompanyRecord) => Promise<void>;
  readonly me: { readonly signerId: string; readonly wrappingSecret: Hex };
  /** The worker's `spending-policy-keys` ask (`VaultBuilderClient.spendingPolicyKeys`). */
  readonly keys: VaultBuilderClient['spendingPolicyKeys'];
  /** For each key asked, lower-cased, what the account's map of roles holds under it, or null for nothing. */
  readonly onChain: (keys: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;
  /** The readers of the read grants in force that read `policy`, as this device believes them: sealed to beside the seats. */
  readonly grantReaders: () => Promise<readonly PoolSigner[]>;
}

/** What reading a vault's policy needs of this device: the company's records, which carry the policies' own doors. */
export interface SpendingPolicyDoors {
  readonly records: CompanyRecordsHere;
  readonly accountId: string;
  readonly viewingKey: KeysHeld;
}

/** Where a vault stands for one currency, as this device read it. */
type SpendingPolicyStanding =
  /** The vault carries no policy marker: it is paid as it always was, at its approvals, with no bands or limit. */
  | { readonly state: 'none'; readonly keys: SpendingPolicyKeys }
  /** The vault is under a policy, but none for this currency: the chain will charge no run of it, so none is paid. */
  | { readonly state: 'not-for-this-currency'; readonly keys: SpendingPolicyKeys }
  /** The vault's policy for this currency, opened here and making exactly the commitment the chain holds. */
  | {
    readonly state: 'set'; readonly keys: SpendingPolicyKeys; readonly commitment: Hex;
    readonly policy: PolicyOpening; readonly opening: PolicyOpeningOnTheWire; readonly version: number;
  };

export const policiesOf = (records: CompanyRecordsHere): SpendingPoliciesHere => {
  if (records.spendingPolicies === undefined) {
    throw new PolicyNotOpenedHere('This page cannot read the company\'s spending policies. Reload the page to get the current version.');
  }
  return records.spendingPolicies;
};

/** The account's blinding a currency's key is made with, from the state the founding seat signed. */
export const blindingHere = async (doors: SpendingPolicyDoors): Promise<string> =>
  (await signedStateHere(doors.records, doors.accountId, doors.viewingKey)).assetBlinding;

/** The contract's own keys for this vault and currency, with `opening` the commitment it makes, and with `total` too the approvals its band needs. */
export const keysHere = async (
  doors: SpendingPolicyDoors, vault: string, asset: Hex, opening?: PolicyOpeningOnTheWire, total?: bigint,
): Promise<SpendingPolicyKeys> => policiesOf(doors.records).keys({
  vault: vault.toLowerCase(), asset, assetBlinding: await blindingHere(doors), ...(opening === undefined ? {} : { policy: opening }),
  ...(opening === undefined || total === undefined ? {} : { total: total.toString() }),
});

/**
 * **THE VERSIONS OF ONE POLICY'S RECORD THIS DEVICE BELIEVES**, from what the
 * company's store serves: each filed for this company under this key, its
 * filing signed by a seat the directory this device believes says may file a
 * spending policy at that version, and sealed only to seats that directory
 * holds an entry for and to readers of a read grant (`isReaderId`): a version
 * sealed to a reader whose grant was taken away since stays believed, so a
 * taking-away never shuts a policy in force out of reach. Two more rules keep a policy out of the wrong hands and
 * in the right ones: a version is sealed to no seat already retired before the
 * batch that anchored it (`sealedToARetiredSeat`), so a signer who left reads
 * no policy set after they left; and a version is sealed to every reader of the
 * believed version before it who stays (`leavesOutAStayingReader`), so no
 * filing can shut a staying signer out. Any other version is passed over,
 * never opened.
 */
export async function believedVersions(doors: SpendingPolicyDoors, id: string): Promise<readonly SealedCompanyRecord[]> {
  return (await versionsHere(doors, id)).believed;
}

/**
 * The versions of one policy's record as `believedVersions` reads them, with
 * `judged` too: every version whose filing and readers pass, before the two
 * rules about who left and who stays. What the chain holds may be opened by a
 * judged version no device believes; `sealPoliciesToNewSignersHere` seals its
 * opening again to the signers who stay, so that is never the end.
 */
export async function versionsHere(
  doors: SpendingPolicyDoors, id: string,
): Promise<{ readonly judged: readonly SealedCompanyRecord[]; readonly believed: readonly SealedCompanyRecord[] }> {
  const policies = policiesOf(doors.records);
  const [served, here] = await Promise.all([policies.versions(id), doors.records.directory({ records: [{ store: 'company', kind: SPENDING_POLICY_KIND, id }] })]);
  const judge = judgeIn(here);
  const seats = new Set(here.dir.seats.map((x) => x.seat.toLowerCase()));
  const passed = served.filter((rec) => rec.company === doors.accountId && rec.kind === SPENDING_POLICY_KIND && rec.id === id
    && judge(verifiedCompanyFiler(rec), SPENDING_POLICY_KIND, companyRecordKey(SPENDING_POLICY_KIND, id), companyRecordEntry(rec)) === null
    && rec.wrapped.length > 0 && rec.wrapped.every((w) => seats.has(String(w.signerId).toLowerCase()) || isReaderId(String(w.signerId))));
  const anchored = new Map((here.records.history.get(recordKeyOf({ store: 'company', kind: SPENDING_POLICY_KIND, id })) ?? [])
    .map((v) => [v.version, v] as const));
  const believed: SealedCompanyRecord[] = [];
  for (const rec of [...passed].sort((a, b) => a.version - b.version)) {
    if (sealedToARetiredSeat(here, anchored.get(rec.version) ?? null, rec)) continue;
    if (leavesOutAStayingReader(here, believed[believed.length - 1], rec)) continue;
    believed.push(rec);
  }
  return { judged: passed, believed };
}

/**
 * Whether a version leaves out a reader of the believed version before it who
 * stays: a seat the directory has not retired and the chain holds. Judged from
 * the directory and the chain alone, never from the roster this device
 * opened, which can lag, so a version is believed or not the same way on every
 * device and at every read. The first version is judged by the other rules
 * alone. A signer seated since may be left out here; they are sealed in by
 * `sealPoliciesToNewSignersHere`.
 */
const leavesOutAStayingReader = (here: DirectoryHere, before: SealedCompanyRecord | undefined, rec: SealedCompanyRecord): boolean => {
  if (before === undefined) return false;
  const readers = readersOf(rec);
  const earlier = readersOf(before);
  return here.dir.seats.some((x) => earlier.has(x.seat.toLowerCase()) && x.retired === null && notOnTheChainNow(x, here.holders) === null
    && !readers.has(x.seat.toLowerCase()));
};

/** The seats this device believes now, each to the records key its own entry names: who a new version is sealed to. */
export const believedSigners = async (doors: SpendingPolicyDoors): Promise<readonly PoolSigner[]> =>
  [...await readersIn(doors.records.directory).signers(), ...await policiesOf(doors.records).grantReaders()];

/** The commitment an opening makes, by the contract's own function. */
export const commitmentHere = (doors: SpendingPolicyDoors, vault: string, asset: Hex) => async (opening: PolicyOpeningOnTheWire): Promise<Hex> => {
  const made = (await keysHere(doors, vault, asset, opening)).commitment;
  if (made === null) throw new PolicyNotOpenedHere('This device could not work out what the spending policy commits to.');
  return made;
};

/**
 * **A VAULT'S SPENDING POLICY FOR ONE CURRENCY, AS THE CHAIN HOLDS IT, OPENED
 * HERE.** The one place a policy is read on a device: the raise check, the
 * charge before a payment, and every page that shows a policy read it here.
 */
export async function spendingPolicyHere(doors: SpendingPolicyDoors, input: { vault: string; asset: AssetId }): Promise<SpendingPolicyStanding> {
  const policies = policiesOf(doors.records);
  const asset = assetIdHex(input.asset) as Hex;
  const keys = await keysHere(doors, input.vault, asset);
  const held = await policies.onChain([keys.onKey, keys.policyKey]);
  if ((held.get(keys.onKey.toLowerCase()) ?? null) === null) return { state: 'none', keys };
  const commitment = held.get(keys.policyKey.toLowerCase()) ?? null;
  if (commitment === null) return { state: 'not-for-this-currency', keys };
  const found = await policyOpeningFor(await believedVersions(doors, keys.policyKey), policies.me,
    { vault: input.vault.toLowerCase(), asset, commitment }, commitmentHere(doors, input.vault, asset));
  return { state: 'set', keys, commitment, policy: found.opening, opening: found.secrets.opening, version: found.version };
}

/** What the raise checks need to know of a run's vault's spending policy, as this device read it for that run. */
export type PolicyForARun =
  /** This device could not read where the vault stands; nothing is raised or approved on a guess. */
  | { readonly state: 'unread'; readonly why: string }
  | { readonly state: 'none' }
  | { readonly state: 'not-for-this-currency' }
  /**
   * The vault's policy for the run's currency: the period the run's whole
   * window lies in (null when it lies in none), the approvals its band needs
   * (null when its total is above every band), and the limit per period.
   */
  | {
    readonly state: 'set'; readonly version: number; readonly period: bigint | null; readonly required: bigint | null;
    readonly periodLimit: bigint;
  };

/**
 * **WHERE A RUN STANDS UNDER ITS VAULT'S SPENDING POLICY**, read here the one
 * way a policy is read (`spendingPolicyHere`), with the approvals its band
 * needs worked out by the contract's own function. Never throws: what could
 * not be read is `unread`, with why.
 */
export async function policyForARunHere(
  doors: SpendingPolicyDoors,
  run: { readonly vault: string; readonly asset: AssetId; readonly total: bigint; readonly opensAt: bigint; readonly closesAt: bigint },
): Promise<PolicyForARun> {
  try {
    const standing = await spendingPolicyHere(doors, { vault: run.vault, asset: run.asset });
    if (standing.state !== 'set') return { state: standing.state };
    const band = (await keysHere(doors, run.vault, assetIdHex(run.asset) as Hex, standing.opening, run.total)).required;
    if (band === undefined) throw new PolicyNotOpenedHere('This device could not work out the approvals this run\'s band needs.');
    return {
      state: 'set', version: standing.version, period: periodOf(standing.policy, { opensAt: run.opensAt, closesAt: run.closesAt }),
      required: band === null ? null : BigInt(band), periodLimit: standing.policy.terms.periodLimit,
    };
  } catch (e) {
    return { state: 'unread', why: String((e as Error)?.message ?? e).replace(/\s*Nothing was built or sent\.\s*$/u, '').replace(/\.?\s*$/u, '') };
  }
}
