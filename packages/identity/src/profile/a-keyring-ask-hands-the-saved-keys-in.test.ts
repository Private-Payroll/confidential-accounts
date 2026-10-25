import { describe, expect, it, vi } from 'vitest';

vi.mock('./act-intents.js', () => ({
  ACT_INTENTS: Object.freeze({ 'move-between-vaults': { fields: { vault: 'vault' } } }),
}));

import { ACT_ENDED_SCHEMA } from './channel.js';
import { readActEnded } from './act-channel.js';
import { RequestError, parseAsk, type KeyringRequest } from './request.js';
import { KEYRING_RELEASE_SCHEMA, readKeyringRelease } from './unlock.js';

/*
 * **A KEYRING ASK HANDS THE PERSON'S SAVED KEYS IN, SEALED, AND THE WALLET READS THEM ITSELF.** The page holds the
 * sealed copy the service gave it and never the key; the ask carries it with each listed company's viewing key wrapped
 * to its seats and the creation changes the page asks for, each in a closed shape, so nothing the page names reaches
 * the wallet as a field it does not read. An action's end answer says what the saved keys hold that is not secret, and
 * never a copy: one viewing key at most, the action's own company's, which its ask handed in served as a keyring ask's.
 */

const NOW = 1_755_000_000_000;
const PAGE = 'https://app.payroll.example';
const SEALED = { iv: '00'.repeat(12), tag: '', body: 'ab'.repeat(40) };
const SERVED = {
  accountId: 'acc_aaaaaaaaaaaa', inboxPublicKey: 'c1'.repeat(32),
  wrappedKeys: [{ signerId: 'sgn_aaaaaaaaaa', iv: '01'.repeat(12), tag: '02'.repeat(16), body: '03'.repeat(64), ephemeral: '04'.repeat(32) }],
};

const keyringAsk = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'midnight-identity/disclosure-request/v1', kind: 'keyring', requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'To read your companies.', nonce: 'n1', expiresAt: NOW + 600_000, person: 'usr_a',
  keyring: { sealed: SEALED, version: 3 }, served: [SERVED], tidy: [{ record: 'acc_bbbbbbbbbbbb', what: 'aside' }],
  ...over,
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

describe('A KEYRING ASK HANDS THE SAVED KEYS IN, FOR THE WALLET TO READ', () => {
  it('carries the saved keys, the served keys and the asked changes for a company that exists, as given', () => {
    const k = parseAsk(keyringAsk(), PAGE, NOW) as KeyringRequest;
    /* RED WHEN: an ask that is not starting a company is refused for handing the saved keys in, so the page must open them. */
    expect(k.keyring).toEqual({ sealed: SEALED, version: 3 });
    expect(k.served).toEqual([SERVED]);
    expect(k.tidy).toEqual([{ record: 'acc_bbbbbbbbbbbb', what: 'aside' }]);
  });

  it('refuses served keys or changes with no saved keys, and anything outside their shapes', () => {
    const { keyring: _gone, ...noKeys } = keyringAsk();
    /* RED WHEN: served keys are read with no saved keys to read a seat from. */
    expect(refusal(noKeys)).toBe('malformed-field');
    /* RED WHEN: a served key carrying a field its shape does not name, a seat's secret say, is read. */
    expect(refusal(keyringAsk({ served: [{ ...SERVED, wrappingSecret: '05'.repeat(32) }] }))).toBe('malformed-field');
    expect(refusal(keyringAsk({ served: [{ ...SERVED, inboxPublicKey: 'not hex' }] }))).toBe('malformed-field');
    /* RED WHEN: a change the wallet does not make is read. */
    expect(refusal(keyringAsk({ tidy: [{ record: 'acc_bbbbbbbbbbbb', what: 'drop-the-seat' }] }))).toBe('malformed-field');
    expect(refusal(keyringAsk({ served: Array.from({ length: 65 }, () => SERVED) }))).toBe('malformed-field');
  });
});

describe('AN ACTION\'S END ANSWER SAYS WHAT THE SAVED KEYS HOLD THAT IS NOT SECRET', () => {
  const ended = (keys: unknown) => ({
    schema: ACT_ENDED_SCHEMA, nonce: 'n1', intent: 'move-between-vaults', ended: 'done', step: 1, steps: 1, relayed: 0, unconfirmed: 0,
    ...(keys === undefined ? {} : { keys }),
  });
  const KEYS = { seats: {}, viewing: {}, metadata: { counter: 2 }, holder: 'a5'.repeat(32), resealed: null };

  it('carries the seats and metadata, one viewing key at most, and never a copy', () => {
    expect(readActEnded(ended(KEYS), { nonce: 'n1', intent: 'move-between-vaults' })?.keys).toEqual(KEYS);
    const SEAT_SHOWN = { signerId: 'sgn_aaaaaaaaaa', signingPublicKey: 'a1'.repeat(32), wrappingPublicKey: 'a2'.repeat(32), scope: 'a3'.repeat(32) };
    const one = { ...KEYS, seats: { acc_aaaaaaaaaaaa: SEAT_SHOWN }, viewing: { acc_aaaaaaaaaaaa: 'a4'.repeat(32) } };
    /* RED WHEN: the action's own company's key is not read, so a page that acted with its keys closed asks again. */
    expect(readActEnded(ended(one), { nonce: 'n1', intent: 'move-between-vaults' })?.keys).toEqual(one);
    /* RED WHEN: an end answer hands the page more than its own company's key. */
    const two = { ...one, seats: { ...one.seats, acc_bbbbbbbbbbbb: SEAT_SHOWN }, viewing: { ...one.viewing, acc_bbbbbbbbbbbb: 'a6'.repeat(32) } };
    expect(readActEnded(ended(two), { nonce: 'n1', intent: 'move-between-vaults' })).toBeNull();
    expect(readActEnded(ended({ ...one, resealed: { sealed: SEALED, ifVersion: 3 } }), { nonce: 'n1', intent: 'move-between-vaults' })).toBeNull();
    /* RED WHEN: an end answer carries a seat's secret in a field the shape does not name. */
    expect(readActEnded(ended({ ...KEYS, signingSecret: '11'.repeat(32) }), { nonce: 'n1', intent: 'move-between-vaults' })).toBeNull();
  });
});

describe('AN ACTION ASK HANDS IN ITS OWN COMPANY\'S SERVED KEYS, AND NO MORE', () => {
  const actAsk = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema: 'midnight-identity/disclosure-request/v1', kind: 'act', requester: { name: 'Payroll', rdns: 'example.payroll' },
    purpose: 'To make a vault.', nonce: 'n1', expiresAt: NOW + 600_000, intent: { name: 'move-between-vaults', vault: 'c'.repeat(64) },
    person: 'usr_a', keyring: { sealed: SEALED, version: 3 }, served: [SERVED], ...over,
  });

  it('reads one company\'s served keys with the saved keys, as a keyring ask reads them', () => {
    /* RED WHEN: the act ask cannot carry its own company's served keys, so its end answer can give no viewing key. */
    expect((parseAsk(actAsk(), PAGE, NOW) as { served?: unknown }).served).toEqual([SERVED]);
  });

  it('refuses more than one company\'s, any with no saved keys, and any outside the shape', () => {
    /* RED WHEN: an action ask can have the wallet open a company the action is not about. */
    expect(refusal(actAsk({ served: [SERVED, { ...SERVED, accountId: 'acc_bbbbbbbbbbbb' }] }))).toBe('not-an-act');
    const { person: _p, keyring: _k, ...bare } = actAsk();
    expect(refusal(bare)).toBe('not-an-act');
    expect(refusal(actAsk({ served: [{ ...SERVED, wrappingSecret: '05'.repeat(32) }] }))).toBe('not-an-act');
  });
});

describe('A COMPANY NAMED BESIDE OPENING THE SAVED KEYS', () => {
  const LABEL = `co_${'3d'.repeat(32)}`;
  const ACCOUNT = 'c0'.repeat(32);

  it('is read only with the company, its account and the saved keys, and only as yes', () => {
    const k = parseAsk(keyringAsk({ company: LABEL, account: ACCOUNT, companyIfOnChain: true }), PAGE, NOW) as KeyringRequest;
    /* RED WHEN: the wallet does not read that the company was named beside opening the saved keys, so a failed check blocks them. */
    expect([k.company, k.account, k.companyIfOnChain]).toEqual([LABEL, ACCOUNT, true]);
    const { keyring: _gone, served: _s, tidy: _t, ...noKeys } = keyringAsk({ company: LABEL, account: ACCOUNT, companyIfOnChain: true });
    /* RED WHEN: a company is named beside opening the saved keys with no company, no account, no saved keys, or as anything but yes. */
    expect([
      refusal(keyringAsk({ companyIfOnChain: true })),
      refusal(keyringAsk({ company: LABEL, companyIfOnChain: true })),
      refusal(noKeys),
      refusal(keyringAsk({ company: LABEL, account: ACCOUNT, companyIfOnChain: 'yes' })),
      refusal(keyringAsk({ company: LABEL, account: ACCOUNT, companyIfOnChain: false })),
    ]).toEqual(['malformed-field', 'malformed-field', 'malformed-field', 'malformed-field', 'malformed-field']);
  });

  it('takes an answer for no company as the saved keys opened alone, and still refuses one for another company', () => {
    const answer = (company: string | null, account: string | null) => readKeyringRelease({
      schema: KEYRING_RELEASE_SCHEMA, origin: PAGE, person: 'usr_a', signedInAs: null, company, account, nonce: 'n1', at: NOW,
      companyKey: null, committeeKey: null,
    }, { atOrigin: PAGE, expectingNonce: 'n1', person: 'usr_a', signedInAs: null, forCompany: LABEL as never, forAccount: ACCOUNT as never, companyIfOnChain: true });
    /* RED WHEN: a wallet whose chain check did not confirm the company cannot answer without blocking the saved keys. */
    expect(answer(null, null)).toMatchObject({ ok: true, company: null, companyKey: null });
    /* RED WHEN: an answer naming a company other than the one opened is taken. */
    expect(answer(`co_${'4d'.repeat(32)}`, ACCOUNT)).toMatchObject({ ok: false, code: 'company-mismatch' });
    /* RED WHEN: an ask that did not name the company beside opening the saved keys takes an answer for none. */
    expect(readKeyringRelease({
      schema: KEYRING_RELEASE_SCHEMA, origin: PAGE, person: 'usr_a', signedInAs: null, company: null, account: null, nonce: 'n1', at: NOW,
      companyKey: null, committeeKey: null,
    }, { atOrigin: PAGE, expectingNonce: 'n1', person: 'usr_a', signedInAs: null, forCompany: LABEL as never, forAccount: ACCOUNT as never })).toMatchObject({ ok: false, code: 'company-mismatch' });
  });
});
