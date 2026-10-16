/**
 * **THE COMPANY'S ROSTER, READ, CHANGED AND FILED FROM THIS SEAT'S OWN DEVICE.**
 *
 * The roster says who holds a seat on the company, the keys their device made,
 * the leaf the chain holds for them and the vault keys they gave. It is one of
 * the company's own records: sealed here under the company's roster key, signed
 * by this seat, and filed only for a seat the company's directory believes. A
 * version this device reads is believed only as filed by a seat it believes,
 * and then each entry in it only on its own signer's witnesses
 * (`rosterEntryRefusal`): any seat that files the roster files it whole, so who
 * filed it says nothing about whose an entry is. An entry that fails is not
 * shown; a filing from here carries it on as it was filed, never changed,
 * unless it is refused for good (`carriedHere`). A version every device
 * refuses for who filed it, or for a signer it leaves out, is followed by the
 * next version filed from here (`rosterHere`).
 *
 * Three changes are made here, each checked here first:
 *
 *   · a person waiting for a seat is **admitted** once the chain holds their
 *     seat: their keys are held to the proof their invitation gave them, to the
 *     fingerprint they read out, to the sign-in their request was sealed
 *     for, and to the invitation a seat signed for them; the company's key is
 *     wrapped to the key they gave;
 *   · a new signer **offers** their vault keys, sealed under the company's
 *     roster key, before they file the roster themselves;
 *   · every open offer is **folded** into the roster by a seat already believed,
 *     each checked against the signing key the roster holds for that signer.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import { fromHex, signingPublicKeyOf, wrapKey, type Hex } from '../../../src/core/crypto.js';
import { openFromInbox } from '../../../src/core/sealed-records.js';
import { openAccount } from '../../../src/core/account.js';
import {
  believedSigners, foundingRosterRefusal, oneEntryPerSeat, openRoster, ROSTER_ENTRY_REFUSAL, ROSTER_ID, rosterEntryRefusal, sealRoster, seatsNotBelieved,
  seatsStaying as stayingIn,
  type DirectoryWitness, type RefusedEntry, type RosterEntryRefusal, type RosterSecrets, type RosterWitnesses,
} from '../../../src/core/roster-record.js';
import { refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import { seatInvitationRefusal, type SignedSeatInvitation } from '../../../src/core/invitation.js';
import { seatOpeningRefusal, walletKeyProvedBy } from '../../../src/core/seat-opening.js';
import {
  openVaultKeysOffer, rosterWithVaultKeys, sealVaultKeysOffer, signVaultKeys, vaultKeyIndexOf, vaultKeysOfferRefusal,
  type VaultKey, type VaultKeysOffer,
} from '../../../src/core/vault-keys.js';
import type { Account, PendingSigner, PendingSignerPayload, SealedAccount, Signer } from '../../../src/core/types.js';
import {
  companyWirePaths, fromCompanyWire, signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord,
} from '../../../src/midnight/sealed-record-wire.js';
import { heldStandingOf } from '../../../src/midnight/records-held.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import type { RecordsEntered } from './record-entered-here.js';
import { companyRecordKey, filingRefusalOf, mayInvite, seatsWithAnotherRecordsKey, type DirectorySeat } from '../../../src/midnight/seat-directory.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { refuseASeatWhoseFingerprintIsNotTheJoiners } from './invitation-on-device.js';
import {
  attestedIn, directoryHere, foundingRecordRefusalHere, judgeIn, newerNamedRefusal, passedOverSaid, type DirectoryHere, type DirectoryHereDeps,
} from './vault-page-doors.js';

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** What reading and filing the roster from this device needs. */
export interface RosterDoors {
  readonly api: Api;
  readonly accountId: string;
  readonly viewingKey: Hex;
  /** This seat's filing key: the one its directory entry names. */
  readonly signingSecret: Hex;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  /** What this device reads, afresh for each read, to believe the roster and each entry in it. */
  readonly reads: RosterReads;
  /** The one filing call, bound to this company and this seat: a roster filed here is entered in the company's records. */
  readonly entered: RecordsEntered;
}

/**
 * The company's directory filings, the chain as the person's own wallet reads
 * it, the company's records as the head on chain holds them, and the leaf this
 * device's vault worker makes of each entry's opening: what a roster is
 * believed against. Nothing a device believed before is kept or read: an
 * older version, or other bytes under a version, is refused by the anchor.
 */
export type RosterReads = Pick<DirectoryHereDeps, 'filings' | 'holders' | 'anchored' | 'leaves'>;

/**
 * The company as this device believes it, with every seat the chain holds that
 * no believed entry names (`notBelieved`): a committee, a reader list or a count
 * of approvers is built only when that is empty.
 */
export type BelievedAccount = Account & { readonly notBelieved: readonly string[] };

/** The fixed sentence for a company that has never filed its signers as a roster record: its signers are not read. */
export const NO_ROSTER_RECORD = 'This company\'s signers have never been filed as a record a seat signed, so this device does '
  + 'not read them. A signer of the company opens it on their own device to file them.';

/**
 * One read of a roster version, with everything it was held to: the directory
 * and the company's records as this read believed them, the version opened,
 * what each entry was held to, and the seats waited for. What the next version
 * filed from here is built from, on this read alone.
 */
interface RosterReadHeld {
  readonly here: Awaited<ReturnType<typeof directoryHere>>;
  readonly roster: SealedCompanyRecord;
  /** Whether the version is refused for who filed it: then nothing its entries do not bind is taken from it (`carriedHere`). */
  readonly refusedForItsFiler: boolean;
  readonly opened: Account;
  readonly witnesses: RosterWitnesses;
  readonly waited: ReadonlySet<string>;
}

/** Why the company's roster was not read on this device. Nothing was shown from it. */
export class RosterNotBelieved extends Error {
  /**
   * Set only where the version is refused for who filed it, or for a seat the
   * chain holds that it leaves out and nobody invited to it waits for: the
   * refusals a version filed from here follows (`rosterHere`). Null for every
   * other refusal: one the company's records show withheld or changed, one a
   * read could not make, or a first version.
   */
  readonly followable: RosterReadHeld | null;
  constructor(why: string, followable: RosterReadHeld | null = null) {
    super(why);
    this.name = 'RosterNotBelieved';
    this.followable = followable;
  }
}

/** The roster as this device read it: the believed company, every entry as filed, its version, and the entries not believed. */
interface RosterRead {
  /** The company with only the entries this device believes, and those waiting for a seat. */
  readonly account: BelievedAccount;
  /** Every entry as the version was filed. Never shown. */
  readonly opened: Account;
  /** The version read: a version filed from here is filed above it. */
  readonly version: number;
  readonly refused: readonly RefusedEntry[];
  /** What each entry was held to on this read, for a change made here to be held to the same. */
  readonly witnesses: RosterWitnesses;
  /** What this read was held to, for the next version filed from here. */
  readonly held: RosterReadHeld;
}

/**
 * **THE SEATS PEOPLE WAITING FOR ONE WERE INVITED TO**: a seat the chain holds
 * before the roster names its signer, between the seat being carried out and
 * its signer being admitted. Each request is read from the company's inbox and
 * held to what every approving device holds it to before it approves the leaf
 * (`invitationRefusalHere`): the invitation of a seat this device believes and
 * has not seen retired, for the person and sign-in it names, and an opening
 * that makes this leaf. A proof the viewing key alone makes is not enough: any
 * holder of that key makes one. A seat whose own entry the directory already
 * holds was admitted, so nobody waits for it, whatever the inbox holds.
 */
const seatsWaitedFor = async (
  sealed: SealedAccount, viewingKey: Hex, seating: SeatingReads, entered: readonly DirectorySeat[],
): Promise<Set<string>> => {
  const seats = new Set<string>();
  for (const box of sealed.pendingSigners ?? []) {
    try {
      const payload = openFromInbox<PendingSignerPayload>(box.sealed, sealed.id, viewingKey);
      refuseASeatKeyNotFromTheInvitee(viewingKey, sealed.id, payload);
      const leaf = payload.leafCommitment.toLowerCase();
      if (entered.some((x) => x.seat.toLowerCase() === leaf)) continue;
      if ((await invitationRefusalHere(sealed, box, payload, seating)) === null) seats.add(leaf);
    } catch {
      /* A request that does not open, or whose keys are not the invitee's, waits for no seat. */
    }
  }
  return seats;
};

/**
 * The seats of a directory this device believes whose entry it opened and
 * believed: only those carry a wallet key to witness a roster entry with, and
 * only those are believed to have signed an invitation.
 */
export const provedSeatsOf = (seats: readonly DirectorySeat[]): DirectoryWitness[] =>
  seats.flatMap((x) => (x.committeeKey === undefined ? [] : [{
    seat: x.seat, signingKey: x.signingKey, committeeKey: x.committeeKey, retired: x.retired !== null, role: x.role, person: x.person,
  }]));

/**
 * **THE COMPANY'S ROSTER AS THIS DEVICE BELIEVES IT, FROM ITS FILED RECORD
 * ONLY.** Refused, with `NO_ROSTER_RECORD`, for a company whose signers were
 * never filed as a roster record: the unsigned list on its account record is
 * never read. Refused when the version is not filed by a seat this device
 * believes, whose role may file it (`filingRefusalOf`), or, for the first version, as the company was founded
 * with it (`firstRosterRefusal`). Then each entry is held to its own signer's witnesses
 * (`believedSigners`): the directory this device believes, read afresh with
 * the chain as the person's own wallet reads it, and this device's own key.
 * The records-key statements the directory is read with are taken only from
 * the entries believed.
 *
 * Refused whole, so nothing is built from it, when it has no entry for a seat
 * the chain holds that nobody invited to it is waiting for. An older version,
 * or another record under a version, is refused by the anchor on chain like
 * any record read as the newest; nothing a device believed before is kept. A
 * seat the chain holds that no believed entry names is returned in
 * `notBelieved`, and no committee is built while there is one.
 */
export async function rosterBelievedHere(
  sealed: SealedAccount & { readonly roster?: SealedCompanyRecord | null }, viewingKey: Hex,
  d: {
    readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress; readonly reads: RosterReads;
    /** This device's own signing key, and its own roster entry where it knows it. */
    readonly own?: { readonly signerId?: string | null; readonly signingPublicKey: string } | null;
  },
): Promise<RosterRead> {
  const roster = sealed.roster ?? null;
  if (roster === null) throw new RosterNotBelieved(NO_ROSTER_RECORD);
  let opened: Account;
  try {
    opened = openAccount(sealed, viewingKey, roster);
  } catch {
    throw new RosterNotBelieved('This device cannot open the company\'s roster with the key it holds. Reload the page and try again.');
  }
  let read: Awaited<ReturnType<typeof directoryHere>>;
  try {
    /* The statements are taken below from the entries this device believes, never from the roster as filed. */
    read = await directoryHere({ accountId: d.accountId, label: d.label, viewingKey, ...d.reads, attested: async () => [] }, {
      records: [{ store: 'company', kind: 'roster', id: ROSTER_ID }], founding: roster.version === 1,
    });
  } catch (e) {
    throw new RosterNotBelieved(`This device could not check who filed the company's roster (${(e as Error)?.message ?? String(e)}). Reload the page and try again.`);
  }
  const witnesses: RosterWitnesses = {
    accountId: d.accountId, label: d.label, account: d.account, seatsOnTheChain: read.holders.seats,
    directory: provedSeatsOf(read.dir.seats),
    own: d.own ?? null,
    retired: retiredAsAnchored(read),
  };
  const { believed, refused } = believedSigners(opened.signers, witnesses);
  const here = { ...read, another: seatsWithAnotherRecordsKey(read.dir, d.label, read.holders.account, attestedIn({ signers: believed })) };
  const why = roster.version === 1 ? firstRosterRefusal(here, roster, d.accountId, d.own ?? null)
    : judgeIn(here)(verifiedCompanyFiler(roster), 'roster', companyRecordKey('roster', ROSTER_ID), companyRecordEntry(roster), true);
  /* Every seat the chain holds is in the roster, or waited for by someone the company invited to it. */
  const waited = await seatsWaitedFor(sealed, viewingKey, { seats: witnesses.directory, onTheChain: read.holders.seats, leaves: d.reads.leaves }, read.dir.seats);
  const held: RosterReadHeld = { here, roster, refusedForItsFiler: false, opened, witnesses, waited };
  if (why !== null) {
    throw new RosterNotBelieved(`This device does not believe the company's roster it was given (${why}).`,
      roster.version !== 1 && refusedForItsFilerOnly(here, roster) ? { ...held, refusedForItsFiler: true } : null);
  }
  const missing = unnamedIn(opened.signers, stayingIn(witnesses), waited);
  if (missing.length > 0) {
    const over = passedOverSaid(read);
    throw new RosterNotBelieved(`This device does not believe the company's roster it was given (it has no entry for `
      + `${missing.length} seat(s) the company's account holds on the chain, so it leaves a signer out). Nothing is `
      + `built from it. ${over === null ? 'Ask a signer of the company to open it on their own device.' : `The way past it: ${over}.`}`, held);
  }
  return {
    account: { ...opened, signers: believed, notBelieved: seatsNotBelieved(believed, stayingIn(witnesses)) },
    opened, version: roster.version, refused, witnesses, held,
  };
}

/**
 * The seats a retirement anchored in the company's records retired, as the directory stood at the newest version the
 * anchor holds: one retired by a version filed and not yet anchored still has its entry, until that version is anchored.
 */
const retiredAsAnchored = (read: { readonly records: { readonly directory: ReadonlyMap<number, unknown> }; readonly at: DirectoryHere['at'] }): string[] => {
  const newest = Math.max(0, ...read.records.directory.keys());
  if (newest === 0) return [];
  return (read.at(newest)?.dir.seats ?? []).filter((x) => x.retired !== null).map((x) => x.seat.toLowerCase());
};

/** The seats the chain holds that no seated entry of `signers` names and nobody invited to them waits for. */
const unnamedIn = (signers: readonly Signer[], seatsOnTheChain: readonly string[], waited: ReadonlySet<string>): string[] =>
  [...new Set(seatsOnTheChain.map((x) => x.toLowerCase()))].filter((seat) => !waited.has(seat)
    && !signers.some((x) => x.status === 'active' && (x.leafCommitment ?? '').toLowerCase() === seat));

/**
 * Whether the seat whose filing key is `filer` may not file version `version`
 * of the roster, as this read believes the directory: no entry, a role that
 * files no roster, past its boundary, off the chain, or its own wallet has not
 * attested its records key. The one rule a roster's filer is judged by here.
 */
const filerRefusedHere = (here: Awaited<ReturnType<typeof directoryHere>>, filer: string, version: number): boolean => {
  const key = filer.toLowerCase() as Hex;
  const seat = here.dir.seats.find((x) => x.signingKey.toLowerCase() === key);
  return (seat !== undefined && here.another.has(seat.seat))
    || filingRefusalOf(here.dir, here.holders, key, 'roster', companyRecordKey('roster', ROSTER_ID), version) !== null;
};

/**
 * Whether a version is refused only for who filed it: signed by a seat that may
 * not file it (`filerRefusedHere`), and the company's records either hold it as
 * filed and not yet anchored, or hold no entry for it, which they keep for no
 * seat that may not file one, and name no newer version. Read from the records
 * and the directory, never from a refusal's words: a version they show
 * withheld, changed, passed over or past a header this device cannot check is
 * the service's doing, and is never followed.
 */
const refusedForItsFilerOnly = (here: Awaited<ReturnType<typeof directoryHere>>, roster: SealedCompanyRecord): boolean => {
  const filer = verifiedCompanyFiler(roster);
  if (filer === null || !filerRefusedHere(here, filer, roster.version)) return false;
  const s = heldStandingOf(here.records, companyRecordEntry(roster), filer);
  return ((s.standing === 'not-yet-anchored' && s.version === roster.version) || s.standing === 'not-entered')
    && s.newest <= roster.version;
};

/** Whether the company's records hold `rec` as that version, entered under the key that signed it: anchored or not yet. */
const heldAsFiled = (here: Awaited<ReturnType<typeof directoryHere>>, rec: SealedCompanyRecord): boolean => {
  const filer = verifiedCompanyFiler(rec);
  if (filer === null) return false;
  const s = heldStandingOf(here.records, companyRecordEntry(rec), filer);
  return (s.standing === 'anchored' || s.standing === 'older-than-anchored' || s.standing === 'not-yet-anchored') && s.version === rec.version;
};

/**
 * Why this device does not believe a company's first roster, or null when it
 * does. It is filed with the company by its founding signer's device and
 * anchored in the company's first batch, so it is believed by the rule the
 * first state is (`foundingRecordRefusalHere`), and only while no newer version
 * is named. On the founding signer's own device, on its own signing key, it is
 * believed before that first anchor too, while nothing is anchored and no newer
 * version is named: that device made it.
 */
const firstRosterRefusal = (
  here: Awaited<ReturnType<typeof directoryHere>>, roster: SealedCompanyRecord, accountId: string,
  own: { readonly signingPublicKey: string } | null,
): string | null => {
  const filer = verifiedCompanyFiler(roster);
  const read = { ...companyRecordEntry(roster), version: roster.version };
  const nothingAnchored = here.records.reached.seq < 0 && here.records.stopped === null;
  if (nothingAnchored && filer !== null && own !== null && filer.toLowerCase() === own.signingPublicKey.toLowerCase()) {
    return foundingRosterRefusal(roster, accountId, own.signingPublicKey) ?? newerNamedRefusal(here, read);
  }
  return foundingRecordRefusalHere(here, roster, (key) => foundingRosterRefusal(roster, accountId, key))
    ?? newerNamedRefusal(here, read);
};

/** Why the roster was not read or not filed from this device. Nothing was filed. */
class RosterNotFiled extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'RosterNotFiled';
  }
}

const route = (accountId: string, rest = ''): string => `/api/accounts/${encodeURIComponent(accountId)}${rest}`;

/** The roster to change from here: the read it rests on, and the company as the next version filed from here carries it. */
interface RosterHere extends RosterRead {
  readonly sealed: SealedAccount;
  /** Every entry the next version filed from here carries (`carriedHere`), and those waiting for a seat. Never shown. */
  readonly carried: Account;
  /** The version every device refuses that this read follows, and why it is refused; null when the newest is believed. */
  readonly followed: { readonly version: number; readonly why: string } | null;
}

/**
 * **THE COMPANY AND ITS SIGNERS AS THIS DEVICE BELIEVES THEM NOW, TO CHANGE
 * FROM HERE** (`rosterBelievedHere`), with the company's record as served, and
 * the entries the next version filed from here carries (`carriedHere`).
 *
 * A newest version every device refuses for who filed it, or for a seat the
 * chain holds that it leaves out, is followed: the company is then as this
 * device believes the version filed next would make it, and `followed` says
 * which version and why. Nothing is kept from an earlier read. Any other
 * refusal is thrown, and nothing is filed.
 */
export async function rosterHere(d: RosterDoors): Promise<RosterHere> {
  const sealed = await d.api(route(d.accountId)) as SealedAccount & { roster?: SealedCompanyRecord | null };
  let read: RosterRead;
  try {
    read = await rosterBelievedHere(sealed, d.viewingKey, { ...d, own: { signingPublicKey: signingPublicKeyOf(d.signingSecret) } });
  } catch (e) {
    if (!(e instanceof RosterNotBelieved)) throw e;
    if (e.followable === null) throw new RosterNotFiled(e.message);
    const held = e.followable;
    const { signers, above } = await carriedHere(d, held, true);
    const carried: Account = { ...held.opened, signers: [...signers, ...held.opened.signers.filter((s) => s.status !== 'active')] };
    const { believed, refused } = believedSigners(carried.signers, held.witnesses);
    return {
      sealed, opened: held.opened, version: above, refused, witnesses: held.witnesses, held, carried,
      account: { ...carried, signers: believed, notBelieved: seatsNotBelieved(believed, stayingIn(held.witnesses)) },
      followed: { version: held.roster.version, why: e.message },
    };
  }
  const { signers, above } = await carriedHere(d, read.held, false);
  return {
    sealed, ...read, version: above, followed: null,
    carried: { ...read.opened, signers: [...signers, ...read.opened.signers.filter((s) => s.status !== 'active')] },
  };
}

/** The refusals no later read can lift: an entry refused for one of them is dropped from every version filed from here. */
const REFUSED_FOR_GOOD: ReadonlySet<RosterEntryRefusal> = new Set<RosterEntryRefusal>(['not-their-signing-key', 'vault-keys-not-theirs', 'rights-not-the-chains', 'seat-retired']);

/** Whether a version filed from here carries `s`: believed here, or refused only for what a later read can lift. */
const carriedOn = (s: Signer, w: RosterWitnesses): boolean => {
  const why = rosterEntryRefusal(s, w);
  return why === null || !REFUSED_FOR_GOOD.has(why);
};

/**
 * **THE SEATED ENTRIES THE NEXT VERSION FILED FROM HERE CARRIES, AND THE
 * VERSION IT IS FILED ABOVE.** Every entry of the version read, except one
 * refused for good: an entry that waits for its signer's own directory entry,
 * or for a seat the chain does not show yet, is carried as filed, since
 * another device may believe it, or will. Belief in an entry reads only the
 * chain and the directory, so every device carries the same entries.
 *
 * A seat the chain holds that those entries leave out, and nobody invited to it
 * waits for, takes the newest entry an older version names for it that this
 * device carries on its own, where the company's records hold that version as
 * it was filed; where none does, the version read's own entry for it, refused
 * or not, since a version leaving a seat out is refused by every device.
 * Following a version every device refuses (`followed`), the versions are read
 * whatever is left out, and the version filed is above every version served;
 * a seat no version names stops the filing.
 *
 * A version refused for who filed it is held to nothing its entries do not
 * bind: each signer is taken from the newest older version filed by a seat
 * that may file it, as the records hold it, with only what the refused
 * version's own entry for that signer binds (`boundFrom`); the older versions
 * it fills a seat from are those too. A seat no such version names takes the
 * refused version's entry, which this device believes on its own.
 *
 * At most one entry stands for a seat (`oneEntryPerSeat`).
 */
const carriedHere = async (
  d: RosterDoors, held: RosterReadHeld, followed: boolean,
): Promise<{ readonly signers: Signer[]; readonly above: number }> => {
  const seated = held.opened.signers.filter((s) => s.status === 'active');
  let signers = seated.filter((s) => carriedOn(s, held.witnesses));
  let unnamed = unnamedIn(signers, stayingIn(held.witnesses), held.waited);
  let above = held.roster.version;
  if (followed || unnamed.length > 0) {
    const answer = await d.api(companyWirePaths.versions(d.accountId, 'roster', ROSTER_ID)) as { versions?: unknown } | null;
    if (!Array.isArray(answer?.versions)) throw new RosterNotFiled('The company\'s earlier rosters could not be read.');
    const served = (answer!.versions as unknown[]).map((m) => fromCompanyWire(m, { company: d.accountId, kind: 'roster', id: ROSTER_ID }).sealed);
    above = Math.max(above, ...served.map((r) => r.version));
    const older = served.filter((r) => r.version < held.roster.version && heldAsFiled(held.here, r)
      && (!held.refusedForItsFiler || !filerRefusedHere(held.here, verifiedCompanyFiler(r)!, r.version)))
      .sort((a, b) => b.version - a.version);
    if (held.refusedForItsFiler) {
      const base = older[0];
      if (base === undefined) {
        throw new RosterNotFiled('No version of the company\'s roster filed by a seat that may file one can be read, so the version '
          + 'every device refuses is not followed from here.');
      }
      signers = openRoster(base, d.viewingKey).signers.filter((s) => s.status === 'active' && carriedOn(s, held.witnesses))
        .map((b) => boundFrom(b, seated, held.witnesses));
      unnamed = unnamedIn(signers, stayingIn(held.witnesses), held.waited);
    }
    for (const rec of older) {
      if (unnamed.length === 0) break;
      const theirs = openRoster(rec, d.viewingKey).signers.filter((s) => s.status === 'active' && carriedOn(s, held.witnesses));
      for (const seat of unnamed) {
        const found = theirs.find((s) => (s.leafCommitment ?? '').toLowerCase() === seat);
        if (found !== undefined) signers.push(found);
      }
      unnamed = unnamedIn(signers, stayingIn(held.witnesses), held.waited);
    }
  }
  for (const seat of unnamed) {
    const own = seated.find((s) => (s.leafCommitment ?? '').toLowerCase() === seat);
    if (own !== undefined) signers.push(own);
  }
  unnamed = unnamedIn(signers, stayingIn(held.witnesses), held.waited);
  if (unnamed.length > 0) {
    throw new RosterNotFiled(`No version of the company's roster this device can read names an entry for ${unnamed.length} `
      + 'seat(s) the company\'s account holds on the chain, so a version filed from here would leave a signer out.');
  }
  return { signers: oneEntryPerSeat(signers, held.witnesses), above };
};

/**
 * `b`, an entry of a version filed by a seat that may file one, with what a
 * refused version's entry for the same signer, seat and filing key binds -
 * their vault keys and the entry their wallet signed - where that entry is one
 * this device believes. Its name, sign-in, role and wrapping key are `b`'s.
 */
const boundFrom = (b: Signer, refused: readonly Signer[], w: RosterWitnesses): Signer => {
  const r = refused.find((x) => x.id === b.id && (x.leafCommitment ?? '').toLowerCase() === (b.leafCommitment ?? '').toLowerCase()
    && x.signingPublicKey.toLowerCase() === b.signingPublicKey.toLowerCase());
  if (r === undefined || rosterEntryRefusal(r, w) !== null) return b;
  const bound: Signer = { ...b, vaultKeys: r.vaultKeys ?? b.vaultKeys, directoryEntry: r.directoryEntry ?? b.directoryEntry };
  return rosterEntryRefusal(bound, w) === null ? bound : b;
};

/**
 * **THE VERSION THAT FOLLOWS ONE EVERY DEVICE REFUSES, FILED FROM HERE**: the
 * entries `rosterHere` carries, filed above every version served, and entered
 * in the company's records. Returns the version filed; null, with nothing
 * filed, when the newest version is believed, or when this seat may not file a
 * roster (`filingRefusalOf`): a version it filed would be refused in turn.
 */
export async function fileTheRosterFollowedHere(d: RosterDoors): Promise<number | null> {
  const read = await rosterHere(d);
  if (read.followed === null) return null;
  if (filerRefusedHere(read.held.here, signingPublicKeyOf(d.signingSecret), read.version + 1)) return null;
  const { filing, entry } = nextFiling(d, read.sealed.keyEpoch, seatedOf(read.carried), read.version);
  await d.api(route(d.accountId, '/roster'), { method: 'POST', body: JSON.stringify({ ...filing, folded: [] }) });
  await d.entered.enter([entry]);
  return filing.roster.version;
}

/**
 * The roster's next version, sealed and signed here, with the index of the
 * company's vault keys made from it, and the entry the one filing call makes
 * of it once the service has kept it.
 */
const nextFiling = (d: RosterDoors, keyEpoch: number, next: RosterSecrets, version: number) => {
  const rec = signCompanyFiling(sealRoster(d.accountId, next, version + 1, keyEpoch, d.viewingKey), d.signingSecret);
  return {
    filing: {
      roster: { version: version + 1, message: toCompanyWire(rec) },
      index: vaultKeyIndexOf({ id: d.accountId, signers: next.signers }),
    },
    entry: companyRecordEntry(rec),
  };
};

/** The active signers, as the roster lists them: those waiting for a seat are in the company's inbox, not here. */
const seatedOf = (account: Account): RosterSecrets => ({ name: account.name, signers: account.signers.filter((s) => s.status === 'active') });

/** What an approving device reads to hold a seat request to the invitation behind it. */
export interface SeatingReads {
  /** The seats this device's own read of the company's directory believes (`provedSeatsOf`). */
  readonly seats: readonly DirectoryWitness[];
  /** Every seat the company's account holds now, as the person's own wallet read it for the same read. */
  readonly onTheChain: readonly string[];
  /** The leaf each opening makes, worked out in this device's vault worker. Never the service's word. */
  readonly leaves: RosterReads['leaves'];
}

/**
 * Whether `invited` is signed by the filing key of a seat this device believes,
 * whose role may invite (`mayInvite`), and which it has not seen retired - or,
 * once the chain holds the leaf the request is for (`leafOnTheChain`), which it
 * believes at all: the signers approved that leaf on the chain with its
 * inviter checked, so an inviter who has left since strands nobody waiting to
 * be admitted.
 */
const signedByASeatHeld = (invited: SignedSeatInvitation, seats: readonly DirectoryWitness[], leafOnTheChain = false): boolean =>
  seats.some((x) => (leafOnTheChain || !x.retired) && mayInvite(x) && x.signingKey.toLowerCase() === invited.signedBy.toLowerCase());

/** Whether `leaf` is one of the seats the company's account holds now, as this device's own wallet read it. */
const onTheChain = (leaf: string, reads: Pick<SeatingReads, 'onTheChain'>): boolean =>
  reads.onTheChain.some((x) => x.toLowerCase() === leaf.toLowerCase());

/** Thrown with the sentence an approving device shows; nothing was raised, approved, carried out or filed. */
const notTheInvited = (why: string): SeatKeyNotFromTheInvitee =>
  new SeatKeyNotFromTheInvitee(`${why} Nothing was sent. Do not give this person access: ask a seated signer to invite them again.`);

/**
 * **A SEAT GOES TO THE PERSON INVITED, AND ITS LEAF TO THEIR WALLET**: refuses,
 * before any device approves the leaf, a seat request that is not held fast to
 * the invitation behind it. It must carry who the seat is for
 * (`seatInvitationRefusal`), signed by a seat this device believes whose role
 * may invite and which it has not seen retired (until the chain holds the
 * leaf), for this company and for the name and role it asks for; the
 * person it was sealed for and the sign-in the service holds it under must be
 * that invitation's person; where the invitation names a leaf, it must be this
 * leaf; its opening must make this leaf for the wallet key it names
 * (`walletKeyProvedBy`, with the leaf this device's vault worker works out); and
 * no other request waiting in the company's inbox, under an invitation a seat
 * this device believes signed, may answer the same invitation or wait for the
 * same person; and the person may hold no other seat this device believes and
 * has not seen retired. Trusts the viewing key, this device's own read of the directory
 * and its own vault worker; trusts nothing the service says about who is
 * waiting.
 */
export async function refuseASeatNotForTheInvited(
  sealed: SealedAccount, viewingKey: Hex, box: Pick<PendingSigner, 'id' | 'userId'>, payload: PendingSignerPayload, reads: SeatingReads,
): Promise<void> {
  const why = await invitationRefusalHere(sealed, box, payload, reads);
  if (why !== null) throw notTheInvited(why);
  const t = payload.invited!.terms;
  for (const other of sealed.pendingSigners ?? []) {
    if (other.id === box.id) continue;
    let theirs: PendingSignerPayload;
    try {
      theirs = openFromInbox<PendingSignerPayload>(other.sealed, sealed.id, viewingKey);
    } catch {
      continue;
    }
    /* Only an invitation a seat this device believes signed counts: anybody can seal a request to the inbox, a seat's signature nobody can make. */
    if (seatInvitationRefusal(theirs.invited) !== null || !signedByASeatHeld(theirs.invited!, reads.seats)) continue;
    if (theirs.invited!.terms.invitation === t.invitation) {
      throw notTheInvited('Another seat request answers the same invitation, so this device seats neither.');
    }
    /* One person waits for one seat: two requests for them, under two invitations, are one person's two votes. */
    if (theirs.invited!.terms.person === t.person) {
      throw notTheInvited('Another seat request is waiting for the same person, so this device seats neither. Withdraw the one '
        + 'that should not be seated first.');
    }
  }
  /* A person holds one seat not retired: one this device believes already holds a seat is not seated again. */
  const leaf = payload.leafCommitment.toLowerCase();
  if (reads.seats.some((x) => !x.retired && x.person === t.person && x.seat.toLowerCase() !== leaf)) {
    throw notTheInvited('The person this seat request is for already holds a seat on this company, so nobody is seated from it.');
  }
}

/**
 * Why one seat request is not held fast to the invitation behind it, in the
 * sentence an approving device shows, or null: everything
 * `refuseASeatNotForTheInvited` holds a request to but the other requests in
 * the inbox. The one rule for approving a leaf and for a seat being waited for.
 */
const invitationRefusalHere = async (
  sealed: SealedAccount, box: Pick<PendingSigner, 'userId'>, payload: PendingSignerPayload, reads: SeatingReads,
): Promise<string | null> => {
  const invited = payload.invited;
  if (seatInvitationRefusal(invited) !== null || invited === undefined) {
    return 'This seat request does not carry who the seat is for, signed by the seat that invited them, so nobody is seated from it.';
  }
  const t = invited.terms;
  if (t.company !== sealed.id || t.name !== payload.name || t.role !== payload.role) {
    return 'This seat request asks for another company, name or role than its invitation gave, so nobody is seated from it.';
  }
  if (!signedByASeatHeld(invited, reads.seats, onTheChain(payload.leafCommitment, reads))) {
    const inviter = reads.seats.find((x) => x.signingKey.toLowerCase() === invited.signedBy.toLowerCase());
    return inviter !== undefined && !mayInvite(inviter)
      ? 'The seat that signed this invitation has a role that may not file a proposal, so it invites nobody, and nobody is seated from it.'
      : 'The seat that signed this invitation is not one this device believes is seated, so nobody is seated from it.';
  }
  if (payload.person !== t.person || box.userId !== t.person) {
    return 'This seat request is not for the person the invitation names, so nobody is seated from it.';
  }
  if (t.leaf !== undefined && t.leaf.toLowerCase() !== payload.leafCommitment.toLowerCase()) {
    return 'The keys in this seat request are not the ones the code its invitation was made for carried, so nobody is seated from it.';
  }
  if (seatOpeningRefusal(payload.opening) !== null) {
    return 'This seat request does not show which wallet its keys were made for, so nobody is seated from it.';
  }
  const [made] = await reads.leaves([payload.opening!]);
  if (walletKeyProvedBy(payload.opening, payload.leafCommitment.toLowerCase(), () => made ?? null) === null) {
    return 'The keys in this seat request are not made for the wallet it names, so nobody is seated from it.';
  }
  return null;
};

/**
 * **WHO WAITS FOR A SEAT UNDER `signerId`, AS THIS DEVICE READS AND CHECKS IT.**
 * Their keys are read from what they left in the company's inbox and held to:
 * the proof their invitation gave them; no other signer already holding the same
 * keys; the fingerprint they read out to whoever seats them; the sign-in
 * their request was sealed for, which must be the one the company would make a
 * member; and the invitation behind it (`refuseASeatNotForTheInvited`).
 */
export async function waitingHere(
  sealed: SealedAccount, account: Account, viewingKey: Hex, signerId: string, readOut: string, seating: SeatingReads,
): Promise<{ readonly payload: PendingSignerPayload; readonly userId: string | null }> {
  const box = sealed.pendingSigners.find((p) => p.id === signerId);
  if (box === undefined) {
    throw new SeatKeyNotFromTheInvitee('That person is no longer waiting for a seat. Reload the page. Nothing was sent.');
  }
  const payload = openFromInbox<PendingSignerPayload>(box.sealed, sealed.id, viewingKey);
  refuseASeatKeyNotFromTheInvitee(viewingKey, sealed.id, payload);
  if (account.signers.some((x) => x.id !== signerId && (x.signingPublicKey === payload.signingPublicKey
    || (x.leafCommitment ?? '').toLowerCase() === payload.leafCommitment.toLowerCase()))) {
    throw new SeatKeyNotFromTheInvitee('These keys already belong to another signer on this company, so they cannot be '
      + 'seated under this name. Nothing was sent. Do not give this person access: they need a new invitation.');
  }
  refuseASeatWhoseFingerprintIsNotTheJoiners(payload, readOut);
  if (typeof payload.person !== 'string' || payload.person !== box.userId) {
    throw new SeatKeyNotFromTheInvitee('This seat request was not sealed for the sign-in it would make a member of the '
      + 'company, so nobody is seated from it. Nothing was sent. Ask the person to accept their invitation again.');
  }
  await refuseASeatNotForTheInvited(sealed, viewingKey, box, payload, seating);
  return { payload, userId: box.userId };
}

/** What `waitingHere` holds a request to, from one read of the roster: the directory that read believed, and this device's vault worker. */
export const seatingOf = (read: { readonly witnesses: RosterWitnesses }, reads: Pick<RosterReads, 'leaves'>): SeatingReads =>
  ({ seats: read.witnesses.directory, onTheChain: read.witnesses.seatsOnTheChain, leaves: reads.leaves });

/**
 * **A PERSON SEATED ON THE CHAIN, ADMITTED.** Their request is checked again
 * here (`waitingHere`), the roster is filed with them in it, and the company's
 * key is wrapped to the key they gave. Refused by the service until the chain
 * holds their seat, with nothing filed.
 */
export async function admitSignerHere(d: RosterDoors, input: { signerId: string; readOut: string }): Promise<void> {
  const read = await rosterHere(d);
  const { sealed, opened, carried, version } = read;
  /* Held against the entries this device believes: one nobody believes holds no keys from anybody. */
  const { payload } = await waitingHere(sealed, read.account, d.viewingKey, input.signerId, input.readOut, seatingOf(read, d.reads));
  const pending = opened.signers.find((s) => s.id === input.signerId)!;
  /* The entries the next version carries (`carriedHere`): an admission changes nobody else's entry. */
  const seated = seatedOf(carried);
  /* The admission stands for its seat: another entry at the same leaf, which no device believes, is left out. */
  const leaf = payload.leafCommitment.toLowerCase();
  const next: RosterSecrets = {
    name: seated.name,
    signers: [...seated.signers.filter((s) => (s.leafCommitment ?? '').toLowerCase() !== leaf), { ...pending, status: 'active', leafCommitment: payload.leafCommitment }],
  };
  const wrap = wrapKey(d.viewingKey, payload.wrappingPublicKey);
  const { filing, entry } = nextFiling(d, sealed.keyEpoch, next, version);
  await d.api(route(d.accountId, `/signers/${encodeURIComponent(input.signerId)}/admit`), {
    method: 'POST',
    body: JSON.stringify({ ...filing, leaf: payload.leafCommitment.toLowerCase(), wrap }),
  });
  await d.entered.enter([entry]);
}

/**
 * **THIS SIGNER'S OWN VAULT KEYS, OFFERED, SEALED**: the two public keys signed
 * with their own signing key for their roster entry, the statement their
 * wallet signed over the records key and their seat, and the directory entry
 * their wallet signed in the same press, all sealed under the company's roster
 * key (`viewingKey`), so the service never holds their wallet key. Refused
 * here when the statement is not for the records key this device works out
 * from the company key the wallet released.
 */
export async function offerVaultKeysHere(
  api: Api, accountId: string,
  keys: {
    readonly signerId: string; readonly signingSecret: Hex; readonly companyKey: Hex; readonly committeeKey: VaultKey;
    readonly recordsKey: RecordsKeyStatement; readonly entry: DirectoryEntryStatement; readonly viewingKey: Hex;
  },
): Promise<void> {
  const recordsKey = recordsKeypairFrom(fromHex(keys.companyKey)).publicKey;
  if (String(keys.recordsKey.recordsKey).toLowerCase() !== recordsKey.toLowerCase()) {
    throw new Error('your wallet signed a records key that is not the one your company key gives, so your vault keys were '
      + 'not offered. Open the company with your wallet again.');
  }
  const signed = signVaultKeys(accountId, keys.signerId, {
    committeeKey: keys.committeeKey, recordsKey,
    recordsKeyStatement: keys.recordsKey.signature as Hex, recordsKeySeat: keys.recordsKey.seat as Hex,
  }, keys.signingSecret);
  const offer = sealVaultKeysOffer(accountId, { signerId: keys.signerId, entry: { committeeKey: keys.committeeKey, statement: keys.entry }, keys: signed }, keys.viewingKey);
  await api(route(accountId, '/vault-keys'), { method: 'PUT', body: JSON.stringify({ offer }) });
}

/** What folding the open offers came to: the seats folded in, and each offer refused with why. */
export interface Folded {
  readonly folded: readonly string[];
  readonly refused: ReadonlyArray<{ readonly seat: string; readonly why: string }>;
}

/**
 * **EVERY OPEN OFFER OF VAULT KEYS, FOLDED INTO THE ROSTER FROM THIS DEVICE.**
 * Each is opened under the company's roster key (`openVaultKeysOffer`) and
 * checked against the roster this device opened (`rosterWithVaultKeys`):
 * signed for its signer's entry by the signing key that entry holds, and its
 * records-key statement verifying for the seat that entry holds. An offer is
 * folded only when the entry it makes is one this device believes. An offer that fails is left out, never folded, and stays
 * open. The roster is filed once, with the offers it took, which the service
 * lets go once the roster holds their keys. The service files it only for a
 * seat the company's directory believes.
 */
export async function foldOffersHere(d: RosterDoors): Promise<Folded> {
  const { offers } = await d.api(route(d.accountId, '/vault-keys/offers')) as { offers: VaultKeysOffer[] };
  if (offers.length === 0) return { folded: [], refused: [] };
  const { sealed, carried, version, witnesses } = await rosterHere(d);
  /* The entries the next version carries (`carriedHere`): a fold changes only the entries of the offers it takes. */
  let roster = seatedOf(carried);
  const folded: string[] = [];
  const refused: { seat: string; why: string }[] = [];
  for (const kept of offers) {
    const seat = String(kept?.seat ?? '').toLowerCase();
    try {
      const offer = openVaultKeysOffer(d.accountId, kept, d.viewingKey);
      if (typeof offer === 'string') throw new Error(`the offer is refused: ${offer}.`);
      /* The entry its own wallet signed: for this company, naming the keys it gives, for the seat and signing key the roster holds. */
      const notKept = vaultKeysOfferRefusal(d.label, d.account, d.accountId, offer);
      if (notKept !== null) throw new Error(`the offer is refused: ${notKept}.`);
      const entry = roster.signers.find((x) => x.id === offer.signerId && x.status === 'active');
      if (entry === undefined || (entry.leafCommitment ?? '').toLowerCase() !== seat
        || entry.signingPublicKey.toLowerCase() !== String(offer.entry.statement.signingKey).toLowerCase()) {
        throw new Error('the offer\'s own directory entry is not for the seat and signing key the roster holds for that signer.');
      }
      /* Signed by the signing key the roster holds for that signer, and its records-key statement for the seat it holds. */
      const next = rosterWithVaultKeys(roster, d.accountId, d.label, d.account, offer.signerId, offer.keys);
      const keyed = next === 'already-given' ? roster : next;
      /* The entry their wallet signed is kept beside their keys, so every device can hold their entry to it. */
      const signedEntry = { committeeKey: { tag: offer.entry.committeeKey.tag, value: offer.entry.committeeKey.value }, statement: offer.entry.statement };
      const withEntry = { ...keyed, signers: keyed.signers.map((x) => (x.id === offer.signerId ? { ...x, directoryEntry: signedEntry } : x)) };
      /*
       * The entry it makes must be one this device believes, held to the same witnesses the roster was read against:
       * an offer is never folded into an entry this device refuses, unless the witness it brings is all that was missing.
       */
      const made = withEntry.signers.find((x) => x.id === offer.signerId)!;
      const unbelieved = rosterEntryRefusal(made, witnesses);
      if (unbelieved !== null) throw new Error(`the entry it would make is not one this device believes: ${ROSTER_ENTRY_REFUSAL[unbelieved]}.`);
      roster = withEntry;
      folded.push(seat);
    } catch (e) {
      refused.push({ seat, why: (e as Error)?.message ?? String(e) });
    }
  }
  /*
   * Filed once, with the offers it took: the service lets go of an offer only once the roster filed holds its keys. An
   * offer refused here stays open until its own signer offers again, for this or another seat's device to fold.
   */
  if (folded.length === 0) return { folded, refused };
  const { filing, entry } = nextFiling(d, sealed.keyEpoch, roster, version);
  await d.api(route(d.accountId, '/roster'), { method: 'POST', body: JSON.stringify({ ...filing, folded }) });
  await d.entered.enter([entry]);
  return { folded, refused };
}
