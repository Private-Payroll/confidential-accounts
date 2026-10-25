import { describe, expect, it, vi } from 'vitest';

/*
 * One action, named only for this file, stands in for the list later actions are added to: the parser reads it
 * exactly as it reads any of them.
 */
vi.mock('./act-intents.js', () => ({
  ACT_INTENTS: Object.freeze({
    'move-between-vaults': {
      fields: { company: 'company', account: 'account', vault: 'vault', seat: 'seat', amount: 'amount' },
    },
  }),
}));

import { RequestError, parseAsk } from './request.js';

const NOW = 1_755_000_000_000;
const ORIGIN = 'https://payroll-a.example';
const LABEL = `co_${'a'.repeat(64)}`;
const ACCOUNT = 'b'.repeat(64);
const VAULT = 'c'.repeat(64);
const SEAT = 'd'.repeat(64);

const intent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'move-between-vaults', company: LABEL, account: ACCOUNT, vault: VAULT, seat: SEAT, amount: '1000', ...over,
});
const act = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1',
  kind: 'act',
  requester: { name: 'Payroll A', rdns: 'example.payroll-a' },
  purpose: 'To move money between two of your company\'s vaults.',
  nonce: 'n1',
  expiresAt: NOW + 20 * 60_000,
  intent: intent(),
  ...over,
});
const refusal = (raw: unknown): string => {
  try {
    parseAsk(raw, ORIGIN, NOW);
  } catch (e) {
    if (e instanceof RequestError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('an action ask names the action and the ids and amounts it acts on, and nothing else', () => {
  it('an action the wallet runs is read with each field by its kind, and always hears progress', () => {
    const read = parseAsk(act(), ORIGIN, NOW);
    /* RED WHEN: the parser does not know the `act` kind, or reads it as another kind. */
    expect(read.kind).toBe('act');
    if (read.kind !== 'act') return;
    expect(read.intent).toEqual({
      name: 'move-between-vaults', fields: { company: LABEL, account: ACCOUNT, vault: VAULT, seat: SEAT, amount: '1000' },
    });
    /* RED WHEN: an action ask that did not say it hears progress is told nothing while it runs, so its steps never reach the page. */
    expect(read.hearsProgress).toBe(true);
    expect(read.requester.origin).toBe(ORIGIN);
  });

  it('an action the wallet does not run is refused before anything is shown', () => {
    /* RED WHEN: an unknown action name is accepted and left for the wallet to guess at. */
    expect(refusal(act({ intent: intent({ name: 'drain-every-vault' }) }))).toBe('unknown-intent');
    /* RED WHEN: a name inherited by every object, such as `toString`, passes as an action. */
    expect(refusal(act({ intent: intent({ name: 'toString' }) }))).toBe('unknown-intent');
    expect(refusal(act({ intent: 'move-between-vaults' }))).toBe('not-an-act');
  });

  it('a field the action does not take, or a missing one, is refused rather than ignored', () => {
    /* RED WHEN: the intent's fields are not held to the action's own list, so a page can add bytes it built. */
    expect(refusal(act({ intent: intent({ transaction: 'AAAA' }) }))).toBe('not-an-act');
    /* RED WHEN: a field the action needs may be left out. */
    const { amount: _left, ...short } = intent();
    expect(refusal(act({ intent: short }))).toBe('not-an-act');
  });

  it('every field is read by its kind: an amount is a whole decimal number, a seat and a vault are addresses', () => {
    /* RED WHEN: an amount is taken as given, so a negative, fractional or padded figure reaches the wallet. */
    for (const amount of ['-1', '1.5', '01', '', 'ten', 1000]) {
      expect(refusal(act({ intent: intent({ amount }) })), String(amount)).toBe('not-an-act');
    }
    /* RED WHEN: a seat or a vault is not checked to be an address. */
    expect(refusal(act({ intent: intent({ seat: 'D'.repeat(64) }) }))).toBe('not-an-act');
    expect(refusal(act({ intent: intent({ vault: 'c'.repeat(63) }) }))).toBe('not-an-act');
    expect(refusal(act({ intent: intent({ company: 'not a label' }) }))).not.toBe('accepted');
  });

  it('a page cannot slip another kind\'s fields into an action', () => {
    /* RED WHEN: an action ask may carry a transaction for the wallet to pay for. */
    expect(refusal(act({ transaction: 'AAAA' }))).toBe('balance-fields-on-another-kind');
    /* RED WHEN: an action ask may carry a deploy or keys to insert, built by the page. */
    expect(refusal(act({ deploy: 'AAAA' }))).toBe('creation-fields-on-another-kind');
    /* RED WHEN: an action ask may carry a seat or an invitation the way a records-key ask does. */
    expect(refusal(act({ seat: SEAT }))).toBe('records-key-fields-on-another-kind');
    /* RED WHEN: an action ask's own allow-list is dropped, so anything no other kind names is ignored and kept. */
    for (const field of ['company', 'wants', 'inboxPublicKey', 'bytes']) {
      expect(refusal(act({ [field]: 'x' })), field).toBe('more-than-an-act');
    }
  });

  it('an action belongs to an action ask: another kind carrying one is refused', () => {
    const balance = {
      ...act(), kind: 'balance', intent: undefined, company: LABEL, account: ACCOUNT, vault: VAULT, transaction: 'AAAA',
    };
    delete (balance as Record<string, unknown>)['intent'];
    expect(refusal(balance)).toBe('accepted');
    /* RED WHEN: an intent is ignored on another kind, so a page can name an action behind a payment's screen. */
    expect(refusal({ ...balance, intent: intent() })).toBe('act-fields-on-another-kind');
    expect(refusal({ ...act(), kind: 'sign-in', intent: intent() })).toBe('act-fields-on-another-kind');
  });
});
