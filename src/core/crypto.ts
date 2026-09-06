/**
 * Real cryptography. Nothing here is simulated.
 *
 * Isomorphic on purpose: no node:crypto, no Buffer. The same code runs on the
 * server and in the browser, which is what lets the whole product ship as a
 * single HTML file with no backend when that is useful.
 *
 * Signatures (ed25519) and shielded-state encryption (AES-256-GCM, keys agreed
 * over x25519) are genuine. The simulated boundary lives in ledger.ts, not here.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';

export type Hex = string;

export const toHex = (b: Uint8Array): Hex => bytesToHex(b);
export const fromHex = (h: Hex): Uint8Array => hexToBytes(h);
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export interface SigningKeypair { secret: Hex; publicKey: Hex; }
export interface WrappingKeypair { secret: Hex; publicKey: Hex; }

export function newSigningKeypair(): SigningKeypair {
  const secret = ed25519.utils.randomSecretKey();
  return { secret: toHex(secret), publicKey: toHex(ed25519.getPublicKey(secret)) };
}

export function newWrappingKeypair(): WrappingKeypair {
  const secret = x25519.utils.randomSecretKey();
  return { secret: toHex(secret), publicKey: toHex(x25519.getPublicKey(secret)) };
}

/**
 * THE PUBLIC NAME OF A SECRET, so a server that cannot hold the secret can
 * still tell who holds it.
 *
 * A bundle key is symmetric: the server stores ciphertext wrapped to it and has
 * no way to distinguish a real wrap from noise. That is fine until a decision
 * depends on it — and one does. **Removing a stolen device re-wraps the new key
 * to every device on the account, so a row planted by a thief with nothing but
 * a session receives a working key.** The server has to be able to refuse that,
 * and it cannot ask "is this ciphertext real"; it can only ask "prove you hold
 * the key".
 *
 * So a bundle key gets an ed25519 keypair derived from it, deterministically,
 * under its own label. The public half is stored and is not a secret — it
 * identifies a key without revealing it. Whoever holds the bundle key can sign
 * a challenge; whoever holds only a session cannot.
 *
 * Domain-separated, because this key must never be usable for anything else and
 * no key in this system does two jobs.
 */
export function proofKeypairFor(symmetricKey: Hex): SigningKeypair {
  const secret = sha256(utf8('midnight-bundle-proof:' + symmetricKey));
  return { secret: toHex(secret), publicKey: toHex(ed25519.getPublicKey(secret)) };
}

/**
 * THE PUBLIC HALF OF A SIGNING SECRET, DERIVED FROM THE SECRET AND NOT READ
 * OFF A RECORD. `C325`, and `C323` is why it is a derivation.
 *
 * `newSigningKeypair` above is the only other place this line is written, and
 * there it is the pair being MADE. This is the same line asked of a secret that
 * already exists, which is a different question and the only one a device can
 * use to check a record about itself: `C323` is the row for a check that
 * compared two stored claims and never derived from the material, and a leaf
 * check built the same way would agree with a roster that had been substituted
 * wholesale.
 *
 * There is deliberately no wrapping twin. Nothing asks that question yet, and a
 * helper with no caller is a second definition waiting for one.
 */
export function signingPublicKeyOf(secret: Hex): Hex {
  return toHex(ed25519.getPublicKey(fromHex(secret)));
}

export function sign(message: string, secret: Hex): Hex {
  return toHex(ed25519.sign(utf8(message), fromHex(secret)));
}

export function verify(message: string, signature: Hex, publicKey: Hex): boolean {
  try {
    return ed25519.verify(fromHex(signature), utf8(message), fromHex(publicKey));
  } catch {
    return false;
  }
}

/** Content-addressed commitment. What a real chain would publish instead of the data. */
export function commit(plaintext: string, nonce: Hex): Hex {
  return toHex(sha256(utf8(nonce + ':' + plaintext)));
}

/* `newNonce` — sixteen bytes, no callers — STOOD HERE. Deleted by `S44`. `T-204`, below. */
export const newSymmetricKey = (): Hex => toHex(randomBytes(32));

/**
 * THE PROPOSAL'S SALT. THIRTY-TWO BYTES, BECAUSE A CIRCUIT ARGUMENT SAYS SO.
 *
 *
 * **SEPARATE FROM `newNonce`, WHICH STOOD ABOVE UNTIL `S44` DELETED IT.**
 * It was DECLARED as `commit`'s nonce (`:93-95`), where the width is
 * nobody's business: the value is concatenated into a string and hashed, so
 * every width works and none is required. It was ALSO the proposal salt, at
 * five sites in `src/core/account.ts`, and there the width is a contract's
 * business. One generator answering to two rules is `M-106`, whose sentence
 * `src/midnight/commitments.ts:294` still carries — *the safest shared rule is
 * the one that does not exist.* Widening `newNonce` would have been that
 * mistake with a green suite; this function is the other answer.
 *
 * **AND THE `commit` HALF WAS A DECLARATION RATHER THAN A CALL, WHICH `S43`
 * MEASURED AND WHICH `C371`'S ROW AND `SC9` BOTH STATE THE OTHER WAY.** Every
 * `commit(...)` in this repository passes `''` as its nonce — `account.ts:1097`,
 * `:1208`, `:1394`, `:1568`, `:1994`, `:2252`, and no others. So `S43`'s five
 * sites were its ONLY callers and it was left exported, untested, and SIXTEEN
 * BYTES WIDE in the file every key on the money path comes from. `S44` grepped
 * the repository again — one definition, no import, no call — and deleted it.
 * **The position against, written out: it is one line and removing it fixes no
 * failure.** The answer is that the next person who needed a nonce would have
 * found a sixteen-byte one first, which is exactly how `C371` got its width.
 *
 * **WHAT READS IT, AND WHY THIRTY-TWO.** It is `StateChange.salt`
 * (`src/core/ledger.ts:197-209`): `proposalIdOf(payloadHash, vault, salt)` is
 * what every governance circuit and `recordPayment` recompute to prove they
 * were handed the proposal the signers approved, so this value is the round's
 * name and not a decoration on it. Both bindings that take it declare
 * `Bytes<32>` and refuse anything else by length, loudly, naming the argument:
 * `proposalIdOf` argument 3 (`contracts/managed/contract/index.js:4261`) and
 * `changeCommitmentOf` argument 4 (`:4228`).
 *
 * **AND WHY SIXTEEN SURVIVED FOUR MONTHS.** The simulated scheme keys an HMAC
 * with it instead (`src/core/ledger.ts:1806`, `:1810`), and HMAC takes a key of
 * any length. The product runs on the simulator today
 * (`src/wiring/selection.ts:144`), so nothing the product ran ever presented
 * this value to a binding, and every test that reaches one hand-builds its own
 * 32-byte constant.
 *
 * **THE ASSERT IS HERE, WHERE THE SALT IS MADE, AND NOT AT EITHER CONSUMER.**
 * A width checked where it is used is `C371` again with a better error message:
 * by then the value is already wrong and already travelling, and there are two
 * consumers to remember. Checked here, a salt that leaves this function is a
 * salt the chain will take.
 *
 * **IT CANNOT FAIL AGAINST THE BODY DIRECTLY ABOVE IT, AND THAT IS SAID PLAINLY
 * RATHER THAN LEFT TO BE FOUND.** `randomBytes(PROPOSAL_SALT_BYTES)` is that
 * many bytes by construction, so today the check passes by arithmetic. What it
 * catches is an EDIT to this function — a hand-written width, a swap back to
 * `randomBytes(16)`, a different generator — which is exactly the change that
 * reintroduces `C371` and exactly the mutation `2y7g` should carry. A check
 * that cannot fail against today's code and does fail against tomorrow's edit
 * is a tripwire; `contracts/test/one-definition.test.ts:770` is this
 * repository's precedent for labelling one as such rather than claiming more
 * for it.
 */
export const PROPOSAL_SALT_BYTES = 32;

export const newProposalSalt = (): Hex => {
  const salt = randomBytes(PROPOSAL_SALT_BYTES);
  if (salt.length !== PROPOSAL_SALT_BYTES) {
    throw new Error(
      `a proposal salt is ${PROPOSAL_SALT_BYTES} bytes and this one is ${salt.length}. ` +
        'It is the third argument of proposalIdOf and the fourth of changeCommitmentOf, both ' +
        'Bytes<32>, which refuse any other length — so a salt of this width is a governance ' +
        'round and a payroll run that cannot be raised at all. C371.',
    );
  }
  return toHex(salt);
};

/**
 * Hides a signer's identity in the on-chain signer tree.
 *
 * As precious as the signing key. A signer who loses it cannot reproduce their
 * own leaf and is locked out of the account while still holding a valid key.
 * Anything that backs up or recovers a signing key must cover this too.
 *
 * **AND IT IS ALSO THE ACCOUNT'S PAYOUT SEED, WHICH IS A SECOND JOB AND THE
 * REASON THE WIDTH IS CHECKED HERE. `T-195`, `SC9` `F3`.**
 *
 * `src/core/account.ts:763` (creation) and `:1821` (rotate) take a payout seed
 * off this function, and `src/midnight/run-keys.ts:124` expands it with HKDF —
 * **which accepts any IKM length and returns 32 bytes regardless.** So at any
 * seed width every run key, every `V-43` per-payee nonce and every blinding
 * stays well-formed and self-consistent, and the contract sees a hash and
 * cannot tell a strong one from a weak one. **A narrowing here is invisible on
 * chain and invisible in every derivation downstream of it.**
 *
 * **WHAT REDDENED A NARROWING BEFORE THIS CHECK EXISTED WAS AN ACCIDENT ON
 * SOMEBODY ELSE'S PATH** — `src/core/signer-leaf.ts:223`'s `HEX64`, reached
 * through `src/web/accept-seat.test.ts:128`, which is the SIGNER blinding: a
 * different consumer of the same function. Rule 27 and `C286` say that has to
 * be written in those words, and `SC9` wrote them. This is the check of its
 * own that replaces the accident.
 *
 * **IT CANNOT FAIL AGAINST THE BODY BESIDE IT, SAID PLAINLY RATHER THAN LEFT
 * TO BE FOUND** — the same sentence `newProposalSalt` above carries, for the
 * same reason. `randomBytes(BLINDING_BYTES)` is that many bytes by
 * construction, so today the check passes by arithmetic. What it catches is an
 * EDIT: a hand-written width, a swap to `randomBytes(16)`, a different
 * generator. `contracts/test/one-definition.test.ts:770` is this
 * repository's precedent for labelling a tripwire as one.
 *
 * **AND IF THIS IS EVER SPLIT INTO A DEDICATED `newPayoutSeed()` — which is
 * the fix `SC9` `F3` names — THE SPLIT CARRIES THIS CHECK WITH IT.** A split
 * that leaves the assertion here alone puts the payout seed back exactly where
 * `F3` found it, with nothing on its own path checking anything.
 */
export const BLINDING_BYTES = 32;

export const newBlinding = (): Hex => {
  const b = randomBytes(BLINDING_BYTES);
  if (b.length !== BLINDING_BYTES) {
    throw new Error(
      `a blinding is ${BLINDING_BYTES} bytes and this one is ${b.length}. It is the account's ` +
        'payout seed (account.ts:763, :1821) as well as a signer blinding, and run-keys.ts:124 ' +
        'expands it with HKDF, which takes any width and returns a well-formed 32 bytes from ' +
        'all of them — so a narrowing here degrades every per-payee nonce in every run and ' +
        'nothing on chain or downstream can see it. T-195.',
    );
  }
  return toHex(b);
};

/** AES-256-GCM. The tag is carried inside `body` by the noble API. */
export interface Sealed { iv: Hex; tag: Hex; body: Hex; }

export function seal(plaintext: string, key: Hex): Sealed {
  const iv = randomBytes(12);
  const body = gcm(fromHex(key), iv).encrypt(utf8(plaintext));
  return { iv: toHex(iv), tag: '', body: toHex(body) };
}

export function unseal(sealed: Sealed, key: Hex): string {
  return fromUtf8(gcm(fromHex(key), fromHex(sealed.iv)).decrypt(fromHex(sealed.body)));
}

/**
 * Seal something to a recipient's x25519 public key.
 *
 * This is how a viewing key reaches a signer without ever being transmitted in
 * clear, and that is the overwhelmingly common use — hence the name. The
 * parameter is a plain `string` rather than a `Hex` because the mechanism never
 * cared what it carried: M-96 seals a JSON payload to an account's inbox with
 * the identical construction, and a second copy of this ECDH would have been one
 * more rule written twice.
 */
export function wrapKey(plaintext: string, recipientPublicKey: Hex): { ephemeral: Hex } & Sealed {
  const eph = x25519.utils.randomSecretKey();
  const shared = x25519.getSharedSecret(eph, fromHex(recipientPublicKey));
  const kek = toHex(sha256(shared));
  return { ephemeral: toHex(x25519.getPublicKey(eph)), ...seal(plaintext, kek) };
}

export function unwrapKey(wrapped: { ephemeral: Hex } & Sealed, recipientSecret: Hex): string {
  const shared = x25519.getSharedSecret(fromHex(recipientSecret), fromHex(wrapped.ephemeral));
  const kek = toHex(sha256(shared));
  return unseal(wrapped, kek);
}

/**
 * Stable serialisation so signatures and commitments are reproducible.
 *
 * **Absent keys are dropped and `undefined` inside an array becomes `null`,
 * exactly as `JSON.stringify` does.** That is not a nicety. Without it an
 * optional field that happens to be unset — `blockedReason`, `executedAt`,
 * `txRef` — serialises to the bare text `undefined`, which is not JSON, and
 * anything that seals a record and parses it back fails to open with an error
 * that names encryption rather than serialisation.
 *
 * It survived because this function's only callers were `sign` and `commit`,
 * which hash the string and never parse it: the output was malformed and
 * deterministic, so nothing complained. sealed-records.ts had its own second
 * copy that used `JSON.stringify` and therefore did not have the bug, and
 * merging the two is what surfaced it. M-97, and the tenth instance of this
 * project's one-rule-two-copies failure — the first where the copies had
 * genuinely drifted apart in behaviour.
 *
 * Output is unchanged for any value with no `undefined` in it, so no existing
 * digest or signature moves.
 */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return bigintToJson(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>)
    .filter(k => (value as any)[k] !== undefined)
    .sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
}

/* ------------------------------------------------------------------ *
 * bigint over the wire
 * ------------------------------------------------------------------ */

/**
 * How a bigint survives being sealed and read back.
 *
 * EVERY AMOUNT IN THIS SYSTEM IS A BIGINT, and `JSON.stringify` throws on one —
 * loudly, which is the right failure and the reason bigint was chosen over a
 * decimal string. A string amount round-trips through JSON for free and then
 * silently answers `"9" > "10"` and `"100" + "200" === "100200"`; a bigint
 * cannot be serialised by accident and compares and adds correctly. So the
 * awkwardness is here, once, instead of everywhere.
 *
 * TAGGED rather than written as a bare string, and the tag is the whole point:
 * `{"$n":"500000"}` is unambiguous, so `500000n` and the string `"500000"` do
 * not produce the same bytes and therefore do not produce the same digest. An
 * untagged encoding would make a commitment over a payload agree with a
 * commitment over a subtly different payload, which is the kind of collision
 * that is discovered years later.
 *
 * It also means the reviver needs no schema: nothing has to remember which
 * fields are amounts, so a new amount-bearing field cannot be forgotten.
 */
const BIGINT_TAG = '$n';

const bigintToJson = (v: bigint): string =>
  '{' + JSON.stringify(BIGINT_TAG) + ':' + JSON.stringify(v.toString()) + '}';

const isTagged = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.keys(v).length === 1
    && typeof (v as any)[BIGINT_TAG] === 'string'
    && /^-?\d+$/.test((v as any)[BIGINT_TAG]);

/**
 * How a bigint leaves an HTTP response, for `JSON.stringify` and express.
 *
 * SAME TAG AS `canonical`, from the same constant, and that is the whole point
 * of it living here. `res.json` on a body containing a bigint throws *Do not
 * know how to serialize a BigInt* — so every route returning a balance, a
 * roster or a plug-in allowance answered 400 until this existed. The obvious
 * fix is a one-line replacer written at the server, and it would have been a
 * SECOND definition of the wire encoding: the client revives `{"$n":…}` because
 * that is what `canonical` emits, and two places deciding what the tag looks
 * like is this project's oldest failure.
 */
export const bigintJsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value;

/** Walks a parsed value and turns every `{"$n":"…"}` back into a bigint. */
export function reviveBigints(value: unknown): unknown {
  if (isTagged(value)) return BigInt(value[BIGINT_TAG]);
  if (Array.isArray(value)) return value.map(reviveBigints);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = reviveBigints(v);
    return out;
  }
  return value;
}

/**
 * The counterpart to `canonical`. Anything sealed with one is opened with this.
 *
 * A plain `JSON.parse` on canonical output silently yields `{$n: "500000"}`
 * where an amount should be — an object where a bigint belongs, which arithmetic
 * turns into `NaN` or a concatenation rather than an error. Every read path for
 * anything holding an amount goes through here.
 */
export const parseCanonical = <T>(json: string): T => reviveBigints(JSON.parse(json)) as T;

export { randomBytes };
