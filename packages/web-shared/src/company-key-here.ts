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
import { answerDigestOf, type SealedAnswer } from '../../../src/core/answer-opened.js';

/** A waiting seat request or a payee's handover, as the service serves it: sealed to the company's inbox. */
export type { SealedAnswer };
export { answerDigestOf };

/** What finding this device's company key needs. */
interface CompanyKeyDoors {
  readonly accountId: string;
  /** This device's filing key for the company: how its own seat is found in the directory. */
  readonly material: { readonly signingSecret: string };
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

/** The person's wallet gave no key for the company, so this device opens no key above the first. */
export class CompanyKeyNotOpened extends Error {
  constructor() {
    super('this device opens the company\'s key with the key your wallet releases for the company, and your wallet gave none. '
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
 * What this tab's last try to change each company's key answered, so the pause says why it still holds: a try made on
 * the way into the company leaves no other trace on the page.
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
    + 'replaced. A signer who stays opens the company, which changes it'
    + (why === null ? '' : `. This device tried to change it and could not yet: ${why}`);
};

/** This device's own seat in the directory, by its filing key. */
const ownSeatIn = (here: DirectoryHere, signingSecret: string): DirectorySeat | undefined => {
  const mine = signingPublicKeyOf(signingSecret as Hex).toLowerCase();
  return here.dir.seats.find((x) => x.signingKey.toLowerCase() === mine);
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
 */
export async function companyKeyHere(doors: CompanyKeyDoors, released = releasedOnce(doors)): Promise<CompanyKeyHere> {
  const here = await doors.records.directory();
  const rotations = anchoredRotationsIn(here, (here.dir.rotations ?? []).length === 0 ? [] : await doors.filings());
  const own = ownSeatIn(here, doors.material.signingSecret);
  const newest = rotations.length === 0 ? 0 : rotations[rotations.length - 1]!.rotation.epoch;
  const lastRotated = rotations.length === 0 ? 0 : rotations[rotations.length - 1]!.rotation.version;
  const keys = new Map<number, Hex>();
  const checkAt = new Map<number, Hex>(rotations.map(({ rotation }) => [rotation.epoch, rotation.keyCheck]));
  /* This seat's own copy in every change it was given one in, each opening to its change's key check. */
  let unopened = false;
  for (let i = rotations.length - 1; i >= 0 && own !== undefined; i -= 1) {
    const wrap = rotations[i]!.change.wraps.find((w) => w.seat === own.seat);
    if (wrap === undefined) continue;
    const key = openedWrap(wrap.wrap as WrappedCompanyKey, recordsKeyOf(await released()).secret);
    const { epoch, keyCheck } = rotations[i]!.rotation;
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
    served = (await doors.served()).toLowerCase();
  } else if (staying) {
    try { served = (await doors.served()).toLowerCase(); } catch { served = null; }
  }
  const servedAt = served === null ? 0
    : rotations.find(({ rotation }) => keyCheckOf(doors.accountId, rotation.epoch, served!) === rotation.keyCheck)?.rotation.epoch ?? 0;
  if (served !== null && !keys.has(servedAt)) keys.set(servedAt, served);
  const servedAtZero = servedAt === 0 ? served : null;
  /*
   * Back through the key each change replaces, newest first. A change whose replaced key does not open, or does not
   * match the key check of the epoch it names (at epoch 0, this seat's served copy), does not lead back.
   */
  const notBelieved = new Map<number, string>();
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
    const matches = below === 0 ? servedAtZero === null || before === servedAtZero : keyCheckOf(doors.accountId, below, before) === checkAt.get(below);
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
  if (keys.size === 0) throw new CompanyKeyNotBelieved(newest, 'no key of the company that this seat holds leads back to the keys before it');
  const epoch = Math.max(...keys.keys());
  const key = keys.get(epoch)!;
  const seeded = [...rotations].reverse().find(({ rotation }) => rotation.repairs === undefined)?.rotation.epoch;
  const newestNotBelieved = notBelieved.get(newest);
  const notSealing = epoch < newest && newestNotBelieved !== undefined
    ? `the company's newest change of its key is not believed on this device, because ${newestNotBelieved}, so this device `
      + `seals nothing new. ${CLEARED}`
    : epoch < newest && unopened
      ? 'this seat\'s copy of the company\'s newest key does not open to the key its change names, so this device seals '
        + `nothing new. If this is not the wallet this seat was entered with, open the company with that wallet. ${CLEARED}`
      : epoch < newest ? 'this seat holds no copy of the company\'s newest key, so it seals nothing new'
        : seeded !== undefined && !seeds.some((s) => s.epoch === seeded)
          ? 'this seat holds no copy of the payout seed of the company\'s newest key, so it seals nothing new'
          : own?.retired !== null && own !== undefined ? 'this seat is retired from the company, so it seals nothing new'
            : pauseIn(here, lastRotated, doors.accountId);
  const answered = new Map<number, ReadonlySet<string>>(
    rotations.map(({ rotation, change }) => [change.replaces ?? rotation.epoch - 1, new Set(change.waiting.map((d) => d.toLowerCase()))]));
  return Object.freeze({
    epoch, key, newest, seeds: Object.freeze(seeds), notSealing, answered,
    keyAt: (e: number): Hex => {
      const k = keys.get(e);
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

/** The version of the newest retirement no rotation has followed yet (`after`), and the version of the newest rotation (`since`); null when every retirement is followed. */
const owedIn = (here: DirectoryHere): { readonly after: number; readonly since: number } | null => {
  const retiredAt = here.dir.seats.flatMap((x) => (x.retired !== null && x.retiredAt !== undefined ? [x.retiredAt] : []));
  if (retiredAt.length === 0) return null;
  const after = Math.max(...retiredAt);
  const rotations = here.dir.rotations ?? [];
  const since = rotations.length === 0 ? 0 : rotations[rotations.length - 1]!.version;
  return after > since ? { after, since } : null;
};

/** Whether a change of the key was filed by a seat the directory has retired since and the chain no longer holds. */
const filedByARemovedSeat = (here: DirectoryHere, r: DirectoryRotation): boolean => {
  const filer = here.dir.seats.find((x) => x.seat === r.by);
  return filer !== undefined && filer.retired !== null && filer.retiredAt !== undefined && filer.retiredAt > r.version
    && !here.holders.seats.includes(filer.seat);
};

/**
 * Whether the seats that stay, among those the chain holds, are enough to meet the higher of the account's threshold and
 * its seat bar on their own. A retired seat the chain still holds gets no copy of a new key, so it can never open, and so
 * never approve, a proposal sealed under it; the key changes past such a seat only while no proposal needs it.
 */
const stayersApproveAlone = (here: DirectoryHere): boolean => {
  const staying = here.holders.seats.filter((s) => here.dir.seats.some((x) => x.seat === s && x.retired === null)).length;
  return staying >= Math.max(Number(here.holders.approvals ?? 0), Number(here.holders.seatBar ?? 0));
};

/**
 * **THE COMPANY'S KEY CHANGED FROM THIS DEVICE, ONCE A SIGNER'S REMOVAL IS CARRIED OUT
 * ON THE CHAIN AND ANCHORED.** A new random key and payout seed, a copy of the key
 * for every seat the directory holds and has not retired, the key it replaces
 * sealed under it, and the digest of each waiting request and handover this
 * device opened, filed as the directory's next version and anchored at once.
 * Nothing is filed by a seat that is not in the directory, is retired, is the
 * one leaving (`leaf`) or under an approved removal, or may not file a proposal;
 * nothing is filed while who is under an approved removal cannot be read, another
 * change of the key is filed and not anchored, the retirement is not anchored, the chain still holds
 * a retired seat while the seats that stay could not meet the chain's approvals without it
 * (`stayersApproveAlone`), the chain holds a seat the directory has no entry for that the
 * company's roster admitted (a seat never admitted holds no key, gets no copy and is
 * admitted afterwards with the new one), or
 * the directory holds a seat that stays and the chain no longer holds - each
 * would leave a copy of the key with a seat that should not hold one, or none
 * with one that should. A device that loses the race to another reads the
 * other's change and files nothing more. A seat that does not hold the newest key
 * (its copy did not open, or this device does not believe that change) changes the key
 * from the newest key it holds (`replaces`) once every newer change was filed by a seat
 * retired since and off the chain, and otherwise files nothing.
 */
export async function rotateTheCompanyKeyHere(doors: RotationDoors, o: { readonly leaf?: string } = {}): Promise<KeyRotated> {
  const outcome = await rotatedHere(doors, o);
  triedHere.set(doors.accountId, outcome);
  return outcome;
}

const rotatedHere = async (doors: RotationDoors, o: { readonly leaf?: string }): Promise<KeyRotated> => {
  const here = await doors.records.directory();
  const seat = ownSeatIn(here, doors.material.signingSecret);
  if (seat === undefined) return { state: 'not-this-seat', why: 'this device\'s seat has no entry in the company\'s directory' };
  if (seat.retired !== null) return { state: 'not-this-seat', why: 'this seat is retired from the company' };
  if (typeof o.leaf === 'string' && o.leaf.toLowerCase() === seat.seat) return { state: 'not-this-seat', why: 'this seat is the one leaving' };
  if (!here.holders.seats.includes(seat.seat)) return { state: 'not-this-seat', why: 'the chain no longer holds this seat' };
  if (!mayInvite(seat)) return { state: 'not-this-seat', why: 'this seat\'s role files no proposal, so it does not change the company\'s key' };
  let leaving: ReadonlySet<string>;
  try {
    leaving = await doors.leaving();
  } catch (e) {
    return { state: 'waits', why: `${(e as Error)?.message ?? String(e)}; the company's key is changed once it can be read` };
  }
  if (leaving.has(seat.signingKey.toLowerCase())) return { state: 'not-this-seat', why: 'a removal of this seat is approved' };
  const rotations = here.dir.rotations ?? [];
  if (rotations.some((r) => !here.records.directory.has(r.version))) {
    return { state: 'waits', why: 'a change of the company\'s key is filed and not yet anchored' };
  }
  const owed = owedIn(here);
  if (owed === null) return { state: 'not-needed' };
  if (!here.records.directory.has(owed.after)) return { state: 'waits', why: 'the retirement of the leaving seat is filed and not yet anchored' };
  const stillHeld = here.dir.seats.filter((x) => x.retired !== null && (x.retiredAt ?? 0) > owed.since && here.holders.seats.includes(x.seat));
  if (stillHeld.some((x) => !here.records.directory.has(x.retiredAt ?? 0)) || (stillHeld.length > 0 && !stayersApproveAlone(here))) {
    return { state: 'waits', why: 'the chain still holds a retired seat, so the removal is not carried out on the chain yet' };
  }
  const unentered = here.holders.seats.filter((s) => !here.dir.seats.some((x) => x.seat === s));
  if (unentered.length > 0) {
    let admitted: ReadonlySet<string> | null = null;
    try { admitted = doors.admitted === undefined ? new Set(unentered.map((s) => s.toLowerCase())) : await doors.admitted(); } catch { admitted = null; }
    if (admitted === null) {
      return { state: 'waits', why: 'the chain holds a seat the company\'s directory has no entry for, and the company\'s roster could not be read to tell whether it was admitted' };
    }
    if (unentered.some((s) => admitted!.has(s.toLowerCase()))) {
      return { state: 'waits', why: 'the chain holds a seat the company\'s directory has no entry for yet; that seat files its entry first' };
    }
  }
  if (here.dir.seats.some((x) => x.retired === null && !here.holders.seats.includes(x.seat))) {
    return { state: 'waits', why: 'the chain no longer holds a seat the directory has not retired; its retirement is filed and anchored first' };
  }
  const released = releasedOnce(doors);
  let now: CompanyKeyHere;
  let records: { readonly secret: Hex; readonly publicKey: Hex };
  try {
    now = await companyKeyHere(doors, released);
    records = recordsKeyOf(await released());
  } catch (e) {
    return { state: 'not-rotated', why: (e as Error)?.message ?? String(e) };
  }
  if (now.epoch < now.newest && (here.dir.rotations ?? []).some((r) => r.epoch > now.epoch && !filedByARemovedSeat(here, r))) {
    return { state: 'not-rotated', why: 'this seat holds no copy of the company\'s newest key, and the signer who changed it is not removed from the company yet' };
  }
  if (records.publicKey !== seat.wrappingKey.toLowerCase()) {
    return { state: 'not-rotated', why: 'the key your wallet released is not the one this seat\'s directory entry names, so this seat could not open the new key' };
  }
  const epoch = now.newest + 1;
  const key = newSymmetricKey().toLowerCase();
  const wraps = wrapsFor(key, here.dir.seats.filter((x) => x.retired === null).map((x) => ({ seat: x.seat, wrappingKey: x.wrappingKey })));
  if (openedWrap(wraps.find((w) => w.seat === seat.seat)!.wrap, records.secret) !== key) {
    return { state: 'not-rotated', why: 'this seat could not open its own copy of the new key' };
  }
  const waiting: Hex[] = [];
  for (const box of (await doors.waiting?.()) ?? []) {
    try { openFromInbox(box, doors.accountId, now.key); } catch { continue; }
    const d = answerDigestOf(box);
    if (!waiting.includes(d)) waiting.push(d);
  }
  const signedFor = here.dir.version + 1;
  const unsigned = {
    kind: 'rotate' as const, epoch, keyCheck: keyCheckOf(doors.accountId, epoch, key), after: owed.after, wraps,
    previous: sealedPrevious(key, now.key), seed: { epoch, sealed: sealedSeed(key, newSymmetricKey().toLowerCase()) }, waiting,
    ...(now.epoch < now.newest ? { replaces: now.epoch } : {}),
  };
  const message = directoryChangeMessage(doors.accountId, signedFor, { ...unsigned, signatures: [] as never });
  const secret = doors.material.signingSecret as Hex;
  const change: RotateChange = { ...unsigned, signatures: [{ publicKey: signingPublicKeyOf(secret), signature: sign(message, secret) }] };
  let filed: { readonly version: number; readonly anchor: object };
  try {
    filed = await doors.file(change, signedFor);
  } catch (e) {
    const after = owedIn(await doors.records.directory());
    if (after === null) return { state: 'rotated-elsewhere', epoch };
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
