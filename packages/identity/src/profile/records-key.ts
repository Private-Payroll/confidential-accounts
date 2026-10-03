import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { Identity } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor, readCommitteeKey } from './committee-key.js';
import { readAccountAddress, readCompanyLabel } from './company-label.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';
import { unlockKeyFor } from './unlock.js';
import { usableOrigin } from './origin.js';
import type { HoldersRequest, RecordsKeyRequest, UnlockRequest } from './request.js';

/**
 * **A SIGNER'S RECORDS KEY FOR ONE COMPANY AND THE SEAT THEY HOLD ON ITS
 * ACCOUNT, SIGNED BY THIS WALLET WITH THE KEY THE CHAIN ALREADY LISTS FOR THEM.**
 *
 * A vault's secret is kept on the chain as one sealed copy per signer, each
 * sealed to that signer's records key, so a signer holding only their recovery
 * words and the chain can open it. A copy sealed to any other key is a copy
 * nobody can open that still counts as written. So the key each copy is sealed
 * to must be one the signer's own wallet produced, and every device that
 * approves the copies must be able to check that, whoever handed it the key.
 *
 * **THE CHECK IS A SIGNATURE BY THE SIGNER'S COMMITTEE KEY.** That key is a pure
 * function of the person's words and the company's label (`committee-key.ts`),
 * its secret half never leaves this wallet, and its public half is what the
 * company's account lists on the chain as one seat of its committee. This
 * wallet signs one statement with it - this records key belongs to this
 * company's label, for this seat on its account - and any device holding the
 * statement, the committee key and the label checks it with no service in
 * between.
 *
 * **THE SEAT IS IN THE STATEMENT SO A SIGNER WHO HAS LEFT IS NOT A READER.**
 * A committee nobody has changed since somebody left still lists their key,
 * and their statement from before still verifies. What it names is the seat
 * they held, and the account no longer seats it, so a device that checks every
 * reader's seat against the seats the account holds now refuses it. This
 * wallet signs a seat only when the account, read by this wallet, seats it now.
 * It cannot tell whose seat it is: the page works the seat out from the
 * signer's own key material and asks for that one, so an honest device never
 * asks for another signer's seat, and a statement for a seat somebody else
 * also signed for is refused by every device that checks the readers.
 *
 * **THE STATEMENT CAN NEVER BE READ AS A CHANGE TO A CONTRACT'S RULES, AND THE
 * REVERSE.** The same key signs maintenance updates, whose bytes are the
 * ledger's own serialisation and begin with the ledger's own tag. What is
 * signed here begins with a tag of its own, fixed below, followed by the label,
 * the records key and the seat and nothing else, so no maintenance update has
 * these bytes and no statement has a maintenance update's. Nor is the tag the
 * only thing between them: the ledger checks a committee signature with its own
 * scheme over the update's bytes, and does not accept this statement's
 * signature even over the very same bytes.
 *
 * **THE RECORDS KEY IS WORKED OUT HERE FROM THE COMPANY KEY THIS WALLET
 * RELEASES**, in the same domain the company's records are sealed in, so the
 * key signed for is always the one the page derives from the same release.
 *
 * Loads no WebAssembly.
 */

/** The domain a records key is expanded in. It is the records' own: changing it re-keys every company's records. */
const RECORDS_WRAPPING_SALT = new TextEncoder().encode('confidential-accounts/company-records-wrapping/v1');

/** The tag every statement begins with, and nothing else this wallet signs begins with it. */
export const RECORDS_KEY_STATEMENT_TAG = 'midnight-identity:records-key-statement:v1';

/** The answer this wallet gives a records-key ask. */
export const RECORDS_KEY_ANSWER_SCHEMA = 'midnight-identity/records-key-answer/v1';

const KEY_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

/** What a signer's wallet signs: their records key, the seat they hold, and its signature over both. */
export interface RecordsKeyStatement {
  /** The public half of the signer's records key, 64 lower-case hex characters. */
  readonly recordsKey: string;
  /** The seat the signer holds on the company's account, 64 lower-case hex characters. */
  readonly seat: string;
  /** The BIP-340 signature by the signer's committee key over the statement, 128 lower-case hex characters. */
  readonly signature: string;
}

/**
 * **WHO HOLDS A COMPANY'S ACCOUNT, AS A WALLET READ IT OFF THE CHAIN ITSELF**:
 * the keys of the account's maintenance committee, their threshold, and every
 * seat the account holds now.
 */
export interface AccountSeats {
  readonly committee: readonly { readonly tag: string; readonly value: string }[];
  readonly threshold: number;
  /** Every seat the account holds now, each 64 lower-case hex characters. */
  readonly seats: readonly string[];
}

/**
 * **WHO HOLDS ONE OF THE COMPANY'S VAULTS, AS A WALLET READ IT OFF THE CHAIN
 * ITSELF**: the keys of the vault's maintenance committee, their threshold,
 * and the account the vault is pinned to, as the vault's own state names it.
 * Read when a page is about to approve that vault's secret, so a device checks
 * the vault against what the signer's own wallet read rather than what a
 * service reported.
 */
export interface VaultHolders {
  /** The vault read, 64 lower-case hex characters. */
  readonly vault: string;
  /** The account the vault is pinned to, 64 lower-case hex characters. */
  readonly account: string;
  readonly committee: readonly { readonly tag: string; readonly value: string }[];
  readonly threshold: number;
}

/** The public half of the records key a company key opens, as the company's records are sealed to it. */
export function recordsPublicKeyOf(companyKey: Uint8Array): string {
  if (!(companyKey instanceof Uint8Array) || companyKey.length !== KEY_BYTES || companyKey.every((b) => b === 0)) {
    throw new Error(`a records key is derived from a ${KEY_BYTES}-byte company key, and this is not one. Nothing was derived.`);
  }
  const secret = hkdf(sha256, companyKey, RECORDS_WRAPPING_SALT, new Uint8Array(0), KEY_BYTES);
  const publicKey = x25519.getPublicKey(secret);
  secret.fill(0);
  return toHex(publicKey);
}

/**
 * **THE BYTES SIGNED**, or `null` when the label, the key or the seat is not
 * one. The tag, a zero byte, the label as written, a zero byte, the records
 * key's thirty-two bytes, the seat's thirty-two bytes.
 */
export function recordsKeyStatementBytes(company: CompanyLabel, recordsKey: string, seat: string): Uint8Array | null {
  const label = readCompanyLabel(company);
  if (label === null || typeof recordsKey !== 'string' || !HEX64.test(recordsKey)
    || typeof seat !== 'string' || !HEX64.test(seat)) return null;
  const enc = new TextEncoder();
  const tag = enc.encode(RECORDS_KEY_STATEMENT_TAG);
  const name = enc.encode(label);
  const key = fromHex(recordsKey);
  const leaf = fromHex(seat);
  const out = new Uint8Array(tag.length + 1 + name.length + 1 + key.length + leaf.length);
  out.set(tag, 0);
  out.set(name, tag.length + 1);
  out.set(key, tag.length + 1 + name.length + 1);
  out.set(leaf, tag.length + 1 + name.length + 1 + key.length);
  return out;
}

/**
 * **THE STATEMENT, SIGNED. Used inside the wallet only**, at the press on the
 * records-key screen, so the person has been shown that their records key is
 * being signed for this company and this seat.
 */
export function signRecordsKey(identity: Identity, company: CompanyLabel, companyKey: Uint8Array, seat: string): RecordsKeyStatement {
  const recordsKey = recordsPublicKeyOf(companyKey);
  const message = recordsKeyStatementBytes(company, recordsKey, seat);
  if (message === null) throw new Error('that is not a company\'s label and a seat on its account, so no records key was signed.');
  const secret = fromHex(committeeSigningKeyFor(identity, company).value);
  try {
    return Object.freeze({ recordsKey, seat, signature: toHex(schnorr.sign(message, secret)) });
  } finally {
    secret.fill(0);
  }
}

/**
 * **WHETHER A RECORDS KEY WAS SIGNED FOR THIS COMPANY BY THIS COMMITTEE KEY.**
 * Never throws: anything that is not a statement, a schnorr committee key or a
 * label is `false`.
 */
export function recordsKeySignedBy(
  company: CompanyLabel, committeeKey: { readonly tag: string; readonly value: string }, statement: RecordsKeyStatement,
): boolean {
  if (typeof committeeKey !== 'object' || committeeKey === null || committeeKey.tag !== 'schnorr'
    || typeof committeeKey.value !== 'string' || !HEX64.test(committeeKey.value)) return false;
  if (typeof statement !== 'object' || statement === null || typeof statement.signature !== 'string'
    || !HEX128.test(statement.signature)) return false;
  const message = recordsKeyStatementBytes(company, statement.recordsKey, statement.seat);
  if (message === null) return false;
  try {
    return schnorr.verify(fromHex(statement.signature), message, fromHex(committeeKey.value));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ the directory entry */

/**
 * **THE ENTRY A SIGNER HOLDS IN THEIR COMPANY'S SEAT DIRECTORY, SIGNED BY THIS
 * WALLET WITH THE SAME COMMITTEE KEY, FOR THE SAME SEAT.**
 *
 * The company's server keeps a plain table of who files its records under
 * which key. It is assumed to lie, so an entry in it is believed by a device
 * only when the signer's own wallet signed it: the signing key the signer's
 * filings are signed with, the wrapping key copies are sealed to (the records
 * key above, worked out here from the same company key), and the seat the
 * account holds for them now. A device checks the signature against the
 * committee the account lists on the chain and the seat against the seats the
 * account holds now, as it checks the records-key statement.
 *
 * **ITS OWN TAG**, so this statement is never the records-key statement and
 * never a change to a contract's rules, and the reverse.
 */
export const DIRECTORY_ENTRY_STATEMENT_TAG = 'midnight-identity:directory-entry-statement:v1';

/** What a signer's wallet signs for their directory entry, and the signature. */
export interface DirectoryEntryStatement {
  /** The signer's filing key: the ed25519 public key their filings are signed with, 64 lower-case hex characters. */
  readonly signingKey: string;
  /** The key copies are sealed to: their records key, 64 lower-case hex characters. */
  readonly wrappingKey: string;
  /** The seat the signer holds on the company's account, 64 lower-case hex characters. */
  readonly seat: string;
  /** The BIP-340 signature by the signer's committee key over the entry, 128 lower-case hex characters. */
  readonly signature: string;
}

/**
 * **THE BYTES SIGNED FOR AN ENTRY**, or `null` when any part is not one. The
 * tag, a zero byte, the label as written, a zero byte, then the signing key's,
 * the wrapping key's and the seat's thirty-two bytes each.
 */
export function directoryEntryStatementBytes(
  company: CompanyLabel, signingKey: string, wrappingKey: string, seat: string,
): Uint8Array | null {
  const label = readCompanyLabel(company);
  if (label === null || [signingKey, wrappingKey, seat].some((k) => typeof k !== 'string' || !HEX64.test(k))) return null;
  const enc = new TextEncoder();
  const tag = enc.encode(DIRECTORY_ENTRY_STATEMENT_TAG);
  const name = enc.encode(label);
  const parts = [fromHex(signingKey), fromHex(wrappingKey), fromHex(seat)];
  const out = new Uint8Array(tag.length + 1 + name.length + 1 + KEY_BYTES * 3);
  out.set(tag, 0);
  out.set(name, tag.length + 1);
  parts.forEach((part, i) => out.set(part, tag.length + 1 + name.length + 1 + KEY_BYTES * i));
  return out;
}

/** **THE ENTRY, SIGNED. Used inside the wallet only**, at the press that signs the records key. */
export function signDirectoryEntry(
  identity: Identity, company: CompanyLabel, companyKey: Uint8Array, signingKey: string, seat: string,
): DirectoryEntryStatement {
  const wrappingKey = recordsPublicKeyOf(companyKey);
  const message = directoryEntryStatementBytes(company, signingKey, wrappingKey, seat);
  if (message === null) throw new Error('that is not a company\'s label, a filing key and a seat on its account, so no entry was signed.');
  const secret = fromHex(committeeSigningKeyFor(identity, company).value);
  try {
    return Object.freeze({ signingKey, wrappingKey, seat, signature: toHex(schnorr.sign(message, secret)) });
  } finally {
    secret.fill(0);
  }
}

/**
 * **WHETHER A DIRECTORY ENTRY WAS SIGNED FOR THIS COMPANY BY THIS COMMITTEE
 * KEY.** Never throws: anything that is not an entry, a schnorr committee key
 * or a label is `false`.
 */
export function directoryEntrySignedBy(
  company: CompanyLabel, committeeKey: { readonly tag: string; readonly value: string }, entry: DirectoryEntryStatement,
): boolean {
  if (typeof committeeKey !== 'object' || committeeKey === null || committeeKey.tag !== 'schnorr'
    || typeof committeeKey.value !== 'string' || !HEX64.test(committeeKey.value)) return false;
  if (typeof entry !== 'object' || entry === null || typeof entry.signature !== 'string'
    || !HEX128.test(entry.signature)) return false;
  const message = directoryEntryStatementBytes(company, entry.signingKey, entry.wrappingKey, entry.seat);
  if (message === null) return false;
  try {
    return schnorr.verify(fromHex(entry.signature), message, fromHex(committeeKey.value));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the ask */

/** What this wallet hands back for a records-key ask. Everything in it is public. */
export interface RecordsKeyAnswer {
  readonly schema: typeof RECORDS_KEY_ANSWER_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  /** Echoed back, never read as authority. */
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly nonce: string;
  readonly at: number;
  /** This person's committee key for the company: the key the statement verifies against. */
  readonly committeeKey: { readonly tag: string; readonly value: string };
  readonly statement: RecordsKeyStatement;
  /** Who holds the account, as this wallet read it off the chain in the read that showed the label. */
  readonly seats: AccountSeats;
  /** Who holds the vault the ask named, as this wallet read it off the chain. Present exactly when the ask named one. */
  readonly vault?: VaultHolders;
  /** This signer's directory entry, signed in the same press. Present exactly when the ask named a filing key. */
  readonly entry?: DirectoryEntryStatement;
}

/** Thrown before anything is signed. Nothing has been given. */
export class RecordsKeyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordsKeyRefused';
  }
}

/**
 * The records key this wallet signs for `request`, worked out the same way the
 * answer works it out, so the person sees the key before they sign. The
 * company key it is worked out from is wiped before this returns.
 */
export function recordsKeyFor(identity: Identity, request: RecordsKeyRequest): string {
  const companyKey = unlockKeyFor(identity, { ...request, kind: 'unlock' } as unknown as UnlockRequest);
  try {
    return recordsPublicKeyOf(companyKey);
  } finally {
    companyKey.fill(0);
  }
}

const frozenKeys = (keys: readonly { readonly tag: string; readonly value: string }[]) =>
  Object.freeze(keys.map((k) => Object.freeze({ tag: k.tag, value: k.value.toLowerCase() })));

/**
 * **THE ANSWER THE PERSON'S PRESS PRODUCES, AND THE SEAT CHECK IS INSIDE IT.**
 * `seats` is what this wallet read off the account itself; a seat the account
 * does not hold now is refused before anything is signed, so this wallet never
 * signs a seat for somebody who has left. When the ask names a vault, `vault`
 * is what this wallet read off that vault itself, and an ask is refused when
 * this wallet has not read it, or when the vault is pinned to another account.
 */
export function recordsKeyAnswerFor(
  identity: Identity, request: RecordsKeyRequest, seats: AccountSeats, at: number, vault?: VaultHolders,
): RecordsKeyAnswer {
  if (!usableOrigin(request.requester.origin)) {
    throw new RecordsKeyRefused('This wallet could not tell who asked, so nothing has been signed.');
  }
  if (request.vault !== undefined && (vault === undefined || vault.vault !== request.vault)) {
    throw new RecordsKeyRefused(
      'This wallet has not read the vault the page names from the network, so nothing has been signed. Open this again in a minute.');
  }
  if (request.vault !== undefined && vault !== undefined && vault.account !== request.account) {
    throw new RecordsKeyRefused(
      'The vault the page names belongs to a different company account from this one, as this wallet read it from the '
      + 'network. Nothing has been signed.');
  }
  if (!seats.seats.includes(request.seat)) {
    throw new RecordsKeyRefused(
      'The seat the page names is not one this company\'s account holds now, as this wallet read it from the network. '
      + 'Nothing has been signed. If you have just been seated, wait a minute and try again.');
  }
  const companyKey = unlockKeyFor(identity, { ...request, kind: 'unlock' } as unknown as UnlockRequest);
  let statement: RecordsKeyStatement;
  let entry: DirectoryEntryStatement | undefined;
  try {
    statement = signRecordsKey(identity, request.company, companyKey, request.seat);
    if (request.signingKey !== undefined) entry = signDirectoryEntry(identity, request.company, companyKey, request.signingKey, request.seat);
  } finally {
    companyKey.fill(0);
  }
  return Object.freeze({
    schema: RECORDS_KEY_ANSWER_SCHEMA,
    origin: request.requester.origin,
    company: request.company,
    account: request.account,
    nonce: request.nonce,
    at,
    committeeKey: committeeKeyFor(identity, request.company) as { tag: string; value: string },
    statement,
    seats: Object.freeze({
      committee: frozenKeys(seats.committee),
      threshold: seats.threshold,
      seats: Object.freeze([...seats.seats]),
    }),
    ...(request.vault === undefined || vault === undefined ? {} : {
      vault: Object.freeze({ vault: vault.vault, account: vault.account, committee: frozenKeys(vault.committee), threshold: vault.threshold }),
    }),
    ...(entry === undefined ? {} : { entry }),
  });
}

export type RecordsKeyRead =
  | {
    readonly ok: true;
    readonly committeeKey: { readonly tag: string; readonly value: string };
    readonly statement: RecordsKeyStatement;
    readonly seats: AccountSeats;
    /** Who holds the vault the ask named, as the wallet read it; null when the ask named none. */
    readonly vault: VaultHolders | null;
    /** This signer's directory entry, signed in the same press; null when the ask named no filing key. */
    readonly entry: DirectoryEntryStatement | null;
    readonly at: number;
  }
  | { readonly ok: false; readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch' | 'other-company' | 'not-signed'; readonly says: string };

/** Who holds the account, as an answer carries it, or null for a shape no wallet writes. */
const readSeats = (value: unknown): AccountSeats | null => {
  const v = value as Partial<AccountSeats> | null;
  if (typeof v !== 'object' || v === null || !Array.isArray(v.committee) || !Array.isArray(v.seats)
    || !Number.isSafeInteger(v.threshold) || (v.threshold as number) < 0) return null;
  const committee: { tag: string; value: string }[] = [];
  for (const k of v.committee) {
    const key = readCommitteeKey(k);
    if (key === null) return null;
    committee.push({ tag: key.tag, value: key.value });
  }
  if (!v.seats.every((x) => typeof x === 'string' && HEX64.test(x)) || new Set(v.seats).size !== v.seats.length) return null;
  return Object.freeze({ committee: Object.freeze(committee), threshold: v.threshold as number, seats: Object.freeze([...v.seats as string[]]) });
};

/** Who holds a vault, as an answer carries it, or null for a shape no wallet writes. */
const readVaultHolders = (value: unknown): VaultHolders | null => {
  const v = value as Partial<VaultHolders> | null;
  if (typeof v !== 'object' || v === null || typeof v.vault !== 'string' || !HEX64.test(v.vault)
    || typeof v.account !== 'string' || !HEX64.test(v.account) || !Array.isArray(v.committee)
    || !Number.isSafeInteger(v.threshold) || (v.threshold as number) < 0) return null;
  const committee: { tag: string; value: string }[] = [];
  for (const k of v.committee) {
    const key = readCommitteeKey(k);
    if (key === null) return null;
    committee.push({ tag: key.tag, value: key.value });
  }
  return Object.freeze({ vault: v.vault, account: v.account, committee: Object.freeze(committee), threshold: v.threshold as number });
};

/**
 * **THE PAGE'S SIDE OF A RECORDS-KEY ANSWER.** Every expectation is the page's
 * own: where it is, the nonce it chose, the company, the account and the seat
 * it asked about. The statement must verify against the committee key beside
 * it. What the seats and the committee key are worth is decided by whoever
 * checks a secret's readers against them, not here.
 */
export function readRecordsKeyAnswer(
  message: unknown,
  expecting: {
    readonly atOrigin: string; readonly expectingNonce: string;
    readonly company: CompanyLabel; readonly account: AccountAddress; readonly seat: string;
    /** The vault the ask named, when it named one: the answer must carry who holds exactly that vault. */
    readonly vault?: string;
    /** The filing key the ask named, when it named one: the answer must carry the entry signed for exactly it. */
    readonly signingKey?: string;
  },
): RecordsKeyRead {
  const body = message as Partial<RecordsKeyAnswer> | null;
  if (typeof body !== 'object' || body === null || body.schema !== RECORDS_KEY_ANSWER_SCHEMA) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a signed records key.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return { ok: false, code: 'origin-mismatch', says: `this was signed for ${String(body.origin)} and arrived at ${expecting.atOrigin}. It is refused.` };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return { ok: false, code: 'nonce-mismatch', says: 'this answers a different request from the one that was sent.' };
  }
  if (readCompanyLabel(body.company) !== expecting.company || readAccountAddress(body.account) !== expecting.account) {
    return { ok: false, code: 'other-company', says: 'this signs a records key for a different company from the one asked about. It is refused.' };
  }
  const committeeKey = readCommitteeKey(body.committeeKey);
  const statement = body.statement;
  const seats = readSeats(body.seats);
  const vault = expecting.vault === undefined ? null : readVaultHolders(body.vault);
  if (expecting.vault !== undefined && (vault === null || vault.vault !== expecting.vault)) {
    return { ok: false, code: 'not-an-answer', says: 'that answer does not say who holds the vault that was asked about.' };
  }
  if (committeeKey === null || seats === null || typeof body.at !== 'number' || !Number.isSafeInteger(body.at)
    || typeof statement !== 'object' || statement === null) {
    return { ok: false, code: 'not-an-answer', says: 'that is not a signed records key.' };
  }
  if (statement.seat !== expecting.seat || !recordsKeySignedBy(expecting.company, committeeKey, statement)) {
    return {
      ok: false, code: 'not-signed',
      says: 'this answer does not carry your records key signed by your wallet for this company and your seat. It is refused.',
    };
  }
  let entry: DirectoryEntryStatement | null = null;
  if (expecting.signingKey !== undefined) {
    const e = body.entry;
    if (typeof e !== 'object' || e === null || e.signingKey !== expecting.signingKey || e.seat !== expecting.seat
      || e.wrappingKey !== statement.recordsKey || !directoryEntrySignedBy(expecting.company, committeeKey, e)) {
      return {
        ok: false, code: 'not-signed',
        says: 'this answer does not carry your directory entry signed by your wallet for this company, your filing key and your seat. It is refused.',
      };
    }
    entry = Object.freeze({ signingKey: e.signingKey, wrappingKey: e.wrappingKey, seat: e.seat, signature: e.signature });
  }
  return {
    ok: true,
    committeeKey: { tag: committeeKey.tag, value: committeeKey.value },
    statement: Object.freeze({ recordsKey: statement.recordsKey, seat: statement.seat, signature: statement.signature }),
    seats,
    vault,
    entry,
    at: body.at,
  };
}

/* ------------------------------------------------------------------ who holds it, with no press */

/** The answer this wallet gives a holders ask. */
export const HOLDERS_ANSWER_SCHEMA = 'midnight-identity/holders-answer/v1';

/**
 * **WHO HOLDS A COMPANY'S ACCOUNT, AS A WALLET READ IT OFF THE CHAIN ITSELF,
 * WITH THE ACCOUNT'S OWN RULES BESIDE IT**: everything in `AccountSeats`, the
 * number of approvals the account itself requires, and every vault it has
 * adopted. Public chain facts only.
 */
export interface AccountHolders extends AccountSeats {
  /** The approvals the account requires, as its own state holds it. */
  readonly approvals: number;
  /** Every vault the account has adopted and not retired, each 64 lower-case hex characters. */
  readonly adoptedVaults: readonly string[];
}

/** What this wallet hands back for a holders ask. Everything in it is public, and nothing in it is signed. */
export interface HoldersAnswer {
  readonly schema: typeof HOLDERS_ANSWER_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly nonce: string;
  readonly at: number;
  readonly holders: AccountHolders;
}

/** Who holds an account, with its rules, as an answer carries it, or null for a shape no wallet writes. */
const readHolders = (value: unknown): AccountHolders | null => {
  const seats = readSeats(value);
  const v = value as Partial<AccountHolders> | null;
  if (seats === null || v === null || typeof v !== 'object' || !Number.isSafeInteger(v.approvals)
    || (v.approvals as number) < 1 || !Array.isArray(v.adoptedVaults)) return null;
  if (!v.adoptedVaults.every((x) => typeof x === 'string' && HEX64.test(x)) || new Set(v.adoptedVaults).size !== v.adoptedVaults.length) return null;
  return Object.freeze({ ...seats, approvals: v.approvals as number, adoptedVaults: Object.freeze([...v.adoptedVaults as string[]]) });
};

/**
 * **THE ANSWER TO A HOLDERS ASK.** Refused when this wallet could not tell who
 * asked.
 */
export function holdersAnswerFor(request: HoldersRequest, holders: AccountHolders, at: number): HoldersAnswer {
  if (!usableOrigin(request.requester.origin)) {
    throw new RecordsKeyRefused('This wallet could not tell who asked, so nothing has been handed back.');
  }
  return Object.freeze({
    schema: HOLDERS_ANSWER_SCHEMA,
    origin: request.requester.origin,
    company: request.company,
    account: request.account,
    nonce: request.nonce,
    at,
    holders: Object.freeze({
      committee: frozenKeys(holders.committee), threshold: holders.threshold, seats: Object.freeze([...holders.seats]),
      approvals: holders.approvals, adoptedVaults: Object.freeze([...holders.adoptedVaults]),
    }),
  });
}

export type HoldersRead =
  | { readonly ok: true; readonly holders: AccountHolders; readonly at: number }
  | { readonly ok: false; readonly code: 'not-an-answer' | 'origin-mismatch' | 'nonce-mismatch' | 'other-company'; readonly says: string };

/**
 * **THE PAGE'S SIDE OF A HOLDERS ANSWER.** Every expectation is the page's own:
 * where it is, the nonce it chose, the company and the account it asked about. Nothing in it is signed: what it is worth is that it came from
 * the person's own wallet over this page's own channel.
 */
export function readHoldersAnswer(
  message: unknown,
  expecting: {
    readonly atOrigin: string; readonly expectingNonce: string;
    readonly company: CompanyLabel; readonly account: AccountAddress;
  },
): HoldersRead {
  const body = message as Partial<HoldersAnswer> | null;
  if (typeof body !== 'object' || body === null || body.schema !== HOLDERS_ANSWER_SCHEMA) {
    return { ok: false, code: 'not-an-answer', says: 'that is not an answer saying who holds the company.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return { ok: false, code: 'origin-mismatch', says: `this was read for ${String(body.origin)} and arrived at ${expecting.atOrigin}. It is refused.` };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return { ok: false, code: 'nonce-mismatch', says: 'this answers a different request from the one that was sent.' };
  }
  if (readCompanyLabel(body.company) !== expecting.company || readAccountAddress(body.account) !== expecting.account) {
    return { ok: false, code: 'other-company', says: 'this says who holds a different company from the one asked about. It is refused.' };
  }
  const holders = readHolders(body.holders);
  if (holders === null || typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-an-answer', says: 'that is not an answer saying who holds the company.' };
  }
  return { ok: true, holders, at: body.at };
}
