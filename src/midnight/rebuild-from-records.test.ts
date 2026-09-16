/**
 * **THE WALK FROM A COMPANY'S OWN RECORDS**, against a history this file writes
 * by hand. The commitment here is a label, not the ledger's: what is under test
 * is which candidates the walk puts to the history and what it keeps. The walk
 * against the real contract, and a spend of what it names, is
 * `contracts/test/a-vault-rebuilt-with-us-gone.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { walkCompanyRecords, compiledOutputCommitment, type CompanyRecords } from './rebuild-from-records.js';
import { depositNonceAt, depositNonceKeyFor, DEPOSIT_SLOT_ATTEMPTS } from './deposit-nonce.js';
import { changeNoteOf, sentNonceOf, nameTheRecord } from './vault-recovery.js';
import { vaultNoteCommitment } from './note-index.js';
import { toHex, fromHex, randomBytes, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';

const VAULT = 'ab'.repeat(32) as Hex;
const GBP = 'aa'.repeat(32) as Hex;
const EUR = 'ee'.repeat(32) as Hex;
const KEY = depositNonceKeyFor(new Uint8Array(32).fill(3), VAULT);
const OTHER_KEY = depositNonceKeyFor(new Uint8Array(32).fill(4), VAULT);
const label = (c: VaultCoin, vault: Hex = VAULT) => `${vault}|${c.nonce}|${c.token}|${c.value}`;
const dep = (key: typeof KEY, value: bigint, slot: number, token: Hex = GBP): VaultCoin =>
  ({ nonce: depositNonceAt(key, { token, value }, slot), token, value });
const piece = (c: VaultCoin, amount: bigint): VaultCoin =>
  ({ nonce: toHex(sentNonceOf(fromHex(c.nonce))), token: c.token, value: amount });
/** An output the vault holds that no record here can name: another depositor's, or one made at random. */
const stranger = (i: number): VaultCoin => ({ nonce: toHex(new Uint8Array(32).fill(i + 1)), token: GBP, value: 1n });

const walk = (made: VaultCoin[], records: CompanyRecords, keys = [KEY]) =>
  walkCompanyRecords({
    vault: VAULT, keys, records, everCreated: new Set(made.map((c) => label(c))), commitmentOf: label,
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

  it('WALKS EXACTLY AS FAR AS THE VAULT LETS A DEPOSIT GO: its output count plus the attempts, whatever was abandoned', async () => {
    /*
     * Four outputs already, then a deposit whose first two slots named coins that
     * already existed: it landed at the last slot a deposit may use. Any number
     * of attempts abandoned in between used no slot, because the count did not move.
     */
    const earlier = [0, 1, 2, 3].map(stranger);
    const last = dep(KEY, 100n, 4 + DEPOSIT_SLOT_ATTEMPTS);
    const w = await walk([...earlier, last], { deposited: [{ token: GBP, value: 100n }], paid: [] });
    expect(w.coins, 'RED WHEN: a deposit at the last slot it may use is not named').toEqual([last]);
    expect(w.slots, 'RED WHEN: the walk is bounded by anything but the vault\'s outputs and the attempts')
      .toEqual({ walked: 5 + DEPOSIT_SLOT_ATTEMPTS, lastFound: 7 });
    const none = await walk([], { deposited: [{ token: GBP, value: 100n }], paid: [] });
    expect(none.slots, 'RED WHEN: an empty vault is walked past the slots its first deposit could use').toEqual({ walked: DEPOSIT_SLOT_ATTEMPTS, lastFound: 0 });
    expect(none.checks).toBe(DEPOSIT_SLOT_ATTEMPTS);
  });

  it('A LONG RUN OF OUTPUTS NOBODY HERE CAN NAME DOES NOT END THE WALK, however long it is', async () => {
    const unnameable = Array.from({ length: 60 }, (_, i) => stranger(i));
    const mine = dep(KEY, 700n, 61);
    const w = await walk([...unnameable, mine], { deposited: [{ token: GBP, value: 700n }], paid: [] });
    expect(w.coins, 'RED WHEN: a run of versions that no key names ends the walk before a later deposit').toEqual([mine]);
    expect(w.slots).toEqual({ walked: 61 + DEPOSIT_SLOT_ATTEMPTS, lastFound: 61 });
  });

  it('a change counts as an output, so the deposit after a payment is at the slot after it', async () => {
    const d1 = dep(KEY, 1_000n, 1);
    const c1 = changeNoteOf(d1, 400n)!;
    const d2 = dep(KEY, 1_000n, 3);
    const w = await walk([d1, c1, d2], {
      deposited: [{ token: GBP, value: 1_000n }], paid: [{ token: GBP, amount: 400n }],
    });
    expect(w.coins, 'RED WHEN: a deposit made after a payment is not named').toEqual([d1, d2, c1]);
  });

  it('tries every recorded amount at every slot, so two amounts at one slot both name their coins', async () => {
    const a = dep(KEY, 100n, 1);
    const b = dep(KEY, 300n, 1);
    const w = await walk([a, b], { deposited: [{ token: GBP, value: 100n }, { token: GBP, value: 300n }], paid: [] });
    expect(w.coins).toEqual([a, b]);
  });

  it('WALKS EVERY EPOCH AT EVERY SLOT: a deposit made under a secret since rotated is still named', async () => {
    const old = dep(OTHER_KEY, 100n, 1);
    const now = dep(KEY, 100n, 2);
    const w = await walk([old, now], { deposited: [{ token: GBP, value: 100n }], paid: [] }, [OTHER_KEY, KEY]);
    expect(w.coins, 'RED WHEN: only the newest epoch is walked, so money deposited before a signer left loses its name').toEqual([old, now]);
    const onlyNew = await walk([old, now], { deposited: [{ token: GBP, value: 100n }], paid: [] }, [KEY]);
    expect(onlyNew.coins).toEqual([now]);
  });

  it('walks every key it is given, and names nothing for a key nobody used', async () => {
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
    /* Three outputs, so six slots, two amounts each; then one payment amount against the EUR note and against its change. */
    expect(w.checks, 'RED WHEN: a payment in one token is tried against the other token\'s notes').toBe(6 * 2 + 2 + 2);
  });

  it('an amount the records hold rounded, or not at all, names nothing -- and the walk says what it tried', async () => {
    const d = dep(KEY, 1_234n, 1);
    const w = await walk([d], { deposited: [{ token: GBP, value: 1_230n }], paid: [] });
    expect(w.coins).toEqual([]);
    expect(w.slots).toEqual({ walked: 1 + DEPOSIT_SLOT_ATTEMPTS, lastFound: 0 });
    expect(w.checks).toBe(1 + DEPOSIT_SLOT_ATTEMPTS);
  });

  it('does not try an amount at least as large as the note: an exact spend leaves no change and a split must leave some', async () => {
    const d = dep(KEY, 100n, 1);
    const w = await walk([d], { deposited: [{ token: GBP, value: 100n }], paid: [{ token: GBP, amount: 100n }, { token: GBP, amount: 150n }] });
    expect(w.checks, 'RED WHEN: amounts that cannot have left change are tried').toBe(1 + DEPOSIT_SLOT_ATTEMPTS);
  });

  it('tries a recorded amount ONCE however many times the books repeat it', async () => {
    const d = dep(KEY, 100n, 1);
    const once = await walk([d], { deposited: [{ token: GBP, value: 100n }], paid: [{ token: GBP, amount: 40n }] });
    const thrice = await walk([d], {
      deposited: [{ token: GBP, value: 100n }, { token: GBP, value: 100n }, { token: GBP, value: 100n }],
      paid: [{ token: GBP, amount: 40n }, { token: GBP, amount: 40n }],
    });
    expect(thrice.checks, 'RED WHEN: a monthly deposit of one amount multiplies the walk by the months').toBe(once.checks);
    expect(once.checks).toBe(1 + DEPOSIT_SLOT_ATTEMPTS + 2);
  });

  it('REFUSES a record of nothing, and a token in a second spelling', async () => {
    await expect(walk([], { deposited: [{ token: GBP, value: 0n }], paid: [] })).rejects.toThrow(/deposit of nothing/);
    await expect(walk([], { deposited: [], paid: [{ token: GBP, amount: 0n }] })).rejects.toThrow(/payment of nothing/);
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

describe('the commitment a rebuild asks the compiled contract for', () => {
  it('IS THE LEDGER\'S OWN, for coins of every shape', async () => {
    const ask = await compiledOutputCommitment();
    const coins: VaultCoin[] = [
      { nonce: toHex(randomBytes(32)), token: GBP, value: 1n },
      { nonce: toHex(randomBytes(32)), token: EUR, value: (1n << 128n) - 1n },
      ...Array.from({ length: 6 }, (_, i) => ({ nonce: toHex(randomBytes(32)), token: toHex(randomBytes(32)), value: BigInt(1_000 * (i + 1)) })),
    ];
    for (const coin of coins) {
      const vault = toHex(randomBytes(32)) as Hex;
      expect(ask(coin, vault), 'RED WHEN: the contract\'s commitment is not the one the ledger records, so a walk through it names nothing')
        .toBe(await vaultNoteCommitment(coin, vault));
    }
  });

  it('differs by vault, so one vault\'s history never names another\'s coin', async () => {
    const ask = await compiledOutputCommitment();
    const coin = { nonce: toHex(randomBytes(32)), token: GBP, value: 5n };
    expect(ask(coin, VAULT)).not.toBe(ask(coin, 'cd'.repeat(32) as Hex));
  });
});
