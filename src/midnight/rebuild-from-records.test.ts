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
import { changeNoteOf, splitPiecesOf, nameTheRecord } from './vault-recovery.js';
import { spentNullifierOf, NonceSecretNeeded, NonceSecretNotTheVaults } from './vault-coin-nonces.js';
import { pureCircuits as V } from '../../contracts/managed-vault/contract/index.js';
import { vaultNoteCommitment } from './note-index.js';
import { toHex, fromHex, randomBytes, type Hex } from '../core/crypto.js';
import type { VaultCoin } from './vault-coins.js';

const VAULT = 'ab'.repeat(32) as Hex;
const TOKEN = 'aa'.repeat(32) as Hex;
const OTHER_TOKEN = 'ee'.repeat(32) as Hex;
/* The vault's nonce secret, which the company's deposit key is also derived from. */
const SECRET = toHex(new Uint8Array(32).fill(3));
const KEY = depositNonceKeyFor(fromHex(SECRET), VAULT);
const OTHER_KEY = depositNonceKeyFor(new Uint8Array(32).fill(4), VAULT);
/* Every coin a payment or a split makes is named under the vault's secret, as a device holding it names it. */
const UNDER = { circuits: V, vault: VAULT, secret: SECRET };
const NONCE_SECRETS = { secrets: [SECRET], commitment: toHex(V.secretCommitmentOf(fromHex(VAULT), fromHex(SECRET))) };
/** The vault's split journal entry for a split of `amount` out of `c`, as `splitNote` writes it. */
const journalled = (c: VaultCoin, amount: bigint): [string, string] => {
  const spent = spentNullifierOf(V, VAULT, c);
  return [spent, toHex(V.maskedAmountOf(amount, V.splitMaskOf(fromHex(SECRET), fromHex(spent))))];
};
const label = (c: VaultCoin, vault: Hex = VAULT) => `${vault}|${c.nonce}|${c.token}|${c.value}`;
const dep = (key: typeof KEY, value: bigint, slot: number, token: Hex = TOKEN): VaultCoin =>
  ({ nonce: depositNonceAt(key, { token, value }, slot), token, value });
const piece = (c: VaultCoin, amount: bigint): VaultCoin => splitPiecesOf(c, amount, UNDER)[0];
/** An output the vault holds that no record here can name: another depositor's, or one made at random. */
const stranger = (i: number): VaultCoin => ({ nonce: toHex(new Uint8Array(32).fill(i + 1)), token: TOKEN, value: 1n });

const walk = (made: VaultCoin[], records: CompanyRecords, keys = [KEY], splitJournal = new Map<string, string>()) =>
  walkCompanyRecords({
    vault: VAULT, keys, records, everCreated: new Set(made.map((c) => label(c))), commitmentOf: label,
    nonceSecrets: NONCE_SECRETS, splitJournal,
  });

describe('walking a company\'s records against everything the chain made for the vault', () => {
  it('names deposits, the change each payment left and the pieces a split made, through notes long since spent', async () => {
    const d1 = dep(KEY, 1_000n, 1);
    const c1 = changeNoteOf(d1, 250n, UNDER)!;   // 750
    const c2 = changeNoteOf(c1, 700n, UNDER)!;   // 50, reachable only through two spent notes
    const p = piece(c2, 20n);                    // a split of 20 out of the 50
    const c3 = splitPiecesOf(c2, 20n, UNDER)[1]; // its remainder, 30
    const w = await walk([d1, c1, c2, p, c3], {
      deposited: [{ token: TOKEN, value: 1_000n }],
      paid: [{ token: TOKEN, amount: 250n }, { token: TOKEN, amount: 700n }, { token: TOKEN, amount: 20n }],
    }, [KEY], new Map([journalled(c2, 20n)]));
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
    const w = await walk([...earlier, last], { deposited: [{ token: TOKEN, value: 100n }], paid: [] });
    expect(w.coins, 'RED WHEN: a deposit at the last slot it may use is not named').toEqual([last]);
    expect(w.slots, 'RED WHEN: the walk is bounded by anything but the vault\'s outputs and the attempts')
      .toEqual({ walked: 5 + DEPOSIT_SLOT_ATTEMPTS, lastFound: 7 });
    const none = await walk([], { deposited: [{ token: TOKEN, value: 100n }], paid: [] });
    expect(none.slots, 'RED WHEN: an empty vault is walked past the slots its first deposit could use').toEqual({ walked: DEPOSIT_SLOT_ATTEMPTS, lastFound: 0 });
    expect(none.checks).toBe(DEPOSIT_SLOT_ATTEMPTS);
  });

  it('A LONG RUN OF OUTPUTS NOBODY HERE CAN NAME DOES NOT END THE WALK, however long it is', async () => {
    const unnameable = Array.from({ length: 60 }, (_, i) => stranger(i));
    const mine = dep(KEY, 700n, 61);
    const w = await walk([...unnameable, mine], { deposited: [{ token: TOKEN, value: 700n }], paid: [] });
    expect(w.coins, 'RED WHEN: a run of versions that no key names ends the walk before a later deposit').toEqual([mine]);
    expect(w.slots).toEqual({ walked: 61 + DEPOSIT_SLOT_ATTEMPTS, lastFound: 61 });
  });

  it('a change counts as an output, so the deposit after a payment is at the slot after it', async () => {
    const d1 = dep(KEY, 1_000n, 1);
    const c1 = changeNoteOf(d1, 400n, UNDER)!;
    const d2 = dep(KEY, 1_000n, 3);
    const w = await walk([d1, c1, d2], {
      deposited: [{ token: TOKEN, value: 1_000n }], paid: [{ token: TOKEN, amount: 400n }],
    });
    expect(w.coins, 'RED WHEN: a deposit made after a payment is not named').toEqual([d1, d2, c1]);
  });

  it('tries every recorded amount at every slot, so two amounts at one slot both name their coins', async () => {
    const a = dep(KEY, 100n, 1);
    const b = dep(KEY, 300n, 1);
    const w = await walk([a, b], { deposited: [{ token: TOKEN, value: 100n }, { token: TOKEN, value: 300n }], paid: [] });
    expect(w.coins).toEqual([a, b]);
  });

  it('WALKS EVERY EPOCH AT EVERY SLOT: a deposit made under a secret since rotated is still named', async () => {
    const old = dep(OTHER_KEY, 100n, 1);
    const now = dep(KEY, 100n, 2);
    const w = await walk([old, now], { deposited: [{ token: TOKEN, value: 100n }], paid: [] }, [OTHER_KEY, KEY]);
    expect(w.coins, 'RED WHEN: only the newest epoch is walked, so money deposited before a signer left loses its name').toEqual([old, now]);
    const onlyNew = await walk([old, now], { deposited: [{ token: TOKEN, value: 100n }], paid: [] }, [KEY]);
    expect(onlyNew.coins).toEqual([now]);
  });

  it('walks every key it is given, and names nothing for a key nobody used', async () => {
    const mine = dep(KEY, 100n, 1);
    const theirs = dep(OTHER_KEY, 100n, 1);
    const both = await walk([mine, theirs], { deposited: [{ token: TOKEN, value: 100n }], paid: [] }, [KEY, OTHER_KEY]);
    expect(both.coins).toEqual([mine, theirs]);
    const one = await walk([theirs], { deposited: [{ token: TOKEN, value: 100n }], paid: [] }, [KEY]);
    expect(one.coins, 'RED WHEN: a deposit is named without the key it was derived from').toEqual([]);
  });

  it('keeps tokens apart: an amount paid in one token is never tried against a note of another', async () => {
    const g = dep(KEY, 1_000n, 1, TOKEN);
    const e = dep(KEY, 1_000n, 2, OTHER_TOKEN);
    const eChange = changeNoteOf(e, 400n, UNDER)!;
    const w = await walk([g, e, eChange], {
      deposited: [{ token: TOKEN, value: 1_000n }, { token: OTHER_TOKEN, value: 1_000n }],
      paid: [{ token: OTHER_TOKEN, amount: 400n }],
    });
    expect(w.coins).toEqual([g, e, eChange]);
    /*
     * Three outputs, so six slots, two amounts each; then one payment amount against the OTHER_TOKEN note and against its
     * change. A split is no longer guessed from the amounts paid (the vault's split journal names it), so each note
     * costs one change and no piece.
     */
    /* RED WHEN a payment is tried against another token's notes, or a split's piece is guessed from the amounts paid */
    expect(w.checks, 'RED WHEN: a payment in one token is tried against the other token\'s notes').toBe(6 * 2 + 1 + 1);
  });

  it('an amount the records hold rounded, or not at all, names nothing -- and the walk says what it tried', async () => {
    const d = dep(KEY, 1_234n, 1);
    const w = await walk([d], { deposited: [{ token: TOKEN, value: 1_230n }], paid: [] });
    expect(w.coins).toEqual([]);
    expect(w.slots).toEqual({ walked: 1 + DEPOSIT_SLOT_ATTEMPTS, lastFound: 0 });
    expect(w.checks).toBe(1 + DEPOSIT_SLOT_ATTEMPTS);
  });

  it('does not try an amount at least as large as the note: an exact spend leaves no change and a split must leave some', async () => {
    const d = dep(KEY, 100n, 1);
    const w = await walk([d], { deposited: [{ token: TOKEN, value: 100n }], paid: [{ token: TOKEN, amount: 100n }, { token: TOKEN, amount: 150n }] });
    expect(w.checks, 'RED WHEN: amounts that cannot have left change are tried').toBe(1 + DEPOSIT_SLOT_ATTEMPTS);
  });

  it('tries a recorded amount ONCE however many times the books repeat it', async () => {
    const d = dep(KEY, 100n, 1);
    const once = await walk([d], { deposited: [{ token: TOKEN, value: 100n }], paid: [{ token: TOKEN, amount: 40n }] });
    const thrice = await walk([d], {
      deposited: [{ token: TOKEN, value: 100n }, { token: TOKEN, value: 100n }, { token: TOKEN, value: 100n }],
      paid: [{ token: TOKEN, amount: 40n }, { token: TOKEN, amount: 40n }],
    });
    expect(thrice.checks, 'RED WHEN: a monthly deposit of one amount multiplies the walk by the months').toBe(once.checks);
    /* One change tried for the one amount paid; a piece is read from the split journal, never tried. */
    /* RED WHEN a split's piece is guessed from the amounts paid */
    expect(once.checks).toBe(1 + DEPOSIT_SLOT_ATTEMPTS + 1);
  });

  it('REFUSES a record of nothing, and a token in a second spelling', async () => {
    await expect(walk([], { deposited: [{ token: TOKEN, value: 0n }], paid: [] })).rejects.toThrow(/deposit of nothing/);
    await expect(walk([], { deposited: [], paid: [{ token: TOKEN, amount: 0n }] })).rejects.toThrow(/payment of nothing/);
    await expect(walk([], { deposited: [{ token: TOKEN.toUpperCase() as Hex, value: 1n }], paid: [] }),
      'RED WHEN: a second spelling of a token is carried into a coin').rejects.toThrow(/64 lower-case hex/);
    await expect(walk([], { deposited: [], paid: [{ token: `0x${TOKEN}` as Hex, amount: 1n }] })).rejects.toThrow(/64 lower-case hex/);
  });

  it('NAMES A CHANGE ONLY UNDER THE SECRET IT WAS MADE UNDER, through a rotation: every secret the record holds is tried', async () => {
    const NEWER = toHex(new Uint8Array(32).fill(5));
    const now = { secrets: [SECRET, NEWER], commitment: toHex(V.secretCommitmentOf(fromHex(VAULT), fromHex(NEWER))) };
    const d = dep(KEY, 1_000n, 1);
    const before = changeNoteOf(d, 300n, UNDER)!;                                  // made under the older secret
    const after = changeNoteOf(before, 200n, { ...UNDER, secret: NEWER })!;        // made under the newer one
    const records = { deposited: [{ token: TOKEN, value: 1_000n }], paid: [{ token: TOKEN, amount: 300n }, { token: TOKEN, amount: 200n }] };
    const made = new Set([d, before, after].map((c) => label(c)));
    const run = (nonceSecrets: typeof now) => walkCompanyRecords({
      vault: VAULT, keys: [KEY], records, everCreated: made, commitmentOf: label, nonceSecrets, splitJournal: new Map(),
    });
    expect((await run(now)).coins, /* RED WHEN only the newest secret is tried */ 'RED WHEN: a change made under a secret since rotated loses its name')
      .toEqual([d, before, after]);
    /* RED WHEN a coin is named under a secret the record does not hold */
    expect((await run({ ...now, secrets: [NEWER] })).coins, 'RED WHEN: a change is named under a secret that did not make it').toEqual([d]);
  });

  it('REFUSES BY NAME to name what payments made without the vault\'s secret, with secrets that are not the vault\'s, or without its split journal', async () => {
    const records = { deposited: [{ token: TOKEN, value: 100n }], paid: [{ token: TOKEN, amount: 40n }] };
    const base = { vault: VAULT, keys: [KEY], records, everCreated: new Set<string>(), commitmentOf: label };
    await expect(walkCompanyRecords(base), /* RED WHEN a walk of payments goes on without the secret */
      'RED WHEN: payments are walked without the secret, so every change they left is silently unnamed').rejects.toThrow(NonceSecretNeeded);
    await expect(walkCompanyRecords({ ...base, nonceSecrets: { ...NONCE_SECRETS, secrets: [toHex(new Uint8Array(32).fill(4))] }, splitJournal: new Map() }),
      /* RED WHEN the secrets are not checked against the vault's commitment */
      'RED WHEN: a record none of whose secrets is the vault\'s is walked as though it were').rejects.toThrow(NonceSecretNotTheVaults);
    await expect(walkCompanyRecords({ ...base, nonceSecrets: NONCE_SECRETS }),
      /* RED WHEN a missing split journal is read as an empty one */
      'RED WHEN: a journal that was not read is taken for a vault that never split').rejects.toThrow(/split journal was not given/);
  });

  it('a coin found this way is named as the company\'s own records', () => {
    expect(nameTheRecord({ kind: 'company records' }), 'RED WHEN: a coin named from the books is called a journal line or a version').toBe('the company\'s own records');
  });

  it('reads the history by the ledger\'s commitment in any spelling', async () => {
    const d = dep(KEY, 100n, 1);
    const w = await walkCompanyRecords({
      vault: VAULT, keys: [KEY], records: { deposited: [{ token: TOKEN, value: 100n }], paid: [] },
      everCreated: new Set([label(d).toLowerCase()]), commitmentOf: (c) => `0x${label(c).toUpperCase()}`,
      nonceSecrets: NONCE_SECRETS, splitJournal: new Map(),
    });
    expect(w.coins).toEqual([d]);
  });
});

describe('the commitment a rebuild asks the compiled contract for', () => {
  it('IS THE LEDGER\'S OWN, for coins of every shape', async () => {
    const ask = await compiledOutputCommitment();
    const coins: VaultCoin[] = [
      { nonce: toHex(randomBytes(32)), token: TOKEN, value: 1n },
      { nonce: toHex(randomBytes(32)), token: OTHER_TOKEN, value: (1n << 128n) - 1n },
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
    const coin = { nonce: toHex(randomBytes(32)), token: TOKEN, value: 5n };
    expect(ask(coin, VAULT)).not.toBe(ask(coin, 'cd'.repeat(32) as Hex));
  });
});
