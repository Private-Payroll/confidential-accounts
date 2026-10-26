import { describe, expect, it } from 'vitest';
import { readActEnded } from './act-channel.js';
import * as channel from './act-channel.js';
import * as request from './request.js';
import { RequestError, intentShapeOf, parseAsk, routeOf } from './request.js';

/*
 * **A ONE-OFF PAYMENT IS ASKED OF THE WALLET BY INTENT.** The page names the company, the vault, the currency, the
 * amount, the payee's address, the payee's name and the reason, all of which the wallet checks and shows as the page's
 * words; or it names a proposal already raised, which the wallet approves, charges and pays from its own reads. The
 * wallet may ask the page only for the calls the entry lists, and a call is counted as sent only when it carries a
 * transaction.
 */

const NOW = 1_755_000_000_000;
const PAGE = 'https://app.payroll.example';
const LABEL = `co_${'a'.repeat(64)}`;
const ACCOUNT = 'b'.repeat(64);
const VAULT = 'c'.repeat(64);
const ASSET = 'd'.repeat(64);
const ADDRESS = 'mn_shield-addr_undeployed1qqqqqq';

const intent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'one-off-payment', record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: ASSET, amount: '250',
  payee: ADDRESS, payeeName: 'Acme Printing', reason: 'Business cards', ...over,
});
const act = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To pay a one-off payment.', nonce: 'n1', expiresAt: NOW + 600_000, intent: intent(), ...over,
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

describe('a one-off payment is one act, by intent', () => {
  it('reads the company, the vault, the currency, the amount, the payee, the name and the reason, and nothing else', () => {
    const read = parseAsk(act(), PAGE, NOW);
    /* RED WHEN: the wallet runs no one-off payment by intent. */
    expect(read.kind === 'act' ? read.intent : null).toEqual({
      name: 'one-off-payment',
      fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, vault: VAULT, token: ASSET, amount: '250', payee: ADDRESS, payeeName: 'Acme Printing', reason: 'Business cards' },
    });
    /* RED WHEN: the page can hand the wallet a window, a transaction, a seed or anything else it chose for the payment. */
    for (const extra of ['opensAt', 'closesAt', 'transaction', 'seed', 'form']) {
      expect(refusal(act({ intent: intent({ [extra]: '1' }) })), extra).toBe('not-an-act');
    }
    /* RED WHEN: a currency that is not sixty-four lower-case hex characters, or an amount that is not a whole number, is taken. */
    expect(refusal(act({ intent: intent({ token: 'D'.repeat(64) }) }))).toBe('not-an-act');
    expect(refusal(act({ intent: intent({ amount: '2.5' }) }))).toBe('not-an-act');
    /* RED WHEN: the company is not named. */
    for (const field of ['record', 'company', 'account']) {
      const { [field]: _left, ...short } = intent();
      expect(refusal(act({ intent: short })), field).toBe('not-an-act');
    }
  });

  it('names a proposal already raised instead, to approve, charge and pay it', () => {
    const read = parseAsk(act({ intent: { name: 'one-off-payment', record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_abcdefghijkl' } }), PAGE, NOW);
    /* RED WHEN: a proposal raised on another device cannot be carried on by intent. */
    expect(read.kind === 'act' ? read.intent.fields : null).toEqual({ record: 'acc_1', company: LABEL, account: ACCOUNT, proposal: 'prp_abcdefghijkl' });
  });

  it('may ask the page only for the company\'s records, the vault\'s records, the proposal, its charge and its payment', () => {
    const shape = intentShapeOf('one-off-payment')!;
    /* RED WHEN: the raise, the approval, the charge or the payment is not counted as sent. */
    for (const [method, path] of [
      ['POST', '/api/accounts/acc_1/proposals'], ['POST', '/api/proposals/prp_abcdefghijkl/approve'], ['POST', '/api/proposals/prp_abcdefghijkl/charge'],
      ['POST', `/api/accounts/acc_1/vaults/${VAULT}/payout`], ['POST', `/api/accounts/acc_1/vaults/${VAULT}/public-payout`],
      ['POST', '/api/accounts/acc_1/proven'],
    ] as const) {
      expect(routeOf(shape, method, path)?.sends, `${method} ${path}`).toBe(true);
    }
    /* RED WHEN: the one-off's record, the runs, the proposals or the vault's records cannot be read or filed. */
    for (const [method, path] of [
      ['PUT', '/api/accounts/acc_1/records/transfer/one_0123/1'], ['GET', '/api/accounts/acc_1/records/transfer/one_0123/1'],
      ['GET', '/api/accounts/acc_1/runs'], ['GET', '/api/accounts/acc_1/proposals'], ['POST', '/api/proposals/prp_abcdefghijkl/standing'],
      ['PUT', `/api/vaults/${VAULT}/records/payment-journal/2`], ['POST', '/api/accounts/acc_1/manifest/entries'],
    ] as const) {
      expect(routeOf(shape, method, path), `${method} ${path}`).not.toBeNull();
    }
    /* RED WHEN: the payment can read the service's view of the chain, the readers' keys or the saved keys, or send anything else. */
    for (const [method, path] of [
      ['GET', '/api/accounts/acc_1/call-state'], ['GET', `/api/accounts/acc_1/vaults/${VAULT}/payout-state`], ['GET', '/api/accounts/acc_1/vault-keys'],
      ['GET', '/api/me/keys'], ['POST', `/api/accounts/acc_1/vaults/${VAULT}/deposit`], ['POST', '/api/proposals/prp_abcdefghijkl/carry'],
      ['POST', '/api/accounts/acc_1/runs'], ['POST', `/api/accounts/acc_1/vaults/${VAULT}/merge`],
    ] as const) {
      expect(routeOf(shape, method, path), `${method} ${path}`).toBeNull();
    }
  });

  it('tells the page at its end only where the payment got to, the approvals and how many it needs, and the upkeep', () => {
    const ended = (outcome: unknown) => readActEnded({
      schema: 'midnight-identity/act-ended/v1', nonce: 'n1', intent: 'one-off-payment', ended: 'done', step: 7, steps: 7,
      relayed: 2, unconfirmed: 0, outcome,
    }, { nonce: 'n1', intent: 'one-off-payment' });
    expect(ended({ state: 'paid', approvals: 1, needed: 1, upkeep: 'done', anchored: 2 })?.outcome).toEqual({ state: 'paid', approvals: 1, needed: 1, upkeep: 'done', anchored: 2 });
    /* RED WHEN: the end can carry the amount, the payee or any part the entry does not list. */
    expect(ended({ amount: 250 })).toBeNull();
    expect(ended({ payee: 'mn' })).toBeNull();
  });
});

describe('a call is counted as sent only when it carries a transaction', () => {
  it('writing a proposal down with no transaction is not a send, and with one it is', () => {
    const shape = intentShapeOf('create-vault')!;
    const route = routeOf(shape, 'POST', '/api/accounts/acc_1/proposals')!;
    /* RED WHEN: a proposal written down with nothing for the chain is counted as handed over, so a late answer reads as maybe sent. */
    expect(request.sendsIn(route, JSON.stringify({ proposal: {}, salt: 'ab' }))).toBe(false);
    /* RED WHEN: a proposal raised with its transaction is not counted as sent. */
    expect(request.sendsIn(route, JSON.stringify({ proposal: {}, salt: 'ab', tx: 'AAAA' }))).toBe(true);
    /* RED WHEN: a body that does not read is taken as carrying nothing, so a send it may be is not counted. */
    expect(request.sendsIn(route, '{not json')).toBe(true);
    /* RED WHEN: a route that always sends stops counting, whatever its body. */
    expect(request.sendsIn(routeOf(shape, 'POST', `/api/accounts/acc_1/vaults/${VAULT}`.replace(`/${VAULT}`, ''))!, undefined)).toBe(true);
    /* RED WHEN: a read is counted as a send. */
    expect(request.sendsIn(routeOf(shape, 'GET', '/api/accounts/acc_1')!, undefined)).toBe(false);
    /* RED WHEN: the page's side cannot apply the same rule. */
    expect(channel.sendsIn).toBe(request.sendsIn);
  });
});
