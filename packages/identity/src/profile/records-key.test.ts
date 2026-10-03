import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromSecret } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';
import { parseAsk, type RecordsKeyRequest } from './request.js';
import { unlockKeyFor } from './unlock.js';
import type { UnlockRequest } from './request.js';
import {
  RECORDS_KEY_ANSWER_SCHEMA, RECORDS_KEY_STATEMENT_TAG, RecordsKeyRefused, readRecordsKeyAnswer, recordsKeyAnswerFor,
  recordsKeySignedBy, recordsKeyStatementBytes, recordsPublicKeyOf, signRecordsKey,
} from './records-key.js';

/*
 * A signer's records key and seat, signed by their wallet with the committee
 * key the chain lists for them, and checked by anybody holding the statement,
 * the committee key and the company's label.
 */
const me = identityFromSecret(new Uint8Array(32).fill(3));
const somebodyElse = identityFromSecret(new Uint8Array(32).fill(9));
const CO = `co_${'c1'.repeat(32)}` as CompanyLabel;
const OTHER_CO = `co_${'d2'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'a7'.repeat(32) as AccountAddress;
const SEAT = '5e'.repeat(32);
const ANOTHER_SEAT = '6f'.repeat(32);
const companyKey = new Uint8Array(32).fill(4);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const flip = (h: string, at = 0): string => h.slice(0, at) + (h[at] === '0' ? '1' : '0') + h.slice(at + 1);

describe('A RECORDS KEY AND A SEAT, SIGNED BY THE WALLET WITH THE COMMITTEE KEY', () => {
  const statement = signRecordsKey(me, CO, companyKey, SEAT);
  const mine = committeeKeyFor(me, CO);

  it('signs the records key the company key opens, worked out in the records\' own domain', () => {
    /* RED WHEN: the key signed for is derived any other way than the company's records are sealed to it. */
    const secret = hkdf(sha256, companyKey, new TextEncoder().encode('confidential-accounts/company-records-wrapping/v1'), new Uint8Array(0), 32);
    expect(statement.recordsKey).toBe(hex(x25519.getPublicKey(secret)));
    expect(recordsPublicKeyOf(companyKey)).toBe(statement.recordsKey);
    expect(statement.seat).toBe(SEAT);
    /* RED WHEN: a company key of zeros or of the wrong width yields a key. */
    expect(() => recordsPublicKeyOf(new Uint8Array(32))).toThrow(/Nothing was derived/);
    expect(() => recordsPublicKeyOf(new Uint8Array(31).fill(1))).toThrow(/Nothing was derived/);
  });

  it('checks against the signer\'s committee key for that company, and against nothing else', () => {
    /* RED WHEN: the check passes nothing, or the signing key is not the committee key. */
    expect(recordsKeySignedBy(CO, mine, statement)).toBe(true);
    /* RED WHEN: another person's committee key, or this person's for another company, passes. */
    expect(recordsKeySignedBy(CO, committeeKeyFor(somebodyElse, CO), statement)).toBe(false);
    expect(recordsKeySignedBy(CO, committeeKeyFor(me, OTHER_CO), statement)).toBe(false);
    /* RED WHEN: the label is not part of what is signed. */
    expect(recordsKeySignedBy(OTHER_CO, mine, statement)).toBe(false);
    /* RED WHEN: the records key is not part of what is signed - a key the service substitutes passes. */
    const substituted = recordsPublicKeyOf(new Uint8Array(32).fill(5));
    expect(recordsKeySignedBy(CO, mine, { ...statement, recordsKey: substituted })).toBe(false);
    /* RED WHEN: the seat is not part of what is signed - a statement from a seat somebody left passes for another. */
    expect(recordsKeySignedBy(CO, mine, { ...statement, seat: ANOTHER_SEAT })).toBe(false);
    /* RED WHEN: a signature with one bit changed passes. */
    expect(recordsKeySignedBy(CO, mine, { ...statement, signature: flip(statement.signature, 70) })).toBe(false);
  });

  it('never throws on what is not a statement, a committee key or a label', () => {
    expect(recordsKeySignedBy(CO, { tag: 'ecdsa', value: mine.value }, statement)).toBe(false);
    expect(recordsKeySignedBy(CO, { tag: 'schnorr', value: 'ab' }, statement)).toBe(false);
    expect(recordsKeySignedBy('co_nope' as CompanyLabel, mine, statement)).toBe(false);
    expect(recordsKeySignedBy(CO, mine, { ...statement, signature: 'zz' })).toBe(false);
    expect(recordsKeySignedBy(CO, mine, null as never)).toBe(false);
    expect(recordsKeySignedBy(CO, mine, { ...statement, recordsKey: statement.recordsKey.toUpperCase() })).toBe(false);
    expect(recordsKeySignedBy(CO, mine, { ...statement, seat: 'ab' })).toBe(false);
    expect(() => signRecordsKey(me, CO, companyKey, 'not a seat')).toThrow(/no records key was signed/);
  });

  it('IS NEVER A CHANGE TO A CONTRACT\'S RULES, AND NO SUCH CHANGE IS EVER A STATEMENT', () => {
    const bytes = recordsKeyStatementBytes(CO, statement.recordsKey, SEAT)!;
    const tag = new TextEncoder().encode(RECORDS_KEY_STATEMENT_TAG);
    /* RED WHEN: what is signed does not begin with the statement's own tag. */
    expect(hex(bytes.subarray(0, tag.length))).toBe(hex(tag));
    expect(bytes).toHaveLength(tag.length + 1 + CO.length + 1 + 32 + 32);
    /* The ledger's own signatures are made a different way: it does not take the statement's as one of its own even over these bytes. */
    expect(L.verifySignature(mine as never, bytes, { tag: 'schnorr', value: statement.signature } as never)).toBe(false);
    /* A maintenance update this key would sign begins with the ledger's own tag, which is not the statement's. */
    const update = new L.MaintenanceUpdate(L.sampleContractAddress(), [
      new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([mine as never], 1, 1n)) as never,
    ], 0n);
    const data = update.dataToSign;
    expect(hex(data.subarray(0, tag.length))).not.toBe(hex(tag));
    /* RED WHEN: the statement's signature would pass as the maintenance update's, or the reverse. */
    expect(L.verifySignature(mine as never, data, { tag: 'schnorr', value: statement.signature } as never)).toBe(false);
    const maintenance = L.signData(committeeSigningKeyFor(me, CO) as never, data) as unknown as { tag: string; value: string };
    expect(L.verifySignature(mine as never, data, maintenance as never)).toBe(true);
    expect(recordsKeySignedBy(CO, mine, { ...statement, signature: maintenance.value })).toBe(false);
  });
});

describe('THE RECORDS-KEY ASK: SIGNED ONLY FOR A SEAT THE ACCOUNT HOLDS NOW, AND READ BACK BY THE PAGE THAT ASKED', () => {
  const PAGE = 'https://payroll.example';
  const NOW = 1_755_000_000_000;
  const ask = (over: Record<string, unknown> = {}) => parseAsk({
    schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key',
    requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'To check your records key.',
    nonce: 'r1', expiresAt: NOW + 60_000, company: CO, account: ACCOUNT, seat: SEAT, ...over,
  }, PAGE, NOW) as RecordsKeyRequest;
  const seats = { committee: [committeeKeyFor(me, CO) as { tag: string; value: string }], threshold: 1, seats: [ANOTHER_SEAT, SEAT] };
  const expecting = { atOrigin: PAGE, expectingNonce: 'r1', company: CO, account: ACCOUNT, seat: SEAT };

  it('signs the records key of this company\'s key for the seat asked about, and hands back the seats it read', () => {
    const answer = recordsKeyAnswerFor(me, ask(), seats, NOW);
    expect(answer.schema).toBe(RECORDS_KEY_ANSWER_SCHEMA);
    const companyKeyHere = unlockKeyFor(me, { ...ask(), kind: 'unlock' } as unknown as UnlockRequest);
    /* RED WHEN: the statement is for any other records key than the one this company's key opens. */
    expect(answer.statement.recordsKey).toBe(recordsPublicKeyOf(companyKeyHere));
    expect(answer.statement.seat).toBe(SEAT);
    expect(recordsKeySignedBy(CO, answer.committeeKey, answer.statement)).toBe(true);
    /* RED WHEN: who holds the account, as the wallet read it, does not travel with the answer. */
    expect(answer.seats).toEqual(seats);
    /* No secret crosses. */
    expect(JSON.stringify(answer)).not.toContain(hex(companyKeyHere));
    expect(JSON.stringify(answer)).not.toContain(committeeSigningKeyFor(me, CO).value);
    const read = readRecordsKeyAnswer(answer, expecting);
    expect(read.ok && read.statement).toEqual(answer.statement);
    expect(read.ok && read.seats).toEqual(seats);
  });

  it('A SEAT THE ACCOUNT DOES NOT HOLD NOW IS REFUSED, AND NOTHING IS SIGNED', () => {
    /* RED WHEN: the wallet signs a seat somebody has left. */
    expect(() => recordsKeyAnswerFor(me, ask(), { ...seats, seats: [ANOTHER_SEAT] }, NOW)).toThrow(RecordsKeyRefused);
    expect(() => recordsKeyAnswerFor(me, ask(), { ...seats, seats: [] }, NOW)).toThrow(/not one this company's account holds now/);
  });

  it('the ask is read whole: a seat that is not one, or a seat on any other kind, is refused', () => {
    expect(() => ask({ seat: 'AB'.repeat(32) })).toThrow(/not one \(64 lower-case hex characters\)/);
    expect(() => ask({ seat: undefined })).toThrow(/not one/);
    expect(() => ask({ wants: [] })).toThrow(/two different powers/);
    /* RED WHEN: a seat rides along on another kind of ask and is ignored. */
    expect(() => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in',
      requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'Sign in.', nonce: 'n', expiresAt: NOW + 60_000, seat: SEAT,
    }, PAGE, NOW)).toThrow(/names a seat/);
  });

  it('THE PAGE REFUSES AN ANSWER TO ANY OTHER QUESTION, OR ONE NOT SIGNED FOR ITS SEAT', () => {
    const answer = recordsKeyAnswerFor(me, ask(), seats, NOW);
    const code = (over: Record<string, unknown>, exp = expecting) => {
      const r = readRecordsKeyAnswer({ ...answer, ...over }, exp);
      return r.ok ? 'accepted' : r.code;
    };
    expect(code({})).toBe('accepted');
    expect(code({ schema: 'x' })).toBe('not-an-answer');
    expect(code({ origin: 'https://elsewhere.example' })).toBe('origin-mismatch');
    expect(code({ nonce: 'r2' })).toBe('nonce-mismatch');
    expect(code({ company: OTHER_CO })).toBe('other-company');
    /* RED WHEN: an answer signed for another seat than the one asked about is taken. */
    expect(code({}, { ...expecting, seat: ANOTHER_SEAT })).toBe('not-signed');
    /* RED WHEN: a statement signed by another key is taken. */
    expect(code({ committeeKey: committeeKeyFor(somebodyElse, CO) })).toBe('not-signed');
    /* RED WHEN: seats in a shape no wallet writes are taken as who holds the account. */
    expect(code({ seats: { ...seats, seats: [SEAT, SEAT] } })).toBe('not-an-answer');
    expect(code({ seats: { ...seats, seats: ['nope'] } })).toBe('not-an-answer');
    expect(code({ seats: { ...seats, committee: [{ tag: 'ecdsa', value: '11'.repeat(32) }] } })).toBe('not-an-answer');
  });

  describe('WITH A VAULT NAMED', () => {
    const VAULT = '9a'.repeat(32);
    const held = { vault: VAULT, account: ACCOUNT as string, committee: seats.committee, threshold: 1 };

    it('the ask names one vault by its address, never the account itself, and nothing else of a payment', () => {
      expect(ask({ vault: VAULT.toUpperCase() }).vault).toBe(VAULT);
      /* RED WHEN: a vault that is not an address, or the company's account named as its own vault, is taken. */
      expect(() => ask({ vault: 'co_x' })).toThrow(/names one of its vaults by something that is not a vault's address/);
      expect(() => ask({ vault: ACCOUNT })).toThrow(/names one of its vaults by something that is not a vault's address/);
      /* RED WHEN: a transaction rides along on a records-key ask and is ignored. */
      expect(() => ask({ vault: VAULT, transaction: 'AAAA' })).toThrow(/carries a transaction or names a vault/);
      /* RED WHEN: a vault is let through on a kind that does not read it. */
      expect(() => parseAsk({
        schema: 'midnight-identity/disclosure-request/v1', kind: 'sign-in',
        requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'Sign in.', nonce: 'n', expiresAt: NOW + 60_000, vault: VAULT,
      }, PAGE, NOW)).toThrow(/carries a transaction or names a vault/);
    });

    it('the answer carries who holds the vault as the wallet read it, and the wallet signs nothing without that read', () => {
      const answer = recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, held);
      /* RED WHEN: the vault the wallet read does not travel with the answer, or travels changed. */
      expect(answer.vault).toEqual(held);
      /* RED WHEN: the wallet signs for a vault it did not read, or read another vault in its place. */
      expect(() => recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW)).toThrow(/has not read the vault the page names/);
      expect(() => recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, { ...held, vault: '9b'.repeat(32) }))
        .toThrow(/has not read the vault the page names/);
      /* RED WHEN: the wallet signs while the vault it read is pinned to another company's account. */
      expect(() => recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, { ...held, account: 'ad'.repeat(32) }))
        .toThrow(/belongs to a different company account/);
      /* An ask that names no vault is answered with none. */
      expect('vault' in recordsKeyAnswerFor(me, ask(), seats, NOW, held)).toBe(false);
    });

    it('THE PAGE TAKES AN ANSWER ONLY WHEN IT SAYS WHO HOLDS THE VAULT IT ASKED ABOUT', () => {
      const answer = recordsKeyAnswerFor(me, ask({ vault: VAULT }), seats, NOW, held);
      const withVault = { ...expecting, vault: VAULT };
      const read = readRecordsKeyAnswer(answer, withVault);
      expect(read.ok && read.vault).toEqual(held);
      const code = (over: Record<string, unknown>) => {
        const r = readRecordsKeyAnswer({ ...answer, ...over }, withVault);
        return r.ok ? 'accepted' : r.code;
      };
      /* RED WHEN: an answer about another vault, or about none, or in a shape no wallet writes, is taken. */
      expect(code({ vault: { ...held, vault: '9b'.repeat(32) } })).toBe('not-an-answer');
      expect(code({ vault: undefined })).toBe('not-an-answer');
      expect(code({ vault: { ...held, account: 'nope' } })).toBe('not-an-answer');
      expect(code({ vault: { ...held, committee: [{ tag: 'ecdsa', value: '11'.repeat(32) }] } })).toBe('not-an-answer');
      expect(code({ vault: { ...held, threshold: -1 } })).toBe('not-an-answer');
      /* A page that asked about no vault reads none, whatever the answer carries. */
      const none = readRecordsKeyAnswer(answer, expecting);
      expect(none.ok && none.vault).toBeNull();
    });
  });
});
