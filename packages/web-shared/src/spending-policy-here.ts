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
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import type { PolicyOpening } from '../../../contracts/src/witnesses.js';
import type { AccountRoleEntry } from 'midnight-identity/profile/records-key';
import { MOST_ROLES_ASKED } from 'midnight-identity/profile/request';
import type { SpendingPolicyKeys } from './governed-call-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { judgeIn, readersIn } from './vault-page-doors.js';
import { signedStateHere, type CompanyRecordsHere, type SpendingPoliciesHere } from './run-rebuilt-here.js';
import { governOnDevice, type GovernanceDoors, type GovernedOutcome, type BarsOnTheChain } from './governed-call-on-device.js';

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
 * holds an entry for. Any other version is passed over, never opened.
 */
async function believedVersions(doors: SpendingPolicyDoors, id: string): Promise<readonly SealedCompanyRecord[]> {
  const policies = policiesOf(doors.records);
  const [served, here] = await Promise.all([policies.versions(id), doors.records.directory()]);
  const judge = judgeIn(here);
  const seats = new Set(here.dir.seats.map((x) => x.seat.toLowerCase()));
  return served.filter((rec) => rec.company === doors.accountId && rec.kind === SPENDING_POLICY_KIND && rec.id === id
    && judge(verifiedCompanyFiler(rec), SPENDING_POLICY_KIND, companyRecordKey(SPENDING_POLICY_KIND, id), rec.version) === null
    && rec.wrapped.length > 0 && rec.wrapped.every((w) => seats.has(String(w.signerId).toLowerCase())));
}

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

/** The terms written the one way a policy record writes them, refused unless the contract could open them. */
const termsChecked = (terms: PolicyTermsOnTheWire): PolicyTermsOnTheWire => policyTermsToWire(policyTermsFromWire(terms));

/**
 * **THE OPENING TO RAISE FOR THESE TERMS**: one already filed for this vault
 * and currency with exactly these terms and not yet the one the chain holds -
 * a change being approved - when this device believes its filing and it is
 * sealed to exactly the seats it believes now; or else a new one under a fresh
 * blinding, filed now, sealed to those seats, as the record's next version.
 * A version is never reused for its terms alone.
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
  for (const rec of [...versions].sort((a, b) => b.version - a.version)) {
    let secrets: SpendingPolicySecrets;
    try {
      secrets = openSpendingPolicy(rec, policies.me).secrets;
    } catch {
      continue;
    }
    if (secrets.vault !== vault.toLowerCase() || secrets.asset !== asset || !sameTerms(secrets.opening.terms, terms)) continue;
    if (onChain !== null && (await commitmentOf(secrets.opening)).toLowerCase() === onChain.toLowerCase()) {
      throw new PolicyNotOpenedHere('This vault already has exactly this spending policy for this currency.');
    }
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
};

/**
 * The approvals a change to a spending policy is carried out at: the higher of
 * the account's and the bar the chain keeps. The account keeps the bar in the
 * same map as each vault's own approvals, under the bar's key, and the
 * account's status hands that map over whole, so the bar is found there. Only
 * whether to try carrying the change out: the chain refuses one short of its
 * bar whatever this says.
 */
const policyBarFrom = (barKey: string) => (bars: BarsOnTheChain): number => {
  const kept = bars.vaultThresholds.find((v) => v.vault.toLowerCase() === barKey.toLowerCase())?.threshold;
  return Math.max(bars.threshold, kept ?? bars.threshold);
};

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
  const onChain = (await policiesOf(doors.records).onChain([keys.policyKey])).get(keys.policyKey.toLowerCase()) ?? null;
  const opening = await openingToRaise(here, vault, asset, terms, keys, onChain);
  const commitment = await commitmentHere(here, vault, asset)(opening);
  const blinding = await blindingHere(here);
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'spending-policy', vault, assetKey: keys.assetKey, commitment },
    summary: 'Set this vault\'s spending policy for one currency',
    body: { vault: vault as Hex, assetKey: keys.assetKey as Hex, commitment: commitment as Hex },
    /* Every device that approves or carries it out opens the policy it is approving, from the company's records. */
    before: async () => {
      await policyOpeningFor(await believedVersions(here, keys.policyKey), policiesOf(here.records).me,
        { vault, asset, commitment }, commitmentHere(here, vault, asset));
    },
    bar: policyBarFrom(keys.barKey),
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
  return (async () => {
    const barKey = await doors.builder.policyBarKey();
    return governOnDevice(doors, {
      viewingKey: input.viewingKey,
      change: { kind: 'policy-bar', bar: String(input.newBar) },
      summary: `Make any change to a spending policy need ${input.newBar} of ${input.seated} approvals`,
      body: { newPolicyBar: input.newBar },
      bar: policyBarFrom(barKey),
    });
  })();
}
