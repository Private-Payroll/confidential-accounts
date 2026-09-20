/**
 * **THE TEST IS THE DELIVERABLE OF `C325`, NOT THE FIX.**
 *
 * The property: a stored `Signer.leafCommitment` that disagrees with the leaf
 * the owning device computes is REFUSED, in its own sentence, distinguishable
 * from the two neighbouring states it is not.
 *
 * **`C306` IS WHY THE EXPECTED VALUES DO NOT COME THROUGH THE CODE UNDER TEST.**
 * A test whose two sides both come from the same function passes for every
 * value of that function, and it cost two money rules their only guard. So:
 *
 *   · the public key is derived with `ed25519.getPublicKey` DIRECTLY, never
 *     through `signingPublicKeyOf`, which is the function `ownLeafReading`
 *     calls;
 *   · the expected leaf is built by a SECOND, INDEPENDENT implementation of the
 *     construction `SimulatedCommitments.signerLeaf` documents — noble
 *     primitives and string literals, no import from `ledger.ts`;
 *   · the disagreement cases use HAND-BUILT stored values that no function in
 *     this repository produced.
 *
 * **AND THE INDEPENDENT IMPLEMENTATION IS ALSO A GUARD, DELIBERATELY.** If a
 * later round moves `SimulatedCommitments.signerLeaf`, `agrees on a seat this
 * device really owns` goes red — which is precisely the alarm `C325` exists
 * for. `S32` moved the CONTRACT's `signerLeaf` and nothing anywhere went red,
 * and that silence is the whole row.
 *
 * ---
 *
 * **WHAT `S34` CHANGED HERE, AND THE SOURCE PIN THAT IS GONE.** `C328`,
 *
 *
 *   · The public half is no longer an ed25519 key. The contract reads
 *     `persistentHash([tag, sk])` and both product writers passed
 *     `ed25519.getPublicKey(sk)`, which is different, uncorrelated 32 bytes.
 *     The derivation now goes through `CommitmentScheme.signerPublicKey`, and
 *     `publicKeyOf` below survives as a NEGATIVE control: there is a test that
 *     the derived leaf is not the one the old writers made.
 *   · The device's material carries a `scope`, and a seat stored under a
 *     non-default one is reproduced rather than reported as a mismatch.
 *
 *   · **THE SOURCE PIN OVER `src/web/App.tsx` IS DELETED, NOT DOUBLED.**
 *     It asserted that `openAccount` called the check exactly once,
 *     and `S34` found the fourth defeat its own comment predicted: `loadDemo`
 *     built a session without entering `openAccount` at all, so a second door
 *     into the product skipped the refusal with the pin green. What replaces it
 *     is `seatOnThisDevice`, whose result `Session` requires and whose brand is
 *     not exported — so the check is not something a screen is pinned into
 *     calling, it is the only way to obtain a value the screen cannot render
 *     without. Two guards where one is weaker teaches a reader to trust the
 *     weaker one, so there is one.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { redactSecrets } from './redact-secrets.js';
import { SimulatedCommitments } from './ledger.js';
import { ownLeafReading, requireOwnLeaf, seatOnThisDevice } from './signer-leaf.js';

/* Fixed device material. Deterministic on purpose: a random keypair would make
 * a failure impossible to reproduce from the output alone. */
const SIGNING_SECRET = '11'.repeat(32);
const BLINDING = '22'.repeat(32);
const STRANGER_SECRET = '33'.repeat(32);
const OTHER_BLINDING = '44'.repeat(32);

/* A stored value no derivation produced, and NOT a repeating one: `de`.repeat(32)
 * has the same sixteen characters in every window, so an assertion that the
 * refusal printed "its first sixteen" could not tell which sixteen it printed. */
const HAND_BUILT = '0123456789abcdef' + 'fedcba9876543210' + '00112233445566778899aabbccddeeff';

/**
 * **ed25519, STRAIGHT FROM THE CURVE — AND IT IS HERE AS A NEGATIVE CONTROL
 * NOW.**
 *
 * This used to be what the derivation was checked against, because it was what
 * the writers passed. It is what the writers must never pass again: the leaf
 * built over it is not the leaf `requireSigner()` looks for.
 */
const publicKeyOf = (secretHex: string): string =>
  bytesToHex(ed25519.getPublicKey(hexToBytes(secretHex)));

/** The default scope, written out rather than read off the scheme. */
const ALL_VAULTS = bytesToHex(sha256(new TextEncoder().encode('midnight-accounts:scope:all')));

/**
 * A SECOND IMPLEMENTATION of what `SimulatedCommitments.signerPublicKey`
 * documents, from the description and not from the code:
 *
 *   signerPublicKey(sk) = hmac(sha256, sk, "simulated-signer-pk")
 *
 * Deliberately unlike the contract's `persistentHash([tag, sk])` — `S32`'s rule
 * that the simulated scheme must never agree with the chain's.
 */
const independentPk = (secretHex: string): string =>
  bytesToHex(hmac(sha256, hexToBytes(secretHex), new TextEncoder().encode('simulated-signer-pk')));

/**
 * A SECOND IMPLEMENTATION of what `SimulatedCommitments` documents, written
 * from the description rather than imported from it:
 *
 *   signerLeaf(pk, blinding, scope) = hmac(sha256, blinding, "signer-leaf:<pk>:<scope>")
 *   scope (defaulted)               = sha256("midnight-accounts:scope:all")
 *
 * If this and the scheme ever stop agreeing, one of them moved.
 */
const independentLeaf = (publicKey: string, blinding: string, scope = ALL_VAULTS): string =>
  bytesToHex(hmac(
    sha256,
    hexToBytes(blinding),
    new TextEncoder().encode('signer-leaf:' + publicKey + ':' + scope),
  ));

/** The whole derivation, independently, from a secret. */
const independentFrom = (secretHex: string, blinding: string, scope = ALL_VAULTS): string =>
  independentLeaf(independentPk(secretHex), blinding, scope);

const device = { signingSecret: SIGNING_SECRET, blinding: BLINDING };
const seatWith = (leaf: string | null) => ({ id: 'sgn_abcdefghij', leafCommitment: leaf });

describe('the stored signer leaf, against the device that has to reproduce it', () => {
  /* ------------------------------------------------------------------ *
   * THE ONE THAT MUST FAIL WHEN THE TWO DISAGREE
   * ------------------------------------------------------------------ */

  it('REFUSES a stored leaf this device does not compute', () => {
    /* Hand-built. Sixty-four hex characters that no derivation in this
     * repository produced, which is what makes this side independent. */
    const stored = HAND_BUILT;
    expect(stored).toHaveLength(64);

    const reading = ownLeafReading(seatWith(stored), device, SimulatedCommitments);

    expect(reading.verdict).toBe('disagrees');
    expect(reading.stored).toBe(stored);
    /* The derived side is asserted against the independent construction rather
     * than merely "not the stored one", which excludes one value out of all of
     * them. */
    expect(reading.derived).toBe(independentFrom(SIGNING_SECRET, BLINDING));
    expect(() => requireOwnLeaf(reading)).toThrow(/COMPUTES A DIFFERENT LEAF/);
  });

  it('refuses a leaf that agrees for 62 of its 64 characters', () => {
    /* `C320`'s test-coverage pass finding, applied here before an auditor has to:
     * a comparison that reads one character passes every fixture that differs
     * everywhere. This one differs in the last two. */
    const real = independentFrom(SIGNING_SECRET, BLINDING);
    const nearly = real.slice(0, 62) + (real.endsWith('00') ? '11' : '00');
    expect(nearly).not.toBe(real);
    expect(nearly.slice(0, 62)).toBe(real.slice(0, 62));

    expect(ownLeafReading(seatWith(nearly), device, SimulatedCommitments).verdict)
      .toBe('disagrees');
  });

  it('REFUSES when the blinding on this device is not the one the leaf was built from', () => {
    /* **THE REALISTIC CASE, AND EVERY OTHER TEST HERE VARIES THE STORED SIDE.**
     * `S33`'s test-coverage pass mutated the derivation to ignore `device.blinding`
     * entirely and thirteen tests stayed green, because one device was used
     * throughout. A blinding restored from the wrong backup, or lost and
     * replaced, is what `C325` is actually about: the record is right, the
     * device is not, and the seat is dead either way. */
    const stored = independentFrom(SIGNING_SECRET, BLINDING);
    const restoredWrong = { signingSecret: SIGNING_SECRET, blinding: OTHER_BLINDING };

    const reading = ownLeafReading(seatWith(stored), restoredWrong, SimulatedCommitments);

    expect(reading.verdict).toBe('disagrees');
    expect(reading.derived).toBe(independentFrom(SIGNING_SECRET, OTHER_BLINDING));
    expect(() => requireOwnLeaf(reading)).toThrow(/COMPUTES A DIFFERENT LEAF/);
  });

  it('REFUSES when the signing secret on this device is not the one the leaf was built from', () => {
    /* The mirror of the case above, and the reason the derivation may not
     * ignore either half of the material. */
    const stored = independentFrom(SIGNING_SECRET, BLINDING);
    const wrongKey = { signingSecret: STRANGER_SECRET, blinding: BLINDING };

    const reading = ownLeafReading(seatWith(stored), wrongKey, SimulatedCommitments);

    expect(reading.verdict).toBe('disagrees');
    expect(reading.derived).toBe(independentFrom(STRANGER_SECRET, BLINDING));
    expect(() => requireOwnLeaf(reading)).toThrow(/COMPUTES A DIFFERENT LEAF/);
  });

  it('refuses a roster substituted whole, because the key is DERIVED and not read', () => {
    /* `C323`: a check that compares two stored claims agrees with a record
     * that was replaced in its entirety. The stored leaf here is a real leaf —
     * a STRANGER'S — computed over this device's own blinding, so only a check
     * that derives the public key from THIS device's secret can tell. */
    const strangers = independentFrom(STRANGER_SECRET, BLINDING);

    expect(ownLeafReading(seatWith(strangers), device, SimulatedCommitments).verdict)
      .toBe('disagrees');
  });

  /* ------------------------------------------------------------------ *
   * AND THE THREE STATES THAT ARE NOT THAT ONE
   * ------------------------------------------------------------------ */

  it('agrees on a seat this device really owns', () => {
    const stored = independentFrom(SIGNING_SECRET, BLINDING);

    const reading = ownLeafReading(seatWith(stored), device, SimulatedCommitments);

    expect(reading.verdict).toBe('agrees');
    expect(reading.derived).toBe(stored);
    expect(() => requireOwnLeaf(reading)).not.toThrow();
  });

  it('agrees on a stored leaf recorded in UPPER case', () => {
    /* `S31`'s test-coverage pass finding, applied here before an auditor has to:
     * dropping `.toLowerCase()` survived every mutation there because every
     * fixture was already lower case, and what it costs on a real record is a
     * present, correct leaf reported as a mismatch — a lockout invented by the
     * check that exists to prevent one. */
    const stored = independentFrom(SIGNING_SECRET, BLINDING).toUpperCase();
    expect(stored).not.toBe(independentFrom(SIGNING_SECRET, BLINDING));

    const reading = ownLeafReading(seatWith(stored), device, SimulatedCommitments);

    expect(reading.verdict).toBe('agrees');
    expect(() => requireOwnLeaf(reading)).not.toThrow();
  });

  it('says no-stored-leaf for a signer created before M-13, and does not refuse', () => {
    const reading = ownLeafReading(seatWith(null), device, SimulatedCommitments);

    expect(reading.verdict).toBe('no-stored-leaf');
    expect(reading.stored).toBeNull();
    /* Reading their own company is not what a null leaf costs them. `refFor`
     * refuses at the moment they try to ACT, and that refusal already exists. */
    expect(() => requireOwnLeaf(reading)).not.toThrow();
  });

  it('says no-seat when the roster holds no signer with this id, and does not refuse', () => {
    /* `App.tsx` finds the seat by id and can miss — a removed signer, a stale
     * keyring entry. Calling that "no stored leaf" would tell somebody their
     * seat predates M-13 when the truth is they have no seat, and the two have
     * different remedies. `refFor` says "not a signer on this account". */
    const reading = ownLeafReading(undefined, device, SimulatedCommitments);

    expect(reading.verdict).toBe('no-seat');
    /* Both fields asserted to a value. `not.toBeNull()` passes for every string
     * there is, and `signerId` had a fallback nothing read. */
    expect(reading.signerId).toBe('(no seat)');
    expect(reading.derived).toBe(independentFrom(SIGNING_SECRET, BLINDING));
    expect(() => requireOwnLeaf(reading)).not.toThrow();
  });

  it('says no-device-key when no material was offered at all, and does not refuse', () => {
    const reading = ownLeafReading(seatWith(HAND_BUILT), null, SimulatedCommitments);

    expect(reading.verdict).toBe('no-device-key');
    expect(reading.derived).toBeNull();
    expect(() => requireOwnLeaf(reading)).not.toThrow();
  });

  it('REFUSES key material that is here and is not usable, which is not the same state', () => {
    /* An entry exists for this seat and it cannot produce a leaf. That is a
     * device holding a seat it can never prove — `disagrees` arriving by the
     * other door — and passing it would show an active signer whose every
     * approval fails inside a proof, which is M-69's defect. */
    for (const held of [
      { signingSecret: '', blinding: BLINDING },
      { signingSecret: SIGNING_SECRET, blinding: 'not-hex' },
      { signingSecret: SIGNING_SECRET.slice(0, 62), blinding: BLINDING },
      /* ANCHORED, and unanchored survives without these two: a keyring entry
       * that CONTAINS 64 hex characters is not one that IS 64 hex characters,
       * and the difference is a named refusal against a raw throw out of
       * `hexToBytes`. */
      { signingSecret: '0x' + SIGNING_SECRET, blinding: BLINDING },
      { signingSecret: SIGNING_SECRET + SIGNING_SECRET, blinding: BLINDING },
    ]) {
      const reading = ownLeafReading(seatWith(HAND_BUILT), held as never, SimulatedCommitments);
      expect(reading.verdict).toBe('device-key-unusable');
      expect(reading.derived).toBeNull();
      expect(() => requireOwnLeaf(reading)).toThrow(/NOT A SIGNING SECRET AND A BLINDING/);
    }
  });

  it('keeps the unusable-material refusal distinguishable from its two neighbours', () => {
    const reading = ownLeafReading(
      seatWith(HAND_BUILT), { signingSecret: '', blinding: BLINDING } as never,
      SimulatedCommitments);
    let message = '';
    try { requireOwnLeaf(reading); } catch (e: any) { message = String(e.message); }

    expect(message).toContain('NOT the case of no keys being saved for this company');
    expect(message).toContain('nothing can be derived from what is here to mismatch with');
    expect(message).not.toContain('COMPUTES A DIFFERENT LEAF');
  });

  /* ------------------------------------------------------------------ *
   * THE REFUSAL TELLS A PERSON WHICH CASE THEY ARE IN
   * ------------------------------------------------------------------ */

  it('names the seat and both values, and denies the two cases it is not', () => {
    const stored = HAND_BUILT;
    const reading = ownLeafReading(seatWith(stored), device, SimulatedCommitments);

    let message = '';
    try { requireOwnLeaf(reading); } catch (e: any) { message = String(e.message); }

    expect(message).toContain('sgn_abcdefghij');
    /* **EACH VALUE UNDER ITS OWN LABEL**, not merely present somewhere. The two
     * remedies invert with the labels — restore this device's bundle, or
     * replace the seat — so a message that swaps them is `C320`'s confusion
     * with extra steps, and `toContain` on both halves cannot see it. */
    expect(message).toMatch(new RegExp('roster records\\s+' + stored.slice(0, 16)));
    expect(message).toMatch(new RegExp('device computes\\s+' + reading.derived!.slice(0, 16)));
    /* It denies them rather than being silent about them — `C320`'s rule that a
     * refusal which could be mistaken for its neighbour is the defect. */
    expect(message).toContain('NOT the case of no keys being saved for this company');
    expect(message).toContain('this seat has no leaf');
    /* And it does not promise a door that does not exist. */
    expect(message).toMatch(/NO DOOR THAT REPAIRS A RECORDED LEAF IN PLACE/);
    /* Rule 19: it names a door that resolves it, and says plainly when neither
     * door applies rather than sending somebody to one that cannot work. */
    expect(message).toMatch(/restoring the key bundle/);
    expect(message).toMatch(/IF EVERY DEVICE ON THIS ACCOUNT REPORTS THIS/);
    expect(message).toMatch(/NOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN/);
  });

  it('survives the redaction every shown error goes through', () => {
    /*
     * **THE SIXTEEN CHARACTERS ARE LOAD-BEARING AND NOTHING SAID SO.** `C145`,
     * Every sentence this application shows goes through
     * `shownError`, which redacts any run of 32-or-more hex characters before
     * a person or a report sees it. A refusal printing 32 — never mind the
     * whole 64 — reaches the screen as `<redacted:hex>` and tells the person
     * nothing, which is the exact opposite of a refusal that says which case
     * they are in. Measured by `S33`'s test-coverage pass, pinned here.
     */
    const stored = HAND_BUILT;
    const reading = ownLeafReading(seatWith(stored), device, SimulatedCommitments);
    let message = '';
    try { requireOwnLeaf(reading); } catch (e: any) { message = String(e.message); }

    const shown = redactSecrets(message);
    expect(shown).not.toContain('<redacted:hex>');
    expect(shown).toContain(stored.slice(0, 16));
    expect(shown).toContain(reading.derived!.slice(0, 16));
  });

  /* ------------------------------------------------------------------ *
   * THE CALL SITE — A TYPE, NOT A PIN.
   * ------------------------------------------------------------------ */

  it('seatOnThisDevice REFUSES a mismatch and returns nothing a session can be built from', () => {
    /*
     * **THIS REPLACES THE SOURCE PIN OVER `src/web/App.tsx`, AND THE PIN IS
     * DELETED RATHER THAN LEFT BESIDE IT.**
     *
     * The pin asserted that `openAccount` called the check exactly once, with
     * the text stripped of comments. It could not see semantics: its own
     * round's test-coverage pass defeated the first version three ways with the
     * text intact, and `S34` found the fourth without looking — `loadDemo`
     * built a `Session` without entering `openAccount`, so the pin counted
     * calls in one function while a second door skipped the refusal entirely.
     *
     * What is asserted here instead is the thing the screen cannot get around:
     * `Session.seat` is a `SeatOnThisDevice`, its brand is a symbol
     * `signer-leaf.ts` does not export, and this function is the only source of
     * one — so a door that skips the check does not compile. **The property is
     * enforced by the type, and this test is what proves the constructor
     * refuses** rather than handing back a token for a seat that disagrees.
     */
    expect(() => seatOnThisDevice(seatWith(HAND_BUILT), device, SimulatedCommitments))
      .toThrow(/COMPUTES A DIFFERENT LEAF/);
    expect(() => seatOnThisDevice(
      seatWith(HAND_BUILT), { signingSecret: '', blinding: BLINDING } as never,
      SimulatedCommitments)).toThrow(/NOT A SIGNING SECRET AND A BLINDING/);
  });

  it('seatOnThisDevice carries the verdict for the four states that are allowed to pass', () => {
    /* It is not a claim that the seat can act — `refFor` is what refuses at the
     * moment of acting, and locking somebody out of READING their own company
     * would be the new lockout `C325`'s round existed to avoid. So the token
     * says which of the four a person is in rather than asserting one. */
    const owned = independentFrom(SIGNING_SECRET, BLINDING);
    expect(seatOnThisDevice(seatWith(owned), device, SimulatedCommitments).verdict).toBe('agrees');
    expect(seatOnThisDevice(seatWith(null), device, SimulatedCommitments).verdict)
      .toBe('no-stored-leaf');
    expect(seatOnThisDevice(undefined, device, SimulatedCommitments).verdict).toBe('no-seat');
    expect(seatOnThisDevice(seatWith(owned), null, SimulatedCommitments).verdict)
      .toBe('no-device-key');
    expect(seatOnThisDevice(seatWith(owned), device, SimulatedCommitments).signerId)
      .toBe('sgn_abcdefghij');
  });

  /* ------------------------------------------------------------------ *
   * THE PUBLIC HALF IS THE SCHEME'S AND NOT THE CURVE'S. `C328`
   * ------------------------------------------------------------------ */

  it('does NOT compute the leaf the old writers wrote, which is the whole of C328', () => {
    /*
     * **THE REGRESSION GUARD FOR THE DEFECT THIS ROUND EXISTS TO FIX.**
     *
     * Until `S34` both product writers passed `ed25519.getPublicKey(sk)` as the
     * public half, while the contract's `requireSigner()` looks for a leaf over
     * `signerPublicKey(sk)` — a domain-separated hash of the SECRET. Different,
     * uncorrelated 32 bytes, so every seat this product had written was one no
     * device could ever prove.
     *
     * A test that only asserted the new value would pass if somebody put the
     * old one back beside it. This asserts the old value is REFUSED, which is
     * the property that actually matters: a seat written the old way is a
     * mismatch on the device that owns it, and it says so.
     */
    const theOldWay = independentLeaf(publicKeyOf(SIGNING_SECRET), BLINDING);
    const theNewWay = independentFrom(SIGNING_SECRET, BLINDING);
    expect(theOldWay).not.toBe(theNewWay);

    const reading = ownLeafReading(seatWith(theOldWay), device, SimulatedCommitments);
    expect(reading.verdict).toBe('disagrees');
    expect(reading.derived).toBe(theNewWay);
  });

  it('derives the public half from the SECRET, so a stranger holding the ed25519 key is out', () => {
    /* The public key is on the roster (`Signer.signingPublicKey`) and is what
     * an approval SIGNATURE is checked against, so it is a value anybody on the
     * account can read. If the leaf were still built over it, holding the
     * roster would be holding the public half of every seat. It is now built
     * over material that never leaves the device. */
    expect(SimulatedCommitments.signerPublicKey(SIGNING_SECRET))
      .toBe(independentPk(SIGNING_SECRET));
    expect(SimulatedCommitments.signerPublicKey(SIGNING_SECRET))
      .not.toBe(publicKeyOf(SIGNING_SECRET));
    expect(SimulatedCommitments.signerPublicKey(SIGNING_SECRET))
      .not.toBe(SimulatedCommitments.signerPublicKey(STRANGER_SECRET));
  });

  /* ------------------------------------------------------------------ *
   * THE SCOPE TRAVELS WITH THE SEAT.
   * ------------------------------------------------------------------ */

  it('a leaf stored under a NON-DEFAULT scope is not reported as a mismatch', () => {
    /*
     * **`T-116`'s *Done when*, and the day it was written for.** `S33` left a
     * note in `signer-leaf.ts` saying the check derived under the scheme's
     * `allVaults()` default because both writers passed two arguments, and that
     * **nothing would go red the day a writer passed one explicitly** — the
     * first seat written under a per-vault scope would be a seat its own device
     * could not reproduce, and the check would invent the lockout it exists to
     * prevent.
     *
     * The scope now travels with the device's material, from the same place the
     * writer took it. This is the assertion that it does.
     */
    const PER_VAULT = 'a1'.repeat(32);
    expect(PER_VAULT).not.toBe(ALL_VAULTS);

    const stored = independentFrom(SIGNING_SECRET, BLINDING, PER_VAULT);
    /* It really is a different leaf — otherwise this test would pass for a
     * derivation that dropped the scope entirely, which is `S33`'s
     * test-coverage pass finding about the blinding, one argument along. */
    expect(stored).not.toBe(independentFrom(SIGNING_SECRET, BLINDING));

    const scoped = { signingSecret: SIGNING_SECRET, blinding: BLINDING, scope: PER_VAULT };
    const reading = ownLeafReading(seatWith(stored), scoped, SimulatedCommitments);
    expect(reading.verdict).toBe('agrees');
    expect(reading.derived).toBe(stored);
    expect(() => requireOwnLeaf(reading)).not.toThrow();
  });

  it('a device carrying the WRONG scope is a mismatch, and says so', () => {
    /* The mirror, and the reason the fallback may not be "whatever agrees". */
    const PER_VAULT = 'a1'.repeat(32);
    const stored = independentFrom(SIGNING_SECRET, BLINDING, PER_VAULT);

    const reading = ownLeafReading(seatWith(stored), device, SimulatedCommitments);
    expect(reading.verdict).toBe('disagrees');
    expect(() => requireOwnLeaf(reading)).toThrow(/COMPUTES A DIFFERENT LEAF/);
  });

  it('an absent scope means allVaults(), which is what every seat before S34 was made under', () => {
    /* A bundle sealed before `S34` has no scope field. Reading a missing value
     * as anything but the scheme's default would report every one of those
     * seats as a mismatch — the same invented lockout, arriving on an upgrade
     * instead of on a feature. */
    const stored = independentFrom(SIGNING_SECRET, BLINDING, ALL_VAULTS);
    expect(ownLeafReading(seatWith(stored), device, SimulatedCommitments).verdict).toBe('agrees');
    expect(ownLeafReading(
      seatWith(stored), { ...device, scope: SimulatedCommitments.allVaults() },
      SimulatedCommitments).verdict).toBe('agrees');
  });

  /* ------------------------------------------------------------------ *
   * THE SCHEME ITSELF
   * ------------------------------------------------------------------ */

  it('derives what SimulatedCommitments derives, by a route that does not call it', () => {
    /* The two sides of this one are the scheme and a reimplementation of its
     * documented construction. It is the guard `S32` did not have: a round that
     * moves the client derivation turns this red, and every leaf already stored
     * under the old one is unreproducible from that moment.
     *
     * The CONTRACT's `signerLeaf` has no pinned vector and is not pinned here
     * either — reading it needs the live circuit, which is not a session's
     * (`contracts/test/commitments.test.ts:583`, and it is owed there). */
    const pk = SimulatedCommitments.signerPublicKey(SIGNING_SECRET);
    expect(SimulatedCommitments.signerLeaf(pk, BLINDING)).toBe(independentLeaf(pk, BLINDING));
    /* And with the third argument passed, which is what both writers do since
     * The defaulted and the explicit call must be the same value or
     * every seat written before this round is unreproducible. */
    expect(SimulatedCommitments.signerLeaf(pk, BLINDING, SimulatedCommitments.allVaults()))
      .toBe(independentLeaf(pk, BLINDING));
  });
});
