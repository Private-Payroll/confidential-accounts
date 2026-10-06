import { describe, expect, it } from 'vitest';
import { identityFromSecret } from '../keys/derivation.js';
import { committeeKeyFor } from './committee-key.js';
import type { CompanyLabel } from './company-label.js';
import { addressFingerprint, payeeCodeFingerprint, seatKeyFingerprint, tidyFingerprint } from './fingerprint.js';
import {
  JOIN_CODE_PREFIX, JoinCodeRefused, joinCodeAnswerFor, joinCodeSignedBy, readJoinCode, signJoinCode, whyNoJoinCode, writeJoinCode,
  type JoinCode, type PayeeParts, type SignerParts,
} from './join-code.js';
import { parseAsk, type JoinCodeRequest } from './request.js';

/*
 * A join code: what a person's own wallet signs so a company can add them
 * without a link. Signed over every part, for one company, by that company's
 * committee key in this wallet; read back whole or refused.
 */
const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll.example';
const CO = `co_${'c3'.repeat(32)}` as CompanyLabel;
const OTHER = `co_${'c4'.repeat(32)}` as CompanyLabel;
const me = identityFromSecret(new Uint8Array(32).fill(5));
const someoneElse = identityFromSecret(new Uint8Array(32).fill(6));
const SIGNER: SignerParts = { kind: 'signer', signingPublicKey: '11'.repeat(32), wrappingPublicKey: '22'.repeat(32), leafCommitment: '33'.repeat(32) };
const ADDRESS = `mn_shield-addr_test1${'p'.repeat(60)}`;

const ask = (over: Record<string, unknown> = {}) => parseAsk({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'join-code',
  requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'To join.',
  nonce: 'n1', expiresAt: NOW + 600_000, company: CO, person: 'usr_ada', parts: SIGNER, ...over,
}, ORIGIN, NOW);

describe('A JOIN CODE', () => {
  it('IS SIGNED BY THIS WALLET\'S COMMITTEE KEY FOR THE COMPANY, AND READS BACK WHOLE FROM ITS TEXT', () => {
    const code = signJoinCode(me, CO, 'usr_ada', SIGNER);
    expect(code.committeeKey).toEqual({ ...committeeKeyFor(me, CO) });
    expect(joinCodeSignedBy(code)).toBe(true);
    const text = writeJoinCode(code);
    expect(text.startsWith(JOIN_CODE_PREFIX)).toBe(true);
    expect(readJoinCode(text, CO)).toEqual(code);
  });

  it('A CODE WITH ANY PART SWAPPED FAILS ITS SIGNATURE', () => {
    const code = signJoinCode(me, CO, 'usr_ada', SIGNER);
    const swapped: JoinCode[] = [
      { ...code, person: 'usr_mallory' },
      { ...code, company: OTHER },
      { ...code, parts: { ...SIGNER, signingPublicKey: '44'.repeat(32) } },
      { ...code, parts: { ...SIGNER, wrappingPublicKey: '44'.repeat(32) } },
      { ...code, parts: { ...SIGNER, leafCommitment: '44'.repeat(32) } },
      { ...code, committeeKey: { ...committeeKeyFor(someoneElse, CO) } },
    ];
    /* RED WHEN: a part the signature does not cover can be changed. */
    for (const s of swapped) expect(joinCodeSignedBy(s), JSON.stringify(s)).toBe(false);
    for (const s of swapped.filter((x) => x.company === CO)) expect(readJoinCode(writeJoinCode(s), CO)).toBe('not-signed');
    /* RED WHEN: a payee's address or payslip key can be changed under the signature. */
    const PAYEE: PayeeParts = { kind: 'payee', address: ADDRESS, payslipKey: 'aa'.repeat(32) };
    const payee = signJoinCode(me, CO, 'usr_ada', PAYEE);
    for (const s of [{ ...payee, parts: { ...PAYEE, address: `mn_shield-addr_test1${'q'.repeat(60)}` } }, { ...payee, parts: { ...PAYEE, payslipKey: 'bb'.repeat(32) } }] as JoinCode[]) {
      expect(joinCodeSignedBy(s), JSON.stringify(s.parts)).toBe(false);
      expect(readJoinCode(writeJoinCode(s), CO)).toBe('not-signed');
    }
  });

  it('A PAYEE\'S CODE SWAPPED ON THE WAY HAS ANOTHER FINGERPRINT, EVEN WITH THE SAME ADDRESS', () => {
    const PAYEE: PayeeParts = { kind: 'payee', address: ADDRESS, payslipKey: 'aa'.repeat(32) };
    const mine = signJoinCode(me, CO, 'usr_ada', PAYEE) as JoinCode & { parts: PayeeParts };
    /* RED WHEN: another wallet's code, or the same address with another payslip key, reads out the joiner's fingerprint. */
    expect(payeeCodeFingerprint(signJoinCode(someoneElse, CO, 'usr_ada', PAYEE) as JoinCode & { parts: PayeeParts })).not.toBe(payeeCodeFingerprint(mine));
    expect(payeeCodeFingerprint({ ...mine, parts: { ...PAYEE, payslipKey: 'bb'.repeat(32) } })).not.toBe(payeeCodeFingerprint(mine));
    expect(payeeCodeFingerprint(mine)).not.toBe(addressFingerprint(ADDRESS));
  });

  it('A WHOLE CODE SWAPPED FOR ANOTHER PERSON\'S STILL VERIFIES, AND ITS FINGERPRINT IS NOT THE JOINER\'S', () => {
    const theirs = signJoinCode(someoneElse, CO, 'usr_ada', { ...SIGNER, signingPublicKey: '55'.repeat(32) });
    expect(readJoinCode(writeJoinCode(theirs), CO)).toEqual(theirs);
    /* RED WHEN: two different seats' keys share a fingerprint, so a swap cannot be seen. */
    expect(seatKeyFingerprint(theirs.parts as SignerParts)).not.toBe(seatKeyFingerprint(SIGNER));
    expect(tidyFingerprint(seatKeyFingerprint(SIGNER).toLowerCase().replace(/-/gu, ' '))).toBe(seatKeyFingerprint(SIGNER));
    /* RED WHEN: a seat's fingerprint is computed under the address fingerprint's domain. */
    expect(seatKeyFingerprint(SIGNER)).not.toBe(addressFingerprint(['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)].join('/')));
  });

  it('A CODE FOR ANOTHER COMPANY, OR TEXT THAT IS NOT A CODE, IS REFUSED BY NAME', () => {
    const code = signJoinCode(me, OTHER, 'usr_ada', SIGNER);
    expect(readJoinCode(writeJoinCode(code), CO)).toBe('another-company');
    expect(readJoinCode('hello', CO)).toBe('not-a-code');
    expect(readJoinCode(`${JOIN_CODE_PREFIX}!!!`, CO)).toBe('not-a-code');
    /* RED WHEN: a code carrying a field nothing reads is taken. */
    expect(readJoinCode(writeJoinCode({ ...signJoinCode(me, CO, 'usr_ada', SIGNER), extra: 1 } as JoinCode), CO)).toBe('not-a-code');
  });

  it('THE WALLET SIGNS A PAYEE\'S CODE ONLY FOR AN ADDRESS IT RECEIVES AT AND THE PAYSLIP KEY IT GIVES FOR THE COMPANY', () => {
    /* This wallet's own payslip key for the company, as the wallet works it out (its own test's); any other key is somebody else's. */
    const own = 'ee'.repeat(32);
    const payee = (payslipKey: string) => ask({ parts: { kind: 'payee', address: ADDRESS, payslipKey } }) as JoinCodeRequest;
    /* RED WHEN: a page has this wallet sign somebody else's address as where the person is paid. */
    expect(() => joinCodeAnswerFor(me, payee(own), [], own)).toThrow(/not one this wallet receives at/);
    /* RED WHEN: a page has this wallet sign somebody else's key as the one the person's payslips are sealed to. */
    expect(() => joinCodeAnswerFor(me, payee('aa'.repeat(32)), [ADDRESS], own)).toThrow(/payslip key the page names is not the one this wallet gives/);
    expect(() => joinCodeAnswerFor(me, payee(own), [ADDRESS], null)).toThrow(JoinCodeRefused);
    expect(whyNoJoinCode(payee(own), [ADDRESS], own)).toBeNull();
    expect(joinCodeSignedBy(joinCodeAnswerFor(me, payee(own), [ADDRESS], own))).toBe(true);
    expect(joinCodeSignedBy(joinCodeAnswerFor(me, ask() as JoinCodeRequest, [], null))).toBe(true);
  });

  it('THE ASK IS READ WHOLE: A PERSON, PARTS OF ONE KIND, AND NOTHING MORE', () => {
    expect((ask() as JoinCodeRequest).parts).toEqual(SIGNER);
    /* RED WHEN: an ask carrying more than a code carries is taken. */
    expect(() => ask({ seat: '5a'.repeat(32) })).toThrow();
    expect(() => ask({ wants: [] })).toThrow();
    /* RED WHEN: parts of neither kind are taken. */
    expect(() => ask({ parts: { kind: 'signer', signingPublicKey: '11'.repeat(32) } })).toThrow(/neither a signer's keys nor a payee's/);
    expect(() => ask({ person: 'not a sign-in!' })).toThrow(/not a sign-in/);
    /* RED WHEN: a code's parts are taken on another kind of ask. */
    expect(() => parseAsk({
      schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key', requester: { name: 'P', rdns: 'p' }, purpose: 'x',
      nonce: 'n', expiresAt: NOW + 1000, company: CO, account: 'ab'.repeat(32), seat: '5a'.repeat(32), parts: SIGNER,
    }, ORIGIN, NOW)).toThrow(/parts of a join code/);
  });
});
