/**
 * **THE ORDER IS WHAT KEEPS A SEAT PROVABLE, SO THE ORDER IS WHAT IS TESTED.**
 *
 * A leaf published before its key material is sealed, followed by a refused
 * write, seats a signer whose key material never survived: a seat that counts
 * towards N, can never approve, and on an M-of-N account enough of them means
 * nobody can move the money.
 *
 * **THE DOORS ARE STUBS AND THE SCHEME IS NOT.** `SimulatedCommitments` is the
 * real one, so the leaf below is a real leaf and `ownLeafReading` - the check a
 * seated signer's device runs - is asked to agree with it. A test that stubbed
 * the scheme too would prove the sequence calls four functions in an order and
 * nothing about what it published.
 */
import { describe, it, expect } from 'vitest';
import { SimulatedCommitments } from '../../../src/core/ledger.js';
import { ownLeafReading, storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { newSigningKeypair, newWrappingKeypair, newBlinding, type Hex } from '../../../src/core/crypto.js';
import { acceptSeatOnThisDevice, newSeatKeys, type NewSeatKeys, type SeatDoors } from './accept-seat.js';
import { seatBlinding, walletKeyProvedBy } from '../../../src/core/seat-opening.js';
import type { PendingSeat } from './keyring.js';

/** The item at a place in a list; an item that is not there fails the test here rather than being read through. */
const itemAt = <T,>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`expected an item at place ${i}, and the list holds ${xs.length}`);
  return x;
};

const ACCOUNT = 'acc_northwind';

/* The joining person's own wallet key for the company, as their wallet gave it. */
const WALLET = { tag: 'schnorr', value: '4c'.repeat(32) };

/* Fixed, so a failure is reproducible from the output alone. */
const KEYS: NewSeatKeys = {
  signingSecret: '11'.repeat(32),
  signingPublicKey: 'aa'.repeat(32),
  wrappingSecret: '33'.repeat(32),
  wrappingPublicKey: 'bb'.repeat(32),
  salt: '55'.repeat(32),
  blinding: seatBlinding(WALLET, '55'.repeat(32)),
};

/** Every door, recording the order it was called in. */
const doorsThat = (over: Partial<SeatDoors> = {}) => {
  const order: string[] = [];
  const sealed: PendingSeat[] = [];
  const published: Array<Record<string, unknown>> = [];
  const promoted: Array<[Hex, string]> = [];
  const doors: SeatDoors = {
    newKeys: () => { order.push('newKeys'); return KEYS; },
    seal: async (s) => { order.push('seal'); sealed.push(s); },
    publish: async (p) => { order.push('publish'); published.push(p); return { id: 'sgn_new' }; },
    promote: async (pk, id) => { order.push('promote'); promoted.push([pk, id]); },
    ...over,
  };
  return { doors, order, sealed, published, promoted };
};

describe('A leaf cannot reach a roster before its key material is durable', () => {
  it('SEALS BEFORE IT PUBLISHES, and promotes only after', async () => {
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);
    /* The whole property, as a sequence rather than as four separate facts:
     * `indexOf` on two of them would pass for an order with a publish in
     * between. */
    expect(d.order).toEqual(['newKeys', 'seal', 'publish', 'promote']);
  });

  it('PUBLISHES NOTHING when the seal refuses', async () => {
    /* A refused write leaves the key list as it was and rethrows, and at this
     * moment no leaf exists anywhere. */
    const d = doorsThat({ seal: async () => { throw new Error('bundle version conflict'); } });
    await expect(acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET))
      .rejects.toThrow(/version conflict/);
    expect(d.published).toHaveLength(0);
    expect(d.promoted).toHaveLength(0);
  });

  it('leaves the material SEALED when the promotion refuses, so the seat can be finished', async () => {
    /* What happens to a leaf already sent when the step after it fails: the
     * seal has already happened, and the material for the published leaf is
     * durable. `finishPendingSeat` is the
     * door, and it is named in the refusal path rather than implied. */
    const d = doorsThat({ promote: async () => { throw new Error('bundle version conflict'); } });
    await expect(acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET))
      .rejects.toThrow(/version conflict/);
    expect(d.sealed).toHaveLength(1);
    expect(d.published).toHaveLength(1);
    expect(itemAt(d.sealed, 0).blinding).toBe(KEYS.blinding);
    expect(itemAt(d.sealed, 0).signingSecret).toBe(KEYS.signingSecret);
  });

  it('SEALS THE MATERIAL THE PUBLISHED LEAF WAS MADE FROM, not merely some material', async () => {
    /* A seal that stored a fresh blinding would satisfy every ordering
     * assertion above and produce exactly the state this order exists to
     * prevent. So the two are tied together by the check that reads them. */
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);
    const stored = itemAt(d.published, 0).leafCommitment as Hex;
    const reading = ownLeafReading(
      { id: 'sgn_new', leafCommitment: stored }, itemAt(d.sealed, 0), SimulatedCommitments);
    expect(reading.verdict).toBe('agrees');
  });
});

describe('The leaf this path publishes', () => {
  it('is the one definition every writer shares, not a second spelling', async () => {
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);
    expect(itemAt(d.published, 0).leafCommitment).toBe(
      storedSignerLeaf(
        { signingSecret: KEYS.signingSecret, blinding: KEYS.blinding,
          scope: SimulatedCommitments.allVaults() },
        SimulatedCommitments));
  });

  it('is NOT the leaf the old writer made over the ed25519 public key', async () => {
    /*
     * A leaf over the raw ed25519 public key is a seat its own device can never
     * prove, and nothing else executes this writer.
     *
     * The old value is built with the real keypair helpers rather than written
     * out, so this cannot drift into asserting a constant.
     */
    const sk = newSigningKeypair();
    const wk = newWrappingKeypair();
    const blinding = newBlinding();
    const d = doorsThat({
      newKeys: () => ({
        signingSecret: sk.secret, signingPublicKey: sk.publicKey,
        wrappingSecret: wk.secret, wrappingPublicKey: wk.publicKey, blinding, salt: newBlinding(),
      }),
    });
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);

    const theOldWay = SimulatedCommitments.signerLeaf(
      sk.publicKey, blinding, SimulatedCommitments.allVaults());
    expect(itemAt(d.published, 0).leafCommitment).not.toBe(theOldWay);
    /* And the seat the old writer made is one this device would refuse. */
    expect(ownLeafReading(
      { id: 'sgn_new', leafCommitment: theOldWay }, itemAt(d.sealed, 0), SimulatedCommitments).verdict)
      .toBe('disagrees');
  });

  it('sends the two public halves, the leaf and the leaf\'s opening, AND NOTHING ELSE', async () => {
    /* A payload with another field is a secret leaving the device, and `toMatchObject` would not see one. */
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);
    /* RED WHEN: the seat request carries anything beyond the public halves, the leaf and its opening. */
    expect(Object.keys(itemAt(d.published, 0)).sort())
      .toEqual(['leafCommitment', 'opening', 'signingPublicKey', 'wrappingPublicKey']);
    /* RED WHEN: the opening sent is not the one kept with the seat's secrets, so approvers check another leaf's. */
    expect(itemAt(d.published, 0).opening).toEqual(itemAt(d.sealed, 0).opening);
    /* RED WHEN: a seat's secret leaves this device in the seat request. */
    expect(JSON.stringify(itemAt(d.published, 0))).not.toContain(KEYS.signingSecret);
    expect(JSON.stringify(itemAt(d.published, 0))).not.toContain(KEYS.wrappingSecret);
  });

  it('carries the scope the leaf was made under into the material that must reproduce it', async () => {
    /* A seal that dropped the scope would agree today, while every
     * seat written on the day a per-vault scope arrives becomes unreproducible
     * on its own device. */
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);
    expect(itemAt(d.sealed, 0).scope).toBe(SimulatedCommitments.allVaults());
    expect(itemAt(d.sealed, 0).accountId).toBe(ACCOUNT);
    expect(d.promoted[0]).toEqual([KEYS.signingPublicKey, 'sgn_new']);
  });
});

describe('an invitation carried in a link is for one company', () => {
  it('REFUSES an invitation made for another company, before any key is made or anything is sent', async () => {
    const d = doorsThat();
    const other = { accountId: 'acc_elsewhere', nonce: '01'.repeat(32), secret: '02'.repeat(32) };
    /* RED WHEN: keys are made and published for a company the link does not name - the proof is then refused everywhere, after the fact. */
    await expect(acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET, other))
      .rejects.toThrow(/for a different company/u);
    expect(d.order).toEqual([]);
  });
});

describe('a seat\'s leaf commits to the wallet key of the person taking it', () => {
  const leafOf = (o: { publicKey: string; blinding: string; scope: string }) =>
    SimulatedCommitments.signerLeaf(o.publicKey as Hex, o.blinding as Hex, o.scope as Hex);

  it('the leaf published is made with the hash of the wallet key under a fresh salt, and the sealed opening proves that key for it', async () => {
    const d = doorsThat({ newKeys: newSeatKeys });
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors, WALLET);
    const sealed = itemAt(d.sealed, 0);
    const opening = sealed.opening!;
    /* RED WHEN: an invitee's leaf is made with a blinding that does not commit to its wallet key. */
    expect(sealed.blinding).toBe(seatBlinding(WALLET, opening.salt));
    expect(opening.blinding).toBe(sealed.blinding);
    expect(opening.walletKey).toEqual(WALLET);
    /* RED WHEN: the opening kept is not of the leaf published, so it proves nothing on any other device. */
    expect(walletKeyProvedBy(opening, itemAt(d.published, 0).leafCommitment as string, leafOf)).toEqual(WALLET);
    expect(opening.publicKey).toBe(SimulatedCommitments.signerPublicKey(sealed.signingSecret));
    expect(opening.scope).toBe(sealed.scope);
  });

  it('every seat gets its own salt, so two seats for one wallet key are two unlinkable leaves', () => {
    /* RED WHEN: the salt is fixed or derived, so a leaf says whose key it commits to to anybody who guesses the key. */
    const [a, b] = [newSeatKeys(WALLET), newSeatKeys(WALLET)];
    expect(a.salt).not.toBe(b.salt);
    expect(a.blinding).not.toBe(b.blinding);
    expect(a.blinding).toBe(seatBlinding(WALLET, a.salt));
  });
});
