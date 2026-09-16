import { describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signData, signatureVerifyingKey, signingKeyFromBip340, verifySignature } from '@midnightntwrk/ledger-v9';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Purposes, identityFromWords } from '../keys/derivation.js';
import {
  CommitteeKeyError, committeeKeyFor, committeeSigningKeyFor, readCommitteeKey,
} from './committee-key.js';

/*
 * The committee key, checked against a walk that shares no code with the
 * wallet: the BIP-32 path through `@scure/bip32`, the HKDF through
 * `@noble/hashes`, and the public key through `@noble/curves`' BIP-340.
 */
const CO_A = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const CO_B = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const text = (s: string) => new TextEncoder().encode(s);
const identity = identityFromWords(TEST_MNEMONIC);

const root = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC))
  .derive("m/44'/2400'/1'/0/0").privateKey!;
const authority = (purpose: string, index: number): Uint8Array =>
  hkdf(sha256, root, text('midnight-identity/authority/v1'), text(`${purpose}/${index}`), 32);
const independentSecret = (company: string): Uint8Array =>
  hkdf(sha256, authority('maintenance', 0), text('midnight-identity/vault-committee/v1'), text(company), 32);
const independentUnlock = (company: string): Uint8Array =>
  hkdf(sha256, authority('unlock', 0), text('midnight-identity/unlock/v2'), text(company), 32);
const independentRecordsSeed = (company: string): Uint8Array =>
  hkdf(sha256, independentUnlock(company),
    text('confidential-accounts/company-records-wrapping/v1'), new Uint8Array(0), 32);

describe('THE COMMITTEE KEY', () => {
  it('is the BIP-340 key of an expansion of its own parent under the company address, byte for byte', () => {
    const secret = independentSecret(CO_A);
    expect(committeeSigningKeyFor(identity, CO_A)).toEqual({ tag: 'schnorr', value: hex(secret) });
    expect(committeeKeyFor(identity, CO_A)).toEqual({ tag: 'schnorr', value: hex(schnorr.getPublicKey(secret)) });
  });

  it('is one key per company, the same for every spelling of one address, and the same after a rebuild from the words', () => {
    expect(committeeKeyFor(identity, CO_A).value).not.toBe(committeeKeyFor(identity, CO_B).value);
    expect(committeeKeyFor(identity, CO_A.toUpperCase())).toEqual(committeeKeyFor(identity, CO_A));
    const again = identityFromWords(TEST_MNEMONIC);
    expect(committeeKeyFor(again, CO_A)).toEqual(committeeKeyFor(identity, CO_A));
  });

  it('SHARES NO PARENT WITH ANY KEY A PAGE IS GIVEN: not the unlock key, not the keyring parent, not the records key', () => {
    const secret = committeeSigningKeyFor(identity, CO_A).value;
    expect(secret).toBe(hex(independentSecret(CO_A)));
    expect(hex(identity.authority(Purposes.Maintenance, 0))).toBe(hex(authority('maintenance', 0)));
    for (const other of [
      hex(independentUnlock(CO_A)),
      hex(independentRecordsSeed(CO_A)),
      hex(authority('unlock', 0)),
      hex(authority('keyring', 0)),
      hex(hkdf(sha256, authority('unlock', 0), text('midnight-identity/vault-committee/v1'), text(CO_A), 32)),
    ]) {
      expect(other).not.toBe(secret);
    }
    /* And the parent is the maintenance purpose in the code itself, not a copy. */
    const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'committee-key.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function committeeSigningKeyFor'));
    const code = body.slice(0, body.indexOf('\n}')).replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(code).toContain('Purposes.Maintenance');
    expect(code).not.toContain('Purposes.Unlock');
    expect(code).not.toContain('Purposes.Keyring');
  });

  it('IS THE LEDGER\'S OWN BIP-340 KEY: the ledger reads the secret and derives the same public half', () => {
    const secret = committeeSigningKeyFor(identity, CO_A);
    expect(signingKeyFromBip340(Buffer.from(secret.value, 'hex'))).toEqual(secret);
    expect(signatureVerifyingKey(secret)).toEqual(committeeKeyFor(identity, CO_A));
  });

  it('LOADS NO WEBASSEMBLY: the ledger is reached for types only, so a page can read a committee key', () => {
    const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'committee-key.ts'), 'utf8');
    const imports = source.split('\n').filter((l) => /^import /u.test(l) && l.includes('ledger-v9'));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((l) => l.startsWith('import type '))).toBe(true);
  });

  it('signs what the ledger checks against the public half', () => {
    const data = text('midnight:contract-update:example');
    const signature = signData(committeeSigningKeyFor(identity, CO_A), data);
    expect(verifySignature(committeeKeyFor(identity, CO_A), data, signature)).toBe(true);
    expect(verifySignature(committeeKeyFor(identity, CO_B), data, signature)).toBe(false);
  });

  it('refuses anything that is not a company address, and derives nothing', () => {
    for (const bad of ['', CO_A.slice(1), `0x${CO_A}`, `${CO_A} `, 'g'.repeat(64)]) {
      expect(() => committeeKeyFor(identity, bad)).toThrow(CommitteeKeyError);
    }
  });

  it('a committee key read off a wire is a schnorr key of thirty-two bytes and nothing else', () => {
    const key = committeeKeyFor(identity, CO_A);
    expect(readCommitteeKey(key)).toEqual(key);
    expect(readCommitteeKey({ ...key })).toEqual(key);
    expect(readCommitteeKey(null)).toBeNull();
    expect(readCommitteeKey(key.value)).toBeNull();
    expect(readCommitteeKey({ ...key, tag: 'ecdsa' })).toBeNull();
    expect(readCommitteeKey({ ...key, value: key.value.toUpperCase() })).toBeNull();
    expect(readCommitteeKey({ ...key, value: key.value.slice(2) })).toBeNull();
    expect(readCommitteeKey({ ...key, value: `${key.value}00` })).toBeNull();
  });
});
