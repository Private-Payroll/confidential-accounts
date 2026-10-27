/* AN UNSHIELDED ADDRESS'S CLAIM, SIGNED AND CHECKED. The address is the hash of the verifying key, as the ledger
 * makes it; the address's own key signs the claim's challenge (`addressClaimChallenge`) under its own tag, so the
 * signature is never one over anything else. Kept apart from address-claim.ts because it loads the ledger. */
import { Buffer } from 'buffer';
import { addressFromKey, signData, signatureVerifyingKey, verifySignature } from '@midnightntwrk/ledger-v9';
import { UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import type { Identity } from '../keys/derivation.js';
import { addressClaimChallenge, readAddressClaim, type AddressClaimFor, type UnshieldedAddressClaim } from './address-claim.js';

/**
 * The tag an unshielded claim's signature is made under, and the first bytes of everything this module signs. It
 * begins `midnight-`, where every signing envelope of the ledger begins `midnight:`, so what a spending key signs here
 * is never readable as an authorisation the ledger would accept.
 */
export const ADDRESS_CLAIM_SIGNED_DOMAIN = 'midnight-accounts/address-claim-signature/v1:';
const SIGNED_DOMAIN = ADDRESS_CLAIM_SIGNED_DOMAIN;

/* The unshielded address a verifying key makes on a network: the hash of the key, as the ledger makes it. The same
 * address a disclosure's signer is checked against (`addressOfVerifyingKey`, disclosure.ts). */
const addressOfVerifyingKey = (verifyingKey: string, networkId: Parameters<typeof UnshieldedAddress.codec.encode>[0]): string =>
  UnshieldedAddress.codec.encode(networkId, new UnshieldedAddress(Buffer.from(addressFromKey({ tag: 'schnorr', value: verifyingKey }), 'hex'))).asString();

const signedBytes = (challenge: string): Uint8Array =>
  Uint8Array.from([...new TextEncoder().encode(SIGNED_DOMAIN), ...Buffer.from(challenge, 'hex')]);

/**
 * The claim an unshielded address makes: the wallet signs the challenge with the key of the subwallet
 * whose unshielded address was typed. The caller has checked that the address is that subwallet's.
 */
export function signUnshieldedClaim(identity: Identity, account: number, f: AddressClaimFor): UnshieldedAddressClaim {
  const challenge = addressClaimChallenge(f);
  const key = { tag: 'schnorr' as const, value: Buffer.from(identity.moneyAt(account).night).toString('hex') };
  const signature = signData(key, signedBytes(challenge) as Uint8Array<ArrayBuffer>);
  return Object.freeze({ kind: 'unshielded', address: f.address, verifyingKey: signatureVerifyingKey(key).value, signature: signature.value });
}

/**
 * Why an unshielded claim does not prove its address for what it is for, or null when it does: the
 * address is the one its verifying key makes, and that key signed this claim's challenge.
 */
export function unshieldedClaimRefusal(
  claim: UnshieldedAddressClaim, f: AddressClaimFor, networkId: Parameters<typeof addressOfVerifyingKey>[1],
): string | null {
  if (readAddressClaim(claim)?.kind !== 'unshielded') return 'the claim is not an unshielded address\'s claim';
  if (claim.address !== f.address) return 'the claim names another address than the one that was typed';
  let challenge: string;
  try { challenge = addressClaimChallenge(f); } catch (e) { return (e as Error).message; }
  let derived: string;
  try { derived = addressOfVerifyingKey(claim.verifyingKey, networkId); } catch { return 'the claim\'s verifying key is not a usable one'; }
  if (derived !== f.address) return 'the claim was signed by the owner of another address than the one that was typed';
  let good = false;
  try {
    good = verifySignature({ tag: 'schnorr', value: claim.verifyingKey }, signedBytes(challenge) as Uint8Array<ArrayBuffer>,
      { tag: 'schnorr', value: claim.signature });
  } catch { good = false; }
  return good ? null : 'the claim\'s signature is not the address\'s over this company, person, payslip key and address';
}

