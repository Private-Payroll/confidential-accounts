/**
 * **A JOIN CODE: WHAT A PERSON'S OWN WALLET SIGNS SO A COMPANY CAN ADD THEM
 * WITHOUT SENDING THEM A LINK.**
 *
 * The other way into a company runs the other way round: the person makes the
 * code and gives it to somebody already in the company, who pastes it. A code
 * names the company by its label, names the person by the id they signed in
 * with, and carries only public parts:
 *
 *   · **a signer's**: the public halves of the seat keys their device made, and
 *     the leaf worked out from them; the secrets never leave that device;
 *   · **a payee's**: an address this wallet receives at, and the public key
 *     their payslips are sealed to.
 *
 * All of it is signed by this wallet's committee key for that company's label,
 * so a code with any part swapped fails its signature. **A whole code swapped
 * for somebody else's still verifies** - it is that person's signature - which
 * is what the fingerprint is for: the person reads theirs off their own device
 * and the one adding them compares it with the one their device works out
 * from the code (`seatKeyFingerprint`, `payeeCodeFingerprint`).
 *
 * The same code is what a person's device hands over when they accept a link
 * instead, so the two ways in end in one package.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { Identity } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import { readCompanyLabel, type CompanyLabel } from './company-label.js';
import { usableOrigin } from './origin.js';
import { readJoinParts, type JoinParts } from './join-parts.js';

export { readJoinParts, type JoinParts, type PayeeParts, type SignerParts } from './join-parts.js';
import type { JoinCodeRequest } from './request.js';

export const JOIN_CODE_SCHEMA = 'midnight-identity/join-code/v1' as const;
const SIGNED_TAG = 'midnight-identity/join-code-signed/v1';
/** What a code's text starts with, so a pasted code is told from anything else pasted. */
export const JOIN_CODE_PREFIX = 'mnjoin1.';

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const PERSON = /^[A-Za-z0-9_-]{1,64}$/u;

export interface JoinCode {
  readonly schema: typeof JOIN_CODE_SCHEMA;
  /** The company, by its label. */
  readonly company: CompanyLabel;
  /** The id the person signed in to the company's service with. */
  readonly person: string;
  readonly parts: JoinParts;
  /** This wallet's committee key for the company's label. */
  readonly committeeKey: { readonly tag: string; readonly value: string };
  /** By that key, over everything above. */
  readonly signature: string;
}

/** The bytes a code's signature covers, or null when any part is not one. */
export function joinCodeBytes(company: CompanyLabel, person: string, parts: JoinParts): Uint8Array | null {
  const label = readCompanyLabel(company);
  const read = readJoinParts(parts);
  if (label === null || typeof person !== 'string' || !PERSON.test(person) || read === null) return null;
  const fields = read.kind === 'signer'
    ? [read.kind, read.signingPublicKey, read.wrappingPublicKey, read.leafCommitment]
    : [read.kind, read.address, read.payslipKey];
  return sha256(new TextEncoder().encode(JSON.stringify([SIGNED_TAG, label, person, ...fields])));
}

/**
 * **A CODE, SIGNED. Used inside the wallet only**, at the press on the
 * code screen, after the person was shown which company and what it carries.
 */
export function signJoinCode(identity: Identity, company: CompanyLabel, person: string, parts: JoinParts): JoinCode {
  const message = joinCodeBytes(company, person, parts);
  if (message === null) throw new Error('that is not a company\'s label, a sign-in and a code\'s parts, so no code was made.');
  const secret = Uint8Array.from((committeeSigningKeyFor(identity, company).value.match(/../gu) ?? []).map((x) => Number.parseInt(x, 16)));
  try {
    const signature = Array.from(schnorr.sign(message, secret), (b) => b.toString(16).padStart(2, '0')).join('');
    const committeeKey = committeeKeyFor(identity, company);
    return Object.freeze({
      schema: JOIN_CODE_SCHEMA, company, person, parts: readJoinParts(parts)!,
      committeeKey: Object.freeze({ tag: committeeKey.tag, value: committeeKey.value }), signature,
    });
  } finally {
    secret.fill(0);
  }
}

/** Whether a code is signed, over exactly what it carries, by the committee key it names. Never throws. */
export function joinCodeSignedBy(code: JoinCode): boolean {
  if (typeof code !== 'object' || code === null || code.schema !== JOIN_CODE_SCHEMA) return false;
  const k = code.committeeKey;
  if (typeof k !== 'object' || k === null || k.tag !== 'schnorr' || typeof k.value !== 'string' || !HEX64.test(k.value)) return false;
  if (typeof code.signature !== 'string' || !HEX128.test(code.signature)) return false;
  const message = joinCodeBytes(code.company, code.person, code.parts);
  if (message === null) return false;
  try {
    const hex = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
    return schnorr.verify(hex(code.signature), message, hex(k.value));
  } catch {
    return false;
  }
}

/** A code as text to paste: the prefix, then the code's JSON in base64url. */
export function writeJoinCode(code: JoinCode): string {
  const bytes = new TextEncoder().encode(JSON.stringify(code));
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return JOIN_CODE_PREFIX + btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Why a pasted code is not one, each a sentence the person pasting it can act on. */
export const JOIN_CODE_REFUSAL = {
  'not-a-code': 'what was pasted is not a join code. Ask the person for the code their wallet made, and paste all of it.',
  'not-signed': 'this code is not signed by the wallet it names, over exactly what it carries, so a part of it was changed. Ask the person to make a new code.',
  'another-company': 'this code was made for another company. Ask the person to make one for this company.',
} as const;
export type JoinCodeRefusal = keyof typeof JOIN_CODE_REFUSAL;

/** A pasted code, read and checked: signed, and for `company`. */
export function readJoinCode(text: string, company: CompanyLabel): JoinCode | JoinCodeRefusal {
  if (typeof text !== 'string' || !text.trim().startsWith(JOIN_CODE_PREFIX)) return 'not-a-code';
  let code: JoinCode;
  try {
    const b64 = text.trim().slice(JOIN_CODE_PREFIX.length).replace(/-/gu, '+').replace(/_/gu, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    code = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))) as JoinCode;
  } catch {
    return 'not-a-code';
  }
  if (typeof code !== 'object' || code === null || code.schema !== JOIN_CODE_SCHEMA
    || Object.keys(code).sort().join(',') !== 'committeeKey,company,parts,person,schema,signature') return 'not-a-code';
  if (!joinCodeSignedBy(code)) return 'not-signed';
  if (code.company !== company) return 'another-company';
  return Object.freeze({ ...code, parts: readJoinParts(code.parts)! });
}

/** Thrown when this wallet will not make the code asked for; the message is the sentence the screen shows. */
export class JoinCodeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinCodeRefused';
  }
}

/**
 * **WHY THIS WALLET WILL NOT SIGN A CODE THE PAGE ASKED FOR**, or null when
 * it will: a payee's code names only an address this wallet receives at
 * (`receives`) and only the payslip key this wallet gives for that company
 * (`ownPayslipKey`), so a page cannot have this wallet sign somebody else's
 * address as where the person is paid, or somebody else's key as the one their
 * payslips are sealed to. The screen says this sentence; the press refuses on it.
 */
export function whyNoJoinCode(request: JoinCodeRequest, receives: readonly string[], ownPayslipKey: string | null): string | null {
  if (request.parts.kind !== 'payee') return null;
  if (!receives.includes(request.parts.address)) {
    return 'The address the page names is not one this wallet receives at, so this wallet will not sign it as where you are paid. No code has been made.';
  }
  if (ownPayslipKey === null || request.parts.payslipKey.toLowerCase() !== ownPayslipKey.toLowerCase()) {
    return 'The payslip key the page names is not the one this wallet gives for this company, so your payslips would be sealed to somebody else. No code has been made.';
  }
  return null;
}

/**
 * **THE CODE THIS WALLET MAKES AT THE PRESS**, for the ask the page made,
 * refused for any reason `whyNoJoinCode` gives.
 */
export function joinCodeAnswerFor(
  identity: Identity, request: JoinCodeRequest, receives: readonly string[], ownPayslipKey: string | null,
): JoinCode {
  if (!usableOrigin(request.requester.origin)) {
    throw new JoinCodeRefused('This wallet could not tell who asked, so no code has been made.');
  }
  const why = whyNoJoinCode(request, receives, ownPayslipKey);
  if (why !== null) throw new JoinCodeRefused(why);
  return signJoinCode(identity, request.company, request.person, request.parts);
}
