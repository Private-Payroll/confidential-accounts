/**
 * **THE CEILING ON WHAT ONE TRANSACTION MAY SPEND FROM OUR DUST, AS PURE
 * RULES.** The class that applies them has its own cases; these hold the
 * reading of the setting, the reading of a transaction and the two sentences.
 */
import { describe, it, expect } from 'vitest';
import {
  FEE_CEILING_SETTING, feeCeilingFrom, dustSpentBy, refusalForExpected, refusalForCommitted,
} from './fee-ceiling.js';

const spend = (vFee: unknown) => ({ vFee });
const intent = (...spends: unknown[]) => ({ dustActions: { spends } });

describe('the ceiling is read from the settings and never defaulted', () => {
  /* RED WHEN: an unset setting yields a ceiling instead of a refusal. */
  it('refuses when it is not set, naming the setting', () => {
    expect(() => feeCeilingFrom({})).toThrow(new RegExp(`${FEE_CEILING_SETTING} is not set`));
    expect(() => feeCeilingFrom({ [FEE_CEILING_SETTING]: '   ' })).toThrow(/is not set/);
  });

  /* RED WHEN: the digits-only rule is loosened, so a unit, a sign or a decimal gets through. */
  it('refuses anything that is not a whole number above zero', () => {
    for (const bad of ['0', '-5', '1.5', '1e18', '12 SPECKs', '0x10', 'abc']) {
      expect(() => feeCeilingFrom({ [FEE_CEILING_SETTING]: bad }), bad)
        .toThrow(/not a whole number of SPECKs above zero/);
    }
  });

  /* RED WHEN: the value is parsed as a Number, which loses precision past 2^53. */
  it('reads a large whole number exactly', () => {
    expect(feeCeilingFrom({ [FEE_CEILING_SETTING]: ' 20000000000000001 ' }))
      .toEqual({ perTransaction: 20_000_000_000_000_001n });
  });
});

describe('what a transaction declares it will spend from DUST', () => {
  /* RED WHEN: only the first intent, or only the first spend, is counted. */
  it('sums every spend in every intent', () => {
    const tx = { intents: new Map<number, unknown>([[1, intent(spend(3n), spend(4n))], [2, intent(spend(10n))]]) };
    expect(dustSpentBy(tx)).toBe(17n);
  });

  /* RED WHEN: an intent with no DUST actions answers `null` instead of being skipped. */
  it('skips an intent that spends no DUST', () => {
    const tx = { intents: new Map<number, unknown>([[1, { dustActions: undefined }], [2, intent(spend(6n))]]) };
    expect(dustSpentBy(tx)).toBe(6n);
  });

  /* RED WHEN: a shape the ledger does not publish is read as zero. */
  it('answers null for anything it cannot read, never zero', () => {
    /* And it answers rather than throws: a throw here would be a fault, not a refusal. */
    for (const odd of [{ intents: new Map([[1, intent(spend(5))]]) }, { intents: new Map([[1, intent(spend('5'))]]) }]) {
      expect(() => dustSpentBy(odd)).not.toThrow();
    }
    expect(dustSpentBy(undefined)).toBeNull();
    expect(dustSpentBy({})).toBeNull();
    expect(dustSpentBy({ intents: [intent(spend(1n))] })).toBeNull();
    expect(dustSpentBy({ intents: new Map([[1, { dustActions: { spends: 'x' } }]]) })).toBeNull();
    expect(dustSpentBy({ intents: new Map([[1, intent(spend(5))]]) })).toBeNull();
    expect(dustSpentBy({ intents: new Map([[1, intent(spend(-1n))]]) })).toBeNull();
    expect(dustSpentBy({ intents: new Map([[1, null]]) })).toBeNull();
  });

  /*
   * **AGAINST THE LEDGER ITSELF, NOT A DOUBLE.** A transaction the ledger
   * builds has its intents as a map and a fresh intent carries no DUST actions,
   * so it declares nothing spent.
   *
   * RED WHEN: the reader stops recognising the ledger's own map, which answers
   * `null` here and would refuse every real payment.
   */
  it('reads a transaction the ledger built', async () => {
    const l: any = await import('@midnightntwrk/ledger-v9');
    const tx = l.Transaction.fromParts('undeployed', undefined, undefined, l.Intent.new(new Date(Date.now() + 60_000)));
    expect(dustSpentBy(tx)).toBe(0n);
  });
});

describe('the two refusals', () => {
  const ceiling = { perTransaction: 100n };

  /* RED WHEN: an unread estimate becomes a refusal, which would stop payments whenever an instrument failed. */
  it('an estimate that was not read is not a refusal', () => {
    expect(refusalForExpected(null, ceiling)).toBeNull();
    expect(refusalForExpected(100n, ceiling)).toBeNull();
  });

  /* RED WHEN: the comparison is dropped or reversed. */
  it('an estimate over the ceiling is, and it names both numbers and the setting', () => {
    const r = refusalForExpected(101n, ceiling);
    expect(r).toMatch(/expected to cost 101 SPECKs/);
    expect(r).toMatch(/is 100\b/);
    expect(r).toContain(FEE_CEILING_SETTING);
    expect(r).toMatch(/Nothing was booked and nothing was sent/);
  });

  /* RED WHEN: an unread amount on the balanced transaction is let through. */
  it('an amount that cannot be read off the balanced transaction is a refusal', () => {
    expect(refusalForCommitted(null, ceiling)).toMatch(/could not be read off it/);
  });

  /* RED WHEN: the comparison is dropped, reversed or made strict. */
  it('an amount over the ceiling is a refusal, and one at it is not', () => {
    expect(refusalForCommitted(100n, ceiling)).toBeNull();
    const r = refusalForCommitted(101n, ceiling);
    expect(r).toMatch(/would spend 101 SPECKs/);
    expect(r).toContain(FEE_CEILING_SETTING);
    expect(r).toMatch(/Nothing was sent, and what was booked for it was released/);
  });
});
