import { describe, expect, it } from 'vitest';
import { parseAsk, RequestError, type CreationRequest } from './request.js';
import { drewTheLabelFor, emptyProfile, pinCompanyAccount, pinnedAccountOf, recordRelease } from './model.js';
import { CREATION_SIGNATURE_SCHEMA, readCreationSignature } from './creation-sign.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';

/*
 * The ask that finishes creating a company's account, the pin the wallet keeps
 * of the account it signed the creation of, and the page's reading of the
 * answer. What the wallet checks in the deploy itself is driven against the
 * real ledger in `contracts/test/a-company-born-held-from-the-browser.test.ts`.
 */
const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const COMPANY = `co_${'cd'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'c0'.repeat(32) as AccountAddress;
const KEY = { tag: 'schnorr' as const, value: 'ef'.repeat(32) };

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'creation',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To finish creating your company\'s account.',
  nonce: 'n1',
  expiresAt: NOW + 60_000,
  company: COMPANY,
  account: ACCOUNT,
  deploy: 'REVQTE9Z',
  insert: [{ circuit: 'payout', key: 'S0VZ' }],
  ...over,
});
const codeOf = (f: () => unknown): string => {
  try { f(); } catch (e) { return e instanceof RequestError ? e.code : `not refused by name: ${String(e)}`; }
  return 'not refused';
};

describe('AN ASK TO FINISH CREATING A COMPANY\'S ACCOUNT', () => {
  it('IS READ WHOLE: THE COMPANY, THE ACCOUNT, THE DEPLOY AND THE KEYS IT INSERTS', () => {
    const ask = parseAsk(wire(), ORIGIN, NOW) as CreationRequest;
    /* RED WHEN: any of the four is dropped or changed on the way in. */
    expect(ask).toMatchObject({ kind: 'creation', company: COMPANY, account: ACCOUNT, deploy: 'REVQTE9Z', insert: [{ circuit: 'payout', key: 'S0VZ' }] });
  });

  it.each([
    ['details asked for beside it', { wants: [{ attribute: 'email', required: true }] }, 'attributes-on-a-creation'],
    ['a key to seal an answer to', { inboxPublicKey: 'ab'.repeat(32) }, 'inbox-key-on-a-creation'],
    ['a deploy that is not base64', { deploy: 'not base64!' }, 'not-a-creation'],
    ['no keys to insert', { insert: [] }, 'not-a-creation'],
    ['one circuit twice', { insert: [{ circuit: 'payout', key: 'S0VZ' }, { circuit: 'payout', key: 'S0VZ' }] }, 'not-a-creation'],
    ['a key that is not base64', { insert: [{ circuit: 'payout', key: 'K' }] }, 'not-a-creation'],
  ])('IS REFUSED BY NAME WITH %s', (_what, over, code) => {
    /* RED WHEN: the ask is read with the field ignored, or refused without saying why. */
    expect(codeOf(() => parseAsk(wire(over), ORIGIN, NOW))).toBe(code);
  });

  it('ITS FIELDS ON ANY OTHER KIND ARE REFUSED, NOT IGNORED', () => {
    /* RED WHEN: another kind carrying a deploy, or keys to insert, is read as that kind. */
    for (const field of ['deploy', 'insert']) {
      const other = wire({ kind: 'holders' });
      delete other[field === 'deploy' ? 'insert' : 'deploy'];
      expect(codeOf(() => parseAsk(other, ORIGIN, NOW)), field).toBe('creation-fields-on-another-kind');
    }
  });
});

describe('THE ACCOUNT THIS WALLET PINS FOR A COMPANY IT CREATED', () => {
  const drawn = recordRelease(emptyProfile(NOW), {
    at: NOW, nonce: 'n1', recipient: { origin: ORIGIN, name: 'Payroll A', rdns: 'example.payroll-a' }, company: COMPANY, account: null,
  } as never, NOW);

  it('IS SIGNED FOR ONLY WHEN THIS WALLET DREW THE LABEL AND HAS PINNED NOTHING FOR IT', () => {
    /* RED WHEN: a creation is signed for a label this wallet never drew, or for one already finished. */
    expect(drewTheLabelFor(emptyProfile(NOW), COMPANY)).toBe(false);
    expect(drewTheLabelFor(drawn, COMPANY)).toBe(true);
    const pinned = pinCompanyAccount(drawn, { company: COMPANY, account: ACCOUNT, from: 'created', at: NOW }, NOW);
    expect(pinnedAccountOf(pinned, COMPANY)).toBe(ACCOUNT);
    expect(drewTheLabelFor(pinned, COMPANY)).toBe(false);
  });

  it('IS PINNED ONCE: THE SAME AGAIN CHANGES NOTHING, A SECOND ACCOUNT IS REFUSED', () => {
    const pinned = pinCompanyAccount(drawn, { company: COMPANY, account: ACCOUNT, from: 'created', at: NOW }, NOW);
    expect(pinCompanyAccount(pinned, { company: COMPANY, account: ACCOUNT, from: 'created', at: NOW + 1 }, NOW + 1)).toBe(pinned);
    /* RED WHEN: a later press moves a label's pin to another account. */
    expect(() => pinCompanyAccount(pinned, { company: COMPANY, account: 'c1'.repeat(32) as AccountAddress, from: 'created', at: NOW }, NOW))
      .toThrow('already pinned another account for this company');
  });
});

describe('THE PAGE READING THE WALLET\'S SIGNATURE ON A CREATION', () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    schema: CREATION_SIGNATURE_SCHEMA, origin: ORIGIN, company: COMPANY, account: ACCOUNT, nonce: 'n1', at: NOW,
    signer: KEY, signature: { tag: 'schnorr', value: '5a'.repeat(64) }, ...over,
  });
  const expecting = { atOrigin: ORIGIN, expectingNonce: 'n1', company: COMPANY, account: ACCOUNT, signer: KEY };

  it('TAKES THE SIGNATURE WHEN EVERYTHING IS WHAT THE PAGE ASKED ABOUT', () => {
    expect(readCreationSignature(answer(), expecting)).toEqual({ ok: true, signer: KEY, signature: { tag: 'schnorr', value: '5a'.repeat(64) } });
  });

  it.each([
    ['another origin', { origin: 'https://elsewhere.example' }, 'origin-mismatch'],
    ['another nonce', { nonce: 'n2' }, 'nonce-mismatch'],
    ['another company', { company: `co_${'99'.repeat(32)}` }, 'other-company'],
    ['another account', { account: 'c1'.repeat(32) }, 'other-company'],
    ['another signer', { signer: { tag: 'schnorr', value: '11'.repeat(32) } }, 'other-company'],
    ['no signature', { signature: null }, 'not-an-answer'],
  ])('REFUSES %s', (_what, over, code) => {
    /* RED WHEN: that field is not compared with what the page asked about. */
    const read = readCreationSignature(answer(over), expecting);
    expect(read.ok ? 'taken' : (read as { code: string }).code).toBe(code);
  });
});
