import { describe, expect, it } from 'vitest';
import { RequestError, parseAsk } from './request.js';
import type { BalanceRequest } from './request.js';
import { BALANCED_SCHEMA, balancedAnswerFor, readBalancedAnswer } from './balance.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from './company-label.js';

const NOW = 1_755_000_000_000;
const A = 'https://payroll-a.example';
const CO = 'co_1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071' as CompanyLabel;
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e' as VaultAddress;
const TX = 'AAECAwQFBgc=';
const TOKEN = 'ab'.repeat(32);

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'balance',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'Put money into your company vault.',
  nonce: 'b1',
  expiresAt: NOW + 60_000,
  company: CO,
  account: ACCOUNT,
  vault: VAULT,
  transaction: TX,
  ...over,
});
const codeOf = (raw: Record<string, unknown>): string => {
  try { parseAsk(raw, A, NOW); return 'parsed'; } catch (e) {
    return e instanceof RequestError ? e.code : `threw ${String(e)}`;
  }
};
const without = (key: string) => { const w = wire(); delete w[key]; return w; };

describe('A BALANCE ASK', () => {
  it('parses, folds both addresses to one spelling, keeps the label as written, and carries the transaction untouched', () => {
    const ask = parseAsk(wire({ account: ACCOUNT.toUpperCase(), vault: VAULT.toUpperCase() }), A, NOW);
    expect(ask.kind).toBe('balance');
    const b = ask as BalanceRequest;
    expect(b.company).toBe(CO);
    expect(b.account).toBe(ACCOUNT);
    expect(b.vault).toBe(VAULT);
    expect(b.transaction).toBe(TX);
    expect(b.requester.origin).toBe(A);
    expect(Object.keys(b).sort()).toEqual(
      ['account', 'company', 'expiresAt', 'kind', 'nonce', 'purpose', 'requester', 'schema', 'transaction', 'vault']);
  });

  it('refuses a company, a vault or a transaction it cannot read, each by name', () => {
    expect(codeOf(without('company'))).toBe('not-a-company-label');
    /* RED WHEN: the balance kind takes an address for the company, or a label for the account. */
    expect(codeOf(wire({ company: ACCOUNT }))).toBe('not-a-company-label');
    expect(codeOf(wire({ company: CO.toUpperCase() }))).toBe('not-a-company-label');
    expect(codeOf(without('account'))).toBe('not-an-account-address');
    expect(codeOf(wire({ account: CO }))).toBe('not-an-account-address');
    expect(codeOf(wire({ vault: CO }))).toBe('not-a-vault-address');
    expect(codeOf(without('vault'))).toBe('not-a-vault-address');
    expect(codeOf(wire({ vault: VAULT.slice(1) }))).toBe('not-a-vault-address');
    expect(codeOf(without('transaction'))).toBe('not-a-transaction');
    expect(codeOf(wire({ transaction: '' }))).toBe('not-a-transaction');
    expect(codeOf(wire({ transaction: 'not base64!' }))).toBe('not-a-transaction');
    expect(codeOf(wire({ transaction: 'AAECA' }))).toBe('not-a-transaction');
    expect(codeOf(wire({ transaction: 'A'.repeat(1_000_004) }))).toBe('not-a-transaction');
    expect(codeOf(wire({ transaction: 'A'.repeat(1_000_000) }))).toBe('parsed');
  });

  it('refuses a list of details, an inbox key and an address beside it, by presence', () => {
    expect(codeOf(wire({ wants: [] }))).toBe('attributes-on-a-balance');
    expect(codeOf(wire({ inboxPublicKey: 'ab'.repeat(32) }))).toBe('inbox-key-on-a-balance');
    expect(codeOf(wire({ address: 'x' }))).toBe('proposes-an-address');
    /* A figure proposed by the page is not a field at all; it is simply not read. */
    const ask = parseAsk(wire({ amount: '999' }), A, NOW) as unknown as Record<string, unknown>;
    expect('amount' in ask).toBe(false);
  });

  it('A TRANSACTION OR A VAULT ON ANY OTHER KIND IS REFUSED, NOT IGNORED', () => {
    for (const kind of ['sign-in', 'unlock', 'keyring', 'disclosure', 'join']) {
      expect(codeOf({ ...wire({ kind }), transaction: TX }), kind).toBe('balance-fields-on-another-kind');
      const noTx = wire({ kind }); delete noTx['transaction'];
      expect(codeOf(noTx), kind).toBe('balance-fields-on-another-kind');
    }
  });
});

describe('THE ANSWER, AND THE PAGE READING IT', () => {
  const ask = parseAsk(wire(), A, NOW) as BalanceRequest;
  const leaves = [{ token: TOKEN, amount: '1000', kind: 'shielded' as const }];
  const answer = balancedAnswerFor(ask, 'ZmluaXNoZWQ=', leaves, NOW);
  const expecting = { atOrigin: A, expectingNonce: 'b1', company: CO, account: ACCOUNT, vault: VAULT };

  it('carries the finished transaction and what left the wallet, addressed to the origin that asked', () => {
    expect(answer.schema).toBe(BALANCED_SCHEMA);
    expect(answer.origin).toBe(A);
    const read = readBalancedAnswer(answer, expecting);
    expect(read).toEqual({ ok: true, transaction: 'ZmluaXNoZWQ=', leaves });
  });

  it('refuses an answer to any other question', () => {
    const code = (over: Record<string, unknown>) => {
      const r = readBalancedAnswer({ ...answer, ...over }, expecting);
      return r.ok ? 'accepted' : r.code;
    };
    expect(code({ schema: 'x' })).toBe('not-an-answer');
    expect(code({ origin: 'https://other.example' })).toBe('origin-mismatch');
    expect(code({ nonce: 'b2' })).toBe('nonce-mismatch');
    expect(code({ vault: CO })).toBe('other-transaction');
    expect(code({ company: VAULT })).toBe('other-transaction');
    /* RED WHEN: the reader does not compare the account. */
    expect(code({ account: VAULT })).toBe('other-transaction');
    expect(code({ company: CO.toUpperCase() })).toBe('other-transaction');
    expect(code({ transaction: 'x' })).toBe('not-an-answer');
    expect(code({ leaves: [{ token: TOKEN, amount: '-1', kind: 'shielded' }] })).toBe('not-an-answer');
    expect(code({ leaves: [{ token: TOKEN, amount: '01', kind: 'shielded' }] })).toBe('not-an-answer');
    expect(code({ leaves: [{ token: TOKEN, amount: '1', kind: 'dust' }] })).toBe('not-an-answer');
    expect(code({ leaves: 'all of it' })).toBe('not-an-answer');
    expect(code({ at: 1.5 })).toBe('not-an-answer');
    expect(readBalancedAnswer(null, expecting).ok).toBe(false);
  });
});
