/**
 * **THE COMPANY'S KEY AT EVERY EPOCH, AS THIS DEVICE OPENS IT, AND THE CHANGE OF
 * IT AFTER A SIGNER LEAVES.** A company's key starts at epoch 0, which each seat
 * opens from the copy the service serves it. Each later epoch is a `rotate`
 * version of the company's directory, anchored on chain: a copy of the new key
 * for every seat that stays, to that seat's records key, and the key it
 * replaces sealed under it. This device opens its own copy with the key its
 * wallet releases for the company, and walks back through each replaced key to
 * epoch 0. A copy that does not open, or a rotation whose replaced key or seed
 * does not open, costs only that rotation's key: every key below it still
 * opens, and nothing new is sealed until a seat that stays changes the key again
 * from the newest key it holds, once the signer who made that rotation is
 * removed. Only rotations the anchor holds count, and each is read from the
 * bytes the anchor holds. Nothing new is sealed while a signer's
 * removal is carried out on the chain and anchored and the key they held is not
 * yet replaced, nor while this seat holds no copy of the newest key or of its
 * payout seed; everything sealed under a key this device holds still opens.
 */
import { fromHex, newSymmetricKey, sign, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import {
  keyCheckOf, openedPrevious, openedSeed, openedWrap, sealedPrevious, sealedSeed, wrapsFor, type WrappedCompanyKey,
} from '../../../src/core/company-key.js';
import { openFromInbox } from '../../../src/core/sealed-records.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { directoryEntry } from '../../../src/midnight/record-manifest.js';
import {
  directoryChangeMessage, mayInvite, type DirectoryFiling, type DirectoryRotation, type DirectorySeat, type RotateChange,
} from '../../../src/midnight/seat-directory.js';
import type { PayoutSeed } from '../../../src/core/types.js';
import type { CompanyKeys } from '../../../src/core/company-key.js';
import type { DirectoryHere, DirectoryRead } from './vault-page-doors.js';
import { filedByARemovedSeat, owedIn, removalWaitsHere } from './key-change-owed.js';

export { removalWaitsHere };
import { answerDigestOf, type SealedAnswer } from '../../../src/core/answer-opened.js';

/** A waiting seat request or a payee's handover, as the service serves it: sealed to the company's inbox. */
export type { SealedAnswer };
export { answerDigestOf };

/** What finding this device's company key needs. */
interface CompanyKeyDoors {
  readonly accountId: string;
  /**
   * This device's filing key for the company, or only its public half: how its own seat is found in the directory. A
   * read of the company's keys needs the public half alone; a rotation signs, so its doors carry the secret.
   */
  readonly material: { readonly signingSecret: string } | { readonly signingPublicKey: string };
  /**
   * The company's directory as this device believes it, read afresh. Whether a rotation's payout seed repeats one of
   * the company's first state is held where every seed is read (`seedsOfEveryEpoch`).
   */
  readonly records: { readonly directory: DirectoryRead };
  /** Every filing of the company's directory, as the service serves them; each rotation read from it is held to its anchored digest. */
  readonly filings: () => Promise<readonly DirectoryFiling[]>;
  /** The company's key from the copy the service serves this seat, opened on this device. */
  readonly served: () => Promise<Hex>;
  /** The key the person's wallet released for this company in this tab, or null when it released none. */
  readonly released: () => Hex | null;
  /** Asks the person's wallet once for the key it releases for this company; null, or a throw, when the person declines. */
  readonly askTheWallet: () => Promise<Hex | null>;
  /**
   * The key epoch a believed taking-away of a read grant was filed at, or null when none is (`revokedAtHere`): while it
   * is the newest epoch, the reader it was taken from still holds the key in force, and nothing new is sealed.
   */
  readonly revoked: () => Promise<number | null>;
}

/** The company's keys this device holds. */
export interface CompanyKeyHere {
  /** The newest epoch this device holds a key for, and that key: what it opens with. */
  readonly epoch: number;
  readonly key: Hex;
  /** The newest epoch the company's anchored directory holds. */
  readonly newest: number;
  /** The key at `epoch`; throws for an epoch this device holds no key for. */
  readonly keyAt: (epoch: number) => Hex;
  /** Each payout seed a rotation this device believes carried, by its epoch. */
  readonly seeds: readonly PayoutSeed[];
  /**
   * The answers each anchored rotation found waiting, by the epoch of the key whose inbox they were sealed to: an
   * answer sealed to an older inbox is believed only when its digest is here.
   */
  readonly answered: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * Why nothing new may be sealed now, or null. Sealing refuses while a signer's removal is carried out on the chain
   * and anchored and no rotation has replaced the key they held, and while this seat holds no copy of the newest key
   * or of the payout seed of the newest change that is no repair, so no run is raised under an older seed.
   */
  readonly notSealing: string | null;
  /**
   * With `unreleased: 'not-opened'`: the epochs this seat holds a copy of that were not opened, because the wallet has
   * not released the company's key on this visit, in order. `keyAt` throws `CompanyKeyNotOpened` for each; nothing else is refused. Absent
   * or empty when every copy this seat holds was opened.
   */
  readonly notOpened?: readonly number[];
  /** The key and epoch to seal under now; throws `CompanyKeyBeingChanged` while `notSealing` says why not. */
  readonly sealing: () => { readonly key: Hex; readonly epoch: number };
}

/** Nothing new is sealed: the company's key is being changed, or this seat holds no copy of the newest key or its seed. */
export class CompanyKeyBeingChanged extends Error {
  constructor(why: string) {
    super(`${why}. Nothing was sealed. Everything sealed under a key this device holds still opens.`);
    this.name = 'CompanyKeyBeingChanged';
  }
}

/**
 * No key of the company was released by the person's wallet on this visit, whether it was asked and gave none (a press)
 * or deliberately not asked (a quiet read), so this device opens no key it needs above the first.
 */
export class CompanyKeyNotOpened extends Error {
  constructor() {
    super('this device opens the company\'s key with the key your wallet releases for the company, and your wallet has not released one on this visit. '
      + 'Nothing was changed. Open the company with your wallet, then try again.');
    this.name = 'CompanyKeyNotOpened';
  }
}

/**
 * What puts right a change of the company's key a seat cannot hold: the change its filer made is passed over by the
 * next one, which a staying seat makes from the newest key it holds once that filer is retired.
 */
const CLEARED = 'It is put right once the signer who made that change is removed from the company: then a signer who stays '
  + 'changes the key again from the newest key it holds';

/** The rotations served are not the bytes the anchor holds, or no key of the company this seat holds leads back. */
export class CompanyKeyNotBelieved extends Error {
  constructor(epoch: number, why: string) {
    super(`the change of the company's key at epoch ${epoch} is not believed on this device: ${why}. Nothing was sealed, and `
      + 'this device opens none of the company\'s records while it says this. Reload the page, which reads the company\'s '
      + 'directory again; if it says this again, tell the company\'s other signers.');
    this.name = 'CompanyKeyNotBelieved';
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** How `companyKeyHere` takes a wallet that has not released the company's key on this visit. */
export interface CompanyKeyHereOptions {
  /**
   * `'refuse'` (the default, every press): the wallet is asked once, and a key not given refuses with
   * `CompanyKeyNotOpened`. `'not-opened'` (a quiet read, which opens no wallet window): the wallet is never asked, only
   * a key already released on this visit is used, and each epoch it would have opened is named in `notOpened`.
   */
  readonly unreleased?: 'refuse' | 'not-opened';
}

/** The company's key the wallet already released on this visit, or null; never asks the wallet. */
const heldRelease = (doors: Pick<CompanyKeyDoors, 'released'>): Hex | null => {
  const held = doors.released();
  return typeof held === 'string' && HEX64.test(held.toLowerCase()) ? held.toLowerCase() as Hex : null;
};

/** The wallet's released key, asked for at most once per use. */
const releasedOnce = (doors: Pick<CompanyKeyDoors, 'released' | 'askTheWallet'>): (() => Promise<Hex>) => {
  let asked: Promise<Hex | null> | null = null;
  return async () => {
    const held = doors.released();
    if (typeof held === 'string' && HEX64.test(held.toLowerCase())) return held.toLowerCase();
    asked ??= doors.askTheWallet().catch(() => null);
    const given = await asked;
    if (typeof given !== 'string' || !HEX64.test(given.toLowerCase())) throw new CompanyKeyNotOpened();
    return given.toLowerCase();
  };
};

/** The secret this seat opens what is wrapped to its records key with, and that key's public half. */
const recordsKeyOf = (released: Hex): { readonly secret: Hex; readonly publicKey: Hex } => {
  const pair = recordsKeypairFrom(fromHex(released));
  return { secret: pair.secret.toLowerCase(), publicKey: pair.publicKey.toLowerCase() };
};

/**
 * The rotations the anchor holds, oldest first, each with its own filing: the anchored ones up to the first that is
 * not, each filing held to the digest the anchor holds for its version.
 */
const anchoredRotationsIn = (
  here: DirectoryHere, filings: readonly DirectoryFiling[],
): readonly { readonly rotation: DirectoryRotation; readonly change: RotateChange }[] => {
  const out: { rotation: DirectoryRotation; change: RotateChange }[] = [];
  for (const rotation of here.dir.rotations ?? []) {
    const held = here.records.directory.get(rotation.version);
    if (held === undefined) break;
    const filing = filings[rotation.version - 1];
    if (filing === undefined || filing.version !== rotation.version || filing.change.kind !== 'rotate'
      || directoryEntry(filing).digest !== held.digest) {
      throw new CompanyKeyNotBelieved(rotation.epoch, 'the service served other bytes for it than the company\'s records anchor');
    }
    out.push({ rotation, change: filing.change });
  }
  return out;
};

/**
 * What this device's last try to change each company's key answered, so the pause says why it still holds: a try made
 * at the start of a seat action in the wallet leaves no other trace there.
 */
const triedHere = new Map<string, KeyRotated>();

/**
 * Why nothing new is sealed: a retirement anchored after the newest anchored rotation, of a seat the chain no longer
 * holds, so the key that seat held is still the newest. Null when there is none. When this device has tried to change
 * the key and could not, it says why.
 */
const pauseIn = (here: DirectoryHere, lastRotated: number, accountId: string): string | null => {
  const paused = here.dir.seats.some((x) => x.retired !== null && x.retiredAt !== undefined && x.retiredAt > lastRotated
    && here.records.directory.has(x.retiredAt) && !here.holders.seats.includes(x.seat));
  if (!paused) return null;
  const tried = triedHere.get(accountId);
  const why = tried !== undefined && 'why' in tried ? tried.why : null;
  return 'the company\'s key is being changed: a signer\'s removal is carried out on the chain, and the key they held is not yet '
    + 'replaced. The next action a signer who stays makes in their wallet changes it first'
    + (why === null ? '' : `. This device tried to change it and could not yet: ${why}`);
};

/** Why nothing new is sealed after a read grant is taken away, and what clears it. */
const REVOKED_PAUSE = 'a read grant was taken away and the company\'s key has not changed since, so the reader it was taken from '
  + 'still holds the key in force and this device seals nothing new. The next action a signer who stays makes in their wallet changes it first';

/**
 * Why nothing new is sealed for the company's read grants: one was taken away and the key has not changed past the epoch
 * it was filed at, or the grants could not be read, so whether one was is not known. Null when neither.
 */
const grantsPauseOf = async (doors: Pick<CompanyKeyDoors, 'revoked'>, newest: number): Promise<string | null> => {
  let revokedAt: number | null;
  try {
    revokedAt = await doors.revoked();
  } catch (e) {
    return `the company's read grants could not be read (${(e as Error)?.message ?? String(e)}), so whether a reader's grant was `
      + 'taken away is not known and this device seals nothing new. Reload the page, which reads them again';
  }
  return revokedAt !== null && revokedAt >= newest ? REVOKED_PAUSE : null;
};

/** This device's own seat in the directory, by its filing key or that key's public half. */
const ownSeatIn = (here: DirectoryHere, material: CompanyKeyDoors['material']): DirectorySeat | undefined => {
  const mine = ('signingPublicKey' in material ? material.signingPublicKey : signingPublicKeyOf(material.signingSecret as Hex)).toLowerCase();
  return here.dir.seats.find((x) => x.signingKey.toLowerCase() === mine);
};

/**
 * The keys held that lead back, and the payout seeds they open: back through the key each change replaces, newest
 * first, then each change's key and seed checked against every earlier one. A change not believed is named with why,
 * and its epoch's key is taken out of `keys`; every key below it is kept.
 */
const keysBelievedIn = (
  accountId: string, rotations: readonly { readonly rotation: DirectoryRotation; readonly change: RotateChange }[],
  keys: Map<number, Hex>, servedAtZero: Hex | null,
): { readonly notBelieved: ReadonlyMap<number, string>; readonly seeds: readonly PayoutSeed[] } => {
  /*
   * Back through the key each change replaces, newest first. A change whose replaced key does not open, or does not
   * match the key check of the epoch it names (at epoch 0, this seat's served copy), does not lead back.
   */
  const notBelieved = new Map<number, string>();
  const checkAt = new Map<number, Hex>(rotations.map(({ rotation }) => [rotation.epoch, rotation.keyCheck]));
  for (let i = rotations.length - 1; i >= 0; i -= 1) {
    const { rotation, change } = rotations[i]!;
    const key = keys.get(rotation.epoch);
    if (key === undefined) continue;
    const below = change.replaces ?? rotation.epoch - 1;
    const before = openedPrevious(key, change.previous);
    if (before === null) {
      notBelieved.set(rotation.epoch, 'the key it replaces does not open under it');
      continue;
    }
    const matches = below === 0 ? servedAtZero === null || before === servedAtZero : keyCheckOf(accountId, below, before) === checkAt.get(below);
    if (!matches) {
      notBelieved.set(rotation.epoch, 'the key it replaces does not match the key check of the epoch it names');
      continue;
    }
    if (!keys.has(below)) keys.set(below, before);
  }
  /* Oldest first: each change's key differs from every earlier epoch's, and its payout seed opens and is new. */
  const seeds: PayoutSeed[] = [];
  for (const { rotation } of rotations) {
    const key = keys.get(rotation.epoch);
    if (key === undefined || notBelieved.has(rotation.epoch)) continue;
    if ([...keys].some(([e, k]) => e < rotation.epoch && k === key)) {
      notBelieved.set(rotation.epoch, 'its key is one an earlier epoch had');
      continue;
    }
    if (rotation.seed === undefined) continue;
    const seed = openedSeed(key, rotation.seed.sealed);
    if (seed === null) {
      notBelieved.set(rotation.epoch, 'its payout seed does not open under its key');
    } else if (seeds.some((s) => s.seed === seed)) {
      notBelieved.set(rotation.epoch, 'its payout seed is one an earlier epoch had');
    } else {
      seeds.push({ epoch: rotation.seed.epoch, seed });
    }
  }
  for (const e of notBelieved.keys()) keys.delete(e);
  return { notBelieved, seeds };
};

/**
 * **EVERY KEY OF THE COMPANY THIS DEVICE HOLDS, FROM ONE READ OF THE DIRECTORY.**
 * With no anchored rotation, the key is epoch 0's, from the copy the service serves this seat. Otherwise this seat's
 * own copy in every rotation it was given one in is opened with its wallet's released key (asked for once when this
 * tab holds none), and each must open to its rotation's key check; a copy that does not is passed over. The served
 * copy is the key of the rotation whose check it matches (a seat seated after it), or else epoch 0's. From each key
 * held, the key its rotation replaces is opened: the one just before, or the older one it names (`replaces`), which
 * must match that epoch's check, or at epoch 0 this seat's served copy. A rotation whose replaced key does not open or
 * does not match, whose key is one an earlier epoch had, or whose payout seed does not open or is one an earlier epoch
 * had, is not believed: its epoch's key is not held, and every key below it still is. So a seat whose copy of the
 * newest key does not open, or that is retired, or that reads a newest rotation it does not believe, holds the keys
 * below and seals nothing new. Refuses with `CompanyKeyNotOpened` when the wallet gives no key, and
 * `CompanyKeyNotBelieved` when the service serves other bytes than the anchor holds, or no key at all leads back.
 * With `unreleased: 'not-opened'` (a quiet read) the wallet is never asked: a copy is opened only with a key already
 * released on this visit, each epoch left unopened is named in `notOpened`, and what the served copy leads back to
 * is held as above; it refuses with `CompanyKeyNotOpened` only when it holds no key at all.
 */
export async function companyKeyHere(
  doors: CompanyKeyDoors, released = releasedOnce(doors), options: { readonly unreleased?: CompanyKeyHereOptions['unreleased'] } = {},
): Promise<CompanyKeyHere> {
  const quiet = options.unreleased === 'not-opened';
  const opener = quiet ? async () => heldRelease(doors) : released;
  const here = await doors.records.directory();
  const rotations = anchoredRotationsIn(here, (here.dir.rotations ?? []).length === 0 ? [] : await doors.filings());
  const own = ownSeatIn(here, doors.material);
  const newest = rotations.length === 0 ? 0 : rotations[rotations.length - 1]!.rotation.epoch;
  const lastRotated = rotations.length === 0 ? 0 : rotations[rotations.length - 1]!.rotation.version;
  const keys = new Map<number, Hex>();
  /* This seat's own copy in every change it was given one in, each opening to its change's key check. */
  let unopened = false;
  const notOpened: number[] = [];
  for (let i = rotations.length - 1; i >= 0 && own !== undefined; i -= 1) {
    const wrap = rotations[i]!.change.wraps.find((w) => w.seat === own.seat);
    if (wrap === undefined) continue;
    const { epoch, keyCheck } = rotations[i]!.rotation;
    const releasedKey = await opener();
    if (releasedKey === null) { notOpened.unshift(epoch); continue; }
    const key = openedWrap(wrap.wrap as WrappedCompanyKey, recordsKeyOf(releasedKey).secret);
    if (key === null || keyCheckOf(doors.accountId, epoch, key) !== keyCheck) {
      unopened ||= i === rotations.length - 1;
      continue;
    }
    keys.set(epoch, key);
  }
  const staying = own !== undefined && own.retired === null;
  /* The copy the service serves this seat: the key of the change whose key check it matches, or else epoch 0's. */
  let served: Hex | null = null;
  if (keys.size === 0) {
    served = await doors.served().then((k) => k.toLowerCase(), (e: unknown) => {
      /* A quiet read with nothing opened and no served copy holds no key at all: it is a key not opened yet. */
      throw quiet && notOpened.length > 0 ? new CompanyKeyNotOpened() : e;
    });
  } else if (staying) {
    try { served = (await doors.served()).toLowerCase(); } catch { served = null; }
  }
  const servedAt = served === null ? 0
    : rotations.find(({ rotation }) => keyCheckOf(doors.accountId, rotation.epoch, served!) === rotation.keyCheck)?.rotation.epoch ?? 0;
  if (served !== null && !keys.has(servedAt)) keys.set(servedAt, served);
  const servedAtZero = servedAt === 0 ? served : null;
  const { notBelieved, seeds } = keysBelievedIn(doors.accountId, rotations, keys, servedAtZero);
  if (keys.size === 0) throw new CompanyKeyNotBelieved(newest, 'no key of the company that this seat holds leads back to the keys before it');
  const epoch = Math.max(...keys.keys());
  const key = keys.get(epoch)!;
  const seeded = [...rotations].reverse().find(({ rotation }) => rotation.repairs === undefined)?.rotation.epoch;
  const newestNotBelieved = notBelieved.get(newest);
  const grantsPause = await grantsPauseOf(doors, newest);
  const notOpenedNow = notOpened.filter((e) => !keys.has(e));
  const notSealing = notOpenedNow.includes(newest)
    ? 'the company\'s newest key is not opened on this page, because your wallet has not released the company\'s key on this '
      + 'visit, so this page seals nothing new. Open the company with your wallet to open it'
    : epoch < newest && newestNotBelieved !== undefined
    ? `the company's newest change of its key is not believed on this device, because ${newestNotBelieved}, so this device `
      + `seals nothing new. ${CLEARED}`
    : epoch < newest && unopened
      ? 'this seat\'s copy of the company\'s newest key does not open to the key its change names, so this device seals '
        + `nothing new. If this is not the wallet this seat was entered with, open the company with that wallet. ${CLEARED}`
      : epoch < newest ? 'this seat holds no copy of the company\'s newest key, so it seals nothing new'
        : seeded !== undefined && !seeds.some((s) => s.epoch === seeded)
          ? 'this seat holds no copy of the payout seed of the company\'s newest key, so it seals nothing new'
          : own?.retired !== null && own !== undefined ? 'this seat is retired from the company, so it seals nothing new'
            : grantsPause ?? pauseIn(here, lastRotated, doors.accountId);
  const answered = new Map<number, ReadonlySet<string>>(
    rotations.map(({ rotation, change }) => [change.replaces ?? rotation.epoch - 1, new Set(change.waiting.map((d) => d.toLowerCase()))]));
  return Object.freeze({
    epoch, key, newest, seeds: Object.freeze(seeds), notSealing, answered, notOpened: Object.freeze(notOpenedNow),
    keyAt: (e: number): Hex => {
      const k = keys.get(e);
      /* An epoch a quiet read left unopened is the typed "not opened yet", which its caller offers to open with the wallet. */
      if (k === undefined && notOpenedNow.includes(e)) throw new CompanyKeyNotOpened();
      if (k === undefined) throw new Error(`this device holds no key of the company at epoch ${e}, so nothing sealed under it opens here.`);
      return k;
    },
    sealing: () => {
      if (notSealing !== null) throw new CompanyKeyBeingChanged(notSealing);
      return { key, epoch };
    },
  });
}

/** What changing the company's key needs, beyond finding it. */
export interface RotationDoors extends CompanyKeyDoors {
  /** The seat's filing key itself: a rotation is signed with it. */
  readonly material: { readonly signingSecret: string };
  /** Files the signed change at the version it names and anchors it at once (`directoryChangeFiledHere`). */
  readonly file: (change: RotateChange, signedFor: number) => Promise<{ readonly version: number; readonly anchor: object }>;
  /** Every waiting seat request and payee handover the service serves, sealed to the company's inbox. */
  readonly waiting?: () => Promise<readonly SealedAnswer[]>;
  /**
   * Every seat the company's roster admitted, whether or not it has filed its directory entry (`seatsAdmittedHere`),
   * read afresh; a throw makes the rotation wait. A seat the chain holds that has no directory entry and was never
   * admitted holds no company key, so a rotation does not wait for it: it gets no copy, and it is admitted afterwards
   * with the key in force. One admitted and not yet entered holds the key, so the rotation waits for its entry.
   * Without this door every seat with no entry makes the rotation wait.
   */
  readonly admitted?: () => Promise<ReadonlySet<string>>;
  /**
   * The filing keys of seats an approved removal is about, read from the chain (`seatsLeavingHere`). A throw is read as
   * "not known", and nothing is filed: a seat on its way out never makes the key the seats that stay keep.
   */
  readonly leaving: () => Promise<ReadonlySet<string>>;
}

/** What one attempt to change the company's key came to. */
export type KeyRotated =
  | { readonly state: 'rotated'; readonly epoch: number; readonly version: number }
  | { readonly state: 'filed-not-anchored'; readonly epoch: number; readonly version: number; readonly why: string }
  | { readonly state: 'rotated-elsewhere'; readonly epoch: number }
  | { readonly state: 'not-needed' }
  | { readonly state: 'waits'; readonly why: string }
  | { readonly state: 'not-this-seat'; readonly why: string }
  | { readonly state: 'not-rotated'; readonly why: string };

/**
 * **THE COMPANY'S KEY CHANGED FROM THIS DEVICE, ONCE A SIGNER'S REMOVAL IS CARRIED OUT
 * ON THE CHAIN AND ANCHORED.** A new random key and payout seed, a copy of the key
 * for every seat the directory holds and has not retired, the key it
 * replaces sealed under it, and the digest of each waiting request and handover this
 * device opened, filed as the directory's next version and anchored at once.
 * Nothing is filed until what every change after a removal waits for has passed
 * (`removalWaitsHere`, with a seat that may file a proposal as the one that acts; a
 * seat never admitted holds no key, gets no copy and is admitted afterwards with the
 * new one): each would leave a copy of the key with a seat that should not hold
 * one, or none with one that should, and the directory takes a change only when
 * it is wrapped to every seat that stays. A device that loses the race to another reads the
 * other's change and files nothing more. A seat that does not hold the newest key
 * (its copy did not open, or this device does not believe that change) changes the key
 * from the newest key it holds (`replaces`) once every newer change was filed by a seat
 * retired since and off the chain, and otherwise files nothing. When no removal is owed one
 * and a read grant was taken away while the newest key was in force (`revoked`), or `repair` asks
 * for it, it repairs the newest key instead: a new key, wrapped to the same seats, keeping the
 * payout seed, and only from a seat that holds the newest key.
 */
export async function rotateTheCompanyKeyHere(doors: RotationDoors, o: { readonly leaf?: string; readonly repair?: boolean } = {}): Promise<KeyRotated> {
  const outcome = await rotatedHere(doors, o);
  triedHere.set(doors.accountId, outcome);
  return outcome;
}

/**
 * What a change of the key from this device waits for (`removalWaitsHere`), in one pass. The read grants are read only
 * when no removal is owed a change: a removal's change never waits on them, and clears any taking-away anyway.
 */
const keyChangeWaited = async (
  doors: RotationDoors, here: DirectoryHere, o: { readonly leaf?: string; readonly repair?: boolean },
): Promise<Awaited<ReturnType<typeof removalWaitsHere>>> => {
  const mayAct = (s: DirectorySeat): string | null => (mayInvite(s) ? null : 'this seat\'s role files no proposal, so it does not change the company\'s key');
  return removalWaitsHere(here, ownSeatIn(here, doors.material), { ...o, revoked: doors.revoked }, mayAct, doors);
};

const rotatedHere = async (doors: RotationDoors, o: { readonly leaf?: string; readonly repair?: boolean }): Promise<KeyRotated> => {
  const here = await doors.records.directory();
  const waited = await keyChangeWaited(doors, here, o);
  if (waited.state !== 'ready') return waited;
  const { seat, owed } = waited;
  const released = releasedOnce(doors);
  let now: CompanyKeyHere;
  let records: { readonly secret: Hex; readonly publicKey: Hex };
  try {
    now = await companyKeyHere(doors, released);
    records = recordsKeyOf(await released());
  } catch (e) {
    return { state: 'not-rotated', why: (e as Error)?.message ?? String(e) };
  }
  const repairs = 'repairs' in owed ? owed.repairs : null;
  if (repairs !== null && now.epoch < now.newest) {
    return { state: 'not-rotated', why: 'this seat holds no copy of the company\'s newest key, so it cannot change the key after a read grant is taken away; a signer who holds it does' };
  }
  if (now.epoch < now.newest && (here.dir.rotations ?? []).some((r) => r.epoch > now.epoch && !filedByARemovedSeat(here, r))) {
    return { state: 'not-rotated', why: 'this seat holds no copy of the company\'s newest key, and the signer who changed it is not removed from the company yet' };
  }
  if (records.publicKey !== seat.wrappingKey.toLowerCase()) {
    return { state: 'not-rotated', why: 'the key your wallet released is not the one this seat\'s directory entry names, so this seat could not open the new key' };
  }
  const epoch = now.newest + 1;
  const key = newSymmetricKey().toLowerCase();
  /*
   * The new key goes to every seat the directory holds and has not retired, believed or not, never to `readersIn`'s
   * list alone: a seat's records key is attested only by its vault-keys offer and a fold of it, and both seal under
   * the company's key, which is paused until this change. A seat left out here could never attest, and every device's
   * sealing would stay paused. The waits above make these exactly the seats the chain holds. A reader is never one.
   */
  const wraps = wrapsFor(key, here.dir.seats.filter((x) => x.retired === null).map((x) => ({ seat: x.seat, wrappingKey: x.wrappingKey })));
  const own = wraps.find((w) => w.seat === seat.seat);
  if (own === undefined) return { state: 'not-rotated', why: 'this seat is not among the seats given a copy of the new key' };
  if (openedWrap(own.wrap, records.secret) !== key) {
    return { state: 'not-rotated', why: 'this seat could not open its own copy of the new key' };
  }
  const waiting: Hex[] = [];
  for (const box of (await doors.waiting?.()) ?? []) {
    try { openFromInbox(box, doors.accountId, now.key); } catch { continue; }
    const d = answerDigestOf(box);
    if (!waiting.includes(d)) waiting.push(d);
  }
  const signedFor = here.dir.version + 1;
  /* A repair, after a read grant is taken away, keeps the payout seed: no reader ever held it. */
  const unsigned = {
    kind: 'rotate' as const, epoch, keyCheck: keyCheckOf(doors.accountId, epoch, key), after: owed.after, wraps,
    previous: sealedPrevious(key, now.key), waiting,
    ...(repairs !== null ? { repairs } : { seed: { epoch, sealed: sealedSeed(key, newSymmetricKey().toLowerCase()) } }),
    ...(repairs === null && now.epoch < now.newest ? { replaces: now.epoch } : {}),
  };
  const message = directoryChangeMessage(doors.accountId, signedFor, { ...unsigned, signatures: [] as never });
  const secret = doors.material.signingSecret as Hex;
  const change: RotateChange = { ...unsigned, signatures: [{ publicKey: signingPublicKeyOf(secret), signature: sign(message, secret) }] };
  let filed: { readonly version: number; readonly anchor: object };
  try {
    filed = await doors.file(change, signedFor);
  } catch (e) {
    const after = await doors.records.directory();
    const newest = (after.dir.rotations ?? []).reduce((n, r) => Math.max(n, r.epoch), 0);
    if (repairs !== null ? newest > repairs : owedIn(after) === null) return { state: 'rotated-elsewhere', epoch };
    throw e;
  }
  const notAnchored = (filed.anchor as { readonly notAnchored?: unknown }).notAnchored;
  return typeof notAnchored === 'string'
    ? { state: 'filed-not-anchored', epoch, version: filed.version, why: notAnchored }
    : { state: 'rotated', epoch, version: filed.version };
};

/**
 * **EVERY KEY OF THE COMPANY THIS DEVICE CAN REACH, FROM THE DIRECTORY'S FILINGS
 * AS SERVED, BEFORE ANY OF THEM IS BELIEVED**, each with its epoch. The
 * directory is believed by replaying its filings, and an entry filed after a
 * change of the key carries a proof sealed under the new key: so the replay
 * needs the keys before it can say which change is believed. Each change of the
 * key is tried: a copy wrapped to this seat's records key (opened with the key
 * the person's wallet releases, if this tab holds it or the wallet gives it),
 * or the served copy, counts only where it opens to that change's key check.
 * Then, from the newest, the key each held change replaced (the one just before,
 * or the older one it names) is taken while it matches the check of its own
 * epoch. The served copy is epoch 0's
 * where it matches no change. Nothing here is believed: a key only lets a
 * record be opened, and whether it stands is the replay's and the anchor's.
 */
export async function keysInTheFilings(
  accountId: string, filings: readonly DirectoryFiling[],
  doors: { readonly served: () => Promise<Hex>; readonly released: () => Promise<Hex | null> },
): Promise<CompanyKeys> {
  const at = new Map<number, Hex>();
  let served: Hex | null = null;
  try { served = (await doors.served()).toLowerCase() as Hex; } catch { served = null; }
  const changes = filings.filter((f) => f?.change?.kind === 'rotate').map((f) => f.change as RotateChange)
    .filter((c) => Number.isInteger(c.epoch) && c.epoch > 0 && typeof c.keyCheck === 'string');
  const checkAt = new Map<number, string>(changes.map((c) => [c.epoch, c.keyCheck]));
  let secret: Hex | null = null;
  if (changes.length > 0) {
    try {
      const released = await doors.released();
      secret = released === null ? null : recordsKeyOf(released).secret;
    } catch { secret = null; }
  }
  const newestFirst = [...changes].sort((a, b) => b.epoch - a.epoch);
  for (const c of newestFirst) {
    let key: Hex | null = null;
    if (served !== null && keyCheckOf(accountId, c.epoch, served) === c.keyCheck) key = served;
    for (const w of secret === null || key !== null ? [] : c.wraps ?? []) {
      let opened: Hex | null = null;
      try { opened = openedWrap(w.wrap as WrappedCompanyKey, secret!); } catch { opened = null; }
      if (opened !== null && keyCheckOf(accountId, c.epoch, opened) === c.keyCheck) { key = opened; break; }
    }
    if (key !== null && !at.has(c.epoch)) at.set(c.epoch, key);
  }
  for (const c of newestFirst) {
    const k = at.get(c.epoch);
    if (k === undefined) continue;
    let before: Hex | null = null;
    try { before = openedPrevious(k, c.previous); } catch { before = null; }
    if (before === null) continue;
    const epochBefore = Number.isSafeInteger(c.replaces) && c.replaces! >= 0 && c.replaces! < c.epoch ? c.replaces! : c.epoch - 1;
    if (epochBefore > 0 && keyCheckOf(accountId, epochBefore, before) !== checkAt.get(epochBefore)) continue;
    if (!at.has(epochBefore)) at.set(epochBefore, before);
  }
  if (!at.has(0) && served !== null && ![...at.values()].includes(served)) at.set(0, served);
  const epoch = at.size === 0 ? 0 : Math.max(...at.keys());
  return Object.freeze({
    epoch, key: at.get(epoch) ?? ('' as Hex), newest: Math.max(0, ...changes.map((c) => c.epoch)),
    keyAt: (e: number): Hex => {
      const k = at.get(e);
      if (k === undefined) throw new Error(`this device holds no key of the company at epoch ${e}, so nothing sealed under it opens here.`);
      return k;
    },
    sealing: () => {
      throw new CompanyKeyBeingChanged('the company\'s keys found from its directory before it is believed seal nothing');
    },
  });
}
