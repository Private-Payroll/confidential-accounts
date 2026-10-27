/**
 * **ONE PERSON INVITED AND SEATED, FOLLOWED FROM THE DEVICES TO THE CHAIN, THE
 * DIRECTORY, THE ROSTER AND THE ANCHOR.** Ada's device invites Dee, signing the
 * invitation with Ada's seat; Dee's device accepts it, sealing her keys and
 * the opening of her leaf to the company's inbox; Ada's device holds the
 * request to the invitation and raises the proposal to seat her, carrying the
 * invitation with her leaf; Bo's device approves it, which reaches the seat
 * bar, carries it out and admits her to the roster. Dee's own device then
 * files her directory entry with the invitation the proposal carried, every
 * member's device believes it at the invitation's role, and the company's
 * records are anchored with it and still open from every device, Dee's own
 * among them.
 *
 * Over real HTTP: the page's own device functions and the service's own
 * invitation, directory, records, roster and proposal routes, with the company
 * and its stand-ins as `a-company-whose-signers-change-on-the-chain` names
 * them. Two probes put a request and an entry before the devices that a link
 * holder who is not the person invited could make: each must be refused. Each
 * assertion names the step whose loss turns it red.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import type { Hex } from '../core/crypto.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation } from '../core/invitation.js';
import { openFromInbox } from '../core/sealed-records.js';
import type { PendingSignerPayload } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { directoryEntryMade } from '../midnight/seat-directory.js';
import { leafOfTheContract, leavesOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';
import { anAddress } from '../testing/an-invitee.js';
import { newSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { acceptAsSignerHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { seatSignerOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { fileTheOwedDirectoryEntry, type OwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { admitSignerHere, foldOffersHere, offerVaultKeysHere, refuseASeatNotForTheInvited, rosterHere, seatingOf } from 'vaults-web-shared/roster-here.js';
import { recordsEnteredFor, manifestServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { ACME, aRecordFiledBy, ORIGIN, fromAda } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, anchorDoorsOf, api, BO, CO, committeeKeyOfLeaf, companyNow, deviceOf, directoryOf, events, KEY, LABEL,
  recordsReadBy, rosterDoorsOf, seatsOnTheChain, sendAs, store, theInviteeTakesTheSeatHere, walletOf, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

/** Dee's wallet, and the key it gives for the company: the key her seat's leaf commits to. */
const DEES_WALLET = identityFromSecret(new Uint8Array(32).fill(4));
const DEES_KEY = committeeKeyFor(DEES_WALLET, LABEL) as { tag: string; value: string };
/** The company key Dee's wallet releases, which her records key is made from. */
const DEES_COMPANY_KEY = new Uint8Array(32).fill(104);

/** The signers `s`'s device believes are seated, as its roster reads them. */
const activeIn = async (s: Seat): Promise<string[]> =>
  (await rosterHere(rosterDoorsOf(s))).account.signers.filter((x) => x.status === 'active').map((x) => x.name);
/** A seat's device, with the roster it reads and admits through. */
const seatingDevice = (s: Seat) => ({ ...deviceOf(s), roster: rosterDoorsOf(s) });

describe('A PERSON INVITED AND SEATED FROM THE SIGNERS\' OWN DEVICES, TRACED TO THE CHAIN AND THE ANCHOR', () => {
  it('DEE IS SEATED ON THE CHAIN, ADMITTED TO THE ROSTER, FILES HER OWN ENTRY WITH HER INVITATION, AND EVERY DEVICE BELIEVES HER AND OPENS EVERY BATCH', async () => {
    /* Ada's device invites Dee, its seat signing who the seat is for; Dee's device accepts under her own sign-in and wallet. */
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => DEES_KEY);
    const dee = kept[0]!;
    const leaf = leafOfTheContract(dee.opening!)!;
    committeeKeyOfLeaf.set(leaf, DEES_KEY);
    const signerId = accepted.signerId!;

    /* Probe: the same request with the opening of another wallet's leaf, as a link holder who is not Dee could seal it. */
    const sealed = store.getAccount(CO)!;
    const box = sealed.pendingSigners.find((p) => p.id === signerId)!;
    const payload = openFromInbox<PendingSignerPayload>(box.sealed, CO, KEY);
    const seating = seatingOf(await rosterHere(rosterDoorsOf(ADA)), { leaves: leavesOfTheContract });
    await expect(refuseASeatNotForTheInvited(sealed, KEY, box, payload, seating)).resolves.toBeUndefined();
    const another = seatOpenedFor({ tag: 'schnorr', value: '5e'.repeat(32) }, 7).opening;
    /* RED WHEN: an approving device approves a leaf whose opening does not prove it for the wallet the request names. */
    await expect(refuseASeatNotForTheInvited(sealed, KEY, box, { ...payload, opening: another }, seating))
      .rejects.toThrow(/not made for the wallet it names/u);

    /*
     * Ada's device raises the proposal to invite Dee's address, which is her approval; Bo's device approves it. Dee's own
     * wallet then takes the seat, and Bo's device admits her.
     */
    const at = anAddress(MidnightCommitments, 41);
    const invite = { address: at.address, salt: at.addressSalt, scope: MidnightCommitments.allVaults() };
    const raised = await seatSignerOnDevice(seatingDevice(ADA), { viewingKey: KEY, signerId, readOut: accepted.fingerprint, invite });
    expect(raised.state).toBe('waiting-for-approvals');
    /* RED WHEN: the approved proposal is carried out by a signer's device, and not left for the person invited. */
    expect((await seatSignerOnDevice(seatingDevice(BO), { viewingKey: KEY, signerId, readOut: accepted.fingerprint, invite })).state)
      .toBe('waiting-for-the-invitee');
    theInviteeTakesTheSeatHere(raised.round!.chainId, invite.address, leaf);
    /* RED WHEN: she is not admitted once the chain holds her seat. */
    await admitSignerHere(rosterDoorsOf(BO), { signerId, readOut: accepted.fingerprint });
    expect(events).toEqual(['chain propose', 'chain approve', `chain seatInvited ${leaf}`]);
    expect(seatsOnTheChain()).toContain(leaf);
    /* RED WHEN: the person seated on the chain is not admitted to the roster. */
    expect(companyNow().signers.find((x) => x.name === 'dee')?.status).toBe('active');
    /* Admitted, and not yet believed. RED WHEN: a roster entry's wallet is believed before the seat's own directory entry proves it. */
    expect(await activeIn(BO)).not.toContain('dee');

    /* Probe: an entry for Dee's seat, under her own wallet, carrying an invitation that names somebody else, filed first. */
    const statement = signDirectoryEntry(DEES_WALLET, LABEL, ADDRESS, DEES_COMPANY_KEY, dee.signingPublicKey, leaf);
    const forSomebodyElse = signSeatInvitation({
      company: CO, invitation: invitationIdOf(newInvitationToken()), person: 'mallory', name: 'dee', role: 'approver', leaf: leaf as Hex,
    }, ADA.signingSecret as Hex);
    const wrong = directoryEntryMade({
      company: CO, person: 'dee', committeeKey: DEES_KEY, signed: statement, opening: dee.opening!, signingSecret: dee.signingSecret, viewingKey: KEY,
      invited: forSomebodyElse,
    });
    const probe = store.directoryFilingsOf(CO).length + 1;
    expect((await sendAs('dee')(`/api/accounts/${CO}/directory/${probe}`, { method: 'POST', body: JSON.stringify({ company: CO, version: probe, change: { kind: 'claim', entry: wrong } }) })).status).toBe(201);

    /* Dee's own device files her entry, with the invitation it reads from the proposal that seated her. */
    let owed: OwedDirectoryEntry | null = { person: 'dee', company: LABEL, signed: { committeeKey: DEES_KEY as never, entry: statement }, opening: dee.opening! };
    const filed = await fileTheOwedDirectoryEntry(api('dee'), CO, { read: () => owed, settle: async () => { owed = null; } },
      async () => ({ signingSecret: dee.signingSecret, viewingKey: KEY }), async () => ADA.seat);
    /* RED WHEN: the proposal that seated her does not carry her invitation with her leaf, so her entry waits for it for good. */
    expect(filed).toBe('filed');
    const own = store.directoryFilingsOf(CO).length;
    expect(own).toBe(probe + 1);

    /* Every member's device believes her own entry at the invitation's role, and no device believes the probe's. */
    for (const s of [ADA, BO]) {
      const here = await directoryOf(s)();
      /* RED WHEN: an entry is believed with an invitation that names another person than the entry's. */
      expect(here.dir.seats.find((x) => x.seat === leaf), s.person).toMatchObject({ person: 'dee', role: 'approver', retired: null });
      expect([...(here.refusedAt ?? [])], s.person).toEqual([probe]);
    }
    /* RED WHEN: the roster does not believe the person seated once her own entry proves her wallet. */
    expect(await activeIn(BO)).toContain('dee');

    /* Dee gives her vault keys from her own device and Ada's device folds them into the roster: her wallet's statement is read from it. */
    const deeAsASeat = {
      person: 'dee', n: 4, seat: leaf, signingSecret: dee.signingSecret, entered: recordsEnteredFor(manifestServiceFor(api('dee')), CO, dee.signingSecret),
    } as unknown as Seat;
    await offerVaultKeysHere(api('dee'), CO, {
      signerId, signingSecret: dee.signingSecret, committeeKey: DEES_KEY as never, ...walletOf(deeAsASeat), entry: statement, viewingKey: KEY,
    });
    expect(await foldOffersHere(rosterDoorsOf(ADA))).toEqual({ folded: [leaf], refused: [] });

    /* Ada's device anchors Dee's entry; Dee files a record and it is anchored after it. */
    events.length = 0;
    expect((await anchorTheRecordsHere(anchorDoorsOf(ADA))).anchored).toBeGreaterThan(0);
    const deesRecord = await aRecordFiledBy(deeAsASeat, 'prp_filed_by_dee', 'proposal');
    await deeAsASeat.entered.enter([deesRecord]);
    expect((await anchorTheRecordsHere(anchorDoorsOf(ADA))).anchored).toBeGreaterThan(0);
    expect(events).toEqual(['anchored', 'anchored']);

    /* The company's records, checked from their first header on every device, Dee's own among them: every batch opens. */
    for (const s of [ADA, BO, deeAsASeat]) {
      /* RED WHEN: the joiner's entry is not anchored with the company's records, or a batch after it does not open. */
      expect(await directoryOf(s)().then((h) => h.records.directory.has(own), (e: Error) => e.message), s.person).toBe(true);
      const read = await recordsReadBy(s, { records: [{ store: 'company', kind: 'proposal', id: 'prp_filed_by_dee' }] });
      expect(read.records.stopped, s.person).toBeNull();
      expect(read.records.history.get('company:proposal:prp_filed_by_dee')?.map((v) => v.version), s.person).toEqual([1]);
    }
  }, 170_000);
});
