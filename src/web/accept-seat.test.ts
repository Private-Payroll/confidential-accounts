/**
 * **THE ORDER IS THE DEFECT, SO THE ORDER IS WHAT IS TESTED.** `C329`, `C328`,
 * `T-118`, `S34`.
 *
 * `acceptInvite` POSTed the leaf and THEN sealed the keyring. `putBundle` rolls
 * back and rethrows on a version conflict and the three secrets were only ever
 * in that closure, so a conflict at the wrong moment seated a signer whose key
 * material never survived — a seat that counts towards N, can never approve,
 * and on an M-of-N account enough of them means nobody can move the money.
 * `S33` built the detector for that state; this path is one of its factories.
 *
 * **AND UNTIL `S34` NOTHING COULD EXECUTE IT.** No test file in this repository
 * imports `src/web/App.tsx`. What stood in for rule 11 there was a
 * comment-stripped source pin, and `S34`'s `test-auditor` measured what that
 * bought: restoring `C328`'s ed25519 writer at that very line left 187 tests
 * green. The sequence moved out of the screen so a real test could drive it.
 *
 * **THE DOORS ARE STUBS AND THE SCHEME IS NOT.** `SimulatedCommitments` is the
 * real one, so the leaf below is a real leaf and `ownLeafReading` — the check a
 * seated signer's device runs — is asked to agree with it. A test that stubbed
 * the scheme too would prove the sequence calls four functions in an order and
 * nothing about what it published.
 */
import { describe, it, expect } from 'vitest';
import { SimulatedCommitments } from '../core/ledger.js';
import { ownLeafReading, storedSignerLeaf } from '../core/signer-leaf.js';
import { newSigningKeypair, newWrappingKeypair, newBlinding, type Hex } from '../core/crypto.js';
import { acceptSeatOnThisDevice, type NewSeatKeys, type SeatDoors } from './accept-seat.js';
import type { PendingSeat } from './keyring.js';

const ACCOUNT = 'acc_northwind';

/* Fixed, so a failure is reproducible from the output alone. */
const KEYS: NewSeatKeys = {
  signingSecret: '11'.repeat(32),
  signingPublicKey: 'aa'.repeat(32),
  wrappingSecret: '33'.repeat(32),
  wrappingPublicKey: 'bb'.repeat(32),
  blinding: '22'.repeat(32),
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

describe('C329 — a leaf cannot reach a roster before its key material is durable', () => {
  it('SEALS BEFORE IT PUBLISHES, and promotes only after', async () => {
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors);
    /* The whole property, as a sequence rather than as four separate facts:
     * `indexOf` on two of them would pass for an order with a publish in
     * between. */
    expect(d.order).toEqual(['newKeys', 'seal', 'publish', 'promote']);
  });

  it('PUBLISHES NOTHING when the seal refuses', async () => {
    /* The version conflict `C329` is about. `putBundle` rolls the local edit
     * back and rethrows, and the point of the new order is that at this moment
     * no leaf exists anywhere. */
    const d = doorsThat({ seal: async () => { throw new Error('bundle version conflict'); } });
    await expect(acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors))
      .rejects.toThrow(/version conflict/);
    expect(d.published).toHaveLength(0);
    expect(d.promoted).toHaveLength(0);
  });

  it('leaves the material SEALED when the promotion refuses, so the seat can be finished', async () => {
    /* The question `C329` asks: what happens to a leaf already sent when the
     * seal then fails. It cannot fail then — it has already happened — and the
     * material for the published leaf is durable. `finishPendingSeat` is the
     * door, and it is named in the refusal path rather than implied. */
    const d = doorsThat({ promote: async () => { throw new Error('bundle version conflict'); } });
    await expect(acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors))
      .rejects.toThrow(/version conflict/);
    expect(d.sealed).toHaveLength(1);
    expect(d.published).toHaveLength(1);
    expect(d.sealed[0].blinding).toBe(KEYS.blinding);
    expect(d.sealed[0].signingSecret).toBe(KEYS.signingSecret);
  });

  it('SEALS THE MATERIAL THE PUBLISHED LEAF WAS MADE FROM, not merely some material', async () => {
    /* A seal that stored a fresh blinding would satisfy every ordering
     * assertion above and produce exactly the state this round exists to
     * prevent. So the two are tied together by the check that reads them. */
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors);
    const stored = d.published[0].leafCommitment as Hex;
    const reading = ownLeafReading(
      { id: 'sgn_new', leafCommitment: stored }, d.sealed[0], SimulatedCommitments);
    expect(reading.verdict).toBe('agrees');
  });
});

describe('C328 — the leaf this path publishes', () => {
  it('is the one definition every writer shares, not a second spelling', async () => {
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors);
    expect(d.published[0].leafCommitment).toBe(
      storedSignerLeaf(
        { signingSecret: KEYS.signingSecret, blinding: KEYS.blinding,
          scope: SimulatedCommitments.allVaults() },
        SimulatedCommitments));
  });

  it('is NOT the leaf the old writer made over the ed25519 public key', async () => {
    /*
     * **THE REGRESSION GUARD FOR `C328` AT THIS WRITER**, and `S34`'s
     * `test-auditor` is why it exists: it restored the old line here and 187
     * tests stayed green, because nothing in the repository executed this path.
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
        wrappingSecret: wk.secret, wrappingPublicKey: wk.publicKey, blinding,
      }),
    });
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors);

    const theOldWay = SimulatedCommitments.signerLeaf(
      sk.publicKey, blinding, SimulatedCommitments.allVaults());
    expect(d.published[0].leafCommitment).not.toBe(theOldWay);
    /* And the seat the old writer made is one this device would refuse. */
    expect(ownLeafReading(
      { id: 'sgn_new', leafCommitment: theOldWay }, d.sealed[0], SimulatedCommitments).verdict)
      .toBe('disagrees');
  });

  it('sends the two public halves and the leaf, AND NOTHING ELSE', async () => {
    /* Decision 0003, M-106: the blinding lives on one device. A payload with a
     * fourth field is the promise broken, and `toMatchObject` would not see
     * one. */
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors);
    expect(Object.keys(d.published[0]).sort())
      .toEqual(['leafCommitment', 'signingPublicKey', 'wrappingPublicKey']);
    expect(JSON.stringify(d.published[0])).not.toContain(KEYS.blinding);
    expect(JSON.stringify(d.published[0])).not.toContain(KEYS.signingSecret);
    expect(JSON.stringify(d.published[0])).not.toContain(KEYS.wrappingSecret);
  });

  it('carries the scope the leaf was made under into the material that must reproduce it', async () => {
    /* `T-116`. A seal that dropped the scope would agree today, while every
     * seat written on the day a per-vault scope arrives becomes unreproducible
     * on its own device. */
    const d = doorsThat();
    await acceptSeatOnThisDevice(ACCOUNT, SimulatedCommitments, d.doors);
    expect(d.sealed[0].scope).toBe(SimulatedCommitments.allVaults());
    expect(d.sealed[0].accountId).toBe(ACCOUNT);
    expect(d.promoted[0]).toEqual([KEYS.signingPublicKey, 'sgn_new']);
  });
});
