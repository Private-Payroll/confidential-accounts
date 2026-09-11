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
 * test: the ledger's token type from the ledger itself, and the account's name
 * for NIGHT from the characters of the word.
 */

const NETWORK = 'undeployed' as const;
const LEDGER_NIGHT = (nativeToken() as unknown as { raw: string }).raw;

/** `NIGHT` as ASCII, zero padded to 32 bytes, computed without `assetIdBytes`. */
const NIGHT_AS_ASCII = Buffer.from('NIGHT', 'ascii').toString('hex').padEnd(64, '0');

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

  it('refuses private NIGHT by name and says what can be paid instead', () => {
    expect(() => ledgerTokenOf('NIGHT', 'shielded')).toThrow(/no private NIGHT/);
    expect(() => ledgerTokenOf('NIGHT', 'shielded')).toThrow(/public address/);
  });

  it('refuses every other asset in the registry, in both kinds, rather than inventing a token', () => {
    const others = assets.all().map((a) => a.code).filter((c) => c !== 'NIGHT');
    expect(others.length).toBeGreaterThan(0);
    for (const code of others) {
      for (const kind of ['shielded', 'unshielded'] as const) {
        let message = '';
        let value: string | undefined;
        try { value = ledgerTokenOf(code, kind); } catch (e) { message = String((e as Error).message); }
        expect(value, `${code} ${kind} must not be given a token`).toBeUndefined();
        expect(message).toContain(code);
        expect(message).toMatch(/NIGHT, paid to a public address/);
      }
    }
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
    expect(() => transferFacts(gbp)).toThrow(/GBP is not money any vault on Midnight can hold/);
  });

  it('the payee\'s own kind picks the token, so a record naming a private address gets none', () => {
    /*
     * `transferOf` refuses private NIGHT before this is reached. A record that
     * arrived some other way, with a private address on it, must still be
     * refused here rather than handed the public token.
     */
    const record = { ...publicNightTransfer(), payee: payeeFor(new Uint8Array(32).fill(0x44), NETWORK) };
    expect(() => transferFacts(record)).toThrow(/no private NIGHT/);
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
