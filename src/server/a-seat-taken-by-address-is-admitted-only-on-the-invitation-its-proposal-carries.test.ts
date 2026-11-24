/**
 * A seat taken by address is admitted only on the invitation its approved proposal carries: a request naming another person,
 * a second record under the proposal's id that no device believes, a request filed under a seated signer's id, and a chain
 * that could not be read for the seat taken. The proposal's id is made under the salt its invitation makes, so another
 * invitation filed under that id is never believed beside it, and a proposal raised under any other salt is refused.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { invitationIdOf, invitationProposalSalt, seatByAddressChangeOf, signSeatInvitation, type SeatByAddressChange, seatInvitationRefusal } from '../core/invitation.js';
import { newSeatInvitation, SeatKeyNotFromTheInvitee } from '../core/seat-invite-proof.js';
import { sealingWith } from '../core/company-key.js';
import type { SealedProposal } from '../core/types.js';
import { proposalEntry } from '../midnight/record-manifest.js';
import { approveSeatInvitationOnDevice, raiseSeatInvitationOnDevice } from 'vaults-web-shared/seat-invited-on-device.js';
import { rosterHere, seatingOf, WaitingIdTaken, waitingHere } from 'vaults-web-shared/roster-here.js';
import { admitSignerHere } from 'vaults-web-shared/roster-filed-here.js';
import { SeatNotReadOnTheChain } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import { ReadRanOutOfTime } from 'vaults-web-shared/read-bound.js';
import { acmeReads, fromAda, store } from './a-company-of-two-seats.test-support.js';
import { aCompanyWhoseSignersChange, ADA, BO, CO, companyNow, CY, events, ID, KEY, rosterDoorsOf, type Seat } from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { scopeOfRole } from '../core/seat-rights.js';
import { addressOf, coinKeyAt, inviteAddressOf, seatingDevice, withCommitments, EVE, HAL, IVY, JO, KIT, PAT, ROY, VAL, WES, invited, seatTaken, signedAgain, secondRecordFor, seated } from './a-signer-invited-by-address.test-support.js';
aCompanyWhoseSignersChange();

describe('A SEAT TAKEN BY ADDRESS IS ADMITTED ONLY ON THE INVITATION ITS PROPOSAL CARRIES', () => {
  let eve: Awaited<ReturnType<typeof invited>>;

  beforeAll(async () => {
    eve = await seated(EVE);
  }, 120_000);

  it('RED WHEN: a seat taken by address is admitted on an invitation other than the one the approved proposal carries, naming a person nobody approved', { timeout: 120_000 }, async () => {
    const hal = await invited(HAL);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: hal.shown }, inviteAddressOf);
    /* Ada's seat signs a second invitation for the same proposal, address, role and rights, naming another person, with a seat secret made for that name, and Hal's request carries it. */
    const renamed = signSeatInvitation({ ...hal.offer.invited.terms, name: 'mallory' }, ADA.signingSecret as Hex);
    const seat = newSeatInvitation(sealingWith(KEY, 0).key, CO, 'mallory', 'approver', renamed.terms.invitation);
    const forged = { ...hal, offer: { ...hal.offer, name: 'mallory', invited: renamed, seat: { nonce: seat.nonce, secret: seat.secret } } };
    const signerId = await seatTaken(HAL, forged, { sealed: { name: 'mallory' } });
    await expect(admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: 'mallory' }))
      .rejects.toThrow(/not the invitation the proposal its seat was approved on carries/u);
    expect(companyNow().signers.find((x) => x.name === 'mallory')?.status).not.toBe('active');
  });

  it('RED WHEN: a record under the approved proposal\'s id, filed and signed by a key that is no seat, stops a seat the approvers approved from being admitted', { timeout: 120_000 }, async () => {
    const ivy = await invited(IVY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: ivy.shown }, inviteAddressOf);
    const signerId = await seatTaken(IVY, ivy);
    /* The service serves a second record under the same id on the network, its invitation naming another person, filed and signed by a key of nobody's. */
    const { rec, filing } = await secondRecordFor(ivy, 'mallory', toHex(new Uint8Array(32).fill(9)) as Hex, 'prp_decoydecoyde');
    store.putProposal({ ...rec, ...filing, id: 'prp_decoydecoyde', status: 'executed' } as never);
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: IVY.name });
    expect(companyNow().signers.find((x) => x.name === IVY.name)).toMatchObject({ status: 'active' });
  });

  it('a proposal is approved as shown though a seat that may invite files another invitation under its id on the network, which no device believes', { timeout: 120_000 }, async () => {
    const jo = await invited(JO);
    const { rec, filing } = await secondRecordFor(jo, 'mallory', ADA.signingSecret as Hex, 'prp_secondrecord');
    store.putProposal({ ...rec, ...filing, id: 'prp_secondrecord' } as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    const bo = seatingDevice(BO);
    /* A device that took every invitation as making the id it names would believe both records. */
    const takesAny = { ...bo, builder: { ...bo.builder, proposalIdentity: async (change: SeatByAddressChange, salt: string) => ({
      ...(await bo.builder.proposalIdentity!(change, salt)), chainId: String(jo.proposal.chainId).toLowerCase() }) } };
    const before = events.length;
    /* RED WHEN: two records the device believes under one id carry different invitations, and the approval is still sent. */
    await expect(approveSeatInvitationOnDevice(takesAny, { viewingKey: KEY, shown: jo.shown }, inviteAddressOf))
      .rejects.toThrow(/Another proposal the company holds under the same id on the network carries another invitation/u);
    expect(events.slice(before)).toEqual([]);
    /* RED WHEN: a record whose invitation does not make the id it is filed under is believed beside the approved one, so the approval is refused for good. */
    const done = await approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: jo.shown }, inviteAddressOf);
    expect(done.state).toBe('waiting-for-the-invitee');
    expect(events.slice(before)).toEqual(['chain approve']);
  });

  it('a seat is admitted with the role the approvers approved though, after the network seated it, a seat that may invite files another invitation under its id', { timeout: 120_000 }, async () => {
    const kit = await invited(KIT);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: kit.shown }, inviteAddressOf);
    const signerId = await seatTaken(KIT, kit);
    /* After the network seated Kit, Ada's seat files a second record under the same id, its invitation naming another person. */
    const { rec, filing } = await secondRecordFor(kit, 'mallory', ADA.signingSecret as Hex, 'prp_secondrecor2');
    store.putProposal({ ...rec, ...filing, id: 'prp_secondrecor2', status: 'executed' } as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    const doors = withCommitments(ADA);
    const takesAny = { ...doors, reads: { ...doors.reads, proposalIdentity: async (change: SeatByAddressChange, salt: string) => ({
      ...(await acmeReads.proposalIdentity(change, salt)), chainId: String(kit.proposal.chainId).toLowerCase() }) } };
    /* RED WHEN: two invitations believed under the seated id are told apart by a choice, and the person is seated with one of them. */
    await expect(admitSignerHere(takesAny, { signerId, readOut: '', name: KIT.name }))
      .rejects.toThrow(/Two proposals this device believes, each filed and signed by a seat that may invite, carry different invitations/u);
    expect(companyNow().signers.find((x) => x.name === KIT.name)?.status).not.toBe('active');
    /* RED WHEN: a record filed after the seat, whose invitation does not make the seated id, is believed, so the person is never admitted. */
    await admitSignerHere(doors, { signerId, readOut: '', name: KIT.name });
    expect(companyNow().signers.find((x) => x.name === KIT.name)).toMatchObject({ status: 'active' });
  });

  it('RED WHEN: a proposal to seat an address is raised under a salt the inviting seat chose, so its id commits to the address and rights and not to the person and role', { timeout: 120_000 }, async () => {
    const ada = seatingDevice(ADA);
    const { proposal: _id, ...terms } = eve.offer.invited.terms;
    const salt = toHex(new Uint8Array(32).fill(0x5e)) as Hex;
    const { chainId } = await ada.builder.proposalIdentity!(seatByAddressChangeOf(terms.invite!), salt);
    const chosen = signSeatInvitation({ ...terms, invitation: invitationIdOf(toHex(new Uint8Array(32).fill(0x5f)) as Hex), proposal: chainId as Hex }, ADA.signingSecret as Hex);
    /* RED WHEN: the salt leaves out the threshold, the rights or the address, so another invitation naming them differently makes the same proposal. */
    const signedBy = eve.offer.invited.signedBy;
    for (const invite of [{ ...terms.invite!, threshold: '3' }, { ...terms.invite!, scope: '5d'.repeat(32) as Hex }, { ...terms.invite!, address: '5e'.repeat(32) as Hex }]) {
      expect(invitationProposalSalt({ terms: { ...terms, invite }, signedBy })).not.toBe(invitationProposalSalt({ terms, signedBy }));
    }
    /* RED WHEN: the salt leaves out the key that signed the invitation, so any seat that may invite can make the same proposal. */
    expect(invitationProposalSalt({ terms, signedBy: '5f'.repeat(32) as Hex })).not.toBe(invitationProposalSalt({ terms, signedBy }));
    const before = events.length;
    await expect(raiseSeatInvitationOnDevice(ada, {
      viewingKey: KEY, invited: chosen, proposalSalt: salt, name: EVE.name, coinPublicKey: coinKeyAt(addressOf(EVE.fill)),
    }, inviteAddressOf)).rejects.toThrow(/salt this proposal is raised under is not the one its invitation makes/u);
    /* RED WHEN: an invitation raised under its own salt is raised though it names another proposal than its change and that salt make. */
    const misnamed = signSeatInvitation({ ...eve.offer.invited.terms, proposal: 'ab'.repeat(32) as Hex }, ADA.signingSecret as Hex);
    await expect(raiseSeatInvitationOnDevice(ada, {
      viewingKey: KEY, invited: misnamed, proposalSalt: eve.offer.byAddress!.proposalSalt, name: EVE.name, coinPublicKey: coinKeyAt(addressOf(EVE.fill)),
    }, inviteAddressOf)).rejects.toThrow(/not the one its address, rights, threshold and salt make/u);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: an invitation by address taken up again raises another seat\'s record for the same address and rights, naming another person, in place of its own', { timeout: 120_000 }, async () => {
    const coin = coinKeyAt(addressOf(VAL.fill));
    const addressSalt = toHex(new Uint8Array(32).fill(0x6a)) as Hex;
    const invite = { address: inviteAddressOf(coin, addressSalt).toLowerCase() as Hex, salt: addressSalt, scope: scopeOfRole('approver') };
    const made = async (s: Seat, name: string, fill: number) => {
      const terms = { company: CO, invitation: invitationIdOf(toHex(new Uint8Array(32).fill(fill)) as Hex), person: `adr_${fill}`, name, role: 'approver' as const, invite };
      const proposalSalt = invitationProposalSalt({ terms, signedBy: signingPublicKeyOf(s.signingSecret as Hex) });
      const { chainId } = await seatingDevice(s).builder.proposalIdentity!(seatByAddressChangeOf(invite), proposalSalt);
      return { invited: signSeatInvitation({ ...terms, proposal: String(chainId).toLowerCase() as Hex }, s.signingSecret as Hex), proposalSalt };
    };
    /* `s`'s device makes its filing, and the connection drops before the service is reached; the filing is handed back. */
    const filedNotRaised = async (s: Seat, x: Awaited<ReturnType<typeof made>>): Promise<{ id: string }> => {
      const device = seatingDevice(s);
      let filed: { id: string } | null = null;
      const dropped = { ...device, service: { ...device.service, file: async (_account: string, body: { proposal: { id: string } }) => {
        filed = body.proposal;
        throw new Error('the connection dropped');
      } } };
      await expect(raiseSeatInvitationOnDevice(dropped as never, { viewingKey: KEY, ...x, name: VAL.name, coinPublicKey: coin }, inviteAddressOf))
        .rejects.toThrow(/connection dropped/u);
      return filed!;
    };
    const adas = await made(ADA, VAL.name, 0x71);
    const first = await filedNotRaised(ADA, adas);
    expect((await fromAda(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify({ proposal: first, salt: adas.proposalSalt }) })).status).toBe(200);
    const held = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === first.id)!;
    /* Another seat's filing of its own invitation for the same address and rights, naming another person, is served beside Ada's, never raised. */
    const bos = await made(BO, 'mallory', 0x72);
    const other = await filedNotRaised(BO, bos);
    store.putProposal({ ...held, ...other, status: 'open' } as never);
    await BO.entered.enter([proposalEntry(CO, other as never)]);
    const done = await raiseSeatInvitationOnDevice(seatingDevice(ADA), { viewingKey: KEY, ...adas, name: VAL.name, coinPublicKey: coin }, inviteAddressOf);
    expect(String(done.round?.chainId).toLowerCase()).toBe(adas.invited.terms.proposal);
  });

  it('a proposal is approved and its seat admitted though the same invitation is filed again under its id with another signature', { timeout: 120_000 }, async () => {
    const wes = await invited(WES);
    const again = await secondRecordFor(wes, WES.name, ADA.signingSecret as Hex, 'prp_signedagain1', { signedAgain: true });
    store.putProposal({ ...again.rec, ...again.filing, id: 'prp_signedagain1' } as never);
    await ADA.entered.enter([proposalEntry(CO, again.filing as never)]);
    const before = events.length;
    /* RED WHEN: two records whose invitations differ only in their signature are told apart, so every approver is refused for good. */
    const done = await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: wes.shown }, inviteAddressOf);
    expect([done.state, events.slice(before)]).toEqual(['waiting-for-the-invitee', ['chain approve']]);
    const signerId = await seatTaken(WES, wes);
    const late = await secondRecordFor(wes, WES.name, ADA.signingSecret as Hex, 'prp_signedagain2', { signedAgain: true });
    store.putProposal({ ...late.rec, ...late.filing, id: 'prp_signedagain2', status: 'executed' } as never);
    await ADA.entered.enter([proposalEntry(CO, late.filing as never)]);
    /* RED WHEN: a copy of the approved invitation signed again, filed after the seat, stops the person from ever being admitted. */
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: WES.name });
    expect(companyNow().signers.find((x) => x.name === WES.name)).toMatchObject({ status: 'active' });
  });

  it('a seat invitation signed again over the same terms is another valid signature', () => {
    const copy = signedAgain(eve.offer.invited, ADA.signingSecret as Hex);
    expect([seatInvitationRefusal(copy), copy.signature === eve.offer.invited.signature]).toEqual([null, false]);
  });

  it('RED WHEN: a request the service names with a seated signer\'s id is filed as that signer at the joiner\'s seat, and every device then refuses the roster', { timeout: 120_000 }, async () => {
    const pat = await invited(PAT);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: pat.shown }, inviteAddressOf);
    const own = await seatTaken(PAT, pat);
    const seated = ID[CY.person]!;
    /* The service answers the request under Cy's id, as only the service chooses the id a person waits under. */
    const named = (from: string, to: string): void => {
      const rec = store.getAccount(CO)!;
      store.putAccount({ ...rec, pendingSigners: rec.pendingSigners.map((p) => (p.id === from ? { ...p, id: to } : p)) });
    };
    named(own, seated);
    const before = (await rosterHere(rosterDoorsOf(ADA))).version;
    const refused = await admitSignerHere(withCommitments(ADA), { signerId: seated, readOut: '', name: PAT.name }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WaitingIdTaken);
    /* RED WHEN: a roster is filed under an id another entry carries, so Cy's keys sit at Pat's seat and no device can read the roster again. */
    expect((await rosterHere(rosterDoorsOf(ADA))).version).toBe(before);
    expect(companyNow().signers.filter((x) => x.id === seated && x.status === 'active').map((x) => x.leafCommitment?.toLowerCase())).toEqual([CY.seat.toLowerCase()]);
    /* Under the id the service first gave it, the same request is admitted. */
    named(seated, own);
    await admitSignerHere(withCommitments(ADA), { signerId: own, readOut: '', name: PAT.name });
    expect(companyNow().signers.find((x) => x.name === PAT.name)?.status).toBe('active');
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('RED WHEN: a chain that could not be read for the seat an invitation by address took is told as another seat, and the person is refused for good', { timeout: 120_000 }, async () => {
    const roy = await invited(ROY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: roy.shown }, inviteAddressOf);
    const signerId = await seatTaken(ROY, roy);
    const read = await rosterHere(rosterDoorsOf(BO));
    const seating = seatingOf(read, rosterDoorsOf(BO).reads);
    const waitingWith = (invitedSeats: (proposals: readonly string[]) => Promise<Readonly<Record<string, string | null>>>) =>
      waitingHere(read.sealed, read.account, KEY, signerId, '', { ...seating, invitedSeats }).catch((e: unknown) => e);
    for (const unread of [
      async () => { throw new ReadRanOutOfTime('The network (invited-seats)'); },
      async () => { throw new Error('the indexer refused the query'); },
      /* What a device whose wallet names no indexer answers: nothing, for any proposal. */
      async () => ({}),
    ]) {
      const e = await waitingWith(unread);
      expect(e).toBeInstanceOf(SeatNotReadOnTheChain);
      expect(e).not.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    }
    /* RED WHEN: a chain that shows the proposal took another seat is told as a chain not read, and the person is asked to press again for a seat that is not theirs. */
    expect(await waitingWith(async (proposals) => Object.fromEntries(proposals.map((x) => [x, '5d'.repeat(32)])))).toBeInstanceOf(SeatKeyNotFromTheInvitee);
    /* Read again, the same request is admitted. */
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: ROY.name });
    expect(companyNow().signers.find((x) => x.name === ROY.name)?.status).toBe('active');
  });
});
