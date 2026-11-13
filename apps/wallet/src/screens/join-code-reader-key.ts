import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes, type Identity } from 'midnight-identity';
import { readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { JoinCodeRequest } from 'midnight-identity/profile/request';
import type { WrappingKeypair } from '../../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { watchFor } from '../keyring/nothing-secret-crosses.js';
import { payslipKeyOfThisWallet } from './join-code-payslip-key.js';

/**
 * **THE KEY A READER OF A COMPANY READS ITS RECORDS WITH, DERIVED IN THE READER'S OWN WALLET AND NEVER KEPT.**
 *
 * A company's read grants wrap the keys for the records a reader may read to this key's public half. It comes from
 * the seed's reader authority (`Purposes.Reader`, a parent no other key shares) under a salt of its own, per company
 * label, so it is none of the keys this wallet releases for a company: knowing a released company key, a payslip key or a records key gives
 * nothing of it. It is worked out each time it is needed, its root is wiped once used, and its secret is watched, so
 * a message that would carry it to a page is refused (`checkedChannel`).
 */
const READER_SALT = new TextEncoder().encode('midnight-identity/reader-key/v1');
const READER_PARENT_INDEX = 0;
const KEY_BYTES = 32;

/** This wallet's reader keypair for the company `label` names. Refuses a label that is not one. */
export function readerKeypairOfThisWallet(identity: Identity, label: string): WrappingKeypair {
  const company = readCompanyLabel(label);
  if (company === null) throw new Error('that is not a company\'s label, so no key to read its records with is worked out.');
  const parent = identity.authority(Purposes.Reader, READER_PARENT_INDEX);
  const root = hkdf(sha256, parent, READER_SALT, new TextEncoder().encode(company), KEY_BYTES);
  try {
    const pair = recordsKeypairFrom(root);
    watchFor(root);
    watchFor(pair.secret);
    return { secret: pair.secret.toLowerCase(), publicKey: pair.publicKey.toLowerCase() };
  } finally {
    root.fill(0);
  }
}

/** The public half alone: what a reader's join code carries. */
export const readerKeyOfThisWallet = (identity: Identity, label: string): string => readerKeypairOfThisWallet(identity, label).publicKey;

/** This wallet's own keys a join-code ask needs: its payslip key for a payee's code, its reader key for a reader's. */
export const ownJoinKeysOf = (identity: Identity, request: JoinCodeRequest): { readonly ownPayslipKey: string | null; readonly ownReaderKey: string | null } => ({
  ownPayslipKey: request.parts.kind === 'payee' ? payslipKeyOfThisWallet(identity, request) : null,
  ownReaderKey: request.parts.kind === 'reader' ? readerKeyOfThisWallet(identity, request.company) : null,
});
