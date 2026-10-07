/**
 * **THE PAY-RECORD KEY AGAINST THE ACCOUNT'S COMMITMENT TO IT**, with the
 * contract's own circuits. Kept apart from the key's derivations
 * (`run-keys.ts`), which need no circuit, so code that only derives nonces and
 * seeds loads no contract.
 */
import { toHex, fromHex, unwrapKey, type Hex } from '../core/crypto.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { PAY_KEY_WRAP_PARTS } from './run-keys.js';

/**
 * **WHAT EVERY DEVICE CHECKS THE PAY-RECORD KEY IT UNSEALED AGAINST.** The
 * contract's own `payKeyCommitmentOf`, never derived a second way. The account
 * holds one, written under an approved proposal, so a copy sealed with the
 * wrong key is found out on the first device that opens it.
 */
export const payKeyCommitmentOf = (key: Hex): Hex =>
  toHex(pureCircuits.payKeyCommitmentOf(fromHex(key)));

/** What signers approve to commit the account to its pay-record key. The contract's own `payKeyPayload`. */
export const payKeyPayloadOf = (commitment: Hex): Hex =>
  toHex(pureCircuits.payKeyPayload(fromHex(commitment)));

/**
 * **A SIGNER'S OWN SEALED COPY, OPENED AND CHECKED AGAINST THE ACCOUNT'S
 * COMMITMENT.** Refuses a copy that does not open with this signer's wrapping
 * secret, and a key that opens but is not the one the account committed to -
 * a key derived from it would give nonces that match nothing on chain, and the
 * account would not refuse a second payment made under them.
 */
export const openSealedPayKey = (parts: Hex[], wrappingSecret: Hex, commitment: Hex): Hex => {
  if (parts.length !== PAY_KEY_WRAP_PARTS || parts.some(p => fromHex(p).length !== 32)) {
    throw new Error('a sealed pay-record key is four 32-byte entries');
  }
  const packed = new Uint8Array(32 * PAY_KEY_WRAP_PARTS);
  parts.forEach((p, i) => packed.set(fromHex(p), 32 * i));
  const key = unwrapKey({
    ephemeral: toHex(packed.slice(0, 32)),
    iv: toHex(packed.slice(32, 44)),
    tag: '',
    body: toHex(packed.slice(44, 124)),
  }, wrappingSecret);
  if (payKeyCommitmentOf(key).toLowerCase() !== commitment.toLowerCase()) {
    throw new Error(
      'your copy of the company\'s pay-record key on chain does not open to the key this company '
      + 'confirmed, so it cannot be used. Use the key from the company\'s sealed records instead.');
  }
  return key;
};
