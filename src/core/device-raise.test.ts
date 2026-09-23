import { describe, it, expect } from 'vitest';
import {
  DEVICE_RAISE_VERSION, DIGEST_SHAPE, RAISE_IS_NOT_WHAT_WAS_CHECKED, RAISE_NAMES_NOTHING_CHECKED,
  SEND_IS_NOT_WHAT_WAS_CHECKED, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED, paymentsCheckedDigest, reloadThePage, type PaymentChecked,
} from './device-raise.js';
import { redactSecrets } from './redact-secrets.js';

/**
 * **THE DIGEST A DEVICE SENDS OF WHAT IT CHECKED, AND THE SERVICE COMPUTES OF
 * WHAT IT RAISES OR SENDS.** Both sides call this one function, so what these
 * tests pin is that it tells apart every change a run could make to its
 * payments, and treats one amount written two ways as one amount.
 */
const A = 'ab'.repeat(32);
const Z = '0'.repeat(64);
const TWO: PaymentChecked[] = [{ kind: 'shielded', token: A, amount: '100' }, { kind: 'unshielded', token: Z, amount: 5n }];

describe('THE DIGEST OF THE PAYMENTS CHECKED', () => {
  it('is the sha-256 of a fixed domain and the rows, derived independently of this module', () => {
    /*
     * Computed outside this code: python3 hashlib.sha256 over
     * 'device-raise/payments-checked/1\n' + json.dumps(rows, separators=(',', ':')).
     * RED WHEN: the domain, the field order, the separator or the hash changes - a page and a
     * service built at different times would then disagree about every run.
     */
    expect(paymentsCheckedDigest(TWO)).toBe('9eeae1ead1cc13449294e1e231e19c7f78ce3117dc646eb84fca08584d44da27');
    expect(paymentsCheckedDigest(TWO)).toMatch(DIGEST_SHAPE);
  });

  it('changes with every field of every payment, with the order and with the count', () => {
    const base = paymentsCheckedDigest(TWO);
    for (const [why, other] of [
      ['a kind', [{ kind: 'unshielded', token: A, amount: '100' }, TWO[1]!]],
      ['a token', [{ kind: 'shielded', token: 'cd'.repeat(32), amount: '100' }, TWO[1]!]],
      ['an amount', [{ kind: 'shielded', token: A, amount: '101' }, TWO[1]!]],
      ['the order', [TWO[1]!, TWO[0]!]],
      ['one fewer', [TWO[0]!]],
      ['one more', [...TWO, TWO[1]!]],
      ['none', []],
    ] as const) {
      /* RED WHEN: a field, the order or the count is left out of the digest - that change then goes through unnoticed. */
      expect(paymentsCheckedDigest(other as readonly PaymentChecked[]), why).not.toBe(base);
    }
  });

  it('reads one amount written as a string or a bigint, with or without leading zeroes, and one token in either case, as the same', () => {
    const base = paymentsCheckedDigest(TWO);
    /* RED WHEN: a string and a bigint of one amount digest apart - the page sends strings and the service holds bigints. */
    expect(paymentsCheckedDigest([{ kind: 'shielded', token: A, amount: 100n }, { kind: 'unshielded', token: Z, amount: '5' }])).toBe(base);
    expect(paymentsCheckedDigest([{ kind: 'shielded', token: A.toUpperCase(), amount: '0100' }, { kind: 'unshielded', token: Z, amount: '005' }])).toBe(base);
  });

  it('refuses an amount that is not a whole number rather than digesting it', () => {
    for (const amount of ['1e4', '-5', '1.5', '', ' 5', -5n]) {
      /* RED WHEN: a malformed amount is digested - two different readings of it could then agree. */
      expect(() => paymentsCheckedDigest([{ kind: 'shielded', token: A, amount }]), String(amount)).toThrow(/not a whole number/u);
    }
  });
});

describe('THE SENTENCE A PAGE OF ANOTHER VERSION IS REFUSED WITH', () => {
  it('says what the page named, what is accepted, to reload, and what did not happen', () => {
    /* RED WHEN: the refusal stops saying how to resolve it. */
    expect(reloadThePage(undefined, 'Nothing was sent.')).toMatch(
      new RegExp(`names no version .* accepts version ${DEVICE_RAISE_VERSION}.*Reload the page and try again\\. Nothing was sent\\.$`, 'su'));
    expect(reloadThePage(0, 'Nothing was written down.')).toMatch(/names version 0 .*Nothing was written down\.$/su);
    /* RED WHEN: whatever a caller names is written into the sentence whole, however long. */
    expect(reloadThePage('x'.repeat(10_000), 'Nothing was sent.').length).toBeLessThan(400);
    expect(reloadThePage('1', 'Nothing was sent.')).toMatch(/names version "1" /u);
  });
});

describe('EVERY REFUSAL HERE REACHES THE REFUSAL LOG AS WRITTEN', () => {
  it('none is taken for a recovery phrase and hidden', () => {
    for (const sentence of [
      RAISE_NAMES_NOTHING_CHECKED, RAISE_IS_NOT_WHAT_WAS_CHECKED, SEND_IS_NOT_WHAT_WAS_CHECKED, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED,
      reloadThePage(undefined, 'Nothing was written down.'), reloadThePage(0, 'Nothing was sent.'),
    ]) {
      /* RED WHEN: a sentence runs twelve short words together - the log then shows a redaction where the reason should be. */
      expect(redactSecrets(sentence), sentence).toBe(sentence);
    }
  });
});
