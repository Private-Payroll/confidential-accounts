import { describe, expect, it } from 'vitest';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';

import { assetIdBytes, assets, ledgerTokenOf, NIGHT, TEST_SETTLEMENT_ASSET } from './assets.js';
import { toHex } from './crypto.js';
import { transferFacts, transferOf } from './movement.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';

/**
 * **THE TOKEN A PAYMENT MOVES IS THE LEDGER'S, AND AN ASSET IS THAT TOKEN.**
 *
 * A vault holds NIGHT as the ledger's own token type, because that is the only
 * NIGHT a wallet can fund a deposit with. A payment out of a vault is checked
 * against the token it commits to. So the two must be one value, and the value
 * must be the ledger's; and the account names an asset by the same value, so a
 * run's root, a spending policy's key and the payment the vault makes all name
 * one token.
 *
 * Every expected value below is read from somewhere other than the code under
 * test: the ledger's token type from the ledger itself, and the test settlement
 * asset's colour from a mint that produced it on a public test network,
 * written down here.
 */

const NETWORK = 'undeployed' as const;
const LEDGER_NIGHT = (nativeToken() as unknown as { raw: string }).raw;

/** `NIGHT` as ASCII, zero padded to 32 bytes: the placeholder name an account once gave it. */
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
  'tUSD shielded': 'abda184485c6abbbe4440d65b99ef88e0f79f61ec19af52a5bb0d91b4a824679',  // not-a-secret: the colour a mint produced on a public test network, published by the chain itself and readable by anyone
});

const publicNightTransfer = (amount = 10n) => transferOf({
  accountId: 'acct_1',
  payee: unshieldedPayeeFor('c3'.repeat(32), NETWORK),
  asset: NIGHT,
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
    /* RED WHEN NIGHT's identity in the registry is not the ledger's own NIGHT. */
    expect(NIGHT).toBe(LEDGER_NIGHT);
    expect(ledgerTokenOf(NIGHT, 'unshielded')).toBe(LEDGER_NIGHT);
  });

  it('a public NIGHT transfer commits to the token a deposit puts into a vault', () => {
    const facts = transferFacts(publicNightTransfer());
    expect(facts.token).toBe(LEDGER_NIGHT);
    expect(facts.amount).toBe(10n);
  });

  it('the account\'s own name for NIGHT is the ledger\'s token, the same value the payment moves', () => {
    /*
     * By design: an asset is identified by its ledger token
     * everywhere. The account's asset key, a run's root and a spending policy
     * are built over these bytes, and the vault hands the account the token it
     * moves, so they must be the token itself and never a padded name.
     */
    /* RED WHEN the account's name for an asset is anything but its ledger token, such as padded ASCII. */
    expect(toHex(assetIdBytes(NIGHT))).toBe(LEDGER_NIGHT);
    expect(transferFacts(publicNightTransfer()).token).toBe(toHex(assetIdBytes(NIGHT)));
    /* RED WHEN the placeholder name is accepted as an asset at all. */
    expect(() => assetIdBytes('NIGHT')).toThrow(/is not an asset/);
    expect(transferFacts(publicNightTransfer()).token).not.toBe(NIGHT_AS_ASCII);
  });

  it('refuses private NIGHT by name and says which asset CAN be paid privately instead', () => {
    expect(() => ledgerTokenOf(NIGHT, 'shielded')).toThrow(/NIGHT has no private form on Midnight/);
    expect(() => ledgerTokenOf(NIGHT, 'shielded')).toThrow(/It has a public form only\./);
    /*
     * RED WHEN the refusal stops naming a way through. Until a test settlement
     * asset existed there was none to name and the sentence was "No asset has a
     * private form yet"; there is one now, and a refusal that still said the
     * old sentence would be sending somebody away from a payment they can make.
     */
    /* RED WHEN the refusal names a token by its hex rather than its symbol. */
    expect(() => ledgerTokenOf(NIGHT, 'shielded'))
      .toThrow(/Assets that have a private form: tUSD\./);
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
          expect(value, `${asset.symbol} ${form} must not be given a token`).toBeUndefined();
          expect(message).toContain(asset.symbol);
          expect(message).toMatch(form === 'shielded'
            ? /Assets that have a private form: tUSD\./
            : /Assets that have a public form: NIGHT\./);
        } else {
          const key = `${asset.symbol} ${form}`;
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
     * RED WHEN a third row appears. Exactly two rows are in this registry, each a
     * real token: NIGHT publicly, and the test settlement asset privately.
     */
    expect(assets.all().map(a => a.symbol)).toEqual(['NIGHT', 'tUSD']);
    expect(assets.require(TEST_SETTLEMENT_ASSET).ledger.unshielded).toBeNull();
  });

  it('a public transfer in an asset no vault can hold publicly is refused when its payment is built', () => {
    const tusd = transferOf({
      accountId: 'acct_1',
      payee: unshieldedPayeeFor('c3'.repeat(32), NETWORK),
      asset: TEST_SETTLEMENT_ASSET,
      amount: 100n,
      privacy: 'public',
      reference: 'a supplier',
      createdBy: 'usr_founder',
      employees: [],
    });
    /* RED WHEN a token with no public form is given one for a public payment. */
    expect(() => transferFacts(tusd)).toThrow(/tUSD has no public form on Midnight/);
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
      asset: NIGHT,
      amount: 100n,
      privacy: 'private',
      reference: 'a supplier',
      createdBy: 'usr_founder',
      employees: [],
    })).toThrow(/^NIGHT can only be paid publicly\. Anyone can read the recipient's address and the amount\.$/);
  });
});
