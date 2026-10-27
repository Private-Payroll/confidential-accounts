/**
 * Seating a signer invited at a wallet address, against the compiled account.
 *
 * The signers raise and approve an invitation that names a hiding commitment to
 * the invitee's address and the rights the seat will carry. The invitee carries
 * it out with `seatInvited`, proving inside the call that they hold the coin
 * secret key behind that address. Each test states one way a seat could be
 * taken that the signers did not approve, and asserts the chain refuses it.
 */
import { describe, it, expect } from 'vitest';
import {
  AccountSimulator, privateStateFor, change, ZERO_32, invitePayloadFor, invitedAddressFor,
  invitedAddressCommitmentOf, type Change,
} from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { Transcript } from './transcript.js';
import { ALL_VAULTS, scopeOfRights, type AccountPrivateState, type SignerRights } from '../src/witnesses.js';

type Device = AccountPrivateState;

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);
const D = privateStateFor(4);

/** Raises `payload` as `by`, which counts as `by`'s approval, and answers the id the chain files it under. */
const raise = async (sim: AccountSimulator, by: Device, c: Change, payload: Uint8Array): Promise<Uint8Array> => {
  await sim.as(sim.applying(by, c)).propose(payload);
  return sim.proposalId(payload, c.salt);
};

/** An invitation of `who` raised by A and approved by every other device in `approvers`. */
const invitation = async (sim: AccountSimulator, who: Device, approvers: Device[], seed: number) => {
  const c = change(0n, seed);
  const id = await raise(sim, A, c, invitePayloadFor(who));
  for (const d of approvers.filter((a) => a !== A)) await sim.as(d).approve(id);
  return { id, c };
};

const NOT_THIS_WALLET = /that proposal does not invite this wallet with these rights/;

describe('a signer invited by address takes their own seat', () => {
  it('a signer invited by address is seated at threshold by the invitee, and can approve at once', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 11);

    await sim.seatInvited(id, sim.invited(C, c));

    expect(sim.ledger.signerLeaves.size()).toBe(3n);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(C))).toBe(true);
    expect(sim.isOpen(id)).toBe(false);
    const next = await raise(sim, A, change(0n, 12), new Uint8Array(32).fill(5));
    await expect(sim.as(C).approve(next)).resolves.not.toThrow();
  });

  it('seating publishes only the proposal id and the new leaf, and never the address, its commitment, its salt or a key', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 13);
    const invite = invitedAddressFor(C);

    const tape = Transcript.watch(sim.contract).clear();
    await sim.seatInvited(id, sim.invited(C, c));
    const t = tape.last;
    tape.stop();

    t.assertNotVacuous();
    t.assertPublishes({ 'the new leaf': sim.leafOf(C), 'the proposal': id });
    /* RED WHEN: seating discloses the invited address, its commitment, its salt, the wallet's key or the seat's key. */
    t.assertAbsent({
      'the coin secret key': invite.coinSecretKey,
      'the coin public key': pureCircuits.coinPublicKeyOf(invite.coinSecretKey),
      'the address salt': invite.addressSalt,
      'the commitment to the address': invitedAddressCommitmentOf(invite),
      'the invitation payload': invitePayloadFor(C),
      'the seat key': C.secretKey,
      'the seat public key': sim.publicKeyOf(C),
      'the blinding': C.blinding,
    });
  });
});

describe('a seat the signers did not approve is refused', () => {
  it('another wallet cannot take the seat, even holding the invitation and its salt', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 21);
    const other = { ...sim.invited(C, c), invite: { ...invitedAddressFor(C), coinSecretKey: invitedAddressFor(D).coinSecretKey } };

    /* RED WHEN: the proposal's id is not checked against the invitation, so any wallet takes the seat. */
    await expect(sim.seatInvited(id, other)).rejects.toThrow(NOT_THIS_WALLET);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('someone who knows the invited address but not its key cannot take the seat', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 22);
    const invite = invitedAddressFor(C);
    /* The address carries the coin public key in the clear; its holder alone has the secret key behind it. */
    const knowsTheAddress = { ...sim.invited(D, c), invite: { ...invite, coinSecretKey: pureCircuits.coinPublicKeyOf(invite.coinSecretKey) } };

    /* RED WHEN: the coin public key is taken from the invitee instead of worked out from their secret key. */
    await expect(sim.seatInvited(id, knowsTheAddress)).rejects.toThrow(NOT_THIS_WALLET);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it("a wallet that copies the invitation's commitment cannot take the seat", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 23);
    const copied = { ...sim.invited(D, c), invite: { coinSecretKey: invitedAddressFor(D).coinSecretKey, addressSalt: invitedAddressCommitmentOf(invitedAddressFor(C)) } };

    /* RED WHEN: the commitment to the address is not worked out from the invitee's key and salt. */
    await expect(sim.seatInvited(id, copied)).rejects.toThrow(NOT_THIS_WALLET);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('the invited wallet with the wrong salt is refused', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 24);
    const wrongSalt = { ...sim.invited(C, c), invite: { ...invitedAddressFor(C), addressSalt: new Uint8Array(32).fill(7) } };

    await expect(sim.seatInvited(id, wrongSalt)).rejects.toThrow(NOT_THIS_WALLET);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('an invitee cannot take wider rights than the invitation fixed', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const narrow: SignerRights = { mayRaise: false, mayApprove: true, mayHold: false, everyVault: false, vaults: [new Uint8Array(32).fill(9)] };
    const invited: Device = { ...C, rights: narrow, scope: scopeOfRights(narrow) };
    const { id, c } = await invitation(sim, invited, [A, B], 25);
    const wider: Device = { ...sim.invited(invited, c), rights: null, scope: ALL_VAULTS };

    /* RED WHEN: the invitation binds who is seated but not the rights the seat carries. */
    await expect(sim.seatInvited(id, wider)).rejects.toThrow(NOT_THIS_WALLET);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(wider))).toBe(false);

    await sim.seatInvited(id, sim.invited(invited, c));
    expect(sim.ledger.signerLeaves.member(sim.leafOf(invited))).toBe(true);
  });

  it('an invitation that would seat a leaf already seated is refused', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, B, [A, B], 26);

    /* RED WHEN: seatInvited stops refusing a leaf that is already seated. */
    await expect(sim.seatInvited(id, sim.invited(B, c))).rejects.toThrow(/that signer is already on this account/);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('an invitation approved by too few signers is refused', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A], 27);

    await expect(sim.seatInvited(id, sim.invited(C, c))).rejects.toThrow(/not enough approvals yet/);
    expect(sim.ledger.signerLeaves.size()).toBe(2n);
  });

  it('an invitation below the seat bar is refused until the bar is met', async () => {
    const sim = await AccountSimulator.liveAccount([A, B, C], 2n);
    const barChange = change(0n, 28);
    const barId = await raise(sim, A, barChange, pureCircuits.setPolicyBarPayload(3n));
    await sim.as(B).approve(barId);
    await sim.as(sim.applying(A, barChange)).setPolicyBar(3n, barId);

    const { id, c } = await invitation(sim, D, [A, B], 29);
    /* RED WHEN: seatInvited stops calling requireSeatBar, so the account threshold alone seats a signer. */
    await expect(sim.seatInvited(id, sim.invited(D, c)))
      .rejects.toThrow(/needs as many approvals as a policy change needs, and at least the threshold/);
    await sim.as(C).approve(id);
    await sim.seatInvited(id, sim.invited(D, c));
    expect(sim.ledger.signerLeaves.member(sim.leafOf(D))).toBe(true);
  });

  it('an invitation raised before a removal cannot be taken', async () => {
    const sim = await AccountSimulator.liveAccount([A, B, C], 2n);
    const { id, c } = await invitation(sim, D, [A, B], 30);

    const out = change(0n, 31);
    const outId = await raise(sim, A, out, pureCircuits.removeSignerPayload(sim.leafOf(C)));
    await sim.as(B).approve(outId);
    await sim.as(sim.applying(A, out)).removeSigner(sim.leafOf(C), outId);

    /* RED WHEN: seatInvited stops calling requireApproved, so a removal since the raise does not end the invitation. */
    await expect(sim.seatInvited(id, sim.invited(D, c)))
      .rejects.toThrow(/a signer has been removed or replaced since this was raised; raise it again/);
    expect(sim.ledger.signerLeaves.member(sim.leafOf(D))).toBe(false);
  });

  it('an invitation is carried out once', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const { id, c } = await invitation(sim, C, [A, B], 32);
    await sim.seatInvited(id, sim.invited(C, c));

    await expect(sim.seatInvited(id, sim.invited(C, c))).rejects.toThrow(/that signer is already on this account/);
    await expect(sim.seatInvited(id, { ...privateStateFor(77), invite: invitedAddressFor(C), proposalSalt: c.salt }))
      .rejects.toThrow(/there is no open proposal with that id/);
    expect(sim.ledger.signerLeaves.size()).toBe(3n);
  });

  it('naming no proposal seats nobody', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    await expect(sim.seatInvited(ZERO_32, sim.invited(C, change(0n, 33)))).rejects.toThrow(NOT_THIS_WALLET);
  });
});

describe('a signer is added only by invitation', () => {
  it('the account has no circuit that seats a leaf it is handed, and amendSigner only removes', async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    const circuits = Object.keys(sim.contract.impureCircuits);
    expect(circuits).toContain('seatInvited');
    expect(circuits).toContain('amendSigner');
    expect(Object.keys(pureCircuits)).not.toContain('signerAddPayload');
    /* The generated circuit takes the call context, the leaf being removed and the proposal: nothing that could seat. */
    const amend = sim.contract.impureCircuits.amendSigner as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(amend({}, sim.leafOf(B), ZERO_32, false, false)).rejects.toThrow(/amendSigner: expected 3 arguments/);
  });
});
