import type { Identity } from 'midnight-identity/keys/derivation';
import type { JoinCodeRequest, UnlockRequest } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import { payslipKeypairFrom } from '../../../../src/core/payslip-key-derive.js';

/**
 * **THE PAYSLIP PUBLIC KEY THIS WALLET GIVES FOR THE COMPANY A JOIN CODE
 * NAMES**, worked out from the key it releases for that company by the payslip
 * key's one derivation (`payslipKeypairFrom`), and nothing else. The released
 * key is zeroed once it has been used. Here, in the wallet, so the code's own
 * module stays light enough for the pages that read codes.
 */
export function payslipKeyOfThisWallet(identity: Identity, request: JoinCodeRequest): string {
  const companyKey = unlockKeyFor(identity, { ...request, kind: 'unlock' } as unknown as UnlockRequest);
  try {
    return payslipKeypairFrom(companyKey).publicKey.toLowerCase();
  } finally {
    companyKey.fill(0);
  }
}
