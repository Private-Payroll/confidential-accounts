/**
 * **THE WALK FROM A COMPANY'S OWN RECORDS**, against a history this file writes
 * by hand. The commitment here is a label, not the ledger's: what is under test
 * is which candidates the walk puts to the history and what it keeps. The walk
 * against the real contract, and a spend of what it names, is
 * `contracts/test/a-vault-rebuilt-with-us-gone.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { walkCompanyRecords, DEPOSIT_VERSION_GAP, type CompanyRecords } from './rebuild-from-records.js';
import { depositNonceAt, depositNonceKeyFor } from './deposit-nonce.js';
import { changeNoteOf, sentNonceOf, nameTheRecord } from './vault-recovery.js';
import { toHex, fromHex, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';

const VAULT = 'ab'.repeat(32) as Hex;
const GBP = 'aa'.repeat(32) as Hex;
const EUR = 'ee'.repeat(32) as Hex;
const KEY = depositNonceKeyFor(new Uint8Array(32).fill(3), VAULT);
const OTHER_KEY = depositNonceKeyFor(new Uint8Array(32).fill(4), VAULT);
const label = (c: VaultCoin, vault: Hex = VAULT) => `${vault}|${c.nonce}|${c.token}|${c.value}`;
const dep = (key: typeof KEY, value: bigint, version: number, token: Hex = GBP): VaultCoin =>
  ({ nonce: depositNonceAt(key, { token, value }, version), token, value });
const piece = (c: VaultCoin, amount: bigint): VaultCoin =>
  ({ nonce: toHex(sentNonceOf(fromHex(c.nonce))), token: c.token, value: amount });

const walk = (made: VaultCoin[], records: CompanyRecords, keys = [KEY], gap?: number) =>
  walkCompanyRecords({
    vault: VAULT, keys, records, everCreated: new Set(made.map((c) => label(c))), commitmentOf: label,
    ...(gap === undefined ? {} : { gap }),
  });

describe('walking a company\'s records against everything the chain made for the vault', () => {
  it('names deposits, the change each payment left and the pieces a split made, through notes long since spent', async () => {
    const d1 = dep(KEY, 1_000n, 1);
    const c1 = changeNoteOf(d1, 250n)!;          // 750
    const c2 = changeNoteOf(c1, 700n)!;          // 50, reachable only through two spent notes
    const p = piece(c2, 20n);                    // a split of 20 out of the 50
    const c3 = changeNoteOf(c2, 20n)!;           // its remainder, 30
    const w = await walk([d1, c1, c2, p, c3], {
      deposited: [{ token: GBP, value: 1_000n }],
      paid: [{ token: GBP, amount: 250n }, { token: GBP, amount: 700n }, { token: GBP, amount: 20n }],
    });
    expect(w.coins, 'RED WHEN: a note is only found when the vault still holds its parent').toEqual([d1, c1, c2, c3, p]);
    expect(w.found).toEqual({ deposits: 1, changes: 3, pieces: 1 });
  });

  it('WALKS PAST ABANDONED VERSIONS up to the gap, and stops after it', async () => {
    const at5 = dep(KEY, 100n, 5);
    const at30 = dep(KEY, 100n, 30);
    const w = await walk([at5, at30], { deposited: [{ token: GBP, value: 100n }], paid: [] }, [KEY], 20);
    expect(w.coins, 'RED WHEN: a deposit after four abandoned attempts is not named').toEqual([at5]);
    expect(w.versions, 'RED WHEN: the walk stops before the gap, or runs past it').toEqual([{ walked: 25, lastFound: 5 }]);
    const wide = await walk([at5, at30], { deposited: [{ token: GBP, value: 100n }], paid: [] }, [KEY], 25);
    expect(wide.coins, 'RED WHEN: a wider gap is not honoured').toEqual([at5, at30]);
    expect(DEPOSIT_VERSION_GAP).toBe(20);
  });

  it('tries every recorded amount at every version, so a version handed out twice names both coins', async () => {
    const a = dep(KEY, 100n, 2);
    const b = dep(KEY, 300n, 2);
    const w = await walk([a, b], { deposited: [{ token: GBP, value: 100n }, { token: GBP, value: 300n }], paid: [] });
    expect(w.coins).toEqual([a, b]);
  });

  it('COUNTS THE GAP OVER VERSIONS THE WHOLE VAULT SHARES: a deposit after another person\'s long run of deposits is still found', async () => {
    /* Another person deposits at versions 1-25, fifteen attempts are abandoned, and then this person deposits. */
    const theirs = Array.from({ length: 25 }, (_, i) => dep(OTHER_KEY, 100n, i + 1));
    const mine = dep(KEY, 700n, 41);
    const w = await walk([...theirs, mine], {
      deposited: [{ token: GBP, value: 100n }, { token: GBP, value: 700n }], paid: [],
    }, [KEY, OTHER_KEY]);
    expect(
      w.coins.some((c) => c.nonce === mine.nonce && c.value === 700n),
      'RED WHEN: the gap is counted per person, so one depositor\'s run of versions reads as a gap for everybody else and a later deposit is never tried',
    ).toBe(true);
    expect(w.found.deposits).toBe(26);
    expect(w.versions).toEqual([{ walked: 61, lastFound: 41 }]);
  });

  it('WALKS AT LEAST AS FAR AS THE VAULT HAS OUTPUTS: versions no given key can name (old random lines, a person who left) do not end the walk early', async () => {
    const unnameable = Array.from({ length: 25 }, (_, i) => dep(OTHER_KEY, 100n, i + 1));
    const mine = dep(KEY, 700n, 26);
    const w = await walk([...unnameable, mine], { deposited: [{ token: GBP, value: 700n }], paid: [] }, [KEY]);
    expect(
      w.coins,
      'RED WHEN: a run of versions longer than the gap that no given key can name ends the walk before a later deposit',
    ).toEqual([mine]);
    expect(w.versions).toEqual([{ walked: 46, lastFound: 26 }]);
  });

  it('walks every key it is given, one per person who deposited, and names nothing for a key nobody used', async () => {
    const mine = dep(KEY, 100n, 1);
    const theirs = dep(OTHER_KEY, 100n, 1);
    const both = await walk([mine, theirs], { deposited: [{ token: GBP, value: 100n }], paid: [] }, [KEY, OTHER_KEY]);
    expect(both.coins).toEqual([mine, theirs]);
    const one = await walk([theirs], { deposited: [{ token: GBP, value: 100n }], paid: [] }, [KEY]);
    expect(one.coins, 'RED WHEN: a deposit is named without the key it was derived from').toEqual([]);
  });

  it('keeps tokens apart: an amount paid in one token is never tried against a note of another', async () => {
    const g = dep(KEY, 1_000n, 1, GBP);
    const e = dep(KEY, 1_000n, 2, EUR);
    const eChange = changeNoteOf(e, 400n)!;
    const w = await walk([g, e, eChange], {
      deposited: [{ token: GBP, value: 1_000n }, { token: EUR, value: 1_000n }],
      paid: [{ token: EUR, amount: 400n }],
    });
    expect(w.coins).toEqual([g, e, eChange]);
    expect(w.checks, 'RED WHEN: a payment in one token is tried against the other token\'s notes').toBe(20 * 2 + 2 * 2 + 2 * 2);
  });

  it('an amount the records hold rounded, or not at all, names nothing -- and the walk says what it tried', async () => {
    const d = dep(KEY, 1_234n, 1);
    const w = await walk([d], { deposited: [{ token: GBP, value: 1_230n }], paid: [] });
    expect(w.coins).toEqual([]);
    expect(w.versions).toEqual([{ walked: 20, lastFound: 0 }]);
    expect(w.checks).toBe(20);
  });

  it('does not try an amount at least as large as the note: an exact spend leaves no change and a split must leave some', async () => {
    const d = dep(KEY, 100n, 1);
    const w = await walk([d], { deposited: [{ token: GBP, value: 100n }], paid: [{ token: GBP, amount: 100n }, { token: GBP, amount: 150n }] });
    expect(w.checks, 'RED WHEN: amounts that cannot have left change are tried').toBe(21);
  });

  it('tries a recorded amount ONCE however many times the books repeat it', async () => {
    const d = dep(KEY, 100n, 1);
    const once = await walk([d], { deposited: [{ token: GBP, value: 100n }], paid: [{ token: GBP, amount: 40n }] });
    const thrice = await walk([d], {
      deposited: [{ token: GBP, value: 100n }, { token: GBP, value: 100n }, { token: GBP, value: 100n }],
      paid: [{ token: GBP, amount: 40n }, { token: GBP, amount: 40n }],
    });
    expect(thrice.checks, 'RED WHEN: a monthly deposit of one amount multiplies the walk by the months').toBe(once.checks);
    expect(once.checks).toBe(21 + 2);
  });

  it('REFUSES a record of nothing, and a gap of nothing', async () => {
    await expect(walk([], { deposited: [{ token: GBP, value: 0n }], paid: [] })).rejects.toThrow(/deposit of nothing/);
    await expect(walk([], { deposited: [], paid: [{ token: GBP, amount: 0n }] })).rejects.toThrow(/payment of nothing/);
    await expect(walk([], { deposited: [], paid: [] }, [KEY], 0)).rejects.toThrow(/gap of at least one/);
    await expect(walk([], { deposited: [{ token: GBP.toUpperCase() as Hex, value: 1n }], paid: [] }),
      'RED WHEN: a second spelling of a token is carried into a coin').rejects.toThrow(/64 lower-case hex/);
    await expect(walk([], { deposited: [], paid: [{ token: `0x${GBP}` as Hex, amount: 1n }] })).rejects.toThrow(/64 lower-case hex/);
  });

  it('a coin found this way is named as the company\'s own records', () => {
    expect(nameTheRecord({ kind: 'company records' }), 'RED WHEN: a coin named from the books is called a journal line or a version').toBe('the company\'s own records');
  });

  it('reads the history by the ledger\'s commitment in any spelling', async () => {
    const d = dep(KEY, 100n, 1);
    const w = await walkCompanyRecords({
      vault: VAULT, keys: [KEY], records: { deposited: [{ token: GBP, value: 100n }], paid: [] },
      everCreated: new Set([label(d).toLowerCase()]), commitmentOf: (c) => `0x${label(c).toUpperCase()}`,
    });
    expect(w.coins).toEqual([d]);
  });
});
