/**
 * **A VAULT'S NONCE SECRET: ANY SIGNER OPENS IT, A SIGNER WHO LEAVES KEEPS ONLY
 * WHAT THEY HAD, AND NO EPOCH IS EVER FORGOTTEN.** The records key is pinned
 * against a vector computed by a second implementation (Python's `hmac` and
 * `hashlib` with HKDF written out, and X25519 written out by hand), not
 * against another call of the same function. The whole journey from recovery
 * words is `contracts/test/a-deposit-made-on-the-device.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  recordsKeypairFrom, startNonceSecret, openNonceSecrets, admitToNonceSecret, rotateNonceSecret,
  openNewestNonceSecrets, depositNonceKeysOf, currentDepositNonceKey, NonceSecretUnreadable,
} from './company-nonce-secret.js';
import { payslipKeypairFrom } from '../core/payslip-key-derive.js';
import { depositNonceKeyFor } from './deposit-nonce.js';
import { fromHex, toHex, newWrappingKeypair, seal, wrapKey, canonical, utf8 } from '../core/crypto.js';
import type { SealedPool } from './vault-pool.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/* The seal key, written out here from the domain it is pinned to, so a test can seal a body the way a dishonest signer might. */
const sealKey = (secret: string) => toHex(hkdf(sha256, fromHex(secret), utf8('confidential-accounts/nonce-secret-seal/v1'), new Uint8Array(0), 32));
const handMade = (body: Record<string, unknown>, wrappedSecret: string, sealedUnder: string): SealedPool => ({
  vault: VAULT, version: 1,
  sealed: seal(canonical(body), sealKey(sealedUnder)),
  wrapped: [{ signerId: A.publicKey, wrapped: wrapKey(wrappedSecret, A.publicKey) }],
});

const VAULT = 'ab'.repeat(32);
const person = (n: number) => recordsKeypairFrom(new Uint8Array(32).fill(n));
const reader = (kp: { publicKey: string }) => ({ publicKey: kp.publicKey });
const A = person(1);
const B = person(2);
const C = person(3);

describe('a signer\'s records key', () => {
  it('IS THE PINNED VECTOR: a pure function of the key the wallet releases for the company', () => {
    const released = new Uint8Array(32).map((_, i) => i + 33);
    expect(recordsKeypairFrom(released), 'RED WHEN: the salt, the info or the curve step changes, and every copy wrapped before stops opening').toEqual({
      secret: '8a38a10988f3affb518ec17beaa5f0e524f874d439ae5f5658df2490da164e13',
      publicKey: 'e1306ee032fd06554db4faa3d5e0d77e76a0051a2c99abb84d35eb61b646de4d',
    });
  });

  it('is neither the released key nor the payslip key made from the same bytes', () => {
    const released = new Uint8Array(32).fill(9);
    expect(person(9).secret, 'RED WHEN: the released key is used as the records key').not.toBe(toHex(released));
    expect(person(9).secret, 'RED WHEN: the records key is the payslip key, so a company that can read a payslip key can open its records').not.toBe(payslipKeypairFrom(released).secret);
  });

  it('REFUSES a key of the wrong length, and a key of zeros', () => {
    expect(() => recordsKeypairFrom(new Uint8Array(31).fill(1)), 'RED WHEN: a short key is expanded anyway').toThrow(/32-byte key/);
    expect(() => recordsKeypairFrom(new Uint8Array(32)), 'RED WHEN: a key anybody can derive is accepted').toThrow(/all zeros/);
  });
});

describe('a vault\'s nonce secret', () => {
  it('EVERY SIGNER IT IS WRAPPED TO OPENS THE SAME SECRET WITH THEIR OWN KEY, and nobody else does', () => {
    const rec = startNonceSecret(VAULT, [reader(A), reader(B)]);
    const a = openNonceSecrets(rec, VAULT, A);
    const b = openNonceSecrets(rec, VAULT, B);
    expect(a.secrets, 'RED WHEN: two signers open two different secrets, so each can name only their own deposits').toEqual(b.secrets);
    expect(a).toMatchObject({ vault: VAULT, version: 1, epoch: 1 });
    expect(a.secrets).toHaveLength(1);
    expect(() => openNonceSecrets(rec, VAULT, C), 'RED WHEN: somebody it was not wrapped to opens it').toThrow(/no copy is wrapped/);
    const liar = { ...newWrappingKeypair(), publicKey: A.publicKey };
    expect(() => openNonceSecrets(rec, VAULT, liar), 'RED WHEN: a copy is chosen by a public key the opener does not hold').toThrow(/does not match/);
    expect(JSON.stringify(rec), 'RED WHEN: the secret is written anywhere outside the seal').not.toContain(a.secrets[0]);
    expect(() => startNonceSecret(VAULT, []), 'RED WHEN: a secret wrapped to nobody is written').toThrow(/wrapped to nobody/);
  });

  it('OPENS ONLY AS THE VAULT AND VERSION IT WAS SEALED AS, and refuses a record put together from two', () => {
    const rec = startNonceSecret(VAULT, [reader(A)]);
    expect(() => openNonceSecrets(rec, 'cd'.repeat(32), A), 'RED WHEN: one vault\'s secret is opened as another\'s').toThrow(/different vault/);
    expect(() => openNonceSecrets({ ...rec, vault: 'cd'.repeat(32) }, 'cd'.repeat(32), A), 'RED WHEN: a record relabelled with another vault opens').toThrow(/names a different vault/);
    expect(() => openNonceSecrets({ ...rec, version: 2 }, VAULT, A), 'RED WHEN: a version presented as another opens').toThrow(/filed as version 2/);
    const other = startNonceSecret(VAULT, [reader(A)]);
    const spliced: SealedPool = { ...rec, sealed: other.sealed };
    expect(() => openNonceSecrets(spliced, VAULT, A), 'RED WHEN: a copy from one record opens the body of another').toThrow(NonceSecretUnreadable);
  });

  it('REFUSES A BODY THAT IS NOT WHAT THE COPY OPENS: another newest secret, another kind of record', () => {
    const s1 = 'a1'.repeat(32); const s2 = 'b2'.repeat(32);
    const good = handMade({ record: 'nonce-secret', vault: VAULT, version: 1, epoch: 1, secrets: [s1] }, s1, s1);
    expect(openNonceSecrets(good, VAULT, A).secrets, 'the hand-made record is well formed').toEqual([s1]);
    const otherNewest = handMade({ record: 'nonce-secret', vault: VAULT, version: 1, epoch: 1, secrets: [s2] }, s1, s1);
    expect(() => openNonceSecrets(otherNewest, VAULT, A),
      'RED WHEN: a signer deposits under a secret other than the one the other signers were given').toThrow(/not the one this record is sealed under/);
    const aPool = handMade({ record: 'pool', vault: VAULT, version: 1, epoch: 1, secrets: [s1] }, s1, s1);
    expect(() => openNonceSecrets(aPool, VAULT, A), 'RED WHEN: another kind of record opens as a nonce secret').toThrow(/not a nonce secret/);
    const twoForOne = handMade({ record: 'nonce-secret', vault: VAULT, version: 1, epoch: 1, secrets: [s2, s1] }, s1, s1);
    expect(() => openNonceSecrets(twoForOne, VAULT, A), 'RED WHEN: a body with more secrets than epochs opens').toThrow(/one secret per epoch/);
  });

  it('its length says nothing about how many epochs there have been', () => {
    let rec = startNonceSecret(VAULT, [reader(A), reader(B), reader(C)]);
    const one = rec.sealed.body.length;
    rec = rotateNonceSecret(rec, VAULT, A, { remaining: [reader(A), reader(C)], leaving: [reader(B)] });
    rec = rotateNonceSecret(rec, VAULT, A, { remaining: [reader(A)], leaving: [reader(C)] });
    expect(rec.sealed.body.length, 'RED WHEN: the store can count how many signers have left from the record\'s length').toBe(one);
  });

  it('ADMITS A SIGNER TO THE SAME SECRET as the next version, taking nobody away', () => {
    const one = startNonceSecret(VAULT, [reader(A), reader(B)]);
    const two = admitToNonceSecret(one, VAULT, A, [reader(C)]);
    expect(two.version).toBe(2);
    const c = openNonceSecrets(two, VAULT, C);
    expect(c.secrets, 'RED WHEN: a new signer is given a secret nobody deposited under').toEqual(openNonceSecrets(one, VAULT, A).secrets);
    expect(openNonceSecrets(two, VAULT, B).epoch, 'RED WHEN: admitting somebody takes somebody else\'s copy away').toBe(1);
    expect(() => admitToNonceSecret(one, VAULT, C, [reader(C)]), 'RED WHEN: somebody who cannot open it gives themselves a copy').toThrow(/no copy is wrapped/);
  });

  it('A SIGNER LEAVING STARTS A NEW EPOCH: those who remain open every secret, the leaver keeps only what they had', () => {
    const one = startNonceSecret(VAULT, [reader(A), reader(B)]);
    const before = openNonceSecrets(one, VAULT, B).secrets;
    const two = rotateNonceSecret(one, VAULT, A, { remaining: [reader(A)], leaving: [reader(B)] });
    const a = openNonceSecrets(two, VAULT, A);
    expect(a.epoch).toBe(2);
    expect(a.secrets[0], 'RED WHEN: rotating forgets the secret old deposits were made under').toBe(before[0]);
    expect(a.secrets[1], 'RED WHEN: the new epoch reuses the secret the leaver knows').not.toBe(before[0]);
    expect(() => openNonceSecrets(two, VAULT, B), 'RED WHEN: the signer who left can open the new epoch').toThrow(/no copy is wrapped/);
    expect(openNonceSecrets(one, VAULT, B).secrets, 'what they had, they keep: accepted').toEqual(before);
    const newest = openNewestNonceSecrets([{ version: 1, sealed: one }, { version: 2, sealed: two }], VAULT, B);
    expect(newest.epoch, 'RED WHEN: a leaver is handed anything newer than the version before they left').toBe(1);
    expect(openNewestNonceSecrets([{ version: 1, sealed: one }, { version: 2, sealed: two }], VAULT, A).epoch).toBe(2);
    expect(() => openNewestNonceSecrets([{ version: 1, sealed: one }], VAULT, C)).toThrow(/no version filed/);
  });

  it('A ROTATION NAMES EVERY SIGNER, and takes nobody\'s access without being told to', () => {
    const one = startNonceSecret(VAULT, [reader(A), reader(B), reader(C)]);
    expect(() => rotateNonceSecret(one, VAULT, A, { remaining: [reader(A)], leaving: [reader(B)] }),
      'RED WHEN: a signer who is neither leaving nor remaining is dropped silently').toThrow(/named neither as remaining nor as leaving/);
    expect(() => rotateNonceSecret(one, VAULT, A, { remaining: [reader(A), reader(B), reader(C)], leaving: [] }),
      'RED WHEN: an epoch starts with nobody leaving').toThrow(/nobody is named as leaving/);
    expect(() => rotateNonceSecret(one, VAULT, A, { remaining: [reader(A), reader(B)], leaving: [reader(B), reader(C)] }),
      'RED WHEN: a signer both leaves and remains').toThrow(/both leaving and remaining/);
    expect(() => rotateNonceSecret(one, VAULT, A, { remaining: [], leaving: [reader(A), reader(B), reader(C)] }),
      'RED WHEN: an epoch nobody can open is written').toThrow(/wrapped to nobody/);
  });

  it('GIVES ONE DEPOSIT KEY PER EPOCH, oldest first, and deposits are made under the newest', () => {
    const one = startNonceSecret(VAULT, [reader(A), reader(B)]);
    const two = rotateNonceSecret(one, VAULT, A, { remaining: [reader(A)], leaving: [reader(B)] });
    const opened = openNonceSecrets(two, VAULT, A);
    const keys = depositNonceKeysOf(opened).map(toHex);
    expect(keys, 'RED WHEN: an epoch\'s key is not the vault\'s deposit key for that epoch\'s secret')
      .toEqual(opened.secrets.map((s) => toHex(depositNonceKeyFor(fromHex(s), VAULT))));
    expect(toHex(currentDepositNonceKey(opened)), 'RED WHEN: deposits are made under an epoch a leaver knows').toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
