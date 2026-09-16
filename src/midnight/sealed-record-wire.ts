/**
 * **HOW A SEALED RECORD CROSSES BETWEEN THE PAGE AND THE PRODUCT'S STORE.**
 *
 * A vault's pool and its journals are opened only where a signer's key is: on
 * the person's own device. The server keeps the sealed bytes and can never open
 * them. This file is the one statement of what crosses the wire, used by both
 * ends, and it carries everything a version is:
 *
 *   · **which record** - the pool, the deposit journal or the payment journal;
 *   · **which version** - in the path AND in the message AND inside the record,
 *     and all three must agree;
 *   · **the exact bytes**, as one JSON string, with their SHA-256 beside them,
 *     checked by whoever receives them;
 *   · **who filed it**: a signature over the record, its kind, its vault and
 *     its version (`signFiling`). The store refuses a filing it does not
 *     verify; the device that reads it believes it only if the key is one the
 *     company's roster has held.
 *
 * What a record says it is, is also sealed inside it (`SealedLabel` in
 * `vault-pool.ts`), so a store that relabels or swaps a record gets a record the
 * reader refuses to open as the one it asked for.
 *
 * A message that disagrees with itself about any of those is refused, by
 * whichever end reads it, before anything is filed or believed. A reply about a
 * different version than the one asked for is refused the same way: a write
 * that is told "filed" about another version has not been told anything.
 *
 * **NOTHING HERE OPENS A RECORD.** It checks the shape a store already checks
 * (`whyThisIsNotASealedPool`) and nothing inside the sealed payload.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonical, sign, signingPublicKeyOf, toHex, utf8, verify, type Hex } from '../core/crypto.js';
import { whyThisIsNotASealedPool, type SealedPool, type SealedRecordKind } from './vault-pool.js';

export type WireRecord = SealedRecordKind;
export const WIRE_RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];

/** One filed version, as it crosses the wire. */
export interface WireVersion {
  readonly record: WireRecord;
  readonly version: number;
  /** SHA-256 of `body`, lower-case hex. */
  readonly digest: string;
  /** The sealed record, exactly as `JSON.stringify` wrote it. */
  readonly body: string;
}

/** Thrown for any message that is not what it says it is. The reason is in the message. */
export class SealedRecordWireRefused extends Error {
  constructor(why: string) {
    super(`a sealed record on the wire was refused: ${why}. Nothing was filed or read from it.`);
    this.name = 'SealedRecordWireRefused';
  }
}

const VAULT = /^[0-9a-f]{64}$/u;

export const digestOfBody = (body: string): string => toHex(sha256(utf8(body)));

export const assertWireRecord = (record: unknown): WireRecord => {
  if (typeof record !== 'string' || !(WIRE_RECORDS as readonly string[]).includes(record)) {
    throw new SealedRecordWireRefused(`${JSON.stringify(record)} is not a record a vault keeps`);
  }
  return record as WireRecord;
};

export const assertWireVault = (vault: unknown): string => {
  if (typeof vault !== 'string' || !VAULT.test(vault)) {
    throw new SealedRecordWireRefused(
      'the vault is not named as 64 lower-case hex characters (the address is not repeated here)');
  }
  return vault;
};

export const assertWireVersionNumber = (version: unknown): number => {
  const n = typeof version === 'string' && /^[1-9][0-9]{0,15}$/u.test(version) ? Number(version) : version;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new SealedRecordWireRefused(`${JSON.stringify(version)} is not a version`);
  }
  return n;
};

/** A filed record, made ready to cross. */
export const toWire = (record: WireRecord, sealed: SealedPool): WireVersion => {
  const body = JSON.stringify(sealed);
  return { record, version: sealed.version, digest: digestOfBody(body), body };
};

/**
 * **A VERSION THAT ARRIVED, CHECKED AGAINST WHAT THE RECEIVER EXPECTS**, and the
 * sealed record inside it. `expect.version` is the version named in the path or
 * the one the receiver asked for; omit it only where any version is an answer
 * (a list of versions).
 */
export const fromWire = (
  message: unknown,
  expect: { readonly vault: string; readonly record: WireRecord; readonly version?: number },
): { readonly wire: WireVersion; readonly sealed: SealedPool } => {
  if (message === null || typeof message !== 'object') throw new SealedRecordWireRefused('the message is not an object');
  const m = message as Record<string, unknown>;
  const record = assertWireRecord(m.record);
  if (record !== expect.record) {
    throw new SealedRecordWireRefused(`it says it is the ${record}, and the ${expect.record} was expected`);
  }
  const version = assertWireVersionNumber(m.version);
  if (expect.version !== undefined && version !== expect.version) {
    throw new SealedRecordWireRefused(`it says it is version ${version}, and version ${expect.version} was expected`);
  }
  if (typeof m.body !== 'string') throw new SealedRecordWireRefused('it carries no body');
  if (typeof m.digest !== 'string' || m.digest !== digestOfBody(m.body)) {
    throw new SealedRecordWireRefused('its body does not match the digest it carries');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m.body);
  } catch {
    throw new SealedRecordWireRefused('its body is not JSON');
  }
  if (JSON.stringify(parsed) !== m.body) {
    throw new SealedRecordWireRefused('its body is not written the one way a record is written, so its digest is not the digest of what would be filed');
  }
  const why = whyThisIsNotASealedPool(parsed, expect.vault);
  if (why !== null) throw new SealedRecordWireRefused(why);
  if ((parsed as SealedPool).version !== version) {
    throw new SealedRecordWireRefused(
      `it says it is version ${version} and the record inside it says ${JSON.stringify((parsed as SealedPool).version)}`);
  }
  return { wire: { record, version, digest: m.digest, body: m.body }, sealed: parsed as SealedPool };
};

/** The paths, spelled once. */
export const wirePaths = {
  newest: (vault: string, record: WireRecord) => `/api/vaults/${vault}/records/${record}`,
  versions: (vault: string, record: WireRecord) => `/api/vaults/${vault}/records/${record}/versions`,
  file: (vault: string, record: WireRecord, version: number) => `/api/vaults/${vault}/records/${record}/${version}`,
  one: (vault: string, record: WireRecord, version: number) => `/api/vaults/${vault}/records/${record}/${version}`,
};

/** What a store refused a filing for, in words both ends share. */
export type WireRefusal =
  | { readonly refused: 'version-already-filed'; readonly record: WireRecord; readonly version: number }
  | { readonly refused: 'not-the-next-version'; readonly record: WireRecord; readonly version: number; readonly why: string }
  | { readonly refused: 'not-filed'; readonly record: WireRecord; readonly version: number; readonly why: string };

/** What the store says once a version is filed. */
export interface WireFiled {
  readonly filed: true;
  readonly record: WireRecord;
  readonly version: number;
  readonly digest: string;
}

/* ------------------------------------------------------------------ *
 * who filed a record
 * ------------------------------------------------------------------ */

const FILING_DOMAIN = 'confidential-accounts/sealed-filing/v1';

/** The exact text a filer signs: the record without its signature, and what it is filed as. */
export const filingMessage = (record: WireRecord, rec: SealedPool): string => canonical({
  domain: FILING_DOMAIN,
  record,
  vault: rec.vault,
  version: rec.version,
  sealed: rec.sealed,
  wrapped: rec.wrapped,
});

/**
 * **THE RECORD, SIGNED BY THE SIGNER FILING IT.** Their signing secret stays on
 * their device; the record carries the public half and the signature.
 */
export const signFiling = (record: WireRecord, rec: SealedPool, signingSecret: Hex): SealedPool => {
  const { filedBy: _replaced, ...unsigned } = rec;
  return {
    ...unsigned,
    filedBy: { publicKey: signingPublicKeyOf(signingSecret), signature: sign(filingMessage(record, unsigned), signingSecret) },
  };
};

/**
 * **THE SIGNING KEY THAT FILED THIS RECORD AS THIS KIND, OR `null`.** Null for a
 * record nobody signed, and for a signature that does not cover exactly this
 * record, kind, vault and version.
 */
export const verifiedFiler = (record: WireRecord, rec: SealedPool): Hex | null => {
  const f = rec.filedBy;
  if (!f || typeof f.publicKey !== 'string' || typeof f.signature !== 'string') return null;
  const { filedBy: _signature, ...unsigned } = rec;
  return verify(filingMessage(record, unsigned), f.signature, f.publicKey) ? f.publicKey : null;
};
