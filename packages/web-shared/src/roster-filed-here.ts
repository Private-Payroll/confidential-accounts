/**
 * **THE COMPANY'S ROSTER, CHANGED AND FILED FROM THIS SEAT'S OWN DEVICE.**
 *
 * A person waiting for a seat is admitted once the chain holds their seat, a new
 * signer offers their vault keys, and every open offer is folded into the roster
 * by a seat already believed. Each change is checked here against the roster
 * this device reads (`rosterHere`) before the next version is signed and filed.
 */

import { sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import type { DirectoryEntryStatement, RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import { fromHex, signingPublicKeyOf, wrapKey, type Hex } from '../../../src/core/crypto.js';
import { SEAT_MAY_NOT_FILE_THE_ROSTER, retiredSeatStillNamed, ROSTER_ENTRY_REFUSAL, rosterEntryRefusal, sealRoster, type DirectoryWitness, type RosterSecrets } from '../../../src/core/roster-record.js';
import { SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import type { SignedSeatInvitation } from '../../../src/core/invitation.js';
import { vaultKeysOfferOpened } from './vault-keys-offer-opened.js';
import { rosterServiceOf, type RosterViewHeld } from './roster-through-the-view.js';
import { rosterWithVaultKeys, sealVaultKeysOffer, signVaultKeys, vaultKeyIndexOf, type VaultKey, type VaultKeysOffer } from '../../../src/core/vault-keys.js';
import type { Account, SealedProposal } from '../../../src/core/types.js';
import { toCompanyWire } from '../../../src/midnight/sealed-record-wire.js';
import { companyRecordEntry, signedWithItsEntry } from '../../../src/midnight/record-manifest.js';
import { seatsWithAnotherRecordsKey } from '../../../src/midnight/seat-directory.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { attestedIn, directoryHere, kindAsked } from './vault-page-doors.js';
import { RosterNotFiled, WaitingIdTaken, believedSeatingsUnder, filerRefusedHere, madeByAddress, notTheInvited, rosterHere, sameInvitation, seatingOf, waitingHere, waitingIdTakenIn, withTheFoundingFirst, type RosterDoors, type RosterReadHeld } from './roster-here.js';

/**
 * **THE VERSION THAT FOLLOWS ONE EVERY DEVICE REFUSES, OR ONE THAT STILL SEATS A
 * SIGNER WHO LEFT, FILED FROM HERE**: the entries `rosterHere` carries, filed above
 * every version served, and entered in the company's records. A believed version
 * is followed too while it holds an active entry for a seat an anchored retirement
 * retired and the chain no longer holds (`retiredSeatStillNamed`): the carried
 * entries leave that seat out, so the vault-key index filed with them counts only
 * the seats that stay. Returns the version filed; null, with nothing filed, when
 * the newest version is believed and seats nobody who left, or when this seat may
 * not file a roster (`filingRefusalOf`): a version it filed would be refused in turn.
 */
export async function fileTheRosterFollowedHere(d: RosterDoors): Promise<number | null> {
  const read = await rosterHere(d);
  if (read.followed === null && !retiredSeatStillNamed(read.opened.signers, read.witnesses)) return null;
  if (filerRefusedHere(read.held.here, signingPublicKeyOf(d.signingSecret), read.version + 1)) return null;
  const { filing, entry } = nextFiling(d, read.held.here, read.sealed.keyEpoch, seatedOf(read.carried), read.version);
  const entries = await withTheFoundingFirst(d, nothingAnchoredIn(read.held), entry);
  await rosterServiceOf(d).file({ to: 'roster', body: { ...filing, folded: [] } });
  await d.entered.enter(entries);
  return filing.roster.version;
}

/**
 * Whether this read found nothing of the company anchored. A read that stopped at a header it could not check counts
 * as anchored, so the roster goes in alone and the founding seat's device enters the founding records at its first
 * anchor, which it makes only while the chain shows nothing anchored.
 */
const nothingAnchoredIn = (held: RosterReadHeld): boolean => held.here.records.reached.seq < 0 && held.here.records.stopped === null;

/**
 * The roster's next version, sealed and signed here under the company's key in
 * force (refused while sealing is paused; a bare key seals at `keyEpoch`), with
 * the index of the company's vault keys made from it, and the entry the one
 * filing call makes of it once the service has kept it, and the sealing it
 * was made under. Refused before it is
 * signed when this device's seat may not file it (`filerRefusedHere`), judged
 * as every device reads that version, with the records keys its own entries
 * attest, since every device would refuse it in turn.
 */
const nextFiling = (
  d: RosterDoors, here: Awaited<ReturnType<typeof directoryHere>>, keyEpoch: number, next: RosterSecrets, version: number,
  sealing: { readonly key: Hex; readonly epoch: number } = sealingWith(d.viewingKey, keyEpoch),
) => {
  const asRead = { ...here, another: seatsWithAnotherRecordsKey(here.dir, d.label, here.holders.account, attestedIn(next)) };
  if (filerRefusedHere(asRead, signingPublicKeyOf(d.signingSecret), version + 1)) throw new RosterNotFiled(SEAT_MAY_NOT_FILE_THE_ROSTER);
  const rec = signedWithItsEntry(sealRoster(d.accountId, next, version + 1, sealing.epoch, sealing.key), d.signingSecret);
  return {
    filing: {
      roster: { version: version + 1, message: toCompanyWire(rec) },
      index: vaultKeyIndexOf({ id: d.accountId, signers: next.signers }),
    },
    entry: companyRecordEntry(rec), sealing,
  };
};

/** The active signers, as the roster lists them: those waiting for a seat are in the company's inbox, not here. */
const seatedOf = (account: Account): RosterSecrets => ({ name: account.name, signers: account.signers.filter((s) => s.status === 'active') });

/**
 * **THE COIN KEY OF THE ADDRESS A SEAT WAS INVITED AT**, from the company's proposal its invitation names: the one
 * coin key that makes the commitment the invitation names under the invitation's own salt (`inviteAddressOf`). The
 * invitation is the one a seat signed and the chain shows its proposal took this seat (`invitationRefusalHere`), so the
 * key is the seat's own wallet's, whatever the service serves beside it. Only the proposals under that id this device
 * believes count (`believedSeatingsUnder`, over the directory read with the records-key statements of the roster it
 * believes, `attestedIn`, each one whose invitation makes that id), and **ONE OF THEM MUST CARRY THE VERY SIGNED
 * INVITATION THE REQUEST CARRIES, AND NONE ANOTHER** (`sameInvitation`): the id commits to the whole invitation,
 * so the name and role a seat is admitted with are the ones the approvers opened and approved. A record the service
 * serves beside them, filed or signed by a key that is no seat that may invite, or carrying an invitation that does not
 * make that id, changes nothing. Refused when this device cannot make the commitment or the proposal's identity, no
 * believed proposal under that id carries the request's invitation, two believed ones carry different invitations, or
 * none carries a coin key that makes the commitment.
 */
const coinKeyOfTheSeatHere = async (
  d: RosterDoors, invited: SignedSeatInvitation, seats: readonly DirectoryWitness[], believed: Pick<Account, 'signers'>,
): Promise<Hex> => {
  const invite = invited.terms.invite!;
  const proposal = invited.terms.proposal!.toLowerCase();
  const identity = d.reads.proposalIdentity;
  if (d.commitments === undefined || identity === undefined) {
    throw new RosterNotFiled('This device cannot check the address this seat was invited at, so nobody was admitted and nothing was '
      + 'sent. Reload the page to get the current version.');
  }
  const [served, here] = await Promise.all([
    rosterServiceOf(d).proposals(),
    directoryHere({ accountId: d.accountId, label: d.label, viewingKey: d.viewingKey, ...d.reads, attested: async () => attestedIn(believed) }, kindAsked('proposal')),
  ]);
  const named = await believedSeatingsUnder(here, Array.isArray(served) ? served as SealedProposal[] : [], d.accountId, d.viewingKey, proposal, seats, identity, true);
  if (!named.some((x) => sameInvitation(x.invited, invited))) {
    throw notTheInvited('The invitation this seat request carries is not the invitation the proposal its seat was approved on carries, '
      + 'as this device believes the company\'s proposals, so it may name another person or role than the approvers approved, and '
      + 'nobody is seated from it.');
  }
  if (named.some((x) => !sameInvitation(x.invited, invited))) {
    throw notTheInvited('Two proposals this device believes, each filed and signed by a seat that may invite, carry different '
      + 'invitations under the id the network seated, so this device cannot tell which one the approvers approved, and nobody is '
      + 'seated from it. The seat this invitation took on the network must be removed by the company before this person is invited again.');
  }
  const found = new Set(named
    .filter((x) => x.coinPublicKey !== null
      && String(d.commitments!.inviteAddressOf(x.coinPublicKey, invite.salt.toLowerCase() as Hex)).toLowerCase() === invite.address.toLowerCase())
    .map((x) => x.coinPublicKey!));
  if (found.size !== 1) {
    throw notTheInvited('No proposal of the company\'s shows which wallet the address this seat was invited at belongs to, so '
      + 'nobody is seated from it, and no device could tell that wallet seated again.');
  }
  return [...found][0]!;
};

/**
 * **A PERSON SEATED ON THE CHAIN, ADMITTED.** Their request is checked again
 * here (`waitingHere`), the roster is filed with them in it, and the company's
 * key in force is wrapped to the key they gave. A seat taken by address is
 * admitted with nothing read out, because the chain shows the proposal its
 * invitation names took exactly that seat; its entry records the coin key of
 * the address it was invited at (`coinKeyOfTheSeatHere`), and it is refused
 * when its request carries another invitation than the proposal it was approved
 * on, so its name and role are the ones the approvers opened, or when another
 * entry already records that coin key, as one wallet holding two
 * seats would approve twice. A coin key on any other entry is never taken from
 * the request. `name`, when given, is the name the person was shown under, and
 * a request under another is refused. The entry filed is the request's own
 * waiting entry, and a request whose id the service also gave another entry of
 * the roster, seated or waiting, is refused before anything is signed
 * (`WaitingIdTaken`). Refused by the service until the chain holds their seat,
 * with nothing filed.
 */
export async function admitSignerHere(d: RosterDoors, input: { signerId: string; readOut: string; name?: string }): Promise<void> {
  const read = await rosterHere(d);
  const { sealed, opened, carried, version } = read;
  /* Held against the entries this device believes: one nobody believes holds no keys from anybody. */
  const seating = seatingOf(read, d.reads);
  const { payload } = await waitingHere(sealed, read.account, d.viewingKey, input.signerId, input.readOut, seating);
  if (input.name !== undefined && payload.name !== input.name) {
    throw new SeatKeyNotFromTheInvitee('The person waiting under this request is not the one shown, so nobody was admitted. Nothing was '
      + 'sent. Reload the page.');
  }
  /* Every entry of the roster as opened, believed or not: the id is the service's, and a seated entry under it is never filed as the joiner. */
  if (waitingIdTakenIn(opened.signers, input.signerId, payload.leafCommitment)) throw new WaitingIdTaken();
  const waiting = opened.signers.find((s) => s.id === input.signerId && s.status === 'pending');
  if (waiting === undefined) {
    throw new SeatKeyNotFromTheInvitee('That person is no longer waiting for a seat. Reload the page. Nothing was sent.');
  }
  const { coinPublicKey: _notTaken, ...pending } = waiting;
  /* The entries the next version carries (`carriedHere`): an admission changes nobody else's entry. */
  const seated = seatedOf(carried);
  /* The admission stands for its seat: another entry at the same leaf, which no device believes, is left out. */
  const leaf = payload.leafCommitment.toLowerCase();
  const coin = madeByAddress(payload.invited) ? await coinKeyOfTheSeatHere(d, payload.invited!, seating.seats, read.account) : undefined;
  if (coin !== undefined && seated.signers.some((s) => (s.coinPublicKey ?? '').toLowerCase() === coin && (s.leafCommitment ?? '').toLowerCase() !== leaf)) {
    throw notTheInvited('The wallet at the address this seat was invited at already holds a seat on this company, so nobody is seated from it.');
  }
  const next: RosterSecrets = {
    name: seated.name,
    signers: [
      ...seated.signers.filter((s) => (s.leafCommitment ?? '').toLowerCase() !== leaf),
      { ...pending, status: 'active', leafCommitment: payload.leafCommitment, ...(coin === undefined ? {} : { coinPublicKey: coin }) },
    ],
  };
  /* One sealing for the key handed to the person and the roster that seats them: both refused while sealing is paused. */
  const { filing, entry, sealing } = nextFiling(d, read.held.here, sealed.keyEpoch, next, version);
  const entries = await withTheFoundingFirst(d, nothingAnchoredIn(read.held), entry);
  await rosterServiceOf(d).file({
    to: 'admission', signer: input.signerId,
    body: { ...filing, leaf: payload.leafCommitment.toLowerCase(), wrap: wrapKey(sealing.key, payload.wrappingPublicKey) },
  });
  await d.entered.enter(entries);
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
  accountId: string,
  keys: {
    readonly signerId: string; readonly signingSecret: Hex; readonly companyKey: Hex; readonly committeeKey: VaultKey;
    readonly recordsKey: RecordsKeyStatement; readonly entry: DirectoryEntryStatement; readonly viewingKey: KeysHeld;
  },
  view: RosterViewHeld,
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
  const offer = sealVaultKeysOffer(accountId, { signerId: keys.signerId, entry: { committeeKey: keys.committeeKey, statement: keys.entry }, keys: signed },
    sealingWith(keys.viewingKey, 0).key);
  await rosterServiceOf({ accountId, view }).file({ to: 'vault-keys', body: { offer } });
}

/** What folding the open offers came to: the seats folded in, and each offer refused with why. */
export interface Folded {
  readonly folded: readonly string[];
  readonly refused: ReadonlyArray<{ readonly seat: string; readonly why: string }>;
}

/**
 * **EVERY OPEN OFFER OF VAULT KEYS, FOLDED INTO THE ROSTER FROM THIS DEVICE.**
 * Each is opened under the company's roster key (`vaultKeysOfferOpened`) and
 * checked against the roster this device opened (`rosterWithVaultKeys`):
 * signed for its signer's entry by the signing key that entry holds, and its
 * records-key statement verifying for the seat that entry holds. An offer is
 * folded only when the entry it makes is one this device believes. An offer that fails is left out, never folded, and stays
 * open. The roster is filed once, with the offers it took, which the service
 * lets go once the roster holds their keys. The service files it only for a
 * seat the company's directory believes.
 */
export async function foldOffersHere(d: RosterDoors): Promise<Folded> {
  const { offers } = await rosterServiceOf(d).offers() as { offers: VaultKeysOffer[] };
  if (offers.length === 0) return { folded: [], refused: [] };
  const { sealed, carried, version, witnesses, held } = await rosterHere(d);
  /* The entries the next version carries (`carriedHere`): a fold changes only the entries of the offers it takes. */
  let roster = seatedOf(carried);
  const folded: string[] = [];
  const refused: { seat: string; why: string }[] = [];
  for (const kept of offers) {
    const seat = String(kept?.seat ?? '').toLowerCase();
    try {
      /* An offer names no epoch: it is opened with each key held, newest first, and believed for its signatures and entry. */
      const offer = vaultKeysOfferOpened(d.accountId, kept, d.viewingKey, d.label, d.account);
      if (typeof offer === 'string') throw new Error(`the offer is refused: ${offer}.`);
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
  const { filing, entry } = nextFiling(d, held.here, sealed.keyEpoch, roster, version);
  const entries = await withTheFoundingFirst(d, nothingAnchoredIn(held), entry);
  await rosterServiceOf(d).file({ to: 'roster', body: { ...filing, folded } });
  await d.entered.enter(entries);
  return { folded, refused };
}
