/**
 * **THE CHECKS THE PAYOUT DOOR MAKES BEFORE IT REACHES A CHAIN, AND THE ONE
 * THAT STOPS IT.**
 *
 * ── WHAT IS ACTUALLY UNDER TEST ──────────────────────────────────────────
 *
 * `scripts/transfer-from-vault.ts` reaches no network at all today, so almost
 * all of it is testable here — which is the opposite of `fund-vault.ts` and is
 * worth saying, because it is why this file is longer than that one's.
 *
 * Three of these carry money or privacy directly:
 *
 *   · **a private address is refused by name.** This door pays out of a
 *     vault's PUBLIC balance through `payoutUnshielded`. A shielded address is
 *     a different circuit and a different key space, and there is no private
 *     money in this project to pay with (`V-94`).
 *   · **the colour comparison.** `V-168`: the colour a deposit puts in and the
 *     colour a payout leaf carries are different values, so the vault would
 *     refuse the payment after it had been proposed, approved twice and paid
 *     for. **The test asserts the values disagree TODAY and would pass either
 *     way tomorrow** — see its own comment, because a test that pins a defect
 *     in place is worse than none.
 *   · **the unit.** Nothing converts, for `V-169`'s reason.
 *
 * ── AND THE IMPORT ITSELF IS PART OF THE TEST ────────────────────────────
 *
 * If the `RUN_DIRECTLY` guard at the bottom of that file were removed,
 * importing it here would run the whole instrument inside the suite.
 */
import { describe, it, expect } from 'vitest';

import {
  transferAmountFromText, publicPayeeFromText,
  assertVaultCanPayPublicly, assertVaultIsMarriedToTheDeployedAccount,
  assertColoursAgree,
} from './transfer-from-vault.js';
import {
  payeeAddressFromKeys, unshieldedPayeeAddressFromKeys,
} from '../src/midnight/payee-address.js';
import { VAULT_CIRCUITS } from '../src/midnight/vault-contract.js';
import { assetIdBytes } from '../src/core/assets.js';
import { toHex } from '../src/core/crypto.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';

const NETWORK = 'stagenet' as never;

const PUBLIC_ADDRESS = unshieldedPayeeAddressFromKeys({ userAddress: 'ab'.repeat(32) }, NETWORK);
const PRIVATE_ADDRESS = payeeAddressFromKeys(
  { coinPublicKey: 'cd'.repeat(32), encryptionPublicKey: 'ef'.repeat(32) }, NETWORK);

const entryWith = (circuits: string[]): VaultEntry => ({
  name: 'payroll-test',
  contractAddress: 'ab'.repeat(32),
  accountAddress: 'cd'.repeat(32),
  deployedAt: '2026-08-29T00:00:00.000Z',
  circuits,
  maintenanceAuthority: { kind: 'single-key', committeeSize: 1, threshold: 1 },
  adopted: false,
  deployTx: null,
} as unknown as VaultEntry);

describe('who can be paid through this door', () => {
  it('takes a public address', () => {
    expect(publicPayeeFromText(PUBLIC_ADDRESS.bech32).kind).toBe('unshielded');
  });

  it('refuses a private address by name, and says why rather than "invalid"', () => {
    let message = '';
    try { publicPayeeFromText(PRIVATE_ADDRESS.bech32); } catch (e: any) { message = String(e?.message); }
    expect(message).toMatch(/private address/i);
    expect(message).toMatch(/public balance/i);
    expect(message).toMatch(/mn_addr_/);
  });

  it('refuses something that is not an address at all, naming both prefixes', () => {
    expect(() => publicPayeeFromText('not-an-address')).toThrow(/mn_shield-addr_|mn_addr_/);
  });

  it('refuses an empty address rather than treating it as none given', () => {
    expect(() => publicPayeeFromText('')).toThrow();
  });
});

describe('the amount, and the unit it is in', () => {
  it('takes a whole number of the smallest unit', () => {
    expect(transferAmountFromText('250000')).toBe(250_000n);
  });

  it('refuses a decimal point rather than converting it', () => {
    expect(() => transferAmountFromText('2.5')).toThrow(/smallest unit/i);
  });

  it('refuses zero, a sign, separators and nothing at all', () => {
    for (const bad of ['0', '-1', '2,500', '', '   ']) {
      expect(() => transferAmountFromText(bad)).toThrow();
    }
  });
});

describe('a vault that cannot make a public payment', () => {
  it('accepts a vault whose record carries payoutUnshielded', () => {
    expect(() => assertVaultCanPayPublicly(entryWith([...VAULT_CIRCUITS]))).not.toThrow();
  });

  it('refuses the four-circuit vault, and says its state does not decode either', () => {
    const e = entryWith(['deposit', 'payout', 'retire', 'splitNote']);
    expect(() => assertVaultCanPayPublicly(e)).toThrow(/payoutUnshielded/);
    expect(() => assertVaultCanPayPublicly(e)).toThrow(/does not decode/);
  });

  it('refuses a vault married to another account, printing neither address — C266', () => {
    const e = entryWith([...VAULT_CIRCUITS]);
    (e as any).accountAddress = 'ff'.repeat(32);
    let message = '';
    try { assertVaultIsMarriedToTheDeployedAccount(e); } catch (err: any) { message = String(err?.message); }
    expect(message).toMatch(/no longer uses|no account is deployed/i);
    expect(message).not.toContain('ff'.repeat(32));
  });
});

describe('V-168 — the colour a payment moves against the colour a vault holds', () => {
  /*
   * **THE DOOR'S OWN COMPARISON IS DRIVEN HERE, NOT RE-IMPLEMENTED.** An
   * earlier version of this file recomputed both values and asserted they were
   * 64 hex characters, which is a second implementation of the comparison
   * (`M-104`) and tests nothing about the door.
   *
   * **AND IT DOES NOT PIN THE DEFECT IN PLACE.** Nothing here asserts that
   * NIGHT's two spellings differ, because that assertion would go red on the
   * day somebody fixes `V-168`, and a red test is how a correct fix gets
   * reverted. The measurement lives in `V-168` in `BACKLOG.md`, where a number
   * belongs.
   */
  it('passes two colours that agree', () => {
    expect(() => assertColoursAgree('00'.repeat(32), '00'.repeat(32))).not.toThrow();
  });

  it('is case-insensitive, because a hex string is not a canonical spelling', () => {
    expect(() => assertColoursAgree('AB'.repeat(32), 'ab'.repeat(32))).not.toThrow();
  });

  it('refuses two that disagree, and says the money is not at risk', () => {
    let message = '';
    try {
      assertColoursAgree(toHex(assetIdBytes('NIGHT')), '00'.repeat(32));
    } catch (e: any) { message = String(e?.message); }
    expect(message).toMatch(/REFUSED BY THE VAULT/);
    expect(message).toMatch(/NOTHING IS AT RISK AND NOTHING IS LOST/);
    expect(message).toMatch(/V-168/);
    /* It must say WHY it refuses early, or the next reader deletes the check. */
    expect(message).toMatch(/before a fee/i);
  });
});
