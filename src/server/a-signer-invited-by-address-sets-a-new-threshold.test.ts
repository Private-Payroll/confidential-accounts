/**
 * **A SIGNER INVITED BY ADDRESS WITH A NEW THRESHOLD.** Ada's device invites a wallet at an address and asks the
 * company to need a new number of approvals once that seat is taken. The signed invitation names the threshold, the
 * proposal's payload binds it, every device checks it before every send as the chain will (no higher than the seats
 * held once the seat is taken) and against every vault (the new seat counted only on the vaults its rights reach), and
 * a seat approved from another device is approved only at the threshold its window showed.
 *
 * The company: three seats on the test's chain at a threshold of one and a seat bar of two, every seat holding every
 * right, and no vault but company-wide runs. Every assertion names the change that turns it red.
 */
import { describe, it, expect } from 'vitest';
import { addressFor, identityFromSecret } from 'midnight-identity';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import type { Hex } from '../core/crypto.js';
import { signSeatInvitation, type SignerOffer } from '../core/invitation.js';
import { identityOfAChange } from 'vaults-web-shared/governed-call-builder.js';
import type { SealedProposal } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { theNetwork } from '../midnight/network.js';
import { inviteHere, openInvitationHere, type KeptSeatInvitation } from 'vaults-web-shared/invitation-on-device.js';
import {
  approveSeatInvitationOnDevice, InvitationNotBound, raiseSeatInvitationOnDevice, removeSignerOnDevice, seatSignerOnDevice, signerByAddressDoorsOf,
  type SeatInvitationShown,
} from 'vaults-web-shared/governed-call-on-device.js';
import { ACME, ORIGIN, fromAda, store } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, CO, CY, deviceOf, events, KEY, rosterDoorsOf, sendAs, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

aCompanyWhoseSignersChange();

const NETWORK = theNetwork();
const ALL = MidnightCommitments.allVaults().toLowerCase();
const addressOf = (fill: number): string => addressFor(identityFromSecret(new Uint8Array(32).fill(fill)).moneyAt(0).zswap, NETWORK as never).bech32;
const coinKeyAt = (address: string): Hex => String(checkShieldedAddress(address, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
const inviteAddressOf = (c: Hex, salt: Hex): Hex => MidnightCommitments.inviteAddressOf(c, salt);
const seatingDevice = (s: Seat) => ({ ...deviceOf(s), roster: rosterDoorsOf(s) });

/** Ada's device invites the wallet at `fill`'s address with `threshold`, and `scope` where given; what it kept, and the offer the link opens. */
const invitedAt = async (fill: number, threshold: string, scope?: Hex) => {
  const kept: KeptSeatInvitation[] = [];
  const made = await inviteHere(ACME, ADA, 'signer', {
    name: `w${fill}`, role: 'approver', person: 'unused', address: addressOf(fill), threshold, ...(scope === undefined ? {} : { scope }),
  }, ORIGIN, fromAda, signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async (k) => { kept.push(k); }));
  const offer = (await openInvitationHere(made.link, sendAs(null))).signed.offer.for as SignerOffer;
  const proposal = (await store.listProposals(CO) as SealedProposal[])
    .find((p) => String(p.chainId).toLowerCase() === offer.invited.terms.proposal!.toLowerCase())!;
  const shown: SeatInvitationShown = {
    proposal: proposal.id, name: `w${fill}`, role: 'approver', address: offer.invited.terms.invite!.address, scope: offer.invited.terms.invite!.scope,
    coinPublicKey: coinKeyAt(addressOf(fill)), threshold,
  };
  return { kept, offer, shown };
};

describe('A SIGNER INVITED BY ADDRESS SETS THE THRESHOLD THE SIGNERS APPROVED, ONCE THE SEAT IS TAKEN', () => {
  it('the invitation names the threshold, and the proposal raised is the one its address, rights, threshold and salt make', { timeout: 120_000 }, async () => {
    const before = events.length;
    const w = await invitedAt(81, '4');
    const terms = w.offer.invited.terms;
    /* RED WHEN: the threshold asked is not in the signed invitation the signers approve and the invitee takes the seat with. */
    expect(terms.invite!.threshold).toBe('4');
    /* RED WHEN: the proposal's payload leaves the threshold out, so the chain would seat at a number nobody approved. */
    const salt = w.offer.byAddress!.proposalSalt;
    const bound = await identityOfAChange({ accountPure: pureCircuits as never }, { kind: 'add-signer', address: terms.invite!.address, scope: terms.invite!.scope, threshold: '4' }, salt);
    const unbound = await identityOfAChange({ accountPure: pureCircuits as never }, { kind: 'add-signer', address: terms.invite!.address, scope: terms.invite!.scope }, salt);
    expect(terms.proposal).toBe(String(bound.chainId).toLowerCase());
    expect(String(unbound.chainId).toLowerCase()).not.toBe(terms.proposal);
    expect(events.slice(before)).toEqual(['chain propose']);
  });

  it('RED WHEN: a threshold above the seats held once the seat is taken is raised, which the chain refuses only when the seat is taken', async () => {
    const before = events.length;
    const proposals = (await store.listProposals(CO)).length;
    await expect(invitedAt(82, '5')).rejects.toThrow(/once this seat is taken the company has 4 signers, so it cannot need 5 approvals/iu);
    expect(events.slice(before)).toEqual([]);
    expect((await store.listProposals(CO)).length).toBe(proposals);
  });

  it('RED WHEN: a seat with rights of its own is counted as an approver, and a threshold that leaves company-wide runs short is raised', async () => {
    const before = events.length;
    await expect(invitedAt(83, '4', 'fa'.repeat(32) as Hex))
      .rejects.toThrow(/unable to pay: company-wide runs \(its runs need 4 approvals and 3 signers could give them\)\..* The new seat is counted on no vault/u);
    expect(events.slice(before)).toEqual([]);
    /* The same seat at a threshold the three seats on every vault can meet is raised. */
    await invitedAt(84, '3', 'fa'.repeat(32) as Hex);
    expect(events.slice(before)).toEqual(['chain propose']);
  });

  it('another seat approves it only at the threshold its window showed, and checks it again before its approval is sent', { timeout: 120_000 }, async () => {
    const w = await invitedAt(85, '2');
    const bo = seatingDevice(BO);
    const before = events.length;
    for (const changed of [{ ...w.shown, threshold: '3' }, { ...w.shown, threshold: undefined }, { ...w.shown, threshold: '0' }]) {
      /* RED WHEN: a proposal that sets another threshold than the window showed (or one where the window showed none) is approved. */
      await expect(approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: changed }, inviteAddressOf, { allVaults: ALL }), String(changed.threshold))
        .rejects.toThrow(InvitationNotBound);
    }
    /* RED WHEN: a device that cannot tell which rights cover every vault counts the new seat anyway, and approves. */
    await expect(approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: w.shown }, inviteAddressOf)).rejects.toThrow(/which rights cover every vault/u);
    expect(events.slice(before)).toEqual([]);
    const done = await approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: w.shown }, inviteAddressOf, { allVaults: ALL });
    expect(done.state).toBe('waiting-for-the-invitee');
    expect(events.slice(before)).toEqual(['chain approve']);
  });

  it('RED WHEN: a raise taken up from another device carries the invitation without its threshold, and is raised as another proposal', async () => {
    const w = await invitedAt(86, '2');
    const { threshold: _t, ...without } = w.offer.invited.terms.invite!;
    /* Signed again by the seat that invited, so only the threshold is missing. */
    const stripped = signSeatInvitation({ ...w.offer.invited.terms, invite: without }, ADA.signingSecret as Hex);
    const before = events.length;
    await expect(raiseSeatInvitationOnDevice(seatingDevice(BO), {
      viewingKey: KEY, invited: stripped, proposalSalt: w.offer.byAddress!.proposalSalt, name: 'w86',
    }, undefined, { allVaults: ALL })).rejects.toThrow(/not the one its address, rights, threshold and salt make/u);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: an approval that meets the bar of a seat raising the threshold is sent while a directory version is filed and not yet anchored', async () => {
    const w = await invitedAt(87, '2');
    const bo = seatingDevice(BO);
    const read = bo.records!.directory;
    /* Bo's device reads one directory version filed past the newest anchored, which anchoring from here does not reach. */
    const behind = { ...bo, records: { ...bo.records!, directory: async (asked?: never) => { const d = await read(asked); return { ...d, dir: { ...d.dir, version: d.dir.version + 1 } }; } } };
    const before = events.length;
    await expect(approveSeatInvitationOnDevice(behind as never, { viewingKey: KEY, shown: w.shown }, inviteAddressOf, { allVaults: ALL }))
      .rejects.toThrow(/is not raised while version \d+ of the company's directory is filed and not yet anchored/u);
    /* The device anchors what it can first; nothing reaches the chain's proposals. */
    expect(events.slice(before).filter((e) => e.startsWith('chain'))).toEqual([]);
  });

  it('RED WHEN: a removal is raised while a seat whose invitation raises the threshold above the bar it is approved at is open, and is stranded once that seat is taken', async () => {
    const before = events.length;
    const proposals = (await store.listProposals(CO)).length;
    await expect(removeSignerOnDevice(deviceOf(ADA), { viewingKey: KEY, leaf: CY.seat, name: 'cy' }))
      .rejects.toThrow(/adds a signer whose seat sets the approvals the company needs to \d+ once it is taken, above the 2 this removal is approved at.*Let the person take that seat first, or withdraw that invitation/u);
    expect(events.slice(before)).toEqual([]);
    expect((await store.listProposals(CO)).length).toBe(proposals);
  });

  it('RED WHEN: a seat entered under the leaf its person sent drops the threshold its invitation names, and is raised keeping the one in force', async () => {
    await expect(seatSignerOnDevice(seatingDevice(ADA), {
      viewingKey: KEY, signerId: 'sgn_none', readOut: '', invite: { address: 'aa'.repeat(32), salt: 'bb'.repeat(32), scope: ALL, threshold: '2' },
    } as never)).rejects.toThrow(/a seat entered under the leaf its person sent keeps the threshold in force/u);
  });
});

