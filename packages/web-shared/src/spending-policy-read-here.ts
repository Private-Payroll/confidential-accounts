/*
 * A VAULT'S SPENDING POLICY AS A SIGNER'S DEVICE READS IT: the policy records the company's store serves, each version
 * believed only as filed by a seat this device believes and sealed only to seats it believes, the contract's own keys
 * for a policy, and where a vault's policy and a run under it stand. Reading imports nothing that raises or approves a change.
 */
import { type KeysHeld } from '../../../src/core/company-key.js';
import { assetIdHex, type AssetId } from '../../../src/core/assets.js';
import { canonical, type Hex } from '../../../src/core/crypto.js';
import {
  openSpendingPolicy, periodOf, policyOpeningFor, PolicyNotOpenedHere,
  SPENDING_POLICY_KIND, type PolicyOpeningOnTheWire, type SpendingPolicySecrets,
} from '../../../src/midnight/spending-policy-record.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { isReaderId } from '../../../src/midnight/grants-record.js';
import type { PoolSigner } from '../../../src/midnight/vault-pool.js';
import { companyRecordKey, notOnTheChainNow } from '../../../src/midnight/seat-directory.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import type { PolicyOpening } from '../../../contracts/src/witnesses.js';
import type { SpendingPolicyKeys } from './governed-call-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { MOST_ROLES_ASKED } from 'midnight-identity/profile/request';
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
  /**
   * Many versions filed as one checked batch, each answered on its own in the order given, those filed entered with one
   * entry write; absent, each is filed alone through `file`.
   */
  readonly fileEach?: (recs: readonly SealedCompanyRecord[]) => Promise<readonly PromiseSettledResult<void>[]>;
  readonly me: { readonly signerId: string; readonly wrappingSecret: Hex };
  /** The worker's `spending-policy-keys` ask (`VaultBuilderClient.spendingPolicyKeys`). */
  readonly keys: VaultBuilderClient['spendingPolicyKeys'];
  /**
   * The same ask for many at once (`VaultBuilderClient.spendingPolicyKeysOfEach`), each answered on its own; without it,
   * each is asked through `keys`, one ask each.
   */
  readonly keysOfEach?: VaultBuilderClient['spendingPolicyKeysOfEach'];
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
export type SpendingPolicyStanding =
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

/** The versions of one policy's record this device read: those whose filing and readers pass, and of those, those it believes. */
interface VersionsRead { readonly judged: readonly SealedCompanyRecord[]; readonly believed: readonly SealedCompanyRecord[] }

/**
 * The versions of one policy's record as `believedVersions` reads them, with
 * `judged` too: every version whose filing and readers pass, before the two
 * rules about who left and who stays. What the chain holds may be opened by a
 * judged version no device believes; `sealPoliciesToNewSignersHere` seals its
 * opening again to the signers who stay, so that is never the end.
 */
async function versionsHere(doors: SpendingPolicyDoors, id: string): Promise<VersionsRead> {
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

/** One vault, currency and opening of a policy whose contract keys are made. */
export interface OpeningAsked { readonly vault: string; readonly asset: Hex; readonly opening: PolicyOpeningOnTheWire }

/**
 * The contract's keys for each of `asked`, with the commitment its opening makes, in one ask of the worker for all of
 * them (`keysOfEach`), each answered on its own, in the order given; without `keysOfEach`, each is asked through `keys`,
 * one ask each. Nothing is asked when none is.
 */
const keysOfEachOpening = async (
  doors: SpendingPolicyDoors, asked: readonly OpeningAsked[],
): Promise<readonly PromiseSettledResult<SpendingPolicyKeys>[]> => {
  if (asked.length === 0) return [];
  const policies = policiesOf(doors.records);
  const assetBlinding = await blindingHere(doors);
  const pairs = asked.map((a) => ({ vault: a.vault.toLowerCase(), asset: a.asset, assetBlinding, policy: a.opening }));
  return (policies.keysOfEach ?? ((each) => Promise.allSettled(each.map((one) => policies.keys(one)))))(pairs);
};

/** The commitment one key ask made for an opening: refused with the worker's reason, or when none was made. */
const commitmentMade = (m: PromiseSettledResult<SpendingPolicyKeys> | undefined): Hex => {
  if (m?.status === 'rejected') throw m.reason;
  const commitment = m?.value.commitment ?? null;
  if (commitment === null) throw new PolicyNotOpenedHere('This device could not work out what the spending policy commits to.');
  return commitment as Hex;
};

/**
 * What an opening of one of `versions` commits to, for `policyOpeningFor`: the commitments of every version that opens
 * here for this vault and currency, made in one ask of the worker (`keysOfEachOpening`) the first time one is wanted,
 * and none asked when none is. A version whose keys could not be made is refused when it is looked up.
 */
export const commitmentsWhenWanted = (
  doors: SpendingPolicyDoors, versions: readonly SealedCompanyRecord[], vault: string, asset: Hex,
): ((opening: PolicyOpeningOnTheWire) => Promise<Hex>) => {
  const commitments = async (): Promise<(opening: PolicyOpeningOnTheWire) => Hex> => {
    const openings = versionsOpened('', { judged: [], believed: versions }, policiesOf(doors.records).me, false, { vault, asset })
      .map((v) => v.secrets.opening);
    const made = await keysOfEachOpening(doors, openings.map((opening) => ({ vault, asset, opening })));
    const byOpening = new Map(openings.map((o, i) => [canonical(o), made[i]] as const));
    return (opening) => commitmentMade(byOpening.get(canonical(opening)));
  };
  let made: Promise<(opening: PolicyOpeningOnTheWire) => Hex> | null = null;
  return async (opening) => (await (made ??= commitments()))(opening);
};

/**
 * What the company's account holds under each of `keys`, read through the person's own wallet (`onChain`) as many at
 * once as it answers (`MOST_ROLES_ASKED`). A part that fails leaves its keys out, and each of them is then asked alone,
 * so one key the chain cannot answer stops no other. Each key, lower-cased, is answered on its own: what the chain
 * holds under it, or why that could not be read.
 */
const heldOnTheChain = async (
  doors: SpendingPolicyDoors, keys: readonly string[],
): Promise<ReadonlyMap<string, PromiseSettledResult<string | null>>> => {
  const policies = policiesOf(doors.records);
  const asked = [...new Map(keys.map((k) => [k.toLowerCase(), k] as const)).values()];
  const parts: string[][] = [];
  for (let i = 0; i < asked.length; i += MOST_ROLES_ASKED) parts.push(asked.slice(i, i + MOST_ROLES_ASKED));
  const held = new Map<string, PromiseSettledResult<string | null>>();
  for (const part of await Promise.allSettled(parts.map((keysOfPart) => policies.onChain(keysOfPart)))) {
    /* A part that failed is not taken: each of its keys is asked alone below. */
    if (part.status === 'fulfilled') for (const [k, v] of part.value) held.set(k.toLowerCase(), { status: 'fulfilled', value: v });
  }
  const alone = asked.filter((k) => !held.has(k.toLowerCase()));
  const answered = await Promise.allSettled(alone.map(async (k) => (await policies.onChain([k])).get(k.toLowerCase()) ?? null));
  for (const [i, k] of alone.entries()) held.set(k.toLowerCase(), answered[i]!);
  return held;
};

/** One version of a policy that opens on this device, with what it opens to. */
interface VersionOpened {
  readonly id: string; readonly rec: SealedCompanyRecord; readonly secrets: SpendingPolicySecrets; readonly policy: PolicyOpening;
}

/** The vault and currency a policy is read for, where the reader knows them. */
interface PolicyOf { readonly vault: string; readonly asset: Hex }

/*
 * The versions of one policy this device opens, in the order the one in force is looked for among them: the believed
 * versions, newest first; then, with `judged`, those judged and not believed, which no device reads until they are
 * sealed again. A version not sealed to this seat is passed over: another may be. Given `of`, a version that opens to
 * another vault or currency is passed over too, before its keys are asked, as `policyOpeningFor` passes it over.
 */
const versionsOpened = (
  id: string, read: VersionsRead, me: SpendingPoliciesHere['me'], judged: boolean, of?: PolicyOf,
): VersionOpened[] => {
  const newestFirst = (recs: readonly SealedCompanyRecord[]) => [...recs].sort((a, b) => b.version - a.version);
  const notBelieved = judged ? read.judged.filter((rec) => !read.believed.includes(rec)) : [];
  return [...newestFirst(read.believed), ...newestFirst(notBelieved)].flatMap((rec) => {
    let opened: ReturnType<typeof openSpendingPolicy>;
    try {
      opened = openSpendingPolicy(rec, me);
    } catch {
      /* Not sealed to this seat, so not one this device reads; another version may be. */
      return [];
    }
    const { vault, asset } = opened.secrets;
    if (of !== undefined && (vault.toLowerCase() !== of.vault.toLowerCase() || asset.toLowerCase() !== of.asset.toLowerCase())) return [];
    return [{ id, rec, secrets: opened.secrets, policy: opened.opening }];
  });
};

/*
 * The version of policy `id` in force: the first of its versions opened here, in `versionsOpened`'s order, whose keys
 * name this policy and whose opening makes the commitment the chain holds. Keys the worker could not make for a version
 * stop the policy with why, as they always have.
 */
const inForceAmong = (
  id: string, onChain: string, opened: readonly VersionOpened[], made: readonly PromiseSettledResult<SpendingPolicyKeys>[],
): VersionOpened | null => {
  for (const [i, o] of opened.entries()) {
    if (o.id !== id) continue;
    const m = made[i];
    if (m === undefined) throw new Error('This device was not given the keys of every version of the policy it asked about.');
    if (m.status === 'rejected') throw m.reason;
    if (m.value.policyKey.toLowerCase() === id.toLowerCase() && String(m.value.commitment).toLowerCase() === onChain.toLowerCase()) return o;
  }
  return null;
};

/** What was read of a policy the chain holds a commitment for: that commitment, its versions, and what each opening commits to. */
interface PolicyHeld {
  readonly commitment: string;
  readonly versions: VersionsRead;
  /** What an opening of one of its versions commits to, from the one ask of the worker; refused as `commitmentsWhenWanted` refuses. */
  readonly commitmentOf: (opening: PolicyOpeningOnTheWire) => Hex;
}

/**
 * Where one policy stands, as `policiesInForceHere` read it: in force, with the version whose opening makes the
 * commitment the chain holds; opened by none, when the chain holds a commitment no version this device opens makes;
 * not held, when the chain holds no commitment for it, so no version of it is in force; or refused, with why.
 */
type PolicyInForce = { readonly id: string } & (
  | ({ readonly state: 'in-force'; readonly version: VersionOpened } & PolicyHeld)
  | ({ readonly state: 'opened-by-none' } & PolicyHeld)
  | { readonly state: 'not-held' }
  | { readonly state: 'refused'; readonly why: unknown });

/**
 * **THE VERSION IN FORCE OF EACH SPENDING POLICY, READ ON THIS DEVICE**: the one place it is found, for the bands a
 * change counts (`bandsInForceHere`), the policies sealed again to the signers who stay (`sealPoliciesToNewSignersHere`)
 * and every vault and currency's policy read (`spendingPoliciesHere`). What the chain holds under each policy's key is
 * read through the person's own wallet (`heldOnTheChain`, unless `held` carries it already); every policy it holds a
 * commitment for has its record declared at once and its versions read together (`versionsHere`), so the company's view
 * asks for all of them at once; the contract's keys of every version that opens here (`versionsOpened`, with `judged`
 * and, for a policy in `of`, only its vault and currency) are made in one ask of the worker (`keysOfEachOpening`); and
 * the version in force is the first whose keys name the policy and whose opening makes the chain's commitment
 * (`inForceAmong`). What is read is the same however many policies the company holds. Each policy is answered on its
 * own, in the order given: one the chain, the store or the worker cannot answer is refused with why and stops no other;
 * when the one ask of the worker fails, every policy the chain holds a commitment for is refused with it.
 */
export async function policiesInForceHere(
  doors: SpendingPolicyDoors, ids: readonly string[],
  o: {
    readonly judged: boolean;
    readonly held?: ReadonlyMap<string, PromiseSettledResult<string | null>>;
    readonly of?: ReadonlyMap<string, PolicyOf>;
  },
): Promise<readonly PolicyInForce[]> {
  const policies = policiesOf(doors.records);
  const held = o.held ?? await heldOnTheChain(doors, ids);
  const onChain = ids.map((id): PromiseSettledResult<string | null> => held.get(id.toLowerCase())
    ?? { status: 'rejected', reason: new PolicyNotOpenedHere('This device did not ask the chain about every spending policy it reads.') });
  const committed = ids.filter((_, i) => { const c = onChain[i]!; return c.status === 'fulfilled' && c.value !== null; });
  /* Every policy the chain holds a commitment for declared at once, so the view proves them in one held read, not one for each. */
  if (committed.length > 0) await doors.records.directory({ records: committed.map((id) => ({ store: 'company' as const, kind: SPENDING_POLICY_KIND, id })) });
  const read = await Promise.allSettled(ids.map((id, i) => { const c = onChain[i]!; return c.status === 'fulfilled' && c.value !== null ? versionsHere(doors, id) : Promise.resolve(null); }));
  const opened = ids.flatMap((id, i) => { const r = read[i]!; return r.status === 'fulfilled' && r.value !== null ? versionsOpened(id, r.value, policies.me, o.judged, o.of?.get(id)) : []; });
  const made = await keysOfEachOpening(doors, opened.map((v) => ({ vault: v.secrets.vault, asset: v.secrets.asset, opening: v.secrets.opening })))
    .then((l) => ({ l }), (e: unknown) => ({ e }));
  return ids.map((id, i) => {
    try {
      return policyAnswered(id, onChain[i]!, read[i]!, opened, made);
    } catch (why) {
      return { id, state: 'refused', why };
    }
  });
}

/* One policy's answer from what `policiesInForceHere` read, in the order each read is needed; throws why it is refused. */
const policyAnswered = (
  id: string, onChain: PromiseSettledResult<string | null>, read: PromiseSettledResult<VersionsRead | null>,
  opened: readonly VersionOpened[], made: { readonly l: readonly PromiseSettledResult<SpendingPolicyKeys>[] } | { readonly e: unknown },
): PolicyInForce => {
  if (onChain.status === 'rejected') throw onChain.reason;
  if (onChain.value === null) return { id, state: 'not-held' };
  if (read.status === 'rejected') throw read.reason;
  if ('e' in made) throw made.e;
  const commitmentOf = (opening: PolicyOpeningOnTheWire): Hex =>
    commitmentMade(made.l[opened.findIndex((v) => v.id === id && canonical(v.secrets.opening) === canonical(opening))]);
  const policyHeld = { commitment: onChain.value, versions: read.value!, commitmentOf };
  const found = inForceAmong(id, onChain.value, opened, made.l);
  return found === null ? { id, state: 'opened-by-none', ...policyHeld } : { id, state: 'in-force', version: found, ...policyHeld };
};

/**
 * **A VAULT'S SPENDING POLICY FOR ONE CURRENCY, AS THE CHAIN HOLDS IT, OPENED
 * HERE.** The one place a policy is read on a device: the raise check, the
 * charge before a payment, and every page that shows a policy read it here.
 */
export async function spendingPolicyHere(doors: SpendingPolicyDoors, input: PolicyPair): Promise<SpendingPolicyStanding> {
  const policies = policiesOf(doors.records);
  const [standing] = await spendingPoliciesHere(doors, [input], (each) => Promise.allSettled(each.map((one) => policies.keys(one))));
  if (standing!.status === 'rejected') throw standing!.reason;
  return standing!.value;
}

/** One vault and currency whose spending policy is read. */
export interface PolicyPair { readonly vault: string; readonly asset: AssetId }

/** The commitment the chain holds for a pair's policy, or where a pair stands that has none: no policy, or none for its currency. */
const committedUnder = (keys: SpendingPolicyKeys, held: ReadonlyMap<string, string | null>): string | SpendingPolicyStanding => {
  if ((held.get(keys.onKey.toLowerCase()) ?? null) === null) return { state: 'none', keys };
  return held.get(keys.policyKey.toLowerCase()) ?? { state: 'not-for-this-currency', keys };
};

/** A pair's keys and where the chain stands it, from what the chain holds under its keys; refused with why either was not read. */
const committedFor = (
  m: PromiseSettledResult<SpendingPolicyKeys> | undefined, held: ReadonlyMap<string, PromiseSettledResult<string | null>>,
): { readonly keys: SpendingPolicyKeys; readonly under: string | SpendingPolicyStanding } => {
  if (m === undefined) throw new PolicyNotOpenedHere('This device was not given the keys of every vault and currency it asked about.');
  if (m.status === 'rejected') throw m.reason;
  const values = new Map<string, string | null>();
  for (const key of [m.value.onKey.toLowerCase(), m.value.policyKey.toLowerCase()]) {
    const h = held.get(key);
    if (h === undefined) throw new PolicyNotOpenedHere('This device did not ask the chain about every vault and currency it reads.');
    if (h.status === 'rejected') throw h.reason;
    values.set(key, h.value);
  }
  return { keys: m.value, under: committedUnder(m.value, values) };
};

/**
 * Where a pair stands whose policy the chain holds a commitment for, from that policy's answer: set, under the version
 * in force; refused with why; and when no version this device opens makes the commitment, refused in
 * `policyOpeningFor`'s words, over the same versions and the commitments already made, asking nothing more.
 */
async function standingOf(doors: SpendingPolicyDoors, pair: PolicyPair, keys: SpendingPolicyKeys, a: PolicyInForce): Promise<SpendingPolicyStanding> {
  if (a.state === 'refused') throw a.why;
  if (a.state === 'not-held') return { state: 'not-for-this-currency', keys };
  if (a.state === 'in-force') {
    const { version } = a;
    return { state: 'set', keys, commitment: a.commitment as Hex, policy: version.policy, opening: version.secrets.opening, version: version.rec.version };
  }
  const found = await policyOpeningFor(a.versions.believed, policiesOf(doors.records).me,
    { vault: pair.vault.toLowerCase() as Hex, asset: assetIdHex(pair.asset) as Hex, commitment: a.commitment as Hex }, a.commitmentOf);
  return { state: 'set', keys, commitment: a.commitment as Hex, policy: found.opening, opening: found.secrets.opening, version: found.version };
}

/**
 * **EVERY PAIR'S SPENDING POLICY, READ TOGETHER**: the keys of every pair are made in one ask of the worker
 * (`keysOfEach`); what the chain holds under all of them is read through the person's own wallet (`heldOnTheChain`);
 * and the version in force of every policy the chain holds a commitment for is found together (`policiesInForceHere`),
 * each only among the versions that open to its own vault and currency. Each pair is answered on its own, in the order
 * given: a pair whose keys, entries on the chain or opening could not be read is refused with why, never another; when
 * the one ask of the worker for the openings fails, every pair with a policy set is refused with it.
 */
export async function spendingPoliciesHere(
  doors: SpendingPolicyDoors, pairs: readonly PolicyPair[], keysOfEach: VaultBuilderClient['spendingPolicyKeysOfEach'],
): Promise<readonly PromiseSettledResult<SpendingPolicyStanding>[]> {
  const assetBlinding = await blindingHere(doors);
  const made = await keysOfEach(pairs.map((p) => ({ vault: p.vault.toLowerCase(), asset: assetIdHex(p.asset), assetBlinding })));
  const held = await heldOnTheChain(doors, made.flatMap((m) => (m.status === 'fulfilled' ? [m.value.onKey, m.value.policyKey] : [])));
  const committed = pairs.map((_, i) => {
    try {
      return { status: 'fulfilled', value: committedFor(made[i], held) } as const;
    } catch (reason) {
      return { status: 'rejected', reason } as const;
    }
  });
  const set = new Map<string, PolicyOf>();
  for (const [i, c] of committed.entries()) {
    if (c.status === 'fulfilled' && typeof c.value.under === 'string') set.set(c.value.keys.policyKey, { vault: pairs[i]!.vault, asset: assetIdHex(pairs[i]!.asset) as Hex });
  }
  const answers = new Map((await policiesInForceHere(doors, [...set.keys()], { judged: false, held, of: set })).map((a) => [a.id, a] as const));
  return Promise.allSettled(pairs.map(async (pair, i) => {
    const c = committed[i]!;
    if (c.status === 'rejected') throw c.reason;
    const { keys, under } = c.value;
    return typeof under === 'string' ? standingOf(doors, pair, keys, answers.get(keys.policyKey)!) : under;
  }));
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
