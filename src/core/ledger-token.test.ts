import { describe, expect, it } from 'vitest';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';

import { assetIdBytes, assets, ledgerTokenOf } from './assets.js';
import { toHex } from './crypto.js';
import { transferFacts, transferOf } from './movement.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';

/**
 * **THE TOKEN A PAYMENT MOVES IS THE LEDGER'S, AND THE NAME AN ACCOUNT GIVES AN
 * ASSET IS UNCHANGED.**
 *
 * A vault holds NIGHT as the ledger's own token type, because that is the only
 * NIGHT a wallet can fund a deposit with. A payment out of a vault is checked
 * against the token it commits to. So the two must be one value, and the value
 * must be the ledger's: the account's name for an asset is padded ASCII and a
 * vault never holds a balance under it.
 *
 * Every expected value below is read from somewhere other than the code under
 * test: the ledger's token type from the ledger itself, the account's name for
 * NIGHT from the characters of the word, and the test settlement asset's colour
 * from a mint that produced it on a public test network, written down here.
 */

const NETWORK = 'undeployed' as const;
const LEDGER_NIGHT = (nativeToken() as unknown as { raw: string }).raw;

/** `NIGHT` as ASCII, zero padded to 32 bytes, computed without `assetIdBytes`. */
const NIGHT_AS_ASCII = Buffer.from('NIGHT', 'ascii').toString('hex').padEnd(64, '0');

/**
 * **WHAT THE LEDGER CALLS EVERY ASSET THAT HAS A FORM, FROM SOMEWHERE OTHER
 * THAN THE FUNCTION UNDER TEST.**
 *
 * The loop below used to compare `ledgerTokenOf(code, form)` against
 * `asset.ledger[form]` - which is the value that function reads its answer out
 * of. **Two live computations of one value: it stayed green whatever either
 * side became**, including a registry row edited to name money nobody minted.
 *
 * NIGHT's token comes from the ledger itself, above. The test settlement
 * asset's comes from the chain: a mint on stagenet produced it and a settled
 * deposit has moved it, and it is written down here as a second copy on
 * purpose. A row that changes without that mint having happened is a row
 * naming money that does not exist, and this is what says so.
 */
const WHAT_THE_LEDGER_CALLS_IT: Readonly<Record<string, string>> = Object.freeze({
  'NIGHT unshielded': LEDGER_NIGHT,
  'TESTUSD shielded': 'abda184485c6abbbe4440d65b99ef88e0f79f61ec19af52a5bb0d91b4a824679',  // not-a-secret: the colour a mint produced on a public test network, published by the chain itself and readable by anyone
});

const publicNightTransfer = (amount = 10n) => transferOf({
  accountId: 'acct_1',
  payee: unshieldedPayeeFor('c3'.repeat(32), NETWORK),
  asset: 'NIGHT',
  amount,
  privacy: 'public',
  reference: 'the company paying its own account',
  createdBy: 'usr_founder',
  employees: [],
  at: new Date('2026-09-11T09:00:00.000Z'),
});

describe('the token a payment out of a vault moves', () => {
  it('NIGHT paid publicly is the ledger\'s own NIGHT, read from the ledger', () => {
    expect(LEDGER_NIGHT).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerTokenOf('NIGHT', 'unshielded')).toBe(LEDGER_NIGHT);
  });

  it('a public NIGHT transfer commits to the token a deposit puts into a vault', () => {
    const facts = transferFacts(publicNightTransfer());
    expect(facts.token).toBe(LEDGER_NIGHT);
    expect(facts.amount).toBe(10n);
  });

  it('the account\'s own name for NIGHT is untouched, and it is a different value', () => {
    /*
     * The account's balance key is built over these bytes. If a fix for the
     * payment's token were made by repointing them, every balance would move to
     * a new key; this goes red first.
     */
    expect(toHex(assetIdBytes('NIGHT'))).toBe(NIGHT_AS_ASCII);
    expect(NIGHT_AS_ASCII).not.toBe(LEDGER_NIGHT);
    expect(transferFacts(publicNightTransfer()).token).not.toBe(NIGHT_AS_ASCII);
  });

  it('refuses private NIGHT by name and says which asset CAN be paid privately instead', () => {
    expect(() => ledgerTokenOf('NIGHT', 'shielded')).toThrow(/NIGHT has no private form on Midnight/);
    expect(() => ledgerTokenOf('NIGHT', 'shielded')).toThrow(/It has a public form only\./);
    /*
     * RED WHEN the refusal stops naming a way through. Until a test settlement
     * asset existed there was none to name and the sentence was "No asset has a
     * private form yet"; there is one now, and a refusal that still said the
     * old sentence would be sending somebody away from a payment they can make.
     */
    expect(() => ledgerTokenOf('NIGHT', 'shielded'))
      .toThrow(/Assets that have a private form: TESTUSD\./);
  });

  it('refuses every other asset in the product registry, in both forms, rather than inventing a token', () => {
    /*
     * Read off the rows rather than off a list of codes, so this goes on
     * describing the registry the day a row gains a form: an asset with a token
     * in a form must be given exactly that token, and one without must be refused.
     */
    for (const asset of assets.all()) {
      for (const form of ['shielded', 'unshielded'] as const) {
        const row = asset.ledger[form];
        let message = '';
        let value: string | undefined;
        try { value = ledgerTokenOf(asset.code, form); } catch (e) { message = String((e as Error).message); }
        if (row === null) {
          expect(value, `${asset.code} ${form} must not be given a token`).toBeUndefined();
          expect(message).toContain(asset.code);
          expect(message).toMatch(form === 'shielded'
            ? /Assets that have a private form: TESTUSD\./
            : /Assets that have a public form: NIGHT\./);
        } else {
          const key = `${asset.code} ${form}`;
          /*
           * RED WHEN a row gains a token nothing outside this file has
           * accounted for. The table is the second copy; a row with no entry in
           * it is a token nobody has said where it came from.
           */
          expect(WHAT_THE_LEDGER_CALLS_IT, key).toHaveProperty(key);
          /* RED WHEN the registry's row is edited to a value no mint produced,
           * which the old form of this assertion followed in silence. */
          expect(value, key).toBe(WHAT_THE_LEDGER_CALLS_IT[key]);
          expect(row, key).toBe(WHAT_THE_LEDGER_CALLS_IT[key]);
        }
      }
    }
    /*
     * RED WHEN a third row gains a ledger form. Exactly two rows in this
     * registry state a token: NIGHT publicly, and the test settlement asset
     * privately. Everything else states null in both forms.
     */
    expect(assets.all().filter(a => a.code !== 'NIGHT' && a.code !== 'TESTUSD').every(a =>
      a.ledger.shielded === null && a.ledger.unshielded === null)).toBe(true);
    expect(assets.require('TESTUSD').ledger.unshielded).toBeNull();
  });

  it('a public transfer in an asset no vault can hold is refused when its payment is built', () => {
    const gbp = transferOf({
      accountId: 'acct_1',
      payee: unshieldedPayeeFor('c3'.repeat(32), NETWORK),
      asset: 'GBP',
      amount: 100n,
      privacy: 'public',
      reference: 'a supplier',
      createdBy: 'usr_founder',
      employees: [],
    });
    expect(() => transferFacts(gbp)).toThrow(/GBP has no form on Midnight, private or public/);
  });

  it('the payee\'s own kind picks the token, so a record naming a private address gets none', () => {
    /*
     * `transferOf` refuses private NIGHT before this is reached. A record that
     * arrived some other way, with a private address on it, must still be
     * refused here rather than handed the public token.
     */
    const record = { ...publicNightTransfer(), payee: payeeFor(new Uint8Array(32).fill(0x44), NETWORK) };
    expect(() => transferFacts(record)).toThrow(/NIGHT has no private form on Midnight/);
  });

  it('a private address is still refused where the transfer is made, before any token is asked for', () => {
    expect(() => transferOf({
      accountId: 'acct_1',
      payee: payeeFor(new Uint8Array(32).fill(0x44), NETWORK),
      asset: 'NIGHT',
      amount: 100n,
      privacy: 'private',
      reference: 'a supplier',
      createdBy: 'usr_founder',
      employees: [],
    })).toThrow(/no private form of NIGHT/);
  });
});
