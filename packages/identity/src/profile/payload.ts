import type { AttributeName } from './definition.js';
import type { Assertion, Says, Sent } from './model.js';

/**
 * THE BYTES A DISCLOSURE IS SIGNED OVER.
 *
 * **WITHOUT THE ORIGIN AND THE NONCE IN THE SIGNED PAYLOAD, THE DISCLOSURE
 * COMPANY A RECEIVED CAN BE REPLAYED TO COMPANY B** — same data, different
 * recipient, signature still valid. That is the double-spend of personal data,
 * and there is a money version of the same lesson. So four things are bound
 * in: the origin the request was OBSERVED to come from, the request's nonce,
 * the subwallet address the disclosure is about, and the time.
 *
 * WHY A HAND-WRITTEN ENCODING AND NOT `JSON.stringify`. A signature is only
 * worth what its preimage is unambiguous by. `JSON.stringify` orders keys by
 * insertion, escapes `/` and non-ASCII inconsistently between runtimes, and
 * renders numbers through the float printer — so two parties can hold the same
 * object and hash different bytes, and the failure looks like a bad signature
 * rather than like a serialiser disagreement. This encoding has none of those
 * degrees of freedom: **every string is length-prefixed, every number is its
 * decimal spelling length-prefixed, and the field order is written down here.**
 * Two distinct payloads cannot produce the same bytes, because a length prefix
 * makes concatenation unambiguous — `('ab','c')` and `('a','bc')` encode
 * differently, which is precisely the confusion an unprefixed join allows.
 *
 * THE DOMAIN TAG, AND IT IS NOT DECORATION. This wallet signs with the account's
 * NIGHT key, which is a SPENDING key, and `ledger-v9.d.ts:447` warns in as many
 * words: *"Do not expose access to this function for valuable keys for data
 * that is not strictly controlled!"* Being strictly controlled has to be
 * structural. Two things make it so:
 *
 *   1. **Nothing exported anywhere signs caller-supplied bytes.** `mint` takes a
 *      payload STRUCT and builds the preimage itself; there is no path from a
 *      requester's message to `signData`.
 *   2. **The preimage begins with bytes no ledger signing envelope begins
 *      with** — MEASURED, not assumed. Every signable-data producer in
 *      `ledger-v9` starts with the ASCII `midnight:` followed by an envelope
 *      name (`Intent.signatureData` → `midnight:intent-signing-envelope[v9]:`;
 *      `ClaimRewardsTransaction.dataToSign` →
 *      `midnight:claim-rewards-transaction-signing-envel…`). Ours is
 *      `midnight-identity/…`, which differs at byte 8 — `-` against `:`.
 *      `disclosure.test.ts` asserts that against a REAL envelope obtained from
 *      the SDK at run time, so if the SDK ever changes its prefix the test goes
 *      red rather than the argument going quietly stale.
 */

/** Byte 8 onward is what separates this from `midnight:`-prefixed ledger data. */
export const DISCLOSURE_DOMAIN = 'midnight-identity/disclosure/v1';

export const RESPONSE_SCHEMA = 'midnight-identity/disclosure-response/v1';

/**
 * WHAT IS SIGNED. Exactly §5.4's four bindings, plus the content itself.
 *
 * **THE REQUESTER'S `name` AND `rdns` ARE DELIBERATELY NOT IN HERE**, and that
 * is a decision rather than an omission. They are strings the requester supplies
 * about itself and the wallet has verified neither. Signing them would make the
 * wallet appear to attest to a name it never checked — the same family, a name
 * standing in for an identity. The ORIGIN is the one the browser observed, and
 * it is the field that identifies the recipient.
 */
export interface DisclosurePayload {
  readonly schema: typeof RESPONSE_SCHEMA;
  /** OBSERVED by the browser. §5.3 — never read out of a request. */
  readonly origin: string;
  /** The nonce the requester chose. One request, one disclosure. */
  readonly nonce: string;
  /** The subwallet address this disclosure is about — §7 step 6. */
  readonly address: string;
  /** The wallet's clock, in ms. */
  readonly at: number;
  readonly disclosed: readonly Sent[];
  readonly declined: readonly AttributeName[];
}

/* ------------------------------ the encoding ----------------------------- */

const utf8 = new TextEncoder();

class Writer {
  private readonly parts: Uint8Array[] = [];

  private length = 0;

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    this.length += bytes.length;
    return this;
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, /* littleEndian: */ false);
    return this.raw(out);
  }

  /** Length-prefixed UTF-8. The prefix is what makes concatenation
   * unambiguous, and unambiguous is the whole property. */
  str(value: string): this {
    const bytes = utf8.encode(value.normalize('NFC'));
    return this.u32(bytes.length).raw(bytes);
  }

  /** A number as its decimal spelling, so no float printer is involved. */
  num(value: number): this {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`a signed payload carries whole numbers only; got ${value}`);
    }
    return this.str(String(value));
  }

  /** `null` as a token that is not a decimal number, so it cannot collide. */
  maybeNum(value: number | null): this {
    return value === null ? this.str('-') : this.num(value);
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.length; }
    return out;
  }
}

const writeSays = (w: Writer, says: Says): void => {
  w.str(says.of);
  if (says.of === 'value') w.str(says.value);
  else w.str(says.predicate).str(says.result ? 'true' : 'false');
};

/**
 * **THREE ARMS, AND THE TAG IS WHAT SEPARATES THEM.**
 *
 * `wallet` writes its tag and nothing else, because `{ by: 'wallet' }` has
 * nothing else on it and must not grow anything (`model.ts` says why). A
 * length-prefixed tag with no fields after it is still unambiguous — that is
 * exactly what the prefixes are for — so a `wallet` assertion cannot be read as
 * the beginning of a `self` one, and a decoder that ran off the end lands on
 * `null` from a named guard rather than on a `DataView` throw.
 */
const writeAssertion = (w: Writer, asserted: Assertion): void => {
  w.str(asserted.by);
  if (asserted.by === 'wallet') return;
  if (asserted.by === 'self') {
    w.str(asserted.formerly === null ? '-' : 'formerly');
    if (asserted.formerly !== null) {
      w.str(asserted.formerly.issuer).num(asserted.formerly.issuedAt);
    }
    return;
  }
  w.str(asserted.issuer)
    .str(asserted.signature)
    .num(asserted.issuedAt)
    .maybeNum(asserted.expiresAt)
    .str(asserted.reachableAt ?? '-');
};

/**
 * READING THE PREIMAGE BACK. §5.5.
 *
 * **WHY A DECODER EXISTS AT ALL, WHEN THE ENCODER WAS ENOUGH TO SIGN WITH.**
 * §5.5 asks the history entry to keep the exact bytes that were signed, so that
 * a hash of them is reproducible for ever and anchoring is later a transaction
 * and nothing else. There is a condition that makes that
 * worth having: *if the stored bytes and the stored fields can disagree, the
 * entry is worse than not having them.* **A blob nobody can read is a blob
 * nobody can check.**
 *
 * So the bytes are read back and compared with the fields beside them. That is
 * only possible because the encoding was length-prefixed from the first line —
 * an unprefixed join can be written and never unambiguously read.
 *
 * IT IS TOTAL. Every refusal is a `null` from a named guard rather than an
 * exception out of a `DataView`, because this runs over data that has been
 * sitting in storage and may be damaged, truncated, or from a version that does
 * not exist yet.
 */
class Reader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u32(): number | null {
    if (this.at + 4 > this.bytes.length) return null;
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4);
    this.at += 4;
    return view.getUint32(0, /* littleEndian: */ false);
  }

  str(): string | null {
    const length = this.u32();
    if (length === null || this.at + length > this.bytes.length) return null;
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }

  num(): number | null {
    const text = this.str();
    if (text === null || !/^-?\d+$/u.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
  }

  maybeNum(): number | null | undefined {
    const text = this.str();
    if (text === null) return undefined;
    if (text === '-') return null;
    if (!/^-?\d+$/u.test(text)) return undefined;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : undefined;
  }

  /** True only when every byte has been consumed — trailing bytes are a
   * different message wearing this one's clothes. */
  done(): boolean {
    return this.at === this.bytes.length;
  }

  expect(prefix: Uint8Array): boolean {
    if (this.at + prefix.length > this.bytes.length) return false;
    for (let i = 0; i < prefix.length; i += 1) {
      if (this.bytes[this.at + i] !== prefix[i]) return false;
    }
    this.at += prefix.length;
    return true;
  }
}

const readSays = (r: Reader): Says | null => {
  const of = r.str();
  if (of === 'value') {
    const value = r.str();
    return value === null ? null : { of: 'value', value };
  }
  if (of === 'predicate') {
    const predicate = r.str();
    const result = r.str();
    if (predicate === null || (result !== 'true' && result !== 'false')) return null;
    return { of: 'predicate', predicate, result: result === 'true' };
  }
  return null;
};

const readAssertion = (r: Reader): Assertion | null => {
  const by = r.str();
  /* No fields follow, so there is nothing to read and nothing to check. */
  if (by === 'wallet') return { by: 'wallet' };
  if (by === 'self') {
    const marker = r.str();
    if (marker === '-') return { by: 'self', formerly: null };
    if (marker !== 'formerly') return null;
    const issuer = r.str();
    const issuedAt = r.num();
    if (issuer === null || issuedAt === null) return null;
    return { by: 'self', formerly: { issuer, issuedAt } };
  }
  if (by === 'issuer') {
    const issuer = r.str();
    const signature = r.str();
    const issuedAt = r.num();
    const expiresAt = r.maybeNum();
    const reachable = r.str();
    if (issuer === null || signature === null || issuedAt === null
      || expiresAt === undefined || reachable === null) return null;
    return {
      by: 'issuer',
      issuer,
      signature,
      issuedAt,
      expiresAt,
      reachableAt: reachable === '-' ? null : reachable,
    };
  }
  return null;
};

/**
 * THE PAYLOAD THOSE BYTES ARE, or `null` if they are not a payload at all.
 *
 * `preimage(readPreimage(b)) === b` for every `b` this module produced, and
 * `readPreimage(preimage(p))` deep-equals `p` for every payload — both are
 * pinned in `disclosure.test.ts`.
 */
export function readPreimage(bytes: Uint8Array): DisclosurePayload | null {
  const r = new Reader(bytes);
  if (!r.expect(utf8.encode(DISCLOSURE_DOMAIN))) return null;
  const schema = r.str();
  if (schema !== RESPONSE_SCHEMA) return null;
  const origin = r.str();
  const nonce = r.str();
  const address = r.str();
  const at = r.num();
  if (origin === null || nonce === null || address === null || at === null) return null;

  const disclosedCount = r.u32();
  if (disclosedCount === null || disclosedCount > 4096) return null;
  const disclosed: Sent[] = [];
  for (let i = 0; i < disclosedCount; i += 1) {
    const id = r.str();
    const about = r.str();
    if (id === null || about === null) return null;
    const says = readSays(r);
    if (says === null) return null;
    const asserted = readAssertion(r);
    if (asserted === null) return null;
    disclosed.push({ id, about, says, asserted });
  }

  const declinedCount = r.u32();
  if (declinedCount === null || declinedCount > 4096) return null;
  const declined: AttributeName[] = [];
  for (let i = 0; i < declinedCount; i += 1) {
    const name = r.str();
    if (name === null) return null;
    declined.push(name);
  }

  /* TRAILING BYTES ARE A REFUSAL. A decoder that stops when it has what it
   * wanted will happily read a prefix of somebody else's message. */
  if (!r.done()) return null;

  return Object.freeze({
    schema: RESPONSE_SCHEMA,
    origin,
    nonce,
    address,
    at,
    disclosed: Object.freeze(disclosed),
    declined: Object.freeze(declined),
  });
}

/**
 * THE ONE FUNCTION BOTH SIDES CALL. The wallet builds these bytes and signs
 * them; the recipient builds them again from what it received and checks the
 * signature over them. Any field that differs — the origin above all — gives
 * different bytes and a signature that does not verify.
 */
export function preimage(payload: DisclosurePayload): Uint8Array {
  const w = new Writer();
  w.raw(utf8.encode(DISCLOSURE_DOMAIN));
  w.str(payload.schema)
    .str(payload.origin)
    .str(payload.nonce)
    .str(payload.address)
    .num(payload.at);
  w.u32(payload.disclosed.length);
  for (const sent of payload.disclosed) {
    w.str(sent.id).str(sent.about);
    writeSays(w, sent.says);
    writeAssertion(w, sent.asserted);
  }
  w.u32(payload.declined.length);
  for (const name of payload.declined) w.str(name);
  return w.done();
}
