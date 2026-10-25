import { describe, expect, it } from 'vitest';
import { parseAsk, readFoundingAsked, REQUEST_SCHEMA, type KeyringRequest } from './request.js';
import { ACT_RELAY_SCHEMA } from './channel.js';
import { readActRelay } from './act-channel.js';
import { ACT_INTENTS, FINISH_COMPANY_RELAYS } from './act-intents.js';

/*
 * TWO THINGS A COMPANY'S CREATION NOW CARRIES OVER THE WIRE, READ WHOLE: what a page asks a new company to be founded
 * with, beside the saved keys the wallet writes its seat into; and what each transaction an action hands back is for.
 */
const PAGE = 'https://app.payroll.example';
const keyring = (over: Record<string, unknown> = {}) => ({
  schema: REQUEST_SCHEMA, kind: 'keyring', requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'x',
  nonce: 'k1', expiresAt: Date.now() + 600_000, person: 'usr_a', ...over,
});
const FOUNDING = { name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' } };
const SAVED = { sealed: null, version: 0 };

describe('A FOUNDING IS ASKED FOR WITH ITS NAMES ONLY WITH STARTING A COMPANY, AND THE SAVED KEYS WITH ANY KEYRING ASK', () => {
  /* RED WHEN: the company's names or the saved keys a page hands in are lost, or changed, on the way to the wallet. */
  it('reads the founding and the saved keys of an ask that starts a company', () => {
    const ask = parseAsk(keyring({ drawLabel: true, founding: FOUNDING, keyring: SAVED }), PAGE, Date.now()) as KeyringRequest;
    expect(ask.founding).toEqual(FOUNDING);
    expect(ask.keyring).toEqual(SAVED);
  });

  /* RED WHEN: a founding rides on an ask that starts no company, so the wallet could sign a founding nobody asked it to start. */
  it('refuses a founding on an ask that starts no company, and takes the saved keys on any keyring ask', () => {
    expect(() => parseAsk(keyring({ founding: FOUNDING }), PAGE, Date.now())).toThrow(/does not ask your wallet to start one/u);
    /* RED WHEN: an ask for a company that exists may not hand the saved keys in, so the page must open them. */
    expect((parseAsk(keyring({ keyring: SAVED }), PAGE, Date.now()) as { keyring?: unknown }).keyring).toEqual(SAVED);
  });

  /* RED WHEN: a name the wallet would sign into a roster is empty or unbounded, a role is not one of the four, or anything else rides along. */
  it('reads a founding only as two names of 1 to 200 characters and one of the four roles', () => {
    expect(readFoundingAsked(FOUNDING)).toEqual(FOUNDING);
    for (const bad of [
      { ...FOUNDING, name: ' ' }, { ...FOUNDING, name: 'x'.repeat(201) }, { ...FOUNDING, signer: { name: 'Priya', role: 'owner' } },
      { ...FOUNDING, extra: 1 }, { ...FOUNDING, signer: { ...FOUNDING.signer, extra: 1 } }, null, 'Acme',
    ]) expect(readFoundingAsked(bad)).toBeNull();
    expect(() => parseAsk(keyring({ drawLabel: true, founding: { name: '' }, keyring: SAVED }), PAGE, Date.now())).toThrow(/in a form this wallet does not read/u);
  });
});

describe('A TRANSACTION AN ACTION HANDS BACK SAYS WHAT IT IS FOR', () => {
  const relay = (over: Record<string, unknown> = {}) => ({ schema: ACT_RELAY_SCHEMA, nonce: 'n', n: 1, step: 1, steps: 5, transaction: 'dHgx', ...over });

  /* RED WHEN: the name of what a transaction is for, or the transaction sent with it, is lost when the relay is read. */
  it('reads a relay\'s name and the second transaction sent with it', () => {
    expect(readActRelay(relay({ what: 'creation', also: 'aW5zZXJ0' }), 'n')).toMatchObject({ what: 'creation', also: 'aW5zZXJ0' });
    expect(readActRelay(relay(), 'n')).not.toHaveProperty('what');
  });

  /* RED WHEN: a malformed name, or a second transaction with no name to say where the pair goes, is read as a relay. */
  it('refuses a name that is not one, and a second transaction with no name', () => {
    for (const bad of [{ what: 'Creation' }, { what: 'creation--x' }, { what: 7 }, { also: 'aW5zZXJ0' }, { what: 'creation', also: 'not base64!' }]) {
      expect(readActRelay(relay(bad), 'n')).toBeNull();
    }
  });

  /* RED WHEN: finishing a company hands back a transaction under a name its page does not route. */
  it('names every relay finishing a company makes, and the action takes the company\'s label alone', () => {
    expect(ACT_INTENTS['finish-company']).toEqual({ fields: { company: 'company' }, relays: FINISH_COMPANY_RELAYS });
    for (const what of FINISH_COMPANY_RELAYS) expect(readActRelay(relay({ what }), 'n')?.what).toBe(what);
  });
});
