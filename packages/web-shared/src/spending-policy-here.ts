/**
 * **A VAULT'S SPENDING POLICY, SET AND READ ON A SIGNER'S OWN DEVICE.**
 *
 * The chain holds a commitment to each vault's policy for each currency, a
 * marker on a vault under a policy, and the approvals any change to a policy
 * needs. The policy itself - its bands, its limit per period, its periods and
 * its blinding - is a record of the company's sealed to the signers
 * (`spending-policy-record.ts`), and only a signer's device opens it.
 *
 * **WHAT IS READ, AND FROM WHERE.** The keys are the contract's own, made in the
 * worker. What the chain holds under them is read by the person's own wallet
 * (`SpendingPoliciesHere.onChain`, made with `chainReadThroughTheWallet`). The
 * record is read from the company's store, and a version is believed only when
 * its filing is signed by a seat this device believes may file it, and every
 * signer it is sealed to is a seat in the directory this device believes;
 * then only the version whose opening makes the commitment the chain holds is
 * taken. A version the service withheld, replaced or served old is refused,
 * never guessed at. A new version is sealed to the seats this device believes
 * now (`readersIn`), never to a list the service hands over.
 *
 * **WHAT IS SET, AND HOW.** A policy and the approvals a policy change needs
 * are governance changes like any other (`governOnDevice`): raised, approved
 * and carried out from signers' devices. Before a policy is raised its opening
 * is filed, sealed to the signers, so every approving device opens the policy
 * it approves, and refuses one it cannot.
 */
import { assetIdHex, type AssetId } from '../../../src/core/assets.js';
import { newBlinding, type Hex } from '../../../src/core/crypto.js';
import {
  periodOf, policyOpeningFor, policyTermsFromWire, policyTermsToWire, openSpendingPolicy, sealSpendingPolicy, PolicyNotOpenedHere,
  SPENDING_POLICY_KIND, type PolicyOpeningOnTheWire, type SpendingPolicySecrets,
} from '../../../src/midnight/spending-policy-record.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey, mayFile, notOnTheChainNow, type Directory } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import type { PolicyOpening } from '../../../contracts/src/witnesses.js';
import type { AccountGovernance, AccountRoleEntry } from 'midnight-identity/profile/records-key';
import { MOST_ROLES_ASKED } from 'midnight-identity/profile/request';
import type { SpendingPolicyKeys } from './governed-call-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { judgeIn, kindAsked, namedHere, readersIn, seatNotBelievedHere, type DirectoryHere } from './vault-page-doors.js';
import { signedStateHere, type CompanyRecordsHere, type SpendingPoliciesHere } from './run-rebuilt-here.js';
import { governOnDevice, type GovernanceDoors, type GovernedOutcome } from './governed-call-on-device.js';

export { PolicyNotOpenedHere };

/** What reading a vault's policy needs of this device: the company's records, which carry the policies' own doors. */
interface SpendingPolicyDoors {
  readonly records: CompanyRecordsHere;
  readonly accountId: string;
  readonly viewingKey: string;
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

const policiesOf = (records: CompanyRecordsHere): SpendingPoliciesHere => {
  if (records.spendingPolicies === undefined) {
    throw new PolicyNotOpenedHere('This page cannot read the company\'s spending policies. Reload the page to get the current version.');
  }
  return records.spendingPolicies;
};

/** The account's blinding a currency's key is made with, from the state the founding seat signed. */
const blindingHere = async (doors: SpendingPolicyDoors): Promise<string> =>
  (await signedStateHere(doors.records, doors.accountId, doors.viewingKey as Hex)).assetBlinding;

/** The contract's own keys for this vault and currency, with `opening` the commitment it makes, and with `total` too the approvals its band needs. */
const keysHere = async (
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
 * holds an entry for. Two more rules keep a policy out of the wrong hands and
 * in the right ones: a version is sealed to no seat already retired before the
 * batch that anchored it (`sealedToARetiredSeat`), so a signer who left reads
 * no policy set after they left; and a version is sealed to every reader of the
 * believed version before it who stays (`leavesOutAStayingReader`), so no
 * filing can shut a staying signer out. Any other version is passed over,
 * never opened.
 */
async function believedVersions(doors: SpendingPolicyDoors, id: string): Promise<readonly SealedCompanyRecord[]> {
  return (await versionsHere(doors, id)).believed;
}

/**
 * The versions of one policy's record as `believedVersions` reads them, with
 * `judged` too: every version whose filing and readers pass, before the two
 * rules about who left and who stays. What the chain holds may be opened by a
 * judged version no device believes; `sealPoliciesToNewSignersHere` seals its
 * opening again to the signers who stay, so that is never the end.
 */
async function versionsHere(
  doors: SpendingPolicyDoors, id: string,
): Promise<{ readonly judged: readonly SealedCompanyRecord[]; readonly believed: readonly SealedCompanyRecord[] }> {
  const policies = policiesOf(doors.records);
  const [served, here] = await Promise.all([policies.versions(id), doors.records.directory({ records: [{ store: 'company', kind: SPENDING_POLICY_KIND, id }] })]);
  const judge = judgeIn(here);
  const seats = new Set(here.dir.seats.map((x) => x.seat.toLowerCase()));
  const passed = served.filter((rec) => rec.company === doors.accountId && rec.kind === SPENDING_POLICY_KIND && rec.id === id
    && judge(verifiedCompanyFiler(rec), SPENDING_POLICY_KIND, companyRecordKey(SPENDING_POLICY_KIND, id), companyRecordEntry(rec)) === null
    && rec.wrapped.length > 0 && rec.wrapped.every((w) => seats.has(String(w.signerId).toLowerCase())));
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

const readersOf = (rec: SealedCompanyRecord): Set<string> => new Set(rec.wrapped.map((w) => String(w.signerId).toLowerCase()));

/**
 * Whether a version is sealed to a seat the directory had already retired
 * before the batch that anchored the version - the directory as anchored
 * through every earlier batch, without that batch's own changes - or, for one
 * not yet anchored, that the directory has retired now. A version filed while
 * the seat was seated and anchored together with its retirement stays
 * believed, so the signers who stay still read the policy in force. A version
 * whose directory this read cannot replay is not believed: nothing is guessed.
 */
const sealedToARetiredSeat = (
  here: DirectoryHere, held: { readonly batch: number; readonly dirVersion: number } | null, rec: SealedCompanyRecord,
): boolean => {
  let dir: Directory | null = here.dir;
  if (held !== null) {
    let before = 0;
    for (let v = 1; v <= held.dirVersion; v += 1) {
      const d = here.records.directory.get(v);
      if (d === undefined) return true;
      if (d.batch < held.batch) before = v;
    }
    /* Nothing anchored before its batch: no seat had been retired yet. */
    if (before === 0) return false;
    dir = here.at(before)?.dir ?? null;
  }
  if (dir === null) return true;
  const readers = readersOf(rec);
  return dir.seats.some((x) => x.retired !== null && readers.has(x.seat.toLowerCase()));
};

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
const believedSigners = (doors: SpendingPolicyDoors) => readersIn(doors.records.directory).signers();

/** The commitment an opening makes, by the contract's own function. */
const commitmentHere = (doors: SpendingPolicyDoors, vault: string, asset: Hex) => async (opening: PolicyOpeningOnTheWire): Promise<Hex> => {
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

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * **WHAT THE COMPANY'S ACCOUNT HOLDS UNDER GIVEN KEYS, READ BY THE PERSON'S OWN
 * WALLET**: the chain read every policy is read through
 * (`SpendingPoliciesHere.onChain`). `ask` puts the keys to the wallet as a
 * holders ask naming them (`holdersFromTheWallet` with `roles`), and the
 * answer is taken only when it names every key asked, in the order asked.
 * Never the account state the company's service serves.
 */
export const chainReadThroughTheWallet = (
  ask: (roles: readonly string[]) => Promise<{ readonly roles?: readonly AccountRoleEntry[] }>,
): SpendingPoliciesHere['onChain'] => async (keys) => {
  const asked = [...new Set(keys.map((k) => String(k).toLowerCase()))];
  if (asked.length === 0) return new Map();
  if (!asked.every((k) => HEX64.test(k))) throw new PolicyNotOpenedHere('This device asked the chain about a key that is not thirty-two bytes.');
  if (asked.length > MOST_ROLES_ASKED) {
    throw new PolicyNotOpenedHere(`Your wallet is asked about at most ${MOST_ROLES_ASKED} of the account's entries at once, and this asks about ${asked.length}.`);
  }
  const read = await ask(asked);
  const roles = read.roles;
  if (roles === undefined || roles.length !== asked.length || roles.some((r, i) => r.key !== asked[i])) {
    throw new PolicyNotOpenedHere('Your wallet did not say what the company\'s account holds under every entry this device asked about.');
  }
  return new Map(roles.map((r) => [r.key, r.value]));
};

/** The terms of a policy, as a person sets them: four bands, a limit per period, and the periods. */
type PolicyTermsOnTheWire = PolicyOpeningOnTheWire['terms'];

const sameTerms = (a: PolicyTermsOnTheWire, b: PolicyTermsOnTheWire): boolean =>
  a.periodLimit === b.periodLimit && a.periodStart === b.periodStart && a.periodLength === b.periodLength
  && a.bands.length === b.bands.length && a.bands.every((x, i) => x.ceiling === b.bands[i]!.ceiling && x.approvals === b.bands[i]!.approvals);

/**
 * The most approvals any band of `terms` asks for: what the account raises its
 * stored policy bar to once a policy with these terms is carried out
 * (`setPolicy`). The approvals a change of who is seated needs are the higher
 * of that bar and the account's threshold, so where the threshold is above the
 * band they do not move.
 */
const highestBandOf = (terms: PolicyTermsOnTheWire): number => Math.max(...terms.bands.map((b) => Number(b.approvals)));

/** The terms written the one way a policy record writes them, refused unless the contract could open them. */
const termsChecked = (terms: PolicyTermsOnTheWire): PolicyTermsOnTheWire => policyTermsToWire(policyTermsFromWire(terms));

/**
 * **THE OPENING TO RAISE FOR THESE TERMS**: one already filed for this vault
 * and currency with exactly these terms and not yet the one the chain holds -
 * a change being approved - when this device believes its filing and it is
 * sealed to exactly the seats it believes now; or else a new one under a fresh
 * blinding, filed now, sealed to those seats, as the record's next version.
 * A version is never reused for its terms alone. Refused when the policy the
 * chain holds already has these terms, under any version: the same terms under
 * a new blinding would start the vault's period total again.
 */
async function openingToRaise(
  doors: SpendingPolicyDoors & { readonly keyEpoch: number }, vault: string, asset: Hex, terms: PolicyTermsOnTheWire,
  keys: SpendingPolicyKeys, onChain: string | null,
): Promise<PolicyOpeningOnTheWire> {
  const policies = policiesOf(doors.records);
  const [versions, served, signers] = await Promise.all([
    believedVersions(doors, keys.policyKey), policies.versions(keys.policyKey), believedSigners(doors)]);
  const sealedTo = [...new Set(signers.map((x) => x.id.toLowerCase()))].sort().join(',');
  const commitmentOf = commitmentHere(doors, vault, asset);
  const sameHere: { rec: SealedCompanyRecord; secrets: SpendingPolicySecrets }[] = [];
  for (const rec of [...versions].sort((a, b) => b.version - a.version)) {
    let secrets: SpendingPolicySecrets;
    try {
      secrets = openSpendingPolicy(rec, policies.me).secrets;
    } catch {
      continue;
    }
    if (secrets.vault !== vault.toLowerCase() || secrets.asset !== asset || !sameTerms(secrets.opening.terms, terms)) continue;
    /* Every version of these terms is checked against the chain before any is reused. */
    if (onChain !== null && (await commitmentOf(secrets.opening)).toLowerCase() === onChain.toLowerCase()) {
      throw new PolicyNotOpenedHere('This vault already has exactly this spending policy for this currency.');
    }
    sameHere.push({ rec, secrets });
  }
  for (const { rec, secrets } of sameHere) {
    /* Reused only when every seat believed now can open it, and nobody else can. */
    if ([...new Set(rec.wrapped.map((w) => String(w.signerId).toLowerCase()))].sort().join(',') !== sealedTo) continue;
    return secrets.opening;
  }
  const opening: PolicyOpeningOnTheWire = { terms, blinding: newBlinding() };
  /* The next version after every one the store holds, believed or not: a version number is never filed twice. */
  const newest = served.reduce((n, r) => Math.max(n, r.version), 0);
  await policies.file(sealSpendingPolicy({
    company: doors.accountId, id: keys.policyKey, version: newest + 1, keyEpoch: doors.keyEpoch,
    secrets: { vault: vault.toLowerCase(), asset, opening }, signers,
  }));
  return opening;
}

/** What setting a policy or the approvals a policy change needs asks of this device. */
export type PolicyGovernanceDoors = GovernanceDoors & {
  readonly builder: GovernanceDoors['builder'] & Pick<VaultBuilderClient, 'policyBarKey'>;
  /**
   * The filing keys of the seats a removal raised and not yet carried out is
   * about, as this device read the company's proposals. Without it, no seat is
   * read as leaving.
   */
  readonly leaving?: () => Promise<ReadonlySet<string>>;
};

/**
 * **A CHANGE TO A VAULT'S SPENDING POLICY THAT THIS DEVICE REFUSES TO RAISE,
 * APPROVE OR CARRY OUT.** Three reasons, each read here from the chain through
 * the person's own wallet and from the company's records:
 * - this device cannot open the policy the chain holds now for this vault and
 *   currency, so it cannot tell a real change from the same terms under a new
 *   blinding, which would start the vault's period total again;
 * - the change is to exactly the terms the chain holds now, under another
 *   commitment, for the same reason;
 * - the version the change names was filed by a seat a raised removal is
 *   about: the terms the company keeps after a signer leaves are set by a
 *   signer who stays, from their own device. (A version filed after the raise
 *   is never believed at all; one filed before it stays readable after the
 *   removal.)
 * Without `proposed`, only the first is checked, before anything is filed.
 */
export async function refusePolicyChangeHere(
  here: SpendingPolicyDoors, vault: string, asset: Hex, keys: SpendingPolicyKeys,
  proposed?: { readonly commitment: string; readonly leaving?: () => Promise<ReadonlySet<string>> },
): Promise<void> {
  const policies = policiesOf(here.records);
  const onChain = (await policies.onChain([keys.policyKey])).get(keys.policyKey.toLowerCase()) ?? null;
  const versions = await believedVersions(here, keys.policyKey);
  const commitmentOf = commitmentHere(here, vault, asset);
  let inForce: PolicyOpeningOnTheWire | null = null;
  if (onChain !== null) {
    try {
      inForce = (await policyOpeningFor(versions, policies.me, { vault: vault as Hex, asset, commitment: onChain as Hex }, commitmentOf)).secrets.opening;
    } catch (e) {
      if (!(e instanceof PolicyNotOpenedHere)) throw e;
      throw new PolicyNotOpenedHere('This device cannot open the spending policy this vault holds now for this currency, so it '
        + 'does not change it: a change it cannot compare with the policy in force could start the vault\'s period total again. '
        + 'A signer who may set spending policies and can read the policy in force re-seals it from their own device; then try '
        + 'again. Nothing was filed or sent.');
    }
  }
  if (proposed === undefined) return;
  const found = await policyOpeningFor(versions, policies.me, { vault: vault as Hex, asset, commitment: proposed.commitment as Hex }, commitmentOf);
  if (inForce !== null && proposed.commitment.toLowerCase() !== String(onChain).toLowerCase()
    && sameTerms(inForce.terms, found.secrets.opening.terms)) {
    throw new PolicyNotOpenedHere('This proposal sets exactly the spending policy this vault already has for this currency, '
      + 'under a new blinding, which would start the vault\'s period total again. Do not approve it; withdraw it.');
  }
  const filer = verifiedCompanyFiler(versions.find((v) => v.version === found.version)!);
  const leaving = proposed.leaving === undefined ? new Set<string>() : await proposed.leaving();
  if (filer !== null && [...leaving].some((k) => k.toLowerCase() === filer.toLowerCase())) {
    throw new PolicyNotOpenedHere('The spending policy this proposal sets was filed by a signer whose removal is raised, and '
      + 'the terms the company keeps after a signer leaves are set by a signer who stays. Do not approve it: a signer who '
      + 'stays sets the policy from their own device.');
  }
}

/**
 * The approvals a change to a spending policy, or to the approvals a policy
 * change needs, is carried out at: the higher of the account's threshold and
 * the bar the chain keeps, which is the seat bar the person's own wallet read
 * off the account (`seatBarOf`). Only whether to try carrying the change out:
 * the chain refuses one short of its bar whatever this says.
 */
const policyBarFrom = (held: AccountGovernance): number => held.seatBar;

/**
 * **ONE VAULT'S SPENDING POLICY FOR ONE CURRENCY, SET AS FAR AS THIS DEVICE
 * CAN.** The same call raises it, approves it from another signer's device,
 * and carries it out once the chain counts the approvals any policy change
 * needs: the opening is the one filed for exactly these terms, or a new one
 * filed now. Every device that approves or carries it out first opens, from
 * the company's records, the policy whose commitment the proposal names, and
 * refuses one it cannot open.
 */
export async function setSpendingPolicyOnDevice(
  doors: PolicyGovernanceDoors,
  input: { viewingKey: string; vault: string; asset: AssetId; terms: PolicyTermsOnTheWire },
): Promise<GovernedOutcome> {
  if (doors.records === undefined) {
    throw new PolicyNotOpenedHere('This page cannot read the company\'s records, so it cannot set a spending policy. Reload the page.');
  }
  if (!/^[0-9a-f]{64}$/iu.test(input.vault)) throw new PolicyNotOpenedHere('That is not a vault\'s address.');
  const here: SpendingPolicyDoors & { keyEpoch: number } = {
    records: doors.records, accountId: doors.accountId, viewingKey: input.viewingKey, keyEpoch: doors.filing.keyEpoch,
  };
  const vault = input.vault.toLowerCase();
  const asset = assetIdHex(input.asset) as Hex;
  const terms = termsChecked(input.terms);
  const keys = await keysHere(here, vault, asset);
  /* Before anything is filed: a device that cannot open the policy in force changes nothing. */
  await refusePolicyChangeHere(here, vault, asset, keys);
  const onChain = (await policiesOf(doors.records).onChain([keys.policyKey])).get(keys.policyKey.toLowerCase()) ?? null;
  const opening = await openingToRaise(here, vault, asset, terms, keys, onChain);
  const commitment = await commitmentHere(here, vault, asset)(opening);
  const blinding = await blindingHere(here);
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'spending-policy', vault, assetKey: keys.assetKey, commitment },
    summary: 'Set this vault\'s spending policy for one currency',
    body: { vault: vault as Hex, assetKey: keys.assetKey as Hex, commitment: commitment as Hex },
    /* Every device that raises, approves or carries it out opens the policy it names, and the policy in force. */
    before: () => refusePolicyChangeHere(here, vault, asset, keys, { commitment, ...(doors.leaving === undefined ? {} : { leaving: doors.leaving }) }),
    bar: policyBarFrom,
    highestBand: highestBandOf(opening.terms),
    carry: (opened) => ({
      circuit: 'setPolicy', vault, commitment, proposal: opened.chainId, proposalSalt: opened.salt,
      asset, assetBlinding: blinding, policy: opening,
    }),
  });
}

/**
 * **THE APPROVALS ANY CHANGE TO A SPENDING POLICY NEEDS, CHANGED AS FAR AS THIS
 * DEVICE CAN**, at the bar that stands today. It may be lowered below a band or
 * a vault's own approvals; a policy set later raises it again to its highest band.
 */
export function setPolicyBarOnDevice(
  doors: PolicyGovernanceDoors, input: { viewingKey: string; newBar: number; seated: number },
): Promise<GovernedOutcome> {
  if (!Number.isInteger(input.newBar) || input.newBar < 1) {
    return Promise.reject(new Error('a change to a spending policy needs at least one approval. Nothing was sent.'));
  }
  if (input.newBar > input.seated) {
    return Promise.reject(new Error(`a change to a spending policy cannot need more approvals than the ${input.seated} signers the `
      + 'company has seated. Seat more signers first, or choose a smaller number. Nothing was sent.'));
  }
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'policy-bar', bar: String(input.newBar) },
    summary: `Make any change to a spending policy need ${input.newBar} of ${input.seated} approvals`,
    body: { newPolicyBar: input.newBar },
    bar: policyBarFrom,
  });
}

/**
 * **WHETHER A REMOVAL'S BOUNDARY LEAVES OUT A SPENDING POLICY VERSION THE
 * LEAVING SEAT FILED**, as this device reads the company's records: every
 * version of every spending policy, anchored or entered and not yet anchored,
 * signed by `leaver`'s filing key, must be at or below the last version
 * `filedUpTo` names for that record. One above it would be believed by no
 * device once the removal is carried out, and a vault whose policy is that
 * version could never pay again. `here` must have been read asking for every
 * spending policy (`kindAsked`). Given `anchoredAtTheHead`, once the
 * removal is raised, only the versions anchored at the head its raise names
 * are judged (the batch each was anchored in is asked): the boundary signed at the raise is final: what the leaving seat files after it counts toward no approval, is not anchored by a device told of the raise (`AnchorDoors.leaving`), and is believed by no device once the retirement is anchored. Null when the boundary holds every version; the reason, in words
 * that say what resolves it, when it does not.
 */
export function removalBoundaryRefusal(
  here: DirectoryHere, leaver: string, filedUpTo: Readonly<Record<string, number>>,
  anchoredAtTheHead?: (batch: number) => boolean,
): string | null {
  const key = leaver.toLowerCase();
  for (const id of namedHere(here, 'company', SPENDING_POLICY_KIND)) {
    const last = filedUpTo[companyRecordKey(SPENDING_POLICY_KIND, id)] ?? 0;
    const seen = [
      ...(here.records.history.get(recordKeyOf({ store: 'company', kind: SPENDING_POLICY_KIND, id })) ?? [])
        .filter((v) => v.filedBy.toLowerCase() === key && (anchoredAtTheHead?.(v.batch) ?? true)).map((v) => v.version),
      ...(anchoredAtTheHead !== undefined ? [] : here.records.notYetAnchored)
        .filter((e) => e.store === 'company' && e.kind === SPENDING_POLICY_KIND && e.id === id && e.filedBy.publicKey.toLowerCase() === key)
        .map((e) => e.version),
    ];
    const past = seen.filter((v) => v > last);
    if (past.length > 0) {
      return `the leaving signer filed version ${Math.max(...past)} of a vault's spending policy, past the last version this `
        + `removal keeps (${last}), so once they are removed no device would believe it. Withdraw this removal and raise it `
        + 'again, so it keeps every version they filed';
    }
  }
  return null;
}

/** What sealing the policies in force to the signers seated since needs of this device: its own filing key, and the company's key epoch. */
export type PolicyResealDoors = SpendingPolicyDoors & { readonly keyEpoch: number; readonly filingKey: string };

/** What `sealPoliciesToNewSignersHere` did: the policies it sealed again, and each it could not, with why. */
export interface PoliciesResealed {
  readonly sealed: readonly string[];
  readonly refused: ReadonlyArray<{ readonly id: string; readonly why: string }>;
}

/**
 * **EVERY SPENDING POLICY IN FORCE, SEALED TO EVERY SIGNER WHO STAYS**, from a
 * device whose seat may file a spending policy. For each policy the chain holds,
 * when a seat this device believes now is missing from the version that opens
 * the chain's commitment, that same opening - same terms, same blinding - is
 * filed again as the record's next version, sealed to every seat this device
 * believes now and to no retired seat. The commitment, and so the vault's
 * period total, do not change, and no proposal is raised. A device that cannot
 * open the policy in force files nothing for it. Run on every way into the
 * company; a policy that fails is said and stops no other.
 */
export async function sealPoliciesToNewSignersHere(doors: PolicyResealDoors): Promise<PoliciesResealed> {
  const policies = policiesOf(doors.records);
  const here = await doors.records.directory(kindAsked('company', SPENDING_POLICY_KIND));
  const mine = here.dir.seats.find((x) => x.signingKey.toLowerCase() === doors.filingKey.toLowerCase());
  if (mine === undefined || seatNotBelievedHere(here, mine) !== null || !mayFile(mine).includes(SPENDING_POLICY_KIND)) {
    return { sealed: [], refused: [] };
  }
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
        company: doors.accountId, id: id as Hex, version: newest + 1, keyEpoch: doors.keyEpoch,
        secrets: { vault: inForce.secrets.vault, asset: inForce.secrets.asset, opening: inForce.secrets.opening }, signers,
      }));
      sealed.push(id);
    } catch (e) {
      refused.push({ id, why: String((e as Error)?.message ?? e) });
    }
  }
  return { sealed, refused };
}
