/**
 * A signer invited by address, approved and admitted from another seat's device as those seats' wallets do it. Ada's
 * device invites Eve by her private address; Bo's device approves the proposal it opens itself, only when it invites
 * exactly what Bo was shown, and raises nothing; Eve's own wallet takes the seat; Ada's device, whose role may file the roster, admits her with nothing
 * read out, and her roster entry records the coin key of the address she was invited at, which every later version of
 * the roster keeps.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { canonical, parseCanonical, seal, sign, signingPublicKeyOf, unseal, type Hex } from '../core/crypto.js';
import { invitationProposalSalt, seatByAddressChangeOf, seatInvitationMessage, type SignedSeatInvitation } from '../core/invitation.js';
import { addSignerByAddressIn, signProposalFiling } from '../core/proposal-filing.js';
import { openRecord, sealRecord } from '../core/sealed-records.js';
import { keyOf } from '../core/company-key.js';
import type { SealedProposal } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { proposalEntry } from '../midnight/record-manifest.js';
import { governOnDevice, InvitationNotBound, InvitationOutrun } from 'vaults-web-shared/company-change-on-device.js';
import { NothingToApprove } from 'vaults-web-shared/proposal-approved-on-device.js';
import { approveSeatInvitationOnDevice } from 'vaults-web-shared/seat-invited-on-device.js';
import { addressSeatedOrInvitedRefusal } from 'vaults-web-shared/address-seated-or-invited.js';
import { rosterHere } from 'vaults-web-shared/roster-here.js';
import { admitSignerHere } from 'vaults-web-shared/roster-filed-here.js';
import { store } from './a-company-of-two-seats.test-support.js';
import { aCompanyWhoseSignersChange, ADA, BO, CO, companyNow, events, KEY, rosterDoorsOf } from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { addressOf, coinKeyAt, inviteAddressOf, seatingDevice, withCommitments, EVE, FAY, YUL, coinOf, invited, seatTaken } from './a-signer-invited-by-address.test-support.js';
aCompanyWhoseSignersChange();

const NED = { name: 'ned', fill: 82 };

describe('A SIGNER INVITED BY ADDRESS IS APPROVED AND ADMITTED FROM ANOTHER SEAT, AS IT WAS SHOWN', () => {
  let eve: Awaited<ReturnType<typeof invited>>;

  beforeAll(async () => {
    eve = await invited(EVE);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: eve.shown }, inviteAddressOf);
  }, 120_000);

  /** Eve's seat taken and admitted, unless an earlier case of this file already did. */
  const eveAdmitted = async (): Promise<void> => {
    if (coinOf(EVE.name) === undefined) await admitSignerHere(withCommitments(ADA), { signerId: await seatTaken(EVE, eve), readOut: '', name: EVE.name });
  };

  it('another seat approves the proposal only as it was shown, and raises nothing', { timeout: 120_000 }, async () => {
    const bo = seatingDevice(BO);
    const own = await invited(NED);
    const before = events.length;
    for (const changed of [
      { ...own.shown, name: 'mallory' }, { ...own.shown, address: '5a'.repeat(32) }, { ...own.shown, scope: '5b'.repeat(32) },
      { ...own.shown, coinPublicKey: coinKeyAt(addressOf(63)) }, { ...own.shown, role: 'admin' as const },
    ]) {
      /* RED WHEN: a proposal that invites another person, role, address, rights or wallet than the window showed is approved. */
      await expect(approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: changed }, inviteAddressOf)).rejects.toThrow(InvitationNotBound);
    }
    /* RED WHEN: a coin key that does not make the commitment the proposal's invitation names is approved. */
    await expect(approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: own.shown }, () => '00'.repeat(32) as Hex))
      .rejects.toThrow(/not the one its invitation's address commits to/u);
    expect(events.slice(before)).toEqual([]);
    /* RED WHEN: the inviting device raises the proposal under a salt of its own choosing, not the one the invitation makes. */
    expect(own.offer.byAddress!.proposalSalt).toBe(invitationProposalSalt(own.offer.invited));
    const done = await approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: own.shown }, inviteAddressOf);
    expect(done.state).toBe('waiting-for-the-invitee');
    /* RED WHEN: the approving device sends anything but its one approval, a raise among it. */
    expect(events.slice(before)).toEqual(['chain approve']);
  });

  it('RED WHEN: a device asked only to approve finds no proposal raised for the change, and raises one', async () => {
    const before = events.length;
    await expect(governOnDevice(seatingDevice(BO), {
      viewingKey: KEY, change: { kind: 'threshold', threshold: '2' }, summary: 'Require 2 approvals', body: { newThreshold: 2 }, approveOnly: '5c'.repeat(32),
    })).rejects.toThrow(NothingToApprove);
    await expect(approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: { ...eve.shown, proposal: 'prp_nonexistent0' } }, inviteAddressOf))
      .rejects.toThrow(InvitationNotBound);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: an invitation a removal outran on the chain is approved, though it can never seat anyone', { timeout: 120_000 }, async () => {
    const uma = await invited({ name: 'uma', fill: 77 });
    const bo = seatingDevice(BO);
    const chainId = String(uma.proposal.chainId).toLowerCase();
    const outran = {
      ...bo,
      records: {
        ...bo.records!,
        roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(Object.entries(await bo.records!.roundsOnChain!(ids))
          .map(([id, r]) => [id, id === chainId ? { ...r, outrun: true as const } : r])),
      },
    };
    const before = events.length;
    await expect(approveSeatInvitationOnDevice(outran as never, { viewingKey: KEY, shown: uma.shown }, inviteAddressOf)).rejects.toThrow(InvitationOutrun);
    expect(events.slice(before)).toEqual([]);
  });

  it('the seat taken by address is admitted with nothing read out, and its entry records the coin key it was invited at', async () => {
    const signerId = await seatTaken(EVE, eve);
    /* RED WHEN: a seat taken by address is admitted on a device that cannot hold its coin key to the address's commitment. */
    await expect(admitSignerHere(rosterDoorsOf(ADA), { signerId, readOut: '' })).rejects.toThrow(/cannot check the address/u);
    /* RED WHEN: a coin key that does not make the commitment the invitation names is recorded for the seat. */
    await expect(admitSignerHere({ ...rosterDoorsOf(ADA), commitments: { inviteAddressOf: () => '00'.repeat(32) as Hex } }, { signerId, readOut: '' }))
      .rejects.toThrow(/No proposal of the company's shows which wallet/u);
    /* RED WHEN: a request waiting under another name than the one shown is admitted. */
    await expect(admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: 'mallory' })).rejects.toThrow(/not the one shown/u);
    expect(companyNow().signers.find((x) => x.name === EVE.name)?.status).not.toBe('active');
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: EVE.name });
    /* RED WHEN: the admitted entry does not record the coin key of the address the seat was invited at. */
    expect(companyNow().signers.find((x) => x.name === EVE.name)).toMatchObject({ status: 'active', coinPublicKey: coinKeyAt(addressOf(EVE.fill)) });
    expect(addSignerByAddressIn(eve.proposal, CO, KEY)?.coinPublicKey).toBe(coinKeyAt(addressOf(EVE.fill)));
  });

  it('RED WHEN: a wallet the roster records as seated is invited or approved for a second seat, though the proposals say nothing of it', async () => {
    await eveAdmitted();
    const ada = seatingDevice(ADA);
    /* The chain shows no seat taken by any proposal asked about. */
    const reads = { ...ada.records, invitedSeats: async (asked: readonly string[]) => Object.fromEntries(asked.map((x) => [x, null])) };
    await expect(addressSeatedOrInvitedRefusal(reads, CO, KEY, inviteAddressOf, coinKeyAt(addressOf(EVE.fill)))).resolves.toBeNull();
    await expect(addressSeatedOrInvitedRefusal({ ...reads, seated: async () => [coinKeyAt(addressOf(EVE.fill))] }, CO, KEY, inviteAddressOf,
      coinKeyAt(addressOf(EVE.fill)))).resolves.toMatch(/that address already has a seat on this company/u);
  });

  it('RED WHEN: a proposal whose invitation gives an approver every right on every vault is approved on another seat\'s device', { timeout: 120_000 }, async () => {
    const yul = await invited(YUL);
    const rec = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === yul.proposal.id)!;
    const key = keyOf(KEY as never, rec.keyEpoch);
    const env = openRecord<{ sealedPayload: string }>('proposals', CO, rec.sealed, key);
    const body = parseCanonical<{ invited: SignedSeatInvitation; __change?: Record<string, unknown> }>(unseal(env.sealedPayload as never, key));
    /*
     * Ada's seat signs, as it is, an invitation naming the same approver at every right on every vault, which no device
     * of hers would sign, and files it under the proposal its address, those rights and its own salt make.
     */
    const signedBy = signingPublicKeyOf(ADA.signingSecret as Hex);
    const { proposal: _was, ...unbound } = { ...body.invited.terms, invite: { ...body.invited.terms.invite!, scope: MidnightCommitments.allVaults().toLowerCase() as Hex } };
    const salt = invitationProposalSalt({ terms: unbound, signedBy });
    const { chainId } = await seatingDevice(BO).builder.proposalIdentity!(seatByAddressChangeOf(unbound.invite), salt);
    const terms = { ...unbound, proposal: String(chainId).toLowerCase() as Hex };
    const everyRight = { terms, signedBy, signature: sign(seatInvitationMessage(terms), ADA.signingSecret as Hex) };
    const carried = { ...body, invited: everyRight, __change: { ...body.__change, salt } };
    const sealed = sealRecord('proposals', CO, { ...env, sealedPayload: seal(canonical(carried), key) }, key);
    const filing = signProposalFiling(CO, { id: 'prp_everyright01', digest: rec.digest, chainId: terms.proposal, keyEpoch: rec.keyEpoch, createdAt: rec.createdAt, sealed } as never,
      ADA.signingSecret as Hex);
    const forged = { ...rec, ...filing, id: 'prp_everyright01' };
    store.putProposal(forged as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    /* RED WHEN: the approving device opens the proposal as one inviting the seat, with rights the approver's role does not give. */
    expect(addSignerByAddressIn(forged as never, CO, KEY)).toBeNull();
    const before = events.length;
    await expect(approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: { ...yul.shown, proposal: 'prp_everyright01', scope: terms.invite.scope } }, inviteAddressOf))
      .rejects.toThrow(/carries an invitation this device does not believe: .*invite the person again at the rights of their role/u);
    expect(events.slice(before)).toEqual([]);
  });

  it('every later version of the roster keeps the coin key a seat was admitted with', { timeout: 120_000 }, async () => {
    const fay = await invited(FAY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: fay.shown }, inviteAddressOf);
    /* Her request carries a coin key of its own, sealed to the company's inbox as anyone can seal one. */
    const signerId = await seatTaken(FAY, fay, { sealed: { coinPublicKey: 'ee'.repeat(32) } });
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: FAY.name });
    /* RED WHEN: the coin key an admitted entry records is taken from the request, which anyone can seal, and not from the proposal. */
    expect(coinOf(FAY.name)).toBe(coinKeyAt(addressOf(FAY.fill)));
    await eveAdmitted();
    const read = (await rosterHere(rosterDoorsOf(ADA))).opened.signers;
    /* RED WHEN: a roster filed after a seat's admission drops the coin key that seat was admitted with. */
    expect(read.find((x) => x.name === EVE.name)?.coinPublicKey).toBe(coinKeyAt(addressOf(EVE.fill)));
    expect(read.find((x) => x.name === FAY.name)?.coinPublicKey).toBe(coinKeyAt(addressOf(FAY.fill)));
  });
});
