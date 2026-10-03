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
import { whyThisIsNotASealedPool, type SealedPool, type SealedRecordKind, type WrappedPoolKey } from './vault-pool.js';
import type { Sealed } from '../core/crypto.js';

export type WireRecord = SealedRecordKind;
export const WIRE_RECORDS: readonly WireRecord[] = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'];

/** A company's own records, as the signed company-record store files them. */
export const COMPANY_RECORD_KINDS = ['state', 'roster', 'policy', 'person', 'run', 'proposal', 'offer'] as const;
export type CompanyRecordKind = (typeof COMPANY_RECORD_KINDS)[number];

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

/* ------------------------------------------------------------------ *
 * a company's own records
 * ------------------------------------------------------------------ */

/**
 * **ONE VERSION OF ONE OF A COMPANY'S OWN RECORDS, AS IT IS FILED**: sealed on
 * the device under a fresh key wrapped to each signer, exactly as a vault's
 * records are, and signed by the seat that filed it over what it is - the
 * company, the kind, the record's id, its version and the key epoch it is
 * sealed under - and the bytes. The server reads nothing but those labels.
 */
export interface SealedCompanyRecord {
  company: string;
  kind: CompanyRecordKind;
  id: string;
  version: number;
  /** The company key's epoch the record is sealed under. */
  keyEpoch: number;
  sealed: Sealed;
  wrapped: WrappedPoolKey[];
  filedBy?: { publicKey: Hex; signature: Hex };
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const COMPANY = /^[A-Za-z0-9_-]{1,64}$/u;

export const assertCompanyRecordKind = (kind: unknown): CompanyRecordKind => {
  if (typeof kind !== 'string' || !(COMPANY_RECORD_KINDS as readonly string[]).includes(kind)) {
    throw new SealedRecordWireRefused(`${JSON.stringify(kind)} is not a record a company keeps`);
  }
  return kind as CompanyRecordKind;
};

export const assertCompanyRecordId = (id: unknown): string => {
  if (typeof id !== 'string' || !RECORD_ID.test(id)) {
    throw new SealedRecordWireRefused('the record is not named as 1 to 64 letters, digits, - or _');
  }
  return id;
};

/** Why `parsed` is not a sealed company record for this company, kind and id, or null when it is one. */
export const whyThisIsNotACompanyRecord = (
  parsed: unknown, expect: { readonly company: string; readonly kind: CompanyRecordKind; readonly id: string },
): string | null => {
  if (parsed === null || typeof parsed !== 'object') return 'it is not a record';
  const r = parsed as Record<string, unknown>;
  if (r.company !== expect.company || r.kind !== expect.kind || r.id !== expect.id) {
    return 'it is a record for another company, kind or id than the one it is filed as';
  }
  if (!Number.isSafeInteger(r.version) || (r.version as number) < 1) return 'its version is not a whole number';
  if (!Number.isSafeInteger(r.keyEpoch) || (r.keyEpoch as number) < 0) return 'it names no key epoch';
  if (!Array.isArray(r.wrapped) || r.wrapped.length === 0) return 'it carries no wrapped keys, so nobody could open it';
  if (r.sealed === null || typeof r.sealed !== 'object') return 'it carries no sealed payload';
  if (r.filedBy !== undefined) {
    const f = r.filedBy as Record<string, unknown> | null;
    if (f === null || typeof f !== 'object' || typeof f.publicKey !== 'string' || !/^[0-9a-f]{64}$/u.test(f.publicKey)
      || typeof f.signature !== 'string' || !/^[0-9a-f]{128}$/u.test(f.signature)) {
      return 'it says who filed it in a form that is not a signing key and a signature';
    }
  }
  return null;
};

const COMPANY_FILING_DOMAIN = 'confidential-accounts/company-filing/v1';

/** The exact text a filer signs for a company record: everything but the signature. */
export const companyFilingMessage = (rec: SealedCompanyRecord): string => {
  const { filedBy: _signature, ...unsigned } = rec;
  return canonical({ domain: COMPANY_FILING_DOMAIN, ...unsigned });
};

/** The record, signed by the seat filing it. The signing secret stays on the device. */
export const signCompanyFiling = (rec: SealedCompanyRecord, signingSecret: Hex): SealedCompanyRecord => {
  const { filedBy: _replaced, ...unsigned } = rec;
  return {
    ...unsigned,
    filedBy: { publicKey: signingPublicKeyOf(signingSecret), signature: sign(companyFilingMessage(unsigned), signingSecret) },
  };
};

/** The signing key that filed this company record, or `null` for none or one that does not cover exactly it. */
export const verifiedCompanyFiler = (rec: SealedCompanyRecord): Hex | null => {
  const f = rec.filedBy;
  if (!f || typeof f.publicKey !== 'string' || typeof f.signature !== 'string') return null;
  return verify(companyFilingMessage(rec), f.signature, f.publicKey) ? f.publicKey : null;
};

/** One filed company record version, as it crosses the wire. */
export interface CompanyWireVersion {
  readonly kind: CompanyRecordKind;
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly body: string;
}

export const toCompanyWire = (rec: SealedCompanyRecord): CompanyWireVersion => {
  const body = JSON.stringify(rec);
  return { kind: rec.kind, id: rec.id, version: rec.version, digest: digestOfBody(body), body };
};

/** A company record version that arrived, checked against what the receiver expects. */
export const fromCompanyWire = (
  message: unknown,
  expect: { readonly company: string; readonly kind: CompanyRecordKind; readonly id: string; readonly version?: number },
): { readonly wire: CompanyWireVersion; readonly sealed: SealedCompanyRecord } => {
  if (message === null || typeof message !== 'object') throw new SealedRecordWireRefused('the message is not an object');
  const m = message as Record<string, unknown>;
  if (assertCompanyRecordKind(m.kind) !== expect.kind || assertCompanyRecordId(m.id) !== expect.id) {
    throw new SealedRecordWireRefused('it says it is another record than the one expected');
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
  const why = whyThisIsNotACompanyRecord(parsed, expect);
  if (why !== null) throw new SealedRecordWireRefused(why);
  if ((parsed as SealedCompanyRecord).version !== version) {
    throw new SealedRecordWireRefused('the version it says and the version inside it are not the same');
  }
  return { wire: { kind: expect.kind, id: expect.id, version, digest: m.digest, body: m.body }, sealed: parsed as SealedCompanyRecord };
};

const assertCompany = (company: string): string => {
  if (!COMPANY.test(company)) throw new SealedRecordWireRefused('the company is not named as an account id');
  return company;
};

/** The company record paths, spelled once. */
export const companyWirePaths = {
  newest: (company: string, kind: CompanyRecordKind, id: string) => `/api/accounts/${assertCompany(company)}/records/${kind}/${id}`,
  versions: (company: string, kind: CompanyRecordKind, id: string) => `/api/accounts/${assertCompany(company)}/records/${kind}/${id}/versions`,
  one: (company: string, kind: CompanyRecordKind, id: string, version: number) => `/api/accounts/${assertCompany(company)}/records/${kind}/${id}/${version}`,
};

/** What a store of company records keeps: every version of every record, in order, and nothing changed. */
export interface CompanyRecordStore {
  get(company: string, kind: CompanyRecordKind, id: string): Promise<SealedCompanyRecord | null>;
  versions(company: string, kind: CompanyRecordKind, id: string): Promise<readonly SealedCompanyRecord[]>;
  at(company: string, kind: CompanyRecordKind, id: string, version: number): Promise<SealedCompanyRecord | null>;
  /** Files the next version, or throws `VaultPoolVersionAlreadyFiled` for a taken one and refuses a gap. */
  put(rec: SealedCompanyRecord): Promise<void>;
}
