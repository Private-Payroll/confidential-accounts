import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import {
  MAX_PIECES, RecoveryError, checkPlan, combinePieces, fingerprintOf, hasNoMargin,
  proveRecoverable, splitSecret, suggestDefault, warningsFor,
} from './pieces.js';
import type { Placement } from './pieces.js';
import { identityFromSecret, newSecret, secretFromWords, wordsFromSecret } from '../keys/derivation.js';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * ASSERTS BOTH HALVES: that it threw, and that it threw the right thing.
 *
 * This exists because three tests in this file were written as a bare
 * `try { ... } catch (e) { expect(code) }`, and **a bare try/catch passes when
 * nothing is thrown at all** — the catch simply never runs. Removing the
 * unreachable-threshold guard left the whole file green. A helper, so the shape
 * cannot come back.
 */
/** The same helper for something asynchronous. */
const refusesAsync = async (what: () => Promise<unknown>, code: string): Promise<void> => {
  let thrown: unknown;
  try {
    await what();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected this to be refused, and it was not').toBeInstanceOf(RecoveryError);
  expect((thrown as RecoveryError).code).toBe(code);
};

/** A byte inside the SHARE, past the header, so the header stays honest. */
const damageShare = (piece: Uint8Array, at = 4): Uint8Array =>
  Uint8Array.from(piece, (b, i) => (i === 10 + at ? b ^ 0xff : b));

const refuses = (what: () => unknown, code: string): void => {
  let thrown: unknown;
  try {
    what();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected this to be refused, and it was not').toBeInstanceOf(RecoveryError);
  expect((thrown as RecoveryError).code).toBe(code);
};

const place = (label: string, holder: string, isThisDevice = false): Placement =>
  ({ label, holder, ...(isThisDevice ? { isThisDevice } : {}) });

const THREE: readonly Placement[] = [
  place('Your Google account', 'google:person@example.com'),
  place('Printed', 'paper'),
  place('My other laptop', 'device:laptop-2'),
];

describe('cutting a secret into pieces and putting it back', () => {
  it('rebuilds the SAME secret, and therefore the same wallet', async () => {
    const secret = secretFromWords(TEST_MNEMONIC);
    const set = await splitSecret(secret, THREE, 2);
    const rebuilt = await combinePieces([set.pieces[0]!.bytes, set.pieces[2]!.bytes]);
    expect(hex(rebuilt)).toBe(hex(secret));

    /* The thing that actually matters: the money comes back too. */
    expect(identityFromSecret(rebuilt).money.zswap).toEqual(identityFromSecret(secret).money.zswap);
  });

  it('gives back the WORDS, which is the whole reason the small number is split — §7.4', async () => {
    const secret = secretFromWords(TEST_MNEMONIC);
    const set = await splitSecret(secret, THREE, 2);
    const rebuilt = await combinePieces([set.pieces[1]!.bytes, set.pieces[2]!.bytes]);
    expect(wordsFromSecret(rebuilt).join(' ')).toBe(TEST_MNEMONIC);
  });

  it('works from EVERY minimum-sized combination, not just the one somebody tried', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, THREE, 2);
    const [a, b, c] = set.pieces.map((p) => p.bytes) as [Uint8Array, Uint8Array, Uint8Array];
    for (const subset of [[a, b], [a, c], [b, c], [a, b, c]]) {
      expect(hex(await combinePieces(subset))).toBe(hex(secret));
    }
  });

  it('REFUSES BELOW THE THRESHOLD rather than returning a wrong answer', async () => {
    /*
     * The threshold travels on the pieces, so this does not depend on anybody
     * remembering it. Before that, two pieces of a three-of-three set combined
     * happily into thirty-two well-formed bytes that were not the secret — a
     * valid wallet at a place nobody had ever paid into, presented as a
     * successful recovery.
     */
    const secret = newSecret();
    const set = await splitSecret(secret, THREE, 3);
    await refusesAsync(() => combinePieces([set.pieces[0]!.bytes]), 'not-enough-pieces');
    await refusesAsync(
      () => combinePieces([set.pieces[0]!.bytes, set.pieces[1]!.bytes]), 'not-enough-pieces');
    /* All three, and it is right. */
    expect(hex(await combinePieces(set.pieces.map((p) => p.bytes)))).toBe(hex(secret));
  });

  it('REFUSES PIECES FROM TWO DIFFERENT SETS', async () => {
    /*
     * The ordinary door: anybody who has re-cut their pieces has an older set
     * sitting in the same folder under the same name. Mixed with the right
     * count, Shamir returns an answer rather than an error.
     *
     * The previous version of this test was named for this refusal and asserted
     * nothing that could fail — it compared a 32-byte secret against a 33-byte
     * share. A green test named for a refusal that does not happen is worse
     * than no test.
     */
    const one = await splitSecret(newSecret(), THREE, 2);
    const two = await splitSecret(newSecret(), THREE, 2);
    await refusesAsync(
      () => combinePieces([one.pieces[0]!.bytes, two.pieces[1]!.bytes]),
      'pieces-from-different-sets');
  });

  it('refuses a piece that is not one, or is from a future format', async () => {
    const set = await splitSecret(newSecret(), THREE, 2);
    await refusesAsync(
      () => combinePieces([new Uint8Array(4), set.pieces[1]!.bytes]), 'not-a-piece');
    const future = Uint8Array.from(set.pieces[0]!.bytes);
    future[0] = 9;
    await refusesAsync(() => combinePieces([future, set.pieces[1]!.bytes]), 'not-a-piece');
  });

  it('REFUSES A REBUILT ANSWER THAT IS NOT THE ACCOUNT, the silent one', async () => {
    /*
     * The last line of defence, and the one the earlier version of this file
     * said was impossible: *"it cannot, because there is nothing here to check
     * it against."* There is. The fingerprint is a one-way function of the
     * secret and it rides on every piece.
     *
     * Here the header is left intact and the SHARE is damaged, so every
     * cheaper check passes — same set, same threshold, right count — and only
     * the fingerprint catches it.
     */
    const set = await splitSecret(newSecret(), THREE, 2);
    await refusesAsync(
      () => combinePieces([damageShare(set.pieces[0]!.bytes), set.pieces[1]!.bytes]),
      'wrong-secret');
  });

  it('RECOVERS FROM ANY WORKING SUBSET, not just the first pieces offered', async () => {
    /*
     * Four pieces, two needed, one of them damaged. Taking the first two
     * refused and a different two would have worked — so whether somebody got
     * their account back depended on the ORDER they happened to fetch things
     * in, and the message told them a piece had been altered rather than to try
     * again. On the day somebody is recovering, that difference is the product.
     */
    const secret = newSecret();
    const four = [...THREE, place('A hardware key', 'yubikey:1')];
    const set = await splitSecret(secret, four, 2);
    const bytes = set.pieces.map((p) => p.bytes);
    const damaged = [damageShare(bytes[0]!), bytes[1]!, bytes[2]!, bytes[3]!];

    expect(hex(await combinePieces(damaged))).toBe(hex(secret));
    /* And in every order, because nothing here depends on one. */
    expect(hex(await combinePieces([...damaged].reverse()))).toBe(hex(secret));
    expect(hex(await combinePieces([damaged[3]!, damaged[1]!]))).toBe(hex(secret));

    /*
     * And the damaged piece is still refused when it is the ONLY way to reach
     * the threshold — the search is exhaustive, not lenient. Two pieces, one of
     * them altered, is a set that genuinely cannot be rebuilt.
     */
    await refusesAsync(
      () => combinePieces([damaged[0]!, damaged[1]!]), 'wrong-secret');
  });

  it('REFUSES TWO SETS CUT FROM THE SAME ACCOUNT — which is the ordinary case', async () => {
    /*
     * The fingerprint identifies the SECRET, so re-cutting the same secret — the
     * ordinary reason anybody has two sets, and exactly what this file
     * describes — produced two sets that agreed on every header field. The gate
     * credited with catching it did no work in the one scenario it was written
     * for. A random id per cut fixes that.
     */
    const secret = newSecret();
    const first = await splitSecret(secret, THREE, 2);
    const second = await splitSecret(secret, THREE, 2);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.setId).not.toBe(second.setId);
    await refusesAsync(
      () => combinePieces([first.pieces[0]!.bytes, second.pieces[1]!.bytes]),
      'pieces-from-different-sets');
  });

  it('REFUSES MORE PIECES THAN IT EVER CUTS, because the search is C(n,k)', async () => {
    /*
     * A piece's header is cleartext, so extra structurally-valid pieces can be
     * forged and offered under invented names. The subset search is bounded
     * only by this cap: sixteen pieces is about a fifth of a second and twenty
     * is six seconds — a way to hang somebody's recovery screen while they are
     * already frightened.
     */
    const set = await splitSecret(newSecret(), THREE, 2);
    const many = Array.from({ length: MAX_PIECES + 1 }, () => set.pieces[0]!.bytes);
    await refusesAsync(() => combinePieces(many), 'too-many-pieces');

    /* And the cap itself is still allowed. */
    const wide = Array.from({ length: MAX_PIECES }, (_, i) => place(`p${i}`, `holder-${i}`));
    const big = await splitSecret(newSecret(), wide, 2);
    await expect(combinePieces(big.pieces.slice(0, MAX_PIECES).map((p) => p.bytes)))
      .resolves.toBeTruthy();
  });

  it('refuses a piece claiming a threshold this library never writes', async () => {
    const set = await splitSecret(newSecret(), THREE, 2);
    for (const claimed of [0, 1, 17, 255]) {
      const forged = Uint8Array.from(set.pieces[0]!.bytes);
      forged[1] = claimed;
      await refusesAsync(() => combinePieces([forged, set.pieces[1]!.bytes]), 'not-a-piece');
    }
  });

  it('carries a fingerprint that identifies the secret without revealing it', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, THREE, 2);
    expect(set.fingerprint).toBe(hex(fingerprintOf(secret)));
    expect(set.fingerprint).toHaveLength(16);
    /* Eight bytes, one-way, and nothing of the secret is in it. */
    expect(hex(secret)).not.toContain(set.fingerprint);
    expect((await splitSecret(newSecret(), THREE, 2)).fingerprint).not.toBe(set.fingerprint);
    /* And the same secret always fingerprints the same, so a re-cut set is
     * recognisably the same account. */
    expect((await splitSecret(secret, THREE, 3)).fingerprint).toBe(set.fingerprint);
  });

  it('keeps the placement with the piece, so a set knows where its pieces went', async () => {
    const set = await splitSecret(newSecret(), THREE, 2);
    expect(set.pieces.map((p) => p.placement.label)).toEqual(THREE.map((p) => p.label));
    expect(set.threshold).toBe(2);
    expect(Object.isFrozen(set)).toBe(true);
  });
});

describe('the rules, all of which refuse rather than warn', () => {
  it('refuses a threshold of one — that is not a threshold, it is copies', () => {
    refuses(() => checkPlan(THREE, 1), 'threshold-of-one');
    refuses(() => checkPlan(THREE, 0), 'threshold-of-one');
    refuses(() => checkPlan(THREE, -1), 'threshold-of-one');
  });

  it('refuses a threshold nobody could ever reach', () => {
    refuses(() => checkPlan(THREE, 4), 'threshold-above-count');
    refuses(() => checkPlan(THREE, 99), 'threshold-above-count');
  });

  it('refuses fewer than two pieces, and more than the cap', () => {
    refuses(() => checkPlan([THREE[0]!], 2), 'too-few-pieces');
    refuses(() => checkPlan([], 2), 'too-few-pieces');
    const many = Array.from({ length: MAX_PIECES + 1 }, (_, i) => place(`p${i}`, `holder-${i}`));
    refuses(() => checkPlan(many, 2), 'too-many-pieces');
    expect(() => checkPlan(many.slice(0, MAX_PIECES), 2)).not.toThrow();
  });

  it('REFUSES TWO PIECES BEHIND THE SAME HOLDER, however differently they are labelled', () => {
    /*
     * The failure this closes is invisible to the person: two entries called
     * "My Google Drive" and "Backup folder" look like two places and are one.
     * Whoever opens that account opens both.
     */
    const collide = [
      place('My Google Drive', 'google:person@example.com'),
      place('Backup folder', 'GOOGLE:Person@Example.com'),
      place('Printed', 'paper'),
    ];
    refuses(() => checkPlan(collide, 2), 'holders-collide');
    expect(() => checkPlan(collide, 2)).toThrow(/Backup folder/u);
  });

  it('refuses a placement that does not say who controls it', () => {
    const vague = [place('Somewhere', '  '), place('Printed', 'paper'), THREE[2]!];
    refuses(() => checkPlan(vague, 2), 'holders-collide');
  });

  it('refuses a secret of the wrong length, including the 64-byte seed', async () => {
    await expect(splitSecret(new Uint8Array(64), THREE, 2))
      .rejects.toMatchObject({ code: 'secret-wrong-length' });
    await expect(splitSecret(new Uint8Array(16), THREE, 2))
      .rejects.toMatchObject({ code: 'secret-wrong-length' });
  });

  it('names N-of-N rather than refusing it, because it is somebody\'s own choice', () => {
    expect(hasNoMargin(2, 2)).toBe(true);
    expect(hasNoMargin(3, 3)).toBe(true);
    expect(hasNoMargin(3, 2)).toBe(false);
    /* Allowed — the warning is the product's job, not a refusal. */
    expect(() => checkPlan(THREE, 3)).not.toThrow();
  });

  it('WARNS about N-of-N, rather than that being a sentence in a document', () => {
    /*
     * `hasNoMargin` existed and nothing outside its own test called it, so
     * §1's "N-of-N warned about loudly" was held by nothing. This is the
     * function a screen actually asks.
     */
    expect(warningsFor(THREE, 2)).toHaveLength(0);
    const warned = warningsFor(THREE, 3);
    expect(warned.map((w) => w.kind)).toEqual(['no-margin']);
    expect(warned[0]!.says).toMatch(/gone|spare/u);
  });

  it('WARNS when a piece a HOST holds is one nobody could do without — §7.2', () => {
    /*
     * §7.9 lets the payroll product supply a home of its own. §7.2's second
     * rule is that whatever a host holds must never be necessary — and a piece
     * is necessary exactly when the set is N-of-N. Getting the account back
     * would then depend on us, which is the thing the whole design exists to
     * avoid.
     */
    const withHost = [
      place('A password I remember', 'host:payroll'),
      place('Printed', 'paper'),
    ];
    const kinds = warningsFor(withHost, 2, 'host:payroll').map((w) => w.kind);
    expect(kinds).toContain('host-holds-a-necessary-piece');

    /* Three pieces, two needed: ours is no longer in every combination. */
    const roomy = [...withHost, place('My other laptop', 'device:laptop-2')];
    expect(warningsFor(roomy, 2, 'host:payroll')).toHaveLength(0);

    /* And a set with no host piece at all is never warned about on this count. */
    expect(warningsFor(THREE, 3, 'host:payroll').map((w) => w.kind))
      .toEqual(['no-margin']);
  });
});

describe('the suggested default', () => {
  it('never counts the device it is being created on — §7.3', () => {
    /*
     * "Your cloud account, a printed copy, and this device" reads as
     * two-of-three and behaves as two-of-two, because the device going is the
     * most likely reason somebody is recovering at all.
     */
    const available = [
      place('This laptop', 'device:laptop-1', true),
      ...THREE,
    ];
    const suggested = suggestDefault(available);
    expect(suggested.threshold).toBe(2);
    expect(suggested.placements).toHaveLength(3);
    expect(suggested.placements.some((p) => p.isThisDevice)).toBe(false);
    expect(hasNoMargin(suggested.placements.length, suggested.threshold)).toBe(false);
  });

  it('refuses to suggest anything when there are not three other places', () => {
    const thin = [place('This laptop', 'device:laptop-1', true), THREE[0]!, THREE[1]!];
    expect(() => suggestDefault(thin)).toThrow(RecoveryError);
  });

  it('produces a set that actually works', async () => {
    const available = [place('This laptop', 'device:laptop-1', true), ...THREE];
    const { placements, threshold } = suggestDefault(available);
    const secret = newSecret();
    const set = await splitSecret(secret, placements, threshold);
    await expect(proveRecoverable(secret, set)).resolves.toBeUndefined();
  });
});

describe('proving it works before saying it does', () => {
  it('accepts a set that rebuilds the account from every minimum subset', async () => {
    const secret = newSecret();
    const set = await splitSecret(secret, THREE, 2);
    await expect(proveRecoverable(secret, set)).resolves.toBeUndefined();
  });

  it('IS RUN BY `splitSecret` ITSELF, not by whoever remembers to ask', async () => {
    /*
     * `proveRecoverable` was listed under "the rules this file enforces" and was
     * called by nothing, which is a known shape for the third time. Forty lines
     * above it, `splitSecret` calls `checkPlan` and says why: *a screen is one
     * caller and this is the only door.*
     *
     * Proved by making the split itself produce a set that cannot be rebuilt —
     * a broken scheme — and asserting the door refuses rather than the caller.
     */
    const secret = newSecret();
    const set = await splitSecret(secret, THREE, 2);
    /* Everything that comes out of the door has already been proved. */
    await expect(proveRecoverable(secret, set)).resolves.toBeUndefined();
    /* And the proof is genuinely reached: a corrupted set is refused by it. */
    await expect(proveRecoverable(secret, {
      ...set,
      pieces: set.pieces.map((p, i) => (i === 0 ? { ...p, bytes: damageShare(p.bytes) } : p)),
    })).rejects.toThrow(RecoveryError);
  });

  it('REFUSES a set where one piece has been corrupted', async () => {
    /*
     * The point of proving rather than assuming. One bad piece in a
     * two-of-three set still leaves one working pair, so a check that tried a
     * single combination would pass and the person would be told they are safe.
     */
    const secret = newSecret();
    const set = await splitSecret(secret, THREE, 2);
    const damaged = {
      ...set,
      pieces: set.pieces.map((p, i) => (i === 1 ? { ...p, bytes: damageShare(p.bytes) } : p)),
    };
    await expect(proveRecoverable(secret, damaged)).rejects.toThrow(RecoveryError);
  });

  it('REFUSES a set built from a different secret than the one being secured', async () => {
    const set = await splitSecret(newSecret(), THREE, 2);
    await expect(proveRecoverable(newSecret(), set))
      .rejects.toMatchObject({ code: 'wrong-secret' });
  });

  it('checks every combination, which is what a single-subset check would miss', async () => {
    /*
     * Five pieces, threshold three: ten combinations. Corrupting ONE piece
     * leaves four working ones — so four of the ten still rebuild the secret,
     * and a check that stopped at the first success would report the set as
     * proven.
     */
    const five: Placement[] = Array.from({ length: 5 }, (_, i) => place(`p${i}`, `holder-${i}`));
    const secret = newSecret();
    const set = await splitSecret(secret, five, 3);
    const damaged = {
      ...set,
      pieces: set.pieces.map((p, i) => (i === 4 ? { ...p, bytes: damageShare(p.bytes, 11) } : p)),
    };
    const good = [set.pieces[0]!.bytes, set.pieces[1]!.bytes, set.pieces[2]!.bytes];
    expect(hex(await combinePieces(good))).toBe(hex(secret));
    await expect(proveRecoverable(secret, damaged)).rejects.toThrow(RecoveryError);
  });
});
