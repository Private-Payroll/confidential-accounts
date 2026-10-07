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
 * shown; a filing from here carries it on as it was filed, never changed.
 *
 * Three changes are made here, each checked here first:
 *
 *   · a person waiting for a seat is **admitted** once the chain holds their
 *     seat: their keys are held to the proof their invitation gave them, to the
 *     fingerprint they read out, and to the sign-in their request was sealed
 *     for; the company's key is wrapped to the key they gave;
 *   · a new signer **offers** their vault keys, before the company's committee
 *     holds their key and they can file the roster themselves;
 *   · every open offer is **folded** into the roster by a seat already believed,
 *     each checked against the signing key the roster holds for that signer.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonical, fromHex, signingPublicKeyOf, toHex, utf8, wrapKey, type Hex } from '../../../src/core/crypto.js';
import { openFromInbox } from '../../../src/core/sealed-records.js';
import { openAccount } from '../../../src/core/account.js';
import {
  believedSigners, foundingRosterRefusal, ROSTER_ENTRY_REFUSAL, ROSTER_ID, rosterEntryRefusal, sealRoster, seatsNotBelieved,
  type RefusedEntry, type RosterSecrets, type RosterWitnesses,
} from '../../../src/core/roster-record.js';
import { refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import {
  rosterWithVaultKeys, signVaultKeys, vaultKeyIndexOf, vaultKeysOfferRefusal, type VaultKey, type VaultKeysOffer,
} from '../../../src/core/vault-keys.js';
import type { Account, PendingSignerPayload, SealedAccount } from '../../../src/core/types.js';
import { signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordKey, seatsWithAnotherRecordsKey } from '../../../src/midnight/seat-directory.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { refuseASeatWhoseFingerprintIsNotTheJoiners } from './invitation-on-device.js';
import { attestedIn, directoryHere, foundingSeatHere, judgeIn, type DirectoryHereDeps } from './vault-page-doors.js';

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
}

/**
 * The company's directory filings and the chain as the person's own wallet
 * reads it, what a roster is believed against; and what this person's devices
 * believed of the company's roster before, which a later read may not go back
 * on.
 */
export type RosterReads = Pick<DirectoryHereDeps, 'filings' | 'holders'> & { readonly believed: RosterBelievedBefore };

/**
 * **WHAT THIS PERSON'S DEVICES BELIEVED OF A COMPANY'S ROSTER BEFORE**: the
 * newest version, the digest of that version as filed, and for each seat the
 * wallet its entry was believed on. Kept sealed with the person's own keys,
 * in the bundle the service stores and cannot open: a service that serves an
 * older bundle takes this device back to what it believed then.
 */
export interface RosterSeenBefore {
  readonly version: number;
  readonly digest: string;
  /** Seat (64 hex) to the wallet its entry was believed on (`tag:value`). */
  readonly wallets: Readonly<Record<string, string>>;
}

/** The doors over what was believed before: read it, and keep what a read now believes. */
export interface RosterBelievedBefore {
  readonly read: () => RosterSeenBefore | null;
  readonly keep: (now: RosterSeenBefore) => Promise<void>;
}

/**
 * The company as this device believes it, with every seat the chain holds that
 * no believed entry names (`notBelieved`): a committee, a reader list or a count
 * of approvers is built only when that is empty.
 */
export type BelievedAccount = Account & { readonly notBelieved: readonly string[] };

/** The fixed sentence for a company that has never filed its signers as a roster record: its signers are not read. */
export const NO_ROSTER_RECORD = 'This company\'s signers have never been filed as a record a seat signed, so this device does '
  + 'not read them. A signer of the company opens it on their own device to file them.';

/** Why the company's roster was not read on this device. Nothing was shown from it. */
export class RosterNotBelieved extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'RosterNotBelieved';
  }
}

/** The roster as this device read it: the believed company, every entry as filed, its version, and the entries not believed. */
interface RosterRead {
  /** The company with only the entries this device believes, and those waiting for a seat. */
  readonly account: BelievedAccount;
  /** Every entry as the version was filed, for a filing from here to carry on unchanged. Never shown. */
  readonly opened: Account;
  readonly version: number;
  readonly refused: readonly RefusedEntry[];
  /** What each entry was held to on this read, for a change made here to be held to the same. */
  readonly witnesses: RosterWitnesses;
}

/** The digest of a roster version as filed: what a version this device believed is known by. */
const digestOf = (roster: SealedCompanyRecord): string => toHex(sha256(utf8(canonical(roster))));

/**
 * The seats people waiting for one were invited to, read from the company's
 * inbox and held to the proof each invitation gave: a seat the chain holds
 * before the roster names its signer, between the seat being carried out and
 * its signer being admitted.
 */
const seatsWaitedFor = (sealed: SealedAccount, viewingKey: Hex): Set<string> => {
  const seats = new Set<string>();
  for (const box of sealed.pendingSigners ?? []) {
    try {
      const payload = openFromInbox<PendingSignerPayload>(box.sealed, sealed.id, viewingKey);
      refuseASeatKeyNotFromTheInvitee(viewingKey, sealed.id, payload);
      seats.add(payload.leafCommitment.toLowerCase());
    } catch {
      /* A request that does not open, or whose keys are not the invitee's, waits for no seat. */
    }
  }
  return seats;
};

/**
 * Why this device does not believe a roster version against what this
 * person's devices believed before, or null when it may: no older version, no
 * other record under the version believed, and no seat the chain still holds
 * whose signer was believed before and is not now, or is now on another
 * wallet. A roster a believed seat filed without another signer's entry, or
 * with the entry their wallet signed stripped, is refused here by every device
 * that believed it before.
 */
const goesBackOn = (
  before: RosterSeenBefore | null, version: number, digest: string,
  wallets: Readonly<Record<string, string>>, seatsOnTheChain: readonly string[],
): string | null => {
  if (before === null) return null;
  if (version < before.version) {
    return `it is version ${version} and this device already believed version ${before.version}, so it is an older roster than one already read`;
  }
  if (version === before.version && digest !== before.digest) {
    return `it is not the version ${version} this device already believed`;
  }
  const held = new Set(seatsOnTheChain.map((x) => x.toLowerCase()));
  const lost = Object.entries(before.wallets).filter(([seat, wallet]) => held.has(seat) && wallets[seat] !== wallet);
  return lost.length === 0 ? null
    : `it no longer shows, as this device believed before, the signer${lost.length === 1 ? '' : 's'} at ${lost.length} `
      + 'seat(s) the chain still holds';
};

/**
 * **THE COMPANY'S ROSTER AS THIS DEVICE BELIEVES IT, FROM ITS FILED RECORD
 * ONLY.** Refused, with `NO_ROSTER_RECORD`, for a company whose signers were
 * never filed as a roster record: the unsigned list on its account record is
 * never read. Refused when the version is not filed by a seat this device
 * believes (check S), or, for the first version, by the founding seat
 * (`firstRosterRefusal`). Then each entry is held to its own signer's witnesses
 * (`believedSigners`): the directory this device believes, read afresh with
 * the chain as the person's own wallet reads it, and this device's own key.
 * The records-key statements the directory is read with are taken only from
 * the entries believed.
 *
 * Refused whole, so nothing is built from it, when it has no entry for a seat
 * the chain holds that nobody invited to it is waiting for, or when it goes
 * back on what this person's devices believed before: an older version,
 * another record under the version believed, or a seat the chain still holds
 * whose signer was believed before and is not now. What is read is kept for
 * the next read. A seat the chain holds that no believed entry names is
 * returned in `notBelieved`, and no committee is built while there is one.
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
    read = await directoryHere({ accountId: d.accountId, label: d.label, ...pickReads(d.reads), attested: async () => [] });
  } catch (e) {
    throw new RosterNotBelieved(`This device could not check who filed the company's roster (${(e as Error)?.message ?? String(e)}). Reload the page and try again.`);
  }
  const witnesses: RosterWitnesses = {
    accountId: d.accountId, label: d.label, account: d.account, seatsOnTheChain: read.holders.seats,
    directory: read.dir.seats.map((x) => ({ seat: x.seat, signingKey: x.signingKey, committeeKey: x.committeeKey })),
    own: d.own ?? null,
  };
  const { believed, refused, wallets } = believedSigners(opened.signers, witnesses);
  const here = { ...read, another: seatsWithAnotherRecordsKey(read.dir, d.label, read.holders.account, attestedIn({ signers: believed })) };
  const why = roster.version === 1 ? firstRosterRefusal(here, roster, d.accountId, d.own ?? null)
    : judgeIn(here)(verifiedCompanyFiler(roster), 'roster', companyRecordKey('roster', ROSTER_ID), roster.version);
  if (why !== null) throw new RosterNotBelieved(`This device does not believe the company's roster it was given (${why}).`);
  /* Every seat the chain holds is in the roster, or waited for by someone the company invited to it. */
  const waited = seatsWaitedFor(sealed, viewingKey);
  const missing = [...new Set(read.holders.seats.map((x) => x.toLowerCase()))].filter((seat) => !waited.has(seat)
    && !opened.signers.some((x) => x.status === 'active' && (x.leafCommitment ?? '').toLowerCase() === seat));
  if (missing.length > 0) {
    throw new RosterNotBelieved(`This device does not believe the company's roster it was given (it has no entry for `
      + `${missing.length} seat(s) the company's account holds on the chain, so it leaves a signer out). Nothing is `
      + 'built from it. Ask a signer of the company to open it on their own device.');
  }
  const digest = digestOf(roster);
  const before = d.reads.believed.read();
  const back = goesBackOn(before, roster.version, digest, wallets, read.holders.seats);
  if (back !== null) {
    throw new RosterNotBelieved(`This device does not believe the company's roster it was given (${back}). Nothing is `
      + 'built from it. Ask a signer of the company to open it on their own device.');
  }
  await keepWhatIsBelieved(d.reads.believed, before, roster.version, digest, wallets, read.holders.seats);
  return {
    account: { ...opened, signers: believed, notBelieved: seatsNotBelieved(believed, read.holders.seats) },
    opened, version: roster.version, refused, witnesses,
  };
}

/**
 * Keeps what a read now believes, when it is newer than what was kept: the
 * version, its digest, and every seat's wallet, those the chain still holds
 * from before carried on.
 */
const keepWhatIsBelieved = async (
  believed: RosterBelievedBefore, before: RosterSeenBefore | null, version: number, digest: string,
  wallets: Readonly<Record<string, string>>, seatsOnTheChain: readonly string[],
): Promise<void> => {
  const held = new Set(seatsOnTheChain.map((x) => x.toLowerCase()));
  const carried = Object.fromEntries(Object.entries(before?.wallets ?? {}).filter(([seat]) => held.has(seat)));
  const next: RosterSeenBefore = { version, digest, wallets: { ...carried, ...wallets } };
  if (before !== null && before.version === version && canonical(before.wallets) === canonical(next.wallets)) return;
  await believed.keep(next);
};

const pickReads = (r: RosterReads): Pick<DirectoryHereDeps, 'filings' | 'holders'> => ({ filings: r.filings, holders: r.holders });

/**
 * Why this device does not believe a company's first roster, or null when it
 * does. It is filed with the company by its founding signer's device, before
 * any seat has a directory entry, so it is believed by the rule the first
 * state is: signed by the founding seat the deploy carried, whose entry is
 * signed by the committee key the deploy held the account by
 * (`foundingSeatHere`); and on the founding signer's own device, on its own
 * signing key, until that entry is filed.
 */
const firstRosterRefusal = (
  here: Awaited<ReturnType<typeof directoryHere>>, roster: SealedCompanyRecord, accountId: string,
  own: { readonly signingPublicKey: string } | null,
): string | null => {
  const filer = verifiedCompanyFiler(roster);
  if (filer !== null && own !== null && filer.toLowerCase() === own.signingPublicKey.toLowerCase()) {
    return foundingRosterRefusal(roster, accountId, own.signingPublicKey);
  }
  const seat = foundingSeatHere(here);
  return typeof seat === 'string' ? seat : foundingRosterRefusal(roster, accountId, seat.signingKey);
};

/** Why the roster was not read or not filed from this device. Nothing was filed. */
class RosterNotFiled extends Error {
  constructor(why: string) {
    super(`${why} Nothing was filed.`);
    this.name = 'RosterNotFiled';
  }
}

const route = (accountId: string, rest = ''): string => `/api/accounts/${encodeURIComponent(accountId)}${rest}`;

/**
 * **THE COMPANY AND ITS SIGNERS AS THIS DEVICE BELIEVES THEM NOW, TO CHANGE
 * FROM HERE** (`rosterBelievedHere`), with the company's record as served.
 * Nothing is filed when it is refused.
 */
export async function rosterHere(d: RosterDoors): Promise<RosterRead & { sealed: SealedAccount }> {
  const sealed = await d.api(route(d.accountId)) as SealedAccount & { roster?: SealedCompanyRecord | null };
  try {
    return { sealed, ...(await rosterBelievedHere(sealed, d.viewingKey, { ...d, own: { signingPublicKey: signingPublicKeyOf(d.signingSecret) } })) };
  } catch (e) {
    if (e instanceof RosterNotBelieved) throw new RosterNotFiled(e.message);
    throw e;
  }
}

/** The roster's next version, sealed and signed here, with the index of the company's vault keys made from it. */
const nextFiling = (d: RosterDoors, keyEpoch: number, next: RosterSecrets, version: number) => {
  const rec = signCompanyFiling(sealRoster(d.accountId, next, version + 1, keyEpoch, d.viewingKey), d.signingSecret);
  return {
    roster: { version: version + 1, message: toCompanyWire(rec) },
    index: vaultKeyIndexOf({ id: d.accountId, signers: next.signers }),
  };
};

/** The active signers, as the roster lists them: those waiting for a seat are in the company's inbox, not here. */
const seatedOf = (account: Account): RosterSecrets => ({ name: account.name, signers: account.signers.filter((s) => s.status === 'active') });

/**
 * **WHO WAITS FOR A SEAT UNDER `signerId`, AS THIS DEVICE READS AND CHECKS IT.**
 * Their keys are read from what they left in the company's inbox and held to:
 * the proof their invitation gave them; no other signer already holding the same
 * keys; the fingerprint they read out to whoever seats them; and the sign-in
 * their request was sealed for, which must be the one the company would make a
 * member.
 */
export function waitingHere(
  sealed: SealedAccount, account: Account, viewingKey: Hex, signerId: string, readOut: string,
): { readonly payload: PendingSignerPayload; readonly userId: string | null } {
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
  return { payload, userId: box.userId };
}

/**
 * **A PERSON SEATED ON THE CHAIN, ADMITTED.** Their request is checked again
 * here (`waitingHere`), the roster is filed with them in it, and the company's
 * key is wrapped to the key they gave. Refused by the service until the chain
 * holds their seat, with nothing filed.
 */
export async function admitSignerHere(d: RosterDoors, input: { signerId: string; readOut: string }): Promise<void> {
  const { sealed, opened, version } = await rosterHere(d);
  const { payload } = waitingHere(sealed, opened, d.viewingKey, input.signerId, input.readOut);
  const pending = opened.signers.find((s) => s.id === input.signerId)!;
  /* Every entry as it was filed, believed here or not: an admission changes nobody else's entry. */
  const seated = seatedOf(opened);
  const next: RosterSecrets = { name: seated.name, signers: [...seated.signers, { ...pending, status: 'active', leafCommitment: payload.leafCommitment }] };
  const wrap = wrapKey(d.viewingKey, payload.wrappingPublicKey);
  await d.api(route(d.accountId, `/signers/${encodeURIComponent(input.signerId)}/admit`), {
    method: 'POST',
    body: JSON.stringify({ ...nextFiling(d, sealed.keyEpoch, next, version), leaf: payload.leafCommitment.toLowerCase(), wrap }),
  });
}

/**
 * **THIS SIGNER'S OWN VAULT KEYS, OFFERED**: the two public keys signed with
 * their own signing key for their roster entry, the statement their wallet
 * signed over the records key and their seat, and the directory entry their
 * wallet signed in the same press. Refused here when the statement is not for
 * the records key this device works out from the company key the wallet
 * released.
 */
export async function offerVaultKeysHere(
  api: Api, accountId: string,
  keys: {
    readonly signerId: string; readonly signingSecret: Hex; readonly companyKey: Hex; readonly committeeKey: VaultKey;
    readonly recordsKey: RecordsKeyStatement; readonly entry: DirectoryEntryStatement;
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
  const offer: Omit<VaultKeysOffer, 'person'> = { signerId: keys.signerId, entry: { committeeKey: keys.committeeKey, statement: keys.entry }, keys: signed };
  await api(route(accountId, '/vault-keys'), { method: 'PUT', body: JSON.stringify({ offer }) });
}

/** What folding the open offers came to: the seats folded in, and each offer refused with why. */
export interface Folded {
  readonly folded: readonly string[];
  readonly refused: ReadonlyArray<{ readonly seat: string; readonly why: string }>;
}

/**
 * **EVERY OPEN OFFER OF VAULT KEYS, FOLDED INTO THE ROSTER FROM THIS DEVICE.**
 * Each is checked against the roster this device opened (`rosterWithVaultKeys`):
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
  const { sealed, opened, version, witnesses } = await rosterHere(d);
  /* Every entry as it was filed, believed here or not: a fold changes only the entries of the offers it takes. */
  let roster = seatedOf(opened);
  const folded: string[] = [];
  const refused: { seat: string; why: string }[] = [];
  for (const offer of offers) {
    const seat = String(offer.entry?.statement?.seat ?? '').toLowerCase();
    try {
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
      const unbelieved = rosterEntryRefusal(made, witnesses, withEntry.signers.filter((x) => x.status === 'active'));
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
  const filing = nextFiling(d, sealed.keyEpoch, roster, version);
  await d.api(route(d.accountId, '/roster'), { method: 'POST', body: JSON.stringify({ ...filing, folded }) });
  return { folded, refused };
}
