/**
 * **THE TWO DECISIONS THAT KEEP A SIGNER'S BLINDING ALIVE.** `C329`, `C325`,
 * `S34`.
 *
 * Both were written this round and both were found by `S34`'s own auditors —
 * the clobber by `money-safety-auditor`, the fact that the whole of the new
 * keyring code had no test at all by `test-auditor`. A blinding lives on one
 * device and nowhere else (decision 0003), so a function that can overwrite one
 * or bind material to the wrong seat decides whether an M-of-N account can
 * still reach its threshold.
 *
 * **THE ROSTER HERE IS A REAL SEALED ROSTER.** `sealAccount` seals it and
 * `wrapKey` wraps the viewing key exactly as the product does, so the forgery
 * case below is a real forgery: it is built the way an attacker holding the
 * published wrapping public key would build one, not a fixture shaped like one.
 */
import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  newSigningKeypair, newWrappingKeypair, newSymmetricKey, wrapKey, toHex, fromHex, type Hex,
} from '../core/crypto.js';
import { sealAccount, defaultPolicy } from '../core/account.js';
import type { Account, Signer } from '../core/types.js';
import { clobberRefusal, seatToPromote, type SealedSeat } from './seat-repair.js';

const wrappingPublicOf = (secret: Hex) => toHex(x25519.getPublicKey(fromHex(secret)));

const signerOf = (id: string, signingPublicKey: Hex): Signer => ({
  id, name: id, role: 'approver', status: 'active', userId: null,
  signingPublicKey, wrappingPublicKey: 'cc'.repeat(32), leafCommitment: 'dd'.repeat(32),
});

/** A real account, really sealed, with one wrapped viewing key per signer. */
const accountWith = (signers: Signer[], wrapTo: Array<{ signerId: string; pub: Hex }>) => {
  const viewingKey = newSymmetricKey();
  const account: Account = {
    id: 'acc_northwind', name: 'Northwind', signers,
    policy: defaultPolicy(1), wrappedKeys: [],
    recovery: { signerIds: signers.map(s => s.id), threshold: 1 },
    createdAt: new Date().toISOString(),
  };
  const sealed = sealAccount(account, viewingKey, []);
  sealed.wrappedKeys = wrapTo.map(w => ({
    signerId: w.signerId, ...wrapKey(viewingKey, w.pub),
  })) as never;
  return { sealed, viewingKey };
};

describe('nothing silently replaces key material that is already here', () => {
  const held = { signerId: 'sgn_mine', signingSecret: '11'.repeat(32) };

  it('REFUSES a write that would replace a different signing secret', () => {
    const refusal = clobberRefusal(held, { signerId: 'sgn_other', signingSecret: '33'.repeat(32) });
    expect(refusal).toBeTruthy();
    /* It names BOTH seats, because the person has to be able to tell which one
     * they are about to lose — `C320`'s rule that a refusal mistakable for its
     * neighbour is the defect. */
    expect(refusal).toContain('sgn_mine');
    expect(refusal).toContain('sgn_other');
    /* Rule 19: a door, and not a file to edit. */
    expect(refusal).toMatch(/different device or in a different\s+browser profile/);
    expect(refusal).toMatch(/NOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN/);
    /* And it does not leak the secret it is protecting. */
    expect(refusal).not.toContain('11'.repeat(32));
    expect(refusal).not.toContain('33'.repeat(32));
  });

  it('allows the FIRST write, and allows the same material written twice', () => {
    /* A retry must cost nothing. A refusal here would turn a dropped connection
     * into a company nobody can open. */
    expect(clobberRefusal(undefined, held)).toBeNull();
    expect(clobberRefusal(null, held)).toBeNull();
    expect(clobberRefusal(held, { signerId: 'sgn_mine', signingSecret: '11'.repeat(32) })).toBeNull();
  });

  it('compares the SECRET and not the seat id, in either case', () => {
    /* Two facts in one: a bundle written elsewhere may spell hex in upper case
     * (`S31`'s finding, one file along), and a server that renamed the seat
     * must not be able to make a clobber look like a retry. */
    expect(clobberRefusal(held, { signerId: 'x', signingSecret: '11'.repeat(32).toUpperCase() }))
      .toBeNull();
    expect(clobberRefusal(held, { signerId: 'sgn_mine', signingSecret: '99'.repeat(32) }))
      .toBeTruthy();
  });
});

describe('a published seat is bound to this device only on proof, never on a label', () => {
  const sk = newSigningKeypair();
  const wk = newWrappingKeypair();
  const seat: SealedSeat = {
    signingPublicKey: sk.publicKey, signingSecret: sk.secret, wrappingSecret: wk.secret,
  };

  it('PROMOTES the seat whose roster entry carries this device’s own public key', () => {
    const { sealed } = accountWith(
      [signerOf('sgn_mine', sk.publicKey)],
      [{ signerId: 'sgn_mine', pub: wrappingPublicOf(wk.secret) }]);

    expect(seatToPromote([seat], sealed))
      .toEqual({ signingPublicKey: sk.publicKey, signerId: 'sgn_mine' });
  });

  it('REFUSES a forged wrapped key that names somebody else’s seat', () => {
    /*
     * **THE FINDING THIS FUNCTION WAS REWRITTEN FOR.** `S34`'s
     * `money-safety-auditor`, rule 14: the first version said a substituted
     * roster could not forge a match. `wrapKey` is PUBLIC-key sealing, and this
     * device published its wrapping public key one step earlier — so anybody
     * can produce a ciphertext that opens under this device's secret, and the
     * `signerId` beside it is plaintext the server chooses. A pending entry is
     * one-shot, so a wrong binding is permanent.
     *
     * The forgery below is exactly that: a real `wrapKey` to this device's real
     * public key, labelled with a seat that is not this device's.
     */
    const stranger = newSigningKeypair();
    const { sealed } = accountWith(
      [signerOf('sgn_stranger', stranger.publicKey)],
      [{ signerId: 'sgn_stranger', pub: wrappingPublicOf(wk.secret) }]);

    expect(seatToPromote([seat], sealed)).toBeNull();
  });

  it('REFUSES when the ciphertext opens but is not this account’s viewing key', () => {
    /* The other half of the same forgery: a well-formed wrap of a value that is
     * not the key the roster was sealed under. Discarding the plaintext — which
     * the first version did — accepted this. */
    const { sealed } = accountWith(
      [signerOf('sgn_mine', sk.publicKey)],
      [{ signerId: 'sgn_mine', pub: wrappingPublicOf(wk.secret) }]);
    sealed.wrappedKeys = [{
      signerId: 'sgn_mine', ...wrapKey(newSymmetricKey(), wrappingPublicOf(wk.secret)),
    }] as never;

    expect(seatToPromote([seat], sealed)).toBeNull();
  });

  it('answers null before access is granted, rather than binding to anything', () => {
    /* A seat published and not yet granted has no wrapped key to open. The
     * pending entry waits; it is not consumed. */
    const { sealed } = accountWith([signerOf('sgn_mine', sk.publicKey)], []);
    expect(seatToPromote([seat], sealed)).toBeNull();
  });

  it('finds the right pending entry when this device holds more than one', () => {
    /* The reason the map is keyed by signing public key and not by account:
     * two accepted invites for one company must not be one slot. */
    const other = newSigningKeypair();
    const otherWk = newWrappingKeypair();
    const seats: SealedSeat[] = [
      { signingPublicKey: other.publicKey, signingSecret: other.secret,
        wrappingSecret: otherWk.secret },
      seat,
    ];
    const { sealed } = accountWith(
      [signerOf('sgn_mine', sk.publicKey)],
      [{ signerId: 'sgn_mine', pub: wrappingPublicOf(wk.secret) }]);

    expect(seatToPromote(seats, sealed))
      .toEqual({ signingPublicKey: sk.publicKey, signerId: 'sgn_mine' });
  });

  it('DERIVES this device’s public key rather than reading it off the pending entry', () => {
    /* `C323`: the pending entry is stored in the same bundle as everything else
     * this device holds, so its `signingPublicKey` is a claim. A tampered entry
     * whose stored public key names a stranger's seat must not bind to it. */
    const stranger = newSigningKeypair();
    const tampered: SealedSeat = { ...seat, signingPublicKey: stranger.publicKey };
    const { sealed } = accountWith(
      [signerOf('sgn_stranger', stranger.publicKey)],
      [{ signerId: 'sgn_stranger', pub: wrappingPublicOf(wk.secret) }]);

    expect(seatToPromote([tampered], sealed)).toBeNull();
  });

  it('answers null for a device holding nothing pending', () => {
    const { sealed } = accountWith(
      [signerOf('sgn_mine', sk.publicKey)],
      [{ signerId: 'sgn_mine', pub: wrappingPublicOf(wk.secret) }]);
    expect(seatToPromote([], sealed)).toBeNull();
  });
});
