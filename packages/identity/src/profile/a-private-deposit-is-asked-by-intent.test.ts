import { describe, expect, it } from 'vitest';
import { readActEnded } from './act-channel.js';
import { RequestError, intentShapeOf, parseAsk, routeOf } from './request.js';

/*
 * **A PRIVATE DEPOSIT IS ASKED OF THE WALLET BY INTENT, NAMING ONLY IDS, A TOKEN AND AN AMOUNT.** The wallet builds,
 * proves, pays and signs everything the deposit makes from its own reads; the page names the company, the vault, the
 * private token and the amount, may be asked only for the calls the entry lists, and hears back only public facts.
 */

const NOW = 1_755_000_000_000;
const PAGE = 'https://app.payroll.example';
const LABEL = `co_${'a'.repeat(64)}`;
const ACCOUNT = 'b'.repeat(64);
const VAULT = 'c'.repeat(64);
const TOKEN = 'd'.repeat(64);

const intent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'private-deposit', record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: TOKEN, amount: '1500000', ...over,
});
const act = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To put money into a vault.', nonce: 'n1', expiresAt: NOW + 600_000, intent: intent(), ...over,
});
const refusal = (raw: unknown): string => {
  try {
    parseAsk(raw, PAGE, NOW);
  } catch (e) {
    if (e instanceof RequestError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('a private deposit is one act, by intent', () => {
  it('reads the company, the vault, the private token and the amount, and nothing else', () => {
    const read = parseAsk(act(), PAGE, NOW);
    /* RED WHEN: the wallet runs no private deposit by intent. */
    expect(read.kind === 'act' ? read.intent : null).toEqual({
      name: 'private-deposit', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: TOKEN, amount: '1500000' },
    });
    /* RED WHEN: the page can hand the wallet a transaction, a coin or anything it built for the deposit. */
    expect(refusal(act({ intent: intent({ transaction: 'AAAA' }) }))).toBe('not-an-act');
    expect(refusal(act({ intent: intent({ coin: 'e'.repeat(64) }) }))).toBe('not-an-act');
    /* RED WHEN: a token that is not sixty-four lower-case hex characters, or an amount that is not a whole number, is taken. */
    for (const token of ['D'.repeat(64), 'd'.repeat(63), `0x${'d'.repeat(62)}`, 1, '']) {
      expect(refusal(act({ intent: intent({ token }) })), String(token)).toBe('not-an-act');
    }
    for (const amount of ['-1', '1.5', '0x10', '']) expect(refusal(act({ intent: intent({ amount }) })), amount).toBe('not-an-act');
    /* RED WHEN: any field may be left out. */
    for (const field of ['record', 'company', 'account', 'vault', 'token', 'amount']) {
      const { [field]: _left, ...short } = intent();
      expect(refusal(act({ intent: short })), field).toBe('not-an-act');
    }
  });

  it('may ask the page only for the company\'s records, the vault\'s records and the one deposit it sends', () => {
    const shape = intentShapeOf('private-deposit')!;
    /* RED WHEN: the deposit's one transaction is not counted as sent, so a refused relay shows as nothing out. */
    expect(routeOf(shape, 'POST', `/api/accounts/acc_1/vaults/${VAULT}/deposit`)?.sends).toBe(true);
    expect(routeOf(shape, 'PUT', `/api/vaults/${VAULT}/records/pool/2`)).not.toBeNull();
    expect(routeOf(shape, 'GET', `/api/vaults/${VAULT}/records/deposit-journal/versions`)).not.toBeNull();
    expect(routeOf(shape, 'POST', '/api/accounts/acc_1/manifest/entries')).not.toBeNull();
    /* RED WHEN: the deposit can read the chain, the call state, the readers' keys or the saved keys through the page, or send anything else. */
    for (const [method, path] of [
      ['GET', `/api/accounts/acc_1/vaults/${VAULT}/chain`], ['GET', '/api/accounts/acc_1/call-state'], ['GET', '/api/accounts/acc_1/vault-keys'],
      ['GET', '/api/me/keys'], ['POST', `/api/accounts/acc_1/vaults/${VAULT}/payout`], ['POST', '/api/accounts/acc_1/proposals'],
      ['POST', `/api/accounts/acc_1/vaults/${VAULT}/public-deposit`], ['PUT', '/api/accounts/acc_1/records/state/acc_1/2'],
    ] as const) {
      expect(routeOf(shape, method, path), `${method} ${path}`).toBeNull();
    }
  });

  it('tells the page at its end only the vault, where the deposit got to and the transaction the chain made it in', () => {
    const ended = (outcome: unknown) => readActEnded({
      schema: 'midnight-identity/act-ended/v1', nonce: 'n1', intent: 'private-deposit', ended: 'done', step: 2, steps: 2,
      relayed: 1, unconfirmed: 0, outcome,
    }, { nonce: 'n1', intent: 'private-deposit' });
    expect(ended({ vault: VAULT, state: 'recorded', created: 'e'.repeat(64) })?.outcome).toEqual({ vault: VAULT, state: 'recorded', created: 'e'.repeat(64) });
    /* RED WHEN: the end can carry a coin's nonce, a secret or any part the entry does not list. */
    expect(ended({ vault: VAULT, nonce: 'f'.repeat(64) })).toBeNull();
    expect(ended({ state: 'Recorded Now' })).toBeNull();
  });
});
