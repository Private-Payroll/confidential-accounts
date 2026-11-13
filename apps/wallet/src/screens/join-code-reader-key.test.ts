/**
 * **A READER'S KEY IS ITS OWN WALLET'S, PER COMPANY, AND NONE OF THE KEYS A WALLET RELEASES.** Worked out from the seed
 * each time, never kept, and watched so that no message to a page carries its secret.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity/keys/derivation';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { fromHex } from '../../../../src/core/crypto.js';
import { payslipKeypairFrom } from '../../../../src/core/payslip-key-derive.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { companyKeyOf } from '../actions/company-reach.js';
import { carriesASecret, forgetWatched } from '../keyring/nothing-secret-crosses.js';
import { readerKeypairOfThisWallet } from './join-code-reader-key.js';

const CO = `co_${'c3'.repeat(32)}` as CompanyLabel;
const OTHER = `co_${'c4'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'ab'.repeat(32) as AccountAddress;
const secret = new Uint8Array(32).fill(5);
const me = identityFromSecret(secret);

describe('A READER\'S KEY', () => {
  it('IS THE SAME EACH TIME FOR ONE COMPANY, ANOTHER FOR ANOTHER, AND NONE OF THE KEYS THE WALLET RELEASES FOR THE COMPANY', () => {
    const pair = readerKeypairOfThisWallet(me, CO);
    expect(readerKeypairOfThisWallet(me, CO)).toEqual(pair);
    /* RED WHEN: the reader key's parent, salt or company changes, which would leave every grant wrapped to readers unopened. */
    expect(pair.publicKey).toBe('f4f73a020f041823f9a4c3a74f6eb58f7f7be228a93645bc774452de1e6dd018');
    expect(pair.publicKey).toMatch(/^[0-9a-f]{64}$/u);
    /* RED WHEN: one reader key serves every company, so one grant's wraps open another company's. */
    expect(readerKeypairOfThisWallet(me, OTHER).publicKey).not.toBe(pair.publicKey);
    expect(readerKeypairOfThisWallet(identityFromSecret(new Uint8Array(32).fill(6)), CO).publicKey).not.toBe(pair.publicKey);
    /* RED WHEN: a reader's key is the records key or payslip key of the company key every page of the company is given. */
    const released = fromHex(companyKeyOf({ held: { identity: me, secret }, asker: { origin: 'https://payroll.example', name: 'P', rdns: 'p' } }, CO, ACCOUNT));
    expect(pair.publicKey).not.toBe(recordsKeypairFrom(released).publicKey.toLowerCase());
    expect(pair.publicKey).not.toBe(payslipKeypairFrom(released).publicKey.toLowerCase());
    expect(() => readerKeypairOfThisWallet(me, 'not a label')).toThrow(/not a company's label/u);
  });

  it('IS WATCHED, SO A MESSAGE TO A PAGE THAT CARRIES ITS SECRET IS REFUSED', () => {
    forgetWatched();
    const pair = readerKeypairOfThisWallet(me, CO);
    /* RED WHEN: the reader key's secret could reach a page in a message the wallet sends. */
    expect(carriesASecret({ readKeys: { secret: pair.secret } })).toBe(true);
    expect(carriesASecret({ readKeys: { key: pair.publicKey } })).toBe(false);
    forgetWatched();
  });
});
