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
  believedSigners, foundingRosterRefusal, ROSTER_ENTRY_REFUSAL, ROSTER_ID, rosterEntryRefusal, sealRoster, seatsNotBelieved,
  type RefusedEntry, type RosterSecrets, type RosterWitnesses,
} from '../../../src/core/roster-record.js';
import { refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import {
  openVaultKeysOffer, rosterWithVaultKeys, sealVaultKeysOffer, signVaultKeys, vaultKeyIndexOf, vaultKeysOfferRefusal,
  type VaultKey, type VaultKeysOffer,
} from '../../../src/core/vault-keys.js';
import type { Account, PendingSignerPayload, SealedAccount } from '../../../src/core/types.js';
import { signCompanyFiling, toCompanyWire, verifiedCompanyFiler, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../../../src/midnight/record-manifest.js';
import type { RecordsEntered } from './record-entered-here.js';
import { companyRecordKey, seatsWithAnotherRecordsKey } from '../../../src/midnight/seat-directory.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { refuseASeatWhoseFingerprintIsNotTheJoiners } from './invitation-on-device.js';
import {
  attestedIn, directoryHere, foundingRecordRefusalHere, judgeIn, newerNamedRefusal, passedOverSaid, type DirectoryHereDeps,
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
    /* Only a seat whose entry this device opened and believed carries a wallet key to witness with. */
    directory: read.dir.seats.flatMap((x) => (x.committeeKey === undefined ? [] : [{ seat: x.seat, signingKey: x.signingKey, committeeKey: x.committeeKey }])),
    own: d.own ?? null,
  };
  const { believed, refused } = believedSigners(opened.signers, witnesses);
  const here = { ...read, another: seatsWithAnotherRecordsKey(read.dir, d.label, read.holders.account, attestedIn({ signers: believed })) };
  const why = roster.version === 1 ? firstRosterRefusal(here, roster, d.accountId, d.own ?? null)
    : judgeIn(here)(verifiedCompanyFiler(roster), 'roster', companyRecordKey('roster', ROSTER_ID), companyRecordEntry(roster), true);
  if (why !== null) throw new RosterNotBelieved(`This device does not believe the company's roster it was given (${why}).`);
  /* Every seat the chain holds is in the roster, or waited for by someone the company invited to it. */
  const waited = seatsWaitedFor(sealed, viewingKey);
  const missing = [...new Set(read.holders.seats.map((x) => x.toLowerCase()))].filter((seat) => !waited.has(seat)
    && !opened.signers.some((x) => x.status === 'active' && (x.leafCommitment ?? '').toLowerCase() === seat));
  if (missing.length > 0) {
    const over = passedOverSaid(read);
    throw new RosterNotBelieved(`This device does not believe the company's roster it was given (it has no entry for `
      + `${missing.length} seat(s) the company's account holds on the chain, so it leaves a signer out). Nothing is `
      + `built from it. ${over === null ? 'Ask a signer of the company to open it on their own device.' : `The way past it: ${over}.`}`);
  }
  return {
    account: { ...opened, signers: believed, notBelieved: seatsNotBelieved(believed, read.holders.seats) },
    opened, version: roster.version, refused, witnesses,
  };
}

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
  const { sealed, opened, version, witnesses } = await rosterHere(d);
  /* Every entry as it was filed, believed here or not: a fold changes only the entries of the offers it takes. */
  let roster = seatedOf(opened);
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
  const { filing, entry } = nextFiling(d, sealed.keyEpoch, roster, version);
  await d.api(route(d.accountId, '/roster'), { method: 'POST', body: JSON.stringify({ ...filing, folded }) });
  await d.entered.enter([entry]);
  return { folded, refused };
}
