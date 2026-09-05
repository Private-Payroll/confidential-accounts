/**
 * **THE REFUSALS OF THE DOOR THAT MOVES THE FIRST MONEY, DRIVEN WITHOUT A
 * CHAIN.**
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * `scripts/fund-vault.ts` spends real money on a real network, so almost none
 * of it can be tested here. **What can be, and what this file covers, is every
 * decision it takes BEFORE the wallet** — because those are the decisions that
 * are meant to stop a wrong run for nothing, and a refusal that has never been
 * reached is a refusal nobody has seen.
 *
 * Two of them carry money directly:
 *
 *   · **the unit.** The amount is a whole number in NIGHT's smallest unit and
 *     this door converts nothing. A door that quietly accepted `5.5` and did
 *     something with it would be applying this project's own belief about a
 *     currency's decimal places — which has never been measured against the
 *     chain — to somebody's money.
 *   · **the circuit set.** A vault deployed before the public path existed
 *     cannot hold public money, and its state does not decode against the
 *     compiled reader either. It is refused by name in a second rather than
 *     after a wallet, a dust wait and a proof server.
 *
 * ── AND THE IMPORT ITSELF IS PART OF THE TEST ────────────────────────────
 *
 * This file imports the script. **If the `RUN_DIRECTLY` guard at the bottom of
 * that file were ever removed, importing it here would go to the network and
 * submit a transaction**, and the suite would hang or spend money. That is the
 * same guard `measure-note-index.ts` carries, for the same reason.
 */
import { describe, it, expect } from 'vitest';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  amountFromText, assertVaultTakesPublicMoney, assertVaultIsMarriedToTheDeployedAccount,
  movementVerdict,
} from './fund-vault.js';
import { VAULT_CIRCUITS } from '../src/midnight/vault-contract.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';

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

describe('the amount, and the unit it is in', () => {
  it('takes a whole number of the smallest unit', () => {
    expect(amountFromText('5000')).toBe(5000n);
    expect(amountFromText('  5000  ')).toBe(5000n);
  });

  it('refuses a decimal point rather than converting it', () => {
    /*
     * THE POINT OF THIS TEST IS THE ABSENCE OF A CONVERSION. `src/core/assets.ts`
     * declares NIGHT with six decimal places and nothing has checked that
     * against the chain, so a door that read "5.5" as 5,500,000 would be acting
     * on an unmeasured belief.
     */
    expect(() => amountFromText('5.5')).toThrow(/smallest unit/i);
  });

  it('refuses separators, signs and exponents', () => {
    for (const bad of ['5,000', '-5', '1e3', '0x10', 'five']) {
      expect(() => amountFromText(bad)).toThrow();
    }
  });

  it('refuses nothing at all, and says there is no default', () => {
    expect(() => amountFromText('')).toThrow(/no default/i);
    expect(() => amountFromText('   ')).toThrow(/no default/i);
  });

  it('refuses zero, and says why the contract does too', () => {
    /* A zero deposit seats a colour that `retire` then blocks on: free to do,
     * needs no approval, and jams the vault's retirement. */
    expect(() => amountFromText('0')).toThrow(/deposit of nothing/i);
  });
});

describe('a vault that cannot hold public money', () => {
  it('accepts a vault whose record carries depositUnshielded', () => {
    expect(() => assertVaultTakesPublicMoney(entryWith([...VAULT_CIRCUITS]))).not.toThrow();
  });

  it('refuses the four-circuit vault by name, and says a client change will not fix it', () => {
    const e = entryWith(['deposit', 'payout', 'retire', 'splitNote']);
    expect(() => assertVaultTakesPublicMoney(e)).toThrow(/depositUnshielded/);
    expect(() => assertVaultTakesPublicMoney(e)).toThrow(/does not decode/);
  });

  it('refuses a record with no circuits at all rather than assuming the best', () => {
    expect(() => assertVaultTakesPublicMoney(entryWith([]))).toThrow(/none recorded/);
  });

  /*
   * **THE CHECK IS THE EARLY ONE AND NOT THE REAL ONE, AND THE TEST SAYS SO.**
   * What decides is the operations map read off the chain by
   * `findDeployedVaultContract`. This one reads a local file that can disagree
   * with the chain, which is why it is allowed to be cheap.
   */
  it('is a local record check: a record listing the circuits is not proof of a deployment', () => {
    const lying = entryWith([...VAULT_CIRCUITS]);
    expect(() => assertVaultTakesPublicMoney(lying)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * C266 — the vault's pinned account against the one deployed now
 * ------------------------------------------------------------------ */

/**
 * **THIS IS DRIVEN AGAINST THE REAL DEPLOYMENT RECORD ON DISK, DELIBERATELY.**
 *
 * `C266`'s whole subject is two files disagreeing, so a test that supplied both
 * sides from its own fixture would be testing a comparison it had already made
 * itself. The record is read here exactly as the guard reads it, and the
 * matching case is built FROM it.
 *
 * If there is no record, the guard's other branch is the one under test, and it
 * is the branch that matters more: a vault whose account is not deployed is one
 * nothing can be paid out of.
 */
const RECORD = join(process.cwd(), '.midnight', 'stagenet-contract.json');

describe('a vault married to an account that is not the deployed one', () => {
  const deployed: string | null = existsSync(RECORD)
    ? String(JSON.parse(readFileSync(RECORD, 'utf8'))?.contractAddress ?? '')
    : null;

  it('refuses a vault pinned to some other account, and prints neither address', () => {
    const e = entryWith([...VAULT_CIRCUITS]);
    (e as any).accountAddress = 'ff'.repeat(32);
    if (deployed === 'ff'.repeat(32)) return; /* cannot happen; guards the fixture */
    let message = '';
    try { assertVaultIsMarriedToTheDeployedAccount(e); } catch (err: any) { message = String(err?.message); }
    expect(message).toMatch(/unable to pay any of it out|no account is deployed/i);
    expect(message).not.toContain('ff'.repeat(32));
    if (deployed) expect(message).not.toContain(deployed);
  });

  it('accepts a vault pinned to the account the record names', () => {
    const e = entryWith([...VAULT_CIRCUITS]);
    if (deployed === null) {
      /* No account deployed: the OTHER branch is what is true, and it must fire. */
      expect(() => assertVaultIsMarriedToTheDeployedAccount(e)).toThrow(/no account is deployed/i);
      return;
    }
    (e as any).accountAddress = deployed;
    expect(() => assertVaultIsMarriedToTheDeployedAccount(e)).not.toThrow();
  });

  it('compares case-insensitively, because a record is not a canonical spelling', () => {
    if (deployed === null) return;
    const e = entryWith([...VAULT_CIRCUITS]);
    (e as any).accountAddress = deployed.toUpperCase();
    expect(() => assertVaultIsMarriedToTheDeployedAccount(e)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * V-172 — what two readings of the balance say
 * ------------------------------------------------------------------ */

/**
 * **THE VERDICT IS TESTED HERE BECAUSE IT REACHES THE EXIT CODE**, and the exit
 * code is what stops the door printing "holds public money" over a check that
 * did not confirm it. `C113` is the row about a summary line written to be
 * reassuring rather than derived from what happened.
 */
describe('did the balance move by what was deposited', () => {
  it('says it moved when it moved by exactly the deposit', () => {
    expect(movementVerdict(0n, 1_000_000n, 1_000_000n)).toBe('moved-by-the-deposit');
    expect(movementVerdict(7n, 1_000_007n, 1_000_000n)).toBe('moved-by-the-deposit');
  });

  it('says it did not move when it did not, in either direction', () => {
    expect(movementVerdict(0n, 0n, 1_000_000n)).toBe('did-not-move');
    expect(movementVerdict(0n, 999_999n, 1_000_000n)).toBe('did-not-move');
    expect(movementVerdict(0n, 2_000_000n, 1_000_000n)).toBe('did-not-move');
  });

  /*
   * NO BASELINE IS ITS OWN ANSWER AND NEVER COLLAPSES INTO "did not move".
   * A run that could not read the balance before the deposit knows nothing
   * about the movement, and answering the stronger claim is `C110`.
   */
  it('says it has no baseline rather than guessing, when the first read failed', () => {
    expect(movementVerdict(null, 1_000_000n, 1_000_000n)).toBe('no-baseline');
    expect(movementVerdict(null, 0n, 1_000_000n)).toBe('no-baseline');
  });
});
