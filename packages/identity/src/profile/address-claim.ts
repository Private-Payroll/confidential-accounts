/* A WALLET'S CLAIM THAT IT HOLDS AN UNSHIELDED ADDRESS, for a person or vendor added to a company by that address.
 *
 * The person who adds them types the address; the record keeps it (`invitedAddress`); the wallet that
 * claims the record signs a claim with the address's own key, and every device that reads the record checks
 * that signature before it believes the record can be paid. No fingerprint is read out for an unshielded
 * address: the signature is what binds the claim to the address that was typed.
 *
 * A SHIELDED address has no claim. No device here can check a proof that a wallet holds one (the ledger
 * package this build ships verifies no contract proof), so a person added by a shielded address hands over
 * their code as a person invited by link does, and is admitted only on the fingerprint they read out.
 *
 * The challenge commits to everything a copy of a claim could be reused for: the company, the person or
 * vendor, the payslip key, the address and the network. A claim made for one of them is no claim for any
 * other. The signature is made and checked in address-claim-signed.ts; this file names the challenge and
 * the claim's shape, and loads nothing of the ledger, so every reader of a record can read a claim's shape
 * at no cost. */
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';

/** The tag the challenge is made under. A new version of the claim is a new tag. */
export const ADDRESS_CLAIM_DOMAIN = 'midnight-accounts/address-claim/v1';

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const ADDRESS = /^[\x21-\x7e]{40,200}$/u;
const PERSON = /^[A-Za-z0-9_-]{1,64}$/u;
const NETWORK = /^[a-z0-9-]{1,32}$/u;

/** What a claim is about. Every field is in the challenge. */
export interface AddressClaimFor {
  /** The company's label, as its join codes name it. */
  readonly company: string;
  /** The person's or vendor's record id. */
  readonly person: string;
  /** The payslip key the wallet gives for this company. */
  readonly payslipKey: string;
  /** The address typed when they were added, exactly as typed (bech32). */
  readonly address: string;
  /** The network the address is on. */
  readonly network: string;
}

/**
 * Whether a typed address is a shielded one, read from its prefix alone. A person added by a shielded address
 * is admitted on the fingerprint they read out; one added by an unshielded address, on their wallet's claim.
 */
export const typedAddressIsShielded = (address: string): boolean => address.trim().startsWith('mn_shield-addr');

/** A claim by an unshielded address: the address's own key signed the challenge. */
export interface UnshieldedAddressClaim {
  readonly kind: 'unshielded';
  readonly address: string;
  readonly verifyingKey: string;
  readonly signature: string;
}

/** A claim of an address. Only an unshielded address has one. */
export type AddressClaim = UnshieldedAddressClaim;

const forRefusal = (f: AddressClaimFor): string | null => {
  if (typeof f !== 'object' || f === null) return 'it names nothing it is for';
  if (typeof f.company !== 'string' || f.company.length === 0 || f.company.length > 200) return 'it names no company';
  if (typeof f.person !== 'string' || !PERSON.test(f.person)) return 'it names no person or vendor record';
  if (typeof f.payslipKey !== 'string' || !HEX64.test(f.payslipKey)) return 'it names no payslip key';
  if (typeof f.address !== 'string' || !ADDRESS.test(f.address)) return 'it names no address';
  if (typeof f.network !== 'string' || !NETWORK.test(f.network)) return 'it names no network';
  return null;
};

/**
 * The thirty-two bytes a claim answers, as hex: SHA-256 over the tag and every field, in a fixed order.
 * Throws when a field is not one a claim can be about.
 */
export function addressClaimChallenge(f: AddressClaimFor): string {
  const why = forRefusal(f);
  if (why !== null) throw new Error(`this is not something an address can be claimed for: ${why}.`);
  const text = JSON.stringify([ADDRESS_CLAIM_DOMAIN, f.company, f.person, f.payslipKey.toLowerCase(), f.address, f.network]);
  return Buffer.from(sha256(new TextEncoder().encode(text))).toString('hex');
}

/** Reads a claim's shape, or null when it is not one. Nothing is checked beyond its shape. */
export function readAddressClaim(value: unknown): AddressClaim | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (v.kind === 'unshielded' && keys === 'address,kind,signature,verifyingKey'
    && typeof v.address === 'string' && ADDRESS.test(v.address)
    && typeof v.verifyingKey === 'string' && HEX64.test(v.verifyingKey)
    && typeof v.signature === 'string' && HEX128.test(v.signature)) {
    return Object.freeze({ kind: 'unshielded', address: v.address, verifyingKey: v.verifyingKey, signature: v.signature });
  }
  return null;
}

/** The tag of what a wallet hands a company when it claims a record by the address it was added by. */
export const CLAIMED_HANDOVER_SCHEMA = 'midnight-accounts/address-claim-handover/v1';

/**
 * What a wallet seals to the company when it claims a record it was added to by address: its join code
 * (where it is paid and its payslip key, signed by its company key) and its claim of the unshielded address.
 * No fingerprint is read out for it: the claim is what proves the address.
 */
export interface ClaimedHandover {
  readonly schema: typeof CLAIMED_HANDOVER_SCHEMA;
  readonly code: unknown;
  readonly claim: AddressClaim;
}

/** Reads a claimed handover's shape, or null when it is not one. The code inside is read by its own reader. */
export function readClaimedHandover(value: unknown): ClaimedHandover | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== CLAIMED_HANDOVER_SCHEMA || Object.keys(v).sort().join(',') !== 'claim,code,schema') return null;
  const claim = readAddressClaim(v.claim);
  if (claim === null || typeof v.code !== 'object' || v.code === null) return null;
  return Object.freeze({ schema: CLAIMED_HANDOVER_SCHEMA, code: v.code, claim });
}
