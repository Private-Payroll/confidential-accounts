import { describe, expect, it } from 'vitest';
import {
  BLINDING_BYTES,
  PROPOSAL_SALT_BYTES,
  bigintJsonReplacer,
  canonical,
  commit,
  fromHex,
  newBlinding,
  newProposalSalt,
  newSymmetricKey,
  newSigningKeypair,
  newWrappingKeypair,
  parseCanonical,
  proofKeypairFor,
  reviveBigints,
  seal,
  sign,
  signingPublicKeyOf,
  toHex,
  unseal,
  unwrapKey,
  utf8,
  verify,
  wrapKey,
} from './crypto.js';
import type { Hex, Sealed } from './crypto.js';

/**
 * **`src/core/crypto.ts` — KNOWN-ANSWER VECTORS. `T-197`, `T-195`, `S46`.**
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT A ROUND-TRIP FILE ────────────────
 *
 * Until this file, `crypto.ts` had **no test of any kind**: 322 lines, every
 * key, every hash and every hex conversion on the money path, and not one
 * fixed value anywhere (`SC9` `F5`, `docs/scope-the-money-path.md:463`).
 *
 * **THE FAILURE MODE IS PRECISE AND IT IS NOT LOW COVERAGE.** `seal`/`unseal`,
 * `wrapKey`/`unwrapKey` and `canonical`/`parseCanonical` are three pairs that
 * open what they sealed. A test built on `unseal(seal(x, k), k) === x` passes
 * for **any self-consistent change**: reverse `commit`'s `nonce + ':' + text`
 * concatenation, drop `wrapKey`'s `sha256` over the raw ECDH output, delete
 * `canonical`'s key `.sort()`, freeze `seal`'s IV to a constant. Every one of
 * those is a defect and every one of them survives a round trip. **So a
 * round-trip file here would have been the defect with a test over it**, and
 * the four named above each have a test below that reddens on it — named, so a
 * reader can check the claim rather than take it.
 *
 * ── WHERE EVERY VECTOR CAME FROM — RULE 9 ────────────────────────────────────
 *
 * **NO VECTOR IN THIS FILE WAS PRODUCED BY THE CODE UNDER TEST.** That is the
 * whole point of it, so each one says its source in the test that uses it, and
 * there are exactly three kinds:
 *
 *   · **PUBLISHED STANDARD, CONFIRMED.** RFC 7748 §6.1 (X25519), RFC 8032 §7.1
 *     TEST 2 (Ed25519). Each was recomputed
 *     with **`node:crypto`, which is OpenSSL and is not `@noble`** — the
 *     library this file's subject uses — and the RFC's published bytes and
 *     OpenSSL's agreed. Two independent sources, neither of them us.
 *   · **PRODUCED BY OpenSSL.** The two AES-256-GCM ciphertexts below were
 *     encrypted by `node:crypto`, never by `seal`. `unseal` and `unwrapKey`
 *     open bytes this repository did not write, which is the only construction
 *     that can catch a self-consistent change to the sealing side.
 *   · **SPECIFICATION-LEVEL LITERALS.** `canonical`'s output strings are read
 *     off the rules `crypto.ts:263-283` and `:299-318` state in prose. Nothing
 *     was measured for those: they are the sentence, written as an assertion.
 *
 * **RFC 8032 TEST 2 AND NOT TEST 1, AND THE REASON IS A CORRECTION RATHER THAN
 * A JUDGEMENT ABOUT THE RFC.** `S46` first wrote here that TEST 1 *"did not
 * reproduce under OpenSSL"*. **That was false, and this round's own
 * `test-auditor` demonstrated it**: TEST 1 reproduces exactly, and what did not
 * reproduce was `S46`'s transcription of its SEED — the last eight bytes were
 * wrong. `docs/corrections.md`, rule 26. **A sentence saying a published
 * standard's test vector is untrustworthy is the worst thing to leave in the
 * file future rounds will read for what a known-answer vector means here**, so
 * it is written out rather than quietly deleted. TEST 2 is what is used and it
 * reproduced exactly — public key and signature both.
 *
 * ── WHAT THIS FILE STILL DOES NOT COVER ──────────────────────────────────────
 *
 * The generators are asserted for WIDTH and for freshness, not for entropy
 * quality: nothing here can tell a good CSPRNG from a bad one, and a test that
 * claimed to would be `C286`'s shape. What it catches is a narrowing or a
 * constant, which is what `T-195` is about.
 */

/* ── THE VECTORS, ALL OF THEM, IN ONE PLACE ──────────────────────────────── */

/** RFC 7748 §6.1. Alice's and Bob's X25519 secrets, verbatim from the RFC. */
const ALICE_SECRET: Hex = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
const BOB_SECRET: Hex = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
/** RFC 7748 §6.1's published public keys; OpenSSL derived the same two. */
const ALICE_PUBLIC: Hex = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
const BOB_PUBLIC: Hex = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
/** RFC 7748 §6.1's published shared secret K; OpenSSL's `diffieHellman` agreed. */
const RFC7748_K: Hex = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
/** `sha256(K)` — what `wrapKey:253` calls the KEK. OpenSSL's SHA-256 of the line above. */
const KEK_OVER_K: Hex = 'dead45a1d43d6902aa9240b43c0d75a0b5fc750660590d6d45461cbfc4010684';

/** RFC 8032 §7.1 TEST 2: the 32-byte seed, its public key, message `r`, its signature. */
const ED_SEED: Hex = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
const ED_PUBLIC: Hex = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
const ED_MESSAGE = 'r';
const ED_SIGNATURE: Hex =
  '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da'
  + '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00';

/**
 * An approval-shaped message and its Ed25519 signature, both produced by
 * OpenSSL from the fixed seed below. Not a published vector — a second one,
 * over a message longer than one byte, for the gate at `account.ts:2564`.
 */
const APPROVAL_SEED: Hex = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const APPROVAL_PUBLIC: Hex = '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';
const APPROVAL_MESSAGE = 'approve:proposal-7f3a:acct-9';
const APPROVAL_SIGNATURE: Hex =
  '8051eb8dca27d99bd62b66aaa4c7fbc8dc73916fe42664d41ed5032b7b811ec7'
  + '5e997a16ddc06b042efd3be049a347a59ad081182df6fc6847aa4ce7b3d7ef01';
/**
 * A different signer's public key, for the wrong-signer case: OpenSSL's Ed25519
 * public key of the seed `'20'.repeat(32)`. **The seed is written down because a
 * constant nobody can re-derive is a constant nobody can check** — this round's
 * `test-auditor` had to recover it by search, which is rule 9's point exactly.
 */
const OTHER_SEED: Hex = '20'.repeat(32);
const OTHER_PUBLIC: Hex = '4ed32f63bf35f0eeefcb25f28a2e1fbdc873ae2835671b0c9460f5f12e4556a8';

describe('crypto.ts: fixed vectors, because a round trip agrees with itself', () => {
  /* ──────────────────────────────────────────────────────────────────────
   * `commit` — THE HASH THE CHAIN WOULD PUBLISH INSTEAD OF THE DATA
   * ────────────────────────────────────────────────────────────────────── */

  it('commit is sha256(nonce + ":" + plaintext), and REVERSING the two reddens this', () => {
    /*
     * **THE FIRST OF THE FOUR SELF-CONSISTENT CHANGES.** `crypto.ts:93-94`
     * concatenates nonce-then-plaintext. Swap the two operands and every round
     * trip in this repository still agrees; this line does not.
     *
     * SOURCE: OpenSSL's `sha256('a1b2c3d4:the payload')`. The reversed value
     * beneath it is OpenSSL's `sha256('the payload:a1b2c3d4')` and is here so
     * the test states what it is discriminating between rather than only that
     * a number changed.
     *
     * **AND THE PRIMITIVE UNDER IT IS THE STANDARD ONE, BY THE SAME MEASUREMENT
     * RATHER THAN BY A SEPARATE VECTOR.** `crypto.ts` exports no `sha256`, and
     * `commit` always prefixes `nonce + ':'`, so there is no door onto a bare
     * `SHA-256("abc")` to assert FIPS 180-4 through. What is asserted instead
     * is that OpenSSL's SHA-256 — the FIPS-validated implementation — and
     * `@noble`'s agree on this preimage, which is the same claim reached
     * through the only entrance the file has.
     */
    expect(commit('the payload', 'a1b2c3d4'))
      .toBe('efdc6da247724b62da9af081743ff7bd4644f5b753308f66b7dca4abef7a0869');
    expect(commit('the payload', 'a1b2c3d4'))
      .not.toBe('eb406521193bc07b562c73be7582e396dd17079ae10aa9deb5d935752efcfa28');
    expect(commit('a1b2c3d4', 'the payload'))
      .toBe('eb406521193bc07b562c73be7582e396dd17079ae10aa9deb5d935752efcfa28');
  });

  it('MEASURED AND FILED: the nonce/plaintext separator is ambiguous off the hex path', () => {
    /*
     * **THIS PINS A PROPERTY THAT IS TRUE TODAY AND IS NOT A GOOD ONE.**
     * `SC9` `Q2` (`docs/scope-the-money-path.md:147-149`): `nonce + ':' +
     * plaintext` is unambiguous only while the nonce is hex, and `type Hex =
     * string` (`crypto.ts:16`) does not enforce that. Two different
     * (nonce, plaintext) pairs whose concatenations coincide therefore commit
     * to the same value — demonstrated on the line above and again here.
     *
     * **WHY IT IS SAFE TODAY AND WHY THAT IS A HABIT RATHER THAN A GUARANTEE.**
     * Every `commit(...)` in this repository passes `''` or a hex salt
     * (`crypto.ts:114-124` names the six call sites and `S43` measured them),
     * and `':'` cannot occur in hex. **Nothing enforces it** — rule 27, and it
     * is filed as `T-276` rather than fixed here, because a length-prefixed
     * preimage moves every digest this product has ever written.
     */
    expect(commit('b', 'a:c')).toBe(commit('c:b', 'a'));
  });

  /* ──────────────────────────────────────────────────────────────────────
   * `wrapKey` / `unwrapKey` — THE ECDH THAT CARRIES A VIEWING KEY
   * ────────────────────────────────────────────────────────────────────── */

  it('unwrapKey opens a blob OpenSSL sealed — so DROPPING wrapKey\'s sha256 reddens this', () => {
    /*
     * **THE SECOND OF THE FOUR.** `wrapKey:253` and `unwrapKey:259` both take
     * `sha256` over the raw X25519 output before using it as an AES key. Drop
     * it from **both** and every round trip still opens; this does not, because
     * the ciphertext below was produced outside this repository from a KEK that
     * is `sha256(K)` and nothing else.
     *
     * SOURCES, three of them and none of them us:
     *   · the two keypairs and `K` are RFC 7748 §6.1, confirmed by OpenSSL;
     *   · the KEK is OpenSSL's `sha256(K)`;
     *   · the body is OpenSSL's AES-256-GCM under that KEK and the fixed IV,
     *     ciphertext and tag concatenated, which is the layout `seal:233`
     *     produces and `unseal:237` expects (`tag` is carried inside `body`).
     *
     * `ephemeral` is Alice's public key, so `unwrapKey` agrees the ECDH the
     * other way round — Bob's secret against Alice's public — which is the
     * direction a signer's device actually runs.
     */
    const wrapped: { ephemeral: Hex } & Sealed = {
      ephemeral: ALICE_PUBLIC,
      iv: '000102030405060708090a0b',
      tag: '',
      body: '7386a060b400eafa95b67a80e6f4a1f573309699fab87b58491feaa7e83687',
    };
    expect(unwrapKey(wrapped, BOB_SECRET)).toBe('the viewing key');
  });

  it('the KEK is sha256(K) and NOT K — the two halves are named separately', () => {
    /*
     * The test above proves the chain end to end but a failure in it reads only
     * as *something in wrapKey*. These two lines say WHICH half moved.
     *
     * The same OpenSSL blob is opened twice: once by `unseal` under the KEK
     * directly — which is the AES half alone, and proves the body really is
     * encrypted under `sha256(K)` — and once by `unwrapKey` from Bob's secret,
     * which is the ECDH half plus the hash. **If `wrapKey`/`unwrapKey` dropped
     * the `sha256`, the first line still passes and the second fails**, and
     * that is the discrimination this file was written for.
     *
     * SOURCE: RFC 7748 §6.1 for `K`, OpenSSL for `sha256(K)` and for the body.
     */
    const body =
      '7386a060b400eafa95b67a80e6f4a1f573309699fab87b58491feaa7e83687';
    const iv = '000102030405060708090a0b';

    expect(unseal({ iv, tag: '', body }, KEK_OVER_K)).toBe('the viewing key');
    /* And NOT under the raw shared secret — which is the whole of the
     * `sha256` this test exists to keep. */
    expect(() => unseal({ iv, tag: '', body }, RFC7748_K)).toThrow();
    expect(unwrapKey({ ephemeral: ALICE_PUBLIC, iv, tag: '', body }, BOB_SECRET))
      .toBe('the viewing key');
  });

  it('wrapKey\'s EPHEMERAL IS FRESH PER CALL — freezing it is worse than freezing an IV', () => {
    /*
     * **FOUND BY THIS ROUND'S `test-auditor`, AGAINST THIS ROUND'S OWN FILE.**
     * `crypto.ts:251` draws a fresh x25519 secret per wrap. Replace it with a
     * constant and **every assertion in this file still passed** — including
     * the two known-answer ones above, because they supply the ephemeral as
     * INPUT to `unwrapKey` and never look at one `wrapKey` produced.
     *
     * It is the same shape as the frozen IV below and strictly worse: every
     * wrap to a given recipient would share one KEK, and the secret would be
     * sitting in the source, so anyone reading the file derives every viewing
     * key ever wrapped. Sixteen draws, the same loop the IV test uses.
     */
    const ephemerals = new Set<string>();
    const bodies = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const w = wrapKey('the same viewing key, every time', BOB_PUBLIC);
      expect(w.ephemeral).toMatch(/^[0-9a-f]{64}$/);
      ephemerals.add(w.ephemeral);
      bodies.add(w.body);
      expect(unwrapKey(w, BOB_SECRET)).toBe('the same viewing key, every time');
    }
    expect(ephemerals.size).toBe(16);
    expect(bodies.size).toBe(16);
  });

  it('the wrong recipient secret does not open a wrapped key — it throws, it does not return', () => {
    /* A failure to open must be loud. GCM's tag check is what makes it so, and
     * a silent empty string here would be a viewing key that looks delivered. */
    const wrapped = wrapKey('the viewing key', BOB_PUBLIC);
    expect(() => unwrapKey(wrapped, ALICE_SECRET)).toThrow();
  });

  /* ──────────────────────────────────────────────────────────────────────
   * `seal` / `unseal` — AES-256-GCM
   * ────────────────────────────────────────────────────────────────────── */

  it('unseal opens an OpenSSL ciphertext, tag inside body, exactly as seal lays it out', () => {
    /*
     * SOURCE: OpenSSL AES-256-GCM under the fixed key and IV below, ciphertext
     * and auth tag concatenated. Nothing in this repository produced it.
     *
     * The plaintext is a canonical-encoded amount on purpose: it is what a
     * sealed record actually carries, so this also pins that the sealing layer
     * is byte-transparent to the `{"$n":…}` tag rather than re-encoding it.
     */
    const sealed: Sealed = {
      iv: '0b0a090807060504030201f0',
      tag: '',
      body: '7f493ad055c5cf7c5f03ebaaf9c0521c3d6c18c9fa82f4f7b8e970830e8fed7c6c65d6abb76970a3dc7a',
    };
    const key: Hex = '4041424344454647404142434445464740414243444546474041424344454647';
    expect(unseal(sealed, key)).toBe('{"amount":{"$n":"500000"}}');
    expect(parseCanonical<{ amount: bigint }>(unseal(sealed, key)).amount).toBe(500000n);
  });

  it('a tampered body does not decrypt, and neither does a tampered IV', () => {
    const key: Hex = '4041424344454647404142434445464740414243444546474041424344454647';
    const good: Sealed = {
      iv: '0b0a090807060504030201f0',
      tag: '',
      body: '7f493ad055c5cf7c5f03ebaaf9c0521c3d6c18c9fa82f4f7b8e970830e8fed7c6c65d6abb76970a3dc7a',
    };
    expect(() => unseal({ ...good, body: good.body.replace(/^7f/, '7e') }, key)).toThrow();
    expect(() => unseal({ ...good, iv: '0b0a090807060504030201f1' }, key)).toThrow();
  });

  it('seal\'s IV IS FRESH PER CALL AND TWELVE BYTES — freezing it reddens this', () => {
    /*
     * **THE THIRD OF THE FOUR, AND THE ONE A ROUND TRIP IS BLINDEST TO.**
     * `seal:231` draws a fresh 12-byte IV. Replace `randomBytes(12)` with a
     * constant and every seal/unseal pair in this repository still opens — and
     * AES-GCM under a repeated (key, IV) leaks the XOR of the plaintexts and
     * the authentication key with it, which is catastrophic rather than weak.
     *
     * There is no vector for this: it is a property, and it is asserted as one.
     * Sixteen draws rather than two, so a generator that had gone constant is
     * not mistaken for one that collided.
     */
    const key = newSymmetricKey();
    const ivs = new Set<string>();
    const bodies = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const s = seal('the same plaintext, every time', key);
      expect(s.iv).toMatch(/^[0-9a-f]{24}$/);
      expect(s.tag).toBe('');
      ivs.add(s.iv);
      bodies.add(s.body);
    }
    expect(ivs.size).toBe(16);
    expect(bodies.size).toBe(16);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * `sign` / `verify` — THE APPROVAL-SIGNATURE GATE
   * ────────────────────────────────────────────────────────────────────── */

  it('sign reproduces RFC 8032 §7.1 TEST 2 exactly, and signingPublicKeyOf its public key', () => {
    /*
     * **`verify` WAS IMPORTED BY NO TEST FILE IN THIS REPOSITORY** (`SC9`
     * `F5`), though it is the gate at `src/core/account.ts:2564`. This is the
     * first, and it is a published vector rather than a pair of our own calls.
     *
     * SOURCE: RFC 8032 §7.1 TEST 2 — seed, public key, one-byte message `r`
     * and signature all verbatim from the RFC; OpenSSL reproduced the public
     * key and the signature from the seed, and verified the signature.
     * `sign` UTF-8 encodes its message, and `'r'` is one ASCII byte, so the
     * RFC's message and this one are the same bytes.
     */
    expect(signingPublicKeyOf(ED_SEED)).toBe(ED_PUBLIC);
    expect(sign(ED_MESSAGE, ED_SEED)).toBe(ED_SIGNATURE);
    expect(verify(ED_MESSAGE, ED_SIGNATURE, ED_PUBLIC)).toBe(true);
  });

  it('verify refuses the wrong signer, a tampered message and a mangled signature', () => {
    /* SOURCE: the approval vector — OpenSSL, from the fixed seed above. */
    expect(verify(APPROVAL_MESSAGE, APPROVAL_SIGNATURE, APPROVAL_PUBLIC)).toBe(true);
    expect(sign(APPROVAL_MESSAGE, APPROVAL_SEED)).toBe(APPROVAL_SIGNATURE);
    expect(signingPublicKeyOf(APPROVAL_SEED)).toBe(APPROVAL_PUBLIC);

    expect(verify(APPROVAL_MESSAGE, APPROVAL_SIGNATURE, OTHER_PUBLIC)).toBe(false);
    expect(verify(APPROVAL_MESSAGE + '!', APPROVAL_SIGNATURE, APPROVAL_PUBLIC)).toBe(false);
    expect(verify(APPROVAL_MESSAGE, APPROVAL_SIGNATURE.replace(/^80/, '81'), APPROVAL_PUBLIC))
      .toBe(false);
  });

  it('verify SWALLOWS a malformed input and answers false — pinned because it is a catch', () => {
    /*
     * `crypto.ts:85-89` catches everything and returns `false`. That is the
     * right answer for a gate — a signature that cannot be parsed is not a
     * signature — but it is also the shape that hides a caller passing the
     * wrong argument, and `SC9` `F5` records that the money path is guarded
     * end to end at `src/server/approval-signature.test.ts:254`, `:288`
     * **while the swallowing catch itself was not**. It is now.
     */
    expect(verify(APPROVAL_MESSAGE, 'not hex at all', APPROVAL_PUBLIC)).toBe(false);
    expect(verify(APPROVAL_MESSAGE, '', APPROVAL_PUBLIC)).toBe(false);
    expect(verify(APPROVAL_MESSAGE, APPROVAL_SIGNATURE, 'zz')).toBe(false);
    expect(verify(APPROVAL_MESSAGE, APPROVAL_SIGNATURE, '')).toBe(false);
    /* And a signature of the right shape over the wrong key length. */
    expect(verify(APPROVAL_MESSAGE, APPROVAL_SIGNATURE, APPROVAL_PUBLIC.slice(0, 62))).toBe(false);
  });

  it('proofKeypairFor is domain-separated, and the label is pinned to a fixed value', () => {
    /*
     * `crypto.ts:56-59` derives a bundle-proof keypair as
     * `sha256('midnight-bundle-proof:' + symmetricKey)`. The label is the
     * whole of the domain separation — change it and every stored proof public
     * key stops matching the key it names, silently, on the path `C35`
     * describes (a device removal re-wrapping to a planted row).
     *
     * SOURCE: OpenSSL's `sha256('midnight-bundle-proof:' + <the key below>)`
     * for the secret, and OpenSSL's Ed25519 public key of that secret.
     *
     * **AND IT HAS NO CALLER** — `SC9` `Q3`,
     * `docs/scope-the-money-path.md:153-155`: a live security mechanism
     * described in the present tense with nothing invoking it. That is not
     * fixed here and is not this row's; the vector exists so that whoever wires
     * it up cannot change the label on the way.
     */
    const symmetric: Hex = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
    expect(proofKeypairFor(symmetric)).toEqual({
      secret: '4466b7da0fae765a4caee2865cfc932ced3cc0abfab338486b6a208275fc8e0c',
      publicKey: 'baa2e4998102154b377ad273d510d70128b059d4492234923272c5b8fbc76172',
    });
    /* A different bundle key gives a different pair, and the public half is
     * the ed25519 public key of the secret half rather than a second draw. */
    expect(proofKeypairFor('00'.repeat(32)).secret)
      .not.toBe(proofKeypairFor(symmetric).secret);
    expect(signingPublicKeyOf(proofKeypairFor(symmetric).secret))
      .toBe(proofKeypairFor(symmetric).publicKey);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * `canonical` — THE SERIALISATION EVERY SIGNATURE AND COMMITMENT IS OVER
   * ────────────────────────────────────────────────────────────────────── */

  it('canonical SORTS KEYS — deleting the sort reddens this', () => {
    /*
     * **THE FOURTH OF THE FOUR.** `crypto.ts:291`. Two objects with the same
     * fields in different insertion orders must serialise identically, because
     * a digest over one is checked against a digest over the other. Delete the
     * `.sort()` and every round trip still parses; these do not.
     *
     * SOURCE: specification, not measurement — the literal is what the rule at
     * `crypto.ts:284-293` says the output is.
     */
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    expect(canonical({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('canonical DROPS an absent key and writes null inside an array — M-97, pinned', () => {
    /*
     * `crypto.ts:265-279` records this as `M-97`, the tenth instance of this
     * project's one-rule-two-copies failure and **the first where the copies
     * had genuinely drifted in behaviour**. It had no regression test.
     *
     * The failure it prevents: an unset optional field serialising to the bare
     * text `undefined`, which is not JSON, so a sealed record fails to open
     * with an error naming encryption rather than serialisation.
     *
     * SOURCE: specification — and the rule is *exactly as `JSON.stringify`
     * does*, so `JSON.stringify` is asserted alongside as the statement of
     * what "exactly as" means.
     */
    expect(canonical({ a: 1, blockedReason: undefined })).toBe('{"a":1}');
    expect(canonical({ a: 1, blockedReason: undefined }))
      .toBe(JSON.stringify({ a: 1, blockedReason: undefined }));
    expect(canonical([1, undefined, 2])).toBe('[1,null,2]');
    expect(canonical([1, undefined, 2])).toBe(JSON.stringify([1, undefined, 2]));
    expect(canonical(undefined)).toBe('null');
    expect(canonical(null)).toBe('null');
    expect(canonical({ a: 1 })).not.toContain('undefined');
    expect(canonical([undefined])).not.toContain('undefined');
  });

  it('a bigint is TAGGED, so 500000n and "500000" do not produce the same digest', () => {
    /*
     * `crypto.ts:309-314`: the tag is the whole point — an untagged encoding
     * would make a commitment over a payload agree with a commitment over a
     * subtly different one. This is the assertion that says so.
     *
     * SOURCE: specification, `crypto.ts:319-322`.
     */
    expect(canonical(500000n)).toBe('{"$n":"500000"}');
    expect(canonical({ amount: 500000n })).toBe('{"amount":{"$n":"500000"}}');
    expect(canonical({ amount: '500000' })).toBe('{"amount":"500000"}');
    expect(canonical({ amount: 500000n })).not.toBe(canonical({ amount: '500000' }));
    expect(commit(canonical({ amount: 500000n }), ''))
      .not.toBe(commit(canonical({ amount: '500000' }), ''));
    expect(canonical(-1n)).toBe('{"$n":"-1"}');
    expect(canonical(0n)).toBe('{"$n":"0"}');
  });

  it('parseCanonical revives a tagged amount from a string it never wrote', () => {
    /*
     * SOURCE: specification. The input is a literal, **not** `canonical`'s
     * output — a reviver checked against the encoder that produced its input
     * is the round trip this file exists to avoid.
     */
    expect(parseCanonical('{"amount":{"$n":"500000"}}')).toEqual({ amount: 500000n });
    expect(parseCanonical('[{"$n":"1"},{"$n":"-2"}]')).toEqual([1n, -2n]);
    expect(parseCanonical('{"a":{"b":{"$n":"7"}}}')).toEqual({ a: { b: 7n } });
  });

  it('the reviver is narrow: a second key, or a non-integer, is left alone', () => {
    /*
     * `crypto.ts:324-328` requires exactly one key and `/^-?\d+$/`. Widen
     * either and ordinary customer data starts turning into bigints — a field
     * whose value happens to be a digit string, silently becoming an amount.
     */
    expect(parseCanonical('{"$n":"5","x":1}')).toEqual({ $n: '5', x: 1 });
    expect(parseCanonical('{"$n":"5x"}')).toEqual({ $n: '5x' });
    expect(parseCanonical('{"$n":5}')).toEqual({ $n: 5 });
    expect(parseCanonical('{"$n":"1.5"}')).toEqual({ $n: '1.5' });
    expect(reviveBigints('500000')).toBe('500000');
  });

  it('bigintJsonReplacer emits the SAME tag canonical does, from the same constant', () => {
    /*
     * `crypto.ts:330-341`: the client revives `{"$n":…}` because that is what
     * `canonical` emits, and two places deciding what the tag looks like is
     * `M-104`. This is the assertion that they are one place.
     */
    expect(JSON.stringify({ amount: 500000n }, bigintJsonReplacer))
      .toBe('{"amount":{"$n":"500000"}}');
    expect(JSON.stringify({ amount: 500000n }, bigintJsonReplacer))
      .toBe(canonical({ amount: 500000n }));
    expect(parseCanonical(JSON.stringify({ amount: 7n }, bigintJsonReplacer)))
      .toEqual({ amount: 7n });
  });

  /* ──────────────────────────────────────────────────────────────────────
   * `toHex` / `fromHex` / `utf8`
   * ────────────────────────────────────────────────────────────────────── */

  it('utf8 is UTF-8 and not Latin-1, and toHex is lowercase', () => {
    /* SOURCE: OpenSSL's hex of the UTF-8 bytes of the same string. A
     * `TextEncoder` swapped for a byte-per-character loop is green in every
     * ASCII test in this repository and wrong the first time a payee is called
     * Müller. */
    expect(toHex(utf8('a £ and an é'))).toBe('6120c2a320616e6420616e20c3a9');
    expect(toHex(utf8('abc'))).toBe('616263');
    expect(toHex(fromHex('DEADBEEF'))).toBe('deadbeef');
    expect(Array.from(fromHex('00ff'))).toEqual([0, 255]);
    expect(fromHex('')).toHaveLength(0);

    /*
     * **AND THE DECODE HALF, WHICH NOTHING IN THIS REPOSITORY TESTED.** Found
     * by this round's `test-auditor`: replacing `crypto.ts:21`'s `TextDecoder`
     * with a byte-per-character loop passed every other assertion here and
     * every `unseal` in the repository, because every sealed fixture anywhere
     * is ASCII. A payslip sealed for `Müller` comes back `MÃ¼ller` and the
     * suite is green. The seal is the only door onto `fromUtf8`, so this goes
     * through it.
     */
    const k = newSymmetricKey();
    expect(unseal(seal('a £ and an é', k), k)).toBe('a £ and an é');
  });

  /* ──────────────────────────────────────────────────────────────────────
   * THE GENERATORS — `T-195`, AND THE WIDTH NOTHING ON THE PAYOUT PATH CHECKS
   * ────────────────────────────────────────────────────────────────────── */

  it('THE PAYOUT SEED IS THIRTY-TWO BYTES, ASSERTED HERE BECAUSE NOTHING ELSE ASSERTS IT', () => {
    /*
     * **`T-195` `P1`, AND THIS TEST IS THE WHOLE OF IT.**
     * `docs/scope-the-money-path.md:417-438`, `F3`.
     *
     * `newBlinding()` (`crypto.ts:213`) is the account's payout seed at
     * `src/core/account.ts:763` (creation) and `:1821` (rotate).
     * `src/midnight/run-keys.ts:124` expands it with HKDF, **which accepts any
     * IKM length and returns 32 bytes regardless** — so at any seed width every
     * run key, every `V-43` per-payee nonce and every blinding stays
     * well-formed and self-consistent, and the contract sees a hash and cannot
     * tell a strong one from a weak one. **A narrowing is invisible on chain.**
     *
     * **WHAT REDDENED A NARROWING BEFORE THIS LINE EXISTED WAS AN ACCIDENT ON
     * SOMEBODY ELSE'S PATH:** `src/core/signer-leaf.ts:223`'s `HEX64`, reached
     * through `src/web/accept-seat.test.ts:128` → `:141-143` — the SIGNER
     * blinding, a different consumer of the same function. The obvious refactor
     * (a dedicated `newPayoutSeed()`) removes that guard and nothing else goes
     * red. **This is the check of its own, and rule 27 is why it is written
     * where the seed is MADE rather than where it is used** — `S46` put the
     * refusal in `newBlinding` itself (`crypto.ts:213-226`), the shape
     * `newProposalSalt` above it already uses, and this is what pins it.
     *
     * **IF SOMEBODY DOES SPLIT THIS INTO `newPayoutSeed()`, THIS TEST MOVES
     * WITH IT.** A split that leaves the assertion on `newBlinding` alone puts
     * the payout seed back where `F3` found it.
     */
    expect(BLINDING_BYTES).toBe(32);
    for (let i = 0; i < 8; i++) {
      const seed = newBlinding();
      expect(seed).toMatch(/^[0-9a-f]{64}$/);
      expect(fromHex(seed)).toHaveLength(32);
    }
    const draws = new Set(Array.from({ length: 32 }, () => newBlinding()));
    expect(draws.size).toBe(32);
    expect(newBlinding()).not.toBe('00'.repeat(32));
    /*
     * **A ZERO-PADDED NARROWING IS THE FORM A WIDTH CHECK CANNOT SEE**, found
     * by this round's `test-auditor`: `new Uint8Array(32)` with 16 random bytes
     * written into the front is 32 bytes wide and passed everything above.
     * This is a SHAPE check and not an entropy check — it catches padding at
     * either end and nothing subtler, which is all a test can honestly claim.
     */
    for (let i = 0; i < 8; i++) {
      const seed = newBlinding();
      expect(seed.slice(32)).not.toBe('0'.repeat(32));
      expect(seed.slice(0, 32)).not.toBe('0'.repeat(32));
    }
  });

  it('the proposal salt is thirty-two bytes and its own constant says so — C371', () => {
    /*
     * `C371` was a sixteen-byte salt against two `Bytes<32>` arguments. The
     * refusal lives in `newProposalSalt` (`crypto.ts:160-171`) and its own
     * comment (`:147-156`) says plainly that it cannot fail against today's
     * body and is a tripwire against an EDIT. This pins the constant it reads,
     * so a hand-written width in the generator is a red test rather than a
     * refused governance round.
     */
    expect(PROPOSAL_SALT_BYTES).toBe(32);
    for (let i = 0; i < 8; i++) {
      expect(newProposalSalt()).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(Array.from({ length: 16 }, () => newProposalSalt())).size).toBe(16);
  });

  it('the symmetric key is thirty-two bytes, and AES would refuse it if it were not', () => {
    /*
     * `SC9` `F3` names this one explicitly as **not** unpinned — AES-GCM
     * refuses a bad key width and `sealed-records.test.ts` dies immediately —
     * and says so *"so a later round does not add it"*. It is asserted anyway,
     * one line, because the reason it is safe lives in another file and a
     * reader of this one should not have to find it.
     */
    const key = newSymmetricKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(unseal(seal('x', key), key)).toBe('x');
    expect(() => seal('x', '00'.repeat(31))).toThrow();
  });

  it('the two keypair generators produce distinct, well-formed, matched pairs', () => {
    const s = newSigningKeypair();
    expect(s.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(s.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(signingPublicKeyOf(s.secret)).toBe(s.publicKey);
    expect(verify('m', sign('m', s.secret), s.publicKey)).toBe(true);

    const w = newWrappingKeypair();
    expect(w.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(w.publicKey).toMatch(/^[0-9a-f]{64}$/);
    /* An x25519 keypair is not an ed25519 one, and the two must never be
     * swapped: `C328` was exactly that confusion one type over. */
    expect(w.publicKey).not.toBe(signingPublicKeyOf(w.secret));
    /*
     * **AND THE WRAPPING PAIR IS A MATCHED PAIR, WHICH THE LINE ABOVE DOES NOT
     * SAY.** `test-auditor`, this round: a `newWrappingKeypair` returning a
     * public half derived from a DIFFERENT secret satisfies `not.toBe` and
     * passed everything here. `vault-pool.test.ts:44` catches it elsewhere; the
     * test named *matched pairs* should catch it itself.
     */
    expect(unwrapKey(wrapKey('x', w.publicKey), w.secret)).toBe('x');
    expect(newSigningKeypair().secret).not.toBe(newSigningKeypair().secret);
    expect(newWrappingKeypair().secret).not.toBe(newWrappingKeypair().secret);
  });
});
