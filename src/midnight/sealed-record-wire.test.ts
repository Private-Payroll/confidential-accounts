/**
 * **WHAT CROSSES BETWEEN THE PAGE AND THE STORE, AND EVERY WAY A MESSAGE CAN
 * DISAGREE WITH ITSELF.**
 */
import { describe, it, expect } from 'vitest';
import {
  toWire, fromWire, digestOfBody, assertWireVersionNumber, assertWireRecord, assertWireVault,
  wirePaths, SealedRecordWireRefused, signFiling, verifiedFiler, filingMessage, WIRE_RECORDS,
} from './sealed-record-wire.js';
import { sealPool } from './vault-pool.js';
import { newWrappingKeypair, newSigningKeypair } from '../core/crypto.js';

const VAULT = 'ab'.repeat(32);
const k = newWrappingKeypair();
const sealed = (version: number, vault = VAULT) =>
  sealPool(vault, { notes: [] }, [{ id: 'ada', wrappingPublicKey: k.publicKey }], version);

describe('a version on the wire', () => {
  it('round-trips: the record, the version, the exact bytes and their digest', () => {
    const w = toWire('pool', sealed(3));
    expect(w.version).toBe(3);
    expect(w.digest).toBe(digestOfBody(w.body));
    const back = fromWire(JSON.parse(JSON.stringify(w)), { vault: VAULT, record: 'pool', version: 3 });
    expect(back.sealed).toEqual(JSON.parse(w.body));
    expect(back.wire).toEqual(w);
  });

  it('REFUSES a message about another record, another version, or with its version said two ways', () => {
    const w = toWire('deposit-journal', sealed(2));
    expect(() => fromWire(w, { vault: VAULT, record: 'pool', version: 2 }), 'RED WHEN: a journal is accepted as the pool')
      .toThrow(/it says it is the deposit-journal, and the pool was expected/);
    expect(() => fromWire(w, { vault: VAULT, record: 'deposit-journal', version: 3 }), 'RED WHEN: a reply about another version is believed')
      .toThrow(/version 2, and version 3 was expected/);
    const inner = JSON.parse(w.body); inner.version = 5;
    const body = JSON.stringify(inner);
    expect(() => fromWire({ ...w, body, digest: digestOfBody(body) }, { vault: VAULT, record: 'deposit-journal', version: 2 }),
      'RED WHEN: the version in the message and the version in the record may differ').toThrow(/record inside it says 5/);
  });

  it('REFUSES bytes the digest does not name, bytes not written the one way, and a record for another vault', () => {
    const w = toWire('pool', sealed(1));
    expect(() => fromWire({ ...w, digest: '00'.repeat(32) }, { vault: VAULT, record: 'pool', version: 1 }),
      'RED WHEN: the digest is not checked').toThrow(/does not match the digest/);
    const spaced = w.body.replace('{', '{ ');
    expect(() => fromWire({ ...w, body: spaced, digest: digestOfBody(spaced) }, { vault: VAULT, record: 'pool', version: 1 }),
      'RED WHEN: bytes that would be filed differently from how they were digested are accepted').toThrow(/one way a record is written/);
    const theirs = toWire('pool', sealed(1, 'cd'.repeat(32)));
    expect(() => fromWire(theirs, { vault: VAULT, record: 'pool', version: 1 }), 'RED WHEN: another vault\'s record is accepted')
      .toThrow(/DIFFERENT vault/);
    expect(() => fromWire({ ...w, body: 'nope', digest: digestOfBody('nope') }, { vault: VAULT, record: 'pool' })).toThrow(/not JSON/);
    expect(() => fromWire(null, { vault: VAULT, record: 'pool' })).toThrow(SealedRecordWireRefused);
    expect(() => fromWire({ ...w, body: undefined }, { vault: VAULT, record: 'pool' })).toThrow(/no body/);
  });

  it('names versions, records and vaults one way only', () => {
    expect(assertWireVersionNumber('12')).toBe(12);
    for (const bad of ['0', '01', '-1', '1.5', 0, 1.5, 'x', null, '99999999999999999']) {
      expect(() => assertWireVersionNumber(bad), `RED WHEN: ${JSON.stringify(bad)} is a version`).toThrow(/is not a version/);
    }
    expect(() => assertWireRecord('settlements'), 'RED WHEN: a record a vault does not keep is named').toThrow(/not a record a vault keeps/);
    expect(() => assertWireVault(VAULT.toUpperCase()), 'RED WHEN: a second spelling of a vault reaches a store').toThrow(/64 lower-case hex/);
    expect(wirePaths.file(VAULT, 'pool', 4)).toBe(`/api/vaults/${VAULT}/records/pool/4`);
  });
});

describe('who filed a record', () => {
  const me = newSigningKeypair();

  it('IS THE KEY THAT SIGNED EXACTLY THIS RECORD, KIND, VAULT AND VERSION, and nobody otherwise', () => {
    const signed = signFiling('pool', sealed(3), me.secret);
    expect(verifiedFiler('pool', signed), 'RED WHEN: a real filing is not recognised').toBe(me.publicKey);
    expect(verifiedFiler('deposit-journal', signed), 'RED WHEN: a signature for the pool is taken for a journal').toBeNull();
    expect(verifiedFiler('pool', { ...signed, version: 4 }), 'RED WHEN: a signature carries to another version').toBeNull();
    expect(verifiedFiler('pool', { ...signed, vault: 'cd'.repeat(32) }), 'RED WHEN: a signature carries to another vault').toBeNull();
    expect(verifiedFiler('pool', { ...signed, sealed: sealed(3).sealed }), 'RED WHEN: a signature carries to another body').toBeNull();
    expect(verifiedFiler('pool', { ...signed, wrapped: [] }), 'RED WHEN: a signature carries to another list of readers').toBeNull();
    expect(verifiedFiler('pool', sealed(3)), 'RED WHEN: an unsigned record names a filer').toBeNull();
    const other = newSigningKeypair();
    expect(verifiedFiler('pool', { ...signed, filedBy: { ...signed.filedBy!, publicKey: other.publicKey } }),
      'RED WHEN: a filing can claim to be somebody else\'s').toBeNull();
  });

  it('re-signing replaces the signature rather than signing it, and the signed text names its domain', () => {
    const once = signFiling('pool', sealed(1), me.secret);
    const twice = signFiling('pool', once, me.secret);
    expect(twice.filedBy, 'RED WHEN: a signature covers an earlier signature').toEqual(once.filedBy);
    expect(filingMessage('pool', once)).toContain('confidential-accounts/sealed-filing/v1');
    expect(filingMessage('pool', once), 'RED WHEN: the signature is part of what it signs').not.toContain(once.filedBy!.signature);
  });

  it('the nonce secret is a record a vault keeps', () => {
    expect(WIRE_RECORDS).toContain('nonce-secret');
  });
});
