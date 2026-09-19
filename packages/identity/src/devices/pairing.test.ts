import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  PAIRING_TTL_MS, PairingError, acceptKeys, answerCommitment, askToPair, beginOffer,
  checkAndShow, digitsFor, publicKeyOf, revealAndShow, sealKeys,
} from './pairing.js';
import type { PairingRequest } from './pairing.js';
import { identityFromSecret, newSecret, secretFromWords, wordsFromSecret } from '../keys/derivation.js';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const T0 = 1_700_000_000_000;
const secret = secretFromWords(TEST_MNEMONIC);

const refuses = (what: () => unknown, code: string): void => {
  let thrown: unknown;
  try {
    what();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected this to be refused, and it was not').toBeInstanceOf(PairingError);
  expect((thrown as PairingError).code).toBe(code);
};

/** The whole honest exchange, so the tests can talk about one step at a time. */
function pair(now = T0, secretToSend: Uint8Array = secret) {
  const asked = askToPair(now);
  const begun = beginOffer(asked.code, now);
  const answered = answerCommitment(asked, begun.message, now);
  const reveal = revealAndShow(begun.pending, answered.nonce, now);
  const onNewDevice = checkAndShow(answered.request, reveal.ephemeralPublic, now);
  const keys = sealKeys(begun.pending, secretToSend, now);
  return {
    request: answered.request,
    pending: begun.pending,
    reveal,
    keys,
    digits: reveal.digits,
    onNewDevice,
  };
}

describe('adding a device by scanning a code', () => {
  it('carries the account across, and both screens show the same number', () => {
    const { request, reveal, keys, digits, onNewDevice } = pair();
    expect(digits).toMatch(/^\d{2}$/u);
    expect(onNewDevice).toBe(digits);

    const { secret: arrived } = acceptKeys(request, reveal.ephemeralPublic, keys, digits, T0);
    expect(hex(arrived)).toBe(hex(secret));
    expect(wordsFromSecret(arrived).join(' ')).toBe(TEST_MNEMONIC);
    expect(identityFromSecret(arrived).money.zswap)
      .toEqual(identityFromSecret(secret).money.zswap);
  });

  it('carries a freshly minted account just as well', () => {
    const fresh = newSecret();
    const { request, reveal, keys, digits } = pair(T0, fresh);
    expect(hex(acceptKeys(request, reveal.ephemeralPublic, keys, digits, T0).secret)).toBe(hex(fresh));
  });

  it('seals NOTHING until the person has had the chance to compare', () => {
    /*
     * The second half. The earlier version sealed the secret at the
     * moment of scanning, so a mismatch was a notification rather than a gate:
     * by the time somebody could say stop, the secret had already been produced
     * in a form the other side could open.
     *
     * The digits need only the public keys and the nonce, so waiting costs
     * nothing — and this asserts that the number exists before the keys do.
     */
    const asked = askToPair(T0);
    const begun = beginOffer(asked.code, T0);
    const answered = answerCommitment(asked, begun.message, T0);

    /* Before a number exists, sealing is refused outright — the order is a rule
     * and not a convention. */
    refuses(() => sealKeys(begun.pending, secret, T0), 'out-of-order');

    const reveal = revealAndShow(begun.pending, answered.nonce, T0);
    expect(reveal.digits).toMatch(/^\d{2}$/u);
    expect(checkAndShow(answered.request, reveal.ephemeralPublic, T0)).toBe(reveal.digits);
    /* Only now, and only because a person said yes. */
    expect(sealKeys(begun.pending, secret, T0).sealed.length).toBeGreaterThan(40);
  });

  it('leaves nothing openable on the screen — a photograph of the code is worthless', () => {
    const { keys, reveal, digits } = pair();
    const attacker = askToPair(T0);
    refuses(() => acceptKeys(attacker, reveal.ephemeralPublic, keys, digits, T0), 'out-of-order');
  });
});

describe('the relay, which is the attack this exists to stop', () => {
  it('CANNOT GRIND THE DIGITS TO MATCH, because it must commit before it sees them', () => {
    /*
     * THE EXACT ATTACK THAT WORKED AGAINST THE FIRST VERSION OF THIS FILE.
     *
     * A relay swaps in its own code, takes the whole secret from the old
     * device, and then tries to make the new device show the same two digits
     * the old one displayed. Before the commitment step it simply generated
     * ephemeral keypairs until one hashed to the right number — 245 tries, a
     * measured count; how long they took was never measured here — and both
     * screens agreed.
     *
     * Now the digits also depend on a nonce the NEW device chooses AFTER the
     * relay has committed to its key, so there is nothing left to grind: the
     * relay would have to find a key it has already named.
     */
    /* The relay pairs with the old device using its own code. */
    const relayRequest = askToPair(T0);
    const toRelay = beginOffer(relayRequest.code, T0);
    const relayAnswered = answerCommitment(relayRequest, toRelay.message, T0);
    const toRelayReveal = revealAndShow(toRelay.pending, relayAnswered.nonce, T0);
    const oldScreen = toRelayReveal.digits;
    const stolen = acceptKeys(
      relayAnswered.request, toRelayReveal.ephemeralPublic,
      sealKeys(toRelay.pending, secret, T0), oldScreen, T0);
    expect(hex(stolen.secret)).toBe(hex(secret));

    /*
     * NOW IT MUST REACH THE HONEST DEVICE, AND IT MUST COMMIT FIRST - DRAWN
     * UNTIL THE NUMBER THE NEW DEVICE WILL SHOW DIFFERS FROM THE OLD SCREEN.
     *
     * The same repair, for the same reason, as the case named *refuses a number
     * that is right for a DIFFERENT exchange* below: two independently derived
     * two-digit numbers agree about one draw in a hundred, so an inequality
     * between them is a coin toss asserted as though it were a law. Measured on
     * exactly this pair rather than assumed from the `% 100`: 966 agreements in
     * 100,000 independent draws.
     *
     * **WHAT IS DIFFERENT HERE IS WHAT THE COLLIDING DRAW BREAKS SECOND.** The
     * refusal at the end of this case is unsatisfiable on the same draw: the
     * number the relay presents IS the number the person confirmed, so
     * `acceptKeys` has nothing to refuse and hands the account over. Watched, on
     * a forced colliding draw - with the inequality in place the run stops there
     * and says *expected '06' not to be '06'*; with the inequality deleted and
     * nothing else changed, the same draw reaches the refusal and says *expected
     * this to be refused, and it was not*, which a reader meets as the relay
     * having succeeded. So deleting the inequality alone would have moved a
     * one-in-a-hundred false red from a clear message to an alarming one. What
     * has to go is the draw.
     *
     * AND THE REDRAW MAKES THAT REFUSAL DETERMINISTIC WHERE IT WAS 99 PER CENT:
     * `acceptKeys` is reached with two numbers already asserted to differ. The
     * property the case exists for - that a relay cannot make the numbers match
     * ON PURPOSE - is carried by the grinding loop below, which runs once, on
     * the accepted draw, with the same bound it always had.
     */
    const drawHonestly = (): {
      asked: PairingRequest; offer: ReturnType<typeof beginOffer>;
      answered: ReturnType<typeof answerCommitment>;
      reveal: ReturnType<typeof revealAndShow>;
    } => {
      const asked = askToPair(T0);
      const offer = beginOffer(asked.code, T0);
      const answered = answerCommitment(asked, offer.message, T0);
      return { asked, offer, answered, reveal: revealAndShow(offer.pending, answered.nonce, T0) };
    };
    let draw = drawHonestly();
    for (let i = 0; i < 50 && draw.reveal.digits === oldScreen; i += 1) draw = drawHonestly();
    const { asked: honest, offer: onward, answered: honestAnswered, reveal: onwardReveal } = draw;
    /* Fifty draws all colliding is not chance, and this is where that says so:
     * a `digitsFor` that ignored its inputs leaves the loop still colliding and
     * turns this red. A separate count of the collisions was tried here and
     * taken out - the loop cannot reach fifty and then draw a differing
     * fifty-first under any hash a defect produces, so the count could not fail
     * for any reason this line does not already catch. */
    expect(onwardReveal.digits, 'fifty draws all colliding is not chance').not.toBe(oldScreen);

    /*
     * FOUR THOUSAND ATTEMPTS TO CHEAT. Each is a fresh ephemeral keypair — the
     * only freedom the relay has — and none of them can be used, because the
     * new device has already been told which key to expect.
     *
     * About forty of the four thousand land on the right number by chance, at
     * one in a hundred. The bound below is EIGHT rather than twenty: at twenty
     * the binomial tail is about one run in six thousand, which is a flake, and
     * a suite that fails once in six thousand runs teaches people to re-run it.
     * At eight the tail is around one in ten billion, and a hash ignoring its
     * inputs still lands at zero.
     */
    let couldHaveCheated = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const candidate = x25519.keygen();
      if (digitsFor(candidate.publicKey, publicKeyOf(honest.secretKey), honestAnswered.nonce)
        === oldScreen) {
        couldHaveCheated += 1;
        const forged = { ephemeralPublic: toBase64Url(candidate.publicKey), digits: oldScreen };
        /* Found a key with the right number — and it is not the one committed. */
        refuses(
          () => checkAndShow(honestAnswered.request, forged.ephemeralPublic, T0), 'commitment-broken');
      }
    }
    /* Every one of them was refused, by the commitment rather than by luck. */
    expect(couldHaveCheated).toBeGreaterThan(8);

    /* Playing honestly, the relay's number differs and the person sees it - so the
     * number they confirmed off the old screen is one this device can refuse. */
    refuses(
      () => acceptKeys(
        honestAnswered.request, onwardReveal.ephemeralPublic,
        sealKeys(onward.pending, stolen.secret, T0), oldScreen, T0),
      'digits-do-not-match');
  });

  it('CANNOT GRIND THE NONCE EITHER, because the old device answers once', () => {
    /*
     * The attack the commitment did NOT stop, and the reason it had to be
     * reopened. The relay does not have to grind its key: it can grind the
     * NONCE instead.
     *
     *   1. it sends the old device a throwaway nonce, purely to learn the
     *      ephemeral key it committed to;
     *   2. it runs the honest side properly and sees what number the new
     *      device will display;
     *   3. it grinds a second nonce until the old device would show the same
     *      number, and sends that one.
     *
     * Seventy-one tries, sub-millisecond, and both screens agreed.
     *
     * What stops it is not cryptography, it is memory: **the side holding the
     * account answers exactly one nonce.** The new device already refused a
     * second commitment; this is the same refusal on the side that matters.
     */
    const asked = askToPair(T0);
    const begun = beginOffer(asked.code, T0);
    const answered = answerCommitment(asked, begun.message, T0);

    const throwaway = revealAndShow(begun.pending, toBase64Url(new Uint8Array(16)), T0);
    const learnedKey = throwaway.ephemeralPublic;
    expect(learnedKey).toBeTruthy();

    /* Having learned the key, it hunts for a nonce that lands on a chosen
     * number — and finds one within a couple of hundred tries. */
    const target = '42';
    let ground: string | null = null;
    for (let i = 0; i < 5_000 && ground === null; i += 1) {
      const candidate = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      if (digitsFor(
        fromBase64Url(learnedKey), publicKeyOf(asked.secretKey), candidate) === target) {
        ground = candidate;
      }
    }
    expect(ground, 'a nonce hitting the target is easy to find — that is the point')
      .not.toBeNull();

    /*
     * And it is worth nothing, because the old device will not answer again —
     * and it refuses on the OBJECT, not on a copy the caller was trusted to
     * keep. That distinction is the fix: one-use expressed as "return a new
     * value and hope the caller drops the old one" is enforced by the caller.
     */
    refuses(() => revealAndShow(begun.pending, ground as string, T0), 'already-used');
    void answered;
  });

  it('refuses a reveal that does not match what was committed to', () => {
    const asked = askToPair(T0);
    const { message } = beginOffer(asked.code, T0);
    const other = beginOffer(askToPair(T0).code, T0);
    const answered = answerCommitment(asked, message, T0);
    const wrongReveal = revealAndShow(other.pending, answered.nonce, T0);
    refuses(() => checkAndShow(answered.request, wrongReveal.ephemeralPublic, T0), 'commitment-broken');
  });

  it('NEVER LETS THE NUMBER TRAVEL, so there is nothing to lie about', () => {
    /*
     * The number crosses between the two devices through a PERSON and nowhere
     * else. Each side computes it from the keys and the nonce it actually
     * holds, so there is no field a relay can fill in — which is a stronger
     * position than checking one it could omit.
     *
     * The only thing that crosses is `confirmedDigits`: what somebody read off
     * the other screen and agreed to.
     */
    const { request, reveal, keys } = pair();
    const onThisDevice = checkAndShow(request, reveal.ephemeralPublic, T0);
    expect(onThisDevice).toBe(reveal.digits);

    /* Confirm a number that is not the one on either screen, and it stops. */
    const wrong = String((Number(onThisDevice) + 1) % 100).padStart(2, '0');
    refuses(() => acceptKeys(request, reveal.ephemeralPublic, keys, wrong, T0),
      'digits-do-not-match');
    /* Confirm the right one and it goes through. */
    expect(hex(acceptKeys(request, reveal.ephemeralPublic, keys, onThisDevice, T0).secret))
      .toBe(hex(secret));
  });

  it('refuses a number that is right for a DIFFERENT exchange', () => {
    /*
     * Somebody with two pairings on the go, reading the wrong screen.
     *
     * THIS TEST WAS FLAKY AND THE FLAKE WAS THE DESIGN SHOWING THROUGH. It used
     * to take two exchanges and assert the second's number is refused by the
     * first — but two independent exchanges agree **one time in a hundred**,
     * which is precisely the one-in-a-hundred the two-digit number costs. So
     * one run in a hundred the number really was right and the refusal really
     * should not have happened, and the suite went red for being correct.
     *
     * Failing once in a hundred runs is how a suite teaches people to press
     * re-run, so it is not left to chance: a second exchange is drawn until its
     * number differs, and the collision is asserted separately as the known
     * cost rather than dismissed as noise.
     */
    const first = pair();
    let second = pair();
    let collisions = 0;
    for (let i = 0; i < 50 && second.digits === first.digits; i += 1) {
      collisions += 1;
      second = pair();
    }
    expect(second.digits, 'fifty draws all colliding is not chance').not.toBe(first.digits);
    expect(collisions).toBeLessThan(50);

    refuses(
      () => acceptKeys(first.request, first.reveal.ephemeralPublic, first.keys, second.digits, T0),
      'digits-do-not-match');
  });

  it('is one chance in a hundred, and that is the accepted cost — not a bug', () => {
    /*
     * Stated as a measurement rather than left implicit, because the test above
     * exists to work around it and a reader deserves to know it is deliberate.
     * §1 chose two digits: an attacker must be in the middle at that
     * exact moment, the person is looking at both screens, and a longer number
     * is one people stop reading.
     *
     * 2,000 pairs of independent exchanges. Expected agreement is 1%; the bounds
     * are wide enough that a correct implementation never trips them and a
     * broken hash — one that always returns the same number, or ignores its
     * inputs — fails at once.
     */
    const nonce = toBase64Url(new Uint8Array(16).fill(11));
    /* Keys are minted once and sampled, because generating four per draw is
     * seconds of the suite's life for no extra confidence. */
    const pool = Array.from({ length: 120 }, () => publicKeyOf(askToPair(T0).secretKey));
    /*
     * Indices drawn at RANDOM, not by an arithmetic pattern. A first attempt
     * walked the pool with fixed strides and measured zero agreements in two
     * thousand draws — because structured indices are not independent samples,
     * so the 1% claim simply did not apply to them. A statistical test needs
     * statistical inputs.
     */
    const pick = (): Uint8Array =>
      pool[crypto.getRandomValues(new Uint32Array(1))[0]! % pool.length] as Uint8Array;

    let agreed = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (digitsFor(pick(), pick(), nonce) === digitsFor(pick(), pick(), nonce)) agreed += 1;
    }
    expect(agreed).toBeGreaterThan(3);
    expect(agreed).toBeLessThan(60);
  });
});

describe('what a pairing refuses', () => {
  it('is ONE USE — a code that works twice is a code worth stealing', () => {
    const { request, reveal, keys, digits } = pair();
    const { request: spent } = acceptKeys(request, reveal.ephemeralPublic, keys, digits, T0);
    expect(spent.used).toBe(true);
    refuses(() => acceptKeys(spent, reveal.ephemeralPublic, keys, digits, T0), 'already-used');
    refuses(() => checkAndShow(spent, reveal.ephemeralPublic, T0), 'already-used');
  });

  it('will not let a second device join a conversation already in progress', () => {
    const asked = askToPair(T0);
    const { message } = beginOffer(asked.code, T0);
    const answered = answerCommitment(asked, message, T0);
    const gatecrasher = beginOffer(asked.code, T0);
    refuses(() => answerCommitment(answered.request, gatecrasher.message, T0), 'out-of-order');
  });

  it('refuses a code that CLAIMS a long life, not just one that has expired', () => {
    /*
     * The expiry rides inside the code, written by the side there is no reason
     * to trust. Without a bound on the scanning device, a code claiming a
     * hundred years was accepted, and still accepted a decade later.
     */
    const honest = askToPair(T0);
    const bytes = fromBase64Url(honest.code);
    new DataView(bytes.buffer, bytes.byteOffset)
      .setBigUint64(33, BigInt(T0 + 100 * 365 * 24 * 3600 * 1000), false);
    refuses(() => beginOffer(toBase64Url(bytes), T0), 'lives-too-long');
  });

  it('caps the life of a code even when the new device asks for longer', () => {
    const greedy = askToPair(T0, 10 * PAIRING_TTL_MS);
    expect(greedy.expiresAt).toBe(T0 + PAIRING_TTL_MS);
    expect(() => beginOffer(greedy.code, T0)).not.toThrow();
  });

  it('refuses an expired code on both sides', () => {
    const asked = askToPair(T0, 60_000);
    refuses(() => beginOffer(asked.code, T0 + 60_000), 'expired');

    const begun = beginOffer(asked.code, T0 + 59_000);
    const answered = answerCommitment(asked, begun.message, T0 + 59_000);
    const reveal = revealAndShow(begun.pending, answered.nonce, T0 + 59_000);
    const keys = sealKeys(begun.pending, secret, T0 + 59_000);
    refuses(
      () => acceptKeys(
        answered.request, reveal.ephemeralPublic, keys, reveal.digits, T0 + 60_000),
      'expired');
    expect(() => acceptKeys(
      answered.request, reveal.ephemeralPublic, keys, reveal.digits, T0 + 59_999))
      .not.toThrow();
  });

  it('refuses sealed keys altered anywhere on the way', () => {
    const { request, reveal, keys, digits } = pair();
    for (let i = 20; i < keys.sealed.length; i += 9) {
      const c = keys.sealed[i] as string;
      const swapped = c === 'A' ? 'B' : 'A';
      const tampered = { sealed: keys.sealed.slice(0, i) + swapped + keys.sealed.slice(i + 1) };
      expect(() => acceptKeys(request, reveal.ephemeralPublic, tampered, digits, T0)).toThrow(PairingError);
    }
  });

  it('refuses junk in place of a code, a commitment or the keys', () => {
    const asked = askToPair(T0);
    for (const junk of ['', 'hello', 'AAAA', TEST_MNEMONIC]) {
      refuses(() => beginOffer(junk, T0), 'not-an-offer');
    }
    refuses(() => answerCommitment(asked, { commitment: '' }, T0), 'not-an-offer');

    const { request, reveal, digits } = pair();
    for (const junk of ['', 'AAAA', 'not base64!!']) {
      refuses(() => acceptKeys(request, reveal.ephemeralPublic, { sealed: junk }, digits, T0), 'not-an-offer');
    }
  });

  it('refuses a code from a future version rather than guessing at it', () => {
    const asked = askToPair(T0);
    refuses(() => beginOffer(`B${asked.code.slice(1)}`, T0), 'not-an-offer');
  });

  it('refuses to send anything but a real secret', () => {
    const asked = askToPair(T0);
    const begun = beginOffer(asked.code, T0);
    const answered = answerCommitment(asked, begun.message, T0);
    revealAndShow(begun.pending, answered.nonce, T0);
    refuses(() => sealKeys(begun.pending, new Uint8Array(64), T0), 'secret-wrong-length');
    refuses(() => sealKeys(begun.pending, new Uint8Array(0), T0), 'secret-wrong-length');
  });

  it('refuses keys that open PERFECTLY and carry the wrong number of bytes', () => {
    /*
     * The guard on the receiving side, which an honest sender can never trigger
     * — so it is reached the only way it can be, by FORGING a sealed value with
     * the primitives directly.
     *
     * This duplicates the sealing steps, and that is deliberate rather than
     * sloppy: it builds an adversarial input, it does not restate an expected
     * answer. The version somebody would otherwise write — trusting that
     * nothing can produce this — is how a device ends up calling 64 bytes a
     * secret and deriving a wallet nobody can reach.
     */
    const asked = askToPair(T0);
    const begun = beginOffer(asked.code, T0);
    const answered = answerCommitment(asked, begun.message, T0);
    const reveal = revealAndShow(begun.pending, answered.nonce, T0);
    const pending = begun.pending;

    const shared = x25519.getSharedSecret(pending.ephemeralSecret, pending.theirPublicKey);
    const label = new TextEncoder().encode('midnight-identity/pairing/v1/');
    const info = new Uint8Array(label.length + 64);
    info.set(label, 0);
    info.set(pending.ephemeralPublic, label.length);
    info.set(pending.theirPublicKey, label.length + 32);

    const key = hkdf(sha256, shared, undefined, info, 32);
    const nonce = new Uint8Array(24).fill(4);
    const body = xchacha20poly1305(key, nonce).encrypt(new Uint8Array(64).fill(1));
    const sealed = new Uint8Array(1 + 24 + body.length);
    sealed[0] = 1;
    sealed.set(nonce, 1);
    sealed.set(body, 25);

    /* It decrypts. That is the point — and it is still refused. */
    refuses(
      () => acceptKeys(answered.request, reveal.ephemeralPublic,
        { sealed: toBase64Url(sealed) }, reveal.digits, T0),
      'will-not-open');
  });

  it('refuses a reveal that is not a key at all', () => {
    const { request, keys, digits } = pair();
    for (const bad of [toBase64Url(new Uint8Array(31)), '', 'AAAA']) {
      refuses(
        () => acceptKeys(request, bad, keys, digits, T0),
        'not-an-offer');
    }
  });

  it('will not reveal before anything has been committed to', () => {
    const asked = askToPair(T0);
    const begun = beginOffer(asked.code, T0);
    const reveal = revealAndShow(begun.pending, toBase64Url(new Uint8Array(16)), T0);
    refuses(() => checkAndShow(asked, reveal.ephemeralPublic, T0), 'out-of-order');
  });
});

describe('the randomness the digits stand on', () => {
  /*
   * Both of these were untested and BOTH MUTATIONS SURVIVED the first time:
   * a constant nonce, and a one-byte one. Under a constant nonce the original
   * The grind works again in 54 tries, behind a fully green suite. The earlier
   * test asked whether the digits MOVE when the nonce moves; the question that
   * matters is whether the nonce is a SURPRISE.
   */
  it('answers every pairing with a nonce nobody could have predicted', () => {
    const nonces = Array.from({ length: 300 }, () => {
      const asked = askToPair(T0);
      const { message } = beginOffer(asked.code, T0);
      return answerCommitment(asked, message, T0).nonce;
    });
    expect(new Set(nonces).size).toBe(300);
    for (const nonce of nonces) {
      expect(fromBase64Url(nonce).length).toBeGreaterThanOrEqual(16);
    }
    /* And it is not a function of anything the other side supplied: the same
     * code answered twice gives two different nonces. */
    const asked = askToPair(T0);
    const first = answerCommitment(asked, beginOffer(asked.code, T0).message, T0).nonce;
    const second = answerCommitment(asked, beginOffer(asked.code, T0).message, T0).nonce;
    expect(first).not.toBe(second);
  });

  it('uses a fresh ephemeral key every time, from randomness and not from the code', () => {
    /*
     * The other half of the confidentiality, and it was asserted nowhere.
     * X25519 opens for EITHER private key — so an ephemeral derived from the
     * scanned code means anybody who photographs the QR and captures the
     * sealed blob opens the account. The header's defence table only ever
     * claimed the new device's half.
     */
    const asked = askToPair(T0);
    const keys = Array.from({ length: 200 }, () =>
      beginOffer(asked.code, T0).pending.ephemeralPublic).map(hex);
    expect(new Set(keys).size).toBe(200);
  });

  it('does not open for anybody who only saw the code and the sealed blob', () => {
    const asked = askToPair(T0);
    const { request, reveal, keys, digits } = pair();
    /* Everything an eavesdropper could see, and a fresh request of their own. */
    const eavesdropper = askToPair(T0);
    refuses(() => acceptKeys(eavesdropper, reveal.ephemeralPublic, keys, digits, T0), 'out-of-order');
    expect(hex(acceptKeys(request, reveal.ephemeralPublic, keys, digits, T0).secret)).toBe(hex(secret));
    void asked;
  });
});

describe('the two digits', () => {
  it('depend on both keys AND the nonce, so no single party fixes them', () => {
    const a = publicKeyOf(askToPair(T0).secretKey);
    const b = publicKeyOf(askToPair(T0).secretKey);
    const n1 = toBase64Url(new Uint8Array(16).fill(1));
    const n2 = toBase64Url(new Uint8Array(16).fill(2));
    expect(digitsFor(a, b, n1)).toBe(digitsFor(a, b, n1));

    /*
     * THE KEYS' ORDER MOVES THE DIGITS, and why this is 200 samples
     * rather than one.
     *
     * This assertion was a SINGLE `expect(digitsFor(a, b, n1)).not.toBe(
     * digitsFor(b, a, n1))`: two independent two-digit hashes compared for
     * inequality, and `digitsFor` ends `% 100` (`pairing.ts:479`). **It
     * failed about one full-suite run in a hundred by construction, on any
     * machine, loaded or idle** — reproduced under contention, 2 red in 40
     * runs, both here, and the
     * key-swap collision rate measured independently at 0.957% over 200,000
     * trials.
     *
     * **THIS IS NOT A LOOSENING, and the arithmetic is the argument.** The
     * property being defended is that `digitsFor` depends on the ORDER of
     * the two keys — that a relay cannot swap them and keep the number. A
     * `digitsFor` that ignored order would return the same digits for every
     * swapped pair: the single-shot form catches that with probability 1,
     * and this form catches it with CERTAINTY, because `moved` would be 0
     * and 0 is not greater than 180. Detection of the real defect goes from
     * "always" to "always" while the built-in 1-in-100 false red disappears.
     * What is given up is only the ability to fail for no reason.
     *
     * The tolerance matches the sibling loop below because the statistics
     * are the same: 200 independent draws, each colliding about 1% of the
     * time, so ~198 move and >180 is roughly eighteen standard deviations
     * clear. Both attacks live in this code and both were real; nothing
     * here weakens what catches them.
     */
    let orderMoved = 0;
    for (let i = 0; i < 200; i += 1) {
      const x = publicKeyOf(askToPair(T0).secretKey);
      const y = publicKeyOf(askToPair(T0).secretKey);
      if (digitsFor(x, y, n1) !== digitsFor(y, x, n1)) orderMoved += 1;
    }
    expect(orderMoved).toBeGreaterThan(180);

    /* The nonce is the part the committing side cannot see in advance. */
    let moved = 0;
    for (let i = 0; i < 200; i += 1) {
      const x = publicKeyOf(askToPair(T0).secretKey);
      if (digitsFor(x, b, n1) !== digitsFor(x, b, n2)) moved += 1;
    }
    expect(moved).toBeGreaterThan(180);
  });

  it('are two digits, and spread rather than clustering', () => {
    /*
     * Two digits is one in a hundred for somebody in the middle — a deliberate
     * trade, because a longer number is one people stop reading. What would
     * make it worse than one in a hundred is a distribution that clusters, so
     * that is measured rather than assumed.
     */
    const nonce = toBase64Url(new Uint8Array(16).fill(3));
    const seen = new Map<string, number>();
    for (let i = 0; i < 600; i += 1) {
      const d = digitsFor(
        publicKeyOf(askToPair(T0).secretKey), publicKeyOf(askToPair(T0).secretKey), nonce);
      expect(d).toMatch(/^\d{2}$/u);
      seen.set(d, (seen.get(d) ?? 0) + 1);
    }
    expect(seen.size).toBeGreaterThan(50);
    expect(Math.max(...seen.values())).toBeLessThan(40);
  });
});

describe('a paired device and a recovered one end up the same', () => {
  it('produces an identity indistinguishable from the original', () => {
    const { request, reveal, keys, digits } = pair();
    const paired = identityFromSecret(acceptKeys(request, reveal.ephemeralPublic, keys, digits, T0).secret);
    const original = identityFromSecret(secret);
    expect(paired.words.join(' ')).toBe(original.words.join(' '));
    expect(hex(paired.money.zswap)).toBe(hex(original.money.zswap));
  });
});

describe('a request is a value the host may hold, and holds no keys of the account', () => {
  it('carries only what the new device needs, and is spent after one use', () => {
    const { request, reveal, keys, digits } = pair();
    const { request: after } = acceptKeys(request, reveal.ephemeralPublic, keys, digits, T0);
    const asJson: PairingRequest = JSON.parse(JSON.stringify(after)) as never;
    expect(asJson.used).toBe(true);
    expect(JSON.stringify(after)).not.toContain(hex(secret));
  });
});
