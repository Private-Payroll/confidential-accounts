/**
 * **A PERSON WHO JOINED BY A LINK IS APPROVED FROM A SECOND SEAT, AND ONLY THEY CAN TAKE THE SEAT.** Ada's device
 * invites Dee; Dee's device accepts, sealing to the company's inbox her keys and the address her own wallet signed that
 * she takes the seat with; Ada's device raises the proposal to seat Dee's leaf at that address, which is its approval;
 * Bo's device approves that same proposal by its name in the company's records (`approveSeatByLeafOnDevice`), held to
 * the fingerprint Dee reads out, to the invitation she accepted and to the address her wallet signed. A proposal whose
 * invitation names another person, leaf or address, or no leaf, is refused before anything is built. The account seats
 * only a wallet that holds the address the proposal names, as `seatInvited` does: Dee's, and nobody else's.
 *
 * Over real HTTP, with the company and its stand-ins as `aCompanyWhoseSignersChange` names them.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import type { Hex } from '../core/crypto.js';
import { addSignerByAddressIn, addSignerByLeafIn } from '../core/add-signer-filing.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { SimulatedCommitments } from '../core/ledger.js';
import { leafOfTheContract } from '../testing/directory-seats.js';
import { anAddress } from '../testing/an-invitee.js';
import { aJoinersWallet } from '../testing/a-joiners-wallet.js';
import { seatRoundBound } from '../testing/seat-round-bound.js';
import { newSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { acceptAsSignerHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { InvitationNotBound } from 'vaults-web-shared/governed-call-on-device.js';
import { FingerprintsDiffer } from 'vaults-web-shared/seat-request-fingerprint.js';
import { approveSeatByLeafOnDevice, seatByLeafToConfirmHere, seatSignerOnDevice } from 'vaults-web-shared/signer-by-link.js';
import { admitSignerHere } from 'vaults-web-shared/roster-here.js';
import type { PendingSeat } from 'vaults-web-shared/keyring.js';
import { ACME, ORIGIN, fromAda } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, CO, committeeKeyOfLeaf, companyNow, deviceOf, events, KEY, LABEL, rosterDoorsOf, seatsOnTheChain, sendAs, store,
  theInviteeTakesTheSeatHere, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

/** Dee's own wallet: its key for the company, and the address it takes the seat with. */
const DEE = aJoinersWallet(committeeSigningKeyFor(identityFromSecret(new Uint8Array(32).fill(5)), LABEL).value as Hex, 44);
/** A seat's device, with the roster it reads and admits through. */
const seatingDevice = (s: Seat) => ({ ...deviceOf(s), roster: rosterDoorsOf(s) });
/** An address the raising seat's device holds, which it would name instead of Dee's. */
const RAISERS = anAddress(MidnightCommitments, 43);
const RAISER_HOLDS = { coinPublicKey: MidnightCommitments.coinPublicKeyOf(RAISERS.coinSecretKey), addressSalt: RAISERS.addressSalt };
/** The account's own function making an address from a coin key and a salt, as every device works the signed address out again. */
const inviteAddressOf = (c: Hex, salt: Hex) => MidnightCommitments.inviteAddressOf(c, salt);

describe('A PERSON WHO JOINED BY A LINK IS APPROVED FROM A SECOND SEAT', () => {
  it('Bo approves the proposal Ada raised for Dee at the address Dee\'s wallet signed, and only Dee takes the seat', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'dee', role: 'approver', person: 'dee' }, ORIGIN, fromAda);
    const kept: PendingSeat[] = [];
    const accepted = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async (seat) => { kept.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('dee'), 'dee', async () => DEE.walletKey, DEE.seatAddress);
    const leaf = leafOfTheContract(kept[0]!.opening!)!;
    committeeKeyOfLeaf.set(leaf, DEE.walletKey);
    const signerId = accepted.signerId!;

    const raised = await seatSignerOnDevice(seatingDevice(ADA), { companyKeys: KEY, signerId, readOut: accepted.fingerprint, invite: { scope: kept[0]!.scope }, inviteAddressOf });
    expect(raised.state).toBe('waiting-for-approvals');
    const proposal = raised.round!.id;
    const filed = structuredClone(store.getProposal(proposal)!);

    /* RED WHEN: a proposal raised for a leaf is not read as one, or is read as a seat invited by address. */
    const byLeaf = addSignerByLeafIn(filed, CO, KEY);
    expect(byLeaf).toMatchObject({ chainId: raised.round!.chainId.toLowerCase(), signerId });
    expect(addSignerByAddressIn(filed, CO, KEY)).toBeNull();
    /* RED WHEN: the raising seat names any other address than the one Dee's own wallet signed. */
    expect(byLeaf!.invited.terms.invite).toMatchObject({ address: DEE.at.address.toLowerCase(), salt: DEE.at.addressSalt.toLowerCase() });

    /* RED WHEN: the fingerprint a second seat confirms is not the one of the keys Dee's device made. */
    expect((await seatByLeafToConfirmHere(seatingDevice(BO), { viewingKey: KEY, proposal, inviteAddressOf })).fingerprint).toBe(accepted.fingerprint);

    /* RED WHEN: a second seat confirms an address without working it out again from the coin key by the account's own function: here another one's. */
    await expect(seatByLeafToConfirmHere(seatingDevice(BO), { viewingKey: KEY, proposal, inviteAddressOf: (c, salt) => SimulatedCommitments.inviteAddressOf(c, salt) }))
      .rejects.toThrow(/does not carry an address their own wallet signed for this seat, made from that wallet.s coin key/u);
    /* RED WHEN: a second seat approves with a fingerprint the person waiting did not read out. */
    await expect(approveSeatByLeafOnDevice(seatingDevice(BO), { viewingKey: KEY, proposal, readOut: 'aaaa-bbbb-cccc', inviteAddressOf }))
      .rejects.toBeInstanceOf(FingerprintsDiffer);

    const refusedAsFiled = async (over: Parameters<typeof seatRoundBound>[5], says: RegExp): Promise<void> => {
      seatRoundBound(store, CO, proposal, KEY as Hex, ADA.signingSecret as Hex, over);
      try {
        for (const asked of [
          approveSeatByLeafOnDevice(seatingDevice(BO), { viewingKey: KEY, proposal, readOut: accepted.fingerprint, inviteAddressOf }),
          seatByLeafToConfirmHere(seatingDevice(BO), { viewingKey: KEY, proposal, inviteAddressOf }),
        ]) {
          await expect(asked).rejects.toBeInstanceOf(InvitationNotBound);
          await expect(asked).rejects.toThrow(says);
        }
      } finally {
        store.putProposal(filed);
      }
    };
    const scope = kept[0]!.scope;
    /* RED WHEN: a second seat approves a proposal that names an address the raising seat holds, not the one Dee's wallet signed. */
    await refusedAsFiled({ invite: { address: RAISERS.address, salt: RAISERS.addressSalt, scope } },
      /address this proposal would seat is not the one the person waiting signed with their own wallet/u);
    /* RED WHEN: Dee's address under a salt she did not sign is approved. */
    await refusedAsFiled({ invite: { address: DEE.at.address, salt: RAISERS.addressSalt, scope } },
      /address this proposal would seat is not the one the person waiting signed with their own wallet/u);
    /* RED WHEN: a second seat approves a proposal for Dee's leaf at her signed address that sets the approvals the company needs to one, which no approver is shown. */
    await refusedAsFiled({ invite: { address: DEE.at.address, salt: DEE.at.addressSalt, scope, threshold: '1' } },
      /sets the approvals the company needs once the seat is taken.*raise the person's seat again without a change to the approvals needed/u);
    /* RED WHEN: a second seat approves a proposal whose invitation seats another person than the one waiting accepted. */
    await refusedAsFiled({ name: 'mallory' }, /does not give the seat, role, vaults, person or name of the person waiting/u);
    /* RED WHEN: a second seat approves a proposal whose invitation names another leaf than the keys of the person waiting. */
    await refusedAsFiled({ leaf: 'ab'.repeat(32) as Hex }, /does not give the seat, role, vaults, person or name of the person waiting/u);
    /* RED WHEN: a proposal whose invitation names no leaf is approved as one to seat a leaf. */
    await refusedAsFiled({ leaf: undefined }, /no proposal to seat a person who joined by a link or a code under that name/u);
    /* RED WHEN: a wallet whose coin key another proposal still invites is raised a second seat by a link: one wallet, two seats. */
    const eve = await inviteHere(ACME, ADA, 'signer', { name: 'eve', role: 'approver', person: 'eve' }, ORIGIN, fromAda);
    const sameCoin = aJoinersWallet(committeeSigningKeyFor(identityFromSecret(new Uint8Array(32).fill(7)), LABEL).value as Hex, 44);
    const keptForEve: PendingSeat[] = [];
    const evesRequest = await acceptAsSignerHere(await openInvitationHere(eve.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async (seat) => { keptForEve.push(seat as PendingSeat); }, promote: async () => {},
    }, sendAs('eve'), 'eve', async () => sameCoin.walletKey, sameCoin.seatAddress);
    await expect(seatSignerOnDevice(seatingDevice(ADA), {
      companyKeys: KEY, signerId: evesRequest.signerId!, readOut: evesRequest.fingerprint, invite: { scope: keptForEve[0]!.scope }, inviteAddressOf,
    })).rejects.toThrow(/Nothing was raised and nothing was sent: another invitation for this address is still open on the network/u);
    /* RED WHEN: a refusal is reached only after something was built and sent. */
    expect(events).toEqual(['chain propose']);

    /* RED WHEN: a second seat cannot approve the proposal raised for a person who joined by a link. */
    const approved = await approveSeatByLeafOnDevice(seatingDevice(BO), { viewingKey: KEY, proposal, readOut: accepted.fingerprint, inviteAddressOf });
    expect(approved.state).toBe('waiting-for-the-invitee');
    expect(approved.round?.chainId.toLowerCase()).toBe(raised.round!.chainId.toLowerCase());
    /* RED WHEN: the approval raises or signs another proposal instead of approving the one filed. */
    expect(events).toEqual(['chain propose', 'chain approve']);
    expect(store.getProposal(proposal)!.sealed).toEqual(filed.sealed);
    expect(store.listProposals(CO).filter((p) => addSignerByLeafIn(p, CO, KEY)?.signerId === signerId).map((p) => p.id)).toEqual([proposal]);

    const chainId = raised.round!.chainId;
    const takersLeaf = 'c4'.repeat(32);
    committeeKeyOfLeaf.set(takersLeaf, { tag: 'schnorr', value: '5c'.repeat(32) });
    /* RED WHEN: the raising seat, or any wallet but Dee's, can take the seat every approver confirmed as Dee's. */
    expect(() => theInviteeTakesTheSeatHere(chainId, RAISER_HOLDS, takersLeaf)).toThrow(/does not invite this wallet/u);
    expect(seatsOnTheChain()).not.toContain(takersLeaf);
    /* RED WHEN: Dee cannot take, from her own wallet, the seat every approver confirmed by her fingerprint. */
    theInviteeTakesTheSeatHere(chainId, DEE.holds, leaf);
    expect(seatsOnTheChain()).toContain(leaf);
    /* Bo's device admits her. */
    await admitSignerHere(rosterDoorsOf(BO), { signerId, readOut: accepted.fingerprint });
    expect(companyNow().signers.find((x) => x.name === 'dee')?.status).toBe('active');
  }, 170_000);

  it('a joiner whose wallet signs no address for the seat, or another wallet\'s, sends no seat request', async () => {
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'eve', role: 'approver', person: 'eve' }, ORIGIN, fromAda);
    const other = aJoinersWallet(committeeSigningKeyFor(identityFromSecret(new Uint8Array(32).fill(6)), LABEL).value as Hex, 46);
    const before = store.getAccount(CO)!.pendingSigners.length;
    /* RED WHEN: a seat request is sent with an address the joiner's own wallet did not sign for it. */
    await expect(acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
    }, sendAs('eve'), 'eve', async () => DEE.walletKey, other.seatAddress)).rejects.toThrow(/your wallet did not sign, for this seat, an address made from its own coin key.*invite you by your private address/u);
    /* RED WHEN: a seat request is sent with an address the wallet's coin key does not make under the account's own function. */
    const otherScheme = aJoinersWallet(committeeSigningKeyFor(identityFromSecret(new Uint8Array(32).fill(5)), LABEL).value as Hex, 47, SimulatedCommitments);
    const again = await inviteHere(ACME, ADA, 'signer', { name: 'fay', role: 'approver', person: 'fay' }, ORIGIN, fromAda);
    await expect(acceptAsSignerHere(await openInvitationHere(again.link, sendAs(null)), MidnightCommitments, {
      newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
    }, sendAs('fay'), 'fay', async () => otherScheme.walletKey, otherScheme.seatAddress)).rejects.toThrow(/an address made from its own coin key/u);
    expect(store.getAccount(CO)!.pendingSigners.length).toBe(before);
  }, 170_000);
});
