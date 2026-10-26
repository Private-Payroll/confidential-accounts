import { describe, it, expect } from 'vitest';
import type { Hex } from '../core/crypto.js';
import { oneOffSecretsOf, payRecordNonceOf, payeeBlindingOf } from './run-keys.js';

const SEED = '3c'.repeat(32) as Hex;

describe('A ONE-OFF PAYMENT\'S SECRETS COME FROM THE ONE SEED ITS RECORD SEALS', () => {
  it('ARE THE SAME EACH TIME FROM THE SAME SEED, AND DIFFERENT FROM EACH OTHER', () => {
    const made = oneOffSecretsOf(SEED);
    /* RED WHEN: another device, given the sealed seed, makes other secrets, so it rebuilds another leaf than the one raised. */
    expect(oneOffSecretsOf(SEED)).toEqual(made);
    /* RED WHEN: two of the secrets are derived under one name, so the nonce, the blinding or the salt's fresh half gives another away. */
    expect(new Set([made.nonce, made.blinding, made.fresh]).size).toBe(3);
    for (const v of [made.nonce, made.blinding, made.fresh]) expect(v).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('TWO ONE-OFFS NEVER SHARE A NONCE, SO A SECOND ONE TO THE SAME PAYEE, OF THE SAME AMOUNT, ON THE SAME DAY IS NOT REFUSED AS PAID', () => {
    /* RED WHEN: the nonce is made from anything but the seed, which is random for every one-off. */
    expect(oneOffSecretsOf('3d'.repeat(32) as Hex).nonce).not.toBe(oneOffSecretsOf(SEED).nonce);
  });

  it('IS NEVER A PAYROLL MONTH\'S NONCE OR A PAYROLL PAYEE\'S BLINDING, EVEN WITH THE SEED AS THE PAY-RECORD KEY', () => {
    const made = oneOffSecretsOf(SEED);
    const payroll = [
      payRecordNonceOf(SEED, { person: 'emp_1', month: '2026-10', kind: 'salary', occurrence: 0 }),
      payRecordNonceOf(SEED, { person: 'nonce', month: '2026-10', kind: 'one-off', occurrence: 0 }),
      payeeBlindingOf(SEED, 0),
    ];
    /* RED WHEN: a one-off's secrets are made with payroll's own derivations (payRecordNonceOf, payeeBlindingOf) from its seed, so a one-off could take a payroll month's once-mark. */
    for (const p of payroll) expect([made.nonce, made.blinding, made.fresh]).not.toContain(p);
  });

  it('REFUSES A SEED THAT IS NOT 32 BYTES', () => {
    /* RED WHEN: a short or upper-case seed is taken, so the same record could be read as two seeds. */
    expect(() => oneOffSecretsOf('ab' as Hex)).toThrow(/seed/u);
    expect(() => oneOffSecretsOf('3C'.repeat(32) as Hex)).toThrow(/seed/u);
  });
});
