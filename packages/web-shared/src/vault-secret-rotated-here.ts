/**
 * **A VAULT'S SECRET CHANGED AFTER A SIGNER IS REMOVED.** One owed function
 * (`vaultSecretOwedHere`) reads the chain first and says what a vault still
 * needs; `vaultSecretsRotatedHere` then does only that, in this order, so
 * running it twice, or after another device did part of it, does nothing new:
 *
 * 1. the sealed copies of a secret the chain holds are written, from the run's
 *    copies tree this wallet kept, when every reader of them stays;
 * 2. the secret the chain holds is filed as the vault's next epoch, carrying
 *    every earlier one (`rotateNonceSecret`), never before the chain holds it;
 * 3. a record behind the account's removal count, whose secret was set after
 *    every removal the chain has counted, is filed again carrying the count
 *    (`secretMustChange`);
 * 4. otherwise a new secret is owed: it is made here, kept in this wallet, and
 *    raised as the vault's secret run; when the approvals it needs are met on
 *    this press it is set and every copy is written in the same action.
 *
 * Step 4 raises only with `may: 'raise'`, a person's press. With `'finish'`
 * nothing is raised or approved: an approved run this wallet made is set and
 * its copies written, and a new secret still owed is answered as owed.
 */
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import {
  newNonceSecret, openNonceSecrets, recordsKeypairFrom, refileNonceSecret, rotateNonceSecret,
  type OpenedNonceSecrets,
} from '../../../src/midnight/company-nonce-secret.js';
import { mayFile } from '../../../src/midnight/seat-directory.js';
import type { SealedPool } from '../../../src/midnight/vault-pool.js';
import { ownCopyOpened } from '../../../src/midnight/sealed-secret-copy.js';
import { removalWaitsHere, type RotationDoors } from './company-key-here.js';
import type { DirectoryRead } from './vault-page-doors.js';
import type { CreateVaultDoors, RunKept } from './vault-doors.js';
import { removalsOnTheChainHere } from './removals-on-the-chain.js';
import { theVaultReadForItsStart } from './vault-read-here.js';
import { ownChainSecret } from './vault-secret-to-spend.js';
import { secretMustChange, whenTheSecretWasSetHere } from './who-holds-the-vaults-secret.js';
import { NEW_SECRET_SUMMARY, heldSecretsOf, runLive } from './vault-secret-run-record.js';
import { everyCopyWritten, raiseASecretRunHere, readersNow, secretRunApprovedHere, secretSetHere } from './vault-secret-run.js';
import { approvedHere, standingNow, type StartStanding } from './vault-start-steps.js';
import type { RunSecret } from './vault-pool-opened.js';

const HEX64 = /^[0-9a-f]{64}$/u;

/** What the rotation reads and acts through: a vault's start doors, the directory, and the removal's waits. */
interface VaultRotationDoors extends CreateVaultDoors, Pick<RotationDoors, 'leaving' | 'admitted'> {
  readonly directory: DirectoryRead;
}

/** `raise`: a person's press, which may raise a new secret run. `finish`: the upkeep, which never raises or approves. */
type RotationMay = 'raise' | 'finish';

/** Where one vault's secret change stands after a press. */
type RotationOutcome =
  | { readonly state: 'not-owed' | 'rotated' }
  | { readonly state: 'waits' | 'not-this-seat' | 'owed' | 'not-rotated'; readonly why: string }
  | { readonly state: 'awaiting-approvals'; readonly approvals: number; readonly needed: number };

/** What became of one vault's secret. `did` names each step taken on this press. */
type VaultSecretRotated = { readonly vault: Hex; readonly did: readonly string[] } & RotationOutcome;

/** A run's copies tree this wallet kept, with this signer's own copy opened from it. */
interface TreeHere {
  readonly secret: Hex; readonly readers: readonly Hex[]; readonly previous: Hex;
  /** Everyone any run of this secret this wallet kept sealed it to: who can open it. */
  readonly everReaders: readonly Hex[];
}

/** The newest filed record this signer opens, and the record itself. */
interface Newest { readonly rec: SealedPool; readonly opened: OpenedNonceSecrets }

/** What the owed function read, chain first. */
interface RotationRead {
  readonly state: string;
  readonly commitment: Hex;
  readonly removals: number;
  readonly readers: readonly Hex[];
  readonly newest: Newest | null;
  readonly tree: TreeHere | null;
}

/** What a vault's secret still needs, from the chain and the company's records. */
type SecretOwed =
  | { readonly owed: 'nothing' } | { readonly owed: 'not-started' }
  | { readonly owed: 'copies'; readonly read: RotationRead } | { readonly owed: 'file'; readonly read: RotationRead }
  | { readonly owed: 'count'; readonly read: RotationRead }
  | { readonly owed: 'new-run'; readonly read: RotationRead; readonly why: string };

const lower = (x: string): Hex => String(x).toLowerCase() as Hex;
const allOn = (keys: readonly string[], list: readonly Hex[]): boolean => keys.every((k) => list.includes(lower(k)));

/** This signer's own copy in a kept tree, opened: null when the tree is not this vault's or holds no copy that opens. */
function treeOpened(doors: CreateVaultDoors, vault: Hex, kept: RunKept | null): Omit<TreeHere, 'everReaders'> | null {
  if (kept === null || typeof kept.previous !== 'string' || !HEX64.test(lower(kept.previous)) || lower(kept.vault) !== lower(vault)) return null;
  /* No copy of mine that opens is no tree to write from: the copies are then owed a new run. */
  const secret = ownCopyOpened(doors.me.companyKey, vault, kept.copies);
  return secret === null ? null : { secret, readers: kept.copies.map((c) => lower(c.reader)), previous: lower(kept.previous) };
}

/** Every run of `commitment` this wallet kept, oldest first. */
async function runsOf(doors: CreateVaultDoors, vault: Hex, commitment: Hex): Promise<readonly RunKept[]> {
  const kept = doors.secretKeptHere;
  if (kept?.runsHeld !== undefined) return kept.runsHeld(vault, commitment);
  const one = (await kept?.runHeld?.(vault, commitment)) ?? null;
  return one === null ? [] : [one];
}

/** The newest kept run of `commitment`, opened, with everyone every kept run of it sealed the secret to. */
async function treeHere(doors: CreateVaultDoors, vault: Hex, commitment: Hex): Promise<TreeHere | null> {
  const runs = await runsOf(doors, vault, commitment);
  const tree = treeOpened(doors, vault, runs.at(-1) ?? null);
  return tree === null ? null : { ...tree, everReaders: [...new Set(runs.flatMap((r) => r.copies.map((c) => lower(c.reader))))] };
}

async function newestHere(doors: CreateVaultDoors, vault: Hex): Promise<Newest | null> {
  const rec = await doors.records('nonce-secret').get(vault);
  return rec === null ? null : { rec, opened: openNonceSecrets(rec, vault, recordsKeypairFrom(doors.me.companyKey)) };
}

/**
 * **THE ONE OWED FUNCTION.** Nothing for a vault whose secret is not set yet (its
 * start finishes it). Otherwise, in order: copies unwritten are owed as copies
 * when this wallet kept their tree and every reader of it stays, else as a new
 * run (a reader who left can open them); a secret the chain holds and the
 * records do not is owed a filing; a secret set before a removal the chain has
 * counted is owed a new run, on every device alike (`secretMustChange`); with no
 * removal since, a record behind the account's removal count is owed a re-file
 * carrying it. Readers of a secret are everyone any kept run of it was sealed to.
 * The count is read before the readers and again after them; a count that
 * moved between the reads stops the press, so a removal is never missed.
 */
async function vaultSecretOwedHere(doors: CreateVaultDoors, vault: Hex): Promise<SecretOwed> {
  const { view, refusal } = await theVaultReadForItsStart(doors, vault);
  if (refusal !== null) throw new Error(refusal);
  const commitment = lower(view.nonceCommitment ?? '');
  if (view.state === undefined || !HEX64.test(commitment) || /^0+$/u.test(commitment)) return { owed: 'not-started' };
  if (doors.builder.ownChainCopy === undefined) throw new Error('this page cannot read the vault\'s sealed copies on the chain. Reload it to get the current version.');
  const removals = await removalsOnTheChainHere(doors, vault);
  const readers = (await readersNow(doors, vault)).map(lower);
  if (await removalsOnTheChainHere(doors, vault) !== removals) {
    throw new Error('a signer was removed while this device read who stays, so nothing was done; pressing again goes on.');
  }
  const written = (await ownChainSecret(doors, vault, view.state, 'copies-written')).commitment;
  const tree = await treeHere(doors, vault, commitment);
  const read: RotationRead = { state: view.state, commitment, removals, readers, newest: await newestHere(doors, vault), tree };
  if (written === null || lower(written) !== commitment) {
    return tree !== null && allOn(tree.everReaders, readers) ? { owed: 'copies', read }
      : { owed: 'new-run', read, why: 'the vault\'s secret is set and its sealed copies are not all written, and a signer who left may open them' };
  }
  const newest = read.newest;
  const chainsNewest = newest !== null
    && await doors.builder.secretIsTheVaults({ vault, state: view.state, secret: newest.opened.secrets[newest.opened.secrets.length - 1]! });
  if (!chainsNewest) return { owed: 'file', read };
  const must = await secretMustChange({ opened: newest.opened, chainRemovals: removals, set: () => whenTheSecretWasSetHere(doors, vault, commitment) });
  if (must === null) return { owed: 'nothing' };
  return must.why === 'behind-the-chain' ? { owed: 'count', read }
    : { owed: 'new-run', read, why: 'a signer was removed after the vault\'s secret was set, so they may open it' };
}

/** Writes every copy of the chain's secret from the kept tree. */
async function copiesWrittenHere(doors: CreateVaultDoors, vault: Hex, read: RotationRead): Promise<void> {
  const tree = read.tree!;
  const run: RunSecret = { secret: tree.secret, readers: tree.readers, previous: tree.previous, earlier: await heldSecretsOf(doors, vault) };
  const at = await standingNow(doors, vault, run);
  if (at.run === undefined || lower(at.run.commitment) !== read.commitment || at.standing.secret?.rootIsThisRuns !== true) {
    throw new Error('the sealed copies this wallet kept are not the ones the vault\'s signers approved, so none was written.');
  }
  await everyCopyWritten(doors, vault, at, at.run, run);
}

/**
 * Files the secret the chain holds as the vault's next epoch. Its readers are everyone a kept run of it was sealed to,
 * a signer who has left among them so that a new secret is then owed, and the record is good for the chain's removal
 * count only when every one of them stays; without a kept run it is wrapped to the seats that stay and keeps the
 * newest record's count.
 */
async function chainsSecretFiledHere(doors: CreateVaultDoors, vault: Hex, read: RotationRead): Promise<string | null> {
  const own = read.tree?.secret ?? (await ownChainSecret(doors, vault, read.state, 'commitment')).secret;
  if (own === null || !(await doors.builder.secretIsTheVaults({ vault, state: read.state, secret: own }))) {
    return 'this device holds no copy of the secret the vault holds now; a signer whose copy is on the chain files it';
  }
  const base = read.newest;
  if (base === null) return 'the company\'s records hold no secret of this vault to carry into the new one';
  const removals = read.tree !== null && allOn(read.tree.everReaders, read.readers) ? read.removals : base.opened.removals;
  await doors.records('nonce-secret').put(vault, nextRecordOf(doors, vault, base, read.tree?.everReaders ?? read.readers, own, removals));
  const kept = await doors.secretKeptHere?.held(vault) ?? null;
  if (kept !== null && newestOf(doors, vault, kept) === lower(own)) await doors.secretKeptHere?.drop(vault);
  return null;
}

const newestOf = (doors: CreateVaultDoors, vault: Hex, rec: SealedPool): Hex | null => {
  try {
    const o = openNonceSecrets(rec, vault, recordsKeypairFrom(doors.me.companyKey));
    return lower(o.secrets[o.secrets.length - 1]!);
  } catch {
    return null; // a kept record that does not open here holds no secret to raise or drop
  }
};

/**
 * The new secret this wallet already keeps for the vault's next epoch, or null: one epoch past the newest filed, raised
 * in a run this wallet kept, and sealed in every such run only to signers who stay. A secret a signer who has left was
 * given in a run is never raised again: a fresh one is made in its place.
 */
async function keptNextSecret(doors: CreateVaultDoors, vault: Hex, read: RotationRead): Promise<Hex | null> {
  const base = read.newest;
  if (base === null) return null;
  const kept = await doors.secretKeptHere?.held(vault) ?? null;
  if (kept === null) return null;
  let k: OpenedNonceSecrets;
  try {
    k = openNonceSecrets(kept, vault, recordsKeypairFrom(doors.me.companyKey));
  } catch {
    return null; // a kept record that does not open here is not the next epoch
  }
  const extends1 = k.secrets.length === base.opened.secrets.length + 1 && base.opened.secrets.every((s, i) => lower(s) === lower(k.secrets[i]!));
  if (!extends1) return null;
  const secret = lower(k.secrets[k.secrets.length - 1]!);
  const probe = await standingNow(doors, vault, { secret, readers: read.readers, previous: read.commitment, earlier: [] });
  const runs = probe.run === undefined ? [] : await runsOf(doors, vault, lower(probe.run.commitment));
  return runs.length > 0 && runs.every((r) => allOn(r.copies.map((c) => c.reader), read.readers)) ? secret : null;
}

/** Keeps in this wallet the vault's next record: the newest filed with `secret` as its next epoch, wrapped to `readers`. */
async function nextRecordKept(doors: CreateVaultDoors, vault: Hex, base: Newest, secret: Hex, readers: readonly Hex[]): Promise<void> {
  if (doors.secretKeptHere === undefined) throw new Error('this wallet cannot keep a new secret, so none was made or raised.');
  await doors.secretKeptHere.keep(vault, nextRecordOf(doors, vault, base, readers, secret, base.opened.removals));
}

/**
 * **THE VAULT'S NEXT NONCE-SECRET RECORD**: the newest one's epochs and `secret` as the next, wrapped to `readers`, every
 * reader of the newest one not among them named as leaving, good for `removals`.
 */
function nextRecordOf(doors: CreateVaultDoors, vault: Hex, base: Newest, readers: readonly Hex[], secret: Hex, removals: number): SealedPool {
  const to = readers.map(lower);
  const leaving = base.opened.readers.map(lower).filter((k) => !to.includes(k));
  return rotateNonceSecret(base.rec, vault, recordsKeypairFrom(doors.me.companyKey), {
    remaining: to.map((publicKey) => ({ publicKey })), leaving: leaving.map((publicKey) => ({ publicKey })),
  }, secret, removals);
}

/** The vault's next secret: the one this wallet keeps, or a new one, kept in this wallet before anything is raised. */
async function nextSecretKept(doors: CreateVaultDoors, vault: Hex, read: RotationRead): Promise<Hex> {
  const base = read.newest;
  if (base === null) throw new Error('the company\'s records hold no secret of this vault to carry into a new one, so none was made.');
  const again = await keptNextSecret(doors, vault, read);
  if (again !== null) return again;
  const secret = newNonceSecret();
  await nextRecordKept(doors, vault, base, secret, read.readers);
  return secret;
}

type Carried = { readonly state: 'carried' } | { readonly state: 'awaiting-approvals'; readonly approvals: number; readonly needed: number }
  | { readonly state: 'owed'; readonly why: string };

/** Approves (on a press only) and sets the run's secret once its approvals are met, then writes every copy. */
async function carriedWhenMet(doors: CreateVaultDoors, vault: Hex, from: StartStanding, run: RunSecret, may: RotationMay): Promise<Carried> {
  let at = from;
  let r = at.standing.secret?.run ?? null;
  if (r === null || !runLive(r)) {
    return { state: 'owed', why: r?.beforeARemoval === true ? 'a signer was removed after the vault\'s secret run was raised; pressing again raises it afresh'
      : 'the vault\'s secret run is not open on the chain; pressing again raises it' };
  }
  if (r.approvals < r.needed && may === 'raise' && !approvedHere(vault, r, 'its new secret')) {
    at = await secretRunApprovedHere(doors, vault, at, run, r, NEW_SECRET_SUMMARY);
    r = at.standing.secret?.run ?? r;
  }
  if (r.approvals < r.needed) return { state: 'awaiting-approvals', approvals: r.approvals, needed: r.needed };
  at = await secretSetHere(doors, vault, at, run, r);
  await everyCopyWritten(doors, vault, at, at.run!, run);
  return { state: 'carried' };
}

/** An approved run this wallet made, set and written (the upkeep's carry); null when this wallet keeps none. */
async function keptRunCarried(doors: CreateVaultDoors, vault: Hex, read: RotationRead): Promise<Carried | null> {
  const secret = await keptNextSecret(doors, vault, read);
  if (secret === null) return null;
  const earlier = await heldSecretsOf(doors, vault);
  const first: RunSecret = { secret, readers: read.readers, previous: read.commitment, earlier };
  const probe = await standingNow(doors, vault, first);
  const kept = probe.run === undefined ? null : await treeHere(doors, vault, lower(probe.run.commitment));
  if (kept === null || kept.secret !== secret) return null;
  const run: RunSecret = { secret, readers: kept.readers, previous: kept.previous, earlier };
  return carriedWhenMet(doors, vault, await standingNow(doors, vault, run), run, 'finish');
}

/**
 * Raises the vault's next secret run, then carries it when its approvals are met on this press. The wallet's next
 * record is kept again wrapped to the readers the run was raised with, which are read again at the raise.
 */
async function raisedAndCarried(doors: CreateVaultDoors, vault: Hex, read: RotationRead): Promise<Carried> {
  const secret = await nextSecretKept(doors, vault, read);
  const raised = await raiseASecretRunHere(doors, vault, secret);
  await nextRecordKept(doors, vault, read.newest!, secret, raised.run.readers);
  return carriedWhenMet(doors, vault, raised.at, raised.run, 'raise');
}

/** One vault: the owed function, then its step, until nothing is owed or a step waits. */
async function oneVaultRotatedHere(doors: CreateVaultDoors, vault: Hex, may: RotationMay): Promise<VaultSecretRotated> {
  const did: string[] = [];
  const out = (o: RotationOutcome): VaultSecretRotated => ({ vault, did, ...o });
  try {
    for (let step = 0; step < 6; step += 1) {
      const owed = await vaultSecretOwedHere(doors, vault);
      if (owed.owed === 'nothing' || owed.owed === 'not-started') return out({ state: did.length === 0 ? 'not-owed' : 'rotated' });
      if (owed.owed === 'copies') { await copiesWrittenHere(doors, vault, owed.read); did.push('copies written'); continue; }
      if (owed.owed === 'file') {
        const no = await chainsSecretFiledHere(doors, vault, owed.read);
        if (no !== null) return out({ state: 'owed', why: no });
        did.push('new secret filed');
        continue;
      }
      if (owed.owed === 'count') {
        const base = owed.read.newest!;
        await doors.records('nonce-secret').put(vault,
          refileNonceSecret(base.rec, vault, recordsKeypairFrom(doors.me.companyKey), base.opened.version + 1, owed.read.removals));
        did.push('filed again for the removals counted');
        continue;
      }
      const carried = may === 'raise' ? await raisedAndCarried(doors, vault, owed.read) : await keptRunCarried(doors, vault, owed.read);
      if (carried === null) return out({ state: 'owed', why: `${owed.why}; a signer who stays changes it by pressing to change the vault's secret` });
      if (carried.state !== 'carried') return out(carried);
      did.push('new secret set');
    }
    return out({ state: 'not-rotated', why: 'the vault\'s secret change did not settle on this press; pressing again goes on from where it stopped' });
  } catch (e) {
    return out({ state: 'not-rotated', why: (e as Error)?.message ?? String(e) });
  }
}

/** The removal's waits for a vault's secret: the company key's change comes first. Null when the rotation may go on. */
async function waitsHere(doors: VaultRotationDoors, leaf: string | undefined): Promise<{ readonly state: 'waits' | 'not-this-seat'; readonly why: string } | null> {
  const here = await doors.directory();
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex).toLowerCase();
  const seat = here.dir.seats.find((x) => x.signingKey.toLowerCase() === mine);
  const waited = await removalWaitsHere(here, seat, leaf === undefined ? { admittedFirst: true } : { leaf, admittedFirst: true },
    (s) => (mayFile(s).includes('nonce-secret') ? null : 'this seat\'s role files no vault secret, so it does not change one'), doors);
  if (waited.state === 'waits' || waited.state === 'not-this-seat') return waited;
  if (waited.state === 'ready') return { state: 'waits', why: 'the company\'s key is changed first, after a signer\'s removal; it is changed by the next action a signer who stays takes in their wallet' };
  return null;
}

/**
 * **EVERY VAULT'S SECRET, CHANGED AFTER A REMOVAL**, from a staying signer's
 * device: the removal's waits first (never on the seat that is leaving, never
 * before the company's key is changed), then each vault on its own. A vault that
 * cannot go on says why; the others go on.
 */
export async function vaultSecretsRotatedHere(
  doors: VaultRotationDoors, vaults: readonly Hex[], may: RotationMay, o: { readonly leaf?: string } = {},
): Promise<readonly VaultSecretRotated[]> {
  let waited: Awaited<ReturnType<typeof waitsHere>>;
  try {
    waited = await waitsHere(doors, o.leaf);
  } catch (e) {
    waited = { state: 'waits', why: `the company's directory could not be read (${(e as Error)?.message ?? e})` };
  }
  if (waited !== null) return vaults.map((vault) => ({ vault, did: [], ...waited! }));
  const out: VaultSecretRotated[] = [];
  for (const vault of vaults) out.push(await oneVaultRotatedHere(doors, lower(vault), may));
  return out;
}
