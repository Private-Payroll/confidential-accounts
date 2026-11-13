import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from '../keys/derivation.js';
import { committeeKeyFor } from './committee-key.js';
import { REQUEST_SCHEMA, RequestError, parseAsk, type SuperAdminRequestAsk } from './request.js';
import {
  COMMITTEE_JOIN_SCHEMA, COMMITTEE_REQUEST_SCHEMA, committeeRequestFor, joinedBy, readKeySignature, superAdminRequestBytes,
} from './committee-sign.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';

/*
 * A super admin's request to the company's service: the wallet signs, with its key for the company, the company as the
 * service records it and the person signed in there. The service checks the signature with `joinedBy`.
 */
const ORIGIN = 'https://payroll.example';
const NOW = 1_800_000_000_000;
const COMPANY = `co_${'c0'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'b2'.repeat(32) as AccountAddress;
const me = identityFromWords(TEST_MNEMONIC);
const mine = committeeKeyFor(me, COMPANY);

const wire = (over: Record<string, unknown> = {}) => ({
  schema: REQUEST_SCHEMA, kind: 'committee', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'So you can act as a super admin of your company.', nonce: 'n-1', expiresAt: NOW + 60_000,
  company: COMPANY, account: ACCOUNT, record: 'acct_1', user: 'user_1', ...over,
});
const asked = (over: Record<string, unknown> = {}) => parseAsk(wire(over), ORIGIN, NOW) as SuperAdminRequestAsk;
const refusal = (w: Record<string, unknown>): RequestError => {
  try { parseAsk(w, ORIGIN, NOW); } catch (e) { return e as RequestError; }
  throw new Error('it parsed');
};

describe('A SUPER ADMIN\'S REQUEST TO THE COMPANY\'S SERVICE', () => {
  it('reads as the request press, naming the company at the service and the person signed in there', () => {
    const r = asked();
    /* RED WHEN: a committee ask naming only a record and a person is not the request press. */
    expect([r.kind, r.press, r.record, r.user, r.company, r.account]).toEqual(['committee', 'request', 'acct_1', 'user_1', COMPANY, ACCOUNT]);
  });

  it('REFUSES A REQUEST THAT ALSO NAMES A CONTRACT, OR NAMES NO PERSON, OR CARRIES ITS FIELDS ON ANOTHER KIND', () => {
    /* RED WHEN: a request press can carry contracts to sign. */
    expect(refusal(wire({ contracts: [] })).code).toBe('not-a-committee-change');
    expect(refusal(wire({ user: undefined })).code).toBe('not-a-committee-change');
    expect(refusal(wire({ user: 'not a person' })).code).toBe('not-a-committee-change');
    /* RED WHEN: another kind can carry the request's fields. */
    expect(refusal(wire({ kind: 'holders' })).code).toBe('committee-fields-on-another-kind');
  });

  it('signs the request\'s bytes with the key for the company, which the ledger\'s check takes', () => {
    const answer = committeeRequestFor(L as never, me, asked(), NOW);
    expect(answer.schema).toBe(COMMITTEE_REQUEST_SCHEMA);
    expect(answer.signer.value).toBe(String(mine.value).toLowerCase());
    /* RED WHEN: the wallet signs anything but these bytes, or with another key. */
    expect(joinedBy(L as never, superAdminRequestBytes('acct_1', 'user_1', ACCOUNT), answer.signer, answer.signature)).toBe(true);
    expect(joinedBy(L as never, superAdminRequestBytes('acct_2', 'user_1', ACCOUNT), answer.signer, answer.signature)).toBe(false);
    /* RED WHEN: the signed bytes do not name the account the wallet checked the label of. */
    expect(joinedBy(L as never, superAdminRequestBytes('acct_1', 'user_1', 'b3'.repeat(32)), answer.signer, answer.signature)).toBe(false);
  });

  it('the page reads the answer only for its own origin, ask and company', () => {
    const answer = committeeRequestFor(L as never, me, asked(), NOW);
    const expecting = { schema: COMMITTEE_REQUEST_SCHEMA, atOrigin: ORIGIN, expectingNonce: 'n-1', company: COMPANY, account: ACCOUNT } as const;
    const read = readKeySignature(answer, expecting);
    expect(read.ok && read.signature).toBe(answer.signature);
    /* RED WHEN: an answer for another page, ask, company or kind is read. */
    expect(readKeySignature(answer, { ...expecting, atOrigin: 'https://other.example' })).toMatchObject({ ok: false, code: 'origin-mismatch' });
    expect(readKeySignature(answer, { ...expecting, expectingNonce: 'n-2' })).toMatchObject({ ok: false, code: 'nonce-mismatch' });
    expect(readKeySignature(answer, { ...expecting, company: `co_${'c1'.repeat(32)}` as CompanyLabel })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readKeySignature(answer, { ...expecting, schema: COMMITTEE_JOIN_SCHEMA })).toMatchObject({ ok: false, code: 'not-an-answer' });
  });
});
